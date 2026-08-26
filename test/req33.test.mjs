// req33.test.mjs — REQ-33 导入识别 / 撤回（只读）：自包含 mock 集成测试。
// 走真实 apply → register → execute 路径：mock sessionPersistence（list /
// readFrom / locate，刻意不提供 delete / remove 面）+ mock fs（追踪调用，REQ-33
// 工具不应触碰）+ 真实 imports registry（$DSH_HOME/dsh-chat-import）。
//
// 覆盖：list_imported_sessions 只列带 session/imported 标记会话（locate 路径正确、
// 标题/源路径/导入时间）、无标记会话不出现（registry 记录也不能让无标记会话上榜）、
// 日志读不到时 registry 兜底识别；retract_import 移除 registry 记录 + 手动删除引导 +
// 零删除保证（无 delete/remove 调用、会话工件仍在）、幂等、按 sourcePath 撤回 multi、
// 非导入会话报错、参数缺失报错；撤回后重导行为（会话仍在 → backfill 回填；手动删工件
// 后 → 全新导入）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { resolveRegistryDir, loadImports, rememberImport, removeImport } from '../lib/imports.mjs'

const T0 = 1710000000000 // 固定毫秒时间戳（导入时间）

beforeEach(() => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-home-'))
})

// 辅助：import_chat 分发器定义——execute 时注入 format（收敛后单工具的测试形态，
// 等价旧 import_claude 的调用方式）
function chatDef(ctx, format = 'claude') {
  const tool = ctx.tools.registered('import_chat')
  return { ...tool, execute: (args) => tool.execute({ format, ...args }) }
}

// ── 自包含 mock ────────────────────────────────────────────────

// REQ-32 标记事件（seq 0、ignorable，data 含 tool/sourceId/sourcePath/importedAt）。
function markerEvent(tool, sourceId, sourcePath, importedAt = T0) {
  return { type: 'session/imported', seq: 0, ignorable: true, data: { tool, sourceId, sourcePath, importedAt } }
}

// 平衡会话事件：标记（可选）→ 1 轮 turn/step → session/title（可选，末尾）。
// seq 从 0 连续。marker 传 null 生成无标记会话（原生 / legacy）。
function balancedEvents(marker, title) {
  const events = marker ? [marker] : []
  events.push({ type: 'turn/start', seq: events.length, data: { turn: 1 } })
  events.push({ type: 'step/start', seq: events.length, data: { turn: 1, step: 1 } })
  events.push({ type: 'user/message', seq: events.length, data: { turn: 1, step: 1, role: 'user', text: '你好' } })
  events.push({ type: 'assistant/message', seq: events.length, data: { turn: 1, step: 1, role: 'assistant', text: '你好！' } })
  events.push({ type: 'step/end', seq: events.length, data: { turn: 1, step: 1 } })
  events.push({ type: 'turn/end', seq: events.length, data: { turn: 1, reason: { kind: 'completed' } } })
  if (title) events.push({ type: 'session/title', seq: events.length, data: { title, messageSeqs: [], source: { kind: 'user' } } })
  return events
}

