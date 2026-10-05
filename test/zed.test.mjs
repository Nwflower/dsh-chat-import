// zed.test.mjs — Zed 源转换核心单元测试 + import_chat 集成测试（假宿主见 _support/fake-host.mjs；自包含合成数据，不掺真实会话）
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { convertZedJson, zedFolderPaths, zedDataDir, zedThreadsDir, zedThreadsDbPath } from '../lib/convert/zed.mjs'
import { SESSION_FORMAT_VERSION } from '../lib/convert/core.mjs'
import { assertNativeCompaction, derivedSurfaceMessages } from './_support/compaction.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'
import { Buffer } from 'node:buffer'
import { apply } from '../lib/index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { hostAbs } from './_support/host-path.mjs'
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

const ID = '2f8b1c6e-0000-4000-8000-000000000001'
const CWD = '/home/u/proj'
const TS = '2026-09-15T13:38:45.123456789+00:00'
const TS_MS = Date.parse(TS)

function userMsg(texts) {
  return { User: { id: 'u-' + Math.random().toString(36).slice(2), content: texts.map((t) => ({ Text: t })) } }
}
function agentMsg(content, toolResults = null) {
  const agent = { content, reasoning_details: null }
  if (toolResults) agent.tool_results = toolResults
  return { Agent: agent }
}
function toolUse(id, name, input, rawInput = null) {
  return { ToolUse: { id, name, raw_input: rawInput ?? JSON.stringify(input), input: { type: 'json', value: input }, is_input_complete: true, thought_signature: null } }
}
function toolResult(id, name, texts, isError = false) {
  return { tool_use_id: id, tool_name: name, is_error: isError, content: texts.map((t) => ({ Text: t })), output: null }
}
function thread(messages, over = {}) {
  return JSON.stringify({
    title: '修登录页分页', updated_at: TS, version: '0.3.0', messages,
    model: { provider: 'anthropic', model: 'claude-sonnet-4-5' }, ...over,
  })
}

test('v0.3.0：user 文本开轮、标题取 title、cwd/创建时间经 args 落 meta、model 落 provider', () => {
  const out = convertZedJson(thread([
    userMsg(['修一下登录页分页']),
    agentMsg([{ Text: '已修好。' }]),
  ]), { createdAt: TS_MS, cwd: CWD, zedId: ID, sourcePath: '/home/u/.local/share/zed/threads/threads.db' })
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.id, 'import-' + ID)
  assert.equal(out.meta.sourceId, ID)
  assert.equal(out.meta.cwd, CWD)
  assert.equal(out.meta.createdAt, TS_MS)
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].prompt, '修一下登录页分页')
  assert.equal(out.messages, 2)
  assert.equal(out.title, '修登录页分页')
  assert.equal(out.events.filter((e) => e.type === 'session/title').length, 1)
  const assistant = out.events.find((e) => e.type === 'assistant/message')
  assert.equal(assistant.data.message.source.model, 'claude-sonnet-4-5')
})

test('v0.3.0：Thinking / ToolUse / tool_results（同一 Agent 消息上的对象）→ 推理+调用+结果配对', () => {
  const out = convertZedJson(thread([
    userMsg(['读一下 a.ts']),
    agentMsg(
      [{ Thinking: { text: '先读文件', signature: null } }, toolUse('toolu_01', 'read_file', { path: 'a.ts' })],
      { toolu_01: toolResult('toolu_01', 'read_file', ['export const a = 1']) },
    ),
    agentMsg([{ Text: '只有一个导出。' }]),
  ]), { createdAt: TS_MS, zedId: ID })
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].steps.length, 2)
  const [s1] = out.turns[0].steps
  assert.deepEqual(s1.content[0], { type: 'reasoning', text: '先读文件' })
  assert.deepEqual(s1.toolCalls, [{ type: 'tool-call', id: 'toolu_01', name: 'read_file', arguments: '{"path":"a.ts"}' }])
  assert.deepEqual(s1.toolResults[0].content, [{ type: 'text', text: 'export const a = 1' }])
  assert.equal(s1.toolResults[0].isError, false)
  assert.equal(out.toolCalls, 1)
  assert.equal(out.droppedToolResults, 0)
  assertToolPairing(out.events)
})

