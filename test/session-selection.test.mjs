// test/session-selection.test.mjs — 一库多会话源的「只导所选会话」：spec 的 multiSession 标记是
// 唯一真相源
//
// 导入器按 args.sessionIds 过滤（lib/import-state.mjs 的 sessionSelection）；面板把勾选的
// sessionId 聚合进 sessionIds、import_chat 的 sessionIds 参数描述点名适用来源，两者都只看
// spec.multiSession（lib/tools/import-sources.mjs）。标记漏了，面板勾一条就会把整个库导进来。
// 这里用 Trae Work（state.vscdb 一库多会话）守住面板转发与参数描述。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTools } from '../lib/tools.mjs'
import { registerPanelRoutes } from '../lib/panel.mjs'
import { IMPORT_SPECS } from '../lib/toolkit.mjs'
import { makeCtx } from './_support/fake-host.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'

function traeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-trae-select-'))
  const db = new DatabaseSync(join(dir, 'state.vscdb'))
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB NOT NULL)')
  const session = (id, prompt) => ({
    sessionId: id,
    title: prompt,
    createdAt: '2026-09-30T12:00:00.000Z',
    messages: [{ id: id + '-u', role: 'user', content: prompt }, { id: id + '-a', role: 'assistant', content: 'ok' }],
  })
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('memento/icube-ai-agent-storage', JSON.stringify({
    list: [session('trae-1', '第一个会话'), session('trae-2', '第二个会话')],
  }))
  db.close()
  return join(dir, 'state.vscdb')
}

// 共享假宿主（树为空，fs 全部回退真实磁盘）上注册工具与面板路由；call 直调面板 handler
function makeHost() {
  const { ctx, persistence, registered } = makeCtx({}, { real: true })
  process.env.DSH_HOME = freshDshHome('dsh-home-select-')
  const registryDir = join(process.env.DSH_HOME, 'dsh-chat-import')
  mkdirSync(registryDir, { recursive: true })
  registerTools(ctx, registryDir)
  registerPanelRoutes(ctx, ctx.webServer, registryDir)
  const call = async (path, body) => {
    const route = ctx.webServer.defs.find((r) => r.path === path)
    const req = { async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } }
    const res = { status: null, body: null, writeHead(s) { this.status = s }, end(b) { this.body = b } }
    await route.handler(req, res)
    return { status: res.status, data: JSON.parse(res.body) }
  }
  return { persistence, tools: registered, call }
}

test('trae 是一库多会话源：spec 标 multiSession，import_chat 的 sessionIds 描述点名它', () => {
  const { tools } = makeHost()
  assert.equal(IMPORT_SPECS.get('trae').multiSession, true)
  const chat = tools.find((d) => d.name === 'import_chat')
  assert.match(chat.parameters.properties.sessionIds.description, /\btrae\b/)
})

test('index.d.ts 的 sessionIds 适用来源 = spec 里标 multiSession 的来源', () => {
  makeHost()
  const dts = readFileSync(new URL('../lib/index.d.ts', import.meta.url), 'utf8')
  const m = dts.match(/仅一库多会话来源（([^）]+)）[^\n]*\n\s*sessionIds\?/)
  assert.ok(m, 'index.d.ts 缺少 sessionIds 的适用来源注释')
  const declared = m[1].split('/').map((s) => s.trim()).sort()
  const flagged = [...IMPORT_SPECS.values()].filter((s) => s.multiSession).map((s) => s.format).sort()
  assert.deepEqual(declared, flagged)
})

test('面板只导勾选的 trae 会话：sessionId 聚合进 sessionIds 转给导入器', async () => {
  const dbPath = traeDb()
  const { persistence, call } = makeHost()
  const out = await call('/api-import/import', { items: [{ source: 'trae', sourcePath: dbPath, sessionId: 'trae-2' }] })
  assert.equal(out.status, 200)
  assert.equal(out.data.results.length, 1)
  assert.equal(out.data.results[0].imported, 1)
  const ids = [...persistence.sessions.keys()]
  assert.equal(ids.length, 1, '只建所选那一个会话：' + ids.join(', '))
  assert.match(ids[0], /trae-2/)

  // 再勾另一条：补导它，先前导入的那条不受影响
  const more = await call('/api-import/import', { items: [{ source: 'trae', sourcePath: dbPath, sessionId: 'trae-1' }] })
  assert.equal(more.data.results[0].imported, 1)
  assert.equal(persistence.sessions.size, 2)
})