// 内存会话库：list / readFrom / locate / create / append / inspect。
// 刻意没有 delete / remove 面（平台 sessionPersistence 亦无）——测试断言撤回
// 全程零删除。readFromThrows 模拟日志不可读（registry 兜底场景）。
// issue #22 幽灵会话支持：
//   ghost(id)    —— 模拟「宿主内存索引仍保留 id，但工件已删」：list 仍返回该会话
//                   （GUI 列表可见），inspect / readFrom 抛错（磁盘侧已认可删除）；
//   hostReject(id)—— 模拟更病态的宿主：list 已不暴露该 id，但 create 仍对原 id 抛
//                   `already exists in this backend`（真实 DSH 0.1.1-rc.2 行为）。
function makePersistence() {
  const sessions = new Map()
  const calls = []
  const rejectIds = new Set() // create 拒绝的幽灵 id（list 不暴露）
  const api = {
    sessions,
    calls,
    ghost(id) {
      const s = sessions.get(id)
      if (s) { s.ghosted = true; s.readFromThrows = true }
    },
    hostReject(id) {
      rejectIds.add(id)
      sessions.delete(id) // list 不再暴露
    },
    async list() { calls.push('list'); return [...sessions.values()].map((s) => s.meta) },
    async create(meta) {
      calls.push('create')
      if (rejectIds.has(meta.id)) throw new Error('session "' + meta.id + '" already exists in this backend')
      if (sessions.has(meta.id)) throw new Error('duplicate session ' + meta.id)
      sessions.set(meta.id, { meta, events: [], readFromThrows: false })
    },
    async append(id, events) {
      calls.push('append')
      sessions.get(id).events.push(...events)
    },
    async inspect(id) {
      calls.push('inspect')
      const s = sessions.get(id)
      if (!s) throw new Error('unknown session ' + id)
      if (s.ghosted) throw new Error('session artifact missing (ghost)')
      return { meta: s.meta, events: s.events }
    },
    async readFrom(id, fromSeq = 0) {
      calls.push('readFrom')
      const s = sessions.get(id)
      if (!s) throw new Error('unknown session ' + id)
      if (s.readFromThrows) throw new Error('readFrom failed (torn log)')
      return { meta: s.meta, events: s.events.slice(fromSeq) }
    },
    // 同步、不落盘（对齐 dsh-session-persistence 契约）
    locate(meta) {
      calls.push('locate')
      return { kind: 'jsonl', path: 'D:\\dsh-logs\\' + meta.id + '\\session.jsonl' }
    },
  }
  return api
}

function seedSession(persistence, { id, meta, events, readFromThrows = false }) {
  persistence.sessions.set(id, { meta: meta || { id, version: 0, cwd: 'D:\\demo', createdAt: T0 }, events, readFromThrows })
}

