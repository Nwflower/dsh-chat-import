// goose.test.mjs — Goose 源转换核心单元测试 + import_chat 集成测试（假宿主见 _support/fake-host.mjs；自包含合成数据，不掺真实会话）
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { convertGooseJson, gooseDataDir, gooseSessionsDir, gooseDefaultDbPath } from '../lib/convert/goose.mjs'
import { SESSION_FORMAT_VERSION } from '../lib/convert/core.mjs'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { apply } from '../lib/index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { hostAbs } from './_support/host-path.mjs'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { clearScanCache } from '../lib/discovery.mjs'
import { assertToolPairing } from './_support/session-invariants.mjs'
import { freshDshHome, tempDbPath, openSqliteFixture } from './_support/tmp-db.mjs'

// 集成用例隔离：每个用例独立 DSH_HOME（registry 落盘在 $DSH_HOME/dsh-chat-import），
// 进程内共享的扫描缓存每用例清空。
beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
})

const SID = '20260422_3'
const CWD = '/home/u/repo'
const TS = 1745343730000

// goose 的 messages 一行一条消息，content_json 是整个块数组
function msg(role, content, over = {}) {
  return { role, createdTimestamp: TS, content, ...over }
}
function textBlock(text) {
  return { type: 'text', text }
}
function toolRequest(id, name, args) {
  return { type: 'toolRequest', id, tool_call: { status: 'success', value: { name, arguments: args } } }
}
function toolResponse(id, value, status = 'success') {
  return {
    type: 'toolResponse',
    id,
    tool_result: status === 'error' ? { status: 'error', error: String(value) } : { status: 'success', value },
  }
}
function session(messages, over = {}) {
  return JSON.stringify({
    id: SID, name: '修登录页分页', description: '', workingDir: CWD,
    providerName: 'anthropic', sessionType: 'user', parentSessionId: '',
    createdAt: TS, updatedAt: TS + 1000, messages, ...over,
  })
}

test('简单轮次：user 文本开轮、标题取 name、cwd/创建时间落 meta', () => {
  const out = convertGooseJson(session([
    msg('user', [textBlock('修一下登录页分页')]),
    msg('assistant', [textBlock('已修好。')]),
  ]), { createdAt: TS, sourcePath: '/home/u/.local/share/goose/sessions/sessions.db' })
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.id, 'import-' + SID)
  assert.equal(out.meta.sourceId, SID)
  assert.equal(out.meta.cwd, CWD)
  assert.equal(out.meta.createdAt, TS)
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].prompt, '修一下登录页分页')
  assert.equal(out.messages, 2) // user + assistant（环境变更声明不计）
  assert.equal(out.toolCalls, 0)
  assert.equal(out.title, '修登录页分页')
  // 有显式标题 → 钉 session/title 事件
  assert.equal(out.events.filter((e) => e.type === 'session/title').length, 1)
})

