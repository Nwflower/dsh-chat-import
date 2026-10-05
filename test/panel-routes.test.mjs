// test/panel-routes.test.mjs — 面板路由的统一 JSON 出口契约
//
// 每条 /api-import/* 路由都经同一个出口：application/json + { ok, ... }；畸形 body 统一
// 500 + { ok:false, error }，参数错误 400。具体业务行为由 index / purge / file-import /
// upload 的路由用例覆盖，这里只守出口形状。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerPanelRoutes } from '../lib/panel.mjs'

function setup() {
  const routes = []
  const ws = { register(def) { routes.push(def); return () => {} } }
  const ctx = { get() { return undefined } }
  const registryDir = mkdtempSync(join(tmpdir(), 'dsh-panel-routes-'))
  registerPanelRoutes(ctx, ws, registryDir)
  const call = async (path, raw) => {
    const route = routes.find((r) => r.path === path)
    assert.ok(route, 'route ' + path)
    const req = { async *[Symbol.asyncIterator]() { if (raw !== undefined) yield raw } }
    const res = {
      status: null, headers: null, body: null,
      writeHead(s, h) { this.status = s; this.headers = h },
      end(b) { this.body = b },
    }
    await route.handler(req, res)
    return { status: res.status, headers: res.headers, data: JSON.parse(res.body) }
  }
  return { routes, call }
}

test('面板路由：全部 exact 注册在 /api-import/ 下', () => {
  const { routes } = setup()
  assert.deepEqual(routes.map((r) => r.path).sort(), [
    '/api-import/file', '/api-import/history', '/api-import/import', '/api-import/prefs',
    '/api-import/purge', '/api-import/sessions', '/api-import/upload/chunk', '/api-import/upload/complete',
    '/api-import/upload/init', '/api-import/uploads', '/api-import/workspaces/cleanup',
  ])
  for (const r of routes) assert.equal(r.kind, 'exact', r.path)
})

test('面板路由：畸形 JSON body 统一 500 + { ok:false, error }，响应恒为 application/json', async () => {
  const { routes, call } = setup()
  for (const { path } of routes) {
    if (path === '/api-import/history' || path === '/api-import/workspaces/cleanup') continue // 不读 body
    const out = await call(path, '{not json')
    assert.equal(out.status, 500, path)
    assert.deepEqual(out.headers, { 'content-type': 'application/json' }, path)
    assert.equal(out.data.ok, false, path)
    assert.equal(typeof out.data.error, 'string', path)
  }
})

test('面板路由：参数错误 400（未知来源 / 空 items / 缺确认 / 未知 mode / 缺路径）', async () => {
  const { call } = setup()
  const cases = [
    ['/api-import/sessions', { source: 'no-such-source' }, '未知来源'],
    ['/api-import/import', { items: [] }, 'items 为空'],
    ['/api-import/import', { items: [{ source: 'claude-code', sourcePath: 'x' }], target: 'nowhere' }, '未知导入目标'],
    ['/api-import/purge', {}, 'confirm:true'],
    ['/api-import/uploads', { mode: 'nope' }, '未知 mode'],
    ['/api-import/uploads', { mode: 'cleanup' }, 'confirm:true'],
    ['/api-import/file', {}, '需要 path'],
  ]
  for (const [path, body, needle] of cases) {
    const out = await call(path, JSON.stringify(body))
    assert.equal(out.status, 400, path + ' ' + JSON.stringify(body))
    assert.equal(out.data.ok, false)
    assert.ok(out.data.error.includes(needle), out.data.error)
  }
})

test('面板路由：claude 在面板里叫 claude-code，其余来源 id 与 discovery format 同名', async () => {
  const { call } = setup()
  const bare = await call('/api-import/sessions', JSON.stringify({ source: 'claude', after: 0 }))
  assert.equal(bare.status, 400, '面板来源 id 是 claude-code，不是 claude')
  for (const source of ['kilocode', 'teleagent', 'dsh4']) {
    const out = await call('/api-import/import', JSON.stringify({ items: [{ source }] }))
    assert.equal(out.status, 400)
    assert.ok(out.data.error.includes('sourcePath'), source + ' 是已知来源，只缺 sourcePath：' + out.data.error)
  }
})

test('面板路由：settings 服务缺席时 /prefs 读回默认值并标 available:false', async () => {
  const { call } = setup()
  const out = await call('/api-import/prefs', '{}')
  assert.equal(out.status, 200)
  assert.equal(out.data.ok, true)
  assert.equal(out.data.available, false)
  assert.equal(out.data.value.importSystemPrompt, true)
})
