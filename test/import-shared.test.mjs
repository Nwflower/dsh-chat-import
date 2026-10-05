// import-shared.test.mjs — 跨来源一致性回归：共享状态机件（批量计数口径、落盘选项、
// 「源未变」短路径）在每个来源上的行为必须一致。夹具全部写进临时目录（真实 node:fs），
// 宿主服务用内存 mock。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.mjs'
import { resolveRegistryDir } from '../lib/imports.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { importGrokbuildDirectory } from '../lib/import-variants.mjs'
import { restoreBundle } from '../lib/restore.mjs'
import { convertClaudeJsonl } from '../lib/convert/index.mjs'
import { serializeBundle } from '../lib/export/index.mjs'
import { hostAbs } from './_support/host-path.mjs'

beforeEach(() => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-home-'))
})

// 内存态会话库（append 强制 seq 连续，引擎契约）。
function makePersistence() {
  const sessions = new Map()
  return {
    sessions,
    async list() { return [...sessions.values()].map((s) => s.meta) },
    async create(meta) {
      if (sessions.has(meta.id)) throw new Error('duplicate session ' + meta.id)
      sessions.set(meta.id, { meta, events: [] })
    },
    async append(id, events) {
      const s = sessions.get(id)
      if (!s) throw new Error('unknown session ' + id)
      for (let i = 0; i < events.length; i++) {
        if (events[i].seq !== s.events.length + i) throw new Error('append seq 不连续')
      }
      s.events.push(...events)
    },
    async inspect(id) {
      const s = sessions.get(id)
      if (!s) throw new Error('unknown session ' + id)
      return { meta: s.meta, events: s.events }
    },
    async readFrom(id, fromSeq = 0) {
      const s = sessions.get(id)
      if (!s) throw new Error('unknown session ' + id)
      return { meta: s.meta, events: s.events.slice(fromSeq) }
    },
    async remove(id) { sessions.delete(id) },
  }
}

// 真实文件系统上的最小 ctx：fs 走 node:fs（stat 的 version 由 size + mtime 派生），
// services 可注入额外宿主服务（attachments 等）。
function makeCtx({ services = {} } = {}) {
  const persistence = makePersistence()
  const registered = []
  const workspaces = new Map()
  const fs = {
    async resolve(path) { return { targetKey: path, displayPath: path } },
    async stat(target) {
      let s
      try { s = statSync(target.targetKey) } catch { /* 路径不存在 → 视为未找到 */ return undefined }
      if (s.isDirectory()) return { type: 'directory' }
      return { type: 'file', size: s.size, mtimeMs: s.mtimeMs, version: 'real-' + s.size + '-' + s.mtimeMs }
    },
    async readText(target) { return readFileSync(target.targetKey, 'utf8') },
    async listDir(target) {
      return readdirSync(target.targetKey, { withFileTypes: true })
        .map((e) => {
          const path = join(target.targetKey, e.name)
          return { name: e.name, type: e.isDirectory() ? 'directory' : 'file', target: { targetKey: path, displayPath: path } }
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    },
    processPath(target) { return target.targetKey },
  }
  const workspaceRegistry = {
    async resolveByPath(p) { return workspaces.get(p) ?? null },
    async create(p) { const ws = { path: p, attachSession: async () => {} }; workspaces.set(p, ws); return ws },
  }
  const ctx = {
    fs,
    sessionPersistence: persistence,
    get(service) {
      if (service === 'workspaceRegistry') return workspaceRegistry
      if (service === 'sessionPersistence') return persistence
      return services[service]
    },
    inject(list, cb) {
      const names = Array.isArray(list) ? list : Object.keys(list || {})
      return names.every((s) => ctx.get(s) !== undefined) ? cb(ctx) : undefined
    },
    tools: { register(def) { registered.push(def); return () => {} } },
    on() { return () => {} },
    effect() { return () => {} },
  }
  const chat = (format) => {
    const tool = registered.find((d) => d.name === 'import_chat')
    return { ...tool, execute: (args) => tool.execute({ format, ...args }) }
  }
  return { ctx, persistence, chat }
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
