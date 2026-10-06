// convert-json-sources.test.mjs — 单文件 JSON 源转换（chatgpt / gemini）
// 分支树还原、工具消息结构化。
// 由 test/convert.test.mjs 按主题拆出（纯移动：用例与断言未改）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertChatgptJson, convertGeminiJson } from '../lib/convert/index.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { assertToolPairing, assertMessageOrderLegal, assertSeqContinuity } from './_support/session-invariants.mjs'
import { loadFixture } from './_support/fixtures.mjs'
const load = loadFixture

test('convertChatgptJson: 一文件多会话、多轮、mapping 主线程', () => {
  const out = convertChatgptJson(load('chatgpt-export.json'), { sourcePath: 'D:\\demo\\chatgpt\\conversations.json' })
  assert.equal(out.records, 3)
  assert.equal(out.conversations.length, 2) // conv-003 只有 system，被跳过
  assert.equal(out.skipped, 1)

  // conv-001：user → assistant → user
  const c1 = out.conversations.find((c) => c.meta.id === 'import-conv-001')
  assert.ok(c1)
  assert.equal(c1.title, 'Python debugging help')
  assert.equal(c1.turns.length, 2)
  assert.equal(c1.messages, 3)
  assert.equal(c1.toolCalls, 0)
  assertEnvelopeHygiene(c1.events)
  const types1 = c1.events.map((e) => e.type)
  // 事件以 turn/end 平衡收尾（session/title 钉在最后，不破坏回合平衡）
  assert.equal(types1.filter((t) => t === 'turn/end').length, 2)
  assert.equal([...types1].reverse().find((t) => t !== 'session/title'), 'turn/end')
  assertSeqContinuity(c1.events)
  // 时间戳：Unix 秒 → ms
  assert.equal(c1.meta.createdAt, 1710000000 * 1000)
  // assistant source
  const asst = c1.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.source, { kind: 'model', provider: 'chatgpt', model: 'chatgpt' })

  // conv-002：分支取最后 child（n4），占位节点 n3 跳过
  const c2 = out.conversations.find((c) => c.meta.id === 'import-conv-002')
  assert.ok(c2)
  assert.equal(c2.turns.length, 1)
  assertEnvelopeHygiene(c2.events)
  const asst2 = c2.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message.content[0].text)
  assert.deepEqual(asst2, ['Here is a simple aglio e olio recipe.', 'Actually, use cacio e pepe instead.'])
})

test('convertChatgptJson: 非数组 / 非法 JSON 返回空并计数 skipped', () => {
  const out = convertChatgptJson('not json at all')
  assert.equal(out.conversations.length, 0)
  assert.equal(out.skipped, 1)
  const obj = convertChatgptJson('{"a":1}')
  assert.equal(obj.conversations.length, 0)
  assert.equal(obj.skipped, 1)
})

test('convertChatgptJson: 无 cwd（ChatGPT 是聊天，不归组工作区）', () => {
  const out = convertChatgptJson(load('chatgpt-export.json'))
  const c1 = out.conversations.find((c) => c.meta.id === 'import-conv-001')
  assert.equal(c1.meta.cwd, undefined)
})

test('convertChatgptJson: importSystemPrompt 开关收集 system 角色为上下文注入', () => {
  const conv = {
    id: 'conv-sp-001',
    title: 'System prompt chat',
    create_time: 1710000000,
    mapping: {
      s1: { id: 's1', parent: null, children: ['u1'], message: { id: 'm0', author: { role: 'system' }, content: { content_type: 'text', parts: ['You are a helpful assistant.'] } } },
      u1: { id: 'u1', parent: 's1', children: ['a1'], message: { id: 'm1', author: { role: 'user' }, content: { content_type: 'text', parts: ['hi'] } } },
      a1: { id: 'a1', parent: 'u1', children: [], message: { id: 'm2', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['hello'] } } },
    },
  }
  const off = convertChatgptJson(JSON.stringify([conv]))
  assert.equal(off.conversations.length, 1)
  // 默认关：system 过滤；环境变更声明始终注入（唯一 plugin 注入，不含 system 原文）
  const offPlugin = off.conversations[0].events.filter((e) => e.data && e.data.source && e.data.source.kind === 'plugin')
  assert.equal(offPlugin.length, 1)
  assert.ok(!offPlugin[0].data.content[0].text.includes('You are a helpful assistant.'))
  const on = convertChatgptJson(JSON.stringify([conv]), { importSystemPrompt: true })
  const c1 = on.conversations[0]
  const first = c1.events.find((e) => e.type === 'user/message')
  assert.equal(first.data.source.kind, 'plugin')
  assert.equal(first.data.source.plugin, 'chat-import')
  assert.ok(first.data.content[0].text.includes('You are a helpful assistant.'))
  assert.ok(first.seq > c1.events.find((e) => e.type === 'step/start').seq)
})

