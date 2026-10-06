// index-import-json-sources.test.mjs — 单文件 JSON / JSONL 来源集成（chatgpt / cursor / gemini / reasonix / pi）
// 逐来源的真实入口落盘、schema 校验与幂等。
// 由 test/index.test.mjs 按横幅分组拆出（纯移动：用例与断言未改）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { apply } from '../lib/index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { resolveRegistryDir, loadImports } from '../lib/imports.mjs'
import { clearWorkspacePathCache } from '../lib/cwd-map.mjs'
import { hostAbs } from './_support/host-path.mjs'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { clearScanCache } from '../lib/discovery.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'
import { loadHostFixture as load } from './_support/fixtures.mjs'

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
})

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
  assertEnvelopeHygiene(saved1.events)
  assertEnvelopeHygiene(saved2.events)
  // ChatGPT 无 cwd → 没有可用工作区：落入专用导入工作区（改写 cwd 后挂接），不再回退
  // 源文件目录——宿主只接受 cwd 与原工作区路径相等的挂接，源目录回退只会留下空工作区
  // 且会话仍留在「未分组」（docs/architecture.md D16）
  assert.equal(attached.length, 2)
  assert.ok(attached.every((a) => a.ws === join(process.env.DSH_HOME, 'dsh-chat-import-workspace')), '落点为专用导入工作区')
  assert.deepEqual(attached.map((a) => a.id).sort(), ['import-conv-001', 'import-conv-002'])
  // 结果里如实回报归组落点与「本次新建了工作区」（用户可见的侧栏副作用）
  assert.equal(value.workspace, join(process.env.DSH_HOME, 'dsh-chat-import-workspace'))
  assert.equal(value.workspaceMode, 'dedicated')
  assert.equal(value.workspaceCreated, true)
})

test('import_chatgpt 默认开关：无显式参数默认收集 system（默认开启），设置显式 false 还原过滤', async () => {
  const conv = {
    id: 'conv-sp-def',
    title: 'Default switch chat',
    create_time: 1710000000,
    mapping: {
      s1: { id: 's1', parent: null, children: ['u1'], message: { id: 'm0', author: { role: 'system' }, content: { content_type: 'text', parts: ['You are a helpful assistant.'] } } },
      u1: { id: 'u1', parent: 's1', children: ['a1'], message: { id: 'm1', author: { role: 'user' }, content: { content_type: 'text', parts: ['hi'] } } },
      a1: { id: 'a1', parent: 'u1', children: [], message: { id: 'm2', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['hello'] } } },
    },
  }
  const pluginEnv = (session) => {
    const ev = session.events.find((e) => e.data && e.data.source && e.data.source.kind === 'plugin')
    assert.ok(ev, '环境变更声明存在')
    return ev.data.content[0].text
  }
  // 默认（无 settings 服务 → readImportPrefs 回退默认 true）：system 原文随注入保留
  {
    const { ctx, persistence } = makeCtx({ 'D:\\demo\\chatgpt\\sp.json': JSON.stringify([conv]) })
    apply(ctx)
    await chatDef(ctx, 'chatgpt').execute({ path: 'D:\\demo\\chatgpt\\sp.json' })
    const saved = persistence.sessions.get('import-conv-sp-def')
    assert.ok(saved, '会话落盘')
    assert.ok(pluginEnv(saved).includes('You are a helpful assistant.'), '默认开启：system 原文随注入保留')
  }
  {
    // 显式存储 false（设置分区关闭）：过滤 system，仅环境变更声明
    const settingsStub = {
      register(ns, schema) { return { ns, schema } },
      get() { return { importSystemPrompt: false } },
      describe() { return [{ ns: 'chat-import', value: { importSystemPrompt: false }, revision: 1 }] },
      watch() {},
      async update() {},
    }
    const { ctx, persistence } = makeCtx({ 'D:\\demo\\chatgpt\\sp.json': JSON.stringify([conv]) }, { services: { settings: settingsStub } })
    apply(ctx)
    await chatDef(ctx, 'chatgpt').execute({ path: 'D:\\demo\\chatgpt\\sp.json' })
    const saved = persistence.sessions.get('import-conv-sp-def')
    assert.ok(!pluginEnv(saved).includes('You are a helpful assistant.'), '显式 false：仅环境变更声明')
  }
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
  const titleEv = saved.events.find((e) => e.type === 'session/title')
  assert.ok(titleEv, '应有 session/title 事件')
  assert.match(titleEv.data.title, /^Cursor · /)
  assert.equal(saved.events.at(-1).type, 'session/title')
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assertEnvelopeHygiene(saved.events)
})

