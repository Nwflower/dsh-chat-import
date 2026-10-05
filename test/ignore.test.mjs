// ignore.test.mjs — 忽略（墓碑）表：存储 / 判定 / 决策接入 / 归档与删工作区监听。
// 自包含：真实 ignores.json（临时目录）+ 真实 decideSingle / decideMulti + 轻量 fake ctx。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findIgnore,
  findWorkspaceIgnore,
  forgetIgnoreByDshId,
  forgetWorkspaceIgnore,
  ignoreDecisionFor,
  listIgnores,
  loadIgnores,
  normalizeCwd,
  rememberIgnore,
  rememberWorkspaceIgnore,
  sourceIgnoreKey,
} from '../lib/ignore.mjs'
import { decideMulti, decideSingle, rememberImport } from '../lib/imports.mjs'
import { registerIgnoreWatch } from '../lib/ignore-watch.mjs'

let dir

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ignore-'))
})

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 轮询直到条件满足（监听链是异步串行的，测试不做假定时器）
async function waitFor(fn, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await delay(20)
  }
}

function fakeCtx() {
  return { get: () => undefined }
}

function convertedFor(sessionId, cwd, turns = 2) {
  return {
    meta: { id: 'import-' + sessionId, cwd },
    turns: Array.from({ length: turns }, (_, i) => ({ turn: i + 1 })),
    messages: turns * 2,
    toolCalls: 0,
    skipped: 0,
    events: [{ type: 'turn/start', seq: 0, data: { turn: 1 } }],
  }
}

// ── 存储与键 ────────────────────────────────────────────────────

test('sourceIgnoreKey / normalizeCwd 口径', () => {
  assert.equal(sourceIgnoreKey('D:\\a\\opencode.db'), 'D:\\a\\opencode.db')
  assert.equal(sourceIgnoreKey('D:\\a\\opencode.db', 'sessions', 'ses_1'), 'D:\\a\\opencode.db#sessions:ses_1')
  assert.equal(normalizeCwd('D:/Work/Proj/'), 'd:\\work\\proj')
})

test('忽略表读写往返：源墓碑 / 按 dshId 解除 / 工作区记录', async () => {
  await rememberIgnore(dir, { key: 'D:\\a\\db#sessions:ses_1', reason: 'archived', dshId: 'import-x' })
  await rememberWorkspaceIgnore(dir, 'D:\\Work\\Proj', ['D:\\a\\db#sessions:ses_1'])

  const loaded = await loadIgnores(dir)
  assert.equal(findIgnore(loaded, 'D:\\a\\db', 'sessions', 'ses_1').reason, 'archived')
  assert.equal(findIgnore(loaded, 'D:\\a\\db', 'sessions', 'ses_2'), undefined)
  assert.deepEqual(findWorkspaceIgnore(loaded, 'D:/work/proj/').sessionKeys, ['D:\\a\\db#sessions:ses_1'])

  await forgetIgnoreByDshId(dir, 'import-x')
  assert.equal(findIgnore(await loadIgnores(dir), 'D:\\a\\db', 'sessions', 'ses_1'), undefined)

  await rememberIgnore(dir, { key: 'D:\\a\\db', reason: 'retracted' })
  assert.equal(findIgnore(await loadIgnores(dir), 'D:\\a\\db', 'sessions', 'ses_9').reason, 'retracted', '整源键兜底命中子会话')

  await forgetWorkspaceIgnore(dir, 'D:\\Work\\Proj')
  assert.equal(findWorkspaceIgnore(await loadIgnores(dir), 'D:\\Work\\Proj'), undefined)
  assert.equal(listIgnores(await loadIgnores(dir)).length, 1)
})

test('ignoreDecisionFor：源命中跳过；工作区旧会话跳过、新会话放行并回报恢复', async () => {
  await rememberIgnore(dir, { key: 'D:\\a\\db#sessions:ses_1', reason: 'retracted' })
  await rememberWorkspaceIgnore(dir, 'D:\\Work\\Proj', ['D:\\a\\db#sessions:ses_old'])
  const ignores = await loadIgnores(dir)

  const hit = ignoreDecisionFor({ ignores, sourcePath: 'D:\\a\\db', subTable: 'sessions', subKey: 'ses_1', cwd: 'D:\\Work\\Proj' })
  assert.equal(hit.skipped, true)
  assert.equal(hit.reason, 'retracted')

  const oldSession = ignoreDecisionFor({ ignores, sourcePath: 'D:\\a\\db', subTable: 'sessions', subKey: 'ses_old', cwd: 'D:\\Work\\Proj' })
  assert.equal(oldSession.skipped, true, '删除时已存在的会话继续跳过')
  assert.equal(oldSession.reason, 'workspace-deleted')

  const newSession = ignoreDecisionFor({ ignores, sourcePath: 'D:\\a\\db', subTable: 'sessions', subKey: 'ses_new', cwd: 'D:\\Work\\Proj' })
  assert.equal(newSession.skipped, false)
  assert.equal(newSession.restoreWorkspace, 'd:\\work\\proj')

  const otherCwd = ignoreDecisionFor({ ignores, sourcePath: 'D:\\a\\db', subTable: 'sessions', subKey: 'ses_other', cwd: 'D:\\Work\\B' })
  assert.equal(otherCwd.skipped, false, '其它目录不受影响')
})

