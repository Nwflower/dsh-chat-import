// index-panel.test.mjs — 面板路由
// 被动发现（/api-import/sessions）、面板导入路由、从文件导入的三级探测与 generic 文档。
// 由 test/index.test.mjs 按横幅分组拆出（纯移动：用例与断言未改）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { Buffer } from 'node:buffer'
import { apply } from '../lib/index.mjs'
import { clearScanCache } from '../lib/discovery.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { hostAbs } from './_support/host-path.mjs'
import { makeCtx, toolDef, chatDef } from './_support/fake-host.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'
import { loadHostFixture as load } from './_support/fixtures.mjs'
import { opencodeTestSessions, makeOpencodeDb, invokeImportRoute } from './_support/index-fixtures.mjs'

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
})

function writeDshLog(dir, fileName, id, { withEvents = true, compress = false } = {}) {
  const lines = [{ type: 'session', id, cwd: hostAbs('D:/demo/proj'), createdAt: 1700000000000 }]
  if (withEvents) {
    lines.push(
      { type: 'turn/start', seq: 0, time: 1700000000000, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 1700000000000, data: { turn: 1, step: 1 } },
      { type: 'user/message', seq: 2, time: 1700000000000, surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text: '你好' }] } },
      { type: 'assistant/message', seq: 3, time: 1700000000000, surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '回复' }] } } },
      { type: 'turn/end', seq: 4, time: 1700000000000, data: { turn: 1 } },
    )
  }
  const text = Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n'))
  const file = join(dir, fileName)
  // compress=true 写成宿主形态：**一条事件一帧**的多帧拼接 zstd（单帧夹具测不出
  // 「只解首帧」的截断问题——真实日志恒为多帧，见 test/dsh.test.mjs 的回归用例）
  writeFileSync(file, compress ? Buffer.concat(lines.map((l) => zstdCompressSync(Buffer.from(JSON.stringify(l) + '\n')))) : text)
  return file
}

test('REQ-41 apply 注册 webServer 路由（POST /api-import/sessions + /api-import/import，kind exact），工具计数不变（12 个）', () => {
  const { ctx, webRoutes, registered } = makeCtx({})
  apply(ctx)
  const sessions = webRoutes.find((r) => r.path === '/api-import/sessions')
  const imp = webRoutes.find((r) => r.path === '/api-import/import')
  assert.ok(sessions)
  assert.ok(imp)
  assert.equal(sessions.kind, 'exact')
  assert.equal(imp.kind, 'exact')
  assert.equal(typeof sessions.handler, 'function')
  assert.equal(typeof imp.handler, 'function')
  // 从文件导入一族（面板「从文件导入」）：预览/导入、上传三步、暂存维护
  for (const path of ['/api-import/file', '/api-import/upload/init', '/api-import/upload/chunk', '/api-import/upload/complete', '/api-import/uploads']) {
    const route = webRoutes.find((r) => r.path === path)
    assert.ok(route, 'route ' + path + ' 已注册')
    assert.equal(route.kind, 'exact')
    assert.equal(typeof route.handler, 'function')
  }
  // 只加路由，不加工具：import_chat 分流 18 来源 + import_agents + doctor + import_mcp + import_settings + scan/export_chat/list/retract + bundle 导出/还原 + verify = 12，注册数不变
  assert.equal(registered.length, 12)
})

test('REQ-41 webServer 可选：headless（无 webServer）apply 不抛错、12 工具照常注册、无路由', () => {
  const { ctx, webRoutes, registered } = makeCtx({}, { noWebServer: true })
  apply(ctx)
  // 缺 webServer 只是不注册面板路由，导入工具不受影响（CI headless 冒烟场景）
  assert.equal(webRoutes.length, 0)
  assert.equal(registered.length, 12)
})

