// file-import.test.mjs — 面板「从文件导入」的编排与路由行为测试。
//
// 覆盖：/api-import/file（预览 / 导入 / bundle 分流 / format 覆盖 / target 校验）、
// /api-import/browse（info / list / pick 能力分派）、/api-import/upload/* 与
// /api-import/uploads（上传件直达导入、暂存维护）。走真实 registerPanelRoutes +
// 真实导入状态机，只有宿主服务是 mock（fs 树 / sessionPersistence / workspaceRegistry）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { registerPanelRoutes } from '../lib/panel.mjs'
import { hostAbs } from './_support/host-path.mjs'

// 分隔符归一（跨平台：代码/夹具的 join() 在 posix 与 win 产不同分隔符）
const norm = (p) => String(p).replace(/\\/g, '/')

function makePersistence() {
  const sessions = new Map()
  return {
    sessions,
    async list() { return [...sessions.values()].map((s) => s.meta) },
    async create(meta) {
      if (sessions.has(meta.id)) throw new Error('duplicate session ' + meta.id)
      sessions.set(meta.id, { meta, events: [] })
    },
    async append(id, events) {
      const s = sessions.get(id)
      if (!s) throw new Error('unknown session ' + id)
      for (let i = 0; i < events.length; i++) {
        if (events[i].seq !== s.events.length + i) throw new Error('append seq 不连续: ' + String(events[i] && events[i].seq))
      }
      s.events.push(...events)
    },
    async inspect(id) {
      const s = sessions.get(id)
      if (!s) throw new Error('unknown session ' + id)
      return { meta: s.meta, events: s.events }
    },
    async readFrom(id, fromSeq = 0) {
      const s = sessions.get(id)
      if (!s) throw new Error('unknown session ' + id)
      return { meta: s.meta, events: s.events.slice(fromSeq) }
    },
    async remove(id) { sessions.delete(id) },
  }
}

