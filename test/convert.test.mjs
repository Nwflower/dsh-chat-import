// convert.test.mjs — 纯转换逻辑单元测试（无宿主依赖）
import { test } from 'node:test'
import { assertNativeCompaction, derivedSurfaceMessages } from './_support/compaction.mjs'
import { codexCompactedRollout } from './_support/codex-compacted.mjs'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { convertClaudeJsonl, convertCodexJsonl, convertChatgptJson, convertCursorJsonl, convertGeminiJson, convertReasonixJsonl, convertPiJsonl, convertOpencodeJson, convertQoderJsonl, reasonixStemTime, mintSessionId, parseTime, parseTimeMs, SESSION_FORMAT_VERSION, tailSessionEvents, codexCustomToolArguments, jsObjectLiteralToJson, estimateTokens, cropContentBlocks, trimTurns, applyBudgetTrim, TEXT_BLOCK_CHAR_LIMIT, TOOL_RESULT_CHAR_LIMIT, validateSessionEvents, isEnvInjectionEvent } from '../lib/convert/index.mjs'
import { pinSourcedSessionTitle } from '../lib/sourced-title.mjs'
import { synthesizeSession } from '../lib/convert/core.mjs'
import { contentText } from '../lib/convert/util.mjs'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const load = (name) => readFileSync(join(fixtures, name), 'utf8')

// 配对不变量：每个 tool/call 都有对应 tool/result，且 result 的 sourceEventSeqs
// 指向其 tool/call 的 seq（synthesizeSession 兜底保证，见 convert.mjs）。
function assertToolPairing(events) {
  const calls = events.filter((e) => e.type === 'tool/call')
  const results = events.filter((e) => e.type === 'tool/result')
  assert.equal(results.length, calls.length, `tool/call(${calls.length}) 与 tool/result(${results.length}) 数量一致`)
  const resultByCall = new Map(results.map((r) => [r.data.message.content[0].toolCallId, r]))
  for (const c of calls) {
    const r = resultByCall.get(c.data.callId)
    assert.ok(r, `tool/result 存在 for call ${c.data.callId}`)
    assert.deepEqual(r.sourceEventSeqs, [c.seq], `call ${c.data.callId} 的 result 指向其 seq`)
  }
}

// 投影 LLM 消息序列：DSH 的 deriveMessages 按事件顺序扁平投影 surface 事件
// （user/message / assistant/message / tool/result），不做重排——事件顺序即
// wire 消息顺序。返回 [{role:'user'} | {role:'assistant', toolCallIds} |
// {role:'tool', toolCallId}] 序列。
function projectSurfaceMessages(events) {
  return events
    .filter((e) => e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result')
    .map((e) => {
      if (e.type === 'user/message') return { role: 'user' }
      if (e.type === 'assistant/message') {
        return {
          role: 'assistant',
          toolCallIds: e.data.message.content.filter((c) => c.type === 'tool-call').map((c) => c.id),
        }
      }
      return { role: 'tool', toolCallId: e.data.message.content[0].toolCallId }
    })
}

// 消息投影顺序合法（wire 规则）：带 tool-call 块的 assistant 消息之后、到下一个
// assistant / user 消息之前，其全部 toolCallId 必须已有对应 tool 消息——不允许
// 「带 tool_calls 的 assistant 后紧跟另一条 assistant 而中间无 tool 消息」，
// 也不允许无对应 tool-call 的孤儿 tool 消息。返回投影序列供精确断言。
function assertMessageOrderLegal(events) {
  const msgs = projectSurfaceMessages(events)
  let open = []
  for (const m of msgs) {
    if (m.role === 'assistant') {
      assert.equal(open.length, 0, `assistant 前有未配对的 tool_calls（残留 ${open.join(',')}）`)
      open = [...m.toolCallIds]
    } else if (m.role === 'tool') {
      const i = open.indexOf(m.toolCallId)
      assert.ok(i !== -1, `tool 消息 ${m.toolCallId} 前没有对应的 tool-call`)
      open.splice(i, 1)
    } else {
      assert.equal(open.length, 0, `user 消息前有未配对的 tool_calls（残留 ${open.join(',')}）`)
    }
  }
  assert.equal(open.length, 0, `末尾残留未配对的 tool_calls（${open.join(',')}）`)
  return msgs
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
  out.events.forEach((e, i) => assert.equal(e.seq, i))
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

test('turns=0 时不写 session/imported 标记（无可导入内容）', () => {
  // 有记录但无用户回合（纯 info 通知）：不产生空会话，也不加标记
  const info = convertGeminiJson(JSON.stringify({
    sessionId: 'gemini-info-only',
    startTime: '2026-04-17T18:09:18.567Z',
    messages: [{ id: 'i1', type: 'info', content: 'notice' }],
  }), { sourcePath: 'D:\\demo\\gemini\\info.json' })
  assert.equal(info.turns.length, 0)
  assert.equal(info.events.length, 0)
  assert.equal(info.events.some((e) => e.type === 'session/imported'), false)
  // 空输入同理（Claude）
  const empty = convertClaudeJsonl('', { sourcePath: 'D:\\demo\\proj\\empty.jsonl' })
  assert.equal(empty.turns.length, 0)
  assert.equal(empty.events.length, 0)
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

test('mintSessionId: 清理非法字符并截断', () => {
  assert.equal(mintSessionId('abc_123-def'), 'import-abc_123-def')
  // 全非法字符时回退为时间戳（仍是合法 id）
  assert.match(mintSessionId('中文/路径\\特殊:字符'), /^import-\d+$/)
  const long = mintSessionId('x'.repeat(200))
  assert.ok(long.length <= 8 + 64)
})

test('parseTime: 解析 ISO 时间戳', () => {
  const t = parseTime('2026-08-01T10:00:00.000Z')
  assert.equal(typeof t, 'number')
  assert.ok(t > 0)
  // 缺时间戳回退到当前时间：两次 Date.now() 之间可能跨毫秒，给窗口而不是等值比较
  const before = Date.now()
  const fallback = parseTime(undefined)
  assert.ok(fallback >= before && fallback - before < 1000)
})

test('纯函数层（lib/convert、lib/export）只 import 本层模块与无 IO 的 node 内建', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')
  const allowed = (layer, spec) => /^\.\/[\w-]+\.mjs$/.test(spec)
    || (layer === 'export' && /^\.\.\/convert\/[\w-]+\.mjs$/.test(spec))
    || spec === 'node:path' || spec === 'node:crypto'
  const offenders = []
  for (const layer of ['convert', 'export']) {
    for (const name of readdirSync(join(root, layer))) {
      if (!name.endsWith('.mjs')) continue
      const src = readFileSync(join(root, layer, name), 'utf8')
      for (const m of src.matchAll(/^(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]/gm)) {
        if (!allowed(layer, m[1])) offenders.push(layer + '/' + name + ' → ' + m[1])
      }
    }
  }
  assert.deepEqual(offenders, [])
})

test('contentText: 字符串原样、块数组按 type 取 text，各源差异走显式选项', () => {
  const blocks = [{ type: 'text', text: ' a ' }, { type: 'image' }, { type: 'output_text', text: 'b' }, { type: 'text', text: '' }, 'x', null]
  assert.equal(contentText(' raw '), ' raw ')
  assert.equal(contentText(' raw ', { trim: true }), 'raw')
  assert.equal(contentText(blocks), ' a \n')
  assert.equal(contentText(blocks, { skipEmpty: true }), ' a ')
  assert.equal(contentText(blocks, { types: null, sep: '' }), ' a b')
  assert.equal(contentText(blocks, { types: ['output_text'], trim: true }), 'b')
  assert.equal(contentText(undefined), '')
  assert.equal(contentText({ text: 'not an array' }), '')
})

test('parseTimeMs: 秒/毫秒自适应取整，truncSeconds 截到整秒，拿不到为 null', () => {
  assert.equal(parseTimeMs(1767583930.285031), 1767583930285)
  assert.equal(parseTimeMs(1767583930.285031, { truncSeconds: true }), 1767583930000)
  assert.equal(parseTimeMs(1767583930285), 1767583930285)
  assert.equal(parseTimeMs(1767583930285, { truncSeconds: true }), 1767583930285)
  assert.equal(parseTimeMs('2026-08-01T10:00:00.000Z'), Date.parse('2026-08-01T10:00:00.000Z'))
  for (const bad of [undefined, null, '', 'not a date', Number.NaN, Infinity, 1e300, {}]) {
    assert.equal(parseTimeMs(bad), null, String(bad))
  }
})

// ---- Codex / ChatGPT CLI rollout ----

test('convertCodexJsonl: 简单问答合成平衡回合（元数据来自 session_meta/turn_context）', () => {
  const out = convertCodexJsonl(load('codex-simple.jsonl'), { sourcePath: 'D:\\demo\\codex\\simple.jsonl' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 2)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.meta.id, 'import-019e3b3f-636d-7cb3-aaab-0255eb45ad4f')
  assert.equal(out.meta.sourceId, '019e3b3f-636d-7cb3-aaab-0255eb45ad4f')
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.cwd, 'D:\\demo\\codex-proj')
  assert.ok(out.meta.createdAt)

  const types = out.events.map((e) => e.type)
  assert.deepEqual(types, [
    'turn/start', 'step/start', 'system/message', 'user/message', 'user/message', 'assistant/message', 'step/end', 'turn/end',
  ])
  // seq 连续从 0 开始；最后一个事件是 turn/end（平衡）
  out.events.forEach((e, i) => assert.equal(e.seq, i))
  assert.equal(types.at(-1), 'turn/end')
  assertEnvelopeHygiene(out.events)
  // surface 事件带 surfaceOp
  for (const e of out.events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message')) {
    assert.equal(e.surfaceOp, 'append')
  }
  // assistant 的 source 带 codex provider 与真实 model
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.source, { kind: 'model', provider: 'codex', model: 'gpt-5.5' })
})

test('convertCodexJsonl: function_call + function_call_output 按 call_id 跨行配对', () => {
  const out = convertCodexJsonl(load('codex-tool.jsonl'))
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  assert.equal(out.messages, 4) // user + assistant×2 + tool/result
  const types = out.events.map((e) => e.type)
  assert.ok(types.includes('tool/call'))
  assert.ok(types.includes('tool/result'))
  assert.equal(types.at(-1), 'turn/end')

  const call = out.events.find((e) => e.type === 'tool/call')
  assert.equal(call.data.callId, 'call_7ZuPytXrZQEdP2DBuForbrV8')
  assert.equal(call.data.name, 'shell_command')
  assert.equal(call.data.arguments, '{"cmd":"ls -la","workdir":"D:\\\\demo\\\\codex-proj"}')

  const result = out.events.find((e) => e.type === 'tool/result')
  assert.equal(result.data.message.content[0].toolCallId, 'call_7ZuPytXrZQEdP2DBuForbrV8')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.equal(result.surfaceOp, 'append')
  // output 是纯文本，直接作为 text block
  assert.equal(result.data.message.content[0].content[0].text, 'README.md\nsrc\n')
  assertMessageOrderLegal(out.events)
})

test('convertCodexJsonl: 注入块被过滤、无 summary 的 reasoning 不产生块、custom_tool_call 用 input', () => {
  const out = convertCodexJsonl(load('codex-custom-tool.jsonl'))
  assert.equal(out.turns.length, 1)
  // 注入的 <environment_context> 不进入 prompt
  const user = out.events.find((e) => e.type === 'user/message' && e.data.source.kind === 'user').data
  assert.equal(user.content[0].text, '帮我修这个 bug')
  // reasoning 的 summary 为空 → 不产生 reasoning 块，也不塞空文本（密文 encrypted_content 不读）
  assert.equal(out.events.filter((e) => e.type === 'assistant/message').length, 2)
  const asst = out.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message)
  for (const m of asst) {
    assert.ok(!m.content.some((c) => c.type === 'reasoning'))
  }
  // custom_tool_call（apply_patch）→ tool/call，arguments 是 input 序列化
  const call = out.events.find((e) => e.type === 'tool/call')
  assert.equal(call.data.name, 'apply_patch')
  assert.equal(call.data.callId, 'call_sYb5HPObaiJRLYhllTHqbIxP')
  assert.ok(call.data.arguments.includes('*** Begin Patch'))
  // 补丁自由文本不是 JS 调用形态：不误转、不计入 droppedMalformedArgs（REQ-44）
  assert.equal(out.droppedMalformedArgs, 0)
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.equal(result.data.message.content[0].content[0].text, 'Patch applied successfully.')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
})

test('convertCodexJsonl: importSystemPrompt 开关收集 developer 为上下文注入', () => {
  const raw = [
    '{"timestamp":"2026-05-18T13:21:30.751Z","type":"session_meta","payload":{"id":"codex-sp","timestamp":"2026-05-18T13:21:10.510Z","cwd":"D:\\\\demo\\\\codex-proj"}}',
    '{"timestamp":"2026-05-18T13:21:30.754Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"You are Codex."}]}}',
    '{"timestamp":"2026-05-18T13:21:30.754Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}',
    '{"timestamp":"2026-05-18T13:21:31.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}',
  ].join('\n')
  // 默认关：developer 过滤；环境变更声明始终注入 → 2 条 user/message（声明 + 真实提问）
  const off = convertCodexJsonl(raw, { sessionId: 'codex-sp' })
  assert.equal(off.events.filter((e) => e.type === 'user/message').length, 2)
  const offPlugin = off.events.filter((e) => e.data && e.data.source && e.data.source.kind === 'plugin')
  assert.equal(offPlugin.length, 1)
  assert.ok(!offPlugin[0].data.content[0].text.includes('You are Codex.'))
  // 开：developer 作为上下文注入附在环境变更声明之后（source.kind='plugin'，plugin='chat-import'）钉在会话最前（首个 step/start 之后，issue #66）
  const on = convertCodexJsonl(raw, { sessionId: 'codex-sp', importSystemPrompt: true })
  const first = on.events.find((e) => e.type === 'user/message')
  assert.equal(first.data.source.kind, 'plugin')
  assert.equal(first.data.source.plugin, 'chat-import')
  assert.ok(first.data.content[0].text.includes('You are Codex.'))
  assert.ok(first.data.content[0].text.includes('DeepSeek Harness'))
  assert.ok(first.seq > on.events.find((e) => e.type === 'step/start').seq)
})