test('convertChatgptJson: tool 节点降级为文本块，不再产生孤儿 tool/result', () => {
  // ChatGPT 导出无结构化 tool-call（assistant 从不带 tool_calls 数组）；tool 节点
  // 挂 tool/result 只会产生没有对应 tool/call 的孤儿结果，resume 被模型端拒绝。
  // 按契约降级为最近一步的文本块。
  const raw = JSON.stringify([{
    id: 'conv-tool-001',
    title: 'Tool chat',
    create_time: 1710009000,
    mapping: {
      'n1': {
        id: 'n1',
        message: { id: 'm1', author: { role: 'user' }, content: { content_type: 'text', parts: ['跑一下测试'] }, create_time: 1710009000 },
        parent: null,
        children: ['n2'],
      },
      'n2': {
        id: 'n2',
        message: { id: 'm2', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['好的，执行 npm test。'] }, create_time: 1710009050 },
        parent: 'n1',
        children: ['n3'],
      },
      'n3': {
        id: 'n3',
        message: { id: 'm3', author: { role: 'tool' }, content: { content_type: 'code', parts: ['all tests passed'] }, create_time: 1710009060 },
        parent: 'n2',
        children: [],
      },
    },
  }])
  const out = convertChatgptJson(raw)
  assert.equal(out.conversations.length, 1)
  const c = out.conversations[0]
  // 不再产生 tool/result / tool/call 事件
  assert.equal(c.events.filter((e) => e.type === 'tool/result').length, 0)
  assert.equal(c.toolCalls, 0)
  // 工具文本挂到最近一步的 assistant 消息内容里
  const asst = c.events.find((e) => e.type === 'assistant/message').data.message
  assert.ok(asst.content.some((b) => b.type === 'text' && b.text === 'all tests passed'))
  // 平衡：最后（非 title）事件是 turn/end
  const types = c.events.map((e) => e.type)
  assert.equal([...types].reverse().find((t) => t !== 'session/title'), 'turn/end')
})

test('convertChatgptJson: branch:all 枚举全部分支会话（main = 最后 child 链）', () => {
  // 合成多分支 mapping：root user → assistant A（children: n3 / n4 两条回复分支），
  // n4 分支继续 n5（占位）→ n6（assistant 更正）
  const raw = JSON.stringify([{
    id: 'conv-branch-001',
    title: 'Branch chat',
    create_time: 1710010000,
    mapping: {
      'n1': {
        id: 'n1',
        message: { id: 'm1', author: { role: 'user' }, content: { content_type: 'text', parts: ['怎么煮意面？'] }, create_time: 1710010000 },
        parent: null,
        children: ['n2'],
      },
      'n2': {
        id: 'n2',
        message: { id: 'm2', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['两种做法：'] }, create_time: 1710010100 },
        parent: 'n1',
        children: ['n3', 'n4'],
      },
      'n3': {
        id: 'n3',
        message: { id: 'm3', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['做法 A：aglio e olio。'] }, create_time: 1710010200 },
        parent: 'n2',
        children: [],
      },
      'n4': {
        id: 'n4',
        message: { id: 'm4', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['做法 B：cacio e pepe。'] }, create_time: 1710010300 },
        parent: 'n2',
        children: ['n5'],
      },
      'n5': {
        id: 'n5',
        message: null, // 占位节点
        parent: 'n4',
        children: ['n6'],
      },
      'n6': {
        id: 'n6',
        message: { id: 'm6', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['更正：B 用 pecorino。'] }, create_time: 1710010400 },
        parent: 'n5',
        children: [],
      },
    },
  }])

  // main 模式：只导最后 child 链（n1→n2→n4→n6），n3 分支不出现
  const main = convertChatgptJson(raw, {})
  assert.equal(main.conversations.length, 1)
  const cMain = main.conversations[0]
  assert.equal(cMain.meta.id, 'import-conv-branch-001')
  const mainTexts = cMain.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message.content[0].text)
  assert.deepEqual(mainTexts, ['两种做法：', '做法 B：cacio e pepe。', '更正：B 用 pecorino。'])

  // all 模式：两条 root→leaf 路径各成一会话
  const all = convertChatgptJson(raw, { branch: 'all' })
  assert.equal(all.conversations.length, 2)
  const main2 = all.conversations.find((c) => c.meta.id === 'import-conv-branch-001')
  const branch = all.conversations.find((c) => c.meta.id !== 'import-conv-branch-001')
  assert.ok(main2)
  assert.ok(branch)
  // 主线程与 main 模式一致（最后 child 链）
  const main2Texts = main2.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message.content[0].text)
  assert.deepEqual(main2Texts, ['两种做法：', '做法 B：cacio e pepe。', '更正：B 用 pecorino。'])
  // 分支会话：sourceId 带分支叶子尾缀（registry 幂等键不覆盖）、标题带分支标记
  assert.match(branch.meta.sourceId, /^conv-branch-001-n\d+$/)
  assert.match(branch.title, /Branch chat（分支 /)
  const branchTexts = branch.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message.content[0].text)
  assert.deepEqual(branchTexts, ['两种做法：', '做法 A：aglio e olio。'])
  // 两会话都平衡
  for (const c of all.conversations) {
    const types = c.events.map((e) => e.type)
    assert.equal([...types].reverse().find((t) => t !== 'session/title'), 'turn/end')
  }
})

