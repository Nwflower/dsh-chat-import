// test/hermes.test.mjs — Hermes 源（第 11 个导入源）单元测试（自包含、合成数据）
//
// convertHermesJson（中间 JSON + JSONL flat/nested 双形态）+ readHermesDb（真实
// temp state.db：sessions + messages 表）。不依赖 index.mjs（工具注册由另一 agent
// 接线），直接 import lib/convert/hermes.mjs 与 lib/hermes.mjs；SQLite 优先语义由
// index 层做，此处只验证 readHermesDb 与 convertHermesJson 各自正确。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { convertHermesJson } from '../lib/convert/hermes.mjs'
import { readHermesDb } from '../lib/hermes.mjs'

// 平衡会话断言：seq 连续、turn 开合配对、tool call/result 1:1、surface 事件带 surfaceOp。
function assertBalanced(out) {
  out.events.forEach((e, i) => assert.equal(e.seq, i))
  assert.equal(
    out.events.filter((e) => e.type === 'turn/start').length,
    out.events.filter((e) => e.type === 'turn/end').length,
  )
  assert.equal(
    out.events.filter((e) => e.type === 'tool/call').length,
    out.events.filter((e) => e.type === 'tool/result').length,
  )
  for (const e of out.events.filter((e) => e.type === 'tool/result')) {
    assert.ok(Array.isArray(e.sourceEventSeqs) && e.sourceEventSeqs.length === 1)
  }
  for (const e of out.events.filter((e) => ['user/message', 'assistant/message', 'tool/result'].includes(e.type))) {
    assert.equal(e.surfaceOp, 'append')
  }
}

// ── 合成 hermes fixture ──────────────────────────────────────────────────

// 两个会话：hm-a 带 thinking + tool_use/tool_result 成对；hm-b 纯文本。
// content 数组在 DB 里以 JSON 文本存储（makeHermesDb 负责序列化）。
function hermesTestSessions() {
  return [
    {
      id: 'hm-a',
      title: 'Fix hermes build',
      cwd: 'E:/demo/hermes',
      startedAt: 1786000000000,
      messages: [
        { role: 'user', content: '为什么构建失败', ts: 1786000000001 },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '先看日志' },
            { type: 'tool_use', id: 'call-h1', name: 'bash', input: { command: 'cargo build' } },
          ],
          ts: 1786000000002,
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call-h1', content: [{ type: 'text', text: 'Compiling...' }] },
          ],
          ts: 1786000000003,
        },
        { role: 'assistant', content: '修好了', ts: 1786000000004 },
      ],
    },
    {
      id: 'hm-b',
      title: 'Refactor hermes',
      cwd: 'E:/demo/hermes',
      startedAt: 1786000100000,
      messages: [
        { role: 'user', content: '重构模块', ts: 1786000100001 },
        { role: 'assistant', content: '完成', ts: 1786000100002 },
      ],
    },
  ]
}

// 在 os.tmpdir() 建临时 hermes state.db（真实 schema：sessions + messages 表，
// block 数组 content 以 JSON 文本落库）。
function makeHermesDb(sessions) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hermes-'))
  const dbPath = join(dir, 'state.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, started_at REAL, ended_at REAL)')
  db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, created_at REAL)')
  for (const s of sessions) {
    db.prepare('INSERT INTO sessions (id, title, cwd, started_at) VALUES (?, ?, ?, ?)').run(s.id, s.title, s.cwd, s.startedAt)
    for (const m of s.messages) {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(s.id, m.role, content, m.ts)
    }
  }
  db.close()
  return dbPath
}

// ── convertHermesJson 纯函数单测 ─────────────────────────────────────────

