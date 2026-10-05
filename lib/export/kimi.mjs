// lib/export/kimi.mjs — DSH 会话事件 → Kimi CLI wire.jsonl（纯函数）
//
// 写出可被 convertKimiWire 再导入的最小 wire 事件流（矩阵化互转
// DSH↔Kimi）：首行 metadata，其后按 DSH seq 顺序映射——
//   user/message（source.kind=user）→ TurnBegin { user_input }
//   assistant/message → StepBegin + TextPart（text）/ ThinkPart（reasoning）
//   tool/call → ToolCall { id, function: { name, arguments } }
//   tool/result → ToolResult { tool_call_id, return_value: { output, is_error } }
//   turn/end → TurnEnd
// 目标 = 双向往返：Kimi 侧（grok/CLI）能看见同一段对话，DSH 续聊后可导回。

import { randomUUID } from 'node:crypto'
import { toolResultOf } from '../convert/shape.mjs'
import { sanitizeParseError } from '../convert/core.mjs'

function eventIso(ev, meta) {
  const ms = typeof ev.time === 'number' ? ev.time
    : meta && typeof meta.createdAt === 'number' ? meta.createdAt
      : Date.now()
  return Math.floor(ms / 1000) // Kimi wire 时间戳是 Unix 秒
}

function hasSurfaceEvents(events) {
  return (Array.isArray(events) ? events : []).some((ev) => ev && (
    (ev.type === 'user/message' && ev.data && ev.data.source && ev.data.source.kind === 'user')
    || ev.type === 'assistant/message'
    || ev.type === 'tool/result'
  ))
}

// content blocks → 文本/推理 parts（非文本块跳过计数）。
function splitBlocks(blocks) {
  let skipped = 0
  const texts = []
  const thinks = []
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || typeof b !== 'object') { skipped++; continue }
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else if (b.type === 'reasoning' && typeof b.text === 'string') thinks.push(b.text)
    else skipped++
  }
  return { texts, thinks, skipped }
}

export function serializeKimiRecords(events, { meta, sessionUuid, emitHeader = true }) {
  const list = Array.isArray(events) ? events : []
  const records = []
  let skippedInjections = 0
  let skippedBlocks = 0
  let toolCalls = 0
  let toolResults = 0
  let droppedToolResults = 0
  const resultedCalls = new Set()

  if (emitHeader) {
    records.push({ type: 'metadata', protocol_version: '1.0', session_id: String(sessionUuid) })
  }

  for (const ev of list) {
    if (!ev) continue
    const ts = eventIso(ev, meta)
    const data = ev.data || {}
    switch (ev.type) {
      case 'user/message': {
        if (!data.source || data.source.kind !== 'user') { skippedInjections++; break }
        const { texts, skipped } = splitBlocks(data.content)
        skippedBlocks += skipped
        const text = texts.join('\n')
        if (!text) break
        records.push({ timestamp: ts, message: { type: 'TurnBegin', payload: { user_input: text } } })
        break
      }
      case 'assistant/message': {
        const msg = data.message || {}
        const { texts, thinks, skipped } = splitBlocks(msg.content)
        skippedBlocks += skipped
        if (texts.length === 0 && thinks.length === 0 && skipped === 0) break
        records.push({ timestamp: ts, message: { type: 'StepBegin', payload: { n: 1 } } })
        for (const text of texts) {
          records.push({ timestamp: ts, message: { type: 'TextPart', payload: { text } } })
        }
        for (const think of thinks) {
          records.push({ timestamp: ts, message: { type: 'ThinkPart', payload: { think } } })
        }
        break
      }
      case 'tool/call': {
        records.push({
          timestamp: ts,
          message: {
            type: 'ToolCall',
            payload: {
              id: data.callId || randomUUID(),
              function: { name: data.name || 'unknown', arguments: typeof data.arguments === 'string' ? data.arguments : '{}' },
            },
          },
        })
        toolCalls++
        break
      }
      case 'tool/result': {
        // 形状无关读取（V3 wrapper / V4 一级 tool 消息）
        const result = toolResultOf(ev)
        const callId = result && result.callId
        if (!callId) { droppedToolResults++; break }
        const block = { content: result.blocks, isError: result.isError }
        const { texts, thinks, skipped } = splitBlocks(result.blocks)
        skippedBlocks += skipped
        const output = [...texts, ...thinks]
        records.push({
          timestamp: ts,
          message: {
            type: 'ToolResult',
            payload: {
              tool_call_id: callId,
              return_value: {
                output: output.length === 0 ? '' : output.length === 1 ? output[0] : output,
                ...(block && block.isError === true ? { is_error: true } : {}),
              },
            },
          },
        })
        resultedCalls.add(callId)
        toolResults++
        break
      }
      case 'turn/end': {
        records.push({ timestamp: ts, message: { type: 'TurnEnd', payload: {} } })
        break
      }
      default:
        break // turn/start、step/*、session/* 等不产生 wire 记录
    }
  }
  return { records, toolCalls, toolResults, droppedToolResults, skippedInjections, skippedBlocks }
}

export function serializeKimiWire({ meta, events, sessionUuid }, _opts = {}) {
  if (!hasSurfaceEvents(events)) throw new Error('无可导出内容')
  const out = serializeKimiRecords(events, { meta, sessionUuid, emitHeader: true })
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

export function verifyKimiWire(jsonl) {
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
      errors.push({ line: i + 1, error: 'JSON 解析失败: ' + sanitizeParseError(err) })
      continue
    }
    count++
    if (rec && rec.type === 'metadata') sawMeta = true
    else if (rec && (!rec.message || typeof rec.message.type !== 'string')) {
      errors.push({ line: i + 1, error: '记录缺 message.type' })
    }
  }
  if (count === 0) errors.push({ line: 1, error: '无任何记录' })
  else if (!sawMeta) errors.push({ line: 1, error: '缺少 metadata 首行' })
  return errors.length ? { ok: false, errors } : { ok: true, recordCount: count }
}