// ctx：fs 为抛错代理（REQ-33 工具不碰 fs；被调用即失败暴露），tools 收集注册。
// tree 可选：提供后 fs 变成真实文件树 mock（重导端到端用例用）。
function makeCtx(persistence, tree) {
  const fsCalls = []
  const registered = []
  // 跨平台分隔符归一（与 index.test.mjs makeCtx 同款）：树查找三态命中，防 CI（Linux）红
  const norm = (p) => String(p).replace(/\\/g, '/')
  const lookup = (p) => {
    const f = norm(p)
    return tree[p] ?? tree[f] ?? tree[f.replace(/\//g, '\\')]
  }
  const fs = tree
    ? {
      async resolve(path) { return { targetKey: path, displayPath: path } },
      async stat(target) {
        const v = lookup(target.targetKey)
        if (v === undefined) throw new Error('FS_NOT_FOUND ' + target.targetKey)
        return v === 'dir' ? { type: 'directory' } : { type: 'file', size: v.length, version: 'v' + v.length }
      },
      async readText(target) {
        const v = lookup(target.targetKey)
        if (v === undefined) throw new Error('FS_NOT_FOUND ' + target.targetKey)
        return v
      },
      processPath(target) { return target.targetKey },
    }
    : new Proxy({}, {
      get(_t, prop) {
        fsCalls.push(String(prop))
        return async () => { throw new Error('fs.' + String(prop) + ' 不应被 REQ-33 工具调用') }
      },
    })
  const ctx = {
    fs,
    sessionPersistence: persistence,
    webServer: { register() {} }, // REQ-41：apply 注册 /api-import/sessions 路由（REQ-33 测试不关心）
    // 模拟 Cordis ctx.inject：依赖服务在 ctx 上存在才执行回调（webServer 在场 →
    // 路由注册执行；commands 缺席 → /import 命令不注册，插件照常激活）。
    inject(serviceList, cb) {
      const list = Array.isArray(serviceList) ? serviceList : Object.keys(serviceList || {})
      if (list.every((s) => ctx[s] !== undefined)) return cb(ctx)
      return undefined
    },
    get(service) {
      if (service === 'sessionPersistence') return persistence
      if (service === 'fs') return fs
      if (service === 'workspaceRegistry') return { resolveByPath: async () => null, create: async () => ({ attachSession: async () => {} }) }
      return undefined
    },
    tools: { register(def) { registered.push(def); return () => {} } },
    on() { return () => {} }, // REQ-53：apply 监听 agent/session-start（本测试不模拟事件）
  }
  ctx.tools.registered = (name) => registered.find((d) => d.name === name)
  return { ctx, registered, fsCalls }
}

// ── list_imported_sessions ─────────────────────────────────────

test('list_imported_sessions：只列带标记会话，locate 路径 / 标题 / 源路径 / 导入时间正确', async () => {
  const persistence = makePersistence()
  seedSession(persistence, { id: 'import-a', events: balancedEvents(markerEvent('claude-code', 'src-a', 'D:\\src\\a.jsonl'), '会话A') })
  seedSession(persistence, { id: 'import-b', events: balancedEvents(markerEvent('codex', 'src-b', 'D:\\src\\b.jsonl')) })
  seedSession(persistence, { id: 'native-1', events: balancedEvents(null) }) // 无标记原生会话
  await rememberImport(resolveRegistryDir(), 'D:\\src\\a.jsonl', { kind: 'single', dshId: 'import-a', turns: 1, events: 7, sizeBytes: 1, version: 'v1', args: '[]', importedAt: T0 })
  await rememberImport(resolveRegistryDir(), 'D:\\src\\b.jsonl', { kind: 'single', dshId: 'import-b', turns: 1, events: 6, sizeBytes: 1, version: 'v1', args: '[]', importedAt: T0 })

  const { ctx } = makeCtx(persistence)
  apply(ctx)
  const def = ctx.tools.registered('list_imported_sessions')
  const value = await def.execute({})

  assert.equal(value.total, 2)
  assert.deepEqual(value.sessions.map((s) => s.sessionId).sort(), ['import-a', 'import-b'])
  assert.ok(!value.sessions.some((s) => s.sessionId === 'native-1'), '无标记会话不出现')

  const a = value.sessions.find((s) => s.sessionId === 'import-a')
  assert.equal(a.title, '会话A')
  assert.equal(a.sourcePath, 'D:\\src\\a.jsonl')
  assert.equal(a.artifactPath, 'D:\\dsh-logs\\import-a\\session.jsonl')
  assert.equal(a.importedAt, T0)
  const b = value.sessions.find((s) => s.sessionId === 'import-b')
  assert.ok(!('title' in b), '无显式标题会话省略 title 键')
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  assert.ok(!persistence.calls.includes('create') && !persistence.calls.includes('append'), '识别零副作用')
})

test('list_imported_sessions：无标记会话不出现（registry 记录也不能让无标记会话上榜——标记是权威信号）', async () => {
  const persistence = makePersistence()
  // 日志读成功但首事件不是标记（legacy / 原生会话）；registry 却登记它是导入会话
  seedSession(persistence, { id: 'legacy-x', events: balancedEvents(null) })
  await rememberImport(resolveRegistryDir(), 'D:\\src\\legacy.jsonl', { kind: 'single', dshId: 'legacy-x', turns: 1, events: 6, sizeBytes: 1, version: 'v1', args: '[]', importedAt: T0 })

  const { ctx } = makeCtx(persistence)
  apply(ctx)
  const value = await ctx.tools.registered('list_imported_sessions').execute({})
  assert.equal(value.total, 0)
  assert.deepEqual(value.sessions, [])
})

test('list_imported_sessions：日志读不到时用 registry 兜底识别（读失败 ≠ 无标记）', async () => {
  const persistence = makePersistence()
  seedSession(persistence, { id: 'import-c', events: [], readFromThrows: true })
  seedSession(persistence, { id: 'import-d', events: [], readFromThrows: true }) // 无 registry 记录 → 不出现
  await rememberImport(resolveRegistryDir(), 'D:\\src\\c.jsonl', { kind: 'single', dshId: 'import-c', turns: 1, events: 7, sizeBytes: 1, version: 'v1', args: '[]', importedAt: T0 })

  const { ctx } = makeCtx(persistence)
  apply(ctx)
  const value = await ctx.tools.registered('list_imported_sessions').execute({})

  assert.equal(value.total, 1)
  const c = value.sessions[0]
  assert.equal(c.sessionId, 'import-c')
  assert.equal(c.sourcePath, 'D:\\src\\c.jsonl') // 来自 registry 兜底
  assert.equal(c.artifactPath, 'D:\\dsh-logs\\import-c\\session.jsonl') // locate 仍可用
  assert.equal(c.importedAt, T0)
})

// ── retract_import ─────────────────────────────────────────────

test('retract_import：移除 registry 记录、输出手动删除引导、零删除', async () => {
  const persistence = makePersistence()
  seedSession(persistence, { id: 'import-a', events: balancedEvents(markerEvent('claude-code', 'src-a', 'D:\\src\\a.jsonl')) })
  await rememberImport(resolveRegistryDir(), 'D:\\src\\a.jsonl', { kind: 'single', dshId: 'import-a', turns: 1, events: 6, sizeBytes: 1, version: 'v1', args: '[]', importedAt: T0 })

  const { ctx, fsCalls } = makeCtx(persistence)
  apply(ctx)
  const def = ctx.tools.registered('retract_import')
  const value = await def.execute({ sessionId: 'import-a' })

  assert.equal(value.removed, true)
  assert.equal(value.sourcePath, 'D:\\src\\a.jsonl')
  assert.equal(value.artifactPath, 'D:\\dsh-logs\\import-a\\session.jsonl')
  assert.equal(value.wasRegistered, true)
  assert.match(value.manualDelete, /请手动删除工件目录 D:\\dsh-logs\\import-a\\session\.jsonl/)
  assert.match(value.manualDelete, /DSH 无 delete 面/)
  // issue #22：撤回提示宿主内存索引可能残留幽灵会话，需重启彻底移除
  assert.match(value.manualDelete, /重启 dsh/)
  assert.match(value.manualDelete, /staleGhost/)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  // registry 记录被移除（重导不再幂等短路）
  const reg = await loadImports(resolveRegistryDir())
  assert.ok(!('D:\\src\\a.jsonl' in reg.imports))

  // 零删除保证：mock 无 delete/remove 面、全程无删除调用、会话工件仍在
  assert.equal(typeof persistence.delete, 'undefined')
  assert.equal(typeof persistence.remove, 'undefined')
  assert.ok(!persistence.calls.some((c) => /delete|remove/i.test(c)))
  assert.ok(persistence.sessions.has('import-a'), '会话工件仍在（不删会话）')
  assert.equal(fsCalls.length, 0, '撤回不触碰 fs')
})

test('retract_import：幂等（二次撤回不报错、wasRegistered=false、registry 不再变动）', async () => {
  const persistence = makePersistence()
  seedSession(persistence, { id: 'import-a', events: balancedEvents(markerEvent('claude-code', 'src-a', 'D:\\src\\a.jsonl')) })
  await rememberImport(resolveRegistryDir(), 'D:\\src\\a.jsonl', { kind: 'single', dshId: 'import-a', turns: 1, events: 6, sizeBytes: 1, version: 'v1', args: '[]', importedAt: T0 })

  const { ctx } = makeCtx(persistence)
  apply(ctx)
  const def = ctx.tools.registered('retract_import')
  await def.execute({ sessionId: 'import-a' })

  const second = await def.execute({ sessionId: 'import-a' })
  assert.equal(second.removed, true)
  assert.equal(second.wasRegistered, false)
  assert.equal(second.sourcePath, 'D:\\src\\a.jsonl') // 标记留在日志 → 仍可定位
  assert.equal(second.artifactPath, 'D:\\dsh-logs\\import-a\\session.jsonl')
  const reg = await loadImports(resolveRegistryDir())
  assert.ok(!('D:\\src\\a.jsonl' in reg.imports))
  assert.ok(persistence.sessions.has('import-a'), '二次撤回仍不删会话')
})

test('retract_import：按 sourcePath 撤回 multi 记录（多会话引导逐个撤回）', async () => {
  const persistence = makePersistence()
  seedSession(persistence, { id: 'import-m1', events: balancedEvents(markerEvent('chatgpt', 'conv1', 'D:\\src\\multi.jsonl')) })
  seedSession(persistence, { id: 'import-m2', events: balancedEvents(markerEvent('chatgpt', 'conv2', 'D:\\src\\multi.jsonl')) })
  await rememberImport(resolveRegistryDir(), 'D:\\src\\multi.jsonl', {
    kind: 'multi',
    conversations: {
      conv1: { dshId: 'import-m1', turns: 1, events: 7 },
      conv2: { dshId: 'import-m2', turns: 1, events: 7 },
    },
    sizeBytes: 1, version: 'v1', args: '[]', importedAt: T0,
  })

  const { ctx } = makeCtx(persistence)
  apply(ctx)
  const def = ctx.tools.registered('retract_import')
  const value = await def.execute({ sourcePath: 'D:\\src\\multi.jsonl' })

  assert.equal(value.removed, true)
  assert.equal(value.sourcePath, 'D:\\src\\multi.jsonl')
  assert.equal(value.artifactPath, null) // multi 多会话无单一工件
  assert.match(value.manualDelete, /2 个会话/)
  assert.match(value.manualDelete, /list_imported_sessions/)
  const reg = await loadImports(resolveRegistryDir())
  assert.ok(!('D:\\src\\multi.jsonl' in reg.imports))
  assert.ok(persistence.sessions.has('import-m1') && persistence.sessions.has('import-m2'), 'multi 会话工件仍在')
})

test('retract_import：非导入会话报错；参数缺失报错', async () => {
  const persistence = makePersistence()
  seedSession(persistence, { id: 'native-1', events: balancedEvents(null) })

  const { ctx } = makeCtx(persistence)
  apply(ctx)
  const def = ctx.tools.registered('retract_import')
  await assert.rejects(() => def.execute({ sessionId: 'native-1' }), /不是本插件导入的会话/)
  await assert.rejects(() => def.execute({}), /需要 sessionId 或 sourcePath/)
})

// ── 撤回后重导（registry 记录移除的后果）────────────────────────

// 合成 Claude transcript（文件名 stem = sessionId，对齐导入的 fileStem 判定）。
function claudeTranscript(sessionId) {
  return JSON.stringify({ sessionId, type: 'user', cwd: 'D:\\demo\\proj', message: { role: 'user', content: '问题1' } }) + '\n'
    + JSON.stringify({ sessionId, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '回答1' }] } })
}