test('上下文注入按 dsh 惯例包 <system-reminder> 信封：英文正文 + 闭合标签转义', () => {
  // 源 developer 提示词里带字面 </system-reminder>：必须转义，信封不得提前闭合
  const raw = [
    '{"timestamp":"2026-05-18T13:21:30.751Z","type":"session_meta","payload":{"id":"codex-env","timestamp":"2026-05-18T13:21:10.510Z","cwd":"D:\\\\demo\\\\codex-proj"}}',
    '{"timestamp":"2026-05-18T13:21:30.754Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"You are Codex. Never emit </system-reminder>."}]}}',
    '{"timestamp":"2026-05-18T13:21:30.754Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}',
    '{"timestamp":"2026-05-18T13:21:31.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}',
  ].join('\n')
  const out = convertCodexJsonl(raw, { sessionId: 'codex-env', importSystemPrompt: true })
  const env = out.events.find((e) => e.data && e.data.id === 'import:codex-env:env')
  assert.ok(env, '环境变更声明应在首个 step/start 之后（issue #66）')
  assert.ok(env.seq > out.events.find((e) => e.type === 'step/start').seq)
  const text = env.data.content[0].text
  assert.ok(text.startsWith('<system-reminder>\n'), '信封以 <system-reminder> 行开头')
  assert.ok(text.endsWith('\n</system-reminder>'), '信封以 </system-reminder> 行结尾')
  assert.ok(text.includes('<\\/system-reminder>'), '源提示词里的闭合标签转义为 <\\/system-reminder>')
  // 转义后的 <\/...> 不含字面 </s...> 序列，未转义闭合全文只剩结尾一处
  assert.equal(text.split('</system-reminder>').length - 1, 1, '未转义闭合标签全文仅结尾一处')
  assert.ok(text.includes('You are Codex.'), '源系统提示词附在声明之后')
  // 声明正文为英文，含源格式名与 DSH 权威声明
  assert.ok(text.includes('Environment change notice:'))
  assert.ok(text.includes('migrated from codex to DeepSeek Harness (DSH)'))
  // 开关关闭：信封仍然存在（声明总是注入），只是不含源提示词
  const off = convertCodexJsonl(raw, { sessionId: 'codex-env' })
  const offText = off.events.find((e) => e.data && e.data.id === 'import:codex-env:env').data.content[0].text
  assert.ok(offText.startsWith('<system-reminder>\n') && offText.endsWith('\n</system-reminder>'))
  assert.ok(!offText.includes('You are Codex.'))
})

test('convertCodexJsonl: function_call 无 function_call_output 补发空 tool/result', () => {
  // 工具调用后会话结束/输出缺失：call_id 无对应 output → 合成空 result 保证配对
  const raw = [
    '{"timestamp":"2026-05-18T13:21:30.751Z","type":"session_meta","payload":{"id":"019e3b3f-636d-7cb3-aaab-0255eb45ad4f","timestamp":"2026-05-18T13:21:10.510Z","cwd":"D:\\\\demo\\\\codex-proj","originator":"codex-tui"}}',
    '{"timestamp":"2026-05-18T13:21:30.754Z","type":"turn_context","payload":{"turn_id":"t1","model":"gpt-5.5"}}',
    '{"timestamp":"2026-05-18T13:21:30.754Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"查一下"}]}}',
    '{"timestamp":"2026-05-18T13:21:31.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"好"}]}}',
    '{"timestamp":"2026-05-18T13:21:31.500Z","type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\\"cmd\\":\\"ls\\"}","call_id":"call_orphan_001"}}',
  ].join('\n')
  const out = convertCodexJsonl(raw, { sessionId: 'codex-cut' })
  assert.equal(out.toolCalls, 1)
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.ok(result)
  assert.deepEqual(result.data.message.content[0].content, [])
  assert.equal(result.data.message.content[0].toolCallId, 'call_orphan_001')
  assertToolPairing(out.events)
  assert.equal(out.events.at(-1).type, 'turn/end')
  assertMessageOrderLegal(out.events)
})

test('convertCodexJsonl: event_msg 重复消息不重复计数、多轮正确切分', () => {
  const out = convertCodexJsonl(load('codex-multi-turn.jsonl'))
  assert.equal(out.turns.length, 2)
  assert.equal(out.messages, 4) // 每轮 user + assistant（event_msg 重复不计）
  const starts = out.events.filter((e) => e.type === 'turn/start')
  assert.equal(starts.length, 2)
  const users = out.events.filter((e) => e.type === 'user/message' && e.data.source.kind === 'user')
  assert.equal(users.length, 2)
  assert.equal(users[0].data.content[0].text, '第一个问题')
  assert.equal(users[1].data.content[0].text, '第二个问题')
  const ends = out.events.filter((e) => e.type === 'turn/end')
  assert.equal(ends.length, 2)
})

// ---- Codex 上下文压缩（compacted 信封）：夹具在 _support/codex-compacted.mjs ----

test('convertCodexJsonl: 上下文压缩 → DSH 原生压缩检查点（日志保全量、模型只见摘要+之后）', () => {
  const raw = codexCompactedRollout()
  const out = convertCodexJsonl(raw, { sessionId: 'codex-comp-1', budget: 366000 })
  assert.equal(out.compacted, true)
  assert.equal(out.compactions, 1)
  assert.equal(out.trimmed, undefined)
  // 全量历史留在日志里（压缩只影响模型投影）
  const texts = out.events.filter((e) => e.type === 'assistant/message')
    .flatMap((e) => e.data.message.content).map((c) => c.text)
  assert.ok(texts.includes('压缩前的回答') && texts.includes('压缩后的回答') && texts.includes('新回答'))
  assert.equal(out.toolCalls, 2) // call_pre + call_post 都在
  // 原生事务形状
  assert.equal(assertNativeCompaction(out.events), 1)
  const summary = out.events.find((e) => e.type === 'compaction/summary')
  assert.match(summary.data.summary[0].text, /^Another language model started to solve this problem/)
  // 被遮蔽范围 = 边界之前的全部会话 surface 节点（含压缩前的提问与工具结果）
  const ck = out.events.find((e) => e.type === 'user/message' && typeof e.surfaceOp === 'object')
  const shadowedTypes = ck.sourceEventSeqs.map((s) => out.events[s].type)
  assert.ok(shadowedTypes.includes('assistant/message') && shadowedTypes.includes('tool/result'))
  // 压缩点之前的轮标 log-only；跨压缩点那一轮拆成「log-only 段 + 带检查点的空 prompt 段」
  assert.deepEqual(out.turns.map((t) => ({ shadowed: t.shadowed === true, ck: !!t.compaction, steps: t.steps.length, prompt: t.prompt })),
    [
      { shadowed: true, ck: false, steps: 1, prompt: '第一个任务' },
      { shadowed: false, ck: true, steps: 1, prompt: '' },
      { shadowed: false, ck: false, steps: 1, prompt: '新提问' },
    ])
  // 模型看到的：protected head → 环境变更声明 → 检查点摘要 → 压缩后内容
  const derived = derivedSurfaceMessages(out.events)
  assert.equal(derived[0], 'system:', 'protected head 在 surface 第 0 位')
  assert.ok(derived[1].startsWith('user:<system-reminder>'), '迁移声明不被遮蔽')
  assert.equal(derived[2], 'user:' + summary.data.summary[0].text)
  assert.ok(!derived.some((d) => d.includes('压缩前的回答')), '被遮蔽内容不进模型上下文')
  assert.ok(derived.some((d) => d.includes('压缩后的回答')) && derived.some((d) => d.includes('新回答')))
  // 标题仍取全量记录的第一条提问（压缩只影响投影，不影响标题）
  assert.equal(out.title, '第一个任务')
  assert.equal(validateSessionEvents(out.events).ok, true)
  assertMessageOrderLegal(out.events)
  assertToolPairing(out.events)
})

test('convertCodexJsonl: fullHistory 时不发压缩检查点（模型看到全量）', () => {
  const raw = codexCompactedRollout()
  const full = convertCodexJsonl(raw, { sessionId: 'codex-comp-1', fullHistory: true })
  assert.equal(full.compacted, undefined)
  assert.equal(full.compactions, undefined)
  assert.equal(full.events.some((e) => e.type.startsWith('compaction/')), false)
  assert.equal(full.turns.length, 2) // 压缩前的「第一个任务」+ 压缩后的「新提问」
  assert.equal(full.toolCalls, 2)
  assert.ok(derivedSurfaceMessages(full.events).some((d) => d.includes('压缩前的回答')))
})

test('convertCodexJsonl: 压缩信封没有摘要正文时不发检查点（不静默丢前半段）', () => {
  const raw = codexCompactedRollout({ message: undefined, replacement_history: undefined })
  const out = convertCodexJsonl(raw, { sessionId: 'codex-comp-1' })
  assert.equal(out.compacted, undefined)
  assert.equal(out.events.some((e) => e.type.startsWith('compaction/')), false)
  assert.equal(out.turns.length, 2)
  assert.ok(out.events.some((e) => e.data && e.data.callId === 'call_pre')) // 压缩前内容仍在
})

test('convertCodexJsonl: 压缩后没有人类提问 → 空 prompt 轮承载检查点后的产物', () => {
  const raw = codexCompactedRollout({ replacement_history: [] })
  const out = convertCodexJsonl(raw, { sessionId: 'codex-comp-1' })
  assert.equal(out.compacted, true)
  assert.equal(out.compactions, 1)
  // 边界之后的产物（reasoning/assistant/工具）落在带检查点的空 prompt 轮上，不丢内容
  assert.deepEqual(out.turns.map((t) => ({ shadowed: t.shadowed === true, ck: !!t.compaction, prompt: t.prompt })),
    [{ shadowed: true, ck: false, prompt: '第一个任务' }, { shadowed: false, ck: true, prompt: '' }, { shadowed: false, ck: false, prompt: '新提问' }])
  assert.ok(out.events.some((e) => e.data && e.data.callId === 'call_post'))
  assert.equal(assertNativeCompaction(out.events), 1)
  assertMessageOrderLegal(out.events)
  assertToolPairing(out.events)
})

