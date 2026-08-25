// test/command.test.mjs — REQ-42 /import 命令面
//
// 用真实 registerTools（填充 IMPORT_SPECS）+ registerImportCommand + mock ctx 验证
// 命令 handler：解析（短名/全名/客户端 id 三态）、单文件导入、幂等重导、未知来源
// 与缺参错误路径。fixture 用真实临时目录（mkdtemp，跨平台安全，check:linux 规则）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, statSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTools } from '../lib/tools.mjs'
import { registerImportCommand } from '../lib/command.mjs'

// 最小 Claude transcript（user + assistant 两行；cwd 用不存在路径触发 REQ-39-lite
// 回退归组到源目录——mkdtemp 目录真实存在，attach 不落「未分组」）。
function simpleClaudeJsonl(sessionId) {
  return [
    JSON.stringify({ parentUuid: null, userType: 'user', cwd: 'D:\\no-such\\proj', sessionId, type: 'user', message: { role: 'user', content: '你好' }, uuid: 'u-1', timestamp: '2026-08-01T10:00:00.000Z' }),
    JSON.stringify({ parentUuid: null, userType: 'user', cwd: 'D:\\no-such\\proj', sessionId, type: 'assistant', message: { role: 'assistant', content: '好的' }, uuid: 'a-1', timestamp: '2026-08-01T10:00:01.000Z' }),
  ].join('\n') + '\n'
}

function makeCtx() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cmd-'))
  const registryDir = join(home, 'dsh-chat-import')
  mkdirSync(registryDir, { recursive: true })
  const sessions = new Map() // id → { header, events }
  const attached = []
  const registered = []
  const commands = []

  const fs = {
    async resolve(path) { return { targetKey: path, displayPath: path } },
    async stat(target) {
      try {
        const st = statSync(target.targetKey)
        return { type: st.isDirectory() ? 'directory' : 'file', size: st.size, version: String(st.mtimeMs) }
      } catch { return undefined }
    },
    async readText(target) { return readFileSync(target.targetKey, 'utf8') },
    async listDir(target) {
      // /import-all 走发现层目录扫描：真实列出目录项（mock 空 listDir 会让扫描落空）
      return readdirSync(target.targetKey, { withFileTypes: true }).map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
        target: { targetKey: join(target.targetKey, e.name), displayPath: join(target.targetKey, e.name) },
      }))
    },
    async writeText(target, content) { writeFileSync(target.targetKey, content, 'utf8'); return { path: target.targetKey } },
    processPath(target) { return target.targetKey },
  }
  const persistence = {
    async create(meta) { sessions.set(meta.id, { header: meta, events: [] }) },
    async append(id, events) { const s = sessions.get(id); if (s) s.events.push(...events) },
    async list() { return [...sessions.values()].map((s) => s.header) },
    async locate() { return undefined },
    async readFrom() { return undefined },
  }
  const workspaces = new Map()
  const workspaceRegistry = {
    async resolveByPath(p) { return workspaces.get(p) ?? null },
    async create(p) {
      // 模拟真实 workspaceRegistry：路径必须真实存在（fs.realpath 校验），
      // 不存在 → 失败 → attachToWorkspace 触发 REQ-39-lite 回退源目录
      let real = null
      try { if (statSync(p).isDirectory()) real = p } catch { real = null }
      if (!real) return undefined
      const ws = { path: p, attachSession: async (id) => attached.push({ ws: p, id }) }
      workspaces.set(p, ws)
      return ws
    },
  }
  const ctx = {
    fs,
    sessionPersistence: persistence,
    workspaceRegistry,
    tools: { register(def) { registered.push(def); return () => {} } },
    get(service) {
      if (service === 'workspaceRegistry') return workspaceRegistry
      if (service === 'sessionPersistence') return persistence
      return undefined // agentDefaultModel / llm 缺失 → 预算回退默认（不报错）
    },
    inject(serviceList, cb) {
      if (Array.isArray(serviceList) && serviceList.includes('commands')) {
        cb({ ...ctx, commands: { register(def) { commands.push(def); return () => {} } } })
      }
      return undefined
    },
  }
  return {
    ctx, registryDir, sessions, attached, registered,
    getCommand: (name) => commands.find((c) => c.name === (name || 'import')),
    getAllCommands: () => commands,
  }
}

