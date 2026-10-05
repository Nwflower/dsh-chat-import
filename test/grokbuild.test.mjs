// grokbuild.test.mjs — Grok Build 源转换核心单元测试（自包含合成数据，不掺真实 transcript）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertGrokbuildJson } from '../lib/convert/grokbuild.mjs'
import { SESSION_FORMAT_VERSION } from '../lib/convert/core.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'

// 配对不变量：每个 tool/call 都有对应 tool/result，且 result 的 sourceEventSeqs
// 指向其 tool/call 的 seq（synthesizeSession 兜底保证，见 core.mjs）。
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
// （user/message / assistant/message / tool/result），事件顺序即 wire 消息顺序。
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

// 消息投影顺序合法（wire 规则）：带 tool-call 块的 assistant 之后、到下一个
// assistant / user 消息之前，其全部 toolCallId 必须已有对应 tool 消息；不允许
// 无对应 tool-call 的孤儿 tool 消息。返回投影序列供精确断言。
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

// 合成 summary.json（Grok Build 字段；JSON.stringify 会丢弃 undefined 键）
function summaryJson(over = {}) {
  return JSON.stringify({
    info: { id: 'grok-sess-001', cwd: 'D:/demo/grok-proj' },
    session_summary: '这是一段会话摘要。',
    generated_title: 'Grok 会话标题',
    created_at: '2026-07-16T12:00:00Z',
    updated_at: '2026-07-16T12:05:00Z',
    last_active_at: '2026-07-16T12:06:00Z',
    ...over,
  })
}

// 合成 chat_history.jsonl 文本
function chatLines(recs) {
  return recs.map((r) => JSON.stringify(r)).join('\n')
}

test('convertGrokbuildJson: 简单问答、元数据、显式标题、平衡回合', () => {
  const out = convertGrokbuildJson(summaryJson(), chatLines([
    { type: 'user', content: [{ type: 'text', text: '帮我看看构建失败' }], timestamp: '2026-07-16T12:00:00Z' },
    { type: 'assistant', content: [{ type: 'text', text: '是缺少依赖。' }], timestamp: '2026-07-16T12:00:10Z' },
  ]), { sourcePath: 'D:/demo/grok/sessions/proj-abc/grok-sess-001/summary.json' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 2)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.meta.id, 'import-grok-sess-001')
  assert.equal(out.meta.sourceId, 'grok-sess-001')
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.cwd, 'D:/demo/grok-proj')
  assert.equal(out.meta.createdAt, Date.parse('2026-07-16T12:00:00Z'))
  assert.equal(out.title, 'Grok 会话标题') // generated_title
  // 显式标题 → 钉 session/title 事件（最后，不破坏回合平衡）
  const types = out.events.map((e) => e.type)
  assert.deepEqual(types, [
    'turn/start', 'step/start', 'system/message', 'user/message', 'user/message', 'assistant/message', 'step/end', 'turn/end', 'session/title',
  ])
  assert.equal(out.events.at(-1).data.title, 'Grok 会话标题')
  out.events.forEach((e, i) => assert.equal(e.seq, i))
  assertEnvelopeHygiene(out.events)
  for (const e of out.events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message')) {
    assert.equal(e.surfaceOp, 'append')
  }
  // provider 与 model 回退（Grok 转录无模型字段 → provider 名）
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.source, { kind: 'model', provider: 'grokbuild', model: 'grokbuild' })
})

test('convertGrokbuildJson: tool_use → tool/call + tool 记录 tool_result → tool/result（sourceEventSeqs 关联）', () => {
  const out = convertGrokbuildJson(summaryJson(), chatLines([
    { type: 'user', content: [{ type: 'text', text: '跑一下测试' }] },
    { type: 'assistant', content: [{ type: 'text', text: '好的' }, { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'npm test' } }] },
    { type: 'tool', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: [{ type: 'text', text: 'all tests passed' }], is_error: false }] },
  ]))
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  const call = out.events.find((e) => e.type === 'tool/call')
  assert.equal(call.data.callId, 'toolu_01')
  assert.equal(call.data.name, 'Bash')
  assert.equal(call.data.arguments, '{"command":"npm test"}')
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.equal(result.data.message.content[0].toolCallId, 'toolu_01')
  assert.equal(result.data.message.content[0].content[0].text, 'all tests passed')
  assert.equal(result.data.message.content[0].isError, undefined) // is_error:false 不加标记
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.equal(result.surfaceOp, 'append')
  // tool-call 块出现在 assistant content 里（wire 适配器从 content 块派生 tool_calls）
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.content.map((c) => c.type), ['text', 'tool-call'])
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
})

