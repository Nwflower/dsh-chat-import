// test/mimocode.test.mjs — mimocode 源（opencode fork）单元 + 集成测试（自包含）
//
// mimocode 是 opencode 的 fork：SQLite 三表（session/message/part）schema 与 opencode
// 同构，唯一差异是 session 表无 model 列（消息级 model 在 message.data.modelID）。
// converter 单测走真实 convertMimocodeJson（复用 convertOpencodeJson，仅 provider 标签
// 不同）；import_mimocode 集成测试用合成 SQLite fixture（真实 temp mimocode.db，无
// model 列）走 mock ctx 的 apply → register → execute 路径。后台任务会话
//（checkpoint-writer / AutoDream / AutoDistill）默认剔除。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apply } from '../index.mjs'
import { convertMimocodeJson } from '../convert.mjs'
import { readMimocodeDb, isMimocodeBackgroundSession } from '../lib/mimocode.mjs'
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
// workspaceRegistry + tools。真实 temp mimocode.db 走 node:fs stat。
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

// 辅助：import_chat 分发器定义——execute 时注入 format（等价旧 import_mimocode）
function chatDef(ctx, format = 'mimocode') {
  const tool = registeredDef(ctx, 'import_chat')
  return { ...tool, execute: (args) => tool.execute({ format, ...args }) }
}

// REQ-32：导入会话日志首事件为 session/imported 标记（seq 0、ignorable）。
function assertImportedMarker(events, { tool, sourceId, sourcePath }) {
  const ev = events[0]
  assert.equal(ev.type, 'session/imported')
  assert.equal(ev.seq, 0)
  assert.equal(ev.ignorable, true)
  assert.equal(ev.data.tool, tool)
  assert.equal(ev.data.sourceId, sourceId)
  assert.equal(ev.data.sourcePath, sourcePath)
  assert.equal(typeof ev.data.importedAt, 'number')
  assert.ok(ev.data.importedAt > 0)
}

// ── 合成 mimocode.db fixture：session 表无 model 列（与 opencode 唯一 schema 差异） ──

// 两个正常会话 + 三个后台任务会话（checkpoint-writer / AutoDream / AutoDistill）。
function mimocodeTestSessions() {
  return [
    {
      id: 'mim-a',
      title: 'Fix build',
      directory: 'E:/demo/mimocode',
      createdAt: 1786000000000,
      messages: [
        { id: 'msg-a1', createdAt: 1786000000001, data: { role: 'user' }, parts: [
          { id: 'p-a1', createdAt: 1786000000001, data: { type: 'text', text: '为什么构建失败' } },
        ] },
        { id: 'msg-a2', createdAt: 1786000000002, data: { role: 'assistant', modelID: 'mimo-cli-pro', path: { cwd: 'E:/demo/mimocode' } }, parts: [
          { id: 'p-a2', createdAt: 1786000000002, data: { type: 'text', text: '修好了' } },
        ] },
      ],
    },
    {
      id: 'mim-b',
      title: 'Refactor',
      directory: 'E:/demo/mimocode',
      createdAt: 1786000100000,
      messages: [
        { id: 'msg-b1', createdAt: 1786000100001, data: { role: 'user' }, parts: [
          { id: 'p-b1', createdAt: 1786000100001, data: { type: 'text', text: '重构模块' } },
        ] },
        { id: 'msg-b2', createdAt: 1786000100002, data: { role: 'assistant' }, parts: [
          { id: 'p-b2', createdAt: 1786000100002, data: { type: 'text', text: '完成' } },
        ] },
      ],
    },
    // 后台任务会话：checkpoint-writer（标题前缀 + agent 双信号命中）
    {
      id: 'bg-cw',
      title: 'checkpoint-writer: save memory',
      directory: 'E:/demo/mimocode',
      createdAt: 1786000200000,
      messages: [
        { id: 'msg-cw1', createdAt: 1786000200001, data: { role: 'assistant', agent: 'checkpoint-writer' }, parts: [
          { id: 'p-cw1', createdAt: 1786000200001, data: { type: 'text', text: 'writing checkpoint' } },
        ] },
      ],
    },
    // 后台任务会话：AutoDream（标题 "Auto Dream" + agent=dream）
    {
      id: 'bg-dream',
      title: 'Auto Dream',
      directory: 'E:/demo/mimocode',
      createdAt: 1786000300000,
      messages: [
        { id: 'msg-d1', createdAt: 1786000300001, data: { role: 'assistant', agent: 'dream' }, parts: [
          { id: 'p-d1', createdAt: 1786000300001, data: { type: 'text', text: 'dreaming' } },
        ] },
      ],
    },
    // 后台任务会话：AutoDistill（标题 "Auto Distill" + agent=distill）
    {
      id: 'bg-distill',
      title: 'Auto Distill',
      directory: 'E:/demo/mimocode',
      createdAt: 1786000400000,
      messages: [
        { id: 'msg-di1', createdAt: 1786000400001, data: { role: 'assistant', agent: 'distill' }, parts: [
          { id: 'p-di1', createdAt: 1786000400001, data: { type: 'text', text: 'distilling' } },
        ] },
      ],
    },
  ]
}

