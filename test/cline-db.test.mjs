// cline-db.test.mjs — Cline 索引（sessions.db）与导入参数派生单测：
// 造真实 SQLite 夹具（node:sqlite），覆盖读写口径、子代理过滤、老库缺列、回退路径。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readClineDb, clineMessagesPath, clineDeriveArgs, collectClineFiles } from '../lib/sources/cline.mjs'
import { makeFs } from './_support/fake-host.mjs'

// 上游 sqlite-db.ts 的建表 SQL（main @ 6e8bea1）；老库靠 ALTER TABLE 逐列补齐，
// 故测试另造一个「缺列」的库验证自适应读取。
const CREATE_SESSIONS = `CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY, source TEXT, pid INTEGER, started_at TEXT, ended_at TEXT,
  exit_code INTEGER, status TEXT, status_lock INTEGER, interactive INTEGER, provider TEXT,
  model TEXT, cwd TEXT, workspace_root TEXT, team_name TEXT, enable_tools INTEGER,
  enable_spawn INTEGER, enable_teams INTEGER, parent_session_id TEXT, parent_agent_id TEXT,
  agent_id TEXT, conversation_id TEXT, is_subagent INTEGER, prompt TEXT, metadata_json TEXT,
  transcript_path TEXT, hook_path TEXT, messages_path TEXT, updated_at TEXT)`

const SID = '01J8Z6Q0M4V7X2K9TB3N5R8WDA'
const TS = '2026-04-22T17:40:00.000Z'
const TS_END = '2026-04-22T17:42:10.123Z'

