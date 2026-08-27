// index.test.mjs — 插件级集成测试：mock ctx（fs / sessionPersistence / tools / workspaceRegistry），
// 走真实的 apply → register → execute 路径，并校验返回值符合输出 schema。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { apply, readOpencodeDb, exportClaudeSession } from '../index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { resolveRegistryDir, loadImports, rememberImport } from '../lib/imports.mjs'
import { syncClaudeSession, evaluateWritebackGuards, readFileTailUuid } from '../lib/backfill.mjs'
import { clearScanCache } from '../lib/discovery.mjs'
import { restampSession } from '../lib/import-core.mjs'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const load = (name) => readFileSync(join(fixtures, name), 'utf8')

// REQ-24 registry 隔离：每个用例独立 DSH_HOME（registry 落盘在 $DSH_HOME/dsh-chat-import）
// REQ-25 扫描缓存隔离：scan_discover 的 30s TTL 缓存进程内共享，每用例清空防串扰
beforeEach(() => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  clearScanCache()
})

// fs 版本指纹：内容派生，内容变则 version 变（mock stat 的 version 字段）。
function contentVersion(text) {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
  return 'v' + h
}

// 合成 N 回合 Claude transcript（同一 sessionId，供增量续写测试）。
function claudeTurns(n, sessionId = 'sess-incr-001') {
  const lines = []
  for (let i = 1; i <= n; i++) {
    if (i === 1) {
      lines.push(JSON.stringify({ sessionId, type: 'user', cwd: 'D:\\demo\\proj', message: { role: 'user', content: '问题' + i } }))
    } else {
      lines.push(JSON.stringify({ sessionId, type: 'user', message: { role: 'user', content: '问题' + i } }))
    }
    lines.push(JSON.stringify({ sessionId, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '回答' + i }] } }))
  }
  return lines.join('\n')
}

// 合成 ChatGPT conversations.json 的单个会话对象（mapping 主线程：user/assistant 交替）。
function chatgptConversation(id, title, turns) {
  const mapping = {}
  let prev = null
  let idx = 1
  for (const prompt of turns) {
    for (const role of ['user', 'assistant']) {
      const nodeId = 'n' + idx
      const text = role === 'user' ? prompt : 'reply to ' + prompt
      mapping[nodeId] = {
        id: nodeId,
        message: { id: 'm' + idx, author: { role }, content: { content_type: 'text', parts: [text] }, create_time: 1710000000 + idx },
        parent: prev,
        children: [],
      }
      if (prev) mapping[prev].children.push(nodeId)
      prev = nodeId
      idx++
    }
  }
  return { id, title, create_time: 1710000000, mapping }
}

// 内存态会话库：create/append/list/inspect，模拟 sessionPersistence。
// append 强制 seq 连续（引擎契约：首事件 seq 必须等于已存 next-seq）。
function makePersistence() {
  const sessions = new Map() // id -> { meta, events: [] }
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
        const ev = events[i]
        if (typeof ev.seq !== 'number' || ev.seq !== s.events.length + i) {
          throw new Error('append seq 不连续: 期望 ' + (s.events.length + i) + ' 实际 ' + String(ev && ev.seq))
        }
      }
      s.events.push(...events)
    },
    async inspect(id) {
      const s = sessions.get(id)
      if (!s) throw new Error('unknown session ' + id)
      return { meta: s.meta, events: s.events }
    },
    // REQ-16 导出只读面：readFrom(id, fromSeq) 返回 { meta, events }（不 load/prepare）
    async readFrom(id, fromSeq = 0) {
      const s = sessions.get(id)
      if (!s) throw new Error('unknown session ' + id)
      return { meta: s.meta, events: s.events.slice(fromSeq) }
    },
  }
}

// 目录树：path -> 'dir' | content。opts.versions 可钉住某路径的 stat/writeText 版本
// （测试用：模拟「内容变但 fs 版本不变」的外部修改，隔离 tail-mismatch/预检失败守卫）。
// opts.services 可注入额外 ctx.get 服务（REQ-37 动态预算的 agentDefaultModel / llm）。
function makeCtx(tree, opts = {}) {
  const persistence = makePersistence()
  const attached = []
  const workspaces = new Map()
  const registered = []
  const webRoutes = [] // webServer.register 捕获（REQ-41 路由断言）
  const entriesCache = new Map()
  const reads = { count: 0 }
  const writes = [] // export_claude / sync_to_claude 的写盘记录（{ path, content, options }）
  const versions = opts.versions || {}
  const services = opts.services || {}
  const versionOf = (path, v) => (versions[path] !== undefined ? versions[path] : contentVersion(v))
  // 分隔符归一（跨平台：代码 join() 在 Linux 产正斜杠、Windows 产反斜杠）
  const norm = (p) => String(p).replace(/\\/g, '/')

  const fs = {
    async resolve(path) { return { targetKey: path, displayPath: path } },
    // 跨平台分隔符兜底：代码里的 join() 在 Linux（posix）对反斜杠合成路径会产出
    // 混合分隔符（如 'D:\\demo\\x/summary.json'），而测试树键是反斜杠——查树按
    // 原键 + 正斜杠归一 + 反斜杠归一三种形式都试（Windows 下 join 产反斜杠直中）。
    lookup(p) {
      const f = norm(p)
      return tree[p] ?? tree[f] ?? tree[f.replace(/\//g, '\\')]
    },
    // REQ-16 导出写面：createIfAbsent 对已存在（tree 已 seed 或已写过）路径抛 EEXIST，
    // 模拟「新 uuid + createIfAbsent 不覆盖」双保险的第二道闸。
    // REQ-36 写回写面：replaceIfVersion 只在观测版本上替换（失配抛 FS_STALE_VERSION，
    // 模拟并发写者），返回 { operation, version, before, after }。
    async writeText(target, content, options) {
      const path = target.targetKey
      if (options && options.kind === 'replaceIfVersion') {
        const current = tree[path]
        if (current === undefined || versionOf(path, current) !== options.version) {
          throw Object.assign(new Error('FS_STALE_VERSION ' + path), { code: 'FS_STALE_VERSION' })
        }
        tree[path] = content
        writes.push({ path, content, options })
        return { operation: 'update', version: versionOf(path, content), before: current, after: content }
      }
      if (options && options.kind === 'createIfAbsent' && tree[path] !== undefined) {
        throw Object.assign(new Error('EEXIST ' + path), { code: 'EEXIST' })
      }
      tree[path] = content
      writes.push({ path, content, options })
      return { path }
    },
    async stat(target) {
      const path = target.targetKey
      const v = this.lookup(path)
      if (v !== undefined) {
        // 内容派生指纹：size + version（变则 version 变，REQ-24 短路径判定依据）
        return v === 'dir' ? { type: 'directory' } : { type: 'file', size: v.length, version: versionOf(path, v) }
      }
      // 树外的真实文件（opencode 临时 SQLite 库）：回退 node:fs
      try {
        const s = statSync(path)
        if (s.isDirectory()) return { type: 'directory' }
        return { type: 'file', size: s.size, version: 'real-' + s.size + '-' + s.mtimeMs + '-' + s.ctimeMs }
      } catch {
        return undefined
      }
    },
    async readText(target) {
      reads.count++
      const v = this.lookup(target.targetKey)
      if (v === undefined || v === 'dir') throw new Error('FS_NOT_FOUND ' + target.targetKey)
      return v
    },
    async listDir(target) {
      if (!entriesCache.has(target.targetKey)) {
        const entries = []
        const prefix = target.targetKey.endsWith('\\') ? target.targetKey : target.targetKey + '\\'
        for (const [path, v] of Object.entries(tree)) {
          if (path.startsWith(prefix) && path !== prefix) {
            const rest = path.slice(prefix.length)
            if (!rest.includes('\\')) {
              entries.push({
                name: rest,
                type: v === 'dir' ? 'directory' : 'file',
                target: { targetKey: path, displayPath: path },
                version: 1,
              })
            }
          }
        }
        entriesCache.set(target.targetKey, entries.sort((a, b) => a.name.localeCompare(b.name)))
      }
      return entriesCache.get(target.targetKey)
    },
    processPath(target) { return target.targetKey },
  }

  const workspaceRegistry = {
    async resolveByPath(p) { return workspaces.get(p) ?? null },
    async create(p) { const ws = { path: p, attachSession: async (id) => attached.push({ ws: p, id }) }; workspaces.set(p, ws); return ws },
    // REQ-55 归档感知：全局归档集（opts.archived 种子）；archive 辅助供测试把会话归档
    get archivedSessionIds() { return archivedIds },
    async archiveSession(id) { archivedIds.push(id) },
  }
  const archivedIds = Array.isArray(opts.archived) ? [...opts.archived] : []

  // webServer 是可选且晚挂载的服务（REQ-41 路由经 ctx.inject(['webServer']) 延迟
  // 注册）：opts.noWebServer 模拟 headless / 无 Web 的 profile——inject 回调永不
  // 执行，插件不注册路由但照常 apply。
  const webServerStub = {
    register(def) { webRoutes.push(def); return () => {} },
  }

  const ctx = {
    fs,
    sessionPersistence: persistence,
    webServer: webServerStub,
    get(service) {
      if (service === 'workspaceRegistry') return workspaceRegistry
      if (service === 'sessionPersistence') return persistence
      if (service === 'webServer') return opts.noWebServer ? undefined : webServerStub
      if (services[service] !== undefined) return services[service]
      return undefined
    },
    // 模拟 Cordis ctx.inject：依赖可用（webServer 在场 / 服务在 ctx 上存在）才同步
    // 执行回调；缺依赖（noWebServer / commands 缺席）时不执行——对齐真实 Cordis
    // 「依赖可用再启动回调」语义。
    inject(serviceList, cb) {
      const list = Array.isArray(serviceList) ? serviceList : Object.keys(serviceList || {})
      if (list.every((s) => (s === 'webServer' ? !opts.noWebServer : ctx[s] !== undefined))) return cb(ctx)
      return undefined
    },
    tools: {
      register(def) { registered.push(def); return () => {} },
    },
    on() { return () => {} }, // REQ-53：apply 监听 agent/session-start（本测试不模拟事件）
    effect() { return () => {} },
  }
  // 测试辅助：按名字取出注册的工具定义
  ctx.tools.registered = (toolName) => registered.find((d) => d.name === toolName)
  return { ctx, persistence, attached, registered, reads, writes, webRoutes }
}

// REQ-32：导入会话日志首事件为 session/imported 标记（seq 0、ignorable），
// sourcePath 来自工具入参（fs 服务归一化路径）。
function assertImportedMarker(events, { tool, sourceId, sourcePath }) {
  const ev = events[0]
  assert.equal(ev.type, 'session/imported')
  assert.equal(ev.seq, 0)
  assert.equal(ev.ignorable, true)
  assert.equal(ev.data.tool, tool)
  assert.equal(ev.data.sourceId, sourceId)
  assert.equal(ev.data.sourcePath, sourcePath)
  assert.equal(typeof ev.data.importedAt, 'number')
  assert.ok(ev.data.importedAt > 0)
}

test('apply 注册十三个工具（import_chat 分发器 + import_agents + doctor + import_mcp + import_settings + scan_discover + export_chat 三合一 + sync_to_claude + REQ-33 识别/撤回 + REQ-56 bundle 导出/还原 + verify_session）', () => {
  const { ctx, registered } = makeCtx({})
  apply(ctx)
  assert.equal(registered.length, 13)
  const names = registered.map((d) => d.name).sort()
  assert.deepEqual(names, ['doctor', 'export_bundle', 'export_chat', 'import_agents', 'import_chat', 'import_mcp', 'import_settings', 'list_imported_sessions', 'restore_bundle', 'retract_import', 'scan_discover', 'sync_to_claude', 'verify_session'])
  for (const def of registered) {
    if (['doctor', 'import_mcp', 'import_settings', 'export_bundle', 'restore_bundle', 'sync_to_claude', 'scan_discover', 'list_imported_sessions', 'retract_import', 'verify_session'].includes(def.name)) {
      // doctor / MCP / settings / bundle / 写回 / 发现 / 识别 / 撤回 / 校验工具：单对象输出 schema（非 oneOf）
      assert.equal(def.output.schema.type, 'object')
      assert.ok(!Array.isArray(def.output.schema.oneOf))
    } else if (def.name === 'export_chat') {
      // export_chat 三合一：单对象输出 schema（三态合并，非 oneOf）
      assert.equal(def.output.schema.type, 'object')
      assert.ok(!Array.isArray(def.output.schema.oneOf))
    } else if (def.name === 'import_agents') {
      // REQ-59：单对象输出 schema（非导入状态机，独立注册）
      assert.equal(def.output.schema.type, 'object')
      assert.ok(!Array.isArray(def.output.schema.oneOf))
    } else {
      // import_chat：输出 schema 是 oneOf（单文件 / 批量 + REQ-17 dry-run 预览两个变体）
      assert.equal(def.name, 'import_chat')
      assert.ok(Array.isArray(def.output.schema.oneOf))
      assert.equal(def.output.schema.oneOf.length, 4)
    }
  }
})

// issue #20：DSH 更新后 defineTool 恒暴露 output.render（内部调用 userRender），
// 缺 render 的工具渲染输出即抛 `userRender is not a function`。回归断言四个直接
// defineTool 注册、曾漏 render 的工具现均可渲染（返回文本块、不抛错）。
test('issue #20：doctor/import_agents/import_mcp/import_settings 的 output.render 可用', () => {
  const { ctx } = makeCtx({})
  apply(ctx)
  const doctor = registeredDef(ctx, 'doctor')
  assert.match(
    doctor.output.render({}, { ok: true, checks: [{ name: 'registry', ok: true, detail: '1 条' }], issues: [], totals: { records: 1, sessions: 0, missingSessions: 0, skills: 0 } }).map((b) => b.text).join('\n'),
    /doctor: ok=true/,
  )
  const agents = registeredDef(ctx, 'import_agents')
  assert.match(
    agents.output.render({ apply: false }, { total: 2, planned: 2, applied: 0, skipped: 0, results: [] }).map((b) => b.text).join('\n'),
    /预览（dry-run，未落盘）/,
  )
  const mcp = registeredDef(ctx, 'import_mcp')
  assert.match(
    mcp.output.render({}, { total: 0, servers: [], planText: '# No MCP servers found\n', writtenTo: null }).map((b) => b.text).join('\n'),
    /MCP 镜像计划/,
  )
  const settings = registeredDef(ctx, 'import_settings')
  assert.match(
    settings.output.render({}, { total: 0, suggestions: [], sources: [] }).map((b) => b.text).join('\n'),
    /配置建议：0 条/,
  )
})

test('scan_discover：目录探测 claude、注入过滤、schema 稳定、零副作用、缓存命中不重读', async () => {
  const root = 'D:\\demo\\claude\\projects'
  const tree = {
    [root]: 'dir',
    [root + '\\proj-a']: 'dir',
    [root + '\\proj-a\\sess-aaa.jsonl']: [
      '{"sessionId":"sess-aaa","type":"user","cwd":"D:\\\\demo\\\\claude-proj","message":{"role":"user","content":"帮我重构这个模块"}}',
      '{"sessionId":"sess-aaa","type":"assistant","message":{"role":"assistant","content":"好"}}',
    ].join('\n'),
    [root + '\\proj-a\\sess-aaa']: 'dir', // 主 transcript 的伴生目录（非 .jsonl，不扫）
    [root + '\\proj-a\\sess-aaa\\subagents']: 'dir',
    [root + '\\proj-a\\sess-aaa\\subagents\\agent-123.jsonl']: '{"sessionId":"sess-aaa"}',
    [root + '\\proj-a\\sess-bbb.jsonl']: [
      '{"sessionId":"sess-bbb","type":"user","message":{"role":"user","content":"<system-reminder>系统注入，不是提问</system-reminder>"}}',
      '{"sessionId":"sess-bbb","type":"user","message":{"role":"user","content":"真实问题"}}',
    ].join('\n'),
  }
  const { ctx, persistence, writes, reads } = makeCtx(tree)
  apply(ctx)
  const def = registeredDef(ctx, 'scan_discover')

  const first = await def.execute({ path: root })
  assert.equal(first.total, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, first), [])

  const aaa = first.sessions.find((s) => s.sessionId === 'sess-aaa')
  assert.ok(aaa)
  assert.equal(aaa.format, 'claude')
  assert.equal(aaa.title, '帮我重构这个模块')
  assert.equal(aaa.project, 'claude-proj') // 记录内 cwd basename（REQ-40 项目名提取）
  assert.equal(aaa.importStatus, 'not-imported') // registry 为空
  assert.equal(aaa.messageCount, null) // claude 只读文件头，不计数
  assert.equal(aaa.sourcePath, root + '\\proj-a\\sess-aaa.jsonl')

  const bbb = first.sessions.find((s) => s.sessionId === 'sess-bbb')
  assert.equal(bbb.title, '真实问题') // 注入首行被过滤（REQ-40 标题提取）
  assert.equal(bbb.project, 'proj-a') // 无 cwd 记录 → 布局 slug 回退

  // 零副作用：不写库、不 create/append、不写任何文件
  assert.equal(persistence.sessions.size, 0)
  assert.equal(writes.length, 0)

  // 30s TTL 缓存：同 key 第二次扫描命中，不重读源文件
  const readsAfterFirst = reads.count
  assert.ok(readsAfterFirst > 0)
  const second = await def.execute({ path: root })
  assert.equal(second.total, 2)
  assert.equal(reads.count, readsAfterFirst)

  // query 过滤（标题/项目/路径子串，忽略大小写）
  const q = await def.execute({ path: root, query: '重构' })
  assert.equal(q.total, 1)
  assert.equal(q.sessions[0].sessionId, 'sess-aaa')
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, q), [])
})

test('单文件导入：落盘、归组、返回值符合 schema', async () => {
  const simple = load('sess-simple-001.jsonl')
  const { ctx, persistence, attached } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple })
  apply(ctx)
  const def = ctx.tools.register.calls ?? chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-sess-simple-001')
  assert.equal(value.turns, 1)
  assert.equal(value.messages, 2)
  assert.equal(value.toolCalls, 0)
  assert.equal(value.alreadyImported, false)

  // 输出 schema 校验通过（含 turns 为 integer 而非数组）
  const violations = validateJsonSchemaValue(def.output.schema, value)
  assert.deepEqual(violations, [])

  // 落盘：meta + 平衡事件；首事件为 session/imported 标记（sourcePath = 工具入参）
  const saved = persistence.sessions.get('import-sess-simple-001')
  assert.ok(saved)
  assert.equal(saved.meta.cwd, 'D:\\demo\\proj')
  assert.equal(saved.events.at(-1).type, 'turn/end')
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assertImportedMarker(saved.events, { tool: 'claude-code', sourceId: 'sess-simple-001', sourcePath: 'D:\\demo\\proj\\sess-simple-001.jsonl' })

  // 归组
  assert.equal(attached.length, 1)
  assert.equal(attached[0].id, 'import-sess-simple-001')
})

test('幂等：重复导入同一文件返回 alreadyImported 且不重复落盘', async () => {
  const simple = load('sess-simple-001.jsonl')
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const first = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(first.alreadyImported, false)
  assert.equal(second.alreadyImported, true)
  assert.equal(persistence.sessions.size, 1)
})

test('REQ-55 归档重导：目标会话归档后重导建后缀新副本，归档会话保留、记录指向新副本', async () => {
  const simple = load('sess-simple-001.jsonl')
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple })
  apply(ctx)
  const def = chatDef(ctx, 'claude')

  const first = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(first.sessionId, 'import-sess-simple-001')

  // 归档目标会话（DSH UI 的归档 = workspaceRegistry 全局归档集；会话仍在持久化里）
  const wr = ctx.get('workspaceRegistry')
  await wr.archiveSession('import-sess-simple-001')

  // 重导：不再视为已导入——建后缀新副本（import-<id>-1），旧归档会话原样保留
  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(second.status, 'imported')
  assert.equal(second.alreadyImported, false)
  assert.equal(second.sessionId, 'import-sess-simple-001-1')
  assert.equal(persistence.sessions.size, 2)
  assert.ok(persistence.sessions.has('import-sess-simple-001'))
  assert.ok(persistence.sessions.has('import-sess-simple-001-1'))

  // registry 记录指向新副本（原归档会话不再被记录追踪）
  const registry = (await loadImports(resolveRegistryDir())).imports
  assert.equal(registry['D:\\demo\\proj\\sess-simple-001.jsonl'].dshId, 'import-sess-simple-001-1')

  // 新副本再导入 → 幂等 already-imported（不重复建副本）
  const third = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(third.alreadyImported, true)
  assert.equal(third.sessionId, 'import-sess-simple-001-1')
  assert.equal(persistence.sessions.size, 2)
})

