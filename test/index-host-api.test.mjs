// index-host-api.test.mjs — 新宿主会话 API（句柄形态）
// 句柄式 list / open / read / append 的读写与代次归一。
// 由 test/index.test.mjs 按横幅分组拆出（纯移动：用例与断言未改）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { listPersistedIds, readSessionRecord, readSessionEvents, writeSession } from '../lib/imports.mjs'
import { hostAbs } from './_support/host-path.mjs'
import { makeCtx, makeHandlePersistence, chatDef } from './_support/fake-host.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { clearScanCache } from '../lib/discovery.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'
import { loadHostFixture as load } from './_support/fixtures.mjs'
import { opencodeTestSessions, makeOpencodeDb, kimiCodeWire, kimiCodeEv } from './_support/index-fixtures.mjs'

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
})

test('issue #41 句柄形态会话 API：判重命中、不重复导入、落盘可读回', async () => {
  const simple = load('sess-simple-001.jsonl')
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple }, { hostApi: 'handle' })
  apply(ctx)
  const first = await chatDef(ctx, 'claude').execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(first.status, 'imported')
  assert.equal(persistence.sessions.size, 1)
  // 二次导入必须命中判重：list() 的元素在新宿主是 { header, ... }，把它当 header 用会
  // 让 id 全为 undefined、persisted 集合失效——每次同步都另铸新 id 重复导入（issue #41
  // 的重试风暴）。这条断言守住「新宿主形态下判重仍然有效」。
  const second = await chatDef(ctx, 'claude').execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(second.status, 'already-imported')
  assert.equal(persistence.sessions.size, 1)
  const saved = persistence.sessions.get('import-sess-simple-001')
  assert.ok(saved.events.length > 0)
  assert.ok(saved.events.every((e, i) => e.seq === i))
})

test('issue #41 持久化适配层：list 元素形状、readSessionRecord、writeSession 双形态', async () => {
  const store = { sessions: new Map([['import-a', { meta: { id: 'import-a' }, events: [{ seq: 0 }] }]]) }
  const ctxOf = (sp) => ({ get: (name) => (name === 'sessionPersistence' ? sp : undefined) })
  const handleApi = makeHandlePersistence(store)

  // list 元素是 { header }：仍能取到会话 id
  assert.deepEqual([...(await listPersistedIds(ctxOf(handleApi)))], ['import-a'])
  const rec = await readSessionRecord(ctxOf(handleApi), 'import-a', 0)
  assert.equal(rec.meta.id, 'import-a')
  assert.equal(rec.events.length, 1)
  assert.equal(await readSessionEvents(ctxOf(handleApi), 'missing', 0), null)
  // 写：句柄面走 create → handle.append
  await writeSession(ctxOf(handleApi), { id: 'import-b' }, [{ seq: 0 }, { seq: 1 }])
  assert.equal(store.sessions.get('import-b').events.length, 2)

  // 旧形态（list 返回 header 数组、readFrom/inspect、append(id, events)）继续可用
  const legacy = {
    async list() { return [...store.sessions.values()].map((s) => s.meta) },
    async readFrom(id) {
      const s = store.sessions.get(id)
      return { meta: s.meta, events: s.events }
    },
    async create(meta) { store.sessions.set(meta.id, { meta, events: [] }) },
    async append(id, events) { store.sessions.get(id).events.push(...events) },
  }
  assert.deepEqual([...(await listPersistedIds(ctxOf(legacy)))].sort(), ['import-a', 'import-b'])
  await writeSession(ctxOf(legacy), { id: 'import-c' }, [{ seq: 0 }])
  assert.equal(store.sessions.get('import-c').events.length, 1)
})

test('cwdRemap：dry-run 预览与落盘的 cwd 同口径', async () => {
  const file = 'D:\\demo\\proj\\sess-simple-001.jsonl'
  const from = hostAbs('D:/demo/proj')
  const to = hostAbs('D:/host/work')
  const { ctx, persistence } = makeCtx({ [file]: load('sess-simple-001.jsonl') })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const preview = await def.execute({ path: file, preview: true, cwdRemap: [{ from, to }] })
  assert.equal(preview.cwd, to, '预览即重映射后的 cwd')
  const value = await def.execute({ path: file, cwdRemap: [{ from, to }] })
  assert.equal(value.cwdRemap.mapped, to)
  // 落盘结果同样带 cwdRemap 报告：输出 schema 的单文件导入分支必须声明它
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, preview), [])
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  assert.equal(persistence.sessions.get(value.sessionId).meta.cwd, to, '落盘与预览一致')
})

test('目录 replace:true：批量条目状态 replaced 且符合输出 schema', async () => {
  const dir = 'D:\\demo\\proj'
  const tree = { [dir]: 'dir', [dir + '\\sess-simple-001.jsonl']: load('sess-simple-001.jsonl') }
  const { ctx } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const first = await def.execute({ path: dir })
  assert.equal(first.imported, 1)
  const replaced = await def.execute({ path: dir, replace: true })
  assert.equal(replaced.mode, 'batch')
  assert.deepEqual(replaced.results.map((r) => r.status), ['replaced'])
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, replaced), [])
})

