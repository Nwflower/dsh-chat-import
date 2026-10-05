// test/discovery-scan.test.mjs — 扫描器公共行为：持久化书签覆盖面、复合指纹
//
// 书签契约（lib/discovery/scan-cache.mjs）：源文件（及伴生文件）mtime/size 未变 → 复用上次
// 条目、不读源内容。这里锁住此前绕开书签、每次都整读文件头的扫描器（pi、Cline 旧版任务）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { discoverSessions, createScanCache, clearScanCache, clearInflightScans, SCAN_CACHE_FILE } from '../lib/discovery.mjs'
import { memoryHost, withDirs } from './_support/discovery-host.mjs'
import { hostAbs } from './_support/host-path.mjs'

beforeEach(() => {
  clearScanCache()
  clearInflightScans()
})

const HOME = join('C:', 'Users', 'tester')
const j = (o) => JSON.stringify(o)

// 每次都给新的 TTL 缓存：命中与否只看持久化书签层
async function withCacheDir(fn) {
  const cacheDir = mkdtempSync(join(tmpdir(), 'dsh-discovery-scan-'))
  try {
    return await fn((opts) => discoverSessions({ cache: createScanCache(), cacheDir, imports: {}, ...opts }), cacheDir)
  } finally {
    rmSync(cacheDir, { recursive: true, force: true })
  }
}

test('pi：书签命中时不重读会话文件；文件变化后重读', async () => {
  const root = join(HOME, '.pi', 'agent', 'sessions', '--demo-pi--')
  const file = join(root, '2026-06-01T10-00-00-000Z_019f0a11.jsonl')
  const text = [
    j({ type: 'session', version: 3, id: '019f0a11', timestamp: '2026-06-01T10:00:00.000Z', cwd: hostAbs('D:/demo/pi') }),
    j({ type: 'message', message: { role: 'user', content: '书签覆盖 pi' } }),
  ].join('\n')
  const files = withDirs(root, new Map([[file, { type: 'file', mtimeMs: 1786000002000, text }]]))
  const host = memoryHost(files)
  await withCacheDir(async (scan) => {
    const first = await scan({ path: root, format: 'pi', host })
    assert.equal(first.total, 1)
    assert.equal(first.sessions[0].title, '书签覆盖 pi')
    const reads = host.counters.reads
    const second = await scan({ path: root, format: 'pi', host })
    assert.equal(second.total, 1)
    assert.equal(host.counters.reads, reads, '未变文件命中书签，不读源内容')
    files.set(file, { type: 'file', mtimeMs: 1786000009000, text: text + '\n' + j({ type: 'session_info', name: '改名后' }) })
    const third = await scan({ path: root, format: 'pi', host })
    assert.ok(host.counters.reads > reads, '文件变化 → 重读')
    assert.equal(third.sessions[0].title, '改名后')
  })
})

