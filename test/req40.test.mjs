// req40.test.mjs — REQ-40 剩余增强：scan_discover 持久化 mtime/size 书签（跨进程免重扫）
//
// 自包含：mock host（内存合成夹具，可观测读计数）+ 真实临时 cacheDir（书签文件走
// node:fs 落盘）。覆盖：
//   - 首次扫描落书签（scan-cache.json 原子写：无 .tmp 残留、内容合法、含 entries）
//   - 同 mtime+size 二次扫描（新建 TTL 缓存实例 / 重新 import 模块模拟跨进程）命中
//     书签不重读源文件；importStatus 仍按最新 registry 重算
//   - mtime 或 size 变化 → 触发重读并更新书签
//   - 书签文件损坏 / 缺失 → 按空书签全量重扫，扫描后重写为合法书签
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSessions, createScanCache, SCAN_CACHE_FILE } from '../lib/discovery.mjs'
import { clearWorkspacePathCache } from '../lib/cwd-map.mjs'

const j = (o) => JSON.stringify(o)

// mock host：path → { type:'file', text, mtimeMs } | { type:'dir' }；可观测读计数
//（与 discovery.test.mjs 同款；书签测试只关心 readHead/readText 是否被调用）。
function mockHost(files) {
  const counters = { reads: 0 }
  const host = {
    counters,
    async stat(path) {
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
      const s = String(path).includes('\\') ? '\\' : '/'
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
    async readSessions() { return null },
  }
  return host
}

// claude 合成夹具：两个会话（s1 带 cwd → 项目名） + agent-* 辅助 transcript（不发现）。
function claudeFixture(root) {
  const files = new Map()
  files.set(root, { type: 'dir' })
  const slug = join(root, 'demo-proj')
  files.set(slug, { type: 'dir' })
  const s1 = join(slug, 'sess-001.jsonl')
  const s2 = join(slug, 'sess-002.jsonl')
  files.set(s1, { type: 'file', mtimeMs: 1786000002000, text: [
    j({ sessionId: 'sess-001', type: 'user', cwd: 'D:\\demo\\claude-proj', message: { role: 'user', content: '修复构建失败' } }),
    j({ sessionId: 'sess-001', type: 'assistant', message: { role: 'assistant', content: '已修复' } }),
  ].join('\n') })
  files.set(s2, { type: 'file', mtimeMs: 1786000003000, text: [
    j({ sessionId: 'sess-002', type: 'user', message: { role: 'user', content: '另一个问题' } }),
  ].join('\n') })
  files.set(join(slug, 'agent-x.jsonl'), { type: 'file', mtimeMs: 1786000004000, text: j({ sessionId: 'sess-001', type: 'user', message: { role: 'user', content: '辅助' } }) })
  return { files, s1, s2 }
}

// 每次都传全新 TTL 缓存实例，避免模块级 30s 缓存串扰（书签命中与否只看持久化层）。
const scan = (opts) => discoverSessions({ cache: createScanCache(), ...opts })

test('首次扫描落书签（原子写）；同 mtime+size 二次扫描命中书签不重读', async (t) => {
  const root = join('C:', 'Users', 'tester', '.claude', 'projects')
  const { files, s1 } = claudeFixture(root)
  const cacheDir = mkdtempSync(join(tmpdir(), 'req40-hit-'))
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }))
  const bmPath = join(cacheDir, SCAN_CACHE_FILE)

  // 首次扫描：全量读，书签落盘
  const host1 = mockHost(files)
  const r1 = await scan({ path: root, format: 'claude', host: host1, imports: {}, cacheDir })
  assert.equal(r1.total, 2)
  const reads1 = host1.counters.reads
  assert.ok(reads1 > 0)

  // 书签文件：原子写（目录里只有 scan-cache.json，无 .tmp 残留）、按 format 分表、两个源
  assert.deepEqual(readdirSync(cacheDir).sort(), [SCAN_CACHE_FILE])
  const disk = JSON.parse(readFileSync(bmPath, 'utf8'))
  assert.equal(disk.version, 1)
  const claudeTable = disk.bookmarks.claude
  assert.equal(Object.keys(claudeTable).length, 2) // agent-* 辅助 transcript 不建书签
  const bm1 = claudeTable[s1]
  assert.equal(bm1.mtimeMs, 1786000002000)
  assert.equal(bm1.sizeBytes, files.get(s1).text.length)
  assert.equal(bm1.entries.length, 1)
  assert.equal(bm1.entries[0].sessionId, 'sess-001')
  assert.equal(bm1.entries[0].title, '修复构建失败')
  assert.equal(bm1.entries[0].lastActiveAt, 1786000002000)
  assert.equal(bm1.entries[0].sourcePath, s1)

  // 二次扫描：新 host + 新 TTL 缓存实例（模拟 TTL 过期 / 新进程态），书签命中 → 零内容读
  const host2 = mockHost(files)
  const r2 = await scan({
    path: root, format: 'claude', host: host2, cacheDir,
    imports: { [s1]: { kind: 'single', dshId: 'import-sess-001', turns: 1, events: 3 } },
  })
  assert.equal(r2.total, 2)
  assert.equal(host2.counters.reads, 0)
  // 复用书签元数据的同时，importStatus 仍按最新 registry 重算
  const a = r2.sessions.find((s) => s.sessionId === 'sess-001')
  assert.equal(a.title, '修复构建失败')
  assert.equal(a.project, 'claude-proj')
  assert.equal(a.importStatus, 'imported')
  assert.equal(r2.sessions.find((s) => s.sessionId === 'sess-002').importStatus, 'not-imported')
})

