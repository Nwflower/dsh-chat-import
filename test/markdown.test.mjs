// markdown.test.mjs — session.jsonl → Markdown 纯函数
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sessionJsonlToMarkdown, blocksToMarkdown } from '../lib/markdown.mjs'

test('blocksToMarkdown: text / thinking / tool_use / tool-result', () => {
  const md = blocksToMarkdown([
    { type: 'text', text: 'hello' },
    { type: 'thinking', thinking: 'internal' },
    { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
    { type: 'tool-result', content: [{ type: 'text', text: 'file body' }] },
  ])
  assert.match(md, /hello/)
  assert.match(md, /💭 internal/)
  assert.match(md, /🔧 Read\(/)
  assert.match(md, /📦 Tool result: file body/)
})

test('blocksToMarkdown: 图片块标注附件引用与展示名（字节不内联）', () => {
  const md = blocksToMarkdown([
    { type: 'text', text: '看图' },
    { type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 3, width: 1, height: 1, name: 'shot.png' } },
    { type: 'image', attachment: { attachmentId: 'sha256:def', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } },
  ])
  assert.match(md, /🖼 \[shot\.png\]\(sha256:abc\)/)
  assert.match(md, /🖼 \[image\]\(sha256:def\)/, '没有名字时用 image 兜底')
})

test('sessionJsonlToMarkdown: 渲染会话头、用户、助手与工具调用', () => {
  const lines = [
    { type: 'session', version: 0, id: 'import-abc', createdAt: 1786000000000, cwd: 'D:\\demo\\proj' },
    { type: 'session/title', seq: 0, data: { title: '重构登录' } },
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { role: 'user', content: [{ type: 'text', text: '请修 bug' }] }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '好的' }, { type: 'thinking', thinking: '先看代码' }] } }, surfaceOp: 'append' },
    { type: 'tool/call', seq: 4, data: { turn: 1, step: 1, callId: 'c1', name: 'Bash', arguments: '{"command":"npm test"}' } },
    { type: 'tool/result', seq: 5, data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'pass' }] }] } }, surfaceOp: 'append' },
    { type: 'turn/end', seq: 6, data: { turn: 1, reason: { kind: 'completed' } } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n'

  const md = sessionJsonlToMarkdown(lines)
  assert.match(md, /# 重构登录/)
  assert.match(md, /- \*\*Session\*\*: `import-abc`/)
  assert.match(md, /- \*\*Cwd\*\*: `D:\\demo\\proj`/)
  assert.match(md, /## User/)
  assert.match(md, /请修 bug/)
  assert.match(md, /## Assistant/)
  assert.match(md, /好的/)
  assert.match(md, /💭 先看代码/)
  assert.match(md, /🔧 Tool call: `Bash\(/)
  assert.match(md, /📦 Tool result: pass/)
})

test('sessionJsonlToMarkdown: 畸形行跳过不崩溃', () => {
  const text = 'not-json\n{"type":"session","id":"s1"}\n{"type":"user/message","data":{"content":"hi"}}\n'
  const md = sessionJsonlToMarkdown(text)
  assert.match(md, /s1/)
  assert.match(md, /hi/)
})
