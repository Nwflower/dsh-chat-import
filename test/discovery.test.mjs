// discovery.test.mjs — REQ-25/REQ-40 会话发现单测：mock host（纯函数核心零真实 I/O）
// 覆盖：claude/codex/reasonix/grokbuild/openclaw/pi/hermes 七种格式发现（标题注入过滤、
// 项目名提取、sessionId、importStatus）、30s TTL 缓存命中不重读（可观测读计数）、
// query 过滤、multi 源 partial 状态、chatgpt 显式路径、目录探测格式自拒。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  discoverSessions, createScanCache, clearScanCache, clearInflightScans,
  FORMATS, TITLE_MAX_LEN, defaultRoots,
  isInjectedTitle, normalizeTitle, layoutProject, resolveImportStatus,
} from '../lib/discovery.mjs'
import { resolveCursorSlugPath, clearWorkspacePathCache } from '../lib/cwd-map.mjs'
import { gooseSessionsDir } from '../lib/convert/goose.mjs'
import { zedThreadsDir } from '../lib/convert/zed.mjs'
import { hostAbs } from './_support/host-path.mjs'

beforeEach(() => {
  clearScanCache()
  clearInflightScans()
})

// 合成 home（不存在，默认根扫描确定性为空）
const HOME = join('C:', 'Users', 'tester')
const j = (o) => JSON.stringify(o)

// mock host：path → { type:'file', text, mtimeMs? } | { type:'dir' }；可观测读写计数。
// readSessions 默认 null（DB 格式测试注入 mock 会话摘要，验证「复用读取器」契约）。
function mockHost(files) {
  const counters = { reads: 0, stats: 0, dirs: 0, db: 0 }
  const sep = (p) => (String(p).includes('\\') ? '\\' : '/')
  const host = {
    counters,
    dbSessions: null,
    async stat(path) {
      counters.stats++
      const v = files.get(path)
      if (!v) return null
      return v.type === 'dir' ? { type: 'directory' } : { type: 'file', size: v.text.length, mtimeMs: v.mtimeMs }
    },
    async readText(path) {
      counters.reads++
      const v = files.get(path)
      return v && v.type === 'file' ? v.text : null
    },
    async readHead(path, maxBytes) {
      counters.reads++
      const v = files.get(path)
      return v && v.type === 'file' ? v.text.slice(0, maxBytes) : null
    },
    async readTail(path, maxBytes) {
      counters.reads++
      const v = files.get(path)
      return v && v.type === 'file' ? v.text.slice(-maxBytes) : null
    },
    async readDir(path) {
      counters.dirs++
      const s = sep(path)
      const prefix = String(path).endsWith(s) ? String(path) : String(path) + s
      const out = []
      for (const [p, v] of files) {
        if (!p.startsWith(prefix) || p === prefix) continue
        const rest = p.slice(prefix.length)
        if (rest.includes('\\') || rest.includes('/')) continue
        out.push({ name: rest, type: v.type === 'dir' ? 'directory' : 'file', path: p })
      }
      return out.sort((a, b) => a.name.localeCompare(b.name))
    },
    async readSessions(kind, dbPath) {
      counters.db++
      return typeof host.dbSessions === 'function' ? host.dbSessions(kind, dbPath) : null
    },
  }
  return host
}

// ── 六种格式发现（DoD 核心）─────────────────────────────────────────────

test('claude：注入过滤标题、记录 cwd 项目名、主 transcript 判定、importStatus', async () => {
  const root = join(HOME, '.claude', 'projects')
  const slug = join(root, 'proj-a')
  const s1 = join(slug, 'sess-001.jsonl')
  const files = new Map([
    [root, { type: 'dir' }],
    [slug, { type: 'dir' }],
    [s1, { type: 'file', mtimeMs: 1786000002000, text: [
      j({ sessionId: 'sess-001', type: 'user', cwd: 'D:\\demo\\claude-proj', message: { role: 'user', content: '请帮我修复构建' } }),
      j({ sessionId: 'sess-001', type: 'assistant', message: { role: 'assistant', content: '好的' } }),
    ].join('\n') }],
    [join(slug, 'sess-002.jsonl'), { type: 'file', text: [
      j({ sessionId: 'sess-002', type: 'user', message: { role: 'user', content: '<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>' } }),
      j({ sessionId: 'sess-002', type: 'user', message: { role: 'user', content: '真实提问' } }),
    ].join('\n') }],
    // 辅助 transcript：fileStem（agent-*）≠ sessionId → 不发现
    [join(slug, 'agent-xyz.jsonl'), { type: 'file', text: j({ sessionId: 'sess-001', type: 'user', message: { role: 'user', content: '辅助' } }) }],
  ])
  const host = mockHost(files)
  const imports = { [s1]: { kind: 'single', dshId: 'import-sess-001', turns: 1, events: 3 } }

  const { sessions, total } = await discoverSessions({ path: root, format: 'claude', host, imports })
  assert.equal(total, 2)
  const a = sessions.find((s) => s.sessionId === 'sess-001')
  assert.equal(a.title, '请帮我修复构建')
  assert.equal(a.project, 'claude-proj') // 记录内 cwd basename（REQ-40 项目名）
  assert.equal(a.importStatus, 'imported')
  assert.equal(a.lastActiveAt, 1786000002000) // 文件 mtime
  const b = sessions.find((s) => s.sessionId === 'sess-002')
  assert.equal(b.title, '真实提问') // 注入首行被过滤
  assert.equal(b.project, 'proj-a') // 无 cwd → 布局 slug 回退
  assert.equal(b.importStatus, 'not-imported')
})

test('claude：上下文 token 数取最后一条 assistant 的 usage.input_tokens（小文件走头、大文件走尾）', async () => {
  const root = join(HOME, '.claude', 'projects')
  const slug = join(root, 'proj-a')
  const small = join(slug, 'sess-small.jsonl')
  const big = join(slug, 'sess-big.jsonl')
  const filler = 'x'.repeat(300 * 1024) // 撑过 HEAD_MAX_BYTES，逼尾部 assistant 只能靠 readTail 拿到
  const files = new Map([
    [root, { type: 'dir' }],
    [slug, { type: 'dir' }],
    [small, { type: 'file', text: [
      j({ sessionId: 'sess-small', type: 'user', message: { role: 'user', content: '问' } }),
      j({ sessionId: 'sess-small', type: 'assistant', message: { role: 'assistant', content: '答1', usage: { input_tokens: 1000, output_tokens: 10 } } }),
      j({ sessionId: 'sess-small', type: 'assistant', message: { role: 'assistant', content: '答2', usage: { input_tokens: 2345, output_tokens: 20 } } }),
    ].join('\n') }],
    [big, { type: 'file', text: [
      j({ sessionId: 'sess-big', type: 'user', message: { role: 'user', content: '问' } }),
      j({ sessionId: 'sess-big', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: filler }] } }),
      j({ sessionId: 'sess-big', type: 'assistant', message: { role: 'assistant', content: '尾', usage: { input_tokens: 888888, output_tokens: 30 } } }),
    ].join('\n') }],
  ])
  const host = mockHost(files)
  const { sessions } = await discoverSessions({ path: root, format: 'claude', host, imports: {} })
  assert.equal(sessions.find((s) => s.sessionId === 'sess-small').contextTokens, 2345)
  assert.equal(sessions.find((s) => s.sessionId === 'sess-big').contextTokens, 888888) // >256KB 头不含尾部 assistant
})

test('onEntry：逐条产出顺序与返回一致、状态标注与 query 过滤已应用（面板流式底座）', async () => {
  const root = join(HOME, '.claude', 'projects')
  const slug = join(root, 'proj-a')
  const s1 = join(slug, 'sess-001.jsonl')
  const s2 = join(slug, 'sess-002.jsonl')
  const files = new Map([
    [root, { type: 'dir' }],
    [slug, { type: 'dir' }],
    [s1, { type: 'file', mtimeMs: 1786000002000, text: [
      j({ sessionId: 'sess-001', type: 'user', cwd: 'D:\\demo\\claude-proj', message: { role: 'user', content: '请帮我修复构建' } }),
      j({ sessionId: 'sess-001', type: 'assistant', message: { role: 'assistant', content: '好的' } }),
    ].join('\n') }],
    [s2, { type: 'file', text: [
      j({ sessionId: 'sess-002', type: 'user', message: { role: 'user', content: '真实提问' } }),
    ].join('\n') }],
  ])
  const host = mockHost(files)
  const imports = { [s1]: { kind: 'single', dshId: 'import-sess-001', turns: 1, events: 3 } }

  const emitted = []
  const { sessions, total } = await discoverSessions({
    path: root, format: 'claude', host, imports,
    onEntry: (e) => emitted.push(e),
  })
  // 逐条产出顺序 = 返回顺序（目录遍历序），会话数一致
  assert.equal(total, 2)
  assert.equal(emitted.length, sessions.length)
  assert.deepEqual(emitted.map((e) => e.sessionId), sessions.map((s) => s.sessionId))
  // 产出条目已带状态标注与标题提取（与返回结果同口径）
  const a = emitted.find((e) => e.sessionId === 'sess-001')
  assert.equal(a.importStatus, 'imported')
  assert.equal(a.title, '请帮我修复构建')
  assert.equal(emitted.find((e) => e.sessionId === 'sess-002').importStatus, 'not-imported')

  // query 过滤作用于产出路径：不匹配的会话不出现在 emitted（TTL 缓存命中 → 整批补齐）
  const qEmitted = []
  await discoverSessions({
    path: root, format: 'claude', host, imports, query: '构建',
    onEntry: (e) => qEmitted.push(e),
  })
  assert.deepEqual(qEmitted.map((e) => e.sessionId), ['sess-001'])

  // 缓存命中路径：不重读（读计数不涨）、产出不重复、顺序不变
  const before = host.counters.reads
  const cEmitted = []
  await discoverSessions({
    path: root, format: 'claude', host, imports,
    onEntry: (e) => cEmitted.push(e),
  })
  assert.equal(host.counters.reads, before)
  assert.deepEqual(cEmitted.map((e) => e.sessionId), sessions.map((s) => s.sessionId))
})

test('codex：session_meta 签名、注入过滤标题、项目名（cwd basename / YYYY-MM 回退）', async () => {
  const root = join(HOME, '.codex', 'sessions')
  const withCwd = join(root, '2026', '03', '10', 'rollout-20260310T120000-019e3b3f-636d-7cb3-aaab-0255eb45ad4f.jsonl')
  const noCwd = join(root, '2026', '03', '11', 'rollout-20260311T080000-019e3b3f-636d-7cb3-aaab-0255eb45ad5f.jsonl')
  const files = new Map([
    [root, { type: 'dir' }], [join(root, '2026'), { type: 'dir' }],
    [join(root, '2026', '03'), { type: 'dir' }], [join(root, '2026', '03', '10'), { type: 'dir' }],
    [join(root, '2026', '03', '11'), { type: 'dir' }],
    [withCwd, { type: 'file', text: [
      j({ type: 'session_meta', timestamp: '2026-03-10T12:00:00Z', payload: { id: '019e3b3f-636d-7cb3-aaab-0255eb45ad4f', cwd: 'D:/demo/codex-proj' } }),
      j({ type: 'response_item', payload: { type: 'message', role: 'user', content: '<environment_context>\n<cwd>/x</cwd>\n</environment_context>' } }),
      j({ type: 'response_item', payload: { type: 'message', role: 'user', content: '为什么构建失败' } }),
    ].join('\n') }],
    [noCwd, { type: 'file', text: [
      j({ type: 'session_meta', payload: { id: '019e3b3f-636d-7cb3-aaab-0255eb45ad5f' } }),
      j({ type: 'response_item', payload: { type: 'message', role: 'user', content: '重构模块' } }),
    ].join('\n') }],
  ])
  const host = mockHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'codex', host, imports: {} })
  assert.equal(total, 2)
  const a = sessions.find((s) => s.sessionId === '019e3b3f-636d-7cb3-aaab-0255eb45ad4f')
  assert.equal(a.title, '为什么构建失败')
  assert.equal(a.project, 'codex-proj')
  assert.ok(a.createdAt > 0)
  const b = sessions.find((s) => s.sessionId === '019e3b3f-636d-7cb3-aaab-0255eb45ad5f')
  assert.equal(b.title, '重构模块')
  assert.equal(b.project, '2026/03') // 无 cwd → sessions/YYYY/MM 布局回退
})

