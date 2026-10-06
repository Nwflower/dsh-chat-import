// convert-jsonl-sources.test.mjs — JSONL 源转换（cursor / pi）
// composer id 派生、pi 压缩边界与保留窗口。
// 由 test/convert.test.mjs 按主题拆出（纯移动：用例与断言未改）。
import { test } from 'node:test'
import { assertNativeCompaction, derivedSurfaceMessages } from './_support/compaction.mjs'
import assert from 'node:assert/strict'

import { convertCursorJsonl, convertPiJsonl, SESSION_FORMAT_VERSION, validateSessionEvents } from '../lib/convert/index.mjs'
import { pinSourcedSessionTitle } from '../lib/sourced-title.mjs'

import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { assertToolPairing, assertMessageOrderLegal, assertSeqContinuity } from './_support/session-invariants.mjs'
import { loadFixture } from './_support/fixtures.mjs'
const load = loadFixture

test('convertCursorJsonl: 简单问答、user_query 剥离、平衡回合', () => {
  const out = convertCursorJsonl(load('cursor-simple.jsonl'), { cursorId: 'abc123', sourcePath: 'D:\\demo\\cursor\\composer-abc.jsonl' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 3) // user + assistant×2
  assert.equal(out.toolCalls, 0)
  assert.equal(out.meta.id, 'import-abc123') // cursorId 传入
  assert.equal(out.meta.sourceId, 'abc123')
  assertEnvelopeHygiene(out.events)
  const types = out.events.map((e) => e.type)
  assert.equal(types.filter((t) => t === 'turn/end').length, 1)
  assertSeqContinuity(out.events)
  // user_query 标签被剥离
  const user = out.events.find((e) => e.type === 'user/message' && e.data.source.kind === 'user').data
  assert.equal(user.content[0].text, 'Create a basic python interpreter in rust.')
  // provider
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.source, { kind: 'model', provider: 'cursor', model: 'cursor' })
})

test('convertCursorJsonl: tool_use → tool/call + 合成空 tool/result，input 对象序列化', () => {
  const out = convertCursorJsonl(load('cursor-tool.jsonl'))
  assert.equal(out.toolCalls, 2)
  const calls = out.events.filter((e) => e.type === 'tool/call')
  assert.equal(calls.length, 2)
  assert.notEqual(calls[0].data.callId, calls[1].data.callId)
  assert.equal(calls[0].data.name, 'Glob')
  assert.equal(calls[0].data.arguments, '{"target_directory":".","glob_pattern":"**/*.rs"}')
  assert.equal(calls[1].data.name, 'Read')
  // transcript 不含 tool_result → synthesizeSession 为每个 call 补发空 tool/result
  // （空 content，不虚构文本），保证 resume 时 call/result 配对
  const results = out.events.filter((e) => e.type === 'tool/result')
  assert.equal(results.length, 2)
  assert.deepEqual(results[0].data.message.content[0].content, [])
  assertToolPairing(out.events)
  // 平衡：最后（非 title）事件是 turn/end
  const types = out.events.map((e) => e.type)
  assert.equal([...types].reverse().find((t) => t !== 'session/title'), 'turn/end')
  assertMessageOrderLegal(out.events)
})

test('convertCursorJsonl: 同一步多个 tool_use 不重复 callId（避免 DSH 历史加载失败）', () => {
  const out = convertCursorJsonl(load('cursor-dual-tool-same-step.jsonl'))
  const calls = out.events.filter((e) => e.type === 'tool/call')
  assert.equal(calls.length, 2)
  const ids = calls.map((e) => e.data.callId)
  assert.equal(new Set(ids).size, 2, 'callId 必须唯一：' + ids.join(', '))
  const user = out.events.find((e) => e.type === 'user/message' && e.data.source.kind === 'user').data
  assert.ok(!user.content[0].text.includes('<timestamp>'), '用户正文应剥离 timestamp')
  assert.ok(!user.content[0].text.includes('<user_query>'), '用户正文应剥离 user_query')
  assertMessageOrderLegal(out.events)
})

test('convertCursorJsonl: pinSourcedSessionTitle 后标题为 Cursor · 话题', () => {
  const out = convertCursorJsonl(load('cursor-dual-tool-same-step.jsonl'))
  pinSourcedSessionTitle(out, 'Cursor')
  assert.match(out.title, /^Cursor · /)
  const titleEv = out.events.find((e) => e.type === 'session/title')
  assert.ok(titleEv)
  assert.match(titleEv.data.title, /^Cursor · /)
})

