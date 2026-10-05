// verify-migration.test.mjs — verify_session 的 V4 迁移风险检查
//
// dsh v3→v4 迁移器对工具生命周期 fail-closed（relationships.ts）：tool/call 必须有
// assistant/message 内容块广告（"has no advertised tool lifecycle"）、结果必须闭合在
// 调用的 step 内（step/end 清空未闭合调用，"leaves unresolved tool call"）、每个调用
// 恰好一条结果（第二条结果同样 "no advertised tool lifecycle"）。这里用合成日志逐条
// 锁定 verify_session 能提前报出这三类会被迁移拒载的形状，并确认干净日志不误报。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifySession } from '../lib/verify.mjs'

const MS = 1700000000000
// 测试数据都是 JSON 安全值，深拷贝用 JSON 往返即可（structuredClone 触发 eslint
// no-undef：本仓库 eslint 配置的运行时全局表未含它）
const clone = (x) => JSON.parse(JSON.stringify(x))

// 干净的 V3 形状最小日志：广告 → tool/call → 同 step 内 tool/result → 闭合。
function baseLog() {
  return [
    { type: 'turn/start', seq: 0, time: MS, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: MS, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 2, time: MS, surfaceOp: 'append', data: { turn: 1, step: 1, stream: [], message: { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'Bash', arguments: '{}' }], source: { kind: 'model', provider: 'p', model: 'm' } } } },
    { type: 'tool/call', seq: 3, time: MS, data: { turn: 1, step: 1, callId: 'c1', name: 'Bash', arguments: '{}' } },
    { type: 'tool/result', seq: 4, time: MS, surfaceOp: 'append', sourceEventSeqs: [3], data: { turn: 1, step: 1, message: { id: 't1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }], source: { kind: 'tool', callId: 'c1' } } } },
    { type: 'step/end', seq: 5, time: MS, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 6, time: MS, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

function ctxFor(events) {
  return {
    get: (s) => (s === 'sessionPersistence' ? {
      async list() { return [{ id: 's', version: 3, createdAt: MS }] },
      async readFrom() { return { meta: { id: 's' }, events } },
    } : undefined),
  }
}

const kindsOf = (out) => new Set(out.problems.map((p) => p.kind))
const hintKinds = (out) => new Set(out.repairHints.map((h) => h.kind))

test('verify: 干净日志不报迁移风险', async () => {
  const out = await verifySession(ctxFor(baseLog()), { sessionId: 's' })
  assert.equal(out.ok, true)
  const kinds = kindsOf(out)
  for (const k of ['unadvertised-tool-call', 'cross-step-result', 'duplicate-tool-result', 'orphan-tool-result', 'call-without-result']) {
    assert.equal(kinds.has(k), false, k + ' 不应误报')
  }
})

test('verify: tool/call 无 assistant/message 广告 → unadvertised-tool-call', async () => {
  const events = baseLog().map((ev) => {
    if (ev.type !== 'assistant/message') return ev
    // 广告块被剥掉（旧版导入器/异常源可能产出）：只剩文本块
    const next = clone(ev)
    next.data.message.content = [{ type: 'text', text: 'no blocks' }]
    return next
  })
  const out = await verifySession(ctxFor(events), { sessionId: 's' })
  assert.equal(kindsOf(out).has('unadvertised-tool-call'), true)
  assert.match(out.problems.find((p) => p.kind === 'unadvertised-tool-call').message, /1 个/)
  assert.equal(hintKinds(out).has('unadvertised-tool-call'), true)
  assert.match(out.repairHints.find((h) => h.kind === 'unadvertised-tool-call').hint, /force:true/)
})

test('verify: 结果闭合在调用所在 step 之外 → cross-step-result', async () => {
  const events = baseLog().map((ev) => {
    if (ev.type !== 'tool/result') return ev
    const next = clone(ev)
    next.data.turn = 1
    next.data.step = 2 // 调用在 step 1，结果记在 step 2（异步工具跨 step）
    return next
  })
  // 结果挂在第二个 step 里：补 step/end(1) + step/start(2) 让日志结构完整
  events.splice(5, 0,
    { type: 'step/end', seq: 5, time: MS, data: { turn: 1, step: 1 } },
    { type: 'step/start', seq: 6, time: MS, data: { turn: 1, step: 2 } },
  )
  events[7] = { ...events[7], seq: 7 } // 原 step/end 变成 step 2 的闭合
  for (let i = 8; i < events.length; i++) events[i] = { ...events[i], seq: i }
  const out = await verifySession(ctxFor(events), { sessionId: 's' })
  assert.equal(kindsOf(out).has('cross-step-result'), true)
  assert.equal(hintKinds(out).has('cross-step-result'), true)
  // 干净形态（结果与调用同 step）不报
  const clean = await verifySession(ctxFor(baseLog()), { sessionId: 's' })
  assert.equal(kindsOf(clean).has('cross-step-result'), false)
})

test('verify: 同一调用多条结果 → duplicate-tool-result', async () => {
  const events = baseLog()
  events.splice(5, 0, {
    type: 'tool/result', seq: 5, time: MS, surfaceOp: 'append', sourceEventSeqs: [3],
    data: { turn: 1, step: 1, message: { id: 't1b', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'again' }] }], source: { kind: 'tool', callId: 'c1' } } },
  })
  for (let i = 6; i < events.length; i++) events[i] = { ...events[i], seq: i }
  const out = await verifySession(ctxFor(events), { sessionId: 's' })
  assert.equal(kindsOf(out).has('duplicate-tool-result'), true)
  assert.match(out.problems.find((p) => p.kind === 'duplicate-tool-result').message, /1 个/)
  assert.equal(hintKinds(out).has('duplicate-tool-result'), true)
})

