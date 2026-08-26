// req45.test.mjs — REQ-45 源覆盖面：Reasonix 桌面版 + Claude-3p 新端
//（发现层合成夹具 + reasonix 桌面版导入管线；真实机样本校准见
// dev/research/reasonix-desktop-claude-3p-recon.md 文末不确定点）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSessions, createScanCache, clearScanCache } from '../lib/discovery.mjs'

const j = (o) => JSON.stringify(o)

beforeEach(() => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  clearScanCache()
})

function mockHost(files) {
  const host = {
    async stat(path) {
      const v = files.get(String(path))
      if (!v) return null
      return v.type === 'dir' ? { type: 'directory' } : { type: 'file', size: v.text.length, mtimeMs: v.mtimeMs }
    },
    async readText(path) {
      const v = files.get(String(path))
      return v && v.type === 'file' ? v.text : null
    },
    async readHead(path, maxBytes) {
      const v = files.get(String(path))
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

test('REQ-45 发现：Reasonix 桌面版 projects/<slug>/sessions 布局，.titles.json 权威标题、sidecar 排除', async () => {
  const root = join('C:', 'Users', 'alice', 'AppData', 'Roaming', 'reasonix')
  const proj = join(root, 'projects', 'c--users--alice--work')
  const sessDir = join(proj, 'sessions')
  const files = new Map()
  files.set(root, { type: 'dir' })
  files.set(join(root, 'projects'), { type: 'dir' })
  files.set(proj, { type: 'dir' })
  files.set(sessDir, { type: 'dir' })
  files.set(join(sessDir, 'abc123.jsonl'), { type: 'file', mtimeMs: 1786000000000, text: [
    j({ role: 'user', content: '帮我重构' }),
    j({ role: 'assistant', content: '好的' }),
  ].join('\n') })
  files.set(join(sessDir, 'abc123.events.jsonl'), { type: 'file', mtimeMs: 1786000000000, text: j({ role: 'user', content: 'WAL 不应被发现' }) })
  files.set(join(sessDir, 'abc123.conflicts.jsonl'), { type: 'file', mtimeMs: 1786000000000, text: '{}' })
  files.set(join(sessDir, '.titles.json'), { type: 'file', mtimeMs: 1786000000000, text: j({ 'abc123': '桌面版会话标题' }) })

  const r = await discoverSessions({ path: root, format: 'reasonix', host: mockHost(files), imports: {}, cache: createScanCache() })
  assert.equal(r.total, 1)
  const s = r.sessions[0]
  assert.equal(s.sessionId, 'abc123')
  assert.equal(s.title, '桌面版会话标题') // .titles.json 权威
  assert.equal(s.project, 'c--users--alice--work') // 布局 slug
  assert.equal(s.sourcePath, join(sessDir, 'abc123.jsonl'))
})

test('REQ-45 发现：Claude-3p 元数据 → cliSessionId 反查 jsonl 合并；无 jsonl 降级元数据会话', async () => {
  // 临时 home：~/.claude/projects 放 cliSessionId 对应 jsonl（findJsonlBySessionId 反查）
  const home = mkdtempSync(join(tmpdir(), 'claude3p-home-'))
  process.env.USERPROFILE = home
  process.env.HOME = home
  const projectsRoot = join(home, '.claude', 'projects')
  const slugDir = join(projectsRoot, 'proj-a')
  const jsonlPath = join(slugDir, '282095ab-1111-4222-8333-444455556666.jsonl')
  const root = join('C:', 'Users', 'alice', 'AppData', 'Local', 'Claude-3p', 'claude-code-sessions')
  const files = new Map()
  files.set(root, { type: 'dir' })
  files.set(join(root, 'acct'), { type: 'dir' })
  files.set(join(root, 'acct', 'org'), { type: 'dir' })
  files.set(join(root, 'acct', 'org', 'local_a1b2c3.json'), {
    type: 'file',
    mtimeMs: 1786000000000,
    text: j({
      sessionId: 'local_a1b2c3',
      cliSessionId: '282095ab-1111-4222-8333-444455556666',
      cwd: 'C:\\work\\proj-a',
      originCwd: 'C:\\work\\proj-a',
      createdAt: 1786000000000,
      lastActivityAt: 1786000001000,
      model: 'claude-opus-4-7',
      title: '修复登录',
      titleSource: 'auto',
      isArchived: false,
    }),
  })
  files.set(join(root, 'acct', 'org', 'local_nolink.json'), {
    type: 'file',
    mtimeMs: 1786000000000,
    text: j({ sessionId: 'local_nolink', title: '无 jsonl 的元数据会话', cwd: 'C:\\work\\other', createdAt: 1786000000000, lastActivityAt: 1786000000000 }),
  })
  // 反查命中的 jsonl（文件名 stem + 首行 sessionId 校验）
  files.set(projectsRoot, { type: 'dir' })
  files.set(slugDir, { type: 'dir' })
  files.set(jsonlPath, {
    type: 'file',
    mtimeMs: 1786000000000,
    text: [
      j({ sessionId: '282095ab-1111-4222-8333-444455556666', type: 'user', cwd: 'C:\\work\\proj-a', message: { role: 'user', content: '登录坏了' } }),
      j({ sessionId: '282095ab-1111-4222-8333-444455556666', type: 'assistant', message: { role: 'assistant', content: '修好了' } }),
    ].join('\n'),
  })

  const r = await discoverSessions({ path: root, format: 'claude', host: mockHost(files), imports: {}, cache: createScanCache() })
  assert.equal(r.total, 2)
  const linked = r.sessions.find((s) => s.sessionId === '282095ab-1111-4222-8333-444455556666')
  assert.ok(linked)
  // 标题/cwd 取元数据；sourcePath 指向反查到的 jsonl（import_claude 可直接消费）
  assert.equal(linked.title, '修复登录')
  assert.equal(linked.cwd, 'C:\\work\\proj-a')
  assert.equal(linked.sourcePath, jsonlPath)
  assert.equal(linked.messageCount, null) // jsonl 只读文件头

  const metaOnly = r.sessions.find((s) => s.sessionId === 'local_nolink')
  assert.ok(metaOnly)
  // 无 jsonl → 降级为元数据会话（sourcePath = 元数据 json，messageCount 0）
  assert.equal(metaOnly.sourcePath, join(root, 'acct', 'org', 'local_nolink.json'))
  assert.equal(metaOnly.messageCount, 0)
  assert.equal(metaOnly.title, '无 jsonl 的元数据会话')
})

// ── import 侧：reasonix 桌面版（.titles.json 标题 + slug 贪心解码 cwd）──

test('REQ-45 import_reasonix 桌面版：标题走 .titles.json、cwd 走 slug 贪心解码', async () => {
  // 导入管线 = deriveArgs（titles + slug 解码）→ convertReasonixJsonl → 落盘；
  // 只注册工具（registerTools），不跑完整 apply（避免 prompt-hint/sync-loop 等副作用）
  const norm = (p) => String(p).replace(/\\/g, '/')
  const root = 'C:\\Users\\alice\\AppData\\Roaming\\reasonix'
  const slug = 'c--users--alice--work'
  const sessDir = root + '\\projects\\' + slug + '\\sessions'
  const tree = {
    [root]: 'dir',
    [root + '\\projects']: 'dir',
    [root + '\\projects\\' + slug]: 'dir',
    [sessDir]: 'dir',
    [sessDir + '\\abc123.jsonl']: [
      j({ role: 'user', content: '帮我重构' }),
      j({ role: 'assistant', content: '好的' }),
    ].join('\n'),
    [sessDir + '\\.titles.json']: j({ abc123: '桌面版会话标题' }),
    // slug 解码目标（真实存在性探测）
    'C:\\users\\alice\\work': 'dir',
  }
  const registered = []
  const attached = []
  const persistence = { sessions: new Map(), async list() { return [...this.sessions.values()].map((s) => s.meta) }, async create(meta) { this.sessions.set(meta.id, { meta, events: [] }) }, async append(id, events) { const s = this.sessions.get(id); s.events.push(...events) } }
  const ctx = {
    fs: {
      async resolve(p) { return { targetKey: p, displayPath: p } },
      lookup(p) { const f = norm(p); return tree[p] ?? tree[f] ?? tree[f.replace(/\//g, '\\')] },
      async stat(target) { const v = this.lookup(target.targetKey); return v === undefined ? undefined : { type: v === 'dir' ? 'directory' : 'file', size: v.length, version: 'v' + v.length } },
      async readText(target) { const v = this.lookup(target.targetKey); if (v === undefined || v === 'dir') throw new Error('FS_NOT_FOUND'); return v },
      async listDir(target) { const entries = []; const prefix = target.targetKey.endsWith('\\') ? target.targetKey : target.targetKey + '\\'; for (const [path, v] of Object.entries(tree)) { if (path.startsWith(prefix) && path !== prefix) { const rest = path.slice(prefix.length); if (!rest.includes('\\')) entries.push({ name: rest, type: v === 'dir' ? 'directory' : 'file', target: { targetKey: path, displayPath: path } }) } } return entries.sort((a, b) => a.name.localeCompare(b.name)) },
      processPath(target) { return target.targetKey },
    },
    get(name) {
      if (name === 'workspaceRegistry') return { async resolveByPath() { return null }, async create(p) { const ws = { path: p, attachSession: async (id) => attached.push({ ws: p, id }) }; return ws } }
      return undefined
    },
    sessionPersistence: persistence,
    tools: { register: (d) => registered.push(d) },
  }
  const { registerTools } = await import('../lib/tools.mjs')
  registerTools(ctx, process.env.DSH_HOME + '\\dsh-chat-import')
  const def = registered.find((d) => d.name === 'import_chat')
  const value = await def.execute({ format: 'reasonix', path: sessDir + '\\abc123.jsonl' })
  assert.equal(value.status, 'imported')
  const saved = persistence.sessions.get(value.sessionId)
  assert.equal(saved.meta.cwd, 'C:\\users\\alice\\work') // slug 贪心解码（磁盘存在）
  const titleEv = saved.events.find((e) => e.type === 'session/title')
  assert.equal(titleEv.data.title, '桌面版会话标题') // .titles.json 权威
})
