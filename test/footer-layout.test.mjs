// footer-layout.test.mjs — footer 槽「本按钮还能占多宽」的判定纯函数
// 夹具里的宽度都是 Chromium 实测值（256px 侧栏、宿主 `.footerActions` nowrap 行、
// 宿主 slot 出口是 display:contents 外壳，见 lib/footer-layout.mjs 的说明）。
// 本模块原样内联进 lib/client.js（scripts/build-client.mjs），这里测的就是浏览器里跑的那份。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  FOOTER_ICON_WIDTH,
  FOOTER_LABEL_PADDING,
  occupiesFooterLane,
  claimsFooterRow,
  footerLaneAvailable,
  measureFooterLane,
  resolveFooterSize,
  needsFooterWrap,
} from '../lib/footer-layout.mjs'
import { inlineModule } from '../scripts/build-client.mjs'

// 完整形态（图标 16 + 间距 8 + 「导入会话」+ 内边距 18）实测需要 98px
const NEEDED = 98

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
  display: 'flex', flexDirection: 'row', flexWrap: 'nowrap',
  paddingLeft: '0px', paddingRight: '0px', columnGap: '0px', position: 'static',
  __width: 0, __height: 0, ...extra,
})

/** 复刻宿主真实结构：row（256px、nowrap）> 槽出口（display:contents）+ 同槽条目 */
function fakeFooter(entries) {
  const row = fakeElement(laneStyle(), [], 256)
  const outlet = fakeElement({ display: 'contents', position: 'static', __width: 0, __height: 0 })
  row.children.push(outlet)
  outlet.parentElement = row
  const button = fakeElement({ display: 'flex', position: 'static', __width: 74.94, __height: 42 })
  const probe = fakeElement({ display: 'flex', position: 'absolute', __width: 80, __height: 22 })
  outlet.children.push(button, probe)
  button.parentElement = outlet
  probe.parentElement = outlet
  for (const entry of entries) {
    const sibling = fakeElement({
      position: 'static', __width: entry.width, __height: 42,
      marginLeft: (entry.margin || 0) + 'px', marginRight: (entry.margin || 0) + 'px',
    })
    outlet.children.push(sibling)
    sibling.parentElement = outlet
  }
  return { row, outlet, button, probe }
}

test('measureFooterLane：锚点是本按钮，跳过槽出口（display:contents）外壳', () => {
  const { row, button, probe } = fakeFooter([])
  const facts = measureFooterLane(button, probe, fakeView)
  assert.equal(facts.row, row)
  assert.equal(facts.lane, true)
  assert.equal(facts.wrapped, false)
  assert.equal(facts.wideOccupant, false)
  // 槽出口自己没有盒子，它对 available 的唯一影响只是「条目要经它展开收集」
  assert.equal(facts.needed, 80 + FOOTER_LABEL_PADDING)
  assert.equal(facts.available, 256)
})

test('measureFooterLane：#43 手机连接同槽（整宽条目被压到 181px）→ 换行各自独占一行', () => {
  // 占用者声明 width: calc(100% + 4px) 被 flex 压到 181.06px（外边距盒），留给本按钮 74.94
  const { button, probe } = fakeFooter([{ width: 181.06, margin: 0 }])
  const facts = measureFooterLane(button, probe, fakeView)
  assert.equal(facts.available, 74.94)
  // 占位 181.06 ≥ 半行（128）→ 认作整宽条目；放不下文字 → 换行让各方各占一整行
  assert.equal(facts.wideOccupant, true)
  assert.equal(needsFooterWrap({ ...facts }), true)
  // 注入 wrap 前的一帧仍是图标形态（36px，不挤别人）；容器 wrap 后落到 row
  assert.equal(resolveFooterSize({ ...facts }), 'icon')
  assert.equal(resolveFooterSize({ ...facts, wrapped: true }), 'row')
})

test('measureFooterLane：整宽占用者（width:100%）→ 连 36px 都放不下，同样换行', () => {
  const { button, probe } = fakeFooter([{ width: 256, margin: 0 }])
  const facts = measureFooterLane(button, probe, fakeView)
  assert.equal(facts.available, 0)
  assert.equal(facts.wideOccupant, true)
  assert.equal(resolveFooterSize({ ...facts }), 'icon')
  assert.equal(needsFooterWrap({ ...facts }), true)
})

test('measureFooterLane：两个整宽条目互相挤压（各占 40%）→ 不认整宽，缩成图标同排', () => {
  const { button, probe } = fakeFooter([{ width: 102.6, margin: 0 }, { width: 102.6, margin: 0 }])
  const facts = measureFooterLane(button, probe, fakeView)
  assert.equal(Math.round(facts.available * 100) / 100, 50.8)
  // 单个都不到半行：谁也没有「整行」的主张，缩成图标与它们同排（footer 不多占一行）
  assert.equal(facts.wideOccupant, false)
  assert.equal(needsFooterWrap({ ...facts }), false)
  assert.equal(resolveFooterSize({ ...facts }), 'icon')
})

