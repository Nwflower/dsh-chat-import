// test/opencode-v2.test.mjs — OpenCode V2（opencode 2.x，session_v2/session_message）读取测试
//
// OpenCode 2 沿用同一个 opencode.db：会话落 session_v2、转录落 session_message
//（(session_id, seq) 唯一、按 seq 升序），V1 的 session/message/part 只是 V1→V2 迁移的
// 来源、迁移后旧行仍在库里。这里用**混合库**（两代表都在、V1 里放一个诱饵会话）验证：
// 世代分派只读 V2 表（同一会话不会导入两次）、消息/工具/附件映射、压缩边界口径
//（最近一条 completed compaction 之前的内容不进模型上下文；running/failed 不是边界、
// 正文不丢），以及缺表时大声报错。夹具全部合成。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apply } from '../lib/index.mjs'
import { convertOpencodeJson } from '../lib/convert/index.mjs'
import {
  opencodeSchemaGeneration,
  readOpencodeDb,
  readOpencodeDbSummaries,
  readOpencodeV2,
} from '../lib/sources/opencode.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { hostAbs } from './_support/host-path.mjs'
import { makeCtx, chatDef } from './_support/fake-host.mjs'

// REQ-24 registry 隔离：每个用例独立 DSH_HOME（registry 落盘在 $DSH_HOME/dsh-chat-import）
beforeEach(() => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-home-'))
})

/** 1×1 PNG（合成字节，仅用于验证附件走图片通路）。 */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function tmpDbPath(name) {
  return join(mkdtempSync(join(tmpdir(), 'dsh-opencode2-')), name)
}