test('撤回后重导：registry 记录移除后，副本仍在 → backfill 回填；手动删工件后 → 全新导入', async () => {
  const src = 'D:\\demo\\reimport\\sess-reimport-001.jsonl'
  const tree = { [src]: claudeTranscript('sess-reimport-001') }
  const persistence = makePersistence()
  const { ctx } = makeCtx(persistence, tree)
  apply(ctx)
  const imp = chatDef(ctx)

  // 首次导入（建 registry 记录）
  const first = await imp.execute({ path: src })
  assert.equal(first.sessionId, 'import-sess-reimport-001')
  assert.ok(src in (await loadImports(resolveRegistryDir())).imports)

  // 撤回：registry 记录移除，会话仍在
  const ret = ctx.tools.registered('retract_import')
  await ret.execute({ sessionId: 'import-sess-reimport-001' })
  assert.ok(!(src in (await loadImports(resolveRegistryDir())).imports))

  // 副本仍在时重导：标记仍在 → legacy 回填基线（幂等跳过，不重复建副本）
  const backfilled = await imp.execute({ path: src })
  assert.equal(backfilled.alreadyImported, true)
  assert.equal(backfilled.backfilled, true)

  // 模拟用户按引导手动删除 DSH 工件副本（mock 里移除会话，即用户手动步骤）
  persistence.sessions.delete('import-sess-reimport-001')
  const again = await imp.execute({ path: src })
  assert.equal(again.status, 'imported')
  assert.equal(again.sessionId, 'import-sess-reimport-001')
  assert.ok(src in (await loadImports(resolveRegistryDir())).imports, '重导重新落 registry 记录')
})