test('REQ-41 /api-import/sessions handler：合成夹具经 discoverSessions 返回会话、未知来源 400', async () => {
  const root = 'D:\\demo\\claude\\projects'
  const tree = {
    [root]: 'dir',
    [root + '\\proj-a']: 'dir',
    [root + '\\proj-a\\sess-aaa.jsonl']: [
      '{"sessionId":"sess-aaa","type":"user","cwd":"D:\\\\demo\\\\claude-proj","message":{"role":"user","content":"帮我重构这个模块"}}',
      '{"sessionId":"sess-aaa","type":"assistant","message":{"role":"assistant","content":"好"}}',
    ].join('\n'),
    [root + '\\proj-b']: 'dir',
    [root + '\\proj-b\\sess-bbb.jsonl']: [
      '{"sessionId":"sess-bbb","type":"user","message":{"role":"user","content":"<system-reminder>系统注入，不是提问</system-reminder>"}}',
      '{"sessionId":"sess-bbb","type":"user","message":{"role":"user","content":"真实问题"}}',
      '{"sessionId":"sess-bbb","type":"assistant","message":{"role":"assistant","content":"好"}}',
    ].join('\n'),
  }
  const { ctx, webRoutes } = makeCtx(tree)
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/sessions')
  const invoke = async (body) => {
    const req = { async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } }
    const res = {
      status: null, headers: null, body: null,
      writeHead(s, h) { this.status = s; this.headers = h },
      end(b) { this.body = b },
    }
    await route.handler(req, res)
    return { res, data: JSON.parse(res.body) }
  }

  // claude-code 来源（SOURCE_FORMAT → claude）：discoverSessions 返回 2 个会话
  const first = await invoke({ source: 'claude-code', path: root })
  assert.equal(first.res.status, 200)
  assert.equal(first.data.ok, true)
  assert.equal(first.data.sessions.length, 2)
  const aaa = first.data.sessions.find((s) => s.sessionId === 'sess-aaa')
  assert.ok(aaa)
  assert.equal(aaa.format, 'claude')
  assert.equal(aaa.title, '帮我重构这个模块')
  assert.equal(aaa.importStatus, 'not-imported') // registry 为空
  const bbb = first.data.sessions.find((s) => s.sessionId === 'sess-bbb')
  assert.equal(bbb.title, '真实问题') // 注入首行被过滤（REQ-40 标题提取）
  assert.ok(bbb.sourcePath.endsWith('sess-bbb.jsonl'))

  // query 过滤透传
  const q = await invoke({ source: 'claude-code', path: root, query: '重构' })
  assert.equal(q.data.ok, true)
  assert.equal(q.data.sessions.length, 1)
  assert.equal(q.data.sessions[0].sessionId, 'sess-aaa')

  // source 省略/空串 = 扫全部格式（面板「全部来源」按工作区分组浏览）；其余格式自拒
  const all = await invoke({ path: root })
  assert.equal(all.data.ok, true)
  assert.equal(all.data.sessions.length, 2)
  assert.ok(all.data.sessions.every((s) => s.format === 'claude'))

  // 未知来源 → 400 {ok:false, error}
  const bad = await invoke({ source: 'not-a-source', path: root })
  assert.equal(bad.res.status, 400)
  assert.equal(bad.data.ok, false)
  assert.match(bad.data.error, /未知来源/)
})

test('REQ-41 /api-import/sessions handler：qoder 来源映射（SOURCE_FORMAT → qoder）', async () => {
  const root = 'D:\\demo\\.qoder\\projects'
  const tree = {
    [root]: 'dir',
    [root + '\\-home-u-demo']: 'dir',
    [root + '\\-home-u-demo\\sess-q1.jsonl']: [
      '{"sessionId":"sess-q1","type":"user","cwd":"/home/u/demo","message":{"role":"user","content":"帮我看看构建"}}',
      '{"sessionId":"sess-q1","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"好"}]}}',
      '{"type":"ai-title","aiTitle":"自定义标题","sessionId":"sess-q1"}',
    ].join('\n'),
  }
  const { ctx, webRoutes } = makeCtx(tree)
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/sessions')
  const req = { async *[Symbol.asyncIterator]() { yield JSON.stringify({ source: 'qoder', path: root }) } }
  const res = { status: null, headers: null, body: null, writeHead(s, h) { this.status = s; this.headers = h }, end(b) { this.body = b } }
  await route.handler(req, res)
  const data = JSON.parse(res.body)
  assert.equal(res.status, 200)
  assert.equal(data.ok, true)
  assert.equal(data.sessions.length, 1)
  assert.equal(data.sessions[0].format, 'qoder')
  assert.equal(data.sessions[0].sessionId, 'sess-q1')
  assert.equal(data.sessions[0].title, '自定义标题')
})

test('REQ-41 /api-import/sessions handler：分页（offset/limit + total）+ 搜索组合', async () => {
  const root = 'D:\\demo\\claude\\projects'
  const tree = {
    [root]: 'dir',
    [root + '\\proj-a']: 'dir',
    [root + '\\proj-a\\sess-aaa.jsonl']: '{"sessionId":"sess-aaa","type":"user","cwd":"D:\\\\demo\\\\proj-a","message":{"role":"user","content":"第一个问题"}}\n{"sessionId":"sess-aaa","type":"assistant","message":{"role":"assistant","content":"ok"}}',
    [root + '\\proj-b']: 'dir',
    [root + '\\proj-b\\sess-bbb.jsonl']: '{"sessionId":"sess-bbb","type":"user","cwd":"D:\\\\demo\\\\proj-b","message":{"role":"user","content":"第二个问题"}}\n{"sessionId":"sess-bbb","type":"assistant","message":{"role":"assistant","content":"ok"}}',
    [root + '\\proj-c']: 'dir',
    [root + '\\proj-c\\sess-ccc.jsonl']: '{"sessionId":"sess-ccc","type":"user","cwd":"D:\\\\demo\\\\proj-c","message":{"role":"user","content":"第三个问题"}}\n{"sessionId":"sess-ccc","type":"assistant","message":{"role":"assistant","content":"ok"}}',
  }
  const { ctx, webRoutes } = makeCtx(tree)
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/sessions')
  const invoke = async (body) => {
    const req = { async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } }
    const res = { status: null, headers: null, body: null, writeHead(s, h) { this.status = s; this.headers = h }, end(b) { this.body = b } }
    await route.handler(req, res)
    return { res, data: JSON.parse(res.body) }
  }

  // 第 0 页 limit=2：返回 2 条 + 过滤后总数 3（discovery 排序稳定：目录名序 aaa/bbb/ccc）
  const p0 = await invoke({ source: 'claude-code', path: root, limit: 2 })
  assert.equal(p0.res.status, 200)
  assert.equal(p0.data.ok, true)
  assert.equal(p0.data.sessions.length, 2)
  assert.equal(p0.data.total, 3)
  assert.equal(p0.data.limit, 2)
  assert.equal(p0.data.offset, 0)
  assert.deepEqual(p0.data.sessions.map((s) => s.sessionId), ['sess-aaa', 'sess-bbb'])

  // 第 1 页（offset=2）：返回剩余 1 条，total 不变
  const p1 = await invoke({ source: 'claude-code', path: root, limit: 2, offset: 2 })
  assert.equal(p1.data.sessions.length, 1)
  assert.equal(p1.data.total, 3)
  assert.equal(p1.data.sessions[0].sessionId, 'sess-ccc')

  // 搜索 + 分页组合：query 先过滤（total 收窄）再切片
  const q = await invoke({ source: 'claude-code', path: root, query: '第二个', limit: 2 })
  assert.equal(q.data.total, 1)
  assert.equal(q.data.sessions.length, 1)
  assert.equal(q.data.sessions[0].sessionId, 'sess-bbb')

  // limit 缺省：不分页返回全部（limit = 实际长度）
  const all = await invoke({ source: 'claude-code', path: root })
  assert.equal(all.data.sessions.length, 3)
  assert.equal(all.data.limit, 3)
})

