// test/source-times.test.mjs — 库类来源的时间列与转换层同一口径（lib/convert/core.mjs 的 parseTimeMs）
//
// 数字时间：< 1e11 是 Unix 秒（截断到整秒再 ×1000，与 hermes / vibe 同口径），否则是毫秒；结果恒为
// 安全整数——Cline 索引库的 started_at 会经导入参数落进会话 header.createdAt，宿主只收安全整数。
// 字符串按 Date.parse。拿不到返回 null。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readClineDb } from '../lib/sources/cline.mjs'

// started_at / updated_at 声明为 REAL：数字原样存数字（TEXT 亲和的列会把数字转成文本）
function clineDb(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cline-times-'))
  mkdirSync(join(dir, 'db'), { recursive: true })
  const dbPath = join(dir, 'db', 'sessions.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at REAL, updated_at REAL, cwd TEXT)')
  const insert = db.prepare('INSERT INTO sessions (session_id, started_at, updated_at, cwd) VALUES (?, ?, ?, ?)')
  for (const r of rows) insert.run(r.id, r.started, r.updated, '/home/u/repo')
  db.close()
  return dbPath
}

test('cline 索引库：毫秒带小数 → 取整为安全整数，秒 → 截断到整秒的毫秒', () => {
  const rows = readClineDb(clineDb([
    { id: 'ms', started: 1786000000000.6, updated: 1786000005000 },
    { id: 'sec', started: 1786000000.9, updated: 1786000005 },
  ]))
  const byId = new Map(rows.map((r) => [r.id, r]))
  assert.equal(byId.get('ms').createdAt, 1786000000001)
  assert.equal(byId.get('ms').lastActiveAt, 1786000005000)
  assert.equal(byId.get('sec').createdAt, 1786000000000)
  assert.equal(byId.get('sec').lastActiveAt, 1786000005000)
  for (const r of rows) assert.ok(Number.isSafeInteger(r.createdAt), r.id)
})
