// index-budget-preview.test.mjs — 预算保护与 dry-run 预览
// 超长会话三层保护 + 预算自适应；preview / dryRun 零副作用。
// 由 test/index.test.mjs 按横幅分组拆出（纯移动：用例与断言未改）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { resolveRegistryDir, loadImports } from '../lib/imports.mjs'
import { hostAbs } from './_support/host-path.mjs'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { clearScanCache } from '../lib/discovery.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'
import { loadHostFixture as load } from './_support/fixtures.mjs'
import { opencodeTestSessions, makeOpencodeDb } from './_support/index-fixtures.mjs'

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
})

function hugeClaudeTurns(n, { giantAt = -1, giantChars = 1500 } = {}) {
  const lines = []
  const sessionId = 'sess-huge-001'
  for (let i = 1; i <= n; i++) {
    lines.push(JSON.stringify({ sessionId, type: 'user', cwd: hostAbs('D:/demo/proj'), message: { role: 'user', content: '问题' + i + '，' + '字'.repeat(18) } }))
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
  assert.equal(value.cwd, hostAbs('D:/demo/proj'))
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
  assert.equal(simple.cwd, hostAbs('D:/demo/proj'))
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
  assert.equal(a.cwd, hostAbs('E:/demo/opencode'))
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
