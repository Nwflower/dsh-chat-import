// req26.test.mjs — REQ-26 畸形行行号明细 + secrets 位置上报 + permission 计数
//
// 覆盖三块：parseJsonlLines 行号/封顶/错误净化、各转换器返回的 skippedLines /
// secrets / permissionCount、index 层 schema 透传与 render 报告（正文不含 secret 内容）。
// 全部用合成数据，不掺真实 transcript。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import {
  convertClaudeJsonl, convertCodexJsonl, convertChatgptJson, convertCursorJsonl,
  convertGeminiJson, convertReasonixJsonl, convertOpencodeJson, convertZcodeJson,
  convertGrokbuildJson, convertOpenclawJson, convertHermesJson,
} from '../convert.mjs'
import { detectSecretKinds, parseJsonlLines, SKIPPED_LINES_CAP } from '../lib/convert/core.mjs'

// 辅助：import_chat 分发器定义——execute 时注入 format（收敛后单工具的测试形态，
// 等价旧 import_claude 的调用方式）
function chatDef(ctx, format = 'claude') {
  const tool = ctx.tools.registered('import_chat')
  return { ...tool, execute: (args) => tool.execute({ format, ...args }) }
}

// index 层用例的 registry 隔离（registry 落盘在 $DSH_HOME/dsh-chat-import）
beforeEach(() => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-home-'))
})

const SECRET = 'sk-abc123456789012345'

// ── detectSecretKinds：保守正则命中清单 ────────────────────────────────────

