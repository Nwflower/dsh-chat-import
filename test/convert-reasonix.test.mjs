// convert-reasonix.test.mjs — Reasonix 转换
// WAL 合取（replace 事件整表接管 / 追加式晚到者胜）、stem 时间。
// 由 test/convert.test.mjs 按主题拆出（纯移动：用例与断言未改）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { convertReasonixJsonl, reasonixStemTime } from '../lib/convert/index.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { assertToolPairing, assertMessageOrderLegal, assertSeqContinuity } from './_support/session-invariants.mjs'
import { loadFixture } from './_support/fixtures.mjs'
const load = loadFixture

test('convertReasonixJsonl: subagent-* 子代理默认过滤（skipReason，不建会话）', () => {
  const out = convertReasonixJsonl(load('reasonix-v1.jsonl'), { reasonixId: 'subagent-sub-5-202606020721', sourcePath: 'D:\\demo\\reasonix\\subagent-sub-5-202606020721.jsonl' })
  assert.equal(out.meta, null)
  assert.equal(out.events.length, 0)
  assert.ok(out.skipReason && out.skipReason.includes('subagent'), '应给出子代理跳过原因')
})

test('convertReasonixJsonl: v1 嵌套 tool_calls + tool_call_id 配对 + reasoning', () => {
  const out = convertReasonixJsonl(load('reasonix-v1.jsonl'), { reasonixId: 'desktop-202606020721-1', sourcePath: 'D:\\demo\\reasonix\\desktop-a.jsonl' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  assert.equal(out.meta.id, 'import-desktop-202606020721-1')
  assert.equal(out.meta.sourceId, 'desktop-202606020721-1')
  assertEnvelopeHygiene(out.events)
  const types = out.events.map((e) => e.type)
  assert.equal([...types].reverse().find((t) => t !== 'session/title'), 'turn/end')
  assertSeqContinuity(out.events)
  // 工具调用与结果配对
  const call = out.events.find((e) => e.type === 'tool/call')
  assert.equal(call.data.name, 'search_files')
  assert.equal(call.data.arguments, '{"pattern": "codegraph"}')
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.equal(result.data.message.content[0].content[0].text, '找到了 codegraph v0.9.8')
  // reasoning_content → reasoning block
  const asst = out.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message)
  assert.ok(asst.some((m) => m.content.some((c) => c.type === 'reasoning')))
  // provider
  assert.deepEqual(asst[0].source, { kind: 'model', provider: 'reasonix', model: 'reasonix' })
  assertMessageOrderLegal(out.events)
})

test('convertReasonixJsonl: v2 扁平 tool_calls + createdAt 时间戳', () => {
  const out = convertReasonixJsonl(load('reasonix-v2.jsonl'), { reasonixId: 'desktop-202606020725-2', cwd: 'D:\\Reasonix', title: '查看当前编辑 xlsx 的 skill' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  assert.equal(out.meta.cwd, 'D:\\Reasonix')
  assert.equal(out.meta.createdAt, 1780325474978) // 取第一条消息的 createdAt
  const call = out.events.find((e) => e.type === 'tool/call')
  assert.equal(call.data.name, 'list_directory')
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  // title 来自 meta.summary → session/title 事件
  const titleEv = out.events.find((e) => e.type === 'session/title')
  assert.equal(titleEv.data.title, '查看当前编辑 xlsx 的 skill')
})

test('convertReasonixJsonl: 多轮切分、畸形行计数', () => {
  const out = convertReasonixJsonl('not json\n' + load('reasonix-multi-turn.jsonl'), {})
  assert.equal(out.skipped, 1)
  assert.equal(out.turns.length, 2)
  const starts = out.events.filter((e) => e.type === 'turn/start')
  assert.equal(starts.length, 2)
  // 无 reasonixId 时退化为时间戳 id（仍合法）
  assert.match(out.meta.id, /^import-\d+$/)
})

test('convertReasonixJsonl: tool_calls 无 tool 消息补发空 tool/result', () => {
  // assistant 声明 tool_calls 但没有后续 role=tool 消息（会话中断）→ 合成空 result
  const raw = [
    '{"role":"user","content":"查一下"}',
    '{"role":"assistant","content":"好","tool_calls":[{"id":"call_rx_01","type":"function","function":{"name":"search_files","arguments":"{\\"q\\":\\"x\\"}"}}]}',
  ].join('\n')
  const out = convertReasonixJsonl(raw, { reasonixId: 'desktop-202606020799-9' })
  assert.equal(out.toolCalls, 1)
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.ok(result)
  assert.deepEqual(result.data.message.content[0].content, [])
  assert.equal(result.data.message.content[0].toolCallId, 'call_rx_01')
  assertToolPairing(out.events)
  assert.equal(out.events.at(-1).type, 'turn/end')
})

test('convertReasonixJsonl: 转录无 createdAt 时回退文件名内嵌时间戳', () => {
  const out = convertReasonixJsonl(load('reasonix-v1.jsonl'), { reasonixId: 'desktop-202606020721-1' })
  // stem 内嵌 202606020721（本地时间）→ 2026-06-02 07:21，不再取导入时刻
  assert.equal(out.meta.createdAt, new Date(2026, 5, 2, 7, 21).getTime())
})

test('reasonixStemTime: desktop/subagent 命名解析、无或非法时间戳回退 null', () => {
  assert.equal(reasonixStemTime('desktop-202607020158-1'), new Date(2026, 6, 2, 1, 58).getTime())
  assert.equal(reasonixStemTime('subagent-sub-1-202606030923'), new Date(2026, 5, 3, 9, 23).getTime())
  assert.equal(reasonixStemTime('code-tmp'), null)
  assert.equal(reasonixStemTime('desktop-202613990000-1'), null) // 非法月份
})

test('REQ-22 convertReasonixJsonl: WAL replace 事件整表接管（权威快照），walMerged/walRecords 报告', () => {
  const checkpoint = [
    JSON.stringify({ role: 'user', content: '问题1' }),
    JSON.stringify({ role: 'assistant', content: '旧回答' }),
  ].join('\n')
  const wal = [
    JSON.stringify({ type: 'replace', messages: [
      { role: 'user', content: '问题1' },
      { role: 'assistant', content: '新回答（WAL 权威）' },
      { role: 'user', content: '问题2' },
      { role: 'assistant', content: '回答2' },
    ] }),
  ].join('\n')
  const out = convertReasonixJsonl(checkpoint, { reasonixId: 'desktop-202607020199-1', walText: wal })
  assert.equal(out.walMerged, true)
  assert.equal(out.walRecords, 4)
  assert.equal(out.records, 4) // WAL 消息整表接管
  assert.equal(out.turns.length, 2)
  const texts = out.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message.content[0].text)
  assert.deepEqual(texts, ['新回答（WAL 权威）', '回答2'])
})

test('REQ-22 convertReasonixJsonl: 追加式 WAL（checkpoint 后事件）晚到者胜；无 WAL 纯 checkpoint', () => {
  const checkpoint = [
    JSON.stringify({ role: 'user', content: '问题1' }),
    JSON.stringify({ role: 'assistant', content: '回答1' }),
  ].join('\n')
  const wal = [
    JSON.stringify({ role: 'user', content: '问题2' }),
    JSON.stringify({ role: 'assistant', content: '回答2' }),
  ].join('\n')
  const out = convertReasonixJsonl(checkpoint, { reasonixId: 'desktop-202607020199-2', walText: wal })
  assert.equal(out.walMerged, true)
  assert.equal(out.walRecords, 2)
  assert.equal(out.turns.length, 2)
  // 无 WAL → 旧行为
  const plain = convertReasonixJsonl(checkpoint, { reasonixId: 'desktop-202607020199-2' })
  assert.equal(plain.walMerged, undefined)
  assert.equal(plain.turns.length, 1)
})