test('convertHermesJson: 中间 JSON 问答、元数据、平衡回合', () => {
  const raw = JSON.stringify({
    id: 'hm-a',
    title: 'Fix hermes build',
    cwd: 'E:/demo/hermes',
    createdAt: 1786000000000,
    messages: [
      { role: 'user', content: '为什么构建失败', ts: 1786000000001 },
      { role: 'assistant', content: '是缺依赖，补上即可。', ts: 1786000000002 },
    ],
  })
  const out = convertHermesJson(raw, { sourcePath: 'E:/demo/hermes/state.db' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 2)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.skipped, 0)
  assert.equal(out.droppedToolResults, 0)
  assert.equal(out.meta.id, 'import-hm-a')
  assert.equal(out.meta.sourceId, 'hm-a')
  assert.equal(out.meta.version, 0)
  assert.equal(out.meta.cwd, 'E:/demo/hermes')
  assert.equal(out.meta.createdAt, 1786000000000)
  assert.equal(out.title, 'Fix hermes build')
  assertBalanced(out)
  const types = out.events.map((e) => e.type)
  assert.deepEqual(types, [
    'user/message', 'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end', 'session/title',
  ])
  // 导入归属外置 registry（issue #34）：日志无 session/imported 标记
  assert.ok(out.events.every((e) => e.type !== 'session/imported'))
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.source, { kind: 'model', provider: 'hermes', model: 'hermes' })
  assert.equal(out.events.find((e) => e.type === 'session/title').data.title, 'Fix hermes build')
})

test('convertHermesJson: thinking→reasoning、tool_use/tool_result 成对、isError、结果不开新轮', () => {
  const raw = JSON.stringify({
    id: 'hm-t',
    createdAt: 1786000000000,
    messages: [
      { role: 'user', content: '跑一下', ts: 1 },
      {
        role: 'assistant', ts: 2,
        content: [
          { type: 'thinking', thinking: '先查日志' },
          { type: 'tool_use', id: 'call-ok', name: 'bash', input: { command: 'npm test' } },
          { type: 'tool_use', id: 'call-bad', name: 'bash', input: { command: 'bad' } },
        ],
      },
      {
        role: 'user', ts: 3,
        content: [
          { type: 'tool_result', tool_use_id: 'call-bad', content: [{ type: 'text', text: 'boom' }], is_error: true },
          { type: 'tool_result', tool_use_id: 'call-ok', content: [{ type: 'text', text: 'all passed' }] },
        ],
      },
      { role: 'assistant', content: '完成', ts: 4 },
    ],
  })
  const out = convertHermesJson(raw)
  assertBalanced(out)
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 2)
  const calls = out.events.filter((e) => e.type === 'tool/call')
  const results = out.events.filter((e) => e.type === 'tool/result')
  assert.equal(calls.length, 2)
  assert.equal(results.length, 2)
  // 乱序结果按 call 顺序对齐（call-ok 在前）；错误结果标 isError
  assert.equal(results[0].data.message.content[0].toolCallId, 'call-ok')
  assert.deepEqual(results[0].sourceEventSeqs, [calls[0].seq])
  assert.equal(results[0].data.message.content[0].content[0].text, 'all passed')
  assert.equal(results[1].data.message.content[0].isError, true)
  // 工具结果独占的 user 消息不开新轮；thinking → reasoning 进 assistant content
  assert.equal(out.events.filter((e) => e.type === 'user/message' && e.data.source.kind === 'user').length, 1)
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  const kinds = asst.content.map((c) => c.type)
  assert.ok(kinds.includes('reasoning'))
  assert.ok(kinds.includes('tool-call'))
})

test('convertHermesJson: 无结果的 tool_use 兜底发空 result（成对不变量）', () => {
  const raw = JSON.stringify({
    id: 'hm-n',
    messages: [
      { role: 'user', content: '查一下', ts: 1 },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call-n1', name: 'read', input: { file: 'a.txt' } }], ts: 2 },
    ],
  })
  const out = convertHermesJson(raw)
  assertBalanced(out)
  assert.equal(out.toolCalls, 1)
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.ok(result)
  assert.equal(result.data.message.content[0].toolCallId, 'call-n1')
  assert.deepEqual(result.data.message.content[0].content, [])
})