test('一库多会话重导：子会话已被删时条目带 staleRegistry 且符合输出 schema', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'opencode')
  const first = await def.execute({ path: dbPath })
  assert.equal(first.imported, 2)
  persistence.sessions.delete('import-ses-a')
  const again = await def.execute({ path: dbPath })
  const rebuilt = again.results.find((r) => r.staleRegistry)
  assert.ok(rebuilt, '被删会话重建并点名 staleRegistry')
  assert.deepEqual(rebuilt.staleRegistry, { previous: 'import-ses-a', reason: 'session-log-missing' })
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, again), [])
})

test('import_kimi 新 Kimi Code：state.json 仅含 workDir 时同样解析出 cwd（#61）', async () => {
  const sess = 'C:\\Users\\u\\.kimi-code\\sessions\\wd_genius-invokation_0123456789ab\\session-eb6808b9'
  const workDir = hostAbs('D:/demo/ws/genius-invokation')
  const tree = {
    'C:\\Users\\u\\.kimi-code\\sessions': 'dir',
    'C:\\Users\\u\\.kimi-code\\sessions\\wd_genius-invokation_0123456789ab': 'dir',
    [sess]: 'dir',
    [sess + '\\agents']: 'dir',
    [sess + '\\agents\\main']: 'dir',
    [sess + '\\agents\\main\\wire.jsonl']: kimiCodeWire([
      kimiCodeEv('turn.prompt', { input: [{ type: 'text', text: '帮我看看构建失败' }], origin: { kind: 'user' } }),
      kimiCodeEv('context.append_loop_event', { event: { type: 'step.begin', turnId: '0', step: 1 } }),
      kimiCodeEv('context.append_loop_event', { event: { type: 'content.part', part: { type: 'text', text: '是缺少依赖。' } } }),
      kimiCodeEv('context.append_loop_event', { event: { type: 'step.end', turnId: '0', step: 1, finishReason: 'end_turn' } }),
      kimiCodeEv('turn.ended', { turnId: 0, reason: 'completed' }),
    ]),
    // 关键形态：只有 workDir，没有 cwd（本机实测 29/53 个会话是这种）
    [sess + '\\state.json']: JSON.stringify({ id: 'session-eb6808b9', workDir, custom_title: '牌圣测试' }),
  }
  const { ctx, persistence, attached } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'kimi')
  const preview = await def.execute({ path: sess, preview: true })
  assert.equal(preview.cwd, workDir)

  const value = await def.execute({ path: sess })
  assert.equal(value.mode, 'single')
  assert.equal(value.status, 'imported')
  const saved = persistence.sessions.get(value.sessionId)
  assert.ok(saved)
  assert.equal(saved.meta.cwd, workDir) // state.json.workDir（不再回退 kimi.json）
  assert.equal(saved.events.at(-1).data.title, 'Kimi · 牌圣测试')
  assertEnvelopeHygiene(saved.events)
  assert.equal(attached.length, 1)
})

test('import_kimi 新 Kimi Code：state.json 缺失时按 workspaces.json 回退 cwd（REQ-77）', async () => {
  const workspaceId = 'wd_genius-invokation_0123456789ab'
  const sess = 'C:\\Users\\u\\.kimi-code\\sessions\\' + workspaceId + '\\session-no-state'
  const workDir = hostAbs('D:/demo/ws/genius-invokation')
  const tree = {
    'C:\\Users\\u\\.kimi-code\\sessions': 'dir',
    ['C:\\Users\\u\\.kimi-code\\sessions\\' + workspaceId]: 'dir',
    [sess]: 'dir',
    [sess + '\\agents']: 'dir',
    [sess + '\\agents\\main']: 'dir',
    'C:\\Users\\u\\.kimi-code\\workspaces.json': JSON.stringify({
      version: 1,
      workspaces: { [workspaceId]: { root: workDir, name: 'genius-invokation' } },
    }),
    [sess + '\\agents\\main\\wire.jsonl']: kimiCodeWire([
      kimiCodeEv('turn.prompt', { input: [{ type: 'text', text: '帮我看看构建失败' }], origin: { kind: 'user' } }),
      kimiCodeEv('context.append_loop_event', { event: { type: 'step.begin', turnId: '0', step: 1 } }),
      kimiCodeEv('context.append_loop_event', { event: { type: 'content.part', part: { type: 'text', text: '是缺少依赖。' } } }),
      kimiCodeEv('context.append_loop_event', { event: { type: 'step.end', turnId: '0', step: 1, finishReason: 'end_turn' } }),
      kimiCodeEv('turn.ended', { turnId: 0, reason: 'completed' }),
    ]),
  }
  const { ctx, persistence, attached } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'kimi')
  const preview = await def.execute({ path: sess, preview: true })
  assert.equal(preview.cwd, workDir)

  const value = await def.execute({ path: sess })
  assert.equal(value.mode, 'single')
  assert.equal(value.status, 'imported')
  const saved = persistence.sessions.get(value.sessionId)
  assert.ok(saved)
  assert.equal(saved.meta.cwd, workDir)
  assert.equal(attached.length, 1)
})