test('convertGrokbuildJson: tool_result 块随 user 记录到达（Claude 风格）不开新轮', () => {
  const out = convertGrokbuildJson(summaryJson(), chatLines([
    { type: 'user', content: [{ type: 'text', text: '查一下' }] },
    { type: 'assistant', content: [{ type: 'tool_use', id: 'toolu_02', name: 'Read', input: { file: 'a.txt' } }] },
    { type: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content: [{ type: 'text', text: 'A 内容' }] }] },
  ]))
  assert.equal(out.turns.length, 1)
  assert.equal(out.events.filter((e) => e.type === 'user/message' && e.data.source.kind === 'user').length, 1) // 结果消息不占轮
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.equal(result.data.message.content[0].content[0].text, 'A 内容')
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
})

test('convertGrokbuildJson: string content 记录（无块）与顶层 tool_use_id', () => {
  const out = convertGrokbuildJson(summaryJson(), chatLines([
    { type: 'user', content: 'hello' },
    { type: 'assistant', content: 'Hi there' },
    { type: 'assistant', content: [{ type: 'tool_use', id: 'toolu_03', name: 'Bash', input: { command: 'ls' } }] },
    { type: 'tool', content: 'README.md\nsrc', tool_use_id: 'toolu_03' },
  ]))
  assert.equal(out.turns.length, 1)
  assert.equal(out.events.filter((e) => e.type === 'assistant/message').length, 2) // 两步
  const user = out.events.find((e) => e.type === 'user/message' && e.data.source.kind === 'user').data
  assert.equal(user.content[0].text, 'hello')
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.equal(result.data.message.content[0].content[0].text, 'README.md\nsrc')
  assertToolPairing(out.events)
})

test('convertGrokbuildJson: input_text/output_text 块归一到 text', () => {
  const out = convertGrokbuildJson(summaryJson(), chatLines([
    { type: 'user', content: [{ type: 'input_text', text: '第一个问题' }] },
    { type: 'assistant', content: [{ type: 'output_text', text: '第一个回答' }] },
  ]))
  const user = out.events.find((e) => e.type === 'user/message' && e.data.source.kind === 'user').data
  assert.equal(user.content[0].text, '第一个问题')
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.equal(asst.content[0].text, '第一个回答')
})

test('convertGrokbuildJson: thinking 块映射为 reasoning block', () => {
  const out = convertGrokbuildJson(summaryJson(), chatLines([
    { type: 'user', content: '怎么修' },
    { type: 'assistant', content: [{ type: 'thinking', thinking: '先看日志' }, { type: 'text', text: '查一下' }] },
  ]))
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.content.map((c) => c.type), ['reasoning', 'text'])
  assert.equal(asst.content[0].text, '先看日志')
})

test('convertGrokbuildJson: system 记录过滤计 filtered；reasoning 不再计 filtered（明文前置）', () => {
  const out = convertGrokbuildJson(summaryJson(), chatLines([
    { type: 'system', content: 'You are a coding agent.' },
    { type: 'user', content: [{ type: 'text', text: '继续' }] },
    { type: 'reasoning', content: [{ type: 'summary_text', text: '旧形状的可读思考' }] },
    { type: 'assistant', content: [{ type: 'text', text: '好的' }] },
  ]))
  assert.equal(out.turns.length, 1)
  assert.equal(out.filtered, 1) // 只有 system；reasoning 的可读部分进对话，不再计 filtered
  assert.equal(out.skipped, 0)
  assert.equal(out.records, 4)
  assert.equal(out.events.filter((e) => e.type === 'turn/start').length, 1)
  // 兼容旧 content 块形状的 summary_text：归一到 reasoning 块并前置，不泄漏进文本
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.content.map((c) => c.type), ['reasoning', 'text'])
  assert.equal(asst.content[0].text, '旧形状的可读思考')
})

test('convertGrokbuildJson: 标题回退链 generated_title > session_summary > 首问（REQ-27 截断）', () => {
  const oneTurn = chatLines([
    { type: 'user', content: '首问' },
    { type: 'assistant', content: '回答' },
  ])
  // 两者都有 → generated_title 优先
  const both = convertGrokbuildJson(summaryJson(), oneTurn)
  assert.equal(both.title, 'Grok 会话标题')
  assert.ok(both.events.some((e) => e.type === 'session/title'))
  // 只有 session_summary → 用它
  const summaryOnly = convertGrokbuildJson(summaryJson({ generated_title: undefined }), oneTurn)
  assert.equal(summaryOnly.title, '这是一段会话摘要。')
  assert.ok(summaryOnly.events.some((e) => e.type === 'session/title'))
  // 都没有 → 首问兜底（只回填 out.title，不钉事件）
  const bare = convertGrokbuildJson(summaryJson({ generated_title: undefined, session_summary: undefined }), oneTurn)
  assert.equal(bare.title, '首问')
  assert.ok(!bare.events.some((e) => e.type === 'session/title'))
  // 显式标题超 80 字符 → 79 + …（REQ-27 统一规则）
  const long = convertGrokbuildJson(summaryJson({ generated_title: '长'.repeat(90) }), oneTurn)
  assert.equal(long.title, '长'.repeat(79) + '…')
})

