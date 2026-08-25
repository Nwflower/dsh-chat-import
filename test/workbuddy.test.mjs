// workbuddy.test.mjs — WorkBuddy 源转换核心单元测试（自包含合成数据，不掺真实 transcript）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertWorkbuddyJsonl } from '../lib/convert/workbuddy.mjs'
import { SESSION_FORMAT_VERSION } from '../lib/convert/core.mjs'

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

// 合成 WorkBuddy transcript：逐行事件 JSON（事件词汇见 lib/convert/workbuddy.mjs）。
function wb(recs) {
  return recs.map((r) => JSON.stringify(r)).join('\n')
}

const SID = '0016c4c9-2098-4372-ac81-86cdf5d3fb07'
const CWD = 'H:/CodexProjects/my-project'
const TS = 1787131157250

function userRec(innerText) {
  return {
    id: 'u-' + Math.random().toString(36).slice(2), timestamp: TS, type: 'message', role: 'user',
    content: [{ type: 'input_text', text: innerText }], sessionId: SID, cwd: CWD,
  }
}
function assistantRec(content) {
  return {
    id: 'a-' + Math.random().toString(36).slice(2), timestamp: TS, type: 'message', role: 'assistant',
    content: Array.isArray(content) ? content : [{ type: 'output_text', text: content }],
    sessionId: SID, cwd: CWD,
  }
}
function reasoningRec(text) {
  return {
    id: 'r-' + Math.random().toString(36).slice(2), timestamp: TS, type: 'reasoning',
    rawContent: [{ type: 'reasoning_text', text }], sessionId: SID, cwd: CWD,
  }
}
function callRec(callId, name, args = '{}', extra = {}) {
  return {
    id: 'c-' + Math.random().toString(36).slice(2), timestamp: TS, type: 'function_call',
    callId, name, arguments: args, status: 'completed', sessionId: SID, cwd: CWD, ...extra,
  }
}
function resultRec(callId, text) {
  return {
    id: 'x-' + Math.random().toString(36).slice(2), timestamp: TS, type: 'function_call_result',
    callId, name: 'Bash', status: 'completed', output: { type: 'text', text }, sessionId: SID, cwd: CWD,
  }
}

test('简单 user/assistant 轮次（user_query 提取）→ 1 轮、cwd/createdAt 落 meta', () => {
  const raw = wb([
    userRec('<system-reminder>\n...注入...\n</system-reminder>\n<user_query>帮我看看这个项目</user_query>'),
    assistantRec('好的，我先读一下结构。'),
  ])
  const out = convertWorkbuddyJsonl(raw, { sourcePath: 'C:/Users/u/.workbuddy/projects/p/' + SID + '.jsonl' })
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.id, 'import-' + SID)
  assert.equal(out.meta.sourceId, SID)
  assert.equal(out.meta.cwd, CWD)
  assert.equal(out.meta.createdAt, TS)
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].prompt, '帮我看看这个项目')
  assert.equal(out.messages, 2) // user + assistant（环境变更声明不计）
  assert.equal(out.toolCalls, 0)
  assert.equal(out.skipped, 0)
})

