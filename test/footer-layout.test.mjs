// footer-layout.test.mjs — footer 槽规范 v1 容量判定纯函数（resolveFooterForm / measureFooterLane）
// 夹具里的宽度都是 Chromium 实测值（256px 侧栏、宿主 `.footerActions` nowrap 行、
// 宿主 slot 出口是 display:contents 外壳，见 lib/footer-layout.mjs 的说明）。
// 本模块原样内联进 lib/client.js（scripts/build-client.mjs），这里测的就是浏览器里跑的那份。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  FOOTER_ICON_WIDTH,
  MAX_LABEL_BOX,
  COUNT_LIMIT,
  ROW_GAP,
  ROW_PADDING,
  occupiesFooterLane,
  measureFooterLane,
  resolveFooterForm,
} from '../lib/footer-layout.mjs'
import { inlineModule } from '../scripts/build-client.mjs'

// —— 假 DOM：只实现 measureFooterLane 读到的面（parentElement / children /
// clientWidth / contains / getBoundingClientRect + getComputedStyle 视图）——
function fakeElement(style, children = [], clientWidth = 0) {
  const node = {
    style,
    children,
    clientWidth,
    parentElement: null,
    contains(target) { return target === node || children.some((child) => child.contains(target)) },
    getBoundingClientRect() { return { width: style.__width || 0, height: style.__height || 0, left: 0, top: 0 } },
  }
  for (const child of children) child.parentElement = node
  return node
}
const fakeView = { getComputedStyle: (node) => node.style }
const laneStyle = (extra = {}) => ({
  display: 'flex', flexDirection: 'row', flexWrap: 'nowrap', position: 'static',
  __width: 0, __height: 0, ...extra,
})

/** 复刻宿主真实结构：row（默认 256px、nowrap）> 槽出口（display:contents）> 本按钮 + 同槽条目 */
function fakeFooter(entries, rowWidth = 256) {
  const row = fakeElement(laneStyle(), [], rowWidth)
  const outlet = fakeElement({ display: 'contents', position: 'static', __width: 0, __height: 0 })
  row.children.push(outlet)
  outlet.parentElement = row
  const button = fakeElement({ display: 'flex', position: 'static', __width: 74.94, __height: 42 })
  outlet.children.push(button)
  button.parentElement = outlet
  for (const entry of entries) {
    const sibling = fakeElement({ display: 'flex', position: 'static', __width: entry.width, __height: 42 })
    outlet.children.push(sibling)
    sibling.parentElement = outlet
  }
  return { row, outlet, button }
}

// —— measureFooterLane：facts.count 含本按钮、rowWidth 取行 clientWidth ——

test('measureFooterLane：锚点是本按钮，跳过槽出口（display:contents）外壳；count 含自己、rowWidth 取行宽', () => {
  const { row, button } = fakeFooter([])
  const facts = measureFooterLane(button, fakeView)
  assert.equal(facts.row, row)
  assert.equal(facts.lane, true)
  assert.equal(facts.wrapped, false)
  assert.equal(facts.count, 1) // 只有本按钮一个占位者
  assert.equal(facts.rowWidth, 256) // row.clientWidth
})

test('measureFooterLane：count 数同一行占位者（含本按钮），条目经槽出口展开收集', () => {
  const { button } = fakeFooter([{ width: 78 }, { width: 78 }])
  const facts = measureFooterLane(button, fakeView)
  assert.equal(facts.count, 3)
  assert.equal(facts.rowWidth, 256)
  // 3 个占位者超上限 → 全 icon（各插件同一规则独立求值即收敛）
  assert.equal(resolveFooterForm(facts.count, facts.rowWidth), 'icon')
})

test('measureFooterLane：多级 display:contents 外壳与单子元素包裹层都跳过，行还是那条行', () => {
  const { row, outlet, button } = fakeFooter([{ width: 78 }])
  // 本按钮外再套一层 contents 外壳 + 一层单子元素普通包裹层
  const inner = fakeElement({ display: 'contents', position: 'static', __width: 0, __height: 0 })
  const wrap = fakeElement({ display: 'block', position: 'static', __width: 0, __height: 0 })
  outlet.children.splice(outlet.children.indexOf(button), 1, inner)
  inner.parentElement = outlet
  inner.children.push(wrap)
  wrap.parentElement = inner
  wrap.children.push(button)
  button.parentElement = wrap
  const facts = measureFooterLane(button, fakeView)
  assert.equal(facts.row, row)
  assert.equal(facts.count, 2) // 本按钮 + 1 个同槽条目（包裹层不算占位者）
})

