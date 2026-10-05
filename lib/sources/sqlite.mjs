// lib/sources/sqlite.mjs — SQLite 库类来源的只读访问原语（host 面）
//
// 数据库源的共同契约（docs/architecture.md D5）：node:sqlite 只读打开、列用
// PRAGMA table_info 自适应、读完必关。各来源读取器只管 schema 与行映射；打开 / 关闭 /
// 列探测的样板收在这里——这类样板按来源各抄一份时，最先漂移的就是「失败路径有没有关
// 句柄」（Windows 上未关闭的句柄会让库文件所在目录删不掉）。
import { DatabaseSync } from 'node:sqlite'

/** 只读打开 SQLite 库。路径不存在 / 无权限时抛错；非 SQLite 文件要到首次查询才抛。 */
export function openReadOnly(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true })
}

/** 关闭句柄并吞掉关闭错误：只读句柄关不掉不影响已读到的数据，也不能盖掉调用方正在抛的错。 */
export function closeQuietly(db) {
  if (!db) return
  try {
    db.close()
  } catch {
    // 只读句柄关闭失败（已被关闭 / 进程退出中）：数据已读完，没有需要上报的后果
  }
}

/** 只读打开 → fn(db) → 必定关闭。打开失败与 fn 的异常原样上抛（失败要大声的读取路径用它）。 */
export function withReadOnlyDb(dbPath, fn) {
  const db = openReadOnly(dbPath)
  try {
    return fn(db)
  } finally {
    closeQuietly(db)
  }
}

/**
 * 「可能不是这个来源的库」的读取：打不开、probe 抛错（库损坏 / 锁定 / 非 SQLite）或 probe
 * 返回假值（签名不符）→ null，发现层据此当作「没有这个库」。签名通过后 read(db, sig) 的
 * 异常照常上抛（读到一半出错是真故障，不能伪装成「不是该来源的库」）。句柄恒关闭。
 * read 省略时直接返回 probe 的结果。
 */
export function readOptionalDb(dbPath, probe, read = (_db, sig) => sig) {
  let db
  try {
    db = openReadOnly(dbPath)
  } catch {
    // 文件不存在 / 无权限：按「无此库」处理
    return null
  }
  try {
    let sig
    try {
      sig = probe(db)
    } catch {
      // 表结构不符 / 库损坏 / 锁定 / 非 SQLite：按「无此库」处理
      return null
    }
    return sig ? read(db, sig) : null
  } finally {
    closeQuietly(db)
  }
}

/** 表的列名集合（PRAGMA table_info；表不存在时为空集，不抛）。表名只由本仓库代码给出。 */
export function columnsOf(db, table) {
  return new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map((c) => c.name))
}

/** 库里全部表名的集合。 */
export function tableNames(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name))
}

/** 库里是否有这张表。 */
export function hasTable(db, name) {
  return db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(name).n > 0
}
