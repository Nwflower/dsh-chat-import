// lib/sources/mimocode.mjs — mimocode SQLite 历史库读取与导入编排（opencode fork 专属）
//
// mimocode 是 opencode 的 fork：历史库为 SQLite（默认 ~/.local/share/mimocode/
// mimocode.db），session/message/part 三表 schema 与 opencode 同构（唯一差异：
// session 表无 model 列，消息级 model 在 message.data.modelID）。读取/导入/编排
// 完全复用 lib/opencode.mjs 的通用实现，本文件只收 mimocode 专属差异：
//   - 库文件名 mimocode.db（目录模式定位）
//   - provider 标签 mimocode（lib/convert/mimocode.mjs）
//   - 剔除 MiMo 后台任务会话（checkpoint-writer / AutoDream / AutoDistill），
//     isMimocodeBackgroundSession 判定后作为 filter 传入 readOpencodeDb
//   - 无 model 列的 schema 由 readOpencodeDb 按 PRAGMA 探测自动兼容
//
// 保持「每源一个编排文件」的仓库惯例（对照 lib/zcode.mjs / lib/hermes.mjs），
// opencode 编排文件不含任何 mimocode 专属分支。

import { join } from 'node:path'
import { importOpencodeFile, resolveDbInDirectory, readOpencodeDb, readOpencodeDbSummaries } from './opencode.mjs'
import { convertMimocodeJson } from '../convert/mimocode.mjs'
import { previewEntry } from '../import-core.mjs'
import { markTrimmedSource } from '../budget.mjs'

/** mimocode 历史库默认文件名（目录模式定位用）。 */
export const MIMOCODE_DB_NAME = 'mimocode.db'

// mimocode 后台任务会话特征（2026-08-18 实测 mimocode.db）：
//   checkpoint-writer —— 标题前缀 "checkpoint-writer: ..."（全库 822 条），消息 agent=checkpoint-writer
//   AutoDream        —— 标题 "Auto Dream"（4 条），消息 agent=dream（156 条）
//   AutoDistill      —— 标题 "Auto Distill"（1 条），消息 agent=distill（7 条）
// 这些是 MiMo 的记忆巩固/工作流蒸馏后台任务，无用户交互价值，导入/发现时剔除。
// 标题用空格分隔（Auto Dream/Auto Distill），因此标题正则与 agent 集合双信号判定。
const MIMOCODE_BG_TITLE = /^(checkpoint[-_ ]?writer|auto[-_ ]?(dream|distill))\b/i
const MIMOCODE_BG_AGENTS = new Set(['checkpoint-writer', 'dream', 'distill'])

/** mimocode 后台任务会话判定（纯函数）：标题前缀或任一条消息 agent 命中即真。 */
export function isMimocodeBackgroundSession(session) {
  if (!session || typeof session !== 'object') return false
  if (typeof session.title === 'string' && MIMOCODE_BG_TITLE.test(session.title.trim())) return true
  if (Array.isArray(session.messages)) {
    for (const m of session.messages) {
      if (m && typeof m.agent === 'string' && MIMOCODE_BG_AGENTS.has(m.agent.toLowerCase())) return true
    }
  }
  return false
}

// mimocode 历史库（SQLite）→ 中间会话 JSON 数组：复用 opencode 读取器，默认剔除
// 后台任务会话（options.filter 覆盖时以显式值为准；fullHistory 语义与 opencode 一致）。
export function readMimocodeDb(dbPath, options = {}) {
  return readOpencodeDb(dbPath, {
    fullHistory: options.fullHistory === true,
    filter: options.filter === undefined ? isMimocodeBackgroundSession : options.filter,
  })
}

// 后台任务会话的标题前缀谓词（SQL LIKE；SQLite 的 LIKE 对 ASCII 大小写不敏感，与
// isMimocodeBackgroundSession 的标题正则同口径）。
const MIMOCODE_BG_TITLE_WHERE = [
  "title LIKE 'checkpoint-writer:%'", "title LIKE 'checkpoint writer:%'", "title LIKE 'checkpoint_writer:%'",
  "title LIKE 'auto dream%'", "title LIKE 'auto-dream%'", "title LIKE 'auto_dream%'",
  "title LIKE 'auto distill%'", "title LIKE 'auto-distill%'", "title LIKE 'auto_distill%'",
].join(' OR ')

// mimocode 库 → 会话级摘要（发现层用）：复用 opencode 摘要读取器（只查 session 表），
// 后台任务会话按标题前缀在 SQL 层剔除。标题是双信号里的强信号（实测 checkpoint-writer
// 全库 822 条都带前缀、Auto Dream / Auto Distill 标题固定）；agent-only 的漏网会话最多
// 出现在发现预览里，导入路径仍走 readMimocodeDb + isMimocodeBackgroundSession 精确剔除。
export function readMimocodeDbSummaries(dbPath) {
  return readOpencodeDbSummaries(dbPath, { where: 'NOT (' + MIMOCODE_BG_TITLE_WHERE + ')' })
}

// mimocode 单库导入：复用 opencode 编排（importOpencodeFile），恒返回批量形态；
// 传入 convertMimocodeJson 让 provider 标签为 mimocode（否则 importOpencodeFile 默认
// 走 convertOpencodeJson → provider=opencode）；默认剔除后台任务会话（filter 透传）。
export async function importMimocodeFile(ctx, target, args, options = {}) {
  return importOpencodeFile(ctx, target, args, { ...options, filter: isMimocodeBackgroundSession, convert: convertMimocodeJson, sourceLabel: 'mimocode', importFormat: 'mimocode' })
}

// mimocode 目录导入：目录里定位 mimocode.db（无递归），再走单库导入；缺 DB 时抛错。
export async function importMimocodeDirectory(ctx, dirTarget, args, options = {}) {
  return importMimocodeFile(ctx, await resolveDbInDirectory(ctx, dirTarget, MIMOCODE_DB_NAME), args, options)
}

// ── dry-run 预览（与正式导入同源的只读重演：绕开 registry / decideMulti / 落盘，零副作用）──

// mimocode 预览：opencode fork，同构 SQLite 只读重演（readMimocodeDb 已兼容无 model
// 列 schema 并默认剔除后台任务会话），provider 标签为 mimocode。
export async function previewMimocodeFile(ctx, target, args) {
  const path = target.displayPath || ctx.fs.processPath(target)
  const sessions = readMimocodeDb(path, { fullHistory: args.fullHistory === true })
  const wanted = Array.isArray(args.sessionIds) && args.sessionIds.length > 0 ? new Set(args.sessionIds) : null
  const results = []
  for (const s of sessions) {
    if (wanted && !wanted.has(s.id)) continue
    const out = markTrimmedSource(convertMimocodeJson(JSON.stringify(s), { ...args, sourcePath: path }), args)
    if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
      results.push({ path, skipped: 1, skipReason: 'no user turns (session ' + s.id + ')' })
      continue
    }
    results.push({ path, ...previewEntry(out) })
  }
  return { total: sessions.length, results }
}

export async function previewMimocodeDirectory(ctx, dirTarget, args) {
  const dirPath = dirTarget.displayPath || ctx.fs.processPath(dirTarget)
  const dbTarget = await ctx.fs.resolve(join(dirPath, 'mimocode.db'))
  return previewMimocodeFile(ctx, dbTarget, args)
}
