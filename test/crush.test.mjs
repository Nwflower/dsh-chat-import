// crush.test.mjs — Crush 源转换核心单元测试 + import_chat 集成测试（假宿主见 _support/fake-host.mjs；自包含合成数据，不掺真实会话）
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  convertCrushJson, parseCrushProjects, crushUserDataDir, crushRegistryPath, crushProjectDbPath,
} from '../lib/convert/crush.mjs'
import { SESSION_FORMAT_VERSION } from '../lib/convert/core.mjs'
import { assertNativeCompaction, derivedSurfaceMessages } from './_support/compaction.mjs'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apply } from '../lib/index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { clearScanCache } from '../lib/discovery.mjs'

// 集成用例隔离：每个用例独立 DSH_HOME（registry 落盘在 $DSH_HOME/dsh-chat-import），
// 进程内共享的扫描缓存每用例清空。
beforeEach(() => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  clearScanCache()
})

// 配对不变量：每个 tool/call 都有对应 tool/result，且 result 的 sourceEventSeqs
// 指向其 tool/call 的 seq（synthesizeSession 兜底保证，见 core.mjs）。
function assertToolPairing(events) {
  const calls = events.filter((e) => e.type === 'tool/call')
  const results = events.filter((e) => e.type === 'tool/result')
  assert.equal(results.length, calls.length, `tool/call(${calls.length}) 与 tool/result(${results.length}) 一致`)
  const resultByCall = new Map(results.map((r) => [r.data.message.content[0].toolCallId, r]))
  for (const c of calls) {
    const r = resultByCall.get(c.data.callId)
    assert.ok(r, `tool/result 存在 for call ${c.data.callId}`)
    assert.deepEqual(r.sourceEventSeqs, [c.seq], `call ${c.data.callId} 的 result 指向其 seq`)
  }
}

// parts 是 wrapper 数组：[{type, data}]（Crush 的 parts 列就是它的 JSON 文本）
const text = (t) => ({ type: 'text', data: { text: t } })
const finish = (reason = 'stop') => ({ type: 'finish', data: { reason } })
const reasoning = (t) => ({ type: 'reasoning', data: { thinking: t, signature: '', thought_signature: '', tool_id: '', responses_data: null } })
const toolCall = (id, name, input) => ({ type: 'tool_call', data: { id, name, input, provider_executed: false, finished: true } })
const toolResultPart = (toolCallId, content, isError = false) => ({
  type: 'tool_result',
  data: { tool_call_id: toolCallId, name: 'view', content, data: '', mime_type: '', metadata: '', is_error: isError },
})

const SID = 'a8f1c3d2-0000-4000-8000-000000000001'
const CWD = '/home/u/proj'
const CREATED = 1768000001 // Unix 秒
const UPDATED = 1768000123

function msg(role, parts, over = {}) {
  return { id: 'm-' + Math.random().toString(36).slice(2), role, parts, createdAt: CREATED + 1, finishedAt: null, isSummaryMessage: 0, ...over }
}
function session(messages, over = {}) {
  return JSON.stringify({
    id: SID, parentSessionId: null, title: 'Add retry to fetch', messageCount: messages.length,
    promptTokens: 12043, completionTokens: 812, cost: 0.0412, summaryMessageId: null,
    createdAt: CREATED, updatedAt: UPDATED, messages, ...over,
  })
}

test('简单轮次：user text 开轮、标题取 title、cwd/创建时间经 args 落 meta（秒 → 毫秒）', () => {
  const out = convertCrushJson(session([
    msg('user', [text('add a retry to fetch'), finish()]),
    msg('assistant', [text('Done — added backoff.'), finish('end_turn')]),
  ]), { createdAt: CREATED * 1000, cwd: CWD, crushId: SID, sourcePath: '/home/u/proj/.crush/crush.db' })
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.id, 'import-' + SID)
  assert.equal(out.meta.sourceId, SID)
  assert.equal(out.meta.cwd, CWD)
  assert.equal(out.meta.createdAt, CREATED * 1000)
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].prompt, 'add a retry to fetch')
  assert.equal(out.messages, 2) // user + assistant（finish 结构块不计）
  assert.equal(out.title, 'Add retry to fetch')
  assert.equal(out.events.filter((e) => e.type === 'session/title').length, 1)
  assert.equal(out.skippedBlocks, 0)
})

