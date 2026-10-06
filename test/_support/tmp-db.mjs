// test/_support/tmp-db.mjs — 临时目录与临时 SQLite 夹具的共用骨架
//
// 20 个测试文件此前各写一遍同一批与来源无关的机械代码：mkdtemp、try/finally 里 rmSync、
// mkdir -p 后开库、按对象键拼 INSERT、关库。各源的 schema 与行形状是来源事实，留在各自的
// 测试文件里；这里只收「谁都得写一遍」的那部分。
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

/** 临时目录：回调返回（或抛错）后整棵删除。同步夹具用；异步用 withTempDirAsync。 */
export function withTempDir(prefix, fn) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  try {
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** withTempDir 的异步版（用例里有 await 时用；清理同样在 finally）。 */
export async function withTempDirAsync(prefix, fn) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  try {
    return await fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** 新临时目录里的库路径（不建库；调用方自己清理，或配合 withTempDir 使用）。 */
export function tempDbPath(prefix, name) {
  return join(mkdtempSync(join(tmpdir(), prefix)), name)
}

/**
 * 每个用例独立的 DSH_HOME（registry / 扫描缓存 / 上传暂存的落点隔离）：
 * `$DSH_HOME/dsh-chat-import`。prefix 只用于调试时辨认来源。
 */
export function freshDshHome(prefix = 'dsh-home-') {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), prefix))
  return process.env.DSH_HOME
}

/** 临时库 + 构造回调 → { dir, path, cleanup }（「用完显式 cleanup」的形态）。 */
export function tempDb(prefix, name, build) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const path = join(dir, name)
  const db = new DatabaseSync(path)
  try {
    build(db)
  } finally {
    db.close()
  }
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 按对象键插入若干行：列名即键名，值按同一顺序绑定。 */
export function insertRows(db, table, rows) {
  for (const row of rows) {
    const cols = Object.keys(row)
    db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...cols.map((c) => row[c]))
  }
}

/**
 * 打开（必要时新建）一个夹具库并执行建表语句：create（字符串或数组）→ statements（额外
 * 语句）。返回打开的句柄——行形状复杂的来源（嵌套写入 / 显式列名 / JSON 序列化）自己写行、
 * 自己 close；能按对象键插入的用 insertRows。
 */
export function openSqliteFixture(dbPath, { create, statements = [] } = {}) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  for (const sql of [].concat(create ?? [])) db.exec(sql)
  for (const sql of statements) db.exec(sql)
  return db
}

/**
 * 建一个夹具库：create（建表 SQL，字符串或数组）→ statements（额外语句：索引 / 侧表）
 * → rows（表名 → 行数组，按对象键插入）。默认关库并返回路径；keepOpen 时返回打开的句柄
 *（WAL / 需要继续写的用例自行关闭）。
 */
export function writeSqliteFixture(dbPath, { create, statements = [], rows = {}, keepOpen = false } = {}) {
  const db = openSqliteFixture(dbPath, { create, statements })
  for (const [table, list] of Object.entries(rows)) insertRows(db, table, list)
  if (keepOpen) return db
  db.close()
  return dbPath
}
