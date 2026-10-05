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
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apply } from '../lib/index.mjs'
import { loadImports, unwrapRecord, resolveRegistryDir } from '../lib/imports.mjs'
import { convertMimocodeJson } from '../lib/convert/index.mjs'
import { readMimocodeDb, isMimocodeBackgroundSession } from '../lib/sources/mimocode.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { hostAbs } from './_support/host-path.mjs'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'

// REQ-24 registry 隔离：每个用例独立 DSH_HOME（registry 落盘在 $DSH_HOME/dsh-chat-import）
beforeEach(() => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-home-'))
})

// ── 合成 mimocode.db fixture：session 表无 model 列（与 opencode 唯一 schema 差异） ──

// 两个正常会话 + 三个后台任务会话（checkpoint-writer / AutoDream / AutoDistill）。
function mimocodeTestSessions() {
  return [
    {
      id: 'mim-a',
      title: 'Fix build',
      directory: hostAbs('E:/demo/mimocode'),
      createdAt: 1786000000000,
      messages: [
        { id: 'msg-a1', createdAt: 1786000000001, data: { role: 'user' }, parts: [
          { id: 'p-a1', createdAt: 1786000000001, data: { type: 'text', text: '为什么构建失败' } },
        ] },
        { id: 'msg-a2', createdAt: 1786000000002, data: { role: 'assistant', modelID: 'mimo-cli-pro', path: { cwd: hostAbs('E:/demo/mimocode') } }, parts: [
          { id: 'p-a2', createdAt: 1786000000002, data: { type: 'text', text: '修好了' } },
        ] },
      ],
    },
    {
      id: 'mim-b',
      title: 'Refactor',
      directory: hostAbs('E:/demo/mimocode'),
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
      directory: hostAbs('E:/demo/mimocode'),
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
      directory: hostAbs('E:/demo/mimocode'),
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
      directory: hostAbs('E:/demo/mimocode'),
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
  assertEnvelopeHygiene(out.events)
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
  const def = chatDef(ctx, 'mimocode')
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
  assert.equal(saved.meta.cwd, hostAbs('E:/demo/mimocode'))
  assert.equal(saved.meta.createdAt, 1786000000000)
  assert.equal(saved.events.at(-1).type, 'session/title')
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assertEnvelopeHygiene(saved.events)
})

test('import_mimocode sessionIds 过滤：只导指定源会话', async () => {
  const dbPath = makeMimocodeDb(mimocodeTestSessions())
  const { ctx, persistence } = makeCtx()
  apply(ctx)
  const def = chatDef(ctx, 'mimocode')
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
  const def = chatDef(ctx, 'mimocode')
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
  const def = chatDef(ctx, 'mimocode')
  const value = await def.execute({ path: dirname(dbPath) })

  assert.equal(value.mode, 'batch')
  assert.equal(value.imported, 2)
  assert.equal(persistence.sessions.size, 2)
})

test('import_mimocode 目录模式与单库模式同口径：转换器 / 来源标签 / 导入格式一致', async () => {
  const dbPath = makeMimocodeDb(mimocodeTestSessions())
  const runIsolated = async (path) => {
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-home-'))
    const { ctx, persistence } = makeCtx()
    apply(ctx)
    await chatDef(ctx, 'mimocode').execute({ path })
    const { imports } = await loadImports(resolveRegistryDir())
    const formats = Object.values(imports).flatMap((r) => Object.values(unwrapRecord(r).sessions || {}).map((s) => s.format))
    return { persistence, formats }
  }
  const viaFile = await runIsolated(dbPath)
  const viaDir = await runIsolated(dirname(dbPath))

  const strip = (s) => JSON.stringify(s.events.map(({ time, ...e }) => e))
  for (const id of ['import-mim-a', 'import-mim-b']) {
    const a = viaFile.persistence.sessions.get(id)
    const b = viaDir.persistence.sessions.get(id)
    assert.ok(a && b, '两种入口都落盘了 ' + id)
    assert.equal(strip(b), strip(a), '目录模式不得退回 opencode 转换器 / 标签')
  }
  for (const formats of [viaFile.formats, viaDir.formats]) {
    assert.deepEqual(formats, ['mimocode', 'mimocode'], 'registry 记录的来源格式是 mimocode')
  }
})
