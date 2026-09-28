// claude-tool-use-result.test.mjs — Claude 富结果 sidecar（toolUseResult）可选并入
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertClaudeJsonl, structuredPatchText } from '../lib/convert/claude.mjs'

const SID = 'sess-tur-001'
const jsonl = (recs) => recs.map((r) => JSON.stringify(r)).join('\n')
const user = (c) => ({ sessionId: SID, type: 'user', message: { role: 'user', content: c } })
const asst = (id, content) => ({ sessionId: SID, type: 'assistant', message: { id, role: 'assistant', content } })

// 一条带 tool_result + toolUseResult 的转录：Edit 的补丁 + 元数据 + 与可见结果重复的 stdout
const EDIT_RECORDS = [
  user('改一下'),
  asst('msg_edit', [{ type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: { file_path: 'a.ts' } }]),
  {
    sessionId: SID,
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_edit', content: 'The file a.ts has been updated.' }] },
    toolUseResult: {
      filePath: 'D:/demo/a.ts',
      userModified: false,
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-const a = 1', '+const a = 2'] }],
      originalFile: 'x'.repeat(5000),
      stdout: 'The file a.ts has been updated.',
      durationMs: 12,
    },
  },
  asst('msg_after', [{ type: 'text', text: '改好了' }]),
]

test('默认不并入 sidecar（保持既有产物）', () => {
  const out = convertClaudeJsonl(jsonl(EDIT_RECORDS), { fileStem: SID })
  assert.equal(out.toolUseResultsMerged, undefined)
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.deepEqual(result.data.message.content[0].content, [{ type: 'text', text: 'The file a.ts has been updated.' }])
})

test('includeToolUseResult:true → 补丁/元数据并入结果，体积键与重复值不搬', () => {
  const out = convertClaudeJsonl(jsonl(EDIT_RECORDS), { fileStem: SID, includeToolUseResult: true })
  assert.equal(out.toolUseResultsMerged, 1)
  const result = out.events.find((e) => e.type === 'tool/result')
  const content = result.data.message.content[0].content
  // 可见结果原样在前，sidecar 追加在后
  assert.equal(content[0].text, 'The file a.ts has been updated.')
  const diff = content.find((b) => b.text.startsWith('```diff'))
  assert.ok(diff, '编辑补丁以 diff 文本块并入')
  assert.match(diff.text, /@@ -1,1 \+1,1 @@/)
  assert.match(diff.text, /-const a = 1/)
  assert.match(diff.text, /\+const a = 2/)
  const meta = content.find((b) => b.text.startsWith('<tool-use-result>'))
  assert.ok(meta, '标量元数据以紧凑 JSON 并入')
  assert.match(meta.text, /"durationMs":12/)
  assert.match(meta.text, /"userModified":false/)
  const flat = JSON.stringify(out.events)
  assert.ok(!flat.includes('x'.repeat(100)), 'originalFile 这类体积键不搬')
  assert.ok(!flat.includes('"stdout"'), '与可见文本重复的 stdout 不重复搬')
})

test('structuredPatchText：hunk 数组 → 统一 diff 文本（畸形项跳过）', () => {
  assert.equal(structuredPatchText([{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, lines: [' a', '-b', '+c', '+d'] }]),
    '@@ -3,2 +3,3 @@\n a\n-b\n+c\n+d')
  assert.equal(structuredPatchText(null), '')
  assert.equal(structuredPatchText([null, 'x']), '')
})

test('includeToolUseResult:true 但记录没有 sidecar → 不占计数、不改产物', () => {
  const out = convertClaudeJsonl(jsonl([
    user('看看'),
    asst('msg_bash', [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: {} }]),
    { sessionId: SID, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'ok' }] } },
  ]), { fileStem: SID, includeToolUseResult: true })
  assert.equal(out.toolUseResultsMerged, undefined)
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.deepEqual(result.data.message.content[0].content, [{ type: 'text', text: 'ok' }])
})

test('交互问答（questions/answers）并入为问答对文本', () => {
  const out = convertClaudeJsonl(jsonl([
    user('问'),
    asst('msg_ask', [{ type: 'tool_use', id: 'toolu_ask', name: 'AskUserQuestion', input: {} }]),
    {
      sessionId: SID,
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ask', content: 'answered' }] },
      toolUseResult: { questions: ['用哪个端口？'], answers: ['8080'] },
    },
  ]), { fileStem: SID, includeToolUseResult: true })
  const result = out.events.find((e) => e.type === 'tool/result')
  const qa = result.data.message.content[0].content.find((b) => b.text.startsWith('Q: '))
  assert.equal(qa.text, 'Q: 用哪个端口？\nA: 8080')
})
