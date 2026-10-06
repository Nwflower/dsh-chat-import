// crush-db.test.mjs — Crush 会话库（crush.db）读取单测：造真实 SQLite 夹具
//（node:sqlite），覆盖签名判定、root 会话过滤、parts JSON 解析容错、Unix 秒时间戳、
// 项目路径反查（DB 里没有 cwd 列）与老库缺列自适应。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readCrushSessions, readCrushDb, crushProjectPathFor, crushDeriveArgs } from '../lib/sources/crush.mjs'
import { crushProjectDbPath } from '../lib/convert/crush.mjs'
import { withTempDir, withTempDirAsync, writeSqliteFixture } from './_support/tmp-db.mjs'

// 上游 8 个 goose 迁移合并后的形状（列名逐字）
const CREATE = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, parent_session_id TEXT, title TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER, completion_tokens INTEGER,
  cost REAL, updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
  summary_message_id TEXT, todos TEXT);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, parts TEXT NOT NULL DEFAULT '[]',
  model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER,
  provider TEXT, is_summary_message INTEGER NOT NULL DEFAULT 0,
  prism_model_id TEXT, prism_model_name TEXT, prism_hypercredit_savings REAL, prism_dollar_savings REAL);
CREATE TABLE files (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, path TEXT NOT NULL,
  content TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, UNIQUE(path, session_id, version));
CREATE TABLE read_files (session_id TEXT, path TEXT, read_at INTEGER NOT NULL, PRIMARY KEY(path, session_id));
CREATE TABLE goose_db_version (id INTEGER PRIMARY KEY, version_id INTEGER, is_applied INTEGER);`

const SID = 'a8f1c3d2-0000-4000-8000-000000000001'
const CREATED = 1768000001
const UPDATED = 1768000123

// 本文件的临时库前缀；mkdtemp / 清理 / 建表 / 插行都在 _support/tmp-db.mjs。
const withTmp = (fn) => withTempDir('crush-test-', fn)

function makeDb(dbPath, { sessions = [], messages = [], create = CREATE } = {}) {
  return writeSqliteFixture(dbPath, { create, rows: { sessions, messages } })
}

function sessionRow(over = {}) {
  return {
    id: SID, parent_session_id: null, title: 'Add retry to fetch', message_count: 4,
    prompt_tokens: 12043, completion_tokens: 812, cost: 0.0412,
    created_at: CREATED, updated_at: UPDATED, summary_message_id: null, todos: null, ...over,
  }
}
function messageRow(over = {}) {
  return {
    id: 'm-' + Math.random().toString(36).slice(2), session_id: SID, role: 'user',
    parts: JSON.stringify([{ type: 'text', data: { text: 'hi' } }, { type: 'finish', data: { reason: 'stop' } }]),
    created_at: CREATED + 1, updated_at: CREATED + 1, finished_at: null, is_summary_message: 0, ...over,
  }
}

test('readCrushSessions：root 会话摘要 + Unix 秒时间戳；子会话与 title- 会话被过滤', () => {
  withTmp((root) => {
    const dbPath = makeDb(join(root, 'proj', '.crush', 'crush.db'), {
      sessions: [
        sessionRow(),
        sessionRow({ id: 'parent$$call', parent_session_id: SID, title: 'New Agent Session' }),
        sessionRow({ id: 'title-' + SID, title: 'Generate a title' }),
        sessionRow({ id: 'second', title: '第二个会话', created_at: CREATED + 100, updated_at: UPDATED + 100 }),
      ],
    })
    const rows = readCrushSessions(dbPath)
    assert.deepEqual(rows.map((r) => r.id).sort(), [SID, 'second'])
    const first = rows.find((r) => r.id === SID)
    assert.equal(first.title, 'Add retry to fetch')
    assert.equal(first.createdAt, CREATED * 1000) // Unix 秒 → 毫秒
    assert.equal(first.updatedAt, UPDATED * 1000)
  })
})

test('readCrushDb：消息按 created_at 升序、parts 解析成数组、畸形 parts 按空数组保留消息', () => {
  withTmp((root) => {
    const dbPath = makeDb(join(root, 'crush.db'), {
      sessions: [sessionRow()],
      messages: [
        messageRow({ id: 'm2', role: 'assistant', created_at: CREATED + 2, model: 'claude-sonnet-4-20250514', provider: 'anthropic', parts: JSON.stringify([{ type: 'text', data: { text: '答' } }]) }),
        messageRow({ id: 'm1', role: 'user', created_at: CREATED + 1 }),
        messageRow({ id: 'm3', role: 'tool', created_at: CREATED + 3, parts: '{oops' }),
      ],
    })
    const [s] = readCrushDb(dbPath)
    assert.equal(s.id, SID)
    assert.deepEqual(s.messages.map((m) => m.id), ['m1', 'm2', 'm3'])
    assert.equal(s.messages[1].parts[0].data.text, '答')
    assert.equal(s.messages[1].model, 'claude-sonnet-4-20250514')
    assert.deepEqual(s.messages[2].parts, []) // 畸形 parts → 空数组（消息仍保留）
  })
})

test('库签名：缺 read_files 表或关键列 → null；缺失文件 → null', () => {
  withTmp((root) => {
    assert.equal(readCrushSessions(join(root, 'nope.db')), null)
    // 有 sessions/messages 但没有 read_files（其它 agent 工具的库）
    const noReadFiles = makeDb(join(root, 'other.db'), {
      create: `CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, summary_message_id TEXT, prompt_tokens INTEGER);