test('单文件导入工具历史：tool/result 带 sourceEventSeqs', async () => {
  const { ctx } = makeCtx({ 'D:\\demo\\proj\\sess-tool-001.jsonl': load('sess-tool-001.jsonl') })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj\\sess-tool-001.jsonl' })
  assert.equal(value.mode, 'single')
  assert.equal(value.toolCalls, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('目录批量导入：扫描 .jsonl、逐文件独立会话、跳过非 transcript、汇总符合 schema', async () => {
  const tree = {
    'D:\\demo\\proj': 'dir',
    'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl'),
    'D:\\demo\\proj\\sess-tool-001.jsonl': load('sess-tool-001.jsonl'),
    'D:\\demo\\proj\\notes.txt': 'not a transcript',
    'D:\\demo\\proj\\sub': 'dir',
    'D:\\demo\\proj\\sub\\sess-title-001.jsonl': load('sess-title-001.jsonl'),
  }
  const { ctx, persistence, attached } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 3) // a/b/c 三个 .jsonl（notes.txt 被过滤）
  assert.equal(value.imported, 3)
  assert.equal(value.alreadyImported, 0)
  assert.equal(value.failed, 0)
  assert.equal(value.results.length, 3)
  const ids = value.results.map((r) => r.sessionId).sort()
  assert.deepEqual(ids, ['import-sess-simple-001', 'import-sess-title-001', 'import-sess-tool-001'])

  // 每个会话独立落盘 + 归组
  assert.equal(persistence.sessions.size, 3)
  assert.equal(attached.length, 3)

  // 逐文件的 sourcePath 是各自 transcript 路径（目录模式每个文件一个源路径）
  assertImportedMarker(persistence.sessions.get('import-sess-simple-001').events, { tool: 'claude-code', sourceId: 'sess-simple-001', sourcePath: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assertImportedMarker(persistence.sessions.get('import-sess-tool-001').events, { tool: 'claude-code', sourceId: 'sess-tool-001', sourcePath: 'D:\\demo\\proj\\sess-tool-001.jsonl' })
  assertImportedMarker(persistence.sessions.get('import-sess-title-001').events, { tool: 'claude-code', sourceId: 'sess-title-001', sourcePath: 'D:\\demo\\proj\\sub\\sess-title-001.jsonl' })

  // 输出 schema 校验
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('目录批量导入：递归参数（false 时不进子目录）', async () => {
  const tree = {
    'D:\\demo\\proj': 'dir',
    'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl'),
    'D:\\demo\\proj\\sub': 'dir',
    'D:\\demo\\proj\\sub\\sess-title-001.jsonl': load('sess-title-001.jsonl'),
  }
  const { ctx } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj', recursive: false })
  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 1) // 只扫顶层 sess-simple-001.jsonl
  assert.deepEqual(value.results.map((r) => r.sessionId), ['import-sess-simple-001'])
})

test('目录批量导入：已存在会话计入 alreadyImported', async () => {
  const tree = {
    'D:\\demo\\proj': 'dir',
    'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl'),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  await def.execute({ path: 'D:\\demo\\proj' })
  const second = await def.execute({ path: 'D:\\demo\\proj' })
  assert.equal(second.mode, 'batch')
  assert.equal(second.imported, 0)
  assert.equal(second.alreadyImported, 1)
  assert.equal(persistence.sessions.size, 1)
})

test('批量导入：空文件/无内容文件计入 skipped 而非 failed', async () => {
  const tree = {
    'D:\\demo\\proj': 'dir',
    'D:\\demo\\proj\\empty.jsonl': '',
  }
  const { ctx } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj' })
  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 1)
  assert.equal(value.skipped, 1)
  assert.equal(value.results[0].status, 'skipped')
})

test('目录批量导入：subagent 辅助 transcript 跳过，主 transcript 完整导入', async () => {
  // Claude Code 项目目录：<sessionId>.jsonl 主 transcript + <sessionId>/subagents/agent-*.jsonl
  // 辅助 transcript（记录携带父 sessionId）。辅助文件不得建会话（否则与主 transcript 撞 id、
  // 先扫描者胜导致主内容丢失），只导入主 transcript。
  const tree = {
    'D:\\demo\\proj': 'dir',
    'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl'),
    'D:\\demo\\proj\\sess-simple-001': 'dir',
    'D:\\demo\\proj\\sess-simple-001\\subagents': 'dir',
    'D:\\demo\\proj\\sess-simple-001\\subagents\\agent-abc123.jsonl': load('sess-simple-001.jsonl'),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 1)
  assert.equal(value.skipped, 1)
  assert.equal(value.failed, 0)
  const skipped = value.results.find((r) => r.status === 'skipped')
  assert.ok(skipped)
  assert.ok(skipped.reason.includes('auxiliary'))
  assert.ok(skipped.path.includes('agent-abc123.jsonl'))
  // 只有主 transcript 落盘，且内容完整（user + assistant 各 1）
  assert.equal(persistence.sessions.size, 1)
  const saved = persistence.sessions.get('import-sess-simple-001')
  assert.ok(saved)
  assert.equal(saved.events.filter((e) => e.type === 'user/message' && e.data.source.kind === 'user').length, 1)
  assert.equal(saved.events.filter((e) => e.type === 'assistant/message').length, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('单文件导入辅助 transcript：跳过并返回 skipReason', async () => {
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\proj\\agent-abc123.jsonl': load('sess-simple-001.jsonl') })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj\\agent-abc123.jsonl' })
  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'none')
  assert.equal(value.turns, 0)
  assert.equal(value.skipped, 1)
  assert.ok(value.skipReason.includes('auxiliary'))
  assert.equal(persistence.sessions.size, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

// ---- import_codex 集成 ----

test('import_codex 单文件导入：落盘、归组、返回值符合 schema', async () => {
  const { ctx, persistence, attached } = makeCtx({ 'D:\\demo\\codex\\simple.jsonl': load('codex-simple.jsonl') })
  apply(ctx)
  const def = chatDef(ctx, 'codex')
  const value = await def.execute({ path: 'D:\\demo\\codex\\simple.jsonl' })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-019e3b3f-636d-7cb3-aaab-0255eb45ad4f')
  assert.equal(value.turns, 1)
  assert.equal(value.messages, 2)
  assert.equal(value.toolCalls, 0)
  assert.equal(value.alreadyImported, false)

  const violations = validateJsonSchemaValue(def.output.schema, value)
  assert.deepEqual(violations, [])

  const saved = persistence.sessions.get('import-019e3b3f-636d-7cb3-aaab-0255eb45ad4f')
  assert.ok(saved)
  assert.equal(saved.meta.cwd, 'D:\\demo\\codex-proj')
  assert.equal(saved.events.at(-1).type, 'turn/end')
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assertImportedMarker(saved.events, { tool: 'codex', sourceId: '019e3b3f-636d-7cb3-aaab-0255eb45ad4f', sourcePath: 'D:\\demo\\codex\\simple.jsonl' })
  assert.equal(attached.length, 1)
  assert.equal(attached[0].id, 'import-019e3b3f-636d-7cb3-aaab-0255eb45ad4f')
})

test('import_codex 工具历史：tool/result 带 sourceEventSeqs 且 output 落盘', async () => {
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\codex\\tool.jsonl': load('codex-tool.jsonl') })
  apply(ctx)
  const def = chatDef(ctx, 'codex')
  const value = await def.execute({ path: 'D:\\demo\\codex\\tool.jsonl' })
  assert.equal(value.mode, 'single')
  assert.equal(value.toolCalls, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get(value.sessionId)
  const result = saved.events.find((e) => e.type === 'tool/result')
  assert.ok(result)
  assert.equal(result.data.message.content[0].content[0].text, 'README.md\nsrc\n')
})

test('import_codex 目录批量导入：递归扫描、逐文件独立会话、schema 校验', async () => {
  const tree = {
    'D:\\demo\\codex': 'dir',
    'D:\\demo\\codex\\a.jsonl': load('codex-simple.jsonl'),
    'D:\\demo\\codex\\b.jsonl': load('codex-tool.jsonl'),
  }
  const { ctx, persistence, attached } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'codex')
  const value = await def.execute({ path: 'D:\\demo\\codex' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.equal(value.alreadyImported, 0)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  assert.equal(persistence.sessions.size, 2)
  assert.equal(attached.length, 2)
})

test('import_codex 幂等：重复导入同一文件已存在则跳过', async () => {
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\codex\\a.jsonl': load('codex-simple.jsonl') })
  apply(ctx)
  const def = chatDef(ctx, 'codex')
  const first = await def.execute({ path: 'D:\\demo\\codex\\a.jsonl' })
  const second = await def.execute({ path: 'D:\\demo\\codex\\a.jsonl' })
  assert.equal(first.alreadyImported, false)
  assert.equal(second.alreadyImported, true)
  assert.equal(persistence.sessions.size, 1)
})

// ---- import_workbuddy 集成 ----

// 合成 WorkBuddy transcript（事件词汇对齐 lib/convert/workbuddy.mjs）。
const WB_SID = 'wb-sess-0001'
const WB_CWD = 'D:\\demo\\workbuddy-proj'
const WB_TS = 1787131157250
function wbUser(text) {
  return { id: 'u', timestamp: WB_TS, type: 'message', role: 'user', content: [{ type: 'input_text', text: '<user_query>' + text + '</user_query>' }], sessionId: WB_SID, cwd: WB_CWD }
}
function wbAssistant(text) {
  return { id: 'a', timestamp: WB_TS + 1, type: 'message', role: 'assistant', content: [{ type: 'output_text', text }], sessionId: WB_SID, cwd: WB_CWD }
}
function wbReas(text) {
  return { id: 'r', timestamp: WB_TS + 2, type: 'reasoning', rawContent: [{ type: 'reasoning_text', text }], sessionId: WB_SID, cwd: WB_CWD }
}
function wbCall(callId, name, args) {
  return { id: 'c', timestamp: WB_TS + 3, type: 'function_call', callId, name, arguments: JSON.stringify(args), status: 'completed', sessionId: WB_SID, cwd: WB_CWD }
}
function wbResult(callId, text) {
  return { id: 'x', timestamp: WB_TS + 4, type: 'function_call_result', callId, name: 'Bash', status: 'completed', output: { type: 'text', text }, sessionId: WB_SID, cwd: WB_CWD }
}
function wbTranscript(recs) {
  return recs.map((r) => JSON.stringify(r)).join('\n')
}

test('import_workbuddy 单文件导入：落盘、归组、返回值符合 schema', async () => {
  const src = 'D:\\demo\\workbuddy\\' + WB_SID + '.jsonl'
  const { ctx, persistence, attached } = makeCtx({ [src]: wbTranscript([
    wbUser('帮我看看这个项目'),
    wbReas('先读结构再答'),
    wbAssistant('好的，我先读一下结构。'),
  ]) })
  apply(ctx)
  const def = chatDef(ctx, 'workbuddy')
  const value = await def.execute({ path: src })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-' + WB_SID)
  assert.equal(value.turns, 1)
  assert.equal(value.messages, 2) // user + assistant（环境变更声明不计）
  assert.equal(value.toolCalls, 0)
  assert.equal(value.alreadyImported, false)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get('import-' + WB_SID)
  assert.ok(saved)
  assert.equal(saved.meta.cwd, WB_CWD)
  assert.equal(saved.meta.sourceId, WB_SID)
  assert.equal(saved.events.at(-1).type, 'turn/end')
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assertImportedMarker(saved.events, { tool: 'workbuddy', sourceId: WB_SID, sourcePath: src })
  assert.equal(attached.length, 1)
  assert.equal(attached[0].id, 'import-' + WB_SID)
})

test('import_workbuddy 工具历史：tool/result 带 sourceEventSeqs 且 output 落盘', async () => {
  const src = 'D:\\demo\\workbuddy\\' + WB_SID + '.jsonl'
  const { ctx, persistence } = makeCtx({ [src]: wbTranscript([
    wbUser('跑一下测试'),
    wbReas('用命令跑'),
    wbAssistant('我用命令跑。'),
    wbCall('call_1', 'Bash', { command: 'npm test' }),
    wbResult('call_1', 'ok 42 passed'),
  ]) })
  apply(ctx)
  const def = chatDef(ctx, 'workbuddy')
  const value = await def.execute({ path: src })
  assert.equal(value.mode, 'single')
  assert.equal(value.toolCalls, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get(value.sessionId)
  const result = saved.events.find((e) => e.type === 'tool/result')
  assert.ok(result)
  assert.deepEqual(result.sourceEventSeqs, [saved.events.find((e) => e.type === 'tool/call').seq])
  assert.equal(result.data.message.content[0].content[0].text, 'ok 42 passed')
})

test('import_workbuddy 幂等：重复导入同一文件已存在则跳过', async () => {
  const src = 'D:\\demo\\workbuddy\\' + WB_SID + '.jsonl'
  const { ctx, persistence } = makeCtx({ [src]: wbTranscript([
    wbUser('第一问'),
    wbAssistant('一答'),
  ]) })
  apply(ctx)
  const def = chatDef(ctx, 'workbuddy')
  const first = await def.execute({ path: src })
  const second = await def.execute({ path: src })
  assert.equal(first.alreadyImported, false)
  assert.equal(second.alreadyImported, true)
  assert.equal(persistence.sessions.size, 1)
})

// ---- import_chatgpt 集成 ----

test('import_chatgpt 单文件：一文件多会话、恒返回 batch、schema 校验', async () => {
  const { ctx, persistence, attached } = makeCtx({ 'D:\\demo\\chatgpt\\conversations.json': load('chatgpt-export.json') })
  apply(ctx)
  const def = chatDef(ctx, 'chatgpt')
  const value = await def.execute({ path: 'D:\\demo\\chatgpt\\conversations.json' })

  assert.equal(value.mode, 'batch') // 单文件也恒 batch
  assert.equal(value.total, 3) // 3 个会话（含 1 个被跳过的 system-only）
  assert.equal(value.imported, 2)
  assert.equal(value.skipped, 1)
  assert.equal(value.failed, 0)
  assert.equal(value.results.length, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved1 = persistence.sessions.get('import-conv-001')
  const saved2 = persistence.sessions.get('import-conv-002')
  assert.ok(saved1)
  assert.ok(saved2)
  assert.equal(saved1.events.at(-1).type, 'session/title')
  assert.ok(saved1.events.every((e, i) => e.seq === i))
  // 同一文件里的每个会话都带标记，sourcePath 都是 conversations.json（REQ-32）
  assertImportedMarker(saved1.events, { tool: 'chatgpt', sourceId: 'conv-001', sourcePath: 'D:\\demo\\chatgpt\\conversations.json' })
  assertImportedMarker(saved2.events, { tool: 'chatgpt', sourceId: 'conv-002', sourcePath: 'D:\\demo\\chatgpt\\conversations.json' })
  // ChatGPT 无 cwd → REQ-39-lite 回退归到导出文件所在目录（否则堆进「未分组」找不到）
  assert.equal(attached.length, 2)
  assert.ok(attached.every((a) => a.ws === dirname('D:\\demo\\chatgpt\\conversations.json')))
  assert.deepEqual(attached.map((a) => a.id).sort(), ['import-conv-001', 'import-conv-002'])
})

test('import_chatgpt 幂等：重复导入同一文件只落盘一次', async () => {
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\chatgpt\\conversations.json': load('chatgpt-export.json') })
  apply(ctx)
  const def = chatDef(ctx, 'chatgpt')
  const first = await def.execute({ path: 'D:\\demo\\chatgpt\\conversations.json' })
  const second = await def.execute({ path: 'D:\\demo\\chatgpt\\conversations.json' })
  assert.equal(first.imported, 2)
  assert.equal(second.imported, 0)
  assert.equal(second.alreadyImported, 2)
  assert.equal(persistence.sessions.size, 2)
})

test('REQ-19 import_chatgpt branch:all：多分支会话全部落盘、幂等、schema 校验', async () => {
  const branchFixture = JSON.stringify([{
    id: 'conv-branch-x',
    title: 'Branch x',
    create_time: 1710030000,
    mapping: {
      'a1': { id: 'a1', message: { id: 'ma1', author: { role: 'user' }, content: { content_type: 'text', parts: ['问'] }, create_time: 1710030000 }, parent: null, children: ['a2'] },
      'a2': { id: 'a2', message: { id: 'ma2', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['两条路'] }, create_time: 1710030100 }, parent: 'a1', children: ['b1', 'b2'] },
      'b1': { id: 'b1', message: { id: 'mb1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['路 A'] }, create_time: 1710030200 }, parent: 'a2', children: [] },
      'b2': { id: 'b2', message: { id: 'mb2', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['路 B'] }, create_time: 1710030300 }, parent: 'a2', children: [] },
    },
  }])
  const { ctx, persistence } = makeCtx({
    'D:\\demo\\chatgpt\\main.json': branchFixture,
    'D:\\demo\\chatgpt\\branches.json': branchFixture,
  })
  apply(ctx)
  const def = chatDef(ctx, 'chatgpt')
  // 默认 main：只有主线程（b2，最后 child）一个会话
  const main = await def.execute({ path: 'D:\\demo\\chatgpt\\main.json' })
  assert.equal(main.imported, 1)
  assert.equal(persistence.sessions.size, 1)
  assert.ok(persistence.sessions.has('import-conv-branch-x'))
  // all：主会话 + 分支会话全部落盘（branch 参数进 schema）
  const schemaBranch = def.parameters.properties.branch
  assert.ok(schemaBranch)
  assert.deepEqual(schemaBranch.enum, ['main', 'all'])
  // 分支 fixture：a2 分叉 b1/b2——主线程 = 最后 child（b2），all = 主 + b1 共 2 会话
  const all = await def.execute({ path: 'D:\\demo\\chatgpt\\branches.json', branch: 'all' })
  assert.equal(all.imported, 2)
  assert.equal(persistence.sessions.size, 3)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, all), [])
  const branchIds = [...persistence.sessions.keys()].filter((id) => id !== 'import-conv-branch-x')
  assert.equal(branchIds.length, 2)
  assert.ok(branchIds.every((id) => id.startsWith('import-conv-branch-x')))
  // 幂等：all 再导全部 already-imported
  const again = await def.execute({ path: 'D:\\demo\\chatgpt\\branches.json', branch: 'all' })
  assert.equal(again.imported, 0)
  assert.equal(again.alreadyImported, 2)
})

test('REQ-55 multi 源归档重导：部分会话归档 → 重导只对归档会话建后缀新副本，其余幂等', async () => {
  const file = 'D:\\demo\\chatgpt\\conversations.json'
  const { ctx, persistence } = makeCtx({ [file]: load('chatgpt-export.json') })
  apply(ctx)
  const def = chatDef(ctx, 'chatgpt')
  const first = await def.execute({ path: file })
  assert.equal(first.imported, 2)

  // 归档其中一个会话（conv-001）→ 短路径 allPersisted 失效，走全量重导
  const wr = ctx.get('workspaceRegistry')
  await wr.archiveSession('import-conv-001')
  const second = await def.execute({ path: file })
  assert.equal(second.imported, 1) // 仅 conv-001 重导（后缀新副本）
  assert.equal(second.alreadyImported, 1) // conv-002 幂等跳过
  assert.equal(persistence.sessions.size, 3)
  assert.equal(second.results.find((r) => r.status === 'imported').sessionId, 'import-conv-001-1')
  assert.ok(persistence.sessions.has('import-conv-001')) // 归档会话保留
  assert.ok(persistence.sessions.has('import-conv-001-1'))

  // 记录子表指向新副本
  const registry = (await loadImports(resolveRegistryDir())).imports
  assert.equal(registry[file].conversations['conv-001'].dshId, 'import-conv-001-1')
  assert.equal(registry[file].conversations['conv-002'].dshId, 'import-conv-002')
})

test('import_chatgpt 目录模式：扫描 .json（非 .jsonl）、递归汇总', async () => {
  const tree = {
    'D:\\demo\\chatgpt': 'dir',
    'D:\\demo\\chatgpt\\conversations.json': load('chatgpt-export.json'),
    'D:\\demo\\chatgpt\\sub': 'dir',
    'D:\\demo\\chatgpt\\sub\\more.json': '[{"id":"conv-010","title":"Extra","create_time":1710020000,"mapping":{"x1":{"id":"x1","message":{"id":"mx1","author":{"role":"user"},"content":{"content_type":"text","parts":["hi"]},"create_time":1710020000},"parent":null,"children":[]}}}]',
    'D:\\demo\\chatgpt\\notes.txt': 'not json',
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'chatgpt')
  const value = await def.execute({ path: 'D:\\demo\\chatgpt' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.imported, 3) // conv-001 + conv-002 + conv-010
  assert.equal(value.skipped, 1) // system-only 会话
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  assert.equal(persistence.sessions.size, 3)
})

test('import_chatgpt 非法 JSON：计入 skipped 而非 failed', async () => {
  const { ctx } = makeCtx({ 'D:\\demo\\chatgpt\\bad.json': 'not json' })
  apply(ctx)
  const def = chatDef(ctx, 'chatgpt')
  const value = await def.execute({ path: 'D:\\demo\\chatgpt\\bad.json' })
  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 1)
  assert.equal(value.skipped, 1)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

// ---- import_cursor 集成 ----

test('import_cursor 单文件：composer id 从文件名派生、落盘、schema 校验', async () => {
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\cursor\\composer-abc.jsonl': load('cursor-simple.jsonl') })
  apply(ctx)
  const def = chatDef(ctx, 'cursor')
  const value = await def.execute({ path: 'D:\\demo\\cursor\\composer-abc.jsonl' })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-composer-abc') // 文件名（去 .jsonl）→ composer id
  assert.equal(value.turns, 1)
  assert.equal(value.messages, 3)
  assert.equal(value.alreadyImported, false)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get('import-composer-abc')
  assert.ok(saved)
  assert.equal(saved.events.at(-1).type, 'turn/end') // Cursor 无 title，事件以 turn/end 收尾
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assertImportedMarker(saved.events, { tool: 'cursor', sourceId: 'composer-abc', sourcePath: 'D:\\demo\\cursor\\composer-abc.jsonl' })
})

test('import_cursor 幂等：同名 composer 文件不重复落盘', async () => {
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\cursor\\composer-abc.jsonl': load('cursor-simple.jsonl') })
  apply(ctx)
  const def = chatDef(ctx, 'cursor')
  const first = await def.execute({ path: 'D:\\demo\\cursor\\composer-abc.jsonl' })
  const second = await def.execute({ path: 'D:\\demo\\cursor\\composer-abc.jsonl' })
  assert.equal(first.alreadyImported, false)
  assert.equal(second.alreadyImported, true)
  assert.equal(persistence.sessions.size, 1)
})

test('import_cursor 目录模式：递归扫描 .jsonl、逐文件独立会话', async () => {
  const tree = {
    'D:\\demo\\cursor': 'dir',
    'D:\\demo\\cursor\\composer-a.jsonl': load('cursor-simple.jsonl'),
    'D:\\demo\\cursor\\sub': 'dir',
    'D:\\demo\\cursor\\sub\\composer-b.jsonl': load('cursor-tool.jsonl'),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'cursor')
  const value = await def.execute({ path: 'D:\\demo\\cursor' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  const ids = [...persistence.sessions.keys()].sort()
  assert.deepEqual(ids, ['import-composer-a', 'import-composer-b'])
})

// ---- import_gemini 集成 ----

test('import_gemini 单文件：落盘、归组、schema 校验', async () => {
  const { ctx, persistence, attached } = makeCtx({ 'D:\\demo\\gemini\\session-abc.json': load('gemini-simple.json') })
  apply(ctx)
  const def = chatDef(ctx, 'gemini')
  const value = await def.execute({ path: 'D:\\demo\\gemini\\session-abc.json' })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-b26d7f99-0116-4d1d-b125-98c228a4b933')
  assert.equal(value.turns, 1)
  assert.equal(value.alreadyImported, false)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get('import-b26d7f99-0116-4d1d-b125-98c228a4b933')
  assert.ok(saved)
  assert.equal(saved.meta.cwd, 'D:\\demo\\gemini-proj')
  assert.equal(saved.events.at(-1).type, 'turn/end')
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assertImportedMarker(saved.events, { tool: 'gemini', sourceId: 'b26d7f99-0116-4d1d-b125-98c228a4b933', sourcePath: 'D:\\demo\\gemini\\session-abc.json' })
  // Gemini 有 cwd → 归组
  assert.equal(attached.length, 1)
})

test('import_gemini 工具历史：内联 tool/result 落盘', async () => {
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\gemini\\session-tool.json': load('gemini-tool.json') })
  apply(ctx)
  const def = chatDef(ctx, 'gemini')
  const value = await def.execute({ path: 'D:\\demo\\gemini\\session-tool.json' })
  assert.equal(value.toolCalls, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get(value.sessionId)
  const results = saved.events.filter((e) => e.type === 'tool/result')
  assert.equal(results.length, 2)
  assert.equal(results[0].data.message.content[0].content[0].text, 'src\nCargo.toml')
  assert.equal(results[1].data.message.content[0].isError, true)
})

test('import_gemini 目录模式：扫描 .json、递归、逐文件独立会话', async () => {
  const tree = {
    'D:\\demo\\gemini': 'dir',
    'D:\\demo\\gemini\\session-a.json': load('gemini-simple.json'),
    'D:\\demo\\gemini\\sub': 'dir',
    'D:\\demo\\gemini\\sub\\session-b.json': load('gemini-multi-turn.json'),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'gemini')
  const value = await def.execute({ path: 'D:\\demo\\gemini' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  assert.equal(persistence.sessions.size, 2)
})

test('import_gemini 非法 JSON：单文件计入 skipped 不落盘', async () => {
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\gemini\\bad.json': 'not json' })
  apply(ctx)
  const def = chatDef(ctx, 'gemini')
  const value = await def.execute({ path: 'D:\\demo\\gemini\\bad.json' })
  assert.equal(value.mode, 'single')
  assert.equal(value.skipped, 1)
  assert.equal(persistence.sessions.size, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

// ---- import_reasonix 集成 ----

test('import_reasonix 单文件：meta 派生 cwd/标题、落盘、schema 校验', async () => {
  const { ctx, persistence, attached } = makeCtx({
    'D:\\demo\\reasonix\\desktop-v2.jsonl': load('reasonix-v2.jsonl'),
    'D:\\demo\\reasonix\\desktop-v2.meta.json': load('reasonix-v2.meta.json'),
  })
  apply(ctx)
  const def = chatDef(ctx, 'reasonix')
  const value = await def.execute({ path: 'D:\\demo\\reasonix\\desktop-v2.jsonl' })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-desktop-v2') // 文件名 stem
  assert.equal(value.turns, 1)
  assert.equal(value.toolCalls, 1)
  assert.equal(value.alreadyImported, false)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get('import-desktop-v2')
  assert.ok(saved)
  assert.equal(saved.meta.cwd, 'D:\\Reasonix') // meta.workspace → cwd
  assert.equal(saved.events.at(-1).type, 'session/title') // meta.summary → 标题
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assertImportedMarker(saved.events, { tool: 'reasonix', sourceId: 'desktop-v2', sourcePath: 'D:\\demo\\reasonix\\desktop-v2.jsonl' })
  // cwd → 归组
  assert.equal(attached.length, 1)
  assert.equal(attached[0].id, 'import-desktop-v2')
})

test('import_reasonix 目录模式：递归扫描、排除 WAL 伴生文件、逐文件独立会话', async () => {
  const tree = {
    'D:\\demo\\reasonix': 'dir',
    'D:\\demo\\reasonix\\desktop-a.jsonl': load('reasonix-v1.jsonl'),
    'D:\\demo\\reasonix\\desktop-a.jsonl.bak': load('reasonix-v1.jsonl'),
    'D:\\demo\\reasonix\\sub': 'dir',
    'D:\\demo\\reasonix\\sub\\desktop-b.jsonl': load('reasonix-multi-turn.jsonl'),
    // V2 WAL / 伴生文件：目录扫描必须排除
    'D:\\demo\\reasonix\\desktop-a.events.jsonl': '{"type":"event"}',
    'D:\\demo\\reasonix\\desktop-a.conflicts.jsonl': '{}',
    'D:\\demo\\reasonix\\desktop-a.guardian.jsonl': '{}',
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'reasonix')
  const value = await def.execute({ path: 'D:\\demo\\reasonix' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2) // desktop-a.jsonl + sub/desktop-b.jsonl（bak/WAL 均排除）
  assert.equal(value.imported, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  const ids = [...persistence.sessions.keys()].sort()
  assert.deepEqual(ids, ['import-desktop-a', 'import-desktop-b'])
})

test('import_reasonix 幂等：同名 stem 不重复落盘', async () => {
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\reasonix\\desktop-a.jsonl': load('reasonix-v1.jsonl') })
  apply(ctx)
  const def = chatDef(ctx, 'reasonix')
  const first = await def.execute({ path: 'D:\\demo\\reasonix\\desktop-a.jsonl' })
  const second = await def.execute({ path: 'D:\\demo\\reasonix\\desktop-a.jsonl' })
  assert.equal(first.alreadyImported, false)
  assert.equal(second.alreadyImported, true)
  assert.equal(persistence.sessions.size, 1)
})


// ---- import_pi 集成 ----

test('import_pi 单文件：头行 cwd/id 落盘、归组、返回值符合 schema', async () => {
  const { ctx, persistence, attached } = makeCtx({ 'D:\\demo\\pi\\2025-06-01_pi-simple.jsonl': load('pi-simple.jsonl') })
  apply(ctx)
  const def = chatDef(ctx, 'pi')
  const value = await def.execute({ path: 'D:\\demo\\pi\\2025-06-01_pi-simple.jsonl' })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-019f0a11-2222-7333-8444-555566667777')
  assert.equal(value.turns, 2)
  assert.equal(value.messages, 4)
  assert.equal(value.toolCalls, 0)
  assert.equal(value.alreadyImported, false)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get('import-019f0a11-2222-7333-8444-555566667777')
  assert.ok(saved)
  assert.equal(saved.meta.cwd, 'D:\\demo\\pi-proj')
  assert.equal(saved.events.at(-1).type, 'turn/end')
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assertImportedMarker(saved.events, { tool: 'pi-coding-agent', sourceId: '019f0a11-2222-7333-8444-555566667777', sourcePath: 'D:\\demo\\pi\\2025-06-01_pi-simple.jsonl' })
  // cwd → 归组
  assert.equal(attached.length, 1)
  assert.equal(attached[0].id, 'import-019f0a11-2222-7333-8444-555566667777')
})

test('import_pi 目录批量导入：递归扫描、逐文件独立会话、schema 校验', async () => {
  const tree = {
    'D:\\demo\\pi': 'dir',
    'D:\\demo\\pi\\s1.jsonl': load('pi-simple.jsonl'),
    'D:\\demo\\pi\\sub': 'dir',
    'D:\\demo\\pi\\sub\\s2.jsonl': load('pi-v1.jsonl'),
    'D:\\demo\\pi\\notes.txt': 'not a transcript',
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'pi')
  const value = await def.execute({ path: 'D:\\demo\\pi' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2) // 两个 .jsonl（notes.txt 被过滤）
  assert.equal(value.imported, 2)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  assert.equal(persistence.sessions.size, 2)
  assert.ok(persistence.sessions.has('import-019f0a11-2222-7333-8444-555566667777'))
  assert.ok(persistence.sessions.has('import-019f0a11-6666-7777-8888-999900001111'))
})

test('import_pi 幂等 + fullHistory 入 args 指纹（换值重导 → argsChanged）', async () => {
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\pi\\c.jsonl': load('pi-compaction.jsonl') })
  apply(ctx)
  const def = chatDef(ctx, 'pi')
  const first = await def.execute({ path: 'D:\\demo\\pi\\c.jsonl' })
  const second = await def.execute({ path: 'D:\\demo\\pi\\c.jsonl' })
  assert.equal(first.alreadyImported, false)
  assert.equal(second.alreadyImported, true)
  assert.equal(persistence.sessions.size, 1)
  // 换 fullHistory 重导 → 参数指纹变化 → argsChanged 跳过，不另建会话
  const third = await def.execute({ path: 'D:\\demo\\pi\\c.jsonl', fullHistory: true })
  assert.equal(third.alreadyImported, true)
  assert.equal(third.argsChanged, true)
  assert.equal(persistence.sessions.size, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, third), [])
})

test('import_pi 非 Pi 文件：单文件跳过并返回 skipReason', async () => {
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\pi\\codex.jsonl': load('codex-simple.jsonl') })
  apply(ctx)
  const def = chatDef(ctx, 'pi')
  const value = await def.execute({ path: 'D:\\demo\\pi\\codex.jsonl' })
  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'none')
  assert.equal(value.skipped, 1)
  assert.match(value.skipReason, /no session header/)
  assert.equal(persistence.sessions.size, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

// ---- import_opencode 集成（真实 SQLite 临时库） ----

// 合成 opencode 会话（两代消息形状：平铺 modelID / 无模型回退会话级）。
function opencodeTestSessions() {
  return [
    {
      id: 'ses-a',
      title: 'Fix build',
      directory: 'E:/demo/opencode',
      createdAt: 1786000000000,
      model: { id: 'deepseek-v4-flash', providerID: 'opencode-go' },
      messages: [
        { id: 'msg-a1', createdAt: 1786000000001, data: { role: 'user' }, parts: [
          { id: 'p-a1', createdAt: 1786000000001, data: { type: 'text', text: '为什么构建失败' } },
        ] },
        { id: 'msg-a2', createdAt: 1786000000002, data: { role: 'assistant', modelID: 'deepseek-v4-pro', path: { cwd: 'E:/demo/opencode' } }, parts: [
          { id: 'p-a2', createdAt: 1786000000002, data: { type: 'reasoning', text: '看日志' } },
          { id: 'p-a3', createdAt: 1786000000003, data: { type: 'tool', tool: 'bash', callID: 'call-a1', state: { status: 'completed', input: { command: 'cargo build' }, output: 'Compiling...' } } },
          { id: 'p-a4', createdAt: 1786000000004, data: { type: 'text', text: '修好了' } },
        ] },
      ],
    },
    {
      id: 'ses-b',
      title: 'Refactor',
      directory: 'E:/demo/opencode',
      createdAt: 1786000100000,
      model: { id: 'deepseek-v4-flash', providerID: 'opencode-go' },
      messages: [
        { id: 'msg-b1', createdAt: 1786000100001, data: { role: 'user' }, parts: [
          { id: 'p-b1', createdAt: 1786000100001, data: { type: 'text', text: '重构模块' } },
        ] },
        { id: 'msg-b2', createdAt: 1786000100002, data: { role: 'assistant' }, parts: [
          { id: 'p-b2', createdAt: 1786000100002, data: { type: 'text', text: '完成' } },
        ] },
      ],
    },
  ]
}

// 合成一个含对话压缩（compaction）的 opencode 会话：c1/c2 被压掉，c3 起为尾巴，c5 是触发器（无正文），c6 是摘要。
function opencodeCompactedSession() {
  return {
    id: 'ses-comp',
    title: 'Long task',
    directory: 'E:/demo/opencode',
    createdAt: 1786000000000,
    model: { id: 'deepseek-v4-flash', providerID: 'opencode-go' },
    messages: [
      { id: 'msg-c1', createdAt: 1786000000001, data: { role: 'user' }, parts: [
        { id: 'p-c1', createdAt: 1786000000001, data: { type: 'text', text: '第一个问题' } },
      ] },
      { id: 'msg-c2', createdAt: 1786000000002, data: { role: 'assistant' }, parts: [
        { id: 'p-c2', createdAt: 1786000000002, data: { type: 'text', text: '第一个回答' } },
      ] },
      { id: 'msg-c3', createdAt: 1786000000003, data: { role: 'user' }, parts: [
        { id: 'p-c3', createdAt: 1786000000003, data: { type: 'text', text: '第二个问题' } },
      ] },
      { id: 'msg-c4', createdAt: 1786000000004, data: { role: 'assistant' }, parts: [
        { id: 'p-c4', createdAt: 1786000000004, data: { type: 'text', text: '第二个回答' } },
      ] },
      { id: 'msg-c5', createdAt: 1786000000005, data: { role: 'user' }, parts: [
        { id: 'p-c5', createdAt: 1786000000005, data: { type: 'compaction', tail_start_id: 'msg-c3' } },
      ] },
      { id: 'msg-c6', createdAt: 1786000000006, data: { role: 'assistant', mode: 'compaction', summary: true }, parts: [
        { id: 'p-c6', createdAt: 1786000000006, data: { type: 'text', text: '前面做过的所有事摘要。' } },
      ] },
    ],
  }
}

// 在 os.tmpdir() 建临时 opencode.db（opencode schema 的 session/message/part 三表），返回 db 路径。
function makeOpencodeDb(sessions) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-opencode-'))
  const dbPath = join(dir, 'opencode.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, model TEXT)')
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)')
  db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  for (const s of sessions) {
    db.prepare('INSERT INTO session (id, title, directory, time_created, model) VALUES (?, ?, ?, ?, ?)').run(s.id, s.title, s.directory, s.createdAt, JSON.stringify(s.model))
    for (const m of s.messages) {
      db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run(m.id, s.id, m.createdAt, JSON.stringify(m.data))
      for (const p of m.parts) {
        db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(p.id, m.id, s.id, p.createdAt, JSON.stringify(p.data))
      }
    }
  }
  db.close()
  return dbPath
}

// 往已建好的临时 opencode.db 追加一轮（user + assistant 各一条 text part）。
function addOpencodeTurn(dbPath, sessionId, baseId, userText, asstText, timeBase) {
  const db = new DatabaseSync(dbPath)
  db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run(baseId + '-u', sessionId, timeBase, JSON.stringify({ role: 'user' }))
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(baseId + '-p1', baseId + '-u', sessionId, timeBase, JSON.stringify({ type: 'text', text: userText }))
  db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run(baseId + '-a', sessionId, timeBase + 1, JSON.stringify({ role: 'assistant' }))
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(baseId + '-p2', baseId + '-a', sessionId, timeBase + 1, JSON.stringify({ type: 'text', text: asstText }))
  db.close()
}

// 从临时 opencode.db 删除指定 message（含其 parts）。
function deleteOpencodeMessages(dbPath, ids) {
  const db = new DatabaseSync(dbPath)
  for (const id of ids) {
    db.prepare('DELETE FROM part WHERE message_id = ?').run(id)
    db.prepare('DELETE FROM message WHERE id = ?').run(id)
  }
  db.close()
}

test('import_opencode 单库文件：批量形态、逐会话落盘、schema 校验', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const { ctx, persistence, attached } = makeCtx({}) // stat 不在 tree 里 → 按 DB 文件处理
  apply(ctx)
  const def = chatDef(ctx, 'opencode')
  const value = await def.execute({ path: dbPath })

  assert.equal(value.mode, 'batch') // 单 .db 也恒批量
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.equal(value.alreadyImported, 0)
  assert.equal(value.skipped, 0)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const savedA = persistence.sessions.get('import-ses-a')
  assert.ok(savedA)
  assert.equal(savedA.meta.cwd, 'E:/demo/opencode')
  assert.equal(savedA.meta.createdAt, 1786000000000)
  assert.equal(savedA.events.at(-1).type, 'session/title')
  assert.ok(savedA.events.every((e, i) => e.seq === i))
  // 标记：tool=opencode、sourceId=源会话 id、sourcePath=opencode.db 路径（工具入参）
  assertImportedMarker(savedA.events, { tool: 'opencode', sourceId: 'ses-a', sourcePath: dbPath })
  // tool/call + tool/result 关联落盘
  const call = savedA.events.find((e) => e.type === 'tool/call')
  const result = savedA.events.find((e) => e.type === 'tool/result')
  assert.equal(call.data.callId, 'call-a1')
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  assert.equal(result.data.message.content[0].content[0].text, 'Compiling...')
  // 会话级模型回退（msg-b2 无模型）
  const savedB = persistence.sessions.get('import-ses-b')
  assert.ok(savedB)
  const asstB = savedB.events.find((e) => e.type === 'assistant/message').data.message
  assert.equal(asstB.source.model, 'deepseek-v4-flash')
  // 有 cwd → 归组两个会话
  assert.equal(attached.length, 2)
})

test('import_opencode 目录模式：自动定位 opencode.db、schema 校验', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const dirPath = dirname(dbPath)
  const { ctx, persistence } = makeCtx({ [dirPath]: 'dir' }) // stat 命中 → 目录分支
  apply(ctx)
  const def = chatDef(ctx, 'opencode')
  const value = await def.execute({ path: dirPath })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  assert.equal(persistence.sessions.size, 2)
})

test('import_opencode sessionIds 过滤：只导指定源会话', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'opencode')
  const value = await def.execute({ path: dbPath, sessionIds: ['ses-b'] })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2) // 库里 2 个会话，只处理被选中的
  assert.equal(value.imported, 1)
  assert.equal(value.results.length, 1)
  assert.equal(value.results[0].sessionId, 'import-ses-b')
  assert.equal(persistence.sessions.size, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('import_opencode 幂等：重复导入同一库只落盘一次', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'opencode')
  const first = await def.execute({ path: dbPath })
  const second = await def.execute({ path: dbPath })

  assert.equal(first.imported, 2)
  assert.equal(second.imported, 0)
  assert.equal(second.alreadyImported, 2)
  assert.equal(persistence.sessions.size, 2)
})

test('readOpencodeDb：只读抽取会话、消息/part 排序、模型解析', () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const sessions = readOpencodeDb(dbPath)

  assert.equal(sessions.length, 2)
  const a = sessions.find((s) => s.id === 'ses-a')
  assert.equal(a.title, 'Fix build')
  assert.equal(a.directory, 'E:/demo/opencode')
  assert.equal(a.model, 'deepseek-v4-flash') // session.model JSON 字符串 → id
  assert.equal(a.createdAt, 1786000000000)
  assert.equal(a.messages.length, 2)
  assert.equal(a.messages[0].role, 'user')
  assert.equal(a.messages[1].role, 'assistant')
  assert.equal(a.messages[1].model, 'deepseek-v4-pro') // data.modelID 平铺
  assert.equal(a.messages[1].cwd, 'E:/demo/opencode') // data.path.cwd
  assert.equal(a.messages[1].parts.length, 3)
  assert.equal(a.messages[1].parts[0].type, 'reasoning')
  assert.equal(a.messages[1].parts[1].type, 'tool')
  // 无模型的消息不携带 model
  const b = sessions.find((s) => s.id === 'ses-b')
  assert.equal(b.messages[1].model, undefined)
})

test('readOpencodeDb：尊重压缩只导摘要+尾巴，fullHistory 导全量', () => {
  const dbPath = makeOpencodeDb([opencodeCompactedSession()])
  const [s] = readOpencodeDb(dbPath)
  assert.equal(s.summary, '前面做过的所有事摘要。')
  assert.equal(s.messages.length, 3) // c3/c4/c5（c1/c2 被压掉，c6 摘要消息剔除）
  assert.equal(s.messages[0].id, 'msg-c3')
  assert.equal(s.messages[1].id, 'msg-c4')
  assert.equal(s.messages[2].id, 'msg-c5')

  const [full] = readOpencodeDb(dbPath, { fullHistory: true })
  assert.equal(full.summary, undefined)
  assert.equal(full.messages.length, 6) // 全量
})

test('import_opencode fullHistory：true 导入全量历史', async () => {
  const dbPath = makeOpencodeDb([opencodeCompactedSession()])
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'opencode')
  const value = await def.execute({ path: dbPath, fullHistory: true })
  assert.equal(value.imported, 1)
  const saved = persistence.sessions.get('import-ses-comp')
  assert.ok(saved)
  assert.equal(saved.events.filter((e) => e.type === 'user/message' && e.data.source.kind === 'user').length, 2) // c1 + c3（c5 无正文被跳过）
  assert.equal(saved.events.filter((e) => e.type === 'assistant/message').length, 3) // c2 + c4 + c6
})

test('import_opencode 读不到 DB：失败大声抛错', async () => {
  const { ctx } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'opencode')
  await assert.rejects(() => def.execute({ path: join(tmpdir(), 'no-such-opencode.db') }))
})

// ---- import_grokbuild 集成（会话目录：summary.json + chat_history.jsonl） ----

// 合成 Grok Build chat_history.jsonl：N 轮 user/assistant 交替。
function grokChat(n) {
  const lines = []
  for (let i = 1; i <= n; i++) {
    lines.push(JSON.stringify({ type: 'user', content: [{ type: 'text', text: '问题' + i }] }))
    lines.push(JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: '回答' + i }] }))
  }
  return lines.join('\n')
}

test('import_grokbuild 单会话目录：双文件转换、落盘、归组、schema 校验', async () => {
  const dir = 'D:\\demo\\grok\\sessions\\proj-a\\grok-sess-001'
  const tree = {
    [dir]: 'dir',
    [dir + '\\summary.json']: JSON.stringify({
      info: { id: 'grok-sess-001', cwd: 'D:/demo/grok-proj' },
      generated_title: 'Grok 会话标题',
      created_at: '2026-07-16T12:00:00Z',
    }),
    [dir + '\\chat_history.jsonl']: grokChat(1),
  }
  const { ctx, persistence, attached } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'grokbuild')
  const value = await def.execute({ path: dir })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-grok-sess-001')
  assert.equal(value.turns, 1)
  assert.equal(value.messages, 2)
  assert.equal(value.toolCalls, 0)
  assert.equal(value.alreadyImported, false)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get('import-grok-sess-001')
  assert.ok(saved)
  assert.equal(saved.meta.cwd, 'D:/demo/grok-proj')
  assert.equal(saved.meta.sourceId, 'grok-sess-001')
  // 显式标题（generated_title）钉 session/title 事件
  assert.equal(saved.events.at(-1).type, 'session/title')
  assert.equal(saved.events.at(-1).data.title, 'Grok 会话标题')
  assert.ok(saved.events.every((e, i) => e.seq === i))
  // 幂等键 = 会话目录路径
  assertImportedMarker(saved.events, { tool: 'grokbuild', sourceId: 'grok-sess-001', sourcePath: dir })
  assert.equal(attached.length, 1)
  assert.equal(attached[0].id, 'import-grok-sess-001')
})

test('import_grokbuild 目录批量：递归扫 summary.json、逐会话独立落盘', async () => {
  const root = 'D:\\demo\\grok\\sessions'
  const mkSession = (dir, id) => ({
    [dir]: 'dir',
    [dir + '\\summary.json']: JSON.stringify({ info: { id }, created_at: '2026-07-16T12:00:00Z' }),
    [dir + '\\chat_history.jsonl']: grokChat(1),
  })
  const tree = {
    [root]: 'dir',
    [root + '\\proj-a']: 'dir',
    ...mkSession(root + '\\proj-a\\grok-sess-001', 'grok-sess-001'),
    [root + '\\archived_sessions']: 'dir',
    ...mkSession(root + '\\archived_sessions\\grok-sess-002', 'grok-sess-002'),
    [root + '\\notes.txt']: 'not a session',
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'grokbuild')
  const value = await def.execute({ path: root })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  const ids = [...persistence.sessions.keys()].sort()
  assert.deepEqual(ids, ['import-grok-sess-001', 'import-grok-sess-002'])
})

test('import_grokbuild 增量续写：chat_history 增长 → appended 同一会话（REQ-24）', async () => {
  const dir = 'D:\\demo\\grok\\sessions\\p\\grok-sess-incr'
  const summary = JSON.stringify({ info: { id: 'grok-sess-incr', cwd: 'D:/demo/grok-proj' }, created_at: '2026-07-16T12:00:00Z' })
  const tree = { [dir]: 'dir', [dir + '\\summary.json']: summary, [dir + '\\chat_history.jsonl']: grokChat(2) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'grokbuild')
  const first = await def.execute({ path: dir })
  assert.equal(first.status, 'imported')
  const before = persistence.sessions.get('import-grok-sess-incr').events.length

  tree[dir + '\\chat_history.jsonl'] = grokChat(3)
  const second = await def.execute({ path: dir })
  assert.equal(second.mode, 'single')
  assert.equal(second.status, 'appended')
  assert.equal(second.appendedTurns, 1)
  assert.ok(second.appendedEvents > 0)
  assert.equal(persistence.sessions.size, 1) // 同一会话续写
  const saved = persistence.sessions.get('import-grok-sess-incr')
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assert.equal(saved.events.length, before + second.appendedEvents)
  assert.equal(saved.events.filter((e) => e.type === 'turn/start').length, 3)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, second), [])
})

// ---- import_openclaw 集成（sessions.json 索引提供 displayName） ----

test('import_openclaw 单文件：displayName 从同目录 sessions.json 派生、落盘、归组、schema 校验', async () => {
  const tree = {
    'D:\\demo\\openclaw\\sessions.json': JSON.stringify({
      'agent:main:a': { sessionId: 'sess-openclaw-001', displayName: '重构登录模块' },
    }),
    'D:\\demo\\openclaw\\sess-openclaw-001.jsonl': [
      '{"type":"session","id":"sess-openclaw-001","cwd":"/home/dev/proj","timestamp":"2026-03-06T10:00:00Z"}',
      '{"type":"message","message":{"role":"user","content":"帮我看看构建失败"},"timestamp":"2026-03-06T10:01:00Z"}',
      '{"type":"message","message":{"role":"assistant","content":"是缺少依赖。"},"timestamp":"2026-03-06T10:02:00Z"}',
    ].join('\n'),
  }
  const { ctx, persistence, attached } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'openclaw')
  const value = await def.execute({ path: 'D:\\demo\\openclaw\\sess-openclaw-001.jsonl' })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-sess-openclaw-001')
  assert.equal(value.turns, 1)
  assert.equal(value.messages, 2)
  assert.equal(value.alreadyImported, false)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get('import-sess-openclaw-001')
  assert.ok(saved)
  assert.equal(saved.meta.cwd, '/home/dev/proj')
  assert.equal(saved.meta.sourceId, 'sess-openclaw-001')
  // displayName（sessions.json 索引）→ 标题钉 session/title 事件
  assert.equal(saved.events.at(-1).type, 'session/title')
  assert.equal(saved.events.at(-1).data.title, '重构登录模块')
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assertImportedMarker(saved.events, { tool: 'openclaw', sourceId: 'sess-openclaw-001', sourcePath: 'D:\\demo\\openclaw\\sess-openclaw-001.jsonl' })
  assert.equal(attached.length, 1)
  assert.equal(attached[0].id, 'import-sess-openclaw-001')
})

test('import_openclaw 目录批量：递归扫 .jsonl、逐文件独立会话、schema 校验', async () => {
  const file = (id) => [
    '{"type":"session","id":"' + id + '","cwd":"/home/dev/proj","timestamp":"2026-03-06T10:00:00Z"}',
    '{"type":"message","message":{"role":"user","content":"问题"},"timestamp":"2026-03-06T10:01:00Z"}',
    '{"type":"message","message":{"role":"assistant","content":"回答"},"timestamp":"2026-03-06T10:02:00Z"}',
  ].join('\n')
  const tree = {
    'D:\\demo\\openclaw\\agents\\main\\sessions': 'dir',
    'D:\\demo\\openclaw\\agents\\main\\sessions\\sessions.json': JSON.stringify({
      a: { sessionId: 'sess-a', displayName: '会话A' },
      b: { sessionId: 'sess-b', displayName: '会话B' },
    }),
    'D:\\demo\\openclaw\\agents\\main\\sessions\\sess-a.jsonl': file('sess-a'),
    'D:\\demo\\openclaw\\agents\\main\\sessions\\sess-b.jsonl': file('sess-b'),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'openclaw')
  const value = await def.execute({ path: 'D:\\demo\\openclaw\\agents\\main\\sessions' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2) // sessions.json 是 .json 非 .jsonl，不收集
  assert.equal(value.imported, 2)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  const ids = [...persistence.sessions.keys()].sort()
  assert.deepEqual(ids, ['import-sess-a', 'import-sess-b'])
  // 标题来自 sessions.json displayName
  assert.equal(persistence.sessions.get('import-sess-a').events.at(-1).type, 'session/title')
  assert.equal(persistence.sessions.get('import-sess-b').events.at(-1).type, 'session/title')
})

test('import_openclaw 幂等：重复导入同一文件已存在则跳过', async () => {
  const tree = {
    'D:\\demo\\openclaw\\sess-static.jsonl': [
      '{"type":"session","id":"sess-static","cwd":"/tmp/p","timestamp":"2026-03-06T10:00:00Z"}',
      '{"type":"message","message":{"role":"user","content":"hi"},"timestamp":"2026-03-06T10:01:00Z"}',
      '{"type":"message","message":{"role":"assistant","content":"ok"},"timestamp":"2026-03-06T10:02:00Z"}',
    ].join('\n'),
  }
  const { ctx, persistence } = makeCtx(tree) // 无 sessions.json：deriveArgs 吞缺索引，仅无 displayName
  apply(ctx)
  const def = chatDef(ctx, 'openclaw')
  const first = await def.execute({ path: 'D:\\demo\\openclaw\\sess-static.jsonl' })
  const second = await def.execute({ path: 'D:\\demo\\openclaw\\sess-static.jsonl' })
  assert.equal(first.alreadyImported, false)
  assert.equal(first.sessionId, 'import-sess-static')
  assert.equal(second.alreadyImported, true)
  assert.equal(persistence.sessions.size, 1)
})

// ---- import_hermes 集成（state.db SQLite 恒批量 / JSONL 回退） ----

// 建临时 hermes state.db（真实 schema：sessions + messages 表，content 为 TEXT）。
function makeHermesTestDb() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hermes-'))
  const dbPath = join(dir, 'state.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, started_at REAL)')
  db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, created_at REAL)')
  db.prepare('INSERT INTO sessions (id, title, cwd, started_at) VALUES (?, ?, ?, ?)').run('hm-a', 'Fix hermes build', 'E:/demo/hermes', 1786000000000)
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run('hm-a', 'user', '为什么构建失败', 1786000000001)
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run('hm-a', 'assistant', '是缺依赖。', 1786000000002)
  db.prepare('INSERT INTO sessions (id, title, cwd, started_at) VALUES (?, ?, ?, ?)').run('hm-b', 'Refactor', 'E:/demo/hermes', 1786000100000)
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run('hm-b', 'user', '重构模块', 1786000100001)
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run('hm-b', 'assistant', '完成', 1786000100002)
  db.close()
  return dbPath
}

// 往临时 hermes state.db 追加一轮（user + assistant）。
function addHermesTurn(dbPath, sessionId, userText, asstText, timeBase) {
  const db = new DatabaseSync(dbPath)
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(sessionId, 'user', userText, timeBase)
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(sessionId, 'assistant', asstText, timeBase + 1)
  db.close()
}

test('import_hermes SQLite：state.db 恒批量、逐会话落盘、归组、schema 校验', async () => {
  const dbPath = makeHermesTestDb()
  const { ctx, persistence, attached } = makeCtx({}) // stat 回退 node:fs（真实 db 文件）
  apply(ctx)
  const def = chatDef(ctx, 'hermes')
  const value = await def.execute({ path: dbPath })

  assert.equal(value.mode, 'batch') // 单 .db 也恒批量
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.equal(value.alreadyImported, 0)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const savedA = persistence.sessions.get('import-hm-a')
  assert.ok(savedA)
  assert.equal(savedA.meta.cwd, 'E:/demo/hermes')
  assert.equal(savedA.events.at(-1).type, 'session/title')
  assert.equal(savedA.events.at(-1).data.title, 'Fix hermes build')
  assert.ok(savedA.events.every((e, i) => e.seq === i))
  assertImportedMarker(savedA.events, { tool: 'hermes', sourceId: 'hm-a', sourcePath: dbPath })
  const ids = [...persistence.sessions.keys()].sort()
  assert.deepEqual(ids, ['import-hm-a', 'import-hm-b'])
  assert.equal(attached.length, 2) // 两个会话都有 cwd → 归组
})

test('import_hermes db 增量续写：库增长 → 逐会话 append（REQ-24）', async () => {
  const dbPath = makeHermesTestDb()
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'hermes')
  const first = await def.execute({ path: dbPath })
  assert.equal(first.imported, 2)
  const before = persistence.sessions.get('import-hm-a').events.length

  addHermesTurn(dbPath, 'hm-a', '继续追问', '追加回答', 1786000000100)
  const second = await def.execute({ path: dbPath })
  assert.equal(second.mode, 'batch')
  assert.equal(second.appended, 1)
  assert.equal(second.alreadyImported, 1) // hm-b 未变
  const appended = second.results.find((r) => r.status === 'appended')
  assert.ok(appended)
  assert.equal(appended.sessionId, 'import-hm-a')
  const sesA = persistence.sessions.get('import-hm-a')
  assert.ok(sesA.events.every((e, i) => e.seq === i))
  assert.equal(sesA.events.length, before + appended.appendedEvents)
  assert.equal(sesA.events.filter((e) => e.type === 'turn/start').length, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, second), [])
})

