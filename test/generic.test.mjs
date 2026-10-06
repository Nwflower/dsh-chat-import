// generic.test.mjs — interchange v1（generic）文档转换与三级探测的行为测试。
//
// 契约：docs/INTERCHANGE.md §1；实现：lib/convert/generic.mjs + lib/convert/local-jsonl.mjs。
// 夹具全部合成。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertGenericJson, sniffInterchangeMarker } from '../lib/convert/generic.mjs'
import { validateSessionEvents } from '../lib/convert/core.mjs'
import { convertLocalJsonl } from '../lib/convert/local-jsonl.mjs'
import { loadFixture } from './_support/fixtures.mjs'

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function doc(overrides = {}) {
  return {
    interchange: 'dsh-chat-import',
    version: 1,
    meta: { id: 'demo', createdAt: 1700000000000, cwd: 'D:/work/demo', sourceId: 'src-1' },
    title: '示例会话',
    provider: 'demo-tool',
    model: 'demo-model',
    turns: [
      {
        prompt: '第一问',
        time: 1700000001000,
        steps: [{
          time: 1700000002000,
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 1, reasoningTokens: 2 },
          content: [{ type: 'text', text: '回答一' }],
          toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a.txt' } }],
          toolResults: [{ toolCallId: 'c1', content: [{ type: 'text', text: '文件内容' }], time: 1700000003000 }],
        }],
      },
    ],
    ...overrides,
  }
}

test('内容标记嗅探：interchange / bundle / 无标记', () => {
  assert.equal(sniffInterchangeMarker('{"interchange":"dsh-chat-import","version":1}'), 'generic')
  assert.equal(sniffInterchangeMarker('{"bundle":"dsh-chat-import","format":"interchange-v1"}'), 'bundle')
  assert.equal(sniffInterchangeMarker('{"foo":1}'), null)
  assert.equal(sniffInterchangeMarker('not json at all'), null)
  assert.equal(sniffInterchangeMarker(undefined), null)
})

test('generic：文档 → 事件日志（轮/步、工具配对、usage、时间戳单调）', () => {
  const out = convertGenericJson(JSON.stringify(doc()))
  assert.equal(out.turns.length, 1)
  // 会话 id 一律 mint（import-<slug>，slug 优先取 meta.sourceId）：命名约定不交给来源文档
  assert.equal(out.meta.id, 'import-src-1')
  assert.equal(out.meta.cwd, 'D:/work/demo')
  assert.equal(out.meta.sourceId, 'src-1')
  assert.equal(out.title, '示例会话')
  assert.equal(out.toolCalls, 1)
  const call = out.events.find((e) => e.type === 'tool/call')
  assert.equal(call.data.callId, 'c1')
  assert.equal(call.data.arguments, '{"path":"a.txt"}')
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  const assistant = out.events.find((e) => e.type === 'assistant/message')
  assert.deepEqual(assistant.data.usage, {
    inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 1, reasoningTokens: 2,
  })
  // 事件时间只前进不倒退（宿主统计投影的前提）
  for (let i = 1; i < out.events.length; i++) assert.ok(out.events[i].time >= out.events[i - 1].time)
})

test('generic：版本不符 / 便携包 / 非 JSON / 0 轮 一律大声拒绝（不猜、不半读）', () => {
  const v2 = convertGenericJson(JSON.stringify(doc({ version: 2 })))
  assert.equal(v2.meta, null)
  assert.match(v2.skipReason, /不支持的 interchange 版本 2/)
  const bundle = convertGenericJson(JSON.stringify({ bundle: 'dsh-chat-import', format: 'interchange-v1', log: '' }))
  assert.match(bundle.skipReason, /restore_bundle/)
  const bad = convertGenericJson('{not json')
  assert.match(bad.skipReason, /不是合法 JSON/)
  const empty = convertGenericJson(JSON.stringify(doc({ turns: [] })))
  assert.match(empty.skipReason, /没有可导入的轮次/)
})

test('generic：非 JSON 的拒绝原因不携带文档内容（解析错误经净化）', () => {
  const out = convertGenericJson('{"turns": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "x": password=hunter2hunter2}')
  assert.match(out.skipReason, /不是合法 JSON/)
  assert.ok(!out.skipReason.includes('password'), out.skipReason)
})

