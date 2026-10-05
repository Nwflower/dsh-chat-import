// lib/convert/openclaw.mjs — OpenClaw 会话 JSONL → DSH 会话（纯函数）
//
// 存储：~/.openclaw/agents/<agent>/sessions/*.jsonl（每文件一个会话，与 sessions.json
// 索引同目录）。行是事件流，两种事件：
//   - { type:"session", id, cwd, timestamp }：会话元数据（可能首行），取 id/cwd/创建时间；
//   - { type:"message", message:{ role, content }, timestamp }：对话消息。
// role ∈ user / assistant / toolResult（→ 工具结果）；content 为 string 或 Claude 风格
// block 数组（text/thinking/tool_use/tool_result/...），尾部可能带 OpenClaw gateway 注入
// 的 "\n[message_id: ...]" 元数据（对齐 cc-switch strip_message_id_suffix，剥离）。
// 消息 → 回合映射：user → 新轮（prompt）；assistant → 一步（tool_use block → tool-call，
// 记入未配对调用）；toolResult → tool/result：块内 tool_result 按 tool_use_id 配对，纯
// 文本（无 id）回填最近未配对调用，显式 id 找不到声明或重复结果的孤儿丢弃计数。结果
// 挂回声明它的 step（异步结果跨 step 到达也合法），保证投影出的 LLM 消息里 tool 消息
// 紧跟其 tool_calls 的 assistant（wire 规则）。
// 标题优先级：args.displayName（index 层从 sessions.json 读，见 openclawDisplayNames）
// > 首条 user 文本 > cwd basename。tool/call 必有 tool/result（缺结果由 synthesizeSession
// 补空），配对不变量对齐现有 P0。
// args：sourcePath / sessionId / budget / displayName 透传；openclawId 可选（sourceId
// 兜底，index 层可传文件 stem）。

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
import { normalizeTitle } from './util.mjs'

// 剥离 OpenClaw gateway 注入的尾部元数据 `\n[message_id: ...]`（对齐 cc-switch
// strip_message_id_suffix：lastIndexOf + trim_end）。
function stripMessageIdSuffix(text) {
  const pos = text.lastIndexOf('\n[message_id:')
  return pos === -1 ? text : text.slice(0, pos).trimEnd()
}

// 内容 → 纯文本（对齐 cc-switch extract_text：string 原样 / block 数组按块抽取并以
// \n 连接 / {text} 对象取 text），并剥 message_id 尾缀。
function extractOpenclawText(content) {
  if (typeof content === 'string') return stripMessageIdSuffix(content)
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' ? extractOpenclawText(b) : ''))
      .filter((t) => t.trim())
      .join('\n')
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return stripMessageIdSuffix(content.text)
  return ''
}

// 路径 → basename（对齐 cc-switch path_basename：去尾分隔符后取最后一段）。
function pathBasename(value) {
  const t = String(value ?? '').trim().replace(/[\\/]+$/, '')
  if (!t) return ''
  return t.split(/[\\/]/).pop() || ''
}

// sessions.json 索引 → Map(sessionId → displayName)。纯函数：入参为索引文件原文
//（index 层读 ~/.openclaw/agents/<agent>/sessions/sessions.json 后传入，再按
// sessionId 取 displayName 作为 args.displayName）。索引缺失/非对象/空 displayName
// 一律不进 Map（对齐 cc-switch load_display_names）。
export function openclawDisplayNames(indexJson) {
  const map = new Map()
  let index
  try {
    index = JSON.parse(indexJson)
  } catch {
    // 索引缺失或非 JSON：无可用 displayName
    return map
  }
  if (!index || typeof index !== 'object') return map
  for (const entry of Object.values(index)) {
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.sessionId === 'string' && typeof entry.displayName === 'string' && entry.displayName.trim()) {
      map.set(entry.sessionId, entry.displayName.trim())
    }
  }
  return map
}

// tool_result 块内部内容 → DSH content blocks（text/thinking 经 mapContentBlock；
// 字符串按文本，剥 message_id 尾缀）。
function mapToolResultContent(inner) {
  if (typeof inner === 'string') {
    const text = stripMessageIdSuffix(inner).trim()
    return text ? [{ type: 'text', text }] : []
  }
  if (Array.isArray(inner)) return inner.map(mapContentBlock).filter(Boolean)
  return []
}

// toolResult 消息内容 → 工具结果列表 [{ toolCallId?, content, isError }]。块数组优先
// 取 tool_result 块（按 tool_use_id 配对）；无 tool_result 块（字符串/纯文本块/对象）
// 整条按文本结果返回（由调用方回填最近未配对调用）。
function extractToolResults(content) {
  if (typeof content === 'string') {
    const text = stripMessageIdSuffix(content).trim()
    return text ? [{ content: [{ type: 'text', text }], isError: false }] : []
  }
  if (Array.isArray(content)) {
    const results = []
    let hasToolResult = false
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'tool_result') {
        hasToolResult = true
        results.push({
          toolCallId: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
          content: mapToolResultContent(block.content),
          isError: block.is_error === true,
        })
      }
    }
    if (hasToolResult) return results
  }
  const text = stripMessageIdSuffix(extractOpenclawText(content)).trim()
  return text ? [{ content: [{ type: 'text', text }], isError: false }] : []
}

