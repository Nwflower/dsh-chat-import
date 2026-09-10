// antigravity.test.mjs — Antigravity CLI 源转换核心单元测试（自包含合成数据，
// 不掺真实 transcript）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  convertAntigravityJsonl,
  indexTaskMessages,
  parseAnnotationTitle,
  unwrapUserRequest,
} from '../lib/convert/antigravity.mjs'
import { SESSION_FORMAT_VERSION } from '../lib/convert/core.mjs'

// 转录行：Antigravity 每步一行，键随 type 变化（见 lib/convert/antigravity.mjs 头注）。
const userInput = (stepIndex, content, createdAt = '2026-01-02T03:04:05Z') =>
  JSON.stringify({ step_index: stepIndex, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: createdAt, content })
const planner = (stepIndex, { content = '', thinking, toolCalls } = {}) => {
  const rec = { step_index: stepIndex, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-01-02T03:04:06Z', content }
  if (thinking !== undefined) rec.thinking = thinking
  if (toolCalls !== undefined) rec.tool_calls = toolCalls
  return JSON.stringify(rec)
}
const generic = (stepIndex, status, content) =>
  JSON.stringify({ step_index: stepIndex, source: 'MODEL', type: 'GENERIC', status, created_at: '2026-01-02T03:04:07Z', content })
const systemMessage = (stepIndex, content) =>
  JSON.stringify({ step_index: stepIndex, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: '2026-01-02T03:04:07Z', content })

const jsonl = (...lines) => lines.join('\n') + '\n'

// 配对不变量：每个 tool/call 都有对应 tool/result，且 result 指向其 tool/call 的 seq。
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

test('convertAntigravityJsonl: <USER_REQUEST> 剥壳、<ADDITIONAL_METADATA> 丢弃', () => {
  const raw = jsonl(
    userInput(0, '<USER_REQUEST>\nfix the build\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nworkspace: /tmp/x\n</ADDITIONAL_METADATA>'),
    planner(1, { content: 'on it' }),
  )
  const out = convertAntigravityJsonl(raw, { antigravityId: 'conv-1' })
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.id, 'import-conv-1')
  assert.equal(out.meta.sourceId, 'conv-1')
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].prompt, 'fix the build')
  assert.equal(out.title, 'fix the build')
  assert.equal(out.skipped, 0)
  assert.equal(out.records, 2)
})

test('unwrapUserRequest: 无信封原文保留，仅剥已知信封', () => {
  assert.equal(unwrapUserRequest('plain question'), 'plain question')
  assert.equal(unwrapUserRequest('<USER_REQUEST>  spaced  </USER_REQUEST>'), 'spaced')
  assert.equal(unwrapUserRequest('<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>'), '')
})

test('convertAntigravityJsonl: 工具结果取自紧随其调用步之后的 GENERIC/DONE', () => {
  const raw = jsonl(
    userInput(0, '<USER_REQUEST>run it</USER_REQUEST>'),
    planner(1, { toolCalls: [{ name: 'run_command', args: { CommandLine: '"ls -la"', Cwd: '"/srv"' } }] }),
    // RUNNING 表示后台任务刚启动，不是结果 → 不得消费该调用
    generic(2, 'RUNNING', 'Tool is running as a background task with task id: conv-1/task-2'),
    generic(3, 'DONE', 'The command exited with code 0.\nOutput:\nfile-a\nfile-b'),
    planner(4, { content: 'done' }),
  )
  const out = convertAntigravityJsonl(raw, { antigravityId: 'conv-2' })
  const events = out.events
  assertToolPairing(events)
  const call = events.find((e) => e.type === 'tool/call')
  assert.equal(call.data.name, 'run_command')
  // args 的带引号字符串还原为字面值
  assert.deepEqual(JSON.parse(call.data.arguments), { CommandLine: 'ls -la', Cwd: '/srv' })
  const result = events.find((e) => e.type === 'tool/result')
  assert.match(result.data.message.content[0].content[0].text, /file-a/)
  // cwd 由工具参数的 Cwd 推断
  assert.equal(out.meta.cwd, '/srv')
})

