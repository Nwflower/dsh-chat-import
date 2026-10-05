// lib/convert/cursor.mjs — Cursor agent transcript JSONL → DSH 会话（纯函数）

import {
  SESSION_FORMAT_VERSION,
  finishSession,
  mintSessionId,
  parseJsonlLines,
} from './core.mjs'
import { normalizeTitle } from './util.mjs'

/** 从 Cursor 首条 user 文本的 <timestamp>…</timestamp> 解析毫秒时间戳。 */
export function parseCursorEmbeddedTimestamp(text) {
  const m = String(text ?? '').match(/<timestamp>\s*([^<]+?)\s*<\/timestamp>/i)
  if (!m) return undefined
  const cleaned = m[1].replace(/\s*\(UTC[^)]*\)\s*/gi, ' ').trim()
  const n = Date.parse(cleaned)
  return Number.isFinite(n) ? n : undefined
}

/** 剥离 Cursor 提问里的 <timestamp> 与 <user_query> 包裹（提问正文与面板标题同一口径）。 */
export function stripCursorTitleDecorations(text) {
  return String(text ?? '')
    .replace(/<timestamp>[\s\S]*?<\/timestamp>\s*/gi, '')
    .replace(/<\/?user_query>/gi, '')
    .trim()
}

// Cursor agent transcript JSONL → DSH 会话。
//
// 存储：~/.cursor/projects/<slug>/agent-transcripts/<composer-uuid>/<composer-uuid>.jsonl。
// 行结构：{ role: 'user'|'assistant', message: { content: [...] } }，无 envelope。
// content 只有 text / tool_use 两种块（input 已是解析后的对象，非 JSON 字符串）。
// 与 Claude 的差异：
//   - 用户首条消息包在 <user_query>…</user_query> 里（剥离标签）；
//   - transcript 不含 tool_result（工具结果只在 bubble store 里）→ 只发 tool/call；
//   - assistant 文本常有 "[REDACTED]" 哨兵（客户端隐私剥离）→ 过滤；
//   - 无时间戳 / model / cwd（composer id 即会话 id）。
export function convertCursorJsonl(raw, args = {}) {
  // 逐行解析带行号明细（畸形行计数不设限，明细封顶 200）+ secrets 位置
  const { recs, skipped, skippedLines, secrets } = parseJsonlLines(raw)

  const turns = []
  let cur = null
  for (const rec of recs) {
    if (!rec || (rec.role !== 'user' && rec.role !== 'assistant')) continue
    const content = Array.isArray(rec.message?.content) ? rec.message.content : []
    if (rec.role === 'user') {
      // 提取文本块（剥离 <timestamp> / <user_query> 扫描包裹），合成用户提问 → 新轮
      const texts = []
      for (const block of content) {
        if (block && block.type === 'text' && typeof block.text === 'string') {
          const t = stripCursorTitleDecorations(block.text)
          if (t) texts.push(t)
        }
      }
      const prompt = texts.join('\n').trim()
      if (prompt) {
        cur = { prompt, steps: [] }
        turns.push(cur)
      }
    } else if (rec.role === 'assistant' && cur) {
      const step = { content: [], toolCalls: [], toolResults: [] }
      let toolIndex = 0
      const stepOrdinal = cur.steps.length + 1
      for (const block of content) {
        if (!block) continue
        if (block.type === 'text' && typeof block.text === 'string') {
          const t = cursorText(block.text)
          if (t) step.content.push({ type: 'text', text: t })
        } else if (block.type === 'tool_use') {
          toolIndex += 1
          const mapped = {
            id: block.id || ('cursor-' + turns.length + '-' + stepOrdinal + '-' + toolIndex),
            name: block.name || 'unknown',
            arguments: JSON.stringify(block.input ?? {}),
          }
          step.content.push({ type: 'tool-call', ...mapped })
          step.toolCalls.push(mapped)
        }
      }
      if (step.content.length > 0 || step.toolCalls.length > 0) {
        cur.steps.push(step)
      }
    }
  }

  // Cursor 无时间戳 / 会话内 id：会话 id 由 index 层从文件名（composer uuid）传入 args.cursorId，
  // 保证幂等；未传入时退化为时间戳（单文件手工导入仍可用）。sourceId 即 composer id。
  const finalId = args.sessionId || mintSessionId(args.cursorId)
  const meta = { version: SESSION_FORMAT_VERSION, id: finalId, createdAt: Date.now() }
  if (args.cursorId) meta.sourceId = args.cursorId
  if (typeof args.cwd === 'string' && args.cwd) meta.cwd = args.cwd
  if (typeof args.createdAt === 'number' && Number.isFinite(args.createdAt)) {
    meta.createdAt = args.createdAt
  }
  // 标题：首问（已剥离 timestamp/user_query）；session/title 由 import-core
  // pinSourcedSessionTitle 统一钉为「Cursor · 话题」，避免 UI 回退为工作区目录名。
  const firstPrompt = turns.length > 0 ? turns[0].prompt : ''
  const tsFromPrompt = parseCursorEmbeddedTimestamp(firstPrompt)
  if (tsFromPrompt) meta.createdAt = tsFromPrompt
  const finalTitle = normalizeTitle(firstPrompt)
  return finishSession(turns, args.budget, { meta, provider: 'cursor', model: 'cursor', skipped, records: recs.length, skippedLines, secrets }, { title: finalTitle })
}

// 过滤 Cursor 的 "[REDACTED]" 哨兵文本；整段被剥离后返回空串。
function cursorText(text) {
  const cleaned = text.replace(/\[REDACTED\]/g, '').trim()
  return cleaned
}
