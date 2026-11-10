// opencowork.test.mjs — openCoWork / NextCoWork 双 schema：纯转换、真实 SQLite、发现与工具集成。
// fixtures 全部按公开上游 DDL 合成，不声称使用或验证过真实用户会话。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { convertOpencoworkJson, opencoworkDefaultDbPaths } from '../lib/convert/opencowork.mjs'
import { readOpencoworkSessions, readOpencoworkDb } from '../lib/sources/opencowork.mjs'
import { discoverSessions, clearScanCache, clearInflightScans, defaultRoots } from '../lib/discovery.mjs'
import { fileFormatsForPath } from '../lib/discovery/registry.mjs'
import { apply } from '../lib/index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { memoryHost, FAKE_HOME as HOME } from './_support/discovery-host.mjs'
import { withTempDir, withTempDirAsync, writeSqliteFixture, insertRows, freshDshHome } from './_support/tmp-db.mjs'
import { assertToolPairing } from './_support/session-invariants.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { hostAbs } from './_support/host-path.mjs'

const CREATED = 1768000000000
const UPDATED = 1768000123000
const LEGACY_ID = 'legacy-1'
const NEXT_ID = 'next-1'
// cwd 必须是**宿主平台**的绝对路径：写死 `D:/…` 在 Linux CI 会被 prepareHostMeta 剔除，
// 断言拿到 undefined（本地 Windows 永远绿）。hostAbs 在两端给出本平台等价路径。
const LEGACY_CWD = hostAbs('D:/work/legacy-project')
const NEXT_CWD = '/home/u/next-project'