test('convertHermesJson: 孤儿 tool_result 丢弃并计数上报', () => {
  const raw = JSON.stringify({
    id: 'hm-orphan',
    messages: [
      { role: 'user', content: 'hi', ts: 1 },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-gone', content: [{ type: 'text', text: 'x' }] }], ts: 2 },
      { role: 'assistant', content: 'ok', ts: 3 },
    ],
  })
  const out = convertHermesJson(raw)
  assert.equal(out.droppedToolResults, 1)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.turns.length, 1)
  assertBalanced(out)
})

test('convertHermesJson: 无可用记录返回空 meta（畸形 / 空输入）', () => {
  const bad = convertHermesJson('not json')
  assert.equal(bad.meta, null)
  assert.equal(bad.skipped, 1)
  assert.equal(bad.records, 0)
  const empty = convertHermesJson('')
  assert.equal(empty.meta, null)
  assert.equal(empty.skipped, 0)
  assert.deepEqual(empty.events, [])
  assert.deepEqual(empty.turns, [])
})

test('convertHermesJson: JSONL flat 形态（role/content/ts）平衡会话、标题回退首问', () => {
  const raw = [
    JSON.stringify({ role: 'user', content: '什么是 Rust？', ts: 1700000000 }),
    JSON.stringify({ role: 'assistant', content: '一种系统编程语言。', ts: 1700000001 }),
  ].join('\n') + '\n'
  const out = convertHermesJson(raw, { sourcePath: 'E:/demo/hermes/sessions/s.jsonl' })
  assertBalanced(out)
  assert.equal(out.turns.length, 1)
  assert.equal(out.records, 2)
  assert.equal(out.skipped, 0)
  assert.equal(out.title, '什么是 Rust？') // 无显式标题 → 首问兜底
  assert.equal(out.events.find((e) => e.type === 'session/title'), undefined) // 兜底标题不钉
  assert.ok(out.meta.id.startsWith('import-'))
  assert.equal(out.meta.createdAt, 1700000000000) // 秒级 ts → 毫秒
  const users = out.events.filter((e) => e.type === 'user/message' && e.data.source.kind === 'user')
  assert.equal(users.length, 1)
  assert.equal(users[0].data.content[0].text, '什么是 Rust？')
})

test('convertHermesJson: JSONL nested 形态（session 元数据 + message 记录）', () => {
  const raw = [
    JSON.stringify({ type: 'session', id: 's1', title: 'My Session', cwd: '/home/user/project' }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: 'Hello world' }, timestamp: '2026-01-01T00:00:00Z' }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'Hi there' }, timestamp: '2026-01-01T00:01:00Z' }),
  ].join('\n') + '\n'
  const out = convertHermesJson(raw)
  assertBalanced(out)
  assert.equal(out.meta.sourceId, 's1')
  assert.equal(out.meta.id, 'import-s1')
  assert.equal(out.meta.cwd, '/home/user/project')
  assert.equal(out.title, 'My Session')
  assert.equal(out.meta.createdAt, Date.parse('2026-01-01T00:00:00Z'))
  assert.equal(out.records, 3)
  assert.equal(out.skipped, 0)
  assert.equal(out.turns.length, 1)
})

test('convertHermesJson: JSONL 畸形行计数 skipped、sessionId 字段回退', () => {
  const raw = [
    'not json at all',
    JSON.stringify({ role: 'user', content: '正常提问' }),
    JSON.stringify({ type: 'init', sessionId: 'sess-9', title: 'T' }),
    JSON.stringify({ role: 'assistant', content: '正常回答' }),
  ].join('\n') + '\n'
  const out = convertHermesJson(raw)
  assertBalanced(out)
  assert.equal(out.skipped, 1)
  assert.equal(out.records, 3)
  assert.equal(out.meta.sourceId, 'sess-9')
  assert.equal(out.meta.id, 'import-sess-9')
  assert.equal(out.title, 'T')
})

