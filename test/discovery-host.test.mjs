// test/discovery-host.test.mjs — 发现层 host 适配的有界读取（readHead / readTail / readBytes）
//
// readTail 是「大 transcript 只取尾部元数据」的路径（claude/kimi 的 contextTokens、dsh 的尾部标题）：
// 宿主 fs 有 readByteRange 时按偏移只读末尾窗口（窗口起点落在多字节字符中间要跳过续字节）；
// 没有时流式读到底、在内存里滚动保留末尾 maxBytes；再没有 streamText 时回退 readText 截尾。
// readBytes 有界读原始字节（.zstd 日志），超限 / 缺失返回 null。
import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setImmediate } from 'node:timers'
import { makeDiscoveryHost } from '../lib/discovery-host.mjs'
import { cursorWorkspaceFixture } from './_support/cursor.mjs'
import { withTempDirAsync } from './_support/tmp-db.mjs'

// 伪 fs：files 是 path → 文本；streamText 按 chunkSize 分块 yield（模拟宿主流式读）；
// withRange 时提供 readByteRange（按 UTF-8 字节偏移取窗口），calls 记录各能力的调用次数。
function fakeCtx(files, { chunkSize = 64, withStream = true, withRange = false, withBytes = false } = {}) {
  const calls = { stream: 0, range: 0, bytes: 0 }
  const fs = {
    async resolve(p) { return p },
    async stat(p) {
      if (!files.has(p)) return null
      return { type: 'file', size: Buffer.byteLength(files.get(p)), mtimeMs: 1 }
    },
    async readText(p) { return files.has(p) ? files.get(p) : null },
    async listDir() { return [] },
  }
  if (withStream) {
    fs.streamText = async function* streamText(p) {
      calls.stream++
      const text = files.get(p)
      if (text === undefined) throw new Error('ENOENT')
      for (let i = 0; i < text.length; i += chunkSize) yield text.slice(i, i + chunkSize)
    }
  }
  if (withRange) {
    fs.readByteRange = async (p, { offset, length }) => {
      calls.range++
      const buf = Buffer.from(files.get(p), 'utf8')
      return new Uint8Array(buf.subarray(offset, offset + length))
    }
  }
  if (withBytes) {
    fs.readBytes = async (p, _signal, maxBytes) => {
      calls.bytes++
      const buf = Buffer.from(files.get(p), 'utf8')
      if (buf.length > maxBytes) throw Object.assign(new Error('too large'), { code: 'FS_TOO_LARGE' })
      return new Uint8Array(buf)
    }
  }
  return { fs, calls }
}

test('cursorComposerWorkspace：host 按 composerId 读取登记册，缺行返回 null', async () => {
  await withTempDirAsync('cursor-host-', async (root) => {
    const cwd = join(root, 'moved-project')
    const { ctx } = cursorWorkspaceFixture(root, {
      rows: [{ composerId: 'registered', value: JSON.stringify({ workspaceIdentifier: { uri: { fsPath: cwd } } }) }],
      tree: { [cwd]: 'dir' },
    })
    const host = makeDiscoveryHost(ctx)
    assert.equal(await host.cursorComposerWorkspace('registered'), cwd)
    assert.equal(await host.cursorComposerWorkspace('missing'), null)
  })
})