function makeHarness(tree, opts = {}) {
  const persistence = makePersistence()
  const attached = []
  const workspaces = new Map()
  const webRoutes = []
  const writes = []
  const registryDir = mkdtempSync(join(tmpdir(), 'dsh-fi-reg-'))
  const entriesCache = new Map()
  const normKey = (p) => norm(p).toLowerCase()

  const fs = {
    async resolve(path) { return { targetKey: path, displayPath: path } },
    lookup(p) {
      const f = normKey(p)
      for (const [k, v] of Object.entries(tree)) if (normKey(k) === f) return v
      return undefined
    },
    async stat(target) {
      const v = this.lookup(target.targetKey)
      if (v !== undefined) return v === 'dir' ? { type: 'directory' } : { type: 'file', size: v.length, version: 'v-' + v.length }
      // 树外（上传暂存的真实文件）：回退 node:fs
      try {
        const st = (await import('node:fs')).statSync(target.targetKey)
        if (st.isDirectory()) return { type: 'directory' }
        return { type: 'file', size: st.size, version: 'real-' + st.size + '-' + st.mtimeMs }
      } catch { return undefined }
    },
    async readText(target) {
      const v = this.lookup(target.targetKey)
      if (v !== undefined && v !== 'dir') return v
      try { return (await import('node:fs')).readFileSync(target.targetKey, 'utf8') } catch { throw new Error('FS_NOT_FOUND ' + target.targetKey) }
    },
    async writeText(target, content, options) {
      if (options && options.kind === 'createIfAbsent' && tree[target.targetKey] !== undefined) {
        throw Object.assign(new Error('EEXIST ' + target.targetKey), { code: 'EEXIST' })
      }
      tree[target.targetKey] = content
      writes.push({ path: target.targetKey, content, options })
      return { path: target.targetKey }
    },
    async listDir(target) {
      const key = target.targetKey
      if (!entriesCache.has(key)) {
        const dir = normKey(key).replace(/\/+$/, '')
        const entries = []
        for (const [path, v] of Object.entries(tree)) {
          const p = normKey(path)
          if (!p.startsWith(dir + '/')) continue
          const rest = p.slice(dir.length + 1)
          if (rest.includes('/')) continue
          const real = path.slice(path.length - rest.length)
          entries.push({ name: real, type: v === 'dir' ? 'directory' : 'file', target: { targetKey: path, displayPath: path }, version: 1 })
        }
        // 树外真实目录（上传暂存）：合并 node:fs 的子项
        try {
          const fsm = (await import('node:fs'))
          for (const name of fsm.readdirSync(key)) {
            if (entries.some((e) => e.name === name)) continue
            const child = join(key, name)
            const st = fsm.statSync(child)
            entries.push({ name, type: st.isDirectory() ? 'directory' : 'file', target: { targetKey: child, displayPath: child }, version: 1 })
          }
        } catch { /* 树内目录不存在于磁盘：只列树内项 */ }
        entriesCache.set(key, entries.sort((a, b) => a.name.localeCompare(b.name)))
      }
      return entriesCache.get(key)
    },
    processPath(target) { return target.targetKey },
  }

  const workspaceRegistry = {
    async resolveByPath(p) { return workspaces.get(p) ?? null },
    async create(p) {
      const ws = { path: p, attachSession: async (id) => attached.push({ ws: p, id }) }
      workspaces.set(p, ws)
      return ws
    },
    get archivedSessionIds() { return [] },
  }

  const webServer = { register(def) { webRoutes.push(def); return () => {} } }
  const services = opts.services || {}
  const ctx = {
    fs,
    sessionPersistence: persistence,
    tools: { register() { return () => {} } },
    get(service) {
      if (service === 'workspaceRegistry') return workspaceRegistry
      if (service === 'sessionPersistence') return persistence
      if (service === 'webServer') return webServer
      if (services[service] !== undefined) return services[service]
      return undefined
    },
    inject(list, cb) {
      const names = Array.isArray(list) ? list : Object.keys(list || {})
      if (!names.every((s) => ctx.get(s) !== undefined)) return undefined
      return cb(ctx)
    },
  }
  registerPanelRoutes(ctx, webServer, registryDir)
  return {
    ctx, webRoutes, persistence, writes, registryDir, attached,
    cleanup() { rmSync(registryDir, { recursive: true, force: true }) },
  }
}

function routeOf(h, path) {
  const route = h.webRoutes.find((r) => r.path === path)
  assert.ok(route, 'route ' + path + ' 已注册')
  return route
}

async function invoke(h, path, body) {
  const route = routeOf(h, path)
  const req = { async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } }
  const res = {
    status: null, body: null,
    writeHead(s) { this.status = s },
    end(b) { this.body = b },
  }
  await route.handler(req, res)
  return { status: res.status, data: JSON.parse(res.body) }
}

const BASE = hostAbs('D:/fi')
const DSH_LOG = [
  { type: 'session', id: 'session-fi', cwd: hostAbs('D:/fi/proj'), createdAt: 1700000000000 },
  { type: 'turn/start', seq: 0, time: 1700000000000, data: { turn: 1 } },
  { type: 'user/message', seq: 1, time: 1700000000000, surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text: '本地提问' }] } },
  { type: 'assistant/message', seq: 2, time: 1700000000001, surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '回答' }] } } },
  { type: 'turn/end', seq: 3, time: 1700000000001, data: { turn: 1 } },
].map((l) => JSON.stringify(l)).join('\n')

const GENERIC_DOC = JSON.stringify({
  interchange: 'dsh-chat-import',
  version: 1,
  meta: { id: 'generic-fi', createdAt: 1700000000000, cwd: hostAbs('D:/fi/proj') },
  title: '长尾工具会话',
  provider: 'demo-tool',
  turns: [{ prompt: '问', steps: [{ content: [{ type: 'text', text: '答' }] }] }],
})

