// test/zcode.test.mjs — REQ-38 zcode 源（z.ai 官方 CLI）单元 + 集成测试（自包含）
//
// converter 单测走真实 convertZcodeJson；import_zcode 集成测试用合成 SQLite fixture
//（真实 temp db.sqlite，session/message/part 三表 + compaction 行）走 mock ctx 的
// apply → register → execute 路径（mock ctx 参考 test/index.test.mjs 的 opencode 用例
// 做最小化：无 listDir/writeText，目录模式不扫描）；db 缺失回退旧 transcript.jsonl。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apply } from '../index.mjs'
import { convertZcodeJson } from '../convert.mjs'
import { readZcodeDb, readZcodeTranscript } from '../lib/zcode.mjs'
import { resolveRegistryDir, loadImports } from '../lib/imports.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

// REQ-24 registry 隔离：每个用例独立 DSH_HOME（registry 落盘在 $DSH_HOME/dsh-chat-import）
beforeEach(() => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-home-'))
})

// fs 版本指纹：内容派生，内容变则 version 变（mock stat 的 version 字段）。
function contentVersion(text) {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
  return 'v' + h
}

// 内存态会话库：create/append/list/inspect（append 强制 seq 连续，引擎契约）。
function makePersistence() {
  const sessions = new Map() // id -> { meta, events: [] }
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

// 最小化 mock ctx：fs（resolve/stat/readText/processPath）+ sessionPersistence +
// workspaceRegistry + tools。tree 外的真实文件（temp SQLite / transcript）走 node:fs stat。
function makeCtx(tree = {}) {
  const persistence = makePersistence()
  const attached = []
  const workspaces = new Map()
  const registered = []
  // 跨平台分隔符归一（与 index.test.mjs makeCtx 同款）：树查找三态命中，防 CI（Linux）红
  const norm = (p) => String(p).replace(/\\/g, '/')
  const lookup = (p) => {
    const f = norm(p)
    return tree[p] ?? tree[f] ?? tree[f.replace(/\//g, '\\')]
  }
  const fs = {
    async resolve(path) { return { targetKey: path, displayPath: path } },
    async stat(target) {
      const path = target.targetKey
      const v = lookup(path)
      if (v !== undefined) {
        return v === 'dir' ? { type: 'directory' } : { type: 'file', size: v.length, version: contentVersion(v) }
      }
      try {
        const s = statSync(path)
        if (s.isDirectory()) return { type: 'directory' }
        return { type: 'file', size: s.size, version: 'real-' + s.size + '-' + s.mtimeMs + '-' + s.ctimeMs }
      } catch {
        return undefined
      }
    },
    async readText(target) {
      const v = lookup(target.targetKey)
      if (v === undefined || v === 'dir') throw new Error('FS_NOT_FOUND ' + target.targetKey)
      return v
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
    webServer: { register() {} }, // REQ-41：apply 注册 /api-import/sessions 路由（zcode 测试不关心）
    // 模拟 Cordis ctx.inject：依赖服务在 ctx 上存在才执行回调（webServer 在场 →
    // 路由注册执行；commands 缺席 → /import 命令不注册，插件照常激活）。
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
    tools: {
      register(def) { registered.push(def); return () => {} },
    },
    on() { return () => {} }, // REQ-53：apply 监听 agent/session-start（本测试不模拟事件）
  }
  ctx.tools.registered = (toolName) => registered.find((d) => d.name === toolName)
  return { ctx, persistence, attached, registered }
}

function registeredDef(ctx, toolName) {
  return ctx.tools.registered(toolName)
}

// 辅助：import_chat 分发器定义——execute 时注入 format（等价旧 import_zcode）
function chatDef(ctx, format = 'zcode') {
  const tool = registeredDef(ctx, 'import_chat')
  return { ...tool, execute: (args) => tool.execute({ format, ...args }) }
}

// 导入归属外置 registry（issue #34）：0.8.3 起日志不再写 session/imported 标记，
// 事件 envelope 键收敛在宿主白名单内（type/seq/time/data/surfaceOp/sourceEventSeqs）。
function assertEnvelopeHygiene(events) {
  assert.ok(events.every((e) => e.type !== 'session/imported'), '日志不得含 session/imported 标记')
  const ALLOWED = new Set(['type', 'seq', 'time', 'data', 'surfaceOp', 'sourceEventSeqs'])
  for (const e of events) {
    for (const key of Object.keys(e)) {
      assert.ok(ALLOWED.has(key), '事件 envelope 出现白名单外键: ' + key)
    }
    assert.equal(typeof e.seq, 'number')
    assert.equal(typeof e.time, 'number')
    assert.notEqual(e.data, undefined)
  }
}

// ── 合成 zcode db fixture（真实 schema：session 主会话 parent_id IS NULL；
//    message/part 无 sequence 列，按 time_created, id 升序） ──────────────

// 两个主会话：zcs-a 带 reasoning + tool 成对（含模型）、zcs-b 纯文本无模型。
function zcodeTestSessions() {
  return [
    {
      id: 'zcs-a',
      parentId: null,
      title: 'Fix zcode build',
      directory: 'E:/demo/zcode',
      timeUpdated: 1786000000000,
      messages: [
        { id: 'zm-a1', time: 1786000000001, data: { role: 'user' }, parts: [
          { id: 'zp-a1', time: 1786000000001, data: { type: 'text', text: '为什么构建失败' } },
        ] },
        { id: 'zm-a2', time: 1786000000002, data: { role: 'assistant', modelID: 'glm-4.5' }, parts: [
          { id: 'zp-a2', time: 1786000000002, data: { type: 'reasoning', text: '看日志' } },
          { id: 'zp-a3', time: 1786000000003, data: { type: 'tool', tool: 'bash', callID: 'call-z1', state: { status: 'completed', input: { command: 'cargo build' }, output: 'Compiling...' } } },
          { id: 'zp-a4', time: 1786000000004, data: { type: 'text', text: '修好了' } },
        ] },
      ],
    },
    {
      id: 'zcs-b',
      parentId: null,
      title: 'Refactor',
      directory: 'E:/demo/zcode',
      timeUpdated: 1786000100000,
      messages: [
        { id: 'zm-b1', time: 1786000100001, data: { role: 'user' }, parts: [
          { id: 'zp-b1', time: 1786000100001, data: { type: 'text', text: '重构模块' } },
        ] },
        { id: 'zm-b2', time: 1786000100002, data: { role: 'assistant' }, parts: [
          { id: 'zp-b2', time: 1786000100002, data: { type: 'text', text: '完成' } },
        ] },
      ],
    },
  ]
}

// 含 compaction 的会话：compaction part 的 data.summary.body 是压缩摘要（正文不进入对话）。
function zcodeCompactedSession() {
  return {
    id: 'zcs-comp',
    parentId: null,
    title: 'Long zcode task',
    directory: 'E:/demo/zcode',
    timeUpdated: 1786000200000,
    messages: [
      { id: 'zm-c1', time: 1786000200001, data: { role: 'user' }, parts: [
        { id: 'zp-c1', time: 1786000200001, data: { type: 'text', text: '继续' } },
      ] },
      { id: 'zm-c2', time: 1786000200002, data: { role: 'assistant' }, parts: [
        { id: 'zp-c2', time: 1786000200002, data: { type: 'text', text: '好的' } },
      ] },
      { id: 'zm-c3', time: 1786000200003, data: { role: 'user' }, parts: [
        { id: 'zp-c3', time: 1786000200003, data: { type: 'compaction', summary: { body: '此前对话的压缩摘要。' }, compactBoundary: { summarizedMessageCount: 20, keptMessageCount: 4 } } },
      ] },
    ],
  }
}

// 在 os.tmpdir() 建临时 zcode db.sqlite（真实 schema 的 session/message/part 三表）。
function makeZcodeDb(sessions) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-zcode-'))
  const dbPath = join(dir, 'db.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_updated INTEGER)')
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT)')
  for (const s of sessions) {
    db.prepare('INSERT INTO session (id, parent_id, title, directory, time_updated) VALUES (?, ?, ?, ?, ?)').run(s.id, s.parentId, s.title, s.directory, s.timeUpdated)
    for (const m of s.messages) {
      db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run(m.id, s.id, m.time, JSON.stringify(m.data))
      for (const p of m.parts) {
        db.prepare('INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)').run(p.id, m.id, p.time, JSON.stringify(p.data))
      }
    }
  }
  db.close()
  return dbPath
}

// 旧版 transcript.jsonl fixture：最后一条 model_request 的 payload.messages 是权威
// 消息流（OpenAI 风格）；system 跳过、<system-reminder> user 过滤、tool 结果回填。
function zcodeTranscriptFixture() {
  const messages = [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: '<system-reminder>系统注入提醒</system-reminder>\n请忽略这条' },
    { role: 'assistant', content: '（注入的回复，不应进入对话）' },
    { role: 'user', content: '帮我查一下' },
    { role: 'assistant', content: '好的', model: 'glm-4.5', tool_calls: [{ id: 'call-t1', type: 'function', function: { name: 'search_files', arguments: '{"q":"x"}' } }] },
    { role: 'tool', tool_call_id: 'call-t1', content: '找到了结果' },
    { role: 'assistant', content: '完成' },
  ]
  return [
    JSON.stringify({ type: 'model_request', payload: { messages } }),
    JSON.stringify({ type: 'other', payload: {} }),
  ].join('\n') + '\n'
}

// 在临时目录写 transcript.jsonl（可带 metadata.json 的 cwd）。
function writeZcodeTranscript() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-zcode-tx-'))
  const txPath = join(dir, 'transcript.jsonl')
  writeFileSync(txPath, zcodeTranscriptFixture(), 'utf8')
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ cwd: 'E:/demo/zcode-old' }), 'utf8')
  return { dir, txPath }
}

