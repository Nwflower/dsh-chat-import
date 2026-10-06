// cline.test.mjs — Cline 源转换核心单元测试 + import_chat 集成测试（假宿主见 _support/fake-host.mjs；自包含合成数据，不掺真实会话）
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { convertClineJson } from '../lib/convert/cline.mjs'
import { SESSION_FORMAT_VERSION } from '../lib/convert/core.mjs'
import { assertNativeCompaction, derivedSurfaceMessages } from './_support/compaction.mjs'
import { apply } from '../lib/index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { hostAbs } from './_support/host-path.mjs'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { clearScanCache } from '../lib/discovery.mjs'
import { assertToolPairing } from './_support/session-invariants.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'

// 集成用例隔离：每个用例独立 DSH_HOME（registry 落盘在 $DSH_HOME/dsh-chat-import），
// 进程内共享的扫描缓存每用例清空。
beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
})

const SID = '01J8Z6Q0M4V7X2K9TB3N5R8WDA'
const CWD = '/home/u/repo'
const TS = 1745343730123

function userBlocks(blocks) {
  return { id: 'u-' + Math.random().toString(36).slice(2), role: 'user', content: blocks }
}
function user(text) {
  return userBlocks([{ type: 'text', text }])
}
function assistant(blocks, extra = {}) {
  return {
    id: 'a-' + Math.random().toString(36).slice(2), role: 'assistant', content: blocks, ts: TS, ...extra,
  }
}
function toolUse(id, name, input) {
  return { type: 'tool_use', id, name, input }
}
function toolResults(...blocks) {
  return userBlocks(blocks)
}
function toolResult(toolUseId, content, isError = false) {
  return { type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }
}
function session(messages, over = {}) {
  return JSON.stringify({
    version: 1, updated_at: '2026-04-22T17:42:10.123Z', agent: 'lead', sessionId: SID, messages, ...over,
  })
}

test('压缩侧车（compaction.json 状态）→ 原生压缩检查点；fullHistory 时不发', () => {
  const messages = [
    user('第一件事'),
    assistant([{ type: 'text', text: '做完了' }]),
    user('第二件事'),
    assistant([{ type: 'text', text: '好的' }]),
  ]
  // Cline 的 SessionCompactionState：source_message_count 条 canonical 消息被折叠进摘要，
  // messages.json 仍保全量 → 转换器把前 N 条标 log-only、摘要进检查点
  const args = { clineId: SID, compaction: { summary: '此前在改登录页。', sourceMessageCount: 2 } }
  const out = convertClineJson(session(messages), args)
  assert.equal(out.compacted, true)
  assert.equal(out.compactions, 1)
  assert.equal(assertNativeCompaction(out.events), 1)
  assert.equal(out.turns[0].shadowed, true)
  assert.equal(out.turns[1].compaction.summary, '此前在改登录页。')
  // 模型视角 = 摘要 + 保留窗口；压缩前内容留在日志里
  assert.deepEqual(derivedSurfaceMessages(out.events).slice(2), ['user:此前在改登录页。', 'user:第二件事', 'assistant:好的'])
  assert.ok(out.events.some((e) => JSON.stringify(e.data).includes('做完了')))

  // fullHistory：不发检查点（模型看到全量历史）
  const full = convertClineJson(session(messages), { ...args, fullHistory: true })
  assert.equal(full.compacted, undefined)
  assert.equal(full.events.some((e) => e.type.startsWith('compaction/')), false)

  // 侧车不可解析 / 计数缺失 → 忽略（退回全量可见，不猜边界）
  const noCount = convertClineJson(session(messages), { clineId: SID, compaction: { summary: '摘要' } })
  assert.equal(noCount.compacted, undefined)
  assert.equal(noCount.events.some((e) => e.type.startsWith('compaction/')), false)
})

