// lib/export/codex.mjs — DSH 会话事件 → Codex rollout JSONL（纯函数）
//
// 写出最小可被 convertCodexJsonl 再导入的子集：session_meta + response_item
//（user / assistant / function_call / function_call_output）。不做完整 Codex
// event_msg 镜像——目标是「Grok/Claude/DSH 续聊后，Codex 能看见同一段对话」。

import { randomUUID } from 'node:crypto'

function eventIso(ev, meta, fallbackMs) {
  const ms = typeof ev.time === 'number' ? ev.time
    : meta && typeof meta.createdAt === 'number' ? meta.createdAt
      : fallbackMs !== undefined ? fallbackMs : Date.now()
  return new Date(ms).toISOString()
}

function textOf(blocks) {
  if (typeof blocks === 'string') return { value: blocks, skipped: 0 }
  if (!Array.isArray(blocks)) return { value: '', skipped: 0 }
  let skipped = 0
  const texts = []
  for (const b of blocks) {
    if (b && b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else skipped++
  }
  return { value: texts.join('\n'), skipped }
}

function hasSurfaceEvents(events) {
  return (Array.isArray(events) ? events : []).some((ev) => ev && (
    (ev.type === 'user/message' && ev.data && ev.data.source && ev.data.source.kind === 'user')
    || ev.type === 'assistant/message'
    || ev.type === 'tool/result'
  ))
}

function envelope(type, payload, timestamp) {
  return { timestamp, type, payload }
}

export function serializeCodexRecords(events, { meta, sessionUuid, cwd, emitHeader = true }) {
  const list = Array.isArray(events) ? events : []
  const sessionId = String(sessionUuid)
  const records = []
  let skippedInjections = 0
  let skippedBlocks = 0
  let toolCalls = 0
  let toolResults = 0
  let droppedToolResults = 0
  const pendingCalls = new Set()

  if (emitHeader) {
    records.push(envelope('session_meta', {
      id: sessionId,
      session_id: sessionId,
      timestamp: eventIso({ time: meta && meta.createdAt }, meta),
      cwd: cwd || (meta && meta.cwd) || '',
      originator: 'dsh-chat-import',
      source: 'dsh',
    }, eventIso({ time: meta && meta.createdAt }, meta)))
  }

  for (const ev of list) {
    if (!ev) continue
    const ts = eventIso(ev, meta)
    const data = ev.data || {}
    if (ev.type === 'user/message') {
      if (!data.source || data.source.kind !== 'user') { skippedInjections++; continue }
      const { value: text, skipped } = textOf(data.content)
      skippedBlocks += skipped
      if (!text) continue
      records.push(envelope('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      }, ts))
    } else if (ev.type === 'assistant/message') {
      const msg = data.message || {}
      const { value: text, skipped } = textOf(msg.content)
      skippedBlocks += skipped
      if (text) {
        records.push(envelope('response_item', {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        }, ts))
      }
    } else if (ev.type === 'tool/call') {
      const callId = data.callId || randomUUID()
      records.push(envelope('response_item', {
        type: 'function_call',
        call_id: callId,
        name: data.name || 'unknown',
        arguments: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}),
      }, ts))
      pendingCalls.add(callId)
      toolCalls++
    } else if (ev.type === 'tool/result') {
      const msg = data.message || {}
      const block = Array.isArray(msg.content) ? msg.content.find((b) => b && b.type === 'tool-result') : null
      const callId = (block && block.toolCallId) || (msg.source && msg.source.callId)
      if (!callId) { droppedToolResults++; continue }
      const { value: output, skipped } = textOf(block && block.content)
      skippedBlocks += skipped
      records.push(envelope('response_item', {
        type: 'function_call_output',
        call_id: callId,
        output,
      }, ts))
      pendingCalls.delete(callId)
      toolResults++
    }
  }

  for (const callId of pendingCalls) {
    records.push(envelope('response_item', {
      type: 'function_call_output',
      call_id: callId,
      output: '',
    }, eventIso({}, meta)))
    toolResults++
  }

  return { records, toolCalls, toolResults, droppedToolResults, skippedInjections, skippedBlocks }
}

export function serializeCodexJsonl({ meta, events, sessionUuid, cwd }, _opts = {}) {
  if (!hasSurfaceEvents(events)) throw new Error('无可导出内容')
  const out = serializeCodexRecords(events, { meta, sessionUuid, cwd, emitHeader: true })
  return {
    jsonl: out.records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    recordCount: out.records.length,
    toolCalls: out.toolCalls,
    toolResults: out.toolResults,
    droppedToolResults: out.droppedToolResults,
    skippedInjections: out.skippedInjections,
    skippedBlocks: out.skippedBlocks,
  }
}

export function serializeCodexJsonlTail({ meta, events, sessionUuid, cwd }, _opts = {}) {
  if (!hasSurfaceEvents(events)) throw new Error('无可导出内容')
  const out = serializeCodexRecords(events, { meta, sessionUuid, cwd, emitHeader: false })
  return {
    jsonl: out.records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    recordCount: out.records.length,
    toolCalls: out.toolCalls,
    toolResults: out.toolResults,
    droppedToolResults: out.droppedToolResults,
    skippedInjections: out.skippedInjections,
    skippedBlocks: out.skippedBlocks,
  }
}

export function verifyCodexJsonl(jsonl) {
  const errors = []
  const text = String(jsonl)
  if (!text.endsWith('\n')) errors.push({ line: 1, error: '文件必须以恰好一个换行结尾' })
  const lines = text.split('\n')
  let count = 0
  let sawMeta = false
  for (let i = 0; i < lines.length; i++) {
    if (i === lines.length - 1 && text.endsWith('\n')) continue
    const t = lines[i].trim()
    if (!t) { errors.push({ line: i + 1, error: '空行' }); continue }
    let rec
    try { rec = JSON.parse(t) } catch (err) {
      errors.push({ line: i + 1, error: 'JSON 解析失败: ' + err.message })
      continue
    }
    count++
    if (rec && rec.type === 'session_meta') sawMeta = true
  }
  if (count === 0) errors.push({ line: 1, error: '无任何记录' })
  else if (!sawMeta) errors.push({ line: 1, error: '缺少 session_meta' })
  return errors.length ? { ok: false, errors } : { ok: true, recordCount: count }
}
