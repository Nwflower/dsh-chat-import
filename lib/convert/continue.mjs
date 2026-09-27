// lib/convert/continue.mjs — Continue（continuedev/continue）会话 JSON → DSH 会话（纯函数）
//
// 存储：<global>/sessions/<sessionId>.json，global = $CONTINUE_GLOBAL_DIR || ~/.continue
//（VS Code / JetBrains / CLI 三端共用同一份目录；索引同目录 sessions.json 是数组，
// 只有索引带创建时间）。会话文件是单个 JSON 对象，不是 JSONL。
//
// 文件形态（@continuedev/core 1.1.0 的 core/index.d.ts，2026-09-15 全量核对）：
//   { sessionId, title, workspaceDirectory, history: ChatHistoryItem[],
//     mode?, chatModelTitle?, usage? }
//   ChatHistoryItem{ message: ChatMessage, contextItems[], reasoning?, toolCallStates?,
//                    conversationSummary?, editorState?/promptLogs?/appliedRules? … }
//   ChatMessage.role：
//     user       content: string | MessagePart[]（只取 text 部分，图片块丢弃）
//     assistant  content + toolCalls?: [{ id, type:'function', function:{ name, arguments } }]
//     thinking   content + signature?/redactedThinking?（推理块；无文本时跳过）
//     tool       content + toolCallId（结果消息，按 toolCallId 配对到调用所在步）
//     system     跳过（CLI 落盘前也会过滤掉全部 system 消息）
//
// 与其它源的结构差异（决定本模块的三处非平凡处理）：
//   1. 平面消息列表（非事件流）：一条 assistant 消息 = 一步；工具调用挂在 assistant
//      消息的 toolCalls 上，结果在**紧随其后的独立 tool 消息**里（不是内联）。
//   2. 推理有两处来源：独立的 role:'thinking' 消息，以及 item.reasoning.text（UI 流式
//      累积）。二者常是同一段文本 → 同时取会出现整段重复，故 thinking 消息优先、只在
//      reasoning.text 与之不同且非空时补充（见 reasoningTexts）。
//   3. 压缩（compaction）**不裁剪 history**：core 只在某个 item 上写
//      conversationSummary（跨过它之前的内容生成摘要），原文全部保留在文件里。
//      默认导入为 **DSH 原生压缩检查点**（摘要进检查点、其前的轮 log-only、日志保全量，
//      模型视角 = 摘要 + 压缩点之后的内容）；fullHistory: true 时不发检查点，摘要退回
//      reasoning 块（既有形态）。
//   噪声字段（contextItems 内嵌全文 / editorState / promptLogs / appliedRules /
//   toolCallStates[].tool / mcpUiState）一律丢弃：它们是 UI 态与检索上下文，不是对话。

import {
  SESSION_FORMAT_VERSION,
  applyBudgetTrim,
  mintSessionId,
  parseTime,
  synthesizeSession,
} from './core.mjs'

// 标题归一统一规则：去首尾空白、折叠内部空白；超 80 字符截断加省略号。
const TITLE_MAX_LEN = 80
const TITLE_ELLIPSIS = '…'
function normalizeTitle(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return ''
  return t.length <= TITLE_MAX_LEN ? t : t.slice(0, TITLE_MAX_LEN - TITLE_ELLIPSIS.length) + TITLE_ELLIPSIS
}

// Continue 的默认标题（新建会话时写入的常量）→ 视为「无显式标题」，走首问兜底。
const DEFAULT_TITLE = 'New Session'

// content 是 string | MessagePart[]；只取文本部分。图片/附件块（image、image_url…）
// 丢弃且不虚构占位：源能力矩阵里 continue 的 attachments 为 false。
function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (part && typeof part === 'object' && typeof part.text === 'string' && part.text) {
      parts.push(part.text)
    }
  }
  return parts.join('\n')
}