// 混合库：V1 三表（含诱饵会话）+ V2 两表。
function makeMixedDb({ withLegacy = true } = {}) {
  const dbPath = tmpDbPath('opencode.db')
  const db = new DatabaseSync(dbPath)
  if (withLegacy) {
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, model TEXT)')
    db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
    db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
    db.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run('ses_v1-decoy', 'V1 诱饵', hostAbs('E:/demo/opencode-v1'), 1786000000000, null)
    db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('msg-decoy', 'ses_v1-decoy', 1786000000001, JSON.stringify({ role: 'user' }))
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('prt-decoy', 'msg-decoy', 'ses_v1-decoy', 1786000000001, JSON.stringify({ type: 'text', text: '这段不该被导入' }))
  }
  db.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, cost REAL DEFAULT 0, tokens_input INTEGER DEFAULT 0, model TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)')
  db.exec('CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)')
  db.exec('CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq)')

  const addSession = (s) => db.prepare('INSERT INTO session_v2 (id, project_id, slug, directory, title, version, model, parent_id, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(s.id, 'proj-1', s.id, s.directory, s.title, '2.0.21', s.model ?? null, s.parentId ?? null, s.createdAt, s.createdAt + 1000)
  const addMessages = (sessionID, list) => {
    const ins = db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)')
    list.forEach((m, seq) => ins.run(m.id, sessionID, m.type, seq, m.createdAt, m.createdAt + 1, JSON.stringify(m.data)))
  }

  // 会话 A：用户附件 + assistant（reasoning/text/tool）+ 压缩边界 + 边界后的续跑 + 注入文本
  addSession({ id: 'ses_v2-a', title: 'V2 会话 A', directory: hostAbs('E:/demo/opencode2'), createdAt: 1786200000000, model: JSON.stringify({ id: 'deepseek-v4', providerID: 'deepseek', variant: 'flash' }) })
  addMessages('ses_v2-a', [
    { id: 'msg-a1', type: 'user', createdAt: 1786200000001, data: { type: 'user', text: '为什么构建失败', files: [{ data: PNG_BASE64, mime: 'image/png', name: 'shot.png' }], time: { created: 1786200000001 } } },
    { id: 'msg-a2', type: 'assistant', createdAt: 1786200000002, data: { type: 'assistant', agent: 'build', model: { providerID: 'deepseek', id: 'deepseek-v4' }, content: [
      { type: 'reasoning', text: '先看日志' },
      { type: 'text', text: '构建在 X 失败' },
      { type: 'tool', id: 'call_1', name: 'read', state: { status: 'completed', input: { filePath: 'F:/a.ts' }, content: [{ type: 'text', text: 'file body' }] }, time: { created: 1786200000003 } },
    ], time: { created: 1786200000002, completed: 1786200000004 } } },
    { id: 'msg-a3', type: 'user', createdAt: 1786200000005, data: { type: 'user', text: '继续（这段会被压缩遮蔽）', time: { created: 1786200000005 } } },
    { id: 'msg-a4', type: 'assistant', createdAt: 1786200000006, data: { type: 'assistant', agent: 'build', model: { providerID: 'deepseek', id: 'deepseek-v4' }, content: [{ type: 'text', text: '好的' }], time: { created: 1786200000006 } } },
    { id: 'msg-a5', type: 'compaction', createdAt: 1786200000007, data: { type: 'compaction', status: 'completed', reason: 'auto', summary: '摘要：构建在 X 失败', recent: '[User]: 为什么构建失败', time: { created: 1786200000007 } } },
    { id: 'msg-a6', type: 'user', createdAt: 1786200000008, data: { type: 'user', text: '再改一下', time: { created: 1786200000008 } } },
    { id: 'msg-a7', type: 'assistant', createdAt: 1786200000009, data: { type: 'assistant', agent: 'build', model: { providerID: 'deepseek', id: 'deepseek-v4' }, content: [{ type: 'text', text: '改完了' }], time: { created: 1786200000009 } } },
    { id: 'msg-a8', type: 'system', createdAt: 1786200000010, data: { type: 'system', text: 'The available tools have changed.', time: { created: 1786200000010 } } },
    { id: 'msg-a9', type: 'idle', createdAt: 1786200000011, data: { type: 'idle', outcome: 'succeeded', time: { created: 1786200000011 } } },
  ])

  // 会话 B：failed 压缩不是边界，正文不丢；tool 错误态
  addSession({ id: 'ses_v2-b', title: 'V2 会话 B', directory: hostAbs('E:/demo/opencode2'), createdAt: 1786200100000 })
  addMessages('ses_v2-b', [
    { id: 'msg-b1', type: 'user', createdAt: 1786200100001, data: { type: 'user', text: '老会话', time: { created: 1786200100001 } } },
    { id: 'msg-b2', type: 'compaction', createdAt: 1786200100002, data: { type: 'compaction', status: 'failed', reason: 'auto', summary: '半截摘要', recent: '[User]: 老会话', time: { created: 1786200100002 } } },
    { id: 'msg-b3', type: 'assistant', createdAt: 1786200100003, data: { type: 'assistant', agent: 'build', model: { providerID: 'deepseek', id: 'deepseek-v4' }, content: [{ type: 'tool', id: 'call_9', name: 'shell', state: { status: 'error', input: { command: 'false' }, error: { type: 'tool.execution', message: '命令失败' } }, time: { created: 1786200100004 } }], time: { created: 1786200100003 } } },
  ])

  // 子会话（parent_id 非空）：与 V1 口径一致，照常读取
  addSession({ id: 'ses_v2-child', title: '子任务', directory: hostAbs('E:/demo/opencode2'), createdAt: 1786200200000, parentId: 'ses_v2-a' })
  addMessages('ses_v2-child', [
    { id: 'msg-c1', type: 'user', createdAt: 1786200200001, data: { type: 'user', text: '子任务', time: { created: 1786200200001 } } },
    { id: 'msg-c2', type: 'assistant', createdAt: 1786200200002, data: { type: 'assistant', agent: 'build', model: { providerID: 'deepseek', id: 'deepseek-v4' }, content: [{ type: 'text', text: '子任务完成' }], time: { created: 1786200200002 } } },
  ])

  db.close()
  return dbPath
}

// ── 世代分派 ─────────────────────────────────────────────────────────────

test('opencodeSchemaGeneration：session_v2 → v2，session → v1，两者都无 → null', () => {
  const mixed = makeMixedDb()
  const v1Only = tmpDbPath('v1.db')
  const empty = tmpDbPath('empty.db')
  const mk = (p, sql) => { const db = new DatabaseSync(p); sql(db); db.close(); return p }
  mk(v1Only, (db) => db.exec('CREATE TABLE session (id TEXT PRIMARY KEY)'))
  mk(empty, (db) => db.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY)'))
  for (const [path, expected] of [[mixed, 'v2'], [v1Only, 'v1'], [empty, null]]) {
    const db = new DatabaseSync(path, { readOnly: true })
    try { assert.equal(opencodeSchemaGeneration(db), expected, path) } finally { db.close() }
  }
})

