// legacy-repair.test.mjs — 存量旧形状的重导自愈（docs/architecture.md D26）
//
// 旧版转换器写出的日志缺 protected head / 标题引用未随事件重排重映射，宿主重启读取即
// 拒载（"title messageSeqs must name an earlier event"）；日志 append-only，升级插件不
// 修复存量，而「源未变」短路径连源都不读——用户升级后重导一次的自然动作被静默跳过。
// 这里锁定修复闸的完整语义：形状戳、一次性校验、D13 基线守卫下的 replace/copy 分流、
// 增长分支的续写前校验，以及 verify_session 对读不回日志的大声上报。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCtx, makePersistence } from './_support/fake-host.mjs'
import { hostAbs } from './_support/host-path.mjs'
import { convertDshJsonl } from '../lib/convert/dsh.mjs'
import { validateSessionEvents, legacyShapeProblems } from '../lib/convert/validate.mjs'
import {
  decideSingle, legacyShapeVerdict, rememberImport, loadImports,
  STORED_SHAPE_VERSION, mintForceSessionId,
} from '../lib/imports.mjs'
import { singleShortPath, singleShortPathChecked } from '../lib/import-state.mjs'
import { importTranscript } from '../lib/import-core.mjs'
import { verifySession } from '../lib/verify.mjs'

const MS = 1700000000000
let dir

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-legacy-repair-'))
  // replace 的工件清理按 $DSH_HOME/sessions 扫描（out-of-band）：指到临时目录，
  // 不碰真实宿主数据；fake persistence 的 remove 面负责内存索引。
  process.env.DSH_HOME = dir
})

const ev = (type, seq, data, extra = {}) => ({ type, seq, time: MS + seq, data, ...extra })

// 合成 DSH 源日志（V3 形状）：运行时 head + 人类提问 + 工具配对 + fallback/provider 标题。
// turns 控制轮数（增长分支用）。标题紧跟首问——真实宿主的 fallback 标题就写在那里，
// 旧版转换器不重映射引用时，丢弃事件后引用越位，正是 issue 里的报错形状。
function sourceRaw(turns = 1) {
  const recs = [
    { type: 'session', id: 'session-legacy', createdAt: MS, cwd: hostAbs('D:/Work/Proj') },
    ev('request/header', 0, { header: { config: { provider: 'dsh', model: 'm' } } }),
    ev('turn/start', 1, { turn: 1 }),
    ev('step/start', 2, { turn: 1, step: 1 }),
    ev('system/message', 3, { turn: 1, step: 1, message: { id: 'sys', role: 'system', content: [], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } } }, { surfaceOp: 'append' }),
    ev('user/message', 4, { id: 'u1', role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    ev('session/title', 5, { title: '打招呼', messageSeqs: [4], source: { kind: 'fallback' } }),
    ev('assistant/message', 6, { turn: 1, step: 1, stream: [], message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '好' }], source: { kind: 'model', provider: 'dsh', model: 'm' } } }, { surfaceOp: 'append' }),
    ev('step/end', 7, { turn: 1, step: 1 }),
    ev('turn/end', 8, { turn: 1, reason: { kind: 'completed' } }),
  ]
  if (turns >= 2) {
    recs.push(
      ev('turn/start', 9, { turn: 2 }),
      ev('step/start', 10, { turn: 2, step: 1 }),
      ev('user/message', 11, { id: 'u2', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
      ev('assistant/message', 12, { turn: 2, step: 1, stream: [], message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: '嗯' }], source: { kind: 'model', provider: 'dsh', model: 'm' } } }, { surfaceOp: 'append' }),
      ev('step/end', 13, { turn: 2, step: 1 }),
      ev('turn/end', 14, { turn: 2, reason: { kind: 'completed' } }),
    )
  }
  return recs.map((r) => JSON.stringify(r)).join('\n')
}

function cleanConverted(turns = 1) {
  return convertDshJsonl(sourceRaw(turns), { sourcePath: 'D:/src/session.jsonl' })
}

// 旧版产物形状：标题引用未重映射（指向不存在的 seq）——宿主读取/迁移 fail-closed 拒载。
function corruptEvents(events) {
  return events.map((e) => {
    if (e.type === 'session/title' && e.data.source && e.data.source.kind !== 'user') {
      return { ...e, data: { ...e.data, messageSeqs: [999] } }
    }
    return e
  })
}

