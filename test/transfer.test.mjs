// transfer.test.mjs — 「导入到」非 DSH 目标的转投管线（lib/transfer.mjs）
//
// 这里不走完整 apply：直接用注入的 importItem 钉住「导入结果 → 转投行为」的分支，
// 以及导出失败 / 导入被跳过 / 批量展开这些**必须大声**的路径（集成路径见
// index.test.mjs 的「面板「导入到」」三例）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isTransferTarget, transferDiscoveryItem, transferHint, TRANSFER_TARGETS } from '../lib/transfer.mjs'
import { makeCtx, makePersistence } from './_support/fake-host.mjs'

const item = (over = {}) => ({ format: 'claude', sourcePath: 'D:\\demo\\sess-1.jsonl', sessionIds: [], target: 'opencode', ...over })

// 极小 ctx：导出器只用到 fs.writeText / fs.resolve 与 sessionPersistence（后者缺席时
// 导出会以「sessionPersistence 不可用」失败，正是「导出失败」分支要覆盖的形态）。
function fakeCtx({ persistence, attachments } = {}) {
  const { ctx, writes } = makeCtx({}, { real: false, persistence, services: { attachments } })
  return Object.assign(ctx, { writes })
}

test('目标白名单与落点提示：dsh 不在转投目标里，四个外部目标都有提示', () => {
  assert.deepEqual(TRANSFER_TARGETS, ['claude', 'codex', 'kimi', 'opencode'])
  assert.equal(isTransferTarget('dsh'), false)
  assert.equal(isTransferTarget('zcode'), false)
  for (const t of TRANSFER_TARGETS) assert.equal(isTransferTarget(t), true)
  assert.match(transferHint('opencode', '/tmp/a.opencode.json'), /opencode import/)
  assert.match(transferHint('claude', ''), /--resume|projects/)
  assert.equal(transferHint('dsh', 'x'), '')
})

test('未知目标 / 缺 importItem → 直接抛错（不静默降级回 DSH 导入）', async () => {
  const ctx = fakeCtx()
  await assert.rejects(() => transferDiscoveryItem(ctx, item({ target: 'zcode' }), { importItem: async () => ({}) }), /未知导入目标/)
  await assert.rejects(() => transferDiscoveryItem(ctx, item(), {}), /需要 importItem/)
})

test('导入被跳过（无会话产出）→ 转投报 failed 并带上跳过原因，而不是空的成功', async () => {
  const ctx = fakeCtx()
  const out = await transferDiscoveryItem(ctx, item(), {
    importItem: async () => ({ mode: 'single', status: 'skipped', sessionId: 'none', skipReason: 'auxiliary transcript' }),
  })
  assert.equal(out.status, 'failed')
  assert.equal(out.transferred, 0)
  assert.equal(out.failed, 1)
  assert.match(out.error, /auxiliary transcript/)
  assert.deepEqual(out.files, [])
  assert.equal(ctx.writes.length, 0, '没有产出任何文件')
})

test('导出失败（会话读不到）→ 逐条记 failed + error，且不撤回（无会话可撤）', async () => {
  const ctx = fakeCtx({ persistence: undefined })
  const out = await transferDiscoveryItem(ctx, item(), {
    importItem: async () => ({ mode: 'single', status: 'imported', sessionId: 'import-sess-1' }),
  })
  assert.equal(out.status, 'failed')
  assert.equal(out.failed, 1)
  assert.equal(out.transferred, 0)
  assert.equal(out.purged, 0)
  assert.equal(out.files.length, 1)
  assert.equal(out.files[0].status, 'failed')
  assert.match(out.files[0].error, /不可用|不存在/)
})

test('批量形态：逐条展开转投，跳过/失败的条目不进转投（不产出空文件）', async () => {
  const ctx = fakeCtx()
  const seen = []
  const out = await transferDiscoveryItem(ctx, item({ format: 'opencode' }), {
    // 批量导入结果里混着 skipped 与 failed 条目：它们没有可导出的会话
    importItem: async () => ({
      mode: 'batch',
      results: [
        { path: 'D:\\demo\\a', status: 'skipped', sessionId: 'none' },
        { path: 'D:\\demo\\b', status: 'failed' },
        { path: 'D:\\demo\\c', status: 'imported', sessionId: 'import-c' },
      ],
    }),
  })
  assert.equal(out.mode, 'batch')
  // 唯一可转投的会话导出失败（无 persistence）→ 记一条 failed，且不会为 skipped/failed 造条目
  assert.equal(out.files.length, 1)
  assert.equal(out.files[0].sessionId, 'import-c')
  assert.equal(out.files[0].sourcePath, 'D:\\demo\\c')
  assert.equal(seen.length, 0)
})

