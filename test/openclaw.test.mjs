// openclaw.test.mjs — OpenClaw 源转换核心单元测试 + import_chat 集成测试（假宿主见 _support/fake-host.mjs；自包含合成数据）
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { SESSION_FORMAT_VERSION } from '../lib/convert/core.mjs'
import { convertOpenclawJson, openclawDisplayNames } from '../lib/convert/openclaw.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { apply } from '../lib/index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { clearScanCache } from '../lib/discovery.mjs'
import { assertToolPairing, assertMessageOrderLegal } from './_support/session-invariants.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'

// 集成用例隔离：每个用例独立 DSH_HOME（registry 落盘在 $DSH_HOME/dsh-chat-import），
// 进程内共享的扫描缓存每用例清空。
beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
})

test('convertOpenclawJson: session 事件 + 简单问答合成平衡回合（标题取首条 user 文本）', () => {
  const raw = [
    '{"type":"session","id":"sess-openclaw-001","cwd":"/home/dev/proj","timestamp":"2026-03-06T10:00:00Z"}',
    '{"type":"message","message":{"role":"user","content":"帮我看看构建失败\\n[message_id: msg_1]"},"timestamp":"2026-03-06T10:01:00Z"}',
    '{"type":"message","message":{"role":"assistant","content":"是缺少依赖，补上即可。"},"timestamp":"2026-03-06T10:02:00Z"}',
  ].join('\n')
  const out = convertOpenclawJson(raw, { sourcePath: 'D:/demo/openclaw/sessions/sess-openclaw-001.jsonl' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 2)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.meta.id, 'import-sess-openclaw-001')
  assert.equal(out.meta.sourceId, 'sess-openclaw-001')
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.cwd, '/home/dev/proj')
  assert.equal(out.meta.createdAt, Date.parse('2026-03-06T10:00:00Z'))
  // 标题：无 displayName → 首条 user 文本（message_id 尾缀已剥离），不钉事件
  assert.equal(out.title, '帮我看看构建失败')
  assert.equal(out.events.some((e) => e.type === 'session/title'), false)
  assertEnvelopeHygiene(out.events)
  const types = out.events.map((e) => e.type)
  assert.deepEqual(types, ['turn/start', 'step/start', 'system/message', 'user/message', 'user/message', 'assistant/message', 'step/end', 'turn/end'])
  out.events.forEach((e, i) => assert.equal(e.seq, i))
  const user = out.events.find((e) => e.type === 'user/message' && e.data.source.kind === 'user')
  assert.equal(user.data.content[0].text, '帮我看看构建失败')
  assertMessageOrderLegal(out.events)
})

test('convertOpenclawJson: tool_use block + toolResult → tool/result 配对（thinking→reasoning、sourceEventSeqs）', () => {
  const raw = [
    '{"type":"session","id":"sess-openclaw-002","cwd":"/home/dev/proj","timestamp":"2026-03-06T10:00:00Z"}',
    '{"type":"message","message":{"role":"user","content":"搜索 codegraph"},"timestamp":"2026-03-06T10:01:00Z"}',
    '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"我来搜索"},{"type":"thinking","thinking":"先查本地"},{"type":"tool_use","id":"toolu_01","name":"search_files","input":{"pattern":"codegraph"}}]},"timestamp":"2026-03-06T10:02:00Z"}',
    '{"type":"message","message":{"role":"toolResult","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":[{"type":"text","text":"找到 1 个结果"}],"is_error":false}]},"timestamp":"2026-03-06T10:03:00Z"}',
  ].join('\n')
  const out = convertOpenclawJson(raw, {})
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  const call = out.events.find((e) => e.type === 'tool/call')
  assert.equal(call.data.callId, 'toolu_01')
  assert.equal(call.data.name, 'search_files')
  assert.equal(call.data.arguments, '{"pattern":"codegraph"}')
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.equal(result.data.message.content[0].toolCallId, 'toolu_01')
  assert.equal(result.data.message.content[0].content[0].text, '找到 1 个结果')
  // is_error:false → 不标 isError
  assert.equal(result.data.message.content[0].isError, undefined)
  // assistant content：text + reasoning + tool-call
  const asst = out.events.find((e) => e.type === 'assistant/message').data.message
  assert.deepEqual(asst.content.map((c) => c.type), ['text', 'reasoning', 'tool-call'])
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
})