const BUNDLE_DOC = JSON.stringify({ bundle: 'dsh-chat-import', format: 'interchange-v1', version: 1, log: DSH_LOG, sha256: { session: 'x', bundle: 'y' } })

test('预览路由：单文件识别（报告 detectedFormat/detectedBy）且零副作用', async () => {
  const file = join(BASE, 'downloads', 'session.jsonl')
  const h = makeHarness({ [file]: DSH_LOG })
  try {
    const { status, data } = await invoke(h, '/api-import/file', { path: file, preview: true })
    assert.equal(status, 200)
    assert.equal(data.ok, true)
    assert.equal(data.kind, 'single')
    assert.equal(data.detectedFormat, 'dsh')
    assert.equal(data.detectedBy, 'path-hint')
    assert.ok(data.turns > 0)
    // 预览零副作用：没有建会话、没有写 registry
    assert.equal(h.persistence.sessions.size, 0)
    assert.equal(existsSync(join(h.registryDir, 'imports.json')), false)
  } finally { h.cleanup() }
})

test('预览路由：generic 内容标记直接命中；便携包标记转成「还原」条目', async () => {
  const generic = join(BASE, 'downloads', 'long-tail.json')
  const bundle = join(BASE, 'downloads', 'backup.dshbundle.json')
  const h = makeHarness({ [generic]: GENERIC_DOC, [bundle]: BUNDLE_DOC })
  try {
    const g = await invoke(h, '/api-import/file', { path: generic, preview: true })
    assert.equal(g.data.detectedFormat, 'generic')
    assert.equal(g.data.detectedBy, 'marker')
    assert.equal(g.data.title, '长尾工具会话')
    const b = await invoke(h, '/api-import/file', { path: bundle, preview: true })
    assert.equal(b.data.ok, true)
    assert.equal(b.data.bundle, true)
    assert.match(b.data.note, /便携包/)
  } finally { h.cleanup() }
})

test('预览路由：目录 → 批量条目（可识别 + 未识别带失败清单），并支持强制格式', async () => {
  const dir = join(BASE, 'vault')
  const good = join(dir, 'session.jsonl')
  const bad = join(dir, 'junk.jsonl')
  const h = makeHarness({ [dir]: 'dir', [good]: DSH_LOG, [bad]: '{"foo":1}\n{"bar":2}\n' })
  try {
    const { data } = await invoke(h, '/api-import/file', { path: dir, preview: true })
    assert.equal(data.kind, 'batch')
    assert.equal(data.total, 2)
    const okEntry = data.results.find((r) => r.path === good)
    assert.equal(okEntry.detectedFormat, 'dsh')
    const badEntry = data.results.find((r) => r.path === bad)
    assert.equal(badEntry.detectedFormat, undefined)
    assert.ok(Array.isArray(badEntry.failures) && badEntry.failures.length > 0)
    assert.ok(badEntry.failures.every((f) => f.format && f.reason))
    // 强制格式：generic 解析器读 DSH 日志 → 明确失败（不静默）
    const forced = await invoke(h, '/api-import/file', { path: good, preview: true, format: 'generic' })
    assert.equal(forced.data.detectedFormat, undefined)
    assert.equal(forced.data.failures[0].format, 'generic')
  } finally { h.cleanup() }
})