test('v0.3.0：is_error 结果如实标记；图片结果只计数不进文本', () => {
  const out = convertZedJson(thread([
    userMsg(['跑测试']),
    agentMsg([toolUse('c1', 'terminal', { command: 'npm test' })], {
      c1: { tool_use_id: 'c1', tool_name: 'terminal', is_error: true, content: [{ Text: 'boom' }, { Image: { source: 'x' } }], output: null },
    }),
  ]), { createdAt: TS_MS, zedId: ID })
  const step = out.turns[0].steps[0]
  assert.equal(step.toolResults[0].isError, true)
  assert.deepEqual(step.toolResults[0].content, [{ type: 'text', text: 'boom' }])
  assert.equal(out.skippedBlocks, 1) // 图片块
})

test('v0.3.0：Mention / Image / RedactedThinking 只计数；Resume 与空 content 的 User 都跳过', () => {
  const out = convertZedJson(thread([
    // /compact 会先压一条空 content 的 User 消息，再压 Compaction —— 两者都不能报错
    { User: { id: 'u0', content: [] } },
    userMsg(['问题']),
    agentMsg([{ RedactedThinking: 'opaque' }, { Text: '答' }]),
    'Resume',
    { User: { id: 'u1', content: [{ Mention: { File: { abs_path: '/a.ts' } } }, { Image: { source: 'x' } }] } },
  ]), { createdAt: TS_MS, zedId: ID })
  assert.equal(out.turns.length, 1) // 空 content 的 User 没开轮，Mention/Image 那条也没开轮
  assert.equal(out.skippedBlocks, 3) // RedactedThinking + Mention + Image
  assert.deepEqual(out.turns[0].steps[0].content.filter((b) => b.type === 'text'), [{ type: 'text', text: '答' }])
})

test('v0.3.0：Compaction.Summary → 原生压缩检查点；ProviderNative 只计数', () => {
  const messages = [
    userMsg(['第一件事']),
    agentMsg([{ Text: '做完了' }]),
    { Compaction: { Summary: '此前在改登录页。' } },
    userMsg(['第二件事']),
    agentMsg([{ Text: '好的' }]),
    { Compaction: { ProviderNative: { provider: 'anthropic', items: [{ opaque: true }] } } },
  ]
  const out = convertZedJson(thread(messages), { createdAt: TS_MS, zedId: ID })
  assert.equal(out.turns.length, 2)
  assert.equal(out.compactionSummaries, 1)
  assert.equal(out.skippedBlocks, 1) // ProviderNative
  assert.equal(out.compacted, true)
  assert.equal(out.compactions, 1)
  assert.equal(assertNativeCompaction(out.events), 1)
  assert.equal(out.turns[0].shadowed, true)
  assert.equal(out.turns[1].compaction.summary, '此前在改登录页。')
  assert.deepEqual(derivedSurfaceMessages(out.events).slice(2), ['user:此前在改登录页。', 'user:第二件事', 'assistant:好的'])
  assert.ok(out.events.some((e) => JSON.stringify(e.data).includes('做完了')), '压缩前内容留在日志里')

  // fullHistory：不发检查点，摘要退回既有形态（reasoning 块）
  const full = convertZedJson(thread(messages), { createdAt: TS_MS, zedId: ID, fullHistory: true })
  assert.equal(full.compacted, undefined)
  const reasoning = full.turns[0].steps[0].content.filter((b) => b.type === 'reasoning')
  assert.deepEqual(reasoning, [{ type: 'reasoning', text: 'Compaction summary:\n\n此前在改登录页。' }])
})