// 种一条会话进 fake persistence（meta 带 version 供代次探测）
function seedSession(persistence, id, events, version = 3) {
  persistence.sessions.set(id, { meta: { id, version, createdAt: MS, isSeeded: false, delegationDepth: 0 }, events })
}

// 与源 stat 对齐的 registry 记录（短路径成立的前提）；extra 覆盖 shape/storedEvents 等。
async function seedRecord(ctx, sourcePath, dshId, converted, extra = {}) {
  const stat = await ctx.fs.stat(await ctx.fs.resolve(sourcePath))
  const record = {
    kind: 'single',
    dshId,
    turns: converted.turns.length,
    events: converted.events.length,
    storedEvents: converted.events.length,
    sizeBytes: stat.size,
    version: stat.version,
    args: '[]',
    importedAt: MS,
    ...extra,
  }
  await rememberImport(dir, sourcePath, record)
  return { record, stat }
}

const callsOf = (persistence, name) => persistence.calls.filter((c) => c === name).length

// ── 共用判定件 ──────────────────────────────────────────────────

test('legacyShapeProblems：干净日志不报；坏标题引用 / 缺 head 点名', () => {
  const clean = cleanConverted().events
  assert.deepEqual(legacyShapeProblems(clean), [])
  assert.equal(validateSessionEvents(clean).ok, true)
  const badTitle = legacyShapeProblems(corruptEvents(clean))
  assert.ok(badTitle.some((p) => p.kind === 'title-message-seqs'))
  const noHead = clean.filter((e) => e.type !== 'system/message')
  assert.ok(legacyShapeProblems(noHead).some((p) => p.kind === 'system-head-missing'))
})

test('legacyShapeVerdict：healthy / corrupt / unreadable / no-read-face 四态', async () => {
  const clean = cleanConverted().events
  const persistence = makePersistence()
  const { ctx } = makeCtx({}, { persistence })
  seedSession(persistence, 's-clean', clean)
  seedSession(persistence, 's-bad', corruptEvents(clean))
  seedSession(persistence, 's-ghost', clean)
  persistence.ghost('s-ghost')
  assert.equal((await legacyShapeVerdict(ctx, 's-clean')).verdict, 'healthy')
  assert.equal((await legacyShapeVerdict(ctx, 's-bad')).verdict, 'corrupt')
  assert.equal((await legacyShapeVerdict(ctx, 's-ghost')).verdict, 'unreadable')
  const noRead = makePersistence({ omit: ['readFrom', 'inspect'] })
  const { ctx: ctx2 } = makeCtx({}, { persistence: noRead })
  seedSession(noRead, 's-clean', clean)
  assert.equal((await legacyShapeVerdict(ctx2, 's-clean')).verdict, 'no-read-face')
})

// ── 短路径闸 ────────────────────────────────────────────────────

test('短路径闸：有形状戳 → 原样跳过，不读目标日志', async () => {
  const converted = cleanConverted()
  const persistence = makePersistence()
  const { ctx } = makeCtx({ 'D:/src/session.jsonl': sourceRaw() }, { persistence })
  seedSession(persistence, 'import-session-legacy', converted.events)
  const { record, stat } = await seedRecord(ctx, 'D:/src/session.jsonl', 'import-session-legacy', converted, { shape: STORED_SHAPE_VERSION })
  const skip = await singleShortPathChecked(ctx, record, {}, '[]', stat, { registryDir: dir, sourcePath: 'D:/src/session.jsonl' })
  assert.equal(skip.status, 'already-imported')
  assert.equal(callsOf(persistence, 'readFrom'), 0, '有戳记录不多读')
})

