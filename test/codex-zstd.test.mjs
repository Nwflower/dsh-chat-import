// codex-zstd.test.mjs — issue #108：Codex 把历史 rollout 压成 rollout-*.jsonl.zst 后的
// 发现 / 读取 / 重导语义（同一 rollout 的明文与压缩形态共用一条 registry 记录）。
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { apply } from '../lib/index.mjs'
import { discoverSessions, clearScanCache } from '../lib/discovery.mjs'
import { makeDiscoveryHost } from '../lib/discovery-host.mjs'
import { loadImports, resolveRegistryDir } from '../lib/imports.mjs'
import { isCodexRolloutName, codexPageIdentity, dedupeCodexPages } from '../lib/sources/codex.mjs'
import { isZstdName, siblingZstdPath } from '../lib/zstd.mjs'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { freshDshHome, withTempDirAsync } from './_support/tmp-db.mjs'
import { zstdBytes, zstdBytesFrames } from './_support/zstd.mjs'

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-zst-')
  clearScanCache()
})

const THREAD = '0f1e2d3c-4b5a-6978-8901-2abcdef01234'
const T0 = '2026-09-14T10:54:34.000Z'

const meta = (id = THREAD, extra = {}) => JSON.stringify({
  timestamp: T0, type: 'session_meta',
  payload: { id, cwd: '/home/u/proj', timestamp: T0, ...extra },
})
const user = (text, ts) => JSON.stringify({ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
const asst = (text, ts) => JSON.stringify({ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })

const pageText = (q, a, ts) => [meta(), user(q, ts), asst(a, ts)].join('\n')

const PAGE_A = `rollout-2026-09-14T10-54-33-${THREAD}.jsonl`
const PAGE_B = `rollout-2026-09-15T19-55-00-${THREAD}_7c6d5e4f-0011-2233-4455-66778899aabb.jsonl`

function layout(root) {
  const sessions = join(root, 'sessions')
  const dirA = join(sessions, '2026', '09', '14')
  const dirB = join(sessions, '2026', '09', '15')
  mkdirSync(dirA, { recursive: true })
  mkdirSync(dirB, { recursive: true })
  return { sessions, pageA: join(dirA, PAGE_A), pageB: join(dirB, PAGE_B) }
}

const ZST = (p) => p + '.zst'

function writePlain(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

function writeCompressed(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, zstdBytes(text))
}

const readPrompts = (saved) => saved.events
  .filter((e) => e.type === 'user/message' && e.data.source.kind === 'user')
  .flatMap((e) => e.data.content).filter((b) => b.type === 'text').map((b) => b.text)

test('压缩形态的路径判定：siblingZstdPath / isCodexRolloutName / codexPageIdentity', () => {
  assert.equal(siblingZstdPath('/a/rollout-x.jsonl'), '/a/rollout-x.jsonl.zst')
  assert.equal(siblingZstdPath('/a/rollout-x.jsonl.zst'), '/a/rollout-x.jsonl')
  assert.equal(siblingZstdPath('/a/other.json'), null)
  assert.equal(isZstdName('x.jsonl.zst'), true)
  assert.equal(isZstdName('x.jsonl.zstd'), true)
  assert.equal(isZstdName('x.jsonl'), false)
  assert.equal(isCodexRolloutName('rollout-2026-09-14T10-54-33-a.jsonl'), true)
  assert.equal(isCodexRolloutName('rollout-2026-09-14T10-54-33-a.jsonl.zst'), true)
  assert.equal(isCodexRolloutName('session.jsonl'), false)
  assert.equal(codexPageIdentity('D:\\x\\A.JSONL.ZST'), codexPageIdentity('d:/x/a.jsonl'))
})

test('dedupeCodexPages：同一页两种形态按 mtime 留较新的；mtime 相同留先遇到的', () => {
  const files = [
    { path: '/s/a.jsonl' }, { path: '/s/a.jsonl.zst' }, { path: '/s/b.jsonl' },
  ]
  const mtimes = new Map([['/s/a.jsonl', 1000], ['/s/a.jsonl.zst', 2000]])
  assert.deepEqual(dedupeCodexPages(files, (f) => mtimes.get(f.path)).map((f) => f.path), ['/s/a.jsonl.zst', '/s/b.jsonl'])
  assert.deepEqual(dedupeCodexPages(files).map((f) => f.path), ['/s/a.jsonl', '/s/b.jsonl'])
})

test('发现 host：.jsonl.zst 的 readHead / readText 解压，readTail 不伪装成功', async () => {
  await withTempDirAsync('codex-zst-host-', async (root) => {
    const file = join(root, 'rollout-x.jsonl.zst')
    const text = '{"a":1}\n' + '中文内容'.repeat(40) + '\n末行'
    writeFileSync(file, zstdBytesFrames(text, 3))
    const { ctx } = makeCtx({}, { real: true })
    const host = makeDiscoveryHost(ctx)
    assert.equal(await host.readHead(file, 100000), text)
    assert.equal(await host.readHead(file, 17), text.slice(0, 17))
    assert.equal(await host.readText(file), text)
    assert.equal(await host.readTail(file, 16), null)
  })
})

test('发现：压缩 rollout 与明文一样出一个条目（sourcePath = 链首页的真实路径）', async () => {
  await withTempDirAsync('codex-zst-scan-', async (root) => {
    const { sessions, pageA, pageB } = layout(root)
    writePlain(pageA, pageText('第一问', '答一', '2026-09-14T10:55:00.000Z'))
    writeCompressed(ZST(pageB), pageText('第二问', '答二', '2026-09-15T19:56:00.000Z'))
    const { ctx } = makeCtx({}, { real: true })
    const { sessions: list, total, warnings } = await discoverSessions({
      path: sessions, format: 'codex', host: makeDiscoveryHost(ctx),
    })
    assert.deepEqual(warnings, [])
    assert.equal(total, 1)
    assert.equal(list[0].sessionId, THREAD)
    assert.equal(list[0].title, '第一问')
    assert.equal(list[0].sourcePath, pageA)
  })
})

test('发现：同一 rollout 的 .jsonl 与 .jsonl.zst 并存时按 mtime 只出一条', async () => {
  await withTempDirAsync('codex-zst-dedupe-', async (root) => {
    const { sessions, pageA } = layout(root)
    const text = pageText('第一问', '答一', '2026-09-14T10:55:00.000Z')
    writePlain(pageA, text)
    writeCompressed(ZST(pageA), text)
    const old = new Date('2026-09-20T00:00:00Z')
    const recent = new Date('2026-09-21T00:00:00Z')
    utimesSync(pageA, old, old)
    utimesSync(ZST(pageA), recent, recent)
    const { ctx } = makeCtx({}, { real: true })
    const { sessions: list, total } = await discoverSessions({
      path: sessions, format: 'codex', host: makeDiscoveryHost(ctx),
    })
    assert.equal(total, 1)
    assert.equal(list[0].sourcePath, ZST(pageA))
  })
})

test('导入：目录里的压缩链按明文同口径成一条会话', async () => {
  await withTempDirAsync('codex-zst-import-', async (root) => {
    const { sessions, pageA, pageB } = layout(root)
    writeCompressed(ZST(pageA), pageText('第一问', '答一', '2026-09-14T10:55:00.000Z'))
    writeCompressed(ZST(pageB), pageText('第二问', '答二', '2026-09-15T19:56:00.000Z'))
    const { ctx, persistence } = makeCtx({}, { real: true })
    apply(ctx)
    const def = chatDef(ctx, 'codex')
    const value = await def.execute({ path: sessions })
    assert.equal(value.mode, 'batch')
    assert.equal(value.total, 1)
    assert.equal(value.imported, 1)
    assert.equal(value.failed, 0)
    assert.equal(persistence.sessions.size, 1)
    const saved = persistence.sessions.get('import-' + THREAD)
    assert.ok(saved)
    assert.deepEqual(readPrompts(saved), ['第一问', '第二问'])
  })
})

test('重导：.jsonl 归档成 .jsonl.zst 后沿用原 registry 键，不重复建会话', async () => {
  await withTempDirAsync('codex-zst-transition-', async (root) => {
    const { sessions, pageA, pageB } = layout(root)
    const textA = pageText('第一问', '答一', '2026-09-14T10:55:00.000Z')
    const textB = pageText('第二问', '答二', '2026-09-15T19:56:00.000Z')
    writePlain(pageA, textA)
    writePlain(pageB, textB)

    const { ctx, persistence } = makeCtx({}, { real: true })
    apply(ctx)
    const def = chatDef(ctx, 'codex')
    const first = await def.execute({ path: sessions })
    assert.equal(first.imported, 1)
    assert.equal(persistence.sessions.size, 1)

    // Codex 归档：明文被压缩文件替换（同一 rollout、同一 thread/页名，只改后缀）
    rmSync(pageA)
    rmSync(pageB)
    writeCompressed(ZST(pageA), textA)
    writeCompressed(ZST(pageB), textB)

    const second = await def.execute({ path: sessions })
    assert.equal(second.imported, 0)
    assert.equal(second.alreadyImported, 1)
    assert.equal(persistence.sessions.size, 1)
    // registry 键仍是首次导入的明文路径：两种形态一条记录
    const registry = await loadImports(resolveRegistryDir())
    assert.ok(registry.imports[pageA], '沿用首次导入的键')
    assert.equal(registry.imports[ZST(pageA)], undefined)
    assert.deepEqual(readPrompts(persistence.sessions.get('import-' + THREAD)), ['第一问', '第二问'])
  })
})

test('导入：同一页的明文与压缩形态并存时按 mtime 去重，不重复计轮', async () => {
  await withTempDirAsync('codex-zst-both-', async (root) => {
    const { sessions, pageA, pageB } = layout(root)
    const textA = pageText('第一问', '答一', '2026-09-14T10:55:00.000Z')
    const textB = pageText('第二问', '答二', '2026-09-15T19:56:00.000Z')
    const old = new Date('2026-09-20T00:00:00Z')
    const recent = new Date('2026-09-21T00:00:00Z')
    for (const [plain, text] of [[pageA, textA], [pageB, textB]]) {
      writePlain(plain, text)
      writeCompressed(ZST(plain), text)
      utimesSync(plain, old, old)
      utimesSync(ZST(plain), recent, recent)
    }
    const { ctx, persistence } = makeCtx({}, { real: true })
    apply(ctx)
    const def = chatDef(ctx, 'codex')

    const batch = await def.execute({ path: sessions })
    assert.equal(batch.total, 1)
    assert.equal(batch.imported, 1)
    assert.deepEqual(readPrompts(persistence.sessions.get('import-' + THREAD)), ['第一问', '第二问'])

    // 单文件入口同样解析整链并去重：链未变 → 直接跳过，不会把重复页当新轮追加
    const single = await def.execute({ path: pageB })
    assert.equal(single.alreadyImported, true)
    assert.deepEqual(readPrompts(persistence.sessions.get('import-' + THREAD)), ['第一问', '第二问'])
  })
})

test('预览：压缩单文件可 dry-run，按解压后的内容计数', async () => {
  await withTempDirAsync('codex-zst-preview-', async (root) => {
    const { pageA, pageB } = layout(root)
    writeCompressed(ZST(pageA), pageText('第一问', '答一', '2026-09-14T10:55:00.000Z'))
    writeCompressed(ZST(pageB), pageText('第二问', '答二', '2026-09-15T19:56:00.000Z'))
    const { ctx, persistence } = makeCtx({}, { real: true })
    apply(ctx)
    const def = chatDef(ctx, 'codex')
    const value = await def.execute({ path: ZST(pageB), preview: true })
    assert.equal(value.turns, 2)
    assert.equal(persistence.sessions.size, 0)
  })
})