// 工具调用的参数：源里 function.arguments 是 JSON 字符串；极少数路径可能是对象。
function toolCallArguments(fn) {
  const raw = fn && fn.arguments
  if (typeof raw === 'string') return raw
  if (raw === undefined || raw === null) return '{}'
  // 参数来自 JSON.parse，只可能是 JSON 值 → stringify 不会抛，无需兜底分支
  return JSON.stringify(raw)
}

// 一个 assistant 消息的 toolCalls（权威）→ 统一 { id, name, arguments }。
// 缺 toolCalls 时回退 toolCallStates[].toolCall（GUI 侧两者是同一数组的镜像）。
function toolCallsOf(message, item) {
  const out = []
  const seen = new Set()
  const push = (call) => {
    if (!call || typeof call !== 'object') return
    const id = typeof call.id === 'string' && call.id ? call.id : null
    if (!id || seen.has(id)) return
    seen.add(id)
    const fn = call.function && typeof call.function === 'object' ? call.function : {}
    out.push({
      id,
      name: typeof fn.name === 'string' && fn.name ? fn.name : 'unknown',
      arguments: toolCallArguments(fn),
    })
  }
  for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) push(call)
  if (out.length === 0 && Array.isArray(item && item.toolCallStates)) {
    for (const state of item.toolCallStates) push(state && state.toolCall)
  }
  return out
}

// toolCallStates 里某次调用的 output（ContextItem[]）→ 结果文本；取不到返回 null（不虚构）。
// ContextItem 的正文在 .content（字符串）；.output 也可能是字符串（CLI 侧）。
function stateOutputText(state) {
  if (!state || typeof state !== 'object') return null
  const output = state.output
  if (typeof output === 'string' && output) return output
  if (!Array.isArray(output)) return null
  const texts = []
  for (const entry of output) {
    if (typeof entry === 'string' && entry) texts.push(entry)
    else if (entry && typeof entry === 'object' && typeof entry.content === 'string' && entry.content) {
      texts.push(entry.content)
    }
  }
  return texts.length > 0 ? texts.join('\n') : null
}

// toolCallStates[].status === 'errored' → 结果按错误上报（其余状态一律非错误）。
function stateIsError(state) {
  return Boolean(state) && typeof state === 'object' && state.status === 'errored'
}

