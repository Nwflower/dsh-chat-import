// convert-claude.test.mjs — Claude Code 转换
// 流式拆行合并、isMeta、辅助 transcript 判定、压缩载体（现代 / 旧格式）、富结果 sidecar。
// 由 test/convert.test.mjs 按主题拆出（纯移动：用例与断言未改）。
import { test } from 'node:test'
import { assertNativeCompaction, derivedSurfaceMessages } from './_support/compaction.mjs'
import assert from 'node:assert/strict'
import { convertClaudeJsonl, SESSION_FORMAT_VERSION, validateSessionEvents } from '../lib/convert/index.mjs'
import { pinSourcedSessionTitle } from '../lib/sourced-title.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { assertToolPairing, assertMessageOrderLegal, assertSeqContinuity } from './_support/session-invariants.mjs'
import { loadFixture } from './_support/fixtures.mjs'
const load = loadFixture

test('convertClaudeJsonl: 简单问答合成平衡回合', () => {
  const out = convertClaudeJsonl(load('sess-simple-001.jsonl'), { sourcePath: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 2)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.meta.id, 'import-sess-simple-001')
  assert.equal(out.meta.sourceId, 'sess-simple-001')
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.cwd, 'D:\\demo\\proj')
  assert.ok(out.meta.createdAt)

  const types = out.events.map((e) => e.type)
  assert.deepEqual(types, [
    'turn/start', 'step/start', 'system/message', 'user/message', 'user/message', 'assistant/message', 'step/end', 'turn/end',
  ])
  // seq 连续从 0 开始；环境变更声明（plugin 注入）在首个 step/start 之后、真实提问之前
  assertSeqContinuity(out.events)
  assertEnvelopeHygiene(out.events)
  // surface 事件带 surfaceOp
  const surface = out.events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message')
  for (const e of surface) assert.equal(e.surfaceOp, 'append')
})

test('convertClaudeJsonl: 工具历史（tool/call + tool/result + thinking + 多步）', () => {
  const out = convertClaudeJsonl(load('sess-tool-001.jsonl'))
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  const types = out.events.map((e) => e.type)
  assert.ok(types.includes('tool/call'))
  assert.ok(types.includes('tool/result'))
  assert.ok(types.includes('step/end'))
  assert.ok(types.includes('turn/end'))
  // 平衡：最后一个事件是 turn/end
  assert.equal(types.at(-1), 'turn/end')

  // 每条 user/message 的 id 唯一
  const ids = out.events.filter((e) => e.type === 'user/message').map((e) => e.data.id)
  assert.equal(new Set(ids).size, ids.length)

  // reasoning block（thinking）映射
  const assistant = out.events.find((e) => e.type === 'assistant/message').data.message
  const kinds = assistant.content.map((c) => c.type)
  assert.ok(kinds.includes('reasoning'))
  assert.ok(kinds.includes('text'))
  assert.ok(kinds.includes('tool-call'))

  // tool/call 与 tool/result 关联：sourceEventSeqs 指向 tool/call 的 seq
  const call = out.events.find((e) => e.type === 'tool/call')
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.equal(call.data.callId, 'toolu_01')
  assert.equal(result.data.message.content[0].toolCallId, 'toolu_01')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.equal(result.surfaceOp, 'append')
  assertMessageOrderLegal(out.events)
})

test('convertClaudeJsonl: 多步回合（一步一个 assistant 消息）', () => {
  const out = convertClaudeJsonl(load('sess-multi-001.jsonl'))
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].steps.length, 2)
  const steps = out.events.filter((e) => e.type === 'step/start')
  assert.equal(steps.length, 2)
  assert.equal(steps[0].data.step, 1)
  assert.equal(steps[1].data.step, 2)
  const messages = out.events.filter((e) => e.type === 'assistant/message')
  assert.equal(messages.length, 2)
  assert.equal(messages[0].data.step, 1)
  assert.equal(messages[1].data.step, 2)
  // user/message 只在第一步出现（环境变更声明不计入真实 user 消息）
  const users = out.events.filter((e) => e.type === 'user/message' && e.data.source.kind === 'user')
  assert.equal(users.length, 1)
  assertMessageOrderLegal(out.events)
})

test('convertClaudeJsonl: ai-title → session/title 事件', () => {
  const out = convertClaudeJsonl(load('sess-title-001.jsonl'))
  assert.equal(out.title, '项目问题讨论')
  const titleEv = out.events.find((e) => e.type === 'session/title')
  assert.ok(titleEv)
  assert.equal(titleEv.data.title, '项目问题讨论')
  assert.deepEqual(titleEv.data.messageSeqs, [])
  assert.deepEqual(titleEv.data.source, { kind: 'user' })
})

test('convertClaudeJsonl: 畸形行计数', () => {
  const out = convertClaudeJsonl(load('sess-bad-001.jsonl'))
  assert.equal(out.skipped, 1)
  assert.equal(out.records, 2)
  assert.equal(out.turns.length, 1)
})