test('简单轮次：user 文本块开轮、db 元数据经 args 落地、标题兜底首问', () => {
  const out = convertClineJson(session([
    user('修一下登录页分页'),
    assistant([{ type: 'text', text: '已修好。' }], { modelInfo: { id: 'claude-sonnet-4-6', provider: 'anthropic' } }),
  ]), { createdAt: TS, cwd: CWD, sourcePath: '/home/u/.cline/data/sessions/' + SID + '/' + SID + '.messages.json' })
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.id, 'import-' + SID)
  assert.equal(out.meta.sourceId, SID)
  assert.equal(out.meta.cwd, CWD)
  assert.equal(out.meta.createdAt, TS)
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].prompt, '修一下登录页分页')
  assert.equal(out.messages, 2)
  assert.equal(out.toolCalls, 0)
  // 标题在 DB 索引里（不在 messages.json），未传入时按首问兜底、不钉事件
  assert.equal(out.title, '修一下登录页分页')
  assert.equal(out.events.filter((e) => e.type === 'session/title').length, 0)
})

test('legacy task：原始 api_conversation_history 数组保留文本、推理与工具配对', () => {
  const raw = JSON.stringify([
    { role: 'user', content: 'legacy question' },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: '先读文件' },
      toolUse('legacy-call', 'read_file', { path: 'a.ts' }),
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'legacy-call', content: '内容' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ])
  const out = convertClineJson(raw, {
    legacyTask: true,
    clineId: 'legacy-1',
    createdAt: TS,
    cwd: CWD,
    title: 'Legacy task',
  })
  assert.equal(out.meta.sourceId, 'legacy-1')
  assert.equal(out.meta.cwd, CWD)
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].steps[0].content[0].type, 'reasoning')
  assert.equal(out.turns[0].steps[0].toolCalls[0].id, 'legacy-call')
  assert.deepEqual(out.turns[0].steps[0].toolResults[0].content, [{ type: 'text', text: '内容' }])
  assertToolPairing(out.events)
})

test('legacy task：按 taskHistory 的 deleted range 截断旧上下文并移除孤儿 tool_result', () => {
  const raw = JSON.stringify([
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'stale question' },
    { role: 'assistant', content: 'stale answer' },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'stale-call', content: 'stale output' },
      { type: 'text', text: 'current question' },
    ] },
    { role: 'assistant', content: 'current answer' },
  ])
  const out = convertClineJson(raw, {
    legacyTask: true, clineId: 'legacy-range', legacyDeletedRange: [2, 3], createdAt: TS,
  })
  assert.equal(out.turns.length, 2)
  assert.equal(out.turns[0].prompt, 'first')
  assert.equal(out.turns[1].prompt, 'current question')
  assert.equal(out.turns[1].steps[0].content[0].text, 'current answer')
  assert.equal(out.records, 4)
})