test('convertHermesJson: JSONL 无 id 时 fileStem 兜底会话 id', () => {
  const raw = JSON.stringify({ role: 'user', content: 'hi', ts: 1 }) + '\n'
  const out = convertHermesJson(raw, { fileStem: 'my-session' })
  assert.equal(out.meta.id, 'import-my-session')
  assert.equal(out.meta.sourceId, undefined)
})

// ── readHermesDb 单测（真实 temp SQLite） ────────────────────────────────

test('readHermesDb: 只读抽取 sessions+messages、block 数组解析、ts 归一毫秒', () => {
  const dbPath = makeHermesDb(hermesTestSessions())
  const sessions = readHermesDb(dbPath)
  assert.equal(sessions.length, 2)
  // rowid DESC → 后插入的 hm-b 在前
  const [b, a] = sessions
  assert.equal(b.id, 'hm-b')
  assert.equal(b.title, 'Refactor hermes')
  assert.equal(b.cwd, 'E:/demo/hermes')
  assert.equal(b.createdAt, 1786000100000)
  assert.equal(b.messages.length, 2)
  assert.equal(b.messages[0].role, 'user')
  assert.equal(b.messages[0].content, '重构模块')
  assert.equal(b.messages[0].ts, 1786000100001)

  assert.equal(a.id, 'hm-a')
  assert.equal(a.createdAt, 1786000000000)
  assert.equal(a.messages.length, 4)
  // content 的 Claude block 数组（JSON 文本落库）解析回数组
  assert.deepEqual(a.messages[1].content[0], { type: 'thinking', thinking: '先看日志' })
  assert.equal(a.messages[1].content[1].type, 'tool_use')
  assert.equal(a.messages[2].content[0].tool_use_id, 'call-h1')
  assert.equal(a.messages[3].content, '修好了')
})

test('readHermesDb: 消息按 created_at 升序重建（乱序插入）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hermes-'))
  const dbPath = join(dir, 'state.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, started_at REAL)')
  db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, created_at REAL)')
  db.prepare('INSERT INTO sessions (id, title, cwd, started_at) VALUES (?, ?, ?, ?)').run('s1', 'T1', 'E:/demo', 1786000000000)
  // 乱序插入：3, 1, 2 → 读取必须按 created_at 升序
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run('s1', 'assistant', 'c', 3)
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run('s1', 'user', 'a', 1)
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run('s1', 'user', 'b', 2)
  db.close()

  const [s] = readHermesDb(dbPath)
  assert.deepEqual(s.messages.map((m) => m.content), ['a', 'b', 'c'])
})

test('readHermesDb: 变体列名兼容（directory/created_at/updated_at、messages.timestamp）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hermes-'))
  const dbPath = join(dir, 'state.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, directory TEXT, created_at INTEGER, updated_at INTEGER)')
  db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL)')
  db.prepare('INSERT INTO sessions (id, title, directory, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('v1', 'Variant', '/home/u/proj', 1786000000, 1786000099)
  // 秒级浮点时间戳 → 毫秒（小数秒截断，对齐 cc-switch n as i64 语义）
  db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run('v1', 'user', 'hi', 1786000001.5)
  db.close()

  const [s] = readHermesDb(dbPath)
  assert.equal(s.cwd, '/home/u/proj')
  assert.equal(s.createdAt, 1786000000000) // started_at 缺 → created_at（秒→毫秒）
  assert.equal(s.messages[0].ts, 1786000001000)
})

