// test/vibe.test.mjs — Mistral Vibe CLI 会话导入单元与集成测试（合成数据）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { convertVibeJson, parseVibeTime } from '../lib/convert/vibe.mjs'
import { listVibeSessions, readVibeSessionSummary, vibeUserDataDirs, previewVibeDirectory, previewVibeFile } from '../lib/sources/vibe.mjs'
import { discoverSessions } from '../lib/discovery.mjs'
import { apply } from '../lib/index.mjs'
import { hostAbs } from './_support/host-path.mjs'

const TEST_CWD = hostAbs('C:/projects/vibe-demo')

function syntheticMeta(overrides = {}) {
  return {
    session_id: 'vibe-sess-1111-2222-3333-444444444444',
    start_time: '2026-10-01T12:00:00Z',
    end_time: '2026-10-01T12:05:00Z',
    title: 'Vibe synthetic test session',
    title_source: 'auto',
    environment: {
      working_directory: TEST_CWD,
    },
    origin_directory: TEST_CWD,
    config: {
      active_model: 'mistral-large-latest',
    },
    ...overrides,
  }
}

function syntheticMessages() {
  return [
    {
      role: 'system',
      content: 'System prompt instructions',
    },
    {
      role: 'user',
      content: 'Hello Vibe, list files in this directory',
    },
    {
      role: 'assistant',
      reasoning_content: 'The user wants to list files. I will use the bash tool.',
      content: 'I will run ls to check directory contents.',
      tool_calls: [
        {
          id: 'call_bash_001',
          type: 'function',
          function: {
            name: 'bash',
            arguments: JSON.stringify({ command: 'ls -la' }),
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'call_bash_001',
      content: 'file1.txt\nfile2.js',
      tool_result: {
        output: 'file1.txt\nfile2.js',
        cancelled: false,
      },
    },
    {
      role: 'assistant',
      content: 'Here are the files: file1.txt and file2.js.',
    },
  ]
}

test('parseVibeTime: ISO 字符串与时间戳解析', () => {
  assert.equal(parseVibeTime('2026-10-01T12:00:00Z'), 1790856000000)
  assert.equal(parseVibeTime(1790856000000), 1790856000000)
  assert.equal(parseVibeTime(1790856000), 1790856000000)
  assert.equal(parseVibeTime(null), undefined)
})

test('convertVibeJson: 基本 user/assistant/tool 消息转换与工具配对', () => {
  const meta = syntheticMeta()
  const messages = syntheticMessages()
  const raw = messages.map((m) => JSON.stringify(m)).join('\n')

  const out = convertVibeJson(raw, { meta, sourcePath: '/tmp/session_001/messages.jsonl' })
  assert.ok(out.meta)
  assert.equal(out.meta.id, 'import-vibe-sess-1111-2222-3333-444444444444')
  assert.equal(out.meta.sourceId, 'vibe-sess-1111-2222-3333-444444444444')
  assert.equal(out.meta.cwd, TEST_CWD)
  assert.equal(out.title, 'Vibe synthetic test session')
  assert.equal(out.turns.length, 1)

  const turn = out.turns[0]
  assert.equal(turn.prompt, 'Hello Vibe, list files in this directory')
  assert.equal(turn.steps.length, 2)

  // 第一步应含 reasoning, text, tool-call, 以及配对的 tool-result
  const step1 = turn.steps[0]
  assert.equal(step1.toolCalls.length, 1)
  assert.equal(step1.toolCalls[0].name, 'bash')
  assert.equal(step1.toolResults.length, 1)
  assert.equal(step1.toolResults[0].toolCallId, 'call_bash_001')
  assert.match(step1.toolResults[0].content[0].text, /file1\.txt/)

  // 第二步为总结发言
  const step2 = turn.steps[1]
  assert.equal(step2.toolCalls.length, 0)
  assert.match(step2.content[0].text, /Here are the files/)
  assert.equal(out.droppedToolResults, 0)
})

test('convertVibeJson: 数组格式 content 与 input_text 兼容提取', () => {
  const meta = syntheticMeta({ title: null })
  const messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: 'First user query in array format' }],
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Answer to first query' }],
    },
    {
      role: 'user',
      content: '',
      input_text: 'Second user query from input_text',
    },
    {
      role: 'assistant',
      content: 'Answer to second query',
    },
  ]
  const raw = messages.map((m) => JSON.stringify(m)).join('\n')
  const out = convertVibeJson(raw, { meta })

  assert.equal(out.turns.length, 2)
  assert.equal(out.turns[0].prompt, 'First user query in array format')
  assert.equal(out.turns[1].prompt, 'Second user query from input_text')
  // 标题由首问生成
  assert.equal(out.title, 'First user query in array format')
})

