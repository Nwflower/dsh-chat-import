// test/teleagent.test.mjs — TeleAgent 源（opencode 派生，issue #60）单元 + 集成测试（自包含）
//
// TeleAgent（星辰超级智能体，中电信 TeleAI 桌面客户端）的会话库与 opencode 同构：
// SQLite 三表 session/message/part，message/part 的 data JSON 形状一致。本文件的
// fixture 按报告者实测 .schema 建（session 表**无 model 列**、message/part 有
// time_updated、另有 project/todo 表），确保与真实库的列集兼容。converter 复用
// convertOpencodeJson（仅 provider 标签为 teleagent）；import_teleagent 集成走
// mock ctx 的 apply → register → execute 路径；发现层用临时多账户目录验证
// users/<账户>/teleagent.db 的枚举。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apply } from '../lib/index.mjs'
import { convertTeleagentJson } from '../lib/convert/index.mjs'
import { mintSessionId } from '../lib/convert/core.mjs'
import { readTeleagentDb, teleagentDataDir, teleagentUsersDir, teleagentDbPath, TELEAGENT_DB_NAME, TELEAGENT_USERS_DIR } from '../lib/sources/teleagent.mjs'
import { discoverSessions } from '../lib/discovery.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { hostAbs } from './_support/host-path.mjs'

beforeEach(() => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  delete process.env.TELEAGENT_HOME
})

// 内存态会话库（与 mimocode.test.mjs 同款 mock）
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
      try { s = statSync(path) } catch { return undefined }
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

function chatDef(ctx, format = 'teleagent') {
  const tool = ctx.tools.registered('import_chat')
  return { ...tool, execute: (args) => tool.execute({ format, ...args }) }
}

function assertEnvelopeHygiene(events) {
  assert.ok(events.every((e) => e.type !== 'session/imported'), '日志不得含 session/imported 标记')
  const ALLOWED = new Set(['type', 'seq', 'time', 'data', 'surfaceOp', 'sourceEventSeqs'])
  for (const e of events) {
    for (const key of Object.keys(e)) assert.ok(ALLOWED.has(key), '事件 envelope 出现白名单外键: ' + key)
    assert.equal(typeof e.seq, 'number')
    assert.equal(typeof e.time, 'number')
    assert.notEqual(e.data, undefined)
  }
}

// ── 合成 teleagent.db：按 issue #60 报告者的 .schema 建表 ──
// session 无 model 列；message/part 带 time_updated；另有 project/todo 表。

