import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, stat, readFile, readdir, open, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Buffer } from 'node:buffer'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { convertDshJsonl } from '../lib/convert/dsh.mjs'
import { discoverSessions } from '../lib/discovery.mjs'
import { readDshText } from '../lib/dsh.mjs'

const SESSION_LINES = [
  { type: 'session', id: 'session-dsh-test', cwd: '/tmp/proj', createdAt: 1700000000000 },
  { type: 'turn/start', seq: 0, time: 1700000000000, data: { turn: 1 } },
  { type: 'step/start', seq: 1, time: 1700000000000, data: { turn: 1, step: 1 } },
  { type: 'user/message', seq: 2, time: 1700000000000, surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text: '你好' }] } },
  { type: 'assistant/message', seq: 3, time: 1700000000000, surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '回复' }] } } },
  { type: 'step/end', seq: 4, time: 1700000000000, data: { turn: 1, step: 1 } },
  { type: 'turn/end', seq: 5, time: 1700000000000, data: { turn: 1 } },
  { type: 'session/title', seq: 6, time: 1700000000000, data: { title: 'DSH 导入测试' } },
]
const RAW = SESSION_LINES.map((l) => JSON.stringify(l)).join('\n')

test('convertDshJsonl 保留核心事件并重排 seq', () => {
  const out = convertDshJsonl(RAW, { sourcePath: '/tmp/proj/session.jsonl' })
  assert.equal(out.meta.id, 'import-session-dsh-test')
  assert.equal(out.meta.cwd, '/tmp/proj')
  assert.equal(out.turns.length, 1)
  assert.equal(out.title, 'DSH 导入测试')
  assert.equal(out.messages, 2)
  assert.equal(out.toolCalls, 0)
  // 不再写 session/imported 标记（issue #34：宿主 fail-closed 词汇表）
  assert.ok(out.events.every((e) => e.type !== 'session/imported'))
  assert.ok(out.events.every((e) => Number.isFinite(e.seq)))
  assert.deepEqual(out.events.slice(0, 2).map((e) => e.type), ['turn/start', 'step/start'])
})

test('convertDshJsonl 净化旧日志：过滤标记事件、剥离词汇表外 envelope 键、密集重排 seq（issue #34）', () => {
  // 0.8.2 及以前写入的日志：头上有 session/imported（ignorable: true）
  const legacy = [
    { type: 'session', id: 'legacy-x', cwd: '/tmp/proj', createdAt: 1700000000000 },
    { type: 'session/imported', seq: 0, time: 1700000000000, ignorable: true, data: { tool: 'import_dsh', sourcePath: '/tmp/old.jsonl', importedAt: 1700000000001 } },
    { type: 'turn/start', seq: 1, time: 1700000000000, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, time: 1700000000000, data: { callId: 'c1', name: 'read', arguments: '{}' } },
    { type: 'tool/result', seq: 3, time: 1700000000000, surfaceOp: 'append', sourceEventSeqs: [2], data: { message: { id: 'm1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }], source: { kind: 'tool', callId: 'c1' } } } },
    { type: 'turn/end', seq: 4, time: 1700000000000, data: { turn: 1 } },
  ]
  const out = convertDshJsonl(legacy.map((l) => JSON.stringify(l)).join('\n'), { sourcePath: '/tmp/proj/legacy-x.jsonl' })
  assert.ok(out.events.every((e) => e.type !== 'session/imported'))
  assert.ok(out.events.every((e) => !('ignorable' in e)))
  assert.deepEqual(out.events.map((e) => e.seq), [0, 1, 2, 3])
  // sourceEventSeqs 引用重映射到重排后的新 seq
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.deepEqual(result.sourceEventSeqs, [1])
})

test('discoverSessions format=dsh 发现 session.jsonl 会话', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-import-test-'))
  const dir = join(root, 'sessions', 'encoded', 'session-dsh-test')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'session.jsonl')
  await writeFile(file, RAW + '\n')
  const host = {
    async stat(path) {
      try {
        const s = await stat(path)
        return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtimeMs: s.mtimeMs }
      } catch {
        return null
      }
    },
    async readHead(path, bytes) {
      const fh = await open(path, 'r')
      try {
        const b = Buffer.alloc(Math.min(bytes, 64 * 1024))
        const { bytesRead } = await fh.read(b, 0, b.length, 0)
        return b.subarray(0, bytesRead).toString('utf8')
      } finally {
        await fh.close()
      }
    },
    async readText(path) {
      try { return await readFile(path, 'utf8') } catch { return null }
    },
    async readDir(path) {
      const entries = await readdir(path, { withFileTypes: true })
      return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file', path: join(path, e.name) }))
    },
    async readSessions() { return [] },
  }
  try {
    const found = await discoverSessions({ format: 'dsh', path: join(root, 'sessions'), host, imports: {} })
    assert.equal(found.total, 1)
    assert.equal(found.sessions[0].format, 'dsh')
    assert.equal(found.sessions[0].sessionId, 'session-dsh-test')
    assert.equal(found.sessions[0].title, 'DSH 导入测试')
    assert.equal(found.sessions[0].messageCount, 2)
    assert.equal(found.sessions[0].sourcePath, file)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// session.jsonl.zstd 的最小 zstd 帧 fixture（Python zstandard 压缩
// session/turn/user/title 四条 JSONL 记录生成，raw 431B → zstd 243B），
// 以二进制文件存放避免 dsh.so 把超长 base64 字面量判为疑似混淆载荷。
// 路线 A 用 fzstd 纯 JS 解压替代系统 zstd 二进制（child_process 判为 critical）。
test('readDshText 用 fzstd 纯 JS 解压 session.jsonl.zstd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-zstd-test-'))
  try {
    const file = join(root, 'session.jsonl.zstd')
    const fixturePath = fileURLToPath(new URL('./fixtures/session.jsonl.zstd', import.meta.url))
    await writeFile(file, await readFile(fixturePath))
    const text = await readDshText({}, file)
    assert.ok(text.includes('session-zstd-test'))
    assert.ok(text.includes('Zstd 导入测试'))
    const out = convertDshJsonl(text, { sourcePath: file })
    assert.equal(out.meta.id, 'import-session-zstd-test')
    assert.equal(out.title, 'Zstd 导入测试')
    assert.equal(out.messages, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