test('convertGrokbuildJson: 中断的 tool_use 补发空 tool/result（配对不变量）', () => {
  const out = convertGrokbuildJson(summaryJson(), chatLines([
    { type: 'user', content: '跑一下测试' },
    { type: 'assistant', content: [{ type: 'tool_use', id: 'toolu_04', name: 'Bash', input: { command: 'npm test' } }] },
  ]))
  assert.equal(out.toolCalls, 1)
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.ok(result)
  assert.deepEqual(result.data.message.content[0].content, []) // 空 content，不虚构文本
  assert.equal(result.data.message.content[0].toolCallId, 'toolu_04')
  assertToolPairing(out.events)
  // 回合平衡：最后一个非 title 事件是 turn/end（显式标题钉在末尾）
  const types = out.events.map((e) => e.type)
  assert.equal([...types].reverse().find((t) => t !== 'session/title'), 'turn/end')
  assertMessageOrderLegal(out.events)
})

test('convertGrokbuildJson: tool_result is_error → isError 标记', () => {
  const out = convertGrokbuildJson(summaryJson(), chatLines([
    { type: 'user', content: '跑一下' },
    { type: 'assistant', content: [{ type: 'tool_use', id: 'toolu_err', name: 'Bash', input: { command: 'x' } }] },
    { type: 'tool', content: [{ type: 'tool_result', tool_use_id: 'toolu_err', content: [{ type: 'text', text: 'boom' }], is_error: true }] },
  ]))
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.equal(result.data.message.content[0].isError, true)
  assert.equal(result.data.message.content[0].content[0].text, 'boom')
})

test('convertGrokbuildJson: 无对应 tool_use 的孤儿 tool_result 丢弃并计数', () => {
  const out = convertGrokbuildJson(summaryJson(), chatLines([
    { type: 'user', content: '继续' },
    { type: 'assistant', content: '好的' },
    { type: 'tool', content: [{ type: 'tool_result', tool_use_id: 'toolu_ghost', content: [{ type: 'text', text: '幽灵结果' }] }] },
  ]))
  assert.equal(out.droppedToolResults, 1)
  assert.equal(out.events.filter((e) => e.type === 'tool/result').length, 0)
  assertMessageOrderLegal(out.events)
})

test('convertGrokbuildJson: 多轮切分、畸形行计数', () => {
  const out = convertGrokbuildJson(summaryJson(), 'not json\n' + chatLines([
    { type: 'user', content: '第一个问题' },
    { type: 'assistant', content: '第一个回答' },
    { type: 'user', content: '第二个问题' },
    { type: 'assistant', content: '第二个回答' },
  ]))
  assert.equal(out.skipped, 1) // 畸形行只计 skipped
  assert.equal(out.records, 4) // records = 成功解析的行数
  assert.equal(out.turns.length, 2)
  const starts = out.events.filter((e) => e.type === 'turn/start')
  assert.equal(starts.length, 2)
  const users = out.events.filter((e) => e.type === 'user/message' && e.data.source.kind === 'user').map((e) => e.data.content[0].text)
  assert.deepEqual(users, ['第一个问题', '第二个问题'])
})

test('convertGrokbuildJson: 后置 tool 记录挂回 call 所属 step（不落最近一步）', () => {
  // 异步工具：调用在 step1，结果随后续 assistant（step2）之后到达。tool/result 必须
  // 挂回 call 所属 step（step1），否则投影顺序里带 tool_calls 的 assistant 后面紧跟
  // 另一条 assistant，违反 wire 规则。
  const out = convertGrokbuildJson(summaryJson(), chatLines([
    { type: 'user', content: '请查一下' },
    { type: 'assistant', content: [{ type: 'text', text: '好' }, { type: 'tool_use', id: 'toolu_05', name: 'Read', input: { file: 'a.txt' } }] },
    { type: 'assistant', content: [{ type: 'text', text: '继续' }] },
    { type: 'tool', content: [{ type: 'tool_result', tool_use_id: 'toolu_05', content: [{ type: 'text', text: '结果' }] }] },
  ]))
  const call = out.events.find((e) => e.type === 'tool/call')
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.equal(call.data.step, 1)
  assert.equal(result.data.step, 1)
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  const msgs = assertMessageOrderLegal(out.events)
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'user', 'assistant', 'tool', 'assistant'])
})

