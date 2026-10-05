// lib/convert/util.mjs — 转换器与发现层共用的小型纯函数（零依赖、零 IO）
//
// 多个来源共享的口径收在这里，改规则只改一处。

// 会话标题口径：折叠空白、去首尾空白，超过 80 字符截断并以「…」收尾（总长恰为 80）；
// 空白返回空串。发现层列表标题、导入后的 session/title 与「来源 · 话题」标题同一口径。
export const TITLE_MAX_LEN = 80
export const TITLE_ELLIPSIS = '…'

export function normalizeTitle(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return ''
  return t.length <= TITLE_MAX_LEN ? t : t.slice(0, TITLE_MAX_LEN - TITLE_ELLIPSIS.length) + TITLE_ELLIPSIS
}

// 「这份输入不成会话」的统一返回：meta 为 null、无事件无轮次（导入层与探测层只看 meta 与
// skipReason）。fields 覆盖计数口径——整文件畸形的来源报 skipped:1，逐行来源透传 records /
// skippedLines / secrets；skipReason 为空时不占键。
export function skipResult(skipReason, fields) {
  return {
    meta: null, events: [], turns: [], title: null, messages: 0, toolCalls: 0,
    skipped: 0, records: 0, skippedLines: [], secrets: [],
    ...fields,
    ...(skipReason ? { skipReason } : {}),
  }
}

// 消息 content → 纯文本（各源「内容块取文本」的唯一口径）。content 为字符串时原样返回，
// 为块数组时逐块取字符串 `text` 拼接，其余形态得 ''。各源差异全部显式成选项：
//   types      只收这些 type 的块（缺省 ['text']）；null = 不看 type，凡带字符串 text 的块都收；
//   sep        拼接符（缺省 '\n'）；
//   skipEmpty  空串块不参与拼接（不留空行）；
//   trim       结果去首尾空白（字符串 content 同样生效）。
const TEXT_BLOCK_TYPES = ['text']
export function contentText(content, { types = TEXT_BLOCK_TYPES, sep = '\n', skipEmpty = false, trim = false } = {}) {
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    const parts = []
    for (const b of content) {
      if (!b || typeof b !== 'object' || typeof b.text !== 'string') continue
      if (types !== null && !types.includes(b.type)) continue
      if (skipEmpty && !b.text) continue
      parts.push(b.text)
    }
    text = parts.join(sep)
  }
  return trim ? text.trim() : text
}