test('convertChatgptJson: 工具消息还原 tool/call + tool/result（参数结构化 + sourceEventSeqs）', () => {
  const raw = JSON.stringify([{
    id: 'conv-tool2-001',
    title: 'Tool chat 2',
    create_time: 1710020000,
    mapping: {
      'n1': {
        id: 'n1',
        message: { id: 'm1', author: { role: 'user' }, content: { content_type: 'text', parts: ['算一下 1+1'] }, create_time: 1710020000 },
        parent: null,
        children: ['n2'],
      },
      'n2': {
        id: 'n2',
        message: {
          id: 'm2',
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['{"tool_name":"calculator","tool_call_id":"call_abc","args":{"expr":"1+1"}}'] },
          create_time: 1710020100,
        },
        parent: 'n1',
        children: ['n3'],
      },
      'n3': {
        id: 'n3',
        message: { id: 'm3', author: { role: 'tool' }, name: 'calculator', recipient: 'functions.calculator', content: { content_type: 'text', parts: ['2'] }, create_time: 1710020200 },
        parent: 'n2',
        children: ['n4'],
      },
      'n4': {
        id: 'n4',
        message: { id: 'm4', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['结果是 2。'] }, create_time: 1710020300 },
        parent: 'n3',
        children: [],
      },
    },
  }])
  const out = convertChatgptJson(raw, {})
  assert.equal(out.conversations.length, 1)
  const c = out.conversations[0]
  // tool/call 结构化（arguments 保持 JSON 字符串，与 Claude/Codex 语义一致）
  const calls = c.events.filter((e) => e.type === 'tool/call')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].data.callId, 'call_abc')
  assert.equal(calls[0].data.name, 'calculator')
  assert.equal(calls[0].data.arguments, '{"expr":"1+1"}')
  assert.equal(c.toolCalls, 1)
  // tool/result 配对（sourceEventSeqs 指向 call 的 seq）
  const results = c.events.filter((e) => e.type === 'tool/result')
  assert.equal(results.length, 1)
  assert.equal(results[0].data.message.content[0].toolCallId, 'call_abc')
  assert.equal(results[0].data.message.content[0].content[0].text, '2')
  assert.deepEqual(results[0].sourceEventSeqs, [calls[0].seq])
  // 工具调用内容块不进 assistant 文本（不重复）
  const asst = c.events.find((e) => e.type === 'assistant/message').data.message
  assert.ok(!asst.content.some((b) => b.type === 'text' && b.text.includes('tool_name')))
  assertToolPairing(c.events)
})

