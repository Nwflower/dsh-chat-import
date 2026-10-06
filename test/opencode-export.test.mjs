// opencode-export.test.mjs — REQ-79 DSH 会话 → opencode `import` JSON（纯函数）
//
// 契约来源是上游源码（packages/opencode/src/cli/cmd/import.ts 的 decodeUnknownSync +
// packages/schema/src/v1/session.ts 的 SessionV1.Info/Part、packages/opencode/src/session/
// session.ts 的 Session.Info），本文件把其中**可在本地判定**的硬约束钉住：id 前缀、
// 必填字段、类型、part 的 messageID 外键、以及「同一输入 → 同一组 id」的确定性。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serializeOpencodeJson, buildOpencodeImportDoc, verifyOpencodeImportJson } from '../lib/export/index.mjs'
import { convertClaudeJsonl, convertOpencodeJson, exportDegradations } from '../lib/convert/index.mjs'
import { mapOpencodeToolName, unmapOpencodeToolName } from '../lib/convert/opencode.mjs'
import { loadFixture } from './_support/fixtures.mjs'

const T = 1785000000000

// 合成 DSH 会话事件（含 thinking / 工具调用 / 报错结果），不掺真实 transcript
function syntheticEvents(over = {}) {
  return [
    { type: 'turn/start', seq: 0, time: T, data: { turn: 0 } },
    { type: 'user/message', seq: 1, time: T + 1, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '帮我查一下构建失败的原因' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, time: T + 2, data: { turn: 0, step: 1, stream: [], message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '先看日志。' }, { type: 'reasoning', text: '先读构建输出' }], source: { kind: 'model', provider: 'anthropic', model: 'claude-x' } } } },
    { type: 'tool/call', seq: 3, time: T + 3, data: { turn: 0, step: 1, callId: 'call-1', name: 'web_search', arguments: '{"query":"pnpm build fail"}' } },
    { type: 'tool/result', seq: 4, time: T + 4, data: { turn: 0, step: 1, message: { id: 't1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: '命中 3 条' }] }], source: { kind: 'tool', callId: 'call-1' } } } },
    { type: 'assistant/message', seq: 5, time: T + 5, data: { turn: 1, step: 1, stream: [], message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: '是缺依赖。' }], source: { kind: 'model', provider: 'anthropic', model: 'claude-x' } } } },
    { type: 'tool/call', seq: 6, time: T + 6, data: { turn: 1, step: 1, callId: 'call-2', name: 'Bash', arguments: '{"command":"pnpm i"}' } },
    { type: 'tool/result', seq: 7, time: T + 7, data: { turn: 1, step: 1, message: { id: 't2', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-2', content: [{ type: 'text', text: 'ERR_PNPM' }], isError: true }], source: { kind: 'tool', callId: 'call-2' } } } },
    ...(over.extra || []),
  ]
}

const serialize = (over = {}) => serializeOpencodeJson({
  meta: { version: 2, id: 'import-sess-1', createdAt: T, cwd: 'D:\\demo\\proj' },
  events: syntheticEvents(over),
  sessionUuid: over.sessionUuid || 'import-sess-1',
  cwd: 'D:\\demo\\proj',
  title: over.title === undefined ? '构建失败排查' : over.title,
})

test('serializeOpencodeJson：产出 opencode import 可读文档（id 前缀 / 必填 / 类型全部合法）', () => {
  const out = serialize()
  const check = verifyOpencodeImportJson(out.json)
  assert.deepEqual(check.errors ?? [], [], '结构校验应全绿')
  assert.equal(check.ok, true)
  assert.ok(out.json.endsWith('\n'), '文件以恰好一个换行结尾')
  assert.equal(out.json.trimEnd().endsWith('}'), true)

  const doc = JSON.parse(out.json)
  // 会话 info：id 前缀 ses、slug/title/version 必填、time 是整数毫秒
  assert.match(doc.info.id, /^ses_/)
  assert.equal(doc.info.title, '构建失败排查')
  assert.equal(doc.info.slug, '构建失败排查')
  assert.equal(typeof doc.info.version, 'string')
  assert.equal(doc.info.time.created, T)
  assert.ok(Number.isInteger(doc.info.time.updated))
  // projectID / directory / path 由 opencode 导入端覆盖 → 生成端不写（写了也会被覆盖）
  assert.equal(doc.info.projectID, undefined)
  assert.equal(doc.info.directory, undefined)
  // 两条轮次 = 1 user + 1 assistant，加上无 user 的第 2 轮 assistant
  assert.deepEqual(doc.messages.map((m) => m.info.role), ['user', 'assistant', 'assistant'])
  for (const m of doc.messages) {
    assert.match(m.info.id, /^msg_/)
    assert.match(m.info.sessionID, /^ses_/)
    assert.ok(m.parts.length > 0)
    for (const p of m.parts) {
      // 每个 part 的三个 base 字段都在（导入端会丢掉它们，但解码要求存在）
      assert.match(p.id, /^prt_/)
      assert.match(p.sessionID, /^ses_/)
      assert.equal(p.messageID, m.info.id)
    }
  }
  const user = doc.messages[0]
  assert.equal(user.info.agent, 'build')
  assert.deepEqual(user.info.model, { providerID: 'unknown', modelID: 'unknown' })
  assert.equal(user.parts[0].type, 'text')
  assert.equal(user.parts[0].text, '帮我查一下构建失败的原因')
})

test('serializeOpencodeJson：assistant 的必填用量字段写 0 并计入 usageUnknown（不静默）', () => {
  const out = serialize()
  const doc = JSON.parse(out.json)
  const assistant = doc.messages.find((m) => m.info.role === 'assistant')
  assert.equal(assistant.info.cost, 0)
  assert.deepEqual(assistant.info.tokens, { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
  assert.equal(assistant.info.mode, 'build')
  assert.deepEqual(assistant.info.path, { cwd: 'D:\\demo\\proj', root: 'D:\\demo\\proj' })
  assert.equal(assistant.info.parentID, doc.messages[0].info.id, 'parentID 指向同一轮的 user 消息')
  // 用量未知按规则表上报为 degradation（REQ-21：有损项必须显式）
  assert.equal(out.usageUnknown, doc.messages.filter((m) => m.info.role === 'assistant').length)
  const degs = exportDegradations(out)
  assert.deepEqual(degs, [{ id: 'usage-unknown', kind: 'usageUnknown', strategy: 'text-fallback', count: out.usageUnknown }])
})

test('serializeOpencodeJson：事件带 provider 回报 usage → tokens 如实回填，不计 usageUnknown', () => {
  const out = serialize({
    extra: [],
  })
  // 基线：合成事件无 usage → 全部写 0
  assert.ok(out.usageUnknown > 0)
  const withUsage = serializeOpencodeJson({
    meta: { version: 2, id: 'import-sess-1', createdAt: T, cwd: 'D:\\demo\\proj' },
    events: syntheticEvents().map((e) => e.type === 'assistant/message' && e.data.message.id === 'a1'
      ? { ...e, data: { ...e.data, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, reasoningTokens: 5 } } }
      : e),
    sessionUuid: 'import-sess-1',
    cwd: 'D:\\demo\\proj',
    title: '构建失败排查',
  })
  const doc = JSON.parse(withUsage.json)
  const a1 = doc.messages.find((m) => m.parts.some((p) => p.type === 'text' && p.text === '先看日志。'))
  assert.deepEqual(a1.info.tokens, { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 40 } })
  // 只有带 usage 的那条不计；另一条 assistant 仍写 0 并计数
  assert.equal(withUsage.usageUnknown, 1)
})

test('serializeOpencodeJson：thinking → reasoning part（带必填 time.start），工具调用/结果 → tool part', () => {
  const doc = JSON.parse(serialize().json)
  const types = doc.messages.flatMap((m) => m.parts.map((p) => p.type))
  assert.ok(types.includes('reasoning'))
  assert.ok(types.includes('tool'))
  const reasoning = doc.messages.flatMap((m) => m.parts).find((p) => p.type === 'reasoning')
  assert.equal(reasoning.text, '先读构建输出')
  assert.ok(Number.isInteger(reasoning.time.start) && reasoning.time.start >= 0, 'reasoning.time.start 必填且为整数')

  const tools = doc.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool')
  assert.equal(tools.length, 2)
  const search = tools.find((p) => p.callID === 'call-1')
  assert.equal(search.tool, 'websearch', 'DSH 名 web_search 反查成 opencode 本地名')
  assert.deepEqual(search.state.input, { query: 'pnpm build fail' })
  assert.equal(search.state.status, 'completed')
  assert.equal(search.state.output, '命中 3 条')
  // completed 的 title / metadata 是必填（running/error 才可选）
  assert.equal(typeof search.state.title, 'string')
  assert.deepEqual(search.state.metadata, {})

  const failed = tools.find((p) => p.callID === 'call-2')
  assert.equal(failed.tool, 'bash', 'Claude 源的大写 Bash 归一成 opencode 的 bash')
  assert.equal(failed.state.status, 'error')
  assert.equal(failed.state.error, 'ERR_PNPM')
})

test('serializeOpencodeJson：id 由会话 id 派生 → 同一输入重复导出得到同一组 id（重导幂等）', () => {
  const a = JSON.parse(serialize().json)
  const b = JSON.parse(serialize().json)
  const ids = (doc) => [doc.info.id, ...doc.messages.flatMap((m) => [m.info.id, ...m.parts.map((p) => p.id)])]
  assert.deepEqual(ids(a), ids(b))
  // 不同会话源 → 不同会话 id
  const other = JSON.parse(serialize({ sessionUuid: 'import-sess-2' }).json)
  assert.notEqual(other.info.id, a.info.id)
})

test('serializeOpencodeJson：注入消息跳过并计数；无标题时回退标题/ slug 不为空', () => {
  const out = serialize({
    title: '',
    extra: [{ type: 'user/message', seq: 8, time: T + 8, data: { id: 'inj', role: 'user', content: [{ type: 'text', text: '环境变更声明' }], source: { kind: 'plugin' } } }],
  })
  assert.equal(out.skippedInjections, 1)
  const doc = JSON.parse(out.json)
  assert.equal(doc.info.title, 'DSH import')
  assert.ok(doc.info.slug.length > 0)
  // 注入消息不进 messages
  assert.equal(doc.messages.some((m) => m.parts.some((p) => p.text === '环境变更声明')), false)
})

test('serializeOpencodeJson：无可导出内容 → 抛错（不产出空会话）', () => {
  assert.throws(() => serializeOpencodeJson({ meta: { id: 'x', createdAt: T }, events: [], sessionUuid: 'x' }), /无可导出内容/)
  assert.throws(() => serializeOpencodeJson({ meta: { id: 'x', createdAt: T }, events: [{ type: 'turn/start', seq: 0, time: T, data: {} }], sessionUuid: 'x' }), /无可导出内容/)
})

test('往返：导出的文档按宿主抽取形状喂回 convertOpencodeJson → 同一段对话', () => {
  const out = serialize()
  const doc = JSON.parse(out.json)
  // 复刻 lib/sources/opencode.mjs 从三表抽取的中间 JSON（message.data → role/model，part.data → parts）
  const chat = {
    id: doc.info.id,
    title: doc.info.title,
    directory: doc.info.metadata && doc.info.metadata.dshCwd,
    createdAt: doc.info.time.created,
    messages: doc.messages.map((m) => ({
      role: m.info.role,
      createdAt: m.info.time.created,
      ...(typeof m.info.modelID === 'string' ? { modelID: m.info.modelID } : {}),
      parts: m.parts,
    })),
  }
  const back = convertOpencodeJson(JSON.stringify(chat), { sourcePath: 'D:\\demo\\sess-1.opencode.json' })
  // 合成事件里只有一个 user 提问（第二条 assistant 属同一轮），故 1 轮 2 步
  assert.equal(back.turns.length, 1)
  assert.equal(back.turns[0].steps.length, 2)
  assert.deepEqual(back.turns.map((t) => t.prompt), ['帮我查一下构建失败的原因'])
  assert.equal(back.turns[0].steps.length, 2)
  const step1 = back.turns[0].steps[0]
  assert.equal(step1.toolCalls[0].name, 'web_search', '反查表是双向的：opencode 名再导回来仍是 DSH 名')
  assert.equal(step1.toolResults[0].isError, false)
  const step2 = back.turns[0].steps[1]
  assert.deepEqual(step2.content.map((c) => c.type), ['text', 'tool-call'])
  assert.equal(step2.toolCalls[0].name, 'bash', 'opencode 本地名 bash 没有再被改名')
  assert.equal(step2.toolResults[0].isError, true)
  assert.equal(back.meta.cwd, 'D:\\demo\\proj')
})

test('双向工具名映射：五个别名互逆，未知名原样保留', () => {
  for (const [local, dsh] of [['websearch', 'web_search'], ['webfetch', 'web_fetch'], ['question', 'ask_user_question'], ['todowrite', 'todo_write'], ['task', 'subagent']]) {
    assert.equal(mapOpencodeToolName(local), dsh)
    assert.equal(unmapOpencodeToolName(dsh), local)
  }
  assert.equal(unmapOpencodeToolName('Bash'), 'bash')
  assert.equal(unmapOpencodeToolName('shell_command'), 'shell_command')
  assert.equal(mapOpencodeToolName('shell_command'), 'shell_command')
})

test('verifyOpencodeImportJson：抓出前缀 / 必填 / 外键类缺陷（护栏自己也要有牙）', () => {
  const doc = JSON.parse(serialize().json)
  const badPrefix = JSON.parse(JSON.stringify(doc))
  badPrefix.messages[0].parts[0].id = 'part-1'
  assert.match(verifyOpencodeImportJson(JSON.stringify(badPrefix)).errors.join('|'), /id 必须以 prt 开头/)

  const noTokens = JSON.parse(JSON.stringify(doc))
  const assistant = noTokens.messages.find((m) => m.info.role === 'assistant')
  delete assistant.info.tokens
  assert.match(verifyOpencodeImportJson(JSON.stringify(noTokens)).errors.join('|'), /tokens/)

  const dangling = JSON.parse(JSON.stringify(doc))
  dangling.messages[0].parts[0].messageID = 'msg_not_there'
  assert.match(verifyOpencodeImportJson(JSON.stringify(dangling)).errors.join('|'), /messageID 指向不存在的消息/)

  const floatTime = JSON.parse(JSON.stringify(doc))
  floatTime.info.time.created = 1.5
  assert.match(verifyOpencodeImportJson(JSON.stringify(floatTime)).errors.join('|'), /必须是非负整数/)

  assert.equal(verifyOpencodeImportJson('{ not json').ok, false)
  const leaky = verifyOpencodeImportJson('{"info": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "x": password=hunter2hunter2}\n')
  assert.equal(leaky.ok, false)
  assert.ok(!leaky.errors.join('|').includes('password'), '解析错误经净化，不携带文档内容')
})

test('buildOpencodeImportDoc：从真实夹具（claude tool 会话）导出后结构校验通过', () => {
  const raw = loadFixture('sess-tool-001.jsonl')
  const conv = convertClaudeJsonl(raw, { sourcePath: 'D:\\demo\\sess-tool-001.jsonl' })
  const titleEvent = conv.events.find((e) => e.type === 'session/title')
  const { doc, stats } = buildOpencodeImportDoc({
    meta: conv.meta,
    events: conv.events,
    sessionUuid: conv.meta.id,
    cwd: conv.meta.cwd,
    title: titleEvent ? titleEvent.data.title : undefined,
  })
  assert.equal(verifyOpencodeImportJson(JSON.stringify(doc, null, 2) + '\n').ok, true)
  assert.equal(stats.toolCalls, 1)
  assert.equal(stats.toolResults, 1)
  assert.equal(stats.droppedToolResults, 0)
  assert.ok(stats.partCount >= 4)
})
