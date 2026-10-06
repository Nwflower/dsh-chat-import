// test/kilocode.test.mjs — Kilo Code 源（opencode fork）单元 + 集成测试（自包含）
//
// Kilo Code 是 opencode 的 fork：本地历史库 SQLite 三表（session/message/part）
// schema 是 opencode 的超集（多出 parent_id / time_archived / slug 等列，核心对话列
// 同构）。converter 单测走真实 convertKilocodeJson（复用 convertOpencodeJson，仅
// provider 标签不同）；import_kilocode 集成测试用合成 SQLite fixture（真实 temp
// kilo.db）走 mock ctx 的 apply → register → execute 路径。子会话（parent_id 非空）
// 与已归档会话（time_archived 非空）默认跳过，只导主会话。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apply } from '../lib/index.mjs'
import { convertKilocodeJson } from '../lib/convert/index.mjs'
import { readKilocodeDb } from '../lib/sources/kilocode.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { hostAbs } from './_support/host-path.mjs'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'

// REQ-24 registry 隔离：每个用例独立 DSH_HOME（registry 落盘在 $DSH_HOME/dsh-chat-import）
beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
})

// ── 合成 kilo.db fixture：session 表为 Kilo schema（model + parent_id + time_archived） ──

// 两个正常会话 + 一个子会话（parent_id 非空）+ 一个已归档会话（time_archived 非空）。
function kilocodeTestSessions() {
  return [
    {
      id: 'kilo-a',
      title: 'Fix build',
      directory: hostAbs('E:/demo/kilocode'),
      createdAt: 1786100000000,
      model: JSON.stringify({ id: 'deepseek-v4', providerID: 'deepseek', variant: 'flash' }),
      messages: [
        { id: 'msg-a1', createdAt: 1786100000001, data: { role: 'user' }, parts: [
          { id: 'p-a1', createdAt: 1786100000001, data: { type: 'text', text: '为什么构建失败' } },
        ] },
        { id: 'msg-a2', createdAt: 1786100000002, data: { role: 'assistant', modelID: 'deepseek-v4' }, parts: [
          { id: 'p-a2', createdAt: 1786100000002, data: { type: 'reasoning', text: '检查日志' } },
          { id: 'p-a3', createdAt: 1786100000003, data: { type: 'text', text: '修好了' } },
        ] },
      ],
    },
    {
      id: 'kilo-b',
      title: 'Refactor',
      directory: hostAbs('E:/demo/kilocode'),
      createdAt: 1786100100000,
      messages: [
        { id: 'msg-b1', createdAt: 1786100100001, data: { role: 'user' }, parts: [
          { id: 'p-b1', createdAt: 1786100100001, data: { type: 'text', text: '重构模块' } },
        ] },
        { id: 'msg-b2', createdAt: 1786100100002, data: { role: 'assistant' }, parts: [
          { id: 'p-b2', createdAt: 1786100100002, data: { type: 'text', text: '完成' } },
        ] },
      ],
    },
    // 子会话（parent_id 非空，subagent/分叉产物）——默认跳过
    {
      id: 'kilo-child',
      title: 'subtask',
      directory: hostAbs('E:/demo/kilocode'),
      createdAt: 1786100200000,
      parentId: 'kilo-a',
      messages: [
        { id: 'msg-c1', createdAt: 1786100200001, data: { role: 'user' }, parts: [
          { id: 'p-c1', createdAt: 1786100200001, data: { type: 'text', text: '子任务' } },
        ] },
        { id: 'msg-c2', createdAt: 1786100200002, data: { role: 'assistant' }, parts: [
          { id: 'p-c2', createdAt: 1786100200002, data: { type: 'text', text: '子任务完成' } },
        ] },
      ],
    },
    // 已归档会话（time_archived 非空）——默认跳过
    {
      id: 'kilo-archived',
      title: 'Old work',
      directory: hostAbs('E:/demo/kilocode'),
      createdAt: 1786100300000,
      archivedAt: 1786100400000,
      messages: [
        { id: 'msg-d1', createdAt: 1786100300001, data: { role: 'user' }, parts: [
          { id: 'p-d1', createdAt: 1786100300001, data: { type: 'text', text: '旧任务' } },
        ] },
        { id: 'msg-d2', createdAt: 1786100300002, data: { role: 'assistant' }, parts: [
          { id: 'p-d2', createdAt: 1786100300002, data: { type: 'text', text: '旧答复' } },
        ] },
      ],
    },
  ]
}