test('measureFooterLane：浮层（fixed/absolute）与零尺寸条目不占行内空间、不计入 count', () => {
  const { outlet, button } = fakeFooter([{ width: 200 }])
  // 同槽还有一个峰谷弹窗（fixed 浮层）与一个隐藏条目：都不该被算成占位者
  for (const style of [{ position: 'fixed', __width: 300, __height: 120 }, { position: 'static', __width: 0, __height: 0 }]) {
    const extra = fakeElement({ display: 'flex', ...style })
    outlet.children.push(extra)
    extra.parentElement = outlet
  }
  const facts = measureFooterLane(button, fakeView)
  assert.equal(facts.count, 2) // 本按钮 + 200px 条目
  assert.equal(facts.rowWidth, 256)
})

test('measureFooterLane：判定输入与自身形态无关——按钮已是 icon 或 label，count/rowWidth 同款', () => {
  const wide = fakeFooter([{ width: 78 }])
  const narrow = fakeFooter([{ width: 78 }])
  narrow.button.style.__width = FOOTER_ICON_WIDTH // 已缩成图标
  narrow.button.style.__height = 36
  const a = measureFooterLane(wide.button, fakeView)
  const b = measureFooterLane(narrow.button, fakeView)
  assert.equal(a.count, b.count)
  assert.equal(a.rowWidth, b.rowWidth)
  assert.equal(resolveFooterForm(a.count, a.rowWidth), resolveFooterForm(b.count, b.rowWidth))
})

test('measureFooterLane：纵排容器 → lane=false（row 形态整宽自占一行，issue #25）', () => {
  const { row, button } = fakeFooter([])
  row.style.flexDirection = 'column'
  const facts = measureFooterLane(button, fakeView)
  assert.equal(facts.row, row)
  assert.equal(facts.lane, false)
  // lane=false 由 ImportButton 的 row 分支兜住，count/rowWidth 不再收集
  assert.equal(facts.count, 0)
  assert.ok(Number.isNaN(facts.rowWidth))
})

test('measureFooterLane：宿主/别人已 wrap 的容器 → wrapped=true（row 形态整宽自占一行）', () => {
  const { row, button } = fakeFooter([{ width: 256 }])
  row.style.flexWrap = 'wrap'
  const facts = measureFooterLane(button, fakeView)
  assert.equal(facts.wrapped, true)
  assert.equal(facts.lane, true)
  assert.equal(facts.count, 2)
})

test('measureFooterLane：无按钮 / 非浏览器视图 / 找不到 flex 行 → 量不到，ImportButton 落 row 分支', () => {
  assert.deepEqual(measureFooterLane(null, fakeView), { row: null, lane: false, wrapped: false, count: 0, rowWidth: NaN })
  const { button } = fakeFooter([])
  const noView = measureFooterLane(button, {})
  assert.equal(noView.row, null)
  assert.equal(noView.lane, false)
  // 按钮落在普通 block 容器（多子元素、非 flex 行）：同样找不到行
  const block = fakeElement({ display: 'block', position: 'static' }, [
    fakeElement({ display: 'flex', position: 'static', __width: 10, __height: 10 }),
    button,
  ])
  button.parentElement = block
  const blocked = measureFooterLane(button, fakeView)
  assert.equal(blocked.row, null)
  assert.equal(blocked.lane, false)
})

test('measureFooterLane + resolveFooterForm：实测行宽走容量边界（256px 独占 label；244/243 两人临界）', () => {
  const alone = measureFooterLane(fakeFooter([]).button, fakeView)
  assert.equal(resolveFooterForm(alone.count, alone.rowWidth), 'label') // 256 >= 128
  const crowded = measureFooterLane(fakeFooter([{ width: 78 }, { width: 78 }]).button, fakeView)
  assert.equal(resolveFooterForm(crowded.count, crowded.rowWidth), 'icon') // count=3 > 2
  const pair = measureFooterLane(fakeFooter([{ width: 78 }], 244).button, fakeView)
  assert.equal(resolveFooterForm(pair.count, pair.rowWidth), 'label') // count=2、244 >= 244
  const pairNarrow = measureFooterLane(fakeFooter([{ width: 78 }], 243).button, fakeView)
  assert.equal(resolveFooterForm(pairNarrow.count, pairNarrow.rowWidth), 'icon')
})

// —— resolveFooterForm：容量规则边界 ——

test('resolveFooterForm：required(count)=count*112+(count-1)*4+16，行宽达线才 label', () => {
  // count=1：required=128
  assert.equal(resolveFooterForm(1, 127), 'icon')
  assert.equal(resolveFooterForm(1, 128), 'label')
  // count=2：required=244
  assert.equal(resolveFooterForm(2, 243), 'icon')
  assert.equal(resolveFooterForm(2, 244), 'label')
  // 与常量同一份口径（单一真相源）
  const required = (count) => count * MAX_LABEL_BOX + (count - 1) * ROW_GAP + ROW_PADDING
  assert.equal(required(1), 128)
  assert.equal(required(2), 244)
  assert.equal(resolveFooterForm(2, required(2) - 1), 'icon')
  assert.equal(resolveFooterForm(2, required(2)), 'label')
})

