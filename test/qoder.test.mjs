// qoder.test.mjs — Qoder CLI 源转换核心单元测试（自包含合成数据，不掺真实 transcript）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertQoderJsonl } from '../lib/convert/qoder.mjs'
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

// 合成 Qoder CLI transcript：逐行 JSON（与 Claude 同构的 type + message.content）。
function qoder(recs) {
  return recs.map((r) => JSON.stringify(r)).join('\n')
}

const SID = 'sess-qoder-1'
const CWD = '/home/u/my-project'
const TS = '2026-01-02T03:04:05.000Z'

function userRec(content) {
  return { type: 'user', uuid: 'u' + Math.random().toString(36).slice(2), sessionId: SID, timestamp: TS, cwd: CWD, message: { role: 'user', content } }
}
function assistantRec(content) {
  return { type: 'assistant', uuid: 'a' + Math.random().toString(36).slice(2), sessionId: SID, timestamp: TS, cwd: CWD, message: { role: 'assistant', content } }
}

test('简单 user/assistant 轮次 → 1 轮对话、cwd/createdAt 落 meta', () => {
  const raw = qoder([
    userRec('帮我看看这个项目'),
    assistantRec([{ type: 'text', text: '好的，我先读一下结构。' }]),
  ])
  const out = convertQoderJsonl(raw, { sourcePath: '/home/u/.qoder/projects/-home-u-my-project/' + SID + '.jsonl' })
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.id, 'import-' + SID)
  assert.equal(out.meta.sourceId, SID)
  assert.equal(out.meta.cwd, CWD)
  assert.ok(out.meta.createdAt > 0)
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 2) // user + assistant
  assert.equal(out.toolCalls, 0)
})

test('tool_use + tool_result 按 tool_use_id 配对', () => {
  const raw = qoder([
    userRec('读一下 README'),
    assistantRec([
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'README.md' } },
    ]),
    userRec([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '# 项目标题' }] },
    ]),
    assistantRec([{ type: 'text', text: '已读完。' }]),
  ])
  const out = convertQoderJsonl(raw, { sourcePath: '/home/u/.qoder/projects/p/' + SID + '.jsonl' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  assert.equal(out.droppedToolResults, 0)
  assertToolPairing(out.events)
  // tool/result 的文本进入结果内容
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.equal(result.data.message.content[0].content[0].text, '# 项目标题')
})

test('tool_result 缺 tool_use_id 时按未决调用顺序回退配对', () => {
  const raw = qoder([
    userRec('跑个命令'),
    assistantRec([
      { type: 'tool_use', id: 'toolu_a', name: 'run_in_terminal', input: { command: 'ls' } },
      { type: 'tool_use', id: 'toolu_b', name: 'run_in_terminal', input: { command: 'pwd' } },
    ]),
    userRec([
      { type: 'tool_result', content: [{ type: 'text', text: 'a' }] },
      { type: 'tool_result', content: [{ type: 'text', text: 'b' }] },
    ]),
  ])
  const out = convertQoderJsonl(raw, { sourcePath: '/home/u/.qoder/projects/p/' + SID + '.jsonl' })
  assert.equal(out.toolCalls, 2)
  assert.equal(out.droppedToolResults, 0)
  assertToolPairing(out.events)
})

test('孤儿 tool_result（无对应调用）丢弃并计数', () => {
  const raw = qoder([
    userRec('hi'),
    userRec([{ type: 'tool_result', tool_use_id: 'missing', content: [{ type: 'text', text: 'x' }] }]),
  ])
  const out = convertQoderJsonl(raw, { sourcePath: '/home/u/.qoder/projects/p/' + SID + '.jsonl' })
  assert.equal(out.toolCalls, 0)
  assert.equal(out.droppedToolResults, 1)
})

test('标题选取 ai-title > last-prompt > 首问', () => {
  const aiTitle = qoder([
    userRec('第一个问题'),
    { type: 'ai-title', aiTitle: '自定义标题', sessionId: SID },
    assistantRec([{ type: 'text', text: '答' }]),
  ])
  assert.equal(convertQoderJsonl(aiTitle, { sourcePath: '/p/x/' + SID + '.jsonl' }).title, '自定义标题')

  const lastPrompt = qoder([
    userRec('第一个问题'),
    { type: 'last-prompt', lastPrompt: '末次提问标题', sessionId: SID },
    assistantRec([{ type: 'text', text: '答' }]),
  ])
  assert.equal(convertQoderJsonl(lastPrompt, { sourcePath: '/p/x/' + SID + '.jsonl' }).title, '末次提问标题')

  const firstUser = qoder([
    userRec('只有首问的标题'),
    assistantRec([{ type: 'text', text: '答' }]),
  ])
  assert.equal(convertQoderJsonl(firstUser, { sourcePath: '/p/x/' + SID + '.jsonl' }).title, '只有首问的标题')
})

test('子代理/辅助 transcript（fileStem != sessionId）跳过', () => {
  const raw = qoder([
    userRec('子代理里的消息'),
    assistantRec([{ type: 'text', text: '答' }]),
  ])
  const out = convertQoderJsonl(raw, { fileStem: 'subagent-name', sourcePath: '/home/u/.qoder/projects/p/' + SID + '/subagents/subagent-name.jsonl' })
  assert.equal(out.meta, null)
  assert.ok(out.skipReason.includes('subagent'))
  assert.equal(out.turns.length, 0)
})

test('多轮对话：每条直连 user 提问开新轮', () => {
  const raw = qoder([
    userRec('第一问'),
    assistantRec([{ type: 'text', text: '一答' }]),
    userRec('第二问'),
    assistantRec([{ type: 'text', text: '二答' }]),
  ])
  const out = convertQoderJsonl(raw, { sourcePath: '/p/x/' + SID + '.jsonl' })
  assert.equal(out.turns.length, 2)
  assert.equal(out.messages, 4)
})

test('导入归属外置 registry：日志无标记，首事件为环境变更声明（issue #34）', () => {
  const raw = qoder([
    userRec('hi'),
    assistantRec([{ type: 'text', text: 'yo' }]),
  ])
  const out = convertQoderJsonl(raw, { sourcePath: '/home/u/.qoder/projects/p/' + SID + '.jsonl' })
  assert.ok(out.events.every((e) => e.type !== 'session/imported'))
  assert.equal(out.events[0].type, 'user/message')
  assert.equal(out.events[0].data.source.kind, 'plugin')
  assert.equal(out.events[1].type, 'turn/start')
})