test('convertClaudeJsonl: 未回答的提问也成回合', () => {
  const out = convertClaudeJsonl(load('sess-empty-001.jsonl'), { sourcePath: 'D:\\demo\\proj\\sess-empty-001.jsonl' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 1)
  const types = out.events.map((e) => e.type)
  // 首轮无 step（只有提问、没有回复）：为 head 补一个只装 head 的空 step，环境变更声明与
  // head 一起落在该 step 内——声明必须排在**所有会话节点之前**，否则压缩检查点（native
  // compaction 的遮蔽范围是连续区间）会把迁移说明一并遮蔽掉。
  assert.deepEqual(types, ['turn/start', 'step/start', 'system/message', 'user/message', 'step/end', 'user/message', 'turn/end'])
})

test('convertClaudeJsonl: 数组格式 user content（纯文本块）开新轮（issue #21 复现）', () => {
  // Claude Code 新版对直接提问也写 content:[{type:"text",...}]；此前落入 tool_result
  // 分支被静默丢弃 → 0 轮导入，整段对话丢失
  const raw = [
    '{"type":"user","sessionId":"t","cwd":"/tmp","timestamp":"2026-08-01T00:00:00Z","uuid":"u1","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}',
    '{"type":"assistant","sessionId":"t","cwd":"/tmp","timestamp":"2026-08-01T00:00:01Z","uuid":"u2","message":{"model":"claude","content":[{"type":"text","text":"hi"}]}}',
  ].join('\n')
  const out = convertClaudeJsonl(raw, { fileStem: 't' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].prompt, 'hello')
  assert.equal(out.messages, 2)
  assert.equal(out.droppedUserPrompts, 0)
  assert.equal(out.skipReason, undefined)
  assertMessageOrderLegal(out.events)
  const userMsg = out.events.find((e) => e.type === 'user/message' && e.data.source.kind === 'user')
  assert.equal(userMsg.data.content[0].text, 'hello')
})

test('convertClaudeJsonl: 多 text 块数组拼接为 prompt（换行分隔）', () => {
  const raw = [
    '{"type":"user","sessionId":"t","message":{"role":"user","content":[{"type":"text","text":"第一段"},{"type":"text","text":"第二段"}]}}',
    '{"type":"assistant","sessionId":"t","message":{"role":"assistant","content":[{"type":"text","text":"回答"}]}}',
  ].join('\n')
  const out = convertClaudeJsonl(raw, { fileStem: 't' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].prompt, '第一段\n第二段')
})

test('convertClaudeJsonl: 混合转录——字符串/数组提问开轮，tool_result 数组仍走工具结果（issue #21 文件 B 形态）', () => {
  // 与 issue #21 实测文件 B 同构：字符串提问 + 数组提问 + tool_result 载体混合，
  // 此前数组提问（11 条）被静默丢弃
  const raw = [
    JSON.stringify({ type: 'user', sessionId: 's', message: { role: 'user', content: '字符串提问' } }),
    JSON.stringify({ type: 'assistant', sessionId: 's', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'ls' } }] } }),
    JSON.stringify({ type: 'user', sessionId: 's', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '{"type":"text","text":"out"}' }] } }),
    JSON.stringify({ type: 'assistant', sessionId: 's', message: { role: 'assistant', content: [{ type: 'text', text: '回答1' }] } }),
    JSON.stringify({ type: 'user', sessionId: 's', message: { role: 'user', content: [{ type: 'text', text: '数组提问' }] } }),
    JSON.stringify({ type: 'assistant', sessionId: 's', message: { role: 'assistant', content: [{ type: 'text', text: '回答2' }] } }),
  ].join('\n')
  const out = convertClaudeJsonl(raw, { fileStem: 's' })
  assert.equal(out.turns.length, 2)
  assert.equal(out.turns[0].prompt, '字符串提问')
  assert.equal(out.turns[1].prompt, '数组提问')
  assert.equal(out.messages, 6) // 2 提问 + 3 回答（含 tool_use 条）+ 1 tool_result
  assert.equal(out.toolCalls, 1)
  assert.equal(out.droppedUserPrompts, 0)
  assert.equal(out.droppedToolResults, 0)
  assertMessageOrderLegal(out.events)
})

test('convertClaudeJsonl: 无法解析的 user content 计数并在 0 轮时显式标注丢失（issue #21）', () => {
  const raw = [
    '{"type":"user","sessionId":"t","message":{"role":"user","content":123}}',
    '{"type":"assistant","sessionId":"t","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
  ].join('\n')
  const out = convertClaudeJsonl(raw, { fileStem: 't' })
  assert.equal(out.turns.length, 0)
  assert.equal(out.droppedUserPrompts, 1)
  assert.ok(out.skipReason && out.skipReason.includes('0 轮') && out.skipReason.includes('无法解析'))
})