test('convertCursorJsonl: [REDACTED] 哨兵过滤', () => {
  const out = convertCursorJsonl(load('cursor-redacted.jsonl'))
  assert.equal(out.turns.length, 1)
  const texts = out.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message.content[0].text)
  // 整段 [REDACTED] 被丢弃；含前缀的保留前缀
  assert.deepEqual(texts, ['Applied the refactor.'])
  assert.equal(out.messages, 2) // user + 一条有效 assistant
})

test('convertCursorJsonl: 多轮切分、畸形行计数、无 cursorId 回退时间戳 id', () => {
  const out = convertCursorJsonl('not json\n' + load('cursor-multi-turn.jsonl'), {})
  assert.equal(out.skipped, 1)
  assert.equal(out.turns.length, 2)
  const starts = out.events.filter((e) => e.type === 'turn/start')
  assert.equal(starts.length, 2)
  // 无 cursorId 时 id 仍合法（时间戳回退）
  assert.match(out.meta.id, /^import-\d+$/)
})

test('convertPiJsonl: 简单问答、头行元数据、平衡回合', () => {
  const out = convertPiJsonl(load('pi-simple.jsonl'), { sourcePath: 'D:\\demo\\pi-proj\\2025-06-01_pi-simple.jsonl' })
  assert.equal(out.turns.length, 2)
  assert.equal(out.messages, 4)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.meta.id, 'import-019f0a11-2222-7333-8444-555566667777')
  assert.equal(out.meta.sourceId, '019f0a11-2222-7333-8444-555566667777')
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.cwd, 'D:\\demo\\pi-proj')
  assert.ok(out.meta.createdAt)
  assertEnvelopeHygiene(out.events)
  const types = out.events.map((e) => e.type)
  assert.equal(types.at(-1), 'turn/end')
  assertSeqContinuity(out.events)
  assert.equal(out.events.filter((e) => e.type === 'turn/start').length, 2)
  // assistant source.model 来自消息级 model
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.source, { kind: 'model', provider: 'pi-coding-agent', model: 'claude-sonnet-4-5' })
})

test('convertPiJsonl: 畸形行与疑似 secret 走共享逐行解析器上报（行号明细 + secrets 位置，失败要大声）', () => {
  const lines = load('pi-simple.jsonl').trimEnd().split('\n')
  lines.splice(2, 0, '{"type":"message", not json')
  lines.push(JSON.stringify({ type: 'label', id: 'z1', parentId: null, label: 'token=abcdefgh12345678' }))
  const out = convertPiJsonl(lines.join('\n'), {})
  assert.equal(out.skipped, 1)
  assert.deepEqual(out.skippedLines.map((s) => s.line), [3])
  assert.deepEqual(out.secrets, [{ line: lines.length, kind: 'token' }])
})

test('convertPiJsonl: 工具历史（arguments 对象序列化、thinking→reasoning、配对、孤儿丢弃、bash 注入文本）', () => {
  const out = convertPiJsonl(load('pi-tool.jsonl'), {})
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  assert.equal(out.droppedToolResults, 1) // call-missing 无对应调用 → 孤儿结果丢弃
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  const kinds = asst.content.map((c) => c.type)
  assert.ok(kinds.includes('reasoning'))
  assert.ok(kinds.includes('text'))
  assert.ok(kinds.includes('tool-call'))
  const call = out.events.find((e) => e.type === 'tool/call')
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.equal(call.data.callId, 'call-1')
  assert.equal(call.data.name, 'bash')
  assert.equal(call.data.arguments, '{"command":"ls -la"}')
  assert.equal(result.data.message.content[0].toolCallId, 'call-1')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
  // bashExecution 用 Pi 自身文本格式（Ran `cmd` + 输出）挂到当前轮最后一步
  const bash = out.turns[0].steps.at(-1).content.find((c) => c.type === 'text' && c.text.startsWith('Ran `git status`'))
  assert.ok(bash)
  assert.ok(bash.text.includes('On branch main'))
})

