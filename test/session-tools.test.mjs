// test/session-tools.test.mjs — panel per-row tools: preview, content search, hide, delete
// source, drop onto a sidebar workspace.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.mjs'
import { clearScanCache } from '../lib/discovery.mjs'
import { makeCtx, makeWorkspaceRegistry } from './_support/fake-host.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'
import { invokeImportRoute } from './_support/index-fixtures.mjs'
import { previewSample } from '../lib/preview-sample.mjs'
import { SearchIndex, searchCacheText, searchTerms, extractRecord, createSearchJobs } from '../lib/session-search.mjs'
import { deleteSourceFiles, sourceFilesOf, hideRows, unhideRows } from '../lib/session-actions.mjs'
import { loadIgnores, rememberIgnore } from '../lib/ignore.mjs'
import { importDiscoveryItem } from '../lib/toolkit.mjs'
import { argsFingerprint } from '../lib/imports.mjs'
import { previewFileTarget } from '../lib/file-import.mjs'
import { restampSession, DESTINATION_FINGERPRINT_KEYS } from '../lib/import-core.mjs'
import { hostAbs, hostAbsText } from './_support/host-path.mjs'

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
})

const line = (o) => JSON.stringify(o)
const PROJECT = hostAbs('D:/demo/proj')
const claudeUser = (text, extra = {}) => line({ sessionId: 's1', type: 'user', cwd: PROJECT, message: { role: 'user', content: text }, ...extra })
const claudeAssistant = (content) => line({ sessionId: 's1', type: 'assistant', message: { role: 'assistant', content } })

// ── preview sample ─────────────────────────────────────────────────

test('previewSample: user / assistant text in order, plugin-injected messages skipped, tool calls folded', () => {
  const events = [
    { type: 'user/message', time: 1, data: { role: 'user', content: [{ type: 'text', text: 'migration notice' }], source: { kind: 'plugin', plugin: 'chat-import' } } },
    { type: 'user/message', time: 2, data: { role: 'user', content: [{ type: 'text', text: 'fix the bug' }] } },
    { type: 'tool/call', time: 3, data: { name: 'Bash' } },
    { type: 'tool/call', time: 4, data: { name: 'Bash' } },
    { type: 'tool/call', time: 5, data: { name: 'Read' } },
    { type: 'assistant/message', time: 6, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } },
  ]
  const out = previewSample(events)
  assert.deepEqual(out.messages.map((m) => [m.role, m.text]), [
    ['user', 'fix the bug'], ['tool', 'Bash ×2, Read'], ['assistant', 'done'],
  ])
  assert.equal(out.total, 2)
  assert.equal(out.truncated, false)
})

test('previewSample: limit caps the sample and reports truncation; long text is clipped', () => {
  const events = []
  for (let i = 0; i < 5; i++) events.push({ type: 'user/message', data: { role: 'user', content: 'x'.repeat(50) + i } })
  const out = previewSample(events, { limit: 2, textMax: 10 })
  assert.equal(out.messages.length, 2)
  assert.equal(out.total, 5)
  assert.equal(out.truncated, true)
  assert.equal(out.messages[0].text, 'xxxxxxxxxx …')
})

// ── content search ─────────────────────────────────────────────────

test('extractRecord: Claude text kept, tool results and meta lines dropped; Codex message read', () => {
  assert.deepEqual(extractRecord(JSON.parse(claudeUser('hello world'))), [{ role: 'u', text: 'hello world' }])
  assert.deepEqual(extractRecord(JSON.parse(claudeUser('injected', { isMeta: true }))), [])
  const toolResult = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'secret build log' }] } }
  assert.deepEqual(extractRecord(toolResult), [])
  assert.deepEqual(extractRecord(JSON.parse(claudeAssistant([{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'Bash' }]))), [{ role: 'a', text: 'ok' }])
  const codex = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex prompt' }] } }
  assert.deepEqual(extractRecord(codex), [{ role: 'u', text: 'codex prompt' }])
  assert.deepEqual(extractRecord({ type: 'response_item', payload: { type: 'function_call_output', output: 'x' } }), [])
})

