// goose-db.test.mjs — Goose 会话库（sessions.db）读取单测：造真实 SQLite 夹具
//（node:sqlite），覆盖两表读取、子代理/隐藏过滤、userVisible 过滤、时间戳两种格式、
// 老库缺列自适应与「非 Goose 库 → null」的签名判定。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { readGooseDb, readGooseSessions, gooseDefaultDbPath } from '../lib/sources/goose.mjs'
import { withTempDir, writeSqliteFixture } from './_support/tmp-db.mjs'

// 上游 session_manager.rs 的建表要点（CURRENT_SCHEMA_VERSION=16；老库靠 ALTER 逐列补齐）
const CREATE = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  user_set_name BOOLEAN DEFAULT FALSE, session_type TEXT NOT NULL DEFAULT 'user',
  working_dir TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, extension_data TEXT DEFAULT '{}',
  total_tokens INTEGER, input_tokens INTEGER, output_tokens INTEGER,
  cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  accumulated_total_tokens INTEGER, accumulated_input_tokens INTEGER,
  accumulated_output_tokens INTEGER, accumulated_cache_read_tokens INTEGER,
  accumulated_cache_write_tokens INTEGER, accumulated_cost REAL,
  schedule_id TEXT, recipe_json TEXT, user_recipe_values_json TEXT,
  provider_name TEXT, model_config_json TEXT, goose_mode TEXT NOT NULL DEFAULT 'auto',
  archived_at TIMESTAMP, project_id TEXT, parent_session_id TEXT);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT,
  session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL,
  content_json TEXT NOT NULL, created_timestamp INTEGER NOT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP, tokens INTEGER, metadata_json TEXT);
