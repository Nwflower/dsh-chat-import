// import-shared.test.mjs — 跨来源一致性回归：共享状态机件（批量计数口径、落盘选项、
// 「源未变」短路径）在每个来源上的行为必须一致。夹具全部写进临时目录（真实 node:fs），
// 宿主服务用内存 mock。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { apply } from '../lib/index.mjs'
import { resolveRegistryDir } from '../lib/imports.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { importGrokbuildDirectory } from '../lib/import-variants.mjs'
import { restoreBundle } from '../lib/restore.mjs'
import { importMultiSource } from '../lib/import-core.mjs'
import { batchItem } from '../lib/import-batch.mjs'
import { IMPORT_OUTPUT_SCHEMA } from '../lib/tools/schema.mjs'
import { convertClaudeJsonl } from '../lib/convert/index.mjs'
import { serializeBundle } from '../lib/export/index.mjs'
import { hostAbs } from './_support/host-path.mjs'
import { makeCtx as makeHostCtx, chatDef } from './_support/fake-host.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
})

// 真实文件系统上的 ctx：夹具写进临时目录，fs 全部回退 node:fs；services 注入额外宿主服务
// （attachments 等）。chat(format) 是绑定 format 的 import_chat。
function makeCtx({ services } = {}) {
  const host = makeHostCtx(null, { real: true, services })
  return { ...host, chat: (format) => chatDef(host.ctx, format) }
}

function grokSession(dir, id, turns) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ info: { id, cwd: hostAbs('D:/demo/grok') }, created_at: '2026-07-16T12:00:00Z' }))
  const lines = []
  for (let i = 1; i <= turns; i++) {
    lines.push(JSON.stringify({ type: 'user', content: [{ type: 'text', text: '问题' + i }] }))
    lines.push(JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: '回答' + i }] }))
  }
  writeFileSync(join(dir, 'chat_history.jsonl'), lines.join('\n'))
}

// ── 批量计数口径 ─────────────────────────────────────────────────────────

test('批量计数：replace 覆盖重导计入 imported（grokbuild 目录不再把 replaced 记成 skipped）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grok-batch-'))
  grokSession(join(root, 'proj', 'g-1'), 'g-1', 1)
  grokSession(join(root, 'proj', 'g-2'), 'g-2', 1)
  const { ctx, persistence } = makeCtx()
  const registryDir = resolveRegistryDir()
  const dirTarget = { targetKey: root, displayPath: root }
  const first = await importGrokbuildDirectory(ctx, dirTarget, {}, { registryDir })
  assert.equal(first.imported, 2)

  const refreshed = await importGrokbuildDirectory(ctx, dirTarget, { replace: true }, { registryDir })
  assert.deepEqual(refreshed.results.map((r) => r.status), ['replaced', 'replaced'])
  assert.equal(refreshed.imported, 2, 'replace 写了一份完整会话，计入 imported')
  assert.equal(refreshed.skipped, 0)
  assert.equal(persistence.sessions.size, 2)
})

test('批量计数：vibe 目录批量的结果条目带 path、符合 import_chat 批量 schema', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-batch-'))
  for (const n of [1, 2]) {
    const dir = join(root, 'session_' + n)
    mkdirSync(dir)
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({
      session_id: 'vibe-' + n, title: 'Session ' + n, start_time: '2026-07-01T10:00:00Z',
      environment: { working_directory: hostAbs('D:/demo/vibe') },
    }))
    writeFileSync(join(dir, 'messages.jsonl'), [
      JSON.stringify({ role: 'user', content: '问题 ' + n }),
      JSON.stringify({ role: 'assistant', content: '回答 ' + n }),
    ].join('\n'))
  }
  const { ctx, chat } = makeCtx()
  apply(ctx)
  const def = chat('vibe')
  const value = await def.execute({ path: root })
  assert.equal(value.mode, 'batch')
  assert.equal(value.imported, 2)
  assert.ok(value.results.every((r) => typeof r.path === 'string' && r.path.startsWith(root)))
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

// ── 落盘选项与转换收尾：特殊形态来源与标准来源同口径 ─────────────────────────

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg=='