test('searchCacheText: counts messages with all terms, snippet around first term', () => {
  assert.deepEqual(searchTerms('  Fix   renderer fix '), ['fix', 'renderer'])
  const cache = 'u\tPlease Fix the WebGL renderer\na\tthe renderer is fixed now\nu\tunrelated\n'
  const hit = searchCacheText(cache, ['fix', 'renderer'])
  assert.equal(hit.count, 2) // "fixed" contains "fix"
  assert.equal(hit.snippets[0].role, 'user')
  assert.match(hit.snippets[0].text, /Fix the WebGL renderer/)
  assert.equal(searchCacheText(cache, ['webgl', 'unrelated']).count, 0)
})

test('SearchIndex: builds once, reads only appended bytes of a growing .jsonl, rebuilds a shrunk one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dci-search-'))
  const file = join(dir, 'a.jsonl')
  writeFileSync(file, claudeUser('first message') + '\n' + claudeAssistant('first answer') + '\n')
  const index = new SearchIndex(join(dir, 'registry'))
  const one = await index.refresh(file)
  assert.equal(one, 'u\tfirst message\na\tfirst answer\n')
  // a half-written last line is not indexed yet and not lost
  appendFileSync(file, claudeUser('second message') + '\n' + '{"type":"user","message":{"role":"user","content":"par')
  const two = await index.refresh(file)
  assert.equal(two, 'u\tfirst message\na\tfirst answer\nu\tsecond message\n')
  appendFileSync(file, 'tial line"}}\n')
  const three = await index.refresh(file)
  assert.equal(three.split('\n').filter(Boolean).length, 4)
  assert.match(three, /u\tpartial line\n$/)
  // unchanged → served from the cache (same text, no duplicate append)
  assert.equal(await index.refresh(file), three)
  // the file was rewritten smaller → full rebuild
  writeFileSync(file, claudeUser('rewritten') + '\n')
  assert.equal(await index.refresh(file), 'u\trewritten\n')
  await index.flush()
  const saved = JSON.parse(readFileSync(join(dir, 'registry', 'search-index', 'index.json'), 'utf8'))
  assert.equal(saved.entries[file].offset, Buffer.byteLength(claudeUser('rewritten') + '\n'))
  // directories and unknown extensions are not indexed
  assert.equal(await index.refresh(dir), null)
  writeFileSync(join(dir, 'x.db'), 'binary')
  assert.equal(await index.refresh(join(dir, 'x.db')), null)
})

test('createSearchJobs: hits per source, skipped entries counted, a new query cancels the old one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dci-jobs-'))
  const a = join(dir, 'a.jsonl')
  const b = join(dir, 'b.jsonl')
  writeFileSync(a, claudeUser('deploy the aurora saver') + '\n')
  writeFileSync(b, claudeUser('nothing here') + '\n')
  const jobs = createSearchJobs(join(dir, 'registry'))
  const entries = [
    { format: 'claude', sourcePath: a, sessionId: 'a', processPath: a },
    { format: 'claude', sourcePath: b, sessionId: 'b', processPath: b },
    { format: 'opencode', sourcePath: 'db', sessionId: 'c', processPath: '' },
  ]
  const job = jobs.start('list', 'Aurora deploy', entries, { skip: (e) => !e.processPath })
  while (!job.done) await new Promise((r) => setTimeout(r, 5))
  assert.equal(job.scanned, 3)
  assert.equal(job.skipped, 1)
  assert.deepEqual(job.hits.map((h) => [h.sessionId, h.count]), [['a', 1]])
  assert.strictEqual(jobs.start('list', 'Aurora deploy', entries), job, 'same query reuses the job')
  const next = jobs.start('list', 'other', entries)
  assert.notStrictEqual(next, job)
  assert.equal(job.cancelled, true)
})

