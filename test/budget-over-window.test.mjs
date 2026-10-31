// budget-over-window.test.mjs — 显式预算（参数 / 环境变量）也要受模型窗口约束
//
// 背景（真实事故）：预算优先级里 param / env 两条分支直接 return，从不参照模型窗口。
// 调用方一旦填了一个大于窗口的数（例如 500000000），所有保护同时失效：整段历史
// 全量落盘，恢复对话时每轮请求都超模型上限 → 直接 400；而自动压缩本身也要发一次
// 超窗请求，于是那条会话彻底死锁，用户只能重导。
//
// 这里锁定的行为：能算出窗口上限时，param/env 也钳到上限（不报错、不阻塞导入），
// 并回报 clampedFrom 供结果如实标注；算不出窗口时保持原值（只钳已知量）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveImportBudget, DEFAULT_CONTEXT_BUDGET, IMPORT_BUDGET_ENV } from '../lib/budget.mjs'
import { apply } from '../lib/index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { resolveRegistryDir, loadImports } from '../lib/imports.mjs'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { clearScanCache } from '../lib/discovery.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'
import { loadHostFixture as load } from './_support/fixtures.mjs'
import { renderImportText } from '../lib/tools/import-render.mjs'

// 工具层用例要干净的宿主家目录（registry / 附件都不串味）
const beforeEachHome = () => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
}

const services = (contextWindow, defaultMaxTokens = 4096) => ({  agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  llm: { async resolveModelInfo() { return { context: { contextWindow }, defaultMaxTokens } } },
})

// 与动态预算同一条公式：窗口 − 输出上限 − max(25% 窗口, 40k)
const ceilingOf = (w, maxTokens = 4096) => w - maxTokens - Math.max(Math.floor(w * 0.25), 40000)

test('REQ 参数预算超过模型窗口可用上限：钳到上限并回报钳制前取值', async () => {
  const { ctx } = makeCtx({}, { services: services(100000) })
  const info = await resolveImportBudget(ctx, { budget: 500000000 })
  assert.equal(info.budget, ceilingOf(100000), '超窗预算必须钳到窗口可用上限')
  assert.equal(info.source, 'param')
  assert.equal(info.clampedFrom, 500000000, '必须回报钳制前的原值，供结果如实标注')
})

test('REQ 环境变量预算超过窗口：同样钳制（env 与 param 不能双标）', async () => {
  const { ctx } = makeCtx({}, { services: services(100000) })
  const prev = process.env[IMPORT_BUDGET_ENV]
  process.env[IMPORT_BUDGET_ENV] = String(ceilingOf(100000) * 3)
  try {
    const info = await resolveImportBudget(ctx, {})
    assert.equal(info.budget, ceilingOf(100000))
    assert.equal(info.source, 'env')
    assert.equal(info.clampedFrom, ceilingOf(100000) * 3)
  } finally {
    if (prev === undefined) delete process.env[IMPORT_BUDGET_ENV]
    else process.env[IMPORT_BUDGET_ENV] = prev
  }
})

test('REQ 预算在窗口内：原值保留，不标注钳制', async () => {
  const { ctx } = makeCtx({}, { services: services(100000) })
  const ok = ceilingOf(100000) - 1
  const info = await resolveImportBudget(ctx, { budget: ok })
  assert.equal(info.budget, ok)
  assert.equal(info.source, 'param')
  assert.equal(info.clampedFrom, undefined)
})

test('REQ 恰好等于上限：不钳（边界是「不超过」而非「严格小于」）', async () => {
  const { ctx } = makeCtx({}, { services: services(100000) })
  const edge = ceilingOf(100000)
  const info = await resolveImportBudget(ctx, { budget: edge })
  assert.equal(info.budget, edge)
  assert.equal(info.clampedFrom, undefined)
})

test('REQ 取不到模型窗口（无服务/解析失败）：不钳不改，绝不阻塞导入', async () => {
  const bare = makeCtx({}, {})
  assert.equal((await resolveImportBudget(bare.ctx, { budget: 500000000 })).budget, 500000000, '无窗口信号时保持原值')
  const thrown = makeCtx({}, {
    services: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      llm: { async resolveModelInfo() { throw new Error('adapter not found') } },
    },
  })
  const info = await resolveImportBudget(thrown.ctx, { budget: 500000000 })
  assert.equal(info.budget, 500000000)
  assert.equal(info.source, 'param')
})

test('REQ 窗口元数据存在但没有 contextWindow 字段：无上限可比，保持原值', async () => {
  const { ctx } = makeCtx({}, {
    services: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      llm: { async resolveModelInfo() { return { defaultMaxTokens: 4096 } } },
    },
  })
  const info = await resolveImportBudget(ctx, { budget: 500000000 })
  assert.equal(info.budget, 500000000)
})

test('REQ 小窗口模型：上限低于静态默认时按窗口钳，而不是按默认值放行', async () => {
  const { ctx } = makeCtx({}, { services: services(60000, 4096) })
  const info = await resolveImportBudget(ctx, { budget: DEFAULT_CONTEXT_BUDGET })
  assert.equal(info.budget, ceilingOf(60000))
  assert.equal(info.clampedFrom, DEFAULT_CONTEXT_BUDGET, '静态默认值同样要过窗口这关')
})

// —— 工具层：钳制必须能被调用方看见（落库值 + 结果字段 + 人类文案），不能只是内部改了数

const svc = (contextWindow) => ({
  agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
  llm: { async resolveModelInfo(provider, model) { return { provider, id: model, name: model, context: { contextWindow }, defaultMaxTokens: 4096 } } },
})

test('REQ 工具层超窗预算：落库的是钳后值，结果带 budgetClampedFrom，文案说明被钳', async () => {
  beforeEachHome()
  delete process.env[IMPORT_BUDGET_ENV]
  const simple = load('sess-simple-001.jsonl')
  const { ctx } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple }, { services: svc(100000) })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl', budget: 500000000 })
  assert.equal(value.status, 'imported')
  assert.equal(value.budgetClampedFrom, 500000000, '结果要如实回报钳制前的原值')
  const reg = await loadImports(resolveRegistryDir())
  assert.equal(reg.imports['D:\\demo\\proj\\sess-simple-001.jsonl'].budget, ceilingOf(100000), 'registry 落库必须是钳后值')
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [], '结果字段必须过输出 schema（budgetClampedFrom 已声明）')
  const text = renderImportText(value, { sourceLabel: 'Claude Code' })
  assert.match(text, /钳制/, '人类可读文案必须说出预算被窗口钳过')
})

test('REQ 工具层窗口未知时超窗预算照原值放行：钳制不阻塞导入', async () => {
  beforeEachHome()
  delete process.env[IMPORT_BUDGET_ENV]
  const simple = load('sess-simple-001.jsonl')
  const { ctx } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl', budget: 500000000 })
  assert.equal(value.status, 'imported')
  assert.equal(value.budgetClampedFrom, undefined, '无窗口信号 = 无从判断，不该假称钳制')
})
