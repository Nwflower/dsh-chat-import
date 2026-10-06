// index-transfer.test.mjs — 转投到非 DSH 目标
// 转换成目标工具格式落盘、不留下 DSH 会话、附件回收报告。
// 由 test/index.test.mjs 按横幅分组拆出（纯移动：用例与断言未改）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { resolveRegistryDir, loadImports } from '../lib/imports.mjs'
import { sanitizeJsonValue, prepareHostMeta } from '../lib/import-core.mjs'
import { SESSION_FORMAT_VERSION } from '../lib/convert/index.mjs'
import { verifyOpencodeImportJson } from '../lib/export/index.mjs'
import { hostAbs } from './_support/host-path.mjs'
import { makeCtx, chatDef, exportDef } from './_support/fake-host.mjs'
import { clearScanCache } from '../lib/discovery.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'
import { loadHostFixture as load } from './_support/fixtures.mjs'
import { invokeImportRoute } from './_support/index-fixtures.mjs'

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
})

const HOST_HEADER_ALLOWED = new Set(['version', 'id', 'createdAt', 'isSeeded', 'delegationDepth', 'cwd', 'parentSession', 'origin', 'agentPreset'])

test('面板「导入到」opencode：只落 opencode JSON，DSH 侧不留会话（中间会话已撤回）', async () => {
  const file = 'D:\\demo\\claude\\projects\\proj-a\\sess-tool-001.jsonl'
  const { ctx, webRoutes, writes } = makeCtx({ [file]: load('sess-tool-001.jsonl') })
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/import')

  const out = await invokeImportRoute(route, {
    target: 'opencode',
    items: [{ source: 'claude-code', sourcePath: file, cwd: hostAbs('D:/demo/proj') }],
  })
  assert.equal(out.res.status, 200)
  assert.equal(out.data.ok, true)
  assert.equal(out.data.target, 'opencode')
  const r0 = out.data.results[0]
  assert.equal(r0.target, 'opencode')
  assert.equal(r0.status, 'transferred', JSON.stringify(out.data))
  assert.equal(r0.transferred, 1, JSON.stringify(out.data))
  assert.equal(r0.failed, 0)
  // 转投的中间会话被撤回。注：本测试的 persistence mock 没有宿主 delete 面（真实宿主在
  // 工件消失后即不再持有该会话），所以这里断言 purge 的三件事实——撤回被调用且成功、
  // 工件清理路径没抛错、registry 记录已清——而不是 mock 内存 Map 的尺寸。
  assert.equal(r0.purged, 1)
  assert.match(r0.hint, /opencode import/)

  // 落盘的是 opencode import 可读的 JSON（结构自检）
  const written = writes.filter((w) => w.path.endsWith('.opencode.json'))
  assert.equal(written.length, 1)
  assert.equal(verifyOpencodeImportJson(written[0].content).ok, true)
  // 且确实是这段对话：用户提问进了 user 消息
  const doc = JSON.parse(written[0].content)
  assert.ok(doc.messages.some((m) => m.info.role === 'user' && m.parts.some((p) => typeof p.text === 'string' && p.text.length > 0)))
  // 撤回后 registry 也清干净（不留悬空记录）
  const reg = await loadImports(resolveRegistryDir())
  assert.equal(Object.keys(reg.imports).length, 0)
})

test('面板「导入到」claude：落到 Claude Code 的 projects 目录，DSH 侧同样不留会话', async () => {
  const file = 'D:\\demo\\claude\\projects\\proj-a\\sess-simple-001.jsonl'
  const { ctx, webRoutes, writes } = makeCtx({ [file]: load('sess-simple-001.jsonl') })
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/import')

  const out = await invokeImportRoute(route, {
    target: 'claude',
    items: [{ source: 'claude-code', sourcePath: file, cwd: hostAbs('D:/demo/kimi-proj') }],
  })
  assert.equal(out.data.ok, true)
  const r0 = out.data.results[0]
  assert.equal(r0.status, 'transferred')
  assert.equal(r0.transferred, 1)
  assert.equal(r0.purged, 1, 'claude 目标同样不留 DSH 侧中间会话')
  const written = writes.filter((w) => w.path.replace(/\\/g, '/').includes('/.claude/projects/'))
  assert.equal(written.length, 1, '写进 Claude Code 的 projects 目录')
  const lines = written[0].content.split('\n').filter((l) => l.trim())
  assert.ok(lines.length > 0)
  assert.doesNotThrow(() => JSON.parse(lines[0]), 'Claude Code JSONL 每行都是合法 JSON')
})