test('import_hermes JSONL 回退：目录无可用 state.db → 递归扫 .jsonl 批量', async () => {
  const tree = {
    'D:\\demo\\hermes\\sessions': 'dir',
    'D:\\demo\\hermes\\sessions\\s1.jsonl': JSON.stringify({ role: 'user', content: '什么是 Rust？', ts: 1700000000 }) + '\n' + JSON.stringify({ role: 'assistant', content: '一种系统编程语言。', ts: 1700000001 }) + '\n',
    'D:\\demo\\hermes\\sessions\\s2.jsonl': '{"type":"session","id":"s2","title":"My Session","cwd":"/home/u/proj"}\n{"type":"message","message":{"role":"user","content":"Hello"},"timestamp":"2026-01-01T00:00:00Z"}\n{"type":"message","message":{"role":"assistant","content":"Hi"},"timestamp":"2026-01-01T00:01:00Z"}\n',
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'hermes')
  const value = await def.execute({ path: 'D:\\demo\\hermes\\sessions' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  assert.equal(persistence.sessions.size, 2)
  // 无 session 记录的 flat JSONL → 文件 stem 兜底会话 id
  assert.ok(persistence.sessions.get('import-s1'))
  assert.ok(persistence.sessions.get('import-s2'))
})

test('import_hermes 单 .jsonl：db 之外的单会话源，mode single', async () => {
  const raw = JSON.stringify({ role: 'user', content: 'hi', ts: 1 }) + '\n' + JSON.stringify({ role: 'assistant', content: 'hello', ts: 2 }) + '\n'
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\hermes\\sessions\\s1.jsonl': raw })
  apply(ctx)
  const def = chatDef(ctx, 'hermes')
  const value = await def.execute({ path: 'D:\\demo\\hermes\\sessions\\s1.jsonl' })
  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-s1') // fileStem 兜底
  assert.equal(value.status, 'imported')
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  assert.equal(persistence.sessions.size, 1)
})

// ---- REQ-72 expectedHash（源文件强校验） ----

test('REQ-72 expectedHash: 正确哈希导入成功，错误哈希失败且不落盘', async () => {
  const raw = [
    JSON.stringify({ sessionId: 'sess-hash-001', type: 'user', cwd: 'D:\\demo\\proj', message: { role: 'user', content: '你好' } }),
    JSON.stringify({ sessionId: 'sess-hash-001', type: 'assistant', message: { role: 'assistant', content: '好的' } }),
  ].join('\n') + '\n'
  const path = 'D:\\demo\\proj\\sess-hash-001.jsonl'
  const { ctx, persistence } = makeCtx({ [path]: raw })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const hash = createHash('sha256').update(raw).digest('hex')

  const ok = await def.execute({ path, expectedHash: hash })
  assert.equal(ok.status, 'imported')
  assert.equal(persistence.sessions.size, 1)

  // 错误哈希：抛错，不产生第二个会话
  let thrown
  try {
    await def.execute({ path, expectedHash: '0'.repeat(64), force: true })
  } catch (err) {
    thrown = err
  }
  assert.ok(thrown, '错误哈希应抛错')
  assert.match(String(thrown && thrown.message), /expectedHash mismatch/)
  assert.equal(persistence.sessions.size, 1)
})

test('REQ-72 restamp: 时间戳平移到当前，保持相对间隔', () => {
  const out = { meta: { createdAt: 1000 }, events: [{ time: 1000 }, { time: 2000 }] }
  restampSession(out, { restamp: true })
  assert.ok(out.meta.createdAt > 1000, 'createdAt 被平移: ' + out.meta.createdAt)
  assert.equal(out.events[1].time - out.events[0].time, 1000, '相对间隔保持不变')
})

// ---- REQ-70 导入时 workspaceMode（dedicated） ----

test('REQ-70 import_claude workspaceMode=dedicated: 导入会话挂到专用工作区', async () => {
  const raw = [
    JSON.stringify({ sessionId: 'sess-ws-001', type: 'user', cwd: 'D:\\demo\\proj', message: { role: 'user', content: '你好' } }),
    JSON.stringify({ sessionId: 'sess-ws-001', type: 'assistant', message: { role: 'assistant', content: '好的' } }),
  ].join('\n') + '\n'
  const path = 'D:\\demo\\proj\\sess-ws-001.jsonl'
  const { ctx, attached } = makeCtx({ [path]: raw })
  apply(ctx)
  const dedicatedDir = join(mkdtempSync(join(tmpdir(), 'dsh-ws-mode-')), 'workspace')
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path, workspaceMode: 'dedicated', workspaceDir: dedicatedDir })
  assert.equal(value.status, 'imported')
  assert.ok(attached.some((a) => a.ws === dedicatedDir), '挂到 dedicated workspace: ' + JSON.stringify(attached))
})

