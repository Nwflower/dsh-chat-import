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
// 保持「每源一个编排文件」的仓库惯例（对照 lib/sources/mimocode.mjs / lib/sources/zcode.mjs）。

import { readOptionalDb, columnsOf } from './sqlite.mjs'
import { importOpencodeFile, previewOpencodeFile, resolveDbInDirectory, readOpencodeDb, readOpencodeDbSummaries } from './opencode.mjs'
import { convertKilocodeJson } from '../convert/kilocode.mjs'

/** Kilo Code 历史库默认文件名（目录模式定位用）。 */
export const KILOCODE_DB_NAME = 'kilo.db'

// Kilo Code 历史库（SQLite）→ 中间会话 JSON 数组：复用 opencode 读取器，默认跳过
// 子会话（parent_id 非空）与已归档会话（time_archived 非空）。这两列是 Kilo 相对
// opencode 的新增列，按 PRAGMA 探测存在才过滤（兼容旧库/降级形态不误伤）。跳过集
// 先查一次拿 id 集合，再经 readOpencodeDb 的 filter 剔除——读取/压缩/消息抽取全部
// 复用通用实现，不重复。
export function readKilocodeDb(dbPath, options = {}) {
  // 读不到 / 非 SQLite：skipIds 留空，交由 readOpencodeDb 抛错（失败大声）
  const skipIds = readOptionalDb(dbPath, (db) => {
    const sessionCols = columnsOf(db, 'session')
    const conditions = []
    if (sessionCols.has('parent_id')) conditions.push('parent_id IS NOT NULL')
    if (sessionCols.has('time_archived')) conditions.push('time_archived IS NOT NULL')
    if (conditions.length === 0) return new Set()
    return new Set(db.prepare('SELECT id FROM session WHERE ' + conditions.join(' OR ')).all().map((row) => row.id))
  }) ?? new Set()
  return readOpencodeDb(dbPath, {
    fullHistory: options.fullHistory === true,
    filter: (s) => skipIds.has(s.id) || (typeof options.filter === 'function' && options.filter(s)),
  })
}

// kilocode 库 → 会话级摘要（发现层用）：复用 opencode 摘要读取器，按 PRAGMA 探测的
// parent_id / time_archived 列在 SQL 层剔除子会话（subagent/分叉产物）与已归档会话——
// 与 readKilocodeDb 的跳过口径一致；列不存在时不加谓词（兼容旧库）。
export function readKilocodeDbSummaries(dbPath) {
  // 读不到 / 非 SQLite：不加保留谓词，交由 readOpencodeDbSummaries 抛错（失败大声）
  const where = readOptionalDb(dbPath, (db) => {
    const sessionCols = columnsOf(db, 'session')
    const keep = []
    if (sessionCols.has('parent_id')) keep.push("(parent_id IS NULL OR parent_id = '')")
    if (sessionCols.has('time_archived')) keep.push('time_archived IS NULL')
    return keep.join(' AND ')
  }) || undefined
  return readOpencodeDbSummaries(dbPath, { where })
}

// kilocode 在 opencode 编排上的差异参数（导入与预览共用）：readKilocodeDb 跳过子/归档会话、
// convertKilocodeJson 让 provider 标签为 kilocode（缺省是 readOpencodeDb + convertOpencodeJson）。
const KILOCODE_OPTIONS = { readDb: readKilocodeDb, convert: convertKilocodeJson, sourceLabel: 'kilocode', importFormat: 'kilocode' }

// kilocode 单库导入：复用 opencode 编排（importOpencodeFile），恒返回批量形态。
export async function importKilocodeFile(ctx, target, args, options = {}) {
  return importOpencodeFile(ctx, target, args, { ...options, ...KILOCODE_OPTIONS })
}

// kilocode 目录导入：目录里定位 kilo.db（无递归），再走单库导入；缺 DB 时抛错。
export async function importKilocodeDirectory(ctx, dirTarget, args, options = {}) {
  return importKilocodeFile(ctx, await resolveDbInDirectory(ctx, dirTarget, KILOCODE_DB_NAME), args, options)
}

// ── dry-run 预览（与正式导入同源的只读重演：绕开 registry / decideMulti / 落盘，零副作用）──

// kilocode 预览：opencode 预览编排 + 同一组差异参数。
export async function previewKilocodeFile(ctx, target, args) {
  return previewOpencodeFile(ctx, target, args, KILOCODE_OPTIONS)
}

export async function previewKilocodeDirectory(ctx, dirTarget, args) {
  return previewKilocodeFile(ctx, await resolveDbInDirectory(ctx, dirTarget, KILOCODE_DB_NAME), args)
}
