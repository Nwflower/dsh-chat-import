// lib/convert/gemini.mjs — Gemini CLI 会话 JSON → DSH 会话（纯函数）

import {
  SESSION_FORMAT_VERSION,
  finishSession,
  mintSessionId,
  parseTime,
} from './core.mjs'
import { normalizeTitle, skipResult } from './util.mjs'

// Gemini CLI 会话 JSON → DSH 会话。
//
// 存储：~/.gemini/history/<slot>/chats/session-*.json（一文件一 JSON 对象，非 JSONL）。
// 顶层：{ sessionId, projectHash, startTime, directories, kind, messages: [...] }。
// messages 项：{ type: "user" | "gemini" | "info", content, model, toolCalls, thoughts }。
//   - user：content 是 parts 数组 [{text}] → 开新轮；
//   - gemini：content 是字符串，可带 toolCalls 与 thoughts（reasoning 摘要）；
//   - info：CLI 系统通知（错误横幅、取消等）→ 跳过；
//   - toolCalls：{ id, name, args, status, result: [{ functionResponse: { response: { output } } }] }
//     结果**内联**在同一对象上（与 Claude 拆分消息不同）→ tool/call + tool/result 一起发。
export function convertGeminiJson(raw, args = {}) {
  let chat
  try {
    chat = JSON.parse(raw)
  } catch {
    return skipResult(null, { skipped: 1 })
  }
  if (!chat || typeof chat !== 'object' || !Array.isArray(chat.messages)) return skipResult(null, { skipped: 1 })

  let model = null
  const turns = []
  let cur = null
  for (const msg of chat.messages) {
    if (!msg || typeof msg !== 'object') continue
    if (msg.type === 'user') {
      // parts 数组 → 用户提问（开新轮）
      const texts = []
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part && typeof part === 'object' && typeof part.text === 'string' && part.text.trim()) {
            texts.push(part.text.trim())
          }
        }
      }
      const prompt = texts.join('\n')
      if (prompt) {
        cur = { prompt, steps: [] }
        turns.push(cur)
      }
    } else if (msg.type === 'gemini' && cur) {
      const step = { content: [], toolCalls: [], toolResults: [] }
      if (!model && typeof msg.model === 'string') model = msg.model
      // 文本正文（string 或空串）
      if (typeof msg.content === 'string' && msg.content.trim()) {
        step.content.push({ type: 'text', text: msg.content.trim() })
      }
      // thoughts → reasoning 摘要块
      if (Array.isArray(msg.thoughts)) {
        for (const t of msg.thoughts) {
          if (t && typeof t === 'object' && (t.description || t.subject)) {
            step.content.push({
              type: 'reasoning',
              text: [t.subject, t.description].filter(Boolean).join('：'),
            })
          }
        }
      }
      // toolCalls：结果内联
      if (Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          if (!tc || typeof tc !== 'object') continue
          const callId = String(tc.id || 'gemini-' + turns.length + '-' + (cur.steps.length + 1))
          const mapped = {
            id: callId,
            name: tc.name || 'unknown',
            arguments: JSON.stringify(tc.args ?? {}),
          }
          step.content.push({ type: 'tool-call', ...mapped })
          step.toolCalls.push(mapped)
          // 内联结果：result[].functionResponse.response.output
          const text = geminiToolResultText(tc)
          if (text !== null) {
            step.toolResults.push({
              toolCallId: callId,
              content: [{ type: 'text', text }],
              isError: tc.status === 'error',
            })
          }
        }
      }
      cur.steps.push(step)
    }
    // info 与未知类型跳过
  }

  const sessionId = args.sessionId || mintSessionId(chat.sessionId)
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: parseTime(chat.startTime) }
  if (chat.sessionId) meta.sourceId = chat.sessionId
  if (Array.isArray(chat.directories) && chat.directories[0]) meta.cwd = chat.directories[0]
  // 标题兜底：Gemini 无显式标题源 → 首问兜底（只回填 out.title，不钉事件）
  const finalTitle = normalizeTitle(turns.length > 0 ? turns[0].prompt : '')
  return finishSession(turns, args.budget, { meta, provider: 'gemini', model, skipped: 0, records: chat.messages.length }, { title: finalTitle })
}

// 提取 Gemini 内联工具结果文本；无结果返回 null。
function geminiToolResultText(tc) {
  if (Array.isArray(tc.result)) {
    for (const entry of tc.result) {
      if (!entry || typeof entry !== 'object') continue
      const fr = entry.functionResponse
      const out = fr && fr.response ? fr.response.output : undefined
      if (typeof out === 'string') return out
    }
  }
  if (typeof tc.resultDisplay === 'string') return tc.resultDisplay
  return null
}