// ---- import_kimi 集成（会话目录：wire.jsonl + state.json + kimi.json 映射） ----

// 合成 Kimi wire.jsonl：首行 metadata + 记录（timestamp 秒级递增）。
function kimiWire(recs) {
  const lines = ['{"type":"metadata","protocol_version":"1"}']
  recs.forEach((r, i) => lines.push(JSON.stringify({ timestamp: 1776162400 + i, message: r })))
  return lines.join('\n')
}
function kimiEv(type, payload = {}) { return { type, payload } }
// kimi.json workdir 目录名 = md5(path)（kaos 本地时无前缀）
const kimiHash = (p) => createHash('md5').update(p, 'utf8').digest('hex')
// 新 Kimi Code wire：每行直接是 {type, time, …}，不包 message 外壳。
function kimiCodeWire(recs, tsBase = 1786888277773) {
  const lines = [JSON.stringify({ type: 'metadata', protocol_version: '1', created_at: tsBase })]
  recs.forEach((r, i) => lines.push(JSON.stringify({ ...r, time: tsBase + i })))
  return lines.join('\n')
}
function kimiCodeEv(type, data = {}) { return { type, ...data } }

test('import_kimi 单会话目录：wire.jsonl + state.json + kimi.json 映射、落盘、归组、schema 校验', async () => {
  const workDir = 'D:/demo/kimi-proj'
  const hashDir = kimiHash(workDir)
  const sess = 'D:\\demo\\kimi\\sessions\\' + hashDir + '\\sess-001'
  const tree = {
    'D:\\demo\\kimi\\kimi.json': JSON.stringify({ work_dirs: [{ path: workDir, kaos: 'local', last_session_id: 'sess-001' }] }),
    'D:\\demo\\kimi\\sessions': 'dir',
    ['D:\\demo\\kimi\\sessions\\' + hashDir]: 'dir',
    [sess]: 'dir',
    [sess + '\\wire.jsonl']: kimiWire([
      kimiEv('TurnBegin', { user_input: '帮我看看构建失败' }),
      kimiEv('StepBegin', { n: 1 }),
      kimiEv('TextPart', { text: '是缺少依赖。' }),
      kimiEv('TurnEnd'),
    ]),
    [sess + '\\state.json']: JSON.stringify({ version: 1, custom_title: 'Kimi 会话标题' }),
  }
  const { ctx, persistence, attached } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'kimi')
  const value = await def.execute({ path: sess })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-sess-001')
  assert.equal(value.turns, 1)
  assert.equal(value.messages, 2)
  assert.equal(value.toolCalls, 0)
  assert.equal(value.alreadyImported, false)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get('import-sess-001')
  assert.ok(saved)
  assert.equal(saved.meta.cwd, workDir) // kimi.json md5 映射
  assert.equal(saved.meta.sourceId, 'sess-001')
  // 显式标题（state.json custom_title）钉 session/title 事件
  assert.equal(saved.events.at(-1).type, 'session/title')
  assert.equal(saved.events.at(-1).data.title, 'Kimi 会话标题')
  assert.ok(saved.events.every((e, i) => e.seq === i))
  // 幂等键 = 会话目录路径
  assertImportedMarker(saved.events, { tool: 'kimi', sourceId: 'sess-001', sourcePath: sess })
  assert.equal(attached.length, 1)
  assert.equal(attached[0].id, 'import-sess-001')
})

test('import_kimi 目录批量：递归扫 wire.jsonl、逐会话独立落盘、schema 校验', async () => {
  const hashDir = kimiHash('D:/demo/kimi-proj')
  const mkSession = (id) => ({
    ['D:\\demo\\kimi\\sessions\\' + hashDir + '\\' + id]: 'dir',
    ['D:\\demo\\kimi\\sessions\\' + hashDir + '\\' + id + '\\wire.jsonl']: kimiWire([
      kimiEv('TurnBegin', { user_input: '问题 ' + id }),
      kimiEv('StepBegin', { n: 1 }),
      kimiEv('TextPart', { text: '回答' }),
      kimiEv('TurnEnd'),
    ]),
    ['D:\\demo\\kimi\\sessions\\' + hashDir + '\\' + id + '\\state.json']: '{}',
  })
  const tree = {
    'D:\\demo\\kimi\\kimi.json': JSON.stringify({ work_dirs: [{ path: 'D:/demo/kimi-proj', kaos: 'local' }] }),
    'D:\\demo\\kimi\\sessions': 'dir',
    ['D:\\demo\\kimi\\sessions\\' + hashDir]: 'dir',
    ...mkSession('sess-001'),
    ...mkSession('sess-002'),
    ['D:\\demo\\kimi\\sessions\\' + hashDir + '\\notes.txt']: 'not a session',
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'kimi')
  const value = await def.execute({ path: 'D:\\demo\\kimi\\sessions' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  const ids = [...persistence.sessions.keys()].sort()
  assert.deepEqual(ids, ['import-sess-001', 'import-sess-002'])
  // kimi.json 映射的 cwd 挂进两会话
  for (const id of ids) assert.equal(persistence.sessions.get(id).meta.cwd, 'D:/demo/kimi-proj')
})

test('import_kimi 增量续写：wire.jsonl 增长 → appended 同一会话（REQ-24）', async () => {
  const hashDir = kimiHash('D:/demo/kimi-proj')
  const sess = 'D:\\demo\\kimi\\sessions\\' + hashDir + '\\sess-incr'
  const base = [
    kimiEv('TurnBegin', { user_input: '问题一' }),
    kimiEv('StepBegin', { n: 1 }),
    kimiEv('TextPart', { text: '回答一' }),
    kimiEv('TurnEnd'),
  ]
  const tree = {
    'D:\\demo\\kimi\\sessions': 'dir',
    ['D:\\demo\\kimi\\sessions\\' + hashDir]: 'dir',
    [sess]: 'dir',
    [sess + '\\wire.jsonl']: kimiWire(base),
    [sess + '\\state.json']: '{}',
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'kimi')
  const first = await def.execute({ path: sess })
  assert.equal(first.status, 'imported')
  const before = persistence.sessions.get('import-sess-incr').events.length

  tree[sess + '\\wire.jsonl'] = kimiWire([...base,
    kimiEv('TurnBegin', { user_input: '问题二' }),
    kimiEv('StepBegin', { n: 1 }),
    kimiEv('TextPart', { text: '回答二' }),
    kimiEv('TurnEnd'),
  ])
  const second = await def.execute({ path: sess })
  assert.equal(second.mode, 'single')
  assert.equal(second.status, 'appended')
  assert.equal(second.appendedTurns, 1)
  assert.ok(second.appendedEvents > 0)
  assert.equal(persistence.sessions.size, 1) // 同一会话续写
  const saved = persistence.sessions.get('import-sess-incr')
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assert.equal(saved.events.length, before + second.appendedEvents)
  assert.equal(saved.events.filter((e) => e.type === 'turn/start').length, 2)
  assert.equal(saved.events.filter((e) => e.type === 'session/title').length, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, second), [])
})

test('import_kimi 单 wire.jsonl 文件：mode single、kimiId 从父目录派生', async () => {
  const hashDir = kimiHash('D:/demo/kimi-proj')
  const wirePath = 'D:\\demo\\kimi\\sessions\\' + hashDir + '\\sess-f\\wire.jsonl'
  const tree = {
    [wirePath]: kimiWire([
      kimiEv('TurnBegin', { user_input: 'hi' }),
      kimiEv('StepBegin', { n: 1 }),
      kimiEv('TextPart', { text: 'hello' }),
      kimiEv('TurnEnd'),
    ]),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'kimi')
  const value = await def.execute({ path: wirePath })
  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-sess-f') // 父目录名作源 id
  assert.equal(value.status, 'imported')
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  assert.equal(persistence.sessions.size, 1)
})

test('import_kimi 非会话目录：批量跳过（无用户回合）', async () => {
  const tree = {
    'D:\\demo\\kimi\\sessions': 'dir',
    'D:\\demo\\kimi\\sessions\\empty-dir': 'dir',
    'D:\\demo\\kimi\\sessions\\notes.txt': 'not a session',
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'kimi')
  const value = await def.execute({ path: 'D:\\demo\\kimi\\sessions' })
  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 0)
  assert.equal(value.imported, 0)
  assert.equal(persistence.sessions.size, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('import_kimi dry-run 预览：preview 零副作用、0 skipped、清单字段', async () => {
  const hashDir = kimiHash('D:/demo/kimi-proj')
  const sess = 'D:\\demo\\kimi\\sessions\\' + hashDir + '\\sess-prev'
  const tree = {
    'D:\\demo\\kimi\\sessions': 'dir',
    ['D:\\demo\\kimi\\sessions\\' + hashDir]: 'dir',
    [sess]: 'dir',
    [sess + '\\wire.jsonl']: kimiWire([
      kimiEv('TurnBegin', { user_input: '问题' }),
      kimiEv('StepBegin', { n: 1 }),
      kimiEv('TextPart', { text: '回答' }),
      kimiEv('TurnEnd'),
    ]),
    [sess + '\\state.json']: '{}',
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'kimi')
  const value = await def.execute({ path: sess, preview: true })
  assert.equal(value.mode, 'single')
  assert.equal(value.preview, true)
  assert.equal(value.turns, 1)
  assert.equal(value.messages, 2)
  assert.equal(value.toolCalls, 0)
  assert.equal(value.skipped, 0)
  assert.equal(persistence.sessions.size, 0) // 零副作用：不落盘
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('import_kimi 新 Kimi Code 单会话目录：agents/main/wire.jsonl + state.json cwd/title', async () => {
  const sess = 'C:\\Users\\u\\.kimi-code\\sessions\\wd_nwflower_249d4b67aa09\\session-001'
  const tree = {
    'C:\\Users\\u\\.kimi-code\\sessions': 'dir',
    'C:\\Users\\u\\.kimi-code\\sessions\\wd_nwflower_249d4b67aa09': 'dir',
    [sess]: 'dir',
    [sess + '\\agents']: 'dir',
    [sess + '\\agents\\main']: 'dir',
    [sess + '\\agents\\main\\wire.jsonl']: kimiCodeWire([
      kimiCodeEv('turn.prompt', { input: [{ type: 'text', text: '帮我看看构建失败' }], origin: { kind: 'user' } }),
      kimiCodeEv('context.append_message', { message: { role: 'user', content: [{ type: 'text', text: '帮我看看构建失败' }], toolCalls: [], origin: { kind: 'user' }, id: 'msg_1' } }),
      kimiCodeEv('context.append_loop_event', { event: { type: 'step.begin', turnId: '0', step: 1 } }),
      kimiCodeEv('context.append_loop_event', { event: { type: 'content.part', part: { type: 'text', text: '是缺少依赖。' } } }),
      kimiCodeEv('context.append_loop_event', { event: { type: 'step.end', turnId: '0', step: 1, finishReason: 'end_turn' } }),
      kimiCodeEv('turn.ended', { turnId: 0, reason: 'completed' }),
    ]),
    [sess + '\\state.json']: JSON.stringify({ id: 'session-001', cwd: 'C:/Users/u/proj', title: '新 Kimi Code 标题', isCustomTitle: true }),
  }
  const { ctx, persistence, attached } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'kimi')
  const value = await def.execute({ path: sess })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-session-001')
  assert.equal(value.status, 'imported')
  assert.equal(value.turns, 1)
  assert.equal(value.messages, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get('import-session-001')
  assert.ok(saved)
  assert.equal(saved.meta.cwd, 'C:/Users/u/proj') // state.json.cwd
  assert.equal(saved.meta.sourceId, 'session-001')
  assert.equal(saved.events.at(-1).type, 'session/title')
  assert.equal(saved.events.at(-1).data.title, '新 Kimi Code 标题') // isCustomTitle:true 钉标题
  assertImportedMarker(saved.events, { tool: 'kimi', sourceId: 'session-001', sourcePath: sess })
  assert.equal(attached.length, 1)
})

test('import_kimi 新 Kimi Code 目录批量：递归扫 agents/main/wire.jsonl', async () => {
  const mkSession = (id) => {
    const sess = 'C:\\Users\\u\\.kimi-code\\sessions\\wd_nwflower_249d4b67aa09\\' + id
    return {
      [sess]: 'dir',
      [sess + '\\agents']: 'dir',
      [sess + '\\agents\\main']: 'dir',
      [sess + '\\agents\\main\\wire.jsonl']: kimiCodeWire([
        kimiCodeEv('turn.prompt', { input: [{ type: 'text', text: '问题 ' + id }], origin: { kind: 'user' } }),
        kimiCodeEv('context.append_loop_event', { event: { type: 'step.begin', turnId: '0', step: 1 } }),
        kimiCodeEv('context.append_loop_event', { event: { type: 'content.part', part: { type: 'text', text: '回答' } } }),
        kimiCodeEv('context.append_loop_event', { event: { type: 'step.end', turnId: '0', step: 1, finishReason: 'end_turn' } }),
        kimiCodeEv('turn.ended', { turnId: 0, reason: 'completed' }),
      ]),
      [sess + '\\state.json']: JSON.stringify({ id, cwd: 'C:/Users/u/proj' }),
    }
  }
  const tree = {
    'C:\\Users\\u\\.kimi-code\\sessions': 'dir',
    'C:\\Users\\u\\.kimi-code\\sessions\\wd_nwflower_249d4b67aa09': 'dir',
    ...mkSession('session-001'),
    ...mkSession('session-002'),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'kimi')
  const value = await def.execute({ path: 'C:\\Users\\u\\.kimi-code\\sessions' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  const ids = [...persistence.sessions.keys()].sort()
  assert.deepEqual(ids, ['import-session-001', 'import-session-002'])
  for (const id of ids) assert.equal(persistence.sessions.get(id).meta.cwd, 'C:/Users/u/proj')
})

// ---- REQ-24 增量续写（重导 append 新轮次 + 源路径幂等键） ----

test('REQ-24 增长 append：同一会话 seq 连续、只新增轮次、无重复标题/标记', async () => {
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const first = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(first.status, 'imported')
  assert.equal(first.turns, 2)
  const saved1 = persistence.sessions.get('import-sess-incr-001')
  const before = saved1.events.length
  const firstEvents = [...saved1.events] // 快照：mock 的 append 原地修改同一数组
  assert.equal(saved1.events.filter((e) => e.type === 'turn/start').length, 2)

  // 源文件增长（2 → 3 轮）
  tree['D:\\demo\\proj\\sess-incr-001.jsonl'] = claudeTurns(3)
  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(second.status, 'appended')
  assert.equal(second.appendedTurns, 1)
  assert.ok(second.appendedEvents > 0)
  assert.equal(second.alreadyImported, false)

  // 同一会话：seq 全连续、只多出尾部轮次
  const saved2 = persistence.sessions.get('import-sess-incr-001')
  assert.ok(saved2)
  assert.ok(saved2.events.every((e, i) => e.seq === i))
  assert.equal(saved2.events.length, before + second.appendedEvents)
  assert.equal(saved2.events.filter((e) => e.type === 'turn/start').length, 3)
  // 续写轮次：turn 续号用源编号（3），末尾 turn/end 平衡
  assert.equal(saved2.events.at(-1).type, 'turn/end')
  assert.equal(saved2.events.at(-1).data.turn, 3)
  // 不重复写 session/imported 标记与 session/title
  assert.equal(saved2.events.filter((e) => e.type === 'session/imported').length, 1)
  assert.equal(saved2.events.filter((e) => e.type === 'session/title').length, 0)
  // 已导入前缀事件未被改写
  assert.deepEqual(saved2.events.slice(0, before), firstEvents)
})

test('REQ-24 未变跳过：version/size 短路径不 readText，已存在不重复落盘', async () => {
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2) }
  const { ctx, persistence, reads } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const first = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(reads.count, 1)
  assert.equal(first.status, 'imported')
  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  // 未变：短路径跳过（不 readText），返回 already-imported
  assert.equal(second.status, 'already-imported')
  assert.equal(second.alreadyImported, true)
  assert.equal(reads.count, 1)
  assert.equal(persistence.sessions.size, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, second), [])
})

test('REQ-24 sourceShrunk：源文件轮次减少 → 跳过报告，不破坏已导入会话', async () => {
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(3) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  const before = persistence.sessions.get('import-sess-incr-001').events.length

  tree['D:\\demo\\proj\\sess-incr-001.jsonl'] = claudeTurns(2)
  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(second.status, 'already-imported')
  assert.equal(second.sourceShrunk, true)
  // 已导入会话原样（仍是 3 轮）
  const saved = persistence.sessions.get('import-sess-incr-001')
  assert.equal(saved.events.length, before)
  assert.equal(saved.events.filter((e) => e.type === 'turn/start').length, 3)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, second), [])
})

test('REQ-24 changedInPlace：轮数相等但事件增长 → 跳过（append-only 无法改写）', async () => {
  const v1 = claudeTurns(1)
  // 同轮内多一条 assistant 消息（step2）→ 事件数变多、轮数不变
  const v2 = [
    '{"sessionId":"sess-incr-001","type":"user","cwd":"D:\\\\demo\\\\proj","message":{"role":"user","content":"问题1"}}',
    '{"sessionId":"sess-incr-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"回答1"}]}}',
    '{"sessionId":"sess-incr-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"补充回答"}]}}',
  ].join('\n')
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': v1 }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  const before = persistence.sessions.get('import-sess-incr-001').events.length

  tree['D:\\demo\\proj\\sess-incr-001.jsonl'] = v2
  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(second.status, 'already-imported')
  assert.equal(second.changedInPlace, true)
  assert.equal(persistence.sessions.get('import-sess-incr-001').events.length, before)
})

test('REQ-24 force:true：新 id 完整副本，旧会话原样保留', async () => {
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  const oldEvents = persistence.sessions.get('import-sess-incr-001').events

  const forced = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl', force: true })
  assert.equal(forced.status, 'imported')
  assert.equal(forced.sessionId, 'import-sess-incr-001-1')
  assert.deepEqual(forced.forceImported, { previous: 'import-sess-incr-001', current: 'import-sess-incr-001-1' })
  // 两个会话都在：旧会话原样，新会话是完整副本（含 2 轮）
  assert.equal(persistence.sessions.size, 2)
  const copy = persistence.sessions.get('import-sess-incr-001-1')
  assert.ok(copy)
  assert.ok(copy.events.every((e, i) => e.seq === i))
  assert.equal(copy.events.filter((e) => e.type === 'turn/start').length, 2)
  assert.deepEqual(persistence.sessions.get('import-sess-incr-001').events, oldEvents)
  // registry 指向新 id；再 force 一次 → 从当前记录链式避让（import-sess-incr-001-1-1）
  const forced2 = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl', force: true })
  assert.equal(forced2.sessionId, 'import-sess-incr-001-1-1')
  assert.equal(persistence.sessions.size, 3)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, forced), [])
})

test('REQ-24 两路径共享 sessionId：都导入、后缀避让、互不覆盖', async () => {
  // Claude 主 transcript 命名 = <sessionId>.jsonl；两个不同目录的同名文件共享同一源 sessionId
  const tree = {
    'D:\\demo\\proj\\a\\shared-session.jsonl': claudeTurns(1, 'shared-session'),
    'D:\\demo\\proj\\b\\shared-session.jsonl': [
      '{"sessionId":"shared-session","type":"user","message":{"role":"user","content":"另一个文件的问题"}}',
      '{"sessionId":"shared-session","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"另一个文件的回答"}]}}',
    ].join('\n'),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const ra = await def.execute({ path: 'D:\\demo\\proj\\a\\shared-session.jsonl' })
  const rb = await def.execute({ path: 'D:\\demo\\proj\\b\\shared-session.jsonl' })
  assert.equal(ra.status, 'imported')
  assert.equal(ra.sessionId, 'import-shared-session')
  // 第二个文件目标 id 被占用 → 后缀避让，不覆盖第一个文件的内容
  assert.equal(rb.status, 'imported')
  assert.equal(rb.sessionId, 'import-shared-session-1')
  assert.equal(persistence.sessions.size, 2)
  const a = persistence.sessions.get('import-shared-session')
  const b = persistence.sessions.get('import-shared-session-1')
  assert.ok(a.events.some((e) => e.type === 'user/message' && e.data.content[0].text.includes('问题')))
  assert.ok(b.events.some((e) => e.type === 'user/message' && e.data.content[0].text.includes('另一个文件')))
  // 两个路径各自有 registry 记录，重导各自幂等（不互相串扰）
  const rb2 = await def.execute({ path: 'D:\\demo\\proj\\b\\shared-session.jsonl' })
  assert.equal(rb2.status, 'already-imported')
  assert.equal(persistence.sessions.size, 2)
})

test('REQ-24 legacy 回填：registry 丢失但会话在 → already-imported + 回填基线', async () => {
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(persistence.sessions.size, 1)

  // 模拟 registry 丢失（旧版本无 registry）：清空 imports.json
  const regFile = join(resolveRegistryDir(), 'imports.json')
  mkdirSync(dirname(regFile), { recursive: true })
  writeFileSync(regFile, '{ "version": 1, "imports": {} }')

  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(second.status, 'already-imported')
  assert.equal(second.backfilled, true)
  assert.equal(persistence.sessions.size, 1) // 不重复落盘
  // 回填后 registry 有该路径的基线记录；再导（未变）走短路径跳过
  const reg = await loadImports(resolveRegistryDir())
  const rec = reg.imports['D:\\demo\\proj\\sess-incr-001.jsonl']
  assert.ok(rec)
  assert.equal(rec.kind, 'single')
  assert.equal(rec.dshId, 'import-sess-incr-001')
  assert.equal(rec.turns, 2)
  const third = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(third.status, 'already-imported')
})

test('REQ-24 用户 DSH 续聊后 append：fromSeq 取 inspect 权威游标，seq 接在用户事件后', async () => {
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  const saved1 = persistence.sessions.get('import-sess-incr-001')
  const base = saved1.events.length

  // 用户在 DSH 里继续聊了 2 条消息（会话日志增长，registry 记录过期）
  const chat = [
    { type: 'user/message', seq: base, time: Date.now(), surfaceOp: 'append', data: { id: 'live:u1', role: 'user', content: [{ type: 'text', text: 'DSH 里继续问' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: base + 1, time: Date.now(), surfaceOp: 'append', data: { id: 'live:a1', role: 'assistant', content: [{ type: 'text', text: 'DSH 里继续答' }], source: { kind: 'model', provider: 'dsh' } } },
  ]
  await persistence.append('import-sess-incr-001', chat)

  tree['D:\\demo\\proj\\sess-incr-001.jsonl'] = claudeTurns(3)
  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(second.status, 'appended')
  const saved2 = persistence.sessions.get('import-sess-incr-001')
  assert.ok(saved2.events.every((e, i) => e.seq === i))
  // 用户事件原样保留；续写从 base+2 开始
  assert.equal(saved2.events[base].data.id, 'live:u1')
  assert.equal(saved2.events[base + 1].data.id, 'live:a1')
  assert.ok(saved2.events[base + 2].seq >= base + 2)
  assert.equal(saved2.events.at(-1).type, 'turn/end')
  assert.equal(saved2.events.at(-1).data.turn, 3)
  assert.equal(saved2.events.filter((e) => e.type === 'turn/start').length, 3)
})

test('REQ-24 显式 sessionId 变更：以新 id 建完整副本（force 副本语义），旧会话原样', async () => {
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const first = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl', sessionId: 'custom-a' })
  assert.equal(first.sessionId, 'custom-a')

  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl', sessionId: 'custom-b' })
  assert.equal(second.status, 'imported')
  assert.equal(second.sessionId, 'custom-b')
  assert.deepEqual(second.forceImported, { previous: 'custom-a', current: 'custom-b' })
  assert.equal(persistence.sessions.size, 2)
  assert.ok(persistence.sessions.get('custom-a'))
  assert.ok(persistence.sessions.get('custom-b'))
  // registry 指向新 id
  const reg = await loadImports(resolveRegistryDir())
  assert.equal(reg.imports['D:\\demo\\proj\\sess-incr-001.jsonl'].dshId, 'custom-b')
})

test('REQ-24 损坏 registry 容错：按空 registry 处理并继续导入', async () => {
  const regFile = join(resolveRegistryDir(), 'imports.json')
  mkdirSync(dirname(regFile), { recursive: true })
  writeFileSync(regFile, 'not json {{{')
  const tree = { 'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(value.status, 'imported')
  assert.equal(persistence.sessions.size, 1)
  // 导入后 registry 被重建为合法内容
  const reg = await loadImports(resolveRegistryDir())
  assert.ok(reg.imports['D:\\demo\\proj\\sess-incr-001.jsonl'])
})

test('REQ-24 batch 汇总：目录内单文件增长 → appended 计数与结果 status', async () => {
  const tree = {
    'D:\\demo\\proj': 'dir',
    'D:\\demo\\proj\\sess-incr-001.jsonl': claudeTurns(2),
    'D:\\demo\\proj\\sess-static-001.jsonl': claudeTurns(1, 'sess-static-001'),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const first = await def.execute({ path: 'D:\\demo\\proj' })
  assert.equal(first.imported, 2)
  assert.equal(first.appended, 0)

  tree['D:\\demo\\proj\\sess-incr-001.jsonl'] = claudeTurns(3)
  const second = await def.execute({ path: 'D:\\demo\\proj' })
  assert.equal(second.mode, 'batch')
  assert.equal(second.appended, 1)
  assert.equal(second.alreadyImported, 1) // sess-static 未变短路径跳过
  assert.equal(second.imported, 0)
  const appendedResult = second.results.find((r) => r.status === 'appended')
  assert.ok(appendedResult)
  assert.equal(appendedResult.sessionId, 'import-sess-incr-001')
  assert.equal(appendedResult.appendedTurns, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, second), [])
  assert.equal(persistence.sessions.get('import-sess-incr-001').events.filter((e) => e.type === 'turn/start').length, 3)
})

test('REQ-24 ChatGPT 多会话：逐会话增长 append / 新增 / 消失 missingFromSource', async () => {
  const v1 = JSON.stringify([
    chatgptConversation('conv-001', 'Alpha', ['问题A']),
    chatgptConversation('conv-002', 'Beta', ['问题B']),
  ])
  const v2 = JSON.stringify([
    chatgptConversation('conv-001', 'Alpha', ['问题A', '问题A2']), // 增长
    chatgptConversation('conv-003', 'Gamma', ['问题C']), // 新增
  ]) // conv-002 消失
  const tree = { 'D:\\demo\\chatgpt\\conversations.json': v1 }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'chatgpt')
  const first = await def.execute({ path: 'D:\\demo\\chatgpt\\conversations.json' })
  assert.equal(first.imported, 2)
  assert.equal(persistence.sessions.size, 2)
  const conv1Before = persistence.sessions.get('import-conv-001').events.length

  tree['D:\\demo\\chatgpt\\conversations.json'] = v2
  const second = await def.execute({ path: 'D:\\demo\\chatgpt\\conversations.json' })
  assert.equal(second.mode, 'batch')
  assert.equal(second.appended, 1) // conv-001 增长
  assert.equal(second.imported, 1) // conv-003 新增
  assert.deepEqual(second.missingFromSource, ['conv-002'])
  const appended = second.results.find((r) => r.status === 'appended')
  assert.ok(appended)
  assert.equal(appended.sessionId, 'import-conv-001')
  assert.equal(appended.appendedTurns, 1)
  const conv1 = persistence.sessions.get('import-conv-001')
  assert.ok(conv1.events.every((e, i) => e.seq === i))
  assert.equal(conv1.events.length, conv1Before + appended.appendedEvents)
  assert.equal(conv1.events.filter((e) => e.type === 'turn/start').length, 2)
  assert.ok(persistence.sessions.get('import-conv-003'))
  assert.ok(persistence.sessions.get('import-conv-002')) // 消失的会话原样保留
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, second), [])
})

test('REQ-24 opencode DB 增长 append：同库新增轮次续写同一会话', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'opencode')
  const first = await def.execute({ path: dbPath })
  assert.equal(first.imported, 2)
  const before = persistence.sessions.get('import-ses-a').events.length

  // 库增长：ses-a 追加一轮
  addOpencodeTurn(dbPath, 'ses-a', 'msg-a3', '继续追问', '追加回答', 1786000000100)
  const second = await def.execute({ path: dbPath })
  assert.equal(second.mode, 'batch')
  assert.equal(second.appended, 1)
  assert.equal(second.alreadyImported, 1) // ses-b 未变
  const appended = second.results.find((r) => r.status === 'appended')
  assert.ok(appended)
  assert.equal(appended.sessionId, 'import-ses-a')
  const sesA = persistence.sessions.get('import-ses-a')
  assert.ok(sesA.events.every((e, i) => e.seq === i))
  assert.equal(sesA.events.length, before + appended.appendedEvents)
  assert.equal(sesA.events.filter((e) => e.type === 'turn/start').length, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, second), [])
})

