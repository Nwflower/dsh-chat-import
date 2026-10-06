// discovery-claude.test.mjs — Claude 系（claude / qoder / workbuddy / qwen）的发现
// 标题注入过滤、cwd 项目名、主 transcript 判定、usage token、slug 解码。
// 由 test/discovery.test.mjs 按 lib/discovery/ 的实现族拆出（纯移动：用例与断言未改）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { discoverSessions, clearScanCache, clearInflightScans } from '../lib/discovery.mjs'
import { memoryHost } from './_support/discovery-host.mjs'
import { FAKE_HOME as HOME, j } from './_support/discovery-host.mjs'

beforeEach(() => {
  clearScanCache()
  clearInflightScans()
})

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
  const host = memoryHost(files)
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
  const host = memoryHost(files)
  const { sessions } = await discoverSessions({ path: root, format: 'claude', host, imports: {} })
  assert.equal(sessions.find((s) => s.sessionId === 'sess-small').contextTokens, 2345)
  assert.equal(sessions.find((s) => s.sessionId === 'sess-big').contextTokens, 888888) // >256KB 头不含尾部 assistant
})

test('claude：标题载体 custom-title > ai-title > 首问（尾部记录靠 readTail 取到）', async () => {
  const root = join(HOME, '.claude', 'projects')
  const slug = join(root, 'proj-a')
  const filler = 'x'.repeat(300 * 1024) // 撑过 HEAD_MAX_BYTES：尾部记录头读不到
  const withCustom = join(slug, 'sess-custom.jsonl')
  const aiInTail = join(slug, 'sess-ai.jsonl')
  const pasted = join(slug, 'sess-pasted.jsonl')
  const files = new Map([
    [root, { type: 'dir' }],
    [slug, { type: 'dir' }],
    // 头：首问 + ai-title；尾：custom-title（重命名追加在尾部）
    [withCustom, { type: 'file', text: [
      j({ sessionId: 'sess-custom', type: 'user', message: { role: 'user', content: '首问' } }),
      j({ sessionId: 'sess-custom', type: 'ai-title', aiTitle: 'AI 生成的标题' }),
      j({ sessionId: 'sess-custom', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: filler }] } }),
      j({ sessionId: 'sess-custom', type: 'custom-title', customTitle: '用户重命名' }),
    ].join('\n') }],
    // 无 custom-title、ai-title 也只在尾部（实测 9/62 份转录如此）
    [aiInTail, { type: 'file', text: [
      j({ sessionId: 'sess-ai', type: 'user', message: { role: 'user', content: '首问' } }),
      j({ sessionId: 'sess-ai', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: filler }] } }),
      j({ sessionId: 'sess-ai', type: 'ai-title', aiTitle: '尾部 AI 标题' }),
    ].join('\n') }],
    // 无任何标题记录、首问是粘贴信封 → 剥掉信封取正文（不把标记当标题）
    [pasted, { type: 'file', text: [
      j({ sessionId: 'sess-pasted', type: 'user', message: { role: 'user', content: '<pasted_content id="1b70">\n首页改造需求\n</pasted_content id="1b70">' } }),
      j({ sessionId: 'sess-pasted', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } }),
    ].join('\n') }],
  ])
  const { sessions } = await discoverSessions({ path: root, format: 'claude', host: memoryHost(files), imports: {} })
  assert.equal(sessions.find((s) => s.sessionId === 'sess-custom').title, '用户重命名')
  assert.equal(sessions.find((s) => s.sessionId === 'sess-ai').title, '尾部 AI 标题')
  assert.equal(sessions.find((s) => s.sessionId === 'sess-pasted').title, '首页改造需求')
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
  const host = memoryHost(files)

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
  const host = memoryHost(files)

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
    cwd: 'C:\\Users\\Administrator\\.qwenworkcn\\workspace\\ws-demo-0001',
    humanInput: { text: '出个html介绍一下ai领域的思路', mode: 'prompt' },
    message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>环境注入</system-reminder>' }] },
    ...over,
  })
  const head = [
    j({ type: 'workspace-directories', sessionId: sid, directories: ['C:\\Users\\Administrator\\.qwenworkcn\\workspace\\ws-demo-0001', 'E:\\dev-suite\\demo.Client-app'] }),
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
  const host = memoryHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'qwen', host, imports: {} })
  assert.equal(total, 1) // 双 slug 副本按 sessionId 去重
  const s = sessions[0]
  assert.equal(s.format, 'qwen')
  assert.equal(s.sessionId, sid)
  assert.equal(s.title, '出个html介绍一下ai领域的思路') // humanInput.text 首问
  assert.equal(s.project, 'demo.Client-app') // workspace-directories 非 .qwenworkcn 目录
  assert.equal(s.cwd, 'E:\\dev-suite\\demo.Client-app')
  assert.equal(s.sourcePath, f2) // 留 mtime 最新的副本
  assert.equal(s.lastActiveAt, 1786000002000)

  // 路径自拒：非 ~/.qwenworkcn/projects/ 布局返回空
  const elsewhere = await discoverSessions({ path: join(HOME, 'elsewhere'), format: 'qwen', host, imports: {} })
  assert.equal(elsewhere.total, 0)
})
