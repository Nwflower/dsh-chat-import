// test/warm-projection.test.mjs — warmProjection 宿主契约单测（自包含）
//
// coldSnapshot 的宿主签名是 (meta, inheritedEventCount, events)：曾按旧签名只传
// sessionId，宿主侧 SessionLogOffset(inheritedEventCount=undefined) 抛
// "SessionLogOffset must be a non-negative safe integer, got undefined"，
// 预热每次失败（不影响导入结果，仅侧边栏标题不预热）。本用例钉住三参契约。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { warmProjection } from '../lib/import-core.mjs'

const meta = { id: 'import-ses-a', cwd: '/tmp/demo' }
const events = [{ seq: 0, type: 'user/message' }]

function makeCtx(coldSnapshot) {
  return {
    get(service) {
      if (service === 'sessionProjectionCache') return { coldSnapshot }
      if (service === 'sessionPersistence') {
        return { async inspect(_id) { return { meta, events } } }
      }
      return undefined
    },
  }
}

test('warmProjection：按宿主契约传 (meta, 0, events)，成功返回实测事件数', async () => {
  let captured = null
  const ok = await warmProjection(makeCtx((m, inherited, evs) => {
    captured = { meta: m, inheritedEventCount: inherited, events: evs }
  }), 'import-ses-a')
  // 成功 = 本次 inspect 读到的持久化事件数（落盘路径复用它刷新 storedEvents 基线，
  // 不再整读第二遍）；falsy（false）仍表示未读到。
  assert.equal(ok, 1)
  assert.equal(captured.meta, meta)
  assert.equal(captured.inheritedEventCount, 0)
  assert.equal(captured.events, events)
})

test('warmProjection：coldSnapshot 抛错不外泄、返回 false', async () => {
  const ok = await warmProjection(makeCtx(() => {
    throw new TypeError('SessionLogOffset must be a non-negative safe integer, got undefined')
  }), 'import-ses-a')
  assert.equal(ok, false)
})

test('warmProjection：服务缺席时静默跳过', async () => {
  const ctx = { get: () => undefined }
  assert.equal(await warmProjection(ctx, 'import-ses-a'), false)
})

test('warmProjection：inspect 返回非数组事件 → false（不计长度）', async () => {
  const ctx = {
    get(service) {
      if (service === 'sessionProjectionCache') return { coldSnapshot() {} }
      if (service === 'sessionPersistence') {
        return { async inspect() { return { meta, events: 'not-an-array' } } }
      }
      return undefined
    },
  }
  assert.equal(await warmProjection(ctx, 'import-ses-a'), false)
})
