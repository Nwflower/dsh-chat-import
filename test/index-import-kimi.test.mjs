// index-import-kimi.test.mjs — Kimi 集成（会话目录）
// wire.jsonl + state.json + kimi.json 映射、新 Kimi Code 布局。
// 由 test/index.test.mjs 按横幅分组拆出（纯移动：用例与断言未改）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { apply } from '../lib/index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { hostAbs } from './_support/host-path.mjs'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { clearScanCache } from '../lib/discovery.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'
import { kimiCodeWire, kimiCodeEv } from './_support/index-fixtures.mjs'

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
})

function kimiWire(recs) {
  const lines = ['{"type":"metadata","protocol_version":"1"}']
  recs.forEach((r, i) => lines.push(JSON.stringify({ timestamp: 1776162400 + i, message: r })))
  return lines.join('\n')
}

function kimiEv(type, payload = {}) { return { type, payload } }
// kimi.json workdir 目录名 = md5(path)（kaos 本地时无前缀）

const kimiHash = (p) => createHash('md5').update(p, 'utf8').digest('hex')
// 新 Kimi Code wire：每行直接是 {type, time, …}，不包 message 外壳。

test('import_kimi 单会话目录：wire.jsonl + state.json + kimi.json 映射、落盘、归组、schema 校验', async () => {
  const workDir = hostAbs('D:/demo/kimi-proj')
  const hashDir = kimiHash(workDir)
  const sess = 'D:\\demo\\kimi\\sessions\\' + hashDir + '\\sess-001'
  const tree = {
    'D:\\demo\\kimi\\kimi.json': JSON.stringify({ work_dirs: [{ path: workDir, kaos: 'local', last_session_id: 'sess-001' }] }),
    'D:\\demo\\kimi\\sessions': 'dir',
    ['D:\\demo\\kimi\\sessions\\' + hashDir]: 'dir',
    [sess]: 'dir',
    [sess + '\\wire.jsonl']: kimiWire([
      kimiEv('TurnBegin', { user_input: '帮我看看构建失败' }),
      kimiEv('StepBegin', { n: 1 }),
      kimiEv('TextPart', { text: '是缺少依赖。' }),
      kimiEv('TurnEnd'),
    ]),
    [sess + '\\state.json']: JSON.stringify({ version: 1, custom_title: 'Kimi 会话标题' }),
  }
  const { ctx, persistence, attached } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'kimi')
  const value = await def.execute({ path: sess })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-sess-001')
  assert.equal(value.turns, 1)
  assert.equal(value.messages, 2)
  assert.equal(value.toolCalls, 0)
  assert.equal(value.alreadyImported, false)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get('import-sess-001')
  assert.ok(saved)
  assert.equal(saved.meta.cwd, workDir) // kimi.json md5 映射
  assert.equal(saved.meta.sourceId, undefined)
  // 宿主 header 白名单不含 sourceId（写入路径按 released-v2 schema 严格校验，
  // 白名单外字段会让整次创建被拒）：源 id 只服务 registry 与导出协议，不落 header
  // 显式标题（state.json custom_title）钉 session/title 事件
  assert.equal(saved.events.at(-1).type, 'session/title')
  assert.equal(saved.events.at(-1).data.title, 'Kimi · Kimi 会话标题')
  assert.ok(saved.events.every((e, i) => e.seq === i))
  // 幂等键 = 会话目录路径
  assertEnvelopeHygiene(saved.events)
  assert.equal(attached.length, 1)
  assert.equal(attached[0].id, 'import-sess-001')
})