const LEGACY_CREATE = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, working_folder TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'chat',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, message_count INTEGER NOT NULL DEFAULT 0,
  working_folder TEXT, project_id TEXT, model_id TEXT);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
  meta TEXT, created_at INTEGER NOT NULL, usage TEXT, sort_order INTEGER NOT NULL);`

const NEXT_CREATE = `
CREATE TABLE workspaces (id TEXT PRIMARY KEY, last_opened_at INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL, model TEXT NOT NULL,
  mode TEXT NOT NULL, thinking TEXT NOT NULL, root_path_at_creation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle', archived INTEGER NOT NULL DEFAULT 0,
  favorited INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  json TEXT NOT NULL, parent_session_id TEXT);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, ordinal INTEGER NOT NULL, role TEXT NOT NULL,
  parts TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
  run_id TEXT, internal INTEGER NOT NULL DEFAULT 0, UNIQUE(session_id, ordinal));`

function legacyRows() {
  const blocks = (value) => JSON.stringify(value)
  return {
    projects: [{ id: 'p1', name: 'Legacy project', working_folder: LEGACY_CWD, created_at: CREATED, updated_at: UPDATED }],
    sessions: [{
      id: LEGACY_ID, title: 'Legacy title', mode: 'chat', created_at: CREATED, updated_at: UPDATED,
      message_count: 7, working_folder: null, project_id: 'p1', model_id: 'legacy-model',
    }],
    messages: [
      { id: 'm7', session_id: LEGACY_ID, role: 'user', content: blocks([{ type: 'tool_result', toolUseId: 'missing', content: 'orphan' }]), created_at: CREATED + 7, sort_order: 6 },
      { id: 'm4', session_id: LEGACY_ID, role: 'assistant', content: blocks([{ type: 'text', text: 'Legacy done' }]), created_at: CREATED + 4, sort_order: 3 },
      { id: 'm1', session_id: LEGACY_ID, role: 'user', content: blocks('inspect legacy project'), created_at: CREATED + 1, sort_order: 0 },
      { id: 'm6', session_id: LEGACY_ID, role: 'assistant', content: blocks([{ type: 'text', text: 'plain answer' }, { type: 'future_block', value: 1 }]), created_at: CREATED + 6, sort_order: 5 },
      { id: 'm2', session_id: LEGACY_ID, role: 'assistant', content: blocks([
        { type: 'thinking', thinking: 'Need to inspect' },
        { type: 'tool_use', id: 'call-1', name: 'Read', input: { path: 'a.ts' } },
      ]), created_at: CREATED + 2, sort_order: 1 },
      { id: 'm5', session_id: LEGACY_ID, role: 'user', content: 'plain follow-up', created_at: CREATED + 5, sort_order: 4 },
      { id: 'm3', session_id: LEGACY_ID, role: 'tool', content: blocks([
        { type: 'tool_result', toolUseId: 'call-1', content: [{ type: 'text', text: 'file body' }], isError: false },
      ]), created_at: CREATED + 3, sort_order: 2 },
    ],
  }
}

function nextRows() {
  const parts = (value) => JSON.stringify(value)
  const session = (id, parent = null) => ({
    id, workspace_id: 'w1', title: id === NEXT_ID ? 'Next title' : 'Other', model: 'next-model', mode: 'code',
    thinking: 'auto', root_path_at_creation: NEXT_CWD, status: 'idle', archived: 0, favorited: 0,
    created_at: CREATED, updated_at: UPDATED, json: '{}', parent_session_id: parent,
  })
  return {
    workspaces: [{ id: 'w1', last_opened_at: UPDATED, json: '{}' }],
    sessions: [session(NEXT_ID), session('next-child', NEXT_ID)],
    messages: [
      { id: 'n7', session_id: NEXT_ID, ordinal: 6, role: 'assistant', parts: '{"type":"text"}', schema_version: 1, created_at: CREATED + 7 },
      { id: 'n2', session_id: NEXT_ID, ordinal: 1, role: 'assistant', parts: parts([
        { type: 'thinking', text: 'Need to run' },
        { type: 'tool_call', callId: 'next-call', name: 'bash', input: { command: 'pwd' } },
      ]), schema_version: 1, created_at: CREATED + 2 },
      { id: 'n5', session_id: NEXT_ID, ordinal: 4, role: 'user', parts: parts([
        { type: 'tool_result', callId: 'missing-next', output: { content: 'orphan next' }, isError: true },
      ]), schema_version: 1, created_at: CREATED + 5 },
      { id: 'n1', session_id: NEXT_ID, ordinal: 0, role: 'user', parts: parts([{ type: 'text', text: 'run next' }]), schema_version: 1, created_at: CREATED + 1 },
      { id: 'n6', session_id: NEXT_ID, ordinal: 5, role: 'assistant', parts: '{bad', schema_version: 1, created_at: CREATED + 6 },
      { id: 'n3', session_id: NEXT_ID, ordinal: 2, role: 'user', parts: parts([
        { type: 'tool_result', callId: 'next-call', output: { content: NEXT_CWD, images: [{ mime: 'image/png', dataRef: 'ncw://attachment/1' }] }, isError: false },
      ]), schema_version: 1, created_at: CREATED + 3 },
      { id: 'n4', session_id: NEXT_ID, ordinal: 3, role: 'assistant', parts: parts([{ type: 'text', text: 'Next done' }]), schema_version: 1, created_at: CREATED + 4 },
    ],
  }
}

function makeLegacyDb(path, options = {}) {
  return writeSqliteFixture(path, { create: LEGACY_CREATE, rows: legacyRows(), ...options })
}

function makeNextDb(path, options = {}) {
  return writeSqliteFixture(path, { create: NEXT_CREATE, rows: nextRows(), ...options })
}

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-opencowork-home-')
  clearScanCache()
  clearInflightScans()
})

test('legacy 真实库：项目 cwd 回退、content 三形态、thinking/工具配对、孤儿与未知块计数', () => {
  withTempDir('opencowork-legacy-', (root) => {
    const dbPath = makeLegacyDb(join(root, '.open-cowork', 'data.db'))
    const [summary] = readOpencoworkSessions(dbPath)
    assert.equal(summary.layout, 'legacy')
    assert.equal(summary.cwd, LEGACY_CWD)
    assert.equal(summary.createdAt, CREATED)
    assert.equal(summary.lastActiveAt, UPDATED)

    const [session] = readOpencoworkDb(dbPath)
    assert.deepEqual(session.messages.map((m) => m.id), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'])
    assert.equal(session.messages[0].blocks[0].text, 'inspect legacy project')
    assert.equal(session.messages[4].blocks[0].text, 'plain follow-up')

    const out = convertOpencoworkJson(JSON.stringify(session))
    assert.equal(out.meta.id, 'import-legacy-' + LEGACY_ID)
    assert.equal(out.meta.sourceId, 'legacy-' + LEGACY_ID)
    assert.equal(out.meta.cwd, LEGACY_CWD)
    assert.equal(out.meta.createdAt, CREATED)
    assert.equal(out.title, 'Legacy title')
    assert.equal(out.turns.length, 2)
    assert.equal(out.turns[0].prompt, 'inspect legacy project')
    assert.equal(out.turns[1].prompt, 'plain follow-up')
    assert.deepEqual(out.turns[0].steps[0].content[0], { type: 'reasoning', text: 'Need to inspect' })
    assert.deepEqual(out.turns[0].steps[0].toolResults[0].content, [{ type: 'text', text: 'file body' }])
    assert.equal(out.unknownEvents, 1)
    assert.equal(out.orphanResults, 1)
    assertToolPairing(out.events)
  })
})

test('next 真实库：过滤子会话、parts/ordinal、结果型 user 不开轮、畸形 parts 大声计数', () => {
  withTempDir('opencowork-next-', (root) => {
    const dbPath = makeNextDb(join(root, '.next-cowork', 'data', 'nextcowork.db'))
    const summaries = readOpencoworkSessions(dbPath)
    assert.deepEqual(summaries.map((s) => s.id), [NEXT_ID])
    assert.equal(summaries[0].layout, 'next')
    assert.equal(summaries[0].cwd, NEXT_CWD)

    const [session] = readOpencoworkDb(dbPath)
    assert.deepEqual(session.messages.map((m) => m.id), ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'])
    assert.equal(session.messages[5].invalidBlocks, 1)
    assert.equal(session.messages[6].invalidBlocks, 1)

    const out = convertOpencoworkJson(JSON.stringify(session))
    assert.equal(out.meta.id, 'import-next-' + NEXT_ID)
    assert.equal(out.meta.cwd, NEXT_CWD)
    assert.equal(out.title, 'Next title')
    assert.equal(out.turns.length, 1)
    assert.equal(out.turns[0].steps.length, 2)
    assert.equal(out.turns[0].steps[0].toolCalls[0].name, 'bash')
    assert.deepEqual(out.turns[0].steps[0].toolResults[0].content, [{ type: 'text', text: NEXT_CWD }])
    assert.equal(out.unknownEvents, 2)
    assert.equal(out.orphanResults, 1)
    assert.equal(out.imagesDegraded, 1)
    assertToolPairing(out.events)

    const child = convertOpencoworkJson(JSON.stringify({ ...session, id: 'next-child', parentSessionId: NEXT_ID }))
    assert.equal(child.meta, null)
    assert.match(child.skipReason, /sub-agent/)
  })
})

test('库签名：只有泛化 sessions/messages 不会误认；缺文件返回 null', () => {
  withTempDir('opencowork-signature-', (root) => {
    const other = writeSqliteFixture(join(root, 'other.db'), {
      create: 'CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT); CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT);',
    })
    assert.equal(readOpencoworkSessions(other), null)
    assert.equal(readOpencoworkDb(other), null)
    assert.equal(readOpencoworkSessions(join(root, 'missing.db')), null)
  })
})

test('默认路径与发现：双 roots、独占已知路径、NextCoWork 根目录扫描', async () => {
  assert.deepEqual(opencoworkDefaultDbPaths('/h/u', 'linux'), ['/h/u/.open-cowork/data.db', '/h/u/.next-cowork/data/nextcowork.db'])
  assert.deepEqual(defaultRoots({ home: HOME, env: {} }).opencowork, opencoworkDefaultDbPaths(HOME))
  const legacyPath = join(HOME, '.open-cowork', 'data.db')
  const nextRoot = join(HOME, '.next-cowork')
  const nextPath = join(nextRoot, 'data', 'nextcowork.db')
  assert.deepEqual(fileFormatsForPath(legacyPath), ['opencowork'])
  assert.deepEqual(fileFormatsForPath(nextPath), ['opencowork'])

  const files = new Map([
    [legacyPath, { type: 'file', text: 'SQLite format 3', mtimeMs: CREATED }],
    [nextRoot, { type: 'dir' }],
    [join(nextRoot, 'data'), { type: 'dir' }],
    [nextPath, { type: 'file', text: 'SQLite format 3', mtimeMs: CREATED }],
  ])
  const host = memoryHost(files)
  host.dbSessions = (kind, path) => {
    assert.equal(kind, 'opencowork')
    if (path === legacyPath) return [{ id: LEGACY_ID, title: 'Legacy title', directory: LEGACY_CWD, createdAt: CREATED, lastActiveAt: UPDATED }]
    if (path === nextPath) return [{ id: NEXT_ID, title: 'Next title', directory: NEXT_CWD, createdAt: CREATED, lastActiveAt: UPDATED }]
    return null
  }
  const legacy = await discoverSessions({ path: legacyPath, host, imports: {} })
  assert.deepEqual(legacy.sessions.map((s) => [s.format, s.sessionId]), [['opencowork', LEGACY_ID]])
  const next = await discoverSessions({ path: nextRoot, format: 'opencowork', host, imports: {} })
  assert.equal(next.total, 1)
  assert.equal(next.sessions[0].sessionId, NEXT_ID)
  assert.equal(next.sessions[0].sourcePath, nextPath)
  assert.equal(next.sessions[0].project, 'next-project')
})

test('import_chat legacy：批量落盘、标题/cwd/工具配对、输出 schema 与幂等', async () => {
  await withTempDirAsync('opencowork-import-legacy-', async (root) => {
    const dbPath = makeLegacyDb(join(root, '.open-cowork', 'data.db'))
    const { ctx, persistence, attached } = makeCtx({})
    apply(ctx)
    const def = chatDef(ctx, 'opencowork')
    const first = await def.execute({ path: dbPath })
    assert.equal(first.mode, 'batch')
    assert.equal(first.total, 1)
    assert.equal(first.imported, 1)
    assert.equal(first.failed, 0)
    assert.equal(first.results[0].unknownEvents, 1)
    assert.equal(first.results[0].orphanResults, 1)
    assert.deepEqual(validateJsonSchemaValue(def.output.schema, first), [])

    const saved = persistence.sessions.get('import-legacy-' + LEGACY_ID)
    assert.ok(saved)
    assert.equal(saved.meta.cwd, LEGACY_CWD)
    assert.equal(saved.meta.createdAt, CREATED)
    assert.match(saved.events.at(-1).data.title, /^openCoWork · Legacy title/)
    assertToolPairing(saved.events)
    assertEnvelopeHygiene(saved.events)
    assert.equal(attached.length, 1)

    const second = await def.execute({ path: dbPath })
    assert.equal(second.imported, 0)
    assert.equal(second.alreadyImported, 1)
    assert.equal(persistence.sessions.size, 1)
  })
})

test('import_chat next：目录/sessionIds、WAL 新会话增量、dry-run 零副作用', async () => {
  await withTempDirAsync('opencowork-import-next-', async (root) => {
    const nextRoot = join(root, '.next-cowork')
    const dbPath = join(nextRoot, 'data', 'nextcowork.db')
    const db = makeNextDb(dbPath, { keepOpen: true, statements: ['PRAGMA journal_mode = WAL'] })
    try {
      const { ctx, persistence } = makeCtx({})
      apply(ctx)
      const def = chatDef(ctx, 'opencowork')
      const first = await def.execute({ path: nextRoot, sessionIds: [NEXT_ID] })
      assert.equal(first.mode, 'batch')
      assert.equal(first.total, 1)
      assert.equal(first.imported, 1)
      assert.equal(persistence.sessions.has('import-next-' + NEXT_ID), true)
      assert.equal(persistence.sessions.has('import-next-next-child'), false)
      assert.equal(first.results[0].unknownEvents, 2)
      assert.equal(first.results[0].orphanResults, 1)
      assert.deepEqual(validateJsonSchemaValue(def.output.schema, first), [])

      const unchanged = await def.execute({ path: dbPath, sessionIds: [NEXT_ID] })
      assert.equal(unchanged.alreadyImported, 1)
      assert.equal(persistence.sessions.size, 1)

      const secondId = 'next-2'
      const mainSizeBefore = statSync(dbPath).size
      insertRows(db, 'sessions', [{
        id: secondId, workspace_id: 'w1', title: 'WAL session', model: 'next-model', mode: 'code', thinking: 'auto',
        root_path_at_creation: NEXT_CWD, status: 'idle', archived: 0, favorited: 0,
        created_at: CREATED + 100, updated_at: UPDATED + 100, json: '{}', parent_session_id: null,
      }])
      insertRows(db, 'messages', [{
        id: 'wal-1', session_id: secondId, ordinal: 0, role: 'user',
        parts: JSON.stringify([{ type: 'text', text: 'written only to WAL' }]), schema_version: 1, created_at: CREATED + 101,
      }])
      assert.equal(statSync(dbPath).size, mainSizeBefore)
      assert.ok(existsSync(dbPath + '-wal'))

      const grown = await def.execute({ path: dbPath })
      assert.equal(grown.total, 2)
      assert.equal(grown.imported, 1)
      assert.equal(persistence.sessions.has('import-next-' + secondId), true)

      const before = persistence.sessions.size
      const preview = await def.execute({ path: nextRoot, preview: true })
      assert.equal(preview.preview, true)
      assert.equal(preview.total, 2)
      assert.equal(preview.results.length, 2)
      assert.ok(preview.results.every((r) => String(r.title).startsWith('openCoWork · ')))
      assert.equal(persistence.sessions.size, before)
    } finally {
      db.close()
    }
  })
})
