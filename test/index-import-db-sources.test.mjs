// index-import-db-sources.test.mjs — 库 / 会话目录来源集成（opencode / grokbuild / hermes）
// 真实 SQLite 临时库与会话目录夹具：批量落盘、子表记录、压缩边界。
// 由 test/index.test.mjs 按横幅分组拆出（纯移动：用例与断言未改）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apply, readOpencodeDb } from '../lib/index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { hostAbs } from './_support/host-path.mjs'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { tempDbPath, openSqliteFixture, freshDshHome } from './_support/tmp-db.mjs'
import { clearScanCache } from '../lib/discovery.mjs'
import { opencodeTestSessions, makeOpencodeDb } from './_support/index-fixtures.mjs'

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
})

function opencodeCompactedSession() {
  return {
    id: 'ses-comp',
    title: 'Long task',
    directory: hostAbs('E:/demo/opencode'),
    createdAt: 1786000000000,
    model: { id: 'deepseek-v4-flash', providerID: 'opencode-go' },
    messages: [
      { id: 'msg-c1', createdAt: 1786000000001, data: { role: 'user' }, parts: [
        { id: 'p-c1', createdAt: 1786000000001, data: { type: 'text', text: '第一个问题' } },
      ] },
      { id: 'msg-c2', createdAt: 1786000000002, data: { role: 'assistant' }, parts: [
        { id: 'p-c2', createdAt: 1786000000002, data: { type: 'text', text: '第一个回答' } },
      ] },
      { id: 'msg-c3', createdAt: 1786000000003, data: { role: 'user' }, parts: [
        { id: 'p-c3', createdAt: 1786000000003, data: { type: 'text', text: '第二个问题' } },
      ] },
      { id: 'msg-c4', createdAt: 1786000000004, data: { role: 'assistant' }, parts: [
        { id: 'p-c4', createdAt: 1786000000004, data: { type: 'text', text: '第二个回答' } },
      ] },
      { id: 'msg-c5', createdAt: 1786000000005, data: { role: 'user' }, parts: [
        { id: 'p-c5', createdAt: 1786000000005, data: { type: 'compaction', tail_start_id: 'msg-c3' } },
      ] },
      { id: 'msg-c6', createdAt: 1786000000006, data: { role: 'assistant', mode: 'compaction', summary: true }, parts: [
        { id: 'p-c6', createdAt: 1786000000006, data: { type: 'text', text: '前面做过的所有事摘要。' } },
      ] },
    ],
  }
}

// 在 os.tmpdir() 建临时 opencode.db（opencode schema 的 session/message/part 三表），返回 db 路径。

function grokChat(n) {
  const lines = []
  for (let i = 1; i <= n; i++) {
    lines.push(JSON.stringify({ type: 'user', content: [{ type: 'text', text: '问题' + i }] }))
    lines.push(JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: '回答' + i }] }))
  }
  return lines.join('\n')
}

function makeHermesTestDb() {
  const dbPath = tempDbPath('dsh-hermes-', 'state.db')
  const db = openSqliteFixture(dbPath)
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, started_at REAL)')
  db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, created_at REAL)')
  db.prepare('INSERT INTO sessions (id, title, cwd, started_at) VALUES (?, ?, ?, ?)').run('hm-a', 'Fix hermes build', hostAbs('E:/demo/hermes'), 1786000000000)
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run('hm-a', 'user', '为什么构建失败', 1786000000001)
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run('hm-a', 'assistant', '是缺依赖。', 1786000000002)
  db.prepare('INSERT INTO sessions (id, title, cwd, started_at) VALUES (?, ?, ?, ?)').run('hm-b', 'Refactor', hostAbs('E:/demo/hermes'), 1786000100000)
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run('hm-b', 'user', '重构模块', 1786000100001)
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run('hm-b', 'assistant', '完成', 1786000100002)
  db.close()
  return dbPath
}

// 往临时 hermes state.db 追加一轮（user + assistant）。

function addHermesTurn(dbPath, sessionId, userText, asstText, timeBase) {
  const db = new DatabaseSync(dbPath)
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(sessionId, 'user', userText, timeBase)
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(sessionId, 'assistant', asstText, timeBase + 1)
  db.close()
}

