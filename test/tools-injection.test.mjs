// tools-injection.test.mjs — 工具注入档位（injectTools）契约：
// registerTools 默认注入 13 个工具并返回 reconcile；reconcile 三档对账——
// 'off'/false 注销全部、'minimal' 仅注入 import_chat 入口、'full'/true 重注册全部，
// 且 IMPORT_SPECS（面板/命令依赖）恒被填充、与注入档位无关。
// 另含描述长度护栏：工具常驻上下文成本（description + parameters）不得回肥。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerTools } from '../lib/tools.mjs'
import { IMPORT_SPECS } from '../lib/toolkit.mjs'

function makeToolCtx() {
  const registered = []
  let active = 0
  const ctx = {
    tools: {
      register(def) {
        registered.push(def)
        active++
        return () => { active-- }
      },
    },
    get() { return undefined },
  }
  return { ctx, registered, active: () => active }
}

test('registerTools：默认注入 13 个工具，IMPORT_SPECS 恒填充', () => {
  const { ctx, registered, active } = makeToolCtx()
  const reconcile = registerTools(ctx, '.tools-injection-test')
  assert.equal(typeof reconcile, 'function')
  assert.equal(registered.length, 13)
  assert.equal(active(), 13)
  // IMPORT_SPECS 在注册期即被 makeImportChatTool 填充（面板 POST /api-import/import 与
  // /import 命令依赖），与工具是否注入无关——即使注入关闭也照常可用
  assert.ok(IMPORT_SPECS.has('claude'), 'IMPORT_SPECS 应登记 claude 面板来源')
})

test("reconcile('off')：注销全部工具，IMPORT_SPECS 原样保留；幂等", () => {
  const toolCtx = makeToolCtx()
  const reconcile = registerTools(toolCtx.ctx, '.tools-injection-test')
  reconcile('off')
  assert.equal(toolCtx.active(), 0)
  assert.ok(IMPORT_SPECS.has('claude'), '注销工具不得清空 IMPORT_SPECS')
  // 幂等：重复 off 不重复注销、不抛错
  reconcile('off')
  assert.equal(toolCtx.active(), 0)
})

test("reconcile('minimal')：仅注入 import_chat 入口，其余 12 个不占常驻上下文", () => {
  const toolCtx = makeToolCtx()
  const reconcile = registerTools(toolCtx.ctx, '.tools-injection-test')
  reconcile('minimal')
  assert.equal(toolCtx.active(), 1)
  assert.ok(IMPORT_SPECS.has('claude'), 'minimal 档 IMPORT_SPECS 原样保留')
  // 幂等：重复 minimal 不重复注册
  reconcile('minimal')
  assert.equal(toolCtx.active(), 1)
  // minimal → off → minimal 往返
  reconcile('off')
  assert.equal(toolCtx.active(), 0)
  reconcile('minimal')
  assert.equal(toolCtx.active(), 1)
})

test("reconcile('full')：重注册全部 13 个；三档往返与历史 boolean 兼容", () => {
  const toolCtx = makeToolCtx()
  const reconcile = registerTools(toolCtx.ctx, '.tools-injection-test')
  // minimal → full：注册集合从 1 回到 13
  reconcile('minimal')
  reconcile('full')
  assert.equal(toolCtx.active(), 13)
  reconcile('full')
  assert.equal(toolCtx.active(), 13)
  // 历史 boolean 兼容：true = 'full'，false = 'off'
  reconcile(false)
  assert.equal(toolCtx.active(), 0)
  reconcile(true)
  assert.equal(toolCtx.active(), 13)
  // 注册次数累计：初始 13 + minimal 1 + full 13 + full 13 + full(true) 13 = 53
  //（注销只减 active，不清 registered 记录）
  assert.equal(toolCtx.registered.length, 53)
})

test('描述长度护栏：每个工具 description ≤ 500 字符，全量档常驻 payload ≤ 15k 字符', () => {
  const defs = []
  const measuringCtx = {
    tools: {
      register(def) { defs.push(def); return () => {} },
    },
    get() { return undefined },
  }
  registerTools(measuringCtx, '.tools-guard-test')
  // 常驻上下文成本 = 工具级 description + 参数级 description 之和（模型按此付费）。
  // 回肥护栏：细化行为说明请下沉到执行结果/错误文本（按需付费），而非膨胀 schema。
  let total = 0
  for (const def of defs) {
    const desc = (def.description || '').length
    const params = JSON.stringify(def.parameters || {}).length
    total += desc + params
    assert.ok(desc <= 500, `工具 ${def.name} description ${desc} 字符超过 500 上限（本次瘦身基线）`)
  }
  assert.equal(defs.length, 13)
  assert.ok(total <= 15000, `全量档 payload ${total} 字符超过 15000 上限（本次瘦身基线 ≈ 13.8k）`)
})
