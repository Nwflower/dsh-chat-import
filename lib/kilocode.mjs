// lib/kilocode.mjs — Kilo Code SQLite 历史库读取与导入编排（opencode fork 专属）
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

import { DatabaseSync } from 'node:sqlite'
import { importOpencodeFile, importOpencodeDirectory, readOpencodeDb } from './opencode.mjs'
import { convertKilocodeJson } from './convert/kilocode.mjs'

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

// kilocode 单库导入：复用 opencode 编排（importOpencodeFile），恒返回批量形态；
// 传入 readKilocodeDb 跳过子/归档会话、convertKilocodeJson 让 provider 标签为
// kilocode（否则 importOpencodeFile 默认 readOpencodeDb + convertOpencodeJson）。
export async function importKilocodeFile(ctx, target, args, options = {}) {
  return importOpencodeFile(ctx, target, args, { ...options, readDb: readKilocodeDb, convert: convertKilocodeJson })
}

// kilocode 目录导入：目录里定位 kilo.db（无递归），再走单库导入；缺 DB 时抛错。
export async function importKilocodeDirectory(ctx, dirTarget, args, options = {}) {
  return importOpencodeDirectory(ctx, dirTarget, args, {
    ...options,
    dbName: KILOCODE_DB_NAME,
    readDb: readKilocodeDb,
    convert: convertKilocodeJson,
  })
}
