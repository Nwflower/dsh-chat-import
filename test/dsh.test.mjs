import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, stat, readFile, readdir, open, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { convertDshJsonl } from '../lib/convert/dsh.mjs'
import { convertCodexJsonl } from '../lib/convert/codex.mjs'
import { validateSessionEvents } from '../lib/convert/core.mjs'
import { codexCompactedRollout } from './_support/codex-compacted.mjs'
import { defaultRoots, discoverSessions } from '../lib/discovery.mjs'
import { dshSessionLogVersion, isDshSessionFile, readDshText, decodeZstdText } from '../lib/sources/dsh.mjs'

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

test('convertDshJsonl 保留原生压缩事务（重导压缩过的 DSH 会话不丢检查点）', () => {
  // 真源：用 codex 压缩夹具生成一份带原生检查点的事件日志，再当作 DSH 日志重导
  const codex = convertCodexJsonl(codexCompactedRollout(), { sessionId: 'codex-comp-1' })
  const lines = [
    { type: 'session', id: 'session-comp', cwd: '/tmp/proj', createdAt: 1700000000000 },
    ...codex.events,
  ]
  const out = convertDshJsonl(lines.map((l) => JSON.stringify(l)).join('\n'), { sourcePath: '/tmp/proj/session-comp.jsonl' })
  assert.equal(out.compacted, true)
  assert.equal(out.compactions, 1)
  assert.equal(out.events.filter((e) => e.type === 'compaction/start').length, 1)
  // 检查点：replace 范围与溯源都重映射到新 seq，source 仍是 compact 标记
  const ck = out.events.find((e) => e.type === 'user/message' && typeof e.surfaceOp === 'object')
  assert.equal(ck.surfaceOp.op, 'replace')
  assert.ok(Number.isInteger(ck.surfaceOp.start) && Number.isInteger(ck.surfaceOp.end))
  assert.deepEqual(ck.data.source, { kind: 'plugin', plugin: 'compact', compactionId: 'import:codex-comp-1:c1' })
  const summary = out.events.find((e) => e.type === 'compaction/summary')
  assert.deepEqual(summary.data.shadowedSeqs, ck.sourceEventSeqs)
  assert.deepEqual(summary.data.shadowedRange, { start: ck.surfaceOp.start, end: ck.surfaceOp.end })
  // 重排后的日志自带校验（括号配对 / 遮蔽范围 / 检查点溯源）
  assert.deepEqual(validateSessionEvents(out.events), { ok: true, problems: [] })
  assert.ok(out.events.some((e) => e.type === 'turn/start'))

  // V4 形状：source.kind='plugin:compact' 读回来还原成 V3 形状（写 V4 时再改写）
  const v4 = lines.map((l) => (l.type === 'user/message' && l.surfaceOp && typeof l.surfaceOp === 'object'
    ? { ...l, data: { ...l.data, source: { kind: 'plugin:compact', compactionId: l.data.source.compactionId } } }
    : l))
  const out4 = convertDshJsonl(v4.map((l) => JSON.stringify(l)).join('\n'), { sourcePath: '/tmp/proj/session-comp.jsonl' })
  assert.equal(out4.compactions, 1)
  assert.equal(out4.events.find((e) => e.type === 'user/message' && typeof e.surfaceOp === 'object').data.source.kind, 'plugin')
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
    assert.equal(big.project, 'big-proj')
    // 小文件 sessionId 来自日志头（权威）；大文件兜底目录名——DSH 布局两者同构
    assert.equal(found.sessions.find((s) => s.sessionId === 'session-dsh-test').title, 'DSH 导入测试')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('decodeZstdText：单帧夹具解出全部记录（session/turn/user/title）', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/session.jsonl.zstd', import.meta.url))
  const buf = await readFile(fixture)
  const text = await decodeZstdText(buf)
  assert.match(text, /"id": "session-zstd-test"/)
  assert.equal(text.split('\n').filter(Boolean).length, 4)
})

test('decodeZstdText：非法载荷大声抛错（不静默返回空文本）', async () => {
  await assert.rejects(() => decodeZstdText(Buffer.from('not a zstd frame')), /./)
})

test('decodeZstdText：多帧拼接日志全解（宿主逐事件 flush；只解首帧会丢光对话）', async () => {
  // 回归：宿主按「一条事件一次 flush」写日志，磁盘上的 .zstd 是多帧拼接（本机实测一条
  // 6.5MB 压缩 / 33MB 明文日志 1962 帧）。node:zlib 的 zstdDecompress /
  // createZstdDecompress 只解第一帧、其余静默丢弃——只解首帧就只剩 session 头那一行，
  // 转换出 0 轮，整份导入按「无可导入内容」跳过（表现为「只归档旧会话、不建新会话」）。
  const lines = [
    '{"type":"session","id":"multi-frame","createdAt":1700000000000}',
    '{"type":"turn/start","seq":0,"time":1700000000000,"data":{"turn":1}}',
    '{"type":"user/message","seq":1,"time":1700000000000,"surfaceOp":"append","data":{"role":"user","content":[{"type":"text","text":"多帧"}]}}',
    '{"type":"turn/end","seq":2,"time":1700000000000,"data":{"turn":1}}',
  ]
  const buf = Buffer.concat(lines.map((l) => zstdCompressSync(Buffer.from(l + '\n'))))
  const text = await decodeZstdText(buf)
  assert.equal(text.split('\n').filter(Boolean).length, lines.length)
  const out = convertDshJsonl(text, { sourcePath: '/tmp/multi/session.v3.jsonl.zstd' })
  assert.equal(out.meta.id, 'import-multi-frame')
  assert.equal(out.turns.length, 1)
  assert.equal(out.messages, 1)
  assert.ok(out.events.length > 0, '多帧日志的事件必须全部解出')
})

test('decodeZstdText：帧内出现魔数字节序列（raw block）时后续帧仍完整解出', async () => {
  // 不可压缩载荷会被 zstd 存成 raw block，字节原样出现在压缩正文里——4 字节帧魔数
  // 0x28B52FFD 因此可能在帧内“假阳性”出现。解码器必须仍能解出后续帧（按魔数切分
  // 逐帧解 + 静默截断的实现会在这里丢内容）。
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const raw = Buffer.concat([randomBytes(65536), magic, randomBytes(65536)])
  const first = zstdCompressSync(raw)
  const tail = '{"type":"session","id":"after-raw","createdAt":1700000000000}\n'
  assert.ok(first.indexOf(magic, 1) > 0, '夹具必须在帧内制造魔数（raw block 原样存储）')
  const text = await decodeZstdText(Buffer.concat([first, zstdCompressSync(Buffer.from(tail))]))
  assert.ok(text.includes('"after-raw"'), '帧内魔数不得吞掉后续帧')
})

test('decodeZstdText：截断的帧大声抛错（不静默返回半份日志）', async () => {
  const frame = zstdCompressSync(Buffer.from('{"type":"session","id":"cut"}\n'))
  await assert.rejects(() => decodeZstdText(frame.subarray(0, Math.floor(frame.length / 2))), /./)
})

test('discoverSessions format=dsh：导入产物目录（import-<id>）也列出（代次迁移要用）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-imported-test-'))
  try {
    // 已导入的会话（目录名与头部 id 都是 import- 前缀）要能被列出来：把一条已导入的会话
    // 迁移到另一代次（V3 ↔ V4）正是这个来源的用途；重导不会覆盖原会话（新 id 变成
    // import-import-…），幂等判定与 Toast「忽略警告」照常兜底。
    const dir = join(root, 'sessions', 'encoded', 'import-session-dsh-test')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.jsonl'), RAW + '\n')
    const found = await discoverSessions({ format: 'dsh', path: join(root, 'sessions'), host: makeDshHost(), imports: {} })
    assert.equal(found.total, 1)
    assert.equal(found.sessions[0].sessionId, 'session-dsh-test')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// session.jsonl.zstd 的最小 zstd 帧 fixture（Python zstandard 压缩
// session/turn/user/title 四条 JSONL 记录生成，raw 431B → zstd 243B），
// 以二进制文件存放避免 dsh.so 把超长 base64 字面量判为疑似混淆载荷。
// 路线 A 用 zstd 解压替代系统 zstd 二进制（child_process 判为 critical）：
// decodeZstdText 走 fzstd（自带多帧；node:zlib 原生只解首帧，见上方回归用例）。
test('readDshText 解压 session.jsonl.zstd 并转换出会话', async () => {
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


test('convertDshJsonl 透传净化：补 surfaceOp / stream、归一 tool/result source（issue #41）', () => {
  // 旧宿主/旧插件写出的日志在新宿主（dsh >= 0.1.5）上 fail-closed：surface 事件
  // 缺 surfaceOp、assistant/message 缺 settlement 字段 stream、tool/result 的
  // source 是 user-kind——任一条都会让整份导入被拒。
  const stale = [
    { type: 'session', id: 'stale-x', cwd: '/tmp/proj', createdAt: 1700000000000 },
    { type: 'turn/start', seq: 0, time: 1700000000000, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1700000000000, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, time: 1700000000000, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 3, time: 1700000000000, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '好的' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4' } } } },
    { type: 'tool/call', seq: 4, time: 1700000000000, data: { callId: 'c1', name: 'read', arguments: '{}' } },
    { type: 'tool/result', seq: 5, time: 1700000000000, data: { turn: 1, step: 1, message: { id: 't1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }], source: { kind: 'user' } } } },
    { type: 'step/end', seq: 6, time: 1700000000000, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 7, time: 1700000000000, data: { turn: 1 } },
  ]
  const out = convertDshJsonl(stale.map((l) => JSON.stringify(l)).join('\n'), { sourcePath: '/tmp/proj/stale-x.jsonl' })
  for (const type of ['user/message', 'assistant/message', 'tool/result']) {
    assert.equal(out.events.find((e) => e.type === type).surfaceOp, 'append', type + ' 补 surfaceOp')
  }
  const assistant = out.events.find((e) => e.type === 'assistant/message')
  assert.deepEqual(assistant.data.stream, [], 'assistant/message 补 settlement 字段 stream')
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.deepEqual(result.data.message.source, { kind: 'tool', callId: 'c1' })
  assert.equal(result.data.message.content[0].toolCallId, 'c1')
  assert.equal(out.droppedEvents, undefined, '无丢弃时不占键')
})

test('convertDshJsonl 丢弃无法归一的 tool/result 并计数上报（issue #41）', () => {
  // tool/result 两侧都没有 callId：无法关联任何 tool/call，保留只会让整份导入失败
  const lines = [
    { type: 'session', id: 'orphan-x', cwd: '/tmp/proj', createdAt: 1700000000000 },
    { type: 'turn/start', seq: 0, time: 1700000000000, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 1700000000000, surfaceOp: 'append', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, time: 1700000000000, surfaceOp: 'append', data: { turn: 1, step: 1, stream: [], message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '好的' }], source: { kind: 'model', provider: 'dsh', model: 'm' } } } },
    { type: 'tool/result', seq: 3, time: 1700000000000, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 't1', role: 'user', content: [{ type: 'tool-result', toolCallId: '', content: [] }], source: { kind: 'user' } } } },
    { type: 'turn/end', seq: 4, time: 1700000000000, data: { turn: 1 } },
  ]
  const out = convertDshJsonl(lines.map((l) => JSON.stringify(l)).join('\n'), { sourcePath: '/tmp/proj/orphan-x.jsonl' })
  assert.equal(out.droppedEvents, 1)
  assert.ok(out.events.every((e) => e.type !== 'tool/result'))
  // 丢弃后 seq 仍密集连续
  assert.deepEqual(out.events.map((e) => e.seq), out.events.map((_, i) => i))
})

// DSH 会话工件按代次命名：v0 是 session.jsonl，vN（N>=1）是 session.vN.jsonl，
// 压缩再加 .zstd。此前只认 v0，当前代次（本机 52 个里的 48 个）全部扫不出来。
test('dshSessionLogVersion 识别各代次工件名，拒绝非会话文件', () => {
  assert.equal(dshSessionLogVersion('session.jsonl'), 0)
  assert.equal(dshSessionLogVersion('session.jsonl.zstd'), 0)
  assert.equal(dshSessionLogVersion('session.v1.jsonl.zstd'), 1)
  assert.equal(dshSessionLogVersion('session.v3.jsonl.zstd'), 3)
  assert.equal(dshSessionLogVersion('session.V3.JSONL.ZSTD'), 3)
  assert.equal(dshSessionLogVersion('session.v12.jsonl'), 12)
  // v0 不是规范写法（sessionFormatLogFilename 只对 >=1 加 .vN），不当作会话
  assert.equal(dshSessionLogVersion('session.v0.jsonl'), undefined)
  assert.equal(dshSessionLogVersion('session.v03.jsonl.zstd'), undefined)
  assert.equal(dshSessionLogVersion('rollout-2026-01-02.jsonl'), undefined)
  assert.equal(dshSessionLogVersion('summary.json'), undefined)
  assert.equal(dshSessionLogVersion(''), undefined)
  assert.equal(dshSessionLogVersion(undefined), undefined)
  assert.equal(isDshSessionFile('session.v3.jsonl.zstd'), true)
  assert.equal(isDshSessionFile('session.jsonl'), true)
  assert.equal(isDshSessionFile('session.v0.jsonl'), false)
})

test('discoverSessions format=dsh 发现当前代次 session.v3.jsonl.zstd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-import-gen3-'))
  const dir = join(root, 'sessions', 'encoded', 'session-dsh-gen3')
  await mkdir(dir, { recursive: true })
  // 超过快路径阈值即不解压，故无需真实 zstd 帧；本用例断言的是「发现」，不是解压。
  const file = join(dir, 'session.v3.jsonl.zstd')
  await writeFile(file, Buffer.alloc(256 * 1024 + 1, 7))
  const host = makeDshHost()
  try {
    const found = await discoverSessions({ format: 'dsh', path: join(root, 'sessions'), host, imports: {} })
    assert.equal(found.total, 1)
    assert.equal(found.sessions[0].format, 'dsh')
    assert.equal(found.sessions[0].sourcePath, file)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// 兼容我们自己的历史产物：导入会话的日志里有插件注入的「环境变更声明」（V3 形状
// source.kind='plugin'，V4 形状 kind='plugin:chat-import'）与 system head。重导这些会话时
// 注入声明不是用户提问——否则标题与每轮 prompt 都会变成那段声明。
test('convertDshJsonl：跳过本插件注入的环境变更声明（V3 / V4 两种 source 形状）', async () => {
  const { convertDshJsonl } = await import('../lib/convert/index.mjs')
  const lines = [
    { type: 'session', version: 3, id: 'session-own-1', cwd: '/demo/proj', createdAt: 1700000000000 },
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 2, data: { turn: 1, step: 1 } },
    { type: 'system/message', seq: 3, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'import:session-own-1:sys', role: 'system', content: [], source: { kind: 'plugin', plugin: 'chat-import' } } } },
    { type: 'user/message', seq: 4, surfaceOp: 'append', data: { id: 'import:session-own-1:env', role: 'user', content: [{ type: 'text', text: '环境变更声明：本会话由 dsh-chat-import 从 claude 导入' }], source: { kind: 'plugin', plugin: 'chat-import' } } },
    { type: 'user/message', seq: 5, surfaceOp: 'append', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '真实提问' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 6, surfaceOp: 'append', data: { turn: 1, step: 1, stream: [], message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '好' }], source: { kind: 'model', provider: 'p', model: 'm' } } } },
    { type: 'step/end', seq: 7, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 8, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const out = convertDshJsonl(lines.map((l) => JSON.stringify(l)).join('\n'), { sourcePath: '/demo/proj/session-own-1/session.v3.jsonl' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].prompt, '真实提问', '注入声明不能顶掉真实提问')
  assert.equal(out.title, '真实提问', '标题回退同样跳过注入声明')
})
