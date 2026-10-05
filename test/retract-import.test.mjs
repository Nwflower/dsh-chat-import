// retract-import.test.mjs — 导入识别 / 撤回（只读）：自包含 mock 集成测试。
// 走真实 apply → register → execute 路径：mock sessionPersistence（list /
// readFrom / locate，刻意不提供 delete / remove 面）+ mock fs（追踪调用，REQ-33
// 工具不应触碰）+ 真实 imports registry（$DSH_HOME/dsh-chat-import）。
//
// 覆盖：list_imported_sessions 以 imports registry 反查为权威（locate 路径正确、
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
import { apply } from '../lib/index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { resolveRegistryDir, loadImports, rememberImport, removeImport } from '../lib/imports.mjs'
import { forgetIgnore } from '../lib/ignore.mjs'
import { hostAbs } from './_support/host-path.mjs'
import { makeCtx as makeHostCtx, makePersistence as makeHostPersistence, forbiddenFs, chatDef } from './_support/fake-host.mjs'

const T0 = 1710000000000 // 固定毫秒时间戳（导入时间）

beforeEach(() => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-home-'))
})

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

// 内存会话库（共享 fake host）：list / readFrom / locate / create / append / inspect。
// 刻意没有 delete / remove 面（平台 sessionPersistence 亦无）——测试断言撤回全程零删除。
// 幽灵会话注入见 fake-host 的 ghost(id) / hostReject(id)（issue #22）。
function makePersistence() {
  return makeHostPersistence({
    omit: ['remove'],
    // 同步、不落盘（对齐 dsh-session-persistence 契约）
    locate: (meta) => ({ kind: 'jsonl', path: 'D:\\dsh-logs\\' + meta.id + '\\session.jsonl' }),
  })
}

function seedSession(persistence, { id, meta, events, readFromThrows = false }) {
  persistence.sessions.set(id, { meta: meta || { id, version: 0, cwd: hostAbs('D:/demo'), createdAt: T0 }, events, readFromThrows })
}

