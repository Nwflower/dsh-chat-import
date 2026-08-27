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
  FORMATS, TITLE_MAX_LEN,
  isInjectedTitle, normalizeTitle, layoutProject, resolveImportStatus,
} from '../lib/discovery.mjs'

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
  assert.equal(a.messageCount, null) // 只读文件头不计数
  const b = sessions.find((s) => s.sessionId === 'sess-002')
  assert.equal(b.title, '真实提问') // 注入首行被过滤
  assert.equal(b.project, 'proj-a') // 无 cwd → 布局 slug 回退
  assert.equal(b.importStatus, 'not-imported')
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

test('grokbuild：summary.json 标题/时间、sessions/<project> 项目名', async () => {
  const root = join(HOME, '.grok', 'sessions')
  const proj = join(root, 'proj-x')
  const sess = join(proj, 'grok-sess-001')
  const files = new Map([
    [root, { type: 'dir' }], [proj, { type: 'dir' }], [sess, { type: 'dir' }],
    [join(sess, 'summary.json'), { type: 'file', text: j({
      info: { id: 'grok-sess-001', cwd: 'D:/demo/grok-proj' },
      generated_title: '重构认证模块',
      created_at: '2026-07-16T12:00:00Z',
    }) }],
    [join(sess, 'chat_history.jsonl'), { type: 'file', mtimeMs: 1786000005000, text: [
      j({ type: 'user', content: '登录报错' }),
      j({ type: 'assistant', content: '看日志' }),
    ].join('\n') }],
  ])
  const host = mockHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'grokbuild', host, imports: {} })
  assert.equal(total, 1)
  const a = sessions[0]
  assert.equal(a.sessionId, 'grok-sess-001')
  assert.equal(a.title, '重构认证模块')
  assert.equal(a.project, 'proj-x')
  assert.ok(a.createdAt > 0)
  assert.equal(a.lastActiveAt, 1786000005000) // chat_history mtime 取大
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
  assert.equal(s.messageCount, null)
})

test('hermes：state.db 恒批量（复用读取器）+ db 不可用回退 JSONL', async () => {
  const root = join(HOME, '.hermes')
  const dbPath = join(root, 'state.db')
  const files = new Map([[root, { type: 'dir' }], [dbPath, { type: 'file', text: '' }]])
  const host = mockHost(files)
  host.dbSessions = (kind) => (kind === 'hermes'
    ? [{ id: 'hm-a', title: 'Fix hermes build', directory: 'E:/demo/hermes', createdAt: 1786000000000, lastActiveAt: 1786000000100, messageCount: 3 }]
    : null)

  const { sessions, total } = await discoverSessions({ path: root, format: 'hermes', host, imports: {} })
  assert.equal(total, 1)
  assert.equal(sessions[0].sessionId, 'hm-a')
  assert.equal(sessions[0].title, 'Fix hermes build')
  assert.equal(sessions[0].project, 'hermes') // directory basename
  assert.equal(sessions[0].messageCount, 3)
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
  assert.equal(s.messageCount, null)
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
  assert.equal(s.messageCount, null)

  // 直接把单个新会话目录作为 path 也应识别为会话（不自拒、不误收 agents/main）
  const direct = await discoverSessions({ path: sessDir, format: 'kimi', host, imports: {} })
  assert.equal(direct.total, 1)
  assert.equal(direct.sessions[0].sessionId, 'session-001')
  assert.equal(direct.sessions[0].sourcePath, sessDir)
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
  assert.equal(s.messageCount, null)
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
  assert.equal(s.messageCount, null)

  // 路径自拒：指向其它目录的同一批文件，workbuddy 扫描器返回空
  const other = await discoverSessions({ path: join(HOME, 'elsewhere'), format: 'workbuddy', host, imports: {} })
  assert.equal(other.total, 0)
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
    ? ['ses-a', 'ses-b', 'ses-c'].map((id) => ({ id, title: 'T ' + id, directory: 'E:/demo/op', createdAt: 1, lastActiveAt: 2, messageCount: 1 }))
    : null)
  const imports = {
    [dbPath]: { kind: 'multi', sessions: { 'ses-a': { dshId: 'import-ses-a' }, 'ses-b': { dshId: 'import-ses-b' } } },
  }

  const { sessions } = await discoverSessions({ path: dbPath, format: 'opencode', host, imports })
  assert.equal(sessions.find((s) => s.sessionId === 'ses-a').importStatus, 'imported')
  assert.equal(sessions.find((s) => s.sessionId === 'ses-b').importStatus, 'imported')
  assert.equal(sessions.find((s) => s.sessionId === 'ses-c').importStatus, 'partial')
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
  assert.equal(a.messageCount, 2)
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
  assert.equal(layoutProject('/home/u/.openclaw/agents/main/sessions/s.jsonl', 'openclaw'), 'main')
  assert.equal(layoutProject('/home/u/.gemini/history/slot-a/chats/session-1.json', 'gemini'), 'slot-a')
  assert.equal(layoutProject('/home/u/.cursor/projects/slug-c/agent-transcripts/abc/abc.jsonl', 'cursor'), 'slug-c')
  assert.equal(layoutProject('/home/u/.workbuddy/projects/project-hash-1/wb-sess-0001.jsonl', 'workbuddy'), 'project-hash-1')
})

test('FORMATS 与工具 schema enum 一致（17 种）', () => {
  assert.equal(FORMATS.length, 17)
  assert.deepEqual([...FORMATS].sort(), ['chatgpt', 'claude', 'codex', 'cursor', 'dsh', 'gemini', 'grokbuild', 'hermes', 'kimi', 'mimocode', 'openclaw', 'opencode', 'pi', 'qoder', 'reasonix', 'workbuddy', 'zcode'])
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
