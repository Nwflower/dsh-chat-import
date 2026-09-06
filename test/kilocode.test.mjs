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
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apply } from '../index.mjs'
import { convertKilocodeJson } from '../convert.mjs'
import { readKilocodeDb } from '../lib/kilocode.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

// REQ-24 registry 隔离：每个用例独立 DSH_HOME（registry 落盘在 $DSH_HOME/dsh-chat-import）
beforeEach(() => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-home-'))
})

// 内存态会话库：create/append/list/inspect（append 强制 seq 连续，引擎契约）。
function makePersistence() {
  const sessions = new Map()
  return {
    sessions,
    async list() { return [...sessions.values()].map((s) => s.meta) },
    async create(meta) {
      if (sessions.has(meta.id)) throw new Error('duplicate session ' + meta.id)
      sessions.set(meta.id, { meta, events: [] })
    },
    async append(id, events) {
      const s = sessions.get(id)
      if (!s) throw new Error('unknown session ' + id)
      for (let i = 0; i < events.length; i++) {
        const ev = events[i]
        if (typeof ev.seq !== 'number' || ev.seq !== s.events.length + i) {
          throw new Error('append seq 不连续: 期望 ' + (s.events.length + i) + ' 实际 ' + String(ev && ev.seq))
        }
      }
      s.events.push(...events)
    },
    async inspect(id) {
      const s = sessions.get(id)
      if (!s) throw new Error('unknown session ' + id)
      return { meta: s.meta, events: s.events }
    },
    async readFrom(id, fromSeq = 0) {
      const s = sessions.get(id)
      if (!s) throw new Error('unknown session ' + id)
      return { meta: s.meta, events: s.events.slice(fromSeq) }
    },
  }
}

// 最小化 mock ctx：fs（resolve/stat/processPath）+ sessionPersistence +
// workspaceRegistry + tools。真实 temp kilo.db 走 node:fs stat。
function makeCtx() {
  const persistence = makePersistence()
  const attached = []
  const workspaces = new Map()
  const registered = []
  const fs = {
    async resolve(path) { return { targetKey: path, displayPath: path } },
    async stat(target) {
      const path = target.targetKey
      let s
      try { s = statSync(path) } catch { /* 路径不存在或不可访问 → 视为未找到 */ return undefined }
      if (s.isDirectory()) return { type: 'directory' }
      return { type: 'file', size: s.size, version: 'real-' + s.size + '-' + s.mtimeMs + '-' + s.ctimeMs }
    },
    processPath(target) { return target.targetKey },
  }
  const workspaceRegistry = {
    async resolveByPath(p) { return workspaces.get(p) ?? null },
    async create(p) { const ws = { path: p, attachSession: async (id) => attached.push({ ws: p, id }) }; workspaces.set(p, ws); return ws },
  }
  const ctx = {
    fs,
    sessionPersistence: persistence,
    webServer: { register() {} },
    inject(serviceList, cb) {
      const list = Array.isArray(serviceList) ? serviceList : Object.keys(serviceList || {})
      if (list.every((s) => ctx[s] !== undefined)) return cb(ctx)
      return undefined
    },
    get(service) {
      if (service === 'workspaceRegistry') return workspaceRegistry
      if (service === 'sessionPersistence') return persistence
      return undefined
    },
    tools: { register(def) { registered.push(def); return () => {} } },
    on() { return () => {} },
  }
  ctx.tools.registered = (toolName) => registered.find((d) => d.name === toolName)
  return { ctx, persistence, attached, registered }
}

function registeredDef(ctx, toolName) {
  return ctx.tools.registered(toolName)
}

// 辅助：import_chat 分发器定义——execute 时注入 format（等价旧 import_kilocode）
function chatDef(ctx, format = 'kilocode') {
  const tool = registeredDef(ctx, 'import_chat')
  return { ...tool, execute: (args) => tool.execute({ format, ...args }) }
}

// 导入归属外置 registry（issue #34）：0.8.3 起日志不再写 session/imported 标记，
// 事件 envelope 键收敛在宿主白名单内（type/seq/time/data/surfaceOp/sourceEventSeqs）。
function assertEnvelopeHygiene(events) {
  assert.ok(events.every((e) => e.type !== 'session/imported'), '日志不得含 session/imported 标记')
  const ALLOWED = new Set(['type', 'seq', 'time', 'data', 'surfaceOp', 'sourceEventSeqs'])
  for (const e of events) {
    for (const key of Object.keys(e)) {
      assert.ok(ALLOWED.has(key), '事件 envelope 出现白名单外键: ' + key)
    }
    assert.equal(typeof e.seq, 'number')
    assert.equal(typeof e.time, 'number')
    assert.notEqual(e.data, undefined)
  }
}

// ── 合成 kilo.db fixture：session 表为 Kilo schema（model + parent_id + time_archived） ──

// 两个正常会话 + 一个子会话（parent_id 非空）+ 一个已归档会话（time_archived 非空）。
function kilocodeTestSessions() {
  return [
    {
      id: 'kilo-a',
      title: 'Fix build',
      directory: 'E:/demo/kilocode',
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
      directory: 'E:/demo/kilocode',
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
      directory: 'E:/demo/kilocode',
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
      directory: 'E:/demo/kilocode',
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
  db.prepare('INSERT INTO session (id, title, directory, time_created) VALUES (?, ?, ?, ?)').run('legacy-a', 'Old', 'E:/demo/kilocode', 1786100000000)
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
  const def = chatDef(ctx)
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
  assert.equal(saved.meta.cwd, 'E:/demo/kilocode')
  assert.equal(saved.meta.createdAt, 1786100000000)
  assert.equal(saved.events.at(-1).type, 'session/title')
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assertEnvelopeHygiene(saved.events)
})

test('import_kilocode 幂等：重复导入同一库只落盘一次', async () => {
  const dbPath = makeKilocodeDb(kilocodeTestSessions())
  const { ctx, persistence } = makeCtx()
  apply(ctx)
  const def = chatDef(ctx)
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
  const def = chatDef(ctx)
  const value = await def.execute({ path: dirname(dbPath) })

  assert.equal(value.mode, 'batch')
  assert.equal(value.imported, 2)
  assert.equal(persistence.sessions.size, 2)
})