CREATE INDEX idx_messages_session ON messages(session_id);
CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
`

const SID = '20260422_3'
const CWD = '/home/u/repo'

// 本文件的临时库前缀；mkdtemp / 清理 / 建表 / 插行都在 _support/tmp-db.mjs。
const withTmp = (fn) => withTempDir('goose-test-', fn)

function makeDb(dbPath, { create = CREATE, sessions = [], messages = [] } = {}) {
  return writeSqliteFixture(dbPath, { create, rows: { sessions, messages } })
}

function sessionRow(over = {}) {
  return {
    id: SID, name: '修登录页分页', description: '遗留描述', session_type: 'user',
    working_dir: CWD, created_at: '2026-04-22 17:40:00', updated_at: '2026-04-22 17:42:10',
    provider_name: 'anthropic', parent_session_id: null, ...over,
  }
}
function messageRow(over = {}) {
  return {
    session_id: SID, role: 'user', content_json: JSON.stringify([{ type: 'text', text: '你好' }]),
    created_timestamp: 1745343730, metadata_json: null, ...over,
  }
}

test('readGooseSessions：「CURRENT_TIMESTAMP 文本按 UTC 解析」+ 标题 name 优先', () => {
  withTmp((root) => {
    const dbPath = makeDb(join(root, 'goose', 'sessions', 'sessions.db'), {
      sessions: [sessionRow()],
      messages: [
        messageRow({ id: 1, role: 'user', content_json: JSON.stringify([{ type: 'text', text: '问' }]) }),
        messageRow({ id: 2, role: 'assistant', content_json: JSON.stringify([{ type: 'text', text: '答' }]) }),
        // agent-only（userVisible=false）不计入消息数
        messageRow({ id: 3, role: 'assistant', content_json: JSON.stringify([{ type: 'text', text: '内部' }]), metadata_json: JSON.stringify({ userVisible: false }) }),
      ],
    })
    const rows = readGooseSessions(dbPath)
    assert.equal(rows.length, 1)
    const s = rows[0]
    assert.equal(s.id, SID)
    assert.equal(s.title, '修登录页分页')
    assert.equal(s.cwd, CWD)
    // SQLite CURRENT_TIMESTAMP 是 UTC 但不带时区 → 必须按 UTC 解析（否则按本地时区偏几个小时）
    assert.equal(s.createdAt, Date.parse('2026-04-22T17:40:00Z'))
    assert.equal(s.updatedAt, Date.parse('2026-04-22T17:42:10Z'))
  })
})

test('readGooseSessions：子代理 / 隐藏 / 带父会话的行不列出', () => {
  withTmp((root) => {
    const dbPath = makeDb(join(root, 'sessions.db'), {
      sessions: [
        sessionRow(),
        sessionRow({ id: 'sub-1', session_type: 'sub_agent', parent_session_id: SID }),
        sessionRow({ id: 'hidden-1', session_type: 'hidden' }),
        sessionRow({ id: 'orphan', session_type: 'user', parent_session_id: SID }),
        sessionRow({ id: 'sched-1', session_type: 'scheduled', name: '定时任务' }),
      ],
    })
    const ids = readGooseSessions(dbPath).map((s) => s.id).sort()
    assert.deepEqual(ids, [SID, 'sched-1']) // 定时会话是真实会话，保留
  })
})

test('readGooseDb：消息按 created_timestamp 升序、content_json 原样、userVisible=false 过滤、系统提示词收集', () => {
  withTmp((root) => {
    const dbPath = makeDb(join(root, 'sessions.db'), {
      sessions: [sessionRow()],
      messages: [
        messageRow({ id: 10, role: 'user', created_timestamp: 1745343730, content_json: JSON.stringify([{ type: 'text', text: '第二问' }]) }),
        messageRow({ id: 9, role: 'user', created_timestamp: 1745343720, content_json: JSON.stringify([{ type: 'text', text: '第一问' }]) }),
        messageRow({ id: 11, role: 'system', created_timestamp: 1745343710, content_json: JSON.stringify([{ type: 'text', text: '你是 Goose。' }]) }),
        messageRow({ id: 12, role: 'assistant', created_timestamp: 1745343740, content_json: JSON.stringify([{ type: 'thinking', thinking: '想一想', signature: '' }, { type: 'text', text: '答' }]) }),
        messageRow({ id: 13, role: 'assistant', created_timestamp: 1745343750, content_json: JSON.stringify([{ type: 'text', text: 'agent-only' }]), metadata_json: JSON.stringify({ userVisible: false }) }),
      ],
    })
    const [s] = readGooseDb(dbPath)
    assert.equal(s.id, SID)
    assert.equal(s.systemPrompt, '你是 Goose。')
    assert.deepEqual(s.messages.map((m) => m.role), ['user', 'user', 'assistant'])
    assert.equal(s.messages[0].content[0].text, '第一问') // 按 created_timestamp 升序
    assert.equal(s.messages[2].content[0].type, 'thinking')
  })
})

test('readGooseDb：畸形 content_json/metadata_json 不抛错（该消息无内容，其余照常）', () => {
  withTmp((root) => {
    const dbPath = makeDb(join(root, 'sessions.db'), {
      sessions: [sessionRow()],
      messages: [
        messageRow({ id: 1, content_json: '{oops', metadata_json: '{also-bad' }),
        messageRow({ id: 2, role: 'assistant', content_json: JSON.stringify([{ type: 'text', text: '正常' }]) }),
      ],
    })
    const [s] = readGooseDb(dbPath)
    assert.equal(s.messages.length, 2)
    assert.deepEqual(s.messages[0].content, [])
    assert.equal(s.messages[1].content[0].text, '正常')
  })
})

test('老库缺列（无 name/description/parent_session_id/metadata_json）仍可读', () => {
  withTmp((root) => {
    const dbPath = makeDb(join(root, 'sessions.db'), {
      create: `CREATE TABLE sessions (id TEXT PRIMARY KEY, session_type TEXT, working_dir TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content_json TEXT, created_timestamp INTEGER);`,
      sessions: [{ id: SID, session_type: 'user', working_dir: CWD, created_at: '2026-04-22 17:40:00', updated_at: '2026-04-22 17:42:10' }],
      messages: [{ session_id: SID, role: 'user', content_json: JSON.stringify([{ type: 'text', text: '问' }]), created_timestamp: 1745343730 }],
    })
    const [s] = readGooseDb(dbPath)
    assert.equal(s.name, '') // 旧库没有标题列（中间 JSON 保持 goose 原生字段名 name/description）
    assert.equal(s.workingDir, CWD)
    assert.equal(s.messages.length, 1)
  })
})

test('库签名：非 Goose 库（缺 sessions/messages 或列不符）→ null；缺失文件 → null', () => {
  withTmp((root) => {
    assert.equal(readGooseSessions(join(root, 'nope.db')), null)
    const foreign = join(root, 'foreign.db')
    const db = new DatabaseSync(foreign)
    db.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY)')
    db.close()
    assert.equal(readGooseSessions(foreign), null)
    assert.equal(readGooseDb(foreign), null)
    // 有 sessions 表但没有 messages 表 → 不是 Goose 库
    const half = join(root, 'half.db')
    const db2 = new DatabaseSync(half)
    db2.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, session_type TEXT, working_dir TEXT)")
    db2.close()
    assert.equal(readGooseSessions(half), null)
  })
})

test('gooseDefaultDbPath：$GOOSE_PATH_ROOT 绝对路径优先，否则按平台（注入 env/platform 断言）', () => {
  const home = '/home/u'
  assert.equal(gooseDefaultDbPath(home, {}, 'linux'), '/home/u/.local/share/goose/sessions/sessions.db')
  assert.equal(gooseDefaultDbPath(home, { GOOSE_PATH_ROOT: '/mnt/d/goose-root' }, 'linux'),
    '/mnt/d/goose-root/data/sessions/sessions.db')
  assert.equal(gooseDefaultDbPath(home, { GOOSE_PATH_ROOT: 'rel/root' }, 'linux'),
    '/home/u/.local/share/goose/sessions/sessions.db') // 相对路径被忽略（与上游一致）
  assert.equal(gooseDefaultDbPath('/h/u', {}, 'darwin'),
    '/h/u/Library/Application Support/Block/goose/sessions/sessions.db')
  assert.equal(gooseDefaultDbPath('C:\\Users\\u', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32'),
    'C:\\Users\\u\\AppData\\Roaming\\Block\\goose\\data\\sessions\\sessions.db')
})
