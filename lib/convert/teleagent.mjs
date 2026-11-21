// lib/convert/teleagent.mjs — TeleAgent 历史库会话 → DSH 会话（纯函数）
//
// TeleAgent（星辰超级智能体，中电信 TeleAI 的桌面客户端）的会话库与 opencode 同构：
// SQLite 三表（session/message/part）schema 一致、消息/part 的 data JSON 结构一致
//（part.type ∈ text | reasoning | tool | step-start | step-finish | compaction，
// issue #60 报告者实测 .schema）。仅 provider 标签不同。转换直接复用
// lib/convert/opencode.mjs 的 convertOpencodeJson，只覆盖 provider 为 'teleagent'；
// 独立成文件保持「每源一个 convert 文件」的仓库惯例，opencode 转换器不含任何
// TeleAgent 专属分支。

import { convertOpencodeJson } from './opencode.mjs'
import { isAbsoluteLike, joinForPlatform as joinFor } from './util.mjs'

/** TeleAgent 会话（opencode 派生）→ DSH 会话：复用 opencode 转换器，仅换 provider 标签。 */
export function convertTeleagentJson(raw, args = {}) {
  return convertOpencodeJson(raw, { ...args, provider: 'teleagent' })
}

// ── 路径解析（纯函数；发现层与 lib/sources/teleagent.mjs 共用同一份）─────────────────────

/** TeleAgent 历史库默认文件名（目录模式定位用）。 */
export const TELEAGENT_DB_NAME = 'teleagent.db'

/** TeleAgent 数据根下的多账户目录名（默认根 = <dataDir>/users，其下每账户一个库）。 */
export const TELEAGENT_USERS_DIR = 'users'

/**
 * TeleAgent 数据根解析（优先级）：
 *   $TELEAGENT_HOME（绝对路径才认，上游惯例）→ $XDG_DATA_HOME/TeleAgent（绝对路径才认）→
 *   ~/.local/share/TeleAgent。Windows 上同样走 ~/.local/share（opencode 同构落点，
 * 见 lib/sources/opencode.mjs 的目录约定）。env / platform 可注入，测试不读 process。
 */
export function teleagentDataDir(home, env = process.env, platform = process.platform) {
  const override = env.TELEAGENT_HOME
  if (override && isAbsoluteLike(override)) return joinFor(platform, String(override))
  const xdg = env.XDG_DATA_HOME
  if (xdg && isAbsoluteLike(xdg)) return joinFor(platform, String(xdg), 'TeleAgent')
  return joinFor(platform, String(home), '.local', 'share', 'TeleAgent')
}

/** 多账户目录：<dataDir>/users（发现层对它做一层枚举，得到各账户的库）。 */
export function teleagentUsersDir(home, env = process.env, platform = process.platform) {
  return joinFor(platform, teleagentDataDir(home, env, platform), TELEAGENT_USERS_DIR)
}

/** 单账户的库路径（显式 path 指向账户目录或库文件时同样适用）。 */
export function teleagentDbPath(home, account, env = process.env, platform = process.platform) {
  return joinFor(platform, teleagentDataDir(home, env, platform), TELEAGENT_USERS_DIR, String(account), TELEAGENT_DB_NAME)
}
