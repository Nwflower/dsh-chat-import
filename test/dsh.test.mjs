import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, stat, readFile, readdir, open, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Buffer } from 'node:buffer'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { convertDshJsonl } from '../lib/convert/dsh.mjs'
import { defaultRoots, discoverSessions } from '../lib/discovery.mjs'
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

test('convertDshJsonl sourceEventSeqs 区间对展开 + 悬空引用丢弃（issue #38 主场景）', () => {
  // 新版 DSH 形态：assistant/message 用区间对 [[1,5]] 聚合引用，其中 1-3 是
  // assistant/chunk（非 DURABLE，转换丢弃）、4-5 是 tool/call（保留）。
  // 期望：区间展开 [1..5]，chunk 引用悬空丢弃，call 引用映射到重排后新 seq——
  // 引用密集、无重复、全部严格早于当前事件（宿主 provenance 校验口径）。
  const lines = [
    { type: 'session', id: 'issue-38', cwd: '/tmp/proj', createdAt: 1700000000000 },
    { type: 'assistant/chunk', seq: 1, time: 1700000000000, data: {} },
    { type: 'assistant/chunk', seq: 2, time: 1700000000000, data: {} },
    { type: 'assistant/chunk', seq: 3, time: 1700000000000, data: {} },
    { type: 'tool/call', seq: 4, time: 1700000000000, data: { callId: 'c1', name: 'read', arguments: '{}' } },
    { type: 'tool/call', seq: 5, time: 1700000000000, data: { callId: 'c2', name: 'read', arguments: '{}' } },
    { type: 'assistant/message', seq: 6, time: 1700000000000, surfaceOp: 'append', sourceEventSeqs: [[1, 5]], data: { message: { role: 'assistant', content: [{ type: 'text', text: '聚合回复' }] } } },
  ]
  const out = convertDshJsonl(lines.map((l) => JSON.stringify(l)).join('\n'), { sourcePath: '/tmp/proj/issue-38.jsonl' })
  const msg = out.events.find((e) => e.type === 'assistant/message')
  // c1→0、c2→1、assistant→2；悬空的 1-3（chunk）丢弃
  assert.deepEqual(msg.sourceEventSeqs, [0, 1])
})