test('cline 旧版任务：书签命中时不重读 api / ui 历史；taskHistory 或 ui_messages 变化 → 重读', async () => {
  const root = join(HOME, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev')
  const taskId = 'legacy-task-bm'
  const api = join(root, 'tasks', taskId, 'api_conversation_history.json')
  const ui = join(root, 'tasks', taskId, 'ui_messages.json')
  const history = join(root, 'state', 'taskHistory.json')
  const files = withDirs(root, new Map([
    [history, { type: 'file', mtimeMs: 1786000012000, text: j([{ id: taskId, ts: 1786000000000, task: '', cwdOnTaskInitialization: hostAbs('D:/repo') }]) }],
    [api, { type: 'file', mtimeMs: 1786000013000, text: j([{ role: 'user', content: 'legacy question' }]) }],
    [ui, { type: 'file', mtimeMs: 1786000014000, text: j([{ type: 'ask', ask: 'followup', text: '标题来自 UI' }]) }],
  ]))
  const host = memoryHost(files)
  const readsOf = new Map()
  const readHead = host.readHead
  host.readHead = async (p, n) => { readsOf.set(p, (readsOf.get(p) || 0) + 1); return readHead(p, n) }
  await withCacheDir(async (scan) => {
    const first = await scan({ path: root, format: 'cline', host })
    assert.equal(first.sessions[0].title, '标题来自 UI')
    assert.equal(readsOf.get(ui), 1)
    await scan({ path: root, format: 'cline', host })
    assert.equal(readsOf.get(ui), 1, '书签命中：标题不重读 ui_messages')
    files.set(ui, { type: 'file', mtimeMs: 1786000020000, text: j([{ type: 'ask', ask: 'followup', text: '新的 UI 标题' }]) })
    const third = await scan({ path: root, format: 'cline', host })
    assert.equal(third.sessions[0].title, '新的 UI 标题')
    files.set(history, { type: 'file', mtimeMs: 1786000030000, text: j([{ id: taskId, ts: 1786000000000, task: '索引里的标题', cwdOnTaskInitialization: hostAbs('D:/repo') }]) })
    const fourth = await scan({ path: root, format: 'cline', host })
    assert.equal(fourth.sessions[0].title, '索引里的标题')
  })
})

// Codex 分页链：书签按页存「链拼装所需的摘要」，链条目由页摘要在内存里拼出。此前页级与
// 链级两种探测共用 codex 表、同一个首页路径做键，互相覆盖 → 书签永不命中（每次重读全部
// rollout 头），且页级书签把整段原始记录写进了 scan-cache.json。
test('codex：分页链书签命中时不重读 rollout；书签只存页摘要不存原始记录', async () => {
  const thread = '019e3b3f-636d-7cb3-aaab-0255eb45ad4f'
  const root = join(HOME, '.codex', 'sessions')
  const pageA = join(root, '2026', '09', '14', `rollout-2026-09-14T10-54-33-${thread}.jsonl`)
  const pageB = join(root, '2026', '09', '15', `rollout-2026-09-15T19-55-00-${thread}_9a8b7c6d.jsonl`)
  const solo = join(root, '2026', '09', '15', 'rollout-2026-09-15T20-00-00-11111111-2222-3333-4444-555555555555.jsonl')
  const meta = (id, ts) => j({ timestamp: ts, type: 'session_meta', payload: { id, cwd: hostAbs('D:/demo/codex'), timestamp: ts } })
  const user = (text) => j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
  const files = withDirs(root, new Map([
    [pageA, { type: 'file', mtimeMs: 1786000001000, text: [meta(thread, '2026-09-14T10:54:33.000Z'), user('首页的提问')].join('\n') }],
    [pageB, { type: 'file', mtimeMs: 1786000005000, text: [meta(thread, '2026-09-15T19:55:00.000Z'), user('次页的提问')].join('\n') }],
    [solo, { type: 'file', mtimeMs: 1786000003000, text: [meta('11111111-2222-3333-4444-555555555555', '2026-09-15T20:00:00.000Z'), user('单页会话')].join('\n') }],
  ]))
  const host = memoryHost(files)
  await withCacheDir(async (scan, cacheDir) => {
    const first = await scan({ path: root, format: 'codex', host })
    const byId = Object.fromEntries(first.sessions.map((e) => [e.sessionId, e]))
    assert.equal(first.total, 2)
    assert.equal(byId[thread].sourcePath, pageA, '链的 sourcePath = 首页')
    assert.equal(byId[thread].title, '首页的提问')
    assert.equal(byId[thread].lastActiveAt, 1786000005000, 'lastActiveAt = 最新页 mtime')
    assert.equal(byId[thread].createdAt, Date.parse('2026-09-14T10:54:33.000Z'))
    const reads = host.counters.reads
    const second = await scan({ path: root, format: 'codex', host })
    assert.deepEqual(second.sessions.map((e) => [e.sessionId, e.title, e.sourcePath]), first.sessions.map((e) => [e.sessionId, e.title, e.sourcePath]))
    assert.equal(host.counters.reads, reads, '未变的 rollout 命中书签，不重读文件头')
    const disk = readFileSync(join(cacheDir, SCAN_CACHE_FILE), 'utf8')
    assert.ok(!disk.includes('response_item'), '书签不含原始转录记录')
  })
})

// 一次发现内的目录列举记忆化：无 format 的目录探测让全部来源的扫描器遍历同一棵树，dsh 与
// dsh4 共用默认根也各走一遍——同一目录在一次 discoverSessions 里只向 host 列举一次。
test('目录探测（不给 format）：同一目录在一次发现内只列举一次，结果与逐格式扫描一致', async () => {
  const root = join(HOME, '.claude', 'projects')
  const files = withDirs(root, new Map([
    [join(root, 'proj-a', 'sess-001.jsonl'), { type: 'file', mtimeMs: 1786000002000, text: j({ sessionId: 'sess-001', type: 'user', cwd: hostAbs('D:/p'), message: { role: 'user', content: '问题' } }) }],
    [join(root, 'proj-b', 'nested', 'x.jsonl'), { type: 'file', mtimeMs: 1786000001000, text: j({ other: true }) }],
  ]))
  const host = memoryHost(files)
  const { sessions } = await discoverSessions({ path: root, host, imports: {}, cache: new Map() })
  assert.deepEqual(sessions.map((e) => [e.format, e.sessionId]), [['claude', 'sess-001']])
  for (const [dir, n] of host.dirsByPath) assert.equal(n, 1, dir + ' 只列举一次')
})

test('dsh / dsh4 共用默认根：一次默认扫描内会话目录只列举一次', async () => {
  const dshHome = join(HOME, 'dsh-home-memo')
  const root = join(dshHome, 'sessions')
  const body = (id) => [j({ type: 'session', id, cwd: '/demo/proj', createdAt: 1700000000000 }), j({ type: 'user/message', data: { content: [{ type: 'text', text: id }] } })].join('\n')
  const files = withDirs(root, new Map([
    [join(root, '--w--', 's-a', 'session.v3.jsonl'), { type: 'file', mtimeMs: 1786000002000, text: body('s-a') }],
    [join(root, '--w--', 's-b', 'session.v4.jsonl'), { type: 'file', mtimeMs: 1786000003000, text: body('s-b') }],
  ]))
  const host = memoryHost(files)
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  try {
    const all = await discoverSessions({ home: HOME, host, imports: {}, cache: new Map() })
    const got = all.sessions.filter((e) => e.format === 'dsh' || e.format === 'dsh4').map((e) => [e.format, e.sessionId])
    assert.deepEqual(got.sort(), [['dsh', 's-a'], ['dsh4', 's-b']])
    assert.equal(host.dirsByPath.get(root), 1)
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

test('cursor：同一 slug 的多条会话在一次发现内只解码一次 slug（扫描与书签命中补丁同口径）', async () => {
  const root = join(HOME, '.cursor', 'projects')
  const slug = 'e-dev-demo'
  const t = (id) => join(root, slug, 'agent-transcripts', id, id + '.jsonl')
  const text = (q) => j({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>' + q + '</user_query>' }] } })
  const files = withDirs(root, new Map([
    [t('aaa'), { type: 'file', mtimeMs: 1786000001000, text: text('一') }],
    [t('bbb'), { type: 'file', mtimeMs: 1786000002000, text: text('二') }],
  ]))
  const host = memoryHost(files)
  const calls = []
  host.resolveCursorSlug = async (s) => { calls.push(s); return hostAbs('E:/dev/demo') }
  await withCacheDir(async (scan) => {
    const first = await scan({ path: root, format: 'cursor', host })
    assert.equal(first.total, 2)
    assert.deepEqual(calls, [slug], '扫描：同 slug 只解码一次')
    calls.length = 0
    const second = await scan({ path: root, format: 'cursor', host })
    assert.deepEqual(second.sessions.map((e) => e.project), ['demo', 'demo'])
    assert.deepEqual(calls, [slug], '书签命中补丁：同 slug 只解码一次')
  })
})

// DSH 会话日志经注入 host 读取：明文日志只读头 + 尾两段（不整读几十 MB 的日志），.zstd 经
// host.readBytes 有界读原始字节再解压（此前直接 node:fs 读盘，绕过了 host）。
test('dsh：大明文日志只读头尾两段——会话头取自头部、最新 session/title 取自尾部', async () => {
  const root = join(HOME, 'dsh-home-io', 'sessions')
  const file = join(root, '--w--', 's-big', 'session.v3.jsonl')
  const text = [
    j({ type: 'session', id: 's-big', cwd: '/demo/proj', createdAt: 1700000000000 }),
    j({ type: 'user/message', data: { content: [{ type: 'text', text: '首问' }] } }),
    j({ type: 'session/title', data: { title: '早期标题' } }),
    j({ type: 'assistant/message', data: { content: [{ type: 'text', text: 'x'.repeat(300 * 1024) }] } }),
    j({ type: 'session/title', data: { title: '尾部改名' } }),
  ].join('\n')
  const host = memoryHost(withDirs(root, new Map([[file, { type: 'file', mtimeMs: 1786000002000, text }]])))
  const wholeReads = []
  const readText = host.readText
  host.readText = async (p) => { wholeReads.push(p); return readText(p) }
  const { sessions } = await discoverSessions({ path: root, format: 'dsh', host, imports: {}, cache: new Map() })
  assert.deepEqual(sessions.map((e) => [e.sessionId, e.title]), [['s-big', '尾部改名']])
  assert.deepEqual(wholeReads, [], '不整读会话日志')
  assert.equal(host.counters.tails, 1)
})

test('dsh：小 .zstd 经 host.readBytes 读字节解压取元数据；host 读不到字节时按目录名兜底列出', async () => {
  const fixture = readFileSync(fileURLToPath(new URL('./fixtures/session.jsonl.zstd', import.meta.url)))
  const root = join(HOME, 'dsh-home-zstd', 'sessions')
  const file = join(root, '--w--', 'session-zstd-dir', 'session.jsonl.zstd')
  const files = withDirs(root, new Map([[file, { type: 'file', mtimeMs: 1786000002000, text: 'z'.repeat(fixture.length) }]]))
  const host = memoryHost(files)
  const asked = []
  host.readBytes = async (p, max) => { asked.push([p, max]); return p === file ? new Uint8Array(fixture) : null }
  const ok = await discoverSessions({ path: root, format: 'dsh', host, imports: {}, cache: new Map() })
  assert.deepEqual(ok.sessions.map((e) => [e.sessionId, e.title, e.cwd]), [['session-zstd-test', 'Zstd 导入测试', '/tmp/proj']])
  assert.equal(asked.length, 1)
  assert.equal(asked[0][0], file)
  assert.ok(asked[0][1] >= fixture.length)

  const bare = memoryHost(files) // 无 readBytes 能力的 host
  const fallback = await discoverSessions({ path: root, format: 'dsh', host: bare, imports: {}, cache: new Map() })
  assert.deepEqual(fallback.sessions.map((e) => [e.sessionId, e.title, e.project]), [['session-zstd-dir', null, '--w--']])
})

// 失败要大声：单个目标扫描失败仍只跳过该目标（其余来源照常产出），但失败进 warnings 并写宿主
// 日志；失败结果不进 TTL 缓存（下次发现重试并再次上报）。
test('warnings：读取器异常记入 { format, target, error }、写日志、不进 TTL 缓存', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const dbPath = join(HOME, '.zcode', 'cli', 'db', 'db.sqlite')
  const host = memoryHost(new Map([[dbPath, { type: 'file', text: 'SQLite format 3', mtimeMs: 1786000000000 }]]))
  host.dbSessions = () => { throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' }) }
  const cache = createScanCache()
  const first = await discoverSessions({ path: dbPath, format: 'zcode', host, imports: {}, cache })
  assert.deepEqual(first.sessions, [])
  assert.deepEqual(first.warnings, [{ format: 'zcode', target: dbPath, error: 'ERR_SQLITE_ERROR: database is locked' }])
  assert.equal(warn.mock.callCount(), 1)
  assert.match(String(warn.mock.calls[0].arguments[0]), /zcode/)
  const second = await discoverSessions({ path: dbPath, format: 'zcode', host, imports: {}, cache })
  assert.equal(host.counters.db, 2, '失败结果不缓存：第二次发现重试读取器')
  assert.equal(second.warnings.length, 1)
})

test('warnings：目录探测里一个来源抛 TypeError 不影响其它来源，成功时 warnings 为空数组', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const root = join(HOME, 'mixed')
  const files = withDirs(root, new Map([
    [join(root, 'opencode.db'), { type: 'file', text: 'SQLite format 3', mtimeMs: 1786000000000 }],
    [join(root, '.claude', 'projects', 'p', 's-1.jsonl'), { type: 'file', mtimeMs: 1786000001000, text: j({ sessionId: 's-1', type: 'user', message: { role: 'user', content: '照常发现' } }) }],
  ]))
  const host = memoryHost(files)
  host.dbSessions = (kind) => (kind === 'opencode' ? null.rows : null) // 读取器里的程序错误（TypeError）
  const res = await discoverSessions({ path: root, host, imports: {}, cache: new Map() })
  assert.deepEqual(res.sessions.map((e) => [e.format, e.sessionId]), [['claude', 's-1']])
  assert.deepEqual(res.warnings.map((w) => [w.format, w.target]), [['opencode', root]])
  assert.match(res.warnings[0].error, /TypeError|Cannot read/)
  const ok = await discoverSessions({ path: join(root, '.claude', 'projects'), format: 'claude', host, imports: {}, cache: new Map() })
  assert.deepEqual(ok.warnings, [])
})

test('warnings：hermes state.db 打不开时上报并回退扫 JSONL（降级仍有结果）', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const root = join(HOME, '.hermes')
  const files = withDirs(root, new Map([
    [join(root, 'state.db'), { type: 'file', text: 'SQLite format 3', mtimeMs: 1786000000000 }],
    [join(root, 'sessions', 'h-1.jsonl'), { type: 'file', mtimeMs: 1786000001000, text: [j({ type: 'session', id: 'h-1' }), j({ role: 'user', content: '回退 JSONL' })].join('\n') }],
  ]))
  const host = memoryHost(files)
  host.dbSessions = () => { throw new Error('unable to open database file') }
  const res = await discoverSessions({ path: root, format: 'hermes', host, imports: {}, cache: new Map() })
  assert.deepEqual(res.sessions.map((e) => [e.sessionId, e.title]), [['h-1', '回退 JSONL']])
  assert.deepEqual(res.warnings.map((w) => [w.format, w.error]), [['hermes', 'unable to open database file']])
})
