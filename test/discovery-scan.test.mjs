// test/discovery-scan.test.mjs — 扫描器公共行为：持久化书签覆盖面、复合指纹
//
// 书签契约（lib/discovery/scan-cache.mjs）：源文件（及伴生文件）mtime/size 未变 → 复用上次
// 条目、不读源内容。这里锁住此前绕开书签、每次都整读文件头的扫描器（pi、Cline 旧版任务）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverSessions, createScanCache, clearScanCache, clearInflightScans } from '../lib/discovery.mjs'
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
    return await fn((opts) => discoverSessions({ cache: createScanCache(), cacheDir, imports: {}, ...opts }))
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