test('size 变化触发重读并更新书签', async (t) => {
  const root = join('C:', 'Users', 'tester', '.claude', 'projects')
  const { files, s1 } = claudeFixture(root)
  const cacheDir = mkdtempSync(join(tmpdir(), 'req40-size-'))
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }))
  const bmPath = join(cacheDir, SCAN_CACHE_FILE)

  await scan({ path: root, format: 'claude', host: mockHost(files), imports: {}, cacheDir })

  // 追加一个 user 回合 → size 变化（mtime 不变）
  const old = files.get(s1)
  const newText = old.text + '\n' + j({ sessionId: 'sess-001', type: 'user', message: { role: 'user', content: '追加的问题' } })
  files.set(s1, { type: 'file', mtimeMs: old.mtimeMs, text: newText })

  const host = mockHost(files)
  const r = await scan({ path: root, format: 'claude', host, imports: {}, cacheDir })
  assert.equal(r.total, 2)
  assert.equal(host.counters.reads, 1) // 只重读被改的 s1；s2 书签命中
  const disk = JSON.parse(readFileSync(bmPath, 'utf8'))
  assert.equal(disk.bookmarks.claude[s1].sizeBytes, newText.length) // 书签已更新
  assert.equal(disk.bookmarks.claude[s1].mtimeMs, old.mtimeMs)
})

test('mtime 变化（同 size）触发重读', async (t) => {
  const root = join('C:', 'Users', 'tester', '.claude', 'projects')
  const { files, s1 } = claudeFixture(root)
  const cacheDir = mkdtempSync(join(tmpdir(), 'req40-mtime-'))
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }))

  await scan({ path: root, format: 'claude', host: mockHost(files), imports: {}, cacheDir })

  // 仅 mtime 变化（内容与 size 都不变）
  const old = files.get(s1)
  files.set(s1, { type: 'file', mtimeMs: old.mtimeMs + 10000, text: old.text })

  const host = mockHost(files)
  const r = await scan({ path: root, format: 'claude', host, imports: {}, cacheDir })
  assert.equal(r.total, 2)
  assert.equal(host.counters.reads, 1) // mtime 命中失败 → 重读该文件
})