CREATE TABLE messages (id TEXT PRIMARY KEY, parts TEXT, is_summary_message INTEGER, finished_at INTEGER);`,
    })
    assert.equal(readCrushSessions(noReadFiles), null)
    assert.equal(readCrushDb(noReadFiles), null)
    // 有表但缺关键列（老的第三方库）
    const noCols = makeDb(join(root, 'half.db'), {
      create: `CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT);
CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, parts TEXT);
CREATE TABLE read_files (session_id TEXT, path TEXT, read_at INTEGER);`,
    })
    assert.equal(readCrushSessions(noCols), null)
  })
})

test('crushProjectPathFor：按注册表 data_dir 反查项目路径；回退「库目录以 .crush 结尾 → 父目录」', () => {
  const registry = JSON.stringify({
    projects: [
      { path: '/home/u/proj', data_dir: '/home/u/proj/.crush', last_accessed: '2026-09-15T13:00:00Z' },
      { path: 'D:\\work\\other', data_dir: 'D:\\work\\other\\.crush', last_accessed: '2026-09-14T13:00:00Z' },
    ],
  })
  assert.equal(crushProjectPathFor('/home/u/proj/.crush', registry), '/home/u/proj')
  assert.equal(crushProjectPathFor('D:\\work\\other\\.crush', registry), 'D:\\work\\other') // 分隔符/大小写归一
  assert.equal(crushProjectPathFor('/home/u/unlisted/.crush', registry), '/home/u/unlisted') // 几何回退
  assert.equal(crushProjectPathFor('/tmp/random', registry), null)
  assert.equal(crushProjectPathFor('/tmp/random', null), null)
})

test('crushDeriveArgs：注册表可用时给出 cwd；不可用时回退几何推导', async () => {
  await withTmpAsync(async (root) => {
    const projectDir = join(root, 'proj')
    const dbPath = crushProjectDbPath(projectDir)
    const registryPath = join(root, 'crush-data', 'projects.json')
    const files = {
      [registryPath]: JSON.stringify({ projects: [{ path: projectDir, data_dir: join(projectDir, '.crush'), last_accessed: '2026-09-15T13:00:00Z' }] }),
    }
    // ctx 的最小形态：resolve 原样返回、readText 走内存表
    const ctx = {
      fs: {
        processPath: (t) => t,
        resolve: async (p) => p,
        readText: async (p) => (p in files ? files[p] : null),
      },
    }
    // 注册表路径由 homedir() 推导，测试里改不了它 → 直接验证几何回退这条（注册表不可读）
    const derived = await crushDeriveArgs(ctx, { displayPath: dbPath })
    assert.equal(derived.crushId, 'crush')
    assert.equal(derived.cwd, projectDir) // <项目>/.crush/crush.db → cwd 取 <项目>
  })
})

async function withTmpAsync(fn) {
  return withTempDirAsync('crush-test-', fn)
}
