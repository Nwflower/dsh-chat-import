// matrix.test.mjs — REQ-23 矩阵化互转纯函数单测：DSH → Codex rollout / DSH → Kimi
// wire 序列化 + 反向 convert 往返（四向矩阵的 DSH→Codex / DSH→Kimi 出边）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serializeCodexJsonl, verifyCodexJsonl, serializeKimiWire, verifyKimiWire } from '../lib/export/index.mjs'
import { convertCodexJsonl, convertKimiWire, validateSessionEvents } from '../lib/convert/index.mjs'

const T = 1786000000000

// 合成 DSH 事件（含工具调用，验证矩阵互转保真）。
function sampleEvents() {
  return [
    { type: 'turn/start', seq: 0, time: T, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: T, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '跑测试' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 2, time: T, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '好' }, { type: 'reasoning', text: '先想一下' }, { type: 'tool-call', id: 'c1', name: 'Bash', arguments: '{"command":"npm test"}' }], source: { kind: 'model', provider: 'dsh' } } }, surfaceOp: 'append' },
    { type: 'tool/call', seq: 3, time: T, data: { turn: 1, step: 1, callId: 'c1', name: 'Bash', arguments: '{"command":"npm test"}' } },
    { type: 'tool/result', seq: 4, time: T, data: { turn: 1, step: 1, message: { id: 't1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'all green' }] }], source: { kind: 'tool', callId: 'c1' } } }, surfaceOp: 'append' },
    { type: 'turn/end', seq: 5, time: T, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

const input = () => ({ meta: { version: 0, id: 'import-matrix', createdAt: T, cwd: 'D:\\demo\\proj' }, events: sampleEvents(), sessionUuid: 'import-matrix' })

test('DSH → Codex rollout → convertCodexJsonl 往返：消息/工具调用/结果完整、verify 通过', () => {
  const out = serializeCodexJsonl(input())
  assert.equal(verifyCodexJsonl(out.jsonl).ok, true)
  assert.equal(out.toolCalls, 1)
  assert.equal(out.toolResults, 1)
  const back = convertCodexJsonl(out.jsonl, { sourcePath: 'D:\\demo\\exports\\x.rollout.jsonl' })
  assert.equal(back.skipped, 0)
  assert.equal(back.turns.length, 1)
  assert.equal(back.messages, 3) // user + assistant + tool/result
  assert.equal(back.toolCalls, 1)
  const result = back.events.find((e) => e.type === 'tool/result')
  assert.ok(result)
  assert.equal(result.data.message.content[0].content[0].text, 'all green')
  assert.ok(validateSessionEvents(back.events).ok)
})

test('DSH → Kimi wire → convertKimiWire 往返：TurnBegin/StepBegin/TextPart/ToolCall/ToolResult 还原', () => {
  const out = serializeKimiWire(input())
  assert.equal(verifyKimiWire(out.jsonl).ok, true)
  assert.equal(out.toolCalls, 1)
  assert.equal(out.toolResults, 1)
  const back = convertKimiWire(out.jsonl, { sourcePath: 'D:\\demo\\exports\\x.wire.jsonl' })
  assert.equal(back.skipped, 0)
  assert.equal(back.turns.length, 1)
  assert.equal(back.messages, 3)
  assert.equal(back.toolCalls, 1)
  const call = back.events.find((e) => e.type === 'tool/call')
  assert.equal(call.data.name, 'Bash')
  assert.equal(call.data.arguments, '{"command":"npm test"}')
  const result = back.events.find((e) => e.type === 'tool/result')
  assert.equal(result.data.message.content[0].content[0].text, 'all green')
  assert.ok(validateSessionEvents(back.events).ok)
})

test('serializeKimiWire: reasoning → ThinkPart 往返为 reasoning 块', () => {
  const out = serializeKimiWire(input())
  const recs = out.jsonl.slice(0, -1).split('\n').map((l) => JSON.parse(l))
  const thinks = recs.filter((r) => r.message && r.message.type === 'ThinkPart')
  assert.equal(thinks.length, 1)
  assert.equal(thinks[0].message.payload.think, '先想一下')
  const back = convertKimiWire(out.jsonl, {})
  const asst = back.events.find((e) => e.type === 'assistant/message')
  assert.ok(asst.data.message.content.some((b) => b.type === 'reasoning' && b.text === '先想一下'))
})

test('verifyCodexJsonl / verifyKimiWire: 空文件与坏布局报错', () => {
  assert.equal(verifyCodexJsonl('').ok, false)
  assert.equal(verifyCodexJsonl('{"type":"x"}\n').ok, false)
  assert.equal(verifyKimiWire('').ok, false)
  assert.equal(verifyKimiWire('{"type":"metadata"}\n{"bad":1}\n').ok, false)
})

test('verifyCodexJsonl / verifyKimiWire: 坏行的报错不携带行内容（解析错误经净化）', () => {
  const bad = '{"a": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "x": password=hunter2hunter2}\n'
  for (const verify of [verifyCodexJsonl, verifyKimiWire]) {
    const out = verify(bad)
    assert.equal(out.ok, false)
    const text = out.errors.map((e) => e.error).join('|')
    assert.match(text, /JSON 解析失败/)
    assert.ok(!text.includes('password'), text)
  }
})
