// test/_support/index-fixtures.mjs — index 集成用例的共用夹具构造器（工具模块，不被 npm test 收集）
//
// 这些构造器（opencode 临时库、Kimi Code wire）被多个集成主题复用，收在这里一份，
// 由 test/index-*.test.mjs 各自导入。
import { DatabaseSync } from 'node:sqlite'
import { hostAbs } from './host-path.mjs'
import { tempDbPath, openSqliteFixture } from './tmp-db.mjs'

export function opencodeTestSessions() {
  return [
    {
      id: 'ses-a',
      title: 'Fix build',
      directory: hostAbs('E:/demo/opencode'),
      createdAt: 1786000000000,
      model: { id: 'deepseek-v4-flash', providerID: 'opencode-go' },
      messages: [
        { id: 'msg-a1', createdAt: 1786000000001, data: { role: 'user' }, parts: [
          { id: 'p-a1', createdAt: 1786000000001, data: { type: 'text', text: '为什么构建失败' } },
        ] },
        { id: 'msg-a2', createdAt: 1786000000002, data: { role: 'assistant', modelID: 'deepseek-v4-pro', path: { cwd: hostAbs('E:/demo/opencode') } }, parts: [
          { id: 'p-a2', createdAt: 1786000000002, data: { type: 'reasoning', text: '看日志' } },
          { id: 'p-a3', createdAt: 1786000000003, data: { type: 'tool', tool: 'bash', callID: 'call-a1', state: { status: 'completed', input: { command: 'cargo build' }, output: 'Compiling...' } } },
          { id: 'p-a4', createdAt: 1786000000004, data: { type: 'text', text: '修好了' } },
        ] },
      ],
    },
    {
      id: 'ses-b',
      title: 'Refactor',
      directory: hostAbs('E:/demo/opencode'),
      createdAt: 1786000100000,
      model: { id: 'deepseek-v4-flash', providerID: 'opencode-go' },
      messages: [
        { id: 'msg-b1', createdAt: 1786000100001, data: { role: 'user' }, parts: [
          { id: 'p-b1', createdAt: 1786000100001, data: { type: 'text', text: '重构模块' } },
        ] },
        { id: 'msg-b2', createdAt: 1786000100002, data: { role: 'assistant' }, parts: [
          { id: 'p-b2', createdAt: 1786000100002, data: { type: 'text', text: '完成' } },
        ] },
      ],
    },
  ]
}

// 合成一个含对话压缩（compaction）的 opencode 会话：c1/c2 被压掉，c3 起为尾巴，c5 是触发器（无正文），c6 是摘要。

export function makeOpencodeDb(sessions) {
  const dbPath = tempDbPath('dsh-opencode-', 'opencode.db')
  const db = openSqliteFixture(dbPath)
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, model TEXT)')
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  for (const s of sessions) {
    db.prepare('INSERT INTO session (id, title, directory, time_created, model) VALUES (?, ?, ?, ?, ?)').run(s.id, s.title, s.directory, s.createdAt, JSON.stringify(s.model))
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

// 往已建好的临时 opencode.db 追加一轮（user + assistant 各一条 text part）。

export function addOpencodeTurn(dbPath, sessionId, baseId, userText, asstText, timeBase) {
  const db = new DatabaseSync(dbPath)
  db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run(baseId + '-u', sessionId, timeBase, JSON.stringify({ role: 'user' }))
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(baseId + '-p1', baseId + '-u', sessionId, timeBase, JSON.stringify({ type: 'text', text: userText }))
  db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run(baseId + '-a', sessionId, timeBase + 1, JSON.stringify({ role: 'assistant' }))
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(baseId + '-p2', baseId + '-a', sessionId, timeBase + 1, JSON.stringify({ type: 'text', text: asstText }))
  db.close()
}

// 从临时 opencode.db 删除指定 message（含其 parts）。

export function deleteOpencodeMessages(dbPath, ids) {
  const db = new DatabaseSync(dbPath)
  for (const id of ids) {
    db.prepare('DELETE FROM part WHERE message_id = ?').run(id)
    db.prepare('DELETE FROM message WHERE id = ?').run(id)
  }
  db.close()
}

export function kimiCodeWire(recs, tsBase = 1786888277773) {
  const lines = [JSON.stringify({ type: 'metadata', protocol_version: '1', created_at: tsBase })]
  recs.forEach((r, i) => lines.push(JSON.stringify({ ...r, time: tsBase + i })))
  return lines.join('\n')
}

export function kimiCodeEv(type, data = {}) { return { type, ...data } }

export async function invokeImportRoute(route, body) {
  const req = { async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } }
  const res = {
    status: null, headers: null, body: null,
    writeHead(s, h) { this.status = s; this.headers = h },
    end(b) { this.body = b },
  }
  await route.handler(req, res)
  return { res, data: JSON.parse(res.body) }
}