test('resolveFooterForm：超过 COUNT_LIMIT 个占位者 → 任意行宽都 icon（全有或全无）', () => {
  assert.equal(COUNT_LIMIT, 2)
  assert.equal(resolveFooterForm(3, 256), 'icon')
  assert.equal(resolveFooterForm(3, 10000), 'icon')
  assert.equal(resolveFooterForm(3, Infinity), 'icon')
  assert.equal(resolveFooterForm(10, 10000), 'icon')
})

test('resolveFooterForm：count<=0 按 label 处理（参考实现口径：没有占位者就没有竞争）', () => {
  assert.equal(resolveFooterForm(0, 256), 'label')
  assert.equal(resolveFooterForm(0, 0), 'label')
  assert.equal(resolveFooterForm(0, NaN), 'label')
  assert.equal(resolveFooterForm(-1, NaN), 'label')
})

test('resolveFooterForm：量不到行宽（非有限）→ icon 安全态，不维持 label', () => {
  // 真实管线里「未挂载 / 找不到行」已由 lane=false → row 分支兜住，能走到这里的必须是
  // 已量到的横向行（clientWidth 恒有限）；仍出现非有限值说明视图异常，取 icon：不溢出
  // 行、不挤同槽条目，文字保留在 title / aria-label。与参考实现 NaN>=required 为 false 一致。
  for (const width of [NaN, Infinity, -Infinity, undefined]) {
    assert.equal(resolveFooterForm(1, width), 'icon')
    assert.equal(resolveFooterForm(2, width), 'icon')
  }
  // 量到零宽（行被隐藏）同样 icon
  assert.equal(resolveFooterForm(1, 0), 'icon')
})

test('occupiesFooterLane：浮层与零尺寸条目不占行内空间', () => {
  assert.equal(occupiesFooterLane({ position: 'static', width: 256, height: 42 }), true)
  assert.equal(occupiesFooterLane({ position: 'fixed', width: 256, height: 42 }), false)
  assert.equal(occupiesFooterLane({ position: 'absolute', width: 256, height: 42 }), false)
  assert.equal(occupiesFooterLane({ position: 'static', width: 0, height: 42 }), false)
  assert.equal(occupiesFooterLane({ position: 'static', width: 256, height: 0 }), false)
  assert.equal(occupiesFooterLane(null), false)
  // 宿主 slot 出口（display:contents 外壳）实测 clientWidth/scrollWidth/rect 全 0：
  // 以它为锚的「同槽条目」收集恒为空，这正是 0.11.3 判定失效的形态
  assert.equal(occupiesFooterLane({ position: 'static', width: 0, height: 0 }), false)
})

// —— 单一真相源：lib/client.js 里跑的就是本模块（scripts/build-client.mjs 去 export 后原样
// 内联），不再有「bundle 副本 + 逐字段同步」——上面这些用例测的就是发布出去的那份量法。
test('lib/client.js 原样内联本模块，量法与判定在 bundle 里只有一份实现', () => {
  const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const module = readFileSync(new URL('../lib/footer-layout.mjs', import.meta.url), 'utf8')
  assert.ok(bundle.includes(inlineModule('lib/footer-layout.mjs', module)),
    'lib/client.js 应原样内联 lib/footer-layout.mjs（改了模块后重跑 npm run build:client）')
  for (const name of ['measureFooterLane', 'resolveFooterForm', 'occupiesFooterLane']) {
    assert.equal(bundle.split('function ' + name + '(').length - 1, 1, name + ' 在 bundle 里应恰好一份实现')
    assert.equal(bundle.includes('const ' + name + ' ='), false, name + ' 不应再有片段内的同名副本')
  }
  // 旧配额判定、wrap 注入与宽度镜像全部删除（规范 v1：容量规则 + 不写宿主 DOM）
  for (const name of ['resolveFooterSize', 'needsFooterWrap', 'footerLaneAvailable', 'claimsFooterRow', 'FOOTER_LABEL_PADDING', 'FOOTER_WIDE_OCCUPANT_RATIO', 'FOOTER_PROBE_STYLE', 'probeRef']) {
    assert.equal(bundle.includes(name), false, name + ' 应已删除')
  }
  assert.match(bundle, /const facts = measureFooterLane\(button\);/, 'ImportButton 直接调用模块的量法（无镜像参数）')
  assert.match(bundle, /id: "chat-import", order: 20/, 'footer 注册 order 取会话/数据类 20–39 档（规范 v1 §5）')
})