test('撤回后重导：宿主残留幽灵会话（list 仍暴露、日志不可读）→ 自动另铸新 id 并报 staleGhost（issue #22）', async () => {
  const src = 'D:\\demo\\reimport\\sess-ghost-001.jsonl'
  const tree = { [src]: claudeTranscript('sess-ghost-001') }
  const persistence = makePersistence()
  const { ctx } = makeCtx(persistence, tree)
  apply(ctx)
  const imp = chatDef(ctx)
  const first = await imp.execute({ path: src })
  assert.equal(first.sessionId, 'import-sess-ghost-001')

  // 撤回 + 用户按引导手动删工件；宿主内存索引仍保留该 id（list 返回、日志不可读）
  await ctx.tools.registered('retract_import').execute({ sessionId: 'import-sess-ghost-001' })
  persistence.ghost('import-sess-ghost-001')

  const again = await imp.execute({ path: src })
  assert.equal(again.status, 'imported')
  assert.equal(again.sessionId, 'import-sess-ghost-001-1')
  assert.deepEqual(again.staleGhost, { previous: 'import-sess-ghost-001', current: 'import-sess-ghost-001-1' })
  // 幽灵原 id 仍在宿主 list（重启前不消失）；新副本真实落盘
  assert.ok(persistence.sessions.has('import-sess-ghost-001'))
  assert.ok(persistence.sessions.has('import-sess-ghost-001-1'))
  // registry 指向新 id；再导（未变）幂等跳过
  const reg = await loadImports(resolveRegistryDir())
  assert.equal(reg.imports[src].dshId, 'import-sess-ghost-001-1')
  const third = await imp.execute({ path: src })
  assert.equal(third.status, 'already-imported')
  assert.deepEqual(validateJsonSchemaValue(imp.output.schema, again), [])
})