test('claimsFooterRow：按实测占位是否过「半行」线判定整宽条目', () => {
  assert.equal(claimsFooterRow({ width: 181.06 }, 256), true)
  assert.equal(claimsFooterRow({ width: 128 }, 256), true)
  assert.equal(claimsFooterRow({ width: 127 }, 256), false)
  assert.equal(claimsFooterRow({ width: 78 }, 256), false) // #31 的半宽入口
  assert.equal(claimsFooterRow({ width: 100 }, 0), false)
  assert.equal(claimsFooterRow(null, 256), false)
})

test('measureFooterLane：浮层（fixed/absolute）与零尺寸条目不占行内空间', () => {
  const { row, outlet, button, probe } = fakeFooter([{ width: 200, margin: 0 }])
  // 同槽还有一个峰谷弹窗（fixed 浮层）与一个隐藏条目：都不该被算成占位
  for (const style of [{ position: 'fixed', __width: 300, __height: 120 }, { position: 'static', __width: 0, __height: 0 }]) {
    const extra = fakeElement({ marginLeft: '0px', marginRight: '0px', ...style })
    outlet.children.push(extra)
    extra.parentElement = outlet
  }
  const facts = measureFooterLane(button, probe, fakeView)
  assert.equal(facts.available, 256 - 200)
  assert.equal(facts.row, row)
})

test('measureFooterLane：纵排容器 → lane=false（issue #25 保持整宽、高度随内容）', () => {
  const { row, button, probe } = fakeFooter([])
  row.style.flexDirection = 'column'
  const facts = measureFooterLane(button, probe, fakeView)
  assert.equal(facts.lane, false)
  assert.equal(resolveFooterSize({ ...facts }), 'row')
  assert.equal(needsFooterWrap({ ...facts }), false)
})

test('measureFooterLane：已 wrap 的容器 → 整宽自占一行，判定不抖', () => {
  const { row, button, probe } = fakeFooter([{ width: 256, margin: 0 }])
  row.style.flexWrap = 'wrap'
  const facts = measureFooterLane(button, probe, fakeView)
  assert.equal(facts.wrapped, true)
  assert.equal(resolveFooterSize({ ...facts }), 'row')
  // 反事实口径：不换行时仍分不到 36px —— 保持独占一行，不会「还原 wrap → 又被挤压」抖动
  assert.equal(needsFooterWrap({ ...facts }), true)
})

test('measureFooterLane：无按钮 / 非浏览器视图 → 量不到，判定退回共享一行', () => {
  const { button, probe } = fakeFooter([])
  assert.deepEqual(measureFooterLane(null, probe, fakeView), { row: null, lane: false, wrapped: false, available: NaN, needed: NaN, wideOccupant: false })
  const facts = measureFooterLane(button, probe, {})
  assert.equal(facts.lane, false)
  assert.equal(resolveFooterSize({ ...facts }), 'row')
})

