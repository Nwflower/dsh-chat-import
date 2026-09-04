// tools-injection.test.mjs — 工具注入开关（injectTools）契约：
// registerTools 默认注入 13 个工具并返回 reconcile；reconcile(false) 注销全部、
// reconcile(true) 重注册，且 IMPORT_SPECS（面板/命令依赖）恒被填充、与注入开关无关。
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

test('registerTools：默认注入 13 个工具，reconcile 注销/重注册幂等，IMPORT_SPECS 恒填充', () => {
  const { ctx, registered, active } = makeToolCtx()
  const reconcile = registerTools(ctx, '.tools-injection-test')
  assert.equal(typeof reconcile, 'function')
  assert.equal(registered.length, 13)
  assert.equal(active(), 13)
  // IMPORT_SPECS 在注册期即被 makeImportChatTool 填充（面板 POST /api-import/import 与
  // /import 命令依赖），与工具是否注入无关——即使注入关闭也照常可用
  assert.ok(IMPORT_SPECS.has('claude'), 'IMPORT_SPECS 应登记 claude 面板来源')

  // 注入关闭（injectTools=false）→ 注销全部工具，但 IMPORT_SPECS 原样保留
  reconcile(false)
  assert.equal(active(), 0)
  assert.ok(IMPORT_SPECS.has('claude'), '注销工具不得清空 IMPORT_SPECS')

  // 幂等：重复关闭不重复注销、不抛错
  reconcile(false)
  assert.equal(active(), 0)

  // 重新开启 → 重注册全部工具；重复开启不重复注册
  reconcile(true)
  assert.equal(active(), 13)
  reconcile(true)
  assert.equal(active(), 13)
  assert.equal(registered.length, 26) // 13 初始 + 13 重注册（reconcile(false) 后重新 register）
})