test('convertOpenclawJson: toolResult 纯文本无 id → 回填最近未配对调用（剥 message_id 尾缀）', () => {
  const raw = [
    '{"type":"message","message":{"role":"user","content":"查一下"},"timestamp":"2026-03-06T10:01:00Z"}',
    '{"type":"message","message":{"role":"assistant","content":[{"type":"tool_use","id":"call_rx_01","name":"search_files","input":{"q":"x"}}]},"timestamp":"2026-03-06T10:02:00Z"}',
    '{"type":"message","message":{"role":"toolResult","content":"完成\\n[message_id: msg_9]"},"timestamp":"2026-03-06T10:03:00Z"}',
  ].join('\n')
  const out = convertOpenclawJson(raw, {})
  assert.equal(out.toolCalls, 1)
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.equal(result.data.message.content[0].toolCallId, 'call_rx_01')
  assert.equal(result.data.message.content[0].content[0].text, '完成')
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
})

test('convertOpenclawJson: 并行多调用乱序返回 → 结果按声明顺序投影', () => {
  const raw = [
    '{"type":"message","message":{"role":"user","content":"并行跑两个工具"},"timestamp":"2026-03-06T10:01:00Z"}',
    '{"type":"message","message":{"role":"assistant","content":[{"type":"tool_use","id":"call_a","name":"tool_a","input":{}},{"type":"tool_use","id":"call_b","name":"tool_b","input":{}}]},"timestamp":"2026-03-06T10:02:00Z"}',
    '{"type":"message","message":{"role":"toolResult","content":[{"type":"tool_result","tool_use_id":"call_b","content":[{"type":"text","text":"B 结果"}]}]},"timestamp":"2026-03-06T10:03:00Z"}',
    '{"type":"message","message":{"role":"toolResult","content":[{"type":"tool_result","tool_use_id":"call_a","content":[{"type":"text","text":"A 结果"}]}]},"timestamp":"2026-03-06T10:04:00Z"}',
  ].join('\n')
  const out = convertOpenclawJson(raw, {})
  assert.equal(out.toolCalls, 2)
  const calls = out.events.filter((e) => e.type === 'tool/call')
  const results = out.events.filter((e) => e.type === 'tool/result')
  assert.deepEqual(calls.map((c) => c.data.callId), ['call_a', 'call_b'])
  assert.deepEqual(results.map((r) => r.data.message.content[0].toolCallId), ['call_a', 'call_b'])
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
})

test('convertOpenclawJson: tool_use 无 toolResult → 补发空 tool/result（配对不变量）', () => {
  const raw = [
    '{"type":"message","message":{"role":"user","content":"查一下"},"timestamp":"2026-03-06T10:01:00Z"}',
    '{"type":"message","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_missing","name":"search","input":{}}]},"timestamp":"2026-03-06T10:02:00Z"}',
  ].join('\n')
  const out = convertOpenclawJson(raw, {})
  assert.equal(out.toolCalls, 1)
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.ok(result)
  assert.equal(result.data.message.content[0].toolCallId, 'toolu_missing')
  assert.deepEqual(result.data.message.content[0].content, [])
  assertToolPairing(out.events)
  assert.equal(out.events.at(-1).type, 'turn/end')
})

test('convertOpenclawJson: tool_result is_error → isError 标记透传', () => {
  const raw = [
    '{"type":"message","message":{"role":"user","content":"跑测试"},"timestamp":"2026-03-06T10:01:00Z"}',
    '{"type":"message","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_err","name":"run_tests","input":{}}]},"timestamp":"2026-03-06T10:02:00Z"}',
    '{"type":"message","message":{"role":"toolResult","content":[{"type":"tool_result","tool_use_id":"toolu_err","content":[{"type":"text","text":"测试失败"}],"is_error":true}]},"timestamp":"2026-03-06T10:03:00Z"}',
  ].join('\n')
  const out = convertOpenclawJson(raw, {})
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.equal(result.data.message.content[0].isError, true)
})