test('REQ-41 /api-import/sessions 流式：后台扫描 + after 游标轮询（增量去重、epoch 换键）', async () => {
  const root = 'D:\\demo\\claude\\projects'
  const tree = {
    [root]: 'dir',
    [root + '\\proj-a']: 'dir',
    [root + '\\proj-a\\sess-aaa.jsonl']: '{"sessionId":"sess-aaa","type":"user","cwd":"D:\\\\demo\\\\proj-a","message":{"role":"user","content":"第一个问题"}}\n{"sessionId":"sess-aaa","type":"assistant","message":{"role":"assistant","content":"ok"}}',
    [root + '\\proj-b']: 'dir',
    [root + '\\proj-b\\sess-bbb.jsonl']: '{"sessionId":"sess-bbb","type":"user","cwd":"D:\\\\demo\\\\proj-b","message":{"role":"user","content":"第二个问题"}}\n{"sessionId":"sess-bbb","type":"assistant","message":{"role":"assistant","content":"ok"}}',
  }
  const { ctx, webRoutes } = makeCtx(tree)
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/sessions')
  const invoke = async (body) => {
    const req = { async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } }
    const res = { status: null, headers: null, body: null, writeHead(s, h) { this.status = s; this.headers = h }, end(b) { this.body = b } }
    await route.handler(req, res)
    return { res, data: JSON.parse(res.body) }
  }

  // 首请求创建后台扫描并立即返回当前增量（done 前按 cursor 轮询）
  const p0 = await invoke({ source: 'claude-code', path: root, epoch: 1, after: 0 })
  assert.equal(p0.res.status, 200)
  assert.equal(p0.data.ok, true)
  assert.equal(typeof p0.data.cursor, 'number')
  assert.equal(p0.data.offset, undefined) // 流式响应不带旧契约分页字段

  // 客户端按 cursor 轮询直至 done：增量按 seq 去重，最终集合 = 全量发现
  const all = []
  let after = 0
  let guard = 0
  for (;;) {
    const r = await invoke({ source: 'claude-code', path: root, epoch: 1, after })
    assert.equal(r.data.ok, true)
    for (const s of r.data.sessions) {
      assert.ok(!all.includes(s.sessionId), '游标增量不应重复: ' + s.sessionId)
      all.push(s.sessionId)
    }
    after = r.data.cursor
    if (r.data.done === true) {
      assert.equal(r.data.total, 2)
      break
    }
    // 后台扫描在事件循环里异步推进：轮询需让出（生产端客户端按 ~250ms 轮询）
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.ok(guard++ < 200, '扫描未在 200 次轮询内完成')
  }
  assert.deepEqual([...all].sort(), ['sess-aaa', 'sess-bbb'])

  // epoch 变化 → 新扫描键（刷新语义）：重新产出同一集合
  const again = await invoke({ source: 'claude-code', path: root, epoch: 2, after: 0 })
  assert.equal(again.data.ok, true)
  if (again.data.done === true) {
    assert.deepEqual(again.data.sessions.map((s) => s.sessionId).sort(), ['sess-aaa', 'sess-bbb'])
  }

  // query 过滤透传（流式模式同样作用于产出路径）
  const q = await invoke({ source: 'claude-code', path: root, query: '第二个', epoch: 3, after: 0 })
  assert.equal(q.data.ok, true)
  if (q.data.done === true) {
    assert.deepEqual(q.data.sessions.map((s) => s.sessionId), ['sess-bbb'])
    assert.equal(q.data.total, 1)
  }

  // 未知来源 → 400（流式模式同样先校验）
  const bad = await invoke({ source: 'nope', epoch: 1, after: 0 })
  assert.equal(bad.res.status, 400)
  assert.equal(bad.data.ok, false)
})

