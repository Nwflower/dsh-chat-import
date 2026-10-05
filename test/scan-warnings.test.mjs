// test/scan-warnings.test.mjs — 发现层的扫描失败（warnings）端到端可见
//
// discoverSessions 对抛错的扫描目标只跳过该目标、把失败记进 warnings（{ format, target, error }）。
// 这里守住它一路透出到三个出口：scan_discover 工具结果（且仍符合输出 schema）、面板
// /api-import/sessions 的两种契约（分页 / 流式），以及面板客户端的提示文案。
//
// 夹具：一个真实的 SQLite 库，但没有 zcode 的 session 表——摘要读取器查询即抛，属于「读取器
// 异常」而不是「不是该来源的库」。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { clearScanCache, clearInflightScans } from '../lib/discovery.mjs'
import { makeScanTool } from '../lib/tools/scan-tool.mjs'
import { registerPanelRoutes } from '../lib/panel.mjs'

beforeEach(() => {
  clearScanCache()
  clearInflightScans()
})

// 真实磁盘上的 zcode 库位置，但库里没有 session 表
function brokenZcodeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-scan-warn-'))
  const dbDir = join(dir, '.zcode', 'cli', 'db')
  mkdirSync(dbDir, { recursive: true })
  const dbPath = join(dbDir, 'db.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE unrelated (id TEXT)')
  db.close()
  return dbPath
}

// 只读 fs（真实磁盘）：发现层 host 只用 resolve / stat / readText / listDir
function diskCtx() {
  const fs = {
    async resolve(p) { return { targetKey: p, displayPath: p } },
    processPath(t) { return t.targetKey },
    async stat(t) {
      try {
        const s = statSync(t.targetKey)
        return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtimeMs: s.mtimeMs }
      } catch {
        return null
      }
    },
    async readText(t) { return readFileSync(t.targetKey, 'utf8') },
    async listDir() { return [] },
  }
  return { fs, get() { return undefined } }
}

test('scan_discover：扫描失败的目标进结果的 warnings，结果仍符合输出 schema', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const dbPath = brokenZcodeDb()
  const tool = makeScanTool(diskCtx(), mkdtempSync(join(tmpdir(), 'dsh-scan-warn-reg-')))
  const value = await tool.execute({ path: dbPath, format: 'zcode' })
  assert.equal(value.total, 0)
  assert.equal(value.warnings.length, 1)
  assert.equal(value.warnings[0].format, 'zcode')
  assert.equal(value.warnings[0].target, dbPath)
  assert.match(value.warnings[0].error, /session/)
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), [])
  const text = tool.output.render({ path: dbPath }, value).map((b) => b.text).join('\n')
  assert.match(text, /1 个扫描目标失败/)
  assert.match(text, /zcode/)
})

test('scan_discover：全部目标成功时 warnings 为空数组，渲染不提失败', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-scan-ok-'))
  const tool = makeScanTool(diskCtx(), mkdtempSync(join(tmpdir(), 'dsh-scan-ok-reg-')))
  const value = await tool.execute({ path: dir, format: 'claude' })
  assert.deepEqual(value.warnings, [])
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), [])
  const text = tool.output.render({}, value).map((b) => b.text).join('\n')
  assert.doesNotMatch(text, /失败/)
})

// 面板路由：与 test/panel-routes.test.mjs 同一调用方式（handler 直调，响应体按 JSON 解析）
function panel(ctx) {
  const routes = []
  registerPanelRoutes(ctx, { register(def) { routes.push(def); return () => {} } }, mkdtempSync(join(tmpdir(), 'dsh-scan-warn-panel-')))
  return async (path, body) => {
    const route = routes.find((r) => r.path === path)
    const req = { async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } }
    const res = { status: null, body: null, writeHead(s) { this.status = s }, end(b) { this.body = b } }
    await route.handler(req, res)
    return { status: res.status, data: JSON.parse(res.body) }
  }
}

test('面板 /api-import/sessions（分页）：转发 discoverSessions 的 warnings', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const dbPath = brokenZcodeDb()
  const call = panel(diskCtx())
  const out = await call('/api-import/sessions', { source: 'zcode', path: dbPath })
  assert.equal(out.status, 200)
  assert.deepEqual(out.data.sessions, [])
  assert.deepEqual(out.data.warnings.map((w) => [w.format, w.target]), [['zcode', dbPath]])
})

test('面板 /api-import/sessions（流式）：扫描完成的那次响应带 warnings', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const dbPath = brokenZcodeDb()
  const call = panel(diskCtx())
  let last = null
  for (let i = 0; i < 100; i++) {
    last = await call('/api-import/sessions', { source: 'zcode', path: dbPath, after: 0, epoch: 1 })
    assert.equal(last.status, 200)
    if (last.data.done) break
    assert.equal(last.data.warnings, undefined, '扫描未完成时不带 warnings')
    await sleep(10)
  }
  assert.equal(last.data.done, true)
  assert.deepEqual(last.data.warnings.map((w) => [w.format, w.target]), [['zcode', dbPath]])
  assert.match(last.data.warnings[0].error, /session/)
})

// ── 客户端提示文案（bundle 里的纯函数切出来求值，同 test/panel-toast.test.mjs 的做法）──

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function topLevelFunction(name) {
  const start = source.indexOf('function ' + name + '(')
  assert.notEqual(start, -1, 'lib/client.js 缺少函数 ' + name)
  const end = source.indexOf('\n    }\n', start)
  assert.notEqual(end, -1, name + ' 没有可识别的收尾')
  return source.slice(start, end + '\n    }'.length)
}

const tr = (key, vars) => {
  const dict = { 'scan.warnings': '{n} 个扫描目标失败，已跳过：{sources}', 'result.separator': '，' }
  const raw = dict[key]
  assert.ok(raw !== undefined, '缺少字典键 ' + key)
  return String(raw).replace(/\{(\w+)\}/g, (_, k) => String(vars && vars[k] !== undefined ? vars[k] : ''))
}
const labelOf = (format) => ({ zcode: 'ZCode', claude: 'Claude' })[format] || format

const scanWarningNotice = new Function(topLevelFunction('scanWarningNotice') + '\nreturn scanWarningNotice;')()

test('面板提示：无 warnings 不出提示', () => {
  assert.equal(scanWarningNotice([], tr, labelOf), null)
  assert.equal(scanWarningNotice(undefined, tr, labelOf), null)
})

test('面板提示：按来源去重列名，悬浮看逐条失败明细', () => {
  const notice = scanWarningNotice([
    { format: 'zcode', target: '/a/db.sqlite', error: 'no such table: session' },
    { format: 'claude', target: '/b', error: 'EACCES' },
    { format: 'zcode', target: '/c/db.sqlite', error: 'database is locked' },
  ], tr, labelOf)
  assert.equal(notice.text, '3 个扫描目标失败，已跳过：ZCode，Claude')
  assert.equal(notice.title, [
    'zcode @ /a/db.sqlite: no such table: session',
    'claude @ /b: EACCES',
    'zcode @ /c/db.sqlite: database is locked',
  ].join('\n'))
})

test('面板提示：来源过多时只列前三个并省略', () => {
  const notice = scanWarningNotice(['a', 'b', 'c', 'd'].map((f) => ({ format: f, target: '/' + f, error: 'x' })), tr, labelOf)
  assert.equal(notice.text, '4 个扫描目标失败，已跳过：a，b，c …')
})