// ── convertZcodeJson 纯函数单测 ─────────────────────────────────────────

test('convertZcodeJson: 简单问答、元数据、平衡回合', () => {
  const raw = JSON.stringify({
    id: 'zcs-a',
    title: 'Fix zcode build',
    directory: 'E:/demo/zcode',
    createdAt: 1786000000000,
    messages: [
      { id: 'zm-a1', role: 'user', createdAt: 1, parts: [{ type: 'text', text: '为什么构建失败' }] },
      { id: 'zm-a2', role: 'assistant', createdAt: 2, modelID: 'glm-4.5', parts: [{ type: 'text', text: '是缺依赖，补上即可。' }] },
    ],
  })
  const out = convertZcodeJson(raw, { sourcePath: 'E:/demo/zcode/db.sqlite' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 2)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.meta.id, 'import-zcs-a')
  assert.equal(out.meta.sourceId, 'zcs-a')
  assert.equal(out.meta.version, 0)
  assert.equal(out.meta.cwd, 'E:/demo/zcode')
  assert.equal(out.meta.createdAt, 1786000000000)
  assert.equal(out.title, 'Fix zcode build')
  assertEnvelopeHygiene(out.events)
  const types = out.events.map((e) => e.type)
  assert.deepEqual(types, [
    'user/message', 'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end', 'session/title',
  ])
  out.events.forEach((e, i) => assert.equal(e.seq, i))
  for (const e of out.events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result')) {
    assert.equal(e.surfaceOp, 'append')
  }
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.source, { kind: 'model', provider: 'zcode', model: 'glm-4.5' })
  const titleEv = out.events.find((e) => e.type === 'session/title')
  assert.equal(titleEv.data.title, 'Fix zcode build')
})