export function convertOpenclawJson(raw, args = {}) {
  // 逐行解析带行号明细（畸形行计数不设限，明细封顶 200）+ secrets 位置
  const { recs, skipped, skippedLines, secrets } = parseJsonlLines(raw)

  let sourceId = null
  let cwd = null
  let createdAt = null
  let firstUserText = null
  const turns = []
  let cur = null
  // callId → 声明它的 step：toolResult 按 id 挂回 call 所在 step（异步结果跨 step
  // 到达也合法——synthesizeSession 按会话级 callId 索引回填 sourceEventSeqs）
  const callSteps = new Map()
  // 未配对调用声明顺序：无 id 的纯文本 toolResult 按最近声明回填
  const unresolved = []
  const resolved = new Set()
  let droppedToolResults = 0

  for (const rec of recs) {
    if (!rec || typeof rec !== 'object') continue
    if (rec.type === 'session') {
      if (typeof rec.id === 'string' && sourceId === null) sourceId = rec.id
      if (typeof rec.cwd === 'string' && cwd === null) cwd = rec.cwd
      if (createdAt === null && rec.timestamp !== undefined) createdAt = parseTime(rec.timestamp)
      continue
    }
    if (rec.type !== 'message') continue
    const msg = rec.message
    if (!msg || typeof msg !== 'object') continue
    if (createdAt === null && rec.timestamp !== undefined) createdAt = parseTime(rec.timestamp)
    const recTime = parseTimeMs(rec.timestamp)

    if (msg.role === 'user') {
      const prompt = extractOpenclawText(msg.content).trim()
      if (!prompt) continue
      cur = { prompt, steps: [] }
      if (recTime !== null) cur.time = recTime
      turns.push(cur)
      if (firstUserText === null) firstUserText = prompt
    } else if (msg.role === 'assistant' && cur) {
      const step = { content: [], toolCalls: [], toolResults: [] }
      if (recTime !== null) step.time = recTime
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          const mapped = mapContentBlock(block)
          if (!mapped) continue
          if (mapped.type === 'tool-call') {
            // 无 id 的调用无法配对（会投影出缺 tool 消息的 assistant），整块丢弃
            if (typeof mapped.id !== 'string' || !mapped.id) continue
            step.content.push(mapped)
            step.toolCalls.push(mapped)
            callSteps.set(mapped.id, step)
            unresolved.push(mapped.id)
          } else {
            step.content.push(mapped)
          }
        }
      } else {
        const text = extractOpenclawText(msg.content).trim()
        if (text) step.content.push({ type: 'text', text })
      }
      cur.steps.push(step)
    } else if (msg.role === 'toolResult') {
      for (const r of extractToolResults(msg.content)) {
        let callId
        if (typeof r.toolCallId === 'string') {
          // 显式 id 必须命中已声明调用，否则孤儿丢弃（对齐 claude.mjs 孤儿结果语义）
          if (!callSteps.has(r.toolCallId)) { droppedToolResults++; continue }
          callId = r.toolCallId
        } else {
          const last = unresolved[unresolved.length - 1]
          if (last === undefined) { droppedToolResults++; continue }
          callId = last
        }
        if (resolved.has(callId)) { droppedToolResults++; continue }
        resolved.add(callId)
        const i = unresolved.indexOf(callId)
        if (i !== -1) unresolved.splice(i, 1)
        const step = callSteps.get(callId)
        if (!step) { droppedToolResults++; continue }
        step.toolResults.push({ toolCallId: callId, ...(recTime !== null ? { time: recTime } : {}), content: r.content, isError: r.isError })
      }
    }
  }

  // 同一步内多个结果按 call 声明顺序稳定排序（并行工具乱序返回时保证投影出的
  // tool 消息与 assistant 的 tool_calls 一一对应、顺序一致）
  for (const t of turns) {
    for (const s of t.steps) {
      if (s.toolResults.length < 2 || s.toolCalls.length === 0) continue
      const order = new Map(s.toolCalls.map((c, i) => [c.id, i]))
      s.toolResults.sort((a, b) => {
        const ia = order.get(a.toolCallId)
        const ib = order.get(b.toolCallId)
        return (ia === undefined ? s.toolCalls.length : ia) - (ib === undefined ? s.toolCalls.length : ib)
      })
    }
  }

  // 源会话 id 兜底：session 事件 id > args.openclawId（index 层传的文件 stem）>
  // sourcePath 文件 stem；均无则 mintSessionId 退化为时间戳 id
  const fileStem = typeof args.sourcePath === 'string'
    ? String(args.sourcePath).split(/[\\/]/).pop().replace(/\.jsonl$/i, '')
    : null
  const srcId = sourceId || args.openclawId || fileStem || null
  const meta = {
    version: SESSION_FORMAT_VERSION,
    id: args.sessionId || mintSessionId(srcId),
    createdAt: createdAt ?? Date.now(),
  }
  if (srcId) meta.sourceId = srcId
  if (cwd) meta.cwd = cwd

  // 标题：displayName（显式）钉 session/title 事件；首问/目录名只回填
  // out.title（DSH 自动回退首条 user 文本，钉与不钉结果相同）
  const displayName = typeof args.displayName === 'string' && args.displayName.trim() ? args.displayName.trim() : null
  const finalTitle = normalizeTitle(displayName || firstUserText || pathBasename(cwd))
  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, args.budget)
  const syn = synthesizeSession({
    meta,
    turns: seedTurns,
    title: displayName ? finalTitle : undefined,
    provider: 'openclaw',
    model: 'openclaw',
    skipped,
    records: recs.length,
    skippedLines,
    secrets,
    imported: { sourcePath: args.sourcePath },
  })
  return { ...syn, title: finalTitle, droppedToolResults, ...(trimmed ? { trimmed } : {}) }
}
