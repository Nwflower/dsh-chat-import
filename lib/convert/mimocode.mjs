// lib/convert/mimocode.mjs — mimocode 历史库会话 → DSH 会话（纯函数）
//
// mimocode 是 opencode 的 fork：SQLite 三表（session/message/part）schema 同构、
// 消息/part 数据 JSON 结构与 opencode 完全一致，仅 provider 标签不同。转换直接
// 复用 lib/convert/opencode.mjs 的 convertOpencodeJson，只覆盖 provider 为
// 'mimocode'（模型 source.provider 的标注）。
// 独立成文件保持「每源一个 convert 文件」的仓库惯例，opencode 转换器不含任何
// mimocode 专属分支。

import { convertOpencodeJson } from './opencode.mjs'

/** mimocode 会话（opencode fork）→ DSH 会话：复用 opencode 转换器，仅换 provider 标签。 */
export function convertMimocodeJson(raw, args = {}) {
  return convertOpencodeJson(raw, { ...args, provider: 'mimocode' })
}