// Continue 会话 JSON → 统一的回合中间结构（turns/steps，见 core.mjs synthesizeSession）。
export function convertContinueJson(raw, args = {}) {
  let session
  try {
    session = JSON.parse(raw)
  } catch {
    return {
      meta: null, events: [], turns: [], title: undefined, messages: 0, toolCalls: 0,
      skipped: 1, records: 0, skippedLines: [], secrets: [],
      skipReason: 'not a Continue session (invalid JSON)',
    }
  }
  if (!session || typeof session !== 'object' || !Array.isArray(session.history)) {
    return {
      meta: null, events: [], turns: [], title: undefined, messages: 0, toolCalls: 0,
      skipped: 1, records: 0, skippedLines: [], secrets: [],
      skipReason: 'not a Continue session (no history array)',
    }
  }

  const history = session.history
  const sourceId = typeof session.sessionId === 'string' && session.sessionId ? session.sessionId : null
  const cwd = typeof session.workspaceDirectory === 'string' && session.workspaceDirectory
    ? session.workspaceDirectory
    : null
  const model = typeof session.chatModelTitle === 'string' && session.chatModelTitle
    ? session.chatModelTitle
    : null

  const turns = []
  let cur = null
  let lastStep = null
  // thinking 消息先于承载工具调用的 assistant 消息到达：先缓存，落到下一步内容头部
  //（与 workbuddy 的 pendingReasoning 同款；新开用户回合时清空——被打断的思考不串轮）
  let pendingReasoning = null
  // callId → 所属步（结果消息乱序/跨步时按 callId 配对）
  const callSteps = new Map()
  let droppedOrphanResults = 0
  let compactionSummaries = 0
  // 待落到下一个开启轮的压缩检查点（原生事务，见 events.mjs）
  let pendingCompaction = null

  const openTurn = (prompt) => {
    cur = { prompt, steps: [] }
    if (pendingCompaction) {
      cur.compaction = pendingCompaction
      pendingCompaction = null
    }
    turns.push(cur)
    lastStep = null
    pendingReasoning = null
  }

  const openStep = (reasoning) => {
    if (!cur) return null
    const step = { content: [], toolCalls: [], toolResults: [] }
    for (const text of reasoning || []) {
      if (text) step.content.push({ type: 'reasoning', text })
    }
    cur.steps.push(step)
    lastStep = step
    return step
  }

  // 同一段思考可能同时存在于 thinking 消息与 item.reasoning.text：去重后按序返回。
  const reasoningTexts = (item) => {
    const texts = []
    if (pendingReasoning) texts.push(pendingReasoning)
    const inline = item && item.reasoning && typeof item.reasoning === 'object' && typeof item.reasoning.text === 'string'
      ? item.reasoning.text
      : ''
    if (inline && inline.trim() && inline !== pendingReasoning) texts.push(inline)
    pendingReasoning = null
    return texts
  }

  for (const item of history) {
    if (!item || typeof item !== 'object') continue
    const message = item.message
    if (!message || typeof message !== 'object') continue
    const role = message.role

    if (role === 'user') {
      const prompt = messageText(message.content)
      if (prompt.trim()) openTurn(prompt)
    } else if (role === 'thinking') {
      const text = messageText(message.content)
      // 被安全策略隐藏的思考（redactedThinking）没有正文 → 不虚构内容
      if (text.trim()) pendingReasoning = pendingReasoning ? pendingReasoning + '\n' + text : text
    } else if (role === 'assistant') {
      const step = openStep(reasoningTexts(item))
      if (step) {
        const text = messageText(message.content)
        if (text) step.content.push({ type: 'text', text })
        for (const call of toolCallsOf(message, item)) {
          // assistant 内容必须携带 tool-call 块（wire 的 tool_calls 从 content 派生）
          step.content.push({ type: 'tool-call', ...call })
          step.toolCalls.push(call)
          callSteps.set(call.id, step)
        }
      }
    } else if (role === 'tool') {
      const callId = typeof message.toolCallId === 'string' ? message.toolCallId : null
      const step = callId ? callSteps.get(callId) : null
      // 孤儿结果（转录从中途开始 / 调用来自更早的压缩段）丢弃并计数：挂最近一步会
      // 投影出无 call 的孤儿 tool 消息，被模型 API 拒绝
      if (!step) { droppedOrphanResults++; continue }
      const text = messageText(message.content)
      step.toolResults.push({
        toolCallId: callId,
        content: text ? [{ type: 'text', text }] : [],
        isError: false,
      })
    }
    // system 及其它角色（developer 等）忽略

    // 压缩摘要：core 不裁剪 history（原文全量保留在文件里），但源的模型视角在压缩点之后
    // 只剩「摘要 + 其后的消息」。默认导入为 **DSH 原生压缩检查点**：此刻已建的轮全部 log-only
    // （正文照常留在日志里），摘要作检查点，挂到压缩点之后的第一个轮；fullHistory: true 时不发
    // 检查点，摘要按既有形态（reasoning 块）挂到当前步骤。
    const summary = typeof item.conversationSummary === 'string' ? item.conversationSummary.trim() : ''
    if (summary) {
      if (args.fullHistory === true) {
        if (cur) {
          const step = lastStep || openStep([])
          if (step) {
            step.content.push({ type: 'reasoning', text: 'Previous conversation summary:\n\n' + summary })
            compactionSummaries++
          }
        }
      } else {
        for (const t of turns) t.shadowed = true
        cur = null
        lastStep = null
        pendingReasoning = null
        compactionSummaries++
        pendingCompaction = { summary, provider: 'continue', model: model || undefined }
      }
    }
  }

  // 结果回退：tool 消息缺失（会话中断、CLI 未落盘）但 toolCallStates 带了 output 时，
  // 用真实输出补齐配对；仍无结果的调用由 synthesizeSession 补空结果（不变量兜底）。
  const coveredCallIds = new Set()
  for (const t of turns) for (const s of t.steps) for (const tr of s.toolResults) coveredCallIds.add(tr.toolCallId)
  // callId → 携带该 state 的对象（一次遍历建索引，避免按调用重扫 history）
  const stateByCallId = new Map()
  for (const item of history) {
    if (!item || !Array.isArray(item.toolCallStates)) continue
    for (const state of item.toolCallStates) {
      if (state && typeof state === 'object' && typeof state.toolCallId === 'string') {
        stateByCallId.set(state.toolCallId, state)
      }
    }
  }
  for (const t of turns) {
    for (const s of t.steps) {
      for (const call of s.toolCalls) {
        if (coveredCallIds.has(call.id)) continue
        const state = stateByCallId.get(call.id)
        const text = stateOutputText(state)
        if (text === null) continue
        s.toolResults.push({
          toolCallId: call.id,
          content: [{ type: 'text', text }],
          isError: stateIsError(state),
        })
        coveredCallIds.add(call.id)
      }
    }
  }

  const sessionId = args.sessionId || mintSessionId(sourceId || args.continueId)
  const src = sourceId || args.continueId || sessionId
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: args.createdAt ?? Date.now() }
  meta.sourceId = src
  if (cwd) meta.cwd = cwd

  // 标题：session.title 是显式标题（默认常量 'New Session' 除外）→ 钉 session/title
  // 事件；否则首问兜底，只回填 out.title（DSH 自动回退首条 user 文本）。
  // 待落检查点没等到新轮（文件正好停在压缩点）：空 prompt 轮兜住，否则边界无处发射
  if (pendingCompaction) {
    turns.push({ prompt: '', steps: [], compaction: pendingCompaction })
    pendingCompaction = null
  }

  const explicitTitle = typeof session.title === 'string'
    && session.title.trim()
    && session.title.trim() !== DEFAULT_TITLE
  const finalTitle = normalizeTitle(
    explicitTitle ? session.title : (turns.length > 0 ? turns[0].prompt : ''),
  )
  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, args.budget)
  const syn = synthesizeSession({
    meta,
    turns: seedTurns,
    title: explicitTitle ? finalTitle : undefined,
    provider: 'continue',
    model,
    skipped: 0,
    records: history.length,
    imported: { sourcePath: args.sourcePath },
  })
  return {
    ...syn,
    title: finalTitle,
    droppedOrphanResults,
    compactionSummaries,
    // compacted/compactions：原生压缩检查点（syn.compactions 是实际发射的检查点数）
    ...(syn.compactions ? { compacted: true } : {}),
    ...(trimmed ? { trimmed } : {}),
  }
}