test('readHermesDb: 空内容 / 缺 role 消息跳过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hermes-'))
  const dbPath = join(dir, 'state.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, started_at REAL)')
  db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, created_at REAL)')
  db.prepare('INSERT INTO sessions (id, title, cwd, started_at) VALUES (?, ?, ?, ?)').run('s1', 'T1', 'E:/demo', 1)
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run('s1', 'user', '  ', 1)
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run('s1', 'system', '系统提示', 2)
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run('s1', 'user', '真实提问', 3)
  db.close()

  const [s] = readHermesDb(dbPath)
  // 空内容跳过；system 角色保留在中间 JSON（converter 层忽略非 user/assistant）
  assert.equal(s.messages.length, 2)
  assert.equal(s.messages[0].role, 'system')
  assert.equal(s.messages[1].content, '真实提问')
})

test('REQ-51 readHermesDb: parent_session_id 透出（压缩分叉关联）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hermes-'))
  const dbPath = join(dir, 'state.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, parent_session_id TEXT, started_at REAL)')
  db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, created_at REAL)')
  // 父会话（压缩分叉节点，通常无消息）+ 子会话（承接内容）
  db.prepare('INSERT INTO sessions (id, title, parent_session_id, started_at) VALUES (?, ?, ?, ?)').run('parent-1', 'Parent', null, 1786000000000)
  db.prepare('INSERT INTO sessions (id, title, parent_session_id, started_at) VALUES (?, ?, ?, ?)').run('child-1', 'Child', 'parent-1', 1786000100000)
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run('child-1', 'user', '继续', 1786000100001)
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run('child-1', 'assistant', '好', 1786000100002)
  db.close()

  const sessions = readHermesDb(dbPath)
  const parent = sessions.find((s) => s.id === 'parent-1')
  const child = sessions.find((s) => s.id === 'child-1')
  assert.equal(child.parentSessionId, 'parent-1')
  assert.equal(parent.parentSessionId, undefined)
})

test('readHermesDb: db 不可用返回 null（缺失 / 非 SQLite / 无 sessions 表）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hermes-'))
  const missing = join(dir, 'no.db')
  assert.equal(readHermesDb(missing), null)
  const garbage = join(dir, 'garbage.db')
  writeFileSync(garbage, 'not a sqlite database at all')
  assert.equal(readHermesDb(garbage), null)
  const empty = join(dir, 'empty.db')
  const db = new DatabaseSync(empty)
  db.exec('CREATE TABLE unrelated (a TEXT)')
  db.close()
  assert.equal(readHermesDb(empty), null)
})

// ── readHermesDb → convertHermesJson 管线（合成 fixture 每会话平衡） ──────

test('readHermesDb → convertHermesJson: DB fixture 每个会话都能转出平衡会话', () => {
  const dbPath = makeHermesDb(hermesTestSessions())
  for (const s of readHermesDb(dbPath)) {
    const out = convertHermesJson(JSON.stringify(s), { sourcePath: dbPath })
    assert.ok(out.meta)
    assert.equal(out.meta.sourceId, s.id)
    assert.ok(out.turns.length >= 1)
    assert.equal(out.skipped, 0)
    assertBalanced(out)
    if (s.id === 'hm-a') {
      assert.equal(out.toolCalls, 1)
      // tool_result 挂回 call 所属 step，sourceEventSeqs 关联
      const call = out.events.find((e) => e.type === 'tool/call')
      const result = out.events.find((e) => e.type === 'tool/result')
      assert.deepEqual(result.sourceEventSeqs, [call.seq])
      assert.equal(result.data.message.content[0].content[0].text, 'Compiling...')
      // thinking → reasoning 进 assistant content
      const reasoning = out.events
        .filter((e) => e.type === 'assistant/message')
        .flatMap((e) => e.data.message.content)
        .filter((c) => c.type === 'reasoning')
      assert.equal(reasoning.length, 1)
      assert.equal(reasoning[0].text, '先看日志')
    }
  }
})

// ── REQ-50：hermes-agent 变体（tool_calls / reasoning 独立列）──────────────