test('convertGrokbuildJson: 纯文本 tool 记录（无 id）→ 唯一未覆盖调用兜底；多候选丢弃', () => {
  // 顺序调用：唯一未覆盖 → 兜底配对
  const seq = convertGrokbuildJson(summaryJson(), chatLines([
    { type: 'user', content: '跑一下' },
    { type: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'a' } }] },
    { type: 'tool', content: 'A 输出' },
  ]))
  assert.equal(seq.toolCalls, 1)
  assert.equal(seq.droppedToolResults, 0)
  assert.equal(seq.events.find((e) => e.type === 'tool/result').data.message.content[0].content[0].text, 'A 输出')
  assertToolPairing(seq.events)
  // 并行多调用：归属歧义 → 丢弃计数（不冒险错配）；缺真实结果的 call 由兜底补空
  const par = convertGrokbuildJson(summaryJson(), chatLines([
    { type: 'user', content: '并行跑' },
    { type: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_p1', name: 'Bash', input: {} },
      { type: 'tool_use', id: 'toolu_p2', name: 'Bash', input: {} },
    ] },
    { type: 'tool', content: '谁的输出？' },
  ]))
  assert.equal(par.toolCalls, 2)
  assert.equal(par.droppedToolResults, 1)
  assertToolPairing(par.events)
  assertMessageOrderLegal(par.events)
})

test('convertGrokbuildJson: 无前序 user 的 assistant 记录忽略（转录中途开始）', () => {
  const out = convertGrokbuildJson(summaryJson(), chatLines([
    { type: 'assistant', content: '没有用户提问的回复' },
    { type: 'user', content: '现在开始' },
    { type: 'assistant', content: '好的' },
  ]))
  assert.equal(out.turns.length, 1)
  const users = out.events.filter((e) => e.type === 'user/message' && e.data.source.kind === 'user')
  assert.equal(users.length, 1)
  assert.equal(users[0].data.content[0].text, '现在开始')
})

test('convertGrokbuildJson: sessionId 覆盖与 budget 裁剪透传（REQ-37）', () => {
  const lines = []
  for (let i = 1; i <= 60; i++) {
    lines.push({ type: 'user', content: '问题' + '字'.repeat(49) + i })
    lines.push({ type: 'assistant', content: '回答' + '字'.repeat(49) + i })
  }
  const chat = chatLines(lines)
  const out = convertGrokbuildJson(summaryJson(), chat, { sessionId: 'custom-grok', budget: 1000 })
  assert.equal(out.meta.id, 'custom-grok')
  // sourceId 显式取自 summary，不因 DSH 会话 id 覆盖/前缀解析而改变（REQ-32）
  assert.equal(out.meta.sourceId, 'grok-sess-001')
  assert.ok(out.trimmed)
  assert.ok(out.trimmed.droppedTurns > 0)
  assert.ok(out.trimmed.estimatedTokens <= 1000)
  assert.equal(out.trimmed.budget, 1000)
  // 裁剪后事件仍平衡（配对 + 投影顺序合法）
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
  // 无 budget → 原样、无裁剪上报
  const plain = convertGrokbuildJson(summaryJson(), chat)
  assert.equal(plain.trimmed, undefined)
  assert.ok(plain.turns.length > out.turns.length)
})

test('convertGrokbuildJson: 空 chat_history 不产生事件（meta 仍来自 summary）', () => {
  const out = convertGrokbuildJson(summaryJson(), '')
  assert.equal(out.turns.length, 0)
  assert.equal(out.events.length, 0)
  assert.equal(out.records, 0)
  assert.equal(out.meta.id, 'import-grok-sess-001')
})

test('convertGrokbuildJson: createdAt 回退链 created_at → updated_at → last_active_at', () => {
  const noCreated = convertGrokbuildJson(summaryJson({ created_at: undefined }), '')
  assert.equal(noCreated.meta.createdAt, Date.parse('2026-07-16T12:05:00Z'))
  const noTimes = convertGrokbuildJson(summaryJson({ created_at: undefined, updated_at: undefined, last_active_at: undefined }), '')
  assert.equal(typeof noTimes.meta.createdAt, 'number') // 全部缺失 → 导入时刻
})