test('短路径闸：无戳旧记录 + 日志干净 → 跳过并一次性补戳（此后不再读）', async () => {
  const converted = cleanConverted()
  const persistence = makePersistence()
  const { ctx } = makeCtx({ 'D:/src/session.jsonl': sourceRaw() }, { persistence })
  seedSession(persistence, 'import-session-legacy', converted.events)
  const { record, stat } = await seedRecord(ctx, 'D:/src/session.jsonl', 'import-session-legacy', converted)
  const skip = await singleShortPathChecked(ctx, record, {}, '[]', stat, { registryDir: dir, sourcePath: 'D:/src/session.jsonl' })
  assert.equal(skip.status, 'already-imported')
  assert.equal(record.shape, STORED_SHAPE_VERSION)
  const loaded = await loadImports(dir)
  assert.equal(loaded.imports['D:/src/session.jsonl'].shape, STORED_SHAPE_VERSION, '补戳写回 registry')
  persistence.calls.length = 0
  const again = await singleShortPathChecked(ctx, loaded.imports['D:/src/session.jsonl'], {}, '[]', stat, { registryDir: dir, sourcePath: 'D:/src/session.jsonl' })
  assert.equal(again.status, 'already-imported')
  assert.equal(callsOf(persistence, 'readFrom'), 0, '补戳后与有戳记录同口径')
})

test('短路径闸：无戳 + 坏日志 + 纯镜像（实测==基线）→ 放行并标记 replace', async () => {
  const converted = cleanConverted()
  const persistence = makePersistence()
  const { ctx } = makeCtx({ 'D:/src/session.jsonl': sourceRaw() }, { persistence })
  seedSession(persistence, 'import-session-legacy', corruptEvents(converted.events))
  const { record, stat } = await seedRecord(ctx, 'D:/src/session.jsonl', 'import-session-legacy', converted)
  const skip = await singleShortPathChecked(ctx, record, {}, '[]', stat, { registryDir: dir, sourcePath: 'D:/src/session.jsonl' })
  assert.equal(skip, null, '放行完整重导')
  assert.equal(record.__repair, 'replace')
})

test('短路径闸：无戳 + 坏日志 + 已被续聊（实测>基线）→ 保守标记 copy', async () => {
  const converted = cleanConverted()
  const persistence = makePersistence()
  const { ctx } = makeCtx({ 'D:/src/session.jsonl': sourceRaw() }, { persistence })
  const stored = [...corruptEvents(converted.events), ev('turn/start', converted.events.length, { turn: 99 })]
  seedSession(persistence, 'import-session-legacy', stored)
  const { record, stat } = await seedRecord(ctx, 'D:/src/session.jsonl', 'import-session-legacy', converted)
  const skip = await singleShortPathChecked(ctx, record, {}, '[]', stat, { registryDir: dir, sourcePath: 'D:/src/session.jsonl' })
  assert.equal(skip, null)
  assert.equal(record.__repair, 'copy', '用户续聊过的日志绝不原地重建')
})

test('短路径闸：无戳 + 读不回（当前宿主上损坏即读不回）→ 保守标记 copy', async () => {
  const converted = cleanConverted()
  const persistence = makePersistence()
  const { ctx } = makeCtx({ 'D:/src/session.jsonl': sourceRaw() }, { persistence })
  seedSession(persistence, 'import-session-legacy', converted.events)
  persistence.ghost('import-session-legacy')
  const { record, stat } = await seedRecord(ctx, 'D:/src/session.jsonl', 'import-session-legacy', converted)
  const skip = await singleShortPathChecked(ctx, record, {}, '[]', stat, { registryDir: dir, sourcePath: 'D:/src/session.jsonl' })
  assert.equal(skip, null)
  assert.equal(record.__repair, 'copy', '无法检查的日志绝不销毁')
})

test('短路径闸：宿主没有读事件面 → 维持原跳过语义（不盖章不修复）', async () => {
  const converted = cleanConverted()
  const persistence = makePersistence({ omit: ['readFrom', 'inspect'] })
  const { ctx } = makeCtx({ 'D:/src/session.jsonl': sourceRaw() }, { persistence })
  seedSession(persistence, 'import-session-legacy', converted.events)
  const { record, stat } = await seedRecord(ctx, 'D:/src/session.jsonl', 'import-session-legacy', converted)
  const skip = await singleShortPathChecked(ctx, record, {}, '[]', stat, { registryDir: dir, sourcePath: 'D:/src/session.jsonl' })
  assert.equal(skip.status, 'already-imported')
  assert.equal(record.shape, undefined)
  assert.equal(record.__repair, undefined)
})

