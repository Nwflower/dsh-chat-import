// discovery-gemini.test.mjs — Antigravity（gemini 族）的发现
// 每会话一目录、.db/.pb 去重、annotation 标题、双默认根。
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
  const host = memoryHost(files)

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
  const host = memoryHost(fileMap)

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
  const host = memoryHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'antigravity', host, imports: {} })
  assert.equal(total, 1)
  assert.equal(sessions[0].title, '回退标题')
  assert.equal(sessions[0].cwd, null)
})
