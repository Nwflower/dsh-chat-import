// test/_support/envelope.mjs — 落盘事件 envelope 的共享断言（各来源的导入集成用例共用）。
//
//   assertEnvelopeHygiene(events)  导入归属外置 registry（issue #34）：0.8.3 起日志不再写
//     session/imported 标记，事件 envelope 键收敛在宿主白名单内
//     （type / seq / time / data / surfaceOp / sourceEventSeqs），seq / time 为数字、data 必在。
import assert from 'node:assert/strict'

const ALLOWED = new Set(['type', 'seq', 'time', 'data', 'surfaceOp', 'sourceEventSeqs'])

export function assertEnvelopeHygiene(events) {
  assert.ok(events.every((e) => e.type !== 'session/imported'), '日志不得含 session/imported 标记')
  for (const e of events) {
    for (const key of Object.keys(e)) {
      assert.ok(ALLOWED.has(key), '事件 envelope 出现白名单外键: ' + key)
    }
    assert.equal(typeof e.seq, 'number')
    assert.equal(typeof e.time, 'number')
    assert.notEqual(e.data, undefined)
  }
}
