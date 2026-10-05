// lib/convert/opencode.mjs — opencode 历史库会话 → DSH 会话（纯函数）

import {
  SESSION_FORMAT_VERSION,
  finishSession,
  imageBlockFromSource,
  mintSessionId,
  parseTime,
  parseTimeMs,
} from './core.mjs'
import { skipResult } from './util.mjs'
import { shadowTurns } from './ir.mjs'

// opencode 历史库会话（index 层从 SQLite 抽取的中间 JSON）→ DSH 会话。
//
// 存储：opencode.db（SQLite，WAL）。index.mjs 负责把每个会话抽成下述中间 JSON 再调用本
// 函数，因此本函数保持纯函数（零 DSH 依赖，可单测）：V1（opencode 1.x）抽
// session/message/part 三表；V2（opencode 2.x）抽 session_v2/session_message，V2 的
// assistant content[] 已被读取器拆成同样的 text/reasoning/tool parts（tool 的输出取
// state.content 的文本），用户附件同样落成 file part——所以本函数无世代分支。
// {
//   id, title, directory, createdAt, model, summary?,
//   messages: [
//     { id, role: 'user'|'assistant', createdAt, cwd?, model?, tokens?, parts: [ part.data 原样 ] }
//   ]
// }
// createdAt（消息级，毫秒）透传进 IR 时间戳 → 宿主统计投影能折出真实的逐步模型耗时；
// tokens（assistant 消息，{input, output, reasoning, cache:{read, write}}）映射为 DSH
// usage（老库与 V2 实测无此字段，缺席不映射）。
// part.type 映射：text→text、reasoning→reasoning、tool→tool/call + tool/result
// （state.input 序列化为 arguments，state.output 为结果文本，status==='error' 标
// isError；output 缺失也发空文本结果，保证 call/result 配对）、file→[image: <name>]、
// patch→[patch: <N> files]、subtask→[subtask: <command> — <description>]；
// step-start / step-finish / compaction 是结构性块，跳过。
// 模型回退链（assistant source.model）：消息级 modelID → 消息级 model.modelID →
// 会话级 model（对象取 id/modelID，字符串原样）→ undefined。
//
// compactions[]（压缩边界，reader 给出）：{ tailStartId, summary, recent? }。
// tailStartId = 边界消息 id（V1 是保留窗口第一条消息、V2 是那条 compaction 行）；
// 正文取 summary + recent（V2 两段都进模型上下文，V1 只有 summary）。

// opencode 工具名映射：opencode 本地名 → DSH 标准工具名；未知保持原样。
const OPENCODE_TOOL_ALIASES = {
  websearch: 'web_search',
  webfetch: 'web_fetch',
  question: 'ask_user_question',
  todowrite: 'todo_write',
  task: 'subagent',
}

/** 映射 opencode 工具名为 DSH 工具名（纯函数）。 */
export function mapOpencodeToolName(name) {
  return OPENCODE_TOOL_ALIASES[name] || name
}

// DSH 工具名 → opencode 本地名（导出/互转方向；OPENCODE_TOOL_ALIASES 的逆表）。
// 两个方向共用同一张对照表，避免只改一边造成往返不一致。
const DSH_TO_OPENCODE = Object.fromEntries(
  Object.entries(OPENCODE_TOOL_ALIASES).map(([local, dsh]) => [dsh, local]),
)

// opencode 自带工具名（CLI 文档的 --permissions 列表口径）：DSH 侧同名但大小写不同时
// （Claude 源的 `Bash` / `Read`）归一成 opencode 的小写形态，让它能按名字渲染专用 UI；
// 表外的名字原样保留（opencode 按未知工具通用渲染，不阻断导入）。
const OPENCODE_KNOWN_TOOLS = new Set([
  'bash', 'read', 'edit', 'write', 'glob', 'grep', 'webfetch', 'task', 'todowrite', 'websearch', 'lsp', 'skill',
])

/** 映射 DSH 工具名为 opencode 本地名（纯函数）。 */
export function unmapOpencodeToolName(name) {
  const s = String(name ?? '')
  if (DSH_TO_OPENCODE[s]) return DSH_TO_OPENCODE[s]
  const lower = s.toLowerCase()
  return OPENCODE_KNOWN_TOOLS.has(lower) ? lower : s
}

export function convertOpencodeJson(raw, args = {}) {
  let chat
  try {
    chat = JSON.parse(raw)
  } catch {
    return skipResult(null, { skipped: 1 })
  }
  return convertOpencodeSession(chat, args)
}