test('目录搜索范围：recursive:false 只扫当前层，recursive:true 才下钻（子文件夹询问的两条分支）', async () => {
  const dir = join(BASE, 'vault2')
  const sub = join(dir, 'nested')
  const top = join(dir, 'session.jsonl')
  const deep = join(sub, 'deep.json')
  const h = makeHarness({ [dir]: 'dir', [sub]: 'dir', [top]: DSH_LOG, [deep]: GENERIC_DOC })
  try {
    // 回车/预览先走的方式：仅当前层（面板据此弹「是否搜索子文件夹」）
    const shallow = await invoke(h, '/api-import/file', { path: dir, preview: true, recursive: false })
    assert.equal(shallow.data.kind, 'batch')
    assert.equal(shallow.data.total, 1)
    assert.deepEqual(shallow.data.results.map((r) => r.path), [top])
    // 用户选「包含子文件夹」后重扫
    const deepScan = await invoke(h, '/api-import/file', { path: dir, preview: true, recursive: true })
    assert.equal(deepScan.data.total, 2)
    assert.ok(deepScan.data.results.some((r) => r.path === deep))
    // 导入同样认这个开关：只导当前层那一个
    const imported = await invoke(h, '/api-import/file', { path: dir, recursive: false })
    assert.equal(imported.data.kind, 'batch')
    assert.equal(imported.data.total, 1)
    assert.equal(imported.data.imported, 1)
    assert.equal(h.persistence.sessions.size, 1)
  } finally { h.cleanup() }
})

test('导入路由：单文件落成可继续会话并写 registry；重复导入走幂等', async () => {
  const file = join(BASE, 'downloads', 'session.jsonl')
  const h = makeHarness({ [file]: DSH_LOG })
  try {
    const first = await invoke(h, '/api-import/file', { path: file })
    assert.equal(first.data.ok, true)
    assert.equal(first.data.kind, 'single')
    assert.equal(first.data.status, 'imported')
    assert.ok(h.persistence.sessions.has(first.data.sessionId))
    assert.equal(existsSync(join(h.registryDir, 'imports.json')), true)
    const again = await invoke(h, '/api-import/file', { path: file })
    assert.equal(again.data.status, 'already-imported')
    assert.equal(h.persistence.sessions.size, 1)
  } finally { h.cleanup() }
})

test('导入路由：目录批量导入；format 覆盖错误时不静默（跳过并给原因）', async () => {
  const dir = join(BASE, 'vault')
  const good = join(dir, 'session.jsonl')
  const bad = join(dir, 'junk.jsonl')
  const h = makeHarness({ [dir]: 'dir', [good]: DSH_LOG, [bad]: '{"foo":1}\n' })
  try {
    // 强制错格式：解析器认不出 → 状态 skipped（有原因），不产出空会话也不写 registry
    const forced = await invoke(h, '/api-import/file', { path: good, format: 'claude' })
    assert.equal(forced.data.ok, true)
    assert.equal(forced.data.status, 'skipped')
    assert.ok(forced.data.skipReason || forced.data.error)
    assert.equal(h.persistence.sessions.size, 0)
    const { data } = await invoke(h, '/api-import/file', { path: dir })
    assert.equal(data.ok, true)
    assert.equal(data.kind, 'batch')
    assert.equal(data.total, 2)
    assert.equal(data.imported, 1)
    assert.equal(data.skipped, 1)
  } finally { h.cleanup() }
})

test('导入路由：bundle 分流到 restore_bundle（坏包大声失败，不当成未识别转录）', async () => {
  const bundle = join(BASE, 'downloads', 'backup.dshbundle.json')
  const h = makeHarness({ [bundle]: BUNDLE_DOC })
  try {
    const { status, data } = await invoke(h, '/api-import/file', { path: bundle })
    // 指纹校验失败 → 明确报 bundle 校验问题（不是「未识别格式」）
    assert.equal(data.ok, false)
    assert.equal(status, 500)
    assert.match(data.error, /bundle|指纹|校验/)
  } finally { h.cleanup() }
})

test('导入路由：未知 target 拒绝；缺 path/uploadId 拒绝', async () => {
  const file = join(BASE, 'downloads', 'session.jsonl')
  const h = makeHarness({ [file]: DSH_LOG })
  try {
    const bad = await invoke(h, '/api-import/file', { path: file, target: 'nope' })
    assert.equal(bad.status, 400)
    assert.equal(bad.data.ok, false)
    const missing = await invoke(h, '/api-import/file', {})
    assert.equal(missing.status, 400)
    assert.match(missing.data.error, /path|uploadId/)
  } finally { h.cleanup() }
})