function withTmp(fn) {
  const root = mkdtempSync(join(tmpdir(), 'cline-test-'))
  try {
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function makeDb(dbPath, { create = CREATE_SESSIONS, rows = [], extraTables = true } = {}) {
  mkdirSync(join(dbPath, '..'), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(create)
  if (extraTables) {
    db.exec('CREATE TABLE subagent_spawn_queue (id TEXT PRIMARY KEY)')
    db.exec('CREATE TABLE schedules (id TEXT PRIMARY KEY)')
  }
  for (const row of rows) {
    const cols = Object.keys(row)
    db.prepare(`INSERT INTO sessions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
      ...cols.map((c) => row[c]),
    )
  }
  db.close()
}

function leadRow(over = {}) {
  return {
    session_id: SID,
    source: 'cli',
    started_at: TS,
    status: 'ended',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    cwd: '/home/u/repo',
    workspace_root: '/home/u/repo',
    is_subagent: 0,
    prompt: '修一下登录页分页',
    metadata_json: JSON.stringify({ title: '修登录页分页' }),
    updated_at: TS_END,
    ...over,
  }
}

test('readClineDb：映射元数据列，子代理行被滤掉', () => {
  withTmp((root) => {
    const dbPath = join(root, 'data', 'db', 'sessions.db')
    makeDb(dbPath, {
      rows: [
        leadRow(),
        // 子代理（is_subagent=1）与带 parent/agent 的行都不单独成会话
        leadRow({ session_id: 'sub-1', is_subagent: 1, agent_id: 'explore-1' }),
        leadRow({ session_id: 'sub-2', parent_session_id: SID }),
        leadRow({ session_id: 'sub-3', agent_id: 'review-2' }),
        leadRow({
          session_id: 'other', cwd: null, workspace_root: 'D:/work/proj',
          metadata_json: '{bad json', prompt: '别的会话', started_at: null, updated_at: null,
        }),
      ],
    })
    const rows = readClineDb(dbPath)
    assert.equal(rows.length, 2)
    const byId = new Map(rows.map((r) => [r.id, r]))
    const lead = byId.get(SID)
    assert.equal(lead.title, '修登录页分页')
    assert.equal(lead.cwd, '/home/u/repo')
    assert.equal(lead.createdAt, Date.parse(TS))
    assert.equal(lead.lastActiveAt, Date.parse(TS_END))
    assert.equal(lead.model, 'claude-sonnet-4-6')
    assert.equal(lead.messagesPath, clineMessagesPath(join(root, 'data', 'sessions'), SID))

    const other = byId.get('other')
    assert.equal(other.cwd, 'D:/work/proj') // cwd 空 → workspace_root 回退
    assert.equal(other.title, '') // metadata_json 畸形只丢标题
    assert.equal(other.createdAt, null)
    assert.equal(other.lastActiveAt, null)
  })
})

test('readClineDb：messages_path 仅在绝对路径时采用；相对路径回退规范路径', () => {
  withTmp((root) => {
    const dbPath = join(root, 'data', 'db', 'sessions.db')
    const abs = join(root, 'elsewhere', 'x.messages.json')
    makeDb(dbPath, {
      rows: [
        leadRow({ messages_path: abs }),
        leadRow({ session_id: 'rel', messages_path: 'sessions/rel/rel.messages.json' }),
      ],
    })
    const rows = readClineDb(dbPath)
    const byId = new Map(rows.map((r) => [r.id, r]))
    assert.equal(byId.get(SID).messagesPath, abs)
    assert.equal(byId.get('rel').messagesPath, clineMessagesPath(join(root, 'data', 'sessions'), 'rel'))
  })
})

test('readClineDb：老库缺列（无 metadata_json / messages_path / is_subagent）仍可读', () => {
  withTmp((root) => {
    const dbPath = join(root, 'data', 'db', 'sessions.db')
    makeDb(dbPath, {
      create: 'CREATE TABLE sessions (session_id TEXT PRIMARY KEY, cwd TEXT, started_at TEXT, updated_at TEXT)',
      extraTables: false,
      rows: [{ session_id: SID, cwd: '/home/u/repo', started_at: TS, updated_at: TS_END }],
    })
    const rows = readClineDb(dbPath)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].title, '')
    assert.equal(rows[0].cwd, '/home/u/repo')
    assert.equal(rows[0].messagesPath, clineMessagesPath(join(root, 'data', 'sessions'), SID))
  })
})

test('readClineDb：缺失文件 / 非 Cline 库 → null（发现层据此回退扫目录）', () => {
  withTmp((root) => {
    assert.equal(readClineDb(join(root, 'nope.db')), null)
    const other = join(root, 'other.db')
    makeDb(other, { create: 'CREATE TABLE unrelated (id TEXT PRIMARY KEY)', extraTables: false })
    assert.equal(readClineDb(other), null)
  })
})

// clineDeriveArgs 用的最小 ctx：只有内存树 fs（与真实 fs 契约同形，不回退磁盘）。
const fakeCtx = (files) => ({ fs: makeFs(files, { real: false }) })

test('clineDeriveArgs：DB 优先给 cwd/创建时间/标题', async () => {
  await withTmpAsync(async (root) => {
    const dbPath = join(root, 'data', 'db', 'sessions.db')
    makeDb(dbPath, { rows: [leadRow()] })
    const messagesPath = clineMessagesPath(join(root, 'data', 'sessions'), SID)
    const derived = await clineDeriveArgs(fakeCtx({}), { displayPath: messagesPath })
    assert.deepEqual(derived, {
      clineId: SID,
      cwd: '/home/u/repo',
      createdAt: Date.parse(TS),
      title: '修登录页分页',
    })
  })
})

test('clineDeriveArgs：DB 不可用时回退 manifest（metadata.title 权威 / cwd / started_at）', async () => {
  await withTmpAsync(async (root) => {
    const dir = join(root, 'data', 'sessions', SID)
    const messagesPath = clineMessagesPath(join(root, 'data', 'sessions'), SID)
    const manifestPath = join(dir, SID + '.json')
    const ctx = fakeCtx({
      [manifestPath]: JSON.stringify({
        version: 1, session_id: SID, started_at: TS, cwd: '/home/u/repo',
        workspace_root: '/home/u/repo', metadata: { title: '来自 manifest 的标题' },
      }),
    })
    const derived = await clineDeriveArgs(ctx, { displayPath: messagesPath })
    assert.deepEqual(derived, {
      clineId: SID,
      cwd: '/home/u/repo',
      createdAt: Date.parse(TS),
      title: '来自 manifest 的标题',
    })
  })
})

test('clineDeriveArgs：DB 与 manifest 都缺 → 只带 id（标题由转换器按首问兜底）', async () => {
  await withTmpAsync(async (root) => {
    const messagesPath = clineMessagesPath(join(root, 'data', 'sessions'), SID)
    const derived = await clineDeriveArgs(fakeCtx({}), { displayPath: messagesPath })
    assert.deepEqual(derived, { clineId: SID })
  })
})

test('clineDeriveArgs：legacy api history 从 taskHistory.json 派生任务元数据', async () => {
  await withTmpAsync(async (root) => {
    const taskId = 'legacy-001'
    const globalStorage = join(root, 'globalStorage')
    const apiPath = join(globalStorage, 'tasks', taskId, 'api_conversation_history.json')
    const historyPath = join(globalStorage, 'state', 'taskHistory.json')
    const ctx = fakeCtx({
      [historyPath]: JSON.stringify([{
        id: taskId, ts: 1786000000000, task: '旧任务', cwdOnTaskInitialization: 'D:\\repo',
        modelId: 'claude-sonnet', conversationHistoryDeletedRange: [2, 4],
      }]),
    })
    const derived = await clineDeriveArgs(ctx, { displayPath: apiPath })
    assert.deepEqual(derived, {
      legacyTask: true, clineId: taskId, title: '旧任务', cwd: 'D:\\repo',
      createdAt: 1786000000000, modelId: 'claude-sonnet', legacyDeletedRange: [2, 4],
    })
  })
})

test('collectClineFiles：收现代 messages 与 legacy api history，排除 manifest / compaction，递归子目录', async () => {
  const sessionsDir = join('home', 'u', '.cline', 'data', 'sessions')
  const sessionDir = join(sessionsDir, SID)
  const nested = join(sessionDir, 'nested-session')
  const entriesByDir = {
    [sessionDir]: [
      { name: SID + '.messages.json', type: 'file', target: join(sessionDir, SID + '.messages.json') },
      { name: SID + '.json', type: 'file', target: join(sessionDir, SID + '.json') },
      { name: SID + '.compaction.json', type: 'file', target: join(sessionDir, SID + '.compaction.json') },
      { name: 'api_conversation_history.json', type: 'file', target: join(sessionsDir, 'tasks', 'legacy-001', 'api_conversation_history.json') },
      { name: 'explore-1.messages.json', type: 'file', target: join(sessionDir, 'explore-1.messages.json') },
      { name: 'nested-session', type: 'directory', target: nested },
    ],
    [nested]: [
      { name: 'n1.messages.json', type: 'file', target: join(nested, 'n1.messages.json') },
    ],
  }
  const ctx = { fs: { listDir: async (dir) => entriesByDir[dir] || [] } }
  const out = []
  await collectClineFiles(ctx, sessionDir, out, true)
  // 子代理消息文件（explore-1.messages.json）也会被收进来 —— 由转换器按 agent 字段
  // 判定为子代理会话后跳过（发现层用目录名过滤，见 discovery 的 scanCline）
  assert.deepEqual(out.sort(), [
    join(sessionsDir, 'tasks', 'legacy-001', 'api_conversation_history.json'),
    join(sessionDir, 'explore-1.messages.json'),
    join(sessionDir, SID + '.messages.json'),
    join(nested, 'n1.messages.json'),
  ].sort())

  // 非递归：只收当前层
  const shallow = []
  await collectClineFiles(ctx, sessionDir, shallow, false)
  assert.equal(shallow.some((p) => p.includes('nested-session')), false)
})

test('readClineManifest：畸形 JSON → null；缺字段 → 空标题 + null 工作目录', async () => {
  const { readClineManifest } = await import('../lib/convert/cline.mjs')
  assert.equal(readClineManifest('{not json'), null)
  assert.equal(readClineManifest(''), null)
  assert.equal(readClineManifest(null), null)
  assert.deepEqual(readClineManifest('{}'), { title: '', cwd: null, startedAt: null })
  assert.deepEqual(
    readClineManifest(JSON.stringify({ workspace_root: '/w', metadata: { title: 'T' } })),
    { title: 'T', cwd: '/w', startedAt: null },
  )
})

// withTmp 的异步版（derive 是 async）
async function withTmpAsync(fn) {
  const root = mkdtempSync(join(tmpdir(), 'cline-test-'))
  try {
    return await fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('clineMessagesPath：两种分隔符都不重复拼分隔符', () => {
  assert.equal(clineMessagesPath('/a/b', 'x'), '/a/b/x/x.messages.json')
  assert.equal(clineMessagesPath('/a/b/', 'x'), '/a/b/x/x.messages.json')
  assert.equal(clineMessagesPath('C:\\a\\b', 'x'), 'C:\\a\\b\\x\\x.messages.json')
})