test('readHermesDb: 变体列 tool_calls / reasoning（JSON 文本）进中间 JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hermes-'))
  const dbPath = join(dir, 'state.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, started_at REAL)')
  db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, reasoning TEXT, timestamp REAL)')
  db.prepare('INSERT INTO sessions (id, title, cwd, started_at) VALUES (?, ?, ?, ?)').run('va', 'Variant', 'E:/demo', 1)
  db.prepare('INSERT INTO messages (session_id, role, content, tool_calls, reasoning, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
    .run('va', 'user', '帮我跑测试', null, null, 1)
  db.prepare('INSERT INTO messages (session_id, role, content, tool_calls, reasoning, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
    .run('va', 'assistant', '跑一下', JSON.stringify([{ id: 'call-v1', name: 'bash', arguments: { command: 'npm test' } }]), JSON.stringify('先看测试输出'), 2)
  db.close()

  const [s] = readHermesDb(dbPath)
  assert.equal(s.messages.length, 2)
  const asst = s.messages[1]
  assert.equal(asst.reasoning, '先看测试输出')
  assert.deepEqual(asst.toolCalls, [{ id: 'call-v1', name: 'bash', input: { command: 'npm test' } }])
  assert.equal(s.messages[0].toolCalls, undefined) // 无工具列消息不占键
  assert.equal(s.messages[0].reasoning, undefined)
})

test('convertHermesJson: 变体 toolCalls/reasoning → reasoning 块前置 + tool-call 块配对，0 skipped', () => {
  const raw = JSON.stringify({
    id: 'va',
    createdAt: 1,
    messages: [
      { role: 'user', content: '帮我跑测试', ts: 1 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '跑一下' }],
        reasoning: '先看测试输出',
        toolCalls: [{ id: 'call-v1', name: 'bash', input: { command: 'npm test' } }],
        ts: 2,
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-v1', content: [{ type: 'text', text: 'PASS' }] }],
        ts: 3,
      },
    ],
  })
  const out = convertHermesJson(raw, { sourcePath: 'E:/demo/state.db' })
  assert.equal(out.skipped, 0)
  assert.equal(out.droppedToolResults, 0)
  assert.equal(out.toolCalls, 1)
  assertBalanced(out)
  const blocks = out.events.find((e) => e.type === 'assistant/message').data.message.content
  assert.equal(blocks[0].type, 'reasoning')
  assert.equal(blocks[0].text, '先看测试输出')
  assert.ok(blocks.some((b) => b.type === 'tool-call' && b.id === 'call-v1' && b.name === 'bash'))
  const call = out.events.find((e) => e.type === 'tool/call')
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
})

test('readHermesDb → convertHermesJson: 变体 DB 全链路平衡（tool_calls 列 + 结果配对）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hermes-'))
  const dbPath = join(dir, 'state.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, started_at REAL)')
  db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, reasoning TEXT, timestamp REAL)')
  db.prepare('INSERT INTO sessions (id, title, cwd, started_at) VALUES (?, ?, ?, ?)').run('vb', 'Variant B', 'E:/demo', 1)
  db.prepare('INSERT INTO messages (session_id, role, content, tool_calls, reasoning, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
    .run('vb', 'user', '重构成啥', null, null, 1)
  db.prepare('INSERT INTO messages (session_id, role, content, tool_calls, reasoning, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
    .run('vb', 'assistant', 'plan', JSON.stringify([{ id: 'c1', name: 'bash', input: { command: 'ls' } }]), '先看目录', 2)
  db.prepare('INSERT INTO messages (session_id, role, content, tool_calls, reasoning, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
    .run('vb', 'user', JSON.stringify([{ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'src' }] }]), null, null, 3)
  db.close()

  const [s] = readHermesDb(dbPath)
  const out = convertHermesJson(JSON.stringify(s), { sourcePath: dbPath })
  assert.equal(out.skipped, 0)
  assert.equal(out.toolCalls, 1)
  assertBalanced(out)
})