test('convertClaudeJsonl: sessionId 覆盖参数生效', () => {
  const out = convertClaudeJsonl(load('sess-simple-001.jsonl'), { sessionId: 'custom-id', sourcePath: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(out.meta.id, 'custom-id')
  // sourceId 显式取自源记录，不因 DSH 会话 id 覆盖/前缀解析而改变（REQ-32）
  assert.equal(out.meta.sourceId, 'sess-simple-001')
  assertEnvelopeHygiene(out.events)
  const ids = out.events.filter((e) => e.type === 'user/message').map((e) => e.data.id)
  // 首条是环境变更声明（import:custom-id:env），真实提问在其后
  assert.ok(ids.some((id) => id.startsWith('import:custom-id:u1')))
})

test('convertClaudeJsonl: 空输入不产生事件', () => {
  const out = convertClaudeJsonl('')
  assert.equal(out.events.length, 0)
  assert.equal(out.turns.length, 0)
})

test('convertClaudeJsonl: 主 transcript（fileStem 与 sessionId 一致）正常导入', () => {
  const out = convertClaudeJsonl(load('sess-simple-001.jsonl'), { fileStem: 'sess-simple-001' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.meta.id, 'import-sess-simple-001')
  assert.equal(out.skipReason, undefined)
})

test('convertClaudeJsonl: 辅助 transcript（fileStem ≠ sessionId）跳过并给原因', () => {
  // 辅助 transcript（如 subagents/agent-*.jsonl）记录携带父 sessionId，
  // 文件名与之不一致：不得按记录 sessionId 建会话（会与主 transcript 撞 id）
  const out = convertClaudeJsonl(load('sess-simple-001.jsonl'), { fileStem: 'agent-abc123' })
  assert.equal(out.meta, null)
  assert.equal(out.events.length, 0)
  assert.equal(out.turns.length, 0)
  assert.ok(out.skipReason.includes('auxiliary'))
  assert.ok(out.skipReason.includes('sess-simple-001'))
})

test('convertClaudeJsonl: 无 fileStem 参数保持原行为（纯函数直接调用不受限）', () => {
  const out = convertClaudeJsonl(load('sess-simple-001.jsonl'))
  assert.equal(out.turns.length, 1)
  assert.equal(out.meta.id, 'import-sess-simple-001')
})

test('convertClaudeJsonl: 后置的 tool/result 挂到 call 所属 step（不落最近一步）', () => {
  // 异步工具：调用在 step1，结果随后续 assistant（step2）之后到达。tool_result
  // 必须挂回 call 所属 step（step1），否则投影顺序里带 tool_calls 的 assistant
  // 后面紧跟另一条 assistant（step2），违反 wire 规则。
  const raw = [
    '{"sessionId":"sess-cross-001","type":"user","message":{"role":"user","content":"请查一下"}}',
    '{"sessionId":"sess-cross-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"好"},{"type":"tool_use","id":"toolu_01","name":"fs_read","input":{}}]}}',
    '{"sessionId":"sess-cross-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"继续"}]}}',
    '{"sessionId":"sess-cross-001","type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":[{"type":"text","text":"结果"}]}]}}',
  ].join('\n')
  const out = convertClaudeJsonl(raw, { fileStem: 'sess-cross-001' })
  const call = out.events.find((e) => e.type === 'tool/call')
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.ok(call)
  assert.ok(result)
  assert.equal(call.data.step, 1)
  assert.equal(result.data.step, 1) // 挂到 call 所属 step，而不是结果到达时的最近一步（2）
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.equal(result.surfaceOp, 'append')
  // 投影顺序：user → assistant(带 tool-call) → tool → assistant，合法
  const msgs = assertMessageOrderLegal(out.events)
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'user', 'assistant', 'tool', 'assistant'])
})

test('convertClaudeJsonl: 中断的 tool_use（无 tool_result）补发空 tool/result', () => {
  // 会话在工具结果返回前中断：assistant 带 tool_use 但没有后续 tool_result。
  // 不补 result 的话 resume 时模型 API 拒绝（tool_calls 无对应 tool 消息）。
  const raw = [
    '{"sessionId":"sess-cut-001","type":"user","message":{"role":"user","content":"跑一下测试"}}',
    '{"sessionId":"sess-cut-001","type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_02","name":"Bash","input":{"command":"npm test"}}]}}',
  ].join('\n')
  const out = convertClaudeJsonl(raw, { fileStem: 'sess-cut-001' })
  assert.equal(out.toolCalls, 1)
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.ok(result)
  // 补发结果：空 content、sourceEventSeqs 指向其 call、同 step
  assert.deepEqual(result.data.message.content[0].content, [])
  assert.equal(result.data.message.content[0].toolCallId, 'toolu_02')
  assert.equal(result.surfaceOp, 'append')
  assertToolPairing(out.events)
  // 平衡：turn/end 收尾
  assert.equal(out.events.at(-1).type, 'turn/end')
  assertMessageOrderLegal(out.events)
})

test('convertClaudeJsonl: assistant 连续 tool_use、结果后置 → 投影顺序合法', () => {
  // Claude 源格式：assistant[callA] assistant[callB] user[resultA] user[resultB]
  // （结果后置）。结果必须挂回各自 call 的 step，投影顺序才是
  // user → assistant(A) → tool(A) → assistant(B) → tool(B)；挂最近一步会变成
  // assistant(A) → assistant(B) → tool(A) → tool(B)，被模型 API 拒绝。
  const raw = [
    '{"sessionId":"sess-post-001","type":"user","message":{"role":"user","content":"并行读两个文件"}}',
    '{"sessionId":"sess-post-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"读 A"},{"type":"tool_use","id":"toolu_A","name":"Read","input":{"file":"a.txt"}}]}}',
    '{"sessionId":"sess-post-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"读 B"},{"type":"tool_use","id":"toolu_B","name":"Read","input":{"file":"b.txt"}}]}}',
    '{"sessionId":"sess-post-001","type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_A","content":[{"type":"text","text":"A 内容"}]}]}}',
    '{"sessionId":"sess-post-001","type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_B","content":[{"type":"text","text":"B 内容"}]}]}}',
  ].join('\n')
  const out = convertClaudeJsonl(raw, { fileStem: 'sess-post-001' })
  assert.equal(out.toolCalls, 2)
  assert.equal(out.droppedToolResults, 0)
  const msgs = assertMessageOrderLegal(out.events)
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'user', 'assistant', 'tool', 'assistant', 'tool'])
  // 每条 tool 消息与其 call 的 assistant 同 step
  const calls = out.events.filter((e) => e.type === 'tool/call')
  const results = out.events.filter((e) => e.type === 'tool/result')
  assert.deepEqual(calls.map((c) => [c.data.callId, c.data.step]), [['toolu_A', 1], ['toolu_B', 2]])
  assert.deepEqual(results.map((r) => [r.data.message.content[0].toolCallId, r.data.step]), [['toolu_A', 1], ['toolu_B', 2]])
})