test('转投：从文件导入可直接转到外部工具格式（中间会话导出后撤回）', async () => {
  const file = join(BASE, 'downloads', 'session.jsonl')
  const h = makeHarness({ [file]: DSH_LOG })
  try {
    const { data } = await invoke(h, '/api-import/file', { path: file, target: 'claude' })
    assert.equal(data.ok, true)
    assert.equal(data.kind, 'transfer')
    assert.equal(data.transferred, 1)
    assert.equal(data.failed, 0)
    // 目标格式文件已写出（转投 = 导出到目标工具自己的格式，不留在 DSH）
    assert.ok(h.writes.length > 0, '至少写出了一个目标文件')
    assert.ok(h.writes[0].path.toLowerCase().includes('.jsonl'), h.writes[0].path)
    // 中间会话的去向如实上报：撤回成功（purged）或撤回失败但保留（kept + 原因）。
    // （本 mock 的 sessions Map 不是工件存储——撤回走 locate/扫描磁盘工件，故只断言上报口径。）
    assert.equal((data.purged || 0) + (data.kept || 0), 1)
  } finally { h.cleanup() }
})

test('上传路由：init → chunk → complete 后可直接用 uploadId 预览与导入', async () => {
  const h = makeHarness({})
  try {
    const payload = Buffer.from(DSH_LOG)
    const sha = createHash('sha256').update(payload).digest('hex')
    const init = await invoke(h, '/api-import/upload/init', { name: 'uploaded.jsonl', size: payload.length, sha256: sha })
    assert.equal(init.status, 200)
    assert.equal(init.data.ok, true)
    const cut = Math.floor(payload.length / 2)
    const c1 = await invoke(h, '/api-import/upload/chunk', { uploadId: init.data.uploadId, offset: 0, data: payload.subarray(0, cut).toString('base64') })
    assert.equal(c1.data.receivedOffset, cut)
    const c2 = await invoke(h, '/api-import/upload/chunk', { uploadId: init.data.uploadId, offset: cut, data: payload.subarray(cut).toString('base64') })
    assert.equal(c2.data.receivedOffset, payload.length)
    const done = await invoke(h, '/api-import/upload/complete', { uploadId: init.data.uploadId })
    assert.equal(done.data.ok, true)

    const preview = await invoke(h, '/api-import/file', { uploadId: init.data.uploadId, preview: true })
    assert.equal(preview.data.ok, true)
    assert.equal(preview.data.detectedFormat, 'dsh')

    const imported = await invoke(h, '/api-import/file', { uploadId: init.data.uploadId })
    assert.equal(imported.data.status, 'imported')
    assert.ok(h.persistence.sessions.has(imported.data.sessionId))

    // 未完成 / 未知 uploadId → 400（不是「导入成功但没内容」）
    const missing = await invoke(h, '/api-import/file', { uploadId: '00000000-0000-0000-0000-000000000000' })
    assert.equal(missing.status, 400)
    assert.match(missing.data.error, /上传/)
  } finally { h.cleanup() }
})

test('暂存维护路由：stats 报用量；cleanup 需要 confirm', async () => {
  const h = makeHarness({})
  try {
    const stats = await invoke(h, '/api-import/uploads', { mode: 'stats' })
    assert.equal(stats.data.ok, true)
    assert.ok(stats.data.limitBytes > 0)
    assert.equal(typeof stats.data.pending, 'number')
    const noConfirm = await invoke(h, '/api-import/uploads', { mode: 'cleanup' })
    assert.equal(noConfirm.status, 400)
    assert.match(noConfirm.data.error, /confirm/)
    const cleanup = await invoke(h, '/api-import/uploads', { mode: 'cleanup', confirm: true })
    assert.equal(cleanup.data.ok, true)
    const wrongMode = await invoke(h, '/api-import/uploads', { mode: 'nope' })
    assert.equal(wrongMode.status, 400)
  } finally { h.cleanup() }
})
