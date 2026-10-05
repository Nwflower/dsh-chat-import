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
