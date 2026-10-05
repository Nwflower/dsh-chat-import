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