test('convertGeminiJson: 简单会话、元数据、平衡回合', () => {
  const out = convertGeminiJson(load('gemini-simple.json'), { sourcePath: 'D:\\demo\\gemini\\session-abc.json' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 2)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.meta.id, 'import-b26d7f99-0116-4d1d-b125-98c228a4b933')
  assert.equal(out.meta.sourceId, 'b26d7f99-0116-4d1d-b125-98c228a4b933')
  assert.equal(out.meta.cwd, 'D:\\demo\\gemini-proj') // directories[0] → cwd
  assert.ok(out.meta.createdAt) // startTime ISO → ms
  assertEnvelopeHygiene(out.events)
  const types = out.events.map((e) => e.type)
  assert.equal([...types].reverse().find((t) => t !== 'session/title'), 'turn/end')
  assertSeqContinuity(out.events)
  // 用户 parts 数组 → prompt
  const user = out.events.find((e) => e.type === 'user/message' && e.data.source.kind === 'user').data
  assert.equal(user.content[0].text, 'Create a basic python interpreter in rust.')
  // thoughts → reasoning；真实 model
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.ok(asst.content.some((c) => c.type === 'reasoning'))
  assert.deepEqual(asst.source, { kind: 'model', provider: 'gemini', model: 'gemini-3-flash-preview' })
})

test('convertGeminiJson: 内联 toolCalls → tool/call + tool/result（含错误标记）', () => {
  const out = convertGeminiJson(load('gemini-tool.json'))
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 2)
  const calls = out.events.filter((e) => e.type === 'tool/call')
  const results = out.events.filter((e) => e.type === 'tool/result')
  assert.equal(calls.length, 2)
  assert.equal(results.length, 2)
  assert.equal(calls[0].data.name, 'list_directory')
  assert.equal(calls[0].data.arguments, '{"path":"."}')
  // tool/result 与 tool/call 通过 sourceEventSeqs 关联
  assert.deepEqual(results[0].sourceEventSeqs, [calls[0].seq])
  assert.equal(results[0].data.message.content[0].content[0].text, 'src\nCargo.toml')
  // 第二个调用是 error → isError 标记
  assert.equal(results[1].data.message.content[0].isError, true)
  assert.equal(results[1].data.message.content[0].content[0].text, 'Compilation error: missing semicolon')
  // info 消息跳过：没有多余回合
  assert.equal(out.turns.length, 1)
  assertMessageOrderLegal(out.events)
})

test('convertGeminiJson: toolCalls 无 result 补发空 tool/result', () => {
  // 调用没有内联 result（geminiToolResultText 返回 null）→ 合成空 result 保证配对
  const raw = JSON.stringify({
    sessionId: 'gemini-cut-001',
    startTime: '2026-04-17T18:09:18.567Z',
    directories: ['D:\\demo\\gemini-proj'],
    messages: [
      { id: 'u1', type: 'user', content: [{ text: '跑一下' }] },
      {
        id: 'g1', type: 'gemini', content: '好',
        model: 'gemini-3-flash-preview',
        toolCalls: [
          { id: 'tc_01', name: 'run_shell_command', args: { command: 'npm test' }, status: 'success', result: [] },
        ],
      },
    ],
  })
  const out = convertGeminiJson(raw)
  assert.equal(out.toolCalls, 1)
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.ok(result)
  assert.deepEqual(result.data.message.content[0].content, [])
  assert.equal(result.data.message.content[0].toolCallId, 'tc_01')
  assertToolPairing(out.events)
  assert.equal(out.events.at(-1).type, 'turn/end')
})

test('convertGeminiJson: 多轮切分、kind 缺失兼容', () => {
  const out = convertGeminiJson(load('gemini-multi-turn.json'))
  assert.equal(out.turns.length, 2)
  const starts = out.events.filter((e) => e.type === 'turn/start')
  assert.equal(starts.length, 2)
  const users = out.events.filter((e) => e.type === 'user/message' && e.data.source.kind === 'user')
  assert.equal(users.length, 2)
})

test('convertGeminiJson: 非法 JSON / 非会话结构返回空并 skipped', () => {
  const bad = convertGeminiJson('not json')
  assert.equal(bad.meta, null)
  assert.equal(bad.skipped, 1)
  const wrong = convertGeminiJson('{"foo":1}')
  assert.equal(wrong.meta, null)
  assert.equal(wrong.skipped, 1)
})