test('thinking + tool_use + tool_result（挂 user 消息）→ 推理/调用/结果同一步且配对', () => {
  const out = convertClineJson(session([
    user('读一下 a.ts'),
    assistant([
      { type: 'thinking', thinking: '先读文件' },
      toolUse('call_1', 'read_file', { path: 'a.ts' }),
    ], { modelInfo: { id: 'claude-sonnet-4-6', provider: 'anthropic' } }),
    toolResults(toolResult('call_1', [{ type: 'text', text: 'export const a = 1' }])),
    assistant([{ type: 'text', text: '只有一个导出。' }]),
  ]), { createdAt: TS })
  assert.equal(out.turns.length, 1) // tool_result 载体不开新轮
  assert.equal(out.turns[0].steps.length, 2)
  const [s1] = out.turns[0].steps
  assert.deepEqual(s1.content[0], { type: 'reasoning', text: '先读文件' })
  assert.deepEqual(s1.toolCalls, [{ type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' }])
  assert.equal(s1.toolResults.length, 1)
  assert.deepEqual(s1.toolResults[0].content, [{ type: 'text', text: 'export const a = 1' }])
  assert.equal(s1.toolResults[0].isError, false)
  assert.equal(out.messages, 4) // user + 2 assistant + tool result
  assert.equal(out.toolCalls, 1)
  assert.equal(out.droppedToolResults, 0)
  assertToolPairing(out.events)
})

test('is_error 结果如实标记；同一步多结果按 call 顺序对齐', () => {
  const out = convertClineJson(session([
    user('跑两条命令'),
    assistant([toolUse('c2', 'bash', { cmd: 'b' }), toolUse('c1', 'bash', { cmd: 'a' })]),
    // 结果乱序返回（并行工具）
    toolResults(
      toolResult('c1', [{ type: 'text', text: 'A' }], true),
      toolResult('c2', [{ type: 'text', text: 'B' }]),
    ),
  ]), { createdAt: TS })
  const step = out.turns[0].steps[0]
  assert.deepEqual(step.toolResults.map((r) => r.toolCallId), ['c2', 'c1']) // 按 call 顺序
  const byId = new Map(step.toolResults.map((r) => [r.toolCallId, r]))
  assert.equal(byId.get('c1').isError, true)
  assert.equal(byId.get('c2').isError, false)
  const events = out.events.filter((e) => e.type === 'tool/result')
  assert.deepEqual(events.map((e) => e.data.message.content[0].isError), [undefined, true]) // 非错误不落字段
  assertToolPairing(out.events)
})

test('一轮多条 assistant（上游 retry 语义）→ 各成一步，全部保留', () => {
  const out = convertClineJson(session([
    user('问题'),
    assistant([{ type: 'text', text: '第一次尝试' }], { modelInfo: { id: 'claude-sonnet-4-6', provider: 'anthropic' } }),
    assistant([{ type: 'text', text: '重试后的答复' }], {
      modelInfo: { id: 'claude-sonnet-4-6', provider: 'anthropic' },
      metrics: { inputTokens: 21, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
    }),
  ]), { createdAt: TS })
  assert.equal(out.turns[0].steps.length, 2)
  assert.equal(out.turns[0].steps[0].content[0].text, '第一次尝试')
  assert.equal(out.turns[0].steps[1].content[0].text, '重试后的答复')
  assert.equal(out.messages, 3)
})

test('同一 tool_use.id 重复出现 → 只保留首次（DSH 对重复 callId 会硬异常），计数上报', () => {
  const out = convertClineJson(session([
    user('看看'),
    assistant([toolUse('dup', 'read_file', { path: 'a.ts' })]),
    assistant([toolUse('dup', 'read_file', { path: 'a.ts' }), { type: 'text', text: '重发' }]),
    toolResults(toolResult('dup', [{ type: 'text', text: '内容' }])),
  ]), { createdAt: TS })
  assert.equal(out.droppedDuplicateCalls, 1)
  assert.equal(out.toolCalls, 1)
  assert.equal(out.events.filter((e) => e.type === 'tool/call').length, 1)
  // 第二步只留下文本块，重复的 tool-call 块被整块丢弃
  assert.deepEqual(out.turns[0].steps[1].content.map((b) => b.type), ['text'])
  assertToolPairing(out.events)
})

test('孤儿 tool_result（无匹配 tool_use）丢弃并计数', () => {
  const out = convertClineJson(session([
    user('问题'),
    assistant([{ type: 'text', text: '回答' }]),
    toolResults(toolResult('call_missing', [{ type: 'text', text: '来路不明' }])),
  ]), { createdAt: TS })
  assert.equal(out.droppedToolResults, 1)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.events.filter((e) => e.type === 'tool/result').length, 0)
})

test('子代理 / 团队会话（agent != lead）不单独成会话', () => {
  const out = convertClineJson(session([
    user('子任务'),
    assistant([{ type: 'text', text: '完成' }]),
  ], { agent: 'subagent', taskType: 'explore' }), { createdAt: TS })
  assert.equal(out.meta, null)
  assert.match(out.skipReason, /^Cline subagent session/)
  assert.equal(out.events.length, 0)
})

test('空文本 user 消息（非文本块）不开轮：不虚构提问', () => {
  const out = convertClineJson(session([
    userBlocks([{ type: 'image', source: { type: 'base64', data: 'x' } }]),
    assistant([{ type: 'text', text: '看到了' }]),
  ]), { createdAt: TS })
  assert.equal(out.turns.length, 0)
  // 无轮次 → 环境变更声明也不注入（与 synthesizeSession 的 turns.length > 0 判定一致）
  assert.equal(out.events.length, 0)
})

test('显式标题（DB 索引带入）→ 钉 session/title 事件', () => {
  const out = convertClineJson(session([user('随便问问'), assistant([{ type: 'text', text: '嗯' }])]), {
    createdAt: TS, title: '修登录页分页',
  })
  const titles = out.events.filter((e) => e.type === 'session/title')
  assert.equal(titles.length, 1)
  assert.equal(titles[0].data.title, '修登录页分页')
  assert.equal(out.title, '修登录页分页')
})

test('system_prompt 只在开关开启时收集为上下文注入', () => {
  const raw = session([user('问题'), assistant([{ type: 'text', text: '答' }])], { system_prompt: '你是 Cline。' })
  const off = convertClineJson(raw, { createdAt: TS })
  assert.equal(off.events.some((e) => e.data && Array.isArray(e.data.content)
    && e.data.content.some((b) => typeof b.text === 'string' && b.text.includes('你是 Cline。'))), false)

  const on = convertClineJson(raw, { createdAt: TS, importSystemPrompt: true })
  assert.equal(on.events.some((e) => e.data && Array.isArray(e.data.content)
    && e.data.content.some((b) => typeof b.text === 'string' && b.text.includes('你是 Cline。'))), true)
})

test('创建时间兜底优先级：args.createdAt > 首条消息 ts > updated_at', () => {
  const withTs = convertClineJson(session([user('问'), assistant([{ type: 'text', text: '答' }])]), {})
  assert.equal(withTs.meta.createdAt, TS) // assistant 的 ts

  const noTs = convertClineJson(session([user('问'), assistant([{ type: 'text', text: '答' }], { ts: undefined })]), {})
  assert.equal(noTs.meta.createdAt, Date.parse('2026-04-22T17:42:10.123Z')) // updated_at
})

test('content 为字符串形态、tool_result.content 为字符串 → 都不丢内容', () => {
  const out = convertClineJson(session([
    { id: 'u1', role: 'user', content: '字符串形态的提问' },
    { id: 'a1', role: 'assistant', content: '字符串形态的回答', ts: TS },
    { id: 'u2', role: 'user', content: '再跑一下' },
    assistant([toolUse('c1', 'bash', { cmd: 'x' })]),
    userBlocks([{ type: 'tool_result', tool_use_id: 'c1', content: '纯字符串输出' }]),
  ]), { createdAt: TS })
  assert.equal(out.turns.length, 2)
  assert.equal(out.turns[0].prompt, '字符串形态的提问')
  assert.equal(out.turns[0].steps[0].content[0].text, '字符串形态的回答')
  // tool_result 的字符串形态若只取数组分支会被吞成空结果
  assert.deepEqual(out.turns[1].steps[0].toolResults[0].content, [{ type: 'text', text: '纯字符串输出' }])
  assertToolPairing(out.events)
})

test('非 Cline 结构（无 messages 数组 / 非法 JSON）→ skipReason，不产出事件', () => {
  const noMessages = convertClineJson(JSON.stringify({ version: 1, sessionId: SID, history: [] }))
  assert.equal(noMessages.meta, null)
  assert.equal(noMessages.skipReason, 'not a Cline session (no messages array)')

  const bad = convertClineJson('{not json')
  assert.equal(bad.meta, null)
  assert.equal(bad.skipReason, 'not a Cline session (invalid JSON)')
})

// ---- import_cline 集成 ----

// 合成 Cline 会话（结构对齐 lib/convert/cline.mjs 的 v1 契约：Anthropic 原生块，
// 工具结果是挂在 user 消息上的 tool_result 块）。元数据分工与上游一致：cwd/标题在
// manifest（DB 优先，测试里命中 manifest 分支 —— DB 属真实 SQLite，见 cline-db.test.mjs）。
const CLINE_SID = '01J8Z6Q0M4V7X2K9TB3N5R8WDA'
const CLINE_CWD = hostAbs('D:/demo/cline-proj')
const CLINE_TS = '2026-04-22T17:40:00.000Z'
const CLINE_DIR = 'D:\\demo\\cline\\data\\sessions\\' + CLINE_SID + '\\'
function clineSession(messages, over = {}) {
  return JSON.stringify({
    version: 1, updated_at: '2026-04-22T17:42:10.123Z', agent: 'lead', sessionId: CLINE_SID, messages, ...over,
  })
}
function clineManifest(title) {
  return JSON.stringify({
    version: 1, session_id: CLINE_SID, started_at: CLINE_TS, cwd: CLINE_CWD,
    workspace_root: CLINE_CWD, metadata: { title },
  })
}
function clineUser(text) {
  return { id: 'u1', role: 'user', content: [{ type: 'text', text }], ts: 1776879600000 }
}
function clineAssistant(blocks) {
  return { id: 'a1', role: 'assistant', content: blocks, ts: 1776879601000 }
}

test('import_cline 压缩侧车：原生压缩检查点 + compacted/compactions 报告', async () => {
  const src = CLINE_DIR + CLINE_SID + '.messages.json'
  const { ctx, persistence } = makeCtx({
    [src]: clineSession([
      clineUser('第一件事'),
      clineAssistant([{ type: 'text', text: '做完了' }]),
      clineUser('第二件事'),
      clineAssistant([{ type: 'text', text: '好的' }]),
    ]),
    [CLINE_DIR + CLINE_SID + '.json']: clineManifest('压缩过的会话'),
    // Cline 的 SessionCompactionState：source_message_count 条 canonical 消息被折叠进摘要，
    // messages.json 仍保全量（侧车只给摘要与边界）
    [CLINE_DIR + CLINE_SID + '.compaction.json']: JSON.stringify({
      version: 1,
      updated_at: '2026-04-22T17:42:10.123Z',
      conversation_id: CLINE_SID,
      source_message_count: 2,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Context summary:\n\n此前在改登录页。' }], metadata: { kind: 'compaction_summary', displayRole: 'system', userRunSpan: 1, summary: '此前在改登录页。', details: { readFiles: [], modifiedFiles: [] }, tokensBefore: 100, generatedAt: 1 } },
        { role: 'user', content: [{ type: 'text', text: '第二件事' }] },
        { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
      ],
    }),
  })
  apply(ctx)
  const def = chatDef(ctx, 'cline')
  const value = await def.execute({ path: src })
  assert.equal(value.status, 'imported')
  assert.equal(value.compacted, true)
  assert.equal(value.compactions, 1)
  const saved = persistence.sessions.get('import-' + CLINE_SID)
  assert.ok(saved)
  assert.equal(saved.events.filter((e) => e.type === 'compaction/summary').length, 1)
  const ck = saved.events.find((e) => e.type === 'user/message' && typeof e.surfaceOp === 'object')
  assert.equal(ck.data.source.plugin, 'compact')
  assert.equal(ck.data.content[0].text, '此前在改登录页。')
  // 全量历史留在日志里（压缩只影响模型投影）
  assert.ok(saved.events.some((e) => JSON.stringify(e.data).includes('做完了')))
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('import_cline 单文件导入：manifest 带出 cwd/标题/创建时间、落盘归组、schema 校验', async () => {
  const src = CLINE_DIR + CLINE_SID + '.messages.json'
  const { ctx, persistence, attached } = makeCtx({
    [src]: clineSession([
      clineUser('修一下登录页分页'),
      clineAssistant([{ type: 'text', text: '已修好。' }]),
    ]),
    [CLINE_DIR + CLINE_SID + '.json']: clineManifest('修登录页分页'),
  })
  apply(ctx)
  const def = chatDef(ctx, 'cline')
  const value = await def.execute({ path: src })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-' + CLINE_SID)
  assert.equal(value.turns, 1)
  assert.equal(value.messages, 2)
  assert.equal(value.toolCalls, 0)
  assert.equal(value.alreadyImported, false)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get('import-' + CLINE_SID)
  assert.ok(saved)
  assert.equal(saved.meta.cwd, CLINE_CWD)
  assert.equal(saved.meta.createdAt, Date.parse(CLINE_TS)) // 只存在于 manifest / DB 索引
  assert.equal(saved.events.at(-1).type, 'session/title')
  assert.match(saved.events.at(-1).data.title, /^Cline · /)
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assertEnvelopeHygiene(saved.events)
  assert.equal(attached.length, 1)
  assert.equal(attached[0].id, 'import-' + CLINE_SID)
})

test('import_cline 工具历史：tool_result 块配对、思考落盘、is_error 如实标记', async () => {
  const src = CLINE_DIR + CLINE_SID + '.messages.json'
  const { ctx, persistence } = makeCtx({
    [src]: clineSession([
      clineUser('跑一下测试'),
      clineAssistant([
        { type: 'thinking', thinking: '先用命令跑' },
        { type: 'tool_use', id: 'toolu_1', name: 'run_tests', input: { command: 'npm test' } },
      ]),
      { id: 'u2', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok 42 passed', is_error: false }] },
      clineAssistant([{ type: 'text', text: '测试通过。' }]),
    ]),
  })
  apply(ctx)
  const def = chatDef(ctx, 'cline')
  const value = await def.execute({ path: src })
  assert.equal(value.mode, 'single')
  assert.equal(value.toolCalls, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get(value.sessionId)
  const result = saved.events.find((e) => e.type === 'tool/result')
  assert.ok(result)
  assert.deepEqual(result.sourceEventSeqs, [saved.events.find((e) => e.type === 'tool/call').seq])
  assert.equal(result.data.message.content[0].content[0].text, 'ok 42 passed')
  const reasoning = saved.events
    .flatMap((e) => (e.type === 'assistant/message' ? e.data.message.content : []))
    .filter((b) => b.type === 'reasoning')
  assert.deepEqual(reasoning, [{ type: 'reasoning', text: '先用命令跑' }])
})

test('import_cline 幂等：重复导入同一文件已存在则跳过', async () => {
  const src = CLINE_DIR + CLINE_SID + '.messages.json'
  const { ctx, persistence } = makeCtx({
    [src]: clineSession([clineUser('第一问'), clineAssistant([{ type: 'text', text: '一答' }])]),
  })
  apply(ctx)
  const def = chatDef(ctx, 'cline')
  const first = await def.execute({ path: src })
  const second = await def.execute({ path: src })
  assert.equal(first.alreadyImported, false)
  assert.equal(second.alreadyImported, true)
  assert.equal(persistence.sessions.size, 1)
})

test('import_cline legacy：taskHistory 元数据 + api history 经真实工具入口导入', async () => {
  const taskId = 'legacy-tool-001'
  const root = 'D:\\demo\\Code\\User\\globalStorage\\saoudrizwan.claude-dev'
  const src = root + '\\tasks\\' + taskId + '\\api_conversation_history.json'
  const state = root + '\\state\\taskHistory.json'
  const { ctx, persistence, attached } = makeCtx({
    [src]: JSON.stringify([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'stale question' },
      { role: 'assistant', content: 'stale answer' },
      { role: 'user', content: 'current question' },
      { role: 'assistant', content: 'current answer' },
    ]),
    [state]: JSON.stringify([{
      id: taskId, ts: 1786000000000, task: 'Legacy import', cwdOnTaskInitialization: hostAbs('D:/repo'),
      modelId: 'claude-sonnet', conversationHistoryDeletedRange: [2, 3],
    }]),
  })
  apply(ctx)
  const def = chatDef(ctx, 'cline')
  const value = await def.execute({ path: src })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-' + taskId)
  assert.equal(value.turns, 2)
  assert.equal(value.messages, 4)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get(value.sessionId)
  assert.ok(saved)
  assert.equal(saved.meta.cwd, hostAbs('D:/repo'))
  assert.equal(saved.meta.createdAt, 1786000000000)
  assert.match(saved.events.at(-1).data.title, /^Cline · Legacy import/)
  assert.equal(attached.length, 1)
})
