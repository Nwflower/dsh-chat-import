// convert-db-sources.test.mjs — 库源转换（opencode 双世代）
// V1/V2 表形状、压缩边界取最近 completed compaction。
// 由 test/convert.test.mjs 按主题拆出（纯移动：用例与断言未改）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertOpencodeJson, SESSION_FORMAT_VERSION } from '../lib/convert/index.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { assertToolPairing, assertMessageOrderLegal, assertSeqContinuity } from './_support/session-invariants.mjs'
import { loadFixture } from './_support/fixtures.mjs'
const load = loadFixture

test('convertOpencodeJson: 简单问答、元数据、平衡回合', () => {
  const out = convertOpencodeJson(load('opencode-simple.json'), { sourcePath: 'E:/demo/opencode/opencode.db' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 2)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.meta.id, 'import-ses_simple001')
  assert.equal(out.meta.sourceId, 'ses_simple001')
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.cwd, 'E:/demo/opencode-proj')
  assert.equal(out.meta.createdAt, 1786000000000)
  assert.equal(out.title, 'Fix the build')
  assertEnvelopeHygiene(out.events)
  const types = out.events.map((e) => e.type)
  // 回合平衡：最后一个（非 title）事件是 turn/end；seq 连续
  assert.equal([...types].reverse().find((t) => t !== 'session/title'), 'turn/end')
  assertSeqContinuity(out.events)
  for (const e of out.events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result')) {
    assert.equal(e.surfaceOp, 'append')
  }
  const user = out.events.find((e) => e.type === 'user/message' && e.data.source.kind === 'user').data
  assert.equal(user.content[0].text, '帮我看看构建失败的原因')
  // 消息级 model（字符串）优先于会话级 model
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.equal(asst.content[0].text, '是缺少依赖，补上即可。')
  assert.deepEqual(asst.source, { kind: 'model', provider: 'opencode', model: 'deepseek-v4-pro' })
  // title → session/title 事件
  const titleEv = out.events.find((e) => e.type === 'session/title')
  assert.equal(titleEv.data.title, 'Fix the build')
  assert.deepEqual(titleEv.data.source, { kind: 'user' })
})

test('convertOpencodeJson: reasoning + tool/call + tool/result（error 标记、sourceEventSeqs 关联）', () => {
  const out = convertOpencodeJson(load('opencode-tool.json'))
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 2)
  const calls = out.events.filter((e) => e.type === 'tool/call')
  const results = out.events.filter((e) => e.type === 'tool/result')
  assert.equal(calls.length, 2)
  assert.equal(results.length, 2)
  assert.equal(calls[0].data.name, 'bash')
  assert.equal(calls[0].data.callId, 'call_01')
  assert.equal(calls[0].data.arguments, '{"command":"cargo run"}')
  // 每个 result 通过 sourceEventSeqs 关联自己的 call
  assert.deepEqual(results[0].sourceEventSeqs, [calls[0].seq])
  assert.deepEqual(results[1].sourceEventSeqs, [calls[1].seq])
  assert.equal(results[0].data.message.content[0].toolCallId, 'call_01')
  assert.equal(results[0].data.message.content[0].content[0].text, "thread 'main' panicked at src/main.rs:12")
  assert.equal(results[0].data.message.content[0].isError, undefined)
  // 第二个工具是 error → isError 标记
  assert.equal(results[1].data.message.content[0].isError, true)
  assert.equal(results[1].data.message.content[0].content[0].text, 'error: compilation failed')
  // reasoning → reasoning block；tool-call 出现在 assistant content 里
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  const kinds = asst.content.map((c) => c.type)
  assert.ok(kinds.includes('reasoning'))
  assert.ok(kinds.includes('text'))
  assert.ok(kinds.includes('tool-call'))
  assert.equal(asst.content.find((c) => c.type === 'reasoning').text, '先跑一下复现命令看崩溃栈。')
  // 平铺 modelID 优先
  assert.deepEqual(asst.source, { kind: 'model', provider: 'opencode', model: 'deepseek-v4-max' })
  assertMessageOrderLegal(out.events)
})

