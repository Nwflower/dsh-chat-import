// purge.test.mjs — 导入历史列表 + 批量撤回（删除本插件创建的会话）
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, accessSync, mkdirSync, chmodSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerPanelRoutes } from '../lib/panel.mjs'
import {
  resolveRegistryDir, rememberImport, loadImports,
} from '../lib/imports.mjs'
import {
  listImportHistory, deleteImportedSession, purgeAllImports, collectRegistryTargets,
} from '../lib/purge.mjs'

const T0 = 1710000000000

beforeEach(() => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-home-'))
})

function markerEvent(sourcePath) {
  return { type: 'session/imported', seq: 0, ignorable: true, data: { tool: 'import_chat', sourceId: 'x', sourcePath, importedAt: T0 } }
}

function makePersistence() {
  const sessions = new Map()
  const artifactDirs = new Map()
  const api = {
    sessions,
    artifactDirs,
    async list() { return [...sessions.values()].map((s) => s.meta) },
    async create(meta) {
      if (sessions.has(meta.id)) throw new Error('duplicate')
      sessions.set(meta.id, { meta, events: [] })
      const dir = join(process.env.DSH_HOME, 'sessions', '_proj', meta.id)
      artifactDirs.set(meta.id, dir)
      mkdtempSync(join(tmpdir(), 'art-')) // placeholder; real path tracked in artifactDirs
      writeFileSync(join(process.env.DSH_HOME, 'sessions', '_proj', meta.id + '.marker'), '1')
      mkdtempSync(join(process.env.DSH_HOME, 'sessions', '_proj', meta.id))
    },
    async append(id, events) { sessions.get(id).events.push(...events) },
    async readFrom(id) {
      const s = sessions.get(id)
      if (!s) throw new Error('missing')
      return { meta: s.meta, events: s.events }
    },
    locate(meta) {
      const dir = join(process.env.DSH_HOME, 'sessions', '_proj', meta.id)
      return { kind: 'jsonl', path: dir }
    },
  }
  return api
}

function makeCtx(persistence, { sessions, agents, workspaceRegistry } = {}) {
  const registered = []
  return {
    sessionPersistence: persistence,
    get(service) {
      if (service === 'sessionPersistence') return persistence
      if (service === 'sessions') return sessions
      if (service === 'agents') return agents
      if (service === 'workspaceRegistry') return workspaceRegistry
      return undefined
    },
    tools: { register(def) { registered.push(def) } },
    inject() {},
    effect() {},
    _registered: registered,
  }
}

test('listImportHistory：展平 single/multi registry 条目', async () => {
  const dir = resolveRegistryDir()
  await rememberImport(dir, 'D:\\a\\one.jsonl', {
    kind: 'single', dshId: 'import-s1', turns: 2, events: 10, importedAt: T0,
  })
  await rememberImport(dir, 'D:\\b\\chat.json', {
    kind: 'multi', importedAt: T0 + 1,
    conversations: { c1: { dshId: 'import-c1', turns: 1, events: 5 } },
  })
  const persistence = makePersistence()
  persistence.sessions.set('import-s1', { meta: { id: 'import-s1' }, events: [markerEvent('D:\\a\\one.jsonl')] })
  persistence.sessions.set('import-c1', { meta: { id: 'import-c1' }, events: [markerEvent('D:\\b\\chat.json')] })
  const ctx = makeCtx(persistence)
  const out = await listImportHistory(ctx, dir)
  assert.equal(out.total, 2)
  assert.ok(out.entries.some((e) => e.sessionId === 'import-s1' && e.sourcePath === 'D:\\a\\one.jsonl'))
  assert.ok(out.entries.some((e) => e.sessionId === 'import-c1'))
  assert.equal(out.entries[0].importedAt, T0 + 1)
})

test('deleteImportedSession：删除工件 + 清 registry（仅本插件标记会话）', async () => {
  const dir = resolveRegistryDir()
  const sourcePath = 'D:\\demo\\sess.jsonl'
  const sessionId = 'import-purge-001'
  await rememberImport(dir, sourcePath, {
    kind: 'single', dshId: sessionId, turns: 1, events: 6, importedAt: T0,
  })
  const persistence = makePersistence()
  const artDir = join(process.env.DSH_HOME, 'sessions', '_proj', sessionId)
  mkdirSync(artDir, { recursive: true })
  writeFileSync(join(artDir, 'session.jsonl'), '{"type":"x"}\n')
  persistence.sessions.set(sessionId, {
    meta: { id: sessionId },
    events: [markerEvent(sourcePath)],
  })
  const detached = []
  const workspaceRegistry = {
    list() {
      return [{ path: 'D:\\agent-transcripts\\uuid-1', sessionIds: [sessionId], detachSession: async (id) => { detached.push(id) } }]
    },
  }
  const ctx = makeCtx(persistence, { workspaceRegistry })
  const out = await deleteImportedSession(ctx, dir, sessionId)
  assert.equal(out.sessionId, sessionId)
  assert.equal(out.workspaces, 1)
  assert.deepEqual(detached, [sessionId])
  const reg = await loadImports(dir)
  assert.equal(Object.keys(reg.imports).length, 0)
  let exists = true
  try { accessSync(artDir); } catch { exists = false }
  assert.equal(exists, false, '工件目录应已删除')
})