// —— 单一真相源：lib/client.js 里跑的就是本模块（scripts/build-client.mjs 去 export 后原样
// 内联），不再有「bundle 副本 + 逐字段同步」——上面这些用例测的就是发布出去的那份量法。
test('lib/client.js 原样内联本模块，量法与判定在 bundle 里只有一份实现', () => {
  const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const module = readFileSync(new URL('../lib/footer-layout.mjs', import.meta.url), 'utf8')
  assert.ok(bundle.includes(inlineModule('lib/footer-layout.mjs', module)),
    'lib/client.js 应原样内联 lib/footer-layout.mjs（改了模块后重跑 npm run build:client）')
  for (const name of ['measureFooterLane', 'resolveFooterSize', 'needsFooterWrap', 'footerLaneAvailable', 'claimsFooterRow', 'occupiesFooterLane']) {
    assert.equal(bundle.split('function ' + name + '(').length - 1, 1, name + ' 在 bundle 里应恰好一份实现')
    assert.equal(bundle.includes('const ' + name + ' ='), false, name + ' 不应再有片段内的同名副本')
  }
  assert.equal(bundle.includes('footerLaneFacts'), false, '旧的片段副本 footerLaneFacts 应已删除')
  assert.match(bundle, /const facts = measureFooterLane\(button, probeRef\.current\);/, 'ImportButton 直接调用模块的量法')
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

test('footerLaneAvailable：扣掉同槽占位、行内边距与条目间距', () => {
  assert.equal(footerLaneAvailable({ rowWidth: 256 }), 256)
  assert.equal(footerLaneAvailable({ rowWidth: 256, occupiedWidth: 156, itemCount: 3 }), 100)
  assert.equal(footerLaneAvailable({ rowWidth: 256, occupiedWidth: 156, gap: 4, itemCount: 3 }), 92)
  assert.equal(footerLaneAvailable({ rowWidth: 256, padding: 24, occupiedWidth: 220, itemCount: 2 }), 12)
  // 同槽占满整行 → 负值（连图标都放不下，交给 needsFooterWrap）
  assert.equal(footerLaneAvailable({ rowWidth: 256, occupiedWidth: 260, itemCount: 2 }), -4)
  assert.ok(Number.isNaN(footerLaneAvailable({ rowWidth: NaN })))
})

test('resolveFooterSize：放得下就共享一行（#31 的预期行为不回归）', () => {
  // #31 实测：256px 行 + 两个 78px 半宽入口 → 留给本按钮 100px ≥ 98px
  assert.equal(resolveFooterSize({ lane: true, available: 100, needed: NEEDED }), 'share')
  assert.equal(resolveFooterSize({ lane: true, available: NEEDED, needed: NEEDED }), 'share')
  // 独占整行（只有本按钮）时走 flex 增长，仍是 share
  assert.equal(resolveFooterSize({ lane: true, available: 256, needed: NEEDED }), 'share')
})

test('resolveFooterSize：放不下就缩成图标（与半宽入口抢同一行）', () => {
  // 三个半宽入口同槽：留给本按钮 74.94px（< 98px 的文字形态）
  assert.equal(resolveFooterSize({ lane: true, available: 74.94, needed: NEEDED }), 'icon')
  // 缩成图标后占用者涨回来，留给本按钮 36px —— 判定必须仍是图标（不来回抖）
  assert.equal(resolveFooterSize({ lane: true, available: FOOTER_ICON_WIDTH, needed: NEEDED }), 'icon')
  assert.equal(resolveFooterSize({ lane: true, available: 37, needed: NEEDED + FOOTER_LABEL_PADDING }), 'icon')
  // 两个整宽条目互相挤压（实测留给本按钮 50.8px）
  assert.equal(resolveFooterSize({ lane: true, available: 50.8, needed: NEEDED }), 'icon')
  // 图标都放不下也先取图标形态（换行由 needsFooterWrap 负责，见下）
  assert.equal(resolveFooterSize({ lane: true, available: 0, needed: NEEDED }), 'icon')
  assert.equal(resolveFooterSize({ lane: true, available: -4, needed: NEEDED }), 'icon')
})

test('resolveFooterSize：纵排 / 换行容器 / 找不到行 → 整宽自占一行', () => {
  // dsh-usage-stats 强制纵排（issue #25）、dsh-tokenledger 注入 wrap
  assert.equal(resolveFooterSize({ lane: false, available: 0, needed: NEEDED }), 'row')
  assert.equal(resolveFooterSize({ lane: true, wrapped: true, available: 256, needed: NEEDED }), 'row')
  // 量不到（未挂载 / 非浏览器 / 镜像未渲染）→ 维持共享一行
  assert.equal(resolveFooterSize({ lane: true, available: NaN, needed: NEEDED }), 'share')
  assert.equal(resolveFooterSize({ lane: true, available: 256, needed: NaN }), 'share')
})

test('resolveFooterSize：rail（收起）态恒为图标，不写宿主布局', () => {
  assert.equal(resolveFooterSize({ rail: true, lane: true, available: 256, needed: NEEDED }), 'icon')
  assert.equal(resolveFooterSize({ rail: true, lane: false, available: NaN, needed: NaN }), 'icon')
  assert.equal(needsFooterWrap({ rail: true, lane: true, available: 0 }), false)
})

test('needsFooterWrap：整宽条目同槽就换行各自独占一行；半宽入口不换行', () => {
  // #43 实测：整宽条目被压到 181.06px、留给本按钮 74.94px —— 放不下文字 → 换行
  assert.equal(needsFooterWrap({ lane: true, available: 74.94, needed: NEEDED, wideOccupant: true }), true)
  // cost-meter 费用卡（width:100%）同槽 → 同样换行（0.10.1 起的既有外观）
  assert.equal(needsFooterWrap({ lane: true, available: FOOTER_ICON_WIDTH, needed: NEEDED, wideOccupant: true }), true)
  // 半宽入口同槽（#31）：放不下文字时缩图标，不动宿主容器
  assert.equal(needsFooterWrap({ lane: true, available: 74.94, needed: NEEDED, wideOccupant: false }), false)
  assert.equal(needsFooterWrap({ lane: true, available: 100, needed: NEEDED, wideOccupant: false }), false)
  // 放得下就绝不动宿主容器，哪怕同槽有整宽条目
  assert.equal(needsFooterWrap({ lane: true, available: 150, needed: NEEDED, wideOccupant: true }), false)
  // 连 36px 图标都放不下 → 无论占用者是谁都要一行自己的位置
  assert.equal(needsFooterWrap({ lane: true, available: 0, needed: NEEDED, wideOccupant: false }), true)
  assert.equal(needsFooterWrap({ lane: true, available: -4, needed: NEEDED, wideOccupant: false }), true)
  assert.equal(needsFooterWrap({ lane: true, available: FOOTER_ICON_WIDTH - 1, needed: NEEDED, wideOccupant: false }), true)
  // 已是 wrap 容器（他人注入）时按反事实口径判定：占满整行仍应保持独占一行
  assert.equal(needsFooterWrap({ lane: true, wrapped: true, available: -4, needed: NEEDED, wideOccupant: true }), true)
  assert.equal(needsFooterWrap({ lane: false, available: 0, needed: NEEDED }), false)
  assert.equal(needsFooterWrap({ lane: true, available: NaN, needed: NEEDED }), false)
})