test('v0.3.0：孤儿 tool_result（无匹配 tool_use）丢弃并计数；重复 callId 只保留首次', () => {
  const orphan = convertZedJson(thread([
    userMsg(['问']),
    agentMsg([{ Text: '答' }], { missing: toolResult('missing', 'x', ['来路不明']) }),
  ]), { createdAt: TS_MS, zedId: ID })
  assert.equal(orphan.droppedToolResults, 1)
  assert.equal(orphan.events.filter((e) => e.type === 'tool/result').length, 0)

  const dup = convertZedJson(thread([
    userMsg(['看看']),
    agentMsg([toolUse('dup', 'read_file', { path: 'a.ts' })]),
    agentMsg([toolUse('dup', 'read_file', { path: 'a.ts' }), { Text: '重发' }]),
  ]), { createdAt: TS_MS, zedId: ID })
  assert.equal(dup.droppedDuplicateCalls, 1)
  assert.equal(dup.toolCalls, 1)
  assert.deepEqual(dup.turns[0].steps[1].content.map((b) => b.type), ['text'])
})

test('legacy 方言（无 version / 非 0.3.0）：summary 作标题、segments/tool_uses/tool_results 数组', () => {
  const legacy = JSON.stringify({
    version: '0.2.0',
    summary: '旧的线程标题',
    updated_at: TS,
    messages: [
      { id: 'm1', role: 'system', segments: [{ type: 'text', text: '你是 Zed。' }], is_visible: true },
      { id: 'm2', role: 'user', segments: [{ type: 'text', text: '旧形状提问' }], is_visible: true },
      {
        id: 'm3',
        role: 'assistant',
        segments: [{ type: 'thinking', text: '旧形状推理' }, { type: 'text', text: '旧形状回答' }],
        tool_uses: [{ id: 'tc1', name: 'terminal', input: { command: 'ls' } }],
        tool_results: [{ tool_use_id: 'tc1', is_error: false, content: [{ type: 'text', text: 'a.ts' }] }],
        is_visible: true,
      },
      // agent-only 消息不进对话
      { id: 'm4', role: 'assistant', segments: [{ type: 'text', text: '不可见' }], is_visible: false },
    ],
  })
  const out = convertZedJson(legacy, { createdAt: TS_MS, zedId: ID, importSystemPrompt: true })
  assert.equal(out.title, '旧的线程标题')
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].prompt, '旧形状提问')
  const step = out.turns[0].steps[0]
  assert.deepEqual(step.content.filter((b) => b.type === 'reasoning'), [{ type: 'reasoning', text: '旧形状推理' }])
  assert.deepEqual(step.toolCalls, [{ type: 'tool-call', id: 'tc1', name: 'terminal', arguments: '{"command":"ls"}' }])
  assert.deepEqual(step.toolResults[0].content, [{ type: 'text', text: 'a.ts' }])
  assertToolPairing(out.events)
  // 系统提示词：开关开启时才作为上下文注入
  const injected = out.events.some((e) => e.data && Array.isArray(e.data.content)
    && e.data.content.some((b) => typeof b.text === 'string' && b.text.includes('你是 Zed。')))
  assert.equal(injected, true)
  const off = convertZedJson(legacy, { createdAt: TS_MS, zedId: ID })
  assert.equal(off.events.some((e) => e.data && Array.isArray(e.data.content)
    && e.data.content.some((b) => typeof b.text === 'string' && b.text.includes('你是 Zed。'))), false)
})

test('标题回退：无 title/summary 时用首问（不钉事件）；创建时间回退 blob 的 updated_at', () => {
  const out = convertZedJson(thread([
    userMsg(['首个提问当作标题']),
    agentMsg([{ Text: '好' }]),
  ], { title: '' }), { zedId: ID })
  assert.equal(out.title, '首个提问当作标题')
  assert.equal(out.events.filter((e) => e.type === 'session/title').length, 0)
  assert.equal(out.meta.createdAt, TS_MS) // 无 args.createdAt → 用 blob 的 updated_at（RFC3339 九位小数）
})