test('codex：子代理 rollout（thread_source=subagent / source.subagent）默认过滤', async () => {
  const root = join(HOME, '.codex', 'sessions')
  const day = join(root, '2026', '03', '12')
  const main = join(day, 'rollout-main-019e3b3f-636d-7cb3-aaab-0255eb45ad6f.jsonl')
  const subThreadSource = join(day, 'rollout-sub-019e3b3f-636d-7cb3-aaab-0255eb45ad7f.jsonl')
  const subSource = join(day, 'rollout-sub2-019e3b3f-636d-7cb3-aaab-0255eb45ad8f.jsonl')
  const files = new Map([
    [root, { type: 'dir' }], [join(root, '2026'), { type: 'dir' }],
    [join(root, '2026', '03'), { type: 'dir' }], [day, { type: 'dir' }],
    [main, { type: 'file', text: [
      j({ type: 'session_meta', payload: { id: '019e3b3f-636d-7cb3-aaab-0255eb45ad6f' } }),
      j({ type: 'response_item', payload: { type: 'message', role: 'user', content: '主会话提问' } }),
    ].join('\n') }],
    [subThreadSource, { type: 'file', text: [
      j({ type: 'session_meta', payload: { id: '019e3b3f-636d-7cb3-aaab-0255eb45ad7f', thread_source: 'subagent' } }),
      j({ type: 'response_item', payload: { type: 'message', role: 'user', content: '子代理工作' } }),
    ].join('\n') }],
    [subSource, { type: 'file', text: [
      j({ type: 'session_meta', payload: { id: '019e3b3f-636d-7cb3-aaab-0255eb45ad8f', source: { subagent: { thread_spawn: { parent_thread_id: '019e3b3f-636d-7cb3-aaab-0255eb45ad6f', depth: 1 } } } } }),
      j({ type: 'response_item', payload: { type: 'message', role: 'user', content: '子代理工作2' } }),
    ].join('\n') }],
  ])
  const host = mockHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'codex', host, imports: {} })
  assert.equal(total, 1)
  assert.equal(sessions[0].sessionId, '019e3b3f-636d-7cb3-aaab-0255eb45ad6f')
})

test('reasonix：desktop-* 发现、projects/<slug> 项目名、伴生排除、subagent 默认过滤', async () => {
  const root = join(HOME, '.reasonix', 'projects', 'demo-proj')
  const main = join(root, 'desktop-202603101200-1.jsonl')
  const sub = join(root, 'subagent-sub-5-202603101201.jsonl')
  const files = new Map([
    [root, { type: 'dir' }],
    [main, { type: 'file', text: [
      j({ role: 'user', content: '帮我写个排序函数', createdAt: 1786000000000 }),
      j({ role: 'assistant', content: '好的', createdAt: 1786000001000 }),
    ].join('\n') }],
    [sub, { type: 'file', text: j({ role: 'user', content: '子代理提问', createdAt: 1786000002000 }) }],
    // WAL / 伴生文件：不发现
    [join(root, 'desktop-202603101200-1.events.jsonl'), { type: 'file', text: '{"type":"event"}' }],
    [join(root, 'desktop-202603101200-1.conflicts.jsonl'), { type: 'file', text: '{}' }],
    [join(root, 'desktop-202603101200-1.guardian.jsonl'), { type: 'file', text: '{}' }],
    [join(root, 'not-desktop.jsonl'), { type: 'file', text: j({ role: 'user', content: '不是 reasonix 命名' }) }],
  ])
  const host = mockHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'reasonix', host, imports: {} })
  assert.equal(total, 1)
  const a = sessions.find((s) => s.sessionId === 'desktop-202603101200-1')
  assert.equal(a.title, '帮我写个排序函数')
  assert.equal(a.project, 'demo-proj')
  assert.equal(a.createdAt, 1786000000000)
  assert.ok(!sessions.some((s) => s.sessionId === 'subagent-sub-5-202603101201'), 'subagent 子代理应默认过滤')
})

test('grokbuild：summary.json 标题/时间、百分号编码目录名解码为项目名、cwd 透传', async () => {
  // 真实布局：sessions/<encodeURIComponent(cwd) 整路径>/<session_id>/（Windows 盘符 +
  // 中文都会进入目录名），面板工作区列必须显示解码后的项目名而非 %XX 乱码。
  const root = join(HOME, '.grok', 'sessions')
  const projEnc = 'F%3A%5C%E9%A1%B9%E7%9B%AE%5C%E7%A1%95%E5%A3%AB%E6%AF%95%E4%B8%9A%E8%AE%BE%E8%AE%A1%5CRegulus'
  const proj = join(root, projEnc)
  const sessA = join(proj, 'grok-sess-001')
  const sessB = join(proj, 'grok-sess-002')
  const files = new Map([
    [root, { type: 'dir' }], [proj, { type: 'dir' }], [sessA, { type: 'dir' }], [sessB, { type: 'dir' }],
    [join(sessA, 'summary.json'), { type: 'file', text: j({
      info: { id: 'grok-sess-001', cwd: 'F:\\项目\\硕士毕业设计\\Regulus' },
      generated_title: '重构认证模块',
      created_at: '2026-07-16T12:00:00Z',
    }) }],
    [join(sessA, 'chat_history.jsonl'), { type: 'file', mtimeMs: 1786000005000, text: [
      j({ type: 'user', content: '登录报错' }),
      j({ type: 'assistant', content: '看日志' }),
    ].join('\n') }],
    // 无 info.cwd 的会话：项目名走目录布局解码回退（同一编码目录），cwd 为 null
    [join(sessB, 'summary.json'), { type: 'file', text: j({
      info: { id: 'grok-sess-002' },
      generated_title: '另一个会话',
      created_at: '2026-07-16T13:00:00Z',
    }) }],
    [join(sessB, 'chat_history.jsonl'), { type: 'file', mtimeMs: 1786000006000, text: [
      j({ type: 'user', content: '继续排查' }),
      j({ type: 'assistant', content: '好的' }),
    ].join('\n') }],
  ])
  const host = mockHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'grokbuild', host, imports: {} })
  assert.equal(total, 2)
  const a = sessions.find((s) => s.sessionId === 'grok-sess-001')
  assert.equal(a.title, '重构认证模块')
  assert.equal(a.project, 'Regulus') // 解码后的项目名（不再是 %XX 乱码）
  assert.equal(a.cwd, 'F:\\项目\\硕士毕业设计\\Regulus') // 记录内完整工作目录
  assert.ok(a.createdAt > 0)
  assert.equal(a.lastActiveAt, 1786000005000) // chat_history mtime 取大
  const b = sessions.find((s) => s.sessionId === 'grok-sess-002')
  assert.equal(b.project, 'Regulus') // 无 cwd → 目录布局解码回退
  assert.equal(b.cwd, null)
})

test('openclaw：sessions.json displayName 标题、项目名（记录 cwd > agents/<agent> 布局）', async () => {
  const root = join(HOME, '.openclaw', 'agents')
  const sessDir = join(root, 'main', 'sessions')
  const files = new Map([
    [root, { type: 'dir' }], [join(root, 'main'), { type: 'dir' }], [sessDir, { type: 'dir' }],
    [join(sessDir, 'sessions.json'), { type: 'file', text: j({ a: { sessionId: 'sess-a', displayName: '重构登录模块' } }) }],
    [join(sessDir, 'sess-a.jsonl'), { type: 'file', text: [
      j({ type: 'session', id: 'sess-a', cwd: '/home/dev/proj', timestamp: '2026-03-06T10:00:00Z' }),
      j({ type: 'message', message: { role: 'user', content: '帮我看看构建失败' }, timestamp: '2026-03-06T10:01:00Z' }),
    ].join('\n') }],
    // 无 displayName / 无 cwd 的会话：标题首条 user 文本、项目名 agents/<agent> 布局回退
    [join(sessDir, 'sess-b.jsonl'), { type: 'file', text: [
      j({ type: 'session', id: 'sess-b', timestamp: '2026-03-06T11:00:00Z' }),
      j({ type: 'message', message: { role: 'user', content: '另一个问题' }, timestamp: '2026-03-06T11:01:00Z' }),
    ].join('\n') }],
  ])
  const host = mockHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'openclaw', host, imports: {} })
  assert.equal(total, 2)
  const a = sessions.find((s) => s.sessionId === 'sess-a')
  assert.equal(a.title, '重构登录模块') // sessions.json displayName 优先
  assert.equal(a.project, 'proj') // 记录内 cwd basename 优先
  assert.ok(a.createdAt > 0)
  const b = sessions.find((s) => s.sessionId === 'sess-b')
  assert.equal(b.title, '另一个问题')
  assert.equal(b.project, 'main') // 无 cwd → agents/<agent> 布局回退
})

test('pi：会话头签名（version 字段）、session_info 名称标题、cwd 项目名、旁支/他格式自拒', async () => {
  const root = join(HOME, '.pi', 'agent', 'sessions', '--demo-pi-proj--')
  const s1 = join(root, '2026-06-01T10-00-00-000Z_019f0a11.jsonl')
  const files = new Map([
    [root, { type: 'dir' }],
    [s1, { type: 'file', mtimeMs: 1786000002000, text: [
      j({ type: 'session', version: 3, id: '019f0a11', timestamp: '2026-06-01T10:00:00.000Z', cwd: 'D:\\demo\\pi-proj' }),
      j({ type: 'message', id: 'a1', parentId: null, timestamp: '2026-06-01T10:00:01.000Z', message: { role: 'user', content: '帮我重构这个模块', timestamp: 1786000001000 } }),
      j({ type: 'session_info', id: 'z9', parentId: 'a1', timestamp: '2026-06-01T10:05:00.000Z', name: '重构模块讨论' }),
    ].join('\n') }],
    // 无 version 的 session 头（hermes/openclaw 形态）→ Pi 签名自拒
    [join(root, 'sess-other.jsonl'), { type: 'file', text: [
      j({ type: 'session', id: 'other', timestamp: '2026-06-01T10:00:00.000Z' }),
      j({ type: 'message', message: { role: 'user', content: '不是 Pi' }, timestamp: '2026-06-01T10:01:00.000Z' }),
    ].join('\n') }],
  ])
  const host = mockHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'pi', host, imports: {} })
  assert.equal(total, 1)
  const s = sessions[0]
  assert.equal(s.format, 'pi')
  assert.equal(s.sessionId, '019f0a11')
  assert.equal(s.title, '重构模块讨论') // session_info 名称优先
  assert.equal(s.project, 'pi-proj') // 记录内 cwd basename
  assert.equal(s.createdAt, Date.parse('2026-06-01T10:00:00.000Z'))
  assert.equal(s.lastActiveAt, 1786000002000)
})

test('hermes：state.db 恒批量（复用读取器）+ db 不可用回退 JSONL', async () => {
  const root = join(HOME, '.hermes')
  const dbPath = join(root, 'state.db')
  const files = new Map([[root, { type: 'dir' }], [dbPath, { type: 'file', text: '' }]])
  const host = mockHost(files)
  host.dbSessions = (kind) => (kind === 'hermes'
    ? [{ id: 'hm-a', title: 'Fix hermes build', directory: 'E:/demo/hermes', createdAt: 1786000000000, lastActiveAt: 1786000000100}]
    : null)

  const { sessions, total } = await discoverSessions({ path: root, format: 'hermes', host, imports: {} })
  assert.equal(total, 1)
  assert.equal(sessions[0].sessionId, 'hm-a')
  assert.equal(sessions[0].title, 'Fix hermes build')
  assert.equal(sessions[0].project, 'hermes') // directory basename
  assert.equal(sessions[0].lastActiveAt, 1786000000100)

  // db 不可用（readHermesDb null）→ 回退扫 sessions/*.jsonl（flat 形态）
  const jsonlRoot = join(HOME, '.hermes2')
  const s1 = join(jsonlRoot, 'sessions', 's1.jsonl')
  const files2 = new Map([
    [jsonlRoot, { type: 'dir' }], [join(jsonlRoot, 'sessions'), { type: 'dir' }],
    [s1, { type: 'file', text: [
      j({ role: 'user', content: '什么是 Rust？', ts: 1700000000 }),
      j({ role: 'assistant', content: '一种系统编程语言。', ts: 1700000001 }),
    ].join('\n') }],
  ])
  const host2 = mockHost(files2)
  host2.dbSessions = () => null
  const r2 = await discoverSessions({ path: jsonlRoot, format: 'hermes', host: host2, imports: {} })
  assert.equal(r2.total, 1)
  assert.equal(r2.sessions[0].sessionId, 's1') // 无 session 记录 → 文件 stem
  assert.equal(r2.sessions[0].title, '什么是 Rust？')
})

test('kimi：wire.jsonl 会话目录发现、custom_title 标题、kimi.json md5 映射 cwd、无 wire 目录自拒', async () => {
  const root = join(HOME, '.kimi', 'sessions')
  const workDir = join('D:', 'demo', 'kimi-proj')
  const hashDir = createHash('md5').update(workDir, 'utf8').digest('hex')
  const sessDir = join(root, hashDir, 'sess-001')
  const files = new Map([
    [root, { type: 'dir' }],
    [join(HOME, '.kimi'), { type: 'dir' }],
    [join(root, hashDir), { type: 'dir' }],
    [join(HOME, '.kimi', 'kimi.json'), { type: 'file', text: j({ work_dirs: [{ path: workDir, kaos: 'local' }] }) }],
    [sessDir, { type: 'dir' }],
    [join(sessDir, 'wire.jsonl'), { type: 'file', mtimeMs: 1786000002000, text: [
      j({ type: 'metadata', protocol_version: '1' }),
      j({ timestamp: 1786000000.5, message: { type: 'TurnBegin', payload: { user_input: '帮我重构这个模块' } } }),
      j({ timestamp: 1786000001.5, message: { type: 'TextPart', payload: { text: '好的' } } }),
    ].join('\n') }],
    [join(sessDir, 'state.json'), { type: 'file', text: j({ custom_title: 'Kimi 会话标题' }) }],
    // 无 wire.jsonl 的目录不是会话
    [join(root, hashDir, 'not-a-session'), { type: 'dir' }],
  ])
  const host = mockHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'kimi', host, imports: {} })
  assert.equal(total, 1)
  const s = sessions[0]
  assert.equal(s.format, 'kimi')
  assert.equal(s.sessionId, 'sess-001')
  assert.equal(s.title, 'Kimi 会话标题') // custom_title 优先于 wire 首问
  assert.equal(s.project, 'kimi-proj') // kimi.json md5 映射 cwd 的 basename
  assert.equal(s.createdAt, 1786000000000) // 首条记录 timestamp（秒 → 毫秒）
  assert.equal(s.lastActiveAt, 1786000002000) // wire.jsonl mtime
})