test('readOpencodeDb：混合库里只读 V2 表，V1 诱饵会话不被导入（同一会话不重复导入）', () => {
  const sessions = readOpencodeDb(makeMixedDb())
  assert.deepEqual(sessions.map((s) => s.id).sort(), ['ses_v2-a', 'ses_v2-b', 'ses_v2-child'])
})

test('readOpencodeDb：无 session/session_v2 表 → 大声报错（不静默返回空列表）', () => {
  const dbPath = tmpDbPath('unknown.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY)')
  db.close()
  assert.throws(() => readOpencodeDb(dbPath), /既无 session 也无 session_v2/)
})

test('readOpencodeDb：纯 V2 库（无 V1 三表）也能读', () => {
  const sessions = readOpencodeDb(makeMixedDb({ withLegacy: false }))
  assert.equal(sessions.length, 3)
})

// ── 消息映射 ─────────────────────────────────────────────────────────────

test('readOpencodeV2：user 文本/附件、assistant content、tool 输出、注入文本映射成 V1 同形中间 JSON', () => {
  const [a] = readOpencodeDb(makeMixedDb())
  assert.equal(a.id, 'ses_v2-a')
  assert.equal(a.title, 'V2 会话 A')
  assert.equal(a.directory, hostAbs('E:/demo/opencode2'))
  assert.equal(a.createdAt, 1786200000000)
  assert.equal(a.model, 'deepseek-v4')

  const user = a.messages[0]
  assert.equal(user.role, 'user')
  assert.deepEqual(user.parts[0], { type: 'text', text: '为什么构建失败' })
  assert.deepEqual(user.parts[1], { type: 'file', mime: 'image/png', data: PNG_BASE64, filename: 'shot.png' })

  const assistant = a.messages[1]
  assert.equal(assistant.role, 'assistant')
  assert.equal(assistant.modelID, 'deepseek-v4')
  assert.deepEqual(assistant.parts[0], { type: 'reasoning', text: '先看日志' })
  assert.deepEqual(assistant.parts[1], { type: 'text', text: '构建在 X 失败' })
  const tool = assistant.parts[2]
  assert.equal(tool.type, 'tool')
  assert.equal(tool.callID, 'call_1')
  assert.equal(tool.tool, 'read')
  assert.equal(tool.state.status, 'completed')
  assert.equal(tool.state.output, 'file body')
  assert.deepEqual(tool.state.input, { filePath: 'F:/a.ts' })

  // 注入文本（system）与 idle：前者当文本保留，后者没有正文不进 messages
  const injected = a.messages.filter((m) => m.role === 'user').map((m) => m.parts[0] && m.parts[0].text)
  assert.ok(injected.includes('The available tools have changed.'))
  assert.equal(a.messages.filter((m) => m.id === 'msg-a9').length, 0)
})

test('readOpencodeV2：tool 错误态取 error.message 作 output', () => {
  const b = readOpencodeDb(makeMixedDb()).find((s) => s.id === 'ses_v2-b')
  const tool = b.messages.find((m) => m.role === 'assistant').parts[0]
  assert.equal(tool.state.status, 'error')
  assert.equal(tool.state.output, '命令失败')
})

// ── 压缩边界 ─────────────────────────────────────────────────────────────

test('readOpencodeV2：completed 压缩是边界（tailStartId = 该行 id，summary+recent 都带）', () => {
  const [a] = readOpencodeV2(...(() => { const db = new DatabaseSync(makeMixedDb(), { readOnly: true }); return [db, {}] })())
  assert.equal(a.compactions.length, 1)
  assert.equal(a.compactions[0].tailStartId, 'msg-a5')
  assert.equal(a.compactions[0].summary, '摘要：构建在 X 失败')
  assert.equal(a.compactions[0].recent, '[User]: 为什么构建失败')
  assert.equal(a.summary, '摘要：构建在 X 失败')
})

