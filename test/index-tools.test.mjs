// index-tools.test.mjs — 工具面与落点
// 导入会话工具完整可用（agentPresets / 默认模型绑定）、cwd 权威映射与 home 沙箱、expectedHash、workspaceMode、Reasonix WAL、Hermes lineage。
// 由 test/index.test.mjs 按横幅分组拆出（纯移动：用例与断言未改）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import { apply } from '../lib/index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { restampSession } from '../lib/import-core.mjs'
import { hostAbs } from './_support/host-path.mjs'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { tempDbPath, openSqliteFixture, freshDshHome } from './_support/tmp-db.mjs'
import { clearScanCache } from '../lib/discovery.mjs'
import { loadHostFixture as load } from './_support/fixtures.mjs'

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
})

function makeHermesLineageDb() {
  const dbPath = tempDbPath('dsh-hermes-', 'state.db')
  const db = openSqliteFixture(dbPath)
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

test('expectedHash: 正确哈希导入成功，错误哈希失败且不落盘', async () => {
  const raw = [
    JSON.stringify({ sessionId: 'sess-hash-001', type: 'user', cwd: hostAbs('D:/demo/proj'), message: { role: 'user', content: '你好' } }),
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

test('restamp: 时间戳平移到当前，保持相对间隔', () => {
  const out = { meta: { createdAt: 1000 }, events: [{ time: 1000 }, { time: 2000 }] }
  restampSession(out, { restamp: true })
  assert.ok(out.meta.createdAt > 1000, 'createdAt 被平移: ' + out.meta.createdAt)
  assert.equal(out.events[1].time - out.events[0].time, 1000, '相对间隔保持不变')
})

test('import_claude workspaceMode=dedicated: 导入会话挂到专用工作区', async () => {
  const raw = [
    JSON.stringify({ sessionId: 'sess-ws-001', type: 'user', cwd: hostAbs('D:/demo/proj'), message: { role: 'user', content: '你好' } }),
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
  assert.equal(call.meta.cwd, hostAbs('D:/demo/proj'))
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

test('REQ-39 沙箱防护：transcript cwd = 主目录 → 落入专用导入工作区（绝不把主目录当 workspace）', async () => {
  const home = homedir().replace(/[\\/]+$/, '')
  const jsonl = [
    JSON.stringify({ sessionId: 'sess-home-001', type: 'user', cwd: home, message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ sessionId: 'sess-home-001', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
  ].join('\n')
  const { ctx, attached } = makeCtx({ 'D:\\demo\\proj\\sess-home-001.jsonl': jsonl })
  apply(ctx)
  const value = await chatDef(ctx, 'claude').execute({ path: 'D:\\demo\\proj\\sess-home-001.jsonl' })
  // 主目录被显式跳过（沙箱 ACL 会拒绝 home 里的 temp/pwsh），落点是专用导入工作区；
  // 源文件目录**不**再被建成工作区（旧回退在宿主上必然被拒，只会留下空工作区）
  assert.equal(attached.length, 1)
  assert.equal(attached[0].ws, join(process.env.DSH_HOME, 'dsh-chat-import-workspace'))
  assert.equal(value.workspace, join(process.env.DSH_HOME, 'dsh-chat-import-workspace'))
  assert.equal(value.ungrouped, undefined, '已归组 → 不占 ungrouped 键')
})

test('REQ-39 Claude 权威映射：转录无 cwd → ~/.claude.json projects 命中真实路径', async () => {
  const home = homedir().replace(/[\\/]+$/, '')
  const jsonl = [
    JSON.stringify({ sessionId: 'sess-nocwd-001', type: 'user', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ sessionId: 'sess-nocwd-001', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
  ].join('\n')
  // 权威映射与 slug 解码都建立在 Claude 的 Windows 盘符约定上（会话目录名里的 '--' 是
  // 盘符边界标记，见 lib/convert/claude.mjs / decodeClaudeSlug）：带标记的目录名才产出
  // cwdHint，映射给出的是 `D:\work\my-proj` 这种跨平台绝对路径——Windows 上原样落 header，
  // POSIX 上没有该标记（也就没有 cwdHint）、会话退化为未分组。
  const root = 'D:\\demo\\claude\\projects\\D--work-my-proj'
  const tree = {
    [root]: 'dir',
    [root + '\\sess-nocwd-001.jsonl']: jsonl,
    [join(home, '.claude.json')]: JSON.stringify({ projects: { 'D:\\work\\my-proj': { folderName: 'my-proj' } } }),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: root + '\\sess-nocwd-001.jsonl' })
  assert.equal(value.status, 'imported')
  // meta.cwd = 权威映射结果（真实路径），非 slug 目录名
  const saved = persistence.sessions.get('import-sess-nocwd-001')
  // 分层断言：权威映射层（~/.claude.json projects）与平台无关——直接断言映射结果；
  // 落盘层按宿主 isAbsolute 决定保留与否，期望值用同一函数计算。
  const { resolveClaudeCwd } = await import('../lib/cwd-map.mjs')
  assert.equal(await resolveClaudeCwd(ctx, 'D--work-my-proj'), 'D:\\work\\my-proj')
  assert.equal(saved.meta.cwd, isAbsolute('D:\\work\\my-proj') ? 'D:\\work\\my-proj' : undefined)
})

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

test('REQ-22 import_claude 压缩：原生检查点 + compacted/compactions 报告 + schema', async () => {
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
  // 参数进 schema（历史别名，默认行为即尊重压缩）
  assert.equal(def.parameters.properties.compacted.type, 'boolean')
  // 默认导入即落原生压缩检查点
  const value = await def.execute({ path: 'D:\\demo\\claude\\projects\\p\\sess-comp-002.jsonl' })
  assert.equal(value.status, 'imported')
  assert.equal(value.compacted, true)
  assert.equal(value.compactions, 1)
  const saved = persistence.sessions.get('import-sess-comp-002')
  assert.equal(saved.events.filter((e) => e.type === 'turn/start').length, 2) // 全量历史留在日志里
  assert.equal(saved.events.filter((e) => e.type === 'compaction/summary').length, 1)
  const ck = saved.events.find((e) => e.type === 'user/message' && typeof e.surfaceOp === 'object')
  assert.equal(ck.data.source.plugin, 'compact')
  assert.equal(ck.data.content[0].text, '最终总结')
  // 兼容别名：compacted:true 与默认一致
  const value2 = await def.execute({ path: 'D:\\demo\\claude\\projects\\p\\sess-comp-002.jsonl', compacted: true, force: true })
  assert.equal(value2.compacted, true)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

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