test('reasoning + tool_call（input 是原始 JSON 字符串）+ 单独 role=tool 的结果 → 同一步配对', () => {
  const out = convertCrushJson(session([
    msg('user', [text('look at fetch'), finish()]),
    msg('assistant', [
      reasoning('Need to look at fetch.go'),
      text('Let me inspect fetch.go.'),
      toolCall('call_abc123', 'view', '{"file_path":"internal/fetch/fetch.go"}'),
      finish('tool_use'),
    ], { model: 'claude-sonnet-4-20250514', provider: 'anthropic' }),
    msg('tool', [toolResultPart('call_abc123', 'package fetch\n'), finish()]),
    msg('assistant', [text('Done — added backoff.'), finish('end_turn')]),
  ]), { createdAt: CREATED * 1000, cwd: CWD, crushId: SID })
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].steps.length, 2)
  const [s1] = out.turns[0].steps
  assert.deepEqual(s1.content[0], { type: 'reasoning', text: 'Need to look at fetch.go' })
  assert.deepEqual(s1.toolCalls[0], {
    type: 'tool-call', id: 'call_abc123', name: 'view', arguments: '{"file_path":"internal/fetch/fetch.go"}',
  })
  assert.deepEqual(s1.toolResults[0].content, [{ type: 'text', text: 'package fetch\n' }])
  assert.equal(s1.toolResults[0].isError, false)
  assert.equal(out.toolCalls, 1)
  assert.equal(out.droppedToolResults, 0)
  assertToolPairing(out.events)
  // 模型来自消息级 model
  assert.equal(out.events.find((e) => e.type === 'assistant/message').data.message.source.model, 'claude-sonnet-4-20250514')
})

test('tool_result 也可以挂在 assistant 消息里；is_error 如实标记；字符串结果原样', () => {
  const out = convertCrushJson(session([
    msg('user', [text('run it'), finish()]),
    msg('assistant', [toolCall('c1', 'bash', '{"command":"make"}'), toolResultPart('c1', 'boom', true), finish('tool_use')]),
  ]), { createdAt: CREATED * 1000, crushId: SID })
  const step = out.turns[0].steps[0]
  assert.equal(step.toolResults.length, 1)
  assert.equal(step.toolResults[0].isError, true)
  assert.deepEqual(step.toolResults[0].content, [{ type: 'text', text: 'boom' }])
  assertToolPairing(out.events)
})

test('image_url / shell_command / binary / 未知判别式只计数；只有签名的 reasoning 也计数', () => {
  const out = convertCrushJson(session([
    msg('user', [text('问'), finish()]),
    msg('assistant', [
      { type: 'image_url', data: { url: 'https://x/y.png', detail: 'auto' } },
      { type: 'shell_command', data: { command: 'ls', output: 'a.ts', exit_code: 0 } },
      { type: 'binary', data: { Path: '/x', MIMEType: 'image/png', Data: 'AAA' } },
      { type: 'some_future_part', data: {} },
      { type: 'reasoning', data: { thinking: '', signature: 'sig', responses_data: { opaque: true } } },
      text('答'),
      finish('end_turn'),
    ]),
  ]), { createdAt: CREATED * 1000, crushId: SID })
  assert.equal(out.skippedBlocks, 5)
  assert.deepEqual(out.turns[0].steps[0].content, [{ type: 'text', text: '答' }])
})

test('自动摘要消息（is_summary_message=1）→ 原生压缩检查点，不当作普通 assistant 回合', () => {
  const messages = [
    msg('user', [text('第一件事'), finish()]),
    msg('assistant', [text('做完了'), finish('end_turn')]),
    msg('assistant', [text('此前在改 fetch 的重试。'), finish()], { isSummaryMessage: 1 }),
    msg('user', [text('第二件事'), finish()]),
    msg('assistant', [text('好的'), finish('end_turn')]),
  ]
  const out = convertCrushJson(session(messages), { createdAt: CREATED * 1000, crushId: SID })
  assert.equal(out.turns.length, 2) // 摘要消息没有开新轮
  assert.equal(out.compactionSummaries, 1)
  assert.equal(out.compacted, true)
  assert.equal(out.compactions, 1)
  assert.equal(assertNativeCompaction(out.events), 1)
  assert.equal(out.turns[0].shadowed, true)
  assert.equal(out.turns[1].compaction.summary, '此前在改 fetch 的重试。')
  assert.deepEqual(derivedSurfaceMessages(out.events).slice(2), ['user:此前在改 fetch 的重试。', 'user:第二件事', 'assistant:好的'])
  assert.ok(out.events.some((e) => JSON.stringify(e.data).includes('做完了')), '压缩前内容留在日志里')

  // fullHistory：不发检查点，摘要退回既有形态（reasoning 块）
  const full = convertCrushJson(session(messages), { createdAt: CREATED * 1000, crushId: SID, fullHistory: true })
  assert.equal(full.compacted, undefined)
  const blocks = full.turns[0].steps[0].content.filter((b) => b.type === 'reasoning')
  assert.deepEqual(blocks, [{ type: 'reasoning', text: 'Compaction summary:\n\n此前在改 fetch 的重试。' }])
})