test('REQ-41 /api-import/sessions 流式：超大库按 STREAM_CHUNK 分块交付、游标收敛无重复', async () => {
  const root = 'D:\\demo\\claude\\projects-big'
  const N = 2100
  const tree = { [root]: 'dir', [root + '\\proj-a']: 'dir' }
  for (let i = 0; i < N; i++) {
    const p = root + '\\proj-a\\sess-' + i + '.jsonl'
    tree[p] = '{"sessionId":"sess-' + i + '","type":"user","cwd":"D:\\\\demo\\\\proj-a","message":{"role":"user","content":"问题' + i + '"}}\n' +
      '{"sessionId":"sess-' + i + '","type":"assistant","message":{"role":"assistant","content":"ok"}}'
  }
  const { ctx, webRoutes } = makeCtx(tree)
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/sessions')
  const invoke = async (body) => {
    const req = { async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } }
    const res = { status: null, headers: null, body: null, writeHead(s, h) { this.status = s; this.headers = h }, end(b) { this.body = b } }
    await route.handler(req, res)
    return { res, data: JSON.parse(res.body) }
  }

  // 轮询收敛：单响应长度有界（≤500）、游标单调、无重复、最终全量交付
  const all = []
  let after = 0
  let guard = 0
  for (;;) {
    const r = await invoke({ source: 'claude-code', path: root, epoch: 9, after })
    assert.equal(r.data.ok, true)
    assert.ok(r.data.sessions.length <= 500, '单响应超过分块上限: ' + r.data.sessions.length)
    for (const s of r.data.sessions) {
      assert.ok(!all.includes(s.sessionId), '游标增量不应重复: ' + s.sessionId)
      all.push(s.sessionId)
    }
    assert.ok(r.data.cursor >= after, '游标不应回退')
    after = r.data.cursor
    if (r.data.done === true) break
    await new Promise((resolve) => setTimeout(resolve, 3))
    assert.ok(guard++ < 500, '未在 500 次轮询内收敛')
  }
  assert.equal(all.length, N)
  assert.equal(new Set(all).size, N)
  assert.equal(after, N)
})

test('REQ-41 /api-import/prefs：settings 缺席回退默认；在场时读/写走 fenced 路由（revision 冲突保护）', async () => {
  const invoke = async (route, body) => {
    const req = { async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } }
    const res = { status: null, headers: null, body: null, writeHead(s, h) { this.status = s; this.headers = h }, end(b) { this.body = b } }
    await route.handler(req, res)
    return { res, data: JSON.parse(res.body) }
  }

  // settings 服务缺席（默认 makeCtx）：读回默认 + available:false；写原样返回不抛
  const { ctx, webRoutes } = makeCtx({})
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/prefs')
  assert.ok(route, '面板注册了 /api-import/prefs 路由')
  const r0 = await invoke(route, {})
  assert.equal(r0.res.status, 200)
  assert.equal(r0.data.ok, true)
  assert.equal(r0.data.available, false)
  // settings 缺席回退 IMPORT_PREFS_DEFAULT：injectTools 默认档 'minimal'，sidebarButton 默认 true
  assert.deepEqual(r0.data.value, { importSystemPrompt: true, injectTools: 'minimal', sidebarButton: true })
  const w0 = await invoke(route, { importSystemPrompt: true })
  assert.equal(w0.data.ok, true)
  assert.equal(w0.data.available, false)

  // settings 在场：describe 读 value+revision，update 携带 expectedRevision
  const calls = []
  const settingsStub = {
    register(ns, schema) { return { ns, schema } },
    describe(opts) {
      assert.equal(opts.redactSecrets, true)
      return [{ ns: 'chat-import', value: { importSystemPrompt: false, injectTools: true }, revision: 7 }]
    },
    async update(ns, patch, expectedRevision) { calls.push({ ns, patch, expectedRevision }) },
    get(_ns) { return { importSystemPrompt: false, injectTools: true } },
  }
  const { ctx: ctx2, webRoutes: routes2 } = makeCtx({}, { services: { settings: settingsStub } })
  apply(ctx2)
  const route2 = routes2.find((r) => r.path === '/api-import/prefs')
  const r = await invoke(route2, {})
  assert.equal(r.data.ok, true)
  assert.equal(r.data.available, true)
  assert.equal(r.data.revision, 7)
  assert.deepEqual(r.data.value, { importSystemPrompt: false, injectTools: true })
  const w = await invoke(route2, { importSystemPrompt: true, revision: 7 })
  assert.equal(w.data.ok, true)
  assert.deepEqual(calls, [{ ns: 'chat-import', patch: { importSystemPrompt: true }, expectedRevision: 7 }])
  // injectTools 写入同样走 fenced 路由（第二个开关共用同一偏好命名空间）
  const w2 = await invoke(route2, { injectTools: false, revision: 7 })
  assert.equal(w2.data.ok, true)
  assert.deepEqual(calls, [
    { ns: 'chat-import', patch: { importSystemPrompt: true }, expectedRevision: 7 },
    { ns: 'chat-import', patch: { injectTools: false }, expectedRevision: 7 },
  ])
  // sidebarButton 写入同样走 fenced 路由（第三个开关共用同一偏好命名空间）
  const w3 = await invoke(route2, { sidebarButton: false, revision: 7 })
  assert.equal(w3.data.ok, true)
  assert.deepEqual(calls, [
    { ns: 'chat-import', patch: { importSystemPrompt: true }, expectedRevision: 7 },
    { ns: 'chat-import', patch: { injectTools: false }, expectedRevision: 7 },
    { ns: 'chat-import', patch: { sidebarButton: false }, expectedRevision: 7 },
  ])

  // update 抛冲突 → ok:false + code: settings-conflict（客户端据此重读）
  const conflictStub = {
    ...settingsStub,
    async update() {
      const e = new Error('settings namespace "chat-import" changed since it was read (expected 7, now 8)')
      e.name = 'SettingsConflictError'
      throw e
    },
  }
  const { ctx: ctx3, webRoutes: routes3 } = makeCtx({}, { services: { settings: conflictStub } })
  apply(ctx3)
  const route3 = routes3.find((r) => r.path === '/api-import/prefs')
  const wc = await invoke(route3, { importSystemPrompt: true, revision: 7 })
  assert.equal(wc.data.ok, false)
  assert.equal(wc.data.code, 'settings-conflict')
})