// ── 决策接入 ────────────────────────────────────────────────────

test('decideSingle：墓碑命中跳过且不产出记录；force 显式越权放行', async () => {
  await rememberIgnore(dir, { key: 'D:\\src\\a.jsonl', reason: 'retracted' })
  const converted = convertedFor('ses_a', 'D:\\Work\\A')
  const ignored = await decideSingle(fakeCtx(), {
    known: null, converted, stat: null, args: {}, fingerprint: 'f', persisted: new Set(),
    sourcePath: 'D:\\src\\a.jsonl', budget: 0, archivedIds: new Set(), importFormat: 'claude',
  })
  assert.equal(ignored.status, 'ignored')
  assert.equal(ignored.reason, 'retracted', '原因码结构化透出：面板 / 工具层据此点名被什么挡住')
  assert.equal(ignored.skipReason, 'ignored:retracted')
  assert.equal(ignored.__record, undefined, '忽略不覆盖 registry 记录')

  const forced = await decideSingle(fakeCtx(), {
    known: null, converted, stat: null, args: { force: true }, fingerprint: 'f', persisted: new Set(),
    sourcePath: 'D:\\src\\a.jsonl', budget: 0, archivedIds: new Set(), importFormat: 'claude',
  })
  assert.equal(forced.status, 'imported')
  assert.equal(forced.__action, 'create')
})

test('decideMulti：命中子会话跳过并保留已知记录，其余照常导入', async () => {
  const sourcePath = 'D:\\src\\opencode.db'
  await rememberIgnore(dir, { key: sourceIgnoreKey(sourcePath, 'sessions', 'ses_old'), reason: 'archived', dshId: 'import-old' })
  const known = { kind: 'multi', sessions: { ses_old: { dshId: 'import-old', turns: 2, events: 6 } } }
  const decision = await decideMulti(fakeCtx(), {
    known,
    items: [
      { key: 'ses_old', converted: convertedFor('ses_old', 'D:\\Work\\A') },
      { key: 'ses_new', converted: convertedFor('ses_new', 'D:\\Work\\A') },
    ],
    stat: null, args: {}, fingerprint: 'f', persisted: new Set(['import-old']),
    sourcePath, subTable: 'sessions', budget: 0, archivedIds: new Set(), importFormat: 'opencode',
  })
  // 忽略不再混进 skipped：计数分开，否则「跳过 1」会把「一个会话都没建」读成已处理
  assert.equal(decision.skipped, 0)
  assert.equal(decision.ignored, 1)
  assert.equal(decision.imported, 1)
  assert.deepEqual(decision.results.find((r) => r.sessionId === 'import-old'), {
    path: sourcePath, status: 'ignored', sessionId: 'import-old', reason: 'archived',
  })
  assert.deepEqual(decision.__record.sessions.ses_old, { dshId: 'import-old', turns: 2, events: 6 }, '忽略子会话的已知记录不被覆盖丢账')
  assert.equal(decision.__creates.length, 1)
  assert.equal(decision.__creates[0].key, 'ses_new')
})

test('decideSingle：被删工作区的新会话放行并回报 __restoreWorkspaces', async () => {
  await rememberWorkspaceIgnore(dir, 'D:\\Work\\A', ['D:\\src\\a.jsonl'])
  const decision = await decideSingle(fakeCtx(), {
    known: null, converted: convertedFor('ses_a', 'D:\\Work\\A'), stat: null, args: {}, fingerprint: 'f',
    persisted: new Set(), sourcePath: 'D:\\src\\another.jsonl', budget: 0, archivedIds: new Set(), importFormat: 'claude',
  })
  assert.equal(decision.status, 'imported')
  assert.deepEqual(decision.__restoreWorkspaces, ['d:\\work\\a'])
})

// ── 归档 / 删工作区监听 ─────────────────────────────────────────

function watchHarness({ workspaces, archived = [] }) {
  const handlers = []
  const registry = {
    list: () => workspaces.map((w) => ({ id: w.id, path: w.path, sessionIds: [...w.sessionIds] })),
    archivedSessionIds: [...archived],
  }
  const ctx = {
    get: (name) => (name === 'workspaceRegistry' ? registry : undefined),
    on: (name, fn) => handlers.push({ name, fn }),
  }
  return {
    ctx,
    registry,
    emit: (change) => {
      for (const h of handlers) if (h.name === 'domain/changed') h.fn(change)
    },
  }
}