// ctx：fs 为抛错代理（REQ-33 工具不碰 fs；被调用即失败暴露），tools 收集注册。
// tree 可选：提供后 fs 变成内存文件树（重导端到端用例用）。
function makeCtx(persistence, tree) {
  const forbidden = forbiddenFs()
  const host = makeHostCtx(tree, { persistence, real: false, ...(tree ? {} : { fs: forbidden.fs }) })
  return { ctx: host.ctx, registered: host.registered, fsCalls: forbidden.calls }
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

test('list_imported_sessions：registry 反查是权威（0.8.3 起日志无标记也上榜，issue #34）', async () => {
  const persistence = makePersistence()
  // 0.8.3+ 导入的会话：日志无标记，归属只在 registry
  seedSession(persistence, { id: 'import-x', events: balancedEvents(null) })
  await rememberImport(resolveRegistryDir(), 'D:\\src\\x.jsonl', { kind: 'single', dshId: 'import-x', turns: 1, events: 6, sizeBytes: 1, version: 'v1', args: '[]', importedAt: T0, format: 'claude' })

  const { ctx } = makeCtx(persistence)
  apply(ctx)
  const value = await ctx.tools.registered('list_imported_sessions').execute({})
  assert.equal(value.total, 1)
  assert.equal(value.sessions[0].sessionId, 'import-x')
  assert.equal(value.sessions[0].sourcePath, 'D:\\src\\x.jsonl')
  assert.equal(value.sessions[0].importedAt, T0)
  // 原生会话（registry 无记录、日志无标记）不出现
  seedSession(persistence, { id: 'native-2', events: balancedEvents(null) })
  const again = await ctx.tools.registered('list_imported_sessions').execute({})
  assert.ok(!again.sessions.some((s) => s.sessionId === 'native-2'), '原生会话不出现')
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

test('list_imported_sessions：重导另铸的历史副本也上榜（副本与主记录同源同归属）', async () => {
  const persistence = makePersistence()
  seedSession(persistence, { id: 'import-main', events: balancedEvents(null, '主') })
  seedSession(persistence, { id: 'import-main-1', events: balancedEvents(null, '副本') })
  await rememberImport(resolveRegistryDir(), 'D:\\src\\m.jsonl', {
    kind: 'single',
    dshId: 'import-main-1',
    turns: 3,
    events: 9,
    importedAt: T0,
    copies: [{ dshId: 'import-main', turns: 2, events: 6, importedAt: T0 - 1000 }],
  })

  const { ctx } = makeCtx(persistence)
  apply(ctx)
  const value = await ctx.tools.registered('list_imported_sessions').execute({})
  assert.equal(value.total, 2)
  const main = value.sessions.find((s) => s.sessionId === 'import-main')
  const copy = value.sessions.find((s) => s.sessionId === 'import-main-1')
  assert.equal(main.sourcePath, 'D:\\src\\m.jsonl')
  assert.equal(copy.sourcePath, 'D:\\src\\m.jsonl')
  assert.equal(main.importedAt, T0 - 1000) // 副本保留自己的导入时间
  assert.equal(copy.importedAt, T0)
  assert.deepEqual(validateJsonSchemaValue(ctx.tools.registered('list_imported_sessions').output.schema, value), [])
})

test('retract_import：按历史副本的 sessionId 也能撤回该源（registry 反查含副本）', async () => {
  const persistence = makePersistence()
  seedSession(persistence, { id: 'import-main', events: balancedEvents(null) })
  seedSession(persistence, { id: 'import-main-1', events: balancedEvents(null) })
  await rememberImport(resolveRegistryDir(), 'D:\\src\\m.jsonl', {
    kind: 'single',
    dshId: 'import-main-1',
    turns: 3,
    events: 9,
    importedAt: T0,
    copies: [{ dshId: 'import-main', turns: 2, events: 6 }],
  })

  const { ctx } = makeCtx(persistence)
  apply(ctx)
  const value = await ctx.tools.registered('retract_import').execute({ sessionId: 'import-main' })
  assert.equal(value.removed, true)
  assert.equal(value.sourcePath, 'D:\\src\\m.jsonl')
  assert.equal(value.wasRegistered, true)
  const reg = await loadImports(resolveRegistryDir())
  assert.equal(reg.imports['D:\\src\\m.jsonl'], undefined)
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
  return JSON.stringify({ sessionId, type: 'user', cwd: hostAbs('D:/demo/proj'), message: { role: 'user', content: '问题1' } }) + '\n'
    + JSON.stringify({ sessionId, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '回答1' }] } })
}

test('撤回后重导：墓碑拦截；解除忽略后副本仍在 → backfill 回填；手动删工件后 → 全新导入', async () => {
  const src = 'D:\\demo\\reimport\\sess-reimport-001.jsonl'
  const tree = { [src]: claudeTranscript('sess-reimport-001') }
  const persistence = makePersistence()
  const { ctx } = makeCtx(persistence, tree)
  apply(ctx)
  const imp = chatDef(ctx, 'claude')

  // 首次导入（建 registry 记录）
  const first = await imp.execute({ path: src })
  assert.equal(first.sessionId, 'import-sess-reimport-001')
  assert.ok(src in (await loadImports(resolveRegistryDir())).imports)

  // 撤回：registry 记录移除，会话仍在；同时登记永久墓碑
  const ret = ctx.tools.registered('retract_import')
  await ret.execute({ sessionId: 'import-sess-reimport-001' })
  assert.ok(!(src in (await loadImports(resolveRegistryDir())).imports))

  // 新语义：重导被墓碑忽略（不重建副本，也不覆盖已有副本）
  const blocked = await imp.execute({ path: src })
  assert.equal(blocked.status, 'ignored')
  assert.equal(blocked.skipReason, 'ignored:retracted')

  // 手动解除忽略：既有语义恢复——副本仍在时重导走 legacy 回填基线（幂等跳过）
  await forgetIgnore(resolveRegistryDir(), src)
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
  const imp = chatDef(ctx, 'claude')
  const first = await imp.execute({ path: src })
  assert.equal(first.sessionId, 'import-sess-ghost-001')

  // 撤回 + 用户按引导手动删工件；宿主内存索引仍保留该 id（list 返回、日志不可读）
  await ctx.tools.registered('retract_import').execute({ sessionId: 'import-sess-ghost-001' })
  persistence.ghost('import-sess-ghost-001')

  // 默认被墓碑忽略；force 显式越权重导才进入幽灵避让路径
  assert.equal((await imp.execute({ path: src })).status, 'ignored')
  const again = await imp.execute({ path: src, force: true })
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
  const imp = chatDef(ctx, 'claude')
  await imp.execute({ path: src })
  await ctx.tools.registered('retract_import').execute({ sessionId: 'import-sess-ghost2-001' })
  // 宿主病态：list 已不暴露幽灵，但 create 仍对原 id 抛 already exists
  //（真实 DSH 0.1.1-rc.2：内存索引残留，无 delete/forget 面）
  persistence.hostReject('import-sess-ghost2-001')

  // 默认被墓碑忽略；force 显式越权重导才进入 hostReject 避让路径
  assert.equal((await imp.execute({ path: src })).status, 'ignored')
  const again = await imp.execute({ path: src, force: true })
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
