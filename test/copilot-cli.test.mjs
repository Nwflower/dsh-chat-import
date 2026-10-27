import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertCopilotCliJsonl, copilotCliHeadMeta } from '../lib/convert/copilot-cli.mjs'
import { convertLocalJsonl } from '../lib/convert/local-jsonl.mjs'
import { copilotCliRoots } from '../lib/discovery/copilot-cli.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { copilotCliConversation, copilotCliEvent, copilotCliJsonl, COPILOT_CLI_TIME as TS, COPILOT_CLI_SESSION } from './_support/copilot-cli.mjs'

const convert = (events, args) => convertCopilotCliJsonl(copilotCliJsonl(events), args)

test('Copilot CLI preserves ordered prompts, reasoning, paired tools, title and source times', () => {
  const out = convert(copilotCliConversation())
  assert.equal(out.turns.length, 2)
  assert.equal(out.title, 'Inspect the example')
  assert.equal(out.meta.sourceId, COPILOT_CLI_SESSION)
  assert.equal(out.meta.id, 'import-' + COPILOT_CLI_SESSION)
  assert.equal(out.meta.createdAt, TS)
  assert.equal(out.meta.cwd, '/home/example/project')
  const assistantEvent = out.events.find((e) => e.type === 'assistant/message')
  assert.equal(assistantEvent.data.message.source.provider, 'copilot-cli')
  assert.equal(assistantEvent.data.message.source.model, 'example-model')
  const first = out.turns[0]
  assert.equal(first.prompt, 'Inspect the example')
  assert.equal(first.time, TS + 1000)
  assert.deepEqual(first.steps[0].content.map((b) => b.type), ['reasoning', 'text', 'tool-call'])
  assert.equal(first.steps[0].content[0].text, 'Reading the example.')
  assert.deepEqual(first.steps[0].toolCalls, [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"path":"example.txt"}' }])
  assert.deepEqual(first.steps[0].toolResults[0].content, [{ type: 'text', text: 'example output' }])
  assert.equal(first.steps[0].toolResults[0].isError, false)
  assert.equal(first.steps[0].toolResults[0].time, TS + 3500)
  assert.equal(first.steps[1].content[0].text, 'Done.')
  assert.equal(out.turns[1].prompt, 'Explain the result')
  assert.equal(out.turns[1].steps[0].content[0].text, 'Explanation.')
  assert.equal(out.toolCalls, 1)
  assert.equal(out.messages, 6)
  assert.equal(out.metaMessages, 4) // session.start + execution_start + hook.start + shutdown
  assert.equal(out.droppedAttachments, 1)
  assert.equal(out.unknownEvents, 0)
  assert.equal(out.orphanResults, 0)
  assertEnvelopeHygiene(out.events)
  assert.equal(out.events.find((e) => e.type === 'user/message').time, TS + 1000)
})

test('Copilot CLI turns a summary compaction into a native checkpoint and shadows earlier turns', () => {
  const events = copilotCliConversation()
  events.splice(7, 0, copilotCliEvent('e-compact', 'e-hook', 4800, 'session.compaction_complete', {
    summaryContent: 'Earlier we inspected the example.', checkpointNumber: 1,
  }))
  const out = convert(events)
  assert.equal(out.turns.length, 2)
  assert.equal(out.turns[0].shadowed, true)
  assert.equal(out.turns[0].compaction, undefined)
  assert.equal(out.turns[1].compaction.summary, 'Earlier we inspected the example.')
  assert.equal(out.turns[1].compaction.provider, 'copilot-cli')
  assert.equal(out.turns[1].compaction.time, TS + 4800)
  assert.equal(out.compacted, true)
  assert.ok(out.events.some((e) => e.type === 'compaction/summary' && e.data.summary?.[0]?.text === 'Earlier we inspected the example.'))
  assertEnvelopeHygiene(out.events)
})

test('Copilot CLI fullHistory keeps the full surface and writes no checkpoint', () => {
  const events = copilotCliConversation()
  events.splice(7, 0, copilotCliEvent('e-compact', 'e-hook', 4800, 'session.compaction_complete', {
    summaryContent: 'Earlier we inspected the example.', checkpointNumber: 1,
  }))
  const out = convert(events, { fullHistory: true })
  assert.equal(out.turns.length, 2)
  assert.equal(out.turns[0].shadowed, undefined)
  assert.equal(out.turns[1].compaction, undefined)
  assert.equal(out.compacted, undefined)
  assert.ok(!out.events.some((e) => e.type.startsWith('compaction/')))
})

test('Copilot CLI without a readable summary does not mark a boundary', () => {
  const events = copilotCliConversation()
  events.splice(7, 0, copilotCliEvent('e-compact', 'e-hook', 4800, 'session.compaction_complete', { checkpointNumber: 2 }))
  const out = convert(events)
  assert.equal(out.turns.length, 2)
  assert.equal(out.turns[0].shadowed, undefined)
  assert.equal(out.turns[1].compaction, undefined)
  assert.equal(out.compacted, undefined)
})

test('Copilot CLI counts bookkeeping, unknown and malformed lines without failing the session', () => {
  const out = convertCopilotCliJsonl([
    copilotCliJsonl(copilotCliConversation()),
    '{"id":"e-x","timestamp":"2026-10-24T00:00:00.000Z","type":"brand.new.event","data":{}}',
    '{"broken',
    'sk-abcdefghijklmnopqrstuvwxyz',
  ].join('\n'))
  assert.equal(out.turns.length, 2)
  assert.equal(out.unknownEvents, 1)
  assert.equal(out.skipped, 2)
  assert.equal(out.skippedLines.length, 2)
  assert.deepEqual(out.secrets, [{ line: 14, kind: 'api-key' }])
  assertEnvelopeHygiene(out.events)
})

test('Copilot CLI pairs execution results that arrive without a declared request', () => {
  const events = [
    copilotCliEvent('e-start', null, 0, 'session.start', { sessionId: COPILOT_CLI_SESSION, context: { cwd: '/w' } }),
    copilotCliEvent('e-user', 'e-start', 100, 'user.message', { content: 'Run it', messageId: 'm1' }),
    copilotCliEvent('e-exec1', 'e-user', 200, 'tool.execution_start', { toolCallId: 'c9', toolName: 'run_cmd', arguments: { cmd: 'ls' } }),
    copilotCliEvent('e-exec2', 'e-exec1', 300, 'tool.execution_complete', { toolCallId: 'c9', success: false, error: { code: 'ENOENT', message: 'missing' } }),
  ]
  const out = convert(events)
  assert.equal(out.turns.length, 1)
  const step = out.turns[0].steps[0]
  assert.deepEqual(step.content.map((b) => b.type), ['tool-call'])
  assert.equal(step.content[0].name, 'run_cmd')
  assert.equal(step.toolResults[0].isError, true)
  assert.deepEqual(step.toolResults[0].content, [{ type: 'text', text: 'missing' }])
  assert.equal(out.unannouncedToolCalls, 1)
  assert.equal(out.missingToolOutputs, 0)
})

test('Copilot CLI keeps an undeclared execution visible after an empty assistant message', () => {
  // 纯信令的 assistant.message 会弹出空步；随后补出的 tool-call 必须落在仍可见的新步里，
  // 而不是写进已弹出的 step（那样整条执行轨迹会静默消失）。
  const events = [
    copilotCliEvent('e-start', null, 0, 'session.start', { sessionId: COPILOT_CLI_SESSION, context: {} }),
    copilotCliEvent('e-user', 'e-start', 100, 'user.message', { content: 'Go' }),
    copilotCliEvent('e-empty', 'e-user', 200, 'assistant.message', { content: '' }),
    copilotCliEvent('e-exec1', 'e-empty', 300, 'tool.execution_start', { toolCallId: 'c1', toolName: 'run_cmd', arguments: {} }),
    copilotCliEvent('e-exec2', 'e-exec1', 400, 'tool.execution_complete', { toolCallId: 'c1', success: true, result: { content: 'ok' } }),
  ]
  const out = convert(events)
  assert.equal(out.unannouncedToolCalls, 1)
  const step = out.turns[0].steps[0]
  assert.deepEqual(step.content.map((b) => b.type), ['tool-call'])
  assert.equal(step.toolResults.length, 1)
  assertEnvelopeHygiene(out.events)
})

test('Copilot CLI reports orphan results and unreadable outputs', () => {
  const events = [
    copilotCliEvent('e-start', null, 0, 'session.start', { sessionId: COPILOT_CLI_SESSION, context: {} }),
    copilotCliEvent('e-user', 'e-start', 100, 'user.message', { content: 'Two calls', messageId: 'm1' }),
    copilotCliEvent('e-asst', 'e-user', 200, 'assistant.message', {
      messageId: 'm2', originatingMessageId: 'm1', content: 'Working.',
      toolRequests: [{ toolCallId: 'c1', name: 'tool_one', arguments: {} }],
    }),
    copilotCliEvent('e-exec2', 'e-asst', 300, 'tool.execution_complete', { toolCallId: 'c1', success: true }),
    copilotCliEvent('e-exec3', 'e-exec2', 400, 'tool.execution_complete', { toolCallId: 'ghost', success: true, result: { content: 'late' } }),
    copilotCliEvent('e-exec4', 'e-exec3', 500, 'tool.execution_complete', { toolCallId: 'c1', success: true, result: { content: [{ type: 'image_url', url: 'x' }] } }),
  ]
  const out = convert(events)
  assert.equal(out.orphanResults, 1)
  assert.equal(out.missingToolOutputs, 2)
  assert.equal(out.droppedMalformedOutputs, 1)
  const step = out.turns[0].steps[0]
  assert.equal(step.toolResults.length, 3)
  assert.deepEqual(step.toolResults[0].content, [])
  assert.deepEqual(step.toolResults[1].content, [{ type: 'text', text: 'late' }])
  assert.deepEqual(step.toolResults[2].content, [])
})

test('Copilot CLI keeps an empty prompt turn as the compaction carrier after the boundary', () => {
  const events = [
    copilotCliEvent('e-start', null, 0, 'session.start', { sessionId: COPILOT_CLI_SESSION, context: {} }),
    copilotCliEvent('e-user', 'e-start', 100, 'user.message', { content: 'Before', messageId: 'm1' }),
    copilotCliEvent('e-asst', 'e-user', 200, 'assistant.message', { messageId: 'm2', originatingMessageId: 'm1', content: 'Reply' }),
    copilotCliEvent('e-compact', 'e-asst', 300, 'session.compaction_complete', { summaryContent: 'Summary.' }),
    copilotCliEvent('e-asst2', 'e-compact', 400, 'assistant.message', { messageId: 'm3', originatingMessageId: 'm1', content: 'After the fold' }),
  ]
  const out = convert(events)
  assert.equal(out.turns.length, 2)
  assert.equal(out.turns[0].shadowed, true)
  assert.equal(out.turns[1].prompt, '')
  assert.equal(out.turns[1].compaction.summary, 'Summary.')
  assert.equal(out.turns[1].steps[0].content[0].text, 'After the fold')
  assertEnvelopeHygiene(out.events)
})

test('Copilot CLI marks aborted turns and follows model changes', () => {
  const events = [
    copilotCliEvent('e-start', null, 0, 'session.start', { sessionId: COPILOT_CLI_SESSION, selectedModel: 'model-a', context: {} }),
    copilotCliEvent('e-user', 'e-start', 100, 'user.message', { content: 'Stop here', messageId: 'm1' }),
    copilotCliEvent('e-asst', 'e-user', 200, 'assistant.message', { messageId: 'm2', originatingMessageId: 'm1', content: 'Part' }),
    copilotCliEvent('e-abort', 'e-asst', 300, 'abort', {}),
    copilotCliEvent('e-change', 'e-abort', 400, 'session.model_change', { previousModel: 'model-a', newModel: 'model-b' }),
    copilotCliEvent('e-user2', 'e-change', 500, 'user.message', { content: 'Continue', messageId: 'm3' }),
    copilotCliEvent('e-asst2', 'e-user2', 600, 'assistant.message', { messageId: 'm4', originatingMessageId: 'm3', content: 'Rest' }),
  ]
  const out = convert(events)
  assert.equal(out.turns.length, 2)
  assert.equal(out.turns[0].aborted, true)
  assert.equal(out.events.some((e) => e.type === 'turn/end' && e.data?.reason?.kind === 'aborted'), true)
  const firstAssistant = out.events.find((e) => e.type === 'assistant/message')
  assert.equal(firstAssistant.data.message.source.model, 'model-a')
  assert.equal(out.turns[1].steps[0].model, 'model-b')
})

test('Copilot CLI falls back to the first envelope id when session.start has no sessionId', () => {
  const events = [
    copilotCliEvent('e-only-id', null, 0, 'session.start', { context: {} }),
    copilotCliEvent('e-user', 'e-only-id', 100, 'user.message', { content: 'Hello', messageId: 'm1' }),
  ]
  const out = convert(events)
  assert.equal(out.meta.sourceId, 'e-only-id')
  assert.equal(out.meta.id, 'import-e-only-id')
  assert.equal(out.meta.cwd, undefined)
})

for (const [name, raw] of [
  ['empty stream', ''],
  ['blank lines', '\n\n'],
  ['no session.start and no conversation', '{"id":"a","type":"session.info","data":{}}'],
  ['malformed lines only', '{\n{'],
]) {
  test('Copilot CLI rejects ' + name, () => {
    const out = convertCopilotCliJsonl(raw)
    assert.equal(out.meta, null)
    assert.match(out.skipReason, /Copilot session has no conversation/)
  })
}

test('Copilot CLI refuses a conversation without session.start', () => {
  // 没有 session.start 就没有「这份流是 Copilot CLI」的签名：带 user/assistant 消息的外来
  // JSONL 不能被认领（否则 local-jsonl 的内容试跑会误判来源）。
  const raw = copilotCliJsonl([
    copilotCliEvent('e1', null, 0, 'user.message', { content: 'Hello' }),
    copilotCliEvent('e2', 'e1', 1000, 'assistant.message', { content: 'Hi' }),
  ])
  const out = convertCopilotCliJsonl(raw)
  assert.equal(out.meta, null)
  assert.match(out.skipReason, /no session\.start/)
  const detected = convertLocalJsonl(raw, { sourcePath: '/tmp/random/export.jsonl' })
  assert.equal(detected.detectedFormat, null)
})

test('copilotCliHeadMeta extracts identity, workspace and first prompt; null for foreign streams', () => {
  const meta = copilotCliHeadMeta(copilotCliConversation())
  assert.equal(meta.id, COPILOT_CLI_SESSION)
  assert.equal(meta.cwd, '/home/example/project')
  assert.equal(meta.createdAt, TS)
  assert.equal(meta.model, 'example-model')
  assert.equal(meta.title, 'Inspect the example')
  assert.equal(copilotCliHeadMeta([{ type: 'session_meta', payload: {} }]), null)
  assert.equal(copilotCliHeadMeta([]), null)
})

test('copilotCliRoots honours the platform layout and COPILOT_HOME', () => {
  assert.deepEqual(copilotCliRoots('/home/u', {}, 'linux'), ['/home/u/.copilot/session-state'])
  assert.deepEqual(copilotCliRoots('C:\\Users\\u', {}, 'win32'), ['C:\\Users\\u\\.copilot\\session-state'])
  assert.deepEqual(copilotCliRoots('/Users/u', {}, 'darwin'), ['/Users/u/.copilot/session-state'])
  assert.deepEqual(copilotCliRoots('/home/u', { COPILOT_HOME: '/data/copilot' }, 'linux'), ['/data/copilot/session-state'])
  // 相对 COPILOT_HOME 不是绝对根：按缺省布局处理
  assert.deepEqual(copilotCliRoots('/home/u', { COPILOT_HOME: 'copilot' }, 'linux'), ['/home/u/.copilot/session-state'])
})

test('local-jsonl detects session-state event streams and forces the parser via parseFormat', () => {
  const raw = copilotCliJsonl(copilotCliConversation())
  for (const p of ['/home/u/.copilot/session-state/abc/events.jsonl', 'C:\\cop\\session-state\\abc\\events.jsonl']) {
    const out = convertLocalJsonl(raw, { sourcePath: p })
    assert.equal(out.meta?.sourceId, COPILOT_CLI_SESSION, p)
    // 路径足够特征：只试 copilot-cli，不再靠内容试跑全部 13 个解析器
    assert.equal(out.detectedBy, 'path-hint', p)
  }
  const forced = convertLocalJsonl(raw, { sourcePath: '/tmp/random/export.jsonl', parseFormat: 'copilot-cli' })
  assert.equal(forced.meta?.sourceId, COPILOT_CLI_SESSION)
})