test('convertCodexJsonl: 压缩后什么都没有 → 仍留一个只装检查点的边界轮', () => {
  const j = (o) => JSON.stringify(o)
  const summary = 'Another language model started to solve this problem.'
  const raw = [
    j({ timestamp: '2026-09-07T04:22:51.704Z', type: 'session_meta', payload: { id: 'codex-comp-empty', cwd: 'D:\\demo\\codex-comp' } }),
    j({ timestamp: '2026-09-07T04:23:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '任务' }] } }),
    j({ timestamp: '2026-09-07T09:10:03.113Z', type: 'compacted', payload: { message: summary, replacement_history: [] } }),
  ].join('\n')
  const out = convertCodexJsonl(raw, { sessionId: 'codex-comp-empty' })
  assert.equal(out.compacted, true)
  assert.equal(out.compactions, 1)
  assert.equal(assertNativeCompaction(out.events), 1)
  // 模型只看到 protected head + 迁移声明 + 检查点摘要（压缩前的历史仍在日志里）
  const derived = derivedSurfaceMessages(out.events)
  assert.equal(derived[0], 'system:')
  assert.ok(derived[1].startsWith('user:<system-reminder>'))
  assert.deepEqual(derived.slice(2), ['user:' + summary])
  assert.equal(validateSessionEvents(out.events).ok, true)
})

test('convertCodexJsonl: 畸形行计数与会话 id 覆盖', () => {
  const raw = 'not json\n' + load('codex-simple.jsonl')
  const out = convertCodexJsonl(raw, { sessionId: 'custom-codex' })
  assert.equal(out.skipped, 1)
  assert.equal(out.meta.id, 'custom-codex')
})

test('convertCodexJsonl: 空输入不产生事件', () => {
  const out = convertCodexJsonl('')
  assert.equal(out.events.length, 0)
  assert.equal(out.turns.length, 0)
})

test('convertCodexJsonl: 子代理 rollout 跳过（issue #17），fork 会话保留', () => {
  // source.subagent.thread_spawn（issue #17 复现形态）→ 跳过不建独立会话
  const subagentRaw = [
    '{"timestamp":"t0","type":"session_meta","payload":{"session_id":"parent-1","id":"sub-1","source":{"subagent":{"thread_spawn":{"parent_thread_id":"parent-1","depth":1}}}}}',
    '{"timestamp":"t1","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"subagent work"}]}}',
    '{"timestamp":"t2","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}',
  ].join('\n')
  const out = convertCodexJsonl(subagentRaw)
  assert.equal(out.meta, null)
  assert.equal(out.turns.length, 0)
  assert.equal(out.events.length, 0)
  assert.ok(out.skipReason && out.skipReason.includes('subagent'))

  // thread_source='subagent' 权威标记同样命中
  const altRaw = [
    '{"timestamp":"t0","type":"session_meta","payload":{"id":"sub-2","thread_source":"subagent"}}',
    '{"timestamp":"t1","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"x"}]}}',
  ].join('\n')
  const alt = convertCodexJsonl(altRaw)
  assert.equal(alt.meta, null)
  assert.ok(alt.skipReason && alt.skipReason.includes('subagent'))

  // fork 会话（forked_from_id 但无 subagent 标记）仍是可独立继续的新主会话，导入保留
  const forkRaw = [
    '{"timestamp":"t0","type":"session_meta","payload":{"id":"fork-1","forked_from_id":"parent-1"}}',
    '{"timestamp":"t1","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"fork continued"}]}}',
    '{"timestamp":"t2","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}',
  ].join('\n')
  const fork = convertCodexJsonl(forkRaw)
  assert.ok(fork.meta)
  assert.equal(fork.turns.length, 1)
  assert.equal(fork.meta.sourceId, 'fork-1')
})

// ---- REQ-44: codex custom_tool_call JS 参数 → 标准 JSON（保真度） ----

// 合成含一个 custom_tool_call 的单轮 codex rollout（用 JSON.stringify 生成行，
// 避免在测试源码里手工转义 input 里的引号/花括号）。
function codexJsCallRollout(input, name = 'exec_command') {
  return [
    { timestamp: 't0', type: 'session_meta', payload: { id: 'codex-js-001', timestamp: 't0', cwd: 'D:\\demo\\codex-proj' } },
    { timestamp: 't1', type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-5.5' } },
    { timestamp: 't2', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '跑一下' }] } },
    { timestamp: 't3', type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', call_id: 'call_js_01', name, input } },
  ].map((l) => JSON.stringify(l)).join('\n')
}

test('convertCodexJsonl: custom_tool_call JS 参数转标准 JSON（tools.exec_command 调用形态）', () => {
  // 2026+ 新版 custom_tool_call 的 input 是 JS 代码字符串。识别调用形态 → 提取
  // 对象字面量 → 转标准 JSON；嵌套对象 / 数组 / 单引号 / 布尔 / 数字 / null 全支持
  const input = 'tools.exec_command({command:"ls", args:["-la"], opts:{cwd:\'D:/p\', verbose:true, count:3, empty:null, nested:{a:[1,2,3]}}})'
  const out = convertCodexJsonl(codexJsCallRollout(input), { sessionId: 'codex-js' })
  const call = out.events.find((e) => e.type === 'tool/call')
  assert.equal(call.data.name, 'exec_command')
  // arguments 是提取出的对象字面量转成的标准 JSON（不再是 JS 调用文本）
  assert.equal(
    call.data.arguments,
    '{"command":"ls","args":["-la"],"opts":{"cwd":"D:/p","verbose":true,"count":3,"empty":null,"nested":{"a":[1,2,3]}}}'
  )
  assert.equal(out.droppedMalformedArgs, 0)
  assertToolPairing(out.events)
})

test('convertCodexJsonl: custom_tool_call 直接对象字面量 input 转标准 JSON（无引号键）', () => {
  const out = convertCodexJsonl(codexJsCallRollout('{cmd: "ls", flag: true, n: -2.5}'), { sessionId: 'codex-obj' })
  const call = out.events.find((e) => e.type === 'tool/call')
  assert.equal(call.data.arguments, '{"cmd":"ls","flag":true,"n":-2.5}')
  assert.equal(out.droppedMalformedArgs, 0)
})

test('convertCodexJsonl: custom_tool_call 括号包裹 / 并行形态取第一个对象字面量', () => {
  // Promise.all([...]) 并行多调用：取第一个对象字面量转 JSON（与竞品行为一致）
  const par = convertCodexJsonl(codexJsCallRollout('Promise.all([tools.exec_command({cmd:"ls"}), tools.exec_command({cmd:"pwd"})])'), { sessionId: 'codex-par' })
  assert.equal(par.events.find((e) => e.type === 'tool/call').data.arguments, '{"cmd":"ls"}')
  assert.equal(par.droppedMalformedArgs, 0)
  // 括号包裹表达式（await 调用）同样识别
  const wrapped = convertCodexJsonl(codexJsCallRollout('(await tools.exec_command({cmd:"pwd"}))'), { sessionId: 'codex-wrap' })
  assert.equal(wrapped.events.find((e) => e.type === 'tool/call').data.arguments, '{"cmd":"pwd"}')
  assert.equal(wrapped.droppedMalformedArgs, 0)
})

test('convertCodexJsonl: custom_tool_call JS 参数转换失败回退原样并计数 droppedMalformedArgs', () => {
  // input 是 JS 调用形态但值含方法调用（转换器不支持的表达式）→ 转换失败
  const input = 'tools.exec_command({cmd: shell_escape(userInput)})'
  const out = convertCodexJsonl(codexJsCallRollout(input), { sessionId: 'codex-fb' })
  const call = out.events.find((e) => e.type === 'tool/call')
  // 回退原样：JSON.stringify(input)，不抛异常、不产生垃圾输出
  assert.equal(call.data.arguments, JSON.stringify(input))
  assert.equal(out.droppedMalformedArgs, 1)
})

test('convertCodexJsonl: function_call 不进入 JS 参数转换（arguments 原样）', () => {
  const raw = [
    '{"timestamp":"t0","type":"session_meta","payload":{"id":"codex-fc-001","timestamp":"t0","cwd":"D:\\\\demo"}}',
    '{"timestamp":"t1","type":"turn_context","payload":{"turn_id":"t1","model":"gpt-5.5"}}',
    '{"timestamp":"t2","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"查一下"}]}}',
    JSON.stringify({ timestamp: 't3', type: 'response_item', payload: { type: 'function_call', name: 'shell_command', arguments: 'tools.exec_command({cmd:"ls"})', call_id: 'call_fc_01' } }),
  ].join('\n')
  const out = convertCodexJsonl(raw, { sessionId: 'codex-fc' })
  const call = out.events.find((e) => e.type === 'tool/call')
  // 即便是 JS 形态的 arguments 也原样保留：JS 转换只作用于 custom_tool_call
  assert.equal(call.data.arguments, 'tools.exec_command({cmd:"ls"})')
  assert.equal(out.droppedMalformedArgs, 0)
})

test('codexCustomToolArguments: 非字符串 / 空串 / 已是 JSON / 自由文本保持原样（fallback=false）', () => {
  // 对象 input（老格式）→ JSON.stringify 原样，不算 fallback
  const obj = codexCustomToolArguments({ cmd: 'ls' })
  assert.equal(obj.arguments, '{"cmd":"ls"}')
  assert.equal(obj.fallback, false)
  // 空串
  const empty = codexCustomToolArguments('')
  assert.equal(empty.arguments, '""')
  assert.equal(empty.fallback, false)
  // 已是标准 JSON 的对象字符串 → 转换器幂等输出（格式化归一）
  const json = codexCustomToolArguments('{"cmd":"ls"}')
  assert.equal(json.arguments, '{"cmd":"ls"}')
  assert.equal(json.fallback, false)
  // 自由文本（apply_patch 补丁）→ 未识别为 JS 调用形态，原样保留、不算 fallback
  const patch = codexCustomToolArguments('*** Begin Patch\n*** Update File: a.js\n@@\n-foo\n+bar\n*** End Patch')
  assert.equal(patch.arguments, JSON.stringify('*** Begin Patch\n*** Update File: a.js\n@@\n-foo\n+bar\n*** End Patch'))
  assert.equal(patch.fallback, false)
})

test('codexCustomToolArguments: 字符串/模板里的花括号不误导提取；模板值不支持回退原样', () => {
  // 字符串值里的 '}' 不提前闭合对象
  const s = codexCustomToolArguments('{a: "}", b: 2}')
  assert.equal(s.arguments, '{"a":"}","b":2}')
  assert.equal(s.fallback, false)
  // 模板字符串值（含 ${…} 花括号）→ 提取不误判，但模板值转换器不支持 → 回退原样并标记
  const t = codexCustomToolArguments('{cmd: `ls ${dir}`}')
  assert.equal(t.arguments, JSON.stringify('{cmd: `ls ${dir}`}'))
  assert.equal(t.fallback, true)
})

test('jsObjectLiteralToJson: 不支持的结构返回 null（尾逗号 / 注释 / 表达式 / 模板值）', () => {
  assert.equal(jsObjectLiteralToJson('{a: 1,}'), null) // 尾逗号
  assert.equal(jsObjectLiteralToJson('{a: 1 // 注释\n}'), null) // 注释
  assert.equal(jsObjectLiteralToJson('{a: f(1)}'), null) // 方法调用表达式
  assert.equal(jsObjectLiteralToJson('{a: `x`}'), null) // 模板字符串值
  assert.equal(jsObjectLiteralToJson('{a: 0x10}'), null) // 十六进制数字
  assert.equal(jsObjectLiteralToJson('{a: [1,]}'), null) // 数组尾逗号
  // 支持的结构正常输出（含前导小数点数字 .5）
  assert.equal(jsObjectLiteralToJson('{}'), '{}')
  assert.equal(jsObjectLiteralToJson('{a: [], b: {c: "d"}, e: -1.5, f: 1e3, g: .5}'), '{"a":[],"b":{"c":"d"},"e":-1.5,"f":1000,"g":0.5}')
})

// codex：event_msg/turn_aborted 表示该回合被用户中断。实测 40 条真实记录里 reason 恒为
// 'interrupted'，不区分用户 / hook / 销毁，故映射为宿主为「导入且原始粗粒度记录未携带
// 原因」预留的 legacy 原因，而不是臆测一个更具体的原因。
test('codex：turn_aborted 标为该回合中断，后续回合不受影响', () => {
  const out = convertCodexJsonl(load('codex-turn-aborted.jsonl'))
  const ends = out.events.filter((e) => e.type === 'turn/end').map((e) => e.data.reason)
  assert.equal(ends.length, 2)
  assert.deepEqual(ends[0], { kind: 'aborted', reason: { kind: 'legacy' } })
  assert.deepEqual(ends[1], { kind: 'completed' }, '中断只影响它所在的回合')
})

test('codex：没有 turn_aborted 时回合照常标记完成', () => {
  const out = convertCodexJsonl(load('codex-simple.jsonl'))
  const ends = out.events.filter((e) => e.type === 'turn/end').map((e) => e.data.reason)
  assert.deepEqual(ends, [{ kind: 'completed' }])
})

// 生产导入恒走预算裁剪（resolveImportBudget 恒返回数字），因此「中断标记」必须在裁剪后
// 仍然存在：trimTurns 的 L1 克隆只取 { prompt, steps } 时会把 aborted 丢掉，被裁的会话
// 会静默变回「正常完成」——这里用与生产同口径的 budget 参数锁定该不变量。
test('codex：走预算裁剪后仍标 aborted（裁剪不得丢掉回合级标记）', () => {
  const raw = load('codex-turn-aborted.jsonl')
  const budgeted = convertCodexJsonl(raw, { budget: 550000 })
  const ends = budgeted.events.filter((e) => e.type === 'turn/end').map((e) => e.data.reason)
  assert.deepEqual(ends, [{ kind: 'aborted', reason: { kind: 'legacy' } }, { kind: 'completed' }])
})

// ---- ChatGPT 网页导出 conversations.json ----

test('convertChatgptJson: 一文件多会话、多轮、mapping 主线程', () => {
  const out = convertChatgptJson(load('chatgpt-export.json'), { sourcePath: 'D:\\demo\\chatgpt\\conversations.json' })
  assert.equal(out.records, 3)
  assert.equal(out.conversations.length, 2) // conv-003 只有 system，被跳过
  assert.equal(out.skipped, 1)

  // conv-001：user → assistant → user
  const c1 = out.conversations.find((c) => c.meta.id === 'import-conv-001')
  assert.ok(c1)
  assert.equal(c1.title, 'Python debugging help')
  assert.equal(c1.turns.length, 2)
  assert.equal(c1.messages, 3)
  assert.equal(c1.toolCalls, 0)
  assertEnvelopeHygiene(c1.events)
  const types1 = c1.events.map((e) => e.type)
  // 事件以 turn/end 平衡收尾（session/title 钉在最后，不破坏回合平衡）
  assert.equal(types1.filter((t) => t === 'turn/end').length, 2)
  assert.equal([...types1].reverse().find((t) => t !== 'session/title'), 'turn/end')
  c1.events.forEach((e, i) => assert.equal(e.seq, i))
  // 时间戳：Unix 秒 → ms
  assert.equal(c1.meta.createdAt, 1710000000 * 1000)
  // assistant source
  const asst = c1.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.source, { kind: 'model', provider: 'chatgpt', model: 'chatgpt' })

  // conv-002：分支取最后 child（n4），占位节点 n3 跳过
  const c2 = out.conversations.find((c) => c.meta.id === 'import-conv-002')
  assert.ok(c2)
  assert.equal(c2.turns.length, 1)
  assertEnvelopeHygiene(c2.events)
  const asst2 = c2.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message.content[0].text)
  assert.deepEqual(asst2, ['Here is a simple aglio e olio recipe.', 'Actually, use cacio e pepe instead.'])
})

test('convertChatgptJson: 非数组 / 非法 JSON 返回空并计数 skipped', () => {
  const out = convertChatgptJson('not json at all')
  assert.equal(out.conversations.length, 0)
  assert.equal(out.skipped, 1)
  const obj = convertChatgptJson('{"a":1}')
  assert.equal(obj.conversations.length, 0)
  assert.equal(obj.skipped, 1)
})

test('convertChatgptJson: 无 cwd（ChatGPT 是聊天，不归组工作区）', () => {
  const out = convertChatgptJson(load('chatgpt-export.json'))
  const c1 = out.conversations.find((c) => c.meta.id === 'import-conv-001')
  assert.equal(c1.meta.cwd, undefined)
})

test('convertChatgptJson: importSystemPrompt 开关收集 system 角色为上下文注入', () => {
  const conv = {
    id: 'conv-sp-001',
    title: 'System prompt chat',
    create_time: 1710000000,
    mapping: {
      s1: { id: 's1', parent: null, children: ['u1'], message: { id: 'm0', author: { role: 'system' }, content: { content_type: 'text', parts: ['You are a helpful assistant.'] } } },
      u1: { id: 'u1', parent: 's1', children: ['a1'], message: { id: 'm1', author: { role: 'user' }, content: { content_type: 'text', parts: ['hi'] } } },
      a1: { id: 'a1', parent: 'u1', children: [], message: { id: 'm2', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['hello'] } } },
    },
  }
  const off = convertChatgptJson(JSON.stringify([conv]))
  assert.equal(off.conversations.length, 1)
  // 默认关：system 过滤；环境变更声明始终注入（唯一 plugin 注入，不含 system 原文）
  const offPlugin = off.conversations[0].events.filter((e) => e.data && e.data.source && e.data.source.kind === 'plugin')
  assert.equal(offPlugin.length, 1)
  assert.ok(!offPlugin[0].data.content[0].text.includes('You are a helpful assistant.'))
  const on = convertChatgptJson(JSON.stringify([conv]), { importSystemPrompt: true })
  const c1 = on.conversations[0]
  const first = c1.events.find((e) => e.type === 'user/message')
  assert.equal(first.data.source.kind, 'plugin')
  assert.equal(first.data.source.plugin, 'chat-import')
  assert.ok(first.data.content[0].text.includes('You are a helpful assistant.'))
  assert.ok(first.seq > c1.events.find((e) => e.type === 'step/start').seq)
})

test('convertChatgptJson: tool 节点降级为文本块，不再产生孤儿 tool/result', () => {
  // ChatGPT 导出无结构化 tool-call（assistant 从不带 tool_calls 数组）；tool 节点
  // 挂 tool/result 只会产生没有对应 tool/call 的孤儿结果，resume 被模型端拒绝。
  // 按契约降级为最近一步的文本块。
  const raw = JSON.stringify([{
    id: 'conv-tool-001',
    title: 'Tool chat',
    create_time: 1710009000,
    mapping: {
      'n1': {
        id: 'n1',
        message: { id: 'm1', author: { role: 'user' }, content: { content_type: 'text', parts: ['跑一下测试'] }, create_time: 1710009000 },
        parent: null,
        children: ['n2'],
      },
      'n2': {
        id: 'n2',
        message: { id: 'm2', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['好的，执行 npm test。'] }, create_time: 1710009050 },
        parent: 'n1',
        children: ['n3'],
      },
      'n3': {
        id: 'n3',
        message: { id: 'm3', author: { role: 'tool' }, content: { content_type: 'code', parts: ['all tests passed'] }, create_time: 1710009060 },
        parent: 'n2',
        children: [],
      },
    },
  }])
  const out = convertChatgptJson(raw)
  assert.equal(out.conversations.length, 1)
  const c = out.conversations[0]
  // 不再产生 tool/result / tool/call 事件
  assert.equal(c.events.filter((e) => e.type === 'tool/result').length, 0)
  assert.equal(c.toolCalls, 0)
  // 工具文本挂到最近一步的 assistant 消息内容里
  const asst = c.events.find((e) => e.type === 'assistant/message').data.message
  assert.ok(asst.content.some((b) => b.type === 'text' && b.text === 'all tests passed'))
  // 平衡：最后（非 title）事件是 turn/end
  const types = c.events.map((e) => e.type)
  assert.equal([...types].reverse().find((t) => t !== 'session/title'), 'turn/end')
})

// ---- REQ-19：分支还原 + 工具参数结构化 ----