test('convertClaudeJsonl: 同 step 内多个 tool_result 按 call 顺序对齐', () => {
  // 并行工具：一个 assistant 消息带两个 tool_use，结果乱序返回（resultB 先到）。
  // 结果必须按该 step 的 toolCalls 顺序（A 在 B 前）对齐，保证投影出的 tool
  // 消息与 assistant 的 tool_calls 一一对应、顺序一致。
  const raw = [
    '{"sessionId":"sess-align-001","type":"user","message":{"role":"user","content":"读两个文件"}}',
    '{"sessionId":"sess-align-001","type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file":"a"}},{"type":"tool_use","id":"toolu_2","name":"Read","input":{"file":"b"}}]}}',
    '{"sessionId":"sess-align-001","type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_2","content":[{"type":"text","text":"B"}]},{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"A"}]}]}}',
  ].join('\n')
  const out = convertClaudeJsonl(raw, { fileStem: 'sess-align-001' })
  const results = out.events.filter((e) => e.type === 'tool/result').map((r) => r.data.message.content[0].toolCallId)
  assert.deepEqual(results, ['toolu_1', 'toolu_2'])
  assertMessageOrderLegal(out.events)
})

test('convertClaudeJsonl: 无对应 tool_use 的孤儿 tool_result 丢弃并计数', () => {
  // transcript 里出现没有对应 tool_use 的 tool_result（如从中途开始的文件）。
  // 挂 lastStep 会投影出无 call 的孤儿 tool 消息，被模型 API 拒绝 → 丢弃并计数。
  const raw = [
    '{"sessionId":"sess-orphan-001","type":"user","message":{"role":"user","content":"继续"}}',
    '{"sessionId":"sess-orphan-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"好的"}]}}',
    '{"sessionId":"sess-orphan-001","type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_ghost","content":[{"type":"text","text":"幽灵结果"}]}]}}',
  ].join('\n')
  const out = convertClaudeJsonl(raw, { fileStem: 'sess-orphan-001' })
  assert.equal(out.droppedToolResults, 1)
  assert.equal(out.events.filter((e) => e.type === 'tool/result').length, 0)
  assertMessageOrderLegal(out.events)
})