test('convertOpenclawJson: 标题优先级 displayName > 首条 user 文本（钉 session/title 事件）', () => {
  const raw = [
    '{"type":"session","id":"sess-title-01","cwd":"/tmp/proj","timestamp":"2026-03-06T10:00:00Z"}',
    '{"type":"message","message":{"role":"user","content":"fix something"},"timestamp":"2026-03-06T10:01:00Z"}',
    '{"type":"message","message":{"role":"assistant","content":"done"},"timestamp":"2026-03-06T10:02:00Z"}',
  ].join('\n')
  const out = convertOpenclawJson(raw, { displayName: '重构登录模块' })
  assert.equal(out.title, '重构登录模块')
  const titleEv = out.events.find((e) => e.type === 'session/title')
  assert.ok(titleEv)
  assert.equal(titleEv.data.title, '重构登录模块')
  assert.deepEqual(titleEv.data.messageSeqs, [])
  assert.deepEqual(titleEv.data.source, { kind: 'user' })
})

test('convertOpenclawJson: 显式标题（displayName）超 80 字符截断（REQ-27 统一规则）', () => {
  const raw = [
    '{"type":"session","id":"sess-trunc","cwd":"/tmp/p","timestamp":"2026-03-06T10:00:00Z"}',
    '{"type":"message","message":{"role":"user","content":"hi"},"timestamp":"2026-03-06T10:01:00Z"}',
  ].join('\n')
  const out = convertOpenclawJson(raw, { displayName: '长'.repeat(85) })
  assert.equal(out.title, '长'.repeat(79) + '…')
  const titleEv = out.events.find((e) => e.type === 'session/title')
  assert.equal(titleEv.data.title, '长'.repeat(79) + '…')
})

test('convertOpenclawJson: 无 user 消息 → cwd basename 兜底标题，无可导入内容不产生事件', () => {
  const raw = [
    '{"type":"session","id":"sess-basename","cwd":"/tmp/my-project","timestamp":"2026-03-06T10:00:00Z"}',
    '{"type":"message","message":{"role":"assistant","content":"hello"},"timestamp":"2026-03-06T10:01:00Z"}',
  ].join('\n')
  const out = convertOpenclawJson(raw, {})
  assert.equal(out.title, 'my-project')
  assert.equal(out.turns.length, 0)
  assert.equal(out.events.length, 0)
})

test('openclawDisplayNames: sessions.json 索引解析（空名/坏条目过滤；坏 JSON 空 Map）', () => {
  const index = JSON.stringify({
    'agent:main:main': { sessionId: 'sess-title-01', displayName: '重构登录模块' },
    'agent:main:empty': { sessionId: 'sess-e', displayName: '   ' },
    'agent:main:no-name': { sessionId: 'sess-n' },
    'agent:main:bad': 'not-an-object',
  })
  const map = openclawDisplayNames(index)
  assert.equal(map.get('sess-title-01'), '重构登录模块')
  assert.equal(map.has('sess-e'), false)
  assert.equal(map.size, 1)
  assert.equal(openclawDisplayNames('not json').size, 0)
  assert.equal(openclawDisplayNames('').size, 0)
  // 集成：index 层从 sessions.json 读 displayName 后经 args 传入
  const raw = '{"type":"session","id":"sess-title-01","cwd":"/tmp/p","timestamp":"2026-03-06T10:00:00Z"}\n{"type":"message","message":{"role":"user","content":"hello"},"timestamp":"2026-03-06T10:01:00Z"}'
  const out = convertOpenclawJson(raw, { displayName: map.get('sess-title-01') })
  assert.equal(out.title, '重构登录模块')
})

test('convertOpenclawJson: 畸形行计数、assistant 前置忽略、records', () => {
  const raw = [
    'not json',
    '{"type":"message","message":{"role":"assistant","content":"无用户前置的回复"},"timestamp":"2026-03-06T10:00:00Z"}',
    '{"type":"message","message":{"role":"user","content":"你好"},"timestamp":"2026-03-06T10:01:00Z"}',
    '{"type":"message","message":{"role":"assistant","content":"回复"},"timestamp":"2026-03-06T10:02:00Z"}',
  ].join('\n')
  const out = convertOpenclawJson(raw, {})
  assert.equal(out.skipped, 1)
  assert.equal(out.records, 3)
  assert.equal(out.turns.length, 1)
  const asst = out.events.filter((e) => e.type === 'assistant/message')
  assert.equal(asst.length, 1) // 前置 assistant 未成 step
  assert.equal(asst[0].data.message.content[0].text, '回复')
})

