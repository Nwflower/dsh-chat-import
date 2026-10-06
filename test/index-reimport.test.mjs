// index-reimport.test.mjs — 重导语义（增量续写 / 另铸副本）
// 源未变跳过、源增长续写、已续聊另铸副本、截短与基线缺失。
// 由 test/index.test.mjs 按横幅分组拆出（纯移动：用例与断言未改）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { apply } from '../lib/index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { resolveRegistryDir, loadImports } from '../lib/imports.mjs'
import { hostAbs } from './_support/host-path.mjs'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { clearScanCache } from '../lib/discovery.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'
import { opencodeTestSessions, makeOpencodeDb, addOpencodeTurn, deleteOpencodeMessages } from './_support/index-fixtures.mjs'

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
})

function claudeTurns(n, sessionId = 'sess-incr-001') {
  const lines = []
  for (let i = 1; i <= n; i++) {
    if (i === 1) {
      lines.push(JSON.stringify({ sessionId, type: 'user', cwd: hostAbs('D:/demo/proj'), message: { role: 'user', content: '问题' + i } }))
    } else {
      lines.push(JSON.stringify({ sessionId, type: 'user', message: { role: 'user', content: '问题' + i } }))
    }
    lines.push(JSON.stringify({ sessionId, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '回答' + i }] } }))
  }
  return lines.join('\n')
}

// 合成 ChatGPT conversations.json 的单个会话对象（mapping 主线程：user/assistant 交替）。

function chatgptConversation(id, title, turns) {
  const mapping = {}
  let prev = null
  let idx = 1
  for (const prompt of turns) {
    for (const role of ['user', 'assistant']) {
      const nodeId = 'n' + idx
      const text = role === 'user' ? prompt : 'reply to ' + prompt
      mapping[nodeId] = {
        id: nodeId,
        message: { id: 'm' + idx, author: { role }, content: { content_type: 'text', parts: [text] }, create_time: 1710000000 + idx },
        parent: prev,
        children: [],
      }
      if (prev) mapping[prev].children.push(nodeId)
      prev = nodeId
      idx++
    }
  }
  return { id, title, create_time: 1710000000, mapping }
}

test('REQ-24 增长 append：同一会话 seq 连续、只新增轮次、无重复标题/标记', async () => {
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const first = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(first.status, 'imported')
  assert.equal(first.turns, 2)
  const saved1 = persistence.sessions.get('import-sess-incr-001')
  const before = saved1.events.length
  const firstEvents = [...saved1.events] // 快照：mock 的 append 原地修改同一数组
  assert.equal(saved1.events.filter((e) => e.type === 'turn/start').length, 2)

  // 源文件增长（2 → 3 轮）
  tree['D:\\demo\\proj\\sess-incr-001.jsonl'] = claudeTurns(3)
  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(second.status, 'appended')
  assert.equal(second.appendedTurns, 1)
  assert.ok(second.appendedEvents > 0)
  assert.equal(second.alreadyImported, false)

  // 同一会话：seq 全连续、只多出尾部轮次
  const saved2 = persistence.sessions.get('import-sess-incr-001')
  assert.ok(saved2)
  assert.ok(saved2.events.every((e, i) => e.seq === i))
  assert.equal(saved2.events.length, before + second.appendedEvents)
  assert.equal(saved2.events.filter((e) => e.type === 'turn/start').length, 3)
  // 续写轮次：turn 续号用源编号（3），末尾 turn/end 平衡
  assert.equal(saved2.events.at(-1).type, 'turn/end')
  assert.equal(saved2.events.at(-1).data.turn, 3)
  // 续写不重复钉 session/title（标记自 0.8.3 起不再写入，见 issue #34）
  assert.equal(saved2.events.filter((e) => e.type === 'session/title').length, 1)
  // 已导入前缀事件未被改写
  assert.deepEqual(saved2.events.slice(0, before), firstEvents)
})