// 建临时 kilo.db：session 表为 Kilo schema（model + parent_id + time_archived）。
function makeKilocodeDb(sessions) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-kilocode-'))
  const dbPath = join(dir, 'kilo.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, model TEXT, parent_id TEXT, time_archived INTEGER)')
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  for (const s of sessions) {
    db.prepare('INSERT INTO session (id, title, directory, time_created, model, parent_id, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(s.id, s.title, s.directory, s.createdAt, s.model ?? null, s.parentId ?? null, s.archivedAt ?? null)
    for (const m of s.messages) {
      db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run(m.id, s.id, m.createdAt, JSON.stringify(m.data))
      for (const p of m.parts) {
        db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(p.id, m.id, s.id, p.createdAt, JSON.stringify(p.data))
      }
    }
  }
  db.close()
  return dbPath
}

// ── converter 单测 ───────────────────────────────────────────────────────

test('convertKilocodeJson：provider 标签为 kilocode（复用 opencode 转换器，仅标签不同）', () => {
  const dbPath = makeKilocodeDb(kilocodeTestSessions())
  const [session] = readKilocodeDb(dbPath)
  const out = convertKilocodeJson(JSON.stringify(session), { sourcePath: dbPath })
  assert.equal(out.turns.length, 1)
  // assistant 消息 source.provider 标 kilocode（convertOpencodeJson 经 args.provider 覆盖）
  const asst = out.events.find((e) => e.type === 'assistant/message')
  assert.ok(asst, '有 assistant 消息事件')
  assert.equal(asst.data.message.source.provider, 'kilocode')
  assertEnvelopeHygiene(out.events)
})

// ── readKilocodeDb：跳过子会话 + 已归档会话 ───────────────────────────────

test('readKilocodeDb：默认跳过子会话（parent_id 非空）与已归档会话（time_archived 非空）', () => {
  const dbPath = makeKilocodeDb(kilocodeTestSessions())
  const sessions = readKilocodeDb(dbPath)
  assert.deepEqual(sessions.map((s) => s.id).sort(), ['kilo-a', 'kilo-b'])
})

test('readKilocodeDb：无 parent_id / time_archived 列的旧库正常读取（PRAGMA 探测兼容）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-kilocode-legacy-'))
  const dbPath = join(dir, 'kilo.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER)')
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  db.prepare('INSERT INTO session (id, title, directory, time_created) VALUES (?, ?, ?, ?)').run('legacy-a', 'Old', hostAbs('E:/demo/kilocode'), 1786100000000)
  db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run('msg-a', 'legacy-a', 1786100000001, JSON.stringify({ role: 'user' }))
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run('p-a', 'msg-a', 'legacy-a', 1786100000001, JSON.stringify({ type: 'text', text: 'hi' }))
  db.close()
  const sessions = readKilocodeDb(dbPath)
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].id, 'legacy-a')
})

// ── import_kilocode 集成 ─────────────────────────────────────────────────

test('import_kilocode 单库文件：批量形态、跳过子/归档会话、provider=kilocode、schema 校验', async () => {
  const dbPath = makeKilocodeDb(kilocodeTestSessions())
  const { ctx, persistence, attached } = makeCtx()
  apply(ctx)
  const def = chatDef(ctx, 'kilocode')
  const value = await def.execute({ path: dbPath })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2) // 子会话 + 已归档会话已剔除
  assert.equal(value.imported, 2)
  assert.equal(value.alreadyImported, 0)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  assert.equal(persistence.sessions.size, 2)
  assert.equal(attached.length, 2) // 有 cwd → 归组

  const saved = persistence.sessions.get('import-kilo-a')
  assert.ok(saved)
  assert.equal(saved.meta.cwd, hostAbs('E:/demo/kilocode'))
  assert.equal(saved.meta.createdAt, 1786100000000)
  assert.equal(saved.events.at(-1).type, 'session/title')
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assertEnvelopeHygiene(saved.events)
})

test('import_kilocode 幂等：重复导入同一库只落盘一次', async () => {
  const dbPath = makeKilocodeDb(kilocodeTestSessions())
  const { ctx, persistence } = makeCtx()
  apply(ctx)
  const def = chatDef(ctx, 'kilocode')
  const first = await def.execute({ path: dbPath })
  const second = await def.execute({ path: dbPath })

  assert.equal(first.imported, 2)
  assert.equal(second.imported, 0)
  assert.equal(second.alreadyImported, 2)
  assert.equal(persistence.sessions.size, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, second), [])
})

test('import_kilocode 目录模式：自动定位 kilo.db', async () => {
  const dbPath = makeKilocodeDb(kilocodeTestSessions())
  const { ctx, persistence } = makeCtx()
  apply(ctx)
  const def = chatDef(ctx, 'kilocode')
  const value = await def.execute({ path: dirname(dbPath) })

  assert.equal(value.mode, 'batch')
  assert.equal(value.imported, 2)
  assert.equal(persistence.sessions.size, 2)
})