function setup() {
  const env = makeCtx()
  registerTools(env.ctx, env.registryDir)
  registerImportCommand(env.ctx, env.registryDir)
  const cmd = env.getCommand()
  assert.ok(cmd, 'commands.register 应被调用（commands 服务在场）')
  return { ...env, cmd }
}

test('REQ-42 /import 命令注册契约（name/description/input.hint）', () => {
  const { cmd } = setup()
  assert.equal(cmd.name, 'import')
  assert.equal(cmd.input.hint, '<source> <path>')
  assert.ok(cmd.description.includes('/import <source> <path>'))
  assert.equal(typeof cmd.handler, 'function')
})

// REQ-42 所有命令 input.hint 非空：dsh-commands 的 normalizeDefinition 对空
// hint（hint: ''）会硬抛 TypeError，导致插件 apply 阶段加载失败、被 DSH 启动
// 校验自动回滚。凡带 input 的命令，hint 必须是含非空白字符的字符串。
test('REQ-42 全部命令 input.hint 非空（空 hint 会致插件加载失败回滚）', () => {
  const { getAllCommands } = setup()
  const commands = getAllCommands()
  assert.ok(commands.length >= 7, `应注册 7 条命令，实际 ${commands.length}`)
  for (const c of commands) {
    if (c.input) {
      assert.equal(typeof c.input.hint, 'string', `命令 ${c.name} 的 input.hint 应为字符串`)
      assert.ok(c.input.hint.trim().length > 0, `命令 ${c.name} 的 input.hint 不能为空（''）`)
    }
  }
})

test('REQ-42 /import claude <path>：单文件导入成功并落盘会话', async () => {
  const { cmd, sessions, attached } = setup()
  const file = join(mkdtempSync(join(tmpdir(), 'dsh-cmd-src-')), 'cmd-sess.jsonl')
  writeFileSync(file, simpleClaudeJsonl('cmd-sess'), 'utf8')

  const out = await cmd.handler({ rawInput: 'claude ' + file })
  assert.equal(out.kind, 'success')
  assert.ok(out.text.includes('已导入'), 'text: ' + out.text)
  assert.ok(out.text.includes('cmd-sess'), 'text 含会话 id: ' + out.text)
  assert.ok([...sessions.keys()].some((id) => id.includes('cmd-sess')),
    '会话已落盘（import-<src> 前缀）: ' + [...sessions.keys()].join(','))
  // REQ-39-lite：cwd 不可解析 → 回退源目录归组（mkdtemp 目录存在）
  assert.ok(attached.length > 0, '已归组到工作区')
  assert.ok(attached[0].ws.includes('cmd-src-'), '归组到源目录: ' + attached[0].ws)
})

test('REQ-42 /import：幂等重导跳过（源未变）', async () => {
  const { cmd } = setup()
  const file = join(mkdtempSync(join(tmpdir(), 'dsh-cmd-src2-')), 'cmd-sess.jsonl')
  writeFileSync(file, simpleClaudeJsonl('cmd-sess'), 'utf8')

  const first = await cmd.handler({ rawInput: 'claude ' + file })
  assert.equal(first.kind, 'success')
  const second = await cmd.handler({ rawInput: 'claude ' + file })
  assert.equal(second.kind, 'success')
  assert.ok(second.text.includes('已存在'), '重导应幂等跳过: ' + second.text)
})

test('REQ-42 /import：工具全名 import_claude 与客户端来源 id claude-code 均接受', async () => {
  const { cmd } = setup()
  const file = join(mkdtempSync(join(tmpdir(), 'dsh-cmd-src3-')), 'cmd-sess.jsonl')
  writeFileSync(file, simpleClaudeJsonl('cmd-sess'), 'utf8')

  const a = await cmd.handler({ rawInput: 'import_claude ' + file })
  assert.equal(a.kind, 'success', a.text)
  const b = await cmd.handler({ rawInput: 'claude-code ' + file })
  assert.equal(b.kind, 'success', b.text)
})

test('REQ-42 /import：qoder 短名与工具全名 import_qoder 均接受', async () => {
  const { cmd } = setup()
  const file = join(mkdtempSync(join(tmpdir(), 'dsh-cmd-src4-')), 'qoder-sess.jsonl')
  writeFileSync(file, [
    JSON.stringify({ sessionId: 'qoder-sess', type: 'user', cwd: 'D:\\no-such\\proj', message: { role: 'user', content: '你好' }, timestamp: '2026-08-01T10:00:00.000Z' }),
    JSON.stringify({ sessionId: 'qoder-sess', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] }, timestamp: '2026-08-01T10:00:01.000Z' }),
  ].join('\n') + '\n', 'utf8')

  const a = await cmd.handler({ rawInput: 'qoder ' + file })
  assert.equal(a.kind, 'success', a.text)
  const b = await cmd.handler({ rawInput: 'import_qoder ' + file })
  assert.equal(b.kind, 'success', b.text)
})

