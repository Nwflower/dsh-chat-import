// lib/convert/qoder.mjs — Qoder CLI 会话 JSONL → DSH 会话（纯函数）
//
// Qoder CLI 把每会话 transcript 落盘为 ~/.qoder/projects/<encoded-project>/
// <sessionId>.jsonl（子代理 transcript 在 <sessionId>/subagents/*.jsonl）。逐行 JSON，
// 结构与 Claude Code 高度一致：
//   {"type":"user","uuid":"…","sessionId":"…","timestamp":"…","cwd":"…",
//    "message":{"role":"user","content": "…" | [content blocks]}}
//   {"type":"assistant","message":{"role":"assistant","content":[blocks]}}
//   {"type":"ai-title","aiTitle":"…"}     —— 标题（重命名后到者胜）
//   {"type":"last-prompt","lastPrompt":"…"} —— 标题兜底（ai-title 缺省时）
// content block：text / thinking（→reasoning）/ tool_use（{name,input}）/ tool_result
// （{content,tool_use_id?}）。user 记录：字符串 content 或不含 tool_result 的块数组 =
// 直连提问（开新轮，text 块拼接为 prompt）；含 tool_result 的块数组 = 工具结果。tool_result 按 tool_use_id 挂回 call 所属 step（对齐
// claude.mjs 的并行工具后置结果语义）；缺 tool_use_id 时按未决调用顺序回退配对。
// 标题选取：ai-title > last-prompt > 首问兜底。cwd 取记录内 cwd（Qoder 每轮都记录）。
// 与 claude 同款「主 transcript」判定：fileStem != sessionId 的辅助/subagent 文件跳过。

import {
  SESSION_FORMAT_VERSION,
  applyBudgetTrim,
  mapContentBlock,
  mintSessionId,
  parseJsonlLines,
  parseTime,
  parseTimeMs,
  synthesizeSession,
} from './core.mjs'

// 标题归一统一规则：去首尾空白、折叠内部空白；超 80 字符截断加省略号；
// 空白返回空串。core.mjs 属禁改面，各源按文件内联同款（改规则需逐源同步）。
const TITLE_MAX_LEN = 80
const TITLE_ELLIPSIS = '…'
function normalizeTitle(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return ''
  return t.length <= TITLE_MAX_LEN ? t : t.slice(0, TITLE_MAX_LEN - TITLE_ELLIPSIS.length) + TITLE_ELLIPSIS
}

// tool_result 块 → 配对 callId：优先显式 tool_use_id（Claude 同款），缺省返回 null
//（调用方按未决调用顺序回退配对）。
function toolResultCallId(block) {
  if (block && typeof block === 'object') {
    if (typeof block.tool_use_id === 'string' && block.tool_use_id) return block.tool_use_id
    if (typeof block.toolUseId === 'string' && block.toolUseId) return block.toolUseId
  }
  return null
}

