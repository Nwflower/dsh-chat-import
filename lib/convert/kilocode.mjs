// lib/convert/kilocode.mjs — Kilo Code 历史库会话 → DSH 会话（纯函数）
//
// Kilo Code 是 opencode 的 fork：本地历史库 SQLite 三表（session/message/part）
// schema 同构、消息/part 数据 JSON 结构与 opencode 完全一致（provider 标签不同）。
// 转换直接复用 lib/convert/opencode.mjs 的 convertOpencodeJson，只覆盖 provider 为
// 'kilocode'（事件里 session/imported.data.tool 与模型 source.provider 的标注）。
// 独立成文件保持「每源一个 convert 文件」的仓库惯例，opencode 转换器不含任何
// kilocode 专属分支。

import { convertOpencodeJson } from './opencode.mjs'

/** Kilo Code 会话（opencode fork）→ DSH 会话：复用 opencode 转换器，仅换 provider 标签。 */
export function convertKilocodeJson(raw, args = {}) {
  return convertOpencodeJson(raw, { ...args, provider: 'kilocode' })
}