test('REQ-24 未变跳过：version/size 短路径不 readText，已存在不重复落盘', async () => {
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2) }
  const { ctx, persistence, reads } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const first = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(reads.count, 1)
  assert.equal(first.status, 'imported')
  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  // 未变：短路径跳过（不 readText），返回 already-imported
  assert.equal(second.status, 'already-imported')
  assert.equal(second.alreadyImported, true)
  assert.equal(reads.count, 1)
  assert.equal(persistence.sessions.size, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, second), [])
})

test('REQ-24 sourceShrunk：源文件轮次减少 → 跳过报告，不破坏已导入会话', async () => {
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(3) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  const before = persistence.sessions.get('import-sess-incr-001').events.length

  tree['D:\\demo\\proj\\sess-incr-001.jsonl'] = claudeTurns(2)
  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(second.status, 'already-imported')
  assert.equal(second.sourceShrunk, true)
  // 已导入会话原样（仍是 3 轮）
  const saved = persistence.sessions.get('import-sess-incr-001')
  assert.equal(saved.events.length, before)
  assert.equal(saved.events.filter((e) => e.type === 'turn/start').length, 3)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, second), [])
})

test('REQ-24 changedInPlace：轮数相等但事件增长 → 跳过（append-only 无法改写）', async () => {
  const v1 = claudeTurns(1)
  // 同轮内多一条 assistant 消息（step2）→ 事件数变多、轮数不变
  const v2 = [
    '{"sessionId":"sess-incr-001","type":"user","cwd":"D:\\\\demo\\\\proj","message":{"role":"user","content":"问题1"}}',
    '{"sessionId":"sess-incr-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"回答1"}]}}',
    '{"sessionId":"sess-incr-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"补充回答"}]}}',
  ].join('\n')
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': v1 }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  const before = persistence.sessions.get('import-sess-incr-001').events.length

  tree['D:\\demo\\proj\\sess-incr-001.jsonl'] = v2
  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(second.status, 'already-imported')
  assert.equal(second.changedInPlace, true)
  assert.equal(persistence.sessions.get('import-sess-incr-001').events.length, before)
})

test('REQ-24 force:true：新 id 完整副本，旧会话原样保留', async () => {
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  const oldEvents = persistence.sessions.get('import-sess-incr-001').events

  const forced = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl', force: true })
  assert.equal(forced.status, 'imported')
  assert.equal(forced.sessionId, 'import-sess-incr-001-1')
  assert.deepEqual(forced.reimported, { previous: 'import-sess-incr-001', current: 'import-sess-incr-001-1', reason: 'forced' })
  // 两个会话都在：旧会话原样，新会话是完整副本（含 2 轮）
  assert.equal(persistence.sessions.size, 2)
  const copy = persistence.sessions.get('import-sess-incr-001-1')
  assert.ok(copy)
  assert.ok(copy.events.every((e, i) => e.seq === i))
  assert.equal(copy.events.filter((e) => e.type === 'turn/start').length, 2)
  assert.deepEqual(persistence.sessions.get('import-sess-incr-001').events, oldEvents)
  // registry 指向新 id 且把旧会话收进 copies（撤回/清理/体检仍能枚举到它）
  const regAfterForce = await loadImports(resolveRegistryDir())
  const recAfterForce = regAfterForce.imports['D:\\demo\\proj\\sess-incr-001.jsonl']
  assert.equal(recAfterForce.dshId, 'import-sess-incr-001-1')
  assert.deepEqual(recAfterForce.copies.map((c) => c.dshId), ['import-sess-incr-001'])
  // 再 force 一次 → 从当前记录链式避让（import-sess-incr-001-1-1）
  const forced2 = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl', force: true })
  assert.equal(forced2.sessionId, 'import-sess-incr-001-1-1')
  assert.equal(persistence.sessions.size, 3)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, forced), [])
})