test('import_opencode 单库文件：批量形态、逐会话落盘、schema 校验', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const { ctx, persistence, attached } = makeCtx({}) // stat 不在 tree 里 → 按 DB 文件处理
  apply(ctx)
  const def = chatDef(ctx, 'opencode')
  const value = await def.execute({ path: dbPath })

  assert.equal(value.mode, 'batch') // 单 .db 也恒批量
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.equal(value.alreadyImported, 0)
  assert.equal(value.skipped, 0)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const savedA = persistence.sessions.get('import-ses-a')
  assert.ok(savedA)
  assert.equal(savedA.meta.cwd, hostAbs('E:/demo/opencode'))
  assert.equal(savedA.meta.createdAt, 1786000000000)
  assert.equal(savedA.events.at(-1).type, 'session/title')
  assert.ok(savedA.events.every((e, i) => e.seq === i))
  // 标记：tool=opencode、sourceId=源会话 id、sourcePath=opencode.db 路径（工具入参）
  assertEnvelopeHygiene(savedA.events)
  // tool/call + tool/result 关联落盘
  const call = savedA.events.find((e) => e.type === 'tool/call')
  const result = savedA.events.find((e) => e.type === 'tool/result')
  assert.equal(call.data.callId, 'call-a1')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.equal(result.data.message.content[0].content[0].text, 'Compiling...')
  // 会话级模型回退（msg-b2 无模型）
  const savedB = persistence.sessions.get('import-ses-b')
  assert.ok(savedB)
  const asstB = savedB.events.find((e) => e.type === 'assistant/message').data.message
  assert.equal(asstB.source.model, 'deepseek-v4-flash')
  // 有 cwd → 归组两个会话
  assert.equal(attached.length, 2)
})

test('import_opencode 目录模式：自动定位 opencode.db、schema 校验', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const dirPath = dirname(dbPath)
  const { ctx, persistence } = makeCtx({ [dirPath]: 'dir' }) // stat 命中 → 目录分支
  apply(ctx)
  const def = chatDef(ctx, 'opencode')
  const value = await def.execute({ path: dirPath })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  assert.equal(persistence.sessions.size, 2)
})

test('import_opencode sessionIds 过滤：只导指定源会话', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'opencode')
  const value = await def.execute({ path: dbPath, sessionIds: ['ses-b'] })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2) // 库里 2 个会话，只处理被选中的
  assert.equal(value.imported, 1)
  assert.equal(value.results.length, 1)
  assert.equal(value.results[0].sessionId, 'import-ses-b')
  assert.equal(persistence.sessions.size, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('import_opencode 幂等：重复导入同一库只落盘一次', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'opencode')
  const first = await def.execute({ path: dbPath })
  const second = await def.execute({ path: dbPath })

  assert.equal(first.imported, 2)
  assert.equal(second.imported, 0)
  assert.equal(second.alreadyImported, 2)
  assert.equal(persistence.sessions.size, 2)
})

test('import_opencode sessionIds 补导：库未变时再选未导过的会话仍真正落盘', async () => {
  // 回归：DB version/size 未变时 S3 短路径曾直接对已导子表返回 already-imported，
  // 忽略 args.sessionIds，导致面板「部分」条目补导无效（opencode/mimocode/teleagent 同构）。
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'opencode')
  const first = await def.execute({ path: dbPath, sessionIds: ['ses-a'] })
  assert.equal(first.imported, 1)

  // 同一未变化的库，补导另一个会话：短路径不得吞掉新选中的 ses-b
  const second = await def.execute({ path: dbPath, sessionIds: ['ses-b'] })
  assert.equal(second.imported, 1)
  assert.equal(second.results.length, 1)
  assert.equal(second.results[0].sessionId, 'import-ses-b')
  assert.equal(persistence.sessions.size, 2)

  // 再选已导过的会话：仍是幂等 already-imported（短路径对被覆盖选择照常生效）
  const third = await def.execute({ path: dbPath, sessionIds: ['ses-a'] })
  assert.equal(third.imported, 0)
  assert.equal(persistence.sessions.size, 2)
})

