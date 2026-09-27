// continue.test.mjs — Continue 源转换核心单元测试（自包含合成数据，不掺真实会话）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertContinueJson, readContinueIndex } from '../lib/convert/continue.mjs'
import { SESSION_FORMAT_VERSION } from '../lib/convert/core.mjs'
import { assertNativeCompaction, derivedSurfaceMessages } from './_support/compaction.mjs'

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

const SID = '3f2b9c14-58a7-4f6d-9c31-0d5e7a1b2c34'
const CWD = '/home/u/repo'
const TS = 1787131157250

function item(message, extra = {}) {
  return { message, contextItems: [], ...extra }
}
function user(content) {
  return item({ id: 'u-' + Math.random().toString(36).slice(2), role: 'user', content })
}
function assistant(content, extra = {}) {
  return item({ id: 'a-' + Math.random().toString(36).slice(2), role: 'assistant', content }, extra)
}
// assistant 带工具调用：toolCalls 在 **message 上**（toolCallStates/reasoning/conversationSummary
// 才在 item 上），与文件真实形状一致。
function assistantCalling(content, calls, extra = {}) {
  return item({ id: 'a-' + Math.random().toString(36).slice(2), role: 'assistant', content, toolCalls: calls }, extra)
}
function thinking(content) {
  return item({ id: 't-' + Math.random().toString(36).slice(2), role: 'thinking', content })
}
function toolResult(content, toolCallId) {
  return item({ id: 'r-' + Math.random().toString(36).slice(2), role: 'tool', content, toolCallId })
}
function call(id, name, args = '{}') {
  return { id, type: 'function', function: { name, arguments: args } }
}
function session(history, over = {}) {
  return JSON.stringify({
    sessionId: SID, title: 'New Session', workspaceDirectory: CWD, history, ...over,
  })
}

test('简单 user/assistant 轮次 → 1 轮、cwd/sourceId/createdAt 落 meta、首问兜底标题', () => {
  const out = convertContinueJson(session([user('修一下登录页'), assistant('已修好。')]), {
    createdAt: TS, sourcePath: '/home/u/.continue/sessions/' + SID + '.json',
  })
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.id, 'import-' + SID)
  assert.equal(out.meta.sourceId, SID)
  assert.equal(out.meta.cwd, CWD)
  assert.equal(out.meta.createdAt, TS)
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].prompt, '修一下登录页')
  assert.equal(out.messages, 2) // user + assistant（contextItems 等噪声不计）
  assert.equal(out.toolCalls, 0)
  // 默认标题不是用户起的名字 → 只回填 out.title，不钉 session/title 事件
  assert.equal(out.title, '修一下登录页')
  assert.equal(out.events.filter((e) => e.type === 'session/title').length, 0)
})

test('thinking 消息 + 工具调用 + tool 结果 → reasoning 落步首、结果按 toolCallId 配对', () => {
  const out = convertContinueJson(session([
    user('看看 a.ts'),
    thinking('需要先读文件'),
    assistantCalling('', [call('call_1', 'read_file', '{"filepath":"a.ts"}')]),
    toolResult('export const a = 1', 'call_1'),
    assistant('文件里只有一个导出。'),
  ]), { createdAt: TS })
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].steps.length, 2)
  const [s1, s2] = out.turns[0].steps
  assert.deepEqual(s1.content[0], { type: 'reasoning', text: '需要先读文件' })
  assert.deepEqual(s1.toolCalls, [{ id: 'call_1', name: 'read_file', arguments: '{"filepath":"a.ts"}' }])
  assert.equal(s1.toolResults.length, 1)
  assert.deepEqual(s1.toolResults[0].content, [{ type: 'text', text: 'export const a = 1' }])
  assert.equal(s1.toolResults[0].isError, false)
  assert.equal(s2.content[0].text, '文件里只有一个导出。')
  assert.equal(out.messages, 4) // user + 2 assistant + 1 tool result
  assert.equal(out.toolCalls, 1)
  assert.equal(out.droppedOrphanResults, 0)
  assertToolPairing(out.events)
})

test('thinking 消息与 item.reasoning.text 同一段文本 → 只落一个 reasoning 块', () => {
  const out = convertContinueJson(session([
    user('问题'),
    thinking('同一段思考'),
    assistant('回答', { reasoning: { active: false, text: '同一段思考', startAt: TS } }),
  ]), { createdAt: TS })
  const content = out.turns[0].steps[0].content
  assert.deepEqual(content.filter((b) => b.type === 'reasoning'), [{ type: 'reasoning', text: '同一段思考' }])
})