test('REQ-24 两路径共享 sessionId：都导入、后缀避让、互不覆盖', async () => {
  // Claude 主 transcript 命名 = <sessionId>.jsonl；两个不同目录的同名文件共享同一源 sessionId
  const tree = {
    'D:\\demo\\proj\\a\\shared-session.jsonl': claudeTurns(1, 'shared-session'),
    'D:\\demo\\proj\\b\\shared-session.jsonl': [
      '{"sessionId":"shared-session","type":"user","message":{"role":"user","content":"另一个文件的问题"}}',
      '{"sessionId":"shared-session","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"另一个文件的回答"}]}}',
    ].join('\n'),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const ra = await def.execute({ path: 'D:\\demo\\proj\\a\\shared-session.jsonl' })
  const rb = await def.execute({ path: 'D:\\demo\\proj\\b\\shared-session.jsonl' })
  assert.equal(ra.status, 'imported')
  assert.equal(ra.sessionId, 'import-shared-session')
  // 第二个文件目标 id 被占用 → 后缀避让，不覆盖第一个文件的内容
  assert.equal(rb.status, 'imported')
  assert.equal(rb.sessionId, 'import-shared-session-1')
  assert.equal(persistence.sessions.size, 2)
  const a = persistence.sessions.get('import-shared-session')
  const b = persistence.sessions.get('import-shared-session-1')
  assert.ok(a.events.some((e) => e.type === 'user/message' && e.data.content[0].text.includes('问题')))
  assert.ok(b.events.some((e) => e.type === 'user/message' && e.data.content[0].text.includes('另一个文件')))
  // 两个路径各自有 registry 记录，重导各自幂等（不互相串扰）
  const rb2 = await def.execute({ path: 'D:\\demo\\proj\\b\\shared-session.jsonl' })
  assert.equal(rb2.status, 'already-imported')
  assert.equal(persistence.sessions.size, 2)
})

test('REQ-24 legacy 回填：registry 丢失但会话在 → already-imported + 回填基线', async () => {
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(persistence.sessions.size, 1)

  // 模拟 registry 丢失（旧版本无 registry）：清空 imports.json
  const regFile = join(resolveRegistryDir(), 'imports.json')
  mkdirSync(dirname(regFile), { recursive: true })
  writeFileSync(regFile, '{ "version": 1, "imports": {} }')

  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(second.status, 'already-imported')
  assert.equal(second.backfilled, true)
  assert.equal(persistence.sessions.size, 1) // 不重复落盘
  // 回填后 registry 有该路径的基线记录；再导（未变）走短路径跳过
  const reg = await loadImports(resolveRegistryDir())
  const rec = reg.imports['D:\\demo\\proj\\sess-incr-001.jsonl']
  assert.ok(rec)
  assert.equal(rec.kind, 'single')
  assert.equal(rec.dshId, 'import-sess-incr-001')
  assert.equal(rec.turns, 2)
  const third = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(third.status, 'already-imported')
})

test('重导语义：用户已在 DSH 续聊过 → 不追加进他的会话，另铸副本并点名 continued-in-dsh', async () => {
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  const saved1 = persistence.sessions.get('import-sess-incr-001')
  const base = saved1.events.length

  // 用户在 DSH 里继续聊了 2 条消息（会话日志增长，registry 的 storedEvents 基线过期）
  const chat = [
    { type: 'user/message', seq: base, time: Date.now(), surfaceOp: 'append', data: { id: 'live:u1', role: 'user', content: [{ type: 'text', text: 'DSH 里继续问' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: base + 1, time: Date.now(), surfaceOp: 'append', data: { id: 'live:a1', role: 'assistant', content: [{ type: 'text', text: 'DSH 里继续答' }], source: { kind: 'model', provider: 'dsh' } } },
  ]
  await persistence.append('import-sess-incr-001', chat)

  tree['D:\\demo\\proj\\sess-incr-001.jsonl'] = claudeTurns(3)
  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(second.status, 'imported')
  assert.equal(second.sessionId, 'import-sess-incr-001-1')
  assert.deepEqual(second.reimported, { previous: 'import-sess-incr-001', current: 'import-sess-incr-001-1', reason: 'continued-in-dsh' })
  // 用户那条会话一个字节都没被改写：他的两条消息仍在原位，轮次数不变
  const kept = persistence.sessions.get('import-sess-incr-001').events
  assert.equal(kept.length, base + 2)
  assert.equal(kept[base].data.id, 'live:u1')
  assert.equal(kept[base + 1].data.id, 'live:a1')
  assert.equal(kept.filter((e) => e.type === 'turn/start').length, 2)
  // 新副本是完整 3 轮的独立会话（seq 从 0 连续）
  const copy = persistence.sessions.get('import-sess-incr-001-1')
  assert.ok(copy.events.every((e, i) => e.seq === i))
  assert.equal(copy.events.filter((e) => e.type === 'turn/start').length, 3)
  assert.equal(copy.events.filter((e) => e.type === 'turn/end').at(-1).data.turn, 3)
})

test('重导语义：DSH 侧未续聊 → 仍走增量续写（seq 接在既有事件后，不新建会话）', async () => {
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  const base = persistence.sessions.get('import-sess-incr-001').events.length

  tree['D:\\demo\\proj\\sess-incr-001.jsonl'] = claudeTurns(3)
  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(second.status, 'appended')
  assert.equal(second.reimported, undefined)
  const saved2 = persistence.sessions.get('import-sess-incr-001')
  assert.ok(saved2.events.every((e, i) => e.seq === i))
  assert.ok(saved2.events.length > base)
  assert.equal(saved2.events.filter((e) => e.type === 'turn/start').length, 3)
  // registry 的基线随续写推进（下次重导仍判为「未续聊」）
  const reg = await loadImports(resolveRegistryDir())
  const rec = reg.imports['D:\\demo\\proj\\sess-incr-001.jsonl']
  assert.equal(rec.storedEvents, saved2.events.length)
})

test('重导语义：DSH 侧日志比基线短（被外部截短）→ 不写、跳过并报 storedShrunk', async () => {
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  const before = persistence.sessions.get('import-sess-incr-001').events.slice()

  // 模拟工件被外部截短：日志变短但 registry 基线仍是导入时实测的长度
  persistence.sessions.get('import-sess-incr-001').events = before.slice(0, Math.max(1, before.length - 3))
  tree['D:\\demo\\proj\\sess-incr-001.jsonl'] = claudeTurns(3)
  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(second.status, 'already-imported')
  assert.equal(second.storedShrunk, true)
  assert.equal(second.sessionId, 'import-sess-incr-001')
  // 没有新建会话，也没有写入
  assert.equal(persistence.sessions.size, 1)
  assert.equal(persistence.sessions.get('import-sess-incr-001').events.length, before.length - 3)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, second), [])
})

test('重导语义：旧记录没有 storedEvents 基线 → 保守另铸副本一次并回填基线', async () => {
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })

  // 模拟 0.20.0 之前的记录：有 turns 但没有 storedEvents（无法判断是否被续聊）
  const regFile = join(resolveRegistryDir(), 'imports.json')
  const saved = JSON.parse(readFileSync(regFile, 'utf8'))
  delete saved.imports['D:\\demo\\proj\\sess-incr-001.jsonl'].storedEvents
  writeFileSync(regFile, JSON.stringify(saved, null, 2) + '\n')

  tree['D:\\demo\\proj\\sess-incr-001.jsonl'] = claudeTurns(3)
  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(second.status, 'imported')
  assert.equal(second.sessionId, 'import-sess-incr-001-1')
  assert.equal(second.reimported.reason, 'baseline-missing')
  // 副本落盘后回填了基线（下次重导不再无判据）
  const reg = await loadImports(resolveRegistryDir())
  const rec = reg.imports['D:\\demo\\proj\\sess-incr-001.jsonl']
  assert.equal(rec.dshId, 'import-sess-incr-001-1')
  assert.equal(typeof rec.storedEvents, 'number')
  assert.equal(rec.storedEvents, persistence.sessions.get('import-sess-incr-001-1').events.length)
})