test('convertChatgptJson: branch:all 枚举全部分支会话（main = 最后 child 链）', () => {
  // 合成多分支 mapping：root user → assistant A（children: n3 / n4 两条回复分支），
  // n4 分支继续 n5（占位）→ n6（assistant 更正）
  const raw = JSON.stringify([{
    id: 'conv-branch-001',
    title: 'Branch chat',
    create_time: 1710010000,
    mapping: {
      'n1': {
        id: 'n1',
        message: { id: 'm1', author: { role: 'user' }, content: { content_type: 'text', parts: ['怎么煮意面？'] }, create_time: 1710010000 },
        parent: null,
        children: ['n2'],
      },
      'n2': {
        id: 'n2',
        message: { id: 'm2', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['两种做法：'] }, create_time: 1710010100 },
        parent: 'n1',
        children: ['n3', 'n4'],
      },
      'n3': {
        id: 'n3',
        message: { id: 'm3', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['做法 A：aglio e olio。'] }, create_time: 1710010200 },
        parent: 'n2',
        children: [],
      },
      'n4': {
        id: 'n4',
        message: { id: 'm4', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['做法 B：cacio e pepe。'] }, create_time: 1710010300 },
        parent: 'n2',
        children: ['n5'],
      },
      'n5': {
        id: 'n5',
        message: null, // 占位节点
        parent: 'n4',
        children: ['n6'],
      },
      'n6': {
        id: 'n6',
        message: { id: 'm6', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['更正：B 用 pecorino。'] }, create_time: 1710010400 },
        parent: 'n5',
        children: [],
      },
    },
  }])

  // main 模式：只导最后 child 链（n1→n2→n4→n6），n3 分支不出现
  const main = convertChatgptJson(raw, {})
  assert.equal(main.conversations.length, 1)
  const cMain = main.conversations[0]
  assert.equal(cMain.meta.id, 'import-conv-branch-001')
  const mainTexts = cMain.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message.content[0].text)
  assert.deepEqual(mainTexts, ['两种做法：', '做法 B：cacio e pepe。', '更正：B 用 pecorino。'])

  // all 模式：两条 root→leaf 路径各成一会话
  const all = convertChatgptJson(raw, { branch: 'all' })
  assert.equal(all.conversations.length, 2)
  const main2 = all.conversations.find((c) => c.meta.id === 'import-conv-branch-001')
  const branch = all.conversations.find((c) => c.meta.id !== 'import-conv-branch-001')
  assert.ok(main2)
  assert.ok(branch)
  // 主线程与 main 模式一致（最后 child 链）
  const main2Texts = main2.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message.content[0].text)
  assert.deepEqual(main2Texts, ['两种做法：', '做法 B：cacio e pepe。', '更正：B 用 pecorino。'])
  // 分支会话：sourceId 带分支叶子尾缀（registry 幂等键不覆盖）、标题带分支标记
  assert.match(branch.meta.sourceId, /^conv-branch-001-n\d+$/)
  assert.match(branch.title, /Branch chat（分支 /)
  const branchTexts = branch.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message.content[0].text)
  assert.deepEqual(branchTexts, ['两种做法：', '做法 A：aglio e olio。'])
  // 两会话都平衡
  for (const c of all.conversations) {
    const types = c.events.map((e) => e.type)
    assert.equal([...types].reverse().find((t) => t !== 'session/title'), 'turn/end')
  }
})

test('convertChatgptJson: 工具消息还原 tool/call + tool/result（参数结构化 + sourceEventSeqs）', () => {
  const raw = JSON.stringify([{
    id: 'conv-tool2-001',
    title: 'Tool chat 2',
    create_time: 1710020000,
    mapping: {
      'n1': {
        id: 'n1',
        message: { id: 'm1', author: { role: 'user' }, content: { content_type: 'text', parts: ['算一下 1+1'] }, create_time: 1710020000 },
        parent: null,
        children: ['n2'],
      },
      'n2': {
        id: 'n2',
        message: {
          id: 'm2',
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['{"tool_name":"calculator","tool_call_id":"call_abc","args":{"expr":"1+1"}}'] },
          create_time: 1710020100,
        },
        parent: 'n1',
        children: ['n3'],
      },
      'n3': {
        id: 'n3',
        message: { id: 'm3', author: { role: 'tool' }, name: 'calculator', recipient: 'functions.calculator', content: { content_type: 'text', parts: ['2'] }, create_time: 1710020200 },
        parent: 'n2',
        children: ['n4'],
      },
      'n4': {
        id: 'n4',
        message: { id: 'm4', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['结果是 2。'] }, create_time: 1710020300 },
        parent: 'n3',
        children: [],
      },
    },
  }])
  const out = convertChatgptJson(raw, {})
  assert.equal(out.conversations.length, 1)
  const c = out.conversations[0]
  // tool/call 结构化（arguments 保持 JSON 字符串，与 Claude/Codex 语义一致）
  const calls = c.events.filter((e) => e.type === 'tool/call')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].data.callId, 'call_abc')
  assert.equal(calls[0].data.name, 'calculator')
  assert.equal(calls[0].data.arguments, '{"expr":"1+1"}')
  assert.equal(c.toolCalls, 1)
  // tool/result 配对（sourceEventSeqs 指向 call 的 seq）
  const results = c.events.filter((e) => e.type === 'tool/result')
  assert.equal(results.length, 1)
  assert.equal(results[0].data.message.content[0].toolCallId, 'call_abc')
  assert.equal(results[0].data.message.content[0].content[0].text, '2')
  assert.deepEqual(results[0].sourceEventSeqs, [calls[0].seq])
  // 工具调用内容块不进 assistant 文本（不重复）
  const asst = c.events.find((e) => e.type === 'assistant/message').data.message
  assert.ok(!asst.content.some((b) => b.type === 'text' && b.text.includes('tool_name')))
  assertToolPairing(c.events)
})

// ---- Cursor agent transcript ----

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
  out.events.forEach((e, i) => assert.equal(e.seq, i))
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

// ---- Gemini CLI 会话 ----

test('convertGeminiJson: 简单会话、元数据、平衡回合', () => {
  const out = convertGeminiJson(load('gemini-simple.json'), { sourcePath: 'D:\\demo\\gemini\\session-abc.json' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 2)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.meta.id, 'import-b26d7f99-0116-4d1d-b125-98c228a4b933')
  assert.equal(out.meta.sourceId, 'b26d7f99-0116-4d1d-b125-98c228a4b933')
  assert.equal(out.meta.cwd, 'D:\\demo\\gemini-proj') // directories[0] → cwd
  assert.ok(out.meta.createdAt) // startTime ISO → ms
  assertEnvelopeHygiene(out.events)
  const types = out.events.map((e) => e.type)
  assert.equal([...types].reverse().find((t) => t !== 'session/title'), 'turn/end')
  out.events.forEach((e, i) => assert.equal(e.seq, i))
  // 用户 parts 数组 → prompt
  const user = out.events.find((e) => e.type === 'user/message' && e.data.source.kind === 'user').data
  assert.equal(user.content[0].text, 'Create a basic python interpreter in rust.')
  // thoughts → reasoning；真实 model
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.ok(asst.content.some((c) => c.type === 'reasoning'))
  assert.deepEqual(asst.source, { kind: 'model', provider: 'gemini', model: 'gemini-3-flash-preview' })
})

test('convertGeminiJson: 内联 toolCalls → tool/call + tool/result（含错误标记）', () => {
  const out = convertGeminiJson(load('gemini-tool.json'))
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 2)
  const calls = out.events.filter((e) => e.type === 'tool/call')
  const results = out.events.filter((e) => e.type === 'tool/result')
  assert.equal(calls.length, 2)
  assert.equal(results.length, 2)
  assert.equal(calls[0].data.name, 'list_directory')
  assert.equal(calls[0].data.arguments, '{"path":"."}')
  // tool/result 与 tool/call 通过 sourceEventSeqs 关联
  assert.deepEqual(results[0].sourceEventSeqs, [calls[0].seq])
  assert.equal(results[0].data.message.content[0].content[0].text, 'src\nCargo.toml')
  // 第二个调用是 error → isError 标记
  assert.equal(results[1].data.message.content[0].isError, true)
  assert.equal(results[1].data.message.content[0].content[0].text, 'Compilation error: missing semicolon')
  // info 消息跳过：没有多余回合
  assert.equal(out.turns.length, 1)
  assertMessageOrderLegal(out.events)
})

test('convertGeminiJson: toolCalls 无 result 补发空 tool/result', () => {
  // 调用没有内联 result（geminiToolResultText 返回 null）→ 合成空 result 保证配对
  const raw = JSON.stringify({
    sessionId: 'gemini-cut-001',
    startTime: '2026-04-17T18:09:18.567Z',
    directories: ['D:\\demo\\gemini-proj'],
    messages: [
      { id: 'u1', type: 'user', content: [{ text: '跑一下' }] },
      {
        id: 'g1', type: 'gemini', content: '好',
        model: 'gemini-3-flash-preview',
        toolCalls: [
          { id: 'tc_01', name: 'run_shell_command', args: { command: 'npm test' }, status: 'success', result: [] },
        ],
      },
    ],
  })
  const out = convertGeminiJson(raw)
  assert.equal(out.toolCalls, 1)
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.ok(result)
  assert.deepEqual(result.data.message.content[0].content, [])
  assert.equal(result.data.message.content[0].toolCallId, 'tc_01')
  assertToolPairing(out.events)
  assert.equal(out.events.at(-1).type, 'turn/end')
})

test('convertGeminiJson: 多轮切分、kind 缺失兼容', () => {
  const out = convertGeminiJson(load('gemini-multi-turn.json'))
  assert.equal(out.turns.length, 2)
  const starts = out.events.filter((e) => e.type === 'turn/start')
  assert.equal(starts.length, 2)
  const users = out.events.filter((e) => e.type === 'user/message' && e.data.source.kind === 'user')
  assert.equal(users.length, 2)
})

test('convertGeminiJson: 非法 JSON / 非会话结构返回空并 skipped', () => {
  const bad = convertGeminiJson('not json')
  assert.equal(bad.meta, null)
  assert.equal(bad.skipped, 1)
  const wrong = convertGeminiJson('{"foo":1}')
  assert.equal(wrong.meta, null)
  assert.equal(wrong.skipped, 1)
})

// ---- Reasonix ----

test('convertReasonixJsonl: subagent-* 子代理默认过滤（skipReason，不建会话）', () => {
  const out = convertReasonixJsonl(load('reasonix-v1.jsonl'), { reasonixId: 'subagent-sub-5-202606020721', sourcePath: 'D:\\demo\\reasonix\\subagent-sub-5-202606020721.jsonl' })
  assert.equal(out.meta, null)
  assert.equal(out.events.length, 0)
  assert.ok(out.skipReason && out.skipReason.includes('subagent'), '应给出子代理跳过原因')
})