test('REQ-55 面板发现 + scan_discover：归档目标 importStatus=archived（可重导），未归档导入仍 imported', async () => {
  const root = 'D:\\demo\\claude\\projects'
  const file = root + '\\proj-a\\sess-aaa.jsonl'
  const tree = {
    [root]: 'dir',
    [root + '\\proj-a']: 'dir',
    [file]: '{"sessionId":"sess-aaa","type":"user","cwd":"D:\\\\demo\\\\claude-proj","message":{"role":"user","content":"问题"}}\n{"sessionId":"sess-aaa","type":"assistant","message":{"role":"assistant","content":"好"}}',
  }
  const { ctx, webRoutes } = makeCtx(tree)
  apply(ctx)
  const imp = chatDef(ctx, 'claude')
  await imp.execute({ path: file })
  const wr = ctx.get('workspaceRegistry')
  await wr.archiveSession('import-sess-aaa')

  // 面板数据源：/api-import/sessions 返回 archived（客户端据此显示「已归档」+ 导入按钮）
  const route = webRoutes.find((r) => r.path === '/api-import/sessions')
  const invoke = async (body) => {
    const req = { async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } }
    const res = { status: null, headers: null, body: null, writeHead(s, h) { this.status = s; this.headers = h }, end(b) { this.body = b } }
    await route.handler(req, res)
    return { res, data: JSON.parse(res.body) }
  }
  const panel = await invoke({ source: 'claude-code', path: root })
  assert.equal(panel.data.ok, true)
  assert.equal(panel.data.sessions[0].importStatus, 'archived')

  // scan_discover 同口径（schema 含 archived）
  const scan = toolDef(ctx, 'scan_discover')
  const found = await scan.execute({ path: root })
  assert.equal(found.sessions.find((s) => s.sessionId === 'sess-aaa').importStatus, 'archived')
  assert.deepEqual(validateJsonSchemaValue(scan.output.schema, found), [])
})

test('REQ-41 /api-import/import handler：单选导入（claude 夹具）→ imported，幂等重导 → already-imported，归组一致', async () => {
  const root = 'D:\\demo\\claude\\projects'
  const src = root + '\\proj-a\\sess-aaa.jsonl'
  const tree = {
    [root]: 'dir',
    [root + '\\proj-a']: 'dir',
    [src]: [
      '{"sessionId":"sess-aaa","type":"user","cwd":"D:\\\\demo\\\\claude-proj","message":{"role":"user","content":"帮我重构这个模块"}}',
      '{"sessionId":"sess-aaa","type":"assistant","message":{"role":"assistant","content":"好"}}',
    ].join('\n'),
  }
  const { ctx, persistence, attached, webRoutes } = makeCtx(tree)
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/import')
  assert.ok(route)

  const one = await invokeImportRoute(route, { items: [{ source: 'claude-code', sourcePath: src }] })
  assert.equal(one.res.status, 200)
  assert.equal(one.data.ok, true)
  assert.equal(one.data.results.length, 1)
  assert.equal(one.data.results[0].status, 'imported')
  assert.equal(one.data.results[0].mode, 'single')
  assert.equal(one.data.results[0].sessionId, 'import-sess-aaa')
  assert.equal(persistence.sessions.size, 1)
  // 面板导入与 import_* 工具一致：cwd → workspace attach
  assert.ok(attached.some((a) => a.ws === 'D:\\demo\\claude-proj'))

  // 幂等：同一 sourcePath 再导 → already-imported，不重复落盘
  const again = await invokeImportRoute(route, { items: [{ source: 'claude-code', sourcePath: src }] })
  assert.equal(again.data.ok, true)
  assert.equal(again.data.results[0].status, 'already-imported')
  assert.equal(persistence.sessions.size, 1)
})

