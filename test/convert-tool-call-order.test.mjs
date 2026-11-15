// convert-tool-call-order.test.mjs — assistant step 的 content 里 tool-call 必须收尾
// （工具的块序不变量：tool-call 之后不得再出现 text / reasoning / image 块）。
// 覆盖归一化函数本身，以及经 opencode 转换入口端到端走完 finishSession 漏斗后的块序。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toolCallsLast } from '../lib/convert/ir.mjs'
import { convertOpencodeJson } from '../lib/convert/index.mjs'
import { assertMessageOrderLegal } from './_support/session-invariants.mjs'

// 单轮单步的 IR 骨架（合成；只放本文件关心的字段）。
function stepOf(content, calls = []) {
  return { content, toolCalls: calls, toolResults: [] }
}

// opencode 中间 JSON 骨架：一条 user 消息开轮，一条 assistant 消息承载待测 parts。
function opencodeChat(parts, { extraMessages = [] } = {}) {
  return {
    id: 'ses_order',
    title: 'tool-call order',
    createdAt: 1786000000000,
    messages: [
      { id: 'm1', role: 'user', createdAt: 1786000001000, parts: [{ type: 'text', text: '改一下构建配置' }] },
      { id: 'm2', role: 'assistant', createdAt: 1786000002000, parts },
      ...extraMessages,
    ],
  }
}

test('convertOpencodeJson: patch part 在 tool part 之后 → 该 step 的 content 以 tool-call 收尾，注记文本保留', () => {
  const out = convertOpencodeJson(JSON.stringify(opencodeChat([
    { type: 'reasoning', text: '先跑一次构建' },
    { type: 'text', text: '构建失败，改配置' },
    { type: 'tool', callID: 'call_01', tool: 'bash', state: { status: 'completed', input: { command: 'npm run build' }, output: 'error' } },
    { type: 'patch', files: ['a.mjs', 'b.mjs'] },
  ])))

  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.equal(asst.content.at(-1).type, 'tool-call')
  assert.deepEqual(asst.content.map((c) => c.type), ['reasoning', 'text', 'text', 'tool-call'])
  const texts = asst.content.filter((c) => c.type === 'text').map((c) => c.text)
  assert.deepEqual(texts, ['构建失败，改配置', '[patch: 2 files]'])
  // 端到端：合成后的 provider 消息序仍然合法（tool-call 与 tool/result 相邻闭合）
  assertMessageOrderLegal(out.events)
  // IR 里的块序与事件里的一致（漏斗内改的就是 step.content 本身）
  assert.deepEqual(out.turns[0].steps[0].content, asst.content)
})

test('convertOpencodeJson: subtask part 在 tool part 之后 → content 以 tool-call 收尾，注记文本保留', () => {
  const out = convertOpencodeJson(JSON.stringify(opencodeChat([
    { type: 'text', text: '交给子任务跑测试' },
    { type: 'tool', callID: 'call_01', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'ok' } },
    { type: 'subtask', command: 'npm test', description: '跑测试' },
  ])))

  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.equal(asst.content.at(-1).type, 'tool-call')
  assert.deepEqual(asst.content.map((c) => c.type), ['text', 'text', 'tool-call'])
  assert.deepEqual(asst.content.filter((c) => c.type === 'text').map((c) => c.text),
    ['交给子任务跑测试', '[subtask: npm test — 跑测试]'])
  assertMessageOrderLegal(out.events)
})

test('toolCallsLast: 已收尾的 step 不被改动（幂等），返回 0', () => {
  const content = [
    { type: 'reasoning', text: 'r' },
    { type: 'text', text: 't' },
    { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
    { type: 'tool-call', id: 'c2', name: 'bash', arguments: '{}' },
  ]
  const snapshot = content.slice()
  const turns = [{ prompt: 'p', steps: [stepOf(content, [content[2], content[3]])] }]

  assert.equal(toolCallsLast(turns), 0)
  assert.equal(turns[0].steps[0].content, content)
  assert.deepEqual(turns[0].steps[0].content, snapshot)

  // 全部是 tool-call 块的 step 同样不动
  const allCalls = [{ type: 'tool-call', id: 'c3', name: 'bash', arguments: '{}' }]
  const turns2 = [{ prompt: 'p', steps: [stepOf(allCalls)] }]
  assert.equal(toolCallsLast(turns2), 0)
  assert.equal(turns2[0].steps[0].content, allCalls)
})

test('toolCallsLast: 没有 tool-call 块的 step 保持原序，返回 0', () => {
  const content = [
    { type: 'reasoning', text: 'r' },
    { type: 'text', text: 't' },
    { type: 'image', data: 'AAAA', mediaType: 'image/png' },
    { type: 'text', text: 't2' },
  ]
  const turns = [{ prompt: 'p', steps: [stepOf(content)] }]

  assert.equal(toolCallsLast(turns), 0)
  assert.equal(turns[0].steps[0].content, content)
  assert.deepEqual(turns[0].steps[0].content, [
    { type: 'reasoning', text: 'r' },
    { type: 'text', text: 't' },
    { type: 'image', data: 'AAAA', mediaType: 'image/png' },
    { type: 'text', text: 't2' },
  ])
})

test('toolCallsLast: 稳定分区，多个 tool-call 的相对顺序与 toolCalls/toolResults 不变', () => {
  const c1 = { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"p":"a"}' }
  const c2 = { type: 'tool-call', id: 'c2', name: 'read', arguments: '{"p":"b"}' }
  const r1 = { toolCallId: 'c1', content: [{ type: 'text', text: 'A' }] }
  const r2 = { toolCallId: 'c2', content: [{ type: 'text', text: 'B' }] }
  const step = {
    content: [
      { type: 'text', text: '并行读两个文件' },
      c1,
      { type: 'reasoning', text: '第一个读完了' },
      c2,
      { type: 'text', text: '都读完了' },
    ],
    toolCalls: [c1, c2],
    toolResults: [r1, r2],
  }
  const turns = [{ prompt: 'p', steps: [step] }]

  assert.equal(toolCallsLast(turns), 1)
  assert.deepEqual(step.content.map((b) => b.type), ['text', 'reasoning', 'text', 'tool-call', 'tool-call'])
  assert.equal(step.content[3], c1)
  assert.equal(step.content[4], c2)
  // 非 tool-call 块彼此相对顺序不变，块对象未被替换
  assert.deepEqual(step.content.slice(0, 3).map((b) => b.text), ['并行读两个文件', '第一个读完了', '都读完了'])
  // 调用与结果的容器原样（顺序、引用都不动）
  assert.deepEqual(step.toolCalls, [c1, c2])
  assert.deepEqual(step.toolResults, [r1, r2])

  // 多 step 时返回被调整过的 step 数
  const clean = stepOf([{ type: 'text', text: 'x' }])
  const turns2 = [{ prompt: 'p', steps: [stepOf([c1, { type: 'text', text: 'y' }]), clean] }]
  assert.equal(toolCallsLast(turns2), 1)
  assert.equal(turns2[0].steps[1], clean)
})