test('convertZcodeJson: tool 成对输出（call + result）、sourceEventSeqs、isError', () => {
  const raw = JSON.stringify({
    id: 'zcs-t',
    createdAt: 1786000000000,
    messages: [
      { id: 'm1', role: 'user', createdAt: 1, parts: [{ type: 'text', text: '跑一下' }] },
      {
        id: 'm2', role: 'assistant', createdAt: 2, parts: [
          { type: 'tool', tool: 'bash', callID: 'call-ok', state: { status: 'completed', input: { command: 'npm test' }, output: 'all passed' } },
          { type: 'tool', tool: 'bash', callID: 'call-bad', state: { status: 'error', input: { command: 'bad' }, output: 'boom' } },
        ],
      },
    ],
  })
  const out = convertZcodeJson(raw)
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 2)
  const calls = out.events.filter((e) => e.type === 'tool/call')
  const results = out.events.filter((e) => e.type === 'tool/result')
  assert.equal(calls.length, 2)
  assert.equal(results.length, 2)
  assert.equal(calls[0].data.name, 'bash')
  assert.equal(calls[0].data.callId, 'call-ok')
  assert.equal(calls[0].data.arguments, '{"command":"npm test"}')
  assert.deepEqual(results[0].sourceEventSeqs, [calls[0].seq])
  assert.equal(results[0].data.message.content[0].toolCallId, 'call-ok')
  assert.equal(results[0].data.message.content[0].content[0].text, 'all passed')
  assert.equal(results[0].data.message.content[0].isError, undefined)
  // 错误调用：isError 标记 + sourceEventSeqs 指向自己的 call
  assert.deepEqual(results[1].sourceEventSeqs, [calls[1].seq])
  assert.equal(results[1].data.message.content[0].isError, true)
  // reasoning / text 映射进 assistant content
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  const kinds = asst.content.map((c) => c.type)
  assert.ok(kinds.includes('tool-call'))
  // 成对不变量：call/result 严格 1:1
  assert.equal(out.events.filter((e) => e.type === 'tool/result').length, 2)
})