test('/api-import/import：kilocode 多选只导所选会话（multiSession 由 spec 派生）', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const { ctx, persistence, webRoutes } = makeCtx({})
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/import')
  const out = await invokeImportRoute(route, { items: [{ source: 'kilocode', sourcePath: dbPath, sessionId: 'ses-b' }] })
  assert.equal(out.data.ok, true, JSON.stringify(out.data))
  assert.equal(out.data.results[0].mode, 'batch')
  assert.equal(out.data.results[0].imported, 1)
  assert.deepEqual([...persistence.sessions.keys()], ['import-ses-b'])
})

test('REQ-41 /api-import/sessions handler：source dsh4 是已知来源（来源列表拆代次后不能漏）', async () => {
  // 面板的 SOURCE_FORMAT 与 discovery 的 FORMATS 必须同步：漏掉 dsh4 时面板会回
  // 「未知来源: dsh4」→ 列表空、默认「导入到」也拿不到 dshVersion。
  const { ctx, webRoutes } = makeCtx({})
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/sessions')
  assert.ok(route)
  const { res, data } = await invokeImportRoute(route, { source: 'dsh4', after: 0 })
  assert.equal(res.status, 200, JSON.stringify(data))
  assert.equal(data.ok, true)
  assert.equal(typeof data.dshVersion, 'number')
  const dsh = await invokeImportRoute(route, { source: 'dsh', after: 0 })
  assert.equal(dsh.res.status, 200, JSON.stringify(dsh.data))
  // 未知来源仍 400
  const bad = await invokeImportRoute(route, { source: 'dsh9', after: 0 })
  assert.equal(bad.res.status, 400)
})

test('REQ-41 /api-import/import handler：target dsh3 / dsh4 显式指定会话日志代次（header.version）', async () => {
  // 宿主按 header.version 落盘（sessionPersistence.create(header) 认它），所以面板的
  // 「导入到 → DSH（V3/V4 会话格式）」要能把 header 与事件形状一起按该代次产出。
  const root = 'D:\\demo\\claude\\projects'
  const mk = (name) => [
    '{"sessionId":"' + name + '","type":"user","cwd":"/demo/claude-proj","message":{"role":"user","content":"代次目标"}}',
    '{"sessionId":"' + name + '","type":"assistant","message":{"role":"assistant","content":"好"}}',
  ].join('\n')
  const src3 = root + '\\proj-v3\\sess-v3.jsonl'
  const src4 = root + '\\proj-v4\\sess-v4.jsonl'
  const tree = { [root]: 'dir', [root + '\\proj-v3']: 'dir', [root + '\\proj-v4']: 'dir', [src3]: mk('sess-v3'), [src4]: mk('sess-v4') }
  const { ctx, persistence, webRoutes } = makeCtx(tree)
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/import')

  const v3 = await invokeImportRoute(route, { items: [{ source: 'claude-code', sourcePath: src3 }], target: 'dsh3' })
  assert.equal(v3.data.ok, true, JSON.stringify(v3.data))
  assert.equal(v3.data.target, 'dsh3')
  // 会话 id 由转换层按源 id 派生；这里只认「落盘了且 header.version = 3」
  const idsV3 = [...persistence.sessions.keys()]
  assert.equal(idsV3.length, 1, JSON.stringify(v3.data.results))
  assert.equal(persistence.sessions.get(idsV3[0]).meta.version, 3)
  assert.equal(persistence.sessions.get(idsV3[0]).events[0].type, 'turn/start')

  const v4 = await invokeImportRoute(route, { items: [{ source: 'claude-code', sourcePath: src4 }], target: 'dsh4' })
  assert.equal(v4.data.ok, true, JSON.stringify(v4.data))
  const idsV4 = [...persistence.sessions.keys()].filter((id) => !idsV3.includes(id))
  assert.equal(idsV4.length, 1, JSON.stringify([...persistence.sessions.keys()]))
  assert.equal(persistence.sessions.get(idsV4[0]).meta.version, 4)

  // 未知目标仍 400（dsh3 / dsh4 是 DSH 目标，不是转投目标）
  const bad = await invokeImportRoute(route, { items: [{ source: 'claude-code', sourcePath: src3 }], target: 'dsh9' })
  assert.equal(bad.res.status, 400)
})

