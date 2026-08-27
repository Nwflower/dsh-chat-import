// import-prefs.test.mjs — 导入偏好命名空间注册契约（registerImportPrefs）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerImportPrefs, IMPORT_SETTINGS_NAMESPACE } from '../lib/import-prefs.mjs'

// Cordis effect 契约回执镜像（与 test/index.test.mjs makeCtx.inject 同一套校验）：
// inject 回调返回值只允许函数 / 可空 / thenable / 可迭代，否则抛 TypeError: Invalid effect。
function validateEffect(effect) {
  if (effect === undefined || effect === null || typeof effect === 'function') return
  const invalid = typeof effect !== 'object' ||
    (!('then' in effect) && !(Symbol.iterator in effect) && !(Symbol.asyncIterator in effect))
  if (invalid) throw new TypeError('Invalid effect')
}

test('registerImportPrefs: settings 就绪时执行 inject 回调注册命名空间，回调返回值须通过 Cordis effect 校验', () => {
  const registered = []
  let returned
  const ctx = {
    inject(serviceList, cb) {
      assert.deepEqual(serviceList, ['settings'])
      const settings = {
        // 真实 SettingsProvider.register 返回 owner scope（普通对象）——作为 effect 非法
        register(ns, schema) {
          registered.push({ ns, schema })
          return { get() { return { importSystemPrompt: false } }, watch() {}, update() {}, replace() {} }
        },
      }
      returned = cb({ settings })
    },
  }
  registerImportPrefs(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].ns, IMPORT_SETTINGS_NAMESPACE)
  assert.ok(registered[0].schema) // schemastery Schema（函数形态），非空即注册收到
  // 回归锚点：修复前这里返回的是 register 的 owner scope，validateEffect 抛
  // TypeError: Invalid effect —— 正是桌面宿主（settings 就绪早、回调同步执行）启动崩溃点。
  assert.doesNotThrow(() => validateEffect(returned))
})

test('registerImportPrefs: register 抛错被吞掉、不向外抛（重复注册等不致命）', () => {
  let ran = false
  const ctx = {
    inject(_, cb) {
      ran = true
      // 回调容错后返回 undefined（合法 effect），且不外抛
      assert.equal(cb({ settings: { register() { throw new Error('namespace already registered') } } }), undefined)
    },
  }
  registerImportPrefs(ctx)
  assert.equal(ran, true)
})