test('import_cursor replace:true：同 id 覆盖重导，标题与正文更新', async () => {
  const path = 'D:\\demo\\cursor\\composer-abc.jsonl'
  const tree = { [path]: load('cursor-simple.jsonl') }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'cursor')
  const first = await def.execute({ path })
  assert.equal(first.alreadyImported, false)
  assert.equal(persistence.sessions.size, 1)

  tree[path] = load('cursor-dual-tool-same-step.jsonl')
  const replaced = await def.execute({ path, replace: true })
  assert.equal(replaced.status, 'replaced')
  // 输出 schema 必须声明 replaced 状态（宿主按 schema 校验工具返回值）
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, replaced), [])
  assert.equal(replaced.sessionId, 'import-composer-abc')
  assert.equal(persistence.sessions.size, 1)
  const saved = persistence.sessions.get('import-composer-abc')
  assert.ok(saved)
  const titleEv = saved.events.find((e) => e.type === 'session/title')
  assert.ok(titleEv)
  assert.match(titleEv.data.title, /^Cursor · /)
  const calls = saved.events.filter((e) => e.type === 'tool/call')
  assert.equal(calls.length, 2)
  const ids = calls.map((e) => e.data.callId)
  assert.equal(new Set(ids).size, 2)
  const user = saved.events.find((e) => e.type === 'user/message' && e.data.source.kind === 'user').data
  assert.ok(!user.content[0].text.includes('<timestamp>'))
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

test('import_cursor agent-transcripts：slug 解码 meta.cwd 为真实项目路径', async () => {
  clearWorkspacePathCache()
  const slug = 'e-dev-suite-demo-Client-app'
  const uuid = 'composer-abc'
  const path = `C:\\Users\\Administrator\\.cursor\\projects\\${slug}\\agent-transcripts\\${uuid}\\${uuid}.jsonl`
  // 同一套盘符约定：cursor 的 slug 与 storages 里的权威路径都带盘符，解码/映射出来的
  // 是 `E:\…` 这种跨平台绝对路径——Windows 上原样落 header 并归组，POSIX 上按宿主
  // isAbsolute 剔除（会话退化为未分组）。
  const realCwd = 'E:\\dev-suite\\demo.Client-app'
  const storages = join(process.env.DSH_HOME, 'profiles', 'web', 'storages')
  mkdirSync(storages, { recursive: true })
  writeFileSync(join(storages, 'workspace.json'), JSON.stringify([{ path: realCwd }]))
  const tree = {
    [path]: load('cursor-simple.jsonl'),
    'E:\\dev-suite': 'dir',
    [realCwd]: 'dir',
  }
  const { ctx, persistence, attached } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'cursor')
  const value = await def.execute({ path })

  assert.equal(value.mode, 'single')
  assert.equal(value.alreadyImported, false)
  const saved = persistence.sessions.get('import-composer-abc')
  assert.ok(saved)
  // 分层断言（避免写死平台分支）：解码层与平台无关——cursor 的 slug 自带盘符，解码
  // 走磁盘探测，直接断言解出的真实路径；落盘层是否保留 cwd 由宿主 isAbsolute 决定，
  // 期望值用同一函数计算（AGENTS.md 跨平台路径纪律）。
  const { resolveCursorSlugPath } = await import('../lib/cwd-map.mjs')
  assert.equal(await resolveCursorSlugPath(ctx, slug), realCwd)
  assert.equal(saved.meta.cwd, isAbsolute(realCwd) ? realCwd : undefined)
  // 无 cwd 时归组回退到源目录（lib/import-core.mjs 的 attachToWorkspace 回退），故仍有一条
  assert.equal(attached.length, 1)
  if (isAbsolute(realCwd)) assert.equal(attached[0].ws, realCwd)
})

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
  assert.equal(saved.meta.cwd, hostAbs('D:/demo/gemini-proj'))
  assert.equal(saved.events.at(-1).type, 'session/title')
  assert.match(saved.events.at(-1).data.title, /^Gemini · /)
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assertEnvelopeHygiene(saved.events)
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
  assert.equal(saved.meta.cwd, hostAbs('D:/Reasonix')) // meta.workspace → cwd
  assert.equal(saved.events.at(-1).type, 'session/title') // meta.summary → 标题
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assertEnvelopeHygiene(saved.events)
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