export function convertQoderJsonl(raw, args = {}) {
  // 逐行解析带行号明细（畸形行计数不设限，明细封顶 200）+ secrets 位置
  const { recs, skipped, skippedLines, secrets } = parseJsonlLines(raw)

  let sourceId = null
  let title = null
  let lastPrompt = null
  let cwd = null
  let createdAt = null
  let model = null

  const turns = []
  let cur = null
  // callId → 它所属的 step：tool_result 按 id 挂回 call 所在 step（并行工具结果
  // 可能乱序/后置）；查不到显式 id 时按未决调用顺序回退配对。
  const callSteps = new Map()
  const unresolved = []
  let droppedToolResults = 0

  for (const rec of recs) {
    if (rec && typeof rec.sessionId === 'string' && !sourceId) sourceId = rec.sessionId
    if (rec && typeof rec.cwd === 'string' && !cwd) cwd = rec.cwd
    if (rec && rec.timestamp !== undefined && createdAt === null) createdAt = parseTime(rec.timestamp)
    const recTime = parseTimeMs(rec && rec.timestamp)
    if (rec && rec.type === 'ai-title' && typeof rec.aiTitle === 'string' && !title) title = rec.aiTitle
    if (rec && rec.type === 'last-prompt' && typeof rec.lastPrompt === 'string' && !lastPrompt) lastPrompt = rec.lastPrompt
    const recModel = rec ? (rec.message?.model ?? rec.model) : undefined
    if (typeof recModel === 'string' && !model) model = recModel

    const userBlocks = rec && rec.type === 'user' && Array.isArray(rec.message?.content) ? rec.message.content : null
    const isToolResultRec = userBlocks !== null && userBlocks.some((b) => b && b.type === 'tool_result')
    if (rec && rec.type === 'user' && rec.message && (typeof rec.message.content === 'string' || (userBlocks !== null && !isToolResultRec))) {
      // 直连人类提问 → 新轮。新版 Qoder 与新版 Claude Code 同款，直接提问也写数组
      // content（[{type:'text',...}]）；此前只认字符串，数组提问落进下方 tool_result
      // 分支被静默丢弃、整段对话 0 轮导入。纯文本块数组按 text 拼接作为 prompt；
      // 含 tool_result 块的数组只走下方配对分支，绝不在此开新轮（对齐 claude.mjs）。
      const prompt = userBlocks === null
        ? rec.message.content
        : userBlocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
      cur = { prompt, steps: [] }
      if (recTime !== null) cur.time = recTime
      turns.push(cur)
    } else if (rec && rec.type === 'assistant' && cur) {
      // 一条 assistant 消息 = 一步
      const step = { content: [], toolCalls: [], toolResults: [] }
      if (recTime !== null) step.time = recTime
      if (Array.isArray(rec.message?.content)) {
        for (const block of rec.message.content) {
          const mapped = mapContentBlock(block)
          if (!mapped) continue
          if (mapped.type === 'tool-call') {
            step.content.push(mapped)   // 助手内容里的 tool-call block
            step.toolCalls.push(mapped) // 同时作为 tool/call 事件
            callSteps.set(mapped.id, step)
            unresolved.push(mapped.id)
          } else {
            step.content.push(mapped)   // text / reasoning block
          }
        }
      } else if (typeof rec.message?.content === 'string') {
        step.content.push({ type: 'text', text: rec.message.content })
      }
      cur.steps.push(step)
    } else if (isToolResultRec) {
      // 工具结果：优先按 tool_use_id 挂到 call 所属 step，否则按未决调用顺序回退。
      for (const block of rec.message.content) {
        if (!(block && block.type === 'tool_result')) continue
        let callId = toolResultCallId(block)
        let step = callId ? callSteps.get(callId) : undefined
        if (!step && unresolved.length > 0) {
          // 顺序回退：取最早未决调用（Qoder 个别版本 tool_result 不带 tool_use_id）
          callId = unresolved.shift()
          step = callSteps.get(callId)
        }
        if (!step) { droppedToolResults++; continue }
        if (callId && unresolved.includes(callId)) unresolved.splice(unresolved.indexOf(callId), 1)
        const inner = (Array.isArray(block.content) ? block.content : [])
          .map(mapContentBlock)
          .filter(Boolean)
        step.toolResults.push({
          toolCallId: callId,
          ...(recTime !== null ? { time: recTime } : {}),
          content: inner,
          isError: block.is_error === true,
        })
      }
    }
    // 其余记录类型（mode / summary / subagent 元数据等）不产生对话内容，跳过
  }

  // 只有主 transcript（文件名 = <sessionId>.jsonl）是独立会话。Qoder 的子代理
  // transcript 在 <sessionId>/subagents/*.jsonl，记录携带父 sessionId，若按它建会话
  // 会与主 transcript 撞 id：先扫描到的文件占会话、主内容被幂等跳过而丢失。
  // 文件名与记录 sessionId 不一致的一律跳过并给原因（对齐 claude 语义）。
  const fileStem = typeof args.fileStem === 'string' ? args.fileStem : null
  if (fileStem && sourceId && fileStem !== sourceId) {
    return {
      meta: null, events: [], turns: [], title: null, messages: 0, toolCalls: 0,
      skipped: 0, records: recs.length, droppedToolResults: 0,
      skippedLines: [], secrets: [],
      skipReason: 'auxiliary/subagent transcript (file "' + fileStem + '" does not match sessionId "' + sourceId + '"); only the main <sessionId>.jsonl becomes a session',
    }
  }

  const sessionId = args.sessionId || mintSessionId(sourceId)
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: createdAt ?? Date.now() }
  if (sourceId) meta.sourceId = sourceId
  if (cwd) meta.cwd = cwd

  // 标题选取：ai-title > last-prompt > 首问兜底。显式标题（归一后非空）钉
  // session/title 事件；纯首问兜底只回填 out.title（DSH 自动回退首条 user 文本）。
  const explicitTitle = (title && title.trim()) || (lastPrompt && lastPrompt.trim()) || null
  const finalTitle = normalizeTitle(explicitTitle || (turns.length > 0 ? turns[0].prompt : ''))
  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, args.budget)
  const syn = synthesizeSession({
    meta,
    turns: seedTurns,
    title: explicitTitle ? finalTitle : undefined,
    provider: 'qoder',
    model,
    skipped,
    records: recs.length,
    skippedLines,
    secrets,
    imported: { sourcePath: args.sourcePath },
  })
  return { ...syn, title: finalTitle, droppedToolResults, ...(trimmed ? { trimmed } : {}) }
}