test('generic：畸形条目全部计数（未知块 / 图片降级 / 孤儿结果 / 畸形轮步 / 非法 usage）', () => {
  const out = convertGenericJson(JSON.stringify(doc({
    turns: [
      {
        prompt: '带图',
        promptBlocks: [
          { type: 'text', text: '看图' },
          { type: 'image', data: PNG_1PX, mediaType: 'image/png', name: 'shot.png' },
          { type: 'image', data: 'x', mediaType: 'image/tiff' },
        ],
        steps: [{
          usage: { inputTokens: 'ten', outputTokens: 5 },
          content: [{ type: 'text', text: '好' }, { type: 'mystery' }],
          toolResults: [{ toolCallId: 'orphan', content: [{ type: 'text', text: 'x' }] }],
        }],
      },
      'not-an-object',
      { prompt: '只有空壳', steps: [{ content: [{ type: 'text', text: 'y' }] }] },
    ],
  })))
  assert.equal(out.turns.length, 2)
  assert.equal(out.imagesDegraded, 1) // image/tiff 不是宿主可收类型 → [image] 占位
  assert.equal(out.skippedBlocks, 1) // mystery 块
  assert.equal(out.droppedToolResults, 1) // 没有对应调用的结果
  assert.equal(out.malformedTurns, 1) // 非对象轮
  assert.equal(out.usageDropped, 1) // input 不是整数 → 整份丢弃并计数
  const blocks = out.turns[0].promptBlocks
  assert.equal(blocks.filter((b) => b.type === 'image').length, 1)
  assert.ok(blocks.some((b) => b.type === 'text' && b.text === '[image]'))
})

test('generic：toolCalls 缺列表时从 content 的 tool-call 块派生；压缩轮与遮蔽轮透传', () => {
  const out = convertGenericJson(JSON.stringify(doc({
    turns: [
      { prompt: '旧问', steps: [{ content: [{ type: 'text', text: '旧答' }] }], shadowed: true },
      {
        prompt: '',
        compaction: { summary: '摘要正文', provider: 'demo-tool', time: 1700000010000 },
        steps: [{ content: [{ type: 'tool-call', id: 'c9', name: 'write', arguments: '{"p":1}' }, { type: 'text', text: '新答' }] }],
      },
    ],
  })))
  assert.equal(out.compactions, 1)
  // 与其它来源同口径：实际发射了原生检查点就报 compacted（导入结果据此透出）
  assert.equal(out.compacted, true)
  assert.equal(out.toolCalls, 1)
  const summary = out.events.find((e) => e.type === 'compaction/summary')
  assert.equal(summary.data.summary[0].text, '摘要正文')
  // 空 prompt 的压缩边界轮不再补发 user/message（检查点即该轮的 user 侧消息）
  const userMsgs = out.events.filter((e) => e.type === 'user/message' && e.data.source && e.data.source.kind === 'user')
  assert.equal(userMsgs.length, 1)
  assert.equal(userMsgs[0].data.content[0].text, '旧问')
})

test('generic：step content 里的 tool-result 块派生进 toolResults，正文不留包装（issue #77）', () => {
  const out = convertGenericJson(JSON.stringify(doc({
    turns: [{
      prompt: '搜一下',
      steps: [{
        content: [
          { type: 'text', text: '查' },
          { type: 'tool-call', id: 'c1', name: 'web_search', arguments: { q: 'x' } },
          { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '命中 3 条' }], isError: false },
        ],
      }],
    }],
  })))
  // 正文里的 tool-call / tool-result 块都按 id 派生：调用与结果各一条，配对不变量成立
  assert.equal(out.toolCalls, 1)
  assert.equal(out.skippedBlocks, 0)
  assert.equal(out.droppedToolResults, 0)
  const assistant = out.events.find((e) => e.type === 'assistant/message')
  assert.ok(!assistant.data.message.content.some((b) => b.type === 'tool-result'), '正文不得残留结果包装')
  const call = out.events.find((e) => e.type === 'tool/call')
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.equal(result.data.message.content[0].toolCallId, 'c1')
  assert.equal(result.data.message.content[0].content[0].text, '命中 3 条')
  // 校验层不点名：写侧已无宿主 V4 codec 拒载的 tool-result 包装
  assert.equal(validateSessionEvents(out.events).ok, true)
})

test('generic：显式 toolResults 与 content 结果块按 toolCallId 去重，显式列表优先', () => {
  const out = convertGenericJson(JSON.stringify(doc({
    turns: [{
      prompt: 'p',
      steps: [{
        content: [
          { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
          { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '来自正文' }] },
        ],
        toolResults: [{ toolCallId: 'c1', content: [{ type: 'text', text: '来自列表' }] }],
      }],
    }],
  })))
  const results = out.events.filter((e) => e.type === 'tool/result')
  assert.equal(results.length, 1)
  assert.equal(results[0].data.message.content[0].content[0].text, '来自列表')
  // 派生去重不是「重复结果」降级（计数留给合成层对显式重复的口径）
  assert.equal(out.duplicateToolResults, undefined)
})