// ── delete source ──────────────────────────────────────────────────

test('deleteSourceFiles: Claude transcript goes with its sibling session folder; refuses directories', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dci-del-'))
  const file = join(dir, 'abc.jsonl')
  writeFileSync(file, claudeUser('x') + '\n')
  mkdirSync(join(dir, 'abc', 'subagents'), { recursive: true })
  assert.deepEqual(await sourceFilesOf('claude', file), [file, join(dir, 'abc')])
  assert.deepEqual(await sourceFilesOf('codex', file), [file])
  const recycled = []
  const out = await deleteSourceFiles(dir, 'claude', file, { recycle: async (paths) => { recycled.push(...paths) } })
  assert.deepEqual(recycled, [file, join(dir, 'abc')])
  assert.equal(out.where, 'recycle-bin')
  await assert.rejects(deleteSourceFiles(dir, 'claude', join(dir, 'abc'), { recycle: async () => {} }), /not a file/)
})

test('deleteSourceFiles: off Windows the files move to the plugin trash folder (never unlinked)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dci-trash-'))
  const file = join(dir, 'abc.jsonl')
  writeFileSync(file, 'x\n')
  const out = await deleteSourceFiles(join(dir, 'registry'), 'codex', file, { platform: 'linux' })
  assert.equal(existsSync(file), false)
  assert.equal(readFileSync(join(out.where, 'abc.jsonl'), 'utf8'), 'x\n')
})

// ── routes ─────────────────────────────────────────────────────────

const ROOT = hostAbs('D:/demo/claude/projects')
const SESSION = join(ROOT, 'proj-a', 'sess-aaa.jsonl')
function claudeTree() {
  return {
    [ROOT]: 'dir',
    [join(ROOT, 'proj-a')]: 'dir',
    [SESSION]: [
      hostAbsText('{"sessionId":"sess-aaa","type":"user","cwd":"D:\\\\demo\\\\claude-proj","message":{"role":"user","content":"refactor the module"}}'),
      '{"sessionId":"sess-aaa","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"sure, here is the plan"}]}}',
    ].join('\n'),
  }
}

// chatgpt：一个 conversations.json 承载多条会话（发现层一个文件产出多条行）。
const CHATGPT_DIR = hostAbs('D:/demo/chatgpt')
const CHATGPT_FILE = join(CHATGPT_DIR, 'conversations.json')
function chatgptTree() {
  return {
    [CHATGPT_DIR]: 'dir',
    [CHATGPT_FILE]: JSON.stringify([
      { id: 'conv-1', title: 'one', create_time: 1700000000, mapping: {} },
      { id: 'conv-2', title: 'two', create_time: 1700000100, mapping: {} },
    ]),
  }
}