test('convertClaudeJsonl: 部分调用无结果 → 空 result 补在 call 所属 step', () => {
  // step1 调用 A 有真实结果；step2 调用 B 的结果从未到达（中断）。
  // 兜底空 result 必须补在 B 自己的 step，保持每条 tool 消息紧邻其 assistant。
  const raw = [
    '{"sessionId":"sess-mix-001","type":"user","message":{"role":"user","content":"跑一下"}}',
    '{"sessionId":"sess-mix-001","type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_A","name":"Bash","input":{"command":"a"}}]}}',
    '{"sessionId":"sess-mix-001","type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_A","content":[{"type":"text","text":"A 结果"}]}]}}',
    '{"sessionId":"sess-mix-001","type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_B","name":"Bash","input":{"command":"b"}}]}}',
  ].join('\n')
  const out = convertClaudeJsonl(raw, { fileStem: 'sess-mix-001' })
  assert.equal(out.toolCalls, 2)
  const results = out.events.filter((e) => e.type === 'tool/result')
  assert.equal(results.length, 2)
  const byId = Object.fromEntries(results.map((r) => [r.data.message.content[0].toolCallId, r]))
  assert.equal(byId['toolu_A'].data.step, 1)
  assert.equal(byId['toolu_A'].data.message.content[0].content[0].text, 'A 结果')
  assert.equal(byId['toolu_B'].data.step, 2) // 空 result 补在 call 自己的 step
  assert.deepEqual(byId['toolu_B'].data.message.content[0].content, [])
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
})

test('REQ-22 convertClaudeJsonl: 旧格式 summary 记录 → 原生压缩检查点（全量留日志、模型见摘要+之后）', () => {
  const lines = [
    JSON.stringify({ sessionId: 'sess-comp-001', type: 'user', message: { role: 'user', content: '问题1' } }),
    JSON.stringify({ sessionId: 'sess-comp-001', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '回答1' }] } }),
    JSON.stringify({ sessionId: 'sess-comp-001', type: 'summary', summary: '第一段总结', title: '压缩标题' }),
    JSON.stringify({ sessionId: 'sess-comp-001', type: 'user', message: { role: 'user', content: '继续问题' } }),
    JSON.stringify({ sessionId: 'sess-comp-001', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '继续回答' }] } }),
    JSON.stringify({ sessionId: 'sess-comp-001', type: 'summary', summary: '最终总结：需求已完成', title: '最终标题' }),
    JSON.stringify({ sessionId: 'sess-comp-001', type: 'user', message: { role: 'user', content: '收尾' } }),
    JSON.stringify({ sessionId: 'sess-comp-001', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '收尾回答' }] } }),
  ].join('\n')
  const full = convertClaudeJsonl(lines, { fileStem: 'sess-comp-001' })
  assert.equal(full.turns.length, 3)
  assert.equal(full.compactions, 2) // 两条 summary 记录 = 两次压缩边界
  assert.equal(full.compacted, true)
  // 全量历史留在日志里（含压缩前的两轮）
  const texts = full.events.filter((e) => e.type === 'assistant/message')
    .flatMap((e) => e.data.message.content).filter((b) => b.type === 'text').map((b) => b.text)
  assert.deepEqual(texts, ['回答1', '继续回答', '收尾回答'])
  // 原生事务：第二次检查点遮蔽「第一个检查点 + 其后的轮」
  assert.equal(assertNativeCompaction(full.events), 2)
  const summaries = full.events.filter((e) => e.type === 'compaction/summary')
  assert.deepEqual(summaries.map((e) => e.data.summary[0].text), ['第一段总结', '最终总结：需求已完成'])
  // 模型看到的：head → 迁移声明 → 最后一次检查点 → 压缩后内容
  const derived = derivedSurfaceMessages(full.events)
  assert.deepEqual(derived.map((d) => d.slice(0, 12)), ['system:', 'user:<system', 'user:最终总结：需求', 'user:收尾', 'assistant:收尾'])
  assert.ok(!derived.some((d) => d.includes('回答1')), '被遮蔽内容不进模型上下文')
  // 标题取最后一次 summary 的 summary 字段（标题载体扫描覆盖全量记录）
  assert.equal(full.title, '最终总结：需求已完成')
  // 事件平衡（session/title 钉在最后，不破坏回合平衡）
  const types = full.events.map((e) => e.type)
  assert.equal([...types].reverse().find((t) => t !== 'session/title'), 'turn/end')
  assert.equal(validateSessionEvents(full.events).ok, true)
  // fullHistory：不发检查点（模型看到全量）
  const noCk = convertClaudeJsonl(lines, { fileStem: 'sess-comp-001', fullHistory: true })
  assert.equal(noCk.compacted, undefined)
  assert.equal(noCk.events.some((e) => e.type.startsWith('compaction/')), false)
  assert.equal(derivedSurfaceMessages(noCk.events).length, 8) // head + 声明 + 3 轮问答
  // 无 summary 记录 → 无检查点（全量导入）
  const noSummary = convertClaudeJsonl([
    JSON.stringify({ sessionId: 'sess-comp-001', type: 'user', message: { role: 'user', content: '问题1' } }),
    JSON.stringify({ sessionId: 'sess-comp-001', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '回答1' }] } }),
  ].join('\n'), { fileStem: 'sess-comp-001' })
  assert.equal(noSummary.compacted, undefined)
  assert.equal(noSummary.turns.length, 1)
})