test('REQ-24 opencode 消息删除（turns 变少）→ sourceShrunk 跳过', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  addOpencodeTurn(dbPath, 'ses-a', 'msg-a3', '继续追问', '追加回答', 1786000000100)
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'opencode')
  await def.execute({ path: dbPath })
  const before = persistence.sessions.get('import-ses-a').events.length

  // 删除追加的一轮 → ses-a 轮次变少
  deleteOpencodeMessages(dbPath, ['msg-a3-u', 'msg-a3-a'])
  const second = await def.execute({ path: dbPath })
  const shrunk = second.results.find((r) => r.sessionId === 'import-ses-a')
  assert.ok(shrunk)
  assert.equal(shrunk.status, 'already-imported')
  assert.equal(shrunk.sourceShrunk, true)
  assert.equal(persistence.sessions.get('import-ses-a').events.length, before)
})

test('REQ-24 opencode fullHistory 入 args 指纹：参数变化 → args-changed 跳过', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'opencode')
  await def.execute({ path: dbPath }) // 默认（尊重压缩）
  const second = await def.execute({ path: dbPath, fullHistory: true })
  assert.equal(second.mode, 'batch')
  assert.equal(second.alreadyImported, 2)
  assert.equal(second.imported, 0)
  assert.equal(second.appended, 0)
  assert.ok(second.results.every((r) => r.argsChanged === true))
  assert.equal(persistence.sessions.size, 2) // 未新增副本
  // force:true 可换新参数导入（副本）
  const forced = await def.execute({ path: dbPath, fullHistory: true, force: true })
  assert.equal(forced.imported, 2)
  assert.equal(persistence.sessions.size, 4)
})

test('REQ-24 opencode 未变 DB：短路径跳过（version/size 不变）', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'opencode')
  await def.execute({ path: dbPath })
  const second = await def.execute({ path: dbPath })
  assert.equal(second.imported, 0)
  assert.equal(second.alreadyImported, 2)
  assert.equal(persistence.sessions.size, 2)
})

// ---- export_claude 集成（REQ-16 反向导出） ----

// 直接在 mock persistence 里 seed 合成会话（精确控制事件形状，绕过导入转换）。
async function seedSession(persistence, id, meta, events) {
  await persistence.create(meta)
  await persistence.append(id, events)
}

// 合成 DSH 事件（形状对齐真实日志：surface 事件带 surfaceOp:'append'）。
function mkEvent(type, seq, time, data, extra = {}) {
  return { type, seq, time, data, ...extra }
}

const OUT = join('C:', 'Users', 'test', '.claude', 'projects') // 跨平台 join，避免分隔符断言

test('export_claude 落盘：import → export 闭环、路径 <outputDir>/<slug>/<uuid>.jsonl、schema 校验', async () => {
  const tree = { 'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl') }
  const { ctx, persistence, writes } = makeCtx(tree)
  apply(ctx)
  await chatDef(ctx, 'claude').execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(persistence.sessions.size, 1)

  const def = exportDef(ctx, 'claude')
  const value = await def.execute({ sessionId: 'import-sess-simple-001', outputDir: OUT })

  assert.equal(value.mode, 'single')
  assert.equal(value.sourceSessionId, 'import-sess-simple-001')
  assert.equal(value.slug, 'D--demo-proj') // D:\demo\proj → ':'、'\'、'\' 各一个 '-'
  assert.equal(value.cwd, 'D:\\demo\\proj')
  assert.match(value.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(value.recordCount, 4) // mode + permission-mode + user + assistant（环境变更声明被跳过）
  assert.equal(value.mapping.turns, 1)
  assert.equal(value.mapping.messages, 3) // 环境变更声明 + user + assistant（原样计数，导出时跳过）
  assert.equal(value.mapping.toolCalls, 0)
  assert.equal(value.mapping.toolResults, 0)
  assert.equal(value.dryRun, false)
  assert.equal(value.filePath, join(OUT, 'D--demo-proj', value.sessionId + '.jsonl'))
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  // 落盘：createIfAbsent + 内容可解析、布局正确（每行一记录、恰一个结尾换行）
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, value.filePath)
  assert.equal(writes[0].options.kind, 'createIfAbsent')
  const body = writes[0].content.slice(0, -1)
  assert.equal(writes[0].content.endsWith('\n'), true)
  const lines = body.split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 4)
  assert.equal(lines[0].type, 'mode')
  const pm = lines[1]
  assert.deepEqual(Object.keys(pm).sort(), ['permissionMode', 'sessionId', 'type'])
  const user = lines[2]
  assert.equal(user.type, 'user')
  assert.equal(user.parentUuid, null)
  assert.equal(typeof user.message.content, 'string')
  assert.equal(user.cwd, 'D:\\demo\\proj')
  const asst = lines[3]
  assert.equal(asst.type, 'assistant')
  assert.equal(asst.parentUuid, user.uuid)
  assert.equal(asst.message.stop_reason, 'end_turn')
})

test('export_claude 带标题会话：ai-title 放首个 user 后、assistant 前；返回 title', async () => {
  const tree = { 'D:\\demo\\proj\\sess-title-001.jsonl': load('sess-title-001.jsonl') }
  const { ctx, writes } = makeCtx(tree)
  apply(ctx)
  await chatDef(ctx, 'claude').execute({ path: 'D:\\demo\\proj\\sess-title-001.jsonl' })

  const def = exportDef(ctx, 'claude')
  const value = await def.execute({ sessionId: 'import-sess-title-001', outputDir: OUT })
  assert.equal(value.recordCount, 5) // mode + permission-mode + user + ai-title + assistant
  assert.equal(typeof value.title, 'string')
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const lines = writes[0].content.slice(0, -1).split('\n').map((l) => JSON.parse(l))
  const user = lines[2]
  const ai = lines[3]
  assert.equal(ai.type, 'ai-title')
  assert.equal(ai.aiTitle, value.title)
  assert.equal(Object.hasOwn(ai, 'uuid'), false)
  assert.equal(Object.hasOwn(ai, 'parentUuid'), false)
  assert.equal(lines[4].parentUuid, user.uuid) // assistant 链越过 ai-title
})

test('export_claude 工具会话：tool_use/tool_result 配对、sourceToolAssistantUUID、stop_reason', async () => {
  const tree = { 'D:\\demo\\proj\\sess-tool-001.jsonl': load('sess-tool-001.jsonl') }
  const { ctx, writes } = makeCtx(tree)
  apply(ctx)
  await chatDef(ctx, 'claude').execute({ path: 'D:\\demo\\proj\\sess-tool-001.jsonl' })

  const def = exportDef(ctx, 'claude')
  const value = await def.execute({ sessionId: 'import-sess-tool-001', outputDir: OUT })
  assert.equal(value.recordCount, 6) // mode + permission-mode + user + assistant + tool_result + assistant
  assert.equal(value.mapping.toolCalls, 1)
  assert.equal(value.mapping.toolResults, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const lines = writes[0].content.slice(0, -1).split('\n').map((l) => JSON.parse(l))
  const asst1 = lines[3]
  const thinking = asst1.message.content.find((b) => b.type === 'thinking')
  assert.deepEqual(thinking, { type: 'thinking', thinking: thinking.thinking, signature: '' })
  const toolUse = asst1.message.content.find((b) => b.type === 'tool_use')
  assert.ok(toolUse)
  assert.equal(toolUse.name, 'Bash')
  assert.deepEqual(toolUse.input, { command: 'ls -la' })
  assert.equal(asst1.message.stop_reason, 'tool_use')

  const tr = lines[4]
  assert.equal(tr.type, 'user')
  assert.equal(tr.parentUuid, asst1.uuid)
  assert.equal(tr.sourceToolAssistantUUID, asst1.uuid)
  assert.equal(tr.message.content[0].type, 'tool_result')
  assert.equal(tr.message.content[0].tool_use_id, 'toolu_01')
  assert.equal(tr.message.content[0].content, 'README.md\nsrc\n')
  assert.equal(Object.hasOwn(tr.message.content[0], 'is_error'), false) // fixture is_error:false → 不写
  assert.equal(lines[5].message.stop_reason, 'end_turn')
})

test('export_claude dryRun：不写盘、返回目标路径与统计', async () => {
  const tree = { 'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl') }
  const { ctx, writes } = makeCtx(tree)
  apply(ctx)
  await chatDef(ctx, 'claude').execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })

  const def = exportDef(ctx, 'claude')
  const value = await def.execute({ sessionId: 'import-sess-simple-001', outputDir: OUT, dryRun: true })
  assert.equal(value.dryRun, true)
  assert.equal(writes.length, 0) // 不写盘
  assert.equal(typeof value.filePath, 'string')
  assert.equal(value.recordCount, 4)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('export_claude cwd 覆盖：slug/记录 cwd 用入参而非 header', async () => {
  const tree = { 'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl') }
  const { ctx, writes } = makeCtx(tree)
  apply(ctx)
  await chatDef(ctx, 'claude').execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })

  const value = await exportDef(ctx, 'claude').execute({
    sessionId: 'import-sess-simple-001',
    outputDir: OUT,
    cwd: "C:\\Users\\Meier's\\work", // 含非字母数字：验证 slug 替换
  })
  assert.equal(value.cwd, "C:\\Users\\Meier's\\work")
  assert.equal(value.slug, 'C--Users-Meier-s-work')
  assert.equal(value.filePath, join(OUT, 'C--Users-Meier-s-work', value.sessionId + '.jsonl'))
  const lines = writes[0].content.slice(0, -1).split('\n').map((l) => JSON.parse(l))
  assert.equal(lines[2].cwd, "C:\\Users\\Meier's\\work")
})

test('export_claude 会话不存在：抛错', async () => {
  const { ctx } = makeCtx({})
  apply(ctx)
  const def = exportDef(ctx, 'claude')
  await assert.rejects(() => def.execute({ sessionId: 'no-such-session' }), /会话不存在/)
})

test('export_claude 无 cwd（header 无且未提供）：抛错', async () => {
  const { ctx, persistence } = makeCtx({})
  await seedSession(persistence, 'sess-nocwd', { version: 0, id: 'sess-nocwd', createdAt: 1786000000000 }, [
    mkEvent('user/message', 0, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    mkEvent('assistant/message', 1, 1786000000000, { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'hello' }], source: { kind: 'model', provider: 'dsh' } }, { surfaceOp: 'append' }),
  ])
  apply(ctx)
  const def = exportDef(ctx, 'claude')
  await assert.rejects(() => def.execute({ sessionId: 'sess-nocwd' }), /cwd/)
})

test('export_claude createIfAbsent：目标已存在（uuid 碰撞模拟）时不覆盖', async () => {
  const tree = { 'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl') }
  const { ctx } = makeCtx(tree)
  apply(ctx)
  await chatDef(ctx, 'claude').execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })

  const fixed = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const target = join(OUT, 'D--demo-proj', fixed + '.jsonl')
  tree[target] = 'preexisting' // 目标文件已存在
  await assert.rejects(
    () => exportClaudeSession(ctx, { sessionId: 'import-sess-simple-001', outputDir: OUT }, { uuid: () => fixed }),
    /EEXIST/,
  )
  assert.equal(tree[target], 'preexisting') // 未被覆盖
})

test('export_claude 注入会话：非人类 user/message 跳过并计数', async () => {
  const { ctx, persistence, writes } = makeCtx({})
  await seedSession(persistence, 'sess-inject', { version: 0, id: 'sess-inject', createdAt: 1786000000000, cwd: 'D:\\demo\\proj' }, [
    mkEvent('user/message', 0, 1786000000000, { id: 'i1', role: 'user', content: [{ type: 'text', text: '系统注入' }], source: { kind: 'system' } }, { surfaceOp: 'append' }),
    mkEvent('user/message', 1, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: '真实提问' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    mkEvent('assistant/message', 2, 1786000000000, { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '回答' }], source: { kind: 'model', provider: 'dsh' } }, { surfaceOp: 'append' }),
  ])
  apply(ctx)
  const def = exportDef(ctx, 'claude')
  const value = await def.execute({ sessionId: 'sess-inject', outputDir: OUT })
  assert.equal(value.mapping.skippedInjections, 1)
  assert.equal(value.recordCount, 4) // 注入不落记录
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  const lines = writes[0].content.slice(0, -1).split('\n').map((l) => JSON.parse(l))
  assert.equal(lines[2].message.content, '真实提问')
  assert.equal(lines[2].parentUuid, null) // 首个真实 user 成为链头
})

test('REQ-21 export_claude 降级报告：附件块跳过 + 注入跳过逐条列出（不静默）', async () => {
  const { ctx, persistence, writes } = makeCtx({})
  await seedSession(persistence, 'sess-degrade', { version: 0, id: 'sess-degrade', createdAt: 1786000000000, cwd: 'D:\\demo\\proj' }, [
    mkEvent('user/message', 0, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: '看图' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    mkEvent('assistant/message', 1, 1786000000000, { id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: '这是图' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] }, source: { kind: 'model', provider: 'dsh' } }, { surfaceOp: 'append' }),
  ])
  apply(ctx)
  const def = exportDef(ctx, 'claude')
  const value = await def.execute({ sessionId: 'sess-degrade', outputDir: OUT })
  // image 块无法表达 → attachment-skipped 1 条；无注入/孤儿结果
  assert.deepEqual(value.degradations, [{ id: 'attachment-skipped', kind: 'attachmentSkipped', strategy: 'skip-placeholder', count: 1 }])
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  const line = writes[0].content.slice(0, -1).split('\n').map((l) => JSON.parse(l))[3]
  assert.deepEqual(line.message.content, [{ type: 'text', text: '这是图' }]) // 图片块被跳过
})

test('export_claude 中断会话：末尾补发空 tool_result，会话日志只读不被触碰', async () => {
  const { ctx, persistence, writes } = makeCtx({})
  const events = [
    mkEvent('user/message', 0, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: '提问' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    mkEvent('assistant/message', 1, 1786000000000, { turn: 1, step: 1, id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 'callZ', name: 'Bash', arguments: '{}' }], source: { kind: 'model', provider: 'dsh' } }, { surfaceOp: 'append' }),
    mkEvent('tool/call', 2, 1786000000000, { turn: 1, step: 1, callId: 'callZ', name: 'Bash', arguments: '{}' }),
  ]
  await seedSession(persistence, 'sess-interrupted', { version: 0, id: 'sess-interrupted', createdAt: 1786000000000, cwd: 'D:\\demo\\proj' }, events)
  apply(ctx)
  const def = exportDef(ctx, 'claude')
  const value = await def.execute({ sessionId: 'sess-interrupted', outputDir: OUT })
  assert.equal(value.recordCount, 5) // 末尾补发 1 条
  assert.equal(value.mapping.toolResults, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const lines = writes[0].content.slice(0, -1).split('\n').map((l) => JSON.parse(l))
  const last = lines[4]
  assert.equal(last.message.content[0].type, 'tool_result')
  assert.deepEqual(last.message.content[0].content, [])
  assert.equal(last.parentUuid, lines[3].uuid)
  // 会话日志未被触碰（只读来源）
  const saved = persistence.sessions.get('sess-interrupted')
  assert.equal(saved.events.length, events.length)
  assert.equal(saved.events.filter((e) => e.type === 'tool/result').length, 0)
})

// ---- REQ-56/62 export_bundle / restore_bundle（interchange bundle 备份/便携） ----

test('REQ-56 bundle 闭环：export_bundle 落盘 → restore_bundle 还原 0 skipped、schema 校验、幂等', async () => {
  const { ctx, persistence, writes } = makeCtx({})
  await seedSession(persistence, 'sess-bundle-001', { version: 0, id: 'sess-bundle-001', createdAt: 1786000000000, cwd: 'D:\\demo\\proj' }, [
    mkEvent('turn/start', 0, 1786000000000, { turn: 1 }),
    mkEvent('user/message', 1, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    mkEvent('assistant/message', 2, 1786000000000, { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '你好！' }], source: { kind: 'model', provider: 'dsh' } } }, { surfaceOp: 'append' }),
    mkEvent('turn/end', 3, 1786000000000, { turn: 1, reason: { kind: 'completed' } }),
  ])
  apply(ctx)
  const exp = registeredDef(ctx, 'export_bundle')
  const bundlePath = join('C:', 'Users', 'test', 'exports', 'sess-bundle-001.dshbundle.json')
  const value = await exp.execute({ sessionId: 'sess-bundle-001', path: bundlePath })
  assert.equal(value.mode, 'single')
  assert.equal(value.eventCount, 4)
  assert.match(value.sha256.session, /^[0-9a-f]{64}$/)
  assert.match(value.sha256.bundle, /^[0-9a-f]{64}$/)
  assert.deepEqual(validateJsonSchemaValue(exp.output.schema, value), [])
  assert.equal(writes[0].path, bundlePath)
  assert.equal(writes[0].options.kind, 'createIfAbsent')

  // 还原（bundle 在 mock 树里）；同机语义需要 originalCwd 在 fs 树中可达
  const tree2 = { [bundlePath]: writes[0].content, 'D:\\demo\\proj': 'dir' }
  const { ctx: ctx2, persistence: p2 } = makeCtx(tree2)
  apply(ctx2)
  const rst = registeredDef(ctx2, 'restore_bundle')
  const restored = await rst.execute({ path: bundlePath })
  assert.equal(restored.mode, 'single')
  assert.equal(restored.status, 'imported')
  assert.equal(restored.skipped, 0)
  assert.equal(restored.turns, 1)
  assert.equal(restored.messages, 2)
  assert.equal(restored.sourceSessionId, 'sess-bundle-001')
  assert.equal(restored.originalCwd, 'D:\\demo\\proj')
  assert.equal(restored.cwdAvailable, true) // 同机：原 cwd 可达
  assert.deepEqual(validateJsonSchemaValue(rst.output.schema, restored), [])
  const saved = p2.sessions.get(restored.sessionId)
  assert.ok(saved)
  assert.equal(saved.events.at(-1).type, 'turn/end')
  // 幂等：重复还原 already-imported
  const again = await rst.execute({ path: bundlePath })
  assert.equal(again.status, 'already-imported')
  assert.equal(p2.sessions.size, 1)
})