test('deleteImportedSession：工件被占用（rm 后仍存在）→ 中止且 registry 保留', async () => {
  const dir = resolveRegistryDir()
  const sourcePath = 'D:\\demo\\locked.jsonl'
  const sessionId = 'import-locked-001'
  await rememberImport(dir, sourcePath, {
    kind: 'single', dshId: sessionId, turns: 1, events: 6, importedAt: T0,
  })
  const persistence = makePersistence()
  const artDir = join(process.env.DSH_HOME, 'sessions', '_proj', sessionId)
  mkdirSync(artDir, { recursive: true })
  const artFile = join(artDir, 'session.jsonl')
  writeFileSync(artFile, '{"type":"x"}\n')
  // 跨平台真实锁：Windows 靠子进程占用 cwd（使用中的目录不可删，rimraf 的 chmod
  // 重试也解不开），Linux 靠只读目录（unlink 需要目录写权限）
  chmodSync(artDir, 0o555)
  chmodSync(artFile, 0o444)
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { cwd: artDir, stdio: 'ignore' })
  persistence.sessions.set(sessionId, {
    meta: { id: sessionId },
    events: [markerEvent(sourcePath)],
  })
  const ctx = makeCtx(persistence)
  try {
    await assert.rejects(() => deleteImportedSession(ctx, dir, sessionId), /工件删除失败/)
    const reg = await loadImports(dir)
    assert.ok(reg.imports[sourcePath], 'registry 必须保留，防幽灵会话')
  } finally {
    child.kill()
    await once(child, 'exit')
    chmodSync(artDir, 0o755)
    chmodSync(artFile, 0o644)
  }
})

test('deleteImportedSession：不在 imports registry 的会话拒绝删除（归属以 registry 为权威，issue #34）', async () => {
  const dir = resolveRegistryDir()
  const sessionId = 'native-sess'
  const persistence = makePersistence()
  persistence.sessions.set(sessionId, { meta: { id: sessionId }, events: [{ type: 'turn/start', seq: 0 }] })
  const ctx = makeCtx(persistence)
  await assert.rejects(() => deleteImportedSession(ctx, dir, sessionId), /不在 imports registry/)
})

test('deleteImportedSession：registry 命中即可删除，日志无标记不阻断（0.8.3+ 导出无标记，issue #34）', async () => {
  const dir = resolveRegistryDir()
  const sessionId = 'import-no-marker'
  await rememberImport(dir, 'D:\\x.jsonl', { kind: 'single', dshId: sessionId, turns: 1, events: 1, importedAt: T0 })
  const persistence = makePersistence()
  persistence.sessions.set(sessionId, { meta: { id: sessionId }, events: [{ type: 'turn/start', seq: 0 }] })
  const ctx = makeCtx(persistence)
  const out = await deleteImportedSession(ctx, dir, sessionId)
  assert.equal(out.sessionId, sessionId)
  const reg = await loadImports(dir)
  assert.equal(Object.keys(reg.imports).length, 0)
})

test('purgeAllImports：需 confirm；批量删除 registry 全部会话', async () => {
  const dir = resolveRegistryDir()
  const ids = ['import-a', 'import-b']
  for (const [i, id] of ids.entries()) {
    const sp = 'D:\\s' + i + '.jsonl'
    await rememberImport(dir, sp, { kind: 'single', dshId: id, turns: 1, events: 1, importedAt: T0 + i })
  }
  const persistence = makePersistence()
  for (const [i, id] of ids.entries()) {
    const artDir = join(process.env.DSH_HOME, 'sessions', '_proj', id)
    mkdirSync(artDir, { recursive: true })
    writeFileSync(join(artDir, 'session.jsonl'), 'x\n')
    persistence.sessions.set(id, { meta: { id }, events: [markerEvent('D:\\s' + i + '.jsonl')] })
  }
  const ctx = makeCtx(persistence)
  await assert.rejects(() => purgeAllImports(ctx, dir, {}), /confirm/)
  const out = await purgeAllImports(ctx, dir, { confirm: true })
  assert.equal(out.total, 2)
  assert.equal(out.deleted, 2)
  assert.equal(out.failed, 0)
  const reg = await loadImports(dir)
  assert.equal(Object.keys(reg.imports).length, 0)
})

test('面板路由：/api-import/history + /api-import/purge 注册并可调用', async () => {
  const webRoutes = []
  const ws = { register(r) { webRoutes.push(r) } }
  const persistence = makePersistence()
  const ctx = {
    sessionPersistence: persistence,
    get(s) {
      if (s === 'sessionPersistence') return persistence
      return undefined
    },
  }
  registerPanelRoutes(ctx, ws, resolveRegistryDir())
  const history = webRoutes.find((r) => r.path === '/api-import/history')
  const purge = webRoutes.find((r) => r.path === '/api-import/purge')
  assert.ok(history)
  assert.ok(purge)
  const dir = resolveRegistryDir()
  await rememberImport(dir, 'D:\\z.jsonl', { kind: 'single', dshId: 'import-z', turns: 1, events: 1, importedAt: T0 })
  let body = ''
  const res = { writeHead() {}, end(s) { body = s } }
  await history.handler({ async *[Symbol.asyncIterator]() { yield '{}' } }, res)
  const hist = JSON.parse(body)
  assert.equal(hist.ok, true)
  assert.equal(hist.total, 1)
})

test('collectRegistryTargets：multi 子表展开', () => {
  const targets = collectRegistryTargets({
    a: { kind: 'single', dshId: 's1' },
    b: { kind: 'multi', conversations: { x: { dshId: 's2' } }, sessions: { y: { dshId: 's3' } } },
  })
  assert.deepEqual(targets.map((t) => t.sessionId).sort(), ['s1', 's2', 's3'])
})