test('thinking 消息缺失时用 item.reasoning.text；两者不同则都保留（按序）', () => {
  const onlyInline = convertContinueJson(session([
    user('问题'),
    assistant('回答', { reasoning: { active: false, text: '仅内联推理', startAt: TS } }),
  ]), { createdAt: TS })
  assert.deepEqual(onlyInline.turns[0].steps[0].content[0], { type: 'reasoning', text: '仅内联推理' })

  const both = convertContinueJson(session([
    user('问题'),
    thinking('思考块'),
    assistant('回答', { reasoning: { active: false, text: '内联补充', startAt: TS } }),
  ]), { createdAt: TS })
  assert.deepEqual(both.turns[0].steps[0].content.slice(0, 2), [
    { type: 'reasoning', text: '思考块' },
    { type: 'reasoning', text: '内联补充' },
  ])
})

test('toolCalls 缺失时回退 toolCallStates；结果缺失时用 state.output 补齐（errored → isError）', () => {
  const out = convertContinueJson(session([
    user('跑测试'),
    assistant('', {
      toolCallStates: [{
        toolCallId: 'call_9',
        toolCall: call('call_9', 'run_tests', '{"pattern":"x"}'),
        status: 'errored',
        parsedArgs: { pattern: 'x' },
        output: [{ content: 'FAIL src/x.test.ts' }],
      }],
    }),
  ]), { createdAt: TS })
  const step = out.turns[0].steps[0]
  assert.deepEqual(step.toolCalls, [{ id: 'call_9', name: 'run_tests', arguments: '{"pattern":"x"}' }])
  assert.equal(step.toolResults.length, 1)
  assert.deepEqual(step.toolResults[0].content, [{ type: 'text', text: 'FAIL src/x.test.ts' }])
  assert.equal(step.toolResults[0].isError, true)
  assertToolPairing(out.events)
})

test('孤儿 tool 结果（无匹配调用）丢弃并计数，不挂最近一步', () => {
  const out = convertContinueJson(session([
    user('问题'),
    assistant('回答'),
    toolResult('来路不明的结果', 'call_missing'),
  ]), { createdAt: TS })
  assert.equal(out.toolCalls, 0)
  assert.equal(out.droppedOrphanResults, 1)
  assert.equal(out.events.filter((e) => e.type === 'tool/result').length, 0)
})

test('conversationSummary → 原生压缩检查点（history 全量留日志，模型见摘要+之后）', () => {
  const history = [
    user('第一件事'),
    assistant('做完了', { conversationSummary: '此前在改登录页。' }),
    user('第二件事'),
    assistant('好的'),
  ]
  const out = convertContinueJson(session(history), { createdAt: TS })
  assert.equal(out.turns.length, 2) // 压缩不裁剪：两轮都在日志里
  assert.equal(out.compactionSummaries, 1)
  assert.equal(out.compacted, true)
  assert.equal(out.compactions, 1)
  assert.equal(assertNativeCompaction(out.events), 1)
  assert.equal(out.turns[0].shadowed, true)
  assert.equal(out.turns[1].compaction.summary, '此前在改登录页。')
  // 模型视角 = 声明 → 摘要检查点 → 压缩点之后的内容；压缩前内容不进模型视角但留在日志
  assert.deepEqual(derivedSurfaceMessages(out.events).slice(2), ['user:此前在改登录页。', 'user:第二件事', 'assistant:好的'])
  assert.ok(!derivedSurfaceMessages(out.events).some((d) => d.includes('做完了')))
  assert.ok(out.events.some((e) => JSON.stringify(e.data).includes('做完了')))

  // fullHistory：不发检查点，摘要退回既有形态（reasoning 块）
  const full = convertContinueJson(session(history), { createdAt: TS, fullHistory: true })
  assert.equal(full.compacted, undefined)
  assert.equal(full.compactionSummaries, 1)
  const blocks = full.turns[0].steps[0].content.filter((b) => b.type === 'reasoning')
  assert.equal(blocks.length, 1)
  assert.match(blocks[0].text, /^Previous conversation summary:\n\n此前在改登录页。$/)
})

test('显式标题（非默认 New Session）→ 钉 session/title 事件', () => {
  const out = convertContinueJson(session([user('随便问问'), assistant('嗯')], { title: '修登录页分页' }), { createdAt: TS })
  const titles = out.events.filter((e) => e.type === 'session/title')
  assert.equal(titles.length, 1)
  assert.equal(titles[0].data.title, '修登录页分页')
  assert.equal(out.title, '修登录页分页')
})