test('convertReasonixJsonl: v1 嵌套 tool_calls + tool_call_id 配对 + reasoning', () => {
  const out = convertReasonixJsonl(load('reasonix-v1.jsonl'), { reasonixId: 'desktop-202606020721-1', sourcePath: 'D:\\demo\\reasonix\\desktop-a.jsonl' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  assert.equal(out.meta.id, 'import-desktop-202606020721-1')
  assert.equal(out.meta.sourceId, 'desktop-202606020721-1')
  assertEnvelopeHygiene(out.events)
  const types = out.events.map((e) => e.type)
  assert.equal([...types].reverse().find((t) => t !== 'session/title'), 'turn/end')
  out.events.forEach((e, i) => assert.equal(e.seq, i))
  // 工具调用与结果配对
  const call = out.events.find((e) => e.type === 'tool/call')
  assert.equal(call.data.name, 'search_files')
  assert.equal(call.data.arguments, '{"pattern": "codegraph"}')
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.equal(result.data.message.content[0].content[0].text, '找到了 codegraph v0.9.8')
  // reasoning_content → reasoning block
  const asst = out.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message)
  assert.ok(asst.some((m) => m.content.some((c) => c.type === 'reasoning')))
  // provider
  assert.deepEqual(asst[0].source, { kind: 'model', provider: 'reasonix', model: 'reasonix' })
  assertMessageOrderLegal(out.events)
})

test('convertReasonixJsonl: v2 扁平 tool_calls + createdAt 时间戳', () => {
  const out = convertReasonixJsonl(load('reasonix-v2.jsonl'), { reasonixId: 'desktop-202606020725-2', cwd: 'D:\\Reasonix', title: '查看当前编辑 xlsx 的 skill' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  assert.equal(out.meta.cwd, 'D:\\Reasonix')
  assert.equal(out.meta.createdAt, 1780325474978) // 取第一条消息的 createdAt
  const call = out.events.find((e) => e.type === 'tool/call')
  assert.equal(call.data.name, 'list_directory')
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  // title 来自 meta.summary → session/title 事件
  const titleEv = out.events.find((e) => e.type === 'session/title')
  assert.equal(titleEv.data.title, '查看当前编辑 xlsx 的 skill')
})

test('convertReasonixJsonl: 多轮切分、畸形行计数', () => {
  const out = convertReasonixJsonl('not json\n' + load('reasonix-multi-turn.jsonl'), {})
  assert.equal(out.skipped, 1)
  assert.equal(out.turns.length, 2)
  const starts = out.events.filter((e) => e.type === 'turn/start')
  assert.equal(starts.length, 2)
  // 无 reasonixId 时退化为时间戳 id（仍合法）
  assert.match(out.meta.id, /^import-\d+$/)
})

test('convertReasonixJsonl: tool_calls 无 tool 消息补发空 tool/result', () => {
  // assistant 声明 tool_calls 但没有后续 role=tool 消息（会话中断）→ 合成空 result
  const raw = [
    '{"role":"user","content":"查一下"}',
    '{"role":"assistant","content":"好","tool_calls":[{"id":"call_rx_01","type":"function","function":{"name":"search_files","arguments":"{\\"q\\":\\"x\\"}"}}]}',
  ].join('\n')
  const out = convertReasonixJsonl(raw, { reasonixId: 'desktop-202606020799-9' })
  assert.equal(out.toolCalls, 1)
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.ok(result)
  assert.deepEqual(result.data.message.content[0].content, [])
  assert.equal(result.data.message.content[0].toolCallId, 'call_rx_01')
  assertToolPairing(out.events)
  assert.equal(out.events.at(-1).type, 'turn/end')
})

test('convertReasonixJsonl: 转录无 createdAt 时回退文件名内嵌时间戳', () => {
  const out = convertReasonixJsonl(load('reasonix-v1.jsonl'), { reasonixId: 'desktop-202606020721-1' })
  // stem 内嵌 202606020721（本地时间）→ 2026-06-02 07:21，不再取导入时刻
  assert.equal(out.meta.createdAt, new Date(2026, 5, 2, 7, 21).getTime())
})

test('reasonixStemTime: desktop/subagent 命名解析、无或非法时间戳回退 null', () => {
  assert.equal(reasonixStemTime('desktop-202607020158-1'), new Date(2026, 6, 2, 1, 58).getTime())
  assert.equal(reasonixStemTime('subagent-sub-1-202606030923'), new Date(2026, 5, 3, 9, 23).getTime())
  assert.equal(reasonixStemTime('code-tmp'), null)
  assert.equal(reasonixStemTime('desktop-202613990000-1'), null) // 非法月份
})

// ---- REQ-22 Reasonix V2 WAL 合并 + Claude compacted 摘要导入 ----

test('REQ-22 convertReasonixJsonl: WAL replace 事件整表接管（权威快照），walMerged/walRecords 报告', () => {
  const checkpoint = [
    JSON.stringify({ role: 'user', content: '问题1' }),
    JSON.stringify({ role: 'assistant', content: '旧回答' }),
  ].join('\n')
  const wal = [
    JSON.stringify({ type: 'replace', messages: [
      { role: 'user', content: '问题1' },
      { role: 'assistant', content: '新回答（WAL 权威）' },
      { role: 'user', content: '问题2' },
      { role: 'assistant', content: '回答2' },
    ] }),
  ].join('\n')
  const out = convertReasonixJsonl(checkpoint, { reasonixId: 'desktop-202607020199-1', walText: wal })
  assert.equal(out.walMerged, true)
  assert.equal(out.walRecords, 4)
  assert.equal(out.records, 4) // WAL 消息整表接管
  assert.equal(out.turns.length, 2)
  const texts = out.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message.content[0].text)
  assert.deepEqual(texts, ['新回答（WAL 权威）', '回答2'])
})

test('REQ-22 convertReasonixJsonl: 追加式 WAL（checkpoint 后事件）晚到者胜；无 WAL 纯 checkpoint', () => {
  const checkpoint = [
    JSON.stringify({ role: 'user', content: '问题1' }),
    JSON.stringify({ role: 'assistant', content: '回答1' }),
  ].join('\n')
  const wal = [
    JSON.stringify({ role: 'user', content: '问题2' }),
    JSON.stringify({ role: 'assistant', content: '回答2' }),
  ].join('\n')
  const out = convertReasonixJsonl(checkpoint, { reasonixId: 'desktop-202607020199-2', walText: wal })
  assert.equal(out.walMerged, true)
  assert.equal(out.walRecords, 2)
  assert.equal(out.turns.length, 2)
  // 无 WAL → 旧行为
  const plain = convertReasonixJsonl(checkpoint, { reasonixId: 'desktop-202607020199-2' })
  assert.equal(plain.walMerged, undefined)
  assert.equal(plain.turns.length, 1)
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
// ---- Pi Coding Agent 会话 JSONL ----

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
  out.events.forEach((e, i) => assert.equal(e.seq, i))
  assert.equal(out.events.filter((e) => e.type === 'turn/start').length, 2)
  // assistant source.model 来自消息级 model
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.source, { kind: 'model', provider: 'pi-coding-agent', model: 'claude-sonnet-4-5' })
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

// ---- opencode 会话（SQLite → 中间 JSON） ----

test('convertOpencodeJson: 简单问答、元数据、平衡回合', () => {
  const out = convertOpencodeJson(load('opencode-simple.json'), { sourcePath: 'E:/demo/opencode/opencode.db' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 2)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.meta.id, 'import-ses_simple001')
  assert.equal(out.meta.sourceId, 'ses_simple001')
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.cwd, 'E:/demo/opencode-proj')
  assert.equal(out.meta.createdAt, 1786000000000)
  assert.equal(out.title, 'Fix the build')
  assertEnvelopeHygiene(out.events)
  const types = out.events.map((e) => e.type)
  // 回合平衡：最后一个（非 title）事件是 turn/end；seq 连续
  assert.equal([...types].reverse().find((t) => t !== 'session/title'), 'turn/end')
  out.events.forEach((e, i) => assert.equal(e.seq, i))
  for (const e of out.events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result')) {
    assert.equal(e.surfaceOp, 'append')
  }
  const user = out.events.find((e) => e.type === 'user/message' && e.data.source.kind === 'user').data
  assert.equal(user.content[0].text, '帮我看看构建失败的原因')
  // 消息级 model（字符串）优先于会话级 model
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.equal(asst.content[0].text, '是缺少依赖，补上即可。')
  assert.deepEqual(asst.source, { kind: 'model', provider: 'opencode', model: 'deepseek-v4-pro' })
  // title → session/title 事件
  const titleEv = out.events.find((e) => e.type === 'session/title')
  assert.equal(titleEv.data.title, 'Fix the build')
  assert.deepEqual(titleEv.data.source, { kind: 'user' })
})

test('convertOpencodeJson: reasoning + tool/call + tool/result（error 标记、sourceEventSeqs 关联）', () => {
  const out = convertOpencodeJson(load('opencode-tool.json'))
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 2)
  const calls = out.events.filter((e) => e.type === 'tool/call')
  const results = out.events.filter((e) => e.type === 'tool/result')
  assert.equal(calls.length, 2)
  assert.equal(results.length, 2)
  assert.equal(calls[0].data.name, 'bash')
  assert.equal(calls[0].data.callId, 'call_01')
  assert.equal(calls[0].data.arguments, '{"command":"cargo run"}')
  // 每个 result 通过 sourceEventSeqs 关联自己的 call
  assert.deepEqual(results[0].sourceEventSeqs, [calls[0].seq])
  assert.deepEqual(results[1].sourceEventSeqs, [calls[1].seq])
  assert.equal(results[0].data.message.content[0].toolCallId, 'call_01')
  assert.equal(results[0].data.message.content[0].content[0].text, "thread 'main' panicked at src/main.rs:12")
  assert.equal(results[0].data.message.content[0].isError, undefined)
  // 第二个工具是 error → isError 标记
  assert.equal(results[1].data.message.content[0].isError, true)
  assert.equal(results[1].data.message.content[0].content[0].text, 'error: compilation failed')
  // reasoning → reasoning block；tool-call 出现在 assistant content 里
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  const kinds = asst.content.map((c) => c.type)
  assert.ok(kinds.includes('reasoning'))
  assert.ok(kinds.includes('text'))
  assert.ok(kinds.includes('tool-call'))
  assert.equal(asst.content.find((c) => c.type === 'reasoning').text, '先跑一下复现命令看崩溃栈。')
  // 平铺 modelID 优先
  assert.deepEqual(asst.source, { kind: 'model', provider: 'opencode', model: 'deepseek-v4-max' })
  assertMessageOrderLegal(out.events)
})

test('convertOpencodeJson: file/patch/subtask → 内容块，结构块跳过，空 output 工具仍配对', () => {
  const out = convertOpencodeJson(load('opencode-extras.json'))
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  const texts = asst.content.filter((c) => c.type === 'text').map((c) => c.text)
  // file part 带内联字节（data URL）→ IR image 块（宿主层落成附件），不再是文本占位
  assert.deepEqual(asst.content.filter((c) => c.type === 'image'),
    [{ type: 'image', data: 'AAAA', mediaType: 'image/png' }])
  assert.ok(texts.includes('[patch: 2 files]'))
  assert.ok(texts.includes('[subtask: npm test — 跑测试]'))
  assert.equal(out.imagesDegraded, undefined, '有字节：没有降级')
  // step-start / step-finish / compaction 不产生任何内容块
  assert.ok(!asst.content.some((c) => c.type === 'step-start' || c.type === 'step-finish' || c.type === 'compaction'))
  // 工具 state 无 output → 仍发 result（空文本），保持 call/result 配对
  const call = out.events.find((e) => e.type === 'tool/call')
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.equal(call.data.arguments, '{"command":"git diff"}')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.equal(result.data.message.content[0].content[0].text, '')
  assert.equal(result.data.message.content[0].isError, undefined)
  // 空 output 已有 result → 兜底不重复补：call/result 严格 1:1
  assertToolPairing(out.events)
  // 消息无模型 → 回退会话级 model（对象解析 id）
  assert.deepEqual(asst.source, { kind: 'model', provider: 'opencode', model: 'deepseek-v4-flash' })
})

test('convertOpencodeJson: 模型回退链（msg.modelID → msg.model.modelID → session.model.id）', () => {
  const raw = JSON.stringify({
    id: 'ses_chain',
    createdAt: 1786000300000,
    model: { id: 'session-model', providerID: 'opencode-go' },
    messages: [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'm2', role: 'assistant', model: { modelID: 'msg-object-model' }, parts: [{ type: 'text', text: 'a' }] },
      { id: 'm3', role: 'assistant', parts: [{ type: 'text', text: 'b' }] },
    ],
  })
  const out = convertOpencodeJson(raw)
  assert.equal(out.turns.length, 1) // 一个 user → 两个 assistant 步
  const sources = out.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message.source)
  assert.equal(sources[0].model, 'msg-object-model') // 消息级对象 modelID 优先
  assert.equal(sources[1].model, 'session-model') // 无消息级 → 会话级 id
  // 全程无消息级/会话级模型时回退 provider 名
  const bare = convertOpencodeJson(JSON.stringify({
    id: 'ses_bare',
    messages: [
      { id: 'b1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'b2', role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
    ],
  }))
  assert.equal(bare.events.find((e) => e.type === 'assistant/message').data.message.source.model, 'opencode')
})

test('convertOpencodeJson: 非法 JSON / 无 messages 返回空并 skipped（对齐 Gemini 失败形态）', () => {
  const bad = convertOpencodeJson('not json')
  assert.equal(bad.meta, null)
  assert.equal(bad.skipped, 1)
  assert.deepEqual(bad.events, [])
  assert.deepEqual(bad.turns, [])
  assert.equal(bad.messages, 0)
  assert.equal(bad.toolCalls, 0)
  const wrong = convertOpencodeJson('{"id":"x"}')
  assert.equal(wrong.meta, null)
  assert.equal(wrong.skipped, 1)
})

test('convertOpencodeJson: sessionId 覆盖参数生效、空 messages 不产生会话', () => {
  const out = convertOpencodeJson(load('opencode-simple.json'), { sessionId: 'custom-opencode' })
  assert.equal(out.meta.id, 'custom-opencode')
  const ids = out.events.filter((e) => e.type === 'user/message').map((e) => e.data.id)
  // 首条是环境变更声明（import:custom-opencode:env），真实提问在其后
  assert.ok(ids.some((id) => id.startsWith('import:custom-opencode:u1')))
  // 无 messages → 空事件，由 index 层计 skipped
  const empty = convertOpencodeJson('{"id":"ses_empty","createdAt":1,"messages":[]}')
  assert.equal(empty.turns.length, 0)
  assert.equal(empty.events.length, 0)
})

test('convertOpencodeJson: 压缩摘要 summary → 首个 assistant 步骤前置 reasoning 块', () => {
  const raw = JSON.stringify({
    id: 'ses_comp',
    title: 'Long task',
    directory: 'E:/demo/opencode-proj',
    createdAt: 1786000000000,
    summary: '前面做过的所有事都被压成这段摘要。',
    messages: [
      { id: 'msg-c1', role: 'user', createdAt: 1, parts: [{ type: 'text', text: '继续' }] },
      { id: 'msg-c2', role: 'assistant', createdAt: 2, parts: [{ type: 'text', text: '好的' }] },
    ],
  })
  const out = convertOpencodeJson(raw)
  const firstStep = out.turns[0].steps[0]
  assert.equal(firstStep.content[0].type, 'reasoning')
  assert.equal(firstStep.content[0].text, '前面做过的所有事都被压成这段摘要。')
  // 摘要只前置一次，不重复
  const reasoning = out.events
    .filter((e) => e.type === 'assistant/message')
    .flatMap((e) => e.data.message.content)
    .filter((c) => c.type === 'reasoning')
  assert.equal(reasoning.length, 1)
})

// ---- REQ-27 标题兜底（custom-title > ai-title > 首问；截断；空标题不写） ----

test('REQ-27 claude: custom-title（summary 记录）覆盖 ai-title 与首问', () => {
  const raw = [
    '{"sessionId":"sess-req27-001","type":"summary","summary":"用户自定义标题","leafUuid":null}',
    '{"sessionId":"sess-req27-001","type":"user","message":{"role":"user","content":"第一个问题"}}',
    '{"sessionId":"sess-req27-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"回答"}]}}',
    '{"sessionId":"sess-req27-001","type":"ai-title","aiTitle":"AI 生成的标题"}',
  ].join('\n')
  const out = convertClaudeJsonl(raw)
  assert.equal(out.title, '用户自定义标题') // custom 覆盖 ai
  const titleEv = out.events.find((e) => e.type === 'session/title')
  assert.ok(titleEv)
  assert.equal(titleEv.data.title, '用户自定义标题')
  // summary 记录的 title 字段同源（兼容字段名变体）
  const out2 = convertClaudeJsonl(raw.replace('"summary":"用户自定义标题"', '"title":"标题字段变体"'))
  assert.equal(out2.title, '标题字段变体')
})

test('REQ-27 claude: ai-title 覆盖首问兜底', () => {
  const out = convertClaudeJsonl(load('sess-title-001.jsonl'))
  assert.equal(out.title, '项目问题讨论') // ai-title，而非首问「问个问题」
  const titleEv = out.events.find((e) => e.type === 'session/title')
  assert.equal(titleEv.data.title, '项目问题讨论')
})

test('REQ-27 claude: 无显式标题 → 首问兜底（out.title，不钉事件）', () => {
  const out = convertClaudeJsonl(load('sess-simple-001.jsonl'))
  assert.equal(out.title, '你好，帮我看看这个项目')
  assert.equal(out.events.some((e) => e.type === 'session/title'), false)
})

test('REQ-27 codex: 首问兜底（无显式标题源）', () => {
  const out = convertCodexJsonl(load('codex-simple.jsonl'))
  assert.equal(out.title, '你好，看看这个项目')
  assert.equal(out.events.some((e) => e.type === 'session/title'), false)
})

test('REQ-27 cursor/gemini: 首问兜底', () => {
  const c = convertCursorJsonl(load('cursor-simple.jsonl'))
  assert.equal(c.title, 'Create a basic python interpreter in rust.')
  assert.equal(c.events.some((e) => e.type === 'session/title'), false)
  const g = convertGeminiJson(load('gemini-simple.json'))
  assert.equal(g.title, 'Create a basic python interpreter in rust.')
  assert.equal(g.events.some((e) => e.type === 'session/title'), false)
})

test('REQ-27 reasonix: meta.summary（显式）> 首问兜底', () => {
  const withTitle = convertReasonixJsonl(load('reasonix-v2.jsonl'), { reasonixId: 'desktop-202606020725-2', title: '查看当前编辑 xlsx 的 skill' })
  assert.equal(withTitle.title, '查看当前编辑 xlsx 的 skill')
  assert.ok(withTitle.events.some((e) => e.type === 'session/title'))
  const bare = convertReasonixJsonl(load('reasonix-v1.jsonl'), { reasonixId: 'desktop-202606020721-1' })
  assert.equal(bare.title, '在 github 上搜索 codegraph 并安装')
  assert.equal(bare.events.some((e) => e.type === 'session/title'), false)
})

test('REQ-27 截断：首问超 80 字符 → 79 字符 + 省略号（统一规则）', () => {
  const raw = [
    '{"sessionId":"sess-req27-002","type":"user","message":{"role":"user","content":"' + '长'.repeat(85) + '"}}',
    '{"sessionId":"sess-req27-002","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"回答"}]}}',
  ].join('\n')
  const out = convertClaudeJsonl(raw)
  assert.equal(out.title.length, 80)
  assert.equal(out.title, '长'.repeat(79) + '…')
})

test('REQ-27 截断：显式标题（ai-title）同样截断', () => {
  const raw = [
    '{"sessionId":"sess-req27-003","type":"user","message":{"role":"user","content":"首问"}}',
    '{"sessionId":"sess-req27-003","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"回答"}]}}',
    '{"sessionId":"sess-req27-003","type":"ai-title","aiTitle":"' + 'x'.repeat(90) + '"}',
  ].join('\n')
  const out = convertClaudeJsonl(raw)
  assert.equal(out.title, 'x'.repeat(79) + '…')
  const titleEv = out.events.find((e) => e.type === 'session/title')
  assert.equal(titleEv.data.title, 'x'.repeat(79) + '…')
})