test('面板「导入到」：原本已存在的 DSH 会话只导出不删除（不留空转投），未知目标 400', async () => {
  const file = 'D:\\demo\\claude\\projects\\proj-a\\sess-multi-001.jsonl'
  const { ctx, persistence, webRoutes, writes } = makeCtx({ [file]: load('sess-multi-001.jsonl') })
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/import')

  // 先常规导入一次（建 DSH 会话），再对同一来源做 opencode 转投
  await invokeImportRoute(route, { items: [{ source: 'claude-code', sourcePath: file }] })
  assert.equal(persistence.sessions.size, 1)
  const before = writes.length
  const transfer = await invokeImportRoute(route, {
    target: 'opencode',
    items: [{ source: 'claude-code', sourcePath: file }],
  })
  const r0 = transfer.data.results[0]
  assert.equal(r0.transferred, 1)
  // 会话本来就存在（already-imported）→ 保留，不撤回（用户自己的会话不因转投被删）
  assert.equal(r0.purged, 0)
  assert.equal(r0.kept, 1)
  assert.equal(r0.files[0].kept, true)
  const reg = await loadImports(resolveRegistryDir())
  assert.equal(Object.keys(reg.imports).length, 1, '未撤回 → registry 记录保留')
  assert.ok(writes.length > before, '仍然产出了目标格式文件')

  const bad = await invokeImportRoute(route, {
    target: 'zcode',
    items: [{ source: 'claude-code', sourcePath: file }],
  })
  assert.equal(bad.res.status, 400)
  assert.match(bad.data.error, /未知导入目标/)
})

test('export_chat format: opencode：DSH 会话 → opencode import JSON（dryRun 不写盘 + schema + 降级上报）', async () => {
  const src = 'D:\\demo\\proj\\sess-simple-001.jsonl'
  const { ctx, writes } = makeCtx({ [src]: load('sess-simple-001.jsonl') })
  apply(ctx)
  const imported = await chatDef(ctx, 'claude').execute({ path: src })
  assert.equal(imported.status, 'imported')
  const def = exportDef(ctx, 'opencode')

  const dry = await def.execute({ sessionId: imported.sessionId, dryRun: true })
  assert.equal(dry.dryRun, true)
  assert.match(dry.filePath, /\.opencode\.json$/)
  assert.equal(writes.some((w) => w.path === dry.filePath), false, 'dryRun 不写盘')

  const out = await def.execute({ sessionId: imported.sessionId })
  assert.equal(out.dryRun, false)
  assert.match(out.filePath, /\.opencode\.json$/)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, out), [])
  const written = writes.find((w) => w.path === out.filePath)
  assert.ok(written, '落盘一次')
  assert.equal(verifyOpencodeImportJson(written.content).ok, true)
  // 用量未知（opencode 必填的 cost/tokens 在 DSH 日志里没有）→ 降级显式上报
  assert.ok((out.degradations || []).some((d) => d.id === 'usage-unknown'))
})

test('issue #41 落盘 meta 恰为宿主 header 白名单字段（无 agents 服务路径）', async () => {
  const simple = load('sess-simple-001.jsonl')
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple })
  apply(ctx)
  const value = await chatDef(ctx, 'claude').execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(value.status, 'imported')
  const stored = persistence.sessions.get('import-sess-simple-001')
  assert.equal(stored.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(stored.meta.isSeeded, false)
  assert.equal(stored.meta.delegationDepth, 0)
  assert.deepEqual(Object.keys(stored.meta).filter((k) => !HOST_HEADER_ALLOWED.has(k)), [])
})

test('issue #41 prepareHostMeta：非绝对 cwd 剔除、createdAt 越界回落、插件自有字段不进 header', () => {
  const base = { version: 0, id: 'import-x', createdAt: 1700000000000, sourceId: 'src-1', provider: 'codex', model: 'gpt' }
  // 相对路径 / 跨平台路径在宿主平台非绝对 → 剔除（会话退化为未分组，不拒绝整次导入）
  assert.deepEqual(prepareHostMeta({ ...base, cwd: 'demo/proj' }, 3), {
    version: 3, id: 'import-x', createdAt: 1700000000000, isSeeded: false, delegationDepth: 0,
  })
  assert.equal(prepareHostMeta({ ...base, cwd: '/tmp/proj' }, 3).cwd, '/tmp/proj')
  // createdAt 缺失/越界 → 回落当前时间（宿主要求非负安全整数）
  const fixed = prepareHostMeta({ ...base, createdAt: -1 }, 3).createdAt
  assert.ok(Number.isSafeInteger(fixed) && fixed > 0)
})

