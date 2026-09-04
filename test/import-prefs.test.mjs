// import-prefs.test.mjs — 导入偏好命名空间注册契约（registerImportPrefs）+ 读取语义（readImportPrefs）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerImportPrefs, readImportPrefs, IMPORT_SETTINGS_NAMESPACE } from '../lib/import-prefs.mjs'

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

test('readImportPrefs：默认开启（缺服务/缺键/异常回退 true），仅显式 false 落为关闭', () => {
  // ctx.get('settings') → settings 服务；服务自身的 get(ns) → 存储值（两层各司其职）
  const ctxWith = (stored) => ({
    get(service) { return service === 'settings' ? { get() { return stored } } : undefined },
  })
  const DEFAULT = { importSystemPrompt: true, injectTools: true }
  // settings 服务缺席 / get 抛错 → 默认 true
  assert.deepEqual(readImportPrefs({ get(service) { return service === 'settings' ? undefined : undefined } }), DEFAULT)
  assert.deepEqual(readImportPrefs({ get() { throw new Error('service missing') } }), DEFAULT)
  assert.deepEqual(readImportPrefs({}), DEFAULT)
  // 服务 get 返回非对象 / 裸对象（未应用 schema 默认）→ 默认 true，降级形态不悄悄改回旧行为
  assert.deepEqual(readImportPrefs(ctxWith(undefined)), DEFAULT)
  assert.deepEqual(readImportPrefs(ctxWith({})), DEFAULT)
  assert.deepEqual(readImportPrefs(ctxWith('garbage')), DEFAULT)
  // 显式 true / 显式 false 均按存储值
  assert.deepEqual(readImportPrefs(ctxWith({ importSystemPrompt: true, injectTools: true })), { importSystemPrompt: true, injectTools: true })
  assert.deepEqual(readImportPrefs(ctxWith({ importSystemPrompt: false, injectTools: false })), { importSystemPrompt: false, injectTools: false })
  // 缺 injectTools 键 → 该键回退 true，另一键按存储值
  assert.deepEqual(readImportPrefs(ctxWith({ importSystemPrompt: false })), { importSystemPrompt: false, injectTools: true })
})

test('registerImportPrefs: onInjectToolsChange 在注册后初值对账一次，并在 injectTools 变化时再次触发', () => {
  const events = []
  let watchCb
  let current = { importSystemPrompt: true, injectTools: true }
  const ctx = {
    inject(serviceList, cb) {
      assert.deepEqual(serviceList, ['settings'])
      const settings = {
        register() {
          return {
            get() { return current },
            watch(cb2) { watchCb = cb2 },
            update() {}, replace() {},
          }
        },
      }
      cb({ settings })
    },
  }
  registerImportPrefs(ctx, (inject) => events.push(inject))
  assert.deepEqual(events, [true]) // 初值对账：默认 true
  // 变更 → 再次触发
  current = { importSystemPrompt: true, injectTools: false }
  watchCb()
  assert.deepEqual(events, [true, false])
  // 缺 injectTools 键（未应用 schema 默认的降级形态）→ 回退 true
  current = { importSystemPrompt: true }
  watchCb()
  assert.deepEqual(events, [true, false, true])
})