test('子会话（parentSessionId 非空）与标题生成会话（title- 前缀）不单独成会话', () => {
  const sub = convertCrushJson(session([
    msg('user', [text('子任务'), finish()]),
    msg('assistant', [text('完成'), finish()]),
  ], { parentSessionId: SID }), { createdAt: CREATED * 1000, crushId: 'x$$y' })
  assert.equal(sub.meta, null)
  assert.match(sub.skipReason, /^Crush sub-session/)

  const titleSession = convertCrushJson(session([
    msg('user', [text('生成标题'), finish()]),
  ], { id: 'title-' + SID, title: 'Generate a title' }), { createdAt: CREATED * 1000, crushId: 'title-x' })
  assert.equal(titleSession.meta, null)
  assert.match(titleSession.skipReason, /^Crush title-generation session/)
})

test('孤儿 tool_result 丢弃并计数；重复 callId 只保留首次', () => {
  const orphan = convertCrushJson(session([
    msg('user', [text('问'), finish()]),
    msg('assistant', [text('答'), finish()]),
    msg('tool', [toolResultPart('missing', '来路不明'), finish()]),
  ]), { createdAt: CREATED * 1000, crushId: SID })
  assert.equal(orphan.droppedToolResults, 1)
  assert.equal(orphan.events.filter((e) => e.type === 'tool/result').length, 0)

  const dup = convertCrushJson(session([
    msg('user', [text('看看'), finish()]),
    msg('assistant', [toolCall('dup', 'view', '{"path":"a.ts"}'), finish('tool_use')]),
    msg('assistant', [toolCall('dup', 'view', '{"path":"a.ts"}'), text('重发'), finish()]),
    msg('tool', [toolResultPart('dup', '内容'), finish()]),
  ]), { createdAt: CREATED * 1000, crushId: SID })
  assert.equal(dup.droppedDuplicateCalls, 1)
  assert.equal(dup.toolCalls, 1)
  assert.deepEqual(dup.turns[0].steps[1].content.map((b) => b.type), ['text'])
  assertToolPairing(dup.events)
})

test('并行工具：同一步多结果按 call 顺序对齐', () => {
  const out = convertCrushJson(session([
    msg('user', [text('跑两条'), finish()]),
    msg('assistant', [toolCall('c2', 'bash', '{"cmd":"b"}'), toolCall('c1', 'bash', '{"cmd":"a"}'), finish('tool_use')]),
    msg('tool', [toolResultPart('c1', 'A'), finish()]),
    msg('tool', [toolResultPart('c2', 'B'), finish()]),
  ]), { createdAt: CREATED * 1000, crushId: SID })
  const step = out.turns[0].steps[0]
  assert.deepEqual(step.toolResults.map((r) => r.toolCallId), ['c2', 'c1'])
  assertToolPairing(out.events)
})

test('system 消息只在开关开启时收集为上下文注入；空 parts 的 user 不开轮', () => {
  const raw = session([
    msg('system', [text('你是 Crush。'), finish()]),
    msg('user', [], { id: 'empty' }),
    msg('user', [text('问题'), finish()]),
    msg('assistant', [text('答'), finish('end_turn')]),
  ])
  const hasText = (out, needle) => out.events.some((e) => e.data && Array.isArray(e.data.content)
    && e.data.content.some((b) => typeof b.text === 'string' && b.text.includes(needle)))
  assert.equal(out_turns(raw), 1)
  assert.equal(hasText(convertCrushJson(raw, { createdAt: CREATED * 1000, crushId: SID }), '你是 Crush。'), false)
  assert.equal(hasText(convertCrushJson(raw, { createdAt: CREATED * 1000, crushId: SID, importSystemPrompt: true }), '你是 Crush。'), true)
  function out_turns(text) {
    return convertCrushJson(text, { createdAt: CREATED * 1000, crushId: SID }).turns.length
  }
})

test('非 Crush 结构（无 messages 数组 / 非法 JSON）→ skipReason，不产出事件', () => {
  const noMessages = convertCrushJson(JSON.stringify({ id: SID, title: 'x' }))
  assert.equal(noMessages.meta, null)
  assert.equal(noMessages.skipReason, 'not a Crush session (no messages array)')
  assert.equal(convertCrushJson('{not json').skipReason, 'not a Crush session (invalid JSON)')
})