test('REQ-62 跨机器还原：originalCwd 不可达 → cwdAvailable:false + 回退归组 + restoreNote（不静默）', async () => {
  // A 机导出 bundle（cwd = A 机路径，B 机不存在——用确定不存在的目录名保证 stat 失败）
  const A_CWD = 'D:\\__machine_a_nonexistent_9f3k__\\work'
  const { ctx, writes } = makeCtx({})
  await seedSession(ctx.sessionPersistence, 'sess-machine-a', { version: 0, id: 'sess-machine-a', createdAt: 1786000000000, cwd: A_CWD }, [
    mkEvent('user/message', 0, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    mkEvent('assistant/message', 1, 1786000000000, { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model', provider: 'dsh' } } }, { surfaceOp: 'append' }),
  ])
  apply(ctx)
  const exp = registeredDef(ctx, 'export_bundle')
  const bundlePath = join('C:', 'Users', 'b', 'incoming', 'sess-machine-a.dshbundle.json')
  await exp.execute({ sessionId: 'sess-machine-a', path: bundlePath })
  const bundleContent = writes[0].content

  // B 机：bundle 文件在（原 cwd D:\machine-a\work 不存在），还原
  const treeB = { [bundlePath]: bundleContent }
  const { ctx: ctxB, persistence: pB, attached } = makeCtx(treeB)
  apply(ctxB)
  const rst = registeredDef(ctxB, 'restore_bundle')
  const restored = await rst.execute({ path: bundlePath })
  assert.equal(restored.status, 'imported')
  assert.equal(restored.skipped, 0)
  assert.equal(restored.cwdAvailable, false)
  assert.equal(restored.originalCwd, A_CWD)
  assert.equal(restored.landingHint, 'work')
  assert.equal(restored.groupedTo, dirname(bundlePath)) // REQ-39-lite 回退归组到 bundle 目录
  assert.match(restored.restoreNote, /原 cwd 不可达/)
  assert.deepEqual(validateJsonSchemaValue(rst.output.schema, restored), [])
  // 会话确实落盘（mock workspaceRegistry 对不存在的 cwd 也会虚拟创建，故只断言
  // 归组发生过一次；真实 host resolveByPath 失败 → REQ-39-lite 回退到 bundle 目录，
  // 该落点由 groupedTo 报告契约保证）
  assert.equal(attached.length, 1)
  assert.ok(pB.sessions.has(restored.sessionId))
})

test('REQ-56 损坏检测：bundle 被篡改（log 改动）→ restore_bundle 大声失败不还原', async () => {
  const { ctx, writes } = makeCtx({})
  await seedSession(ctx.sessionPersistence, 'sess-tamper', { version: 0, id: 'sess-tamper', createdAt: 1786000000000, cwd: 'D:\\demo\\proj' }, [
    mkEvent('user/message', 0, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
  ])
  apply(ctx)
  await registeredDef(ctx, 'export_bundle').execute({ sessionId: 'sess-tamper', path: 'C:\\tmp\\tamper.dshbundle.json' })
  const doc = JSON.parse(writes[0].content)
  doc.log = doc.log.replace('hi', '被篡改') // 不重算指纹
  const { ctx: ctx2, persistence: p2 } = makeCtx({ 'C:\\tmp\\tamper.dshbundle.json': JSON.stringify(doc) })
  apply(ctx2)
  const rst = registeredDef(ctx2, 'restore_bundle')
  await assert.rejects(() => rst.execute({ path: 'C:\\tmp\\tamper.dshbundle.json' }), /bundle 校验失败/)
  assert.equal(p2.sessions.size, 0)
  // 预览分支同样报跳过原因（不抛错）
  const preview = await rst.execute({ path: 'C:\\tmp\\tamper.dshbundle.json', preview: true })
  assert.equal(preview.preview, true)
  assert.equal(preview.skipped, 1)
  assert.match(preview.skipReason, /bundle 校验失败/)
})

test('REQ-56 restore_bundle 目录模式：递归收集 .dshbundle.json 逐文件还原', async () => {
  const { ctx, writes } = makeCtx({})
  await seedSession(ctx.sessionPersistence, 'sess-dir-001', { version: 0, id: 'sess-dir-001', createdAt: 1786000000000, cwd: 'D:\\demo\\proj' }, [
    mkEvent('user/message', 0, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    mkEvent('assistant/message', 1, 1786000000000, { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model', provider: 'dsh' } } }, { surfaceOp: 'append' }),
  ])
  apply(ctx)
  const exp = registeredDef(ctx, 'export_bundle')
  const dir = 'C:\\backups'
  await exp.execute({ sessionId: 'sess-dir-001', path: dir + '\\sess-dir-001.dshbundle.json' })
  await exp.execute({ sessionId: 'sess-dir-001', path: dir + '\\sub\\sess-dir-001-copy.dshbundle.json', cwd: 'D:\\other' })

  const { ctx: ctx2, persistence: p2 } = makeCtx({
    [dir]: 'dir',
    [dir + '\\sess-dir-001.dshbundle.json']: writes[0].content,
    [dir + '\\sub']: 'dir',
    [dir + '\\sub\\sess-dir-001-copy.dshbundle.json']: writes[1].content,
    [dir + '\\notes.txt']: 'not a bundle',
  })
  apply(ctx2)
  const rst = registeredDef(ctx2, 'restore_bundle')
  const value = await rst.execute({ path: dir })
  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.deepEqual(validateJsonSchemaValue(rst.output.schema, value), [])
  assert.equal(p2.sessions.size, 2)
})

// ---- REQ-23 矩阵化互转 + verify_session ----

test('REQ-23 export_codex / export_kimi：落盘 + 可再导入 + 降级报告 + schema', async () => {
  const { ctx, writes } = makeCtx({})
  await seedSession(ctx.sessionPersistence, 'sess-matrix-001', { version: 0, id: 'sess-matrix-001', createdAt: 1786000000000, cwd: 'D:\\demo\\proj' }, [
    mkEvent('turn/start', 0, 1786000000000, { turn: 1 }),
    mkEvent('user/message', 1, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: '跑测试' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    mkEvent('assistant/message', 2, 1786000000000, { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '好' }, { type: 'tool-call', id: 'c1', name: 'Bash', arguments: '{"command":"npm test"}' }], source: { kind: 'model', provider: 'dsh' } } }, { surfaceOp: 'append' }),
    mkEvent('tool/call', 3, 1786000000000, { turn: 1, step: 1, callId: 'c1', name: 'Bash', arguments: '{"command":"npm test"}' }),
    mkEvent('tool/result', 4, 1786000000000, { turn: 1, step: 1, message: { id: 't1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'all green' }] }], source: { kind: 'tool', callId: 'c1' } } }, { surfaceOp: 'append' }),
    mkEvent('turn/end', 5, 1786000000000, { turn: 1, reason: { kind: 'completed' } }),
  ])
  apply(ctx)
  const codexDef = exportDef(ctx, 'codex')
  const cwdPath = 'C:\\exports\\x.rollout.jsonl'
  const codexOut = await codexDef.execute({ sessionId: 'sess-matrix-001', path: cwdPath })
  assert.equal(codexOut.recordCount, 5) // session_meta + user + assistant + function_call + function_call_output
  assert.equal(codexOut.toolCalls, 1)
  assert.equal(codexOut.toolResults, 1)
  assert.deepEqual(validateJsonSchemaValue(codexDef.output.schema, codexOut), [])

  const kimiDef = exportDef(ctx, 'kimi')
  const kimiPath = 'C:\\exports\\y.wire.jsonl'
  const kimiOut = await kimiDef.execute({ sessionId: 'sess-matrix-001', path: kimiPath })
  assert.equal(kimiOut.recordCount, 7) // metadata + TurnBegin + StepBegin + TextPart + ToolCall + ToolResult + TurnEnd
  assert.equal(kimiOut.toolCalls, 1)
  assert.deepEqual(validateJsonSchemaValue(kimiDef.output.schema, kimiOut), [])

  // 双向闭环：导出文件再经对应 import_* 导入（新 ctx 模拟另一侧）
  const { ctx: ctx2, persistence: p2 } = makeCtx({ [cwdPath]: writes[0].content, [kimiPath]: writes[1].content })
  apply(ctx2)
  const impCodex = chatDef(ctx2, 'codex')
  const codexBack = await impCodex.execute({ path: cwdPath })
  assert.equal(codexBack.mode, 'single')
  assert.equal(codexBack.status, 'imported')
  assert.equal(codexBack.toolCalls, 1)
  const impKimi = chatDef(ctx2, 'kimi')
  const kimiBack = await impKimi.execute({ path: kimiPath })
  assert.equal(kimiBack.mode, 'single')
  assert.equal(kimiBack.status, 'imported')
  assert.equal(kimiBack.toolCalls, 1)
  assert.equal(p2.sessions.size, 2)
})

test('REQ-23 verify_session：平衡会话 ok、不平衡会话定位问题 + repair 提示（只读）', async () => {
  const { ctx, persistence } = makeCtx({})
  // 平衡会话
  await seedSession(persistence, 'sess-ok', { version: 0, id: 'sess-ok', createdAt: 1786000000000, cwd: 'D:\\demo\\proj' }, [
    mkEvent('turn/start', 0, 1786000000000, { turn: 1 }),
    mkEvent('user/message', 1, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    mkEvent('assistant/message', 2, 1786000000000, { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model', provider: 'dsh' } } }, { surfaceOp: 'append' }),
    mkEvent('turn/end', 3, 1786000000000, { turn: 1, reason: { kind: 'completed' } }),
  ])
  // 不平衡会话：turn 无 end + call 无 result + surface 缺 surfaceOp
  await seedSession(persistence, 'sess-broken', { version: 0, id: 'sess-broken', createdAt: 1786000000000, cwd: 'D:\\demo\\proj' }, [
    mkEvent('turn/start', 0, 1786000000000, { turn: 1 }),
    mkEvent('user/message', 1, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }), // 缺 surfaceOp
    mkEvent('assistant/message', 2, 1786000000000, { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model', provider: 'dsh' } } }, { surfaceOp: 'append' }),
    mkEvent('tool/call', 3, 1786000000000, { turn: 1, step: 1, callId: 'c1', name: 'Bash', arguments: '{}' }), // 无 result
  ])
  apply(ctx)
  const def = registeredDef(ctx, 'verify_session')
  const ok = await def.execute({ sessionId: 'sess-ok' })
  assert.equal(ok.ok, true)
  assert.equal(ok.problems.length, 0)
  assert.equal(ok.turns, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, ok), [])

  const broken = await def.execute({ sessionId: 'sess-broken' })
  assert.equal(broken.ok, false)
  const kinds = broken.problems.map((p) => p.kind)
  assert.ok(kinds.includes('missing-surface-op'))
  assert.ok(kinds.includes('turn-unbalanced'))
  assert.ok(kinds.includes('call-without-result'))
  // repair 提示按 kind 给出
  const hints = broken.repairHints.map((h) => h.kind)
  assert.ok(hints.includes('call-without-result'))
  assert.ok(hints.includes('turn-unbalanced'))
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, broken), [])
  // 只读：会话未被改动
  assert.equal(persistence.sessions.get('sess-broken').events.length, 4)
})

// ---- REQ-43 导入会话工具完整可用（agentPresets.mount + 默认模型绑定） ----

test('REQ-43 agents.create 路径：setup 挂 preset scope、agentOptions 绑定默认模型；无 agents 回退 sessionPersistence', async () => {
  // 带 agents/agentPresets/agentDefaultModel/llm 服务的 ctx
  const agentsCalls = []
  const mounts = []
  const services = {
    agents: {
      async create({ sessionId, meta, seed, agentOptions, setup }) {
        agentsCalls.push({ sessionId, meta, seed, agentOptions, setup })
        // 模拟 agents.create 内部也走 sessionPersistence（导入闭环仍可读）
        await persistence.create(meta)
        await persistence.append(sessionId, seed)
      },
    },
    agentPresets: {
      async mount(agentCtx) { mounts.push(agentCtx); return undefined },
    },
    agentDefaultModel: {
      currentSelection() { return { provider: 'deepseek', model: 'deepseek-chat' } },
    },
    llm: {
      async resolveModelInfo() { return { context: { contextWindow: 131072 }, defaultMaxTokens: 8192 } },
    },
  }
  const simple = load('sess-simple-001.jsonl')
  const { ctx, persistence, attached } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple }, { services })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(value.status, 'imported')
  // agents.create 被调用：meta/seed/agentOptions/setup 齐备
  assert.equal(agentsCalls.length, 1)
  const call = agentsCalls[0]
  assert.equal(call.sessionId, 'import-sess-simple-001')
  assert.equal(call.meta.cwd, 'D:\\demo\\proj')
  assert.ok(Array.isArray(call.seed) && call.seed.length > 0)
  // 默认模型绑定（provider/model/maxTokens）→ 自动压缩路径可触发
  assert.deepEqual(call.agentOptions, { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 8192 })
  // setup 钩子执行 agentPresets.mount（preset 工具对导入会话可见）
  await call.setup({})
  assert.equal(mounts.length, 1)
  // 会话确实落盘（agents.create 内部走 sessionPersistence）
  assert.ok(persistence.sessions.has('import-sess-simple-001'))
  assert.equal(attached.length, 1)

  // 无 agents 服务 → 回退 sessionPersistence.create+append（旧路径，行为不变）
  const { ctx: ctx2, persistence: p2 } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple })
  apply(ctx2)
  const def2 = chatDef(ctx2, 'claude')
  await def2.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.ok(p2.sessions.has('import-sess-simple-001'))
})

test('REQ-43 补录预设：agentPresets.resolve 返回默认 preset 时写进 meta.agentPreset', async () => {
  const agentsCalls = []
  const mounts = []
  const services = {
    agents: {
      async create({ sessionId, meta, seed, agentOptions, setup }) {
        agentsCalls.push({ sessionId, meta, seed, agentOptions, setup })
        await persistence.create(meta)
        await persistence.append(sessionId, seed)
      },
    },
    agentPresets: {
      async resolve() { return { id: 'standard' } },
      async mount(agentCtx, id) { mounts.push(id); return undefined },
    },
    agentDefaultModel: {
      currentSelection() { return { provider: 'deepseek', model: 'deepseek-chat' } },
    },
    llm: {
      async resolveModelInfo() { return { context: { contextWindow: 131072 }, defaultMaxTokens: 8192 } },
    },
  }
  const simple = load('sess-simple-001.jsonl')
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple }, { services })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(value.status, 'imported')
  assert.equal(agentsCalls.length, 1)
  assert.equal(agentsCalls[0].meta.agentPreset, 'standard')
  await agentsCalls[0].setup({})
  assert.deepEqual(mounts, ['standard'])
  assert.ok(persistence.sessions.has('import-sess-simple-001'))
})

test('REQ-43 补录预设：agentPresets.resolve 抛错/缺 default 时保持现状（不落盘 agentPreset）', async () => {
  const agentsCalls = []
  const services = {
    agents: {
      async create({ sessionId, meta, seed, agentOptions, setup }) {
        agentsCalls.push({ sessionId, meta, seed, agentOptions, setup })
        await persistence.create(meta)
        await persistence.append(sessionId, seed)
      },
    },
    agentPresets: {
      async resolve() { throw new Error('no default preset') },
      async mount() { return undefined },
    },
  }
  const simple = load('sess-simple-001.jsonl')
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple }, { services })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(agentsCalls.length, 1)
  assert.equal(agentsCalls[0].meta.agentPreset, undefined)
  assert.ok(persistence.sessions.has('import-sess-simple-001'))
})

test('REQ-43 agents.create 失败（无 cwd 等）→ 回退 sessionPersistence 不静默', async () => {
  const services = {
    agents: {
      async create() { throw new Error('agents.create: meta.cwd missing') },
    },
  }
  const simple = load('sess-simple-001.jsonl')
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple }, { services })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(value.status, 'imported')
  // 回退路径已落盘
  assert.ok(persistence.sessions.has('import-sess-simple-001'))
})

// ---- REQ-39 full：cwd 权威映射 + home-dir 沙箱防护 ----

test('REQ-39 沙箱防护：transcript cwd = 主目录 → 归组回退源文件目录（绝不把主目录当 workspace）', async () => {
  const home = homedir().replace(/[\\/]+$/, '')
  const jsonl = [
    JSON.stringify({ sessionId: 'sess-home-001', type: 'user', cwd: home, message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ sessionId: 'sess-home-001', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
  ].join('\n')
  const { ctx, attached } = makeCtx({ 'D:\\demo\\proj\\sess-home-001.jsonl': jsonl })
  apply(ctx)
  await chatDef(ctx, 'claude').execute({ path: 'D:\\demo\\proj\\sess-home-001.jsonl' })
  // 归组落在源文件目录，不是主目录（跨平台：Linux 下 dirname 为 '.'，Windows 为 D:\demo\proj）
  assert.equal(attached.length, 1)
  assert.equal(attached[0].ws, dirname('D:\\demo\\proj\\sess-home-001.jsonl'))
})

test('REQ-39 Claude 权威映射：转录无 cwd → ~/.claude.json projects 命中真实路径', async () => {
  const home = homedir().replace(/[\\/]+$/, '')
  const jsonl = [
    JSON.stringify({ sessionId: 'sess-nocwd-001', type: 'user', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ sessionId: 'sess-nocwd-001', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
  ].join('\n')
  const root = 'D:\\demo\\claude\\projects\\D--work-my-proj'
  const tree = {
    [root]: 'dir',
    [root + '\\sess-nocwd-001.jsonl']: jsonl,
    [home + '\\.claude.json']: JSON.stringify({ projects: { 'D:\\work\\my-proj': { folderName: 'my-proj' } } }),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: root + '\\sess-nocwd-001.jsonl' })
  assert.equal(value.status, 'imported')
  // meta.cwd = 权威映射结果（真实路径），非 slug 目录名
  const saved = persistence.sessions.get('import-sess-nocwd-001')
  assert.equal(saved.meta.cwd, 'D:\\work\\my-proj')
})

// ---- REQ-22 Reasonix V2 WAL 合并 + Claude compacted 摘要导入（集成） ----

test('REQ-22 import_reasonix：同目录 <stem>.events.jsonl 自动合并，结果报告 walMerged', async () => {
  const dir = 'D:\\demo\\reasonix\\sessions'
  const stem = 'desktop-202607020199-3'
  const tree = {
    [dir]: 'dir',
    [dir + '\\' + stem + '.jsonl']: [
      JSON.stringify({ role: 'user', content: '问题1' }),
      JSON.stringify({ role: 'assistant', content: '旧回答' }),
    ].join('\n'),
    [dir + '\\' + stem + '.events.jsonl']: [
      JSON.stringify({ type: 'replace', messages: [
        { role: 'user', content: '问题1' },
        { role: 'assistant', content: 'WAL 权威回答' },
      ] }),
    ].join('\n'),
    [dir + '\\' + stem + '.meta.json']: JSON.stringify({ workspace: 'D:\\Reasonix', summary: 'WAL 会话' }),
    [dir + '\\desktop-202607020199-4.jsonl']: [ // 无 WAL 的对照文件
      JSON.stringify({ role: 'user', content: '问题' }),
      JSON.stringify({ role: 'assistant', content: '回答' }),
    ].join('\n'),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'reasonix')
  const value = await def.execute({ path: dir })
  assert.equal(value.mode, 'batch')
  assert.equal(value.imported, 2)
  const walItem = value.results.find((r) => r.path.includes(stem + '.jsonl'))
  assert.equal(walItem.walMerged, true)
  assert.equal(walItem.walRecords, 2)
  const plain = value.results.find((r) => r.path.includes('desktop-202607020199-4'))
  assert.equal(plain.walMerged, undefined)
  // WAL 权威内容落盘
  const saved = persistence.sessions.get('import-' + stem)
  const asst = saved.events.find((e) => e.type === 'assistant/message')
  assert.equal(asst.data.message.content[0].text, 'WAL 权威回答')
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('REQ-22 import_claude compacted 参数：摘要导入只落尾部 + compacted 报告 + schema', async () => {
  const lines = [
    JSON.stringify({ sessionId: 'sess-comp-002', type: 'user', message: { role: 'user', content: '问题1' } }),
    JSON.stringify({ sessionId: 'sess-comp-002', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '回答1' }] } }),
    JSON.stringify({ sessionId: 'sess-comp-002', type: 'summary', summary: '最终总结', title: '压缩标题' }),
    JSON.stringify({ sessionId: 'sess-comp-002', type: 'user', message: { role: 'user', content: '收尾' } }),
    JSON.stringify({ sessionId: 'sess-comp-002', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '收尾回答' }] } }),
  ].join('\n')
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\claude\\projects\\p\\sess-comp-002.jsonl': lines })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  // 参数进 schema
  assert.equal(def.parameters.properties.compacted.type, 'boolean')
  const value = await def.execute({ path: 'D:\\demo\\claude\\projects\\p\\sess-comp-002.jsonl', compacted: true })
  assert.equal(value.status, 'imported')
  assert.equal(value.compacted, true)
  const saved = persistence.sessions.get('import-sess-comp-002')
  const turns = saved.events.filter((e) => e.type === 'turn/start').length
  assert.equal(turns, 1) // 只导摘要后的尾部
  const asst = saved.events.find((e) => e.type === 'assistant/message')
  assert.equal(asst.data.message.content[0].type, 'reasoning')
  assert.equal(asst.data.message.content[0].text, '最终总结')
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

// ---- REQ-51 Hermes 会话 lineage（parent_session_id 压缩分叉） ----

// 建带 parent_session_id 列的 hermes state.db：父会话（带消息，压缩分叉节点）+
// 叶子子会话（承接内容）。父会话有消息时默认会导入、lineage:tail 会排除。
function makeHermesLineageDb() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hermes-'))
  const dbPath = join(dir, 'state.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, parent_session_id TEXT, started_at REAL)')
  db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, created_at REAL)')
  db.prepare('INSERT INTO sessions (id, title, parent_session_id, started_at) VALUES (?, ?, ?, ?)').run('parent-1', 'Parent', null, 1786000000000)
  db.prepare('INSERT INTO sessions (id, title, parent_session_id, started_at) VALUES (?, ?, ?, ?)').run('child-1', 'Child', 'parent-1', 1786000100000)
  db.prepare('INSERT INTO sessions (id, title, parent_session_id, started_at) VALUES (?, ?, ?, ?)').run('leaf-1', 'Leaf', null, 1786000200000)
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run('parent-1', 'user', '开始', 1786000000001)
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run('parent-1', 'assistant', '旧内容', 1786000000002)
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run('child-1', 'user', '继续', 1786000100001)
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run('child-1', 'assistant', '好', 1786000100002)
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run('leaf-1', 'user', '新任务', 1786000200001)
  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)').run('leaf-1', 'assistant', 'ok', 1786000200002)
  db.close()
  return dbPath
}

test('REQ-51 import_hermes lineage:tail：只导叶子链尾；父会话（含消息）被排除；默认导入全部', async () => {
  const dbPath = makeHermesLineageDb()
  const { ctx, persistence } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'hermes')
  // lineage 参数进 schema
  assert.equal(def.parameters.properties.lineage.enum[0], 'tail')

  // 默认（无 lineage）：全部导入（父/子/叶 3 会话）
  const plain = await def.execute({ path: dbPath })
  assert.equal(plain.imported, 3)
  assert.ok(persistence.sessions.has('import-parent-1'))
  assert.ok(persistence.sessions.has('import-child-1'))
  assert.ok(persistence.sessions.has('import-leaf-1'))
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, plain), [])

  // lineage:tail：父会话（有子会话，非叶子链尾）显式跳过，只导叶子（child-1/leaf-1）
  const tail = await def.execute({ path: dbPath, force: true, lineage: 'tail' })
  assert.equal(tail.imported, 2)
  const tailReasons = tail.results.map((r) => r.reason || '').join(' | ')
  assert.match(tailReasons, /lineage tail: parent session parent-1/)
  assert.ok(!tailReasons.includes('child-1'))
  // 叶子会话落盘（force 副本）
  assert.ok(persistence.sessions.has('import-child-1-1'))
  assert.ok(persistence.sessions.has('import-leaf-1-1'))
  assert.ok(!persistence.sessions.has('import-parent-1-1')) // 父会话不建副本
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, tail), [])
})

// 辅助：从 ctx.tools 按名字取回定义（apply 内部调用 register）
function registeredDef(ctx, toolName) {
  return ctx.tools.registered(toolName)
}

// 辅助：import_chat 分发器定义——execute 时注入 format（18 种来源收敛为单工具
// 后的测试形态；等价于旧 import_<format> 工具的调用方式）
function chatDef(ctx, format) {
  const tool = registeredDef(ctx, 'import_chat')
  return { ...tool, execute: (args) => tool.execute({ format, ...args }) }
}

// 辅助：export_chat 三合一定义——execute 时注入 format（claude/codex/kimi 收敛为
// 单工具后的测试形态；等价于旧 export_claude / export_codex / export_kimi 调用）
function exportDef(ctx, format) {
  const tool = registeredDef(ctx, 'export_chat')
  return { ...tool, execute: (args) => tool.execute({ format, ...args }) }
}

// ---- REQ-36 反向同步（增量写回） ----

const LIVE_T = 1786000000000 // 固定毫秒时间戳（续聊事件）

// 确定性 uuid 工厂（写回尾部记录）。
function syncUuidSeq() {
  let n = 0
  return () => '11111111-2222-4333-8444-' + String(++n).padStart(12, '0')
}

// 合成带 mode/permission-mode 头的 Claude transcript（verify 预检要求首行 mode、
// 文件名 stem = sessionId 才能通过 import 的 fileStem 判定）。uuid/parentUuid 链式。
function claudeJsonl(n, sessionId = 'sync-sess-001') {
  const lines = [
    JSON.stringify({ type: 'mode', mode: 'normal', sessionId }),
    JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId }),
  ]
  let prev = null
  for (let i = 1; i <= n; i++) {
    const u = 'u-' + i
    const a = 'a-' + i
    lines.push(JSON.stringify({
      parentUuid: prev, type: 'user', sessionId, cwd: 'D:\\demo\\proj',
      message: { role: 'user', content: '问题' + i }, uuid: u,
      timestamp: new Date(LIVE_T + i * 1000).toISOString(),
    }))
    lines.push(JSON.stringify({
      parentUuid: u, type: 'assistant', sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: '回答' + i }] }, uuid: a,
      timestamp: new Date(LIVE_T + i * 1000 + 1).toISOString(),
    }))
    prev = a
  }
  return lines.join('\n') + '\n'
}