test('REQ-27 空标题不写 session/title（空白 ai-title 视作无标题 → 首问兜底）', () => {
  const raw = [
    '{"sessionId":"sess-req27-004","type":"user","message":{"role":"user","content":"首问"}}',
    '{"sessionId":"sess-req27-004","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"回答"}]}}',
    '{"sessionId":"sess-req27-004","type":"ai-title","aiTitle":"   "}',
  ].join('\n')
  const out = convertClaudeJsonl(raw)
  assert.equal(out.events.some((e) => e.type === 'session/title'), false)
  assert.equal(out.title, '首问')
})

// ---- custom-title（/rename 载体）：现代 Claude Code 的自定义标题 ----

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

// ---- compacted 现代 2.x 载体（compact_boundary + isCompactSummary user 记录） ----

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

// ---- tailSessionEvents（REQ-24 增量续写的事件级截取） ----
// 合成三回合 Claude transcript：turn1 文本问答、turn2 工具调用（call+result）、
// turn3 文本问答 + ai-title。
function threeTurnClaude() {
  return [
    '{"sessionId":"sess-incr-001","type":"user","message":{"role":"user","content":"第一个问题"}}',
    '{"sessionId":"sess-incr-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"第一个回答"}]}}',
    '{"sessionId":"sess-incr-001","type":"user","message":{"role":"user","content":"第二个问题"}}',
    '{"sessionId":"sess-incr-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"好"},{"type":"tool_use","id":"toolu_01","name":"Read","input":{"file":"a.txt"}}]}}',
    '{"sessionId":"sess-incr-001","type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":[{"type":"text","text":"A 内容"}]}]}}',
    '{"sessionId":"sess-incr-001","type":"user","message":{"role":"user","content":"第三个问题"}}',
    '{"sessionId":"sess-incr-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"第三个回答"}]}}',
    '{"sessionId":"sess-incr-001","type":"ai-title","aiTitle":"三回合会话"}',
  ].join('\n')
}

test('tailSessionEvents: 按 turn 切片、seq 从 fromSeq 连续重编号、续号用源编号', () => {
  const out = convertClaudeJsonl(threeTurnClaude(), { sourcePath: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(out.turns.length, 3)
  const fromSeq = 40 // 模拟已存日志长度
  const tail = tailSessionEvents(out, { fromTurn: 2, fromSeq })
  assert.equal(tail.firstTurn, 2)
  assert.equal(tail.droppedBoundaryResults, 0)
  // 尾部不含 session/imported 标记与 session/title（续写不重复写标记/标题）
  assert.ok(!tail.events.some((e) => e.type === 'session/imported'))
  assert.ok(!tail.events.some((e) => e.type === 'session/title'))
  // seq 从 fromSeq 连续
  tail.events.forEach((e, i) => assert.equal(e.seq, fromSeq + i))
  // 第一个事件是 turn2 的 turn/start；turn 续号用源编号（2、3）
  assert.equal(tail.events[0].type, 'turn/start')
  assert.equal(tail.events[0].data.turn, 2)
  const starts = tail.events.filter((e) => e.type === 'turn/start').map((e) => e.data.turn)
  assert.deepEqual(starts, [2, 3])
  // 尾部以 turn/end 收尾（平衡）；surfaceOp 保留
  assert.equal(tail.events.at(-1).type, 'turn/end')
  const surface = tail.events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message')
  assert.ok(surface.length > 0)
  for (const e of surface) assert.equal(e.surfaceOp, 'append')
  // 尾部事件集合 = 完整转换里 turn2 起的事件（session/title 被剥离）
  const headSeq = out.events.find((e) => e.type === 'turn/start' && e.data.turn === 2).seq
  const fromTurn2 = out.events.filter((e) => e.seq >= headSeq && e.type !== 'session/title')
  assert.equal(tail.events.length, fromTurn2.length)
  for (const [i, e] of fromTurn2.entries()) {
    assert.equal(tail.events[i].type, e.type)
    assert.deepEqual(tail.events[i].data, e.data)
  }
})

test('tailSessionEvents: 尾内 tool/result 的 sourceEventSeqs 重映射到新 seq', () => {
  const out = convertClaudeJsonl(threeTurnClaude(), { sourcePath: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  const tail = tailSessionEvents(out, { fromTurn: 2, fromSeq: 100 })
  const call = tail.events.find((e) => e.type === 'tool/call')
  const result = tail.events.find((e) => e.type === 'tool/result')
  assert.ok(call)
  assert.ok(result)
  assert.equal(call.data.callId, 'toolu_01')
  // 重映射后 result 指向尾内 call 的新 seq
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  // 尾部事件不引用旧 seq（全部落在 [fromSeq, fromSeq+len) 内）
  for (const e of tail.events) {
    if (Array.isArray(e.sourceEventSeqs)) {
      for (const s of e.sourceEventSeqs) assert.ok(s >= 100)
    }
  }
})

test('tailSessionEvents: 续写尾部不重复注入环境变更声明（issue #66）', () => {
  const out = convertClaudeJsonl(threeTurnClaude(), { sourcePath: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  const env = out.events.find(isEnvInjectionEvent)
  assert.ok(env, '完整转换含一条环境变更声明')
  // 声明位于首个 step/start 之后（写入位契约）
  const firstStep = out.events.find((e) => e.type === 'step/start')
  assert.ok(env.seq > firstStep.seq)
  // 尾部（含首轮切片的极端情形）不携带声明：前段已有一条，续写不得在对话中间再插一条
  for (const fromTurn of [1, 2, 3]) {
    const tail = tailSessionEvents(out, { fromTurn, fromSeq: 50 })
    assert.ok(!tail.events.some(isEnvInjectionEvent), 'fromTurn=' + fromTurn + ' 的尾部不得含声明')
  }
  // 声明是 plugin 注入：不计入真实消息数（既有口径不变）——3 问 + 4 条 assistant
  assert.equal(out.messages, 7)
})

test('tailSessionEvents: dropSessionEvents=false 保留 session/title（标题 last-wins 无害）', () => {
  const out = convertClaudeJsonl(threeTurnClaude(), { sourcePath: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  const tail = tailSessionEvents(out, { fromTurn: 3, fromSeq: 200, dropSessionEvents: false })
  const titleEv = tail.events.find((e) => e.type === 'session/title')
  assert.ok(titleEv)
  assert.equal(titleEv.data.title, '三回合会话')
  assert.equal(titleEv.seq, tail.events.at(-1).seq) // title 钉在尾部末尾
  // 默认剥离
  const stripped = tailSessionEvents(out, { fromTurn: 3, fromSeq: 200 })
  assert.ok(!stripped.events.some((e) => e.type === 'session/title'))
})

test('tailSessionEvents: 指向尾外的 sourceEventSeqs 原样保留并计 droppedBoundaryResults', () => {
  // 合成一个跨界场景：turn2 的 tool/result 引用 turn1 的 tool/call（跨轮异步结果）。
  // 手工构造 converted 事件：turn1 含 call（seq 5），turn2 含 result（sourceEventSeqs=[5]）。
  const ev = (type, seq, data, extra) => ({ type, seq, data, ...extra })
  const converted = {
    events: [
      ev(0, {}),
      ev('turn/start', 1, { turn: 1 }),
      ev('user/message', 2, {}, { surfaceOp: 'append' }),
      ev('assistant/message', 3, {}, { surfaceOp: 'append' }),
      ev('tool/call', 4, { callId: 'toolu_x' }),
      ev('turn/end', 5, { turn: 1 }),
      ev('turn/start', 6, { turn: 2 }),
      ev('user/message', 7, {}, { surfaceOp: 'append' }),
      ev('tool/result', 8, { toolCallId: 'toolu_x' }, { surfaceOp: 'append', sourceEventSeqs: [4] }),
      ev('turn/end', 9, { turn: 2 }),
    ],
    turns: [{}, {}],
  }
  const tail = tailSessionEvents(converted, { fromTurn: 2, fromSeq: 50 })
  assert.equal(tail.droppedBoundaryResults, 1)
  const result = tail.events.find((e) => e.type === 'tool/result')
  // 指向尾外的引用原样保留（前段 seq 未变，旧值仍指向真实调用）
  assert.deepEqual(result.sourceEventSeqs, [4])
  assert.deepEqual(tail.events.map((e) => e.seq), [50, 51, 52, 53])
})

// ---- REQ-37 超长会话三层保护（纯函数） ----

test('estimateTokens: CJK 1 token/字、ASCII 1 token/4 字符', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('汉字测试'), 4)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcdefgh'), 2)
  assert.equal(estimateTokens('a'.repeat(5)), 2) // ceil(5/4)
  assert.equal(estimateTokens('汉a'), 2) // 1 + ceil(1/4)
  assert.equal(estimateTokens('，。'), 2) // CJK 标点按 CJK 计
  assert.equal(estimateTokens(null), 0)
  assert.equal(estimateTokens(undefined), 0)
  assert.equal(estimateTokens(123), 0) // 非字符串按 0
})

test('cropContentBlocks: 超限文本保留头 75% + 尾、未超限原样、tool-result 内部块按结果上限', () => {
  const long = 'A'.repeat(100) + 'B'.repeat(20000)
  const r1 = cropContentBlocks([{ type: 'text', text: long }])
  assert.equal(r1.cropped, 1)
  const out1 = r1.blocks[0].text
  assert.ok(out1.length <= TEXT_BLOCK_CHAR_LIMIT)
  assert.ok(out1.startsWith('A'.repeat(100))) // 头保留
  assert.ok(out1.endsWith('B'.repeat(100))) // 尾保留
  assert.ok(out1.includes('…（已裁剪）…'))

  const short = { type: 'text', text: 'short' }
  const r2 = cropContentBlocks([short])
  assert.equal(r2.cropped, 0)
  assert.deepEqual(r2.blocks, [short])

  // reasoning 同样按文本上限裁剪
  const reasoning = { type: 'reasoning', text: 'R'.repeat(TOOL_RESULT_CHAR_LIMIT + 10) }
  const r3 = cropContentBlocks([reasoning], { textLimit: TOOL_RESULT_CHAR_LIMIT })
  assert.equal(r3.cropped, 1)
  assert.ok(r3.blocks[0].text.length <= TOOL_RESULT_CHAR_LIMIT)

  // tool-result 内部块按工具结果上限（默认 40K）裁剪
  const toolResult = { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'T'.repeat(TOOL_RESULT_CHAR_LIMIT + 10) }] }
  const r4 = cropContentBlocks([toolResult])
  assert.equal(r4.cropped, 1)
  assert.ok(r4.blocks[0].content[0].text.length <= TOOL_RESULT_CHAR_LIMIT)

  // savedTokens = 被裁内容的估算 token 减少量（增量修正 trim 的 L1 估算，免去二次全量走查）：
  // 未裁剪时为 0；裁剪后等于 原文估算 − 裁后估算（口径与 estimateTokens 一致）。
  assert.deepEqual(cropContentBlocks([short]), { blocks: [short], cropped: 0, savedTokens: 0 })
  const r5 = cropContentBlocks([{ type: 'text', text: long }])
  assert.equal(r5.cropped, 1)
  assert.equal(r5.savedTokens, estimateTokens(long) - estimateTokens(r5.blocks[0].text))
  assert.ok(r5.savedTokens > 0)

  // 非数组安全
  assert.deepEqual(cropContentBlocks(undefined), { blocks: [], cropped: 0, savedTokens: 0 })
})

// 合成 N 轮纯文本 turns（每轮 ~2×len tokens），供预算截断用例。
function textTurns(n, perTurnChars = 100) {
  const turns = []
  for (let i = 0; i < n; i++) {
    turns.push({
      prompt: '问题' + '字'.repeat(perTurnChars - 2) + i,
      steps: [{ content: [{ type: 'text', text: '回答' + '字'.repeat(perTurnChars - 2) + i }], toolCalls: [], toolResults: [] }],
    })
  }
  return turns
}

test('trimTurns: 预算内会话原样保留（无截断、无摘要）', () => {
  const turns = textTurns(2, 10)
  const { turns: out, trimmed } = trimTurns(turns, 100000)
  assert.equal(out.length, 2)
  assert.equal(trimmed.droppedTurns, 0)
  assert.equal(trimmed.droppedMessages, 0)
  assert.equal(trimmed.summaryInserted, false)
  assert.equal(trimmed.estimatedTokens, trimmed.originalTokens)
  assert.equal(out[0].prompt, turns[0].prompt) // 未裁剪
})

test('trimTurns: 超长会话保留开头锚点 3 条 user 文本 + 摘要 + 尾部，总估算 ≤ 预算', () => {
  const turns = textTurns(40, 100) // ~40×200 = 8000 tokens > 3×2000
  const { turns: out, trimmed } = trimTurns(turns, 2000)
  assert.ok(trimmed.droppedTurns > 0)
  assert.equal(trimmed.droppedTurns, 40 - out.length)
  assert.ok(trimmed.summaryInserted)
  assert.ok(trimmed.estimatedTokens <= 2000)
  assert.ok(trimmed.originalTokens > 3 * 2000)
  // 开头锚点：前 3 轮原样保留（prompt 未动）
  assert.equal(out[0].prompt, turns[0].prompt)
  assert.equal(out[1].prompt, turns[1].prompt)
  assert.equal(out[2].prompt, turns[2].prompt)
  // 尾部保留：最后一轮在尾部
  assert.equal(out.at(-1).prompt, turns[39].prompt)
  // 摘要作为 reasoning 块前置到首个保留尾部轮
  const firstTail = out[3]
  assert.equal(firstTail.steps[0].content[0].type, 'reasoning')
  assert.ok(firstTail.steps[0].content[0].text.includes('导入预算裁剪'))
  // 输入未被修改（纯函数）
  assert.equal(turns.length, 40)
  assert.equal(turns[0].prompt, '问题' + '字'.repeat(98) + '0')
})

test('trimTurns: 单条巨 assistant 消息（> 预算一半）在锚点内被第三层丢弃', () => {
  // 锚点第一轮含 3000-token 的巨消息：L2 保留锚点（病态小预算下收缩到 1 轮），
  // L3 把超半的整条 assistant 消息丢弃，只留 prompt（宁缺毋滥）。
  const turns = [
    { prompt: '锚点', steps: [{ content: [{ type: 'text', text: '字'.repeat(3000) }], toolCalls: [], toolResults: [] }] },
    ...textTurns(30, 10),
  ]
  const { turns: out, trimmed } = trimTurns(turns, 2000)
  assert.ok(trimmed.droppedOversized > 0)
  // 首轮仍在（prompt 保留），巨 step 被丢弃（宁缺毋滥，不超限）
  assert.equal(out[0].prompt, '锚点')
  assert.equal(out[0].steps.length, 0)
  assert.ok(trimmed.estimatedTokens <= 2000)
  assert.ok(trimmed.droppedMessages >= 1)
})

test('trimTurns: 单条巨工具结果（> 预算一半）被丢弃而非超限', () => {
  const turns = [
    {
      prompt: '锚点一',
      steps: [{
        content: [{ type: 'text', text: '回答一' }],
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }],
        toolResults: [{ toolCallId: 'c1', content: [{ type: 'text', text: '字'.repeat(40000) }] }],
      }],
    },
    ...textTurns(30, 10),
  ]
  const { turns: out, trimmed } = trimTurns(turns, 2000)
  assert.ok(trimmed.droppedOversized > 0)
  // 首轮仍在（锚点），但其巨工具结果被丢弃（调用保留 → synthesizeSession 补空结果）
  assert.equal(out[0].prompt, '锚点一')
  assert.equal(out[0].steps[0].toolResults.length, 0)
  assert.equal(out[0].steps[0].toolCalls.length, 1)
  assert.ok(trimmed.estimatedTokens <= 2000)
})

test('trimTurns: 整段 ≤ 锚点轮数 + 极小预算 → 锚点收缩丢轮计入 trimmed（REQ-49）', () => {
  // 3 轮 ≤ 锚点 3 条 user 文本（rest 为空），预算小到「锚点 + 摘要预留」仍超预算 →
  // 锚点从尾部收缩到 1 轮；被收缩的 2 轮必须计入 dropped*，不得静默消失。
  const turns = textTurns(3, 100) // 每轮 ~202 tokens，3 轮 ~606 > 400 预算
  const { turns: out, trimmed } = trimTurns(turns, 400)
  assert.equal(trimmed.droppedTurns, 2)
  assert.equal(trimmed.droppedMessages, 4) // 2 轮 × (1 prompt + 1 step)
  assert.equal(trimmed.droppedToolCalls, 0)
  assert.equal(trimmed.droppedToolResults, 0)
  assert.equal(out.length, 1) // 收缩守卫：至少留 1 轮可续聊
  assert.equal(out[0].prompt, turns[0].prompt)
  assert.ok(trimmed.summaryInserted)
  assert.ok(trimmed.estimatedTokens <= 400)
})

test('applyBudgetTrim: 整段 ≤ 锚点轮数 + 极小预算 → trimmed 非 null（REQ-49）', () => {
  const turns = textTurns(3, 100)
  const r = applyBudgetTrim(turns, 400)
  assert.ok(r.trimmed) // engaged 不再全零 → 报告如实反映丢轮
  assert.equal(r.trimmed.droppedTurns, 2)
  assert.equal(r.turns.length, 1)
  assert.equal(r.turns[0].prompt, turns[0].prompt)
})

test('trimTurns: 锚点收缩丢轮的工具调用/结果计入 droppedToolCalls/Results（REQ-49）', () => {
  const turns = [
    { prompt: 'q0', steps: [{ content: [{ type: 'text', text: 'a0' }], toolCalls: [], toolResults: [] }] },
    // 放大 toolResult 使预算可放宽到 300：避免预算过小触发 L3 摘要丢弃，计数只反映 L2 锚点收缩
    { prompt: 'q1', steps: [{ content: [{ type: 'text', text: 'a1' }], toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }], toolResults: [{ toolCallId: 'c1', content: [{ type: 'text', text: 'r1' + '字'.repeat(300) }] }] }] },
    { prompt: 'q2', steps: [{ content: [{ type: 'text', text: 'a2' }], toolCalls: [{ id: 'c2', name: 'read', arguments: '{}' }, { id: 'c3', name: 'grep', arguments: '{}' }], toolResults: [{ toolCallId: 'c2', content: [{ type: 'text', text: 'r2' + '字'.repeat(300) }] }, { toolCallId: 'c3', content: [{ type: 'text', text: 'r3' + '字'.repeat(300) }] }] }] },
  ]
  // 总估算 ≈ 2+303+604 = 909 > 300 → 进 L2；锚点 3 轮 + 512 恒超 → 收缩到 1 轮，丢 t1/t2
  const { turns: out, trimmed } = trimTurns(turns, 300)
  assert.equal(trimmed.droppedTurns, 2)
  assert.equal(trimmed.droppedToolCalls, 3) // 1 + 2
  assert.equal(trimmed.droppedToolResults, 3) // 1 + 2
  assert.equal(trimmed.droppedMessages, 7) // (1+1+1) + (1+1+2)
  assert.equal(trimmed.droppedOversized, 0) // 计数只来自 L2，无 L3 干扰
  assert.equal(out.length, 1)
  assert.equal(out[0].prompt, 'q0')
  assert.ok(trimmed.summaryInserted)
})