test('非 Zed 结构（无 messages 数组 / 非法 JSON）→ skipReason，不产出事件', () => {
  const noMessages = convertZedJson(JSON.stringify({ title: 'x', rows: [] }))
  assert.equal(noMessages.meta, null)
  assert.equal(noMessages.skipReason, 'not a Zed thread (no messages array)')
  assert.equal(convertZedJson('{not json').skipReason, 'not a Zed thread (invalid JSON)')
})

test('zedFolderPaths：`\\n` 连接 + `,` 索引还原顺序；索引缺失/越界退化为字典序', () => {
  assert.deepEqual(zedFolderPaths('/a\n/b\n/c', ''), ['/a', '/b', '/c'])
  assert.deepEqual(zedFolderPaths('/a\n/b\n/c', '2,0,1'), ['/c', '/a', '/b'])
  assert.deepEqual(zedFolderPaths('/a\n/b', '0'), ['/a', '/b']) // 长度不符 → 退化
  assert.deepEqual(zedFolderPaths('/a\n/b', '5,0'), ['/a', '/b']) // 越界 → 退化
  assert.deepEqual(zedFolderPaths('/only', '0'), ['/only'])
  assert.deepEqual(zedFolderPaths('', ''), [])
})

test('参数与结果的次要形态：input.type=text、legacy input 为字符串、结果只在 output 里', () => {
  // v0.3.0：没有 raw_input，input = {type:'text', value:'…'} → 直接用 value 当参数文本
  const v3 = convertZedJson(thread([
    userMsg(['跑一下']),
    agentMsg([{ ToolUse: { id: 't1', name: 'terminal', input: { type: 'text', value: 'npm test' }, is_input_complete: true } }], {
      t1: { tool_use_id: 't1', tool_name: 'terminal', is_error: false, content: [], output: 'from-output' },
    }),
  ]), { createdAt: TS_MS, zedId: ID })
  assert.deepEqual(v3.turns[0].steps[0].toolCalls, [{ type: 'tool-call', id: 't1', name: 'terminal', arguments: 'npm test' }])
  assert.deepEqual(v3.turns[0].steps[0].toolResults[0].content, [{ type: 'text', text: 'from-output' }])

  // legacy：input 是字符串、结果 content 是字符串数组、output 是 {text}
  const legacy = JSON.stringify({
    version: '0.1.0', summary: '旧', updated_at: TS,
    messages: [
      { id: 'm1', role: 'user', segments: [{ type: 'text', text: '问' }], is_visible: true },
      {
        id: 'm2', role: 'assistant',
        segments: [{ type: 'text', text: '答' }],
        tool_uses: [{ id: 'tc9', name: 'terminal', input: '{"command":"ls"}' }],
        tool_results: [{ tool_use_id: 'tc9', is_error: false, content: ['plain line'], output: { text: 'obj line' } }],
        is_visible: true,
      },
    ],
  })
  const out = convertZedJson(legacy, { createdAt: TS_MS, zedId: ID })
  assert.deepEqual(out.turns[0].steps[0].toolCalls, [{ type: 'tool-call', id: 'tc9', name: 'terminal', arguments: '{"command":"ls"}' }])
  assert.deepEqual(out.turns[0].steps[0].toolResults[0].content, [{ type: 'text', text: 'plain line\nobj line' }])
  assertToolPairing(out.events)

  // legacy 的 model 也可能是裸字符串 → 落成 provider/model
  const legacyModel = convertZedJson(JSON.stringify({
    version: '0.2.0', summary: '旧', updated_at: TS, model: 'claude-sonnet-4-5',
    messages: [
      { id: 'm1', role: 'user', segments: [{ type: 'text', text: '问' }], is_visible: true },
      { id: 'm2', role: 'assistant', segments: [{ type: 'text', text: '答' }], is_visible: true },
    ],
  }), { createdAt: TS_MS, zedId: ID })
  assert.equal(legacyModel.events.find((e) => e.type === 'assistant/message').data.message.source.model, 'claude-sonnet-4-5')
})