test('书签文件损坏按空书签处理，扫描后重写为合法', async (t) => {
  const root = join('C:', 'Users', 'tester', '.claude', 'projects')
  const { files, s1 } = claudeFixture(root)
  const cacheDir = mkdtempSync(join(tmpdir(), 'req40-corrupt-'))
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }))
  const bmPath = join(cacheDir, SCAN_CACHE_FILE)

  await scan({ path: root, format: 'claude', host: mockHost(files), imports: {}, cacheDir })

  writeFileSync(bmPath, '{ 这不是合法 JSON')

  const host = mockHost(files)
  const r = await scan({ path: root, format: 'claude', host, imports: {}, cacheDir })
  assert.equal(r.total, 2)
  assert.ok(host.counters.reads > 0) // 损坏 → 按空书签全量重扫
  const disk = JSON.parse(readFileSync(bmPath, 'utf8')) // 扫描后已重写为合法书签
  assert.equal(disk.version, 1)
  assert.ok(disk.bookmarks.claude[s1])
})

test('书签文件缺失按空书签处理，扫描后重建', async (t) => {
  const root = join('C:', 'Users', 'tester', '.claude', 'projects')
  const { files, s1 } = claudeFixture(root)
  const cacheDir = mkdtempSync(join(tmpdir(), 'req40-missing-'))
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }))
  const bmPath = join(cacheDir, SCAN_CACHE_FILE)

  await scan({ path: root, format: 'claude', host: mockHost(files), imports: {}, cacheDir })
  rmSync(bmPath)

  const host = mockHost(files)
  const r = await scan({ path: root, format: 'claude', host, imports: {}, cacheDir })
  assert.equal(r.total, 2)
  assert.ok(host.counters.reads > 0) // 缺失 → 全量重扫
  assert.ok(JSON.parse(readFileSync(bmPath, 'utf8')).bookmarks.claude[s1]) // 书签已重建
})

test('cursor 书签命中：旧 slug-only entries 读时补丁解码 cwd/project，不重读 jsonl', async (t) => {
  clearWorkspacePathCache()
  const slug = 'e-RPA-260721-New-Funion-Client-develop'
  const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const cwdDots = 'E:\\RPA-260721-New\\Funion.Client-develop'
  const root = join('C:', 'Users', 'tester', '.cursor', 'projects')
  const dirA = join(root, slug, 'agent-transcripts', uuid)
  const file = join(dirA, uuid + '.jsonl')
  const staleTitle = '<timestamp>Friday, Aug 7, 2026, 3:44 PM (UTC+8)</timestamp>\n<user_query>点号提问</user_query>'
  const fileBody = 'SHOULD-NOT-BE-READ-ON-CACHE-HIT'
  const files = new Map([
    [root, { type: 'dir' }],
    [join(root, slug), { type: 'dir' }],
    [join(root, slug, 'agent-transcripts'), { type: 'dir' }],
    [dirA, { type: 'dir' }],
    [file, { type: 'file', mtimeMs: 1786000002000, text: fileBody }],
    ['E:\\RPA-260721-New', { type: 'dir' }],
    [cwdDots, { type: 'dir' }],
  ])
  const cacheDir = mkdtempSync(join(tmpdir(), 'req40-cursor-patch-'))
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }))
  const bmPath = join(cacheDir, SCAN_CACHE_FILE)
  writeFileSync(bmPath, JSON.stringify({
    version: 1,
    bookmarks: {
      cursor: {
        [file]: {
          mtimeMs: 1786000002000,
          sizeBytes: fileBody.length,
          entries: [{
            format: 'cursor',
            sessionId: uuid,
            title: staleTitle,
            project: slug,
            createdAt: null,
            lastActiveAt: null,
            messageCount: null,
            sourcePath: file,
            cwd: null,
          }],
        },
      },
    },
  }) + '\n', 'utf8')

  const host = mockHost(files)
  host.resolveCursorSlug = async (s) => (s === slug ? cwdDots : null)

  const r = await scan({ path: root, format: 'cursor', host, imports: {}, cacheDir })
  assert.equal(r.total, 1)
  assert.equal(host.counters.reads, 0, '书签命中不应重读 jsonl')
  assert.equal(r.sessions[0].cwd, cwdDots)
  assert.equal(r.sessions[0].project, 'Funion.Client-develop')
  assert.equal(r.sessions[0].title, '点号提问')
  assert.ok(typeof r.sessions[0].createdAt === 'number' && r.sessions[0].createdAt > 0)
  assert.equal(r.sessions[0].lastActiveAt, 1786000002000)

  const disk = JSON.parse(readFileSync(bmPath, 'utf8'))
  const saved = disk.bookmarks.cursor[file].entries[0]
  assert.equal(saved.cwd, cwdDots)
  assert.equal(saved.project, 'Funion.Client-develop')
  assert.equal(saved.title, '点号提问')
  assert.ok(typeof saved.createdAt === 'number' && saved.createdAt > 0)
})