test('applyBudgetTrim: 无预算 / 非法预算 → 原样返回且无 trimmed 上报', () => {
  const turns = textTurns(5, 10)
  for (const budget of [undefined, null, 0, -1, 'abc', NaN]) {
    const r = applyBudgetTrim(turns, budget)
    assert.equal(r.trimmed, null)
    assert.equal(r.turns.length, 5)
    assert.equal(r.turns[0].prompt, turns[0].prompt)
  }
  // 字符串预算被 Number 归一（与 index 层 parseBudgetValue 口径一致）
  const str = applyBudgetTrim(textTurns(40, 100), '1000')
  assert.ok(str.trimmed)
  // 合法预算 + 保护未实际生效（预算内）→ 无上报
  const r2 = applyBudgetTrim(textTurns(2, 10), 100000)
  assert.equal(r2.trimmed, null)
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

// ── validateSessionEvents（REQ-57：导入结果结构校验）────────────────────────

// 一条合法事件的最小形状（surface 事件带 surfaceOp:'append'）。
const ev = (seq, type, extra = {}) => ({ type, seq, time: 1, data: {}, ...extra })

test('validateSessionEvents：合法会话 0 告警', () => {
  const events = [
    ev(0, 'session/imported', { ignorable: true }),
    ev(1, 'turn/start'),
    ev(2, 'user/message', { surfaceOp: 'append' }),
    ev(3, 'assistant/message', { surfaceOp: 'append' }),
    ev(4, 'tool/call'),
    ev(5, 'tool/result', { surfaceOp: 'append', sourceEventSeqs: [4] }),
    ev(6, 'step/end'),
    ev(7, 'turn/end'),
  ]
  const r = validateSessionEvents(events)
  assert.equal(r.ok, true)
  assert.deepEqual(r.problems, [])
})

test('validateSessionEvents：断 seq / 重复 seq / 缺 seq 均被报告', () => {
  const gap = validateSessionEvents([
    ev(0, 'turn/start'), ev(1, 'user/message', { surfaceOp: 'append' }), ev(3, 'assistant/message', { surfaceOp: 'append' }),
  ])
  assert.equal(gap.ok, false)
  assert.ok(gap.problems.some((p) => p.kind === 'seq-gap' && p.seq === 3))

  const dup = validateSessionEvents([ev(0, 'turn/start'), ev(0, 'turn/start')])
  assert.ok(dup.problems.some((p) => p.kind === 'duplicate-seq'))

  const missing = validateSessionEvents([ev(0, 'turn/start'), { type: 'turn/end', data: {} }])
  assert.ok(missing.problems.some((p) => p.kind === 'missing-seq'))
})

test('validateSessionEvents：图片块带内联 data（未落成附件）被点名', () => {
  const ref = { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
  const okRefs = validateSessionEvents([
    ev(0, 'turn/start'),
    ev(1, 'user/message', { surfaceOp: 'append', data: { content: [{ type: 'image', attachment: ref }] } }),
  ])
  assert.ok(!okRefs.problems.some((p) => p.kind === 'inline-image-data'), 'attachment 引用形态合法')

  const leaked = validateSessionEvents([
    ev(0, 'turn/start'),
    ev(1, 'user/message', { surfaceOp: 'append', data: { content: [{ type: 'image', data: 'aGVsbG8=', mediaType: 'image/png' }] } }),
  ])
  assert.equal(leaked.ok, false)
  assert.ok(leaked.problems.some((p) => p.kind === 'inline-image-data' && p.seq === 1))

  // tool-result 内层 content（V3 wrapper / V4 一级 content）里的图片块同样要被抓到
  const nested = validateSessionEvents([
    ev(0, 'turn/start'),
    ev(1, 'tool/result', {
      surfaceOp: 'append',
      data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'image', data: 'AAAA', mediaType: 'image/png' }] }] } },
    }),
  ])
  assert.ok(nested.problems.some((p) => p.kind === 'inline-image-data'))
})

test('validateSessionEvents：解释性 content 里的 tool-result 包装被点名（宿主 V4 退休语法，issue #77）', () => {
  const wrapper = { type: 'tool-result', toolCallId: 'c1', content: [] }
  const assistant = validateSessionEvents([
    ev(0, 'turn/start'),
    ev(1, 'assistant/message', { surfaceOp: 'append', data: { message: { id: 'a1', role: 'assistant', content: [wrapper] } } }),
  ])
  assert.equal(assistant.ok, false)
  const hit = assistant.problems.find((p) => p.kind === 'retired-tool-result-wrapper')
  assert.ok(hit && hit.seq === 1)
  assert.match(hit.message, /message\.content/)

  const user = validateSessionEvents([
    ev(0, 'turn/start'),
    ev(1, 'user/message', { surfaceOp: 'append', data: { content: [wrapper] } }),
  ])
  assert.ok(user.problems.some((p) => p.kind === 'retired-tool-result-wrapper' && p.seq === 1))

  // V3 形状的 tool/result 事件本身就带这个包装（写侧由 shapeToolResults 分流）：不误报
  const v3 = validateSessionEvents([
    ev(0, 'turn/start'),
    ev(1, 'tool/result', { surfaceOp: 'append', data: { message: { role: 'user', content: [wrapper], source: { kind: 'tool', callId: 'c1' } } } }),
  ])
  assert.ok(!v3.problems.some((p) => p.kind === 'retired-tool-result-wrapper'))
})

test('validateSessionEvents：未知类型 / surface 缺 surfaceOp / sourceEventSeqs 指向非 call', () => {
  const unknown = validateSessionEvents([ev(0, 'bogus/event')])
  assert.ok(unknown.problems.some((p) => p.kind === 'unknown-type'))

  const noSurface = validateSessionEvents([ev(0, 'user/message')])
  assert.ok(noSurface.problems.some((p) => p.kind === 'missing-surface-op'))

  const badRef = validateSessionEvents([
    ev(0, 'user/message', { surfaceOp: 'append' }),
    ev(1, 'tool/result', { surfaceOp: 'append', sourceEventSeqs: [0] }),
  ])
  assert.ok(badRef.problems.some((p) => p.kind === 'source-event-seqs-not-call'))
})

test('validateSessionEvents：宿主运行时/状态事件类型不再误报 unknown-type（issue #20 附注）', () => {
  // 原生 DSH 会话含运行时/状态事件（issue #20 附注点名的 6 种 + 代表性扩展），
  // 白名单对齐宿主词汇表后应 0 告警，而不是被判 unknown-type。
  const runtimeTypes = [
    'permission/preset', 'sandbox/mode', 'approval/policy', 'agent/inbox/spliced',
    'request/header', 'assistant/chunk',
    'todo/write', 'request/context', 'session/end-seed', 'tool/code-dispatch',
    'compaction/prune', 'plan/mode', 'team/task', 'tool-workflow/run-start',
    'web/deepseek-search-llm-request',
  ]
  const r = validateSessionEvents(runtimeTypes.map((type, i) => ev(i, type)))
  assert.equal(r.ok, true)
  assert.deepEqual(r.problems, [])
})

test('validateSessionEvents：原生压缩事务契约（括号配对 / 遮蔽范围 / 检查点溯源）', () => {
  const out = convertCodexJsonl(codexCompactedRollout(), { sessionId: 'codex-comp-1' })
  assert.equal(validateSessionEvents(out.events).ok, true)
  const clone = () => JSON.parse(JSON.stringify(out.events))
  const firstProblem = (events) => validateSessionEvents(events).problems[0]

  // 遮蔽范围首尾与 shadowedSeqs 不一致
  const rangeBad = clone()
  const summary = rangeBad.find((e) => e.type === 'compaction/summary')
  summary.data.shadowedRange = { start: summary.data.shadowedSeqs[1], end: summary.data.shadowedRange.end }
  assert.equal(firstProblem(rangeBad).kind, 'compaction-shadow-range')

  // shadowedSeqs 为空（宿主不变式要求非空）
  const emptyShadow = clone()
  emptyShadow.find((e) => e.type === 'compaction/summary').data.shadowedSeqs = []
  assert.equal(firstProblem(emptyShadow).kind, 'compaction-shadow-empty')

  // 检查点缺溯源（漏掉被遮蔽节点）
  const noProv = clone()
  const ck = noProv.find((e) => e.type === 'user/message' && typeof e.surfaceOp === 'object')
  ck.sourceEventSeqs = ck.sourceEventSeqs.slice(1)
  assert.equal(firstProblem(noProv).kind, 'compaction-provenance-missing')

  // 检查点标记与括号 compactionId 不一致 / source 不是 compact 标记
  const wrongId = clone()
  wrongId.find((e) => e.type === 'user/message' && typeof e.surfaceOp === 'object').data.source.compactionId = 'other'
  assert.equal(firstProblem(wrongId).kind, 'compaction-checkpoint-orphan')

  // 未闭合的括号（只有 start）
  const unclosed = clone().filter((e) => e.type !== 'compaction/end')
  assert.ok(validateSessionEvents(unclosed).problems.some((p) => p.kind === 'compaction-unclosed'))

  // 缺 summary 的 end
  const orphanEnd = clone().filter((e) => e.type !== 'compaction/summary' && e.type !== 'user/message')
  assert.ok(validateSessionEvents(orphanEnd).problems.some((p) => p.kind === 'compaction-end-orphan'))
})

test('trimTurns：原生压缩的受遮蔽前缀不计预算、不裁剪、不丢弃', () => {
  // 受遮蔽前缀（log-only）即便超出预算也原样保留；预算只作用于检查点之后的有效段
  const shadowedTurn = {
    shadowed: true,
    prompt: '被压掉的旧问题',
    steps: [{ content: [{ type: 'text', text: 'A'.repeat(4000) }], toolCalls: [], toolResults: [] }],
  }
  const effectiveTurns = Array.from({ length: 6 }, (_, i) => ({
    prompt: '有效问题' + i,
    steps: [{ content: [{ type: 'text', text: 'B'.repeat(4000) }], toolCalls: [], toolResults: [] }],
  }))
  const turns = [shadowedTurn, { prompt: '', steps: [], compaction: { summary: '摘要' } }, ...effectiveTurns]
  const { turns: out, trimmed } = trimTurns(turns, 1500)
  assert.equal(out[0], shadowedTurn, '受遮蔽轮原样保留（连对象都不重建）')
  assert.equal(out[1].compaction.summary, '摘要', '边界轮的检查点标记保留')
  assert.ok(trimmed.droppedTurns > 0, '有效段仍按预算裁剪')
  assert.ok(trimmed.originalTokens < 7000, 'originalTokens 只算有效段（不含被遮蔽的 4000 字符）')
  // 受遮蔽轮不参与估算：把它的正文放大 10 倍，预算判断不变
  const bigger = [{ ...shadowedTurn, steps: [{ content: [{ type: 'text', text: 'A'.repeat(40000) }], toolCalls: [], toolResults: [] }] }, ...turns.slice(1)]
  assert.equal(trimTurns(bigger, 1500).trimmed.originalTokens, trimmed.originalTokens)
})