test('claude: custom-title 记录（/rename）覆盖 ai-title 与首问，后到者胜', () => {
  const raw = [
    '{"sessionId":"sess-ct-001","type":"user","message":{"role":"user","content":"第一个问题"}}',
    '{"sessionId":"sess-ct-001","type":"ai-title","aiTitle":"AI 生成的标题"}',
    '{"sessionId":"sess-ct-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"回答"}]}}',
    '{"sessionId":"sess-ct-001","type":"custom-title","customTitle":"旧名字"}',
    '{"sessionId":"sess-ct-001","type":"custom-title","customTitle":"新名字"}',
  ].join('\n')
  const out = convertClaudeJsonl(raw, { fileStem: 'sess-ct-001' })
  assert.equal(out.title, '新名字') // 后到的 custom-title = 当前标题
  const titleEv = out.events.find((e) => e.type === 'session/title')
  assert.ok(titleEv)
  assert.equal(titleEv.data.title, '新名字')
  // 空白 custom-title 不算标题（退回 ai-title）
  const blank = convertClaudeJsonl(raw.replace('"customTitle":"新名字"', '"customTitle":"   "'), { fileStem: 'sess-ct-001' })
  assert.equal(blank.title, '旧名字')
  // 旧格式 summary 记录（2.0.x 标题载体）与 custom-title 并存时以 custom-title 为准
  const both = convertClaudeJsonl([
    '{"sessionId":"sess-ct-002","type":"summary","summary":"旧格式生成标题"}',
    '{"sessionId":"sess-ct-002","type":"user","message":{"role":"user","content":"第一个问题"}}',
    '{"sessionId":"sess-ct-002","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"回答"}]}}',
    '{"sessionId":"sess-ct-002","type":"custom-title","customTitle":"用户重命名"}',
  ].join('\n'), { fileStem: 'sess-ct-002' })
  assert.equal(both.title, '用户重命名')
})

test('claude: 注入块不作标题（首问兜底跳过斜杠命令日志，取首个真实提问）', () => {
  const turns = (prompts, sid = 'sess-inj-001') => prompts.flatMap((p, i) => [
    JSON.stringify({ sessionId: sid, type: 'user', message: { role: 'user', content: p } }),
    JSON.stringify({ sessionId: sid, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '回答' + i }] } }),
  ]).join('\n')
  // 斜杠命令日志在前、真实提问在后：跳过注入块取真实提问
  const out = convertClaudeJsonl(turns([
    '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.',
    '<command-name>/model</command-name> <command-message>model</command-message> <command-args></command-args>',
    '<local-command-stdout>Set model to `Opus`</local-command-stdout>',
    '真实提问',
  ]), { fileStem: 'sess-inj-001' })
  assert.equal(out.title, '真实提问')
  // 整场只有本地命令 → 无话题（不钉 session/title，由 sourced-title 落「未命名 · 日期」）
  const onlyLocal = convertClaudeJsonl(turns([
    '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.',
    '<command-name>/recap</command-name> <command-message>recap</command-message> <command-args></command-args>',
  ], 'sess-inj-002'), { fileStem: 'sess-inj-002' })
  assert.equal(onlyLocal.title, '')
  assert.equal(onlyLocal.events.some((e) => e.type === 'session/title'), false)
  pinSourcedSessionTitle(onlyLocal, 'Claude Code')
  assert.match(onlyLocal.title, /^Claude · 未命名 · \d{4}-\d{2}-\d{2}$/)
  // 粘贴信封不进口题：剥掉 <pasted_content> 标签只留正文（闭标签可能带 id、也可能缺失）
  const pasted = convertClaudeJsonl(turns([
    '<pasted_content id="1b70">\n首页在没有选中工作区时长这样，希望改成下面的样子：1. …\n</pasted_content>',
  ], 'sess-inj-003'), { fileStem: 'sess-inj-003' })
  assert.equal(pasted.title, '首页在没有选中工作区时长这样，希望改成下面的样子：1. …')
  const pastedNoClose = convertClaudeJsonl(turns([
    '\n\n<pasted_content id="2e28">\n问题正文，闭标签缺失',
  ], 'sess-inj-004'), { fileStem: 'sess-inj-004' })
  assert.equal(pastedNoClose.title, '问题正文，闭标签缺失')
  const pastedAfterText = convertClaudeJsonl(turns([
    '这是提问吗？\n\n<pasted_content id="48cd">\n贴进来的正文\n</pasted_content id="48cd">',
  ], 'sess-inj-005'), { fileStem: 'sess-inj-005' })
  assert.equal(pastedAfterText.title, '这是提问吗？ 贴进来的正文')
})