test('thinking + toolRequest（信封 value）+ toolResponse → 同一步推理/调用/结果且配对', () => {
  const out = convertGooseJson(session([
    msg('user', [textBlock('读一下 a.ts')]),
    msg('assistant', [
      { type: 'thinking', thinking: '先读文件', signature: '' },
      toolRequest('call_1', 'read_file', { path: 'a.ts' }),
    ]),
    msg('user', [toolResponse('call_1', { content: [{ type: 'text', text: 'export const a = 1' }] })]),
    msg('assistant', [textBlock('只有一个导出。')]),
  ]), { createdAt: TS })
  assert.equal(out.turns.length, 1) // 结果载体不开新轮
  assert.equal(out.turns[0].steps.length, 2)
  const [s1] = out.turns[0].steps
  assert.deepEqual(s1.content[0], { type: 'reasoning', text: '先读文件' })
  assert.deepEqual(s1.toolCalls, [{ type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' }])
  assert.deepEqual(s1.toolResults[0].content, [{ type: 'text', text: 'export const a = 1' }])
  assert.equal(s1.toolResults[0].isError, false)
  assert.equal(out.toolCalls, 1)
  assert.equal(out.droppedToolResults, 0)
  assertToolPairing(out.events)
})

test('toolResponse 的 error 信封与 value.isError 都记为错误；字符串结果原样保留', () => {
  const out = convertGooseJson(session([
    msg('user', [textBlock('跑两条命令')]),
    msg('assistant', [toolRequest('c_ok', 'bash', { cmd: 'a' }), toolRequest('c_bad', 'bash', { cmd: 'b' })]),
    // 结果分两条消息到达（乱序：先 bad 后 ok）
    msg('user', [toolResponse('c_bad', 'command failed', 'error')]),
    msg('user', [toolResponse('c_ok', 'ok')]),
  ]), { createdAt: TS })
  const step = out.turns[0].steps[0]
  assert.deepEqual(step.toolResults.map((r) => r.toolCallId), ['c_ok', 'c_bad']) // 按 call 顺序对齐
  const byId = new Map(step.toolResults.map((r) => [r.toolCallId, r]))
  assert.equal(byId.get('c_bad').isError, true)
  assert.deepEqual(byId.get('c_bad').content, [{ type: 'text', text: 'command failed' }])
  assert.deepEqual(byId.get('c_ok').content, [{ type: 'text', text: 'ok' }])
  assertToolPairing(out.events)
})

test('value.isError=true（信封 status 仍 success）也标记为错误结果', () => {
  const out = convertGooseJson(session([
    msg('user', [textBlock('跑')]),
    msg('assistant', [toolRequest('c1', 'bash', {})]),
    msg('user', [toolResponse('c1', { content: [{ type: 'text', text: 'boom' }], isError: true })]),
  ]), { createdAt: TS })
  assert.equal(out.turns[0].steps[0].toolResults[0].isError, true)
})

test('旧形状 {type:reasoning} 兼容；redactedThinking / image / 交互块计入 skippedBlocks', () => {
  const out = convertGooseJson(session([
    msg('user', [textBlock('问题')]),
    msg('assistant', [
      { type: 'reasoning', text: '旧形状推理' },
      { type: 'redactedThinking', data: 'opaque' },
      { type: 'image', data: 'base64' },
      toolRequest('c1', 'bash', {}),
    ]),
    msg('user', [
      toolResponse('c1', 'ok'),
      { type: 'actionRequired', action: 'confirm' },
      { type: 'toolConfirmationRequest', id: 'x' },
    ]),
  ]), { createdAt: TS })
  const step = out.turns[0].steps[0]
  assert.deepEqual(step.content[0], { type: 'reasoning', text: '旧形状推理' })
  assert.equal(out.skippedBlocks, 4) // redactedThinking + image（assistant）+ actionRequired + toolConfirmationRequest（user）
  assertToolPairing(out.events)
})

test('结果载体附带的人类正文挂到该步，不开新轮也不丢文本', () => {
  const out = convertGooseJson(session([
    msg('user', [textBlock('跑一下')]),
    msg('assistant', [toolRequest('c1', 'bash', {})]),
    msg('user', [toolResponse('c1', 'ok'), textBlock('顺便把这个也改了')]),
  ]), { createdAt: TS })
  assert.equal(out.turns.length, 1)
  const step = out.turns[0].steps[0]
  assert.equal(step.toolResults.length, 1)
  assert.deepEqual(step.content.filter((b) => b.type === 'text'), [{ type: 'text', text: '顺便把这个也改了' }])
})

test('孤儿 toolResponse 丢弃并计数；重复 callId 只保留首次', () => {
  const orphan = convertGooseJson(session([
    msg('user', [textBlock('问题')]),
    msg('assistant', [textBlock('回答')]),
    msg('user', [toolResponse('call_missing', '来路不明')]),
  ]), { createdAt: TS })
  assert.equal(orphan.droppedToolResults, 1)
  assert.equal(orphan.events.filter((e) => e.type === 'tool/result').length, 0)

  const dup = convertGooseJson(session([
    msg('user', [textBlock('看看')]),
    msg('assistant', [toolRequest('dup', 'read_file', { path: 'a.ts' })]),
    msg('assistant', [toolRequest('dup', 'read_file', { path: 'a.ts' }), textBlock('重发')]),
    msg('user', [toolResponse('dup', '内容')]),
  ]), { createdAt: TS })
  assert.equal(dup.droppedDuplicateCalls, 1)
  assert.equal(dup.toolCalls, 1)
  assert.deepEqual(dup.turns[0].steps[1].content.map((b) => b.type), ['text'])
  assertToolPairing(dup.events)
})

test('status:error 的 toolRequest（无 value）跳过并计数', () => {
  const out = convertGooseJson(session([
    msg('user', [textBlock('问题')]),
    msg('assistant', [
      { type: 'toolRequest', id: 'bad', tool_call: { status: 'error', error: 'invalid arguments' } },
      textBlock('我来换个方式'),
    ]),
  ]), { createdAt: TS })
  assert.equal(out.toolCalls, 0)
  assert.equal(out.skippedBlocks, 1)
  assert.deepEqual(out.turns[0].steps[0].content, [{ type: 'text', text: '我来换个方式' }])
})

test('子代理 / 隐藏会话不单独成会话', () => {
  const sub = convertGooseJson(session([
    msg('user', [textBlock('子任务')]),
    msg('assistant', [textBlock('完成')]),
  ], { sessionType: 'sub_agent', parentSessionId: '20260422_1' }), { createdAt: TS })
  assert.equal(sub.meta, null)
  assert.match(sub.skipReason, /^Goose sub_agent session/)
  assert.equal(sub.events.length, 0)

  const hidden = convertGooseJson(session([], { sessionType: 'hidden' }), { createdAt: TS })
  assert.match(hidden.skipReason, /^Goose hidden session/)
})

test('标题回退：name 空则用 description，都空则首问兜底（不钉事件）', () => {
  const byDescription = convertGooseJson(session([
    msg('user', [textBlock('随便问问')]),
    msg('assistant', [textBlock('嗯')]),
  ], { name: '', description: '遗留描述标题' }), { createdAt: TS })
  assert.equal(byDescription.title, '遗留描述标题')
  assert.equal(byDescription.events.filter((e) => e.type === 'session/title').length, 1)

  const byPrompt = convertGooseJson(session([
    msg('user', [textBlock('首个提问当作标题')]),
    msg('assistant', [textBlock('好')]),
  ], { name: '', description: '' }), { createdAt: TS })
  assert.equal(byPrompt.title, '首个提问当作标题')
  assert.equal(byPrompt.events.filter((e) => e.type === 'session/title').length, 0)
})

test('系统提示词只在开关开启时收集为上下文注入', () => {
  const raw = session([
    msg('user', [textBlock('问题')]),
    msg('assistant', [textBlock('答')]),
  ], { systemPrompt: '你是 Goose。' })
  const hasText = (out, needle) => out.events.some((e) => e.data && Array.isArray(e.data.content)
    && e.data.content.some((b) => typeof b.text === 'string' && b.text.includes(needle)))
  assert.equal(hasText(convertGooseJson(raw, { createdAt: TS }), '你是 Goose。'), false)
  assert.equal(hasText(convertGooseJson(raw, { createdAt: TS, importSystemPrompt: true }), '你是 Goose。'), true)
})

test('创建时间兜底优先级：args.createdAt > 会话 createdAt > 首条消息时间', () => {
  const byArgs = convertGooseJson(session([
    msg('user', [textBlock('问')]),
    msg('assistant', [textBlock('答')]),
  ]), { createdAt: 1700000000000 })
  assert.equal(byArgs.meta.createdAt, 1700000000000)

  const bySession = convertGooseJson(session([
    msg('user', [textBlock('问')]),
    msg('assistant', [textBlock('答')]),
  ]), {})
  assert.equal(bySession.meta.createdAt, TS)

  const byMessage = convertGooseJson(JSON.stringify({
    id: SID, name: 'n', workingDir: CWD, createdAt: null, messages: [msg('user', [textBlock('问')]), msg('assistant', [textBlock('答')])],
  }), {})
  assert.equal(byMessage.meta.createdAt, TS)
})

test('非 Goose 结构（无 messages 数组 / 非法 JSON）→ skipReason，不产出事件', () => {
  const noMessages = convertGooseJson(JSON.stringify({ id: SID, rows: [] }))
  assert.equal(noMessages.meta, null)
  assert.equal(noMessages.skipReason, 'not a Goose session (no messages array)')

  const bad = convertGooseJson('{not json')
  assert.equal(bad.skipReason, 'not a Goose session (invalid JSON)')
})

test('路径解析：GOOSE_PATH_ROOT 仅绝对路径生效，三平台默认根各自正确', () => {
  const home = join('home', 'u')
  const p = join   // 本机平台口径（跨平台断言用 posix.join/win32.join 显式指定）
  assert.equal(gooseDataDir(home, { GOOSE_PATH_ROOT: join('rel', 'root') }, process.platform),
    p(home, '.local', 'share', 'goose'))
  assert.equal(gooseDataDir(home, { GOOSE_PATH_ROOT: 'D:\\g' }, 'win32'), 'D:\\g\\data')
  assert.equal(gooseDataDir('/h/u', { GOOSE_PATH_ROOT: '/mnt/d/g' }, 'linux'), '/mnt/d/g/data')
  assert.equal(gooseSessionsDir(home, {}, process.platform), p(home, '.local', 'share', 'goose', 'sessions'))
  assert.equal(gooseSessionsDir('/h/u', {}, 'darwin'), '/h/u/Library/Application Support/Block/goose/sessions')
  assert.equal(gooseSessionsDir('C:\\Users\\u', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32'),
    'C:\\Users\\u\\AppData\\Roaming\\Block\\goose\\data\\sessions')
  assert.equal(gooseDefaultDbPath(home, {}, process.platform), p(home, '.local', 'share', 'goose', 'sessions', 'sessions.db'))
})

// ---- import_goose 集成（真实 SQLite 临时库） ----

// 合成 Goose 会话库（sessions/messages 两表，schema 对齐 lib/sources/goose.mjs 头部契约）。
const GOOSE_CWD = hostAbs('D:/demo/goose-proj')
const GOOSE_TS = 1745343730 // Unix 秒（goose 的 created_timestamp 是整数）
function gooseFixtureSessions() {
  const text = (t) => [{ type: 'text', text: t }]
  return [
    {
      id: '20260422_1',
      name: '修登录页分页',
      description: '',
      workingDir: GOOSE_CWD,
      sessionType: 'user',
      parent: null,
      messages: [
        { role: 'user', ts: GOOSE_TS, content: text('修一下登录页分页') },
        {
          role: 'assistant',
          ts: GOOSE_TS + 1,
          content: [
            { type: 'thinking', thinking: '先读文件', signature: '' },
            { type: 'toolRequest', id: 'call_1', tool_call: { status: 'success', value: { name: 'read_file', arguments: { path: 'a.ts' } } } },
          ],
        },
        { role: 'user', ts: GOOSE_TS + 2, content: [{ type: 'toolResponse', id: 'call_1', tool_result: { status: 'success', value: { content: [{ type: 'text', text: 'export const a = 1' }] } } }] },
        { role: 'assistant', ts: GOOSE_TS + 3, content: text('只有一个导出。') },
      ],
    },
    {
      id: '20260422_2',
      name: '',
      description: '遗留描述标题',
      workingDir: GOOSE_CWD,
      sessionType: 'user',
      parent: null,
      messages: [
        { role: 'user', ts: GOOSE_TS + 10, content: text('第二个会话') },
        { role: 'assistant', ts: GOOSE_TS + 11, content: text('好') },
      ],
    },
    // 子代理会话：带 parent_session_id，不单独成会话
    {
      id: '20260422_3',
      name: '子任务',
      description: '',
      workingDir: GOOSE_CWD,
      sessionType: 'sub_agent',
      parent: '20260422_1',
      messages: [
        { role: 'user', ts: GOOSE_TS + 20, content: text('子任务提问') },
        { role: 'assistant', ts: GOOSE_TS + 21, content: text('子任务回答') },
      ],
    },
  ]
}

function makeGooseDb(sessions) {
  const dbPath = tempDbPath('dsh-goose-', 'sessions.db')
  const db = openSqliteFixture(dbPath)
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
    session_type TEXT NOT NULL DEFAULT 'user', working_dir TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    provider_name TEXT, parent_session_id TEXT)`)
  db.exec(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
    content_json TEXT NOT NULL, created_timestamp INTEGER NOT NULL, metadata_json TEXT)`)
  for (const s of sessions) {
    db.prepare('INSERT INTO sessions (id, name, description, session_type, working_dir, created_at, updated_at, provider_name, parent_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.id, s.name, s.description, s.sessionType, s.workingDir, '2026-04-22 17:40:00', '2026-04-22 17:42:10', 'anthropic', s.parent)
    for (const m of s.messages) {
      db.prepare('INSERT INTO messages (session_id, role, content_json, created_timestamp) VALUES (?, ?, ?, ?)')
        .run(s.id, m.role, JSON.stringify(m.content), m.ts)
    }
  }
  db.close()
  return dbPath
}

test('import_goose 单库文件：批量形态、逐会话落盘、子代理不导入、schema 校验', async () => {
  const dbPath = makeGooseDb(gooseFixtureSessions())
  const { ctx, persistence, attached } = makeCtx({}) // stat 不在 tree 里 → 按真实 DB 文件处理
  apply(ctx)
  const def = chatDef(ctx, 'goose')
  const value = await def.execute({ path: dbPath })

  assert.equal(value.mode, 'batch') // 单 .db 也恒批量
  assert.equal(value.total, 2) // 读取层已滤掉子代理会话（parent_session_id / sub_agent）
  assert.equal(value.imported, 2)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const first = persistence.sessions.get('import-20260422_1')
  assert.ok(first)
  assert.equal(first.meta.cwd, GOOSE_CWD)
  // 创建时间取会话级 created_at（CURRENT_TIMESTAMP 文本按 **UTC** 解析；按本地时区会偏几小时）
  assert.equal(first.meta.createdAt, Date.parse('2026-04-22T17:40:00Z'))
  assert.match(first.events.at(-1).data.title, /^Goose · /)
  assert.ok(first.events.every((e, i) => e.seq === i))
  assertEnvelopeHygiene(first.events)

  // 工具配对 + 推理块
  const result = first.events.find((e) => e.type === 'tool/result')
  assert.deepEqual(result.sourceEventSeqs, [first.events.find((e) => e.type === 'tool/call').seq])
  assert.equal(result.data.message.content[0].content[0].text, 'export const a = 1')
  const reasoning = first.events
    .flatMap((e) => (e.type === 'assistant/message' ? e.data.message.content : []))
    .filter((b) => b.type === 'reasoning')
  assert.deepEqual(reasoning, [{ type: 'reasoning', text: '先读文件' }])

  // 标题回退：name 为空 → description
  const second = persistence.sessions.get('import-20260422_2')
  assert.match(second.events.at(-1).data.title, /遗留描述标题/)
  assert.equal(persistence.sessions.has('import-20260422_3'), false)
  assert.equal(attached.length, 2)
})

test('import_goose 目录模式：自动定位 sessions.db；sessionIds 过滤只导所选会话', async () => {
  const dbPath = makeGooseDb(gooseFixtureSessions())
  const dir = join(dbPath, '..')
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'goose')

  const filtered = await def.execute({ path: dir, sessionIds: ['20260422_2'] })
  assert.equal(filtered.mode, 'batch')
  assert.equal(filtered.imported, 1)
  assert.equal(persistence.sessions.has('import-20260422_1'), false)
  assert.equal(persistence.sessions.has('import-20260422_2'), true)
})

test('import_goose 幂等：重复导入同一库只落盘一次', async () => {
  const dbPath = makeGooseDb(gooseFixtureSessions())
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'goose')
  const first = await def.execute({ path: dbPath })
  const second = await def.execute({ path: dbPath })
  assert.equal(first.imported, 2)
  assert.equal(second.imported, 0)
  assert.equal(second.alreadyImported, 2)
  assert.equal(persistence.sessions.size, 2)
})

test('import_goose 读不到 Goose 库：失败大声抛错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-goose-bad-'))
  const bogus = join(dir, 'sessions.db')
  writeFileSync(bogus, 'not a sqlite db')
  const { ctx } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'goose')
  await assert.rejects(() => def.execute({ path: bogus }), /Goose/)
})

test('import_goose preview：SQLite 库逐会话 dry-run（恒批量、零副作用、标题与落盘同口径）', async () => {
  const dbPath = makeGooseDb(gooseFixtureSessions())
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'goose')
  const value = await def.execute({ path: dbPath, preview: true })
  assert.equal(value.mode, 'batch')
  assert.equal(value.preview, true)
  assert.equal(value.total, 2)
  assert.equal(persistence.sessions.size, 0) // 零副作用
  assert.ok(value.results.every((r) => typeof r.title === 'string'))
  assert.ok(value.results.some((r) => r.title.startsWith('Goose · ')))
})
