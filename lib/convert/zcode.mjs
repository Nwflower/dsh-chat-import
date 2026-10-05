// lib/convert/zcode.mjs — zcode（z.ai 官方 CLI）历史库会话 → DSH 会话（纯函数）

import {
  SESSION_FORMAT_VERSION,
  finishSession,
  mintSessionId,
  parseTime,
  parseTimeMs,
} from './core.mjs'
import { imageBlockFromSource } from './image.mjs'
import { skipResult } from './util.mjs'
import { SYSTEM_REMINDER_OPEN } from './inject.mjs'

// zcode 历史库会话（host 面从 db.sqlite 抽取的中间 JSON）→ DSH 会话。
//
// 存储：~/.zcode/cli/db/db.sqlite（SQLite 权威索引）。lib/sources/zcode.mjs 的 readZcodeDb 把每个会话的
// session/message/part 三表抽成下述中间 JSON 再调用本函数，因此本函数保持纯函数
// （零 DSH 依赖，可单测）：
// {
//   id, title, directory, createdAt, summary?,
//   messages: [
//     { id, role: 'user'|'assistant', createdAt, model?, parts: [ part.data 原样 ] }
//   ]
// }
// 消息级 createdAt 透传进 IR 时间戳 → 宿主统计投影折出真实的逐步模型耗时。
// part.type 映射：text→text、reasoning→reasoning、tool→tool/call + tool/result
// 成对输出（state.input 序列化为 arguments、state.output 为结果文本，status
// 'failed'/'error' 标 isError；output 缺失也发空文本结果，保证 call/result 配对）、
// file→[image: <name>]；compaction / step-start / step-finish / timeline 是结构性
// 块，跳过。含 <system-reminder> 的 user 注入消息整条过滤（系统注入不进对话）。
// 压缩（zcode compaction part 的 compactBoundary）：默认导入为 **DSH 原生压缩检查点**——
// 边界落在「保留窗口起点」（carrier 前 keptMessageCount 条消息原样保留），其前的轮 log-only、
// 摘要进检查点、日志保全量，模型视角 = 摘要 + 保留窗口；缺 compactBoundary 或 fullHistory: true
// 时不发检查点，摘要退回既有形态（首个 assistant 步骤的 reasoning 块），不静默遮蔽内容。
// 模型回退链（assistant 消息级 model）：modelID → model（字符串）→ undefined（回退
// provider 名 zcode）。
export function convertZcodeJson(raw, args = {}) {
  let chat
  try {
    chat = JSON.parse(raw)
  } catch {
    return skipResult(null, { skipped: 1 })
  }
  if (!chat || typeof chat !== 'object' || !Array.isArray(chat.messages)) return skipResult(null, { skipped: 1 })

  // 原生压缩检查点（见 events.mjs）：zcode 的 compaction part 带 compactBoundary
  //（summarizedMessageCount / keptMessageCount）——边界之前最近 keptMessageCount 条消息原样
  // 保留，其余被摘要。边界因此落在「保留窗口起点」：此前的轮标 log-only（正文照常留在日志里），
  // 摘要作检查点挂到边界处的轮。缺 compactBoundary（只有摘要正文）时不猜保留窗口，退回既有
  // 形态（摘要作 reasoning 块），不静默遮蔽源侧模型可能仍看得见的内容。
  const cp = chat.compaction && typeof chat.compaction.summary === 'string' && chat.compaction.summary.trim()
    && Number.isInteger(chat.compaction.keptMessageCount) && chat.compaction.keptMessageCount >= 0
    ? chat.compaction
    : null
  const carrierIdx = cp && args.fullHistory !== true ? chat.messages.findIndex((m) => m && m.id === cp.carrierMessageId) : -1
  const boundaryIdx = cp && carrierIdx >= 0 ? Math.max(0, carrierIdx - cp.keptMessageCount) : -1
  let pendingCompaction = null
  // 拿不到字节、以 [image: <name>] 文本占位导入的图片张数（能落成宿主附件的不计这里）
  let imagesDegraded = 0

  const turns = []
  let cur = null
  for (let i = 0; i < chat.messages.length; i++) {
    const msg = chat.messages[i]
    if (!msg || typeof msg !== 'object') continue
    // 消息级 createdAt（毫秒）→ IR time（宿主耗时统计原料；null 不占键）
    const msgTime = parseTimeMs(msg.createdAt)
    if (i === boundaryIdx) {
      for (const t of turns) t.shadowed = true
      cur = null
      pendingCompaction = { summary: cp.summary.trim(), provider: 'zcode', model: zcodeMessageModel(msg) || undefined }
    }
    if (msg.role === 'user') {
      // text part 合并为用户提问 → 新轮；含 <system-reminder> 的系统注入整条过滤
      const texts = []
      if (Array.isArray(msg.parts)) {
        for (const p of msg.parts) {
          if (p && p.type === 'text' && typeof p.text === 'string' && p.text.trim()) texts.push(p.text.trim())
        }
      }
      const prompt = texts.join('\n')
      if (prompt && !prompt.includes(SYSTEM_REMINDER_OPEN)) {
        cur = { prompt, steps: [] }
        if (msgTime !== null) cur.time = msgTime
        if (pendingCompaction) {
          cur.compaction = pendingCompaction
          pendingCompaction = null
        }
        turns.push(cur)
      }
    } else if (msg.role === 'assistant') {
      // 保留窗口从一条 assistant 消息开始（边界落在轮中间）：空 prompt 轮承载检查点后的产物
      if (!cur && pendingCompaction) {
        cur = { prompt: '', steps: [], compaction: pendingCompaction }
        pendingCompaction = null
        turns.push(cur)
      }
      if (!cur) continue
      const step = { content: [], toolCalls: [], toolResults: [] }
      if (msgTime !== null) step.time = msgTime
      if (Array.isArray(msg.parts)) {
        for (const p of msg.parts) {
          if (!p || typeof p !== 'object') continue
          if (p.type === 'text' && typeof p.text === 'string') {
            step.content.push({ type: 'text', text: p.text })
          } else if (p.type === 'reasoning' && typeof p.text === 'string') {
            step.content.push({ type: 'reasoning', text: p.text })
          } else if (p.type === 'tool') {
            const callId = String(p.callID || 'zcode-' + turns.length + '-' + (cur.steps.length + 1))
            const state = p.state && typeof p.state === 'object' ? p.state : {}
            const mapped = {
              id: callId,
              name: p.tool || 'unknown',
              arguments: JSON.stringify(state.input ?? {}),
            }
            step.content.push({ type: 'tool-call', ...mapped })
            step.toolCalls.push(mapped)
            step.toolResults.push({
              toolCallId: callId,
              content: [{ type: 'text', text: toolResultText(state.output) }],
              isError: state.status === 'failed' || state.status === 'error',
            })
          } else if (p.type === 'file') {
            // 图片文件部分：有内联字节（data URL / base64）就产出 IR image 块（宿主层落成
            // 附件），拿不到才降级 [image: <name>] 文本并计数
            const img = imageBlockFromSource(p)
            if (img) step.content.push(img)
            else { imagesDegraded++; step.content.push({ type: 'text', text: '[image: ' + (p.filename || 'unknown') + ']' }) }
          }
          // compaction / step-start / step-finish / timeline 与未知类型是结构块，跳过
        }
      }
      const stepModel = zcodeMessageModel(msg)
      if (stepModel) step.model = stepModel
      cur.steps.push(step)
    }
  }

  // 待落检查点没等到新轮（会话正好停在压缩点）：空 prompt 轮兜住，否则边界无处发射
  if (pendingCompaction) {
    turns.push({ prompt: '', steps: [], compaction: pendingCompaction })
    pendingCompaction = null
  }

  // 压缩摘要（zcode compaction，未走原生检查点的情形：fullHistory 或缺 compactBoundary）：
  // 作 reasoning 块前置到首个 assistant 步骤，让 resume 时模型可见被压掉的历史概要。
  if (!cp || args.fullHistory === true) {
    if (typeof chat.summary === 'string' && chat.summary.trim()) {
      for (const t of turns) {
        if (t.steps.length > 0) {
          t.steps[0].content.unshift({ type: 'reasoning', text: chat.summary.trim() })
          break
        }
      }
    }
  }

  const sessionId = args.sessionId || mintSessionId(chat.id)
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: parseTime(chat.createdAt) }
  if (chat.id) meta.sourceId = chat.id
  if (typeof chat.directory === 'string' && chat.directory) meta.cwd = chat.directory
  const title = typeof chat.title === 'string' ? chat.title.trim() : undefined
  // 开关开启时 readZcodeDb / readZcodeTranscript 已把 system 消息收集到 chat.systemPrompt
  const systemPrompt = args.importSystemPrompt === true && typeof chat.systemPrompt === 'string' && chat.systemPrompt.trim() ? chat.systemPrompt : undefined
  return finishSession(turns, args.budget, {
    meta,
    title,
    provider: 'zcode',
    skipped: 0,
    records: chat.messages.length,
    systemPrompt,
  }, {
    // 图片降级数（>0 才占键）：拿不到字节、以 [image: <name>] 文本占位导入的图片张数
    ...(imagesDegraded > 0 ? { imagesDegraded } : {}),
  })
}

// 工具结果文本：字符串原样；对象/数组序列化；缺失发空（call/result 仍配对）。
function toolResultText(output) {
  if (typeof output === 'string') return output
  if (output === undefined || output === null) return ''
  return JSON.stringify(output)
}

// 消息级模型：平铺 modelID 优先，其次 model 字符串。
function zcodeMessageModel(msg) {
  if (typeof msg.modelID === 'string' && msg.modelID) return msg.modelID
  if (typeof msg.model === 'string' && msg.model) return msg.model
  return undefined
}