// Kimi 会话目录：一轮「截图工具调用 → 结果里带一张 data URL 图片」。
function kimiSessionDir(root, id) {
  const dir = join(root, 'sessions', 'wd-hash', id)
  mkdirSync(dir, { recursive: true })
  const recs = [
    { type: 'TurnBegin', payload: { user_input: '截个图看看' } },
    { type: 'StepBegin', payload: { n: 1 } },
    { type: 'ToolCall', payload: { type: 'function', id: 'call_img', function: { name: 'Shot', arguments: '{}' } } },
    { type: 'ToolResult', payload: { tool_call_id: 'call_img', return_value: { is_error: false, output: [{ type: 'image_url', imageUrl: { url: 'data:image/png;base64,' + PNG_B64 } }], message: '', display: [] } } },
    { type: 'TextPart', payload: { text: '看到了。' } },
    { type: 'TurnEnd', payload: {} },
  ]
  const lines = ['{"type":"metadata","protocol_version":"1"}']
  recs.forEach((r, i) => lines.push(JSON.stringify({ timestamp: 1776162400 + i, message: r })))
  writeFileSync(join(dir, 'wire.jsonl'), lines.join('\n'))
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, cwd: hostAbs('D:/demo/kimi') }))
  return dir
}

test('storeImages:false 对特殊形态来源同样生效（kimi 会话目录：不写附件，只留占位并计数）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kimi-img-'))
  const dir = kimiSessionDir(root, 'sess-img')
  let saves = 0
  const attachments = { async saveImage() { saves++; return { attachmentId: 'sha256:k', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } } }
  const { ctx, persistence, chat } = makeCtx({ services: { attachments } })
  apply(ctx)
  const value = await chat('kimi').execute({ path: dir, storeImages: false })
  assert.equal(value.status, 'imported')
  assert.equal(saves, 0, '未调用附件服务')
  assert.equal(value.images, undefined)
  assert.equal(value.imagesDegraded, 1)
  const flat = JSON.stringify(persistence.sessions.get('import-sess-img').events)
  assert.ok(!flat.includes(PNG_B64), 'base64 永不进日志')
})

test('restamp:true 对特殊形态来源同样生效（grokbuild 会话目录：时间平移到当前）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'grok-restamp-'))
  const dir = join(root, 'g-restamp')
  grokSession(dir, 'g-restamp', 1)
  const { ctx, persistence, chat } = makeCtx()
  apply(ctx)
  const before = Date.now()
  const value = await chat('grokbuild').execute({ path: dir, restamp: true })
  assert.equal(value.status, 'imported')
  const saved = persistence.sessions.get('import-g-restamp')
  assert.ok(saved.meta.createdAt >= before - 1000, '会话创建时间已平移到导入时刻')
})

test('bundle 还原同样比对预算：bundle 未变但预算变 → 跳过并点名 budgetChanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-budget-'))
  const sid = 'sess-bundle-budget'
  const conv = convertClaudeJsonl([
    { sessionId: sid, type: 'user', cwd: hostAbs('D:/demo/bundle'), message: { role: 'user', content: '问题' } },
    { sessionId: sid, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '回答' }] } },
  ].map((r) => JSON.stringify(r)).join('\n'), {})
  const path = join(dir, sid + '.dshbundle.json')
  writeFileSync(path, JSON.stringify(serializeBundle({ meta: conv.meta, events: conv.events, sourceSessionId: sid })))
  const { ctx } = makeCtx()
  const registryDir = resolveRegistryDir()
  const first = await restoreBundle(ctx, { path, budget: 100000 }, { registryDir })
  assert.equal(first.status, 'imported')
  const second = await restoreBundle(ctx, { path, budget: 200000 }, { registryDir })
  assert.equal(second.status, 'already-imported')
  assert.equal(second.budgetChanged, true)
  // 未给预算口径（restore_bundle 工具不解析预算）时不比对，照常按 bundle 未变跳过
  const third = await restoreBundle(ctx, { path }, { registryDir })
  assert.equal(third.status, 'already-imported')
  assert.equal(third.budgetChanged, undefined)
})

// ── 多会话源（一库多会话）：「源未变」短路径与落盘选项同口径 ──────────────────

const CRUSH_SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, parent_session_id TEXT, title TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER, completion_tokens INTEGER,
  cost REAL, updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL, summary_message_id TEXT);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, parts TEXT NOT NULL DEFAULT '[]',
  model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER,
  provider TEXT, is_summary_message INTEGER NOT NULL DEFAULT 0);
