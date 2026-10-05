// lib/export/common.mjs — 各反向导出格式共用的小件（纯函数，零 DSH 依赖）
import { sanitizeParseError } from '../convert/core.mjs'

// 是否存在可导出的 surface 事件（user 直连提问 / assistant / tool/result）。没有就是空
// 会话，各序列化器据此抛「无可导出内容」。
export function hasSurfaceEvents(events) {
  return (Array.isArray(events) ? events : []).some((ev) => ev && (
    (ev.type === 'user/message' && ev.data && ev.data.source && ev.data.source.kind === 'user')
    || ev.type === 'assistant/message'
    || ev.type === 'tool/result'
  ))
}

// 事件时间（毫秒）：缺失回退 meta.createdAt，再回退 fallbackMs，最后回退当前时刻。
export function eventTimeMs(ev, meta, fallbackMs) {
  return typeof ev.time === 'number' ? ev.time
    : meta && typeof meta.createdAt === 'number' ? meta.createdAt
      : fallbackMs !== undefined ? fallbackMs : Date.now()
}

// 同 eventTimeMs，格式化为 ISO8601。
export function eventIso(ev, meta, fallbackMs) {
  return new Date(eventTimeMs(ev, meta, fallbackMs)).toISOString()
}

// 记录序列化结果 → JSONL 文本（每条一行、以恰好一个换行结尾）与统一的计数外形。
export function jsonlResult(out) {
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

// JSONL 文件只读校验的共用骨架：恰好一个换行结尾、无空行、逐行 JSON 合法（报错经
// sanitizeParseError，不回显行内容）、至少一条记录、存在头记录。isHeader(rec) 判定头
// 记录；checkRecord(rec)（可选）返回非头记录的问题描述，无问题返回 null；headerMissing
// 是缺头记录时的报错。返回 { ok: true, recordCount } 或 { ok: false, errors: [{ line, error }] }。
export function verifyJsonlRecords(jsonl, { isHeader, headerMissing, checkRecord }) {
  const errors = []
  const text = String(jsonl)
  if (!text.endsWith('\n')) errors.push({ line: 1, error: '文件必须以恰好一个换行结尾' })
  const lines = text.split('\n')
  let count = 0
  let sawHeader = false
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
    if (isHeader(rec)) {
      sawHeader = true
    } else if (checkRecord) {
      const problem = checkRecord(rec)
      if (problem) errors.push({ line: i + 1, error: problem })
    }
  }
  if (count === 0) errors.push({ line: 1, error: '无任何记录' })
  else if (!sawHeader) errors.push({ line: 1, error: headerMissing })
  return errors.length ? { ok: false, errors } : { ok: true, recordCount: count }
}