test('短路径闸：force / replace 不受闸影响（恒放行重转）', async () => {
  const converted = cleanConverted()
  const persistence = makePersistence()
  const { ctx } = makeCtx({ 'D:/src/session.jsonl': sourceRaw() }, { persistence })
  seedSession(persistence, 'import-session-legacy', corruptEvents(converted.events))
  const { record, stat } = await seedRecord(ctx, 'D:/src/session.jsonl', 'import-session-legacy', converted)
  assert.equal(await singleShortPathChecked(ctx, record, { force: true }, '[]', stat, { registryDir: dir }), null)
  assert.equal(record.__repair, undefined, 'force 走显式重导，不挂修复标记')
  assert.equal(singleShortPath(record, { replace: true }, '[]', stat), null)
})

// ── 决策层消费修复标记 ──────────────────────────────────────────

test('decideSingle：__repair=replace → 同 id 重建（status replaced + repaired 报告 + 盖章）', async () => {
  const converted = cleanConverted()
  const persistence = makePersistence()
  const { ctx } = makeCtx({}, { persistence })
  const known = {
    kind: 'single', dshId: 'import-session-legacy', turns: 1, events: converted.events.length,
    storedEvents: converted.events.length, __repair: 'replace',
  }
  const decision = await decideSingle(ctx, {
    known, converted, stat: null, args: {}, fingerprint: '[]',
    persisted: new Set(['import-session-legacy']), sourcePath: 'D:/src/session.jsonl',
    budget: 0, archivedIds: new Set(), importFormat: 'dsh',
  })
  assert.equal(decision.status, 'replaced')
  assert.equal(decision.sessionId, 'import-session-legacy')
  assert.equal(decision.repaired, 'legacy-shape')
  assert.equal(decision.__action, 'replace')
  assert.equal(decision.__record.shape, STORED_SHAPE_VERSION)
})

test('decideSingle：__repair=copy → 另铸副本，旧会话收进 copies（reason legacy-shape）', async () => {
  const converted = cleanConverted()
  const persistence = makePersistence()
  const { ctx } = makeCtx({}, { persistence })
  const known = {
    kind: 'single', dshId: 'import-session-legacy', turns: 1, events: converted.events.length,
    storedEvents: converted.events.length, __repair: 'copy',
  }
  const persisted = new Set(['import-session-legacy'])
  const decision = await decideSingle(ctx, {
    known, converted, stat: null, args: {}, fingerprint: '[]',
    persisted, sourcePath: 'D:/src/session.jsonl',
    budget: 0, archivedIds: new Set(), importFormat: 'dsh',
  })
  const newId = mintForceSessionId(persisted, converted.meta.id)
  assert.equal(decision.status, 'imported')
  assert.equal(decision.sessionId, newId)
  assert.equal(decision.repaired, 'legacy-shape')
  assert.deepEqual(decision.reimported, { previous: 'import-session-legacy', current: newId, reason: 'legacy-shape' })
  assert.ok(decision.__record.copies.some((c) => c.dshId === 'import-session-legacy'), '旧会话不丢账')
})

// ── 增长分支：续写前的一次性校验 ────────────────────────────────

async function growthDecision(persistence, storedEvents, extra = {}, { ghost = false } = {}) {
  const converted = cleanConverted(2)
  const { ctx } = makeCtx({}, { persistence })
  seedSession(persistence, 'import-session-legacy', storedEvents)
  if (ghost) persistence.ghost('import-session-legacy')
  const known = {
    kind: 'single', dshId: 'import-session-legacy', turns: 1,
    events: storedEvents.length, storedEvents: storedEvents.length, ...extra,
  }
  return decideSingle(ctx, {
    known, converted, stat: null, args: {}, fingerprint: '[]',
    persisted: new Set(['import-session-legacy']), sourcePath: 'D:/src/session.jsonl',
    budget: 0, archivedIds: new Set(), importFormat: 'dsh',
  })
}

test('增长分支：无戳 + 存量干净 → 照常续写并盖章', async () => {
  const head = cleanConverted(1).events
  const decision = await growthDecision(makePersistence(), head)
  assert.equal(decision.status, 'appended')
  assert.equal(decision.__action, 'append')
  assert.equal(decision.__record.shape, STORED_SHAPE_VERSION)
})

