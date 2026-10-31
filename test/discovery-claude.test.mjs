// discovery-claude.test.mjs — Claude 系（claude / qoder / workbuddy / qwen）的发现
// 标题注入过滤、cwd 项目名、主 transcript 判定、usage token、slug 解码。
// 由 test/discovery.test.mjs 按 lib/discovery/ 的实现族拆出（纯移动：用例与断言未改）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { discoverSessions, clearScanCache, clearInflightScans, layoutProject } from '../lib/discovery.mjs'
import { memoryHost, withDirs } from './_support/discovery-host.mjs'
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

test('claude：fork 转录被发现（前缀是父会话记录的拷贝，自己的 id 只在尾部）', async () => {
  // 新版 Claude Code 的 fork 文件 = 父会话记录的逐字拷贝 + 从 fork 点起追加自己的记录。
  // 主转录判定因此必须看两端：只看头部的旧口径把整类 fork 判成辅助 transcript 而扫不到。
  const root = join(HOME, '.claude', 'projects')
  const slug = join(root, 'proj-a')
  const parent = 'parent-001'
  const smallFork = 'fork-small-003'
  const bigFork = 'fork-big-004'
  const parentHead = [
    j({ sessionId: parent, type: 'custom-title', customTitle: '父会话标题' }),
    j({ sessionId: parent, type: 'user', cwd: 'D:\\demo\\claude-proj', message: { role: 'user', content: '父会话提问' } }),
    j({ sessionId: parent, type: 'assistant', message: { role: 'assistant', content: '父会话回答' } }),
  ]
  // 撑过 HEAD_MAX_BYTES：fork 自己的记录头读不到，只能靠尾部（readTail）认出来
  const filler = 'x'.repeat(300 * 1024)
  const files = new Map([
    [root, { type: 'dir' }],
    [slug, { type: 'dir' }],
    [join(slug, parent + '.jsonl'), { type: 'file', mtimeMs: 1786000001000, text: parentHead.join('\n') }],
    // 小 fork：头即全文，尾部记录与头部同在
    [join(slug, smallFork + '.jsonl'), { type: 'file', mtimeMs: 1786000002000, text: [
      ...parentHead,
      j({ sessionId: smallFork, type: 'custom-title', customTitle: '父会话标题 (fork)' }),
      j({ sessionId: smallFork, type: 'user', cwd: 'D:\\demo\\claude-proj', message: { role: 'user', content: 'fork 之后的问题' } }),
    ].join('\n') }],
    // 大 fork：前缀（父会话记录）超过头读上限
    [join(slug, bigFork + '.jsonl'), { type: 'file', mtimeMs: 1786000003000, text: [
      parentHead[0],
      j({ sessionId: parent, type: 'user', cwd: 'D:\\demo\\claude-proj', message: { role: 'user', content: '父会话提问' } }),
      j({ sessionId: parent, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: filler }] } }),
      j({ sessionId: bigFork, type: 'custom-title', customTitle: '父会话标题 (fork)' }),
      j({ sessionId: bigFork, type: 'user', cwd: 'D:\\demo\\claude-proj', message: { role: 'user', content: '大 fork 的问题' } }),
      j({ sessionId: bigFork, type: 'assistant', message: { role: 'assistant', content: '大 fork 的回答', usage: { input_tokens: 4242 } } }),
    ].join('\n') }],
  ])
  const { sessions, total } = await discoverSessions({ path: root, format: 'claude', host: memoryHost(files), imports: {} })
  assert.equal(total, 3) // 父会话 + 两个 fork；fork 文件不得按父会话 id 建条目
  assert.equal(sessions.filter((s) => s.sessionId === parent).length, 1)
  for (const id of [smallFork, bigFork]) {
    const s = sessions.find((x) => x.sessionId === id)
    assert.ok(s, id + ' 未被发现')
    assert.equal(s.title, '父会话标题 (fork)') // 尾部 custom-title（后入者胜）
    assert.equal(s.project, 'claude-proj') // 拷贝段的 cwd
  }
  assert.equal(sessions.find((s) => s.sessionId === bigFork).contextTokens, 4242) // 尾部 usage
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

