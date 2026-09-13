// footer-layout.test.mjs — footer 槽同槽挤压判定纯函数
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isFooterSqueezed, isFooterOccupant } from '../lib/footer-layout.mjs'

const entry = (extra = {}) => ({ visible: true, position: 'static', width: 100, height: 42, ...extra })

test('isFooterSqueezed：内容超出可视宽度即被裁；等宽/取整差 1px 不算', () => {
  assert.equal(isFooterSqueezed(120, 75), true)
  assert.equal(isFooterSqueezed(75, 75), false)
  assert.equal(isFooterSqueezed(76, 75), false) // ellipsis 取整容差
  assert.equal(isFooterSqueezed(77, 75), true)
  assert.equal(isFooterSqueezed(NaN, 75), false)
})

test('isFooterOccupant：整宽条目是占用者（未被挤压时按几何判定）', () => {
  const context = { containerWidth: 256, squeezed: false }
  assert.equal(isFooterOccupant(entry({ width: 260 }), context), true) // calc(100% + 4px)
  assert.equal(isFooterOccupant(entry({ width: 256 }), context), true)
  assert.equal(isFooterOccupant(entry({ width: 255 }), context), true) // 1px 取整容差
})

test('isFooterOccupant：半宽入口共享一行不算占用者（#31 的预期行为不回归）', () => {
  const context = { containerWidth: 256, squeezed: false }
  assert.equal(isFooterOccupant(entry({ width: 120 }), context), false)
  assert.equal(isFooterOccupant(entry({ width: 180 }), context), false)
})

test('isFooterOccupant：本按钮已被裁时，同槽任何占位条目都算（占用者常被一并压扁）', () => {
  // #43 实测：占用者 calc(100%+4px) 声明、被 flex 压到 185px，容器 256px
  const context = { containerWidth: 256, squeezed: true }
  assert.equal(isFooterOccupant(entry({ width: 185 }), context), true)
  assert.equal(isFooterOccupant(entry({ width: 40 }), context), true)
})

test('isFooterOccupant：不可见 / 脱离文档流 / 零尺寸的条目不计入', () => {
  const context = { containerWidth: 256, squeezed: true }
  assert.equal(isFooterOccupant(entry({ visible: false, width: 260 }), context), false)
  assert.equal(isFooterOccupant(entry({ position: 'fixed', width: 260 }), context), false)
  assert.equal(isFooterOccupant(entry({ position: 'absolute', width: 260 }), context), false)
  assert.equal(isFooterOccupant(entry({ width: 0 }), context), false)
  assert.equal(isFooterOccupant(entry({ height: 0 }), context), false)
  assert.equal(isFooterOccupant(null, context), false)
})