test('validateSessionEvents：原生会话 sourceEventSeqs/surfaceOp 语义不再误报（issue #20 附注）', () => {
  // assistant/message 在原生会话可引用 assistant/chunk（消息重建），不应判 source-event-seqs-not-call
  const assistantRef = validateSessionEvents([
    ev(0, 'assistant/chunk'),
    ev(1, 'assistant/message', { surfaceOp: 'append', sourceEventSeqs: [0] }),
  ])
  assert.equal(assistantRef.ok, true)

  // compaction 的 replace surfaceOp 是合法形态，不应判 missing-surface-op
  const replaceOp = validateSessionEvents([
    ev(0, 'assistant/message', { surfaceOp: { op: 'replace', start: 0, end: 0 } }),
  ])
  assert.equal(replaceOp.ok, true)

  // tool/result 指向非 tool/call 仍报 source-event-seqs-not-call（回归不变）
  const toolResultBadRef = validateSessionEvents([
    ev(0, 'assistant/chunk'),
    ev(1, 'tool/result', { surfaceOp: 'append', sourceEventSeqs: [0] }),
  ])
  assert.ok(toolResultBadRef.problems.some((p) => p.kind === 'source-event-seqs-not-call'))
})

test('validateSessionEvents：指向集合外的 sourceEventSeqs 合法（append 尾片跨轮引用）', () => {
  // 尾片从 fromSeq 重编号，引用前段事件（不在集合内）——不报错
  const tail = [
    ev(10, 'turn/start'),
    ev(11, 'tool/result', { surfaceOp: 'append', sourceEventSeqs: [3] }),
  ]
  const r = validateSessionEvents(tail)
  assert.equal(r.ok, true)
})

test('validateSessionEvents：非数组 / 畸形条目报告且封顶', () => {
  const notArr = validateSessionEvents({})
  assert.equal(notArr.ok, false)
  assert.equal(notArr.problems[0].kind, 'not-array')

  const many = validateSessionEvents(Array.from({ length: 100 }, (_, i) => ev(i, 'bogus/event')))
  assert.ok(many.problems.length <= 20) // VALIDATION_PROBLEM_CAP
  assert.equal(many.ok, false)
})

test('validateSessionEvents：首个 step/start 之前的 surface 事件被点名（issue #66）', () => {
  // 旧版本（≤0.18.3）导入日志的形状：环境变更声明排在首个 turn/start 之前。
  // 宿主 v2→v3 迁移对「首个 step/start 之前的 surface」fail-closed 拒载，此形状
  // 必须在导入/校验时被点名，而不是等宿主迁移时静默打不开。
  const legacy = [
    ev(0, 'user/message', { surfaceOp: 'append' }),
    ev(1, 'turn/start'),
    ev(2, 'step/start'),
    ev(3, 'user/message', { surfaceOp: 'append' }),
    ev(4, 'assistant/message', { surfaceOp: 'append' }),
    ev(5, 'step/end'),
    ev(6, 'turn/end'),
  ]
  const r = validateSessionEvents(legacy)
  assert.equal(r.ok, false)
  assert.deepEqual(r.problems.map((p) => p.kind), ['surface-before-first-step'])
  assert.equal(r.problems[0].seq, 0)
  // 新注入位（step/start 之后）同形状不报
  const fixed = validateSessionEvents([
    ev(0, 'turn/start'),
    ev(1, 'step/start'),
    ev(2, 'user/message', { surfaceOp: 'append' }),
    ev(3, 'assistant/message', { surfaceOp: 'append' }),
    ev(4, 'step/end'),
    ev(5, 'turn/end'),
  ])
  assert.equal(fixed.ok, true)
  // 无任何 step/start（只有提问没有回复）时不适用该约束
  const noStep = validateSessionEvents([
    ev(0, 'turn/start'),
    ev(1, 'user/message', { surfaceOp: 'append' }),
    ev(2, 'turn/end'),
  ])
  assert.equal(noStep.ok, true)
})

// ===== 失败重发 step 清洗（ghost retry dedupe）=====
// Claude Code 在一轮工具调用没等到结果而中止时，会在紧随的下一步用同一个 tool_use id
// 原样重发（content 逐字节相同）。两条都保留会产生重复 callId 的 tool/call——DSH 会话
// 折叠器对同一 id 只允许一次 start（“received more than one start Match” 硬异常），
// 首个重复处之后的整段轨迹被吞掉。转换器在合成事件前丢弃失败重发的整步。

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

// 宿主 dsh >= 0.1.5 的 assertAssistantSettlementShape 要求 assistant/message 除
// turn/step 外还带 stream 数组；缺 stream 会让整份种子被拒（issue #41 ①）。
// 所有源共用 synthesizeSession，这里按源抽查落盘形状。
test('所有源的 assistant/message 都带 settlement 字段 stream（issue #41）', () => {
  const cases = [
    ['claude', () => convertClaudeJsonl(load('sess-simple-001.jsonl'))],
    ['codex', () => convertCodexJsonl(load('codex-simple.jsonl'))],
    ['cursor', () => convertCursorJsonl(load('cursor-simple.jsonl'))],
    ['gemini', () => convertGeminiJson(load('gemini-simple.json'))],
    ['pi', () => convertPiJsonl(load('pi-simple.jsonl'))],
    ['reasonix', () => convertReasonixJsonl(load('reasonix-v2.jsonl'))],
    ['qoder', () => convertQoderJsonl(load('qoder-simple.jsonl'))],
    ['opencode', () => convertOpencodeJson(load('opencode-simple.json'))],
  ]
  for (const [name, convert] of cases) {
    const out = convert()
    const assistants = out.events.filter((e) => e.type === 'assistant/message')
    assert.ok(assistants.length > 0, name + ' 应产出 assistant/message')
    for (const ev of assistants) {
      assert.equal(typeof ev.data.turn, 'number', name + ' assistant/message 带 turn')
      assert.equal(typeof ev.data.step, 'number', name + ' assistant/message 带 step')
      assert.ok(Array.isArray(ev.data.stream), name + ' assistant/message 带 stream 数组')
    }
  }
})

// codex reasoning：可读部分在 summary 块里（实测 81 条真实记录：content 恒为 null，
// summary 是 [{type:'summary_text',text}] 数组）。encrypted_content 是不透明密文
// （占 reasoning 的 85.2%），既不读也不搬。
test('codex：reasoning 的 summary 块转成 reasoning 内容块，密文不进产物', () => {
  const out = convertCodexJsonl(load('codex-reasoning.jsonl'))
  const steps = out.turns.flatMap((t) => t.steps)
  const blocks = steps.flatMap((s) => s.content).filter((c) => c.type === 'reasoning')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].text, '**Planning a project structure scan**')
  // 同一条记录里的多个 summary 块按序合并
  assert.equal(blocks[1].text, '**Reading the manifest**\n**Then listing the tree**')
  // reasoning 出现在其所属 assistant 步骤之前，必须并入该步而非另开一步
  assert.equal(steps.length, 1, 'reasoning 不得自开一步')
  assert.equal(out.messages, 2, 'messages 不得因 reasoning 虚增')
  assert.equal(out.turns.length, 1)
  // 密文绝不出现
  assert.ok(!JSON.stringify(out).includes('fixture-blob'), 'encrypted_content 不得进入转换产物')
})

test('codex：无 summary 的 reasoning 不产生空块，也不自开步骤', () => {
  const recs = [
    '{"timestamp":"2026-05-18T13:21:30.751Z","type":"session_meta","payload":{"id":"x","cwd":"/p"}}',
    '{"timestamp":"2026-05-18T13:21:30.754Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}',
    '{"timestamp":"2026-05-18T13:21:31.000Z","type":"response_item","payload":{"type":"reasoning","id":"r","summary":[],"encrypted_content":"gAAAAAB-fixture-blob-3"}}',
    '{"timestamp":"2026-05-18T13:21:31.100Z","type":"response_item","payload":{"type":"reasoning","id":"r2","encrypted_content":"gAAAAAB-fixture-blob-4"}}',
    '{"timestamp":"2026-05-18T13:21:32.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}',
  ].join('\n')
  const out = convertCodexJsonl(recs)
  const steps = out.turns.flatMap((t) => t.steps)
  const blocks = steps.flatMap((s) => s.content).filter((c) => c.type === 'reasoning')
  assert.equal(blocks.length, 0, '没有可读文本时不推空块')
  assert.equal(steps.length, 1, '不因空 reasoning 自开步骤')
  assert.equal(out.messages, 2)
  assert.ok(!JSON.stringify(out).includes('fixture-blob'))
})

// ---- 工具配对归位（wire 顺序 + V4 迁移合法性，见 synthesizeSession 配对预扫描）----

test('synthesizeSession: 跨 step 到达的异步结果归位到调用的 step', () => {
  const out = synthesizeSession({
    meta: { id: 't1', createdAt: 1700000000000 },
    turns: [{
      prompt: 'q',
      steps: [
        { content: [{ type: 'tool-call', id: 'c1', name: 'Bash', arguments: '{}' }], toolCalls: [{ id: 'c1', name: 'Bash', arguments: '{}' }], toolResults: [] },
        { content: [{ type: 'text', text: 'running' }], toolCalls: [], toolResults: [] },
        { content: [{ type: 'text', text: 'later' }], toolCalls: [], toolResults: [{ toolCallId: 'c1', content: [{ type: 'text', text: 'done' }] }] },
      ],
    }],
  })
  const call = out.events.find((e) => e.type === 'tool/call')
  const result = out.events.find((e) => e.type === 'tool/result')
  const firstStepEnd = out.events.find((e) => e.type === 'step/end')
  assert.ok(result, '异步结果仍被发射')
  assert.ok(result.seq < firstStepEnd.seq, '结果必须闭合在调用的 step 内（step/end 前配平）')
  assert.deepEqual(result.data.message.content[0].content, [{ type: 'text', text: 'done' }])
  assert.deepEqual(result.sourceEventSeqs, [call.seq], 'sourceEventSeqs 仍指向其 tool/call')
  assert.equal(out.events.filter((e) => e.type === 'tool/result').length, 1, '后续 step 不再重复该结果')
  assert.equal(out.orphanToolResults, undefined)
  assert.equal(out.duplicateToolResults, undefined)
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
})

test('synthesizeSession: 跨轮到达的异步结果归位到调用的轮', () => {
  const out = synthesizeSession({
    meta: { id: 't2', createdAt: 1700000000000 },
    turns: [
      {
        prompt: 'q1',
        steps: [{ content: [{ type: 'tool-call', id: 'c1', name: 'Bash', arguments: '{}' }], toolCalls: [{ id: 'c1', name: 'Bash', arguments: '{}' }], toolResults: [] }],
      },
      {
        prompt: 'q2',
        steps: [{ content: [{ type: 'text', text: 'next' }], toolCalls: [], toolResults: [{ toolCallId: 'c1', content: [{ type: 'text', text: 'late' }] }] }],
      },
    ],
  })
  const result = out.events.find((e) => e.type === 'tool/result')
  const firstTurnEnd = out.events.find((e) => e.type === 'turn/end')
  assert.ok(result && result.seq < firstTurnEnd.seq, '结果归位到调用所在轮的 step 内')
  assert.deepEqual(result.data.message.content[0].content, [{ type: 'text', text: 'late' }])
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
})

test('synthesizeSession: 无广告调用的孤儿结果丢弃并计数', () => {
  const out = synthesizeSession({
    meta: { id: 't3', createdAt: 1700000000000 },
    turns: [{
      prompt: 'q',
      steps: [{ content: [{ type: 'text', text: 'hi' }], toolCalls: [], toolResults: [{ toolCallId: 'ghost', content: [{ type: 'text', text: 'orphan-body' }] }] }],
    }],
  })
  assert.equal(out.events.filter((e) => e.type === 'tool/result').length, 0)
  assert.equal(out.orphanToolResults, 1)
  assert.equal(out.duplicateToolResults, undefined)
  assert.ok(!JSON.stringify(out.events).includes('orphan-body'), '孤儿结果正文不进入日志')
  assertToolPairing(out.events)
})

test('synthesizeSession: 同一调用的重复结果保留首条并计数', () => {
  const out = synthesizeSession({
    meta: { id: 't4', createdAt: 1700000000000 },
    turns: [{
      prompt: 'q',
      steps: [{
        content: [{ type: 'tool-call', id: 'c1', name: 'Bash', arguments: '{}' }],
        toolCalls: [{ id: 'c1', name: 'Bash', arguments: '{}' }],
        toolResults: [
          { toolCallId: 'c1', content: [{ type: 'text', text: 'first' }] },
          { toolCallId: 'c1', content: [{ type: 'text', text: 'second' }], isError: true },
        ],
      }],
    }],
  })
  const results = out.events.filter((e) => e.type === 'tool/result')
  assert.equal(results.length, 1)
  assert.deepEqual(results[0].data.message.content[0].content, [{ type: 'text', text: 'first' }])
  assert.equal(results[0].data.message.content[0].isError, undefined, '首条无 isError 时不虚构')
  assert.equal(out.duplicateToolResults, 1)
  assert.equal(out.orphanToolResults, undefined)
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
})

test('synthesizeSession: 首个 surface 事件是首个 step 内的 system head（宿主 v3→v4 迁移的 protected head）', () => {
  // 宿主 v3→v4 迁移要求 surface 的第一个事件是 system/message（protected head），
  // 否则宿主续聊写自己的 system/message 时整份日志被拒载：
  // "system/message requires a protected first surface head"。导入会话此前不写 head。
  const out = convertClaudeJsonl(load('sess-simple-001.jsonl'), { sourcePath: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  const surface = out.events.filter((e) => e.surfaceOp !== undefined)
  assert.equal(surface[0].type, 'system/message')
  assert.equal(surface[0].surfaceOp, 'append')
  assert.equal(surface[0].data.message.role, 'system')
  assert.deepEqual(surface[0].data.message.content, [], 'head 内容留空：真正的提示词由宿主在下一步替换')
  // 宿主 agents.create 的 seed 校验：system/message 必须来自 system-prompt 生产者
  //（"seed system/message at index 2 message must have system-prompt source"）
  assert.deepEqual(surface[0].data.message.source, { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' })
  // 必须落在已打开的 step 内，且是第一个 step/start 之后的第一条（宿主锚点同位置）
  const stepIdx = out.events.findIndex((e) => e.type === 'step/start')
  assert.equal(out.events[stepIdx + 1].type, 'system/message')
  assert.deepEqual([out.events[stepIdx + 1].data.turn, out.events[stepIdx + 1].data.step], [1, 1])
  assert.equal(validateSessionEvents(out.events).ok, true)
})

test('synthesizeSession: 首轮无 step 时 head 自补一个只装 head 的 step（否则没有可锚的 step）', () => {
  const out = convertClaudeJsonl(load('sess-empty-001.jsonl'), { sourcePath: 'D:\\demo\\proj\\sess-empty-001.jsonl' })
  assert.deepEqual(out.events.map((e) => e.type), [
    'turn/start', 'step/start', 'system/message', 'user/message', 'step/end', 'user/message', 'turn/end',
  ])
  assert.equal(out.events[2].data.message.role, 'system')
  assert.equal(validateSessionEvents(out.events).ok, true)
})

// attachConversionDetails 的计数透传断言在 verify-migration.test.mjs：本文件不引
// 宿主编排模块（check:linux 对引用它的测试文件启用 cwd 盘符纪律），本文件的盘符
// 字面量是纯转换层的原样透传夹具，属该规则的例外面。
