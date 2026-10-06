// test/session-hints.test.mjs — 列表标题提示（lib/session-hints.mjs）与发现层接入口径
//
// 契约：提示只补「来源自己没取到标题」的条目（大 .zstd 走目录名兜底的那批），来源读到的标题
// 永远优先；身份凭证是宿主持久化 header（不在列表里就不查缓存）；服务缺席 / 读失败 → 退化为
// 没有提示，只警告一次。
import test from 'node:test'
import assert from 'node:assert/strict'
import { basename, join } from 'node:path'
import { discoverSessions } from '../lib/discovery.mjs'
import { persistedIdSet } from '../lib/imports.mjs'
import { makeSessionHintProvider } from '../lib/session-hints.mjs'
import { memoryHost, withDirs } from './_support/discovery-host.mjs'

const HOME = join('C:', 'Users', 'tester')
const j = (o) => JSON.stringify(o)
const CWD = join(HOME, 'proj-a')

const headerOf = (id, over = {}) => ({ version: 4, id, createdAt: 1786000000000, cwd: CWD, isSeeded: false, ...over })

/** 假宿主服务：只实现插件用到的两个面，调用顺序可断言（当前代次优先、跨代次退回）。 */
function fakeCache({ snapshot = {}, predecessor = {}, calls = [] } = {}) {
  return {
    cachedSnapshot(header, keys) {
      calls.push(['snapshot', header.id, JSON.stringify(keys)])
      return snapshot[header.id]
    },
    cachedPredecessorTitle(header) {
      calls.push(['predecessor', header.id])
      return predecessor[header.id]
    },
  }
}

const ctxWith = (service) => ({ get: (name) => (name === 'sessionProjectionCache' ? service : undefined) })
const block = (title) => ({ asOfSeq: 3, values: title === undefined ? {} : { title } })
const withWarnSpy = (fn) => {
  const warns = []
  const prev = console.warn
  console.warn = (...a) => { warns.push(a.join(' ')) }
  try { fn(warns) } finally { console.warn = prev }
}

test('标题提示：只补 dsh/dsh4 条目，字段取自 header（标题 / cwd→project / 创建时间）', () => {
  const calls = []
  const provider = makeSessionHintProvider(
    ctxWith(fakeCache({ snapshot: { 'session-a': block('宿主折叠的标题') }, calls })),
    [headerOf('session-a')],
  )
  assert.deepEqual(provider({ format: 'dsh4', sessionId: 'session-a' }), {
    title: '宿主折叠的标题', cwd: CWD, project: 'proj-a', createdAt: 1786000000000,
  })
  // 其它来源的 sessionId 属于别的键空间：不查缓存
  assert.equal(provider({ format: 'claude', sessionId: 'session-a' }), null)
  // 磁盘上的日志不在宿主持久化列表里（旧代次 / 半成品）：没有身份凭证
  assert.equal(provider({ format: 'dsh', sessionId: 'session-unknown' }), null)
  // 无 sessionId 的畸形条目
  assert.equal(provider({ format: 'dsh4' }), null)
  assert.deepEqual(calls.map((c) => c[0]), ['snapshot'])
})

test('标题提示：当前代次无块 → 退回 cachedPredecessorTitle（跨 Session 格式代次）', () => {
  const calls = []
  const provider = makeSessionHintProvider(
    ctxWith(fakeCache({ predecessor: { 'session-a': block('V3 时代的标题') }, calls })),
    [headerOf('session-a', { version: 4 })],
  )
  assert.equal(provider({ format: 'dsh4', sessionId: 'session-a' }).title, 'V3 时代的标题')
  assert.deepEqual(calls.map((c) => c[0]), ['snapshot', 'predecessor'])
})

test('标题提示：缓存行没有标题（空会话）时不造标题，只补 cwd / 创建时间；同 sessionId 只查一次', () => {
  const calls = []
  const provider = makeSessionHintProvider(
    ctxWith(fakeCache({ snapshot: { 'session-a': block(null) }, calls })),
    [headerOf('session-a')],
  )
  const hint = provider({ format: 'dsh4', sessionId: 'session-a' })
  assert.deepEqual(hint, { cwd: CWD, project: 'proj-a', createdAt: 1786000000000 })
  assert.ok(!('title' in hint))
  assert.deepEqual(provider({ format: 'dsh4', sessionId: 'session-a' }), hint)
  assert.equal(calls.length, 1, '同一会话在一个扫描里只查一次')
})

