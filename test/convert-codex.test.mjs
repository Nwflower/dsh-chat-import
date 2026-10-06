// convert-codex.test.mjs — Codex 转换
// compacted 信封、子代理过滤、JS 字面量参数解析、展平信封还原。
// 由 test/convert.test.mjs 按主题拆出（纯移动：用例与断言未改）。
import { test } from 'node:test'
import { assertNativeCompaction, derivedSurfaceMessages } from './_support/compaction.mjs'
import { codexCompactedRollout } from './_support/codex-compacted.mjs'
import assert from 'node:assert/strict'
import { convertCodexJsonl, SESSION_FORMAT_VERSION, codexCustomToolArguments, jsObjectLiteralToJson, validateSessionEvents } from '../lib/convert/index.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { assertToolPairing, assertMessageOrderLegal, assertSeqContinuity } from './_support/session-invariants.mjs'
import { loadFixture } from './_support/fixtures.mjs'
const load = loadFixture

function codexJsCallRollout(input, name = 'exec_command') {
  return [
    { timestamp: 't0', type: 'session_meta', payload: { id: 'codex-js-001', timestamp: 't0', cwd: 'D:\\demo\\codex-proj' } },
    { timestamp: 't1', type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-5.5' } },
    { timestamp: 't2', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '跑一下' }] } },
    { timestamp: 't3', type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', call_id: 'call_js_01', name, input } },
  ].map((l) => JSON.stringify(l)).join('\n')
}

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
  assertSeqContinuity(out.events)
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

test('codex：走预算裁剪后仍标 aborted（裁剪不得丢掉回合级标记）', () => {
  const raw = load('codex-turn-aborted.jsonl')
  const budgeted = convertCodexJsonl(raw, { budget: 550000 })
  const ends = budgeted.events.filter((e) => e.type === 'turn/end').map((e) => e.data.reason)
  assert.deepEqual(ends, [{ kind: 'aborted', reason: { kind: 'legacy' } }, { kind: 'completed' }])
})

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