test('convertVibeJson: context_boundary 标记转换为 DSH 原生压缩检查点', () => {
  const meta = syntheticMeta()
  const messages = [
    { role: 'user', content: 'Turn 1 before compaction' },
    { role: 'assistant', content: 'Answer 1 before compaction' },
    {
      role: 'user',
      context_boundary: 'compaction',
      content: 'Summary of the preceding discussion',
    },
    { role: 'user', content: 'Turn 2 after compaction' },
    { role: 'assistant', content: 'Answer 2 after compaction' },
  ]
  const raw = messages.map((m) => JSON.stringify(m)).join('\n')
  const out = convertVibeJson(raw, { meta })

  assert.equal(out.turns.length, 2)
  assert.equal(out.turns[0].prompt, 'Turn 1 before compaction')
  assert.equal(out.turns[1].prompt, 'Turn 2 after compaction')
  assert.ok(out.turns[1].compaction)
  assert.equal(out.turns[1].compaction.summary, 'Summary of the preceding discussion')
  assert.equal(out.turns[1].compaction.provider, 'mistral-vibe')
})

test('convertVibeJson: 未配对工具结果计数丢弃，无前驱 assistant 跳过', () => {
  const messages = [
    { role: 'assistant', content: 'Orphan assistant without user prompt' },
    { role: 'user', content: 'Valid prompt' },
    { role: 'tool', tool_call_id: 'unknown_call_id', content: 'orphan output' },
    { role: 'assistant', content: 'Final response' },
  ]
  const raw = messages.map((m) => JSON.stringify(m)).join('\n')
  const out = convertVibeJson(raw)

  assert.equal(out.turns.length, 1)
  assert.equal(out.droppedToolResults, 1)
  assert.ok(out.skipped >= 1)
})

test('convertVibeJson: 空会话返回 skipped 与 skipReason', () => {
  const out = convertVibeJson('{"role":"system","content":"only system"}')
  assert.equal(out.meta, null)
  assert.equal(out.turns.length, 0)
  assert.equal(out.skipReason, 'no user turns found in Mistral Vibe session')
})

// ── 发现层单测 ─────────────────────────────────────────────────────────────