CREATE TABLE read_files (session_id TEXT, path TEXT, read_at INTEGER NOT NULL, PRIMARY KEY(path, session_id));`

function addCrushSession(db, id, t) {
  db.prepare('INSERT INTO sessions (id, parent_session_id, title, updated_at, created_at) VALUES (?, NULL, ?, ?, ?)').run(id, 'Crush ' + id, t, t)
  const parts = (text) => JSON.stringify([{ type: 'text', data: { text } }, { type: 'finish', data: { reason: 'stop' } }])
  db.prepare('INSERT INTO messages (id, session_id, role, parts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id + '-u', id, 'user', parts('问 ' + id), t + 1, t + 1)
  db.prepare('INSERT INTO messages (id, session_id, role, parts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id + '-a', id, 'assistant', parts('答 ' + id), t + 2, t + 2)
}

test('WAL 盲区（非 opencode 的 SQLite 源）：crush.db 主文件未变、-wal 增长 → 新会话仍被增量导入', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'crush-wal-')), 'proj', '.crush')
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'crush.db')
  const conn = new DatabaseSync(dbPath)
  try {
    conn.exec(CRUSH_SCHEMA)
    addCrushSession(conn, 'c-1', 1768000000)
    conn.exec('PRAGMA journal_mode=WAL')
    conn.exec('PRAGMA wal_autocheckpoint=0') // 阻止自动 checkpoint 合并回主文件
    conn.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const { ctx, persistence, chat } = makeCtx()
    apply(ctx)
    const def = chat('crush')
    const first = await def.execute({ path: dbPath })
    assert.equal(first.imported, 1)
    const mainBefore = statSync(dbPath)

    addCrushSession(conn, 'c-2', 1768000100) // 只落 -wal
    const mainAfter = statSync(dbPath)
    assert.equal(mainAfter.size, mainBefore.size) // 前提：主文件确实没变（WAL 语义成立）
    assert.equal(mainAfter.mtimeMs, mainBefore.mtimeMs)

    const second = await def.execute({ path: dbPath })
    assert.equal(second.imported, 1, '新会话只在 -wal 里也要被导入')
    assert.equal(second.alreadyImported, 1)
    assert.ok(persistence.sessions.get('import-c-2'))
  } finally {
    conn.close()
  }
})

test('选择性补导（goose）：库未变时再选未导过的会话仍真正落盘', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'goose-sel-')), 'sessions.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
    session_type TEXT NOT NULL DEFAULT 'user', working_dir TEXT NOT NULL, created_at TEXT, updated_at TEXT, parent_session_id TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
    content_json TEXT NOT NULL, created_timestamp INTEGER NOT NULL, metadata_json TEXT)`)
  for (const id of ['g-a', 'g-b']) {
    db.prepare('INSERT INTO sessions (id, name, working_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'Goose ' + id, hostAbs('D:/demo/goose'), '2026-04-22 17:40:00', '2026-04-22 17:42:10')
    db.prepare('INSERT INTO messages (session_id, role, content_json, created_timestamp) VALUES (?, ?, ?, ?)').run(id, 'user', JSON.stringify([{ type: 'text', text: '问 ' + id }]), 1776000000)
    db.prepare('INSERT INTO messages (session_id, role, content_json, created_timestamp) VALUES (?, ?, ?, ?)').run(id, 'assistant', JSON.stringify([{ type: 'text', text: '答 ' + id }]), 1776000001)
  }
  db.close()
  const { ctx, persistence, chat } = makeCtx()
  apply(ctx)
  const def = chat('goose')
  const first = await def.execute({ path: dbPath, sessionIds: ['g-a'] })
  assert.equal(first.imported, 1)
  const second = await def.execute({ path: dbPath, sessionIds: ['g-b'] })
  assert.equal(second.imported, 1, '库指纹短路径不得吞掉新选中的会话')
  assert.ok(persistence.sessions.get('import-g-b'))
  // 再选已导过的会话：仍是幂等 already-imported
  const third = await def.execute({ path: dbPath, sessionIds: ['g-a'] })
  assert.equal(third.imported, 0)
  assert.equal(persistence.sessions.size, 2)
})

test('storeImages:false 对多会话源同样生效（opencode 库：图片文件部分只留占位并计数）', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'opencode-img-')), 'opencode.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, model TEXT)')
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run('ses-img', '看图', hostAbs('D:/demo/opencode'), 1786000000000, null)
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m-u', 'ses-img', 1786000000001, JSON.stringify({ role: 'user' }))
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m-a', 'ses-img', 1786000000002, JSON.stringify({ role: 'assistant' }))
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p-u', 'm-u', 'ses-img', 1786000000001, JSON.stringify({ type: 'text', text: '看这张图' }))
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p-f', 'm-a', 'ses-img', 1786000000002, JSON.stringify({ type: 'file', mime: 'image/png', filename: 'a.png', data: PNG_B64 }))
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p-a', 'm-a', 'ses-img', 1786000000003, JSON.stringify({ type: 'text', text: '看到了' }))
  db.close()
  let saves = 0
  const attachments = { async saveImage() { saves++; return { attachmentId: 'sha256:o', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } } }
  const { ctx, persistence, chat } = makeCtx({ services: { attachments } })
  apply(ctx)
  const value = await chat('opencode').execute({ path: dbPath, storeImages: false })
  assert.equal(value.imported, 1)
  assert.equal(saves, 0, '未调用附件服务')
  assert.equal(value.images, undefined)
  assert.equal(value.imagesDegraded, 1)
  assert.ok(!JSON.stringify(persistence.sessions.get('import-ses-img').events).includes(PNG_B64), 'base64 永不进日志')
})