test('import_opencode WAL 盲区：主文件未变、-wal 增长 → 新会话仍被增量导入', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const conn = new DatabaseSync(dbPath)
  conn.exec('PRAGMA journal_mode=WAL')
  conn.exec('PRAGMA wal_autocheckpoint=0') // 阻止自动 checkpoint 合并回主文件
  // 连接保持打开（-wal 持续存在；关闭最后一个连接会触发 checkpoint + 删除 -wal）
  try {
    const { ctx, persistence } = makeCtx({})
    apply(ctx)
    const def = chatDef(ctx, 'opencode')
    const first = await def.execute({ path: dbPath })
    assert.equal(first.imported, 2)
    const mainBefore = statSync(dbPath)

    // 追加第三个会话：只落 -wal，主文件 stat 不变
    conn.prepare('INSERT INTO session (id, title, directory, time_created, model) VALUES (?, ?, ?, ?, ?)')
      .run('ses-wal', 'Wal session', hostAbs('E:/demo/opencode'), 1786000200000, null)
    conn.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
      .run('msg-w1', 'ses-wal', 1786000200001, JSON.stringify({ role: 'user' }))
    conn.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)')
      .run('p-w1', 'msg-w1', 'ses-wal', 1786000200001, JSON.stringify({ type: 'text', text: '新问题' }))
    const mainAfter = statSync(dbPath)
    assert.equal(mainAfter.size, mainBefore.size) // 前提：主文件确实没变（WAL 语义成立）

    const second = await def.execute({ path: dbPath })
    assert.equal(second.imported, 1)
    assert.equal(second.alreadyImported, 2)
    assert.equal(persistence.sessions.size, 3)
    assert.ok(persistence.sessions.get('import-ses-wal'))
  } finally {
    conn.close()
  }
})

test('readOpencodeDb：只读抽取会话、消息/part 排序、模型解析', () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const sessions = readOpencodeDb(dbPath)

  assert.equal(sessions.length, 2)
  const a = sessions.find((s) => s.id === 'ses-a')
  assert.equal(a.title, 'Fix build')
  assert.equal(a.directory, hostAbs('E:/demo/opencode'))
  assert.equal(a.model, 'deepseek-v4-flash') // session.model JSON 字符串 → id
  assert.equal(a.createdAt, 1786000000000)
  assert.equal(a.messages.length, 2)
  assert.equal(a.messages[0].role, 'user')
  assert.equal(a.messages[1].role, 'assistant')
  assert.equal(a.messages[1].model, 'deepseek-v4-pro') // data.modelID 平铺
  assert.equal(a.messages[1].cwd, hostAbs('E:/demo/opencode')) // data.path.cwd
  assert.equal(a.messages[1].parts.length, 3)
  assert.equal(a.messages[1].parts[0].type, 'reasoning')
  assert.equal(a.messages[1].parts[1].type, 'tool')
  // 无模型的消息不携带 model
  const b = sessions.find((s) => s.id === 'ses-b')
  assert.equal(b.messages[1].model, undefined)
})

test('readOpencodeDb：压缩不切日志（全量消息 + compactions 描述），fullHistory 不发检查点', () => {
  const dbPath = makeOpencodeDb([opencodeCompactedSession()])
  const [s] = readOpencodeDb(dbPath)
  assert.equal(s.summary, '前面做过的所有事摘要。') // 兼容字段 = 最后一次压缩摘要
  assert.deepEqual(s.compactions, [{ tailStartId: 'msg-c3', summary: '前面做过的所有事摘要。', summaryMessageId: 'msg-c6' }])
  assert.equal(s.messages.length, 6) // 全量消息（摘要消息带 isSummary 标记，由转换器跳过）
  assert.equal(s.messages[0].id, 'msg-c1')
  assert.equal(s.messages[5].isSummary, true)

  const [full] = readOpencodeDb(dbPath, { fullHistory: true })
  assert.equal(full.summary, undefined)
  assert.equal(full.compactions, undefined)
  assert.equal(full.messages.length, 6) // 全量
})

test('import_opencode：压缩落原生检查点（日志全量、模型见摘要+保留窗口）', async () => {
  const dbPath = makeOpencodeDb([opencodeCompactedSession()])
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'opencode')
  const value = await def.execute({ path: dbPath })
  assert.equal(value.imported, 1)
  // multi 源的报告在 results 条目上（顶层只聚合计数）
  assert.equal(value.results[0].compacted, true)
  assert.equal(value.results[0].compactions, 1)
  const saved = persistence.sessions.get('import-ses-comp')
  assert.ok(saved)
  // 全量日志：压缩前的问答与摘要消息都在事件里（后者只在 surface 检查点里可见）
  assert.equal(saved.events.filter((e) => e.type === 'compaction/summary').length, 1)
  const ck = saved.events.find((e) => e.type === 'user/message' && typeof e.surfaceOp === 'object')
  assert.equal(ck.data.source.plugin, 'compact')
  assert.equal(ck.data.content[0].text, '前面做过的所有事摘要。')

  // fullHistory：不发检查点（模型看到全量）
  const { ctx: ctx2, persistence: p2 } = makeCtx({})
  apply(ctx2)
  const def2 = chatDef(ctx2, 'opencode')
  const v2 = await def2.execute({ path: dbPath, fullHistory: true })
  assert.equal(v2.results[0].compacted, undefined)
  assert.equal(v2.results[0].compactions, undefined)
  const saved2 = p2.sessions.get('import-ses-comp')
  assert.equal(saved2.events.some((e) => e.type.startsWith('compaction/')), false)
  assert.equal(saved2.events.filter((e) => e.type === 'user/message' && e.data.source.kind === 'user').length, 2) // c1 + c3（c5 无正文被跳过）
  assert.equal(saved2.events.filter((e) => e.type === 'assistant/message').length, 3) // c2 + c4 + c6
})