test('listVibeSessions & readVibeSessionSummary 扫描目录并抽取摘要', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-vibe-discover-'))
  try {
    const sessionDir = join(tmp, 'session_20261001_120000_abcd1234')
    mkdirSync(sessionDir)
    writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify(syntheticMeta({ title: 'Discovered Session' })))
    writeFileSync(join(sessionDir, 'messages.jsonl'), syntheticMessages().map((m) => JSON.stringify(m)).join('\n'))

    const files = new Map()
    files.set(tmp, { type: 'dir' })
    files.set(sessionDir, { type: 'dir' })
    files.set(join(sessionDir, 'meta.json'), { type: 'file', size: 100, mtimeMs: 1700000000000 })
    files.set(join(sessionDir, 'messages.jsonl'), { type: 'file', size: 500, mtimeMs: 1700000000000 })

    const host = {
      async stat(p) {
        const item = files.get(p)
        if (!item) return null
        return item.type === 'dir' ? { type: 'directory' } : { type: 'file', size: item.size, mtimeMs: item.mtimeMs }
      },
      async readDir(p) {
        if (p === tmp) return [{ name: 'session_20261001_120000_abcd1234', type: 'directory' }]
        return []
      },
      async readText(p) {
        if (p === join(sessionDir, 'meta.json')) return JSON.stringify(syntheticMeta({ title: 'Discovered Session' }))
        return null
      },
      async readHead() { return null },
    }

    const sessions = await listVibeSessions(host, tmp)
    assert.equal(sessions.length, 1)
    const summary = await readVibeSessionSummary(host, sessions[0])
    assert.equal(summary.title, 'Discovered Session')
    assert.equal(summary.directory, TEST_CWD)

    // discoverSessions 集成
    const disc = await discoverSessions({ path: tmp, format: 'vibe', host, imports: {} })
    assert.equal(disc.total, 1)
    assert.equal(disc.sessions[0].format, 'vibe')
    assert.equal(disc.sessions[0].title, 'Discovered Session')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// ── 工具集成测试（import_chat { format: 'vibe' }） ──────────────────────────

test('import_chat 工具可正常导入 Mistral Vibe 会话目录', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-vibe-tool-'))
  try {
    const sessionDir = join(tmp, 'session_20261001_120000_abcd1234')
    mkdirSync(sessionDir)
    writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify(syntheticMeta({ title: 'Tool Imported Session' })))
    writeFileSync(join(sessionDir, 'messages.jsonl'), syntheticMessages().map((m) => JSON.stringify(m)).join('\n'))

    const createdSessions = new Map()
    const persistence = {
      async list() { return [...createdSessions.values()].map((s) => s.meta) },
      async create(meta) {
        createdSessions.set(meta.id, { meta, events: [] })
      },
      async append(id, events) {
        const s = createdSessions.get(id)
        if (s) s.events.push(...events)
      },
      async inspect(id) { return createdSessions.get(id) },
      async readFrom(id, fromSeq = 0) {
        const s = createdSessions.get(id)
        return { meta: s.meta, events: s.events.slice(fromSeq) }
      },
    }

    const registeredTools = new Map()
    const workspaces = new Map()

    const ctx = {
      sessionPersistence: persistence,
      workspaceRegistry: {
        async resolveByPath(p) { return workspaces.get(p) ?? null },
        async create(p) {
          const ws = { path: p, attachSession: async () => {} }
          workspaces.set(p, ws)
          return ws
        },
      },
      tools: {
        register(tool) {
          registeredTools.set(tool.name, tool)
        },
      },
      webServer: { register() {} },
      fs: {
        async resolve(p) { return { targetKey: p, displayPath: p } },
        async stat(target) {
          try {
            const s = statSync(target.targetKey)
            return s.isDirectory() ? { type: 'directory' } : { type: 'file', size: s.size, version: 'v1' }
          } catch {
            return undefined
          }
        },
        async readText(target) {
          const { readFileSync } = await import('node:fs')
          return readFileSync(target.targetKey, 'utf8')
        },
        async listDir(target) {
          const { readdirSync } = await import('node:fs')
          return readdirSync(target.targetKey, { withFileTypes: true }).map((e) => {
            const path = join(target.targetKey, e.name)
            return { name: e.name, type: e.isDirectory() ? 'directory' : 'file', target: { targetKey: path, displayPath: path } }
          })
        },
        processPath(target) { return target.targetKey },
      },
      inject(serviceList, cb) {
        const list = Array.isArray(serviceList) ? serviceList : Object.keys(serviceList || {})
        if (list.every((s) => ctx[s] !== undefined)) return cb(ctx)
        return undefined
      },
      get(s) { return ctx[s] },
      on() { return () => {} },
    }

    apply(ctx)
    const importTool = registeredTools.get('import_chat')
    assert.ok(importTool, 'import_chat 工具已注册')

    const result = await importTool.execute({
      format: 'vibe',
      path: sessionDir,
    })

    assert.equal(result.status, 'imported')
    assert.equal(result.turns, 1)
    assert.equal(createdSessions.size, 1)

    const [created] = createdSessions.values()
    assert.equal(created.meta.id, 'import-vibe-sess-1111-2222-3333-444444444444')
    assert.ok(created.events.length > 0)
    // 验证事件流含 user/message, tool/call, tool/result
    const types = created.events.map((e) => e.type)
    assert.ok(types.includes('user/message'))
    assert.ok(types.includes('tool/call'))
    assert.ok(types.includes('tool/result'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
test('vibeUserDataDirs: 解析 VIBE_HOME 与默认 ~/.vibe/logs/session 路径', () => {
  const defaultDirs = vibeUserDataDirs('/mock/home')
  assert.ok(defaultDirs.some((d) => d.includes('.vibe')))
  
  const originalEnv = process.env.VIBE_HOME
  try {
    process.env.VIBE_HOME = '/custom/vibe'
    const customDirs = vibeUserDataDirs('/mock/home')
    assert.ok(customDirs.some((d) => d.includes('custom')))
  } finally {
    if (originalEnv !== undefined) process.env.VIBE_HOME = originalEnv
    else delete process.env.VIBE_HOME
  }
})

test('previewVibeDirectory & previewVibeFile: 支持目录与单文件只读预览', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-vibe-prev-'))
  try {
    const s1 = join(tmp, 'session_1')
    mkdirSync(s1)
    writeFileSync(join(s1, 'meta.json'), JSON.stringify(syntheticMeta({ title: 'Preview S1' })))
    writeFileSync(join(s1, 'messages.jsonl'), syntheticMessages().map((m) => JSON.stringify(m)).join('\n'))

    const ctx = {
      fs: {
        async resolve(p) { return { targetKey: p, displayPath: p } },
        async stat(target) {
          try {
            const s = statSync(target.targetKey)
            return s.isDirectory() ? { type: 'directory' } : { type: 'file', size: s.size, version: 'v1' }
          } catch { return undefined }
        },
        async readText(target) {
          const { readFileSync } = await import('node:fs')
          return readFileSync(target.targetKey, 'utf8')
        },
        async listDir(target) {
          const { readdirSync } = await import('node:fs')
          return readdirSync(target.targetKey, { withFileTypes: true }).map((e) => {
            const p = join(target.targetKey, e.name)
            return { name: e.name, type: e.isDirectory() ? 'directory' : 'file', target: { targetKey: p, displayPath: p } }
          })
        },
        processPath(target) { return target.targetKey },
      },
    }

    const prevSingle = await previewVibeFile(ctx, { targetKey: s1, displayPath: s1 }, {})
    assert.equal(prevSingle.title, 'Preview S1')
    assert.equal(prevSingle.turns, 1)

    const prevDir = await previewVibeDirectory(ctx, { targetKey: tmp, displayPath: tmp }, {})
    assert.equal(prevDir.total, 1)
    assert.equal(prevDir.results[0].title, 'Preview S1')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('import_chat: 批量导入多会话目录与直传 messages.jsonl 单文件', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-vibe-multi-'))
  try {
    const s1 = join(tmp, 'session_1')
    const s2 = join(tmp, 'session_2')
    mkdirSync(s1)
    mkdirSync(s2)
    writeFileSync(join(s1, 'meta.json'), JSON.stringify(syntheticMeta({ session_id: 'vibe-1', title: 'Session 1' })))
    writeFileSync(join(s1, 'messages.jsonl'), syntheticMessages().map((m) => JSON.stringify(m)).join('\n'))
    writeFileSync(join(s2, 'meta.json'), JSON.stringify(syntheticMeta({ session_id: 'vibe-2', title: 'Session 2' })))
    writeFileSync(join(s2, 'messages.jsonl'), syntheticMessages().map((m) => JSON.stringify(m)).join('\n'))

    const createdSessions = new Map()
    const persistence = {
      async list() { return [...createdSessions.values()].map((s) => s.meta) },
      async create(meta) { createdSessions.set(meta.id, { meta, events: [] }) },
      async append(id, events) { const s = createdSessions.get(id); if (s) s.events.push(...events) },
      async inspect(id) { return createdSessions.get(id) },
      async readFrom(id, fromSeq = 0) { const s = createdSessions.get(id); return { meta: s.meta, events: s.events.slice(fromSeq) } },
    }
    const registeredTools = new Map()
    const workspaces = new Map()
    const ctx = {
      sessionPersistence: persistence,
      workspaceRegistry: {
        async resolveByPath(p) { return workspaces.get(p) ?? null },
        async create(p) { const ws = { path: p, attachSession: async () => {} }; workspaces.set(p, ws); return ws },
      },
      tools: { register(t) { registeredTools.set(t.name, t) } },
      webServer: { register() {} },
      fs: {
        async resolve(p) { return { targetKey: p, displayPath: p } },
        async stat(target) {
          try {
            const s = statSync(target.targetKey)
            return s.isDirectory() ? { type: 'directory' } : { type: 'file', size: s.size, version: 'v1' }
          } catch { return undefined }
        },
        async readText(target) {
          const { readFileSync } = await import('node:fs')
          return readFileSync(target.targetKey, 'utf8')
        },
        async listDir(target) {
          const { readdirSync } = await import('node:fs')
          return readdirSync(target.targetKey, { withFileTypes: true }).map((e) => {
            const p = join(target.targetKey, e.name)
            return { name: e.name, type: e.isDirectory() ? 'directory' : 'file', target: { targetKey: p, displayPath: p } }
          })
        },
        processPath(target) { return target.targetKey },
      },
      inject(serviceList, cb) {
        const list = Array.isArray(serviceList) ? serviceList : Object.keys(serviceList || {})
        if (list.every((s) => ctx[s] !== undefined)) return cb(ctx)
        return undefined
      },
      get(s) { return ctx[s] },
      on() { return () => {} },
    }

    apply(ctx)
    const importTool = registeredTools.get('import_chat')

    // 1. 批量目录导入
    const batchRes = await importTool.execute({ format: 'vibe', path: tmp })
    assert.equal(batchRes.total, 2)
    assert.equal(batchRes.imported, 2)
    assert.equal(createdSessions.size, 2)

    // 2. 直传 messages.jsonl 文件
    const fileRes = await importTool.execute({
      format: 'vibe',
      path: join(s1, 'messages.jsonl'),
      force: true,
    })
    assert.equal(fileRes.status, 'imported')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
test('readVibeSessionSummary：meta.json 缺失时标题取首条 user 消息，跳过头部里解析不了的行', async () => {
  const head = [
    '{"role":"system","content":"sys"',
    JSON.stringify({ role: 'user', content: [null, { type: 'text', text: '帮我修构建' }] }),
    '{"role":"assistant","content":"半截',
  ].join('\n')
  const host = {
    async readText() { throw new Error('ENOENT meta.json') },
    async readHead() { return head },
  }
  const summary = await readVibeSessionSummary(host, join('sessions', 'session_x'))
  assert.equal(summary.title, '帮我修构建')
  assert.equal(summary.id, 'session_x')
  assert.equal(summary.directory, null)
})