test('cursor 书签命中：纯数字 slug 读时补丁清空 project，不误建异类工作区', async (t) => {
  const slug = '1784784551097'
  const uuid = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
  const root = join('C:', 'Users', 'tester', '.cursor', 'projects')
  const dirNum = join(root, slug, 'agent-transcripts', uuid)
  const file = join(dirNum, uuid + '.jsonl')
  const fileBody = 'stale-cache-body'
  const files = new Map([
    [root, { type: 'dir' }],
    [join(root, slug), { type: 'dir' }],
    [join(root, slug, 'agent-transcripts'), { type: 'dir' }],
    [dirNum, { type: 'dir' }],
    [file, { type: 'file', mtimeMs: 1786000004000, text: fileBody }],
  ])
  const cacheDir = mkdtempSync(join(tmpdir(), 'req40-cursor-numeric-'))
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }))
  writeFileSync(join(cacheDir, SCAN_CACHE_FILE), JSON.stringify({
    version: 1,
    bookmarks: {
      cursor: {
        [file]: {
          mtimeMs: 1786000004000,
          sizeBytes: fileBody.length,
          entries: [{
            format: 'cursor',
            sessionId: uuid,
            title: '纯数字 slug',
            project: slug,
            createdAt: null,
            lastActiveAt: null,
            messageCount: null,
            sourcePath: file,
            cwd: null,
          }],
        },
      },
    },
  }) + '\n', 'utf8')

  const host = mockHost(files)
  host.resolveCursorSlug = async () => null

  const r = await scan({ path: root, format: 'cursor', host, imports: {}, cacheDir })
  assert.equal(r.total, 1)
  assert.equal(host.counters.reads, 0)
  assert.equal(r.sessions[0].cwd, null)
  assert.equal(r.sessions[0].project, null)
})

test('跨进程模拟：重新 import 模块实例 + 复用书签文件 → 未变文件不重读', async (t) => {
  const root = join('C:', 'Users', 'tester', '.claude', 'projects')
  const { files } = claudeFixture(root)
  const cacheDir = mkdtempSync(join(tmpdir(), 'req40-cross-'))
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }))

  // 实例 A（进程 1）：全新模块态，首次扫描落书签
  const modA = await import('../lib/discovery.mjs?req40-cross-a=1')
  const hostA = mockHost(files)
  const rA = await modA.discoverSessions({ path: root, format: 'claude', host: hostA, imports: {}, cacheDir, cache: modA.createScanCache() })
  assert.equal(rA.total, 2)
  assert.ok(hostA.counters.reads > 0)

  // 实例 B（进程 2）：模块级缓存为空，仅复用磁盘书签 → 未变文件不重读
  const modB = await import('../lib/discovery.mjs?req40-cross-b=2')
  const hostB = mockHost(files)
  const rB = await modB.discoverSessions({ path: root, format: 'claude', host: hostB, imports: {}, cacheDir, cache: modB.createScanCache() })
  assert.equal(rB.total, 2)
  assert.equal(hostB.counters.reads, 0)
})