test('增长分支：无戳 + 存量损坏（纯镜像）→ 修复 replace，不续写坏日志', async () => {
  const head = corruptEvents(cleanConverted(1).events)
  const decision = await growthDecision(makePersistence(), head)
  assert.equal(decision.status, 'replaced')
  assert.equal(decision.repaired, 'legacy-shape')
  assert.equal(decision.__action, 'replace')
})

test('增长分支：无戳 + 存量损坏且已续聊 → 修复 copy', async () => {
  const head = cleanConverted(1).events
  const stored = [...corruptEvents(head), ev('turn/start', head.length, { turn: 99 })]
  const decision = await growthDecision(makePersistence(), stored, { storedEvents: head.length })
  assert.equal(decision.status, 'imported')
  assert.equal(decision.reimported.reason, 'legacy-shape')
})

test('增长分支：无戳 + 读不回 → 修复 copy；无读面 → 原 appendedSkipped 语义', async () => {
  const head = cleanConverted(1).events
  const d1 = await growthDecision(makePersistence(), head, {}, { ghost: true })
  assert.equal(d1.status, 'imported')
  assert.equal(d1.reimported.reason, 'legacy-shape')

  const p2 = makePersistence({ omit: ['readFrom', 'inspect'] })
  const d2 = await growthDecision(p2, head)
  assert.equal(d2.status, 'already-imported')
  assert.equal(d2.appendedSkipped, 'stored-length-unknown')
})

test('增长分支：有戳记录不做存量校验（既有续写口径不变）', async () => {
  const head = cleanConverted(1).events
  const persistence = makePersistence()
  const decision = await growthDecision(persistence, head, { shape: STORED_SHAPE_VERSION })
  assert.equal(decision.status, 'appended')
})

// ── 跳过类分支不盖章 ────────────────────────────────────────────

test('源未变但 stat 指纹变化（轮数事件数相等）：already-imported 保留无戳状态', async () => {
  const converted = cleanConverted()
  const persistence = makePersistence()
  const { ctx } = makeCtx({}, { persistence })
  const known = {
    kind: 'single', dshId: 'import-session-legacy', turns: converted.turns.length,
    events: converted.events.length, storedEvents: converted.events.length,
  }
  const decision = await decideSingle(ctx, {
    known, converted, stat: null, args: {}, fingerprint: '[]',
    persisted: new Set(['import-session-legacy']), sourcePath: 'D:/src/session.jsonl',
    budget: 0, archivedIds: new Set(), importFormat: 'dsh',
  })
  assert.equal(decision.status, 'already-imported')
  assert.equal(decision.__record.shape, undefined, '未验证的日志不能借跳过分支盖章')
})

// ── 端到端：importTranscript 自愈 ───────────────────────────────

test('端到端：坏日志 + 源未变 → 普通重导原地重建，产物过结构校验；二次重导 cheap skip', async () => {
  const raw = sourceRaw()
  const converted = cleanConverted()
  const persistence = makePersistence()
  const { ctx, reads } = makeCtx({ 'D:/src/session.jsonl': raw }, { persistence })
  const dshId = converted.meta.id
  seedSession(persistence, dshId, corruptEvents(converted.events))
  await seedRecord(ctx, 'D:/src/session.jsonl', dshId, converted)

  const target = await ctx.fs.resolve('D:/src/session.jsonl')
  const res = await importTranscript(ctx, target, {}, (text, args) => convertDshJsonl(text, args), {
    registryDir: dir, importFormat: 'dsh', sourceLabel: 'DSH',
  })
  assert.equal(res.status, 'replaced')
  assert.equal(res.repaired, 'legacy-shape')
  assert.equal(res.sessionId, dshId, '纯镜像同 id 重建')
  const stored = persistence.sessions.get(dshId).events
  assert.deepEqual(legacyShapeProblems(stored), [], '重建产物无旧形状')
  assert.equal(validateSessionEvents(stored).ok, true)
  const record = (await loadImports(dir)).imports['D:/src/session.jsonl']
  assert.equal(record.shape, STORED_SHAPE_VERSION)
  assert.equal(record.storedEvents, stored.length, '基线刷新为实测长度')

  persistence.calls.length = 0
  const readsBefore = reads.count
  const again = await importTranscript(ctx, target, {}, (text, args) => convertDshJsonl(text, args), {
    registryDir: dir, importFormat: 'dsh', sourceLabel: 'DSH',
  })
  assert.equal(again.status, 'already-imported')
  assert.equal(reads.count, readsBefore, '源未变不重读源')
  assert.equal(callsOf(persistence, 'readFrom'), 0, '已盖章不再读目标日志')
})

