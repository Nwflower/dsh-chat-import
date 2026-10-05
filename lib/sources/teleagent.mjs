// lib/sources/teleagent.mjs — TeleAgent SQLite 历史库读取与导入编排（opencode 派生专属）
//
// TeleAgent（星辰超级智能体，中电信 TeleAI 桌面客户端）的会话库是 opencode 同构的
// SQLite 三表（session/message/part，用户实测 .schema），落点为 XDG 风格
// 的多账户目录：~/.local/share/TeleAgent/users/<账户ID>/teleagent.db（多账户按账户
// 分目录、各一个库；Windows 上同样走 ~/.local/share）。读取/导入/编排完全复用
// lib/sources/opencode.mjs 的通用实现，本文件只收 TeleAgent 专属差异：
//   - 库文件名 teleagent.db（目录模式定位）
//   - 默认根是 users/ 目录（多账户）→ 发现层枚举账户目录，逐个 DB 进扫描
//   - provider 标签 teleagent（lib/convert/teleagent.mjs）
//   - session 表无 model 列的 schema 由 readOpencodeDb 按 PRAGMA 探测自动兼容
//     （与 mimocode 同形态）
//
// 保持「每源一个编排文件」的仓库惯例（对照 lib/sources/mimocode.mjs / lib/sources/zcode.mjs），
// opencode 编排文件不含任何 TeleAgent 专属分支。

import { join } from 'node:path'
import { importOpencodeFile, previewOpencodeFile, resolveDbInDirectory, readOpencodeDb } from './opencode.mjs'
import { convertTeleagentJson } from '../convert/teleagent.mjs'

/** TeleAgent 历史库默认文件名（目录模式定位用）。 */
export const TELEAGENT_DB_NAME = 'teleagent.db'

/** TeleAgent 数据根下的多账户目录名（默认根 = <dataDir>/users，其下每账户一个库）。 */
export const TELEAGENT_USERS_DIR = 'users'

// TeleAgent 数据目录解析（$TELEAGENT_HOME 覆盖 → ~/.local/share/TeleAgent）。
export function teleagentDataDir(home) {
  return process.env.TELEAGENT_HOME || join(home, '.local', 'share', 'TeleAgent')
}

// 多账户目录：<dataDir>/users（发现层对它做一层枚举，得到各账户的库）。
export function teleagentUsersDir(home) {
  return join(teleagentDataDir(home), TELEAGENT_USERS_DIR)
}

// 单账户的库路径（显式 path 指向账户目录或库文件时同样适用）。
export function teleagentDbPath(home, account) {
  return join(teleagentDataDir(home), TELEAGENT_USERS_DIR, account, TELEAGENT_DB_NAME)
}

// TeleAgent 历史库（SQLite）→ 中间会话 JSON 数组：复用 opencode 读取器，全量导入
//（不剔除任何会话；报告者样本里未观察到后台任务会话，如后续出现再按 mimocode 的
// filter 模式补）。fullHistory 语义与 opencode 一致。
export function readTeleagentDb(dbPath, options = {}) {
  return readOpencodeDb(dbPath, { fullHistory: options.fullHistory === true })
}

// TeleAgent 在 opencode 编排上的差异参数（导入与预览共用）：convertTeleagentJson 让 provider
// 标签为 teleagent（来源标题钉「TeleAgent · 话题」）。
const TELEAGENT_OPTIONS = { convert: convertTeleagentJson, sourceLabel: 'teleagent', importFormat: 'teleagent' }

// TeleAgent 单库导入：复用 opencode 编排（importOpencodeFile），恒返回批量形态。
export async function importTeleagentFile(ctx, target, args, options = {}) {
  return importOpencodeFile(ctx, target, args, { ...options, ...TELEAGENT_OPTIONS })
}

// TeleAgent 目录导入：目录里定位 teleagent.db（无递归），再走单库导入；缺 DB 时抛错。
export async function importTeleagentDirectory(ctx, dirTarget, args, options = {}) {
  return importTeleagentFile(ctx, await resolveDbInDirectory(ctx, dirTarget, TELEAGENT_DB_NAME), args, options)
}

// ── dry-run 预览（与正式导入同源的只读重演：绕开 registry / decideMulti / 落盘，零副作用）──

// teleagent 预览：opencode 预览编排 + 同一组差异参数（无 model 列 schema 由读取器兼容）。
export async function previewTeleagentFile(ctx, target, args) {
  return previewOpencodeFile(ctx, target, args, TELEAGENT_OPTIONS)
}

export async function previewTeleagentDirectory(ctx, dirTarget, args) {
  return previewTeleagentFile(ctx, await resolveDbInDirectory(ctx, dirTarget, TELEAGENT_DB_NAME), args)
}