test('import_opencode 读不到 DB：失败大声抛错', async () => {
  const { ctx } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'opencode')
  await assert.rejects(() => def.execute({ path: join(tmpdir(), 'no-such-opencode.db') }))
})

test('import_grokbuild 单会话目录：双文件转换、落盘、归组、schema 校验', async () => {
  const dir = 'D:\\demo\\grok\\sessions\\proj-a\\grok-sess-001'
  const tree = {
    [dir]: 'dir',
    [dir + '\\summary.json']: JSON.stringify({
      info: { id: 'grok-sess-001', cwd: hostAbs('D:/demo/grok-proj') },
      generated_title: 'Grok 会话标题',
      created_at: '2026-07-16T12:00:00Z',
    }),
    [dir + '\\chat_history.jsonl']: grokChat(1),
  }
  const { ctx, persistence, attached } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'grokbuild')
  const value = await def.execute({ path: dir })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-grok-sess-001')
  assert.equal(value.turns, 1)
  assert.equal(value.messages, 2)
  assert.equal(value.toolCalls, 0)
  assert.equal(value.alreadyImported, false)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get('import-grok-sess-001')
  assert.ok(saved)
  assert.equal(saved.meta.cwd, hostAbs('D:/demo/grok-proj'))
  assert.equal(saved.meta.sourceId, undefined)
  // 宿主 header 白名单不含 sourceId（写入路径按 released-v2 schema 严格校验，
  // 白名单外字段会让整次创建被拒）：源 id 只服务 registry 与导出协议，不落 header
  // 显式标题（generated_title）钉 session/title 事件
  assert.equal(saved.events.at(-1).type, 'session/title')
  assert.equal(saved.events.at(-1).data.title, 'Grok · Grok 会话标题')
  assert.ok(saved.events.every((e, i) => e.seq === i))
  // 幂等键 = 会话目录路径
  assertEnvelopeHygiene(saved.events)
  assert.equal(attached.length, 1)
  assert.equal(attached[0].id, 'import-grok-sess-001')
})

test('import_grokbuild 目录批量：递归扫 summary.json、逐会话独立落盘', async () => {
  const root = 'D:\\demo\\grok\\sessions'
  const mkSession = (dir, id) => ({
    [dir]: 'dir',
    [dir + '\\summary.json']: JSON.stringify({ info: { id }, created_at: '2026-07-16T12:00:00Z' }),
    [dir + '\\chat_history.jsonl']: grokChat(1),
  })
  const tree = {
    [root]: 'dir',
    [root + '\\proj-a']: 'dir',
    ...mkSession(root + '\\proj-a\\grok-sess-001', 'grok-sess-001'),
    [root + '\\archived_sessions']: 'dir',
    ...mkSession(root + '\\archived_sessions\\grok-sess-002', 'grok-sess-002'),
    [root + '\\notes.txt']: 'not a session',
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'grokbuild')
  const value = await def.execute({ path: root })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  const ids = [...persistence.sessions.keys()].sort()
  assert.deepEqual(ids, ['import-grok-sess-001', 'import-grok-sess-002'])
})

test('import_grokbuild 增量续写：chat_history 增长 → appended 同一会话（REQ-24）', async () => {
  const dir = 'D:\\demo\\grok\\sessions\\p\\grok-sess-incr'
  const summary = JSON.stringify({ info: { id: 'grok-sess-incr', cwd: hostAbs('D:/demo/grok-proj') }, created_at: '2026-07-16T12:00:00Z' })
  const tree = { [dir]: 'dir', [dir + '\\summary.json']: summary, [dir + '\\chat_history.jsonl']: grokChat(2) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'grokbuild')
  const first = await def.execute({ path: dir })
  assert.equal(first.status, 'imported')
  const before = persistence.sessions.get('import-grok-sess-incr').events.length

  tree[dir + '\\chat_history.jsonl'] = grokChat(3)
  const second = await def.execute({ path: dir })
  assert.equal(second.mode, 'single')
  assert.equal(second.status, 'appended')
  assert.equal(second.appendedTurns, 1)
  assert.ok(second.appendedEvents > 0)
  assert.equal(persistence.sessions.size, 1) // 同一会话续写
  const saved = persistence.sessions.get('import-grok-sess-incr')
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assert.equal(saved.events.length, before + second.appendedEvents)
  assert.equal(saved.events.filter((e) => e.type === 'turn/start').length, 3)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, second), [])
})