test('端到端：坏日志 + 已续聊 → 普通重导另铸干净副本，旧会话原样保留', async () => {
  const raw = sourceRaw()
  const converted = cleanConverted()
  const persistence = makePersistence()
  const { ctx } = makeCtx({ 'D:/src/session.jsonl': raw }, { persistence })
  const dshId = converted.meta.id
  const corrupt = corruptEvents(converted.events)
  const stored = [...corrupt, ev('turn/start', corrupt.length, { turn: 99 })]
  seedSession(persistence, dshId, stored)
  await seedRecord(ctx, 'D:/src/session.jsonl', dshId, converted) // storedEvents = 转换口径长度 < 实测

  const target = await ctx.fs.resolve('D:/src/session.jsonl')
  const res = await importTranscript(ctx, target, {}, (text, args) => convertDshJsonl(text, args), {
    registryDir: dir, importFormat: 'dsh', sourceLabel: 'DSH',
  })
  assert.equal(res.status, 'imported')
  assert.equal(res.repaired, 'legacy-shape')
  assert.notEqual(res.sessionId, dshId)
  assert.deepEqual(res.reimported, { previous: dshId, current: res.sessionId, reason: 'legacy-shape' })
  assert.deepEqual(persistence.sessions.get(dshId).events, stored, '旧日志一字节不动')
  assert.deepEqual(legacyShapeProblems(persistence.sessions.get(res.sessionId).events), [])
  const record = (await loadImports(dir)).imports['D:/src/session.jsonl']
  assert.ok(record.copies.some((c) => c.dshId === dshId))
})

test('端到端：legacy 字符串记录回填不盖章（下次重导才校验）', async () => {
  const raw = sourceRaw()
  const converted = cleanConverted()
  const persistence = makePersistence()
  const { ctx } = makeCtx({ 'D:/src/session.jsonl': raw }, { persistence })
  const dshId = converted.meta.id
  seedSession(persistence, dshId, converted.events)
  await rememberImport(dir, 'D:/src/session.jsonl', dshId) // 旧格式：纯字符串记录

  const target = await ctx.fs.resolve('D:/src/session.jsonl')
  const res = await importTranscript(ctx, target, {}, (text, args) => convertDshJsonl(text, args), {
    registryDir: dir, importFormat: 'dsh', sourceLabel: 'DSH',
  })
  assert.equal(res.status, 'already-imported')
  assert.equal(res.backfilled, true)
  const record = (await loadImports(dir)).imports['D:/src/session.jsonl']
  assert.equal(record.shape, undefined, '回填只记账，存量日志未经校验不盖章')
})

// ── verify_session：读不回不再静默 ──────────────────────────────

test('verifySession：日志读不回 → ok:false + stored-log-unreadable + 修复提示', async () => {
  const persistence = makePersistence()
  const { ctx } = makeCtx({}, { persistence })
  seedSession(persistence, 's-bad', cleanConverted().events)
  persistence.ghost('s-bad')
  const out = await verifySession(ctx, { sessionId: 's-bad' })
  assert.equal(out.ok, false)
  assert.equal(out.problems[0].kind, 'stored-log-unreadable')
  assert.ok(out.repairHints.some((h) => h.kind === 'stored-log-unreadable' && /force:true/.test(h.hint)))
})

test('verifySession：干净会话仍 ok:true（新上报不误伤）', async () => {
  const persistence = makePersistence()
  const { ctx } = makeCtx({}, { persistence })
  seedSession(persistence, 's-ok', cleanConverted().events)
  const out = await verifySession(ctx, { sessionId: 's-ok' })
  assert.equal(out.ok, true)
})