test('reasoning 先于 assistant 到达 → 同一 step 内 reasoning + text（不拆步）', () => {
  const raw = wb([
    userRec('<user_query>解释一下这段代码</user_query>'),
    reasoningRec('先看结构再作答'),
    assistantRec('这是入口文件。'),
  ])
  const out = convertWorkbuddyJsonl(raw, { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.turns.length, 1)
  const steps = out.turns[0].steps
  assert.equal(steps.length, 1)
  assert.deepEqual(steps[0].content.map((b) => b.type), ['reasoning', 'text'])
  assert.equal(steps[0].content[0].text, '先看结构再作答')
  // 事件层 step/start 与 step/end 平衡
  const starts = out.events.filter((e) => e.type === 'step/start').length
  const ends = out.events.filter((e) => e.type === 'step/end').length
  assert.equal(starts, ends)
  assert.equal(starts, 1)
})

test('function_call + function_call_result 按 callId 配对', () => {
  const raw = wb([
    userRec('<user_query>跑一下测试</user_query>'),
    assistantRec('我用命令跑。'),
    callRec('call_1', 'Bash', JSON.stringify({ command: 'npm test' })),
    resultRec('call_1', 'ok 42 passed'),
  ])
  const out = convertWorkbuddyJsonl(raw, { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  assertToolPairing(out.events)
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.equal(result.data.message.content[0].content[0].text, 'ok 42 passed')
  // assistant 消息内容携带 tool-call 块（wire 适配器从 content 派生 tool_calls）
  const am = out.events.find((e) => e.type === 'assistant/message')
  assert.ok(am.data.message.content.some((b) => b.type === 'tool-call' && b.name === 'Bash'))
})

test('孤儿 function_call_result（无匹配调用且无当前步）丢弃', () => {
  const raw = wb([
    resultRec('call_missing', '幽灵结果'),
  ])
  const out = convertWorkbuddyJsonl(raw, { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.toolCalls, 0)
  assert.equal(out.turns.length, 0)
  assert.equal(out.skipped, 0)
  assert.equal(out.droppedOrphanResults, 1)
})

test('中途孤儿 function_call_result（有当前步但无匹配调用）丢弃并计数，不误挂 lastStep', () => {
  // 正常 call/result 配对之后来一条无匹配 function_call 的孤儿结果：此前会经
  // `|| lastStep` 误挂到最近一步，产出无 tool/call 的孤儿 tool/result 事件
  //（恢复会话时模型 API 拒绝）——现一律丢弃
  const raw = wb([
    userRec('<user_query>跑一下测试</user_query>'),
    assistantRec('我用命令跑。'),
    callRec('call_1', 'Bash', JSON.stringify({ command: 'npm test' })),
    resultRec('call_1', 'ok 42 passed'),
    resultRec('call_ghost', '孤儿结果'),
  ])
  const out = convertWorkbuddyJsonl(raw, { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.toolCalls, 1)
  assert.equal(out.droppedOrphanResults, 1)
  assertToolPairing(out.events)
  // 日志里没有无 call 的孤儿 tool/result
  const resultIds = out.events.filter((e) => e.type === 'tool/result')
    .map((e) => e.data.message.content[0].toolCallId)
  assert.deepEqual(resultIds, ['call_1'])
})

test('打断/草稿 function_call（isPartialAborted/discard）跳过，不补空结果', () => {
  const raw = wb([
    userRec('<user_query>hi</user_query>'),
    callRec('call_bad', 'Bash', '{}', { providerData: { isPartialAborted: true, discard: true } }),
  ])
  const out = convertWorkbuddyJsonl(raw, { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.toolCalls, 0)
  assertToolPairing(out.events)
})

test('多轮对话：每条 user 提问开新轮', () => {
  const raw = wb([
    userRec('<user_query>第一问</user_query>'),
    assistantRec('一答'),
    userRec('<user_query>第二问</user_query>'),
    assistantRec('二答'),
  ])
  const out = convertWorkbuddyJsonl(raw, { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.turns.length, 2)
  assert.equal(out.messages, 4)
  assert.equal(out.title, '第一问')
})

test('畸形 JSONL 行 → skipped 计数 + skippedLines 明细（不上报内容）', () => {
  // 手动拼 raw：中间插入一行真正非法的 JSON（wb() 会把它 stringify 成合法串，故不走它）
  const raw = [
    JSON.stringify(userRec('<user_query>正常提问</user_query>')),
    '{ 这不是 JSON',
    JSON.stringify(assistantRec('部分回答')),
  ].join('\n')
  const out = convertWorkbuddyJsonl(raw, { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.skipped, 1)
  assert.equal(out.skippedLines.length, 1)
  assert.equal(out.skippedLines[0].line, 2)
  assert.ok(!String(out.skippedLines[0].error).includes('这不是 JSON'))
  assert.equal(out.turns.length, 1)
})

test('事件内无 sessionId → 以文件名 workbuddyId（session-uuid stem）作稳定源 id', () => {
  // 首条 user 记录故意不带 sessionId，验证转换器全程兜底
  const out = convertWorkbuddyJsonl(wb([
    { id: 'u', timestamp: TS, type: 'message', role: 'user', content: [{ type: 'input_text', text: '<user_query>问</user_query>' }], cwd: CWD },
    assistantRec('答'),
  ]), { workbuddyId: SID, sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.meta.id, 'import-' + SID)
  assert.equal(out.meta.sourceId, SID)
})

test('无用户提问（空/纯注入）→ 无可导入内容', () => {
  const raw = wb([
    userRec('<system-reminder>\n纯注入，无 user_query\n</system-reminder>'),
  ])
  const out = convertWorkbuddyJsonl(raw, { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.turns.length, 0)
  assert.equal(out.events.filter((e) => e.type === 'user/message').length, 0)
})

test('session/imported 内部标记钉在日志头（REQ-32）', () => {
  const raw = wb([
    userRec('<user_query>hi</user_query>'),
    assistantRec('yo'),
  ])
  const out = convertWorkbuddyJsonl(raw, { sourcePath: 'C:/Users/u/.workbuddy/projects/p/' + SID + '.jsonl' })
  const ev = out.events[0]
  assert.equal(ev.type, 'session/imported')
  assert.equal(ev.seq, 0)
  assert.equal(ev.ignorable, true)
  assert.equal(ev.data.tool, 'workbuddy')
  assert.equal(ev.data.sourceId, SID)
  assert.equal(ev.data.sourcePath, 'C:/Users/u/.workbuddy/projects/p/' + SID + '.jsonl')
  assert.equal(out.events[1].type, 'user/message') // 环境变更声明（总是注入）
  assert.equal(out.events[1].data.source.kind, 'plugin')
  assert.equal(out.events[2].type, 'turn/start')
})

test('file-history-snapshot 等运行期事件忽略', () => {
  const raw = wb([
    { id: 's', timestamp: TS, type: 'file-history-snapshot', isSnapshotUpdate: false, snapshot: { messageId: 'x', trackedFileBackups: {} }, cwd: CWD },
    userRec('<user_query>hi</user_query>'),
    assistantRec('yo'),
  ])
  const out = convertWorkbuddyJsonl(raw, { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.skipped, 0)
  assert.equal(out.messages, 2)
})