test('import_hermes SQLite：state.db 恒批量、逐会话落盘、归组、schema 校验', async () => {
  const dbPath = makeHermesTestDb()
  const { ctx, persistence, attached } = makeCtx({}) // stat 回退 node:fs（真实 db 文件）
  apply(ctx)
  const def = chatDef(ctx, 'hermes')
  const value = await def.execute({ path: dbPath })

  assert.equal(value.mode, 'batch') // 单 .db 也恒批量
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.equal(value.alreadyImported, 0)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const savedA = persistence.sessions.get('import-hm-a')
  assert.ok(savedA)
  assert.equal(savedA.meta.cwd, hostAbs('E:/demo/hermes'))
  assert.equal(savedA.events.at(-1).type, 'session/title')
  assert.equal(savedA.events.at(-1).data.title, 'Hermes · Fix hermes build')
  assert.ok(savedA.events.every((e, i) => e.seq === i))
  assertEnvelopeHygiene(savedA.events)
  const ids = [...persistence.sessions.keys()].sort()
  assert.deepEqual(ids, ['import-hm-a', 'import-hm-b'])
  assert.equal(attached.length, 2) // 两个会话都有 cwd → 归组
})

test('import_hermes db 增量续写：库增长 → 逐会话 append（REQ-24）', async () => {
  const dbPath = makeHermesTestDb()
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'hermes')
  const first = await def.execute({ path: dbPath })
  assert.equal(first.imported, 2)
  const before = persistence.sessions.get('import-hm-a').events.length

  addHermesTurn(dbPath, 'hm-a', '继续追问', '追加回答', 1786000000100)
  const second = await def.execute({ path: dbPath })
  assert.equal(second.mode, 'batch')
  assert.equal(second.appended, 1)
  assert.equal(second.alreadyImported, 1) // hm-b 未变
  const appended = second.results.find((r) => r.status === 'appended')
  assert.ok(appended)
  assert.equal(appended.sessionId, 'import-hm-a')
  const sesA = persistence.sessions.get('import-hm-a')
  assert.ok(sesA.events.every((e, i) => e.seq === i))
  assert.equal(sesA.events.length, before + appended.appendedEvents)
  assert.equal(sesA.events.filter((e) => e.type === 'turn/start').length, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, second), [])
})

test('import_hermes JSONL 回退：目录无可用 state.db → 递归扫 .jsonl 批量', async () => {
  const tree = {
    'D:\\demo\\hermes\\sessions': 'dir',
    'D:\\demo\\hermes\\sessions\\s1.jsonl': JSON.stringify({ role: 'user', content: '什么是 Rust？', ts: 1700000000 }) + '\n' + JSON.stringify({ role: 'assistant', content: '一种系统编程语言。', ts: 1700000001 }) + '\n',
    'D:\\demo\\hermes\\sessions\\s2.jsonl': '{"type":"session","id":"s2","title":"My Session","cwd":"/home/u/proj"}\n{"type":"message","message":{"role":"user","content":"Hello"},"timestamp":"2026-01-01T00:00:00Z"}\n{"type":"message","message":{"role":"assistant","content":"Hi"},"timestamp":"2026-01-01T00:01:00Z"}\n',
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'hermes')
  const value = await def.execute({ path: 'D:\\demo\\hermes\\sessions' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  assert.equal(persistence.sessions.size, 2)
  // 无 session 记录的 flat JSONL → 文件 stem 兜底会话 id
  assert.ok(persistence.sessions.get('import-s1'))
  assert.ok(persistence.sessions.get('import-s2'))
})

test('import_hermes 单 .jsonl：db 之外的单会话源，mode single', async () => {
  const raw = JSON.stringify({ role: 'user', content: 'hi', ts: 1 }) + '\n' + JSON.stringify({ role: 'assistant', content: 'hello', ts: 2 }) + '\n'
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\hermes\\sessions\\s1.jsonl': raw })
  apply(ctx)
  const def = chatDef(ctx, 'hermes')
  const value = await def.execute({ path: 'D:\\demo\\hermes\\sessions\\s1.jsonl' })
  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-s1') // fileStem 兜底
  assert.equal(value.status, 'imported')
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  assert.equal(persistence.sessions.size, 1)
})