test('convertAntigravityJsonl: 一次 planner 步多个调用按顺序逐个消费结果', () => {
  const raw = jsonl(
    userInput(0, '<USER_REQUEST>two calls</USER_REQUEST>'),
    planner(1, {
      toolCalls: [
        { name: 'view_file', args: { AbsolutePath: '"/a.txt"' } },
        { name: 'view_file', args: { AbsolutePath: '"/b.txt"' } },
      ],
    }),
    generic(2, 'DONE', 'contents of A'),
    generic(3, 'DONE', 'contents of B'),
  )
  const out = convertAntigravityJsonl(raw, { antigravityId: 'conv-3' })
  assertToolPairing(out.events)
  const texts = out.events
    .filter((e) => e.type === 'tool/result')
    .map((e) => e.data.message.content[0].content[0].text)
  assert.deepEqual(texts, ['contents of A', 'contents of B'])
})

test('convertAntigravityJsonl: 无结果的后台调用显式标注，不留空结果', () => {
  const raw = jsonl(
    userInput(0, '<USER_REQUEST>background it</USER_REQUEST>'),
    planner(1, { toolCalls: [{ name: 'run_command', args: { CommandLine: '"sleep 999"' } }] }),
  )
  const out = convertAntigravityJsonl(raw, { antigravityId: 'conv-4' })
  assertToolPairing(out.events)
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.match(result.data.message.content[0].content[0].text, /background task/)
  const call = out.events.find((e) => e.type === 'tool/call')
  assert.equal(call.data.name, 'run_command')
})

test('convertAntigravityJsonl: 任务控制类调用标注为无直接输出', () => {
  const raw = jsonl(
    userInput(0, '<USER_REQUEST>schedule it</USER_REQUEST>'),
    planner(1, { toolCalls: [{ name: 'manage_task', args: { Action: '"wait"' } }] }),
  )
  const out = convertAntigravityJsonl(raw, { antigravityId: 'conv-5' })
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.match(result.data.message.content[0].content[0].text, /task control call/)
})

test('convertAntigravityJsonl: thinking → reasoning 块', () => {
  const raw = jsonl(
    userInput(0, '<USER_REQUEST>think</USER_REQUEST>'),
    planner(1, { content: 'answer', thinking: 'weighing options' }),
  )
  const out = convertAntigravityJsonl(raw, { antigravityId: 'conv-6' })
  const assistant = out.events.find((e) => e.type === 'assistant/message')
  const types = assistant.data.message.content.map((c) => c.type)
  assert.deepEqual(types, ['text', 'reasoning'])
})

test('convertAntigravityJsonl: SYSTEM_MESSAGE 不产出正文（框架通知非对话）', () => {
  const raw = jsonl(
    userInput(0, '<USER_REQUEST>hello</USER_REQUEST>'),
    systemMessage(1, 'The following is a <SYSTEM_MESSAGE> not actually sent by the user. Important instructions follow.'),
    planner(2, { content: 'hi' }),
  )
  const out = convertAntigravityJsonl(raw, { antigravityId: 'conv-7' })
  const assistant = out.events.find((e) => e.type === 'assistant/message')
  assert.equal(assistant.data.message.content[0].text, 'hi')
})

test('convertAntigravityJsonl: ERROR_MESSAGE 保留为正文（失败大声）', () => {
  const raw = jsonl(
    userInput(0, '<USER_REQUEST>do it</USER_REQUEST>'),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'ERROR_MESSAGE', status: 'DONE', created_at: '2026-01-02T03:04:07Z', content: 'permission denied' }),
  )
  const out = convertAntigravityJsonl(raw, { antigravityId: 'conv-8' })
  const texts = out.events
    .filter((e) => e.type === 'assistant/message')
    .flatMap((e) => e.data.message.content.map((c) => c.text))
  assert.ok(texts.some((t) => t.includes('permission denied')), '错误正文可见')
})

test('convertAntigravityJsonl: 截断标记剥离', () => {
  const raw = jsonl(
    userInput(0, '<USER_REQUEST>truncated content</USER_REQUEST>'),
    planner(1, { toolCalls: [{ name: 'run_command', args: { CommandLine: '"cat big.log"' } }] }),
    generic(2, 'DONE', 'partial output\n... (truncated)'),
  )
  const out = convertAntigravityJsonl(raw, { antigravityId: 'conv-9' })
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.equal(result.data.message.content[0].content[0].text, 'partial output')
})