test('REQ-42 /import：未知来源报错', async () => {
  const { cmd } = setup()
  const out = await cmd.handler({ rawInput: 'foobar C:\\x.jsonl' })
  assert.equal(out.kind, 'error')
  assert.ok(out.text.includes('未知来源'), out.text)
})

test('REQ-42 /import：缺 path 报用法', async () => {
  const { cmd } = setup()
  const out = await cmd.handler({ rawInput: 'claude' })
  assert.equal(out.kind, 'error')
  assert.ok(out.text.includes('用法'), out.text)
  const empty = await cmd.handler({ rawInput: '' })
  assert.equal(empty.kind, 'error')
  assert.ok(empty.text.includes('用法'), empty.text)
})

// ── REQ-29 /import-all 批量命令 ───────────────────────────────────────────

test('REQ-29 /import-all：命令注册 + 指定路径批量导入 + 幂等重导跳过', async () => {
  const env = makeCtx()
  registerTools(env.ctx, env.registryDir)
  registerImportCommand(env.ctx, env.registryDir)
  const cmd = env.getCommand('import-all')
  assert.ok(cmd, 'import-all 命令应注册')
  assert.equal(cmd.input.hint, '[source] [path]')
  assert.ok(cmd.description.includes('/import-all'))

  const srcDir = mkdtempSync(join(tmpdir(), 'dsh-importall-src-'))
  const file = join(srcDir, 'all-sess.jsonl')
  writeFileSync(file, simpleClaudeJsonl('all-sess'), 'utf8')

  // 指定来源 + 路径：扫描 → 导入
  const first = await cmd.handler({ rawInput: 'claude ' + srcDir })
  assert.equal(first.kind, 'success', first.text)
  assert.ok(first.text.includes('扫描 1 个会话'), first.text)
  assert.ok(first.text.includes('新增 1'), first.text)
  assert.ok([...env.sessions.keys()].some((id) => id.includes('all-sess')))

  // 幂等：已导入 → 跳过（不再出现「新增」）
  const second = await cmd.handler({ rawInput: 'claude ' + srcDir })
  assert.equal(second.kind, 'success', second.text)
  assert.ok(!second.text.includes('新增 1'), second.text)
  assert.ok(second.text.includes('跳过'), second.text)
})

test('REQ-29 /import-all：仅路径（全部格式探测）+ 未知来源提示', async () => {
  const env = makeCtx()
  registerTools(env.ctx, env.registryDir)
  registerImportCommand(env.ctx, env.registryDir)
  const cmd = env.getCommand('import-all')

  // 首 token 不是来源名 → 整体按路径（无 format 时逐格式探测同一目录）
  const srcDir = mkdtempSync(join(tmpdir(), 'dsh-importall-src2-'))
  writeFileSync(join(srcDir, 'sess.jsonl'), simpleClaudeJsonl('sess'), 'utf8')
  const byPath = await cmd.handler({ rawInput: srcDir })
  assert.equal(byPath.kind, 'success', byPath.text)
  assert.ok(byPath.text.includes('新增 1'), byPath.text)

  // 来源名 typo（claude 前缀命中）→ 报未知来源而非静默当路径
  const typo = await cmd.handler({ rawInput: 'claud' })
  assert.equal(typo.kind, 'error')
  assert.ok(typo.text.includes('未知来源'), typo.text)
})

// ── REQ-65 /attach-workspaces ──────────────────────────────────────────────

test('REQ-65 /attach-workspaces：命令注册 + 按 imports registry 回填', async () => {
  const env = makeCtx()
  registerTools(env.ctx, env.registryDir)
  registerImportCommand(env.ctx, env.registryDir)
  const cmd = env.getCommand('attach-workspaces')
  assert.ok(cmd, 'attach-workspaces 命令应注册')
  assert.ok(cmd.description.includes('workspace'))

  // 先导入一个 Claude 会话，产生 imports registry 记录
  const file = join(mkdtempSync(join(tmpdir(), 'dsh-attach-src-')), 'attach-sess.jsonl')
  writeFileSync(file, simpleClaudeJsonl('attach-sess'), 'utf8')
  const importCmd = env.getCommand('import')
  const imported = await importCmd.handler({ rawInput: 'claude ' + file })
  assert.equal(imported.kind, 'success', imported.text)

  const before = env.attached.length
  const out = await cmd.handler({ rawInput: '' })
  assert.equal(out.kind, 'success', out.text)
  assert.ok(out.text.includes('扫描 1 条导入记录'), out.text)
  assert.ok(out.text.includes('已挂接 1'), out.text)
  assert.ok(env.attached.length >= before, 'attach 应被再次调用/回填')
})