test('convertZcodeJson: 无 output 的工具调用仍发空 result（成对不变量）', () => {
  const raw = JSON.stringify({
    id: 'zcs-n',
    messages: [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: '查一下' }] },
      { id: 'm2', role: 'assistant', parts: [{ type: 'tool', tool: 'read', callID: 'call-n1', state: { input: { file: 'a.txt' } } }] },
    ],
  })
  const out = convertZcodeJson(raw)
  assert.equal(out.toolCalls, 1)
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.ok(result)
  assert.deepEqual(result.data.message.content[0].content, [{ type: 'text', text: '' }])
  assert.equal(result.data.message.content[0].toolCallId, 'call-n1')
})

test('convertZcodeJson: <system-reminder> 注入 user 消息整条过滤', () => {
  const raw = JSON.stringify({
    id: 'zcs-inj',
    messages: [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: '<system-reminder>系统注入</system-reminder>\n请忽略' }] },
      { id: 'm2', role: 'user', parts: [{ type: 'text', text: '真实提问' }] },
      { id: 'm3', role: 'assistant', parts: [{ type: 'text', text: '真实回答' }] },
    ],
  })
  const out = convertZcodeJson(raw)
  assert.equal(out.turns.length, 1)
  const users = out.events.filter((e) => e.type === 'user/message' && e.data.source.kind === 'user')
  assert.equal(users.length, 1)
  assert.equal(users[0].data.content[0].text, '真实提问')
})

test('convertZcodeJson: compaction 摘要 → 前置 reasoning 块（只前置一次）', () => {
  const raw = JSON.stringify({
    id: 'zcs-comp',
    summary: '此前对话的压缩摘要。',
    messages: [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: '继续' }] },
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: '好的' }] },
    ],
  })
  const out = convertZcodeJson(raw)
  const firstStep = out.turns[0].steps[0]
  assert.equal(firstStep.content[0].type, 'reasoning')
  assert.equal(firstStep.content[0].text, '此前对话的压缩摘要。')
  const reasoning = out.events
    .filter((e) => e.type === 'assistant/message')
    .flatMap((e) => e.data.message.content)
    .filter((c) => c.type === 'reasoning')
  assert.equal(reasoning.length, 1)
})

test('convertZcodeJson: 非法 JSON / 无 messages 返回空并 skipped', () => {
  const bad = convertZcodeJson('not json')
  assert.equal(bad.meta, null)
  assert.equal(bad.skipped, 1)
  assert.deepEqual(bad.events, [])
  assert.deepEqual(bad.turns, [])
  const wrong = convertZcodeJson('{"id":"x"}')
  assert.equal(wrong.meta, null)
  assert.equal(wrong.skipped, 1)
})

test('convertZcodeJson: 模型回退链（modelID → model → provider 名）', () => {
  const raw = JSON.stringify({
    id: 'zcs-m',
    messages: [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'm2', role: 'assistant', model: 'glm-4.5', parts: [{ type: 'text', text: 'a' }] },
      { id: 'm3', role: 'user', parts: [{ type: 'text', text: 'again' }] },
      { id: 'm4', role: 'assistant', parts: [{ type: 'text', text: 'b' }] },
    ],
  })
  const out = convertZcodeJson(raw)
  const sources = out.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message.source)
  assert.equal(sources[0].model, 'glm-4.5')
  assert.equal(sources[1].model, 'zcode') // 无消息级模型 → provider 名
})

// ── readZcodeDb 单测 ────────────────────────────────────────────────────