test('convertPiJsonl: 树结构——只重建活动分支、branch_summary→reasoning、session_info→标题、model_change→模型', () => {
  const out = convertPiJsonl(load('pi-branch.jsonl'), {})
  assert.equal(out.turns.length, 3) // 旁支「换成方案 B」不在活动路径上
  assert.deepEqual(out.turns.map((t) => t.prompt), ['重构这个模块', '试试方案 A', '继续方案 A'])
  // branch_summary 摘要用 Pi 固定措辞前置到下一个 assistant 步骤的 reasoning
  const head = out.turns[2].steps[0].content
  assert.equal(head[0].type, 'reasoning')
  assert.ok(head[0].text.includes('The following is a summary of a branch'))
  assert.ok(head[0].text.includes('方案 B 被放弃：性能不达标。'))
  // session_info 名称 → session/title；model_change 更新会话级模型
  assert.equal(out.title, '重构模块讨论')
  const titleEv = out.events.find((e) => e.type === 'session/title')
  assert.equal(titleEv.data.title, '重构模块讨论')
  const assts = out.events.filter((e) => e.type === 'assistant/message')
  assert.equal(assts[0].data.message.source.model, 'claude-sonnet-4-5')
  assert.equal(assts[2].data.message.source.model, 'gpt-5')
  assertMessageOrderLegal(out.events)
})

test('convertPiJsonl: compaction → 原生压缩检查点（保留窗口起点为边界），fullHistory 不发', () => {
  const out = convertPiJsonl(load('pi-compaction.jsonl'), {})
  assert.equal(out.compacted, true)
  assert.equal(out.compactions, 1)
  // 三个问题都在日志里（全量），但「第一个问题」被检查点遮蔽
  assert.deepEqual(out.turns.map((t) => t.prompt), ['第一个问题', '第二个问题', '第三个问题'])
  assert.deepEqual(out.turns.map((t) => t.shadowed === true), [true, false, false])
  assert.equal(out.turns[1].compaction.summary, '用户问了两个问题，都已经回答。')
  assert.equal(assertNativeCompaction(out.events), 1)
  // 摘要不再作 reasoning 块（改由检查点承载）
  const reasoning = out.events.filter((e) => e.type === 'assistant/message')
    .flatMap((e) => e.data.message.content).filter((b) => b.type === 'reasoning')
  assert.deepEqual(reasoning, [])
  // 模型看到：head → 声明 → 摘要 → 保留窗口（第二个问题起）
  const derived = derivedSurfaceMessages(out.events)
  assert.equal(derived[2], 'user:用户问了两个问题，都已经回答。')
  assert.deepEqual(derived.slice(3), ['user:第二个问题', 'assistant:第二个回答', 'user:第三个问题', 'assistant:第三个回答'])
  assert.equal(validateSessionEvents(out.events).ok, true)
  assertMessageOrderLegal(out.events)

  const full = convertPiJsonl(load('pi-compaction.jsonl'), { fullHistory: true })
  assert.equal(full.compacted, undefined)
  assert.equal(full.events.some((e) => e.type.startsWith('compaction/')), false)
  assert.equal(full.turns.length, 3) // 全量：三个问题都在
  assert.deepEqual(full.turns.map((t) => t.prompt), ['第一个问题', '第二个问题', '第三个问题'])
  assert.equal(derivedSurfaceMessages(full.events).length, 8) // head + 声明 + 3 轮问答
  assertMessageOrderLegal(full.events)
})

test('convertPiJsonl: v1 线性条目（无 id/parentId）顺序链兼容', () => {
  const out = convertPiJsonl(load('pi-v1.jsonl'), {})
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 2)
  assert.equal(out.meta.sourceId, '019f0a11-6666-7777-8888-999900001111')
  assert.equal(out.events.at(-1).type, 'turn/end')
  assertToolPairing(out.events)
})

test('convertPiJsonl: 无 session 头行 / 无用户回合 → skipped', () => {
  const out = convertPiJsonl('not json\n', {})
  assert.equal(out.meta, null)
  assert.equal(out.skipped, 1)
  assert.match(out.skipReason, /no session header/)
  // 只有 session 头、没有任何消息 → 不落空会话
  const empty = convertPiJsonl('{"type":"session","version":3,"id":"x","timestamp":"2025-06-05T10:00:00.000Z","cwd":"D:\\\\demo"}', {})
  assert.equal(empty.meta, null)
  assert.equal(empty.skipped, 1)
})
