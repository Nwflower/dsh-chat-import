// discovery-documents.test.mjs — 文档族（continue / chatgpt）的发现
// sessions.json 索引驱动；chatgpt 无自动根，只认显式路径。
// 由 test/discovery.test.mjs 按 lib/discovery/ 的实现族拆出（纯移动：用例与断言未改）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { discoverSessions, clearScanCache, clearInflightScans, defaultRoots } from '../lib/discovery.mjs'
import { memoryHost } from './_support/discovery-host.mjs'
import { FAKE_HOME as HOME, j } from './_support/discovery-host.mjs'

beforeEach(() => {
  clearScanCache()
  clearInflightScans()
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
  const host = memoryHost(files)

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
  const fallback = await discoverSessions({ path: bare, format: 'continue', host: memoryHost(files2), imports: {} })
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
  const { sessions, total } = await discoverSessions({ path: root, format: 'continue', host: memoryHost(files), imports: {} })
  assert.equal(total, 1)
  assert.equal(sessions[0].title, null)
})

test('continue 默认根：$CONTINUE_GLOBAL_DIR 优先，否则 ~/.continue/sessions', () => {
  const roots = defaultRoots({ home: HOME })
  assert.equal(roots.continue, process.env.CONTINUE_GLOBAL_DIR
    ? join(process.env.CONTINUE_GLOBAL_DIR, 'sessions')
    : join(HOME, '.continue', 'sessions'))
})

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
  const host = memoryHost(files)

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