// codex rollout（发现层按链聚合，预览必须拿得到消息样例）。
const CODEX_DIR = hostAbs('D:/demo/codex')
const CODEX_FILE = join(CODEX_DIR, 'rollout-2025-01-01T00-00-00-thread-x.jsonl')
function codexTree() {
  return {
    [CODEX_DIR]: 'dir',
    [CODEX_FILE]: [
      JSON.stringify({ type: 'session_meta', timestamp: '2025-01-01T00:00:00Z', payload: { id: 'thread-x', cwd: '/tmp' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2025-01-01T00:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex question' }] } }),
      JSON.stringify({ type: 'response_item', timestamp: '2025-01-01T00:00:02Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'codex answer' }] } }),
    ].join('\n') + '\n',
  }
}

function routesFor(opts = {}, tree = claudeTree()) {
  const { ctx, webRoutes, attached } = makeCtx(tree, opts)
  apply(ctx)
  const call = (path, body) => invokeImportRoute(webRoutes.find((r) => r.path === path), body)
  return { call, attached }
}

async function scanAll(call, epoch = 0) {
  const sessions = []
  for (let after = 0, i = 0; i < 200; i++) {
    const { data } = await call('/api-import/sessions', { source: 'claude-code', query: '', path: ROOT, epoch, after })
    sessions.push(...data.sessions)
    after = data.cursor
    if (data.done) break
    await new Promise((r) => setTimeout(r, 5))
  }
  return sessions
}

/** One full streamed scan for an arbitrary sessions request (path omitted = default-root scan). */
async function scanList(call, body) {
  const sessions = []
  for (let after = 0, i = 0; i < 200; i++) {
    const { data } = await call('/api-import/sessions', { query: '', epoch: 0, after, ...body })
    sessions.push(...data.sessions)
    after = data.cursor
    if (data.done) return sessions
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('scan did not finish')
}

const row = { source: 'claude-code', sourcePath: SESSION, sessionId: 'sess-aaa' }

test('route /api-import/preview: discovered row → title + message sample; unknown row 400', async () => {
  const { call } = routesFor()
  await scanAll(call)
  const { res, data } = await call('/api-import/preview', row)
  assert.equal(res.status, 200)
  assert.equal(data.ok, true, data.error)
  assert.deepEqual(data.sample.messages.map((m) => [m.role, m.text]), [['user', 'refactor the module'], ['assistant', 'sure, here is the plan']])
  const bad = await call('/api-import/preview', { ...row, sourcePath: hostAbs('C:/elsewhere/x.jsonl') })
  assert.equal(bad.res.status, 400)
})

test('route /api-import/hide + unhide: hidden rows leave the list on rescan and come back after Undo', async () => {
  const { call } = routesFor()
  assert.equal((await scanAll(call, 1)).length, 1)
  const hidden = await call('/api-import/hide', { items: [row] })
  assert.equal(hidden.data.hidden, 1)
  clearScanCache()
  assert.equal((await scanAll(call, 2)).length, 0)
  // the panel's Undo runs against the list it still shows (epoch 1)
  const back = await call('/api-import/unhide', { items: [row] })
  assert.equal(back.data.unhidden, 1)
  clearScanCache()
  assert.equal((await scanAll(call, 3)).length, 1)
})

test('route /api-import/delete-source: needs confirm:true and a discovered row (nothing touched otherwise)', async () => {
  const { call } = routesFor()
  await scanAll(call)
  const noConfirm = await call('/api-import/delete-source', { items: [row] })
  assert.equal(noConfirm.res.status, 400)
  const unknown = await call('/api-import/delete-source', { confirm: true, items: [{ ...row, sourcePath: hostAbs('C:/Windows/win.ini') }] })
  assert.deepEqual(unknown.data.results.map((r) => r.status), ['failed'])
})

test('route /api-import/import with workspaceId: imported into that workspace; unknown id 400', async () => {
  const registry = makeWorkspaceRegistry()
  const dropDir = hostAbs('D:/work/dev-space')
  const target = await registry.create(dropDir)
  target.id = 'ws-1'
  registry.list = () => [...registry.workspaces.values()]
  const { call, attached } = routesFor({ workspaceRegistry: registry })
  await scanAll(call)
  const bad = await call('/api-import/import', { items: [row], target: 'dsh4', workspaceId: 'nope' })
  assert.equal(bad.res.status, 400)
  // a dropped row must be one the panel discovered: an arbitrary path never becomes a member
  const forged = await call('/api-import/import', {
    items: [{ ...row, sourcePath: hostAbs('C:/elsewhere/x.jsonl') }], target: 'dsh4', workspaceId: 'ws-1',
  })
  assert.equal(forged.res.status, 400)
  const { data } = await call('/api-import/import', { items: [row], target: 'dsh4', workspaceId: 'ws-1' })
  assert.equal(data.ok, true, data.error)
  assert.equal(data.results[0].status, 'imported', JSON.stringify(data.results[0]))
  assert.equal(data.workspace.path, dropDir)
  assert.deepEqual(attached.map((a) => a.ws), [dropDir])
  assert.equal(data.results[0].workspace, dropDir)
})

// ── delete source: default-root scans and per-session rows only ────

test('route /api-import/delete-source: an explicit-path scan is refused, a default-root scan may delete', async () => {
  const { call } = routesFor()
  await scanAll(call)
  const refused = await call('/api-import/delete-source', { confirm: true, items: [row] })
  assert.equal(refused.data.results[0].status, 'refused')
  assert.match(refused.data.results[0].error, /default data location/)

  // default-root scan: CONTINUE_GLOBAL_DIR points at a real temporary data root, so the row is
  // root-driven and the file really exists (the route recycles it: Recycle Bin / plugin trash)
  const globalDir = mkdtempSync(join(tmpdir(), 'dci-continue-'))
  mkdirSync(join(globalDir, 'sessions'))
  const sessionFile = join(globalDir, 'sessions', 'root-driven.json')
  writeFileSync(sessionFile, JSON.stringify({
    sessionId: 'root-driven',
    title: 'Root driven',
    workspaceDirectory: hostAbs('D:/work/root-driven'),
    history: [{ message: { role: 'user', content: 'hello' } }],
  }))
  const prev = process.env.CONTINUE_GLOBAL_DIR
  process.env.CONTINUE_GLOBAL_DIR = globalDir
  try {
    const { call: rootCall } = routesFor({ real: true })
    const rows = await scanList(rootCall, { source: 'continue' })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].sourcePath, sessionFile)
    const out = await rootCall('/api-import/delete-source', {
      confirm: true, items: [{ source: 'continue', sourcePath: sessionFile, sessionId: 'root-driven' }],
    })
    assert.equal(out.data.results[0].status, 'deleted', JSON.stringify(out.data.results[0]))
    assert.equal(existsSync(sessionFile), false)
  } finally {
    if (prev === undefined) delete process.env.CONTINUE_GLOBAL_DIR
    else process.env.CONTINUE_GLOBAL_DIR = prev
  }
})

test('route /api-import/delete-source: a sessionId must match, a one-file-many-sessions file is refused', async () => {
  const { call } = routesFor({}, chatgptTree())
  const rows = await scanList(call, { source: 'chatgpt', path: CHATGPT_DIR })
  assert.deepEqual(rows.map((r) => r.sessionId), ['conv-1', 'conv-2'])

  const wrongId = await call('/api-import/delete-source', {
    confirm: true, items: [{ source: 'chatgpt', sourcePath: CHATGPT_FILE, sessionId: 'conv-9' }],
  })
  assert.equal(wrongId.data.results[0].status, 'failed')

  const multi = await call('/api-import/delete-source', {
    confirm: true, items: [{ source: 'chatgpt', sourcePath: CHATGPT_FILE, sessionId: 'conv-1' }],
  })
  assert.equal(multi.data.results[0].status, 'refused')
  assert.match(multi.data.results[0].error, /many sessions/)

  // without a sessionId a multi-session file cannot be selected per row
  const noId = await call('/api-import/delete-source', { confirm: true, items: [{ source: 'chatgpt', sourcePath: CHATGPT_FILE }] })
  assert.equal(noId.data.results[0].status, 'failed')
})

// ── hide: per-session tombstones, existing tombstones kept ──────────

test('route /api-import/hide: a one-file-many-sessions source hides only the named session', async () => {
  const { call } = routesFor({}, chatgptTree())
  await scanList(call, { source: 'chatgpt', path: CHATGPT_DIR })
  const hidden = await call('/api-import/hide', {
    items: [{ source: 'chatgpt', sourcePath: CHATGPT_FILE, sessionId: 'conv-1' }],
  })
  assert.equal(hidden.data.hidden, 1)
  assert.equal(hidden.data.skipped, 0)
  const after = await scanList(call, { source: 'chatgpt', path: CHATGPT_DIR, epoch: 1 })
  assert.deepEqual(after.map((r) => r.sessionId), ['conv-2'])

  const noId = await call('/api-import/hide', { items: [{ source: 'chatgpt', sourcePath: CHATGPT_FILE }] })
  assert.equal(noId.data.hidden, 0)
  assert.match(noId.data.refused[0].error, /many sessions/)

  const back = await call('/api-import/unhide', {
    items: [{ source: 'chatgpt', sourcePath: CHATGPT_FILE, sessionId: 'conv-1' }],
  })
  assert.equal(back.data.unhidden, 1)
  const again = await scanList(call, { source: 'chatgpt', path: CHATGPT_DIR, epoch: 2 })
  assert.deepEqual(again.map((r) => r.sessionId), ['conv-1', 'conv-2'])
})

test('hideRows / unhideRows: an existing tombstone survives hide, Undo removes only hidden entries', async () => {
  const registryDir = mkdtempSync(join(tmpdir(), 'dci-ignore-'))
  const retracted = hostAbs('D:/demo/retracted.jsonl')
  await rememberIgnore(registryDir, { key: retracted, reason: 'retracted', dshId: 'dsh-1' })
  const before = (await loadIgnores(registryDir)).sources[retracted]

  assert.deepEqual(await hideRows(registryDir, [{ key: retracted }]), { hidden: 0, skipped: 1 })
  assert.deepEqual((await loadIgnores(registryDir)).sources[retracted], before)
  assert.equal(await unhideRows(registryDir, [{ key: retracted }]), 0)
  assert.deepEqual((await loadIgnores(registryDir)).sources[retracted], before)

  const fresh = hostAbs('D:/demo/fresh.jsonl')
  assert.deepEqual(await hideRows(registryDir, [{ key: fresh }]), { hidden: 1, skipped: 0 })
  assert.equal((await loadIgnores(registryDir)).sources[fresh].reason, 'hidden')
  assert.equal(await unhideRows(registryDir, [{ key: fresh }]), 1)
  assert.equal((await loadIgnores(registryDir)).sources[fresh], undefined)
})

// ── preview: every source adapter must hand its args to previewEntry ─

test('route /api-import/preview: a codex rollout returns a message sample', async () => {
  const { call } = routesFor({}, codexTree())
  const rows = await scanList(call, { source: 'codex', path: CODEX_DIR })
  assert.equal(rows.length, 1)
  const { res, data } = await call('/api-import/preview', {
    source: 'codex', sourcePath: CODEX_FILE, sessionId: rows[0].sessionId,
  })
  assert.equal(res.status, 200)
  assert.equal(data.ok, true, data.error)
  assert.deepEqual(data.sample.messages.map((m) => [m.role, m.text]), [['user', 'codex question'], ['assistant', 'codex answer']])
})

test('previewFileTarget: the requested sample reaches the shared preview entry', async () => {
  const { ctx } = makeCtx(claudeTree())
  const out = await previewFileTarget(ctx, { path: SESSION, previewSample: 10 })
  assert.equal(out.ok, true, out.error)
  assert.deepEqual(out.sample.messages.map((m) => [m.role, m.text]), [['user', 'refactor the module'], ['assistant', 'sure, here is the plan']])
})

test('previewEntry call sites in source adapters always pass args (a new source cannot drop the sample)', async () => {
  const { fileURLToPath } = await import('node:url')
  const sourcesDir = fileURLToPath(new URL('../lib/sources/', import.meta.url))
  const files = [
    ...readdirSync(sourcesDir).filter((f) => f.endsWith('.mjs')).map((f) => join(sourcesDir, f)),
    fileURLToPath(new URL('../lib/import-variants.mjs', import.meta.url)),
    fileURLToPath(new URL('../lib/file-import.mjs', import.meta.url)),
  ]
  const missing = []
  for (const file of files) {
    if (/previewEntry\(\s*out\s*\)/.test(readFileSync(file, 'utf8'))) missing.push(file)
  }
  assert.deepEqual(missing, [], 'previewEntry(out) 丢掉了 args.previewSample：' + missing.join(', '))
})

// ── import fingerprint: destination params are part of it ──────────

test('importDiscoveryItem: workspace / restamp enter the fingerprint (a drop elsewhere is not a silent skip)', async () => {
  const { ctx } = makeCtx(claudeTree())
  apply(ctx)
  const opts = (workspaceDir) => ({ budget: 4000, workspaceMode: 'dedicated', workspaceDir, restamp: 'end' })
  const first = await importDiscoveryItem(ctx, 'claude', SESSION, [], opts(hostAbs('D:/work/ws-a')))
  assert.equal(first.status, 'imported', JSON.stringify(first))
  const same = await importDiscoveryItem(ctx, 'claude', SESSION, [], opts(hostAbs('D:/work/ws-a')))
  assert.equal(same.alreadyImported, true)
  assert.equal(same.argsChanged, undefined)
  const moved = await importDiscoveryItem(ctx, 'claude', SESSION, [], opts(hostAbs('D:/work/ws-b')))
  assert.equal(moved.alreadyImported, true)
  assert.equal(moved.argsChanged, true)
  // 只采显式给出的键：没有投放参数时不会凭空多出一段指纹
  assert.equal(argsFingerprint({}, DESTINATION_FINGERPRINT_KEYS), '[]')
})

// ── highlight (inlined into the bundle) ─────────────────────────────

test('highlightRanges: case-insensitive, all occurrences, overlapping terms merge', async () => {
  const { highlightRanges, highlightTerms } = await import('../lib/highlight.mjs')
  assert.deepEqual(highlightTerms(' Fix  the FIX '), ['fix', 'the'])
  assert.deepEqual(highlightRanges('Fix the fixture', ['fix']), [[0, 3], [8, 11]])
  assert.deepEqual(highlightRanges('renderer', ['render', 'derer']), [[0, 8]])
  assert.deepEqual(highlightRanges('abc', []), [])
  assert.deepEqual(highlightRanges(null, ['a']), [])
})

test("restampSession 'end': last event becomes now, gaps kept, nothing in the future; true still anchors the start", () => {
  const mk = () => ({ meta: { createdAt: 1000 }, events: [{ type: 'a', time: 1000 }, { type: 'b', time: 5000 }, { type: 'c' }] })
  const before = Date.now()
  const end = restampSession(mk(), { restamp: 'end' })
  const after = Date.now()
  assert.ok(end.events[1].time >= before && end.events[1].time <= after)
  assert.equal(end.events[1].time - end.events[0].time, 4000)
  assert.equal(end.meta.createdAt, end.events[0].time)
  const start = restampSession(mk(), { restamp: true })
  assert.ok(start.events[0].time >= before)
  assert.equal(restampSession(mk(), {}).events[0].time, 1000)
})

test("restampSession 'end': out-of-order source times still end now and leave nothing in the future", () => {
  const before = Date.now()
  const out = restampSession({ meta: { createdAt: 1000 }, events: [{ time: 1000 }, { time: 5000 }, { time: 2000 }] }, { restamp: 'end' })
  const after = Date.now()
  const times = out.events.map((e) => e.time)
  assert.ok(times.every((t) => t <= after), JSON.stringify(times))
  assert.equal(times[1], Math.max(...times))
  assert.ok(times[1] >= before && times[1] <= after)
  assert.equal(times[1] - times[0], 4000)
  assert.equal(times[1] - times[2], 3000)
  assert.ok(out.meta.createdAt <= after)
  // createdAt 晚于锚点时同样夹到 now（会话创建时间不落未来）
  const clamped = restampSession({ meta: { createdAt: Date.now() + 10 * 60_000 }, events: [{ time: 1000 }] }, { restamp: true })
  assert.ok(clamped.meta.createdAt <= Date.now())
})