test('import_kimi 目录批量：递归扫 wire.jsonl、逐会话独立落盘、schema 校验', async () => {
  // 目录名与 kimi.json 里的 workDir 必须同源：产品按 kimi.json 的 path 算 hash 目录，
  // 二者分隔符不一致就会找不到会话（Windows 上尤为明显）
  const workDir = hostAbs('D:/demo/kimi-proj')
  const hashDir = kimiHash(workDir)
  const mkSession = (id) => ({
    ['D:\\demo\\kimi\\sessions\\' + hashDir + '\\' + id]: 'dir',
    ['D:\\demo\\kimi\\sessions\\' + hashDir + '\\' + id + '\\wire.jsonl']: kimiWire([
      kimiEv('TurnBegin', { user_input: '问题 ' + id }),
      kimiEv('StepBegin', { n: 1 }),
      kimiEv('TextPart', { text: '回答' }),
      kimiEv('TurnEnd'),
    ]),
    ['D:\\demo\\kimi\\sessions\\' + hashDir + '\\' + id + '\\state.json']: '{}',
  })
  const tree = {
    'D:\\demo\\kimi\\kimi.json': JSON.stringify({ work_dirs: [{ path: workDir, kaos: 'local' }] }),
    'D:\\demo\\kimi\\sessions': 'dir',
    ['D:\\demo\\kimi\\sessions\\' + hashDir]: 'dir',
    ...mkSession('sess-001'),
    ...mkSession('sess-002'),
    ['D:\\demo\\kimi\\sessions\\' + hashDir + '\\notes.txt']: 'not a session',
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'kimi')
  const value = await def.execute({ path: 'D:\\demo\\kimi\\sessions' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  const ids = [...persistence.sessions.keys()].sort()
  assert.deepEqual(ids, ['import-sess-001', 'import-sess-002'])
  // kimi.json 映射的 cwd 挂进两会话
  for (const id of ids) assert.equal(persistence.sessions.get(id).meta.cwd, workDir)
})

test('import_kimi 增量续写：wire.jsonl 增长 → appended 同一会话（REQ-24）', async () => {
  const hashDir = kimiHash('D:/demo/kimi-proj')
  const sess = 'D:\\demo\\kimi\\sessions\\' + hashDir + '\\sess-incr'
  const base = [
    kimiEv('TurnBegin', { user_input: '问题一' }),
    kimiEv('StepBegin', { n: 1 }),
    kimiEv('TextPart', { text: '回答一' }),
    kimiEv('TurnEnd'),
  ]
  const tree = {
    'D:\\demo\\kimi\\sessions': 'dir',
    ['D:\\demo\\kimi\\sessions\\' + hashDir]: 'dir',
    [sess]: 'dir',
    [sess + '\\wire.jsonl']: kimiWire(base),
    [sess + '\\state.json']: '{}',
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'kimi')
  const first = await def.execute({ path: sess })
  assert.equal(first.status, 'imported')
  const before = persistence.sessions.get('import-sess-incr').events.length

  tree[sess + '\\wire.jsonl'] = kimiWire([...base,
    kimiEv('TurnBegin', { user_input: '问题二' }),
    kimiEv('StepBegin', { n: 1 }),
    kimiEv('TextPart', { text: '回答二' }),
    kimiEv('TurnEnd'),
  ])
  const second = await def.execute({ path: sess })
  assert.equal(second.mode, 'single')
  assert.equal(second.status, 'appended')
  assert.equal(second.appendedTurns, 1)
  assert.ok(second.appendedEvents > 0)
  assert.equal(persistence.sessions.size, 1) // 同一会话续写
  const saved = persistence.sessions.get('import-sess-incr')
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assert.equal(saved.events.length, before + second.appendedEvents)
  assert.equal(saved.events.filter((e) => e.type === 'turn/start').length, 2)
  assert.equal(saved.events.filter((e) => e.type === 'session/title').length, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, second), [])
})

test('import_kimi 单 wire.jsonl 文件：mode single、kimiId 从父目录派生', async () => {
  const hashDir = kimiHash('D:/demo/kimi-proj')
  const wirePath = 'D:\\demo\\kimi\\sessions\\' + hashDir + '\\sess-f\\wire.jsonl'
  const tree = {
    [wirePath]: kimiWire([
      kimiEv('TurnBegin', { user_input: 'hi' }),
      kimiEv('StepBegin', { n: 1 }),
      kimiEv('TextPart', { text: 'hello' }),
      kimiEv('TurnEnd'),
    ]),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'kimi')
  const value = await def.execute({ path: wirePath })
  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-sess-f') // 父目录名作源 id
  assert.equal(value.status, 'imported')
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  assert.equal(persistence.sessions.size, 1)
})

test('import_kimi 非会话目录：批量跳过（无用户回合）', async () => {
  const tree = {
    'D:\\demo\\kimi\\sessions': 'dir',
    'D:\\demo\\kimi\\sessions\\empty-dir': 'dir',
    'D:\\demo\\kimi\\sessions\\notes.txt': 'not a session',
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'kimi')
  const value = await def.execute({ path: 'D:\\demo\\kimi\\sessions' })
  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 0)
  assert.equal(value.imported, 0)
  assert.equal(persistence.sessions.size, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('import_kimi dry-run 预览：preview 零副作用、0 skipped、清单字段', async () => {
  const hashDir = kimiHash('D:/demo/kimi-proj')
  const sess = 'D:\\demo\\kimi\\sessions\\' + hashDir + '\\sess-prev'
  const tree = {
    'D:\\demo\\kimi\\sessions': 'dir',
    ['D:\\demo\\kimi\\sessions\\' + hashDir]: 'dir',
    [sess]: 'dir',
    [sess + '\\wire.jsonl']: kimiWire([
      kimiEv('TurnBegin', { user_input: '问题' }),
      kimiEv('StepBegin', { n: 1 }),
      kimiEv('TextPart', { text: '回答' }),
      kimiEv('TurnEnd'),
    ]),
    [sess + '\\state.json']: '{}',
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'kimi')
  const value = await def.execute({ path: sess, preview: true })
  assert.equal(value.mode, 'single')
  assert.equal(value.preview, true)
  assert.equal(value.turns, 1)
  assert.equal(value.messages, 2)
  assert.equal(value.toolCalls, 0)
  assert.equal(value.skipped, 0)
  assert.equal(persistence.sessions.size, 0) // 零副作用：不落盘
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('import_kimi 新 Kimi Code 单会话目录：agents/main/wire.jsonl + state.json cwd/title', async () => {
  const sess = 'C:\\Users\\u\\.kimi-code\\sessions\\wd_nwflower_249d4b67aa09\\session-001'
  const tree = {
    'C:\\Users\\u\\.kimi-code\\sessions': 'dir',
    'C:\\Users\\u\\.kimi-code\\sessions\\wd_nwflower_249d4b67aa09': 'dir',
    [sess]: 'dir',
    [sess + '\\agents']: 'dir',
    [sess + '\\agents\\main']: 'dir',
    [sess + '\\agents\\main\\wire.jsonl']: kimiCodeWire([
      kimiCodeEv('turn.prompt', { input: [{ type: 'text', text: '帮我看看构建失败' }], origin: { kind: 'user' } }),
      kimiCodeEv('context.append_message', { message: { role: 'user', content: [{ type: 'text', text: '帮我看看构建失败' }], toolCalls: [], origin: { kind: 'user' }, id: 'msg_1' } }),
      kimiCodeEv('context.append_loop_event', { event: { type: 'step.begin', turnId: '0', step: 1 } }),
      kimiCodeEv('context.append_loop_event', { event: { type: 'content.part', part: { type: 'text', text: '是缺少依赖。' } } }),
      kimiCodeEv('context.append_loop_event', { event: { type: 'step.end', turnId: '0', step: 1, finishReason: 'end_turn' } }),
      kimiCodeEv('turn.ended', { turnId: 0, reason: 'completed' }),
    ]),
    [sess + '\\state.json']: JSON.stringify({ id: 'session-001', cwd: hostAbs('C:/Users/u/proj'), title: '新 Kimi Code 标题', isCustomTitle: true }),
  }
  const { ctx, persistence, attached } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'kimi')
  const value = await def.execute({ path: sess })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-session-001')
  assert.equal(value.status, 'imported')
  assert.equal(value.turns, 1)
  assert.equal(value.messages, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get('import-session-001')
  assert.ok(saved)
  assert.equal(saved.meta.cwd, hostAbs('C:/Users/u/proj')) // state.json.cwd
  assert.equal(saved.meta.sourceId, undefined)
  // 宿主 header 白名单不含 sourceId（写入路径按 released-v2 schema 严格校验，
  // 白名单外字段会让整次创建被拒）：源 id 只服务 registry 与导出协议，不落 header
  assert.equal(saved.events.at(-1).type, 'session/title')
  assert.equal(saved.events.at(-1).data.title, 'Kimi · 新 Kimi Code 标题') // isCustomTitle:true 钉标题
  assertEnvelopeHygiene(saved.events)
  assert.equal(attached.length, 1)
})

test('import_kimi 新 Kimi Code 目录批量：递归扫 agents/main/wire.jsonl', async () => {
  const mkSession = (id) => {
    const sess = 'C:\\Users\\u\\.kimi-code\\sessions\\wd_nwflower_249d4b67aa09\\' + id
    return {
      [sess]: 'dir',
      [sess + '\\agents']: 'dir',
      [sess + '\\agents\\main']: 'dir',
      [sess + '\\agents\\main\\wire.jsonl']: kimiCodeWire([
        kimiCodeEv('turn.prompt', { input: [{ type: 'text', text: '问题 ' + id }], origin: { kind: 'user' } }),
        kimiCodeEv('context.append_loop_event', { event: { type: 'step.begin', turnId: '0', step: 1 } }),
        kimiCodeEv('context.append_loop_event', { event: { type: 'content.part', part: { type: 'text', text: '回答' } } }),
        kimiCodeEv('context.append_loop_event', { event: { type: 'step.end', turnId: '0', step: 1, finishReason: 'end_turn' } }),
        kimiCodeEv('turn.ended', { turnId: 0, reason: 'completed' }),
      ]),
      [sess + '\\state.json']: JSON.stringify({ id, cwd: hostAbs('C:/Users/u/proj') }),
    }
  }
  const tree = {
    'C:\\Users\\u\\.kimi-code\\sessions': 'dir',
    'C:\\Users\\u\\.kimi-code\\sessions\\wd_nwflower_249d4b67aa09': 'dir',
    ...mkSession('session-001'),
    ...mkSession('session-002'),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'kimi')
  const value = await def.execute({ path: 'C:\\Users\\u\\.kimi-code\\sessions' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  const ids = [...persistence.sessions.keys()].sort()
  assert.deepEqual(ids, ['import-session-001', 'import-session-002'])
  for (const id of ids) assert.equal(persistence.sessions.get(id).meta.cwd, hostAbs('C:/Users/u/proj'))
})