test('readZcodeDb: 只读抽取、主会话过滤（parent_id IS NULL）、time_created/id 排序', () => {
  // 消息故意乱序插入（time_created 无序），读取必须按 time_created, id 升序重建；
  // 追加一个子会话（parent_id 非空）——主会话过滤必须排除它。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-zcode-'))
  const dbPath = join(dir, 'db.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_updated INTEGER)')
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT)')
  db.prepare('INSERT INTO session (id, parent_id, title, directory, time_updated) VALUES (?, ?, ?, ?, ?)').run('zcs-a', null, 'Fix build', 'E:/demo/zcode', 1786000000000)
  db.prepare('INSERT INTO session (id, parent_id, title, directory, time_updated) VALUES (?, ?, ?, ?, ?)').run('zcs-child', 'zcs-a', 'Subagent', 'E:/demo/zcode', 1786000000500)
  // 乱序插入 message/part：读取按 time_created 升序
  db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run('zm-a2', 'zcs-a', 1786000000002, JSON.stringify({ role: 'assistant' }))
  db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run('zm-a1', 'zcs-a', 1786000000001, JSON.stringify({ role: 'user' }))
  db.prepare('INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)').run('zp-a2b', 'zm-a2', 1786000000004, JSON.stringify({ type: 'text', text: 'b' }))
  db.prepare('INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)').run('zp-a2a', 'zm-a2', 1786000000003, JSON.stringify({ type: 'text', text: 'a' }))
  db.prepare('INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)').run('zp-a1', 'zm-a1', 1786000000001, JSON.stringify({ type: 'text', text: '问题' }))
  db.close()

  const sessions = readZcodeDb(dbPath)
  assert.equal(sessions.length, 1) // 子会话被过滤
  const a = sessions[0]
  assert.equal(a.id, 'zcs-a')
  assert.equal(a.title, 'Fix build')
  assert.equal(a.directory, 'E:/demo/zcode')
  assert.equal(a.createdAt, 1786000000000)
  assert.equal(a.messages.length, 2)
  assert.equal(a.messages[0].id, 'zm-a1')
  assert.equal(a.messages[1].id, 'zm-a2')
  // part 同按 time_created 升序
  assert.deepEqual(a.messages[1].parts.map((p) => p.text), ['a', 'b'])
})

test('readZcodeDb: compaction part 摘要抽到会话级 summary；消息级 summary 兜底', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-zcode-'))
  const dbPath = join(dir, 'db.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_updated INTEGER)')
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT)')
  db.prepare('INSERT INTO session (id, parent_id, title, directory, time_updated) VALUES (?, ?, ?, ?, ?)').run('s1', null, 'T1', 'E:/demo/zcode', 1)
  db.prepare('INSERT INTO session (id, parent_id, title, directory, time_updated) VALUES (?, ?, ?, ?, ?)').run('s2', null, 'T2', 'E:/demo/zcode', 2)
  // s1：compaction part 带 summary.body
  db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run('m1', 's1', 1, JSON.stringify({ role: 'user' }))
  db.prepare('INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)').run('p1', 'm1', 1, JSON.stringify({ type: 'compaction', summary: { body: 'part 级摘要。' } }))
  // s2：无 compaction part，摘要挂在消息级 data.summary.body（兜底，整条不进入对话）
  db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run('m2', 's2', 1, JSON.stringify({ role: 'user', summary: { body: '消息级摘要。' } }))
  db.prepare('INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)').run('p2', 'm2', 1, JSON.stringify({ type: 'text', text: '（引导语）' }))
  db.close()

  const sessions = readZcodeDb(dbPath)
  const [s1, s2] = sessions
  assert.equal(s1.summary, 'part 级摘要。')
  assert.equal(s1.messages.length, 1) // compaction part 不进对话，消息保留（无正文 parts）
  assert.equal(s1.messages[0].parts.length, 0)
  assert.equal(s2.summary, '消息级摘要。')
  assert.equal(s2.messages.length, 0) // 摘要消息（引导语）整条不进对话
})

// ── readZcodeTranscript 单测（旧格式回退） ───────────────────────────────