test('多会话源：子会话在宿主里已不存在 → 当未导入重建，批量结果仍符合 import_chat schema', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'opencode-gone-')), 'opencode.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, model TEXT)')
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run('ses-gone', '会被删的会话', hostAbs('D:/demo/opencode'), 1786000000000, null)
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m-u', 'ses-gone', 1786000000001, JSON.stringify({ role: 'user' }))
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p-u', 'm-u', 'ses-gone', 1786000000001, JSON.stringify({ type: 'text', text: '问题' }))
  db.close()
  const { ctx, persistence, chat } = makeCtx()
  apply(ctx)
  const def = chat('opencode')
  assert.equal((await def.execute({ path: dbPath })).imported, 1)
  persistence.sessions.delete('import-ses-gone') // 日志被手工删除 / 清理过
  const value = await def.execute({ path: dbPath })
  assert.equal(value.imported, 1)
  assert.ok(persistence.sessions.get('import-ses-gone'))
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('bundle 未变的重复还原不读文件、不重算指纹（registry 短路径先行）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-cheap-'))
  const sid = 'sess-bundle-cheap'
  const conv = convertClaudeJsonl([
    { sessionId: sid, type: 'user', cwd: hostAbs('D:/demo/bundle'), message: { role: 'user', content: '问题' } },
    { sessionId: sid, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '回答' }] } },
  ].map((r) => JSON.stringify(r)).join('\n'), {})
  const path = join(dir, sid + '.dshbundle.json')
  writeFileSync(path, JSON.stringify(serializeBundle({ meta: conv.meta, events: conv.events, sourceSessionId: sid })))
  const { ctx } = makeCtx()
  const readText = ctx.fs.readText
  let reads = 0
  ctx.fs.readText = (target) => { reads++; return readText(target) }
  const registryDir = resolveRegistryDir()
  assert.equal((await restoreBundle(ctx, { path }, { registryDir })).status, 'imported')
  reads = 0
  const again = await restoreBundle(ctx, { path }, { registryDir })
  assert.equal(again.status, 'already-imported')
  assert.equal(reads, 0, '未变的 bundle 不读')
})

// ── 结构校验报告的透出路径（runDecision 的 validation）─────────────────────────

test('多会话源落盘事件校验失败：validation 摊到批量顶层，结果仍符合 import_chat 批量 schema', async () => {
  const { ctx } = makeCtx()
  const registryDir = resolveRegistryDir()
  const target = { targetKey: join(tmpdir(), 'no-such-fake.db'), displayPath: join(tmpdir(), 'no-such-fake.db') }
  // seq 连续（假宿主在写盘侧只拦 seq 断档）但带未知事件类型：runDecision 的 check() 必报 unknown-type
  const badEvents = [
    { seq: 0, type: 'user/message', surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text: '问' }] } },
    { seq: 1, type: 'bogus/thing', data: {} },
  ]
  const result = await importMultiSource(ctx, target, {}, {
    sourcePath: target.displayPath,
    registryDir,
    importFormat: 'fake',
    load: async () => ({
      total: 1,
      items: [{
        key: 's1',
        converted: { meta: { id: 'import-fake-s1', createdAt: 1 }, events: badEvents, turns: [{}], messages: 1, toolCalls: 0, skipped: 0 },
      }],
    }),
  })
  assert.equal(result.imported, 1)
  assert.equal(result.validation.ok, false, '校验失败必须大声摊到批量顶层')
  assert.ok(result.validation.problems.some((p) => p.kind === 'unknown-type'))
  // 与工具出口同形态（runImportSpec 加 mode:'batch'）：宿主按 schema 校验返回值，
  // 顶层 validation 漏声明会让整次导入判失败
  assert.deepEqual(validateJsonSchemaValue(IMPORT_OUTPUT_SCHEMA, { mode: 'batch', ...result }), [])
})

test('目录批量条目透出 validation / staleRegistry（batchItem 白名单）', () => {
  const item = batchItem('p', {
    status: 'imported', sessionId: 's', turns: 1, messages: 1, toolCalls: 0, skipped: 0,
    validation: { ok: false, problems: [{ kind: 'seq-gap', seq: 3, message: 'seq 不连续' }] },
    staleRegistry: { previous: 'old-id', reason: 'session-log-missing' },
  })
  assert.equal(item.validation.ok, false, '单文件结果的结构校验报告不得被批量条目静默丢掉')
  assert.equal(item.staleRegistry.previous, 'old-id')
})
