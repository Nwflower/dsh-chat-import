// discovery-core.test.mjs — 发现层核心：缓存 / 过滤 / 状态 / 遍历
// 30s TTL、query 过滤、importStatus 与 resolveImportStatus、书签 WAL 盲区、walkFiles 限深与并发去重、git 状态、FORMATS 一致性。
// 由 test/discovery.test.mjs 按 lib/discovery/ 的实现族拆出（纯移动：用例与断言未改）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverSessions, createScanCache, clearScanCache, clearInflightScans, FORMATS, TITLE_MAX_LEN, defaultRoots, isInjectedTitle, normalizeTitle, layoutProject, resolveImportStatus } from '../lib/discovery.mjs'
import { memoryHost } from './_support/discovery-host.mjs'
import { FAKE_HOME as HOME, j } from './_support/discovery-host.mjs'

beforeEach(() => {
  clearScanCache()
  clearInflightScans()
})

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
  const host = memoryHost(files)
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

test('defaultRoots：GROK_HOME 非空时替代 ~/.grok 双根，空值回退', () => {
  const prev = process.env.GROK_HOME
  try {
    process.env.GROK_HOME = join('mock-root', 'grok-home')
    assert.deepEqual(defaultRoots({ home: HOME }).grokbuild, [
      join('mock-root', 'grok-home', 'sessions'),
      join('mock-root', 'grok-home', 'archived_sessions'),
    ])
    process.env.GROK_HOME = ''
    assert.deepEqual(defaultRoots({ home: HOME }).grokbuild, [
      join(HOME, '.grok', 'sessions'),
      join(HOME, '.grok', 'archived_sessions'),
    ])
  } finally {
    if (prev === undefined) delete process.env.GROK_HOME
    else process.env.GROK_HOME = prev
  }
})

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
  const host = memoryHost(files)

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
  const host = memoryHost(files)

  const byTitle = await discoverSessions({ path: root, format: 'claude', host, imports: {}, query: '登录' })
  assert.equal(byTitle.total, 1)
  assert.equal(byTitle.sessions[0].sessionId, 'sess-a')

  const byProject = await discoverSessions({ path: root, format: 'claude', host, imports: {}, query: 'PROJ-B' })
  assert.equal(byProject.total, 1)
  assert.equal(byProject.sessions[0].sessionId, 'sess-b')

  const byPath = await discoverSessions({ path: root, format: 'claude', host, imports: {}, query: 'sess-a.jsonl' })
  assert.equal(byPath.total, 1)
})

test('importStatus：multi 源子表命中 imported、部分导入 partial', async () => {
  const dbPath = join(HOME, '.local', 'share', 'opencode', 'opencode.db')
  const files = new Map([[dbPath, { type: 'file', text: '' }]])
  const host = memoryHost(files)
  host.dbSessions = (kind) => (kind === 'opencode'
    ? ['ses-a', 'ses-b', 'ses-c'].map((id) => ({ id, title: 'T ' + id, directory: 'E:/demo/op', createdAt: 1, lastActiveAt: 2}))
    : null)
  const imports = {
    [dbPath]: { kind: 'multi', sessions: { 'ses-a': { dshId: 'import-ses-a' }, 'ses-b': { dshId: 'import-ses-b' } } },
  }

  const { sessions } = await discoverSessions({ path: dbPath, format: 'opencode', host, imports })
  assert.equal(sessions.find((s) => s.sessionId === 'ses-a').importStatus, 'imported')
  assert.equal(sessions.find((s) => s.sessionId === 'ses-b').importStatus, 'imported')
  assert.equal(sessions.find((s) => s.sessionId === 'ses-c').importStatus, 'partial')
})