test('kimi：上下文 token 数取 usage 记录的 inputOther + inputCacheRead', async () => {
  const root = join(HOME, '.kimi', 'sessions')
  const workDir = join('D:', 'demo', 'kimi-proj')
  const hashDir = createHash('md5').update(workDir, 'utf8').digest('hex')
  const sessDir = join(root, hashDir, 'sess-001')
  const files = new Map([
    [root, { type: 'dir' }],
    [join(HOME, '.kimi'), { type: 'dir' }],
    [join(root, hashDir), { type: 'dir' }],
    [join(HOME, '.kimi', 'kimi.json'), { type: 'file', text: j({ work_dirs: [{ path: workDir, kaos: 'local' }] }) }],
    [sessDir, { type: 'dir' }],
    [join(sessDir, 'wire.jsonl'), { type: 'file', text: [
      j({ type: 'metadata', protocol_version: '1' }),
      j({ timestamp: 1786000000.5, message: { type: 'TurnBegin', payload: { user_input: '跑一下' } } }),
      j({ type: 'usage.record', usage: { inputOther: 3347, output: 138, inputCacheRead: 18432, inputCacheCreation: 0 } }),
    ].join('\n') }],
  ])
  const host = mockHost(files)
  const { sessions } = await discoverSessions({ path: root, format: 'kimi', host, imports: {} })
  assert.equal(sessions[0].contextTokens, 3347 + 18432)
})

test('kimi：新 Kimi Code ~/.kimi-code agents/main/wire.jsonl 发现、state.json cwd/title', async () => {
  const root = join(HOME, '.kimi-code', 'sessions')
  const workspace = join(root, 'wd_nwflower_249d4b67aa09')
  const sessDir = join(workspace, 'session-001')
  const agentWire = join(sessDir, 'agents', 'main', 'wire.jsonl')
  const files = new Map([
    [root, { type: 'dir' }],
    [join(HOME, '.kimi-code'), { type: 'dir' }],
    [workspace, { type: 'dir' }],
    [sessDir, { type: 'dir' }],
    [join(sessDir, 'agents'), { type: 'dir' }],
    [join(sessDir, 'agents', 'main'), { type: 'dir' }],
    [agentWire, { type: 'file', mtimeMs: 1786000002000, text: [
      j({ type: 'metadata', protocol_version: '1', created_at: 1786000000500 }),
      j({ type: 'turn.prompt', input: [{ type: 'text', text: '帮我看看构建失败' }], time: 1786000000501 }),
      j({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: '是缺少依赖。' } }, time: 1786000000502 }),
    ].join('\n') }],
    [join(sessDir, 'state.json'), { type: 'file', text: j({ id: 'session-001', cwd: 'C:/Users/u/proj', title: '新 Kimi Code 标题', isCustomTitle: true }) }],
    // agents/main 自身不是会话目录（没有 state.json 伴生）
    [join(workspace, 'not-a-session'), { type: 'dir' }],
  ])
  const host = mockHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'kimi', host, imports: {} })
  assert.equal(total, 1)
  const s = sessions[0]
  assert.equal(s.format, 'kimi')
  assert.equal(s.sessionId, 'session-001')
  assert.equal(s.title, '新 Kimi Code 标题') // state.json isCustomTitle+title
  assert.equal(s.project, 'proj') // state.json cwd basename
  assert.equal(s.cwd, 'C:/Users/u/proj')
  assert.equal(s.createdAt, 1786000000500) // 新 wire metadata created_at（毫秒）
  assert.equal(s.lastActiveAt, 1786000002000) // agents/main/wire.jsonl mtime

  // 直接把单个新会话目录作为 path 也应识别为会话（不自拒、不误收 agents/main）
  const direct = await discoverSessions({ path: sessDir, format: 'kimi', host, imports: {} })
  assert.equal(direct.total, 1)
  assert.equal(direct.sessions[0].sessionId, 'session-001')
  assert.equal(direct.sessions[0].sourcePath, sessDir)
})

// Issue #61：新版 Kimi Code 的 state.json 多数只写 workDir（旧版写 cwd）。发现层只认 cwd 时
// project/cwd 会丢，面板里那条会话因此没有项目归属，导入也落不到源工作区。
test('kimi：state.json 仅含 workDir 时发现层同样取到 cwd（#61）', async () => {
  const root = join(HOME, '.kimi-code', 'sessions')
  const workspace = join(root, 'wd_genius-invokation_7d34e589df57')
  const sessDir = join(workspace, 'session-eb6808b9')
  const agentWire = join(sessDir, 'agents', 'main', 'wire.jsonl')
  const files = new Map([
    [root, { type: 'dir' }],
    [join(HOME, '.kimi-code'), { type: 'dir' }],
    [workspace, { type: 'dir' }],
    [sessDir, { type: 'dir' }],
    [join(sessDir, 'agents'), { type: 'dir' }],
    [join(sessDir, 'agents', 'main'), { type: 'dir' }],
    [agentWire, { type: 'file', mtimeMs: 1786000002000, text: [
      j({ type: 'metadata', protocol_version: '1', created_at: 1786000000500 }),
      j({ type: 'turn.prompt', input: [{ type: 'text', text: '帮我看看构建失败' }], time: 1786000000501 }),
    ].join('\n') }],
    [join(sessDir, 'state.json'), { type: 'file', text: j({ id: 'session-eb6808b9', workDir: 'D:/AI/GTCG/genius-invokation' }) }],
  ])
  const host = mockHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'kimi', host, imports: {} })
  assert.equal(total, 1)
  assert.equal(sessions[0].cwd, 'D:/AI/GTCG/genius-invokation')
  assert.equal(sessions[0].project, 'genius-invokation')
})

test('kimi：state.json 缺失时按 workspaces.json 的 workspace-id 回退 cwd（REQ-77）', async () => {
  const root = join(HOME, '.kimi-code', 'sessions')
  const workspaceId = 'wd_genius-invokation_7d34e589df57'
  const workspace = join(root, workspaceId)
  const sessDir = join(workspace, 'session-no-state')
  const agentWire = join(sessDir, 'agents', 'main', 'wire.jsonl')
  const files = new Map([
    [root, { type: 'dir' }],
    [join(HOME, '.kimi-code'), { type: 'dir' }],
    [workspace, { type: 'dir' }],
    [sessDir, { type: 'dir' }],
    [join(sessDir, 'agents'), { type: 'dir' }],
    [join(sessDir, 'agents', 'main'), { type: 'dir' }],
    [join(HOME, '.kimi-code', 'workspaces.json'), { type: 'file', text: j({
      version: 1,
      workspaces: { [workspaceId]: { root: 'D:/AI/GTCG/genius-invokation', name: 'genius-invokation' } },
    }) }],
    [agentWire, { type: 'file', mtimeMs: 1786000002000, text: [
      j({ type: 'metadata', protocol_version: '1', created_at: 1786000000500 }),
      j({ type: 'turn.prompt', input: [{ type: 'text', text: '帮我看看构建失败' }], time: 1786000000501 }),
    ].join('\n') }],
  ])
  const host = mockHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'kimi', host, imports: {} })
  assert.equal(total, 1)
  assert.equal(sessions[0].cwd, 'D:/AI/GTCG/genius-invokation')
  assert.equal(sessions[0].project, 'genius-invokation')
})