test('convertAntigravityJsonl: 标题优先 annotations 权威值，缺省回退首问', () => {
  const raw = jsonl(
    userInput(0, '<USER_REQUEST>first question here</USER_REQUEST>'),
    planner(1, { content: 'ok' }),
  )
  assert.equal(convertAntigravityJsonl(raw, { antigravityId: 'c' }).title, 'first question here')
  assert.equal(
    convertAntigravityJsonl(raw, { antigravityId: 'c', annotationTitle: 'Renamed Session' }).title,
    'Renamed Session',
  )
  // 超 80 字符按统一规则截断加省略号
  const long = 'x'.repeat(120)
  const t = convertAntigravityJsonl(jsonl(userInput(0, `<USER_REQUEST>${long}</USER_REQUEST>`)), { antigravityId: 'c' }).title
  assert.equal(t.length, 80)
  assert.ok(t.endsWith('…'))
})

test('convertAntigravityJsonl: 畸形行计数上报、不静默吞掉（REQ-26）', () => {
  const raw = jsonl(
    userInput(0, '<USER_REQUEST>ok</USER_REQUEST>'),
    '{not json',
    planner(1, { content: 'still parsed' }),
  )
  const out = convertAntigravityJsonl(raw, { antigravityId: 'conv-10' })
  assert.equal(out.skipped, 1)
  assert.equal(out.skippedLines.length, 1)
  assert.equal(out.skippedLines[0].line, 2)
})

test('convertAntigravityJsonl: 空输入 / 无用户轮 → 无回合不抛错', () => {
  assert.equal(convertAntigravityJsonl('', { antigravityId: 'x' }).turns.length, 0)
  // 首轮之前到达的模型回复（会话被截断）不产出无 prompt 的 step
  const orphan = jsonl(planner(0, { content: 'orphan reply' }))
  const out = convertAntigravityJsonl(orphan, { antigravityId: 'x' })
  assert.equal(out.turns.length, 0)
  assert.equal(out.events.length, 0)
})

test('convertAntigravityJsonl: 多轮各自开回合', () => {
  const raw = jsonl(
    userInput(0, '<USER_REQUEST>one</USER_REQUEST>'),
    planner(1, { content: 'first' }),
    userInput(2, '<USER_REQUEST>two</USER_REQUEST>'),
    planner(3, { content: 'second' }),
  )
  const out = convertAntigravityJsonl(raw, { antigravityId: 'conv-11' })
  assert.deepEqual(out.turns.map((t) => t.prompt), ['one', 'two'])
})

test('parseAnnotationTitle: 取 protobuf 文本格式的 title 字段', () => {
  assert.equal(parseAnnotationTitle('title:"Terminate Current Session"'), 'Terminate Current Session')
  assert.equal(parseAnnotationTitle('title:"escaped \\" quote"'), 'escaped " quote')
  assert.equal(parseAnnotationTitle('other:1'), '')
  assert.equal(parseAnnotationTitle(''), '')
})

test('indexTaskMessages: 按 sourceMetadata.tool.stepIndex 建索引', () => {
  const map = indexTaskMessages([
    { content: 'task A finished', sourceMetadata: { tool: { stepIndex: 1431 } } },
    { content: 'task B finished', sourceMetadata: { tool: { stepIndex: 601 } } },
    { content: 'no tool meta' },
    { content: '', sourceMetadata: { tool: { stepIndex: 601 } } },
  ])
  assert.deepEqual(map.get(1431), ['task A finished'])
  assert.deepEqual(map.get(601), ['task B finished'])
  assert.equal(map.size, 2)
})

test('convertAntigravityJsonl: 伴生 messages 回执补齐未配对调用', () => {
  const raw = jsonl(
    userInput(0, '<USER_REQUEST>async work</USER_REQUEST>'),
    planner(1, { toolCalls: [{ name: 'run_command', args: { CommandLine: '"long job"' } }] }),
    // 转录里只留任务回执摘要，正文在伴生 messages/ 里
    generic(7, 'DONE', 'Task conv/task-7 finished'),
  )
  const taskMessages = indexTaskMessages([
    { content: 'The command exited with code 0.\nOutput:\nreal output', sourceMetadata: { tool: { stepIndex: 7 } } },
  ])
  const out = convertAntigravityJsonl(raw, { antigravityId: 'conv-12', taskMessages })
  assertToolPairing(out.events)
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.match(result.data.message.content[0].content[0].text, /real output/)
})