test('REQ-24 显式 sessionId 变更：以新 id 建完整副本（副本语义），旧会话原样', async () => {
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const first = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl', sessionId: 'custom-a' })
  assert.equal(first.sessionId, 'custom-a')

  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl', sessionId: 'custom-b' })
  assert.equal(second.status, 'imported')
  assert.equal(second.sessionId, 'custom-b')
  assert.deepEqual(second.reimported, { previous: 'custom-a', current: 'custom-b', reason: 'session-id-changed' })
  assert.equal(persistence.sessions.size, 2)
  assert.ok(persistence.sessions.get('custom-a'))
  assert.ok(persistence.sessions.get('custom-b'))
  // registry 指向新 id
  const reg = await loadImports(resolveRegistryDir())
  assert.equal(reg.imports['D:\\demo\\proj\\sess-incr-001.jsonl'].dshId, 'custom-b')
})

test('REQ-24 损坏 registry 容错：按空 registry 处理并继续导入', async () => {
  const regFile = join(resolveRegistryDir(), 'imports.json')
  mkdirSync(dirname(regFile), { recursive: true })
  writeFileSync(regFile, 'not json {{{')
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(value.status, 'imported')
  assert.equal(persistence.sessions.size, 1)
  // 导入后 registry 被重建为合法内容
  const reg = await loadImports(resolveRegistryDir())
  assert.ok(reg.imports['D:\\demo\\proj\\sess-incr-001.jsonl'])
})