test('generic：content 结果块受配对不变量约束；错位结果块（promptBlocks / 结果内层）丢弃计数', () => {
  const out = convertGenericJson(JSON.stringify(doc({
    turns: [{
      prompt: 'p',
      promptBlocks: [
        { type: 'text', text: 'p' },
        { type: 'tool-result', toolCallId: 'c9', content: [{ type: 'text', text: '错位' }] },
      ],
      steps: [{
        content: [
          { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
          { type: 'tool-result', toolCallId: 'orphan', content: [{ type: 'text', text: '无调用' }] },
        ],
        toolResults: [{
          toolCallId: 'c1',
          content: [
            { type: 'text', text: '正常' },
            { type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: '嵌套' }] },
          ],
        }],
      }],
    }],
  })))
  // promptBlocks 1 个 + 结果内层 1 个：无处安放的结果块丢弃并计入 skippedBlocks
  assert.equal(out.skippedBlocks, 2)
  // content 派生出的结果没有对应调用 → 与显式孤儿结果同口径丢弃计数
  assert.equal(out.droppedToolResults, 1)
  const results = out.events.filter((e) => e.type === 'tool/result')
  assert.equal(results.length, 1)
  assert.equal(results[0].data.message.content[0].content[0].text, '正常')
})

test('三级探测：内容标记优先（detectedBy=marker），强制格式报 override 并把失败摊开', () => {
  const byMarker = convertLocalJsonl(JSON.stringify(doc()), { sourcePath: 'D:/downloads/whatever.json' })
  assert.equal(byMarker.detectedFormat, 'generic')
  assert.equal(byMarker.detectedBy, 'marker')

  const forced = convertLocalJsonl(JSON.stringify(doc()), { sourcePath: 'D:/downloads/whatever.json', format: 'claude' })
  assert.equal(forced.detectedFormat, null)
  assert.equal(forced.detectedBy, 'override')
  assert.equal(forced.failures.length, 1)
  assert.equal(forced.failures[0].format, 'claude')

  // 标记存在但版本不符：只报 generic 的拒绝原因，不再换格式猜
  const mismatch = convertLocalJsonl(JSON.stringify(doc({ version: 9 })), { sourcePath: 'D:/x/a.json' })
  assert.equal(mismatch.detectedFormat, null)
  assert.equal(mismatch.failures.length, 1)
  assert.equal(mismatch.failures[0].format, 'generic')
  assert.match(mismatch.skipReason, /版本 9/)
})

test('三级探测：路径特征命中报 path-hint，未识别时给出每个候选格式的失败原因', () => {
  const dshRaw = [
    { type: 'session', id: 'session-path', cwd: '/tmp/proj', createdAt: 1700000000000 },
    { type: 'turn/start', seq: 0, time: 1700000000000, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 1700000000000, surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text: '本地文件' }] } },
    { type: 'assistant/message', seq: 2, time: 1700000000000, surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '回复' }] } } },
    { type: 'turn/end', seq: 3, time: 1700000000000, data: { turn: 1 } },
  ].map((l) => JSON.stringify(l)).join('\n')
  const hinted = convertLocalJsonl(dshRaw, { sourcePath: '/tmp/x/session.jsonl' })
  assert.equal(hinted.detectedFormat, 'dsh')
  assert.equal(hinted.detectedBy, 'path-hint')

  const junk = convertLocalJsonl('{"foo":1}\n{"bar":2}\n', { sourcePath: '/tmp/downloads/junk.jsonl' })
  assert.equal(junk.detectedFormat, null)
  assert.equal(junk.failures.length, 11) // 11 个候选格式（含 generic）各给一条原因
  assert.ok(junk.failures.every((f) => typeof f.format === 'string' && typeof f.reason === 'string'))
  assert.match(junk.skipReason, /未能识别/)
})

test('三级探测：便携包标记原样透出（调用方转交 restore_bundle），不参与普通转换', () => {
  const out = convertLocalJsonl(JSON.stringify({ bundle: 'dsh-chat-import', format: 'interchange-v1', log: '' }), {})
  assert.equal(out.bundle, true)
  assert.equal(out.detectedBy, 'marker')
  assert.equal(out.meta, null)
  assert.match(out.skipReason, /restore_bundle/)
})

test('三级探测：内容试跑命中既有来源（claude 夹具）并报 detectedBy=content', async () => {
  const raw = loadFixture('codex-simple.jsonl')
  const out = convertLocalJsonl(raw, { sourcePath: '/tmp/downloads/any-name.jsonl' })
  assert.equal(out.detectedFormat, 'codex')
  assert.ok(out.detectedBy === 'content' || out.detectedBy === 'path-hint')
})
