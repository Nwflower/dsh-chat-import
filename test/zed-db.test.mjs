// zed-db.test.mjs — Zed 线程库（threads.db）读取单测：造真实 SQLite 夹具
//（node:sqlite + zlib 的 zstd 压缩），覆盖 data_type=json/zstd 两条路径、子代理过滤、
// folder_paths 顺序还原、损坏载荷显式上报与「非 Zed 库 → null」的单表签名判定。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import { readZedThreads, readZedDb } from '../lib/sources/zed.mjs'
import { withTempDir, writeSqliteFixture } from './_support/tmp-db.mjs'

// 上游 db.rs 的建表 + 3×ALTER（老库可能缺后 4 列）
const CREATE = `CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at TEXT NOT NULL,
  data_type TEXT NOT NULL, data BLOB NOT NULL);
ALTER TABLE threads ADD COLUMN parent_id TEXT;
ALTER TABLE threads ADD COLUMN folder_paths TEXT;
ALTER TABLE threads ADD COLUMN folder_paths_order TEXT;
ALTER TABLE threads ADD COLUMN created_at TEXT;`

const ID = '2f8b1c6e-0000-4000-8000-000000000001'
const TS = '2026-09-15T13:38:45.123456789+00:00'

function threadJson(over = {}) {
  return JSON.stringify({
    title: '修登录页分页',
    updated_at: TS,
    version: '0.3.0',
    messages: [
      { User: { id: 'u1', content: [{ Text: '修一下登录页分页' }] } },
      { Agent: { content: [{ Text: '已修好。' }], tool_results: {}, reasoning_details: null } },
    ],
    ...over,
  })
}

// 本文件的临时库前缀；mkdtemp / 清理 / 建表 / 插行都在 _support/tmp-db.mjs。
const withTmp = (fn) => withTempDir('zed-test-', fn)

function makeDb(dbPath, rows, { create = CREATE, extraTable = null } = {}) {
  return writeSqliteFixture(dbPath, {
    create,
    statements: extraTable ? [extraTable] : [],
    rows: { threads: rows },
  })
}

function row(over = {}) {
  return {
    id: ID, summary: '修登录页分页', updated_at: TS, data_type: 'json',
    data: threadJson(), parent_id: null, folder_paths: '/home/u/proj',
    folder_paths_order: '0', created_at: TS, ...over,
  }
}

test('readZedThreads：标题取 summary 列、cwd 取 folder_paths 首项、时间原样给出（不解压 blob）', () => {
  withTmp((root) => {
    const dbPath = makeDb(join(root, 'threads', 'threads.db'), [
      row(),
      row({ id: 'sub-1', summary: '子代理线程', parent_id: ID, data: threadJson({ title: '子代理线程' }) }),
      row({ id: 'multi', summary: '多根工作区', folder_paths: '/b\n/a', folder_paths_order: '1,0' }),
    ])
    const rows = readZedThreads(dbPath)
    assert.equal(rows.length, 2) // parent_id 非空的子代理线程被过滤
    const first = rows.find((r) => r.id === ID)
    assert.equal(first.title, '修登录页分页')
    assert.equal(first.cwd, '/home/u/proj')
    assert.deepEqual(first.folderPaths, ['/home/u/proj'])
    assert.equal(first.createdAt, TS)
    assert.equal(first.updatedAt, TS)
    const multi = rows.find((r) => r.id === 'multi')
    assert.equal(multi.cwd, '/a') // order=1,0 → /a 在前
    assert.deepEqual(multi.folderPaths, ['/a', '/b'])
  })
})

test('readZedDb：data_type=zstd（上游写入端恒用的形态）能解压并解析', () => {
  withTmp((root) => {
    const json = threadJson()
    const dbPath = makeDb(join(root, 'threads.db'), [
      row({ data_type: 'zstd', data: zstdCompressSync(Buffer.from(json, 'utf8')) }),
    ])
    const decoded = readZedDb(dbPath)
    assert.equal(decoded.threads.length, 1)
    assert.equal(decoded.failed.length, 0)
    const t = decoded.threads[0]
    assert.equal(t.title, '修登录页分页')
    assert.equal(t.version, '0.3.0')
    assert.equal(t.messages.length, 2)
    assert.deepEqual(t.folderPaths, ['/home/u/proj'])
    // 圆环校验：我们自己压的帧能被 node 的 zstd 解回同一份 JSON
    assert.equal(zstdDecompressSync(zstdCompressSync(Buffer.from(json, 'utf8'))).toString('utf8'), json)
  })
})

test('readZedDb：damaged 载荷显式进 failed（不半读、不静默），未知 data_type 同样拒绝', () => {
  withTmp((root) => {
    const dbPath = makeDb(join(root, 'threads.db'), [
      row(),
      row({ id: 'broken-zstd', data_type: 'zstd', data: Buffer.from('not a zstd frame') }),
      row({ id: 'broken-json', data_type: 'json', data: '{oops' }),
      row({ id: 'weird', data_type: 'protobuf', data: 'x' }),
    ])
    const decoded = readZedDb(dbPath)
    assert.deepEqual(decoded.threads.map((t) => t.id), [ID])
    assert.deepEqual(decoded.failed.sort(), ['broken-json', 'broken-zstd', 'weird'])
  })
})

test('库签名：多表 / 缺列的库 → null（只有 threads 单表 + data_type/data/summary 才是 Zed 库）', () => {
  withTmp((root) => {
    assert.equal(readZedThreads(join(root, 'nope.db')), null)
    const extra = makeDb(join(root, 'extra.db'), [row()], { extraTable: 'CREATE TABLE messages (id TEXT)' })
    assert.equal(readZedThreads(extra), null) // 上游从不建 messages 表
    assert.equal(readZedDb(extra), null)
    const half = makeDb(join(root, 'half.db'), [], {
      create: 'CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT, updated_at TEXT)',
    })
    assert.equal(readZedThreads(half), null) // 缺 data_type/data
  })
})

test('老库（无 created_at 列）仍可读：createdAt 留空、不抛错', () => {
  withTmp((root) => {
    const dbPath = makeDb(join(root, 'threads.db'), [], {
      create: `CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at TEXT NOT NULL,
        data_type TEXT NOT NULL, data BLOB NOT NULL, parent_id TEXT, folder_paths TEXT, folder_paths_order TEXT)`,
    })
    const db = new DatabaseSync(dbPath)
    db.prepare('INSERT INTO threads (id, summary, updated_at, data_type, data, folder_paths) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ID, '老库线程', TS, 'json', threadJson(), '/home/u/proj')
    db.close()
    const rows = readZedThreads(dbPath)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].createdAt, null)
    assert.equal(readZedDb(dbPath).threads.length, 1)
  })
})