const changeGlobal = (archivedIds) => ({ domain: 'workspace', table: '', key: '', operation: 'put', value: { archivedSessionIds: archivedIds } })

test('归档 → 打墓碑；取消归档 → 解除并恢复工作区忽略', async () => {
  const sourcePath = 'D:\\src\\opencode.db'
  await rememberImport(dir, sourcePath, { kind: 'multi', sessions: { ses_1: { dshId: 'import-1', turns: 1, events: 3 } } })
  const h = watchHarness({ workspaces: [{ id: 'ws1', path: 'D:\\Work\\A', sessionIds: ['import-1'] }], archived: [] })
  registerIgnoreWatch(h.ctx, dir)

  h.emit(changeGlobal(['import-1']))
  await waitFor(async () => findIgnore(await loadIgnores(dir), sourcePath, 'sessions', 'ses_1'))

  h.emit(changeGlobal([]))
  await waitFor(async () => (findIgnore(await loadIgnores(dir), sourcePath, 'sessions', 'ses_1') ? undefined : true))
})

test('删工作区 → 名下导入会话打墓碑 + 工作区记录；新会话出现 → 工作区记录解除', async () => {
  const sourcePath = 'D:\\src\\opencode.db'
  await rememberImport(dir, sourcePath, { kind: 'multi', sessions: { ses_1: { dshId: 'import-1', turns: 1, events: 3 } } })
  const h = watchHarness({ workspaces: [{ id: 'ws1', path: 'D:\\Work\\A', sessionIds: ['import-1'] }] })
  registerIgnoreWatch(h.ctx, dir)

  h.emit({ domain: 'workspace', table: 'workspaces', key: 'ws1', operation: 'deleted' })
  await waitFor(async () => {
    const ignores = await loadIgnores(dir)
    return findIgnore(ignores, sourcePath, 'sessions', 'ses_1') && findWorkspaceIgnore(ignores, 'D:\\Work\\A')
  })

  // 新会话（不在删除时快照里）→ 判定放行并回报恢复
  const verdict = ignoreDecisionFor({
    ignores: await loadIgnores(dir), sourcePath, subTable: 'sessions', subKey: 'ses_new', cwd: 'D:\\Work\\A',
  })
  assert.equal(verdict.skipped, false)
  assert.equal(verdict.restoreWorkspace, 'd:\\work\\a')
})

test('忽略表损坏按空表处理，不抛错（损坏文件保持原样）', async () => {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(dir, 'ignores.json'), '{ not json', 'utf8')
  const ignores = await loadIgnores(dir)
  assert.deepEqual(ignores.sources, {})
  assert.match(readFileSync(join(dir, 'ignores.json'), 'utf8'), /not json/)
})

test('rememberIgnore：同内容重复登记不改写忽略表，返回是否有变化', async () => {
  const key = 'D:\src\a.jsonl'
  assert.equal(await rememberIgnore(dir, { key, reason: 'archived', dshId: 'import-a' }), true)
  const written = readFileSync(join(dir, 'ignores.json'), 'utf8')
  await delay(5)
  assert.equal(await rememberIgnore(dir, { key, reason: 'archived', dshId: 'import-a' }), false)
  assert.equal(readFileSync(join(dir, 'ignores.json'), 'utf8'), written, '无变化不写盘（登记时间保持首次）')
  assert.equal(await rememberIgnore(dir, { key, reason: 'retracted', dshId: 'import-a' }), true)
  assert.equal((await loadIgnores(dir)).sources[key].reason, 'retracted')
})

test('启动补墓碑幂等：已在归档态的会话重复启动不改写 ignores.json', async () => {
  await rememberImport(dir, 'D:\src\a.jsonl', { kind: 'single', dshId: 'import-a', turns: 1, events: 2 })
  await rememberImport(dir, 'D:\src\b.jsonl', { kind: 'single', dshId: 'import-b', turns: 1, events: 2 })
  registerIgnoreWatch(watchHarness({ workspaces: [], archived: ['import-a', 'import-b'] }).ctx, dir)
  const before = await waitFor(async () => {
    const { sources } = await loadIgnores(dir)
    return sources['D:\src\a.jsonl'] && sources['D:\src\b.jsonl'] ? readFileSync(join(dir, 'ignores.json'), 'utf8') : undefined
  })
  await delay(10)
  // 插件重启：同一归档集再补一遍墓碑
  registerIgnoreWatch(watchHarness({ workspaces: [], archived: ['import-a', 'import-b'] }).ctx, dir)
  await delay(200)
  assert.equal(readFileSync(join(dir, 'ignores.json'), 'utf8'), before)
})
