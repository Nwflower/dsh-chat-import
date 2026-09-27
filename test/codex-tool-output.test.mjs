// codex-tool-output.test.mjs — Codex 工具输出形态映射契约单测（缺陷 2）。
// 夹具全合成，无真实 transcript。
//
// 锁定的契约（lib/convert/codex.mjs 的 function_call_output / custom_tool_call_output）：
// 本机实测 1045 个工具输出里 968 个（92.6%）是块数组 [{type:'input_text',text:…}]（偶含
// input_image）。此前整体 JSON.stringify 成转义串、可读性全无；现在逐块映射：
//   input_text / output_text → 文本（多块按 \n 拼接）
//   input_image / image_url / image → 每张 [image] 文本占位（base64 / data URL 永不进日志）
//   未知块类型 → 计数进 droppedMalformedOutputs（失败要大声）
// 字符串信封 {"output":…} 与直接字符串两种旧形态行为不变。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertCodexJsonl } from '../lib/convert/codex.mjs'

const T0 = '2026-09-25T01:00:00.000Z'
const metaLine = (id) => JSON.stringify({ timestamp: T0, type: 'session_meta', payload: { id, timestamp: T0, cwd: 'D:\\demo\\proj' } })
const turnLine = (model) => JSON.stringify({ timestamp: T0, type: 'turn_context', payload: { turn_id: 't', model } })
const userLine = (text) => JSON.stringify({ timestamp: T0, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
const callLine = (callId, name = 'shell') => JSON.stringify({
  timestamp: T0, type: 'response_item',
  payload: { type: 'function_call', call_id: callId, name, arguments: '{"command":"ls"}' },
})
const outLine = (callId, output) => JSON.stringify({
  timestamp: T0, type: 'response_item',
  payload: { type: 'function_call_output', call_id: callId, output },
})
const session = (id, output, callId = 'call_1') => [
  metaLine(id), turnLine('gpt-5.5'), userLine('跑一下'),
  callLine(callId), outLine(callId, output),
].join('\n')

const resultOf = (out) => out.turns[0].steps[0].toolResults[0]

// ── 1. 块数组（92.6% 的真实形态）→ 可读文本 ──
test('codex function_call_output: 块数组 → 文本块（不再 JSON 转义串）', () => {
  const out = convertCodexJsonl(session('codex-out-1', [
    { type: 'input_text', text: 'Script failed' },
    { type: 'input_text', text: 'Wall time 1 seconds' },
  ]), { sessionId: 'codex-out-1' })

  assert.deepEqual(resultOf(out).content, [{ type: 'text', text: 'Script failed\nWall time 1 seconds' }])
  // 事件层同样可读，且不含 JSON 转义残留
  const tr = out.events.find((e) => e.type === 'tool/result')
  assert.equal(tr.data.message.content[0].content[0].text, 'Script failed\nWall time 1 seconds')
})

test('codex function_call_output: {"output":[块数组]} 信封字符串 → 同样映射为文本', () => {
  const out = convertCodexJsonl(session('codex-out-2', JSON.stringify({
    output: [{ type: 'output_text', text: '构建通过' }],
    metadata: { exit_code: 0 },
  })), { sessionId: 'codex-out-2' })

  assert.deepEqual(resultOf(out).content, [{ type: 'text', text: '构建通过' }])
})

test('codex function_call_output: 对象信封 {output:[块数组]} → 同样映射为文本', () => {
  const out = convertCodexJsonl(session('codex-out-3', { output: [{ type: 'input_text', text: '文件已写入' }] }), { sessionId: 'codex-out-3' })

  assert.deepEqual(resultOf(out).content, [{ type: 'text', text: '文件已写入' }])
})

// ── 2. 图片只占位、只计数，base64 不进日志 ──
test('codex function_call_output: input_image → [image] 占位，data URL 不进日志', () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
  const out = convertCodexJsonl(session('codex-out-4', [
    { type: 'input_text', text: '截图如下' },
    { type: 'input_image', image_url: dataUrl },
  ]), { sessionId: 'codex-out-4' })

  assert.deepEqual(resultOf(out).content, [
    { type: 'text', text: '截图如下' },
    { type: 'text', text: '[image]' },
  ])
  const serialized = JSON.stringify(out.events)
  assert.ok(!serialized.includes('iVBORw0KGgo'), 'base64 永不进日志')
  assert.ok(!serialized.includes('data:image/png'), 'data URL 永不进日志')
})

test('codex function_call_output: 只有图片时仍产出 [image] 占位（不是空结果）', () => {
  const out = convertCodexJsonl(session('codex-out-5', [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }]), { sessionId: 'codex-out-5' })

  assert.deepEqual(resultOf(out).content, [{ type: 'text', text: '[image]' }])
})

test('codex function_call_output: 未知块类型计数（droppedMalformedOutputs），不静默', () => {
  const out = convertCodexJsonl(session('codex-out-6', [
    { type: 'input_text', text: '正文' },
    { type: 'weird_block', payload: {} },
  ]), { sessionId: 'codex-out-6' })

  assert.deepEqual(resultOf(out).content, [{ type: 'text', text: '正文' }])
  assert.equal(out.droppedMalformedOutputs, 1)
})

// ── 3. 既有字符串形态不回归 ──
test('codex function_call_output: 纯字符串原样保留；{"output":"…"} 信封取正文', () => {
  const plain = convertCodexJsonl(session('codex-out-7', 'plain text output'), { sessionId: 'codex-out-7' })
  assert.deepEqual(resultOf(plain).content, [{ type: 'text', text: 'plain text output' }])

  const wrapped = convertCodexJsonl(session('codex-out-8', JSON.stringify({ output: 'wrapped text', metadata: {} })), { sessionId: 'codex-out-8' })
  assert.deepEqual(resultOf(wrapped).content, [{ type: 'text', text: 'wrapped text' }])
})

test('codex function_call_output: 空块数组 → 空结果（不虚构文本，交由合成层兜底）', () => {
  const out = convertCodexJsonl(session('codex-out-9', []), { sessionId: 'codex-out-9' })

  assert.deepEqual(resultOf(out).content, [])
  assert.equal(out.droppedMalformedOutputs, undefined, '没有未知块就不占键')
})