test('readZcodeTranscript: 旧格式 model_request → 中间 JSON（工具结果回填、system 跳过、cwd）', () => {
  const { txPath } = writeZcodeTranscript()
  const [session] = readZcodeTranscript(txPath)
  assert.ok(session.id)
  assert.equal(session.directory, 'E:/demo/zcode-old') // metadata.json 的 cwd
  // system 消息跳过；注入 user（含 <system-reminder>）与注入回复仍保留在中间 JSON
  //（<system-reminder> 过滤在 converter 层做，readZcodeTranscript 只做格式归一）
  assert.equal(session.messages.length, 5) // user(注入) + assistant(注入回复) + user(真实) + assistant(tool) + assistant
  const toolMsg = session.messages[3]
  assert.equal(toolMsg.role, 'assistant')
  assert.equal(toolMsg.model, 'glm-4.5')
  const toolPart = toolMsg.parts.find((p) => p.type === 'tool')
  assert.ok(toolPart)
  assert.equal(toolPart.tool, 'search_files')
  assert.equal(toolPart.callID, 'call-t1')
  assert.deepEqual(toolPart.state.input, { q: 'x' })
  assert.equal(toolPart.state.output, '找到了结果') // role=tool 结果回填
})

// ── import_zcode 集成（真实 temp SQLite / transcript） ──────────────────

test('import_zcode 单库文件：批量形态、逐会话落盘、schema 校验', async () => {
  const dbPath = makeZcodeDb(zcodeTestSessions())
  const { ctx, persistence, attached } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'zcode')
  const value = await def.execute({ path: dbPath })

  assert.equal(value.mode, 'batch') // 单 .db 也恒批量
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.equal(value.alreadyImported, 0)
  assert.equal(value.skipped, 0)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const savedA = persistence.sessions.get('import-zcs-a')
  assert.ok(savedA)
  assert.equal(savedA.meta.cwd, 'E:/demo/zcode')
  assert.equal(savedA.meta.createdAt, 1786000000000)
  assert.equal(savedA.events.at(-1).type, 'session/title')
  assert.ok(savedA.events.every((e, i) => e.seq === i))
  assertEnvelopeHygiene(savedA.events)
  // tool/call + tool/result 关联落盘
  const call = savedA.events.find((e) => e.type === 'tool/call')
  const result = savedA.events.find((e) => e.type === 'tool/result')
  assert.equal(call.data.callId, 'call-z1')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.equal(result.data.message.content[0].content[0].text, 'Compiling...')
  // 消息级模型（zcs-a 有 modelID、zcs-b 无 → 回退 provider 名）
  const asstA = savedA.events.find((e) => e.type === 'assistant/message').data.message
  assert.equal(asstA.source.model, 'glm-4.5')
  const savedB = persistence.sessions.get('import-zcs-b')
  assert.ok(savedB)
  const asstB = savedB.events.find((e) => e.type === 'assistant/message').data.message
  assert.equal(asstB.source.model, 'zcode')
  // 有 cwd → 归组两个会话
  assert.equal(attached.length, 2)
})

test('import_zcode 目录模式：自动定位 db.sqlite、schema 校验', async () => {
  const dbPath = makeZcodeDb(zcodeTestSessions())
  const dirPath = dirname(dbPath)
  const { ctx, persistence } = makeCtx({ [dirPath]: 'dir' }) // stat 命中 → 目录分支
  apply(ctx)
  const def = chatDef(ctx, 'zcode')
  const value = await def.execute({ path: dirPath })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  assert.equal(persistence.sessions.size, 2)
})