test('verify: 孤儿结果的提示升级为迁移风险（指向 force 重导）', async () => {
  const events = baseLog().map((ev) => {
    if (ev.type !== 'tool/result') return ev
    const next = clone(ev)
    next.data.message.content[0].toolCallId = 'ghost'
    next.data.message.source = { kind: 'tool', callId: 'ghost' }
    return next
  })
  const out = await verifySession(ctxFor(events), { sessionId: 's' })
  assert.equal(kindsOf(out).has('orphan-tool-result'), true)
  const hint = out.repairHints.find((h) => h.kind === 'orphan-tool-result')
  assert.ok(hint, '孤儿结果有修复提示')
  assert.match(hint.hint, /V4/)
  assert.match(hint.hint, /force:true/)
})

// ── 计数上报面：synthesizeSession 的丢弃计数经 attachConversionDetails 透传 ──

test('attachConversionDetails: 工具结果丢弃计数非零才附加', async () => {
  const { attachConversionDetails } = await import('../lib/import-core.mjs')
  const withCounts = attachConversionDetails({ orphanToolResults: 2, duplicateToolResults: 1 }, {})
  assert.equal(withCounts.orphanToolResults, 2)
  assert.equal(withCounts.duplicateToolResults, 1)
  const withoutCounts = attachConversionDetails({}, {})
  assert.equal('orphanToolResults' in withoutCounts, false)
  assert.equal('duplicateToolResults' in withoutCounts, false)
})

// ---- system head（宿主 v3→v4 迁移的另一条硬不变量）----
// surface 的第一个事件必须是 system/message（protected head）；否则宿主续聊写自己的
// system/message 时迁移器拒载整份日志，由它 seed 出来的续聊会话同样打不开。