test('书签 WAL 盲区：-wal 出现/增长/删除都失效重扫，未变则命中', async () => {
  const dbPath = join(HOME, '.zcode', 'cli', 'db', 'db.sqlite')
  const files = new Map([[dbPath, { type: 'file', text: 'SQLite format 3', mtimeMs: 1786000000000 }]])
  const host = memoryHost(files)
  let probe = 0
  host.dbSessions = (kind) => {
    if (kind !== 'zcode') return null
    probe++
    return [{ id: 'zcs-a', title: 'T a', directory: 'E:/demo/z', createdAt: 1, lastActiveAt: 2}]
  }
  const cacheDir = mkdtempSync(join(tmpdir(), 'dsh-scanbm-'))
  // cache 传新 Map 绕过进程内 30s TTL（书签层的行为才是本用例对象）
  const run = () => discoverSessions({ path: dbPath, format: 'zcode', host, imports: {}, cache: new Map(), cacheDir })
  try {
    const r1 = await run()
    assert.equal(r1.sessions.length, 1)
    assert.equal(probe, 1)
    // 主文件未变、无 -wal → 书签命中
    await run()
    assert.equal(probe, 1)
    // -wal 出现（工具运行中）：主文件 stat 仍不变 → 必须失效重扫
    files.set(dbPath + '-wal', { type: 'file', text: 'wal-data', mtimeMs: 1786000005000 })
    const r3 = await run()
    assert.equal(r3.sessions.length, 1)
    assert.equal(probe, 2)
    // -wal 未再变 → 命中
    await run()
    assert.equal(probe, 2)
    // -wal 增长（新会话写入 WAL）→ 失效重扫
    files.set(dbPath + '-wal', { type: 'file', text: 'wal-data-grown', mtimeMs: 1786000009000 })
    await run()
    assert.equal(probe, 3)
    // checkpoint 删除 -wal → 指纹又变 → 重扫一次后稳定命中
    files.delete(dbPath + '-wal')
    await run()
    assert.equal(probe, 4)
    await run()
    assert.equal(probe, 4)
  } finally {
    rmSync(cacheDir, { recursive: true, force: true })
  }
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
  const host = memoryHost(files)
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

test('resolveImportStatus：注册表指向的会话已被删除（不在 persisted）→ not-imported（面板显示导入而非同步）', () => {
  // 真机回归：归档后再删除的会话，registry 记录还在、dshId 已不在宿主，此前返回 imported
  // → 面板显示「同步」，但会话没了无从同步，也无法重新导入。persistedIds 里没有该 dshId
  // 即判定「已删除」，优先级高于归档（归档后又被删除同样是 not-imported）。
  const imports = {
    '/a.jsonl': { kind: 'single', dshId: 'import-gone' },
    '/b.jsonl': 'import-legacy-gone',
    '/c.jsonl': { kind: 'multi', sessions: { 'ses-1': { dshId: 'import-s1-gone' }, 'ses-2': { dshId: 'import-s2-kept' } } },
  }
  const persisted = new Set(['import-s2-kept', 'import-alive'])
  assert.equal(resolveImportStatus(imports, '/a.jsonl', 's', undefined, persisted), 'not-imported')
  assert.equal(resolveImportStatus(imports, '/b.jsonl', 's', undefined, persisted), 'not-imported')
  assert.equal(resolveImportStatus(imports, '/c.jsonl', 'ses-1', undefined, persisted), 'not-imported')
  assert.equal(resolveImportStatus(imports, '/c.jsonl', 'ses-2', undefined, persisted), 'imported')
  // 已删除优先于已归档
  const archived = new Set(['import-gone'])
  assert.equal(resolveImportStatus(imports, '/a.jsonl', 's', archived, persisted), 'not-imported')
  // persistedIds 缺省 → 旧行为（不判删除）
  assert.equal(resolveImportStatus(imports, '/a.jsonl', 's'), 'imported')
  assert.equal(resolveImportStatus(imports, '/a.jsonl', 's', archived), 'archived')
})

test('目录探测：claude 根不被其他 JSONL 格式误扫（自拒）', async () => {
  const root = join(HOME, '.claude', 'projects')
  const slug = join(root, 'proj-a')
  const files = new Map([
    [root, { type: 'dir' }], [slug, { type: 'dir' }],
    [join(slug, 'sess-001.jsonl'), { type: 'file', text: [
      j({ sessionId: 'sess-001', type: 'user', cwd: 'D:\\p', message: { role: 'user', content: '问题' } }),
    ].join('\n') }],
  ])
  const host = memoryHost(files)

  // 不指定 format → 全部格式探测同一目录
  const { sessions, total } = await discoverSessions({ path: root, host, imports: {} })
  assert.equal(total, 1)
  assert.equal(sessions[0].format, 'claude')
})

test('isInjectedTitle：注入类前缀识别（含空串）', () => {
  const cases = [
    ['<environment_context>', true],
    ['<system-reminder>', true],
    ['<user_instructions>', true],
    ['# Files mentioned by the user:', true],
    ['The user is asking about x', true],
    ['<local-command-caveat>', true],
    ['真实提问', false],
    ['', true],
  ]
  for (const [input, expected] of cases) {
    assert.equal(isInjectedTitle(input), expected, JSON.stringify(input))
  }
})

test('normalizeTitle：折叠空白 + 80 字符截断（含省略号）', () => {
  assert.equal(normalizeTitle('  多个   空格  '), '多个 空格')
  const t = normalizeTitle('a'.repeat(100))
  assert.equal(t.length, TITLE_MAX_LEN) // 80 字符截断（含省略号）
  assert.ok(t.endsWith('…'))
})

test('layoutProject：各源目录布局 → 项目名', () => {
  const cases = [
    ['/home/u/.claude/projects/slug-a/sess.jsonl', 'claude', 'slug-a'],
    ['/home/u/.codex/sessions/2026/03/10/rollout-x.jsonl', 'codex', '2026/03'],
    ['/home/u/.reasonix/projects/demo/s/desktop-1.jsonl', 'reasonix', 'demo'],
    ['/home/u/.grok/sessions/proj-x/grok-s1', 'grokbuild', 'proj-x'],
    // 编码目录名 = cwd 整路径 encodeURIComponent：解码后取末段
    ['/home/u/.grok/sessions/D%3A%5C%E5%B7%A5%E4%BD%9C%E5%8C%BA%5Cproj/grok-s1', 'grokbuild', 'proj'],
    ['/home/u/.openclaw/agents/main/sessions/s.jsonl', 'openclaw', 'main'],
    ['/home/u/.gemini/history/slot-a/chats/session-1.json', 'gemini', 'slot-a'],
    ['/home/u/.cursor/projects/slug-c/agent-transcripts/abc/abc.jsonl', 'cursor', 'slug-c'],
    ['/home/u/.workbuddy/projects/project-hash-1/wb-sess-0001.jsonl', 'workbuddy', 'project-hash-1'],
    // antigravity：三套根（2.0 / 旧 CLI / IDE）同内层布局 → 恒定位 antigravity 源标签
    ['/home/u/.gemini/antigravity/brain/c1/.system_generated/logs/transcript.jsonl', 'antigravity', 'antigravity'],
    ['/home/u/.gemini/antigravity-cli/brain/c1/.system_generated/logs/transcript.jsonl', 'antigravity', 'antigravity'],
    ['/home/u/.gemini/antigravity-ide/brain/c1/.system_generated/logs/transcript.jsonl', 'antigravity', 'antigravity'],
  ]
  for (const [path, format, expected] of cases) {
    assert.equal(layoutProject(path, format), expected, path)
  }
})

test('FORMATS 与工具 schema enum 一致（29 种）', () => {
  assert.equal(FORMATS.length, 29)
  // dsh / dsh4 是同一份会话目录的两个日志代次桶（V0–V3 / V4+），来源列表因此能分别只看
  assert.deepEqual([...FORMATS].sort(), ['antigravity', 'chatgpt', 'claude', 'cline', 'codex', 'continue', 'crush', 'cursor', 'dsh', 'dsh4', 'gemini', 'goose', 'grokbuild', 'hermes', 'kilocode', 'kimi', 'mimocode', 'openclaw', 'opencode', 'pi', 'qoder', 'qwen', 'reasonix', 'teleagent', 'trae', 'vibe', 'workbuddy', 'zcode', 'zed'])
})

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
    const clean = await discoverSessions({ path: repo, format: 'claude', host: memoryHost(files), imports: {}, cache: createScanCache() })
    assert.equal(clean.sessions.length, 1)
    assert.equal(clean.sessions[0].gitBranch, expectedBranch)
    assert.equal(clean.sessions[0].gitDirty, null) // gitDirty 降级为 null（无法纯 JS 可靠判断）

    // detached HEAD（直接写提交 hash）→ 短 hash 近似分支名
    writeFileSync(join(repo, '.git', 'HEAD'), 'abc1234def5678\n')
    const detached = await discoverSessions({ path: repo, format: 'claude', host: memoryHost(files), imports: {}, cache: createScanCache() })
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
    const plain = await discoverSessions({ path: plainCwd, format: 'claude', host: memoryHost(files2), imports: {}, cache: createScanCache() })
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
  const host = memoryHost(files)
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

  const { total } = await discoverSessions({ path: root, format: 'claude', host: memoryHost(files), imports: {}, cache: createScanCache() })
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
  const host = memoryHost(files)
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

test('defaultRoots：codex 同时给出 sessions 与 archived_sessions 两个根', () => {
  const roots = defaultRoots({ home: HOME }).codex
  assert.deepEqual(roots, [
    join(HOME, '.codex', 'sessions'),
    join(HOME, '.codex', 'archived_sessions'),
  ])
})

test('layoutProject(dsh)：~XXXX 转义按 code unit 还原，不再解成控制字符', () => {
  assert.equal(
    layoutProject('/h/sessions/--Users-u-Documents-Github-DSH~0020Repo--/sid/session.jsonl', 'dsh'),
    '--Users-u-Documents-Github-DSH Repo--',
  )
  assert.equal(
    layoutProject('/h/sessions/--a~002Eb--/sid/session.jsonl.zstd', 'dsh'),
    '--a.b--',
  )
  // 无转义的目录名原样返回
  assert.equal(layoutProject('/h/sessions/--plain-name--/sid/session.jsonl', 'dsh'), '--plain-name--')
  // 非会话文件名不认
  assert.equal(layoutProject('/h/sessions/--x--/sid/other.jsonl', 'dsh'), null)
})

test('discoverSessions：persistedIds 过滤宿主已加载的原生会话（DSH 自身来源例外）', async () => {
  const root = join(HOME, 'dsh-home', 'sessions')
  const proj = join(root, '--proj--')
  const sessNative = join(proj, 'session-native')
  const sessImported = join(proj, 'session-imported')
  const sessExternal = join(proj, 'session-external')
  const fNative = join(sessNative, 'session.v3.jsonl')
  const fImported = join(sessImported, 'session.v3.jsonl')
  const fExternal = join(sessExternal, 'session.v3.jsonl')
  const body = (id) => [
    j({ type: 'session', id, cwd: '/demo/proj', createdAt: 1700000000000 }),
    j({ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '会话内容 ' + id }] } }),
  ].join('\n')

  const files = new Map([
    [root, { type: 'dir' }],
    [proj, { type: 'dir' }],
    [sessNative, { type: 'dir' }],
    [sessImported, { type: 'dir' }],
    [sessExternal, { type: 'dir' }],
    [fNative, { type: 'file', mtimeMs: 1786000001000, text: body('session-native') }],
    [fImported, { type: 'file', mtimeMs: 1786000002000, text: body('session-imported') }],
    [fExternal, { type: 'file', mtimeMs: 1786000003000, text: body('session-external') }],
  ])
  const host = memoryHost(files)
  const imports = {
    [fImported]: { kind: 'single', dshId: 'session-imported', importedAt: 1786000002000 },
  }
  const persistedIds = new Set(['session-native', 'session-imported'])

  // 1. DSH 来源例外：宿主自己的会话日志也要列出——「从 DSH V3 导入到 DSH V4」这类代次
  //    迁移的对象正是宿主原生会话，按「已加载」隐藏就等于这个来源永远为空
  const res = await discoverSessions({
    path: root,
    format: 'dsh',
    host,
    imports,
    persistedIds,
  })
  assert.equal(res.total, 3, 'DSH 来源列出全部会话日志（含宿主原生会话）')
  assert.ok(res.sessions.some((s) => s.sessionId === 'session-native'), 'DSH 来源必须能列出宿主原生会话')
  assert.ok(res.sessions.some((s) => s.sessionId === 'session-imported'), '已导入会话保留供同步')
  assert.ok(res.sessions.some((s) => s.sessionId === 'session-external'), '未持久化外部会话保留供导入')

  // 2. 流式扫描：onEntry 同样不接收原生会话
  const streamed = []
  await discoverSessions({
    path: root,
    format: 'dsh',
    host,
    imports,
    persistedIds,
    onEntry: (e) => streamed.push(e),
  })
  assert.equal(streamed.length, 3, '流式条目应含 3 条（DSH 来源不过滤原生会话）')
  assert.ok(streamed.some((s) => s.sessionId === 'session-native'), '流式推送同样要含宿主原生会话（DSH 来源例外）')

  // 3. 缺省 persistedIds：不执行过滤（向后兼容）
  const fallback = await discoverSessions({
    path: root,
    format: 'dsh',
    host,
    imports,
  })
  assert.equal(fallback.total, 3, '不传 persistedIds 时全部 3 条正常产出')
})