test('antigravity：~/.gemini/antigravity 每会话一目录发现、.db/.pb 同 id 去重、annotation 标题、cwd、缺 transcript 自拒', async () => {
  const root = join(HOME, '.gemini', 'antigravity')
  const convDir = join(root, 'conversations')
  const brainDir = join(root, 'brain')
  const annoDir = join(root, 'annotations')
  const logsDir = join(brainDir, 'conv-1', '.system_generated', 'logs')
  const transcript = join(logsDir, 'transcript.jsonl')
  const files = new Map([
    [root, { type: 'dir' }],
    [convDir, { type: 'dir' }],
    [brainDir, { type: 'dir' }],
    [annoDir, { type: 'dir' }],
    [join(brainDir, 'conv-1'), { type: 'dir' }],
    [join(brainDir, 'conv-1', '.system_generated'), { type: 'dir' }],
    [logsDir, { type: 'dir' }],
    [transcript, { type: 'file', mtimeMs: 1786000002000, text: [
      j({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-01-02T03:04:05Z', content: '<USER_REQUEST>\n首个提问\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nws: /x\n</ADDITIONAL_METADATA>' }),
      j({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-01-02T03:04:06Z', content: '回复', tool_calls: [{ name: 'run_command', args: { CommandLine: '"ls"', Cwd: '"/home/u/demo"' } }] }),
    ].join('\n') + '\n' }],
    [join(annoDir, 'conv-1.pbtxt'), { type: 'file', text: 'title:"权威标题"' }],
    // 新旧会话文件并存（SQLite *.db + protobuf *.pb）：同 id 只发现一次
    [join(convDir, 'conv-1.db'), { type: 'file', text: '' }],
    [join(convDir, 'conv-1.pb'), { type: 'file', text: '' }],
    // 只有 .pb 的会话同样可发现（新布局下 protobuf 文件仍旧存在）
    [join(convDir, 'conv-3.pb'), { type: 'file', text: '' }],
    [join(brainDir, 'conv-3', '.system_generated', 'logs'), { type: 'dir' }],
    [join(brainDir, 'conv-3', '.system_generated', 'logs', 'transcript.jsonl'), { type: 'file', text: j({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>pb 会话</USER_REQUEST>' }) + '\n' }],
    // 有 .db 但无 transcript 的会话：无正文可导 → 不产出条目
    [join(convDir, 'conv-2.db'), { type: 'file', text: '' }],
  ])
  const host = mockHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'antigravity', host, imports: {} })
  assert.equal(total, 2)
  const s = sessions.find((x) => x.sessionId === 'conv-1')
  assert.equal(s.format, 'antigravity')
  assert.equal(s.title, '权威标题') // annotations/*.pbtxt 权威标题
  assert.equal(s.project, 'antigravity')
  assert.equal(s.cwd, '/home/u/demo') // 工具参数 Cwd 推断
  assert.equal(s.lastActiveAt, 1786000002000)
  assert.equal(s.sourcePath, transcript) // 导入输入指向 transcript.jsonl
  const p = sessions.find((x) => x.sessionId === 'conv-3')
  assert.equal(p.title, 'pb 会话')
  assert.equal(join(p.sourcePath, ''), join(brainDir, 'conv-3', '.system_generated', 'logs', 'transcript.jsonl'))
})

test('antigravity：默认根同时覆盖 ~/.gemini/antigravity 与旧 antigravity-cli（双根扫描）', async () => {
  const roots = defaultRoots({ home: HOME }).antigravity
  assert.deepEqual(roots, [
    join(HOME, '.gemini', 'antigravity'),
    join(HOME, '.gemini', 'antigravity-cli'),
    join(HOME, '.gemini', 'antigravity-ide'),
  ])
  // 新旧两棵根各放一个会话：缺省的默认根扫描应把两棵都发现（缺失根静默落空）
  const mkTree = (root, id) => {
    const t = join(root, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
    return [t, [
      [root, { type: 'dir' }],
      [join(root, 'conversations'), { type: 'dir' }],
      [join(root, 'conversations', id + '.db'), { type: 'file', text: '' }],
      [join(root, 'brain'), { type: 'dir' }],
      [join(root, 'brain', id), { type: 'dir' }],
      [join(root, 'brain', id, '.system_generated'), { type: 'dir' }],
      [join(root, 'brain', id, '.system_generated', 'logs'), { type: 'dir' }],
      [t, { type: 'file', text: j({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>' + id + ' 提问</USER_REQUEST>' }) + '\n' }],
    ]]
  }
  const fileMap = new Map()
  for (const [root, id] of [[roots[0], 'new-1'], [roots[1], 'old-1']]) {
    const [, rows] = mkTree(root, id)
    for (const [p, v] of rows) fileMap.set(p, v)
  }
  const host = mockHost(fileMap)

  const { sessions, total } = await discoverSessions({ format: 'antigravity', home: HOME, host, imports: {} })
  assert.equal(total, 2)
  assert.deepEqual(sessions.map((s) => s.sessionId).sort(), ['new-1', 'old-1'])
})

test('antigravity：无 annotation 时回退首问标题（剥 <USER_REQUEST> 信封）', async () => {
  const root = join(HOME, '.gemini', 'antigravity')
  const logsDir = join(root, 'brain', 'c9', '.system_generated', 'logs')
  const files = new Map([
    [root, { type: 'dir' }],
    [join(root, 'conversations'), { type: 'dir' }],
    [join(root, 'conversations', 'c9.pb'), { type: 'file', text: '' }],
    [join(root, 'brain'), { type: 'dir' }],
    [join(root, 'brain', 'c9'), { type: 'dir' }],
    [join(root, 'brain', 'c9', '.system_generated'), { type: 'dir' }],
    [logsDir, { type: 'dir' }],
    [join(logsDir, 'transcript.jsonl'), { type: 'file', text: j({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-01-02T03:04:05Z', content: '<USER_REQUEST>回退标题</USER_REQUEST>' }) + '\n' }],
  ])
  const host = mockHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'antigravity', host, imports: {} })
  assert.equal(total, 1)
  assert.equal(sessions[0].title, '回退标题')
  assert.equal(sessions[0].cwd, null)
})

test('qoder：~/.qoder/projects 发现、ai-title 标题、cwd 项目名、subagents 跳过', async () => {
  const root = join(HOME, '.qoder', 'projects')
  const proj = join(root, '-home-u-demo')
  const s1 = join(proj, 'sess-q1.jsonl')
  const sessDir = join(proj, 'sess-q1')
  const subDir = join(sessDir, 'subagents')
  const files = new Map([
    [root, { type: 'dir' }],
    [proj, { type: 'dir' }],
    [s1, { type: 'file', mtimeMs: 1786000002000, text: [
      j({ sessionId: 'sess-q1', type: 'user', cwd: '/home/u/demo', timestamp: '2026-01-02T03:04:05.000Z', message: { role: 'user', content: '帮我看看构建' } }),
      j({ sessionId: 'sess-q1', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } }),
      j({ type: 'ai-title', aiTitle: '自定义标题', sessionId: 'sess-q1' }),
    ].join('\n') }],
    [sessDir, { type: 'dir' }],
    [subDir, { type: 'dir' }],
    [join(subDir, 'agent-a.jsonl'), { type: 'file', text: j({ sessionId: 'sess-q1', type: 'user', message: { role: 'user', content: '子代理' } }) }],
  ])
  const host = mockHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'qoder', host, imports: {} })
  assert.equal(total, 1)
  const s = sessions[0]
  assert.equal(s.format, 'qoder')
  assert.equal(s.sessionId, 'sess-q1')
  assert.equal(s.title, '自定义标题') // ai-title
  assert.equal(s.project, 'demo') // 记录内 cwd basename
  assert.equal(s.cwd, '/home/u/demo')
  assert.equal(s.lastActiveAt, 1786000002000)
})

test('workbuddy：~/.workbuddy/projects 发现、user_query 标题、cwd 项目名、路径自拒', async () => {
  const root = join(HOME, '.workbuddy', 'projects')
  const proj = join(root, 'project-hash-1')
  const s1 = join(proj, 'wb-sess-0001.jsonl')
  const files = new Map([
    [root, { type: 'dir' }],
    [proj, { type: 'dir' }],
    [s1, {
      type: 'file', mtimeMs: 1786000002000, text: [
        j({ id: 'u', timestamp: 1787131157250, type: 'message', role: 'user', content: [{ type: 'input_text', text: '<system-reminder>注入</system-reminder>\n<user_query>帮我看看这个项目</user_query>' }], sessionId: 'wb-sess-0001', cwd: '/home/u/demo' }),
        j({ id: 'r', timestamp: 1787131157251, type: 'reasoning', rawContent: [{ type: 'reasoning_text', text: '思考' }], sessionId: 'wb-sess-0001', cwd: '/home/u/demo' }),
        j({ id: 'a', timestamp: 1787131157252, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的' }], sessionId: 'wb-sess-0001', cwd: '/home/u/demo' }),
      ].join('\n'),
    }],
  ])
  const host = mockHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'workbuddy', host, imports: {} })
  assert.equal(total, 1)
  const s = sessions[0]
  assert.equal(s.format, 'workbuddy')
  assert.equal(s.sessionId, 'wb-sess-0001')
  assert.equal(s.title, '帮我看看这个项目') // <user_query> 提取
  assert.equal(s.project, 'demo') // 记录内 cwd basename
  assert.equal(s.cwd, '/home/u/demo')
  assert.equal(s.createdAt, 1787131157250)
  assert.equal(s.lastActiveAt, 1786000002000)

  // 路径自拒：指向其它目录的同一批文件，workbuddy 扫描器返回空
  const other = await discoverSessions({ path: join(HOME, 'elsewhere'), format: 'workbuddy', host, imports: {} })
  assert.equal(other.total, 0)
})

test('qwen：~/.qwenworkcn/projects 发现、humanInput 首问、workspace-directories 项目、双 slug 去重、路径自拒', async () => {
  const root = join(HOME, '.qwenworkcn', 'projects')
  const slugA = join(root, '-sessions-abc123-mnt')
  const slugB = join(root, 'C--Users-Administrator--qwenworkcn-workspace-chat1')
  const sid = '5543d6df-ec9e-4ce9-842d-aaa9cc74867f'
  // 双 slug 副本：同一会话落在两个 slug 下，mtime 新者胜
  const f1 = join(slugA, sid + '.jsonl')
  const f2 = join(slugB, sid + '.jsonl')
  const rec = (over = {}) => j({
    type: 'user', sessionId: sid, timestamp: '2026-08-28T08:09:41.457Z',
    uuid: 'u1', parentUuid: null, isSidechain: false,
    cwd: 'C:\\Users\\Administrator\\.qwenworkcn\\workspace\\mtco7zxwdyf68dl9',
    humanInput: { text: '出个html介绍一下ai领域的思路', mode: 'prompt' },
    message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>环境注入</system-reminder>' }] },
    ...over,
  })
  const head = [
    j({ type: 'workspace-directories', sessionId: sid, directories: ['C:\\Users\\Administrator\\.qwenworkcn\\workspace\\mtco7zxwdyf68dl9', 'E:\\RPA-260721-New\\Funion.Client-develop'] }),
    rec(),
    j({ type: 'assistant', sessionId: sid, timestamp: '2026-08-28T08:09:50.000Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '思考' }, { type: 'text', text: '好的' }] } }),
  ].join('\n')
  const files = new Map([
    [root, { type: 'dir' }],
    [slugA, { type: 'dir' }],
    [slugB, { type: 'dir' }],
    [f1, { type: 'file', mtimeMs: 1786000001000, text: head }],
    [f2, { type: 'file', mtimeMs: 1786000002000, text: head }],
  ])
  const host = mockHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'qwen', host, imports: {} })
  assert.equal(total, 1) // 双 slug 副本按 sessionId 去重
  const s = sessions[0]
  assert.equal(s.format, 'qwen')
  assert.equal(s.sessionId, sid)
  assert.equal(s.title, '出个html介绍一下ai领域的思路') // humanInput.text 首问
  assert.equal(s.project, 'Funion.Client-develop') // workspace-directories 非 .qwenworkcn 目录
  assert.equal(s.cwd, 'E:\\RPA-260721-New\\Funion.Client-develop')
  assert.equal(s.sourcePath, f2) // 留 mtime 最新的副本
  assert.equal(s.lastActiveAt, 1786000002000)

  // 路径自拒：非 ~/.qwenworkcn/projects/ 布局返回空
  const elsewhere = await discoverSessions({ path: join(HOME, 'elsewhere'), format: 'qwen', host, imports: {} })
  assert.equal(elsewhere.total, 0)
})

test('continue：sessions.json 索引驱动发现（标题/创建时间/项目）、非会话文件自拒、无索引回退整读', async () => {
  const root = join(HOME, '.continue', 'sessions')
  const sid = '3f2b9c14-58a7-4f6d-9c31-0d5e7a1b2c34'
  const file = join(root, sid + '.json')
  const session = (title, history) => j({ sessionId: sid, title, workspaceDirectory: '/home/u/repo', history })
  const files = new Map([
    [root, { type: 'dir' }],
    [join(root, 'sessions.json'), {
      type: 'file',
      text: j([{ sessionId: sid, title: '修登录页分页', dateCreated: '1787131157250', workspaceDirectory: '/home/u/repo'}]),
    }],
    [file, {
      type: 'file', mtimeMs: 1786000002000,
      text: session('修登录页分页', [
        { message: { id: 'u1', role: 'user', content: '修分页' } },
        { message: { id: 'a1', role: 'assistant', content: '已修' } },
      ]),
    }],
    // 同目录混入的非会话 JSON（`{}` 空文件、索引本身）都不产出条目
    [join(root, 'empty.json'), { type: 'file', text: '{}' }],
  ])
  const host = mockHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'continue', host, imports: {} })
  assert.equal(total, 1)
  const s = sessions[0]
  assert.equal(s.format, 'continue')
  assert.equal(s.sessionId, sid)
  assert.equal(s.title, '修登录页分页') // 索引里的显式标题
  assert.equal(s.project, 'repo') // 记录内 workspaceDirectory basename
  assert.equal(s.cwd, '/home/u/repo')
  assert.equal(s.createdAt, 1787131157250) // 只有索引带 dateCreated（毫秒字符串）
  assert.equal(s.lastActiveAt, 1786000002000)

  // 索引缺失（手工删改）→ 整读会话文件取标题/项目/消息数，创建时间留空由导入层兜底
  const bare = join(HOME, 'cfg', 'continue', 'sessions')
  const files2 = new Map([
    [bare, { type: 'dir' }],
    [join(bare, sid + '.json'), {
      type: 'file', mtimeMs: 1786000003000,
      text: session('裸目录会话', [
        { message: { id: 'u1', role: 'user', content: '问' } },
        { message: { id: 'a1', role: 'assistant', content: '答' } },
        { message: { id: 't1', role: 'thinking', content: '想' } },
      ]),
    }],
  ])
  const fallback = await discoverSessions({ path: bare, format: 'continue', host: mockHost(files2), imports: {} })
  assert.equal(fallback.total, 1)
  assert.equal(fallback.sessions[0].title, '裸目录会话')
  assert.equal(fallback.sessions[0].cwd, '/home/u/repo')
  assert.equal(fallback.sessions[0].createdAt, null)
})

test('continue：取消标题（默认 New Session）不冒充标题，交给首问兜底', async () => {
  const root = join(HOME, '.continue', 'sessions')
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const files = new Map([
    [root, { type: 'dir' }],
    [join(root, sid + '.json'), {
      type: 'file', mtimeMs: 1786000004000,
      text: j({ sessionId: sid, title: 'New Session', workspaceDirectory: '/home/u/repo', history: [] }),
    }],
  ])
  const { sessions, total } = await discoverSessions({ path: root, format: 'continue', host: mockHost(files), imports: {} })
  assert.equal(total, 1)
  assert.equal(sessions[0].title, null)
})

test('cline：DB 索引优先（cwd/时间/标题），转写缺失的会话不列出', async () => {
  const dataDir = join(HOME, '.cline', 'data')
  const sessionsDir = join(dataDir, 'sessions')
  const dbPath = join(dataDir, 'db', 'sessions.db')
  const sid = '01J8Z6Q0M4V7X2K9TB3N5R8WDA'
  const transcript = join(sessionsDir, sid, sid + '.messages.json')
  const files = new Map([
    [sessionsDir, { type: 'dir' }],
    [dbPath, { type: 'file', mtimeMs: 1786000005000, text: 'SQLite format 3' }],
    [transcript, {
      type: 'file', mtimeMs: 1786000006000,
      text: j({ version: 1, agent: 'lead', sessionId: sid, updated_at: '2026-04-22T17:42:10.123Z', messages: [] }),
    }],
  ])
  const host = mockHost(files)
  host.dbSessions = (kind) => {
    assert.equal(kind, 'cline')
    return [
      {
        id: sid, title: '修登录页分页', prompt: '修一下登录页分页', cwd: '/home/u/repo',
        createdAt: Date.parse('2026-04-22T17:40:00.000Z'), lastActiveAt: Date.parse('2026-04-22T17:42:10.123Z'), messagesPath: transcript,
      },
      // 转写被删/未落盘的会话：DB 里有、磁盘上没有 → 不列出（点了也导不进来）
      { id: 'ghost', title: '幽灵会话', cwd: null, createdAt: null, messagesPath: join(sessionsDir, 'ghost', 'ghost.messages.json') },
    ]
  }

  const { sessions, total } = await discoverSessions({ path: sessionsDir, format: 'cline', host, imports: {} })
  assert.equal(total, 1)
  const s = sessions[0]
  assert.equal(s.format, 'cline')
  assert.equal(s.sessionId, sid)
  assert.equal(s.title, '修登录页分页')
  assert.equal(s.project, 'repo')
  assert.equal(s.cwd, '/home/u/repo')
  assert.equal(s.createdAt, Date.parse('2026-04-22T17:40:00.000Z'))
  assert.equal(s.lastActiveAt, Date.parse('2026-04-22T17:42:10.123Z'))
  assert.equal(s.sourcePath, transcript)
})

test('cline：DB 不可用时回退扫目录（manifest 取标题/项目；子代理消息文件不算会话）', async () => {
  const sessionsDir = join(HOME, '.cline', 'data', 'sessions')
  const sid = '01J8Z6Q0M4V7X2K9TB3N5R8WDA'
  const dir = join(sessionsDir, sid)
  const manifest = j({
    version: 1, session_id: sid, started_at: '2026-04-22T17:40:00.000Z',
    cwd: '/home/u/repo', workspace_root: '/home/u/repo', metadata: { title: '来自 manifest 的标题' },
  })
  const files = new Map([
    [sessionsDir, { type: 'dir' }],
    [dir, { type: 'dir' }],
    [join(dir, sid + '.messages.json'), {
      type: 'file', mtimeMs: 1786000007000,
      text: j({ version: 1, agent: 'lead', sessionId: sid, updated_at: '2026-04-22T17:42:10.123Z', messages: [] }),
    }],
    [join(dir, sid + '.json'), { type: 'file', text: manifest }],
    // 子代理消息文件（文件名与目录名不同）+ 子代理 agent 的文件都不成会话
    [join(dir, 'explore-1.messages.json'), {
      type: 'file', text: j({ version: 1, agent: 'subagent', sessionId: sid + '__explore-1', messages: [] }),
    }],
  ])

  const { sessions, total } = await discoverSessions({ path: sessionsDir, format: 'cline', host: mockHost(files), imports: {} })
  assert.equal(total, 1)
  const s = sessions[0]
  assert.equal(s.sessionId, sid)
  assert.equal(s.title, '来自 manifest 的标题')
  assert.equal(s.project, 'repo')
  assert.equal(s.cwd, '/home/u/repo')
  assert.equal(s.createdAt, Date.parse('2026-04-22T17:40:00.000Z'))
  assert.equal(s.lastActiveAt, Date.parse('2026-04-22T17:42:10.123Z'))
})

test('cline legacy：globalStorage 的 taskHistory 索引发现 api history，UI 消息可作标题回退', async () => {
  const root = join(HOME, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev')
  const taskId = 'legacy-task-001'
  const tasks = join(root, 'tasks')
  const taskDir = join(tasks, taskId)
  const api = join(taskDir, 'api_conversation_history.json')
  const ui = join(taskDir, 'ui_messages.json')
  const files = new Map([
    [root, { type: 'dir' }], [join(root, 'state'), { type: 'dir' }], [tasks, { type: 'dir' }], [taskDir, { type: 'dir' }],
    [join(root, 'state', 'taskHistory.json'), {
      type: 'file', mtimeMs: 1786000012000,
      text: j([{ id: taskId, ts: 1786000000000, task: '', cwdOnTaskInitialization: hostAbs('D:/repo') }]),
    }],
    [api, {
      type: 'file', mtimeMs: 1786000013000,
      text: j([{ role: 'user', content: 'legacy question' }, { role: 'assistant', content: 'answer' }]),
    }],
    [ui, { type: 'file', text: j([{ type: 'ask', ask: 'followup', text: '标题来自 UI' }]) }],
  ])
  const host = mockHost(files)
  const result = await discoverSessions({ path: root, format: 'cline', host, imports: {} })
  assert.equal(result.total, 1)
  assert.deepEqual(result.sessions[0], {
    format: 'cline', sessionId: taskId, title: '标题来自 UI', project: 'repo',
    createdAt: 1786000000000, lastActiveAt: 1786000013000,
    contextTokens: null, sourcePath: api, cwd: hostAbs('D:/repo'), importStatus: 'not-imported',
    gitBranch: null, gitDirty: null,
  })

  const direct = await discoverSessions({ path: api, host, imports: {} })
  assert.equal(direct.total, 1)
  assert.equal(direct.sessions[0].sessionId, taskId)
})

test('goose：sessions.db 经 host.readSessions 发现（标题/项目/时间），旧 jsonl 不当作来源', async () => {
  const dataDir = join(HOME, '.local', 'share', 'goose')
  const sessionsDir = join(dataDir, 'sessions')
  const dbPath = join(sessionsDir, 'sessions.db')
  const files = new Map([
    [sessionsDir, { type: 'dir' }],
    [dbPath, { type: 'file', mtimeMs: 1786000008000, text: 'SQLite format 3' }],
    // 旧版 jsonl 还在磁盘上（上游迁移后不删）→ 绝不能扫出来重复导入
    [join(sessionsDir, '20260301_1.jsonl'), { type: 'file', text: '{"id":"20260301_1"}\n' }],
  ])
  const host = mockHost(files)
  host.dbSessions = (kind) => {
    assert.equal(kind, 'goose')
    return [
      {
        id: '20260422_1', title: '修登录页分页', directory: '/home/u/repo',
        createdAt: 1776879600000, lastActiveAt: 1776879730000,
      },
      {
        id: '20260422_2', title: '', directory: '/home/u/other',
        createdAt: null, lastActiveAt: null,
      },
    ]
  }

  const { sessions, total } = await discoverSessions({ path: sessionsDir, format: 'goose', host, imports: {} })
  assert.equal(total, 2) // 只有库里的会话；jsonl 不计
  const first = sessions.find((s) => s.sessionId === '20260422_1')
  assert.equal(first.format, 'goose')
  assert.equal(first.title, '修登录页分页')
  assert.equal(first.project, 'repo')
  assert.equal(first.cwd, '/home/u/repo')
  assert.equal(first.createdAt, 1776879600000)
  assert.equal(first.lastActiveAt, 1776879730000)
  assert.equal(first.sourcePath, dbPath)
  assert.equal(sessions.some((s) => String(s.sourcePath).endsWith('.jsonl')), false)
})

test('goose 默认根：与 lib/convert/goose.mjs 的解析规则一致（含 $GOOSE_PATH_ROOT / 平台分支）', () => {
  const roots = defaultRoots({ home: HOME })
  assert.equal(roots.goose, gooseSessionsDir(HOME))
  assert.ok(/[\\/]sessions$/.test(roots.goose))
})

test('zed：threads.db 经 host.readSessions 发现（标题/项目/时间）；默认根与路径规则一致', async () => {
  const dataDir = join(HOME, '.local', 'share', 'zed')
  const threadsDir = join(dataDir, 'threads')
  const dbPath = join(threadsDir, 'threads.db')
  const files = new Map([
    [threadsDir, { type: 'dir' }],
    [dbPath, { type: 'file', mtimeMs: 1786000009000, text: 'SQLite format 3' }],
  ])
  const host = mockHost(files)
  host.dbSessions = (kind) => {
    assert.equal(kind, 'zed')
    return [{
      id: '2f8b1c6e-0000-4000-8000-000000000001',
      title: '修登录页分页', directory: '/home/u/proj',
      createdAt: Date.parse('2026-09-15T13:38:45.123Z'), lastActiveAt: Date.parse('2026-09-15T13:40:00.000Z'),
    }]
  }

  const { sessions, total } = await discoverSessions({ path: threadsDir, format: 'zed', host, imports: {} })
  assert.equal(total, 1)
  const s = sessions[0]
  assert.equal(s.format, 'zed')
  assert.equal(s.title, '修登录页分页')
  assert.equal(s.project, 'proj')
  assert.equal(s.cwd, '/home/u/proj')
  assert.equal(s.createdAt, Date.parse('2026-09-15T13:38:45.123Z'))
  assert.equal(s.lastActiveAt, Date.parse('2026-09-15T13:40:00.000Z'))
  assert.equal(s.sourcePath, dbPath)

  const roots = defaultRoots({ home: HOME })
  assert.equal(roots.zed, zedThreadsDir(HOME))
  assert.ok(/[\\/]threads$/.test(roots.zed))
})

test('crush：经 projects.json 与宿主工作区探测项目内 crush.db（DB 无 cwd → 项目取注册表路径）', async () => {
  const projA = join(HOME, 'proj-a')
  const projB = join(HOME, 'proj-b')
  const dbA = join(projA, '.crush', 'crush.db')
  const dbB = join(projB, '.crush', 'crush.db')
  const userDir = join(HOME, '.local', 'share', 'crush')
  const registry = join(userDir, 'projects.json')
  const files = new Map([
    [userDir, { type: 'dir' }],
    [projA, { type: 'dir' }],
    [projB, { type: 'dir' }],
    [registry, {
      type: 'file',
      text: j({ projects: [{ path: projA, data_dir: join(projA, '.crush'), last_accessed: '2026-09-15T13:00:00Z' }] }),
    }],
    [dbA, { type: 'file', mtimeMs: 1786000010000, text: 'SQLite format 3' }],
    [dbB, { type: 'file', mtimeMs: 1786000011000, text: 'SQLite format 3' }],
  ])
  const host = mockHost(files)
  host.listWorkspaces = async () => [projB] // 宿主已知工作区 → 项目内探测
  host.dbSessions = (kind, dbPath) => {
    assert.equal(kind, 'crush')
    if (dbPath === dbA) {
      return [{ id: 'sess-a', title: 'Add retry to fetch', directory: null, createdAt: 1768000001000, lastActiveAt: 1768000123000}]
    }
    return [{ id: 'sess-b', title: '别的项目', directory: null, createdAt: null, lastActiveAt: null}]
  }

  const { sessions, total } = await discoverSessions({ path: userDir, format: 'crush', host, imports: {} })
  assert.equal(total, 2)
  const a = sessions.find((s) => s.sessionId === 'sess-a')
  assert.equal(a.format, 'crush')
  assert.equal(a.project, 'proj-a') // 注册表给出的项目路径（DB 里没有 cwd）
  assert.equal(a.cwd, projA)
  assert.equal(a.createdAt, 1768000001000)
  assert.equal(a.sourcePath, dbA)
  const b = sessions.find((s) => s.sessionId === 'sess-b')
  assert.equal(b.project, 'proj-b') // 宿主工作区探测到的项目
  assert.equal(b.cwd, projB)

  // 显式指向项目目录也能发现（<项目>/.crush/crush.db）
  const direct = await discoverSessions({ path: projA, format: 'crush', host, imports: {} })
  assert.equal(direct.total, 1)
  assert.equal(direct.sessions[0].sessionId, 'sess-a')
  assert.equal(direct.sessions[0].cwd, projA)
})

test('cline 默认根：$CLINE_SESSION_DATA_DIR / $CLINE_DATA_DIR / $CLINE_DIR 优先级', () => {
  const roots = defaultRoots({ home: HOME })
  const expected = process.env.CLINE_SESSION_DATA_DIR
    || join(process.env.CLINE_DATA_DIR || join(process.env.CLINE_DIR || join(HOME, '.cline'), 'data'), 'sessions')
  assert.equal(roots.cline[0], expected)
  assert.ok(Array.isArray(roots.cline))
})

test('continue 默认根：$CONTINUE_GLOBAL_DIR 优先，否则 ~/.continue/sessions', () => {
  const roots = defaultRoots({ home: HOME })
  assert.equal(roots.continue, process.env.CONTINUE_GLOBAL_DIR
    ? join(process.env.CONTINUE_GLOBAL_DIR, 'sessions')
    : join(HOME, '.continue', 'sessions'))
})

// ── 30s TTL 缓存（REQ-25/REQ-40：命中不重读，可观测计数断言）──────────────

test('30s TTL 缓存：命中不重读、过期重扫（注入时钟）', async () => {
  let now = 1000000000000
  const cache = createScanCache({ now: () => now })
  const root = join(HOME, '.claude', 'projects')
  const slug = join(root, 'p')
  const files = new Map([
    [root, { type: 'dir' }], [slug, { type: 'dir' }],
    [join(slug, 'sess-001.jsonl'), { type: 'file', text: [
      j({ sessionId: 'sess-001', type: 'user', cwd: 'D:\\p', message: { role: 'user', content: '问题' } }),
    ].join('\n') }],
  ])
  const host = mockHost(files)

  const first = await discoverSessions({ path: root, format: 'claude', host, imports: {}, cache })
  assert.equal(first.total, 1)
  const reads1 = host.counters.reads
  assert.ok(reads1 > 0)

  now += 20000 // 30s 内
  const second = await discoverSessions({ path: root, format: 'claude', host, imports: {}, cache })
  assert.equal(second.total, 1)
  assert.equal(host.counters.reads, reads1) // 命中缓存：不重读

  now += 11000 // 超过 30s
  const third = await discoverSessions({ path: root, format: 'claude', host, imports: {}, cache })
  assert.equal(third.total, 1)
  assert.ok(host.counters.reads > reads1) // 过期重扫
})

// ── query 过滤（REQ-40：标题/项目/路径，忽略大小写）────────────────────────

test('query：标题 / 项目 / 路径子串过滤（忽略大小写）', async () => {
  const root = join(HOME, '.claude', 'projects')
  const files = new Map([[root, { type: 'dir' }]])
  for (const [dir, sid, cwd, title] of [
    ['proj-a', 'sess-a', 'D:\\demo\\login', '重构登录模块'],
    ['proj-b', 'sess-b', 'D:\\demo\\ops', '修复构建失败'],
  ]) {
    const slug = join(root, dir)
    files.set(slug, { type: 'dir' })
    files.set(join(slug, sid + '.jsonl'), { type: 'file', text: [
      j({ sessionId: sid, type: 'user', cwd, message: { role: 'user', content: title } }),
    ].join('\n') })
  }
  const host = mockHost(files)

  const byTitle = await discoverSessions({ path: root, format: 'claude', host, imports: {}, query: '登录' })
  assert.equal(byTitle.total, 1)
  assert.equal(byTitle.sessions[0].sessionId, 'sess-a')

  const byProject = await discoverSessions({ path: root, format: 'claude', host, imports: {}, query: 'PROJ-B' })
  assert.equal(byProject.total, 1)
  assert.equal(byProject.sessions[0].sessionId, 'sess-b')

  const byPath = await discoverSessions({ path: root, format: 'claude', host, imports: {}, query: 'sess-a.jsonl' })
  assert.equal(byPath.total, 1)
})

// ── importStatus（REQ-25：imported / partial / not-imported）────────────────

test('importStatus：multi 源子表命中 imported、部分导入 partial', async () => {
  const dbPath = join(HOME, '.local', 'share', 'opencode', 'opencode.db')
  const files = new Map([[dbPath, { type: 'file', text: '' }]])
  const host = mockHost(files)
  host.dbSessions = (kind) => (kind === 'opencode'
    ? ['ses-a', 'ses-b', 'ses-c'].map((id) => ({ id, title: 'T ' + id, directory: 'E:/demo/op', createdAt: 1, lastActiveAt: 2}))
    : null)
  const imports = {
    [dbPath]: { kind: 'multi', sessions: { 'ses-a': { dshId: 'import-ses-a' }, 'ses-b': { dshId: 'import-ses-b' } } },
  }

  const { sessions } = await discoverSessions({ path: dbPath, format: 'opencode', host, imports })
  assert.equal(sessions.find((s) => s.sessionId === 'ses-a').importStatus, 'imported')
  assert.equal(sessions.find((s) => s.sessionId === 'ses-b').importStatus, 'imported')
  assert.equal(sessions.find((s) => s.sessionId === 'ses-c').importStatus, 'partial')
})

// 回归（WAL 盲区）：SQLite 库开 WAL 后新会话只落 -wal，主文件 mtime/size 在
// checkpoint 前不变——持久化书签只比主文件会命中过期缓存，面板长期显示旧列表
//（如「某项目只有 2 个会话」）。指纹并入 -wal/-shm 边车后：边车变化 → 失效重扫；
// 全部未变 → 命中；checkpoint 删除 -wal 也构成指纹变化。
test('书签 WAL 盲区：-wal 出现/增长/删除都失效重扫，未变则命中', async () => {
  const dbPath = join(HOME, '.zcode', 'cli', 'db', 'db.sqlite')
  const files = new Map([[dbPath, { type: 'file', text: 'SQLite format 3', mtimeMs: 1786000000000 }]])
  const host = mockHost(files)
  let probe = 0
  host.dbSessions = (kind) => {
    if (kind !== 'zcode') return null
    probe++
    return [{ id: 'zcs-a', title: 'T a', directory: 'E:/demo/z', createdAt: 1, lastActiveAt: 2}]
  }
  const cacheDir = mkdtempSync(join(tmpdir(), 'dsh-scanbm-'))
  // cache 传新 Map 绕过进程内 30s TTL（书签层的行为才是本用例对象）
  const run = () => discoverSessions({ path: dbPath, format: 'zcode', host, imports: {}, cache: new Map(), cacheDir })
  try {
    const r1 = await run()
    assert.equal(r1.sessions.length, 1)
    assert.equal(probe, 1)
    // 主文件未变、无 -wal → 书签命中
    await run()
    assert.equal(probe, 1)
    // -wal 出现（工具运行中）：主文件 stat 仍不变 → 必须失效重扫
    files.set(dbPath + '-wal', { type: 'file', text: 'wal-data', mtimeMs: 1786000005000 })
    const r3 = await run()
    assert.equal(r3.sessions.length, 1)
    assert.equal(probe, 2)
    // -wal 未再变 → 命中
    await run()
    assert.equal(probe, 2)
    // -wal 增长（新会话写入 WAL）→ 失效重扫
    files.set(dbPath + '-wal', { type: 'file', text: 'wal-data-grown', mtimeMs: 1786000009000 })
    await run()
    assert.equal(probe, 3)
    // checkpoint 删除 -wal → 指纹又变 → 重扫一次后稳定命中
    files.delete(dbPath + '-wal')
    await run()
    assert.equal(probe, 4)
    await run()
    assert.equal(probe, 4)
  } finally {
    rmSync(cacheDir, { recursive: true, force: true })
  }
})

test('discoverSessions：archivedIds 传入 → 归档目标 importStatus=archived', async () => {
  const root = join(HOME, '.claude', 'projects')
  const slug = join(root, 'proj-a')
  const s1 = join(slug, 'sess-001.jsonl')
  const s2 = join(slug, 'sess-002.jsonl')
  const files = new Map([
    [root, { type: 'dir' }], [slug, { type: 'dir' }],
    [s1, { type: 'file', mtimeMs: 1, text: [j({ sessionId: 'sess-001', type: 'user', cwd: 'D:\\p', message: { role: 'user', content: '问题A' } })].join('\n') }],
    [s2, { type: 'file', mtimeMs: 2, text: [j({ sessionId: 'sess-002', type: 'user', message: { role: 'user', content: '问题B' } })].join('\n') }],
  ])
  const host = mockHost(files)
  const imports = {
    [s1]: { kind: 'single', dshId: 'import-sess-001' },
    [s2]: { kind: 'single', dshId: 'import-sess-002' },
  }

  // 缺省不标注（旧行为）
  const plain = await discoverSessions({ path: root, format: 'claude', host, imports, cache: createScanCache() })
  assert.equal(plain.sessions.find((s) => s.sessionId === 'sess-001').importStatus, 'imported')

  // 传入归档集：sess-001 的会话已归档 → archived；sess-002 未归档 → imported
  const found = await discoverSessions({ path: root, format: 'claude', host, imports, cache: createScanCache(), archivedIds: ['import-sess-001'] })
  assert.equal(found.sessions.find((s) => s.sessionId === 'sess-001').importStatus, 'archived')
  assert.equal(found.sessions.find((s) => s.sessionId === 'sess-002').importStatus, 'imported')
})

test('resolveImportStatus：single / legacy string / 无记录', () => {
  const imports = {
    '/a.jsonl': { kind: 'single', dshId: 'x' },
    '/b.jsonl': 'legacy-id',
  }
  assert.equal(resolveImportStatus(imports, '/a.jsonl', 's'), 'imported')
  assert.equal(resolveImportStatus(imports, '/b.jsonl', 's'), 'imported')
  assert.equal(resolveImportStatus(imports, '/missing.jsonl', 's'), 'not-imported')
  assert.equal(resolveImportStatus(imports, '/a.jsonl', 's'), 'imported')
})

test('resolveImportStatus：归档目标 → archived（single / legacy / multi 子表）', () => {
  const imports = {
    '/a.jsonl': { kind: 'single', dshId: 'import-x' },
    '/b.jsonl': 'import-legacy',
    '/c.jsonl': { kind: 'multi', sessions: { 'ses-1': { dshId: 'import-s1' }, 'ses-2': { dshId: 'import-s2' } } },
    '/d.jsonl': { kind: 'multi', sessions: {} },
  }
  const archived = new Set(['import-x', 'import-legacy', 'import-s1'])
  // single 记录 dshId 已归档
  assert.equal(resolveImportStatus(imports, '/a.jsonl', 's', archived), 'archived')
  // 旧版纯字符串记录（记录即 dshId）已归档
  assert.equal(resolveImportStatus(imports, '/b.jsonl', 's', archived), 'archived')
  // multi 子表：命中的子会话已归档 → archived；未归档 → imported
  assert.equal(resolveImportStatus(imports, '/c.jsonl', 'ses-1', archived), 'archived')
  assert.equal(resolveImportStatus(imports, '/c.jsonl', 'ses-2', archived), 'imported')
  // 子表非空但本会话不在（其它会话均已归档）→ partial（仍可重导，语义不变）
  assert.equal(resolveImportStatus(imports, '/c.jsonl', 'ses-3', archived), 'partial')
  // 未归档 → imported 不变；无记录 → not-imported 不变
  assert.equal(resolveImportStatus(imports, '/a.jsonl', 's', new Set(['other'])), 'imported')
  assert.equal(resolveImportStatus(imports, '/missing.jsonl', 's', archived), 'not-imported')
  // archivedIds 缺省 → 不标注（旧行为）
  assert.equal(resolveImportStatus(imports, '/a.jsonl', 's'), 'imported')
})

test('resolveImportStatus：注册表指向的会话已被删除（不在 persisted）→ not-imported（面板显示导入而非同步）', () => {
  // 真机回归：归档后再删除的会话，registry 记录还在、dshId 已不在宿主，此前返回 imported
  // → 面板显示「同步」，但会话没了无从同步，也无法重新导入。persistedIds 里没有该 dshId
  // 即判定「已删除」，优先级高于归档（归档后又被删除同样是 not-imported）。
  const imports = {
    '/a.jsonl': { kind: 'single', dshId: 'import-gone' },
    '/b.jsonl': 'import-legacy-gone',
    '/c.jsonl': { kind: 'multi', sessions: { 'ses-1': { dshId: 'import-s1-gone' }, 'ses-2': { dshId: 'import-s2-kept' } } },
  }
  const persisted = new Set(['import-s2-kept', 'import-alive'])
  assert.equal(resolveImportStatus(imports, '/a.jsonl', 's', undefined, persisted), 'not-imported')
  assert.equal(resolveImportStatus(imports, '/b.jsonl', 's', undefined, persisted), 'not-imported')
  assert.equal(resolveImportStatus(imports, '/c.jsonl', 'ses-1', undefined, persisted), 'not-imported')
  assert.equal(resolveImportStatus(imports, '/c.jsonl', 'ses-2', undefined, persisted), 'imported')
  // 已删除优先于已归档
  const archived = new Set(['import-gone'])
  assert.equal(resolveImportStatus(imports, '/a.jsonl', 's', archived, persisted), 'not-imported')
  // persistedIds 缺省 → 旧行为（不判删除）
  assert.equal(resolveImportStatus(imports, '/a.jsonl', 's'), 'imported')
  assert.equal(resolveImportStatus(imports, '/a.jsonl', 's', archived), 'archived')
})

// ── chatgpt（无自动根，path 显式）与默认根扫描 ─────────────────────────────

test('chatgpt：无自动根；path 显式 conversations.json 才解析；默认扫不含 chatgpt', async () => {
  const file = join(HOME, 'Downloads', 'conversations.json')
  const conv = (id, title, turns) => {
    const mapping = {}
    let prev = null
    let idx = 1
    for (const prompt of turns) {
      for (const role of ['user', 'assistant']) {
        const nid = 'n' + idx
        mapping[nid] = { id: nid, message: { id: 'm' + idx, author: { role }, content: { content_type: 'text', parts: [prompt] }, create_time: 1710000000 + idx }, parent: prev, children: [] }
        if (prev) mapping[prev].children.push(nid)
        prev = nid
        idx++
      }
    }
    return { id, title, create_time: 1710000000, mapping }
  }
  const files = new Map([[file, { type: 'file', text: j([conv('conv-001', 'Alpha', ['问题A']), conv('conv-002', 'Beta', ['问题B'])]) }]])
  const host = mockHost(files)

  const explicit = await discoverSessions({ path: file, format: 'chatgpt', host, imports: {} })
  assert.equal(explicit.total, 2)
  const a = explicit.sessions.find((s) => s.sessionId === 'conv-001')
  assert.equal(a.title, 'Alpha')
  assert.equal(a.createdAt, 1710000000 * 1000) // 秒 → 毫秒
  assert.equal(a.project, null)

  // 默认扫（无 path）→ chatgpt 无自动根，不参与；其余格式根指向不存在的 home → 空
  const all = await discoverSessions({ host, imports: {}, home: HOME })
  assert.ok(!all.sessions.some((s) => s.format === 'chatgpt'))
  assert.equal(all.total, 0)
})

// ── 目录探测：格式自拒不误判（同一根只出匹配格式）──────────────────────────

test('目录探测：claude 根不被其他 JSONL 格式误扫（自拒）', async () => {
  const root = join(HOME, '.claude', 'projects')
  const slug = join(root, 'proj-a')
  const files = new Map([
    [root, { type: 'dir' }], [slug, { type: 'dir' }],
    [join(slug, 'sess-001.jsonl'), { type: 'file', text: [
      j({ sessionId: 'sess-001', type: 'user', cwd: 'D:\\p', message: { role: 'user', content: '问题' } }),
    ].join('\n') }],
  ])
  const host = mockHost(files)

  // 不指定 format → 全部格式探测同一目录
  const { sessions, total } = await discoverSessions({ path: root, host, imports: {} })
  assert.equal(total, 1)
  assert.equal(sessions[0].format, 'claude')
})

// ── 纯函数：注入过滤 / 标题归一 / 布局项目名 ──────────────────────────────

test('isInjectedTitle / normalizeTitle / layoutProject 纯函数', () => {
  assert.equal(isInjectedTitle('<environment_context>'), true)
  assert.equal(isInjectedTitle('<system-reminder>'), true)
  assert.equal(isInjectedTitle('<user_instructions>'), true)
  assert.equal(isInjectedTitle('# Files mentioned by the user:'), true)
  assert.equal(isInjectedTitle('The user is asking about x'), true)
  assert.equal(isInjectedTitle('<local-command-caveat>'), true)
  assert.equal(isInjectedTitle('真实提问'), false)
  assert.equal(isInjectedTitle(''), true)

  assert.equal(normalizeTitle('  多个   空格  '), '多个 空格')
  const long = 'a'.repeat(100)
  const t = normalizeTitle(long)
  assert.equal(t.length, TITLE_MAX_LEN) // 80 字符截断（含省略号）
  assert.ok(t.endsWith('…'))

  assert.equal(layoutProject('/home/u/.claude/projects/slug-a/sess.jsonl', 'claude'), 'slug-a')
  assert.equal(layoutProject('/home/u/.codex/sessions/2026/03/10/rollout-x.jsonl', 'codex'), '2026/03')
  assert.equal(layoutProject('/home/u/.reasonix/projects/demo/s/desktop-1.jsonl', 'reasonix'), 'demo')
  assert.equal(layoutProject('/home/u/.grok/sessions/proj-x/grok-s1', 'grokbuild'), 'proj-x')
  // 编码目录名 = cwd 整路径 encodeURIComponent：解码后取末段
  assert.equal(layoutProject('/home/u/.grok/sessions/F%3A%5C%E9%A1%B9%E7%9B%AE%5Cproj/grok-s1', 'grokbuild'), 'proj')
  assert.equal(layoutProject('/home/u/.openclaw/agents/main/sessions/s.jsonl', 'openclaw'), 'main')
  assert.equal(layoutProject('/home/u/.gemini/history/slot-a/chats/session-1.json', 'gemini'), 'slot-a')
  assert.equal(layoutProject('/home/u/.cursor/projects/slug-c/agent-transcripts/abc/abc.jsonl', 'cursor'), 'slug-c')
  assert.equal(layoutProject('/home/u/.workbuddy/projects/project-hash-1/wb-sess-0001.jsonl', 'workbuddy'), 'project-hash-1')
  // antigravity：三套根（2.0 / 旧 CLI / IDE）同内层布局 → 恒定位 antigravity 源标签
  assert.equal(layoutProject('/home/u/.gemini/antigravity/brain/c1/.system_generated/logs/transcript.jsonl', 'antigravity'), 'antigravity')
  assert.equal(layoutProject('/home/u/.gemini/antigravity-cli/brain/c1/.system_generated/logs/transcript.jsonl', 'antigravity'), 'antigravity')
  assert.equal(layoutProject('/home/u/.gemini/antigravity-ide/brain/c1/.system_generated/logs/transcript.jsonl', 'antigravity'), 'antigravity')
})

test('cursor：slug 解码为真实工作区名分组，<timestamp> 解析时间，非仓库 slug 不归组', async () => {
  clearWorkspacePathCache()
  const slugDots = 'e-RPA-260721-New-Funion-Client-develop'
  const slugHyphen = 'e-RPA-260721-New-RpaScheduledTasks-publish-fail-monitor'
  const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const cwdDots = 'E:\\RPA-260721-New\\Funion.Client-develop'
  const cwdHyphen = 'E:\\RPA-260721-New\\RpaScheduledTasks\\publish-fail-monitor'
  const root = join(HOME, '.cursor', 'projects')
  const tsRaw = '<timestamp>Friday, Aug 7, 2026, 3:44 PM (UTC+8)</timestamp>\n<user_query>点号目录提问</user_query>'
  const dirA = join(root, slugDots, 'agent-transcripts', uuid)
  const fileA = join(dirA, uuid + '.jsonl')
  const dirB = join(root, slugHyphen, 'agent-transcripts', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
  const fileB = join(dirB, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl')
  const dirNum = join(root, '1784784551097', 'agent-transcripts', 'cccccccc-cccc-cccc-cccc-cccccccccccc')
  const fileNum = join(dirNum, 'cccccccc-cccc-cccc-cccc-cccccccccccc.jsonl')
  const files = new Map([
    [root, { type: 'dir' }],
    [join(root, slugDots), { type: 'dir' }],
    [join(root, slugHyphen), { type: 'dir' }],
    [join(root, '1784784551097'), { type: 'dir' }],
    [join(root, slugDots, 'agent-transcripts'), { type: 'dir' }],
    [join(root, slugHyphen, 'agent-transcripts'), { type: 'dir' }],
    [join(root, '1784784551097', 'agent-transcripts'), { type: 'dir' }],
    [dirA, { type: 'dir' }],
    [dirB, { type: 'dir' }],
    [dirNum, { type: 'dir' }],
    [fileA, { type: 'file', mtimeMs: 1786000002000, text: [
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: tsRaw }] } }),
    ].join('\n') }],
    [fileB, { type: 'file', mtimeMs: 1786000003000, text: [
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>连字符目录</user_query>' }] } }),
    ].join('\n') }],
    [fileNum, { type: 'file', mtimeMs: 1786000004000, text: [
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>纯数字 slug</user_query>' }] } }),
    ].join('\n') }],
    ['E:\\RPA-260721-New', { type: 'dir' }],
    [cwdDots, { type: 'dir' }],
    ['E:\\RPA-260721-New\\RpaScheduledTasks', { type: 'dir' }],
    [cwdHyphen, { type: 'dir' }],
  ])
  const host = mockHost(files)
  host.resolveCursorSlug = async (s) => {
    const ctx = {
      get(service) {
        if (service === 'workspaceRegistry') {
          return { list: () => [{ path: cwdDots }, { path: cwdHyphen }] }
        }
        return undefined
      },
      fs: {
        async resolve(p) { return { targetKey: p } },
        async stat(t) {
          const v = files.get(t.targetKey)
          if (!v) return null
          return v.type === 'dir' ? { type: 'directory' } : { type: 'file', size: (v.text || '').length, mtimeMs: v.mtimeMs }
        },
      },
    }
    return resolveCursorSlugPath(ctx, s)
  }
  const { sessions, total } = await discoverSessions({ path: root, format: 'cursor', host, imports: {} })
  assert.equal(total, 3)
  const dots = sessions.find((s) => s.sessionId === uuid)
  assert.equal(dots.project, 'Funion.Client-develop')
  assert.equal(dots.cwd, cwdDots)
  assert.equal(dots.title, '点号目录提问')
  assert.ok(typeof dots.createdAt === 'number' && dots.createdAt > 0)
  assert.equal(dots.lastActiveAt, 1786000002000)
  const hyphen = sessions.find((s) => s.sessionId === 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
  assert.equal(hyphen.project, 'publish-fail-monitor')
  assert.equal(hyphen.cwd, cwdHyphen)
  const numeric = sessions.find((s) => s.sessionId === 'cccccccc-cccc-cccc-cccc-cccccccccccc')
  assert.equal(numeric.project, null)
  assert.equal(numeric.cwd, null)
})

test('FORMATS 与工具 schema enum 一致（27 种）', () => {
  assert.equal(FORMATS.length, 27)
  // dsh / dsh4 是同一份会话目录的两个日志代次桶（V0–V3 / V4+），来源列表因此能分别只看
  assert.deepEqual([...FORMATS].sort(), ['antigravity', 'chatgpt', 'claude', 'cline', 'codex', 'continue', 'crush', 'cursor', 'dsh', 'dsh4', 'gemini', 'goose', 'grokbuild', 'hermes', 'kilocode', 'kimi', 'mimocode', 'openclaw', 'opencode', 'pi', 'qoder', 'qwen', 'reasonix', 'teleagent', 'workbuddy', 'zcode', 'zed'])
})

// ── git 状态（REQ-58）──────────────────────────────────────────────────────

// 向上找最近的 .git（与 findGitDir 同口径）：探测路径的上级链若存在 git 仓库
//（如本机把 $HOME 纳入版本管理的 dotfiles 快照工具），「无仓库 fixture」无法构造。
function enclosingGitRepo(probe) {
  let dir = resolve(probe)
  for (;;) {
    try {
      const st = statSync(join(dir, '.git'))
      if (st.isDirectory() || st.isFile()) return dir
    } catch {
      // 继续向上找
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

test('git 状态：cwd 为 git 仓库（纯 JS 解析 .git/HEAD）→ 分支正确；非仓库目录 → null 不报错', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-git-'))
  try {
    // 手写 .git 目录结构（无需调用 git 命令——路线 A 已移除 child_process）
    mkdirSync(join(repo, '.git', 'refs', 'heads'), { recursive: true })
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const expectedBranch = 'main'

    const transPath = join(repo, 'sess.jsonl')
    const files = new Map([
      [repo, { type: 'dir' }],
      [transPath, { type: 'file', text: j({ sessionId: 'sess', type: 'user', cwd: repo, message: { role: 'user', content: 'hi' } }), mtimeMs: 1 }],
    ])
    const clean = await discoverSessions({ path: repo, format: 'claude', host: mockHost(files), imports: {}, cache: createScanCache() })
    assert.equal(clean.sessions.length, 1)
    assert.equal(clean.sessions[0].gitBranch, expectedBranch)
    assert.equal(clean.sessions[0].gitDirty, null) // gitDirty 降级为 null（无法纯 JS 可靠判断）

    // detached HEAD（直接写提交 hash）→ 短 hash 近似分支名
    writeFileSync(join(repo, '.git', 'HEAD'), 'abc1234def5678\n')
    const detached = await discoverSessions({ path: repo, format: 'claude', host: mockHost(files), imports: {}, cache: createScanCache() })
    assert.equal(detached.sessions[0].gitBranch, 'abc1234')
    assert.equal(detached.sessions[0].gitDirty, null)

    // 仓库外的不存在目录（mock 树服务即可，无需真实存在）→ 字段 null、不报错。
    // 探针是真实路径、git 探测向上穿透：本机若上级链存在 git 仓库（如 $HOME 被
    // dotfiles 快照工具纳入版本管理），该 fixture 无法构造「无上层仓库」，跳过
    // 该断言并说明（CI / 无上层仓库环境正常断言）。
    const plainCwd = join(dirname(repo), 'dsh-missing-project')
    const files2 = new Map([
      [plainCwd, { type: 'dir' }],
      [join(plainCwd, 'sess2.jsonl'), { type: 'file', text: j({ sessionId: 'sess2', type: 'user', cwd: plainCwd, message: { role: 'user', content: 'hi' } }), mtimeMs: 1 }],
    ])
    const plain = await discoverSessions({ path: plainCwd, format: 'claude', host: mockHost(files2), imports: {}, cache: createScanCache() })
    const enclosing = enclosingGitRepo(plainCwd)
    if (enclosing) {
      t.skip('环境：' + plainCwd + ' 的上级存在 git 仓库（' + enclosing + '），无法构造无仓库 fixture')
    } else {
      assert.equal(plain.sessions[0].gitBranch, null)
      assert.equal(plain.sessions[0].gitDirty, null)
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

// ── issue #16：扫描不进入 node_modules / 限深 / 并发去重 ───────────────────────
// 回归：会话创建触发的迁移提示扫描（path=cwd）递归进入 node_modules 在 pnpm 符号链接
// 结构下永不结束、占满 CPU。修复 = walkFiles / walkGrokbuildSessions / walkKimiSessions
// 跳过 node_modules 等目录 + 限深；discoverSessions 并发同 key 共享进行中 Promise。

test('issue #16：walkFiles 跳过 node_modules / .git / dist 等目录', async () => {
  const root = join(HOME, '.claude', 'projects', 'proj-16')
  const real = join(root, 'sess-real.jsonl')
  // node_modules 下放一个「诱饵」jsonl：walkFiles 不应进入，故不发现
  const bait = join(root, 'node_modules', 'some-pkg', 'sess-bait.jsonl')
  // .git 下放一个诱饵：同样不发现
  const gitBait = join(root, '.git', 'sess-git.jsonl')
  const files = new Map([
    [root, { type: 'dir' }],
    [real, { type: 'file', mtimeMs: 1786000002000, text: [
      j({ sessionId: 'sess-real', type: 'user', cwd: 'D:\\demo', message: { role: 'user', content: '真实会话' } }),
    ].join('\n') }],
    [join(root, 'node_modules'), { type: 'dir' }],
    [join(root, 'node_modules', 'some-pkg'), { type: 'dir' }],
    [bait, { type: 'file', mtimeMs: 1, text: j({ sessionId: 'sess-bait', type: 'user', message: { role: 'user', content: '诱饵' } }) }],
    [join(root, '.git'), { type: 'dir' }],
    [gitBait, { type: 'file', mtimeMs: 1, text: j({ sessionId: 'sess-git', type: 'user', message: { role: 'user', content: 'git 诱饵' } }) }],
  ])
  const host = mockHost(files)
  const { sessions, total } = await discoverSessions({ path: root, format: 'claude', host, imports: {}, cache: createScanCache() })
  assert.equal(total, 1, '只发现真实会话，不进入 node_modules / .git')
  assert.equal(sessions[0].sessionId, 'sess-real')
  // 确认诱饵未被读取（readHead/readText 未被调用）
  assert.equal(host.counters.reads, 1, '只读了真实会话文件头')
})

test('issue #16：walkFiles 限深切断病态深递归（>12 层不进入）', async () => {
  const root = join(HOME, '.claude', 'projects', 'deep-16')
  // 构造 15 层深的诱饵目录链，末尾放 jsonl——合法根最多 5 层，15 层必为病态路径
  let dir = root
  const files = new Map([[dir, { type: 'dir' }]])
  for (let i = 0; i < 15; i++) {
    dir = join(dir, 'd' + i)
    files.set(dir, { type: 'dir' })
  }
  const deepFile = join(dir, 'sess-deep.jsonl')
  files.set(deepFile, { type: 'file', mtimeMs: 1, text: j({ sessionId: 'sess-deep', type: 'user', message: { role: 'user', content: '深诱饵' } }) })
  // 真实会话在首层
  const real = join(root, 'sess-real.jsonl')
  files.set(real, { type: 'file', mtimeMs: 1, text: j({ sessionId: 'sess-real', type: 'user', message: { role: 'user', content: '真实' } }) })

  const { total } = await discoverSessions({ path: root, format: 'claude', host: mockHost(files), imports: {}, cache: createScanCache() })
  assert.equal(total, 1, '限深切断病态深递归，只发现首层真实会话')
})

test('issue #16：并发同 key 扫描共享进行中 Promise（不叠加全量扫描）', async () => {
  const root = join(HOME, '.claude', 'projects', 'conc-16')
  const f = join(root, 'sess.jsonl')
  const files = new Map([
    [root, { type: 'dir' }],
    [f, { type: 'file', mtimeMs: 1786000002000, text: j({ sessionId: 'sess', type: 'user', cwd: 'D:\\demo', message: { role: 'user', content: 'hi' } }) }],
  ])
  // 慢速 readDir：第一次扫描延迟 50ms，验证并发调用不触发第二次 readDir
  let dirCalls = 0
  const host = mockHost(files)
  const origReadDir = host.readDir.bind(host)
  host.readDir = async (path) => {
    dirCalls++
    if (dirCalls === 1) await new Promise((r) => globalThis.setTimeout(r, 50))
    return origReadDir(path)
  }
  const cache = createScanCache()
  // 两个并发 discoverSessions（模拟两个会话同时 agent/session-start）
  const [a, b] = await Promise.all([
    discoverSessions({ path: root, format: 'claude', host, imports: {}, cache }),
    discoverSessions({ path: root, format: 'claude', host, imports: {}, cache }),
  ])
  assert.equal(a.total, 1)
  assert.equal(b.total, 1)
  // readDir 在扫描完成后已被调用一次（root 目录）；并发去重使其不会重复全量扫描
  // —— 验证第二次 discoverSessions 命中 inflight 或 TTL，不再重复 readDir root
  assert.ok(dirCalls <= 1, '并发同 key 扫描共享 Promise，不叠加全量 readDir（实际 ' + dirCalls + ' 次）')
})

// codex 归档目录是扁平的 archived_sessions/，与 sessions/YYYY/MM/DD/ 并列。
// 它此前不在默认根里，归档的 rollout 完全扫不到；grokbuild 早就是双根形态。
test('defaultRoots：codex 同时给出 sessions 与 archived_sessions 两个根', () => {
  const roots = defaultRoots({ home: HOME }).codex
  assert.deepEqual(roots, [
    join(HOME, '.codex', 'sessions'),
    join(HOME, '.codex', 'archived_sessions'),
  ])
})

test('codex：扁平 archived_sessions/ 下的 rollout 可被发现', async () => {
  const root = join(HOME, '.codex', 'archived_sessions')
  const archived = join(root, 'rollout-20260310T120000-019e3b3f-636d-7cb3-aaab-0255eb45ad4f.jsonl')
  const files = new Map([
    [root, { type: 'dir' }],
    [archived, { type: 'file', text: [
      j({ type: 'session_meta', timestamp: '2026-03-10T12:00:00Z', payload: { id: '019e3b3f-636d-7cb3-aaab-0255eb45ad4f', cwd: 'D:/demo/codex-proj' } }),
      j({ type: 'response_item', payload: { type: 'message', role: 'user', content: '归档会话也要能导入' } }),
    ].join('\n') }],
  ])
  const host = mockHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'codex', host, imports: {} })
  assert.equal(total, 1)
  assert.equal(sessions[0].sessionId, '019e3b3f-636d-7cb3-aaab-0255eb45ad4f')
  assert.equal(sessions[0].title, '归档会话也要能导入')
  assert.equal(sessions[0].sourcePath, archived)
})

// 单文件目标（显式给出某个会话日志路径）要走通「路径特征判格式 → 目录形态扫描器消费」：
// 目录形态的扫描器此前对文件目标恒返回空（walkFiles 只遍历目录），自动探测因此形同虚设。
// 这里同时覆盖代次工件名（session.v3.jsonl）与 Windows 分隔符（Linux CI 上也能验证）。
test('dsh：单文件路径自动探测（不给 format）—— 代次工件名 + Windows 分隔符', async () => {
  const winFile = 'D:\\demo\\dsh-home\\sessions\\--D-Build--\\session-abc\\session.v3.jsonl'
  const posixFile = '/demo/dsh-home/sessions/--D-Build--/session-def/session.v3.jsonl'
  const body = (id) => [
    j({ type: 'session', id, cwd: '/demo/proj', createdAt: 1700000000000 }),
    j({ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '单文件路径也要能探测' }] } }),
  ].join('\n')

  for (const [file, id] of [[winFile, 'session-abc'], [posixFile, 'session-def']]) {
    const host = mockHost(new Map([[file, { type: 'file', mtimeMs: 1786000002000, text: body(id) }]]))
    const { sessions, total } = await discoverSessions({ path: file, host, imports: {} })
    assert.equal(total, 1, '单文件目标应产出 1 条（' + file + '）')
    assert.equal(sessions[0].format, 'dsh', file)
    assert.equal(sessions[0].sessionId, id)
    assert.equal(sessions[0].sourcePath, file)
  }
})

// 项目目录名的 ~XXXX 是宿主 projectKey() 的 code-unit 转义（四位大写十六进制）。
// 此前按 decodeURIComponent('%XXXX') 解，得到控制字符加字面量余数。
// dsh 来源按会话日志代次拆两项：v0–v3 归 dsh（V3 会话格式），v4+ 归 dsh4（V4 会话格式）。
// 同一份 sessions 目录、同一个扫描器，靠文件名里的代次给格式（目录扫描由 scanFormat 的
// 请求 format 过滤，见 scanDsh 的 onlyFormat）。
test('dsh / dsh4：按日志代次给格式（v3 → dsh，v4 → dsh4）', async () => {
  const body = (id) => [
    j({ type: 'session', id, cwd: '/demo/proj', createdAt: 1700000000000 }),
    j({ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '代次分流' }] } }),
  ].join('\n')
  const cases = [
    ['D:\\demo\\dsh-home\\sessions\\--D-Build--\\session-a\\session.v3.jsonl', 'session-a', 'dsh'],
    ['D:\\demo\\dsh-home\\sessions\\--D-Build--\\session-b\\session.v4.jsonl', 'session-b', 'dsh4'],
  ]
  for (const [file, id, fmt] of cases) {
    const host = mockHost(new Map([[file, { type: 'file', mtimeMs: 1786000002000, text: body(id) }]]))
    const { sessions, total } = await discoverSessions({ path: file, host, imports: {} })
    assert.equal(total, 1, file)
    assert.equal(sessions[0].sessionId, id)
    assert.equal(sessions[0].format, fmt, file + ' 应按日志代次归到 ' + fmt)
  }
})

test('layoutProject(dsh)：~XXXX 转义按 code unit 还原，不再解成控制字符', () => {
  assert.equal(
    layoutProject('/h/sessions/--Users-u-Documents-Github-DSH~0020Repo--/sid/session.jsonl', 'dsh'),
    '--Users-u-Documents-Github-DSH Repo--',
  )
  assert.equal(
    layoutProject('/h/sessions/--a~002Eb--/sid/session.jsonl.zstd', 'dsh'),
    '--a.b--',
  )
  // 无转义的目录名原样返回
  assert.equal(layoutProject('/h/sessions/--plain-name--/sid/session.jsonl', 'dsh'), '--plain-name--')
  // 非会话文件名不认
  assert.equal(layoutProject('/h/sessions/--x--/sid/other.jsonl', 'dsh'), null)
})

test('discoverSessions：persistedIds 过滤宿主已加载的原生会话（DSH 自身来源例外）', async () => {
  const root = join(HOME, 'dsh-home', 'sessions')
  const proj = join(root, '--proj--')
  const sessNative = join(proj, 'session-native')
  const sessImported = join(proj, 'session-imported')
  const sessExternal = join(proj, 'session-external')
  const fNative = join(sessNative, 'session.v3.jsonl')
  const fImported = join(sessImported, 'session.v3.jsonl')
  const fExternal = join(sessExternal, 'session.v3.jsonl')
  const body = (id) => [
    j({ type: 'session', id, cwd: '/demo/proj', createdAt: 1700000000000 }),
    j({ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '会话内容 ' + id }] } }),
  ].join('\n')

  const files = new Map([
    [root, { type: 'dir' }],
    [proj, { type: 'dir' }],
    [sessNative, { type: 'dir' }],
    [sessImported, { type: 'dir' }],
    [sessExternal, { type: 'dir' }],
    [fNative, { type: 'file', mtimeMs: 1786000001000, text: body('session-native') }],
    [fImported, { type: 'file', mtimeMs: 1786000002000, text: body('session-imported') }],
    [fExternal, { type: 'file', mtimeMs: 1786000003000, text: body('session-external') }],
  ])
  const host = mockHost(files)
  const imports = {
    [fImported]: { kind: 'single', dshId: 'session-imported', importedAt: 1786000002000 },
  }
  const persistedIds = new Set(['session-native', 'session-imported'])

  // 1. DSH 来源例外：宿主自己的会话日志也要列出——「从 DSH V3 导入到 DSH V4」这类代次
  //    迁移的对象正是宿主原生会话，按「已加载」隐藏就等于这个来源永远为空
  const res = await discoverSessions({
    path: root,
    format: 'dsh',
    host,
    imports,
    persistedIds,
  })
  assert.equal(res.total, 3, 'DSH 来源列出全部会话日志（含宿主原生会话）')
  assert.ok(res.sessions.some((s) => s.sessionId === 'session-native'), 'DSH 来源必须能列出宿主原生会话')
  assert.ok(res.sessions.some((s) => s.sessionId === 'session-imported'), '已导入会话保留供同步')
  assert.ok(res.sessions.some((s) => s.sessionId === 'session-external'), '未持久化外部会话保留供导入')

  // 2. 流式扫描：onEntry 同样不接收原生会话
  const streamed = []
  await discoverSessions({
    path: root,
    format: 'dsh',
    host,
    imports,
    persistedIds,
    onEntry: (e) => streamed.push(e),
  })
  assert.equal(streamed.length, 3, '流式条目应含 3 条（DSH 来源不过滤原生会话）')
  assert.ok(streamed.some((s) => s.sessionId === 'session-native'), '流式推送同样要含宿主原生会话（DSH 来源例外）')

  // 3. 缺省 persistedIds：不执行过滤（向后兼容）
  const fallback = await discoverSessions({
    path: root,
    format: 'dsh',
    host,
    imports,
  })
  assert.equal(fallback.total, 3, '不传 persistedIds 时全部 3 条正常产出')
})

test('discoverSessions：注册表指向的会话已删除 → importStatus not-imported（显示导入而非同步）', async () => {
  const root = join(HOME, 'dsh-home-gone', 'sessions')
  const proj = join(root, '--proj--')
  const sessGone = join(proj, 'session-gone')
  const fGone = join(sessGone, 'session.v3.jsonl')
  const body = (id) => [
    j({ type: 'session', id, cwd: '/demo/proj', createdAt: 1700000000000 }),
    j({ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '会话内容 ' + id }] } }),
  ].join('\n')
  const files = new Map([
    [root, { type: 'dir' }],
    [proj, { type: 'dir' }],
    [sessGone, { type: 'dir' }],
    [fGone, { type: 'file', mtimeMs: 1786000001000, text: body('session-gone') }],
  ])
  const host = mockHost(files)
  const imports = { [fGone]: { kind: 'single', dshId: 'import-deleted', importedAt: 1 } }

  // 注册表说导入过，但 import-deleted 已不在宿主（被删除）→ 该源回到未导入（可重新导入）
  const res = await discoverSessions({ path: root, format: 'dsh', host, imports, persistedIds: new Set(['session-other']) })
  const entry = res.sessions.find((s) => s.sourcePath === fGone)
  assert.ok(entry, '条目必须列出')
  assert.equal(entry.importStatus, 'not-imported', '会话已删除 → 显示导入')

  // 会话仍在宿主 → 保持 imported（显示同步）
  const res2 = await discoverSessions({ path: root, format: 'dsh', host, imports, persistedIds: new Set(['import-deleted']) })
  const entry2 = res2.sessions.find((s) => s.sourcePath === fGone)
  assert.equal(entry2.importStatus, 'imported', '会话仍在 → 显示同步')
})