const headEvent = (seq, turn = 1, step = 1) => ({
  type: 'system/message', seq, time: MS, surfaceOp: 'append',
  data: { turn, step, message: { id: 'sys' + seq, role: 'system', content: [], source: { kind: 'plugin', plugin: 'chat-import' } } },
})
const userEvent = (seq) => ({
  type: 'user/message', seq, time: MS, surfaceOp: 'append',
  data: { id: 'u' + seq, role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
})

test('verify: surface 先于 system/message 且无 protected head → system-head-missing', async () => {
  const events = [
    { type: 'turn/start', seq: 0, time: MS, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: MS, data: { turn: 1, step: 1 } },
    userEvent(2),
    headEvent(3),
  ]
  const out = await verifySession(ctxFor(events), { sessionId: 's' })
  assert.equal(kindsOf(out).has('system-head-missing'), true)
})

test('verify: head 在最前（导入会话的新形状）不报 system-head-missing', async () => {
  const events = [
    { type: 'turn/start', seq: 0, time: MS, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: MS, data: { turn: 1, step: 1 } },
    headEvent(2),
    userEvent(3),
  ]
  const out = await verifySession(ctxFor(events), { sessionId: 's' })
  assert.equal(kindsOf(out).has('system-head-missing'), false)
})

// ---- 存量旧形状：Codex Desktop 外部导入的展平工具信封（docs/architecture.md D18）----
// 0.24.0 之前的转换器把这类信封当正文导入，工具调用至今是散文；日志 append-only，
// verify_session 点名它并给出「force:true 重导」的修复路径（幂等闸会挡住普通重导）。

test('verify: 正文残留展平信封 → flattened-tool-envelope + force 重导提示', async () => {
  const events = baseLog().map((ev) => {
    if (ev.type !== 'assistant/message') return ev
    const next = clone(ev)
    next.data.message.content = [{ type: 'text', text: '先读设计稿。\n\n[external_agent_tool_call: Bash]\ncommand: ls\n[/external_agent_tool_call]' }]
    return next
  })
  const out = await verifySession(ctxFor(events), { sessionId: 's' })
  assert.equal(kindsOf(out).has('flattened-tool-envelope'), true)
  const hint = out.repairHints.find((h) => h.kind === 'flattened-tool-envelope')
  assert.ok(hint, '有修复提示')
  assert.match(hint.hint, /force:true/)
})

// ---- 存量旧形状：解释性 content 里的 tool-result 包装（issue #77，宿主 V4 退休语法）----

test('verify: assistant 正文残留 tool-result 包装 → retired-tool-result-wrapper + force 重导提示', async () => {
  const events = baseLog().map((ev) => {
    if (ev.type !== 'assistant/message') return ev
    const next = clone(ev)
    // 旧转换路径把结果块留在助手正文里（结果本身另有一条 tool/result 事件）
    next.data.message.content = [
      { type: 'tool-call', id: 'c1', name: 'Bash', arguments: '{}' },
      { type: 'tool-result', toolCallId: 'c1', content: [] },
    ]
    return next
  })
  const out = await verifySession(ctxFor(events), { sessionId: 's' })
  assert.equal(kindsOf(out).has('retired-tool-result-wrapper'), true)
  const hint = out.repairHints.find((h) => h.kind === 'retired-tool-result-wrapper')
  assert.ok(hint, '有修复提示')
  assert.match(hint.hint, /force:true/)
})

test('verify: 干净的 V3 形状（结果在 tool/result 事件的包装里）不误报', async () => {
  const out = await verifySession(ctxFor(baseLog()), { sessionId: 's' })
  assert.equal(kindsOf(out).has('retired-tool-result-wrapper'), false)
})

test('verify: 正文里只是引用该标记（非行首信封）不误报', async () => {
  const events = baseLog().map((ev) => {
    if (ev.type !== 'assistant/message') return ev
    const next = clone(ev)
    next.data.message.content = [{ type: 'text', text: '我们把 [external_agent_tool_call: Bash] 这种写法叫展平信封。' }]
    return next
  })
  const out = await verifySession(ctxFor(events), { sessionId: 's' })
  assert.equal(kindsOf(out).has('flattened-tool-envelope'), false)
})