test('import_zcode zcode:// 伪路径：走默认库只导该会话、幂等', async () => {
  const dbPath = makeZcodeDb(zcodeTestSessions())
  const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-zcode-home-'))
  const fakeDbDir = join(fakeHome, '.zcode', 'cli', 'db')
  mkdirSync(fakeDbDir, { recursive: true })
  copyFileSync(dbPath, join(fakeDbDir, 'db.sqlite'))
  const oldUserProfile = process.env.USERPROFILE
  const oldHome = process.env.HOME
  process.env.USERPROFILE = fakeHome
  process.env.HOME = fakeHome
  try {
    const { ctx, persistence } = makeCtx({})
    apply(ctx)
    const def = chatDef(ctx, 'zcode')
    const value = await def.execute({ path: 'zcode://zcs-a' })

    assert.equal(value.mode, 'batch')
    assert.equal(value.total, 2) // 库里 2 个主会话，只处理被选中的
    assert.equal(value.imported, 1)
    assert.equal(value.results.length, 1)
    assert.equal(value.results[0].sessionId, 'import-zcs-a')
    assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
    const saved = persistence.sessions.get('import-zcs-a')
    assert.ok(saved)
    // 幂等键 = 伪路径原始字符串（fs.resolve 会归一化掉 '://' 前缀，不能用 displayPath）
    assertEnvelopeHygiene(saved.events)
    assert.equal(persistence.sessions.size, 1)

    // 幂等：重导同一伪路径 → already-imported
    const second = await def.execute({ path: 'zcode://zcs-a' })
    assert.equal(second.imported, 0)
    assert.equal(second.alreadyImported, 1)
    assert.equal(persistence.sessions.size, 1)
  } finally {
    if (oldUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = oldUserProfile
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
  }
})

test('import_zcode compaction：摘要还原为上下文 reasoning、0 skipped', async () => {
  const dbPath = makeZcodeDb([zcodeCompactedSession()])
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'zcode')
  const value = await def.execute({ path: dbPath })

  assert.equal(value.mode, 'batch')
  assert.equal(value.imported, 1)
  assert.equal(value.skipped, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  const saved = persistence.sessions.get('import-zcs-comp')
  assert.ok(saved)
  const reasoning = saved.events
    .filter((e) => e.type === 'assistant/message')
    .flatMap((e) => e.data.message.content)
    .filter((c) => c.type === 'reasoning')
  assert.equal(reasoning.length, 1)
  assert.equal(reasoning[0].text, '此前对话的压缩摘要。')
  // compaction 结构块不产生内容；摘要消息不产生空回合
  assert.ok(!saved.events.some((e) => e.data && e.data.message && e.data.message.content.some((c) => c.type === 'compaction')))
  assert.equal(saved.events.filter((e) => e.type === 'user/message' && e.data.source.kind === 'user').length, 1)
})

test('import_zcode sessionIds 过滤：只导指定源会话', async () => {
  const dbPath = makeZcodeDb(zcodeTestSessions())
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'zcode')
  const value = await def.execute({ path: dbPath, sessionIds: ['zcs-b'] })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2) // 库里 2 个会话，只处理被选中的
  assert.equal(value.imported, 1)
  assert.equal(value.results.length, 1)
  assert.equal(value.results[0].sessionId, 'import-zcs-b')
  assert.equal(persistence.sessions.size, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('import_zcode 幂等：重复导入同一库只落盘一次', async () => {
  const dbPath = makeZcodeDb(zcodeTestSessions())
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'zcode')
  const first = await def.execute({ path: dbPath })
  const second = await def.execute({ path: dbPath })

  assert.equal(first.imported, 2)
  assert.equal(second.imported, 0)
  assert.equal(second.alreadyImported, 2)
  assert.equal(persistence.sessions.size, 2)
})

test('import_zcode db 缺失回退 transcript.jsonl：不报错、0 skipped', async () => {
  const { txPath } = writeZcodeTranscript()
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'zcode')
  const value = await def.execute({ path: txPath })

  assert.equal(value.mode, 'batch')
  assert.equal(value.imported, 1)
  assert.equal(value.skipped, 0)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  // 会话 id 取 transcript 所在目录名
  const sid = 'import-' + basename(dirname(txPath))
  const saved = persistence.sessions.get(sid)
  assert.ok(saved)
  assert.equal(saved.meta.cwd, 'E:/demo/zcode-old') // metadata.json 的 cwd
  assertEnvelopeHygiene(saved.events)
  // 注入 user 被过滤（不产生回合）；工具调用成对
  assert.equal(saved.events.filter((e) => e.type === 'user/message' && e.data.source.kind === 'user').length, 1)
  const call = saved.events.find((e) => e.type === 'tool/call')
  const result = saved.events.find((e) => e.type === 'tool/result')
  assert.equal(call.data.name, 'search_files')
  assert.equal(call.data.arguments, '{"q":"x"}')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.equal(result.data.message.content[0].content[0].text, '找到了结果')
  // 幂等键 = transcript 文件路径
  const reg = await loadImports(resolveRegistryDir())
  assert.ok(reg.imports[txPath])
})

test('import_zcode 读不到 DB：失败大声抛错', async () => {
  const { ctx } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'zcode')
  await assert.rejects(() => def.execute({ path: join(tmpdir(), 'no-such-zcode.db') }))
})
