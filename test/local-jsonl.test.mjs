import test from 'node:test'
import assert from 'node:assert/strict'
import { convertLocalJsonl } from '../lib/convert/local-jsonl.mjs'
import { loadFixture } from './_support/fixtures.mjs'

const DSH_RAW = [
  { type: 'session', id: 'session-local', cwd: '/tmp/proj', createdAt: 1700000000000 },
  { type: 'turn/start', seq: 0, time: 1700000000000, data: { turn: 1 } },
  { type: 'user/message', seq: 1, time: 1700000000000, surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text: '本地文件' }] } },
  { type: 'assistant/message', seq: 2, time: 1700000000000, surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '回复' }] } } },
  { type: 'turn/end', seq: 3, time: 1700000000000, data: { turn: 1 } },
].map((l) => JSON.stringify(l)).join('\n')

test('import_local_jsonl 自动识别 DSH 会话日志', () => {
  const out = convertLocalJsonl(DSH_RAW, { sourcePath: '/tmp/download/session.jsonl' })
  assert.equal(out.detectedFormat, 'dsh')
  assert.equal(out.meta.id, 'import-session-local')
  assert.equal(out.turns.length, 1)
})

test('import_local_jsonl 自动识别 Codex rollout', async () => {
  const raw = loadFixture('codex-simple.jsonl')
  const out = convertLocalJsonl(raw, { sourcePath: '/home/u/.codex/sessions/2026/01/01/rollout-test.jsonl' })
  assert.equal(out.detectedFormat, 'codex')
  assert.ok(out.meta && out.meta.id)
})

test('import_local_jsonl 自动识别 Cursor transcript', async () => {
  const raw = loadFixture('cursor-simple.jsonl')
  const out = convertLocalJsonl(raw, { sourcePath: '/home/u/.cursor/projects/p/agent-transcripts/id/id.jsonl' })
  assert.equal(out.detectedFormat, 'cursor')
  assert.ok(out.turns.length > 0)
})

test('import_local_jsonl format 参数强制指定解析器', async () => {
  const raw = loadFixture('codex-simple.jsonl')
  const out = convertLocalJsonl(raw, { sourcePath: '/tmp/any-name.jsonl', format: 'codex' })
  assert.equal(out.detectedFormat, 'codex')
})

test('import_local_jsonl 自动识别 Qoder CLI transcript', async () => {
  const raw = loadFixture('qoder-simple.jsonl')
  const out = convertLocalJsonl(raw, { sourcePath: '/home/u/.qoder/projects/-home-u-demo/qoder-simple.jsonl' })
  assert.equal(out.detectedFormat, 'qoder')
  assert.equal(out.meta.id, 'import-qoder-simple')
  assert.equal(out.title, '示例会话')
  assert.equal(out.turns.length, 1)
})