// 索引里的 dateCreated 是「毫秒字符串」（String(Date.now())），不是时间戳文本 →
// 纯数字串按数值解析；其余形态（ISO 等）回退 parseTime。
function indexTime(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const t = v.trim()
    if (/^\d+$/.test(t)) {
      const n = Number(t)
      if (Number.isFinite(n)) return n
    }
  }
  return parseTime(v)
}

// Continue sessions.json 索引 → 会话元数据映射（发现层用；索引只有 sessionId/title/
// dateCreated/workspaceDirectory，文件里没有时间戳）。
// 容错：索引可被用户手工编辑或落后于磁盘，畸变条目按 null 返回由调用方回退到文件。
export function readContinueIndex(raw) {
  let list
  try {
    list = JSON.parse(raw)
  } catch {
    return new Map()
  }
  const out = new Map()
  if (!Array.isArray(list)) return out
  for (const rec of list) {
    if (!rec || typeof rec !== 'object') continue
    const id = typeof rec.sessionId === 'string' && rec.sessionId ? rec.sessionId : null
    if (!id) continue
    out.set(id, {
      title: typeof rec.title === 'string' ? rec.title : '',
      createdAt: indexTime(rec.dateCreated),
      cwd: typeof rec.workspaceDirectory === 'string' && rec.workspaceDirectory ? rec.workspaceDirectory : null,
    })
  }
  return out
}