// 两个用户会话：text / reasoning / tool(completed) / tool(error) / compaction 全形态
function teleagentTestSessions() {
  const dir = hostAbs('D:/demo/ws/genius-invokation')
  return [
    {
      id: 'ses_0f1e2d3c4b5a697889012abcdef01234',
      title: '牌局复盘',
      directory: dir,
      createdAt: 1786527086925,
      messages: [
        { id: 'msg_001', createdAt: 1786527086925, data: { role: 'user', agent: 'build', model: { providerID: 'teleai', modelID: 'tele-chat' }, time: { created: 1786527086925 } }, parts: [
          { id: 'prt_001', createdAt: 1786527086925, data: { type: 'text', text: '帮我复盘这局牌' } },
        ] },
        { id: 'msg_002', createdAt: 1786527086949, data: { role: 'assistant', parentID: 'msg_001', modelID: 'tele-chat', providerID: 'teleai', agent: 'build', mode: '', path: { cwd: dir, root: dir }, time: { created: 1786527086949, completed: 1786527092607 }, cost: 0, tokens: { total: 24776, input: 24678, output: 98, reasoning: 0, cache: { read: 0, write: 0 } }, finish: 'stop' }, parts: [
          { id: 'prt_002', createdAt: 1786527086950, data: { type: 'reasoning', text: '先读牌谱', time: { start: 1786527086950 } } },
          { id: 'prt_003', createdAt: 1786527086975, data: { type: 'step-start' } },
          { id: 'prt_004', createdAt: 1786527089784, data: { type: 'tool', callID: 'call-1', tool: 'read', state: { status: 'completed', input: { filePath: 'cards.json' }, title: 'cards.json', output: '[{"card":"fire"}]', metadata: { loaded: [], preview: '', truncated: false }, time: { start: 1786527089784, end: 1786527092600 } } } },
          { id: 'prt_005', createdAt: 1786527092607, data: { type: 'text', text: '第 3 手不该出火牌' } },
          { id: 'prt_006', createdAt: 1786527092700, data: { type: 'step-finish', reason: 'stop', cost: 0, tokens: { total: 24776, input: 24678, output: 98, reasoning: 0, cache: { read: 0, write: 0 } } } },
        ] },
      ],
    },
    {
      id: 'ses_9a8b7c6d5e4f0123456789abcdef01234',
      title: '带报错工具与会话内压缩',
      directory: dir,
      createdAt: 1786675502425,
      messages: [
        { id: 'msg_101', createdAt: 1786675502425, data: { role: 'user', agent: 'build', model: { providerID: 'teleai', modelID: 'tele-chat' }, time: { created: 1786675502425 } }, parts: [
          { id: 'prt_101', createdAt: 1786675502425, data: { type: 'text', text: '查一下牌表' } },
        ] },
        { id: 'msg_102', createdAt: 1786675502500, data: { role: 'assistant', parentID: 'msg_101', modelID: 'tele-chat', providerID: 'teleai', agent: 'build', mode: '', path: { cwd: dir, root: dir }, time: { created: 1786675502500, completed: 1786675503000 }, cost: 0, tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [
          { id: 'prt_102', createdAt: 1786675502501, data: { type: 'tool', callID: 'call-2', tool: 'bash', state: { status: 'error', input: { command: 'cat missing.json' }, error: 'no such file', time: { start: 1786675502502, end: 1786675502900 } } } },
          { id: 'prt_103', createdAt: 1786675502950, data: { type: 'text', text: '牌表文件不存在' } },
          { id: 'prt_104', createdAt: 1786675502990, data: { type: 'compaction', auto: true } },
        ] },
      ],
    },
  ]
}

// 建临时 teleagent.db：完全按报告者的 .schema（含 project/todo 与 time_updated 列）。
// dir 不存在时递归建（多账户场景：users/<账户>/ 都是新目录）。
function makeTeleagentDb(dir, sessions) {
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, TELEAGENT_DB_NAME)
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE project (
    id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT, icon_url TEXT, icon_color TEXT,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_initialized INTEGER,
    sandboxes TEXT NOT NULL, commands TEXT)`)
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL,
    directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, share_url TEXT,
    summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT,
    revert TEXT, permission TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
    time_compacting INTEGER, time_archived INTEGER, workspace_id TEXT,
    FOREIGN KEY (project_id) REFERENCES project(id))`)
  db.exec(`CREATE TABLE message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL, data TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES session(id))`)
  db.exec(`CREATE TABLE part (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL,
    FOREIGN KEY (message_id) REFERENCES message(id))`)
  db.exec(`CREATE TABLE todo (
    session_id TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL,
    position INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
    PRIMARY KEY (session_id, position))`)
  db.prepare('INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES (?, ?, ?, ?, ?)').run('pj_1', dir, '[]', 1786527000000, 1786527000000)
  for (const s of sessions) {
    db.prepare('INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.id, 'pj_1', s.id.slice(0, 12), s.directory, s.title, '1.2.27', s.createdAt, s.createdAt + 1000)
    for (const m of s.messages) {
      db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
        .run(m.id, s.id, m.createdAt, m.createdAt, JSON.stringify(m.data))
      for (const p of m.parts) {
        db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
          .run(p.id, m.id, s.id, p.createdAt, p.createdAt, JSON.stringify(p.data))
      }
    }
  }
  db.close()
  return dbPath
}

// ── 路径辅助 ─────────────────────────────────────────────────────────────

test('teleagent 路径辅助：TELEAGENT_HOME 覆盖 → users 层 → 账户库路径', () => {
  const home = process.platform === 'win32' ? 'C:\\Users\\u' : '/home/u'
  process.env.TELEAGENT_HOME = join(home, 'custom-ta')
  assert.equal(teleagentDataDir(home), join(home, 'custom-ta'))
  assert.equal(teleagentUsersDir(home), join(home, 'custom-ta', TELEAGENT_USERS_DIR))
  assert.equal(teleagentDbPath(home, 'v1_public_1'), join(home, 'custom-ta', TELEAGENT_USERS_DIR, 'v1_public_1', TELEAGENT_DB_NAME))
  delete process.env.TELEAGENT_HOME
  assert.equal(teleagentDataDir(home), join(home, '.local', 'share', 'TeleAgent'))
})

// ── converter 单测 ───────────────────────────────────────────────────────