test('readTail：跨多块流式读取时返回末尾 maxBytes（滚动窗口不累积未淘汰块）', async () => {
  const text = Array.from({ length: 1000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')
  const host = makeDiscoveryHost(fakeCtx(new Map([['/f.jsonl', text]]), { chunkSize: 64 }))
  const tail = await host.readTail('/f.jsonl', 100)
  assert.equal(tail, text.slice(-100))
  assert.equal(tail.length, 100)
})

test('readTail：单个 chunk 自身就超过 maxBytes 时取该块末尾（不丢尾部）', async () => {
  const text = 'x'.repeat(5000) + 'TAILMARKER'
  const host = makeDiscoveryHost(fakeCtx(new Map([['/f.jsonl', text]]), { chunkSize: 100000 }))
  const tail = await host.readTail('/f.jsonl', 32)
  assert.equal(tail.length, 32)
  assert.ok(tail.endsWith('TAILMARKER'))
})

test('readTail：文本不足 maxBytes 时原样返回；缺失文件返回 null', async () => {
  const host = makeDiscoveryHost(fakeCtx(new Map([['/small.jsonl', 'short text']])))
  assert.equal(await host.readTail('/small.jsonl', 4096), 'short text')
  assert.equal(await host.readTail('/missing.jsonl', 4096), null)
})

test('readTail：无 streamText（测试 mock / 降级 fs）时回退 readText 截尾，行为与旧版一致', async () => {
  const text = 'y'.repeat(300) + 'END'
  const host = makeDiscoveryHost(fakeCtx(new Map([['/f.jsonl', text]]), { withStream: false }))
  assert.equal(await host.readTail('/f.jsonl', 10), text.slice(-10))
  assert.equal(await host.readTail('/f.jsonl', 10000), text)
})

test('readHead：有界读头（取到 maxBytes 即停），无 streamText 时回退截断', async () => {
  const text = 'z'.repeat(1000)
  const streamed = makeDiscoveryHost(fakeCtx(new Map([['/f.jsonl', text]]), { chunkSize: 64 }))
  assert.equal((await streamed.readHead('/f.jsonl', 100)).length, 100)
  assert.equal(await streamed.readHead('/f.jsonl', 5000), text)
  const fallback = makeDiscoveryHost(fakeCtx(new Map([['/f.jsonl', text]]), { withStream: false }))
  assert.equal((await fallback.readHead('/f.jsonl', 100)).length, 100)
})

test('readTail：宿主有 readByteRange 时按偏移只读末尾窗口，不流式读整份文件', async () => {
  const text = 'x'.repeat(100000) + 'TAIL-END'
  const ctx = fakeCtx(new Map([['/big.jsonl', text]]), { withRange: true })
  const host = makeDiscoveryHost(ctx)
  assert.equal(await host.readTail('/big.jsonl', 64), text.slice(-64))
  assert.equal(ctx.calls.range, 1)
  assert.equal(ctx.calls.stream, 0, '不再流过整份文件')
  assert.equal(await host.readTail('/missing.jsonl', 64), null)
})

test('readTail：字节窗口起点落在多字节字符中间时跳过残缺字节，不产生替换字符', async () => {
  const text = '{"a":1}\n' + '中'.repeat(50) + '\n{"b":"尾"}'
  const host = makeDiscoveryHost(fakeCtx(new Map([['/u.jsonl', text]]), { withRange: true }))
  const tail = await host.readTail('/u.jsonl', 31) // 31 不是 3 的倍数：窗口起点切在「中」的中间
  assert.ok(!tail.includes('\uFFFD'), JSON.stringify(tail))
  assert.ok(tail.endsWith('{"b":"尾"}'))
  assert.ok(text.endsWith(tail))
})

test('readBytes：经宿主 readBytes 有界读原始字节；超限 / 缺失返回 null', async () => {
  const ctx = fakeCtx(new Map([['/s.zstd', 'raw-bytes']]), { withBytes: true })
  const host = makeDiscoveryHost(ctx)
  assert.equal(Buffer.from(await host.readBytes('/s.zstd', 1024)).toString('utf8'), 'raw-bytes')
  assert.equal(await host.readBytes('/s.zstd', 4), null)
  assert.equal(await host.readBytes('/missing.zstd', 1024), null)
  assert.equal(ctx.calls.bytes, 3)
})

test('readSessions：读取器异常（非 SQLite 文件）原样抛出交给发现层上报；未知格式返回 null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-host-db-'))
  try {
    const bogus = join(dir, 'opencode.db')
    writeFileSync(bogus, 'definitely not a sqlite database file '.repeat(200))
    const host = makeDiscoveryHost({ fs: { resolve: async (p) => p } })
    await assert.rejects(() => host.readSessions('opencode', bogus))
    assert.equal(await host.readSessions('no-such-format', bogus), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readSessions：同步 SQLite 读取前先让出一轮事件循环（库与库之间不连续阻塞）', async () => {
  const host = makeDiscoveryHost({ fs: { resolve: async (p) => p } })
  const order = []
  setImmediate(() => order.push('macrotask'))
  await assert.rejects(() => host.readSessions('opencode', join(tmpdir(), 'dsh-missing-' + Date.now() + '.db')))
  order.push('read-done')
  assert.deepEqual(order, ['macrotask', 'read-done'])
})

test('readLines：跨块中文、CRLF、空行与无末尾换行，不整读文件', async () => {
  const ctx = fakeCtx(new Map([['index', '标题一\r\n\r\n标题二\n末行']]), { chunkSize: 1 })
  ctx.fs.readText = async () => { throw new Error('不得整读') }
  const out = []
  for await (const line of makeDiscoveryHost(ctx).readLines('index')) out.push(line)
  assert.deepEqual(out, ['标题一', '', '标题二', '末行'])
})

test('readLines：提前停止时关闭宿主流，读取失败向调用方传播', async () => {
  let closed = false
  const ctx = { fs: { resolve: async (p) => p, async *streamText() {
    try { yield 'first\n'; yield 'second\n' } finally { closed = true }
  } } }
  for await (const line of makeDiscoveryHost(ctx).readLines('index')) { assert.equal(line, 'first'); break }
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(closed, true)
  ctx.fs.streamText = async function* () { throw new Error('read failed') }
  await assert.rejects(async () => { for await (const _line of makeDiscoveryHost(ctx).readLines('index')) { assert.fail('unexpected line: ' + _line) } }, /read failed/)
})

test('readLines：无宿主 streamText 时使用 processPath 文件流，不调用 readText', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-index-lines-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'session_index.jsonl')
  writeFileSync(path, '中文标题\r\n最后一行')
  const host = makeDiscoveryHost({ fs: {
    resolve: async () => ({ targetKey: 'index' }), processPath: () => path,
    readText: async () => { throw new Error('不得整读') },
  } })
  const out = []
  for await (const line of host.readLines('index')) out.push(line)
  assert.deepEqual(out, ['中文标题', '最后一行'])
})