test('convertDshJsonl sourceEventSeqs 混合形态：区间对 + 单整数、区间内混杂已丢弃事件', () => {
  // 区间 [[1,3]] 内的 seq 2 是 chunk（丢弃）→ 只保留 1、3 的映射；单整数 4 是 call
  const lines = [
    { type: 'session', id: 'issue-38-mixed', cwd: '/tmp/proj', createdAt: 1700000000000 },
    { type: 'tool/call', seq: 1, time: 1700000000000, data: { callId: 'c1', name: 'read', arguments: '{}' } },
    { type: 'assistant/chunk', seq: 2, time: 1700000000000, data: {} },
    { type: 'tool/call', seq: 3, time: 1700000000000, data: { callId: 'c2', name: 'read', arguments: '{}' } },
    { type: 'tool/call', seq: 4, time: 1700000000000, data: { callId: 'c3', name: 'read', arguments: '{}' } },
    { type: 'tool/result', seq: 5, time: 1700000000000, surfaceOp: 'append', sourceEventSeqs: [[1, 3], 4], data: { message: { id: 'm1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }], source: { kind: 'tool', callId: 'c1' } } } },
  ]
  const out = convertDshJsonl(lines.map((l) => JSON.stringify(l)).join('\n'), { sourcePath: '/tmp/proj/issue-38-mixed.jsonl' })
  const result = out.events.find((e) => e.type === 'tool/result')
  // c1→0、c2→1、c3→2、result→3；2（chunk）悬空丢弃
  assert.deepEqual(result.sourceEventSeqs, [0, 1, 2])
})

test('convertDshJsonl sourceEventSeqs 全悬空：引用键整体移除（宿主仅 assistant/message 允许空数组）', () => {
  // issue 原始形态：assistant/message 只引用 chunk 区间——全悬空后无有效引用，
  // 删键对全部事件类型合法（空数组会被宿主 provenance 校验对非 assistant 拒载）
  const lines = [
    { type: 'session', id: 'issue-38-empty', cwd: '/tmp/proj', createdAt: 1700000000000 },
    { type: 'assistant/chunk', seq: 1, time: 1700000000000, data: {} },
    { type: 'assistant/chunk', seq: 2, time: 1700000000000, data: {} },
    { type: 'assistant/message', seq: 3, time: 1700000000000, surfaceOp: 'append', sourceEventSeqs: [[1, 2]], data: { message: { role: 'assistant', content: [{ type: 'text', text: '回复' }] } } },
  ]
  const out = convertDshJsonl(lines.map((l) => JSON.stringify(l)).join('\n'), { sourcePath: '/tmp/proj/issue-38-empty.jsonl' })
  const msg = out.events.find((e) => e.type === 'assistant/message')
  assert.ok(!('sourceEventSeqs' in msg))
})

test('convertDshJsonl sourceEventSeqs 畸形形态：反向区间丢弃、重叠区间去重、巨型区间不展开（防 OOM）', () => {
  const lines = [
    { type: 'session', id: 'issue-38-bad', cwd: '/tmp/proj', createdAt: 1700000000000 },
    { type: 'tool/call', seq: 1, time: 1700000000000, data: { callId: 'c1', name: 'read', arguments: '{}' } },
    { type: 'tool/call', seq: 2, time: 1700000000000, data: { callId: 'c2', name: 'read', arguments: '{}' } },
    { type: 'tool/call', seq: 3, time: 1700000000000, data: { callId: 'c3', name: 'read', arguments: '{}' } },
    // 反向区间 [5,2] 无效 → 展开器原样透传 → 重映射无映射丢弃 → 键移除
    { type: 'tool/result', seq: 4, time: 1700000000000, surfaceOp: 'append', sourceEventSeqs: [[5, 2]], data: { message: { id: 'm1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }], source: { kind: 'tool', callId: 'c1' } } } },
    // 重叠区间 [[1,2],[2,3]] 展开产生重复 2 → 去重保首现；巨型区间 [1,1e9] 超上限
    // 不展开 → 透传后无映射丢弃（若被展开本测试会因内存/耗时爆炸失败）
    { type: 'tool/result', seq: 5, time: 1700000000000, surfaceOp: 'append', sourceEventSeqs: [[1, 2], [2, 3], [1, 1000000000]], data: { message: { id: 'm2', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c2', content: [] }], source: { kind: 'tool', callId: 'c2' } } } },
  ]
  const out = convertDshJsonl(lines.map((l) => JSON.stringify(l)).join('\n'), { sourcePath: '/tmp/proj/issue-38-bad.jsonl' })
  const results = out.events.filter((e) => e.type === 'tool/result')
  assert.ok(!('sourceEventSeqs' in results[0]))
  // c1→0、c2→1、c3→2、r2→3：[1,2]∪[2,3] → [0,1,1,2] → 去重 [0,1,2]
  assert.deepEqual(results[1].sourceEventSeqs, [0, 1, 2])
})

// 真实文件系统 host stub（dsh 源发现面：stat / readHead / readText / readDir /
// readSessions），默认根与显式 path 两条发现路径共用。
function makeDshHost() {
  return {
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
}

test('discoverSessions format=dsh 发现 session.jsonl 会话', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-import-test-'))
  const dir = join(root, 'sessions', 'encoded', 'session-dsh-test')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'session.jsonl')
  await writeFile(file, RAW + '\n')
  const host = makeDshHost()
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

// dsh 默认发现根随宿主 DSH_HOME 走（桌面 harness 域 ≠ ~/.dsh）：env 优先与
// registryDir（$DSH_HOME/dsh-chat-import）同域，env 缺省回退 ~/.dsh（CLI 直跑）。
test('defaultRoots：dsh 默认根优先 $DSH_HOME，env 缺省回退 ~/.dsh', () => {
  const prev = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = join('mock-root', 'harness')
    assert.equal(defaultRoots({ home: join('mock-home') }).dsh, join('mock-root', 'harness', 'sessions'))
    delete process.env.DSH_HOME
    assert.equal(defaultRoots({ home: join('mock-home') }).dsh, join('mock-home', '.dsh', 'sessions'))
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})

test('discoverSessions format=dsh：不传 path 时扫描 $DSH_HOME/sessions（桌面 harness 域）', async () => {
  const prev = process.env.DSH_HOME
  const root = await mkdtemp(join(tmpdir(), 'dsh-root-test-'))
  try {
    process.env.DSH_HOME = root
    const dir = join(root, 'sessions', '_proj', 'session-root-test')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.jsonl'), RAW + '\n')
    const found = await discoverSessions({ format: 'dsh', host: makeDshHost(), imports: {} })
    assert.equal(found.total, 1)
    assert.equal(found.sessions[0].sessionId, 'session-dsh-test')
    assert.equal(found.sessions[0].sourcePath, join(dir, 'session.jsonl'))
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    await rm(root, { recursive: true, force: true })
  }
})

test('discoverSessions format=dsh：超过阈值的 .zstd 不解压，按目录名兜底 sessionId（首扫分钟级 → 秒级）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-big-test-'))
  try {
    const dir = join(root, 'sessions', 'big-proj', 'session-large-test')
    await mkdir(dir, { recursive: true })
    // 300KB 伪 zstd（内容非法也无妨——快路径不解压）；对照：小文件仍走解压取头
    await writeFile(join(dir, 'session.jsonl.zstd'), Buffer.alloc(256 * 1024 + 1, 7))
    const smallDir = join(root, 'sessions', 'big-proj', 'session-small-test')
    await mkdir(smallDir, { recursive: true })
    await writeFile(join(smallDir, 'session.jsonl'), RAW + '\n')
    const found = await discoverSessions({ format: 'dsh', path: join(root, 'sessions'), host: makeDshHost(), imports: {} })
    assert.equal(found.total, 2)
    const big = found.sessions.find((s) => s.sessionId === 'session-large-test')
    assert.ok(big, '大文件按目录名兜底出现在列表')
    assert.equal(big.title, null)
    assert.equal(big.messageCount, 0)
    assert.equal(big.project, 'big-proj')
    // 小文件 sessionId 来自日志头（权威）；大文件兜底目录名——DSH 布局两者同构
    assert.equal(found.sessions.find((s) => s.sessionId === 'session-dsh-test').title, 'DSH 导入测试')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('discoverSessions format=dsh：导入产物目录（import-<id>）不当源扫出', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-imported-test-'))
  try {
    // 产物目录里的会话头 id 也是 import- 前缀（与目录名同构），两者都不得入列表
    const dir = join(root, 'sessions', 'encoded', 'import-session-dsh-test')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.jsonl'), RAW + '\n')
    const found = await discoverSessions({ format: 'dsh', path: join(root, 'sessions'), host: makeDshHost(), imports: {} })
    assert.equal(found.total, 0)
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