test('import_reasonix 目录 canonical：只折叠严格前缀且有明确 parent_id 的恢复祖先', async () => {
  const lines = (items) => items.map(([role, content]) => JSON.stringify({ role, content })).join('\n')
  const base = lines([['user', 'A'], ['assistant', 'X']])
  const left = lines([['user', 'A'], ['assistant', 'X'], ['user', 'B'], ['assistant', 'Y']])
  const right = lines([['user', 'A'], ['assistant', 'X'], ['user', 'C'], ['assistant', 'Z']])
  const meta = (id, parentId, updatedAt) => JSON.stringify({
    id,
    parent_id: parentId,
    logical_topic_id: 'logical-topic',
    topic_id: 'storage-topic',
    topic_title: 'Synthetic research',
    workspace_root: 'D:\\Synthetic',
    updated_at: updatedAt,
  })
  const tree = {
    'D:\\demo\\reasonix': 'dir',
    'D:\\demo\\reasonix\\base.jsonl': base,
    'D:\\demo\\reasonix\\base.jsonl.meta': meta('root', null, '1'),
    'D:\\demo\\reasonix\\left.jsonl': left,
    'D:\\demo\\reasonix\\left.jsonl.meta': meta('left', 'root', '3'),
    'D:\\demo\\reasonix\\right.jsonl': right,
    'D:\\demo\\reasonix\\right.jsonl.meta': meta('right', 'root', '2'),
  }
  const { ctx, persistence, attached } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'reasonix')
  assert.deepEqual(def.parameters.properties.lineageMode.enum, ['canonical', 'physical'])

  const preview = await def.execute({ path: 'D:\\demo\\reasonix', preview: true })
  assert.equal(preview.mode, 'batch')
  assert.equal(preview.total, 2)
  assert.ok(preview.results.every((item) => /Synthetic research（分支 [12]\/2）/.test(item.title)))
  assert.deepEqual(preview.results.map((item) => item.cwd), ['D:\\Synthetic', 'D:\\Synthetic'])
  assert.equal(persistence.sessions.size, 0)
  assert.equal(attached.length, 0)

  const imported = await def.execute({ path: 'D:\\demo\\reasonix' })
  assert.equal(imported.total, 2)
  assert.equal(imported.imported, 2)
  assert.deepEqual(new Set(persistence.sessions.keys()), new Set(['import-left', 'import-right']))
  assert.equal(attached.length, 2)
})

test('import_reasonix 目录 canonical：同 topic 但缺少明确谱系时保留全部文件', async () => {
  const line = (content) => JSON.stringify({ role: 'user', content })
  const meta = (id) => JSON.stringify({ id, topic_id: 'shared-topic', topic_title: 'Ambiguous' })
  const tree = {
    'D:\\demo\\reasonix': 'dir',
    'D:\\demo\\reasonix\\base.jsonl': line('A'),
    'D:\\demo\\reasonix\\base.jsonl.meta': meta('base'),
    'D:\\demo\\reasonix\\extended.jsonl': line('A') + '\n' + line('B'),
    'D:\\demo\\reasonix\\extended.jsonl.meta': meta('extended'),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'reasonix')
  const value = await def.execute({ path: 'D:\\demo\\reasonix' })
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.deepEqual(new Set(persistence.sessions.keys()), new Set(['import-base', 'import-extended']))
})

test('import_reasonix 目录 physical：显式恢复每个 JSONL 独立导入', async () => {
  const line = (content) => JSON.stringify({ role: 'user', content })
  const meta = (id, parentId) => JSON.stringify({ id, parent_id: parentId, topic_id: 'shared-topic' })
  const tree = {
    'D:\\demo\\reasonix': 'dir',
    'D:\\demo\\reasonix\\base.jsonl': line('A'),
    'D:\\demo\\reasonix\\base.jsonl.meta': meta('base', null),
    'D:\\demo\\reasonix\\extended.jsonl': line('A') + '\n' + line('B'),
    'D:\\demo\\reasonix\\extended.jsonl.meta': meta('extended', 'base'),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'reasonix')
  const value = await def.execute({ path: 'D:\\demo\\reasonix', lineageMode: 'physical' })
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.deepEqual(new Set(persistence.sessions.keys()), new Set(['import-base', 'import-extended']))
})

test('import_reasonix 目录 canonical：无 topic key 的独立现代 meta 文件仍派生 cwd/标题', async () => {
  const line = (content) => JSON.stringify({ role: 'user', content })
  const meta = (id) => JSON.stringify({ id, workspace_root: hostAbs('D:/Solo'), topic_title: 'Solo topic' })
  const tree = {
    'D:\\demo\\reasonix': 'dir',
    'D:\\demo\\reasonix\\solo.jsonl': line('A'),
    'D:\\demo\\reasonix\\solo.jsonl.meta': meta('solo'),
  }
  const { ctx } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'reasonix')
  const preview = await def.execute({ path: 'D:\\demo\\reasonix', preview: true })
  assert.equal(preview.total, 1)
  assert.equal(preview.results[0].cwd, hostAbs('D:/Solo'))
  assert.ok(preview.results[0].title.includes('Solo topic'))
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

test('import_pi 单文件：头行 cwd/id 落盘、归组、返回值符合 schema', async () => {
  const { ctx, persistence, attached } = makeCtx({ 'D:\\demo\\pi\\2025-06-01_pi-simple.jsonl': load('pi-simple.jsonl') })
  apply(ctx)
  const def = chatDef(ctx, 'pi')
  const value = await def.execute({ path: 'D:\\demo\\pi\\2025-06-01_pi-simple.jsonl' })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-019f0a11-2222-7333-8444-555566667777')
  assert.equal(value.turns, 2)
  assert.equal(value.messages, 4)
  assert.equal(value.alreadyImported, false)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get('import-019f0a11-2222-7333-8444-555566667777')
  assert.ok(saved)
  assert.equal(saved.meta.cwd, hostAbs('D:/demo/pi-proj'))
  assert.equal(saved.events.at(-1).type, 'session/title')
  assert.match(saved.events.at(-1).data.title, /^Pi · /)
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assertEnvelopeHygiene(saved.events)
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