test('readOpencodeV2：running/failed 压缩不是边界，正文按普通内容保留', () => {
  const db = new DatabaseSync(makeMixedDb(), { readOnly: true })
  const b = readOpencodeV2(db, {}).find((s) => s.id === 'ses_v2-b')
  db.close()
  assert.equal(b.compactions, undefined)
  assert.equal(b.unfinishedCompactions, 1)
  const kept = b.messages.find((m) => m.parts[0] && m.parts[0].text === '半截摘要\n\n[User]: 老会话')
  assert.ok(kept, '失败压缩的正文不得静默丢弃')
})

test('convertOpencodeJson：V2 边界正文 = summary + recent，边界前的轮被遮蔽', () => {
  const db = new DatabaseSync(makeMixedDb(), { readOnly: true })
  const a = readOpencodeV2(db, {})[0]
  db.close()
  const out = convertOpencodeJson(JSON.stringify(a), { provider: 'opencode' })
  assert.equal(out.compacted, true)
  assert.equal(out.compactions, 1)
  const checkpoint = out.turns.find((t) => t.compaction)
  assert.equal(checkpoint.compaction.summary, '摘要：构建在 X 失败\n\n[User]: 为什么构建失败')
  assert.ok(out.turns.filter((t) => t.shadowed).length >= 1, '边界之前的轮被遮蔽')
  const summaryEvent = out.events.find((e) => e.type === 'compaction/summary')
  assert.equal(summaryEvent.data.summary[0].text, '摘要：构建在 X 失败\n\n[User]: 为什么构建失败')
})

// ── 发现层摘要 ───────────────────────────────────────────────────────────

test('readOpencodeDbSummaries：V2 走 session_v2 + 最近转录时间，V1 诱饵会话不出现', () => {
  const rows = readOpencodeDbSummaries(makeMixedDb())
  assert.deepEqual(rows.map((r) => r.id), ['ses_v2-a', 'ses_v2-b', 'ses_v2-child'])
  assert.equal(rows[0].title, 'V2 会话 A')
  assert.equal(rows[0].directory, hostAbs('E:/demo/opencode2'))
  assert.equal(rows[0].createdAt, 1786200000000)
  assert.equal(rows[0].lastActiveAt, 1786200000011) // MAX(session_message.time_created)
})

// ── 导入集成 ─────────────────────────────────────────────────────────────

test('import_chat(format: opencode)：V2 库按会话批量导入，V1 诱饵会话不进结果', async () => {
  const dbPath = makeMixedDb()
  const { ctx, persistence, attached } = makeCtx()
  apply(ctx)
  const def = chatDef(ctx, 'opencode')
  const value = await def.execute({ path: dbPath })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 3)
  assert.equal(value.imported, 3)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  assert.equal(persistence.sessions.size, 3)
  assert.ok(!persistence.sessions.has('import-ses_v1-decoy'), 'V1 诱饵会话不得被导入')
  assert.equal(attached.length, 3) // 有 cwd → 归组

  const saved = persistence.sessions.get('import-ses_v2-a')
  assert.ok(saved)
  assert.equal(saved.meta.cwd, hostAbs('E:/demo/opencode2'))
  assert.equal(saved.meta.createdAt, 1786200000000)
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assert.ok(saved.events.some((e) => e.type === 'compaction/summary'), '压缩事务落进日志')
  const ALLOWED = new Set(['type', 'seq', 'time', 'data', 'surfaceOp', 'sourceEventSeqs'])
  for (const e of saved.events) for (const k of Object.keys(e)) assert.ok(ALLOWED.has(k), '事件 envelope 出现白名单外键: ' + k)
})

test('import_chat(format: opencode)：V2 库重复导入幂等', async () => {
  const dbPath = makeMixedDb()
  const { ctx, persistence } = makeCtx()
  apply(ctx)
  const def = chatDef(ctx, 'opencode')
  const first = await def.execute({ path: dbPath })
  const second = await def.execute({ path: dbPath })
  assert.equal(first.imported, 3)
  assert.equal(second.imported, 0)
  assert.equal(second.alreadyImported, 3)
  assert.equal(persistence.sessions.size, 3)
})