test('convertOpencodeJson: file/patch/subtask → 内容块，结构块跳过，空 output 工具仍配对', () => {
  const out = convertOpencodeJson(load('opencode-extras.json'))
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  const texts = asst.content.filter((c) => c.type === 'text').map((c) => c.text)
  // file part 带内联字节（data URL）→ IR image 块（宿主层落成附件），不再是文本占位
  assert.deepEqual(asst.content.filter((c) => c.type === 'image'),
    [{ type: 'image', data: 'AAAA', mediaType: 'image/png' }])
  assert.ok(texts.includes('[patch: 2 files]'))
  assert.ok(texts.includes('[subtask: npm test — 跑测试]'))
  assert.equal(out.imagesDegraded, undefined, '有字节：没有降级')
  // step-start / step-finish / compaction 不产生任何内容块
  assert.ok(!asst.content.some((c) => c.type === 'step-start' || c.type === 'step-finish' || c.type === 'compaction'))
  // 工具 state 无 output → 仍发 result（空文本），保持 call/result 配对
  const call = out.events.find((e) => e.type === 'tool/call')
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.equal(call.data.arguments, '{"command":"git diff"}')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.equal(result.data.message.content[0].content[0].text, '')
  assert.equal(result.data.message.content[0].isError, undefined)
  // 空 output 已有 result → 兜底不重复补：call/result 严格 1:1
  assertToolPairing(out.events)
  // 消息无模型 → 回退会话级 model（对象解析 id）
  assert.deepEqual(asst.source, { kind: 'model', provider: 'opencode', model: 'deepseek-v4-flash' })
})

test('convertOpencodeJson: 模型回退链（msg.modelID → msg.model.modelID → session.model.id）', () => {
  const raw = JSON.stringify({
    id: 'ses_chain',
    createdAt: 1786000300000,
    model: { id: 'session-model', providerID: 'opencode-go' },
    messages: [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'm2', role: 'assistant', model: { modelID: 'msg-object-model' }, parts: [{ type: 'text', text: 'a' }] },
      { id: 'm3', role: 'assistant', parts: [{ type: 'text', text: 'b' }] },
    ],
  })
  const out = convertOpencodeJson(raw)
  assert.equal(out.turns.length, 1) // 一个 user → 两个 assistant 步
  const sources = out.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message.source)
  assert.equal(sources[0].model, 'msg-object-model') // 消息级对象 modelID 优先
  assert.equal(sources[1].model, 'session-model') // 无消息级 → 会话级 id
  // 全程无消息级/会话级模型时回退 provider 名
  const bare = convertOpencodeJson(JSON.stringify({
    id: 'ses_bare',
    messages: [
      { id: 'b1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'b2', role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
    ],
  }))
  assert.equal(bare.events.find((e) => e.type === 'assistant/message').data.message.source.model, 'opencode')
})

test('convertOpencodeJson: 非法 JSON / 无 messages 返回空并 skipped（对齐 Gemini 失败形态）', () => {
  const bad = convertOpencodeJson('not json')
  assert.equal(bad.meta, null)
  assert.equal(bad.skipped, 1)
  assert.deepEqual(bad.events, [])
  assert.deepEqual(bad.turns, [])
  assert.equal(bad.messages, 0)
  assert.equal(bad.toolCalls, 0)
  const wrong = convertOpencodeJson('{"id":"x"}')
  assert.equal(wrong.meta, null)
  assert.equal(wrong.skipped, 1)
})

test('convertOpencodeJson: sessionId 覆盖参数生效、空 messages 不产生会话', () => {
  const out = convertOpencodeJson(load('opencode-simple.json'), { sessionId: 'custom-opencode' })
  assert.equal(out.meta.id, 'custom-opencode')
  const ids = out.events.filter((e) => e.type === 'user/message').map((e) => e.data.id)
  // 首条是环境变更声明（import:custom-opencode:env），真实提问在其后
  assert.ok(ids.some((id) => id.startsWith('import:custom-opencode:u1')))
  // 无 messages → 空事件，由 index 层计 skipped
  const empty = convertOpencodeJson('{"id":"ses_empty","createdAt":1,"messages":[]}')
  assert.equal(empty.turns.length, 0)
  assert.equal(empty.events.length, 0)
})

test('convertOpencodeJson: 压缩摘要 summary → 首个 assistant 步骤前置 reasoning 块', () => {
  const raw = JSON.stringify({
    id: 'ses_comp',
    title: 'Long task',
    directory: 'E:/demo/opencode-proj',
    createdAt: 1786000000000,
    summary: '前面做过的所有事都被压成这段摘要。',
    messages: [
      { id: 'msg-c1', role: 'user', createdAt: 1, parts: [{ type: 'text', text: '继续' }] },
      { id: 'msg-c2', role: 'assistant', createdAt: 2, parts: [{ type: 'text', text: '好的' }] },
    ],
  })
  const out = convertOpencodeJson(raw)
  const firstStep = out.turns[0].steps[0]
  assert.equal(firstStep.content[0].type, 'reasoning')
  assert.equal(firstStep.content[0].text, '前面做过的所有事都被压成这段摘要。')
  // 摘要只前置一次，不重复
  const reasoning = out.events
    .filter((e) => e.type === 'assistant/message')
    .flatMap((e) => e.data.message.content)
    .filter((c) => c.type === 'reasoning')
  assert.equal(reasoning.length, 1)
})