test('convertGrokbuildJson: 畸形 summary.json 返回 skipReason（失败要大声）', () => {
  const out = convertGrokbuildJson('not json', '{"type":"user","content":"hi"}')
  assert.equal(out.meta, null)
  assert.deepEqual(out.events, [])
  assert.deepEqual(out.turns, [])
  assert.equal(out.messages, 0)
  assert.equal(out.toolCalls, 0)
  assert.ok(out.skipReason.includes('malformed summary'))
})
// ── 真实 chat_format_version:1 行契约（顶层 tool_calls / summary 明文 / synthetic_reason）──

test('convertGrokbuildJson: 顶层 tool_calls 多调用 → 多 tool/call；tool_result 行按 tool_call_id 归位（跨 step 晚到）', () => {
  const out = convertGrokbuildJson(summaryJson(), chatLines([
    { type: 'user', content: [{ type: 'text', text: '并行读两个文件' }] },
    { type: 'assistant', content: '先读 a 和 c', model_id: 'grok-4.6', tool_calls: [
      { id: 'call-a', name: 'read_file', arguments: '{"target_file":"a.txt"}' },
      { id: 'call-c', name: 'grep', arguments: '{"pattern":"x"}' },
    ] },
    { type: 'assistant', content: '再读 b', tool_calls: [
      { id: 'call-b', name: 'read_file', arguments: '{"target_file":"b.txt"}' },
    ] },
    { type: 'tool_result', tool_call_id: 'call-b', content: 'B 内容' }, // 跨 step 晚到：挂回 step2
    { type: 'tool_result', tool_call_id: 'call-a', content: 'A 内容' }, // 跨 step 晚到：挂回 step1
    { type: 'tool_result', tool_call_id: 'call-c', content: '' },
  ]))
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 3)
  assert.equal(out.droppedToolResults, 0)
  const calls = out.events.filter((e) => e.type === 'tool/call')
  assert.deepEqual(calls.map((c) => [c.data.name, c.data.arguments]), [
    ['read_file', '{"target_file":"a.txt"}'],
    ['grep', '{"pattern":"x"}'],
    ['read_file', '{"target_file":"b.txt"}'],
  ])
  const resultOf = (id) => out.events.find((e) => e.type === 'tool/result' && e.data.message.content[0].toolCallId === id)
  assert.equal(resultOf('call-a').data.step, 1)
  assert.equal(resultOf('call-c').data.step, 1)
  assert.equal(resultOf('call-b').data.step, 2)
  // tool-call 块同时进 assistant content（wire 适配器只从 content 块派生 tool_calls）
  const asst = out.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message)
  assert.deepEqual(asst[0].content.map((c) => c.type), ['text', 'tool-call', 'tool-call'])
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
})

test('convertGrokbuildJson: reasoning summary[] 明文前置到下一个 assistant 步骤；末尾残余补收尾步骤', () => {
  const out = convertGrokbuildJson(summaryJson(), chatLines([
    { type: 'user', content: [{ type: 'text', text: '第一步' }] },
    { type: 'reasoning', id: 'rs1', status: 'completed', summary: [{ type: 'summary_text', text: '先想' }], encrypted_content: 'CIPHERTEXT-ONE' },
    { type: 'assistant', content: '做第一步', tool_calls: [{ id: 'call-x', name: 'run', arguments: '{}' }] },
    { type: 'tool_result', tool_call_id: 'call-x', content: 'ok' },
    { type: 'reasoning', id: 'rs2', status: 'completed', summary: [{ type: 'summary_text', text: '断了' }], encrypted_content: 'CIPHERTEXT-TWO' },
  ]))
  assert.equal(out.filtered, 0) // reasoning 不再计 filtered
  assert.equal(out.events.filter((e) => e.type === 'assistant/message').length, 1) // 不虚增步骤
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.content.map((c) => c.type), ['reasoning', 'text', 'tool-call', 'reasoning'])
  assert.equal(asst.content[0].text, '先想')
  assert.equal(asst.content[3].text, '断了') // 末尾残余落到最后一步（codex pendingReasoning 同款）
  assert.ok(!JSON.stringify(out.events).includes('CIPHERTEXT'), 'encrypted_content 是密文，永不落日志')

  // 该轮还没有任何步骤时，残余 reasoning 补一个收尾步骤承载
  const solo = convertGrokbuildJson(summaryJson(), chatLines([
    { type: 'user', content: [{ type: 'text', text: '只想没答' }] },
    { type: 'reasoning', id: 'rs3', status: 'completed', summary: [{ type: 'summary_text', text: '只有思考' }] },
  ]))
  const soloAsst = solo.events.find((e) => e.type === 'assistant/message')
  assert.deepEqual(soloAsst.data.message.content, [{ type: 'reasoning', text: '只有思考' }])
  assert.equal(solo.events.filter((e) => e.type === 'turn/start').length, 1)
})