// 已解析的中间对象入口：在内存里归一出同构对象的来源（trae）直接走这里，不必先序列化
// 再解析一遍。形状不对（非对象 / 缺 messages 数组）返回跳过结果。
export function convertOpencodeSession(chat, args = {}) {
  if (!chat || typeof chat !== 'object' || !Array.isArray(chat.messages)) return skipResult(null, { skipped: 1 })

  // 原生压缩检查点（见 events.mjs）：reader 传来的 compactions 给出每次压缩的正文与边界消息 id。
  // 边界处的轮标 log-only（正文照常留在日志里），正文作检查点；模型只看得到最后一次压缩的
  // 正文 + 之后的对话。正文 = summary + recent：V1 只有 summary；V2 的 compaction 行把摘要与
  // 保留窗口原文分两个字段，源侧模型两段都看得见（session/compaction.ts 的 <summary> /
  // <recent-context>），少取一段就是丢内容。
  const compactions = Array.isArray(chat.compactions)
    ? chat.compactions
        .map((c) => ({
          ...c,
          body: [c && c.summary, c && c.recent].filter((s) => typeof s === 'string' && s.trim()).join('\n\n').trim(),
        }))
        .filter((c) => c && typeof c.tailStartId === 'string' && c.body)
    : []
  // 边界消息 id → 压缩（同一 id 多条时取首条）；正文已进检查点的摘要消息 id
  const boundaryById = new Map()
  for (const c of compactions) if (!boundaryById.has(c.tailStartId)) boundaryById.set(c.tailStartId, c)
  const summaryMessageIds = new Set(compactions.map((c) => c.summaryMessageId))
  let pendingCompaction = null
  // 拿不到字节、以 [image: <name>] 文本占位导入的图片张数（能落成宿主附件的不计这里）
  let imagesDegraded = 0

  const turns = []
  // 已标 log-only 的轮数（多次压缩只走新增的轮）
  let shadowedTurns = 0
  let cur = null
  for (const msg of chat.messages) {
    if (!msg || typeof msg !== 'object') continue
    const boundary = boundaryById.get(msg.id)
    if (boundary) {
      shadowedTurns = shadowTurns(turns, shadowedTurns)
      cur = null
      pendingCompaction = { summary: boundary.body, provider: args.provider || 'opencode', model: msg.model || undefined }
    }
    // 摘要消息（mode='compaction'）：正文已进检查点时不再当对话内容；没有检查点承载它
    //（fullHistory / 只有摘要没有边界标记）时按普通消息导入，绝不静默丢正文。
    if (msg.isSummary && summaryMessageIds.has(msg.id)) continue
    if (msg.role === 'user') {
      // text part 合并为用户提问 → 新轮；无文本（如只有附件）不开轮
      const texts = []
      if (Array.isArray(msg.parts)) {
        for (const p of msg.parts) {
          if (p && p.type === 'text' && typeof p.text === 'string' && p.text.trim()) texts.push(p.text.trim())
        }
      }
      const prompt = texts.join('\n')
      if (prompt) {
        cur = { prompt, steps: [] }
        const t = parseTimeMs(msg.createdAt)
        if (t !== null) cur.time = t
        if (pendingCompaction) {
          cur.compaction = pendingCompaction
          pendingCompaction = null
        }
        turns.push(cur)
      }
    } else if (msg.role === 'assistant') {
      // 保留窗口从一条 assistant 消息开始（边界落在轮中间）：空 prompt 轮承载检查点后的产物，
      // 合成层对带检查点的空 prompt 轮不再补发 user/message
      if (pendingCompaction && !cur) {
        cur = { prompt: '', steps: [], compaction: pendingCompaction }
        pendingCompaction = null
        turns.push(cur)
      }
      if (!cur) continue
      const step = { content: [], toolCalls: [], toolResults: [] }
      const t = parseTimeMs(msg.createdAt)
      if (t !== null) step.time = t
      // provider 回报用量（V1 message.data.tokens；字段守卫在 events.mjs sanitizeUsage）
      const tk = msg.tokens
      if (tk && typeof tk === 'object') {
        step.usage = {
          inputTokens: tk.input,
          outputTokens: tk.output,
          reasoningTokens: tk.reasoning,
          cacheReadTokens: tk.cache && typeof tk.cache === 'object' ? tk.cache.read : undefined,
          cacheWriteTokens: tk.cache && typeof tk.cache === 'object' ? tk.cache.write : undefined,
        }
      }
      if (Array.isArray(msg.parts)) {
        for (const p of msg.parts) {
          if (!p || typeof p !== 'object') continue
          if (p.type === 'text' && typeof p.text === 'string') {
            step.content.push({ type: 'text', text: p.text })
          } else if (p.type === 'reasoning' && typeof p.text === 'string') {
            step.content.push({ type: 'reasoning', text: p.text })
          } else if (p.type === 'tool') {
            const callId = String(p.callID || 'opencode-' + turns.length + '-' + (cur.steps.length + 1))
            const state = p.state && typeof p.state === 'object' ? p.state : {}
            const mapped = {
              id: callId,
              name: mapOpencodeToolName(p.tool || 'unknown'),
              arguments: JSON.stringify(state.input ?? {}),
            }
            step.content.push({ type: 'tool-call', ...mapped })
            step.toolCalls.push(mapped)
            step.toolResults.push({
              toolCallId: callId,
              content: [{ type: 'text', text: typeof state.output === 'string' ? state.output : '' }],
              isError: state.status === 'error',
            })
          } else if (p.type === 'file') {
            // 图片文件部分：有内联字节（data URL / base64）就产出 IR image 块（宿主层落成
            // 附件），拿不到才降级 [image: <name>] 文本并计数
            const img = imageBlockFromSource(p)
            if (img) step.content.push(img)
            else { imagesDegraded++; step.content.push({ type: 'text', text: '[image: ' + (p.filename || 'unknown') + ']' }) }
          } else if (p.type === 'patch') {
            step.content.push({ type: 'text', text: '[patch: ' + (Array.isArray(p.files) ? p.files.length : 0) + ' files]' })
          } else if (p.type === 'subtask') {
            step.content.push({ type: 'text', text: '[subtask: ' + (p.command || '') + ' — ' + (p.description || '') + ']' })
          }
          // step-start / step-finish / compaction 与未知类型是结构性块，跳过
        }
      }
      const stepModel = opencodeMessageModel(msg)
      if (stepModel) step.model = stepModel
      cur.steps.push(step)
    }
  }

  // 待落检查点没等到新轮（会话正好停在压缩点）：空 prompt 轮兜住，否则边界无处发射
  if (pendingCompaction) {
    turns.push({ prompt: '', steps: [], compaction: pendingCompaction })
    pendingCompaction = null
  }

  // 兼容：调用方直接给 chat.summary 而没有 compactions（旧形状 / 手工构造的 JSON）时，摘要仍
  // 作 reasoning 块前置，不静默丢摘要。reader 现在走 compactions → 原生压缩检查点。
  if (compactions.length === 0 && typeof chat.summary === 'string' && chat.summary.trim()) {
    for (const t of turns) {
      if (t.steps.length > 0) {
        t.steps[0].content.unshift({ type: 'reasoning', text: chat.summary.trim() })
        break
      }
    }
  }

  const sessionId = args.sessionId || mintSessionId(chat.id)
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: parseTime(chat.createdAt) }
  if (chat.id) meta.sourceId = chat.id
  if (typeof chat.directory === 'string' && chat.directory) meta.cwd = chat.directory
  const title = typeof chat.title === 'string' ? chat.title.trim() : undefined
  return finishSession(turns, args.budget, {
    meta,
    title,
    // opencode 系 fork（kilocode / mimocode / teleagent / trae）复用本转换器时经 args.provider 换标签
    provider: args.provider || 'opencode',
    model: opencodeSessionModel(chat),
    skipped: 0,
    records: chat.messages.length,
  }, {
    // 图片降级数（>0 才占键）：拿不到字节、以 [image: <name>] 文本占位导入的图片张数
    ...(imagesDegraded > 0 ? { imagesDegraded } : {}),
  })
}

// 消息级模型：平铺 modelID 优先，其次 model.modelID / model 字符串。
function opencodeMessageModel(msg) {
  if (typeof msg.modelID === 'string' && msg.modelID) return msg.modelID
  const m = msg.model
  if (m && typeof m === 'object' && typeof m.modelID === 'string' && m.modelID) return m.modelID
  if (typeof m === 'string' && m) return m
  return undefined
}

// 会话级模型：对象取 id → modelID；字符串原样。
function opencodeSessionModel(chat) {
  const s = chat.model
  if (s && typeof s === 'object') {
    if (typeof s.id === 'string' && s.id) return s.id
    if (typeof s.modelID === 'string' && s.modelID) return s.modelID
  }
  if (typeof s === 'string' && s) return s
  return undefined
}
