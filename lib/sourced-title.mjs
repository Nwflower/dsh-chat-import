// lib/sourced-title.mjs — 导入会话标题：来源 · 话题（禁止回退为工作区目录名）

const TITLE_MAX_LEN = 80
const TITLE_ELLIPSIS = '…'

/** provider / format 短名 → 面板展示用来源标签。 */
export const SOURCE_LABEL_BY_KEY = {
  'claude-code': 'Claude',
  claude: 'Claude',
  codex: 'Codex',
  chatgpt: 'ChatGPT',
  cursor: 'Cursor',
  gemini: 'Gemini',
  reasonix: 'Reasonix',
  opencode: 'OpenCode',
  mimocode: 'MimoCode',
  zcode: 'ZCode',
  grokbuild: 'Grok',
  openclaw: 'OpenClaw',
  pi: 'Pi',
  hermes: 'Hermes',
  kimi: 'Kimi',
  qoder: 'Qoder',
  workbuddy: 'WorkBuddy',
  dsh: 'DSH',
  'local-jsonl': 'JSONL',
}

export function normalizeSourceLabel(label) {
  const s = String(label || '').trim()
  if (!s) return '未知'
  const ALIASES = {
    'Claude Code': 'Claude',
    'Codex/ChatGPT': 'Codex',
    'Gemini CLI': 'Gemini',
    'Grok Build': 'Grok',
    'Pi Coding Agent': 'Pi',
    'Qoder CLI': 'Qoder',
    'Local JSONL': 'JSONL',
    'Kimi CLI': 'Kimi',
    'pi-coding-agent': 'Pi',
  }
  return ALIASES[s] || SOURCE_LABEL_BY_KEY[s] || SOURCE_LABEL_BY_KEY[s.toLowerCase()] || s
}


export function sourceLabelFromKey(key) {
  return normalizeSourceLabel(key)
}

/** 从 session/imported 事件的 data.tool 解析来源标签。 */
export function sourceLabelFromImportedEvents(events) {
  if (!Array.isArray(events)) return null
  const imp = events.find((e) => e && e.type === 'session/imported' && e.data && typeof e.data.tool === 'string')
  return imp ? sourceLabelFromKey(imp.data.tool) : null
}

export function normalizeTitleText(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return ''
  return t.length <= TITLE_MAX_LEN ? t : t.slice(0, TITLE_MAX_LEN - TITLE_ELLIPSIS.length) + TITLE_ELLIPSIS
}

/** 去掉已有「来源 · 」或「来自 来源 · 」前缀，避免重复套娃。 */
export function stripSourcedPrefix(title, sourceLabel) {
  const t = String(title ?? '').trim()
  const label = String(sourceLabel ?? '').trim()
  if (!t || !label) return t
  const plain = label + ' · '
  if (t.startsWith(plain)) return t.slice(plain.length).trim()
  const from = '来自 ' + plain
  if (t.startsWith(from)) return t.slice(from.length).trim()
  return t
}

function shortDate(createdAt) {
  const d = new Date(typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/**
 * 生成「来源 · 话题」标题；话题未知时用「未命名 · YYYY-MM-DD」。
 * 绝不使用工作区目录名——调用方应传入已剥离装饰的首问/显式标题。
 */
export function formatSourcedTitle(sourceLabel, topic, createdAt) {
  const label = normalizeSourceLabel(sourceLabel)
  let body = normalizeTitleText(stripSourcedPrefix(topic, label))
  if (!body) body = '未命名 · ' + shortDate(createdAt)
  const combined = label + ' · ' + body
  return combined.length <= TITLE_MAX_LEN
    ? combined
    : combined.slice(0, TITLE_MAX_LEN - TITLE_ELLIPSIS.length) + TITLE_ELLIPSIS
}

/** 在转换结果上钉住 session/title 事件（全量导入 / 覆盖刷新共用）。 */
export function pinSourcedSessionTitle(converted, sourceLabel) {
  if (!converted || !Array.isArray(converted.events)) return converted
  const label = normalizeSourceLabel(sourceLabel || sourceLabelFromImportedEvents(converted.events) || '未知')
  const rawTopic = converted.title || (converted.turns && converted.turns[0] && converted.turns[0].prompt) || ''
  const title = formatSourcedTitle(label, rawTopic, converted.meta && converted.meta.createdAt)
  converted.title = title
  const events = converted.events
  let idx = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i] && events[i].type === 'session/title') { idx = i; break }
  }
  const data = { title, messageSeqs: [], source: { kind: 'user' } }
  if (idx >= 0) {
    events[idx] = { ...events[idx], data: { ...(events[idx].data || {}), ...data } }
  } else {
    events.push({
      type: 'session/title',
      seq: events.length,
      time: (converted.meta && converted.meta.createdAt) || Date.now(),
      data,
    })
  }
  return converted
}