test('撤回后重导：宿主 create 拒绝幽灵 id（list 已不暴露）→ 另铸新 id 重试并报 staleGhost（issue #22）', async () => {
  const src = 'D:\\demo\\reimport\\sess-ghost2-001.jsonl'
  const tree = { [src]: claudeTranscript('sess-ghost2-001') }
  const persistence = makePersistence()
  const { ctx } = makeCtx(persistence, tree)
  apply(ctx)
  const imp = chatDef(ctx)
  await imp.execute({ path: src })
  await ctx.tools.registered('retract_import').execute({ sessionId: 'import-sess-ghost2-001' })
  // 宿主病态：list 已不暴露幽灵，但 create 仍对原 id 抛 already exists
  //（真实 DSH 0.1.1-rc.2：内存索引残留，无 delete/forget 面）
  persistence.hostReject('import-sess-ghost2-001')

  const again = await imp.execute({ path: src })
  assert.equal(again.status, 'imported')
  assert.equal(again.sessionId, 'import-sess-ghost2-001-1')
  assert.deepEqual(again.staleGhost, { previous: 'import-sess-ghost2-001', current: 'import-sess-ghost2-001-1' })
  // registry 指向新 id（不是幽灵原 id），下次导入幂等短路
  const reg = await loadImports(resolveRegistryDir())
  assert.equal(reg.imports[src].dshId, 'import-sess-ghost2-001-1')
  const third = await imp.execute({ path: src })
  assert.equal(third.status, 'already-imported')
  assert.deepEqual(validateJsonSchemaValue(imp.output.schema, again), [])
})

// ── removeImport 单元 ──────────────────────────────────────────

test('removeImport：移除记录；键不存在幂等返回', async () => {
  const dir = resolveRegistryDir()
  await rememberImport(dir, 'K1', { kind: 'single', dshId: 'x', turns: 1, events: 1, importedAt: T0 })
  await removeImport(dir, 'K1')
  assert.ok(!('K1' in (await loadImports(dir)).imports))
  // 幂等：不存在键不报错、registry 保持不变
  await removeImport(dir, 'K1')
  await removeImport(dir, 'never-existed')
  assert.deepEqual((await loadImports(dir)).imports, {})
})