test('convertOpenclawJson: sessionId 覆盖 + sourcePath 透传（标记内 sourceId 仍为源 id）', () => {
  const raw = '{"type":"session","id":"sess-ovr-01","cwd":"/tmp/p","timestamp":"2026-03-06T10:00:00Z"}\n{"type":"message","message":{"role":"user","content":"hi"},"timestamp":"2026-03-06T10:01:00Z"}'
  const out = convertOpenclawJson(raw, { sessionId: 'custom-openclaw', sourcePath: 'D:/demo/openclaw/sess-ovr-01.jsonl' })
  assert.equal(out.meta.id, 'custom-openclaw')
  assert.equal(out.meta.sourceId, 'sess-ovr-01')
  assertEnvelopeHygiene(out.events)
})

test('convertOpenclawJson: 孤儿 toolResult（显式 id 无对应调用）丢弃计数', () => {
  const raw = [
    '{"type":"message","message":{"role":"user","content":"hi"},"timestamp":"2026-03-06T10:01:00Z"}',
    '{"type":"message","message":{"role":"toolResult","content":[{"type":"tool_result","tool_use_id":"call_ghost","content":[{"type":"text","text":"无主结果"}]}]},"timestamp":"2026-03-06T10:02:00Z"}',
  ].join('\n')
  const out = convertOpenclawJson(raw, {})
  assert.equal(out.droppedToolResults, 1)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.events.some((e) => e.type === 'tool/result'), false)
})

test('convertOpenclawJson: budget 透传 → 超预算会话裁剪（trimmed 上报）', () => {
  // 5 轮（> 锚点 3 轮）：budget=1 病态小 → 锚点从 3 收缩到 1（丢 2 轮）+ middle 丢 2 轮，
  // droppedTurns 如实计 4（REQ-49：锚点收缩丢轮不得静默），保留 1 轮可续聊
  const mk = (n) => '{"type":"message","message":{"role":"user","content":"第' + n + '问"},"timestamp":"2026-03-06T10:0' + n + ':00Z"}\n{"type":"message","message":{"role":"assistant","content":"答' + n + '"},"timestamp":"2026-03-06T10:0' + n + ':30Z"}'
  const raw = mk(1) + '\n' + mk(2) + '\n' + mk(3) + '\n' + mk(4) + '\n' + mk(5)
  const out = convertOpenclawJson(raw, { budget: 1 })
  assert.ok(out.trimmed)
  assert.equal(out.trimmed.droppedTurns, 4)
  assert.equal(out.turns.length, 1)
})

test('convertOpenclawJson: 空输入无事件', () => {
  const out = convertOpenclawJson('')
  assert.equal(out.events.length, 0)
  assert.equal(out.turns.length, 0)
  assert.equal(out.title, '')
})

// ---- import_openclaw 集成（sessions.json 索引提供 displayName） ----