test('discoverSessions：注册表指向的会话已删除 → importStatus not-imported（显示导入而非同步）', async () => {
  const root = join(HOME, 'dsh-home-gone', 'sessions')
  const proj = join(root, '--proj--')
  const sessGone = join(proj, 'session-gone')
  const fGone = join(sessGone, 'session.v3.jsonl')
  const body = (id) => [
    j({ type: 'session', id, cwd: '/demo/proj', createdAt: 1700000000000 }),
    j({ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '会话内容 ' + id }] } }),
  ].join('\n')
  const files = new Map([
    [root, { type: 'dir' }],
    [proj, { type: 'dir' }],
    [sessGone, { type: 'dir' }],
    [fGone, { type: 'file', mtimeMs: 1786000001000, text: body('session-gone') }],
  ])
  const host = memoryHost(files)
  const imports = { [fGone]: { kind: 'single', dshId: 'import-deleted', importedAt: 1 } }

  // 注册表说导入过，但 import-deleted 已不在宿主（被删除）→ 该源回到未导入（可重新导入）
  const res = await discoverSessions({ path: root, format: 'dsh', host, imports, persistedIds: new Set(['session-other']) })
  const entry = res.sessions.find((s) => s.sourcePath === fGone)
  assert.ok(entry, '条目必须列出')
  assert.equal(entry.importStatus, 'not-imported', '会话已删除 → 显示导入')

  // 会话仍在宿主 → 保持 imported（显示同步）
  const res2 = await discoverSessions({ path: root, format: 'dsh', host, imports, persistedIds: new Set(['import-deleted']) })
  const entry2 = res2.sessions.find((s) => s.sourcePath === fGone)
  assert.equal(entry2.importStatus, 'imported', '会话仍在 → 显示同步')
})
