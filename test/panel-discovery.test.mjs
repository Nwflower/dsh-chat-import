// panel-discovery.test.mjs — 发现面板（src/client/discovery.js）里的纯函数：
// 从 bundle 切出来求值，测的就是发布的那份逻辑（面板没有 DOM 测试环境，组件本身只能读
// 源码断言，见 panel-layout.test.mjs）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** 切出 bundle 里一段 4 空格基准缩进的顶层声明（从 start 标记到同缩进的收尾行）。 */
function topLevel(startMarker, endMarker = '\n    }') {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, 'lib/client.js 缺少 ' + startMarker)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, startMarker + ' 没有可识别的收尾')
  return source.slice(start, end + endMarker.length)
}

const nextHot = new Function(
  topLevel('const NO_HOT = ', ';') + '\n' + topLevel('function nextHot(') + '\nreturn nextHot;',
)()

test('nextHot：进入点亮该行与所在分组，离开该行时连同分组一起熄灭', () => {
  const off = { key: null, group: null }
  const a = nextHot(off, 'a', null, 'G1')
  assert.deepEqual(a, { key: 'a', group: 'G1' })
  // 回归：此前离开行只熄灭行、分组状态是个恒等式（永不复位），组头一直亮着、折叠箭头一直露着
  assert.deepEqual(nextHot(a, null, 'a', 'G1'), off)
})

test('nextHot：交错的进入 / 离开不会熄掉新点亮的行', () => {
  const b = nextHot({ key: 'a', group: 'G1' }, 'b', null, 'G2')
  assert.deepEqual(b, { key: 'b', group: 'G2' })
  // 旧行 a 的失焦 / 离开晚到：点亮的已是 b，保持不变（同一个对象，不触发重渲染）
  assert.equal(nextHot(b, null, 'a', 'G1'), b)
  // 重复进入同一行（悬停后再聚焦行内按钮）返回同一个对象
  assert.equal(nextHot(b, 'b', null, 'G2'), b)
  // 没有分组信息时按 null 记
  assert.deepEqual(nextHot(b, 'c', null, undefined), { key: 'c', group: null })
})