test('import_openclaw 单文件：displayName 从同目录 sessions.json 派生、落盘、归组、schema 校验', async () => {
  const tree = {
    'D:\\demo\\openclaw\\sessions.json': JSON.stringify({
      'agent:main:a': { sessionId: 'sess-openclaw-001', displayName: '重构登录模块' },
    }),
    'D:\\demo\\openclaw\\sess-openclaw-001.jsonl': [
      '{"type":"session","id":"sess-openclaw-001","cwd":"/home/dev/proj","timestamp":"2026-03-06T10:00:00Z"}',
      '{"type":"message","message":{"role":"user","content":"帮我看看构建失败"},"timestamp":"2026-03-06T10:01:00Z"}',
      '{"type":"message","message":{"role":"assistant","content":"是缺少依赖。"},"timestamp":"2026-03-06T10:02:00Z"}',
    ].join('\n'),
  }
  const { ctx, persistence, attached } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'openclaw')
  const value = await def.execute({ path: 'D:\\demo\\openclaw\\sess-openclaw-001.jsonl' })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-sess-openclaw-001')
  assert.equal(value.turns, 1)
  assert.equal(value.messages, 2)
  assert.equal(value.alreadyImported, false)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get('import-sess-openclaw-001')
  assert.ok(saved)
  assert.equal(saved.meta.cwd, '/home/dev/proj')
  assert.equal(saved.meta.sourceId, undefined)
  // 宿主 header 白名单不含 sourceId（写入路径按 released-v2 schema 严格校验，
  // 白名单外字段会让整次创建被拒）：源 id 只服务 registry 与导出协议，不落 header
  // displayName（sessions.json 索引）→ 标题钉 session/title 事件
  assert.equal(saved.events.at(-1).type, 'session/title')
  assert.equal(saved.events.at(-1).data.title, 'OpenClaw · 重构登录模块')
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assertEnvelopeHygiene(saved.events)
  assert.equal(attached.length, 1)
  assert.equal(attached[0].id, 'import-sess-openclaw-001')
})

test('import_openclaw 目录批量：递归扫 .jsonl、逐文件独立会话、schema 校验', async () => {
  const file = (id) => [
    '{"type":"session","id":"' + id + '","cwd":"/home/dev/proj","timestamp":"2026-03-06T10:00:00Z"}',
    '{"type":"message","message":{"role":"user","content":"问题"},"timestamp":"2026-03-06T10:01:00Z"}',
    '{"type":"message","message":{"role":"assistant","content":"回答"},"timestamp":"2026-03-06T10:02:00Z"}',
  ].join('\n')
  const tree = {
    'D:\\demo\\openclaw\\agents\\main\\sessions': 'dir',
    'D:\\demo\\openclaw\\agents\\main\\sessions\\sessions.json': JSON.stringify({
      a: { sessionId: 'sess-a', displayName: '会话A' },
      b: { sessionId: 'sess-b', displayName: '会话B' },
    }),
    'D:\\demo\\openclaw\\agents\\main\\sessions\\sess-a.jsonl': file('sess-a'),
    'D:\\demo\\openclaw\\agents\\main\\sessions\\sess-b.jsonl': file('sess-b'),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'openclaw')
  const value = await def.execute({ path: 'D:\\demo\\openclaw\\agents\\main\\sessions' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2) // sessions.json 是 .json 非 .jsonl，不收集
  assert.equal(value.imported, 2)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  const ids = [...persistence.sessions.keys()].sort()
  assert.deepEqual(ids, ['import-sess-a', 'import-sess-b'])
  // 标题来自 sessions.json displayName
  assert.equal(persistence.sessions.get('import-sess-a').events.at(-1).type, 'session/title')
  assert.equal(persistence.sessions.get('import-sess-b').events.at(-1).type, 'session/title')
})

test('import_openclaw 幂等：重复导入同一文件已存在则跳过', async () => {
  const tree = {
    'D:\\demo\\openclaw\\sess-static.jsonl': [
      '{"type":"session","id":"sess-static","cwd":"/tmp/p","timestamp":"2026-03-06T10:00:00Z"}',
      '{"type":"message","message":{"role":"user","content":"hi"},"timestamp":"2026-03-06T10:01:00Z"}',
      '{"type":"message","message":{"role":"assistant","content":"ok"},"timestamp":"2026-03-06T10:02:00Z"}',
    ].join('\n'),
  }
  const { ctx, persistence } = makeCtx(tree) // 无 sessions.json：deriveArgs 吞缺索引，仅无 displayName
  apply(ctx)
  const def = chatDef(ctx, 'openclaw')
  const first = await def.execute({ path: 'D:\\demo\\openclaw\\sess-static.jsonl' })
  const second = await def.execute({ path: 'D:\\demo\\openclaw\\sess-static.jsonl' })
  assert.equal(first.alreadyImported, false)
  assert.equal(first.sessionId, 'import-sess-static')
  assert.equal(second.alreadyImported, true)
  assert.equal(persistence.sessions.size, 1)
})
