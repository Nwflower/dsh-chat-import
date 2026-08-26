// lib/export/grokbuild.mjs — DSH 会话事件 → Grok Build chat_history.jsonl（纯函数）
//
// 写出 convertGrokbuildJson 能再读回的最小子集：user / assistant / tool 行。
// summary.json 由写回层单独维护（info.id / info.cwd / generated_title）。

function eventIso(ev, meta) {
  const ms = typeof ev.time === 'number' ? ev.time
    : meta && typeof meta.createdAt === 'number' ? meta.createdAt
      : Date.now()
  return new Date(ms).toISOString()
}

function textOf(blocks) {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

function hasSurfaceEvents(events) {
  return (Array.isArray(events) ? events : []).some((ev) => ev && (
    (ev.type === 'user/message' && ev.data && ev.data.source && ev.data.source.kind === 'user')
    || ev.type === 'assistant/message'
    || ev.type === 'tool/result'
  ))
}

export function serializeGrokbuildRecords(events, { meta } = {}) {
  const list = Array.isArray(events) ? events : []
  const records = []
  let skippedInjections = 0
  let toolCalls = 0
  let toolResults = 0
  let droppedToolResults = 0
  const pending = []

  for (const ev of list) {
    if (!ev) continue
    const ts = eventIso(ev, meta)
    const data = ev.data || {}
    if (ev.type === 'user/message') {
      if (!data.source || data.source.kind !== 'user') { skippedInjections++; continue }
      const text = textOf(data.content)
      if (!text) continue
      records.push({ type: 'user', content: [{ type: 'text', text }], timestamp: ts })
    } else if (ev.type === 'assistant/message') {
      const msg = data.message || {}
      const content = []
      const blocks = Array.isArray(msg.content) ? msg.content : []
      for (const b of blocks) {
        if (!b) continue
        if (b.type === 'text' && typeof b.text === 'string') content.push({ type: 'text', text: b.text })
        else if (b.type === 'reasoning' && typeof b.text === 'string') content.push({ type: 'thinking', thinking: b.text })
        else if (b.type === 'tool-call') {
          content.push({
            type: 'tool_use',
            id: b.id,
            name: b.name,
            input: (() => { try { return JSON.parse(b.arguments || '{}') } catch { return {} } })(),
          })
          pending.push(b.id)
          toolCalls++
        }
      }
      if (content.length > 0) records.push({ type: 'assistant', content, timestamp: ts })
    } else if (ev.type === 'tool/result') {
      const msg = data.message || {}
      const block = Array.isArray(msg.content) ? msg.content.find((b) => b && b.type === 'tool-result') : null
      const callId = (block && block.toolCallId) || (msg.source && msg.source.callId)
      if (!callId) { droppedToolResults++; continue }
      records.push({
        type: 'tool',
        tool_use_id: callId,
        content: textOf(block && block.content),
        timestamp: ts,
        ...(block && block.isError ? { is_error: true } : {}),
      })
      const i = pending.indexOf(callId)
      if (i !== -1) pending.splice(i, 1)
      toolResults++
    }
  }

  for (const callId of pending) {
    records.push({ type: 'tool', tool_use_id: callId, content: '', timestamp: eventIso({}, meta) })
    toolResults++
  }

  return { records, toolCalls, toolResults, droppedToolResults, skippedInjections }
}

export function serializeGrokbuildJsonl({ meta, events }) {
  if (!hasSurfaceEvents(events)) throw new Error('无可导出内容')
  const out = serializeGrokbuildRecords(events, { meta })
  return {
    jsonl: out.records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    recordCount: out.records.length,
    toolCalls: out.toolCalls,
    toolResults: out.toolResults,
    droppedToolResults: out.droppedToolResults,
    skippedInjections: out.skippedInjections,
  }
}

export function serializeGrokbuildJsonlTail({ meta, events }) {
  return serializeGrokbuildJsonl({ meta, events })
}

export function buildGrokSummary({ sessionUuid, cwd, title, createdAt, updatedAt, numMessages }) {
  const now = new Date(updatedAt || Date.now()).toISOString()
  return {
    info: { id: sessionUuid, cwd: cwd || '' },
    session_summary: title || '',
    generated_title: title || '',
    created_at: new Date(createdAt || Date.now()).toISOString(),
    updated_at: now,
    last_active_at: now,
    num_messages: numMessages || 0,
    num_chat_messages: numMessages || 0,
    chat_format_version: 1,
    originator: 'dsh-chat-import',
  }
}

export function verifyGrokbuildJsonl(jsonl) {
  const errors = []
  const text = String(jsonl)
  if (text && !text.endsWith('\n')) errors.push({ line: 1, error: '文件必须以恰好一个换行结尾' })
  const lines = text.split('\n')
  let count = 0
  for (let i = 0; i < lines.length; i++) {
    if (i === lines.length - 1 && text.endsWith('\n')) continue
    const t = lines[i].trim()
    if (!t) { errors.push({ line: i + 1, error: '空行' }); continue }
    try { JSON.parse(t) } catch (err) {
      errors.push({ line: i + 1, error: 'JSON 解析失败: ' + err.message })
      continue
    }
    count++
  }
  return errors.length ? { ok: false, errors } : { ok: true, recordCount: count }
}