// 建临时 mimocode.db：session 表无 model 列（mimocode schema），message/part 同 opencode。
function makeMimocodeDb(sessions) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mimocode-'))
  const dbPath = join(dir, 'mimocode.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER)')
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  for (const s of sessions) {
    db.prepare('INSERT INTO session (id, title, directory, time_created) VALUES (?, ?, ?, ?)').run(s.id, s.title, s.directory, s.createdAt)
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

test('convertMimocodeJson：provider 标签为 mimocode（复用 opencode 转换器，仅标签不同）', () => {
  // converter 消费 readMimocodeDb 输出的已组装会话结构（非 DB 原始行）
  const dbPath = makeMimocodeDb(mimocodeTestSessions())
  const [session] = readMimocodeDb(dbPath)
  const out = convertMimocodeJson(JSON.stringify(session), { sourcePath: dbPath })
  assert.equal(out.turns.length, 1)
  assertImportedMarker(out.events, { tool: 'mimocode', sourceId: 'mim-a', sourcePath: dbPath })
})

// ── isMimocodeBackgroundSession：后台任务会话双信号判定 ──────────────────

test('isMimocodeBackgroundSession：标题前缀或消息 agent 命中即判定为后台会话', () => {
  // 标题前缀命中
  assert.equal(isMimocodeBackgroundSession({ title: 'checkpoint-writer: save memory' }), true)
  assert.equal(isMimocodeBackgroundSession({ title: 'Auto Dream' }), true)
  assert.equal(isMimocodeBackgroundSession({ title: 'Auto Distill' }), true)
  // 消息 agent 命中（标题无关）
  assert.equal(isMimocodeBackgroundSession({ title: '随意标题', messages: [{ agent: 'checkpoint-writer' }] }), true)
  assert.equal(isMimocodeBackgroundSession({ title: '随意标题', messages: [{ agent: 'dream' }] }), true)
  assert.equal(isMimocodeBackgroundSession({ title: '随意标题', messages: [{ agent: 'distill' }] }), true)
  // 正常会话不命中
  assert.equal(isMimocodeBackgroundSession({ title: 'Fix build', messages: [{ agent: 'main' }] }), false)
  assert.equal(isMimocodeBackgroundSession({}), false)
  assert.equal(isMimocodeBackgroundSession(null), false)
})

// ── readMimocodeDb：无 model 列 schema 兼容 + 后台过滤 ────────────────────

test('readMimocodeDb：session 表无 model 列正常读取（PRAGMA 探测兼容两种 schema）', () => {
  const dbPath = makeMimocodeDb(mimocodeTestSessions())
  const sessions = readMimocodeDb(dbPath)
  // 默认剔除 3 个后台任务会话，剩 2 个正常会话
  assert.equal(sessions.length, 2)
  assert.deepEqual(sessions.map((s) => s.id).sort(), ['mim-a', 'mim-b'])
})

test('readMimocodeDb：filter=null 显式不过滤 → 返回全部 5 个（含后台）', () => {
  const dbPath = makeMimocodeDb(mimocodeTestSessions())
  const sessions = readMimocodeDb(dbPath, { filter: null })
  assert.equal(sessions.length, 5)
})

// ── import_mimocode 集成 ─────────────────────────────────────────────────

test('import_mimocode 单库文件：批量形态、逐会话落盘、schema 校验、provider=mimocode', async () => {
  const dbPath = makeMimocodeDb(mimocodeTestSessions())
  const { ctx, persistence, attached } = makeCtx()
  apply(ctx)
  const def = chatDef(ctx)
  const value = await def.execute({ path: dbPath })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2) // 后台会话已剔除
  assert.equal(value.imported, 2)
  assert.equal(value.alreadyImported, 0)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  assert.equal(persistence.sessions.size, 2)
  assert.equal(attached.length, 2) // 有 cwd → 归组

  const saved = persistence.sessions.get('import-mim-a')
  assert.ok(saved)
  assert.equal(saved.meta.cwd, 'E:/demo/mimocode')
  assert.equal(saved.meta.createdAt, 1786000000000)
  assert.equal(saved.events.at(-1).type, 'session/title')
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assertImportedMarker(saved.events, { tool: 'mimocode', sourceId: 'mim-a', sourcePath: dbPath })
})

test('import_mimocode sessionIds 过滤：只导指定源会话', async () => {
  const dbPath = makeMimocodeDb(mimocodeTestSessions())
  const { ctx, persistence } = makeCtx()
  apply(ctx)
  const def = chatDef(ctx)
  const value = await def.execute({ path: dbPath, sessionIds: ['mim-b'] })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2) // 库里 2 个正常会话（后台已剔除），只处理被选中的
  assert.equal(value.imported, 1)
  assert.equal(value.results.length, 1)
  assert.equal(value.results[0].sessionId, 'import-mim-b')
  assert.equal(persistence.sessions.size, 1)
  assert.ok(persistence.sessions.get('import-mim-b'))
})

test('import_mimocode 幂等：重复导入同一库只落盘一次', async () => {
  const dbPath = makeMimocodeDb(mimocodeTestSessions())
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

test('import_mimocode 目录模式：自动定位 mimocode.db', async () => {
  const dbPath = makeMimocodeDb(mimocodeTestSessions())
  const { ctx, persistence } = makeCtx()
  apply(ctx)
  const def = chatDef(ctx)
  const value = await def.execute({ path: dirname(dbPath) })

  assert.equal(value.mode, 'batch')
  assert.equal(value.imported, 2)
  assert.equal(persistence.sessions.size, 2)
})
