// discovery-sqlite.test.mjs — SQLite 索引族（hermes / cline / goose / zed / crush）的发现
// DB 索引优先、db 不可用回退扫目录、host.readSessions 摘要。
// 由 test/discovery.test.mjs 按 lib/discovery/ 的实现族拆出（纯移动：用例与断言未改）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { discoverSessions, clearScanCache, clearInflightScans, defaultRoots } from '../lib/discovery.mjs'
import { gooseSessionsDir } from '../lib/convert/goose.mjs'
import { zedThreadsDir } from '../lib/convert/zed.mjs'
import { hostAbs } from './_support/host-path.mjs'
import { memoryHost } from './_support/discovery-host.mjs'
import { FAKE_HOME as HOME, j } from './_support/discovery-host.mjs'

beforeEach(() => {
  clearScanCache()
  clearInflightScans()
})

test('hermes：state.db 恒批量（复用读取器）+ db 不可用回退 JSONL', async () => {
  const root = join(HOME, '.hermes')
  const dbPath = join(root, 'state.db')
  const files = new Map([[root, { type: 'dir' }], [dbPath, { type: 'file', text: '' }]])
  const host = memoryHost(files)
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
  const host2 = memoryHost(files2)
  host2.dbSessions = () => null
  const r2 = await discoverSessions({ path: jsonlRoot, format: 'hermes', host: host2, imports: {} })
  assert.equal(r2.total, 1)
  assert.equal(r2.sessions[0].sessionId, 's1') // 无 session 记录 → 文件 stem
  assert.equal(r2.sessions[0].title, '什么是 Rust？')
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
  const host = memoryHost(files)
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

  const { sessions, total } = await discoverSessions({ path: sessionsDir, format: 'cline', host: memoryHost(files), imports: {} })
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
  const host = memoryHost(files)
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
  const host = memoryHost(files)
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
  const host = memoryHost(files)
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
  const host = memoryHost(files)
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