test('REQ-41 面板显式目标代次 = 宿主原生代次 → 走 agents.create（会话即时进列表，无需刷新）', async () => {
  // 面板「导入到」的默认目标取自扫描到的 dshVersion（= 宿主原生代次）。此时代次覆盖与
  // 原生一致，必须走 agents.create：它会 enter + announce 会话，宿主 api-session-controller
  // 据此转发 api-session/added，客户端会话列表无需刷新即出现新会话。sessionPersistence.create
  // 只落盘、不进内存会话表，因此此前默认路径（覆盖恒生效）导入后必须刷新页面。
  // 目标代次与原生不一致（此处 V4 宿主上的 target=dsh3）时才只能直写——原生 store 只认
  // 原生形状，塞旧代次会被拒。
  const root = 'D:\\demo\\claude\\projects'
  const mk = (name) => [
    '{"sessionId":"' + name + '","type":"user","cwd":"/demo/claude-proj","message":{"role":"user","content":"代次目标"}}',
    '{"sessionId":"' + name + '","type":"assistant","message":{"role":"assistant","content":"好"}}',
  ].join('\n')
  const src4 = root + '\\proj-v4\\sess-v4.jsonl'
  const src3 = root + '\\proj-v3\\sess-v3.jsonl'
  const tree = { [root]: 'dir', [root + '\\proj-v4']: 'dir', [root + '\\proj-v3']: 'dir', [src4]: mk('sess-v4'), [src3]: mk('sess-v3') }
  const agentsCalls = []
  const services = {
    agents: {
      async create({ sessionId, meta, seed }) {
        agentsCalls.push({ sessionId, meta, seed })
        await persistence.create(meta)
        await persistence.append(sessionId, seed)
      },
    },
  }
  const { ctx, persistence, webRoutes } = makeCtx(tree, { services })
  // 宿主原生代次由存量会话 header 推断（插件不 import 宿主包）：空库时默认常量是 V3，
  // 会掩盖「原生 = 4」的分支。先落一条 V4 存量会话，模拟真实的 V4 宿主。
  persistence.sessions.set('host-existing-v4', { meta: { id: 'host-existing-v4', version: 4, createdAt: 1, isSeeded: false, delegationDepth: 0 }, events: [] })
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/import')

  const v4 = await invokeImportRoute(route, { items: [{ source: 'claude-code', sourcePath: src4 }], target: 'dsh4' })
  assert.equal(v4.data.ok, true, JSON.stringify(v4.data))
  assert.equal(agentsCalls.length, 1, '目标代次 = 原生代次必须走 agents.create（发 session/created）')
  assert.equal(agentsCalls[0].meta.version, 4)

  const v3 = await invokeImportRoute(route, { items: [{ source: 'claude-code', sourcePath: src3 }], target: 'dsh3' })
  assert.equal(v3.data.ok, true, JSON.stringify(v3.data))
  assert.equal(agentsCalls.length, 1, '目标代次 ≠ 原生代次不得走 agents.create（store 只认原生形状）')
  assert.ok([...persistence.sessions.values()].some((s) => s.meta.version === 3), [...persistence.sessions.keys()].join(','))
})

test('REQ-41 /api-import/import handler：DSH 源 .zstd 日志必须解压后导入（面板不能丢 spec.readText）', async () => {
  // 回归：面板/命令的 importDiscoveryItem 曾漏传 spec.readText，.zstd 被当二进制读 →
  // 转换出 0 轮 → skipped（「只会归档旧会话、不导入新会话」的直接成因）。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-panel-zstd-'))
  const file = writeDshLog(dir, 'session.v3.jsonl.zstd', 'sess-panel-zstd', { compress: true })
  const { ctx, persistence, webRoutes } = makeCtx({})
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/import')
  assert.ok(route)

  const out = await invokeImportRoute(route, { items: [{ source: 'dsh', sourcePath: file, sessionId: 'sess-panel-zstd' }], target: 'dsh4' })
  assert.equal(out.data.ok, true, JSON.stringify(out.data))
  assert.equal(out.data.results[0].status, 'imported', JSON.stringify(out.data.results))
  assert.equal(out.data.results[0].turns, 1, '多帧 zstd 日志的对话必须全部解出（只解首帧会 0 轮 → skipped）')
  const stored = persistence.sessions.get('import-sess-panel-zstd')
  assert.ok(stored, [...persistence.sessions.keys()].join(','))
  assert.equal(stored.meta.version, 4)
  assert.equal(stored.events.filter((e) => e.type === 'user/message').length, 1)
})

test('REQ-41 面板「导入并归档」：导入未成功的源会话绝不归档（不两头落空）', async () => {
  // 归档是不可逆的隐藏动作（平台无取消归档面），只有确实建出/续写/已存在新会话的
  // 源会话才允许归档；skipped / failed 的条目归档会让用户既看不到旧会话、也没有新会话。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-panel-arch-'))
  // 两条都压缩（真实宿主形态）：空日志 → skipped，正常日志 → imported
  const empty = writeDshLog(dir, 'session.v3.jsonl.zstd', 'sess-empty-001', { withEvents: false, compress: true })
  const good = writeDshLog(dir, 'session.v4.jsonl.zstd', 'sess-good-001', { compress: true })
  const { ctx, persistence, webRoutes } = makeCtx({})
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/import')
  const out = await invokeImportRoute(route, {
    items: [
      { source: 'dsh', sourcePath: empty, sessionId: 'sess-empty-001' },
      { source: 'dsh4', sourcePath: good, sessionId: 'sess-good-001' },
    ],
    target: 'dsh3',
    archiveSources: true,
  })
  assert.equal(out.data.ok, true, JSON.stringify(out.data))
  assert.equal(out.data.archived, 1, JSON.stringify(out.data))
  assert.equal(out.data.archiveSkipped, 1, JSON.stringify(out.data))
  assert.deepEqual(ctx.get('workspaceRegistry').archivedSessionIds, ['sess-good-001'])
  assert.ok(persistence.sessions.has('import-sess-good-001'))
})

