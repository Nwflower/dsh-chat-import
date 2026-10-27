// lib/preview-sample.mjs — readable message sample of a converted session (panel preview).
//
// Every converter emits the same DSH event stream, so one extractor serves all 25+ sources:
// user/message (text in data.content), assistant/message (text in data.message.content) and
// tool/call (data.name). Messages injected by a plugin (the migration notice, the system
// prompt seat) are not part of the conversation and are skipped. Pure: no ctx, no I/O.

/** Default number of messages a preview carries (the panel shows them in a scrolling card). */
export const PREVIEW_SAMPLE_LIMIT = 200
/** Per-message character cap: a 40k-char paste must not turn the preview into a megabyte. */
export const PREVIEW_TEXT_MAX = 4000

const textOf = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n')
}

const injected = (data, message) => {
  const source = (message && message.source) || (data && data.source)
  return !!source && source.kind === 'plugin'
}

const clip = (text, max) => (text.length > max ? text.slice(0, max) + ' …' : text)

/**
 * Converted events → [{ role: 'user' | 'assistant' | 'tool', text, time? }], conversation order.
 * Consecutive tool calls fold into one 'tool' line ("Bash, Read ×2") so a 140-call turn does
 * not bury the text. Returns { messages, total, truncated }.
 */
export function previewSample(events, { limit = PREVIEW_SAMPLE_LIMIT, textMax = PREVIEW_TEXT_MAX } = {}) {
  const messages = []
  let total = 0
  let tools = null
  const flushTools = () => {
    if (!tools) return
    const parts = [...tools.counts].map(([name, n]) => (n > 1 ? name + ' ×' + n : name))
    messages.push({ role: 'tool', text: parts.join(', '), ...(tools.time ? { time: tools.time } : {}) })
    tools = null
  }
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e.type !== 'string') continue
    const data = e.data || {}
    if (e.type === 'tool/call') {
      const name = typeof data.name === 'string' && data.name ? data.name : 'tool'
      if (!tools) tools = { counts: new Map(), time: e.time }
      tools.counts.set(name, (tools.counts.get(name) || 0) + 1)
      continue
    }
    if (e.type !== 'user/message' && e.type !== 'assistant/message') continue
    const message = e.type === 'assistant/message' ? data.message : data
    if (!message || injected(data, message)) continue
    const text = textOf(message.content).trim()
    if (!text) continue
    flushTools()
    total++
    if (messages.length >= limit) continue
    messages.push({
      role: e.type === 'user/message' ? 'user' : 'assistant',
      text: clip(text, textMax),
      ...(typeof e.time === 'number' ? { time: e.time } : {}),
    })
  }
  if (messages.length < limit) flushTools()
  return { messages: messages.slice(0, limit), total, truncated: total > messages.filter((m) => m.role !== 'tool').length }
}
