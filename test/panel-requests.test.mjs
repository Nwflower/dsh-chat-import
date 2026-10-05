// panel-requests.test.mjs — 面板 → 宿主路由请求的统一出口（utils.js 的 postJson）：
//   1. 面板里所有请求都经 postJson（bundle 里只剩它一处 fetch）——请求头、JSON 体、健壮
//      解析与 ok 判定只有一份，不再在 14 个调用点各抄一遍；
//   2. postJson 的返回口径：{ ok, data, error, status }，网络层失败照常 reject；
//   3. 历史面板的三个动作共用 runAction：动作结束（成功或失败）都解除忙碌并关掉确认框——
//      此前「清理上传暂存」点了确认后弹框不会自己关。
//
// postJson 是纯异步函数（只依赖注入的 fetch）：从 bundle 里切出来跑，测的就是发布的那份。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** 切出 bundle 里一段 4 空格基准缩进的顶层声明（从 start 标记到同缩进的收尾行）。 */
function topLevel(startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, 'lib/client.js 缺少 ' + startMarker)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, startMarker + ' 没有可识别的收尾')
  return source.slice(start, end + endMarker.length)
}

const readJsonSrc = topLevel('const readJson = async (resp) => {', '\n    };')
const postJsonSrc = topLevel('async function postJson(', '\n    }')
const makePostJson = (fetch) => new Function('fetch', readJsonSrc + '\n' + postJsonSrc + '\nreturn postJson;')(fetch)

const fakeResponse = (status, text) => ({ status, text: async () => text })

test('面板请求统一走 postJson：bundle 里只剩一处 fetch，不再到处手写请求头', () => {
  assert.equal(source.split('fetch(').length - 1, 1, '只有 postJson 里调用 fetch')
  assert.equal(source.split('"Content-Type": "application/json"').length - 1, 1, 'JSON 请求头只写一次')
  assert.ok(postJsonSrc.includes('fetch(path, {'), 'fetch 在 postJson 内')
  // 每个路由都经 postJson（数一数调用点，防止有人绕开助手另写 fetch）
  for (const route of ['/api-import/sessions', '/api-import/import', '/api-import/history', '/api-import/purge',
    '/api-import/workspaces/cleanup', '/api-import/uploads', '/api-import/prefs', '/api-import/file',
    '/api-import/upload/init', '/api-import/upload/chunk', '/api-import/upload/complete']) {
    assert.ok(source.includes('postJson("' + route + '"') || source.includes('runAction("' + route + '"'), route + ' 应经 postJson / runAction')
  }
})

test('postJson：POST JSON 体，返回 { ok, data, error, status }', async () => {
  const calls = []
  const postJson = makePostJson(async (path, init) => {
    calls.push({ path, init })
    return fakeResponse(200, JSON.stringify({ ok: true, n: 1 }))
  })
  const r = await postJson('/api-import/x', { a: 1 })
  assert.deepEqual(r, { ok: true, data: { ok: true, n: 1 }, error: null, status: 200 })
  assert.equal(calls[0].path, '/api-import/x')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
  assert.equal(calls[0].init.body, '{"a":1}')
  await postJson('/api-import/y')
  assert.equal(calls[1].init.body, '{}', '无请求体时发空对象')
})

test('postJson：服务端失败带 error 文本；空 / 非 JSON 响应给 data=null；网络层失败照常 reject', async () => {
  const failed = await makePostJson(async () => fakeResponse(500, JSON.stringify({ ok: false, error: 'boom' })))('/p', {})
  assert.deepEqual(failed, { ok: false, data: { ok: false, error: 'boom' }, error: 'boom', status: 500 })
  const empty = await makePostJson(async () => fakeResponse(413, ''))('/p', {})
  assert.deepEqual(empty, { ok: false, data: null, error: null, status: 413 })
  const html = await makePostJson(async () => fakeResponse(502, '<html>bad gateway</html>'))('/p', {})
  assert.equal(html.data, null)
  assert.equal(html.error, null, '没有服务端 error 文本时为 null，调用方套自己的兜底文案')
  await assert.rejects(makePostJson(async () => { throw new Error('offline') })('/p', {}), /offline/)
})

test('postJson：可换解析器（扫描走 Worker 解析 parsePanelResponse）', async () => {
  const postJson = makePostJson(async () => fakeResponse(200, 'ignored'))
  const r = await postJson('/p', {}, async () => ({ ok: true, via: 'custom' }))
  assert.deepEqual(r.data, { ok: true, via: 'custom' })
  assert.match(source, /postJson\("\/api-import\/sessions", \{ source, query, epoch, after \}, parsePanelResponse\)/,
    '扫描轮询仍走 Worker 解析')
})

test('历史面板三个动作共用 runAction：结束后解除忙碌并关闭确认框（含清理上传暂存）', () => {
  const panel = topLevel('function HistoryPanel() {', '\n    }')
  const run = panel.slice(panel.indexOf('const runAction = async (path, body, onDone) => {'))
  assert.ok(run.length > 0 && panel.includes('const runAction = async (path, body, onDone) => {'), 'HistoryPanel 应有 runAction')
  const finallyAt = run.indexOf('} finally {')
  assert.notEqual(finallyAt, -1, 'runAction 要在 finally 里收尾')
  const fin = run.slice(finallyAt, run.indexOf('};', finallyAt))
  assert.match(fin, /setBusy\(false\)/)
  assert.match(fin, /setConfirm\(null\)/, '确认框在动作结束后关闭（此前清理上传暂存后弹框不会自己关）')
  assert.match(run, /setNote\(null\);\s*\n\s*setError\(null\);/, '动作开始时清掉上一次的提示与错误')
  assert.match(panel, /const runPurge = \(body\) => runAction\("\/api-import\/purge"/)
  assert.match(panel, /const runCleanup = \(\) => runAction\("\/api-import\/workspaces\/cleanup"/)
  assert.match(panel, /const runStagingCleanup = \(\) => runAction\("\/api-import\/uploads"/)
})