test('claude compacted：现代压缩载体，摘要作 reasoning、只留尾部、标题载体不随切片丢失', () => {
  const aiTitle = { sessionId: 'sess-comp2-001', type: 'ai-title', aiTitle: '压缩前的 AI 标题' }
  const boundary = {
    sessionId: 'sess-comp2-001', type: 'system', subtype: 'compact_boundary',
    content: 'Conversation compacted', level: 'info', compactMetadata: { trigger: 'manual', preTokens: 421159, postTokens: 13571 },
  }
  const summaryUser = (text) => ({
    sessionId: 'sess-comp2-001', type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true,
    message: { role: 'user', content: text },
  })
  const user = (text) => ({ sessionId: 'sess-comp2-001', type: 'user', message: { role: 'user', content: text } })
  const asst = (text) => ({ sessionId: 'sess-comp2-001', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
  const firstSummary = 'This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. 第一段要点'
  const lastSummary = 'This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. 最后一段要点'
  const lines = [
    user('问题1'), asst('回答1'), aiTitle,
    boundary, summaryUser(firstSummary),
    user('问题2'), asst('回答2'),
    boundary, summaryUser(lastSummary),
    user('继续问题'), asst('继续回答'),
  ].map((r) => JSON.stringify(r)).join('\n')

  // 默认（尊重压缩）：全量记录留日志，两次边界各发一个原生检查点
  const out = convertClaudeJsonl(lines, { fileStem: 'sess-comp2-001' })
  assert.equal(out.compacted, true)
  assert.equal(out.compactions, 2)
  assert.equal(out.turns.length, 3) // 三条人类提问；isCompactSummary 记录不是人类提问
  assert.deepEqual(out.turns.map((t) => t.prompt), ['问题1', '问题2', '继续问题'])
  const summaries = out.events.filter((e) => e.type === 'compaction/summary')
  assert.deepEqual(summaries.map((e) => e.data.summary[0].text), [firstSummary, lastSummary])
  assert.equal(assertNativeCompaction(out.events), 2)
  // 模型看到的是「最后一次摘要 + 压缩点之后的内容」；压缩前的两轮被遮蔽
  const derived = derivedSurfaceMessages(out.events)
  assert.equal(derived[2], 'user:' + lastSummary)
  assert.ok(derived.some((d) => d.includes('继续回答')))
  assert.ok(!derived.some((d) => d.includes('回答1') || d.includes('回答2')))
  // 标题载体在压缩边界**之前**（ai-title）也不受影响（标题在全量记录上取）
  assert.equal(out.title, '压缩前的 AI 标题')
  const titleEv = out.events.find((e) => e.type === 'session/title')
  assert.equal(titleEv.data.title, '压缩前的 AI 标题')

  // fullHistory：不发检查点，压缩摘要记录按普通 user 记录导入（摘要正文不丢）
  const full = convertClaudeJsonl(lines, { fileStem: 'sess-comp2-001', fullHistory: true })
  assert.equal(full.compacted, undefined)
  assert.equal(full.events.some((e) => e.type.startsWith('compaction/')), false)
  assert.equal(full.turns.length, 5) // 3 条人类提问 + 2 条压缩续接记录

  // 只有 compact_boundary、没有摘要正文 → 不发检查点（不静默丢前半段）
  const boundaryOnly = [user('问题1'), asst('回答1'), boundary, user('问题2'), asst('回答2')]
    .map((r) => JSON.stringify(r)).join('\n')
  const kept = convertClaudeJsonl(boundaryOnly, { fileStem: 'sess-comp2-001' })
  assert.equal(kept.compacted, undefined)
  assert.equal(kept.turns.length, 2)
})

test('claude compacted：自动压缩后没有新提问的续跑内容归入压缩边界轮，事件时间取源时间戳', () => {
  const at = (s) => '2026-09-30T12:' + s + 'Z'
  const lines = [
    { sessionId: 'sess-comp4-001', type: 'user', timestamp: at('00:00.000'), message: { role: 'user', content: '部署' } },
    { sessionId: 'sess-comp4-001', type: 'assistant', timestamp: at('01:00.000'), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'ls' } }] } },
    { sessionId: 'sess-comp4-001', type: 'user', timestamp: at('02:00.000'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'a.txt' }] } },
    { sessionId: 'sess-comp4-001', type: 'user', isCompactSummary: true, timestamp: at('33:16.000'), message: { role: 'user', content: 'Summary:\n要点' } },
    { sessionId: 'sess-comp4-001', type: 'assistant', timestamp: at('34:00.000'), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'pwd' } }] } },
    { sessionId: 'sess-comp4-001', type: 'user', timestamp: at('35:00.000'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: '/tmp' }] } },
    { sessionId: 'sess-comp4-001', type: 'assistant', timestamp: at('59:00.000'), message: { role: 'assistant', content: [{ type: 'text', text: '已部署' }] } },
  ].map((r) => JSON.stringify(r)).join('\n')
  const out = convertClaudeJsonl(lines, { fileStem: 'sess-comp4-001' })
  assert.deepEqual(out.turns.map((t) => [t.prompt, t.steps.length, Boolean(t.compaction)]), [['部署', 1, false], ['', 2, true]])
  assert.equal(assertNativeCompaction(out.events), 1)
  const derived = derivedSurfaceMessages(out.events)
  assert.ok(derived.some((d) => d.includes('已部署')))
  const timeOf = (pred) => out.events.find(pred).time
  assert.equal(out.meta.createdAt, Date.parse(at('00:00.000')))
  assert.equal(timeOf((e) => e.type === 'tool/result' && e.data.message.content[0].toolCallId === 'toolu_b'), Date.parse(at('35:00.000')))
  assert.equal(timeOf((e) => e.type === 'compaction/summary'), Date.parse(at('33:16.000')))
  assert.equal(out.events.at(-2).time, Date.parse(at('59:00.000')))
  assert.ok(out.events.every((e, i) => i === 0 || e.time >= out.events[i - 1].time))
})