// 往已导入会话追加一个完整轮（turn 编号续源编号）；halfOpen 时不写 step/end + turn/end。
async function appendTurn(persistence, id, turnNum, text, { halfOpen = false } = {}) {
  const base = persistence.sessions.get(id).events.length
  const turn = [
    { type: 'turn/start', seq: base, time: LIVE_T, data: { turn: turnNum } },
    { type: 'step/start', seq: base + 1, time: LIVE_T, data: { turn: turnNum, step: 1 } },
    { type: 'user/message', seq: base + 2, time: LIVE_T, surfaceOp: 'append', data: { id: 'live:u' + turnNum, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: base + 3, time: LIVE_T, surfaceOp: 'append', data: { turn: turnNum, step: 1, id: 'live:a' + turnNum, role: 'assistant', content: [{ type: 'text', text: '回复' + text }], source: { kind: 'model', provider: 'dsh' } } },
  ]
  if (!halfOpen) {
    turn.push({ type: 'step/end', seq: base + 4, time: LIVE_T, data: { turn: turnNum, step: 1 } })
    turn.push({ type: 'turn/end', seq: base + 5, time: LIVE_T, data: { turn: turnNum, reason: { kind: 'completed' } } })
  }
  await persistence.append(id, turn)
}

test('REQ-36 快乐路径：导入 → DSH 续聊完整轮 → sync 写回源文件（无头/链接续/水印/再次 sync no-new-turns）', async () => {
  const src = 'D:\\demo\\proj\\sync-sess-001.jsonl'
  const tree = { [src]: claudeJsonl(1) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const imp = chatDef(ctx, 'claude')
  const imported = await imp.execute({ path: src })
  assert.equal(imported.status, 'imported')
  assert.equal(imported.sessionId, 'import-sync-sess-001')
  const baseEvents = persistence.sessions.get('import-sync-sess-001').events.length

  // DSH 里继续聊了一轮（完整闭合）
  await appendTurn(persistence, 'import-sync-sess-001', 2, 'DSH 继续问')

  const syncDef = registeredDef(ctx, 'sync_to_claude')
  const value = await syncClaudeSession(ctx, { sessionId: 'import-sync-sess-001', target: 'source', uuid: syncUuidSeq() }, { registryDir: resolveRegistryDir() })
  assert.equal(value.mode, 'single')
  assert.equal(value.status, 'synced')
  assert.equal(value.target, 'source')
  assert.equal(value.filePath, src)
  assert.equal(value.sourcePath, src)
  assert.equal(value.appendedTurns, 1)
  assert.equal(value.appendedEvents, 6)
  assert.ok(value.appendedRecords > 0)
  assert.equal(value.dryRun, false)
  assert.equal(value.conflictDetected, undefined)
  assert.deepEqual(validateJsonSchemaValue(syncDef.output.schema, value), [])

  // 文件 = 旧内容 + 无头尾部；首条尾部记录 parentUuid = 旧文件尾 uuid
  const oldContent = claudeJsonl(1)
  const oldLines = oldContent.trimEnd().split('\n')
  const newContent = tree[src]
  assert.ok(newContent.startsWith(oldContent))
  const allLines = newContent.trimEnd().split('\n')
  assert.equal(allLines.length, oldLines.length + value.appendedRecords)
  const tailStart = JSON.parse(allLines[oldLines.length])
  assert.equal(tailStart.type, 'user') // 尾部无 mode/permission-mode 头
  assert.equal(tailStart.parentUuid, JSON.parse(oldLines[oldLines.length - 1]).uuid) // 链续旧尾
  assert.equal(tailStart.sessionId, 'sync-sess-001') // 与文件 sessionId 一致
  const tailAsst = JSON.parse(allLines[oldLines.length + 1])
  assert.equal(tailAsst.parentUuid, tailStart.uuid) // 尾部内链连续

  // registry writeback：水印 = 已存事件数、prevUuid = 本次尾部最后一条记录 uuid
  const reg = await loadImports(resolveRegistryDir())
  const rec = reg.imports[src]
  assert.ok(rec.writeback)
  assert.equal(rec.writeback.filePath, src)
  assert.equal(rec.writeback.sessionUuid, 'sync-sess-001')
  assert.equal(rec.writeback.lastWrittenSeq, baseEvents + 6)
  assert.equal(rec.writeback.lastWrittenTurn, 2)
  assert.equal(rec.writeback.prevUuid, JSON.parse(allLines[allLines.length - 1]).uuid)
  assert.equal(rec.writeback.lastSize, newContent.length)
  assert.equal(rec.turns, 2) // 重转新文件轮数（REQ-24 幂等键）
  assert.equal(rec.events, baseEvents + 6)

  // 再次 sync → no-new-turns，文件不变
  const second = await syncClaudeSession(ctx, { sessionId: 'import-sync-sess-001' }, { registryDir: resolveRegistryDir() })
  assert.equal(second.status, 'no-new-turns')
  assert.equal(second.incompleteFinalTurn, undefined)
  assert.equal(tree[src], newContent)
  assert.deepEqual(validateJsonSchemaValue(syncDef.output.schema, second), [])
})

test('REQ-36 半截轮不写：半开尾轮丢弃（incompleteFinalTurn），闭合后再同步写回', async () => {
  const src = 'D:\\demo\\proj\\sync-sess-001.jsonl'
  const tree = { [src]: claudeJsonl(1) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  await chatDef(ctx, 'claude').execute({ path: src })

  // 半开轮（无 step/end + turn/end）
  await appendTurn(persistence, 'import-sync-sess-001', 2, '半截提问', { halfOpen: true })
  const before = tree[src]
  const first = await syncClaudeSession(ctx, { sessionId: 'import-sync-sess-001' }, { registryDir: resolveRegistryDir() })
  assert.equal(first.status, 'no-new-turns')
  assert.equal(first.incompleteFinalTurn, true)
  assert.equal(tree[src], before) // 半截轮不写

  // 闭合半开轮
  const s = persistence.sessions.get('import-sync-sess-001')
  await persistence.append('import-sync-sess-001', [
    { type: 'step/end', seq: s.events.length, time: LIVE_T, data: { turn: 2, step: 1 } },
    { type: 'turn/end', seq: s.events.length + 1, time: LIVE_T, data: { turn: 2, reason: { kind: 'completed' } } },
  ])
  const second = await syncClaudeSession(ctx, { sessionId: 'import-sync-sess-001' }, { registryDir: resolveRegistryDir() })
  assert.equal(second.status, 'synced')
  assert.equal(second.appendedTurns, 1)
  assert.equal(second.appendedEvents, 6)
  const lines = tree[src].trimEnd().split('\n')
  assert.equal(lines.length, claudeJsonl(1).trimEnd().split('\n').length + second.appendedRecords)
})

test('REQ-36 守卫：源文件被外部修改（size/version 变化）→ skipped + source-modified-externally', async () => {
  const src = 'D:\\demo\\proj\\sync-sess-001.jsonl'
  const tree = { [src]: claudeJsonl(1) }
  const { ctx } = makeCtx(tree)
  apply(ctx)
  await chatDef(ctx, 'claude').execute({ path: src })
  // 首同步：建立基线水印（no-new-turns，桥武装）
  const arm = await syncClaudeSession(ctx, { sessionId: 'import-sync-sess-001' }, { registryDir: resolveRegistryDir() })
  assert.equal(arm.status, 'no-new-turns')

  // 外部修改：追加一行（size/version 都变）
  tree[src] = tree[src] + JSON.stringify({ type: 'user', parentUuid: 'a-1', uuid: 'ext-1', sessionId: 'sync-sess-001', message: { role: 'user', content: '外部加的' } }) + '\n'
  const v = await syncClaudeSession(ctx, { sessionId: 'import-sync-sess-001' }, { registryDir: resolveRegistryDir() })
  assert.equal(v.status, 'skipped')
  assert.equal(v.conflictDetected, 'source-modified-externally')
  assert.equal(v.writeback.lastWrittenSeq, 8) // 环境变更声明 + 1 轮（session/imported + 6 回合事件）
})

test('REQ-36 守卫：源文件缩小 → skipped + sourceShrunk', async () => {
  const src = 'D:\\demo\\proj\\sync-sess-001.jsonl'
  const tree = { [src]: claudeJsonl(2) }
  const { ctx } = makeCtx(tree)
  apply(ctx)
  await chatDef(ctx, 'claude').execute({ path: src })
  const arm = await syncClaudeSession(ctx, { sessionId: 'import-sync-sess-001' }, { registryDir: resolveRegistryDir() })
  assert.equal(arm.status, 'no-new-turns')

  tree[src] = claudeJsonl(1) // 截断成 1 轮
  const v = await syncClaudeSession(ctx, { sessionId: 'import-sync-sess-001' }, { registryDir: resolveRegistryDir() })
  assert.equal(v.status, 'skipped')
  assert.equal(v.sourceShrunk, true)
})

test('REQ-36 守卫：tail-mismatch（同尺寸同版本改链尾）→ 跳过；force 重锚定后写回', async () => {
  const src = 'D:\\demo\\proj\\sync-sess-001.jsonl'
  const tree = { [src]: claudeJsonl(1) }
  // 钉住版本：模拟「内容变了但 fs 版本不变」的外部修改（真实 fs version 是 opaque id）
  const { ctx, persistence } = makeCtx(tree, { versions: { [src]: 'v-pinned' } })
  apply(ctx)
  await chatDef(ctx, 'claude').execute({ path: src })
  const arm = await syncClaudeSession(ctx, { sessionId: 'import-sync-sess-001' }, { registryDir: resolveRegistryDir() })
  assert.equal(arm.status, 'no-new-turns')

  // 同长度篡改链尾：换掉最后一条 assistant 的 uuid（a-1 → x-1），size/version 不变
  const tampered = claudeJsonl(1).replace('"uuid":"a-1"', '"uuid":"x-1"')
  assert.equal(tampered.length, claudeJsonl(1).length)
  tree[src] = tampered
  const v = await syncClaudeSession(ctx, { sessionId: 'import-sync-sess-001' }, { registryDir: resolveRegistryDir() })
  assert.equal(v.status, 'skipped')
  assert.equal(v.conflictDetected, 'tail-mismatch')

  // force：重锚定（prevUuid = 篡改后链尾 x-1）→ 新轮写回，冲突上报
  await appendTurn(persistence, 'import-sync-sess-001', 2, 'force 后写回')
  const forced = await syncClaudeSession(ctx, { sessionId: 'import-sync-sess-001', force: true, uuid: syncUuidSeq() }, { registryDir: resolveRegistryDir() })
  assert.equal(forced.status, 'synced')
  assert.equal(forced.conflictDetected, 'tail-mismatch')
  assert.equal(forced.appendedTurns, 1)
  const lines = tree[src].trimEnd().split('\n')
  const tailStart = JSON.parse(lines[lines.length - forced.appendedRecords])
  assert.equal(tailStart.parentUuid, 'x-1') // 重锚定链尾
  assert.equal(tailStart.sessionId, 'sync-sess-001')
})

test('REQ-36 CAS 竞态：写入瞬间版本失配 → write-version-mismatch，不覆盖', async () => {
  const src = 'D:\\demo\\proj\\sync-sess-001.jsonl'
  const tree = { [src]: claudeJsonl(1) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  await chatDef(ctx, 'claude').execute({ path: src })
  const arm = await syncClaudeSession(ctx, { sessionId: 'import-sync-sess-001' }, { registryDir: resolveRegistryDir() })
  assert.equal(arm.status, 'no-new-turns')
  await appendTurn(persistence, 'import-sync-sess-001', 2, '竞态提问')

  // 模拟并发写者：writeText 委托前抢先改文件 → 观测版本失配
  const origWrite = ctx.fs.writeText
  ctx.fs.writeText = async (t, c, o) => {
    if (o && o.kind === 'replaceIfVersion' && t.targetKey === src) {
      tree[src] = tree[src] + JSON.stringify({ type: 'user', parentUuid: 'a-1', uuid: 'race-1', sessionId: 'sync-sess-001', message: { role: 'user', content: '并发写' } }) + '\n'
    }
    return origWrite(t, c, o)
  }
  const v = await syncClaudeSession(ctx, { sessionId: 'import-sync-sess-001' }, { registryDir: resolveRegistryDir() })
  assert.equal(v.status, 'skipped')
  assert.equal(v.conflictDetected, 'write-version-mismatch')
  assert.ok(!tree[src].includes('竞态提问')) // 尾行未写入
  const reg = await loadImports(resolveRegistryDir())
  assert.equal(reg.imports[src].writeback.lastWrittenSeq, 8) // 水印未推进（环境变更声明 + 1 轮）
})

test('REQ-36 预检失败回滚：目标文件不符合严格布局（无 mode 头）→ 写后回滚，水印不推进', async () => {
  // 用无 mode 头的旧式 fixture：首同步建立基线，续聊后写回 → 预检失败 → 回滚
  const src = 'D:\\demo\\proj\\sess-simple-001.jsonl'
  const tree = { [src]: load('sess-simple-001.jsonl') }
  const { ctx, persistence, writes } = makeCtx(tree)
  apply(ctx)
  await chatDef(ctx, 'claude').execute({ path: src })
  const arm = await syncClaudeSession(ctx, { sessionId: 'import-sess-simple-001' }, { registryDir: resolveRegistryDir() })
  assert.equal(arm.status, 'no-new-turns')
  await appendTurn(persistence, 'import-sess-simple-001', 2, '预检失败提问')
  const before = tree[src]
  const wCount = writes.length

  const v = await syncClaudeSession(ctx, { sessionId: 'import-sess-simple-001' }, { registryDir: resolveRegistryDir() })
  assert.equal(v.status, 'skipped')
  assert.equal(v.precheckFailed, true)
  assert.ok(v.precheck.errors.some((e) => /mode/.test(e.error)))
  assert.equal(tree[src], before) // 回滚：文件恢复为写前内容
  assert.equal(writes.length, wCount + 2) // 前向写 + 回滚写
  const reg = await loadImports(resolveRegistryDir())
  assert.equal(reg.imports[src].writeback.lastWrittenSeq, 8) // 水印未推进（环境变更声明 + 1 轮）
})

test('REQ-36 写回后重导幂等：sync 后 import_claude → already-imported 无重复 append', async () => {
  const src = 'D:\\demo\\proj\\sync-sess-001.jsonl'
  const tree = { [src]: claudeJsonl(1) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const imp = chatDef(ctx, 'claude')
  await imp.execute({ path: src })
  await appendTurn(persistence, 'import-sync-sess-001', 2, '续聊')
  const sync = await syncClaudeSession(ctx, { sessionId: 'import-sync-sess-001' }, { registryDir: resolveRegistryDir() })
  assert.equal(sync.status, 'synced')
  const eventCount = persistence.sessions.get('import-sync-sess-001').events.length

  const re = await imp.execute({ path: src })
  assert.equal(re.status, 'already-imported')
  assert.equal(re.alreadyImported, true)
  assert.equal(persistence.sessions.get('import-sync-sess-001').events.length, eventCount)
  assert.equal(persistence.sessions.size, 1)
})

test('REQ-36 非导入会话：无 session/imported 标记 → 报错', async () => {
  const { ctx, persistence } = makeCtx({})
  await seedSession(persistence, 'native-sess', { version: 0, id: 'native-sess', createdAt: 1786000000000, cwd: 'D:\\demo\\proj' }, [
    mkEvent('user/message', 0, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    mkEvent('assistant/message', 1, 1786000000000, { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'hello' }], source: { kind: 'model', provider: 'dsh' } }, { surfaceOp: 'append' }),
  ])
  apply(ctx)
  await assert.rejects(() => syncClaudeSession(ctx, { sessionId: 'native-sess' }, { registryDir: resolveRegistryDir() }), /非导入会话/)
})

test('REQ-36 多会话源：registry kind=multi → 报错暂不支持写回', async () => {
  const tree = { 'D:\\demo\\chatgpt\\conversations.json': load('chatgpt-export.json') }
  const { ctx } = makeCtx(tree)
  apply(ctx)
  await chatDef(ctx, 'chatgpt').execute({ path: 'D:\\demo\\chatgpt\\conversations.json' })
  await assert.rejects(() => syncClaudeSession(ctx, { sessionId: 'import-conv-001' }, { registryDir: resolveRegistryDir() }), /多会话源/)
})

test('REQ-36 copy target：export_claude 落 mapping → sync 写回副本；导出晚于 DSH 续聊不重复', async () => {
  const src = 'D:\\demo\\proj\\sync-sess-001.jsonl'
  const tree = { [src]: claudeJsonl(1) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  await chatDef(ctx, 'claude').execute({ path: src })
  // DSH 续聊一轮后再导出（导出副本已含该轮）
  await appendTurn(persistence, 'import-sync-sess-001', 2, '导出前续聊')
  const exp = await exportDef(ctx, 'claude').execute({ sessionId: 'import-sync-sess-001', outputDir: OUT })
  const copyPath = exp.filePath
  const copyBefore = tree[copyPath]
  // export 后 registry 记录带 exports 映射（mapping 落库）
  const reg1 = await loadImports(resolveRegistryDir())
  assert.equal(reg1.imports[src].exports.length, 1)
  assert.equal(reg1.imports[src].exports[0].filePath, copyPath)
  assert.equal(reg1.imports[src].exports[0].sessionUuid, exp.sessionId)

  // 首同步 target=copy：副本已含全部已存事件 → no-new-turns（基线 = 副本实测事件数，不重复写）
  const first = await syncClaudeSession(ctx, { sessionId: 'import-sync-sess-001', target: 'copy' }, { registryDir: resolveRegistryDir() })
  assert.equal(first.status, 'no-new-turns')
  assert.equal(tree[copyPath], copyBefore) // 无重复追加

  // 再续一轮 → sync 写回副本，尾部链续副本原尾、sessionId 用导出 sessionUuid
  await appendTurn(persistence, 'import-sync-sess-001', 3, '副本续聊')
  const copyLines = copyBefore.trimEnd().split('\n')
  const second = await syncClaudeSession(ctx, { sessionId: 'import-sync-sess-001', target: 'copy', uuid: syncUuidSeq() }, { registryDir: resolveRegistryDir() })
  assert.equal(second.status, 'synced')
  assert.equal(second.filePath, copyPath)
  assert.equal(second.appendedTurns, 1)
  const lines = tree[copyPath].trimEnd().split('\n')
  assert.equal(lines.length, copyLines.length + second.appendedRecords)
  const tailStart = JSON.parse(lines[copyLines.length])
  assert.equal(tailStart.parentUuid, JSON.parse(copyLines[copyLines.length - 1]).uuid)
  assert.equal(tailStart.sessionId, exp.sessionId) // 记录 sessionId 与副本一致
})

test('REQ-36 dryRun：完整计算 + 预检但不写盘、不更新 registry', async () => {
  const src = 'D:\\demo\\proj\\sync-sess-001.jsonl'
  const tree = { [src]: claudeJsonl(1) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  await chatDef(ctx, 'claude').execute({ path: src })
  await appendTurn(persistence, 'import-sync-sess-001', 2, 'dry 续聊')
  const before = tree[src]
  const v = await syncClaudeSession(ctx, { sessionId: 'import-sync-sess-001', dryRun: true }, { registryDir: resolveRegistryDir() })
  assert.equal(v.status, 'synced')
  assert.equal(v.dryRun, true)
  assert.equal(v.appendedTurns, 1)
  assert.equal(v.writeback.lastWrittenSeq, 14) // 将写入的水印（未持久化；环境变更声明 + 2 轮）
  assert.equal(tree[src], before) // 不写盘
  const reg = await loadImports(resolveRegistryDir())
  assert.equal(reg.imports[src].writeback, undefined) // 不更新 registry
})

test('REQ-36 源文件缺失：skipped + source-missing', async () => {
  const src = 'D:\\demo\\proj\\sync-sess-001.jsonl'
  const tree = { [src]: claudeJsonl(1) }
  const { ctx } = makeCtx(tree)
  apply(ctx)
  await chatDef(ctx, 'claude').execute({ path: src })
  delete tree[src]
  const v = await syncClaudeSession(ctx, { sessionId: 'import-sync-sess-001' }, { registryDir: resolveRegistryDir() })
  assert.equal(v.status, 'skipped')
  assert.equal(v.reason, 'source-missing')
})

test('REQ-36 storedShrunk：DSH 日志比水印短 → 跳过', async () => {
  const src = 'D:\\demo\\proj\\sync-sess-001.jsonl'
  const tree = { [src]: claudeJsonl(1) }
  const { ctx } = makeCtx(tree)
  apply(ctx)
  await chatDef(ctx, 'claude').execute({ path: src })
  // 直接写 registry：伪造超前水印（lastSize/version 与 stat 一致、prevUuid 匹配 → 三闸通过）
  const content = claudeJsonl(1)
  const stat = { size: content.length, version: contentVersion(content) }
  await rememberImport(resolveRegistryDir(), src, {
    kind: 'single', dshId: 'import-sync-sess-001', turns: 1, events: 7, sizeBytes: stat.size, version: stat.version,
    writeback: { sessionUuid: 'sync-sess-001', filePath: src, lastWrittenSeq: 999, lastWrittenTurn: 1, prevUuid: readFileTailUuid(content), lastSize: stat.size, lastVersion: stat.version, writtenAt: 0 },
  })
  const v = await syncClaudeSession(ctx, { sessionId: 'import-sync-sess-001' }, { registryDir: resolveRegistryDir() })
  assert.equal(v.status, 'skipped')
  assert.equal(v.storedShrunk, true)
})

test('REQ-36 守卫纯函数 evaluateWritebackGuards：三闸 + force 重锚定', () => {
  const wb = { lastSize: 100, lastVersion: 'v1', prevUuid: 'tail-1' }
  assert.deepEqual(evaluateWritebackGuards(wb, { size: 90, version: 'v1', fileTailUuid: 'tail-1' }), { ok: false, sourceShrunk: true })
  assert.deepEqual(evaluateWritebackGuards(wb, { size: 110, version: 'v2', fileTailUuid: 'tail-1' }), { ok: false, conflictDetected: 'source-modified-externally' })
  assert.deepEqual(evaluateWritebackGuards(wb, { size: 100, version: 'v1', fileTailUuid: 'tail-2' }), { ok: false, conflictDetected: 'tail-mismatch' })
  assert.deepEqual(evaluateWritebackGuards(wb, { size: 100, version: 'v1', fileTailUuid: 'tail-1' }), { ok: true })
  assert.deepEqual(evaluateWritebackGuards(wb, { size: 110, version: 'v2', fileTailUuid: 'tail-2', force: true }), { ok: true, reanchorPrevUuid: 'tail-2' })
  assert.deepEqual(evaluateWritebackGuards(null, { size: 1, version: 'v', fileTailUuid: 'x' }), { ok: true })
})

test('REQ-36 工具入口：sync_to_claude execute 走 syncClaudeSession（schema 校验）', async () => {
  const src = 'D:\\demo\\proj\\sync-sess-001.jsonl'
  const tree = { [src]: claudeJsonl(1) }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  await chatDef(ctx, 'claude').execute({ path: src })
  await appendTurn(persistence, 'import-sync-sess-001', 2, '工具入口')
  const def = registeredDef(ctx, 'sync_to_claude')
  const value = await def.execute({ sessionId: 'import-sync-sess-001', dryRun: true })
  assert.equal(value.mode, 'single')
  assert.equal(value.status, 'synced')
  assert.equal(value.dryRun, true)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

// ---- REQ-37 超长会话三层保护 + 预算自适应（mock 集成） ----

// 合成超长 Claude transcript：N 轮，每轮 ~46 tokens（CJK）；giantAt 轮的回答换成
// 超长文本（巨消息用例，> 预算一半）。> 预算 3 倍 = 80 轮 ≈ 3680 tokens（预算 1000）。
function hugeClaudeTurns(n, { giantAt = -1, giantChars = 1500 } = {}) {
  const lines = []
  const sessionId = 'sess-huge-001'
  for (let i = 1; i <= n; i++) {
    lines.push(JSON.stringify({ sessionId, type: 'user', cwd: 'D:\\demo\\proj', message: { role: 'user', content: '问题' + i + '，' + '字'.repeat(18) } }))
    const answer = i === giantAt ? '回答' + '字'.repeat(giantChars) : '回答' + i + '，' + '字'.repeat(18)
    lines.push(JSON.stringify({ sessionId, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } }))
  }
  return lines.join('\n')
}

test('REQ-37 超长会话导入：预算环境变量覆盖 → 三层保护生效（seed ≤ 预算、trimmed 上报、锚点+摘要+尾部保留）', async () => {
  process.env.DSH_IMPORT_CONTEXT_BUDGET = '1000'
  try {
    const tree = { 'D:\\demo\\proj\\sess-huge-001.jsonl': hugeClaudeTurns(80, { giantAt: 5 }) }
    const { ctx, persistence } = makeCtx(tree)
    apply(ctx)
    const def = chatDef(ctx, 'claude')
    const value = await def.execute({ path: 'D:\\demo\\proj\\sess-huge-001.jsonl' })
    assert.equal(value.mode, 'single')
    assert.equal(value.status, 'imported')
    assert.ok(value.trimmed)
    assert.equal(value.trimmed.source, 'env')
    assert.equal(value.trimmed.budget, 1000)
    assert.ok(value.trimmed.originalTokens > 3000) // 源 > 预算 3 倍
    assert.ok(value.trimmed.estimatedTokens <= 1000) // seed 总 token 估算 ≤ 预算
    assert.ok(value.trimmed.droppedTurns > 0)
    assert.equal(value.trimmed.summaryInserted, true)
    // 巨消息（turn5 的回答，1500+ tokens > 预算一半）未落盘（宁缺毋滥）
    const saved = persistence.sessions.get(value.sessionId)
    assert.ok(saved)
    // 注意：user/message 的 data 是扁平 { id, role, content, source }（无 message 壳），
    // assistant/message 是 { message: { ... } }——两种形状都要兼容
    const contentOf = (e) => (e.data.message ? e.data.message.content : e.data.content) || []
    const texts = saved.events
      .filter((e) => e.type === 'user/message' || e.type === 'assistant/message')
      .flatMap(contentOf)
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text)
    assert.ok(!texts.some((t) => t.startsWith('回答' + '字'.repeat(1500))))
    // 开头锚点（最早 3 条 user 文本）保留
    const userTexts = saved.events.filter((e) => e.type === 'user/message' && e.data.source.kind === 'user').map((e) => e.data.content[0].text)
    assert.ok(userTexts[0].startsWith('问题1'))
    assert.ok(userTexts[1].startsWith('问题2'))
    assert.ok(userTexts[2].startsWith('问题3'))
    // 尾部保留（最后一轮）
    assert.ok(userTexts.some((t) => t.startsWith('问题80')))
    // 摘要 reasoning 块存在
    const summaries = saved.events
      .filter((e) => e.type === 'assistant/message')
      .flatMap((e) => e.data.message.content)
      .filter((b) => b && b.type === 'reasoning' && b.text.includes('导入预算裁剪'))
    assert.ok(summaries.length >= 1)
    // 事件 seq 连续 + schema 校验
    assert.ok(saved.events.every((e, i) => e.seq === i))
    assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  } finally {
    delete process.env.DSH_IMPORT_CONTEXT_BUDGET
  }
})

test('REQ-37 无 provider 配置：走静态默认预算 550k，不报错、小会话无 trimmed 上报', async () => {
  delete process.env.DSH_IMPORT_CONTEXT_BUDGET
  const simple = load('sess-simple-001.jsonl')
  const { ctx } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(value.status, 'imported')
  assert.equal(value.trimmed, undefined) // 保护未生效 → 不上报
  const reg = await loadImports(resolveRegistryDir())
  assert.equal(reg.imports['D:\\demo\\proj\\sess-simple-001.jsonl'].budget, 550000)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('REQ-37 工具参数 budget 覆盖环境变量（优先级最高）', async () => {
  process.env.DSH_IMPORT_CONTEXT_BUDGET = '500000'
  try {
    const simple = load('sess-simple-001.jsonl')
    const { ctx } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple })
    apply(ctx)
    const def = chatDef(ctx, 'claude')
    const value = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl', budget: 300000 })
    assert.equal(value.status, 'imported')
    const reg = await loadImports(resolveRegistryDir())
    assert.equal(reg.imports['D:\\demo\\proj\\sess-simple-001.jsonl'].budget, 300000)
  } finally {
    delete process.env.DSH_IMPORT_CONTEXT_BUDGET
  }
})

test('REQ-37 动态预算：agentDefaultModel + llm 解析模型窗口（窗口 − 输出上限 − max(25%, 40k)）', async () => {
  delete process.env.DSH_IMPORT_CONTEXT_BUDGET
  const calls = []
  const services = {
    agentDefaultModel: {
      currentSelection() { return { provider: 'deepseek', model: 'deepseek-chat' } },
    },
    llm: {
      async resolveModelInfo(provider, model) {
        calls.push([provider, model])
        return { provider, id: model, name: model, context: { contextWindow: 100000 }, defaultMaxTokens: 4096 }
      },
    },
  }
  const simple = load('sess-simple-001.jsonl')
  const { ctx } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple }, { services })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(value.status, 'imported')
  assert.deepEqual(calls, [['deepseek', 'deepseek-chat']])
  // 动态预算 = 100000 − 4096 − max(25%×100000, 40000) = 55904
  const reg = await loadImports(resolveRegistryDir())
  assert.equal(reg.imports['D:\\demo\\proj\\sess-simple-001.jsonl'].budget, 55904)
})

test('REQ-37 动态解析失败（服务抛错）→ 回退静态默认不报错', async () => {
  delete process.env.DSH_IMPORT_CONTEXT_BUDGET
  const simple = load('sess-simple-001.jsonl')
  const services = {
    agentDefaultModel: {
      currentSelection() { return { provider: 'deepseek', model: 'deepseek-chat' } },
    },
    llm: {
      async resolveModelInfo() { throw new Error('adapter not found') },
    },
  }
  const { ctx } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple }, { services })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(value.status, 'imported')
  const reg = await loadImports(resolveRegistryDir())
  assert.equal(reg.imports['D:\\demo\\proj\\sess-simple-001.jsonl'].budget, 550000)
})

test('REQ-37 预算变化：文件未变但预算变 → 跳过并上报 budgetChanged', async () => {
  const simple = load('sess-simple-001.jsonl')
  const { ctx } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  process.env.DSH_IMPORT_CONTEXT_BUDGET = '500000'
  try {
    const first = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
    assert.equal(first.status, 'imported')
    process.env.DSH_IMPORT_CONTEXT_BUDGET = '400000'
    const second = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
    assert.equal(second.status, 'already-imported')
    assert.equal(second.budgetChanged, true)
    assert.deepEqual(validateJsonSchemaValue(def.output.schema, second), [])
    // 同预算重导：记录未更新前仍报 budgetChanged（同 argsChanged 语义——跳过不
    // 改写记录，需要按新预算导入用 force:true）
    const third = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
    assert.equal(third.status, 'already-imported')
    assert.equal(third.budgetChanged, true)
    // force:true 按新预算建副本 → 记录更新；之后再导同预算不再报 budgetChanged
    const forced = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl', force: true })
    assert.equal(forced.status, 'imported')
    const reg = await loadImports(resolveRegistryDir())
    assert.equal(reg.imports['D:\\demo\\proj\\sess-simple-001.jsonl'].budget, 400000)
    const fourth = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
    assert.equal(fourth.status, 'already-imported')
    assert.equal(fourth.budgetChanged, undefined)
  } finally {
    delete process.env.DSH_IMPORT_CONTEXT_BUDGET
  }
})

test('REQ-37 目录批量导入：逐文件 trimmed 进 results（schema 校验）', async () => {
  process.env.DSH_IMPORT_CONTEXT_BUDGET = '1000'
  try {
    const tree = {
      'D:\\demo\\proj': 'dir',
      'D:\\demo\\proj\\sess-huge-001.jsonl': hugeClaudeTurns(80, { giantAt: 5 }),
      'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl'),
    }
    const { ctx, persistence } = makeCtx(tree)
    apply(ctx)
    const def = chatDef(ctx, 'claude')
    const value = await def.execute({ path: 'D:\\demo\\proj' })
    assert.equal(value.mode, 'batch')
    assert.equal(value.imported, 2)
    const huge = value.results.find((r) => r.path.endsWith('sess-huge-001.jsonl'))
    assert.ok(huge)
    assert.ok(huge.trimmed)
    assert.equal(huge.trimmed.source, 'env')
    assert.ok(huge.trimmed.estimatedTokens <= 1000)
    const small = value.results.find((r) => r.path.endsWith('sess-simple-001.jsonl'))
    assert.equal(small.trimmed, undefined)
    assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
    // 落盘会话事件平衡
    assert.ok(persistence.sessions.get(huge.sessionId))
    assert.ok(persistence.sessions.get(small.sessionId))
  } finally {
    delete process.env.DSH_IMPORT_CONTEXT_BUDGET
  }
})

// ---- REQ-17 导入 dry-run 预览（preview / dryRun 别名） ----

test('REQ-17 单文件 preview：返回预览清单（标题/cwd/时间/规模）、零副作用、schema 校验', async () => {
  const simple = load('sess-simple-001.jsonl')
  const { ctx, persistence, attached, reads } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl', preview: true })

  assert.equal(value.mode, 'single')
  assert.equal(value.preview, true)
  // 无写入态字段（与正式导入同骨架，只去掉 sessionId/status/alreadyImported 等）
  assert.equal(value.sessionId, undefined)
  assert.equal(value.status, undefined)
  assert.equal(value.alreadyImported, undefined)
  // 清单字段：标题 / cwd / 时间 / 规模
  assert.equal(value.title, '你好，帮我看看这个项目')
  assert.equal(value.cwd, 'D:\\demo\\proj')
  assert.equal(typeof value.createdAt, 'number')
  assert.equal(value.turns, 1)
  assert.equal(value.messages, 2)
  assert.equal(value.toolCalls, 0)
  assert.equal(value.skipped, 0)
  assert.ok(reads.count > 0) // 确实读了源文件（转换发生）
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  // 零副作用：不落盘、不归组、不写 imports registry
  assert.equal(persistence.sessions.size, 0)
  assert.equal(attached.length, 0)
  const reg = await loadImports(resolveRegistryDir())
  assert.deepEqual(reg.imports, {})
})

test('REQ-17 dryRun 别名：与 preview 同语义（单文件）', async () => {
  const simple = load('sess-simple-001.jsonl')
  const { ctx, persistence, attached } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl', dryRun: true })
  assert.equal(value.mode, 'single')
  assert.equal(value.preview, true)
  assert.equal(value.turns, 1)
  assert.equal(persistence.sessions.size, 0)
  assert.equal(attached.length, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('REQ-17 目录 preview：批量形态（total/results 同骨架）、逐文件条目、零副作用', async () => {
  const tree = {
    'D:\\demo\\proj': 'dir',
    'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl'),
    'D:\\demo\\proj\\sess-multi-001.jsonl': load('sess-multi-001.jsonl'),
    'D:\\demo\\proj\\agent-abc123.jsonl': load('sess-simple-001.jsonl'), // 辅助 transcript → 跳过
    'D:\\demo\\proj\\sess-bad-001.jsonl': load('sess-bad-001.jsonl'),
  }
  const { ctx, persistence, attached } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj', preview: true })

  assert.equal(value.mode, 'batch')
  assert.equal(value.preview, true)
  assert.equal(value.total, 4)
  // 无写入态计数（imported/alreadyImported/appended/skipped/failed 是落盘决策产物）
  assert.equal(value.imported, undefined)
  assert.equal(value.skipped, undefined)

  const simple = value.results.find((r) => r.path.endsWith('sess-simple-001.jsonl'))
  assert.ok(simple)
  assert.equal(simple.title, '你好，帮我看看这个项目')
  assert.equal(simple.cwd, 'D:\\demo\\proj')
  assert.equal(simple.turns, 1)
  assert.equal(simple.messages, 2)
  const multi = value.results.find((r) => r.path.endsWith('sess-multi-001.jsonl'))
  assert.equal(multi.turns, 1)
  assert.equal(multi.messages, 4) // user + 2 assistant + 1 tool/result
  assert.equal(multi.toolCalls, 1)
  // 辅助 transcript：跳过明细（skipReason）
  const aux = value.results.find((r) => r.path.endsWith('agent-abc123.jsonl'))
  assert.equal(aux.turns, 0)
  assert.equal(aux.skipped, 1)
  assert.ok(aux.skipReason.includes('auxiliary'))
  // 畸形行计数进预览（规模含跳过明细）
  const bad = value.results.find((r) => r.path.endsWith('sess-bad-001.jsonl'))
  assert.equal(bad.turns, 1)
  assert.equal(bad.skipped, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  // 零副作用
  assert.equal(persistence.sessions.size, 0)
  assert.equal(attached.length, 0)
  const reg = await loadImports(resolveRegistryDir())
  assert.deepEqual(reg.imports, {})
})

test('REQ-17 辅助 transcript 单文件 preview：跳过明细（skipReason）', async () => {
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\proj\\agent-abc123.jsonl': load('sess-simple-001.jsonl') })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj\\agent-abc123.jsonl', preview: true })
  assert.equal(value.mode, 'single')
  assert.equal(value.preview, true)
  assert.equal(value.turns, 0)
  assert.equal(value.messages, 0)
  assert.equal(value.skipped, 1)
  assert.ok(value.skipReason.includes('auxiliary'))
  assert.equal(persistence.sessions.size, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('REQ-17 import_chatgpt preview：单 conversations.json 逐会话预览（恒批量）', async () => {
  const { ctx, persistence, attached } = makeCtx({ 'D:\\demo\\chatgpt\\conversations.json': load('chatgpt-export.json') })
  apply(ctx)
  const def = chatDef(ctx, 'chatgpt')
  const value = await def.execute({ path: 'D:\\demo\\chatgpt\\conversations.json', preview: true })

  assert.equal(value.mode, 'batch') // 单文件也恒批量
  assert.equal(value.preview, true)
  assert.equal(value.total, 3) // 2 个可导入会话 + 1 个 system-only 跳过
  const conv1 = value.results.find((r) => r.title === 'Python debugging help')
  assert.ok(conv1)
  assert.equal(conv1.turns, 2)
  assert.equal(typeof conv1.createdAt, 'number')
  const skip = value.results.find((r) => r.skipReason)
  assert.ok(skip)
  assert.ok(skip.skipReason.includes('no importable conversations'))
  assert.equal(persistence.sessions.size, 0)
  assert.equal(attached.length, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('REQ-17 import_opencode preview：SQLite 库逐会话预览（恒批量、零副作用）', async () => {
  const dbPath = makeOpencodeDb(opencodeTestSessions())
  const { ctx, persistence, attached } = makeCtx({})
  apply(ctx)
  const def = chatDef(ctx, 'opencode')
  const value = await def.execute({ path: dbPath, preview: true })

  assert.equal(value.mode, 'batch')
  assert.equal(value.preview, true)
  assert.equal(value.total, 2)
  const a = value.results.find((r) => r.title === 'Fix build')
  assert.ok(a)
  assert.equal(a.cwd, 'E:/demo/opencode')
  assert.equal(a.createdAt, 1786000000000)
  assert.equal(a.turns, 1)
  assert.equal(a.toolCalls, 1)
  assert.equal(persistence.sessions.size, 0)
  assert.equal(attached.length, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('REQ-17 已导入文件 preview：不 consult registry 短路径，仍报真实转换统计', async () => {
  const simple = load('sess-simple-001.jsonl')
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' }) // 正式导入（建 registry 记录）
  const value = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl', preview: true })
  assert.equal(value.preview, true)
  // 预览不做幂等短路径：即使已导入仍返回真实转换统计（而非 0 轮 already-imported）
  assert.equal(value.turns, 1)
  assert.equal(value.messages, 2)
  assert.equal(value.sessionId, undefined)
  assert.equal(persistence.sessions.size, 1) // 预览不新增落盘
})

test('REQ-17 预览 → 正式导入：去掉 preview 后字段口径一致、预览不产生 registry 记录', async () => {
  const simple = load('sess-simple-001.jsonl')
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const preview = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl', preview: true })
  const real = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })

  // 同源口径：规模字段与正式导入一致
  assert.equal(preview.turns, real.turns)
  assert.equal(preview.messages, real.messages)
  assert.equal(preview.toolCalls, real.toolCalls)
  assert.equal(preview.skipped, real.skipped)
  // 预览不写 registry → 正式导入是首次导入（非 already-imported）
  assert.equal(real.alreadyImported, false)
  assert.equal(real.sessionId, 'import-sess-simple-001')
  assert.equal(persistence.sessions.size, 1)
})

// ---- REQ-41 被动会话发现（Browser 面板数据源路由） ----

test('REQ-41 apply 注册 webServer 路由（POST /api-import/sessions + /api-import/import，kind exact），工具计数不变（13 个）', () => {
  const { ctx, webRoutes, registered } = makeCtx({})
  apply(ctx)
  const sessions = webRoutes.find((r) => r.path === '/api-import/sessions')
  const imp = webRoutes.find((r) => r.path === '/api-import/import')
  const sync = webRoutes.find((r) => r.path === '/api-import/sync')
  assert.ok(sessions)
  assert.ok(imp)
  assert.ok(sync)
  assert.equal(sessions.kind, 'exact')
  assert.equal(imp.kind, 'exact')
  assert.equal(typeof sessions.handler, 'function')
  assert.equal(typeof imp.handler, 'function')
  // 只加路由，不加工具：import_chat 分流 18 来源 + import_agents + doctor + import_mcp + import_settings + scan/export_chat/sync/list/retract + bundle 导出/还原 + verify = 13，注册数不变
  assert.equal(registered.length, 13)
})

test('REQ-41 webServer 可选：headless（无 webServer）apply 不抛错、13 工具照常注册、无路由', () => {
  const { ctx, webRoutes, registered } = makeCtx({}, { noWebServer: true })
  apply(ctx)
  // 缺 webServer 只是不注册面板路由，导入工具不受影响（CI headless 冒烟场景）
  assert.equal(webRoutes.length, 0)
  assert.equal(registered.length, 13)
})

test('REQ-41 /api-import/sessions handler：合成夹具经 discoverSessions 返回会话、未知来源 400', async () => {
  const root = 'D:\\demo\\claude\\projects'
  const tree = {
    [root]: 'dir',
    [root + '\\proj-a']: 'dir',
    [root + '\\proj-a\\sess-aaa.jsonl']: [
      '{"sessionId":"sess-aaa","type":"user","cwd":"D:\\\\demo\\\\claude-proj","message":{"role":"user","content":"帮我重构这个模块"}}',
      '{"sessionId":"sess-aaa","type":"assistant","message":{"role":"assistant","content":"好"}}',
    ].join('\n'),
    [root + '\\proj-b']: 'dir',
    [root + '\\proj-b\\sess-bbb.jsonl']: [
      '{"sessionId":"sess-bbb","type":"user","message":{"role":"user","content":"<system-reminder>系统注入，不是提问</system-reminder>"}}',
      '{"sessionId":"sess-bbb","type":"user","message":{"role":"user","content":"真实问题"}}',
      '{"sessionId":"sess-bbb","type":"assistant","message":{"role":"assistant","content":"好"}}',
    ].join('\n'),
  }
  const { ctx, webRoutes } = makeCtx(tree)
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/sessions')
  const invoke = async (body) => {
    const req = { async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } }
    const res = {
      status: null, headers: null, body: null,
      writeHead(s, h) { this.status = s; this.headers = h },
      end(b) { this.body = b },
    }
    await route.handler(req, res)
    return { res, data: JSON.parse(res.body) }
  }

  // claude-code 来源（SOURCE_FORMAT → claude）：discoverSessions 返回 2 个会话
  const first = await invoke({ source: 'claude-code', path: root })
  assert.equal(first.res.status, 200)
  assert.equal(first.data.ok, true)
  assert.equal(first.data.sessions.length, 2)
  const aaa = first.data.sessions.find((s) => s.sessionId === 'sess-aaa')
  assert.ok(aaa)
  assert.equal(aaa.format, 'claude')
  assert.equal(aaa.title, '帮我重构这个模块')
  assert.equal(aaa.importStatus, 'not-imported') // registry 为空
  const bbb = first.data.sessions.find((s) => s.sessionId === 'sess-bbb')
  assert.equal(bbb.title, '真实问题') // 注入首行被过滤（REQ-40 标题提取）
  assert.ok(bbb.sourcePath.endsWith('sess-bbb.jsonl'))

  // query 过滤透传
  const q = await invoke({ source: 'claude-code', path: root, query: '重构' })
  assert.equal(q.data.ok, true)
  assert.equal(q.data.sessions.length, 1)
  assert.equal(q.data.sessions[0].sessionId, 'sess-aaa')

  // source 省略/空串 = 扫全部格式（面板「全部来源」按工作区分组浏览）；其余格式自拒
  const all = await invoke({ path: root })
  assert.equal(all.data.ok, true)
  assert.equal(all.data.sessions.length, 2)
  assert.ok(all.data.sessions.every((s) => s.format === 'claude'))

  // 未知来源 → 400 {ok:false, error}
  const bad = await invoke({ source: 'not-a-source', path: root })
  assert.equal(bad.res.status, 400)
  assert.equal(bad.data.ok, false)
  assert.match(bad.data.error, /未知来源/)
})

test('REQ-41 /api-import/sessions handler：qoder 来源映射（SOURCE_FORMAT → qoder）', async () => {
  const root = 'D:\\demo\\.qoder\\projects'
  const tree = {
    [root]: 'dir',
    [root + '\\-home-u-demo']: 'dir',
    [root + '\\-home-u-demo\\sess-q1.jsonl']: [
      '{"sessionId":"sess-q1","type":"user","cwd":"/home/u/demo","message":{"role":"user","content":"帮我看看构建"}}',
      '{"sessionId":"sess-q1","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"好"}]}}',
      '{"type":"ai-title","aiTitle":"自定义标题","sessionId":"sess-q1"}',
    ].join('\n'),
  }
  const { ctx, webRoutes } = makeCtx(tree)
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/sessions')
  const req = { async *[Symbol.asyncIterator]() { yield JSON.stringify({ source: 'qoder', path: root }) } }
  const res = { status: null, headers: null, body: null, writeHead(s, h) { this.status = s; this.headers = h }, end(b) { this.body = b } }
  await route.handler(req, res)
  const data = JSON.parse(res.body)
  assert.equal(res.status, 200)
  assert.equal(data.ok, true)
  assert.equal(data.sessions.length, 1)
  assert.equal(data.sessions[0].format, 'qoder')
  assert.equal(data.sessions[0].sessionId, 'sess-q1')
  assert.equal(data.sessions[0].title, '自定义标题')
})

test('REQ-41 /api-import/sessions handler：分页（offset/limit + total）+ 搜索组合', async () => {
  const root = 'D:\\demo\\claude\\projects'
  const tree = {
    [root]: 'dir',
    [root + '\\proj-a']: 'dir',
    [root + '\\proj-a\\sess-aaa.jsonl']: '{"sessionId":"sess-aaa","type":"user","cwd":"D:\\\\demo\\\\proj-a","message":{"role":"user","content":"第一个问题"}}\n{"sessionId":"sess-aaa","type":"assistant","message":{"role":"assistant","content":"ok"}}',
    [root + '\\proj-b']: 'dir',
    [root + '\\proj-b\\sess-bbb.jsonl']: '{"sessionId":"sess-bbb","type":"user","cwd":"D:\\\\demo\\\\proj-b","message":{"role":"user","content":"第二个问题"}}\n{"sessionId":"sess-bbb","type":"assistant","message":{"role":"assistant","content":"ok"}}',
    [root + '\\proj-c']: 'dir',
    [root + '\\proj-c\\sess-ccc.jsonl']: '{"sessionId":"sess-ccc","type":"user","cwd":"D:\\\\demo\\\\proj-c","message":{"role":"user","content":"第三个问题"}}\n{"sessionId":"sess-ccc","type":"assistant","message":{"role":"assistant","content":"ok"}}',
  }
  const { ctx, webRoutes } = makeCtx(tree)
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/sessions')
  const invoke = async (body) => {
    const req = { async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } }
    const res = { status: null, headers: null, body: null, writeHead(s, h) { this.status = s; this.headers = h }, end(b) { this.body = b } }
    await route.handler(req, res)
    return { res, data: JSON.parse(res.body) }
  }

  // 第 0 页 limit=2：返回 2 条 + 过滤后总数 3（discovery 排序稳定：目录名序 aaa/bbb/ccc）
  const p0 = await invoke({ source: 'claude-code', path: root, limit: 2 })
  assert.equal(p0.res.status, 200)
  assert.equal(p0.data.ok, true)
  assert.equal(p0.data.sessions.length, 2)
  assert.equal(p0.data.total, 3)
  assert.equal(p0.data.limit, 2)
  assert.equal(p0.data.offset, 0)
  assert.deepEqual(p0.data.sessions.map((s) => s.sessionId), ['sess-aaa', 'sess-bbb'])

  // 第 1 页（offset=2）：返回剩余 1 条，total 不变
  const p1 = await invoke({ source: 'claude-code', path: root, limit: 2, offset: 2 })
  assert.equal(p1.data.sessions.length, 1)
  assert.equal(p1.data.total, 3)
  assert.equal(p1.data.sessions[0].sessionId, 'sess-ccc')

  // 搜索 + 分页组合：query 先过滤（total 收窄）再切片
  const q = await invoke({ source: 'claude-code', path: root, query: '第二个', limit: 2 })
  assert.equal(q.data.total, 1)
  assert.equal(q.data.sessions.length, 1)
  assert.equal(q.data.sessions[0].sessionId, 'sess-bbb')

  // limit 缺省：不分页返回全部（limit = 实际长度）
  const all = await invoke({ source: 'claude-code', path: root })
  assert.equal(all.data.sessions.length, 3)
  assert.equal(all.data.limit, 3)
})

test('REQ-41 /api-import/sessions 流式：后台扫描 + after 游标轮询（增量去重、epoch 换键）', async () => {
  const root = 'D:\\demo\\claude\\projects'
  const tree = {
    [root]: 'dir',
    [root + '\\proj-a']: 'dir',
    [root + '\\proj-a\\sess-aaa.jsonl']: '{"sessionId":"sess-aaa","type":"user","cwd":"D:\\\\demo\\\\proj-a","message":{"role":"user","content":"第一个问题"}}\n{"sessionId":"sess-aaa","type":"assistant","message":{"role":"assistant","content":"ok"}}',
    [root + '\\proj-b']: 'dir',
    [root + '\\proj-b\\sess-bbb.jsonl']: '{"sessionId":"sess-bbb","type":"user","cwd":"D:\\\\demo\\\\proj-b","message":{"role":"user","content":"第二个问题"}}\n{"sessionId":"sess-bbb","type":"assistant","message":{"role":"assistant","content":"ok"}}',
  }
  const { ctx, webRoutes } = makeCtx(tree)
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/sessions')
  const invoke = async (body) => {
    const req = { async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } }
    const res = { status: null, headers: null, body: null, writeHead(s, h) { this.status = s; this.headers = h }, end(b) { this.body = b } }
    await route.handler(req, res)
    return { res, data: JSON.parse(res.body) }
  }

  // 首请求创建后台扫描并立即返回当前增量（done 前按 cursor 轮询）
  const p0 = await invoke({ source: 'claude-code', path: root, epoch: 1, after: 0 })
  assert.equal(p0.res.status, 200)
  assert.equal(p0.data.ok, true)
  assert.equal(typeof p0.data.cursor, 'number')
  assert.equal(p0.data.offset, undefined) // 流式响应不带旧契约分页字段

  // 客户端按 cursor 轮询直至 done：增量按 seq 去重，最终集合 = 全量发现
  const all = []
  let after = 0
  let guard = 0
  for (;;) {
    const r = await invoke({ source: 'claude-code', path: root, epoch: 1, after })
    assert.equal(r.data.ok, true)
    for (const s of r.data.sessions) {
      assert.ok(!all.includes(s.sessionId), '游标增量不应重复: ' + s.sessionId)
      all.push(s.sessionId)
    }
    after = r.data.cursor
    if (r.data.done === true) {
      assert.equal(r.data.total, 2)
      break
    }
    // 后台扫描在事件循环里异步推进：轮询需让出（生产端客户端按 ~250ms 轮询）
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.ok(guard++ < 200, '扫描未在 200 次轮询内完成')
  }
  assert.deepEqual([...all].sort(), ['sess-aaa', 'sess-bbb'])

  // epoch 变化 → 新扫描键（刷新语义）：重新产出同一集合
  const again = await invoke({ source: 'claude-code', path: root, epoch: 2, after: 0 })
  assert.equal(again.data.ok, true)
  if (again.data.done === true) {
    assert.deepEqual(again.data.sessions.map((s) => s.sessionId).sort(), ['sess-aaa', 'sess-bbb'])
  }

  // query 过滤透传（流式模式同样作用于产出路径）
  const q = await invoke({ source: 'claude-code', path: root, query: '第二个', epoch: 3, after: 0 })
  assert.equal(q.data.ok, true)
  if (q.data.done === true) {
    assert.deepEqual(q.data.sessions.map((s) => s.sessionId), ['sess-bbb'])
    assert.equal(q.data.total, 1)
  }

  // 未知来源 → 400（流式模式同样先校验）
  const bad = await invoke({ source: 'nope', epoch: 1, after: 0 })
  assert.equal(bad.res.status, 400)
  assert.equal(bad.data.ok, false)
})

test('REQ-41 /api-import/prefs：settings 缺席回退默认；在场时读/写走 fenced 路由（revision 冲突保护）', async () => {
  const invoke = async (route, body) => {
    const req = { async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } }
    const res = { status: null, headers: null, body: null, writeHead(s, h) { this.status = s; this.headers = h }, end(b) { this.body = b } }
    await route.handler(req, res)
    return { res, data: JSON.parse(res.body) }
  }

  // settings 服务缺席（默认 makeCtx）：读回默认 + available:false；写原样返回不抛
  const { ctx, webRoutes } = makeCtx({})
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/prefs')
  assert.ok(route, '面板注册了 /api-import/prefs 路由')
  const r0 = await invoke(route, {})
  assert.equal(r0.res.status, 200)
  assert.equal(r0.data.ok, true)
  assert.equal(r0.data.available, false)
  assert.deepEqual(r0.data.value, { importSystemPrompt: false })
  const w0 = await invoke(route, { importSystemPrompt: true })
  assert.equal(w0.data.ok, true)
  assert.equal(w0.data.available, false)

  // settings 在场：describe 读 value+revision，update 携带 expectedRevision
  const calls = []
  const settingsStub = {
    register(ns, schema) { return { ns, schema } },
    describe(opts) {
      assert.equal(opts.redactSecrets, true)
      return [{ ns: 'chat-import', value: { importSystemPrompt: false }, revision: 7 }]
    },
    async update(ns, patch, expectedRevision) { calls.push({ ns, patch, expectedRevision }) },
    get(ns) { return { importSystemPrompt: false } },
  }
  const { ctx: ctx2, webRoutes: routes2 } = makeCtx({}, { services: { settings: settingsStub } })
  apply(ctx2)
  const route2 = routes2.find((r) => r.path === '/api-import/prefs')
  const r = await invoke(route2, {})
  assert.equal(r.data.ok, true)
  assert.equal(r.data.available, true)
  assert.equal(r.data.revision, 7)
  assert.deepEqual(r.data.value, { importSystemPrompt: false })
  const w = await invoke(route2, { importSystemPrompt: true, revision: 7 })
  assert.equal(w.data.ok, true)
  assert.deepEqual(calls, [{ ns: 'chat-import', patch: { importSystemPrompt: true }, expectedRevision: 7 }])

  // update 抛冲突 → ok:false + code: settings-conflict（客户端据此重读）
  const conflictStub = {
    ...settingsStub,
    async update() {
      const e = new Error('settings namespace "chat-import" changed since it was read (expected 7, now 8)')
      e.name = 'SettingsConflictError'
      throw e
    },
  }
  const { ctx: ctx3, webRoutes: routes3 } = makeCtx({}, { services: { settings: conflictStub } })
  apply(ctx3)
  const route3 = routes3.find((r) => r.path === '/api-import/prefs')
  const wc = await invoke(route3, { importSystemPrompt: true, revision: 7 })
  assert.equal(wc.data.ok, false)
  assert.equal(wc.data.code, 'settings-conflict')
})

test('REQ-55 面板发现 + scan_discover：归档目标 importStatus=archived（可重导），未归档导入仍 imported', async () => {
  const root = 'D:\\demo\\claude\\projects'
  const file = root + '\\proj-a\\sess-aaa.jsonl'
  const tree = {
    [root]: 'dir',
    [root + '\\proj-a']: 'dir',
    [file]: '{"sessionId":"sess-aaa","type":"user","cwd":"D:\\\\demo\\\\claude-proj","message":{"role":"user","content":"问题"}}\n{"sessionId":"sess-aaa","type":"assistant","message":{"role":"assistant","content":"好"}}',
  }
  const { ctx, webRoutes } = makeCtx(tree)
  apply(ctx)
  const imp = chatDef(ctx, 'claude')
  await imp.execute({ path: file })
  const wr = ctx.get('workspaceRegistry')
  await wr.archiveSession('import-sess-aaa')

  // 面板数据源：/api-import/sessions 返回 archived（客户端据此显示「已归档」+ 导入按钮）
  const route = webRoutes.find((r) => r.path === '/api-import/sessions')
  const invoke = async (body) => {
    const req = { async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } }
    const res = { status: null, headers: null, body: null, writeHead(s, h) { this.status = s; this.headers = h }, end(b) { this.body = b } }
    await route.handler(req, res)
    return { res, data: JSON.parse(res.body) }
  }
  const panel = await invoke({ source: 'claude-code', path: root })
  assert.equal(panel.data.ok, true)
  assert.equal(panel.data.sessions[0].importStatus, 'archived')

  // scan_discover 同口径（schema 含 archived）
  const scan = registeredDef(ctx, 'scan_discover')
  const found = await scan.execute({ path: root })
  assert.equal(found.sessions.find((s) => s.sessionId === 'sess-aaa').importStatus, 'archived')
  assert.deepEqual(validateJsonSchemaValue(scan.output.schema, found), [])
})

// ---- REQ-41 Stage 2 面板导入路由（POST /api-import/import） ----

// 路由调用辅助：把 body 序列化为 async iterable req + 捕获 res
async function invokeImportRoute(route, body) {
  const req = { async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } }
  const res = {
    status: null, headers: null, body: null,
    writeHead(s, h) { this.status = s; this.headers = h },
    end(b) { this.body = b },
  }
  await route.handler(req, res)
  return { res, data: JSON.parse(res.body) }
}

test('REQ-41 /api-import/import handler：单选导入（claude 夹具）→ imported，幂等重导 → already-imported，归组一致', async () => {
  const root = 'D:\\demo\\claude\\projects'
  const src = root + '\\proj-a\\sess-aaa.jsonl'
  const tree = {
    [root]: 'dir',
    [root + '\\proj-a']: 'dir',
    [src]: [
      '{"sessionId":"sess-aaa","type":"user","cwd":"D:\\\\demo\\\\claude-proj","message":{"role":"user","content":"帮我重构这个模块"}}',
      '{"sessionId":"sess-aaa","type":"assistant","message":{"role":"assistant","content":"好"}}',
    ].join('\n'),
  }
  const { ctx, persistence, attached, webRoutes } = makeCtx(tree)
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/import')
  assert.ok(route)

  const one = await invokeImportRoute(route, { items: [{ source: 'claude-code', sourcePath: src }] })
  assert.equal(one.res.status, 200)
  assert.equal(one.data.ok, true)
  assert.equal(one.data.results.length, 1)
  assert.equal(one.data.results[0].status, 'imported')
  assert.equal(one.data.results[0].mode, 'single')
  assert.equal(one.data.results[0].sessionId, 'import-sess-aaa')
  assert.equal(persistence.sessions.size, 1)
  // 面板导入与 import_* 工具一致：cwd → workspace attach
  assert.ok(attached.some((a) => a.ws === 'D:\\demo\\claude-proj'))

  // 幂等：同一 sourcePath 再导 → already-imported，不重复落盘
  const again = await invokeImportRoute(route, { items: [{ source: 'claude-code', sourcePath: src }] })
  assert.equal(again.data.ok, true)
  assert.equal(again.data.results[0].status, 'already-imported')
  assert.equal(persistence.sessions.size, 1)
})

test('REQ-41 /api-import/import handler：多选同源去重（同 sourcePath 只导一次）+ 空 items 400 + 未知来源 400', async () => {
  const root = 'D:\\demo\\claude\\projects'
  const src = root + '\\proj-a\\sess-aaa.jsonl'
  const tree = {
    [root]: 'dir',
    [root + '\\proj-a']: 'dir',
    [src]: '{"sessionId":"sess-aaa","type":"user","message":{"role":"user","content":"hi"}}\n{"sessionId":"sess-aaa","type":"assistant","message":{"role":"assistant","content":"ok"}}',
  }
  const { ctx, webRoutes } = makeCtx(tree)
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/import')

  // 同一 sourcePath 两个条目（多选命中同一文件）→ 去重只导一次
  const multi = await invokeImportRoute(route, {
    items: [
      { source: 'claude-code', sourcePath: src, sessionId: 'sess-aaa' },
      { source: 'claude-code', sourcePath: src, sessionId: 'whatever' },
    ],
  })
  assert.equal(multi.data.ok, true)
  assert.equal(multi.data.results.length, 1)
  assert.equal(multi.data.results[0].status, 'imported')

  // items 为空 → 400
  const empty = await invokeImportRoute(route, { items: [] })
  assert.equal(empty.res.status, 400)
  assert.equal(empty.data.ok, false)
  assert.match(empty.data.error, /items 为空/)

  // 未知来源 → 400
  const bad = await invokeImportRoute(route, { items: [{ source: 'nope', sourcePath: src }] })
  assert.equal(bad.res.status, 400)
  assert.equal(bad.data.ok, false)
  assert.match(bad.data.error, /未知来源/)
})

test('REQ-41 /api-import/import handler：批量形态（chatgpt conversations.json 一文件多会话 → batch 摘要）', async () => {
  const file = 'D:\\demo\\chatgpt\\conversations.json'
  const { ctx, persistence, webRoutes } = makeCtx({ [file]: load('chatgpt-export.json') })
  apply(ctx)
  const route = webRoutes.find((r) => r.path === '/api-import/import')

  const out = await invokeImportRoute(route, { items: [{ source: 'chatgpt', sourcePath: file }] })
  assert.equal(out.res.status, 200)
  assert.equal(out.data.ok, true)
  assert.equal(out.data.results.length, 1)
  assert.equal(out.data.results[0].mode, 'batch')
  assert.equal(out.data.results[0].imported, 2)
  assert.equal(out.data.results[0].skipped, 1)
  assert.equal(persistence.sessions.size, 2)
})