test('qoder：标题载体只在尾部窗口也能取到（last-prompt 追加在长会话末尾）', async () => {
  const root = join(HOME, '.qoder', 'projects')
  const proj = join(root, '-home-u-long')
  const sid = 'sess-qlong'
  // 头窗（256KB）里没有可用标题：首条 user 只有注入信封、没有 ai-title；唯一的 last-prompt
  // 落在尾部。修前只能给 null（面板显示无标题），修后应与导入侧取到同一个标题。
  const filler = 'x'.repeat(300 * 1024)
  const text = [
    j({ sessionId: sid, type: 'user', cwd: '/home/u/long', timestamp: '2026-01-02T03:04:05.000Z', message: { role: 'user', content: '<system-reminder>注入</system-reminder>' } }),
    j({ sessionId: sid, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: filler }] } }),
    j({ sessionId: sid, type: 'last-prompt', lastPrompt: '尾部的最后提问' }),
  ].join('\n')
  const files = withDirs(root, new Map([[join(proj, sid + '.jsonl'), { type: 'file', mtimeMs: 1786000004000, text }]]))
  const host = memoryHost(files)

  const { sessions } = await discoverSessions({ path: root, format: 'qoder', host, imports: {} })
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].title, '尾部的最后提问')
  assert.ok(host.counters.tails > 0) // 真的读了尾段，而不是靠头段蒙对
})

// Qoder CN（国内发行版，数据根 ~/.qoder-cn）与 intl 版 transcript 逐字同格式：不另立
// format，只多一个根。这里锁住 CN 根的发现，以及两版之外的路径仍然自拒。
test('qoder CN：~/.qoder-cn/projects 同 format 一并发现；非 qoder 布局仍自拒', async () => {
  const root = join(HOME, '.qoder-cn', 'projects')
  const proj = join(root, 'D--DSH-demo')
  const sid = 'sess-qcn'
  const f = join(proj, sid + '.jsonl')
  const files = new Map([
    [root, { type: 'dir' }],
    [proj, { type: 'dir' }],
    [f, { type: 'file', mtimeMs: 1786000003000, text: [
      j({ sessionId: sid, type: 'user', cwd: 'D:\\DSH\\demo', timestamp: '2026-01-02T03:04:05.000Z', message: { role: 'user', content: 'CN 版的提问' } }),
      j({ sessionId: sid, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } }),
      j({ type: 'ai-title', aiTitle: 'CN 标题', sessionId: sid }),
    ].join('\n') }],
  ])
  const host = memoryHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'qoder', host, imports: {} })
  assert.equal(total, 1)
  const s = sessions[0]
  assert.equal(s.format, 'qoder') // 同产品两版发行共用一个来源
  assert.equal(s.sessionId, sid)
  assert.equal(s.title, 'CN 标题')
  assert.equal(s.project, 'demo') // 记录内 cwd basename
  assert.equal(s.cwd, 'D:\\DSH\\demo')
  assert.equal(s.lastActiveAt, 1786000003000)

  // 路径自拒：既不是 ~/.qoder/projects 也不是 ~/.qoder-cn/projects
  const elsewhere = await discoverSessions({ path: join(HOME, 'elsewhere'), format: 'qoder', host, imports: {} })
  assert.equal(elsewhere.total, 0)
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

test('workbuddy：Desktop 5.9.x 的 ~/.workbuddy-ai/projects 同样发现（.workbuddy 只剩 logs）', async () => {
  // 老根与新根共存时的两种情形都要工作：数据根改名不该让已装用户扫不到自己的历史
  const root = join(HOME, '.workbuddy-ai', 'projects')
  const proj = join(root, 'c-Users-u-WorkBuddy AI-2026-10-27-13-46-52')
  const s1 = join(proj, 'wb-sess-9001.jsonl')
  const files = new Map([
    [root, { type: 'dir' }],
    [proj, { type: 'dir' }],
    [s1, {
      type: 'file', mtimeMs: 1786000002000, text: [
        j({ id: 'u', timestamp: 1787131157250, type: 'message', role: 'user', content: [{ type: 'input_text', text: '<user_query>查一下缓存</user_query>' }], sessionId: 'wb-sess-9001', cwd: '/home/u/demo' }),
        j({ id: 'a', timestamp: 1787131157252, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的' }], sessionId: 'wb-sess-9001', cwd: '/home/u/demo' }),
      ].join('\n'),
    }],
  ])
  const host = memoryHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'workbuddy', host, imports: {} })
  assert.equal(total, 1)
  const s = sessions[0]
  assert.equal(s.sessionId, 'wb-sess-9001')
  assert.equal(s.title, '查一下缓存')
  assert.equal(s.cwd, '/home/u/demo')
  // layoutProject 也要认新根（记录内无 cwd 时的回退；入参是 .jsonl 文件路径）
  assert.equal(
    layoutProject(join(root, 'c-Users-u-x-2026-10-27', 'wb-sess-9001.jsonl'), 'workbuddy'),
    'c-Users-u-x-2026-10-27',
  )
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
