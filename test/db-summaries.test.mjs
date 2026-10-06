// test/db-summaries.test.mjs — 发现层 SQLite 会话摘要读取器（真实临时库夹具）
//
// 面板不再展示消息条数 → 发现层不再为统计它整读 message/part 正文。opencode 系
//（opencode/mimocode/kilocode/teleagent）与 zcode/hermes 各自提供只查元数据的摘要
// 读取器，这里用合成 SQLite 库验证：字段口径、fork 过滤谓词、降级形态（缺 message
// 表 / 库里 message.data 非 JSON）下不解析正文，以及 discovery-host.readSessions 的
// 分派形状（条目不含 messageCount）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readOpencodeDbSummaries } from '../lib/sources/opencode.mjs'
import { readMimocodeDbSummaries } from '../lib/sources/mimocode.mjs'
import { readKilocodeDbSummaries } from '../lib/sources/kilocode.mjs'
import { readZcodeDbSummaries } from '../lib/sources/zcode.mjs'
import { readHermesDbSummaries } from '../lib/sources/hermes.mjs'
import { makeDiscoveryHost } from '../lib/discovery-host.mjs'
import { tempDb, tempDbPath } from './_support/tmp-db.mjs'

// 本文件的临时库前缀；mkdtemp / 建库 / 清理都在 _support/tmp-db.mjs。
const tmpDb = (name, build) => tempDb('dsh-summary-', name, build)

// opencode 三表最小形态：message.data 故意写成非 JSON——摘要路径不得解析正文。
function makeOpencodeDb(name = 'opencode.db', extraSessionCols = '') {
  return tmpDb(name, (db) => {
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER' + extraSessionCols + ')')
    db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
    db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT)')
    db.prepare('INSERT INTO session VALUES (?,?,?,?)').run('ses-a', '会话 A', 'E:/proj/a', 100)
    db.prepare('INSERT INTO session VALUES (?,?,?,?)').run('ses-b', '会话 B', 'E:/proj/b', 200)
    db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m1', 'ses-a', 150, 'not json at all')
    db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m2', 'ses-a', 180, '{oops')
    db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m3', 'ses-b', 260, 'still not json')
  })
}

test('readOpencodeDbSummaries：只读 session 表 + 最近消息时间，不解析 message.data', () => {
  const f = makeOpencodeDb()
  try {
    const rows = readOpencodeDbSummaries(f.path)
    assert.deepEqual(rows.map((r) => r.id), ['ses-a', 'ses-b']) // time_created 升序
    assert.equal(rows[0].title, '会话 A')
    assert.equal(rows[0].directory, 'E:/proj/a')
    assert.equal(rows[0].createdAt, 100)
    assert.equal(rows[0].lastActiveAt, 180) // MAX(message.time_created)；data 是脏 JSON 也不碰
    assert.equal(rows[1].lastActiveAt, 260)
    assert.ok(!('messageCount' in rows[0])) // 摘要有意不带消息条数
  } finally { f.cleanup() }
})

test('readOpencodeDbSummaries：缺 message 表（降级库）时 lastActiveAt 回落会话行时间', () => {
  const f = tmpDb('bare.db', (db) => {
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER)')
    db.prepare('INSERT INTO session VALUES (?,?,?,?)').run('only', '只有一个会话', 'E:/x', 42)
  })
  try {
    const rows = readOpencodeDbSummaries(f.path)
    assert.deepEqual(rows, [{ id: 'only', title: '只有一个会话', directory: 'E:/x', createdAt: 42, lastActiveAt: 42 }])
  } finally { f.cleanup() }
})

test('readOpencodeDbSummaries：where 谓词给 fork 做会话级过滤（只保留谓词命中的会话）', () => {
  const f = makeOpencodeDb()
  try {
    const rows = readOpencodeDbSummaries(f.path, { where: "title = '会话 B'" })
    assert.deepEqual(rows.map((r) => r.id), ['ses-b'])
  } finally { f.cleanup() }
})

test('readMimocodeDbSummaries：标题命中的后台任务会话在 SQL 层剔除（不读消息判 agent）', () => {
  const f = tmpDb('mimocode.db', (db) => {
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER)')
    db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
    const insert = db.prepare('INSERT INTO session VALUES (?,?,?,?)')
    insert.run('bg1', 'checkpoint-writer: cluster sync', 'E:/m', 10)
    insert.run('bg2', 'Auto Dream', 'E:/m', 20)
    insert.run('bg3', 'auto distill nightly', 'E:/m', 30)
    insert.run('keep', '正常会话', 'E:/m', 40)
  })
  try {
    assert.deepEqual(readMimocodeDbSummaries(f.path).map((r) => r.id), ['keep'])
  } finally { f.cleanup() }
})

