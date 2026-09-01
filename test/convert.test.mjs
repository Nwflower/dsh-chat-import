// convert.test.mjs — 纯转换逻辑单元测试（无宿主依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { convertClaudeJsonl, convertCodexJsonl, convertChatgptJson, convertCursorJsonl, convertGeminiJson, convertReasonixJsonl, convertPiJsonl, convertOpencodeJson, reasonixStemTime, mintSessionId, parseTime, SESSION_FORMAT_VERSION, tailSessionEvents, codexCustomToolArguments, jsObjectLiteralToJson, estimateTokens, cropContentBlocks, trimTurns, applyBudgetTrim, TEXT_BLOCK_CHAR_LIMIT, TOOL_RESULT_CHAR_LIMIT, validateSessionEvents } from '../convert.mjs'
import { pinSourcedSessionTitle } from '../lib/sourced-title.mjs'

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
    'user/message', 'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
  ])
  // seq 连续从 0 开始；首事件是内部标记
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
  assert.deepEqual(types, ['user/message', 'turn/start', 'user/message', 'turn/end'])
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
  assert.equal(parseTime(undefined), Date.now())
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
    'user/message', 'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
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

test('convertCodexJsonl: 注入块被过滤、reasoning 加密被跳过、custom_tool_call 用 input', () => {
  const out = convertCodexJsonl(load('codex-custom-tool.jsonl'))
  assert.equal(out.turns.length, 1)
  // 注入的 <environment_context> 不进入 prompt
  const user = out.events.find((e) => e.type === 'user/message' && e.data.source.kind === 'user').data
  assert.equal(user.content[0].text, '帮我修这个 bug')
  // 加密 reasoning 不产生 reasoning 块
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
  // 开：developer 作为上下文注入附在环境变更声明之后（source.kind='plugin'，plugin='chat-import'）钉在最前
  const on = convertCodexJsonl(raw, { sessionId: 'codex-sp', importSystemPrompt: true })
  const first = on.events.find((e) => e.type === 'user/message')
  assert.equal(first.data.source.kind, 'plugin')
  assert.equal(first.data.source.plugin, 'chat-import')
  assert.ok(first.data.content[0].text.includes('You are Codex.'))
  assert.ok(first.data.content[0].text.includes('DeepSeek Harness'))
  assert.ok(first.seq < on.events.find((e) => e.type === 'turn/start').seq)
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
  assert.ok(first.seq < c1.events.find((e) => e.type === 'turn/start').seq)
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

test('REQ-22 convertClaudeJsonl: compacted 只导最后一次摘要 + 尾部，摘要作 reasoning 前置', () => {
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
  const out = convertClaudeJsonl(lines, { fileStem: 'sess-comp-001', compacted: true })
  assert.equal(out.compacted, true)
  // 只保留最后一次 summary 之后的尾部（1 轮）
  assert.equal(out.turns.length, 1)
  const texts = out.events.filter((e) => e.type === 'assistant/message')
    .map((e) => e.data.message.content.filter((b) => b.type === 'text').map((b) => b.text)[0])
  assert.deepEqual(texts, ['收尾回答'])
  // 摘要 reasoning 前置到首个保留轮
  const firstAsst = out.events.find((e) => e.type === 'assistant/message')
  assert.ok(firstAsst.data.message.content.some((b) => b.type === 'reasoning' && b.text === '最终总结：需求已完成'))
  // 标题取最后一次 summary 的 title（custom-title 载体）
  assert.equal(out.title, '最终标题')
  // 事件平衡（session/title 钉在最后，不破坏回合平衡）
  const types = out.events.map((e) => e.type)
  assert.equal([...types].reverse().find((t) => t !== 'session/title'), 'turn/end')
  // 无 summary 记录 → compacted 不生效（全量）
  const noSummary = convertClaudeJsonl([
    JSON.stringify({ sessionId: 'sess-comp-001', type: 'user', message: { role: 'user', content: '问题1' } }),
    JSON.stringify({ sessionId: 'sess-comp-001', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '回答1' }] } }),
  ].join('\n'), { fileStem: 'sess-comp-001', compacted: true })
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

test('convertPiJsonl: compaction 默认尊重（摘要+retainedTail+尾部），fullHistory 导全量', () => {
  const out = convertPiJsonl(load('pi-compaction.jsonl'), {})
  assert.equal(out.turns.length, 2) // 第一个问题被压进摘要
  assert.deepEqual(out.turns.map((t) => t.prompt), ['第二个问题', '第三个问题'])
  const head = out.turns[0].steps[0].content
  assert.equal(head[0].type, 'reasoning')
  assert.ok(head[0].text.includes('The conversation history before this point was compacted'))
  assert.ok(head[0].text.includes('用户问了两个问题，都已经回答。'))
  assertMessageOrderLegal(out.events)

  const full = convertPiJsonl(load('pi-compaction.jsonl'), { fullHistory: true })
  assert.equal(full.turns.length, 3) // 全量：三个问题都在
  assert.deepEqual(full.turns.map((t) => t.prompt), ['第一个问题', '第二个问题', '第三个问题'])
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

test('convertOpencodeJson: file/patch/subtask → text 块，结构块跳过，空 output 工具仍配对', () => {
  const out = convertOpencodeJson(load('opencode-extras.json'))
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  const texts = asst.content.filter((c) => c.type === 'text').map((c) => c.text)
  assert.ok(texts.includes('[image: diagram.png]'))
  assert.ok(texts.includes('[patch: 2 files]'))
  assert.ok(texts.includes('[subtask: npm test — 跑测试]'))
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

  // 非数组安全
  assert.deepEqual(cropContentBlocks(undefined), { blocks: [], cropped: 0 })
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
    'compaction/start', 'plan/mode', 'team/task', 'tool-workflow/run-start',
    'web/deepseek-search-llm-request',
  ]
  const r = validateSessionEvents(runtimeTypes.map((type, i) => ev(i, type)))
  assert.equal(r.ok, true)
  assert.deepEqual(r.problems, [])
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