test('并行工具：同一步多结果按 call 顺序对齐（结果乱序到达）', () => {
  const out = convertZedJson(thread([
    userMsg(['跑两条命令']),
    agentMsg(
      [toolUse('c2', 'bash', { cmd: 'b' }), toolUse('c1', 'bash', { cmd: 'a' })],
      // 结果乱序：先 c1 后 c2（对象键序与调用顺序相反）
      {
        c1: toolResult('c1', 'bash', ['A']),
        c2: toolResult('c2', 'bash', ['B']),
      },
    ),
  ]), { createdAt: TS_MS, zedId: ID })
  const step = out.turns[0].steps[0]
  assert.deepEqual(step.toolResults.map((r) => r.toolCallId), ['c2', 'c1']) // 按 call 顺序
  assertToolPairing(out.events)
})

test('路径解析：三平台各自正确（macOS 用 Application Support、Windows 用 LOCALAPPDATA\\Zed）', () => {
  assert.equal(zedDataDir('/h/u', {}, 'linux'), '/h/u/.local/share/zed')
  assert.equal(zedDataDir('/h/u', { XDG_DATA_HOME: '/xdg' }, 'linux'), '/xdg/zed')
  assert.equal(zedDataDir('/h/u', { XDG_DATA_HOME: 'rel/xdg' }, 'linux'), '/h/u/.local/share/zed') // 相对 XDG 忽略
  assert.equal(zedDataDir('/h/u', {}, 'darwin'), '/h/u/Library/Application Support/Zed')
  assert.equal(zedDataDir('C:\\Users\\u', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32'),
    'C:\\Users\\u\\AppData\\Local\\Zed')
  assert.equal(zedThreadsDir('/h/u', {}, 'linux'), '/h/u/.local/share/zed/threads')
  assert.equal(zedThreadsDbPath('/h/u', {}, 'linux'), '/h/u/.local/share/zed/threads/threads.db')
})

// ---- import_zed 集成（真实 SQLite 临时库，zstd blob） ----

// 合成 Zed 线程库（threads 单表；data_type=zstd 是上游实际写入的形态）
const ZED_ID = '2f8b1c6e-0000-4000-8000-000000000001'
const ZED_CWD = hostAbs('D:/demo/zed-proj')
const ZED_TS = '2026-09-15T13:38:45.123456789+00:00'
function zedThreadPayload({ title = '修登录页分页', version = '0.3.0', withTool = true } = {}) {
  const messages = [
    { User: { id: 'u1', content: [{ Text: '修一下登录页分页' }] } },
  ]
  if (withTool) {
    messages.push({
      Agent: {
        content: [
          { Thinking: { text: '先读文件', signature: null } },
          {
            ToolUse: {
              id: 'toolu_01', name: 'read_file', raw_input: '{"path":"a.ts"}',
              input: { type: 'json', value: { path: 'a.ts' } }, is_input_complete: true, thought_signature: null,
            },
          },
        ],
        tool_results: {
          toolu_01: { tool_use_id: 'toolu_01', tool_name: 'read_file', is_error: false, content: [{ Text: 'export const a = 1' }], output: null },
        },
        reasoning_details: null,
      },
    })
  }
  messages.push({ Agent: { content: [{ Text: '已修好。' }], tool_results: {}, reasoning_details: null } })
  return { title, updated_at: ZED_TS, version, messages }
}

function makeZedDb(threads) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-zed-'))
  const dbPath = join(dir, 'threads.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at TEXT NOT NULL,
    data_type TEXT NOT NULL, data BLOB NOT NULL, parent_id TEXT,
    folder_paths TEXT, folder_paths_order TEXT, created_at TEXT)`)
  for (const t of threads) {
    db.prepare('INSERT INTO threads (id, summary, updated_at, data_type, data, parent_id, folder_paths, folder_paths_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(t.id, t.summary, ZED_TS, 'zstd', zstdCompressSync(Buffer.from(JSON.stringify(t.payload), 'utf8')), t.parent || null, t.folderPaths ?? ZED_CWD, '0', ZED_TS)
  }
  db.close()
  return dbPath
}

test('import_zed 单库文件：zstd 解压 + 批量形态 + 逐线程落盘 + schema 校验', async () => {
  const dbPath = makeZedDb([
    { id: ZED_ID, summary: '修登录页分页', payload: zedThreadPayload({}) },
    { id: 'legacy-1', summary: '老库线程', payload: zedThreadPayload({ title: '老库线程', version: '0.2.0', withTool: false }) },
    // 子代理线程（parent_id 非空）不落地
    { id: 'sub-1', summary: '子代理', parent: ZED_ID, payload: zedThreadPayload({ title: '子代理' }) },
  ])
  const { ctx, persistence, attached } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'zed')
  const value = await def.execute({ path: dbPath })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2) // 读取层已滤掉子代理线程
  assert.equal(value.imported, 2)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const first = persistence.sessions.get('import-' + ZED_ID)
  assert.ok(first)
  assert.equal(first.meta.cwd, ZED_CWD)
  assert.equal(first.meta.createdAt, Date.parse(ZED_TS))
  assert.match(first.events.at(-1).data.title, /^Zed · /)
  assert.ok(first.events.every((e, i) => e.seq === i))
  assertEnvelopeHygiene(first.events)
  const result = first.events.find((e) => e.type === 'tool/result')
  assert.deepEqual(result.sourceEventSeqs, [first.events.find((e) => e.type === 'tool/call').seq])
  assert.equal(result.data.message.content[0].content[0].text, 'export const a = 1')
  assert.equal(persistence.sessions.has('import-sub-1'), false)
  assert.equal(attached.length, 2)
})

test('import_zed 目录模式定位 threads.db；sessionIds 过滤与 preview 同口径', async () => {
  const dbPath = makeZedDb([
    { id: ZED_ID, summary: '线程一', payload: zedThreadPayload({}) },
    { id: 'second', summary: '线程二', payload: zedThreadPayload({ title: '线程二', withTool: false }) },
  ])
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'zed')

  const filtered = await def.execute({ path: join(dbPath, '..'), sessionIds: ['second'] })
  assert.equal(filtered.mode, 'batch')
  assert.equal(filtered.imported, 1)
  assert.equal(persistence.sessions.has('import-' + ZED_ID), false)
  assert.equal(persistence.sessions.has('import-second'), true)

  const preview = await def.execute({ path: dbPath, preview: true })
  assert.equal(preview.preview, true)
  assert.equal(preview.total, 2)
  assert.ok(preview.results.some((r) => String(r.title).startsWith('Zed · ')))
  assert.equal(persistence.sessions.size, 1) // 预览零副作用
})

test('import_zed 幂等：重复导入同一库只落盘一次；非 Zed 库大声报错', async () => {
  const dbPath = makeZedDb([{ id: ZED_ID, summary: '线程', payload: zedThreadPayload({}) }])
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'zed')
  const first = await def.execute({ path: dbPath })
  const second = await def.execute({ path: dbPath })
  assert.equal(first.imported, 1)
  assert.equal(second.imported, 0)
  assert.equal(second.alreadyImported, 1)
  assert.equal(persistence.sessions.size, 1)

  const dir = mkdtempSync(join(tmpdir(), 'dsh-zed-bad-'))
  const bogus = join(dir, 'threads.db')
  writeFileSync(bogus, 'not a sqlite db')
  await assert.rejects(() => def.execute({ path: bogus }), /Zed/)
})