test('convertTeleagentJson：provider 标签为 teleagent（复用 opencode 转换器）', () => {
  const dbPath = makeTeleagentDb(mkdtempSync(join(tmpdir(), 'dsh-teleagent-')), teleagentTestSessions())
  const [session] = readTeleagentDb(dbPath)
  const out = convertTeleagentJson(JSON.stringify(session), { sourcePath: dbPath })
  assert.equal(out.turns.length, 1)
  assert.deepEqual(out.turns[0].steps.map((st) => st.model), ['tele-chat'])
  assertEnvelopeHygiene(out.events)
  // reasoning 进 content，tool 调用配对结果
  const step = out.turns[0].steps[0]
  assert.deepEqual(step.content.map((c) => c.type), ['reasoning', 'tool-call', 'text'])
  assert.equal(step.toolCalls[0].id, 'call-1')
  assert.equal(step.toolResults[0].content[0].text, '[{"card":"fire"}]')
})

test('convertTeleagentJson：报错工具结果 → isError，compaction 无 tail 不裁剪', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-teleagent-'))
  const dbPath = makeTeleagentDb(dir, teleagentTestSessions())
  const [, second] = readTeleagentDb(dbPath)
  const out = convertTeleagentJson(JSON.stringify(second), { sourcePath: dbPath })
  assert.equal(out.turns.length, 1)
  const step = out.turns[0].steps[0]
  assert.equal(step.toolResults[0].isError, true, 'state.status=error → isError')
  // 样本中的 compaction 只有 {auto:true}、无 tail_start_id → 全量保留（不丢历史）
  assert.equal(out.turns.length, 1)
  assert.equal(out.meta.id, mintSessionId('ses_9a8b7c6d5e4f0123456789abcdef01234'))
})

// ── 读取器（真实 SQLite）───────────────────────────────────────────────

test('readTeleagentDb：无 model 列 schema 兼容（PRAGMA 探测），会话按 (time_created,id) 排序', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-teleagent-'))
  const sessions = teleagentTestSessions()
  const dbPath = makeTeleagentDb(dir, [sessions[1], sessions[0]])
  const read = readTeleagentDb(dbPath)
  assert.deepEqual(read.map((s) => s.id), [sessions[0].id, sessions[1].id], '按 time_created 升序')
  assert.equal(read[0].title, '牌局复盘')
  assert.equal(read[0].directory, sessions[0].directory)
  // message 级 model 从 data.modelID 取（session 表无 model 列）
  assert.equal(read[0].messages[1].model, 'tele-chat')
})

// ── 发现层：多账户目录枚举 ─────────────────────────────────────────────

// 发现层 host：真实临时目录的 stat/readDir/readText/readHead + readSessions（内联
// discovery-host 的 dbSummary 同款映射——扫描器只消费
// id/title/directory/createdAt/lastActiveAt）
function discoveryHost() {
  return {
    async stat(path) {
      let s
      try { s = statSync(path) } catch { return null }
      return s.isDirectory() ? { type: 'directory', mtimeMs: s.mtimeMs, size: s.size } : { type: 'file', mtimeMs: s.mtimeMs, size: s.size }
    },
    async readDir(dir) {
      let list
      try { list = readdirSync(dir) } catch { return null }
      return list.filter((name) => !name.startsWith('.')).map((name) => {
        const full = join(dir, name)
        let isDir = false
        try { isDir = statSync(full).isDirectory() } catch { isDir = false }
        return { name, type: isDir ? 'directory' : 'file', path: full }
      })
    },
    async readText(path) {
      try { return readFileSync(path, 'utf8') } catch { return null }
    },
    async readHead(path, max) {
      try { return readFileSync(path, 'utf8').slice(0, max) } catch { return null }
    },
    async readSessions(kind, dbPath) {
      return readTeleagentDb(dbPath).map((s) => ({
        id: s.id, title: s.title, directory: s.directory,
        createdAt: s.createdAt, lastActiveAt: lastMsgTime(s.messages),
      }))
    },
  }
}

function lastMsgTime(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const v = messages[i] && messages[i].createdAt
    if (typeof v === 'number') return v
  }
  return undefined
}