test('convertGrokbuildJson: synthetic_reason 非空且 ≠human 不开轮计 filtered；<user_info> 无 synthetic_reason 也注入', () => {
  const out = convertGrokbuildJson(summaryJson({ generated_title: undefined, session_summary: undefined }), chatLines([
    { type: 'user', content: [{ type: 'text', text: '<system-reminder>\nskills' }], synthetic_reason: 'system_reminder' },
    { type: 'user', content: [{ type: 'text', text: '<user_info>\nOS: windows' }], synthetic_reason: 'compaction_meta' }, // 压缩后重注入环境块
    { type: 'user', content: [{ type: 'text', text: '<user_info>\nOS: windows' }] }, // 无 synthetic_reason 的环境块
    { type: 'user', content: [{ type: 'text', text: '真实提问' }] },
    { type: 'assistant', content: '回答' },
  ]))
  assert.equal(out.turns.length, 1)
  assert.equal(out.filtered, 3)
  assert.equal(out.title, '真实提问')
  const users = out.events.filter((e) => e.type === 'user/message' && e.data.source.kind === 'user').map((e) => e.data.content[0].text)
  assert.deepEqual(users, ['真实提问'])
})

test('convertGrokbuildJson: compaction_meta 交接摘要 → 原生压缩检查点（前序轮 shadowed、provider=grok-build）', () => {
  const out = convertGrokbuildJson(summaryJson({ current_model_id: 'grok-4.6' }), chatLines([
    { type: 'user', content: [{ type: 'text', text: '第一问' }] },
    { type: 'assistant', content: '第一答' },
    { type: 'user', content: [{ type: 'text', text: 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.' }], synthetic_reason: 'compaction_meta' },
    { type: 'user', content: [{ type: 'text', text: '第二问' }] },
    { type: 'assistant', content: '第二答', model_id: 'grok-4.6' },
  ]))
  assert.equal(out.turns.length, 2)
  assert.equal(out.compacted, true)
  assert.equal(out.turns[0].shadowed, true) // 边界前的轮是 log-only
  assert.equal(out.turns[1].shadowed, undefined)
  const summary = out.events.find((e) => e.type === 'compaction/summary')
  assert.ok(summary, '发射 compaction/summary')
  assert.equal(summary.data.provider, 'grok-build')
  assert.equal(summary.data.model, 'grok-4.6') // summary.current_model_id 兜底
  assert.match(summary.data.summary[0].text, /^This session is being continued/)
  const ck = out.events.find((e) => e.type === 'user/message' && e.data.source.kind === 'plugin' && e.data.source.plugin === 'compact')
  assert.equal(ck.surfaceOp.op, 'replace')
  assert.ok(Array.isArray(ck.sourceEventSeqs) && ck.sourceEventSeqs.length > 0)
  // 边界轮的空 prompt 不再补发 user/message；两轮提问各一条
  const users = out.events.filter((e) => e.type === 'user/message' && e.data.source.kind === 'user').map((e) => e.data.content[0].text)
  assert.deepEqual(users, ['第一问', '第二问'])
  assert.equal(out.filtered, 0)
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
})

test('convertGrokbuildJson: fullHistory 下压缩摘要行按普通 user 轮导入（不发检查点）', () => {
  const raw = chatLines([
    { type: 'user', content: [{ type: 'text', text: '第一问' }] },
    { type: 'assistant', content: '第一答' },
    { type: 'user', content: [{ type: 'text', text: 'This session is being continued from a previous conversation that ran out of context.' }], synthetic_reason: 'compaction_meta' },
    { type: 'assistant', content: '第二答' },
  ])
  const out = convertGrokbuildJson(summaryJson(), raw, { fullHistory: true })
  assert.equal(out.compacted, undefined)
  assert.ok(!out.events.some((e) => e.type === 'compaction/start'))
  assert.ok(!out.turns.some((t) => t.shadowed === true))
  assert.equal(out.turns.length, 2)
  const users = out.events.filter((e) => e.type === 'user/message' && e.data.source.kind === 'user').map((e) => e.data.content[0].text)
  assert.equal(users.length, 2)
  assert.match(users[1], /^This session is being continued/)
})

test('convertGrokbuildJson: <user_query> 三种包装（裸包装 / 中断 / 插话）剥出真实提问', () => {
  const out = convertGrokbuildJson(summaryJson({ generated_title: undefined, session_summary: undefined }), chatLines([
    { type: 'user', content: [{ type: 'text', text: '<user_query>\n第一问\n</user_query>' }] },
    { type: 'assistant', content: '答一' },
    { type: 'user', content: [{ type: 'text', text: 'The user interrupted the previous turn:\n<user_query>\n第二问\n</user_query>\nMake sure to complete any unfinished tasks from previous turns.' }], prior_turn_interrupt: 'mid_turn_abort' },
    { type: 'assistant', content: '答二' },
    { type: 'user', content: [{ type: 'text', text: 'The user sent a message while you were working:\n<user_query>\n第三问\n</user_query>' }] },
    { type: 'assistant', content: '答三' },
  ]))
  const users = out.events.filter((e) => e.type === 'user/message' && e.data.source.kind === 'user').map((e) => e.data.content[0].text)
  assert.deepEqual(users, ['第一问', '第二问', '第三问'])
  assert.equal(out.turns.length, 3)
  // mid_turn_abort 把上一轮标 aborted（合成层映射为 turn/end 的 aborted）
  const ends = out.events.filter((e) => e.type === 'turn/end')
  assert.deepEqual(ends.map((e) => e.data.reason.kind), ['aborted', 'completed', 'completed'])
})

test('convertGrokbuildJson: tool_result images → IR image 块（无字节才占位 + imagesDegraded）', () => {
  const out = convertGrokbuildJson(summaryJson(), chatLines([
    { type: 'user', content: [{ type: 'text', text: '看图' }] },
    { type: 'assistant', content: '', tool_calls: [{ id: 'call-img', name: 'read_file', arguments: '{"target_file":"x.png"}' }] },
    { type: 'tool_result', tool_call_id: 'call-img', content: 'Read image file: x.png', images: [
      { type: 'image', url: 'data:image/png;base64,QUJD' },
      { type: 'image', url: 'data:image/png;base64,REVG' },
    ] },
  ]))
  const result = out.events.find((e) => e.type === 'tool/result')
  const content = result.data.message.content[0].content
  assert.equal(content[0].text, 'Read image file: x.png')
  assert.deepEqual(content.slice(1), [
    { type: 'image', data: 'QUJD', mediaType: 'image/png' },
    { type: 'image', data: 'REVG', mediaType: 'image/png' },
  ])
  assert.equal(out.imagesDegraded, undefined, '两张图都有字节：没有降级')
  // 空 content + 有图：也不静默丢图
  const onlyImages = convertGrokbuildJson(summaryJson(), chatLines([
    { type: 'user', content: [{ type: 'text', text: '再看' }] },
    { type: 'assistant', content: '', tool_calls: [{ id: 'call-img2', name: 'read_file', arguments: '{}' }] },
    { type: 'tool_result', tool_call_id: 'call-img2', content: '', images: [{ type: 'image', url: 'data:image/png;base64,QUJD' }] },
  ]))
  assert.deepEqual(onlyImages.events.find((e) => e.type === 'tool/result').data.message.content[0].content,
    [{ type: 'image', data: 'QUJD', mediaType: 'image/png' }])
  // 拿不到字节（http URL）：占位 + 计数
  const noBytes = convertGrokbuildJson(summaryJson(), chatLines([
    { type: 'user', content: [{ type: 'text', text: '远程' }] },
    { type: 'assistant', content: '', tool_calls: [{ id: 'call-img3', name: 'read_file', arguments: '{}' }] },
    { type: 'tool_result', tool_call_id: 'call-img3', content: '', images: [{ type: 'image', url: 'https://example.com/a.png' }] },
  ]))
  assert.deepEqual(noBytes.events.find((e) => e.type === 'tool/result').data.message.content[0].content, [{ type: 'text', text: '[image]' }])
  assert.equal(noBytes.imagesDegraded, 1)
  // 孤儿结果的图随结果一起丢弃，只计 droppedToolResults
  const orphan = convertGrokbuildJson(summaryJson(), chatLines([
    { type: 'user', content: [{ type: 'text', text: '问' }] },
    { type: 'tool_result', tool_call_id: 'ghost', content: 'x', images: [{ type: 'image', url: 'data:image/png;base64,QUJD' }] },
  ]))
  assert.equal(orphan.imagesDegraded, undefined)
  assert.equal(orphan.droppedToolResults, 1)
})

test('convertGrokbuildJson: backend_tool_call 只计数（不映射成 tool/call 破坏配对不变量）', () => {
  const out = convertGrokbuildJson(summaryJson(), chatLines([
    { type: 'user', content: [{ type: 'text', text: '搜一下' }] },
    { type: 'assistant', content: '搜', tool_calls: [{ id: 'call-s', name: 'web_search', arguments: '{"query":"x"}' }] },
    { type: 'tool_result', tool_call_id: 'call-s', content: '结果' },
    { type: 'backend_tool_call', kind: { tool_type: 'web_search', action: { type: 'search', query: 'x' } } },
  ]))
  assert.equal(out.backendToolCalls, 1)
  assert.equal(out.toolCalls, 1)
  assert.equal(out.filtered, 0) // 后端工具不是「被过滤的记录」
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
})

test('convertGrokbuildJson: model_id → step.model；无 model_id 用 summary.current_model_id 兜底', () => {
  const out = convertGrokbuildJson(summaryJson({ current_model_id: 'grok-4.5', generated_title: undefined, session_summary: undefined }), chatLines([
    { type: 'user', content: [{ type: 'text', text: '问' }] },
    { type: 'assistant', content: '答一', model_id: 'grok-4.6' },
    { type: 'user', content: [{ type: 'text', text: '再问' }] },
    { type: 'assistant', content: '答二' },
  ]))
  const models = out.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message.source.model)
  assert.deepEqual(models, ['grok-4.6', 'grok-4.5'])
  // 两者都没有 → provider 名兜底（既有口径）
  const bare = convertGrokbuildJson(summaryJson({ generated_title: undefined, session_summary: undefined }), chatLines([
    { type: 'user', content: [{ type: 'text', text: '问' }] },
    { type: 'assistant', content: '答' },
  ]))
  assert.equal(bare.events.find((e) => e.type === 'assistant/message').data.message.source.model, 'grokbuild')
})

test('convertGrokbuildJson: v0 行（无 type 有 role）走同一管线', () => {
  const out = convertGrokbuildJson(summaryJson({ generated_title: undefined, session_summary: undefined }), chatLines([
    { role: 'user', content: [{ type: 'text', text: 'v0 提问' }] },
    { role: 'reasoning', summary: [{ type: 'summary_text', text: 'v0 思考' }] },
    { role: 'assistant', content: 'v0 回答', tool_calls: [{ id: 'call-v0', name: 'run', arguments: '{"a":1}' }] },
    { role: 'tool_result', tool_call_id: 'call-v0', content: 'v0 结果' },
  ]))
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  assert.equal(out.title, 'v0 提问')
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.content.map((c) => c.type), ['reasoning', 'text', 'tool-call'])
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
})

test('convertGrokbuildJson: 未知 type 计入 filtered（schema 漂移不静默吞）', () => {
  const out = convertGrokbuildJson(summaryJson(), chatLines([
    { type: 'user', content: [{ type: 'text', text: '问' }] },
    { type: 'some_future_record', payload: {} },
    { type: 'assistant', content: '答' },
  ]))
  assert.equal(out.filtered, 1)
  assert.equal(out.records, 3)
})
test('convertGrokbuildJson: 压缩边界落在轮中间（摘要后直接是 assistant）→ 空 prompt 轮承载检查点', () => {
  const out = convertGrokbuildJson(summaryJson(), chatLines([
    { type: 'user', content: [{ type: 'text', text: '第一问' }] },
    { type: 'assistant', content: '第一答' },
    { type: 'user', content: [{ type: 'text', text: 'This session is being continued from a previous conversation that ran out of context.' }], synthetic_reason: 'compaction_meta' },
    { type: 'assistant', content: '边界后的半轮产物', tool_calls: [{ id: 'call-mid', name: 'run', arguments: '{}' }] },
    { type: 'tool_result', tool_call_id: 'call-mid', content: 'mid ok' },
    { type: 'user', content: [{ type: 'text', text: '第二问' }] },
    { type: 'assistant', content: '第二答' },
  ]))
  assert.equal(out.turns.length, 3)
  assert.equal(out.turns[1].prompt, '') // 承载轮：空 prompt，检查点即该轮 user 侧消息
  assert.ok(out.turns[1].compaction)
  assert.equal(out.toolCalls, 1) // 边界后的产物不丢
  assert.equal(out.droppedToolResults, 0)
  const users = out.events.filter((e) => e.type === 'user/message' && e.data.source.kind === 'user').map((e) => e.data.content[0].text)
  assert.deepEqual(users, ['第一问', '第二问']) // 承载轮不补发 user/message
  assert.ok(out.events.some((e) => e.type === 'assistant/message' && e.data.message.content.some((c) => c.text === '边界后的半轮产物')))
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
})