test('REQ-41 /api-import/import handler：多选同源去重（同 sourcePath 只导一次）+ 空 items 400 + 未知来源 400', async () => {
  const root = 'D:\\demo\\claude\\projects'
  const src = root + '\\proj-a\\sess-aaa.jsonl'
  const tree = {
    [root]: 'dir',
    [root + '\\proj-a']: 'dir',
    [src]: '{"sessionId":"sess-aaa","type":"user","message":{"role":"user","content":"hi"}}\n{"sessionId":"sess-aaa","type":"assistant","message":{"role":"assistant","content":"ok"}}',
  }
  const { ctx, webRoutes } = makeCtx(tree)
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/import')

  // 同一 sourcePath 两个条目（多选命中同一文件）→ 去重只导一次
  const multi = await invokeImportRoute(route, {
    items: [
      { source: 'claude-code', sourcePath: src, sessionId: 'sess-aaa' },
      { source: 'claude-code', sourcePath: src, sessionId: 'whatever' },
    ],
  })
  assert.equal(multi.data.ok, true)
  assert.equal(multi.data.results.length, 1)
  assert.equal(multi.data.results[0].status, 'imported')

  // items 为空 → 400
  const empty = await invokeImportRoute(route, { items: [] })
  assert.equal(empty.res.status, 400)
  assert.equal(empty.data.ok, false)
  assert.match(empty.data.error, /items 为空/)

  // 未知来源 → 400
  const bad = await invokeImportRoute(route, { items: [{ source: 'nope', sourcePath: src }] })
  assert.equal(bad.res.status, 400)
  assert.equal(bad.data.ok, false)
  assert.match(bad.data.error, /未知来源/)
})

test('REQ-41 /api-import/import handler：批量形态（chatgpt conversations.json 一文件多会话 → batch 摘要）', async () => {
  const file = 'D:\\demo\\chatgpt\\conversations.json'
  const { ctx, persistence, webRoutes } = makeCtx({ [file]: load('chatgpt-export.json') })
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/import')

  const out = await invokeImportRoute(route, { items: [{ source: 'chatgpt', sourcePath: file }] })
  assert.equal(out.res.status, 200)
  assert.equal(out.data.ok, true)
  assert.equal(out.data.results.length, 1)
  assert.equal(out.data.results[0].mode, 'batch')
  assert.equal(out.data.results[0].imported, 2)
  assert.equal(out.data.results[0].skipped, 1)
  assert.equal(persistence.sessions.size, 2)
})

test('从文件导入：generic 文档经 local-jsonl 落盘，dry-run 预览带识别信息并符合 output schema', async () => {
  const file = 'D:\\demo\\downloads\\long-tail.json'
  const doc = JSON.stringify({
    interchange: 'dsh-chat-import',
    version: 1,
    meta: { id: 'gen-1', createdAt: 1700000000000 },
    title: '长尾工具会话',
    provider: 'demo-tool',
    turns: [{ prompt: '问一句', steps: [{ content: [{ type: 'text', text: '答一句' }] }] }],
  })
  const { ctx, persistence } = makeCtx({ [file]: doc })
  apply(ctx)
  const def = chatDef(ctx, 'local-jsonl')

  const preview = await def.execute({ path: file, dryRun: true })
  assert.equal(preview.mode, 'single')
  assert.equal(preview.detectedFormat, 'generic')
  assert.equal(preview.detectedBy, 'marker')
  assert.equal(preview.turns, 1)
  assert.equal(preview.title, '长尾工具会话')
  assert.deepEqual(validateJsonSchemaValue(toolDef(ctx, 'import_chat').output.schema, preview), [])
  assert.equal(persistence.sessions.size, 0) // 预览零副作用

  const out = await def.execute({ path: file })
  assert.equal(out.status, 'imported')
  assert.ok(persistence.sessions.has(out.sessionId))
  assert.deepEqual(validateJsonSchemaValue(toolDef(ctx, 'import_chat').output.schema, out), [])
})

test('从文件导入：未识别文件 dry-run 给出全量失败清单（符合 schema、不落盘）', async () => {
  const file = 'D:\\demo\\downloads\\junk.jsonl'
  const { ctx, persistence } = makeCtx({ [file]: '{"foo":1}\n{"bar":2}\n' })
  apply(ctx)
  const def = chatDef(ctx, 'local-jsonl')

  const bad = await def.execute({ path: file, dryRun: true })
  assert.equal(bad.turns, 0)
  assert.ok(Array.isArray(bad.failures) && bad.failures.length > 0)
  assert.ok(bad.failures.every((f) => typeof f.format === 'string' && typeof f.reason === 'string'))
  assert.deepEqual(validateJsonSchemaValue(toolDef(ctx, 'import_chat').output.schema, bad), [])
  assert.equal(persistence.sessions.size, 0)

  // 强制指定错解析器：同样明确失败（不静默产出空会话）
  const forced = await def.execute({ path: file, dryRun: true, parseFormat: 'claude' })
  assert.equal(forced.turns, 0)
  assert.deepEqual(validateJsonSchemaValue(toolDef(ctx, 'import_chat').output.schema, forced), [])
})