test('标题提示：服务缺席 → 无提示不抛错；读失败 → 只警告一次，之后不再重试', () => {
  // ctx.get 抛 INACTIVE_EFFECT（会话在发现期间结束，不是故障）：不记警告
  withWarnSpy((warns) => {
    const inactive = { get: () => { const e = new Error('inactive'); e.code = 'INACTIVE_EFFECT'; throw e } }
    const provider = makeSessionHintProvider(inactive, [headerOf('session-a')])
    assert.equal(provider({ format: 'dsh4', sessionId: 'session-a' }), null)
    assert.deepEqual(warns, [])
  })

  // 服务读失败：一次警告 + 后续条目不再重试（失败要大声，但不逐条刷屏）
  withWarnSpy((warns) => {
    let n = 0
    const broken = { cachedSnapshot() { n += 1; throw new Error('投影缓存炸了') }, cachedPredecessorTitle() { return undefined } }
    const provider = makeSessionHintProvider(ctxWith(broken), [headerOf('session-a'), headerOf('session-b')])
    assert.equal(provider({ format: 'dsh4', sessionId: 'session-a' }), null)
    assert.equal(provider({ format: 'dsh4', sessionId: 'session-b' }), null)
    assert.equal(n, 1)
    assert.equal(warns.length, 1)
    assert.match(warns[0], /投影缓存炸了/)
  })

  // 服务缺席（未挂 session-projection-cache）：静默退化
  withWarnSpy((warns) => {
    const provider = makeSessionHintProvider(ctxWith(undefined), [headerOf('session-a')])
    assert.equal(provider({ format: 'dsh4', sessionId: 'session-a' }), null)
    assert.deepEqual(warns, [])
  })

  // ctx 连 get 都没有（宿主 ABI 变动的自卫）：不抛错
  assert.equal(makeSessionHintProvider({}, [headerOf('session-a')])({ format: 'dsh4', sessionId: 'session-a' }), null)
})

// 大 .zstd 兜底 + 已能解析的明文日志各一条：前者只能靠提示，后者必须保持来源自己的标题。
function hintFixture() {
  const root = join(HOME, 'dsh-hints', 'sessions')
  const ws = join(root, '--w--')
  const bigFile = join(ws, 'session-large', 'session.v4.jsonl.zstd')
  const smallFile = join(ws, 'session-small', 'session.v4.jsonl')
  const smallText = [
    j({ type: 'session', id: 'session-small', cwd: CWD, createdAt: 1786000001000 }),
    j({ type: 'user/message', seq: 0, time: 1786000001000, data: { content: [{ type: 'text', text: '首问' }] } }),
    j({ type: 'session/title', seq: 1, time: 1786000001000, data: { title: '来源自己的标题' } }),
  ].join('\n')
  const files = withDirs(root, new Map([
    // 压缩后超阈值：发现层不解压，按布局目录名兜底（内容不参与判定）
    [bigFile, { type: 'file', mtimeMs: 1786000002000, text: 'x'.repeat(256 * 1024 + 1) }],
    [smallFile, { type: 'file', mtimeMs: 1786000003000, text: smallText }],
  ]))
  return {
    root, host: memoryHost(files),
    headers: [headerOf('session-large'), headerOf('session-small')],
    cache: fakeCache({
      snapshot: { 'session-large': block('宿主折叠的大日志标题'), 'session-small': block('缓存里的旧标题') },
    }),
  }
}

test('发现层接线：兜底条目按提示补标题 / cwd / 创建时间，来源读到的标题不被覆盖', async () => {
  const f = hintFixture()
  const { sessions } = await discoverSessions({
    path: f.root, format: 'dsh4', host: f.host, imports: {}, cache: new Map(),
    persistedIds: persistedIdSet(f.headers),
    sessionHints: makeSessionHintProvider(ctxWith(f.cache), f.headers),
  })
  const big = sessions.find((s) => s.sessionId === 'session-large')
  assert.equal(big.title, '宿主折叠的大日志标题')
  assert.equal(big.cwd, CWD)
  assert.equal(big.project, basename(CWD)) // 不再是布局目录名 '--w--'
  assert.equal(big.createdAt, 1786000000000) // 由 header 补，不再退化成文件 mtime
  assert.equal(big.lastActiveAt, 1786000002000) // 最后活跃仍是文件 mtime
  assert.equal(sessions.find((s) => s.sessionId === 'session-small').title, '来源自己的标题')
})

test('发现层接线：提示在 query 过滤之前生效（流式与全量两条路径同口径）', async () => {
  const f = hintFixture()
  const opts = () => ({
    path: f.root, format: 'dsh4', host: f.host, imports: {}, cache: new Map(),
    query: '折叠的', persistedIds: persistedIdSet(f.headers),
    sessionHints: makeSessionHintProvider(ctxWith(f.cache), f.headers),
  })
  const streamed = []
  await discoverSessions({ ...opts(), onEntry: (e) => streamed.push(e) })
  const full = await discoverSessions(opts())
  assert.deepEqual(streamed.map((e) => e.sessionId), ['session-large'])
  assert.deepEqual(full.sessions.map((e) => e.sessionId), ['session-large'])

  // 不给提示时同一关键词搜不到（今天的表现：大 .zstd 的标题为空）
  const bare = await discoverSessions({ ...opts(), sessionHints: undefined })
  assert.deepEqual(bare.sessions, [])
})
