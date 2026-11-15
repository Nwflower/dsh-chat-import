// verify-tool-call-order.test.mjs — verify_session 的块序检查（text-after-tool-call）
//
// 事件级配对（call↔result、step 坐标、广告）全部成立的会话仍可能投影失败：assistant/message
// 的内容块里 tool-call 之后还跟着 text / reasoning 时，宿主按块序把这些块摊成 provider 消息，
// 正文会夹在 tool_use 与紧随其后的 tool_result 之间，用户在该会话发第一条新消息即被接口以
// 400 INVALID_REQUEST 拒收。这里用合成日志锁定此类形状能被点名、正常块序不误报、多处时计数
// 与首个定位 seq 正确（假宿主见 test/_support/fake-host.mjs）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifySession } from '../lib/verify.mjs'
import { makeCtx } from './_support/fake-host.mjs'

const MS = 1700000000000
const SESSION_ID = 's'

// protected head：surface 的第一个事件（宿主 v3→v4 的硬不变量）。
const headEvent = (seq) => ({
  type: 'system/message', seq, time: MS, surfaceOp: 'append',
  data: { turn: 1, step: 1, message: { id: 'sys' + seq, role: 'system', content: [], source: { kind: 'plugin', plugin: 'chat-import' } } },
})

const assistantEvent = (seq, index, content) => ({
  type: 'assistant/message', seq, time: MS, surfaceOp: 'append',
  data: { turn: 1, step: 1, stream: [], message: { id: 'a' + index, role: 'assistant', content, source: { kind: 'model', provider: 'p', model: 'm' } } },
})

// 一条最小合法日志：head → 若干 assistant/message（块序由用例给）→ 每个被广告的 tool-call
// 配一条同 step 的 tool/result → 闭合。事件级检查全部通过，problems 里只会剩下用例关心的
// 那种投影期形状。
function logOf(messageContents) {
  const events = [
    { type: 'turn/start', seq: 0, time: MS, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: MS, data: { turn: 1, step: 1 } },
    headEvent(2),
  ]
  const calls = []
  let seq = 3
  messageContents.forEach((content, index) => {
    events.push(assistantEvent(seq++, index, content))
    for (const block of content) {
      if (!block || block.type !== 'tool-call') continue
      const callSeq = seq++
      calls.push({ id: block.id, seq: callSeq })
      events.push({ type: 'tool/call', seq: callSeq, time: MS, data: { turn: 1, step: 1, callId: block.id, name: block.name, arguments: block.arguments } })
    }
  })
  for (const call of calls) {
    events.push({
      type: 'tool/result', seq: seq++, time: MS, surfaceOp: 'append', sourceEventSeqs: [call.seq],
      data: { turn: 1, step: 1, message: { id: 't' + call.id, role: 'user', content: [{ type: 'tool-result', toolCallId: call.id, content: [] }], source: { kind: 'tool', callId: call.id } } },
    })
  }
  events.push({ type: 'step/end', seq: seq++, time: MS, data: { turn: 1, step: 1 } })
  events.push({ type: 'turn/end', seq: seq++, time: MS, data: { turn: 1, reason: { kind: 'completed' } } })
  return events
}

const call = (id) => ({ type: 'tool-call', id, name: 'Bash', arguments: '{}' })
const text = (s) => ({ type: 'text', text: s })

async function verify(events) {
  const { ctx, persistence } = makeCtx()
  persistence.sessions.set(SESSION_ID, { meta: { id: SESSION_ID, version: 3, createdAt: MS }, events })
  return verifySession(ctx, { sessionId: SESSION_ID })
}

test('verify: tool-call 之后跟 text → text-after-tool-call + force 重导提示', async () => {
  const out = await verify(logOf([[call('c1'), text('先跑一下再解释')]]))
  // 事件级配对全对：这条形状只有新检查抓得到，旧检查一条都不报
  assert.deepEqual(out.problems.map((p) => p.kind), ['text-after-tool-call'])
  assert.equal(out.ok, false)
  const problem = out.problems[0]
  assert.match(problem.message, /1 条/)
  assert.match(problem.message, /400/)
  const hint = out.repairHints.find((h) => h.kind === 'text-after-tool-call')
  assert.ok(hint, '给出修复提示')
  assert.match(hint.hint, /force:true/)
  assert.match(hint.hint, /400 INVALID_REQUEST/)
})

test('verify: tool-call 之后跟 reasoning 同样算一处', async () => {
  const out = await verify(logOf([[call('c1'), { type: 'reasoning', text: '想想下一步' }]]))
  assert.deepEqual(out.problems.map((p) => p.kind), ['text-after-tool-call'])
})

test('verify: text 在 tool-call 之前（正常块序）不报', async () => {
  const out = await verify(logOf([[text('先说明一下，再调用工具'), call('c1')]]))
  assert.equal(out.problems.some((p) => p.kind === 'text-after-tool-call'), false)
  assert.equal(out.ok, true)
})

test('verify: 整条消息没有 tool-call 不报', async () => {
  const out = await verify(logOf([[text('纯正文'), { type: 'reasoning', text: '纯推理' }]]))
  assert.equal(out.problems.some((p) => p.kind === 'text-after-tool-call'), false)
  assert.equal(out.ok, true)
})

test('verify: 同一会话多处 → 次数正确、seq 指向首个', async () => {
  const out = await verify(logOf([
    [text('正文在前的正常块序'), call('c1')],
    [call('c2'), text('第一处越界正文')],
    [call('c3'), { type: 'reasoning', text: '第二处越界推理' }],
  ]))
  const problem = out.problems.find((p) => p.kind === 'text-after-tool-call')
  assert.ok(problem, '报到该 kind')
  assert.match(problem.message, /2 条/)
  // 首个越界的是第 2 条 assistant/message：head 占 seq 2，第 1 条消息 seq 3 与它的 tool/call
  // seq 4 之后，第 2 条消息落在 seq 5
  assert.equal(problem.seq, 5)
})