test('readKilocodeDbSummaries：parent_id / time_archived 非空的会话剔除；无这两列的旧库全保留', () => {
  const modern = tmpDb('kilo.db', (db) => {
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, parent_id TEXT, time_archived INTEGER)')
    const insert = db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?)')
    insert.run('main', '主会话', 'E:/k', 10, null, null)
    insert.run('child', '子代理会话', 'E:/k', 20, 'main', null)
    insert.run('archived', '已归档', 'E:/k', 30, null, 1700000000000)
  })
  try {
    assert.deepEqual(readKilocodeDbSummaries(modern.path).map((r) => r.id), ['main'])
  } finally { modern.cleanup() }
  const legacy = tmpDb('kilo-old.db', (db) => {
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER)')
    db.prepare('INSERT INTO session VALUES (?,?,?,?)').run('any', '旧库会话', 'E:/k', 5)
  })
  try {
    // 无 parent_id / time_archived 列 → 不加谓词（PROGMA 自适应），旧库不误伤
    assert.deepEqual(readKilocodeDbSummaries(legacy.path).map((r) => r.id), ['any'])
  } finally { legacy.cleanup() }
})

test('readZcodeDbSummaries：只取主会话、createdAt 取 time_updated、lastActiveAt 取最近消息时间', () => {
  const f = tmpDb('db.sqlite', (db) => {
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER, parent_id TEXT)')
    db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
    const insert = db.prepare('INSERT INTO session VALUES (?,?,?,?,?)')
    insert.run('z1', '主会话', 'E:/z', 100, null)
    insert.run('z2', '空 parent 也当主会话', 'E:/z', 300, '')
    insert.run('sub', '子会话', 'E:/z', 400, 'z1')
    db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m1', 'z1', 150, '非法 JSON')
    db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m2', 'z1', 250, '[1,2')
  })
  try {
    const rows = readZcodeDbSummaries(f.path)
    assert.deepEqual(rows.map((r) => r.id), ['z1', 'z2']) // parent_id 非空剔除，按 time_updated 升序
    assert.equal(rows[0].createdAt, 100)
    assert.equal(rows[0].lastActiveAt, 250)
    assert.equal(rows[1].lastActiveAt, 300) // 无消息 → 回落 session.time_updated
  } finally { f.cleanup() }
})

test('readHermesDbSummaries：会话元数据 + 最近消息时间；非 hermes 库返回 null', () => {
  const f = tmpDb('state.db', (db) => {
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, started_at TEXT, ended_at TEXT)')
    db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, created_at TEXT, content TEXT)')
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run('h1', 'Hermes 会话', 'E:/h', '2026-04-22T17:40:00Z', '2026-04-22T17:42:10Z')
    db.prepare('INSERT INTO messages VALUES (?,?,?,?)').run('m1', 'h1', '2026-04-22T17:41:00Z', '正文不读')
    db.prepare('INSERT INTO messages VALUES (?,?,?,?)').run('m2', 'h1', '2026-04-22T17:41:30Z', '正文不读')
  })
  try {
    const rows = readHermesDbSummaries(f.path)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'h1')
    assert.equal(rows[0].title, 'Hermes 会话')
    assert.equal(rows[0].cwd, 'E:/h')
    assert.equal(rows[0].createdAt, Date.parse('2026-04-22T17:40:00Z'))
    assert.equal(rows[0].lastActiveAt, Date.parse('2026-04-22T17:41:30Z'))
  } finally { f.cleanup() }
  const other = tmpDb('state.db', (db) => { db.exec('CREATE TABLE unrelated (id TEXT)') })
  try {
    assert.equal(readHermesDbSummaries(other.path), null) // 无 sessions 表 → 不是 hermes 库
  } finally { other.cleanup() }
  assert.equal(readHermesDbSummaries(tempDbPath('dsh-summary-', 'definitely-missing-' + Date.now() + '.db')), null)
})

test('discovery-host.readSessions：按格式分派到摘要读取器，条目字段稳定（无 messageCount/cwd 冗余键）', async () => {
  const host = makeDiscoveryHost({ fs: { resolve: async (p) => p } })
  const opencode = makeOpencodeDb()
  try {
    const rows = await host.readSessions('opencode', opencode.path)
    assert.deepEqual(Object.keys(rows[0]).sort(), ['createdAt', 'directory', 'id', 'lastActiveAt', 'title'])
    assert.equal(rows.length, 2)
  } finally { opencode.cleanup() }
  const zcode = tmpDb('db.sqlite', (db) => {
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER, parent_id TEXT)')
    db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
    db.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run('z1', '标题', 'E:/z', 10, null)
  })
  try {
    const rows = await host.readSessions('zcode', zcode.path)
    assert.deepEqual(Object.keys(rows[0]).sort(), ['createdAt', 'directory', 'id', 'lastActiveAt', 'title'])
    assert.equal(rows[0].lastActiveAt, 10)
  } finally { zcode.cleanup() }
})