test('转投的图片口径：能承载图片的目标落附件并点名撤回后不可回收的张数', async () => {
  const persistence = makePersistence({ omit: ['remove'] })
  const store = persistence.sessions
  const sessionId = 'import-sess-img'
  store.set(sessionId, {
    meta: { id: sessionId, version: 4, createdAt: 1785000000000, cwd: 'D:\\demo\\proj', isSeeded: false, delegationDepth: 0 },
    events: [
      { type: 'user/message', seq: 0, time: 1785000000001, data: { id: 'u', role: 'user', content: [{ type: 'text', text: '看图' }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 1, time: 1785000000002, data: { turn: 0, step: 1, stream: [], message: { id: 'a', role: 'assistant', content: [{ type: 'image', attachment: { attachmentId: 'sha256:i', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } }] } } },
    ],
  })
  const registryDir = mkdtempSync(join(tmpdir(), 'dsh-transfer-img-'))
  // 先让会话进 registry，撤回才可能成功
  const { rememberImport } = await import('../lib/imports.mjs')
  await rememberImport(registryDir, 'D:\\demo\\sess-img.jsonl', { kind: 'single', dshId: sessionId, turns: 1, events: 2 })

  // claude 目标：能承载图片 → 落附件（storeImages 不传 false），撤回后点名孤儿字节
  const claudeCtx = fakeCtx({
    persistence,
    // 附件服务：导出方向把引用读回字节（readImage），目标格式才拿得到 base64
    attachments: { async readImage() { return { data: Buffer.from('abc') } } },
  })
  const seen = []
  const claudeOut = await transferDiscoveryItem(claudeCtx, item({ target: 'claude', cwd: 'D:\\demo\\proj' }), {
    registryDir,
    importItem: async (_ctx, _format, _path, _ids, opts) => {
      seen.push(opts.storeImages)
      return { mode: 'single', status: 'imported', sessionId, images: 1 }
    },
  })
  assert.equal(seen[0], true, 'claude 目标落图片')
  assert.equal(claudeOut.transferred, 1)
  assert.equal(claudeOut.purged, 1)
  assert.equal(claudeOut.attachmentsOrphaned, 1, '撤回后不可回收的图片张数要点名')
  assert.equal(claudeOut.files[0].attachmentsOrphaned, 1)
  // 图片确实写进了目标格式（attachment 引用被读成 base64）
  assert.match(claudeCtx.writes[0].content, /"type":"image"/)

  // kimi 目标：wire 只能指自有 blob → 不落附件（省下撤回后无法回收的字节）
  const kimiCtx = fakeCtx({ persistence })
  const kimiSeen = []
  const kimiOut = await transferDiscoveryItem(kimiCtx, item({ target: 'kimi' }), {
    registryDir,
    importItem: async (_ctx, _format, _path, _ids, opts) => {
      kimiSeen.push(opts.storeImages)
      return { mode: 'single', status: 'imported', sessionId, images: 0, imagesDegraded: 1 }
    },
  })
  assert.equal(kimiSeen[0], false, 'kimi 目标不落图片')
  assert.equal(kimiOut.attachmentsOrphaned, undefined, '没有落图就没有孤儿字节')
})

test('导出成功但撤回失败 → 保留会话并把原因带到结果（kept + purgeError，不静默）', async () => {
  // 用一个真的能被导出的最小 DSH 会话：persistence 提供 list/readFrom，导出走 opencode
  const persistence = makePersistence({ omit: ['remove'] })
  const store = persistence.sessions
  const sessionId = 'import-sess-keep'
  store.set(sessionId, {
    meta: { id: sessionId, version: 3, createdAt: 1785000000000, cwd: 'D:\\demo\\proj', isSeeded: false, delegationDepth: 0 },
    events: [
      { type: 'user/message', seq: 0, time: 1785000000001, data: { id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 1, time: 1785000000002, data: { turn: 0, step: 1, stream: [], message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } },
    ],
  })
  const ctx = fakeCtx({ persistence })
  // registry 目录用临时目录；会话不在 registry 里 → deleteImportedSession 会抛
  //「会话不在 imports registry」，正好模拟撤回失败
  const registryDir = mkdtempSync(join(tmpdir(), 'dsh-transfer-'))
  const out = await transferDiscoveryItem(ctx, item(), {
    registryDir,
    importItem: async () => ({ mode: 'single', status: 'imported', sessionId }),
  })
  assert.equal(out.transferred, 1)
  assert.equal(out.purged, 0)
  assert.equal(out.kept, 1)
  assert.equal(out.files[0].kept, true)
  assert.match(out.files[0].purgeError, /registry|非法/)
  // 文件确实写出来了（导出本身成功），撤回失败不掩盖这一点
  assert.equal(ctx.writes.length, 1)
  assert.match(ctx.writes[0].path, /\.opencode\.json$/)
  assert.equal(JSON.parse(ctx.writes[0].content).info.id.startsWith('ses_'), true)
})