test('claude compacted：custom-title（/rename）在压缩边界之前时仍是标题', () => {
  const lines = [
    { sessionId: 'sess-comp3-001', type: 'user', message: { role: 'user', content: '问题1' } },
    { sessionId: 'sess-comp3-001', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '回答1' }] } },
    { sessionId: 'sess-comp3-001', type: 'custom-title', customTitle: '用户重命名' },
    { sessionId: 'sess-comp3-001', type: 'user', isCompactSummary: true, message: { role: 'user', content: 'Summary:\n要点' } },
    { sessionId: 'sess-comp3-001', type: 'user', message: { role: 'user', content: '继续问题' } },
    { sessionId: 'sess-comp3-001', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '继续回答' }] } },
  ].map((r) => JSON.stringify(r)).join('\n')
  const out = convertClaudeJsonl(lines, { fileStem: 'sess-comp3-001' })
  assert.equal(out.compacted, true)
  assert.equal(out.compactions, 1)
  assert.equal(out.turns.length, 2)
  assert.equal(out.title, '用户重命名')
})

test('convertClaudeJsonl: budget 裁剪后事件仍平衡（配对 + 投影顺序合法）', () => {
  const lines = []
  const sessionId = 'sess-trim-001'
  for (let i = 1; i <= 60; i++) {
    lines.push(JSON.stringify({ sessionId, type: 'user', cwd: 'D:\\demo', message: { role: 'user', content: '问题' + '字'.repeat(49) + i } }))
    lines.push(JSON.stringify({ sessionId, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '回答' + '字'.repeat(49) + i }] } }))
  }
  const out = convertClaudeJsonl(lines.join('\n'), { budget: 1000, sourcePath: 'D:\\demo\\sess-trim-001.jsonl' })
  assert.ok(out.trimmed)
  assert.ok(out.trimmed.droppedTurns > 0)
  assert.ok(out.trimmed.estimatedTokens <= 1000)
  assert.equal(out.trimmed.budget, 1000)
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
  // 无 budget 时行为不变（无裁剪上报）
  const plain = convertClaudeJsonl(lines.join('\n'), { sourcePath: 'D:\\demo\\sess-trim-001.jsonl' })
  assert.equal(plain.trimmed, undefined)
  assert.ok(plain.turns.length > out.turns.length)
})

test('convertClaudeJsonl: 失败重发 ghost step 丢弃（同一 tool_use id 下一步原样重发）', () => {
  const out = convertClaudeJsonl(load('claude-ghost-retry.jsonl'))
  const calls = out.events.filter((e) => e.type === 'tool/call')
  assert.equal(calls.length, 1, 'ghost 步丢弃后只保留一次 tool/call')
  assert.equal(out.droppedRetrySteps, 1)
  assertToolPairing(out.events)
  // 文本产物完整：重发前的文本步与重发后的回复都在
  const texts = out.events
    .filter((e) => e.type === 'assistant/message')
    .flatMap((e) => e.data.message.content)
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
  assert.ok(texts.some((t) => t.includes('我来执行')), '重发前的文本步保留')
  assert.ok(texts.some((t) => t.includes('列出了 3 个文件')), '重发后的回复保留')
})

test('convertClaudeJsonl: 链式失败重发（连续两次 ghost）全部丢弃', () => {
  const out = convertClaudeJsonl(load('claude-ghost-chain.jsonl'))
  const calls = out.events.filter((e) => e.type === 'tool/call')
  assert.equal(calls.length, 1)
  assert.equal(out.droppedRetrySteps, 2)
  assertToolPairing(out.events)
})

test('convertClaudeJsonl: 非相邻的重发保守保留（已知边界，不清洗）', () => {
  // ghost 与重发之间隔了带文本的 assistant 步 → 不满足「相邻两步」条件，保持原样
  const out = convertClaudeJsonl(load('claude-ghost-nonadjacent.jsonl'))
  const calls = out.events.filter((e) => e.type === 'tool/call')
  assert.equal(calls.length, 2)
  assert.equal(out.droppedRetrySteps, 0)
})