test('scanTeleagent：users/ 多账户目录 → 逐账户库出条目；账户目录/库文件直扫同样可用', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-teleagent-root-'))
  const users = join(root, TELEAGENT_USERS_DIR)
  const accA = join(users, 'v1_public_111')
  const accB = join(users, 'v1_public_222')
  const sessions = teleagentTestSessions()
  makeTeleagentDb(accA, [sessions[0]])
  makeTeleagentDb(accB, [sessions[1]])
  const host = discoveryHost()

  // 从 TeleAgent 数据根（users 的上一级）扫：下钻 users/ 枚举账户
  const fromDataRoot = await discoverSessions({ path: root, format: 'teleagent', host, imports: {} })
  assert.equal(fromDataRoot.total, 2)
  assert.deepEqual(fromDataRoot.sessions.map((s) => s.sessionId).sort(), [sessions[0].id, sessions[1].id].sort())
  for (const s of fromDataRoot.sessions) {
    assert.equal(s.title === '牌局复盘' || s.title === '带报错工具与会话内压缩', true)
    assert.equal(s.sourcePath.endsWith(TELEAGENT_DB_NAME), true)
  }

  // 直接给 users/ 目录：同样两库
  const fromUsers = await discoverSessions({ path: users, format: 'teleagent', host, imports: {} })
  assert.equal(fromUsers.total, 2)

  // 直接给账户目录：只扫该账户
  const fromAccount = await discoverSessions({ path: accA, format: 'teleagent', host, imports: {} })
  assert.equal(fromAccount.total, 1)
  assert.equal(fromAccount.sessions[0].sessionId, sessions[0].id)
})

// ── import_teleagent 集成（mock ctx + 真实临时库）──────────────────────

test('import_teleagent 单库：恒批量、落盘、归组、schema 校验', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-teleagent-'))
  const dbPath = makeTeleagentDb(dir, teleagentTestSessions())
  const { ctx, persistence, attached, registered } = makeCtx()
  apply(ctx)
  const def = chatDef(ctx)
  const value = await def.execute({ path: dbPath })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  const sidA = mintSessionId('ses_0f1e2d3c4b5a697889012abcdef01234')
  const sidB = mintSessionId('ses_9a8b7c6d5e4f0123456789abcdef01234')
  assert.deepEqual([...persistence.sessions.keys()].sort(), [sidA, sidB].sort())
  const saved = persistence.sessions.get(sidA)
  assert.ok(saved, 'teleagent 会话按源 id 落盘')
  assert.equal(saved.meta.cwd, hostAbs('D:/demo/ws/genius-invokation'))
  const titleEv = saved.events.find((e) => e.type === 'session/title')
  assert.ok(titleEv, '钉标题事件存在')
  assert.equal(titleEv.data.title, 'TeleAgent · 牌局复盘')
  assert.ok(attached.length >= 1)
  // 模型来源标注 provider=teleagent（assistant/message 的 source）
  const asst = saved.events.find((e) => e.type === 'assistant/message')
  assert.equal(asst.data.message.source.provider, 'teleagent')
  assert.equal(registered.length > 0, true)
})

test('import_teleagent 幂等：重导跳过；sessionIds 过滤只导所选；目录模式定位库文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-teleagent-'))
  const dbPath = makeTeleagentDb(dir, teleagentTestSessions())
  const { ctx, persistence } = makeCtx()
  apply(ctx)
  const def = chatDef(ctx)

  const first = await def.execute({ path: dbPath })
  assert.equal(first.imported, 2)
  const again = await def.execute({ path: dbPath })
  assert.equal(again.alreadyImported, 2)
  assert.equal(persistence.sessions.size, 2)

  // 目录模式（账户目录内含 teleagent.db）
  const byDir = await def.execute({ path: dir })
  assert.equal(byDir.mode, 'batch')
  assert.equal(byDir.alreadyImported, 2)
})

test('import_teleagent sessionIds 过滤：全新环境只导指定源会话（多会话库）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-teleagent-'))
  const dbPath = makeTeleagentDb(dir, teleagentTestSessions())
  const { ctx, persistence } = makeCtx()
  apply(ctx)
  const def = chatDef(ctx)
  const filtered = await def.execute({ path: dbPath, sessionIds: ['ses_0f1e2d3c4b5a697889012abcdef01234'] })
  assert.equal(filtered.total, 2, '库里有两条')
  assert.equal(filtered.imported, 1, '只导所选一条')
  assert.equal(persistence.sessions.size, 1)
})

test('import_teleagent：非 SQLite 库 / 缺 DB 目录 → 大声失败', async () => {
  const { ctx } = makeCtx()
  apply(ctx)
  const def = chatDef(ctx)
  const bogus = mkdtempSync(join(tmpdir(), 'dsh-teleagent-'))
  const notDb = join(bogus, 'teleagent.db')
  writeFileSync(notDb, 'definitely not a sqlite database')
  await assert.rejects(() => def.execute({ path: notDb }), /not a database/i)
  // 目录里没有 teleagent.db → 打开 <dir>/teleagent.db 失败（CANTOPEN），同样大声
  await assert.rejects(() => def.execute({ path: bogus }), /unable to open database file|not a database|SQLITE/i)
})