test('user content 为 parts 数组时取文本块；空 user（CLI 把正文放进 editorState）不开轮', () => {
  const out = convertContinueJson(session([
    item({ id: 'u1', role: 'user', content: [{ type: 'text', text: '第一行' }, { type: 'image_url', imageUrl: { url: 'x' } }, { type: 'text', text: '第二行' }] }),
    assistant('好的'),
    item({ id: 'u2', role: 'user', content: '' }, { editorState: { doc: '正文在 UI 态里' } }),
    assistant('继续'),
  ]), { createdAt: TS })
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].prompt, '第一行\n第二行')
})

test('转录未记录结果的调用 → synthesizeSession 补空结果，配对不变量仍成立', () => {
  const out = convertContinueJson(session([
    user('看看'),
    assistantCalling('', [call('call_x', 'ls')]),
  ]), { createdAt: TS })
  assert.equal(out.toolCalls, 1)
  const results = out.events.filter((e) => e.type === 'tool/result')
  assert.equal(results.length, 1)
  assert.deepEqual(results[0].data.message.content[0].content, []) // 不虚构输出
  assertToolPairing(out.events)
})

test('toolCallStates.output 多种形态：字符串条目与对象条目拼接；不可解析形态回退空结果', () => {
  const joined = convertContinueJson(session([
    user('跑'),
    assistant('', {
      toolCallStates: [{
        toolCallId: 'c1',
        toolCall: call('c1', 'bash', '{"cmd":"x"}'),
        status: 'done',
        output: ['第一行', { content: '第二行' }, null],
      }],
    }),
  ]), { createdAt: TS })
  assert.deepEqual(joined.turns[0].steps[0].toolResults[0].content, [{ type: 'text', text: '第一行\n第二行' }])

  // output 非字符串/数组（如数字）→ 不虚构结果，交给 synthesizeSession 补空结果
  const unusable = convertContinueJson(session([
    user('跑'),
    assistant('', {
      toolCallStates: [{ toolCallId: 'c2', toolCall: call('c2', 'bash', '{}'), status: 'done', output: 42 }],
    }),
  ]), { createdAt: TS })
  assert.equal(unusable.turns[0].steps[0].toolResults.length, 0)
  assert.deepEqual(unusable.events.filter((e) => e.type === 'tool/result')[0].data.message.content[0].content, [])
  assertToolPairing(unusable.events)

  // 调用没带 arguments（function 里缺字段）→ 归一为空对象，不落 undefined
  const noArgs = convertContinueJson(session([
    user('看看'),
    assistantCalling('', [{ id: 'c3', type: 'function', function: { name: 'ls' } }]),
  ]), { createdAt: TS })
  assert.deepEqual(noArgs.turns[0].steps[0].toolCalls, [{ id: 'c3', name: 'ls', arguments: '{}' }])

  // 参数已是对象（部分写入路径不 stringify）→ 序列化后落盘，保持 wire 形态一致
  const objArgs = convertContinueJson(session([
    user('看看'),
    assistantCalling('', [{ id: 'c4', type: 'function', function: { name: 'read_file', arguments: { filepath: 'a.ts' } } }]),
  ]), { createdAt: TS })
  assert.deepEqual(objArgs.turns[0].steps[0].toolCalls, [{ id: 'c4', name: 'read_file', arguments: '{"filepath":"a.ts"}' }])
})

test('非 Continue 结构（无 history 数组 / 非法 JSON）→ skipReason，不产出事件', () => {
  const noHistory = convertContinueJson(JSON.stringify({ sessionId: 'x', messages: [] }))
  assert.equal(noHistory.meta, null)
  assert.equal(noHistory.skipReason, 'not a Continue session (no history array)')
  assert.equal(noHistory.events.length, 0)

  const bad = convertContinueJson('{not json')
  assert.equal(bad.meta, null)
  assert.equal(bad.skipReason, 'not a Continue session (invalid JSON)')
})

test('readContinueIndex：解析索引数组，脏条目跳过（非数组 / 缺 sessionId）', () => {
  const index = readContinueIndex(JSON.stringify([
    { sessionId: SID, title: '修登录页', dateCreated: String(TS), workspaceDirectory: CWD},
    { title: '缺 id' },
    null,
    { sessionId: 'other', title: '', dateCreated: '2026-09-15T00:00:00.000Z'},
  ]))
  assert.equal(index.size, 2)
  const first = index.get(SID)
  assert.equal(first.title, '修登录页')
  assert.equal(first.createdAt, TS)
  assert.equal(first.cwd, CWD)
  const second = index.get('other')
  assert.equal(second.title, '')
  assert.equal(second.cwd, null)
  assert.equal(second.createdAt, Date.parse('2026-09-15T00:00:00.000Z'))

  assert.equal(readContinueIndex('{oops').size, 0)
  assert.equal(readContinueIndex('{"sessionId":"x"}').size, 0)
})