// ── REQ-66 /doctor ─────────────────────────────────────────────────────────

test('REQ-66 /doctor：命令注册 + 导入后健康检查通过', async () => {
  const env = makeCtx()
  registerTools(env.ctx, env.registryDir)
  registerImportCommand(env.ctx, env.registryDir)
  const cmd = env.getCommand('doctor')
  assert.ok(cmd, 'doctor 命令应注册')
  assert.ok(cmd.description.includes('健康检查'))

  // 未导入时 registry 为空：会报 issue，但命令仍可执行
  const empty = await cmd.handler({ rawInput: '' })
  assert.equal(empty.kind, 'error', empty.text)
  assert.ok(empty.text.includes('registry 为空'), empty.text)

  // 导入一个会话后：registry 有记录、会话存在、workspaceRegistry 可用 → 健康
  const file = join(mkdtempSync(join(tmpdir(), 'dsh-doctor-src-')), 'doctor-sess.jsonl')
  writeFileSync(file, simpleClaudeJsonl('doctor-sess'), 'utf8')
  const importCmd = env.getCommand('import')
  const imported = await importCmd.handler({ rawInput: 'claude ' + file })
  assert.equal(imported.kind, 'success', imported.text)

  const out = await cmd.handler({ rawInput: '' })
  assert.equal(out.kind, 'success', out.text)
  assert.ok(out.text.includes('会话 1 个'), out.text)
})

// ── REQ-74（缓存重置）/import-reset ────────────────────────────────────────

test('REQ-74 /import-reset：清空扫描缓存与持久书签，不影响导入', async () => {
  const env = makeCtx()
  registerTools(env.ctx, env.registryDir)
  registerImportCommand(env.ctx, env.registryDir)
  const cmd = env.getCommand('import-reset')
  assert.ok(cmd, 'import-reset 命令应注册')
  assert.ok(cmd.description.includes('扫描缓存'))

  // 制造一个持久书签文件
  const cacheFile = join(env.registryDir, 'scan-cache.json')
  writeFileSync(cacheFile, JSON.stringify({ version: 1, bookmarks: {} }), 'utf8')
  assert.ok(existsSync(cacheFile))

  const out = await cmd.handler({ rawInput: '' })
  assert.equal(out.kind, 'success', out.text)
  assert.ok(out.text.includes('扫描缓存已清空'), out.text)
  assert.ok(!existsSync(cacheFile), 'scan-cache.json 已删除')
})

// ── REQ-70 workspaceMode：/attach-workspaces --mode dedicated ────────────────

test('REQ-70 /attach-workspaces：dedicated 模式把所有导入会话挂到单个工作区', async () => {
  const env = makeCtx()
  registerTools(env.ctx, env.registryDir)
  registerImportCommand(env.ctx, env.registryDir)
  const cmd = env.getCommand('attach-workspaces')
  assert.ok(cmd, 'attach-workspaces 命令应注册')

  const file = join(mkdtempSync(join(tmpdir(), 'dsh-dedicated-src-')), 'dedicated-sess.jsonl')
  writeFileSync(file, simpleClaudeJsonl('dedicated-sess'), 'utf8')
  const importCmd = env.getCommand('import')
  const imported = await importCmd.handler({ rawInput: 'claude ' + file })
  assert.equal(imported.kind, 'success', imported.text)

  const dedicatedDir = join(mkdtempSync(join(tmpdir(), 'dsh-dedicated-ws-')), 'workspace')
  const out = await cmd.handler({ rawInput: '--mode dedicated --dir ' + dedicatedDir })
  assert.equal(out.kind, 'success', out.text)
  assert.ok(out.text.includes('模式 dedicated'), out.text)
  assert.ok(out.text.includes('已挂接 1'), out.text)
  assert.ok(env.attached.some((a) => a.ws === dedicatedDir), '会话挂到 dedicated workspace: ' + JSON.stringify(env.attached))
})
