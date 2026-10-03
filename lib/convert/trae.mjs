// lib/convert/trae.mjs — Trae Work state.vscdb 会话 → DSH 会话（纯函数）
//
// Trae Work 的会话由 sources/trae.mjs 从 ItemTable 提取为会话对象；本文件只负责
// 将已知的消息字段整理成 opencode 同构的中间形状，再复用成熟的 SQLite 转换器。
// 不读盘、不依赖宿主服务；未知字段不整对象转储，避免把内部元数据写进会话。

import { convertOpencodeJson } from './opencode.mjs'

const MESSAGE_TEXT_KEYS = ['content', 'text', 'message', 'body', 'prompt', 'response', 'output', 'result']
const SESSION_MESSAGE_KEYS = ['messages', 'chatMessages', 'history', 'messageList', 'entries']
const SESSION_ID_KEYS = ['sessionId', 'id', 'uuid', 'session_id']
const SESSION_TITLE_KEYS = ['title', 'name', 'topic', 'summary']
const SESSION_DIRECTORY_KEYS = ['cwd', 'directory', 'workspacePath', 'workspace', 'projectPath']
const SESSION_TIME_KEYS = ['createdAt', 'created_at', 'createTime', 'created', 'startTime', 'timestamp']

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function firstString(object, keys) {
  if (!object || typeof object !== 'object') return ''
  for (const key of keys) {
    const value = stringValue(object[key])
    if (value) return value
  }
  return ''
}

function firstPresent(object, keys) {
  if (!object || typeof object !== 'object') return undefined
  for (const key of keys) {
    const value = object[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    const text = stringValue(value)
    if (text) return text
  }
  return undefined
}

function valuesOf(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') return Object.values(value)
  return []
}

// 只沿已知内容字段递归，避免 JSON.stringify 把 token、配置和内部状态写入导入会话。
function textFromValue(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return ''
  const scalar = stringValue(value)
  if (scalar) return scalar
  if (Array.isArray(value)) {
    return value.map((item) => textFromValue(item, depth + 1)).filter(Boolean).join('\n').trim()
  }
  if (typeof value !== 'object') return ''
  if (value.type === 'text' || value.type === 'output' || value.type === 'message') {
    const typed = textFromValue(value.text ?? value.content ?? value.value, depth + 1)
    if (typed) return typed
  }
  for (const key of MESSAGE_TEXT_KEYS) {
    const text = textFromValue(value[key], depth + 1)
    if (text) return text
  }
  return textFromValue(value.parts, depth + 1)
}

function formatPlanValue(value) {
  const text = textFromValue(value)
  if (text) return text
  if (value && typeof value === 'object') {
    try { return JSON.stringify(value) } catch { return '' }
  }
  return value === undefined || value === null ? '' : String(value)
}

function planItemText(item) {
  if (!item || typeof item !== 'object') return ''
  const lines = []
  const thought = formatPlanValue(item.thought)
  const toolName = stringValue(item.toolName || item.tool || item.name)
  const params = formatPlanValue(item.params ?? item.arguments ?? item.input)
  const result = formatPlanValue(item.result ?? item.finish)
  const content = formatPlanValue(item.content ?? item.text)
  if (thought) lines.push('[thought] ' + thought)
  if (toolName) lines.push('[tool] ' + toolName)
  if (params) lines.push('[arguments] ' + params)
  if (result) lines.push('[result] ' + result)
  if (!thought && !toolName && !params && !result && content) lines.push(content)
  return lines.join('\n').trim()
}

function agentPlanText(message) {
  const sources = [message && message.agentTaskContent, message && message.content]
  for (const source of sources) {
    const items = source && source.guideline && valuesOf(source.guideline.planItems)
    const text = items ? items.map(planItemText).filter(Boolean).join('\n\n').trim() : ''
    if (text) return text
  }
  return ''
}

function normalizeRole(message) {
  const raw = firstString(message, ['role', 'type', 'sender'])
    || firstString(message && message.author, ['role', 'type'])
  const role = raw.toLowerCase()
  if (role === 'user' || role === 'human' || role === 'human_message') return 'user'
  if (role === 'assistant' || role === 'ai' || role === 'bot' || role === 'agent' || role === 'model') return 'assistant'
  return null
}

function messageText(message) {
  const direct = textFromValue(message && message.content)
    || textFromValue(message && message.text)
    || textFromValue(message && message.message)
    || textFromValue(message && message.body)
    || textFromValue(message && message.prompt)
    || textFromValue(message && message.response)
    || textFromValue(message && message.output)
  return direct || agentPlanText(message)
}

export function extractTraeSessions(value) {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return []
  for (const key of ['list', 'sessions', 'conversations', 'entries', 'items', 'data']) {
    const entries = valuesOf(value[key])
    if (entries.length > 0) return entries
  }
  // Some fallback stores are keyed by session id rather than wrapping an array.
  return Object.values(value).filter((item) => item && typeof item === 'object')
}

export function normalizeTraeSession(session, index = 0) {
  if (!session || typeof session !== 'object') return null
  const id = firstString(session, SESSION_ID_KEYS)
  if (!id) return null
  const messagesValue = SESSION_MESSAGE_KEYS
    .map((key) => session[key])
    .find((value) => valuesOf(value).length > 0)
  const messages = valuesOf(messagesValue).map((message, messageIndex) => {
    if (!message || typeof message !== 'object') return null
    const role = normalizeRole(message)
    if (!role) return null
    const text = messageText(message)
    if (!text) return null
    const messageId = firstString(message, ['id', 'messageId', 'uuid']) || id + '-message-' + messageIndex
    const createdAt = firstPresent(message, ['createdAt', 'created_at', 'timestamp', 'time'])
    const model = firstString(message, ['model', 'modelId', 'modelID', 'modelName']) || undefined
    return { id: messageId, role, createdAt, model, parts: [{ type: 'text', text }] }
  }).filter(Boolean)
  const normalized = {
    id,
    title: firstString(session, SESSION_TITLE_KEYS) || undefined,
    directory: firstString(session, SESSION_DIRECTORY_KEYS) || undefined,
    createdAt: firstPresent(session, SESSION_TIME_KEYS),
    model: typeof session.model === 'object' ? session.model : (firstString(session, ['model', 'modelId', 'modelID']) || undefined),
    messages,
  }
  // Keep a deterministic fallback only for diagnostic callers; source readers skip empty IDs.
  if (!normalized.id) normalized.id = 'trae-session-' + index
  return normalized
}

export function convertTraeJson(raw, args = {}) {
  let value
  try {
    value = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return convertOpencodeJson('null', args)
  }
  const session = normalizeTraeSession(value)
  if (!session) return convertOpencodeJson('null', args)
  return convertOpencodeJson(JSON.stringify(session), { ...args, provider: 'trae' })
}
