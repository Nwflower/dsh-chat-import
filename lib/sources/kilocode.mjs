// lib/sources/kilocode.mjs — Kilo Code SQLite 历史库读取与导入编排（opencode fork 专属）
//
// Kilo Code 是 opencode 的 fork：本地历史库为 SQLite（默认
// ~/.local/share/kilo/kilo.db；开发频道为 kilo-<channel>.db / 旧版
// opencode-<channel>.db，可被 KILO_DB 覆盖）。session/message/part 三表 schema 是
// opencode 的超集（多出 parent_id / time_archived / slug / project_id 等列，核心
// 对话列完全同构），读取/导入/编排完全复用 lib/opencode.mjs 的通用实现。本文件只收
// kilocode 专属差异：
//   - 库文件名 kilo.db（目录模式定位）
//   - provider 标签 kilocode（lib/convert/kilocode.mjs）
//   - 跳过子会话（parent_id 非空，subagent/分叉产物）与已归档会话（time_archived
//     非空）——对齐 claude/qoder/reasonix「跳过辅助 transcript」语义，只导主会话
//
// 保持「每源一个编排文件」的仓库惯例（对照 lib/mimocode.mjs / lib/zcode.mjs）。

import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { importOpencodeFile, resolveDbInDirectory, readOpencodeDb, readOpencodeDbSummaries } from './opencode.mjs'
import { convertKilocodeJson } from '../convert/kilocode.mjs'
import { previewEntry } from '../import-core.mjs'
import { markTrimmedSource } from '../budget.mjs'

/** Kilo Code 历史库默认文件名（目录模式定位用）。 */
export const KILOCODE_DB_NAME = 'kilo.db'

// Kilo Code 历史库（SQLite）→ 中间会话 JSON 数组：复用 opencode 读取器，默认跳过
// 子会话（parent_id 非空）与已归档会话（time_archived 非空）。这两列是 Kilo 相对
// opencode 的新增列，按 PRAGMA 探测存在才过滤（兼容旧库/降级形态不误伤）。跳过集
// 先查一次拿 id 集合，再经 readOpencodeDb 的 filter 剔除——读取/压缩/消息抽取全部
// 复用通用实现，不重复。
export function readKilocodeDb(dbPath, options = {}) {
  const skipIds = new Set()
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const sessionCols = new Set(db.prepare('PRAGMA table_info(session)').all().map((c) => c.name))
      const conditions = []
      if (sessionCols.has('parent_id')) conditions.push('parent_id IS NOT NULL')
      if (sessionCols.has('time_archived')) conditions.push('time_archived IS NOT NULL')
      if (conditions.length > 0) {
        for (const row of db.prepare('SELECT id FROM session WHERE ' + conditions.join(' OR ')).all()) {
          skipIds.add(row.id)
        }
      }
    } finally {
      db.close()
    }
  } catch {
    // 读不到 / 非 SQLite：skipIds 留空，交由 readOpencodeDb 抛错（失败大声）
  }
  return readOpencodeDb(dbPath, {
    fullHistory: options.fullHistory === true,
    filter: (s) => skipIds.has(s.id) || (typeof options.filter === 'function' && options.filter(s)),
  })
}

// kilocode 库 → 会话级摘要（发现层用）：复用 opencode 摘要读取器，按 PRAGMA 探测的
// parent_id / time_archived 列在 SQL 层剔除子会话（subagent/分叉产物）与已归档会话——
// 与 readKilocodeDb 的跳过口径一致；列不存在时不加谓词（兼容旧库）。
export function readKilocodeDbSummaries(dbPath) {
  let where
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const sessionCols = new Set(db.prepare('PRAGMA table_info(session)').all().map((c) => c.name))
      const keep = []
      if (sessionCols.has('parent_id')) keep.push("(parent_id IS NULL OR parent_id = '')")
      if (sessionCols.has('time_archived')) keep.push('time_archived IS NULL')
      if (keep.length > 0) where = keep.join(' AND ')
    } finally {
      db.close()
    }
  } catch {
    // 读不到 / 非 SQLite：不加保留谓词，交由 readOpencodeDbSummaries 抛错（失败大声）
  }
  return readOpencodeDbSummaries(dbPath, { where })
}

// kilocode 单库导入：复用 opencode 编排（importOpencodeFile），恒返回批量形态；
// 传入 readKilocodeDb 跳过子/归档会话、convertKilocodeJson 让 provider 标签为
// kilocode（否则 importOpencodeFile 默认 readOpencodeDb + convertOpencodeJson）。
export async function importKilocodeFile(ctx, target, args, options = {}) {
  return importOpencodeFile(ctx, target, args, { ...options, readDb: readKilocodeDb, convert: convertKilocodeJson, sourceLabel: 'kilocode', importFormat: 'kilocode' })
}

// kilocode 目录导入：目录里定位 kilo.db（无递归），再走单库导入；缺 DB 时抛错。
export async function importKilocodeDirectory(ctx, dirTarget, args, options = {}) {
  return importKilocodeFile(ctx, await resolveDbInDirectory(ctx, dirTarget, KILOCODE_DB_NAME), args, options)
}

// ── dry-run 预览（与正式导入同源的只读重演：绕开 registry / decideMulti / 落盘，零副作用）──

// kilocode 预览：opencode fork，同构 SQLite 只读重演（readKilocodeDb 已跳过子/归档
// 会话），provider 标签为 kilocode。
export async function previewKilocodeFile(ctx, target, args) {
  const path = target.displayPath || ctx.fs.processPath(target)
  const sessions = readKilocodeDb(path, { fullHistory: args.fullHistory === true })
  const wanted = Array.isArray(args.sessionIds) && args.sessionIds.length > 0 ? new Set(args.sessionIds) : null
  const results = []
  for (const s of sessions) {
    if (wanted && !wanted.has(s.id)) continue
    const out = markTrimmedSource(convertKilocodeJson(JSON.stringify(s), { ...args, sourcePath: path }), args)
    if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
      results.push({ path, skipped: 1, skipReason: 'no user turns (session ' + s.id + ')' })
      continue
    }
    results.push({ path, ...previewEntry(out) })
  }
  return { total: sessions.length, results }
}

export async function previewKilocodeDirectory(ctx, dirTarget, args) {
  const dirPath = dirTarget.displayPath || ctx.fs.processPath(dirTarget)
  const dbTarget = await ctx.fs.resolve(join(dirPath, 'kilo.db'))
  return previewKilocodeFile(ctx, dbTarget, args)
}