test('REQ-24 batch 汇总：目录内单文件增长 → appended 计数与结果 status', async () => {
  const tree = {
    'D:\\demo\\proj': 'dir',
    'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2),
    'D:\\demo\\proj\\sess-static-001.jsonl': claudeTurns(1, 'sess-static-001'),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const first = await def.execute({ path: 'D:\\demo\\proj' })
  assert.equal(first.imported, 2)
  assert.equal(first.appended, 0)

  tree['D:\\demo\\proj\\sess-incr-001.jsonl'] = claudeTurns(3)
  const second = await def.execute({ path: 'D:\\demo\\proj' })
  assert.equal(second.mode, 'batch')
  assert.equal(second.appended, 1)
  assert.equal(second.alreadyImported, 1) // sess-static 未变短路径跳过
  assert.equal(second.imported, 0)
  const appendedResult = second.results.find((r) => r.status === 'appended')
  assert.ok(appendedResult)
  assert.equal(appendedResult.sessionId, 'import-sess-incr-001')
  assert.equal(appendedResult.appendedTurns, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, second), [])
  assert.equal(persistence.sessions.get('import-sess-incr-001').events.filter((e) => e.type === 'turn/start').length, 3)
})

test('REQ-24 ChatGPT 多会话：逐会话增长 append / 新增 / 消失 missingFromSource', async () => {
  const v1 = JSON.stringify([
    chatgptConversation('conv-001', 'Alpha', ['问题A']),
    chatgptConversation('conv-002', 'Beta', ['问题B']),
  ])
  const v2 = JSON.stringify([
    chatgptConversation('conv-001', 'Alpha', ['问题A', '问题A2']), // 增长
    chatgptConversation('conv-003', 'Gamma', ['问题C']), // 新增
  ]) // conv-002 消失
  const tree = { 'D:\\demo\\chatgpt\\conversations.json': v1 }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'chatgpt')
  const first = await def.execute({ path: 'D:\\demo\\chatgpt\\conversations.json' })
  assert.equal(first.imported, 2)
  assert.equal(persistence.sessions.size, 2)
  const conv1Before = persistence.sessions.get('import-conv-001').events.length

  tree['D:\\demo\\chatgpt\\conversations.json'] = v2
  const second = await def.execute({ path: 'D:\\demo\\chatgpt\\conversations.json' })
  assert.equal(second.mode, 'batch')
  assert.equal(second.appended, 1) // conv-001 增长
  assert.equal(second.imported, 1) // conv-003 新增
  assert.deepEqual(second.missingFromSource, ['conv-002'])
  const appended = second.results.find((r) => r.status === 'appended')
  assert.ok(appended)
  assert.equal(appended.sessionId, 'import-conv-001')
  assert.equal(appended.appendedTurns, 1)
  const conv1 = persistence.sessions.get('import-conv-001')
  assert.ok(conv1.events.every((e, i) => e.seq === i))
  assert.equal(conv1.events.length, conv1Before + appended.appendedEvents)
  assert.equal(conv1.events.filter((e) => e.type === 'turn/start').length, 2)
  assert.ok(persistence.sessions.get('import-conv-003'))
  assert.ok(persistence.sessions.get('import-conv-002')) // 消失的会话原样保留
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, second), [])
})