test('detectSecretKinds: 命中 api-key / token / password / secret / authorization', () => {
  assert.deepEqual(detectSecretKinds('use ' + SECRET + ' now'), ['api-key'])
  assert.deepEqual(detectSecretKinds('{"x":"api_key=abc12345"}'), ['api-key'])
  assert.deepEqual(detectSecretKinds(['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz123456'].join('')), ['token'])
  assert.deepEqual(detectSecretKinds('token=abc12345'), ['token'])
  assert.deepEqual(detectSecretKinds('"token": "abc12345"'), ['token'])
  assert.deepEqual(detectSecretKinds('password=hunter2'), ['password'])
  assert.deepEqual(detectSecretKinds('"password": "hunter2"'), ['password'])
  assert.deepEqual(detectSecretKinds('secret=xyzzy'), ['secret'])
  assert.deepEqual(detectSecretKinds('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), ['authorization'])
})

test('detectSecretKinds: 无命中与去重', () => {
  // 普通文本 / 疑似词的普通用法不误报
  assert.deepEqual(detectSecretKinds('普通对话文本，没有敏感信息'), [])
  assert.deepEqual(detectSecretKinds('token count = 5'), [])
  assert.deepEqual(detectSecretKinds('use the ask-skill command'), [])
  // 同行多形态只报首个命中 kind（去重，按正则优先级）
  assert.deepEqual(detectSecretKinds('sk-abc123456789012 and api_key=zzzzzzzz'), ['api-key'])
})

// ── parseJsonlLines：行号明细 / 封顶 / 错误净化 / secrets / requireObject ───

test('parseJsonlLines: 畸形行精确行号 + 错误消息净化（不含行内容）', () => {
  const raw = [
    '{"a":1}',
    '{"b": ' + SECRET + '}', // 畸形且含疑似 secret：行内容不得进错误消息
    '{"c":3}',
    'not json',
    '{"d":4}',
  ].join('\n')
  const { recs, skipped, skippedLines, secrets } = parseJsonlLines(raw)
  assert.equal(recs.length, 3)
  assert.equal(skipped, 2)
  assert.deepEqual(skippedLines.map((s) => s.line), [2, 4])
  assert.equal(typeof skippedLines[0].error, 'string')
  assert.ok(skippedLines[0].error.length > 0)
  assert.ok(!skippedLines[0].error.includes(SECRET))
  assert.ok(!skippedLines[0].error.includes('sk-'))
  assert.deepEqual(secrets, [{ line: 2, kind: 'api-key' }])
})

test('parseJsonlLines: 超 200 条时 skipped 计数完整、skippedLines 封顶 200', () => {
  const many = Array.from({ length: SKIPPED_LINES_CAP + 50 }, (_, i) => 'malformed ' + i).join('\n')
  const { recs, skipped, skippedLines } = parseJsonlLines(many)
  assert.equal(recs.length, 0)
  assert.equal(skipped, SKIPPED_LINES_CAP + 50)
  assert.equal(skippedLines.length, SKIPPED_LINES_CAP)
  assert.equal(skippedLines[0].line, 1)
  assert.equal(skippedLines[SKIPPED_LINES_CAP - 1].line, SKIPPED_LINES_CAP)
  assert.equal(skippedLines[SKIPPED_LINES_CAP], undefined)
})

test('parseJsonlLines: requireObject 时非对象行计入 skipped 明细', () => {
  const { recs, skipped, skippedLines } = parseJsonlLines('null\n{"a":1}', { requireObject: true })
  assert.equal(recs.length, 1)
  assert.equal(skipped, 1)
  assert.deepEqual(skippedLines, [{ line: 1, error: 'non-object record' }])
})

// ── Claude：畸形行明细 + secrets 位置 + permission 计数（不进入对话）─────────

// 合成 Claude transcript（sessionId 与文件名 stem 一致，避免辅助 transcript 判定）。
function claudeReq26Raw(sessionId = 'sess-req26') {
  return [
    '{"sessionId":"' + sessionId + '","type":"user","cwd":"D:\\\\demo","message":{"role":"user","content":"hi"}}',
    'this is not valid json',
    '{"sessionId":"' + sessionId + '","type":"permission","permissionMode":"bypassPermissions","toolName":"Bash"}',
    '{"sessionId":"' + sessionId + '","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"use api_key=' + SECRET + ' for setup"}]}}',
    'also not valid json',
    '{"sessionId":"' + sessionId + '","type":"permission","permissionMode":"default","toolName":"Read"}',
    '{"sessionId":"' + sessionId + '","type":"user","message":{"role":"user","content":"thanks"}}',
  ].join('\n')
}

test('convertClaudeJsonl: 畸形行号明细 + secrets 位置（只含 line+kind）+ permission 计数', () => {
  const out = convertClaudeJsonl(claudeReq26Raw(), { sourcePath: 'D:\\demo\\req26.jsonl' })
  assert.equal(out.skipped, 2)
  assert.deepEqual(out.skippedLines.map((s) => s.line), [2, 5])
  assert.equal(out.skippedLines[0].error.length > 0, true)
  // secrets 位置清单只含 line+kind，绝不含内容
  assert.deepEqual(out.secrets, [{ line: 4, kind: 'api-key' }])
  assert.ok(!JSON.stringify(out.secrets).includes(SECRET))
  // permission 记录只计数，不进入对话：两轮 user 提问、一轮 assistant 步骤
  assert.equal(out.permissionCount, 2)
  assert.equal(out.turns.length, 2)
  assert.ok(!JSON.stringify(out.events).includes('bypassPermissions'))
  assert.ok(!JSON.stringify(out.events).includes('permissionMode'))
})

test('convertClaudeJsonl: 无畸形行 / 无 secrets / 无 permission 时返回空数组', () => {
  const out = convertClaudeJsonl('{"sessionId":"s","type":"user","message":{"role":"user","content":"hi"}}\n{"sessionId":"s","type":"assistant","message":{"role":"assistant","content":"ok"}}')
  assert.deepEqual(out.skippedLines, [])
  assert.deepEqual(out.secrets, [])
  assert.equal(out.permissionCount, undefined)
})

test('convertClaudeJsonl: 超 200 条畸形行时计数完整、明细封顶 200', () => {
  const lines = []
  for (let i = 0; i < 250; i++) lines.push('malformed line ' + i)
  lines.push('{"sessionId":"sess-cap","type":"user","message":{"role":"user","content":"hi"}}')
  const out = convertClaudeJsonl(lines.join('\n'))
  assert.equal(out.skipped, 250)
  assert.equal(out.skippedLines.length, 200)
  assert.equal(out.skippedLines[0].line, 1)
  assert.equal(out.skippedLines[199].line, 200)
  assert.equal(out.skippedLines[200], undefined)
})

// ── 其余逐行转换器：畸形行号明细 + secrets 透传 ────────────────────────────

test('逐行转换器（codex/cursor/reasonix/openclaw/grokbuild/hermes）: 行号明细', () => {
  const codex = convertCodexJsonl('not json\n{"timestamp":"t0","type":"session_meta","payload":{"id":"c1"}}')
  assert.equal(codex.skipped, 1)
  assert.deepEqual(codex.skippedLines.map((s) => s.line), [1])
  assert.deepEqual(codex.secrets, [])

  const cursorRaw = [
    '{"role":"user","message":{"content":[{"type":"text","text":"hi"}]}}',
    'not json',
    '{"role":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}',
  ].join('\n')
  const cursor = convertCursorJsonl(cursorRaw)
  assert.equal(cursor.skipped, 1)
  assert.deepEqual(cursor.skippedLines.map((s) => s.line), [2])
  assert.deepEqual(cursor.secrets, [])

  const reasonixRaw = [
    '{"role":"user","content":"hi"}',
    'not json',
    '{"role":"assistant","content":"ok"}',
  ].join('\n')
  const reasonix = convertReasonixJsonl(reasonixRaw)
  assert.equal(reasonix.skipped, 1)
  assert.deepEqual(reasonix.skippedLines.map((s) => s.line), [2])

  const openclawRaw = [
    '{"type":"session","id":"o1","cwd":"D:\\\\p"}',
    'not json',
    '{"type":"message","message":{"role":"user","content":"hi"}}',
  ].join('\n')
  const openclaw = convertOpenclawJson(openclawRaw)
  assert.equal(openclaw.skipped, 1)
  assert.deepEqual(openclaw.skippedLines.map((s) => s.line), [2])

  const grok = convertGrokbuildJson(
    '{"info":{"id":"g1","cwd":"D:\\\\p"},"generated_title":"t"}',
    '{"type":"user","content":"hi"}\nnot json\n{"type":"assistant","content":"ok"}',
  )
  assert.equal(grok.skipped, 1)
  assert.deepEqual(grok.skippedLines.map((s) => s.line), [2])

  const hermesRaw = [
    '{"type":"init","id":"h1","title":"T"}',
    'not json',
    '{"type":"message","role":"user","content":"hi"}',
    '{"role":"assistant","content":"ok"}',
  ].join('\n')
  const hermes = convertHermesJson(hermesRaw)
  assert.equal(hermes.skipped, 1)
  assert.deepEqual(hermes.skippedLines.map((s) => s.line), [2])
  assert.deepEqual(hermes.secrets, [])
})

test('逐行转换器 secrets：疑似 secret 行上报位置与 kind', () => {
  const raw = [
    '{"role":"user","content":"hi"}',
    '{"role":"assistant","content":"use api_key=' + SECRET + '"}',
  ].join('\n')
  const reasonix = convertReasonixJsonl(raw)
  assert.deepEqual(reasonix.secrets, [{ line: 2, kind: 'api-key' }])
  assert.ok(!JSON.stringify(reasonix.secrets).includes(SECRET))
})

// ── 整文件转换器：畸形整文件 skipped:1、行号明细如实为空 ────────────────────

test('整文件转换器（chatgpt/gemini/opencode/zcode）: 畸形 JSON 时 skippedLines 为空数组', () => {
  const chatgpt = convertChatgptJson('not json')
  assert.equal(chatgpt.skipped, 1)
  assert.deepEqual(chatgpt.skippedLines, [])
  assert.deepEqual(chatgpt.secrets, [])

  const gemini = convertGeminiJson('not json')
  assert.equal(gemini.skipped, 1)
  assert.deepEqual(gemini.skippedLines, [])

  const opencode = convertOpencodeJson('not json')
  assert.equal(opencode.skipped, 1)
  assert.deepEqual(opencode.skippedLines, [])

  const zcode = convertZcodeJson('not json')
  assert.equal(zcode.skipped, 1)
  assert.deepEqual(zcode.skippedLines, [])
})

// ── index 层：schema 透传 + render 报告（正文不含 secret 内容）──────────────

// 最小 mock ctx（仅覆盖 import_claude 单文件 / 目录批量所需的服务面）
function makeMinCtx(tree) {
  const sessions = new Map()
  const persistence = {
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
  }
  // 跨平台分隔符归一（与 index.test.mjs makeCtx 同款）：代码 join() 在 Linux 对
  // 反斜杠合成路径产混合分隔符，树查找必须三态归一，否则 CI（ubuntu）红。
  const norm = (p) => String(p).replace(/\\/g, '/')
  const lookup = (p) => {
    const f = norm(p)
    return tree[p] ?? tree[f] ?? tree[f.replace(/\//g, '\\')]
  }
  const fs = {
    async resolve(path) { return { targetKey: path, displayPath: path } },
    async stat(target) {
      const v = lookup(target.targetKey)
      if (v === undefined) return undefined
      if (v === 'dir') return { type: 'directory' }
      let h = 0
      for (let i = 0; i < v.length; i++) h = (h * 31 + v.charCodeAt(i)) | 0
      return { type: 'file', size: v.length, version: 'v' + h }
    },
    async readText(target) {
      const v = lookup(target.targetKey)
      if (v === undefined || v === 'dir') throw new Error('FS_NOT_FOUND ' + target.targetKey)
      return v
    },
    async listDir(target) {
      const prefix = norm(target.targetKey).replace(/\/+$/, '') + '/'
      const entries = []
      for (const [path, v] of Object.entries(tree)) {
        const np = norm(path)
        if (!np.startsWith(prefix) || np === prefix) continue
        const rest = np.slice(prefix.length)
        if (rest.includes('/')) continue
        entries.push({ name: rest, type: v === 'dir' ? 'directory' : 'file', target: { targetKey: path, displayPath: path }, version: 1 })
      }
      return entries.sort((a, b) => a.name.localeCompare(b.name))
    },
    processPath(target) { return target.targetKey },
  }
  const workspaceRegistry = {
    async resolveByPath() { return null },
    async create(p) { return { path: p, attachSession: async () => {} } },
  }
  const registered = []
  const ctx = {
    fs,
    sessionPersistence: persistence,
    webServer: { register() {} }, // REQ-41：apply 注册 /api-import/sessions 路由（REQ-26 测试不关心）
    // 模拟 Cordis ctx.inject：依赖服务在 ctx 上存在才执行回调（webServer 在场 →
    // 路由注册执行；commands 缺席 → /import 命令不注册，插件照常激活）。
    inject(serviceList, cb) {
      const list = Array.isArray(serviceList) ? serviceList : Object.keys(serviceList || {})
      if (list.every((s) => ctx[s] !== undefined)) return cb(ctx)
      return undefined
    },
    get(service) {
      if (service === 'sessionPersistence') return persistence
      if (service === 'workspaceRegistry') return workspaceRegistry
      return undefined
    },
    tools: {
      register(def) { registered.push(def); return () => {} },
      registered: (name) => registered.find((d) => d.name === name),
    },
    on() { return () => {} }, // REQ-53：apply 监听 agent/session-start（本测试不模拟事件）
  }
  return { ctx, registered, persistence }
}

test('import_claude 单文件：skippedLines/secrets/permissionCount 透传 + schema + 报告正文不含 secret 内容', async () => {
  const tree = { 'D:\\demo\\sess-req26.jsonl': claudeReq26Raw() }
  const { ctx } = makeMinCtx(tree)
  apply(ctx)
  const def = chatDef(ctx)
  const value = await def.execute({ path: 'D:\\demo\\sess-req26.jsonl' })
  assert.equal(value.mode, 'single')
  assert.equal(value.status, 'imported')
  assert.equal(value.skipped, 2)
  assert.deepEqual(value.skippedLines.map((s) => s.line), [2, 5])
  assert.deepEqual(value.secrets, [{ line: 4, kind: 'api-key' }])
  assert.equal(value.permissionCount, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  // 返回数据不含 secret 内容
  assert.ok(!JSON.stringify(value).includes(SECRET))
  // render：畸形行明细只含行号与 kind 计数，绝不拼入 secret 内容
  const text = def.output.render({ path: 'D:\\demo\\sess-req26.jsonl' }, value).map((b) => b.text).join('\n')
  assert.ok(text.includes('畸形行明细：L2/L5'))
  assert.ok(text.includes('secrets 命中 1 处'))
  assert.ok(text.includes('permission 2 条'))
  assert.ok(!text.includes(SECRET))
  assert.ok(!text.includes('api_key'))
})

test('import_claude 全畸形文件：skipped 路径也透传行号明细并渲染', async () => {
  const tree = { 'D:\\demo\\req26-allbad.jsonl': 'bad line 1\nbad line 2\nbad line 3' }
  const { ctx } = makeMinCtx(tree)
  apply(ctx)
  const def = chatDef(ctx)
  const value = await def.execute({ path: 'D:\\demo\\req26-allbad.jsonl' })
  assert.equal(value.status, 'skipped')
  assert.deepEqual(value.skippedLines.map((s) => s.line), [1, 2, 3])
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  const text = def.output.render({}, value).map((b) => b.text).join('\n')
  assert.ok(text.includes('畸形行明细：L1/L2/L3'))
})

test('import_claude 目录批量：batchItem 透传 skippedLines/secrets/permissionCount + schema', async () => {
  const dir = 'D:\\demo\\req26dir'
  const tree = {
    [dir]: 'dir',
    [dir + '\\a.jsonl']: claudeReq26Raw('a'),
    [dir + '\\b.jsonl']: '{"sessionId":"b","type":"user","message":{"role":"user","content":"hi"}}\n{"sessionId":"b","type":"assistant","message":{"role":"assistant","content":"ok"}}',
  }
  const { ctx } = makeMinCtx(tree)
  apply(ctx)
  const def = chatDef(ctx)
  const value = await def.execute({ path: dir })
  assert.equal(value.mode, 'batch')
  const a = value.results.find((r) => r.path.endsWith('a.jsonl'))
  assert.equal(a.status, 'imported')
  assert.deepEqual(a.skippedLines.map((s) => s.line), [2, 5])
  assert.deepEqual(a.secrets, [{ line: 4, kind: 'api-key' }])
  assert.equal(a.permissionCount, 2)
  const b = value.results.find((r) => r.path.endsWith('b.jsonl'))
  assert.equal(b.skippedLines, undefined) // 无畸形行：不占键
  assert.ok(!JSON.stringify(value).includes(SECRET))
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})