test('issue #41 幽灵 id：agents.create 报 already exists 时不回退，另铸后缀新 id 重试', async () => {
  const calls = []
  const services = {
    agents: {
      async create({ sessionId, meta, seed }) {
        calls.push(sessionId)
        // 首次撞宿主内存索引残留的同名会话（list 不暴露但 create 拒绝）
        if (calls.length === 1) throw new Error('session "' + sessionId + '" already exists in this backend')
        await persistence.create(meta)
        await persistence.append(sessionId, seed)
      },
    },
  }
  const simple = load('sess-simple-001.jsonl')
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple }, { services })
  apply(ctx)
  const value = await chatDef(ctx, 'claude').execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(value.status, 'imported')
  assert.equal(value.sessionId, 'import-sess-simple-001-1')
  assert.deepEqual(calls, ['import-sess-simple-001', 'import-sess-simple-001-1'])
  // 回退路径未被触发：重铸后的新 id 落盘，原 id 不被 sessionPersistence 收下
  assert.equal(persistence.sessions.has('import-sess-simple-001'), false)
  assert.ok(persistence.sessions.has('import-sess-simple-001-1'))
})

test('issue #55 会话 id 被宿主写句柄占用时，同样另铸后缀新 id 重试', async () => {
  const cases = [
    // 按 err.name 命中（文案故意写成无关内容，锁定「名字优先」）
    { label: 'SessionAlreadyOwnedError（按 err.name）', make: (id) => Object.assign(new Error('见 err.name'), { name: 'SessionAlreadyOwnedError', sessionId: id }) },
    // 文案兜底：老宿主 / 被包了一层的错误没有 name
    { label: '仅文案（already owned by an active write handle）', make: (id) => new Error('session "' + id + '" is already owned by an active write handle') },
  ]
  for (const c of cases) {
    const calls = []
    const services = {
      agents: {
        async create({ sessionId, meta, seed }) {
          calls.push(sessionId)
          if (calls.length === 1) throw c.make(sessionId)
          await persistence.create(meta)
          await persistence.append(sessionId, seed)
        },
      },
    }
    const simple = load('sess-simple-001.jsonl')
    const { ctx, persistence } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple }, { services })
    apply(ctx)
    const value = await chatDef(ctx, 'claude').execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
    assert.equal(value.status, 'imported', c.label)
    assert.equal(value.sessionId, 'import-sess-simple-001-1', c.label)
    assert.deepEqual(calls, ['import-sess-simple-001', 'import-sess-simple-001-1'], c.label)
    assert.equal(persistence.sessions.has('import-sess-simple-001'), false, c.label)
    assert.ok(persistence.sessions.has('import-sess-simple-001-1'), c.label)
  }
})

test('issue #41 sanitizeJsonValue 剥离不可无损 JSON 序列化的值并上报路径', () => {
  const stripped = []
  const cyclic = { name: 'loop' }
  cyclic.self = cyclic
  const out = sanitizeJsonValue({
    keep: 1,
    drop: undefined,
    nested: { drop: undefined, keep: 'x' },
    list: [1, undefined, 3],
    nan: NaN,
    zero: -0,
    cyclic,
    when: new Date(0),
  }, 'v', stripped)
  assert.deepEqual(out, {
    keep: 1,
    nested: { keep: 'x' },
    list: [1, null, 3],
    nan: null,
    zero: null,
    cyclic: { name: 'loop' },
    when: {},
  })
  // 剥离即上报（失败要大声），路径含字段名
  assert.ok(stripped.some((x) => x.includes('v.drop')))
  assert.ok(stripped.some((x) => x.includes('v.nested.drop')))
  assert.ok(stripped.some((x) => x.includes('v.nan')))
  assert.ok(stripped.some((x) => x.includes('v.cyclic.self')))
  assert.ok(stripped.some((x) => x.includes('v.when')))
  // 返回值本身可无损 JSON 往返
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out)
})