test('parseCrushProjects：`{projects:[{path,data_dir,last_accessed}]}`；缺失/畸形 → 空数组', () => {
  const raw = JSON.stringify({
    projects: [
      { path: '/home/u/proj', data_dir: '/home/u/proj/.crush', last_accessed: '2026-09-15T13:00:00Z' },
      { path: '/home/u/other', data_dir: '/home/u/other/.crush', last_accessed: '2026-09-14T13:00:00Z' },
      { data_dir: '/x/.crush' }, // 缺 path → 丢弃
      null,
    ],
  })
  const list = parseCrushProjects(raw)
  assert.equal(list.length, 2)
  assert.deepEqual(list[0], { path: '/home/u/proj', dataDir: '/home/u/proj/.crush', lastAccessed: '2026-09-15T13:00:00Z' })
  assert.deepEqual(parseCrushProjects('{oops'), [])
  assert.deepEqual(parseCrushProjects(''), [])
  assert.deepEqual(parseCrushProjects(JSON.stringify({ projects: 'nope' })), [])
})

test('路径解析：用户级目录三平台 + projects.json 与项目库路径', () => {
  assert.equal(crushUserDataDir('/h/u', {}, 'linux'), '/h/u/.local/share/crush')
  assert.equal(crushUserDataDir('/h/u', { XDG_DATA_HOME: '/xdg' }, 'linux'), '/xdg/crush')
  assert.equal(crushUserDataDir('/h/u', { CRUSH_GLOBAL_DATA: '/override' }, 'linux'), '/override')
  assert.equal(crushUserDataDir('/h/u', { CRUSH_GLOBAL_DATA: 'rel' }, 'linux'), '/h/u/.local/share/crush') // 相对被忽略
  assert.equal(crushUserDataDir('C:\\Users\\u', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32'),
    'C:\\Users\\u\\AppData\\Local\\crush')
  assert.equal(crushRegistryPath('/h/u', {}, 'linux'), '/h/u/.local/share/crush/projects.json')
  assert.equal(crushProjectDbPath('/home/u/proj', 'linux'), '/home/u/proj/.crush/crush.db')
  assert.equal(crushProjectDbPath('D:\\proj', 'win32'), 'D:\\proj\\.crush\\crush.db')
})

// ---- import_crush 集成（真实 SQLite 临时库，项目内 .crush/） ----

// 合成 Crush 会话库（sessions/messages/read_files 三表；parts 是 wrapper JSON 数组）
const CRUSH_SID = 'a8f1c3d2-0000-4000-8000-000000000001'
const CRUSH_CREATED = 1768000001
const CRUSH_UPDATED = 1768000123
function crushPartsUser(t) {
  return JSON.stringify([{ type: 'text', data: { text: t } }, { type: 'finish', data: { reason: 'stop' } }])
}
function crushFixture() {
  return {
    sessions: [
      {
        id: CRUSH_SID, title: 'Add retry to fetch', message_count: 4,
        prompt_tokens: 12043, completion_tokens: 812, cost: 0.0412,
        created_at: CRUSH_CREATED, updated_at: CRUSH_UPDATED,
      },
      // 子会话：不单独成会话
      { id: 'parent$$toolcall', parent_session_id: CRUSH_SID, title: 'New Agent Session', message_count: 1, created_at: CRUSH_CREATED, updated_at: CRUSH_UPDATED },
    ],
    messages: [
      { id: 'm1', session_id: CRUSH_SID, role: 'user', created_at: CRUSH_CREATED + 1, updated_at: CRUSH_CREATED + 1, parts: crushPartsUser('add a retry to fetch') },
      {
        id: 'm2', session_id: CRUSH_SID, role: 'assistant', created_at: CRUSH_CREATED + 2, updated_at: CRUSH_CREATED + 2, model: 'claude-sonnet-4-20250514', provider: 'anthropic',
        parts: JSON.stringify([
          { type: 'reasoning', data: { thinking: 'Need to look at fetch.go', signature: '', tool_id: '', responses_data: null } },
          { type: 'tool_call', data: { id: 'call_abc123', name: 'view', input: '{"file_path":"internal/fetch/fetch.go"}', provider_executed: false, finished: true } },
          { type: 'finish', data: { reason: 'tool_use', time: CRUSH_CREATED + 3 } },
        ]),
      },
      {
        id: 'm3', session_id: CRUSH_SID, role: 'tool', created_at: CRUSH_CREATED + 3, updated_at: CRUSH_CREATED + 3, finished_at: CRUSH_CREATED + 3,
        parts: JSON.stringify([
          { type: 'tool_result', data: { tool_call_id: 'call_abc123', name: 'view', content: 'package fetch\n', is_error: false } },
          { type: 'finish', data: { reason: 'stop' } },
        ]),
      },
      { id: 'm4', session_id: CRUSH_SID, role: 'assistant', created_at: CRUSH_CREATED + 4, updated_at: CRUSH_CREATED + 4, parts: crushPartsUser('Done — added backoff.') },
    ],
  }
}

function makeCrushDb(fixture) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crush-'))
  const projectDir = join(dir, 'proj')
  const dbPath = join(projectDir, '.crush', 'crush.db')
  mkdirSync(join(projectDir, '.crush'), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, title TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER, completion_tokens INTEGER, cost REAL,
    updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL, summary_message_id TEXT, todos TEXT);
  CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
    parts TEXT NOT NULL DEFAULT '[]', model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    finished_at INTEGER, provider TEXT, is_summary_message INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE files (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(path, session_id, version));
  CREATE TABLE read_files (session_id TEXT, path TEXT, read_at INTEGER NOT NULL, PRIMARY KEY(path, session_id));`)
  for (const s of fixture.sessions) {
    const cols = Object.keys(s)
    db.prepare(`INSERT INTO sessions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => s[c]))
  }
  for (const m of fixture.messages) {
    const cols = Object.keys(m)
    db.prepare(`INSERT INTO messages (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => m[c]))
  }
  db.close()
  return { dbPath, projectDir }
}

test('import_crush 项目内单库：批量形态、子会话不导入、parts 配对落盘、schema 校验', async () => {
  const { dbPath, projectDir } = makeCrushDb(crushFixture())
  const { ctx, persistence, attached } = makeCtx({}) // stat 不在 tree 里 → 按真实 DB 文件处理
  apply(ctx)
  const def = chatDef(ctx, 'crush')
  const value = await def.execute({ path: dbPath })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 1) // 子会话在读取层被过滤
  assert.equal(value.imported, 1)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get('import-' + CRUSH_SID)
  assert.ok(saved)
  // DB 里没有 cwd 列 → 项目路径由「库目录以 .crush 结尾 → 父目录」推导
  assert.equal(saved.meta.cwd, projectDir)
  assert.equal(saved.meta.createdAt, CRUSH_CREATED * 1000) // Unix 秒 → 毫秒
  assert.match(saved.events.at(-1).data.title, /^Crush · /)
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assertEnvelopeHygiene(saved.events)

  const result = saved.events.find((e) => e.type === 'tool/result')
  assert.deepEqual(result.sourceEventSeqs, [saved.events.find((e) => e.type === 'tool/call').seq])
  assert.equal(result.data.message.content[0].content[0].text, 'package fetch\n')
  const reasoning = saved.events
    .flatMap((e) => (e.type === 'assistant/message' ? e.data.message.content : []))
    .filter((b) => b.type === 'reasoning')
  assert.deepEqual(reasoning, [{ type: 'reasoning', text: 'Need to look at fetch.go' }])
  assert.equal(attached.length, 1)
})

test('import_crush 目录模式：接受项目目录或数据目录；sessionIds 过滤；preview 零副作用', async () => {
  const { dbPath, projectDir } = makeCrushDb(crushFixture())
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'crush')

  const viaProject = await def.execute({ path: projectDir, sessionIds: [CRUSH_SID] })
  assert.equal(viaProject.mode, 'batch')
  assert.equal(viaProject.imported, 1)
  assert.equal(persistence.sessions.has('import-' + CRUSH_SID), true)

  const preview = await def.execute({ path: dbPath, preview: true })
  assert.equal(preview.preview, true)
  assert.equal(preview.total, 1)
  assert.ok(preview.results.some((r) => String(r.title).startsWith('Crush · ')))
  assert.equal(persistence.sessions.size, 1) // 预览零副作用
})

test('import_crush 幂等：重复导入同一库只落盘一次；非 Crush 库大声报错', async () => {
  const { dbPath } = makeCrushDb(crushFixture())
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'crush')
  const first = await def.execute({ path: dbPath })
  const second = await def.execute({ path: dbPath })
  assert.equal(first.imported, 1)
  assert.equal(second.imported, 0)
  assert.equal(second.alreadyImported, 1)
  assert.equal(persistence.sessions.size, 1)

  const dir = mkdtempSync(join(tmpdir(), 'dsh-crush-bad-'))
  const bogus = join(dir, 'crush.db')
  writeFileSync(bogus, 'not a sqlite db')
  await assert.rejects(() => def.execute({ path: bogus }), /Crush/)
})