test('REQ-24 opencode DB 增长 append：同库新增轮次续写同一会话', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'opencode')
  const first = await def.execute({ path: dbPath })
  assert.equal(first.imported, 2)
  const before = persistence.sessions.get('import-ses-a').events.length

  // 库增长：ses-a 追加一轮
  addOpencodeTurn(dbPath, 'ses-a', 'msg-a3', '继续追问', '追加回答', 1786000000100)
  const second = await def.execute({ path: dbPath })
  assert.equal(second.mode, 'batch')
  assert.equal(second.appended, 1)
  assert.equal(second.alreadyImported, 1) // ses-b 未变
  const appended = second.results.find((r) => r.status === 'appended')
  assert.ok(appended)
  assert.equal(appended.sessionId, 'import-ses-a')
  const sesA = persistence.sessions.get('import-ses-a')
  assert.ok(sesA.events.every((e, i) => e.seq === i))
  assert.equal(sesA.events.length, before + appended.appendedEvents)
  assert.equal(sesA.events.filter((e) => e.type === 'turn/start').length, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, second), [])
})

test('REQ-24 opencode 消息删除（turns 变少）→ sourceShrunk 跳过', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  addOpencodeTurn(dbPath, 'ses-a', 'msg-a3', '继续追问', '追加回答', 1786000000100)
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'opencode')
  await def.execute({ path: dbPath })
  const before = persistence.sessions.get('import-ses-a').events.length

  // 删除追加的一轮 → ses-a 轮次变少
  deleteOpencodeMessages(dbPath, ['msg-a3-u', 'msg-a3-a'])
  const second = await def.execute({ path: dbPath })
  const shrunk = second.results.find((r) => r.sessionId === 'import-ses-a')
  assert.ok(shrunk)
  assert.equal(shrunk.status, 'already-imported')
  assert.equal(shrunk.sourceShrunk, true)
  assert.equal(persistence.sessions.get('import-ses-a').events.length, before)
})

test('REQ-24 opencode fullHistory 入 args 指纹：参数变化 → args-changed 跳过', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'opencode')
  await def.execute({ path: dbPath }) // 默认（尊重压缩）
  const second = await def.execute({ path: dbPath, fullHistory: true })
  assert.equal(second.mode, 'batch')
  assert.equal(second.alreadyImported, 2)
  assert.equal(second.imported, 0)
  assert.equal(second.appended, 0)
  assert.ok(second.results.every((r) => r.argsChanged === true))
  assert.equal(persistence.sessions.size, 2) // 未新增副本
  // force:true 可换新参数导入（副本）
  const forced = await def.execute({ path: dbPath, fullHistory: true, force: true })
  assert.equal(forced.imported, 2)
  assert.equal(persistence.sessions.size, 4)
})

test('REQ-24 opencode 未变 DB：短路径跳过（version/size 不变）', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'opencode')
  await def.execute({ path: dbPath })
  const second = await def.execute({ path: dbPath })
  assert.equal(second.imported, 0)
  assert.equal(second.alreadyImported, 2)
  assert.equal(persistence.sessions.size, 2)
})
