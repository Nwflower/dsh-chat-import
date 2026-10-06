// discovery-session-dirs.test.mjs — 「每会话一目录」族（kimi / grokbuild）的发现
// wire.jsonl / summary.json 判据、kimi.json 与 workspaces.json 的 cwd 映射。
// 由 test/discovery.test.mjs 按 lib/discovery/ 的实现族拆出（纯移动：用例与断言未改）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { discoverSessions, clearScanCache, clearInflightScans } from '../lib/discovery.mjs'
import { memoryHost } from './_support/discovery-host.mjs'
import { FAKE_HOME as HOME, j } from './_support/discovery-host.mjs'

beforeEach(() => {
  clearScanCache()
  clearInflightScans()
})

test('grokbuild：summary.json 标题/时间、百分号编码目录名解码为项目名、cwd 透传', async () => {
  // 真实布局：sessions/<encodeURIComponent(cwd) 整路径>/<session_id>/（Windows 盘符 +
  // 中文都会进入目录名），面板工作区列必须显示解码后的项目名而非 %XX 乱码。
  const root = join(HOME, '.grok', 'sessions')
  const projEnc = 'D%3A%5C%E5%B7%A5%E4%BD%9C%E5%8C%BA%5C%E7%A4%BA%E4%BE%8B%E9%A1%B9%E7%9B%AE%5Cdemo-app'
  const proj = join(root, projEnc)
  const sessA = join(proj, 'grok-sess-001')
  const sessB = join(proj, 'grok-sess-002')
  const files = new Map([
    [root, { type: 'dir' }], [proj, { type: 'dir' }], [sessA, { type: 'dir' }], [sessB, { type: 'dir' }],
    [join(sessA, 'summary.json'), { type: 'file', text: j({
      info: { id: 'grok-sess-001', cwd: 'D:\\工作区\\示例项目\\demo-app' },
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
  const host = memoryHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'grokbuild', host, imports: {} })
  assert.equal(total, 2)
  const a = sessions.find((s) => s.sessionId === 'grok-sess-001')
  assert.equal(a.title, '重构认证模块')
  assert.equal(a.project, 'demo-app') // 解码后的项目名（不再是 %XX 乱码）
  assert.equal(a.cwd, 'D:\\工作区\\示例项目\\demo-app') // 记录内完整工作目录
  assert.ok(a.createdAt > 0)
  assert.equal(a.lastActiveAt, 1786000005000) // chat_history mtime 取大
  const b = sessions.find((s) => s.sessionId === 'grok-sess-002')
  assert.equal(b.project, 'demo-app') // 无 cwd → 目录布局解码回退
  assert.equal(b.cwd, null)
})

test('grokbuild：标题兜底跳过 synthetic_reason / 注入行，剥 <user_query> 信封（中断信封同样处理）', async () => {
  const root = join(HOME, '.grok', 'sessions')
  const proj = join(root, 'proj-title')
  const sess = join(proj, 'grok-sess-title')
  const files = new Map([
    [root, { type: 'dir' }], [proj, { type: 'dir' }], [sess, { type: 'dir' }],
    [join(sess, 'summary.json'), { type: 'file', text: j({
      info: { id: 'grok-sess-title', cwd: 'D:/demo/grok-title' },
      created_at: '2026-07-16T12:00:00Z',
    }) }],
    [join(sess, 'chat_history.jsonl'), { type: 'file', text: [
      j({ type: 'user', content: [{ type: 'text', text: '<system-reminder>\nskills' }], synthetic_reason: 'system_reminder' }),
      j({ type: 'user', content: [{ type: 'text', text: 'This session is being continued from a previous conversation that ran out of context.' }], synthetic_reason: 'compaction_meta' }),
      j({ type: 'user', content: [{ type: 'text', text: '<user_info>\nOS Version: windows' }] }),
      j({ type: 'user', content: [{ type: 'text', text: 'The user interrupted the previous turn:\n<user_query>\n真实提问\n</user_query>\nMake sure to complete any unfinished tasks from previous turns.' }], prior_turn_interrupt: 'mid_turn_abort' }),
      j({ type: 'assistant', content: '好' }),
    ].join('\n') }],
  ])
  const { sessions, total } = await discoverSessions({ path: root, format: 'grokbuild', host: memoryHost(files), imports: {} })
  assert.equal(total, 1)
  assert.equal(sessions[0].title, '真实提问')
})

test('grokbuild：v0 行（role 无 type）标题兜底 + 剥 <user_query> 信封', async () => {
  const root = join(HOME, '.grok', 'sessions')
  const proj = join(root, 'proj-v0')
  const sess = join(proj, 'grok-sess-v0')
  const files = new Map([
    [root, { type: 'dir' }], [proj, { type: 'dir' }], [sess, { type: 'dir' }],
    [join(sess, 'summary.json'), { type: 'file', text: j({ info: { id: 'grok-sess-v0' }, created_at: '2026-07-16T12:00:00Z' }) }],
    [join(sess, 'chat_history.jsonl'), { type: 'file', text: [
      j({ role: 'user', content: [{ type: 'text', text: '<user_query>\nv0 提问\n</user_query>' }] }),
      j({ role: 'assistant', content: 'v0 回答' }),
    ].join('\n') }],
  ])
  const { sessions, total } = await discoverSessions({ path: root, format: 'grokbuild', host: memoryHost(files), imports: {} })
  assert.equal(total, 1)
  assert.equal(sessions[0].title, 'v0 提问')
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
  const host = memoryHost(files)

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
  const host = memoryHost(files)
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
  const host = memoryHost(files)

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

test('kimi：state.json 仅含 workDir 时发现层同样取到 cwd（#61）', async () => {
  const root = join(HOME, '.kimi-code', 'sessions')
  const workspace = join(root, 'wd_genius-invokation_0123456789ab')
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
    [join(sessDir, 'state.json'), { type: 'file', text: j({ id: 'session-eb6808b9', workDir: 'D:/demo/ws/genius-invokation' }) }],
  ])
  const host = memoryHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'kimi', host, imports: {} })
  assert.equal(total, 1)
  assert.equal(sessions[0].cwd, 'D:/demo/ws/genius-invokation')
  assert.equal(sessions[0].project, 'genius-invokation')
})

test('kimi：state.json 缺失时按 workspaces.json 的 workspace-id 回退 cwd（REQ-77）', async () => {
  const root = join(HOME, '.kimi-code', 'sessions')
  const workspaceId = 'wd_genius-invokation_0123456789ab'
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
      workspaces: { [workspaceId]: { root: 'D:/demo/ws/genius-invokation', name: 'genius-invokation' } },
    }) }],
    [agentWire, { type: 'file', mtimeMs: 1786000002000, text: [
      j({ type: 'metadata', protocol_version: '1', created_at: 1786000000500 }),
      j({ type: 'turn.prompt', input: [{ type: 'text', text: '帮我看看构建失败' }], time: 1786000000501 }),
    ].join('\n') }],
  ])
  const host = memoryHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'kimi', host, imports: {} })
  assert.equal(total, 1)
  assert.equal(sessions[0].cwd, 'D:/demo/ws/genius-invokation')
  assert.equal(sessions[0].project, 'genius-invokation')
})
