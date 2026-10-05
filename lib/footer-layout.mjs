// lib/footer-layout.mjs — 侧栏 footer 槽「本按钮还能占多宽」的判定（纯函数）
//
// 浏览器侧跑的就是这一份：scripts/build-client.mjs 把本文件去掉 export、整体缩进后原样
// 内联进 lib/client.js（见该脚本文件头的「内联模块」），ImportButton 直接调用这里的
// measureFooterLane / resolveFooterSize / needsFooterWrap，测试直接 import 本模块。因此本文件
// 必须保持「零 import、只有顶格 export 声明、无跨行模板字符串」的纯模块形态。
//
// 背景：#31 / #35 / #39 / #43 是同一类问题的四次复发——footer 槽是宿主 ui-sidebar 的
// 一条不换行 flex 行（`.footerActions`：`display:flex` + 默认 `flex-wrap:nowrap`），
// 任何同槽条目进来都会和「导入会话」抢这条行。此前两条判据都已失效：
//
//   ① 选择器白名单认「占用者是谁」（cordis 徽标 / 插件市场 launcher / usage-billing /
//      cost-meter / 内置「手机连接」…）：来源还在增加、CSS-module 哈希类名跨构建不稳定，
//      永远追不上；
//   ② 按「本插件的槽元素内容被裁」判定（0.11.3）：`[data-slot='sidebar.footer.action']`
//      并不是本按钮——DSH 的 slot 出口是 ui-renderer 的 `SlotOutlet`，一个
//      `data-slot=<槽名>` + `ANCHOR_STYLE={display:'contents'}` 的外壳，所有条目都渲染在
//      它**内部**，外壳自身没有盒子：`scrollWidth`/`clientWidth` 恒为 0、`rect` 全 0。
//      于是「内容被裁」恒为 false、「同槽可见条目」恒为 0 个，判定在生产里恒不命中
//      （Chromium 实测：outlet clientWidth/scrollWidth = 0/0、父元素 children = 1）。
//
// 现在只问一个问题：**这条行里还剩多少宽度给本按钮**——同槽是谁、有几个、叫什么名字
// 都无关，也不写宿主的 DOM：
//
//   available = 行内容宽 − 同槽其它条目占位（含外边距）− 行间距 − 行自身内边距
//   needed    = 本按钮完整形态（图标 + 文字 + 左右内边距）所需宽度，由按钮内一个
//               脱离文档流的隐藏镜像量出，因此与按钮当前形态无关，判定不会自我振荡
//
// 三档形态（`resolveFooterSize`）：
//   share — 放得下 → `flex:1 1 auto` 与同槽条目共享一行（#31 的预期行为）；
//   icon  — 与「半宽入口」抢同一行且放不下文字 → 缩成 36×36 圆钮（图标保留、文字进
//           title / aria-label），绝不截断、绝不遮挡、绝不动宿主布局；
//   row   — 换行容器 / 纵排容器 / 找不到可共享的行 → 整宽自占一行。
//
// 唯一的宿主写操作（`needsFooterWrap`）：同槽有「整宽条目」（声明 `width:100%` /
// `calc(100% + 4px)` 这类，判据见 `claimsFooterRow`）且本按钮放不下时，把行换成 `wrap`
// 让各方各占一整行——保留 0.10.1 起对整宽占用者的既有处理，插件卸载时还原；连 36px
// 图标都放不下时同样换行。反事实口径（在 wrap 容器里也按「不换行时能分到多少」计）保证
// 判定在「注入 → 仍不足」之间稳定，不会来回抖。
//
// 量宽度的一步 `measureFooterLane` 也在这里：它只经 `view.getComputedStyle`（默认
// globalThis，即浏览器的 window）与元素自身的几何读 DOM，测试可注入假视图（见
// test/footer-layout.test.mjs 的假 DOM 用例）。

/** 图标形态宽度（与 rail 态同款 36×36 圆钮） */
export const FOOTER_ICON_WIDTH = 36

/** 完整形态左右内边距之和（对齐侧边栏「设置」按钮：`padding: 0 10px 0 8px`） */
export const FOOTER_LABEL_PADDING = 18

/** 「整宽条目」判据：同槽条目占到半行以上（半宽入口如 78px 的「检查更新」远低于此线） */
export const FOOTER_WIDE_OCCUPANT_RATIO = 0.5

/**
 * 行内条目是否占位。
 * @param {{position?: string, width?: number, height?: number}} entry 条目的计算样式与渲染尺寸
 * @returns {boolean} fixed / absolute 是浮层、不占行内空间；零尺寸条目（隐藏）同样不计
 */
export function occupiesFooterLane(entry) {
  if (!entry) return false
  if (entry.position === 'fixed' || entry.position === 'absolute') return false
  return entry.width > 0 && entry.height > 0
}

/**
 * 同槽条目是否本来就是「整宽条目」——它声明的是整行宽度，与本按钮同处一行只会互相压扁。
 * 半宽入口（`flex:0 0 auto` + 固定窄宽）不在此列，它们本该共享一行（issue #31）。
 *
 * 用渲染宽度而非声明值：CSS 里声明的 `width: calc(100% + 4px)` 经 `getComputedStyle` 已
 * 解析成像素、按 `style.width` 又读不到（类名里写的），因此这里按「实测占位 ≥ 半行」认。
 * 被 flex 压扁的整宽条目（issue #43 实测 181px / 容器 256px）仍过线。
 * @param {{width?: number}} entry 条目的外边距盒宽
 * @param {number} rowWidth 行内容宽
 * @returns {boolean}
 */
export function claimsFooterRow(entry, rowWidth) {
  if (!entry || !Number.isFinite(rowWidth) || rowWidth <= 0) return false
  return entry.width >= rowWidth * FOOTER_WIDE_OCCUPANT_RATIO
}

/**
 * 行内还剩多少宽度给本按钮。
 * @param {{rowWidth?: number, padding?: number, occupiedWidth?: number, gap?: number, itemCount?: number}} lane
 *   `rowWidth` 行内容宽（含内边距），`padding` 行左右内边距之和，`occupiedWidth` 同槽其它
 *   条目占位（外边距盒宽之和），`gap` 行间距，`itemCount` 行内条目总数（含本按钮）
 * @returns {number} 可用宽度；量不到行宽（未挂载 / 零宽）返回 NaN，调用方按「维持现状」处理
 */
export function footerLaneAvailable({ rowWidth, padding = 0, occupiedWidth = 0, gap = 0, itemCount = 1 } = {}) {
  if (!Number.isFinite(rowWidth)) return NaN
  return rowWidth - padding - occupiedWidth - gap * Math.max(0, itemCount - 1)
}

/**
 * 以本按钮为锚点量出它所在行的事实（宿主无关：视图经 `view` 注入，测试可传假 DOM）。
 *
 * 锚点必须是本按钮自己——`[data-slot=...]` 槽出口并不是本按钮：它是 ui-renderer 的
 * `SlotOutlet`，一个 `display:contents` 外壳（条目都渲染在它内部、外壳自己没有盒子），
 * 因此向上找行时要跳过它（多级嵌套一并跳过），行内条目也要经同款展开逐层收集。
 * @param {object} button 本插件按钮元素
 * @param {object|null} probe 完整形态宽度镜像元素（绝对定位 + hidden，仍参与布局计算）
 * @param {object} view 视图对象（默认 globalThis）：只用它的 `getComputedStyle`
 * @returns {{row: object|null, lane: boolean, wrapped: boolean, available: number, needed: number, wideOccupant: boolean}}
 *   `row` 宿主行元素（注入 wrap / 观测用）；`lane` 该行是横向的（纵排容器为 false）；
 *   `wrapped` 该行当前允许换行；`available` 不换行时还能分给本按钮的宽度（量不到为 NaN）；
 *   `wideOccupant` 同槽有「整宽条目」（见 `claimsFooterRow`）
 */
export function measureFooterLane(button, probe, view = globalThis) {
  const facts = { row: null, lane: false, wrapped: false, available: NaN, needed: NaN, wideOccupant: false }
  const styleOf = view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle.bind(view) : null
  if (!button || styleOf === null) return facts
  const probeRect = probe && probe.getBoundingClientRect()
  if (probeRect && probeRect.width > 0) facts.needed = probeRect.width + FOOTER_LABEL_PADDING
  let node = button
  while (node && node.parentElement) {
    const row = node.parentElement
    const cs = styleOf(row)
    if (cs.display === 'contents') { node = row; continue }
    if (cs.display !== 'flex' && cs.display !== 'inline-flex') {
      // 单子元素的普通包裹层不是行本身，真正的行还在上面
      if (row.children.length === 1) { node = row; continue }
      return facts
    }
    facts.row = row
    facts.lane = cs.flexDirection.startsWith('row')
    facts.wrapped = cs.flexWrap !== 'nowrap'
    if (!facts.lane) return facts
    let occupiedWidth = 0
    let itemCount = 1 // 本按钮自己
    let wideOccupant = false
    const collect = (container) => {
      for (const child of container.children) {
        const childCs = styleOf(child)
        // 槽出口（display:contents）把条目摊进行里：继续展开，别把它当成一个条目
        if (childCs.display === 'contents') { collect(child); continue }
        if (child.contains(button)) continue // 本按钮所在的条目（含包裹层）不算「其它」
        const rect = child.getBoundingClientRect()
        if (!occupiesFooterLane({ position: childCs.position, width: rect.width, height: rect.height })) continue
        const marginBox = rect.width + (parseFloat(childCs.marginLeft) || 0) + (parseFloat(childCs.marginRight) || 0)
        occupiedWidth += marginBox
        itemCount += 1
        if (claimsFooterRow({ width: marginBox }, row.clientWidth)) wideOccupant = true
      }
    }
    collect(row)
    facts.wideOccupant = wideOccupant
    facts.available = footerLaneAvailable({
      rowWidth: row.clientWidth,
      padding: (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0),
      occupiedWidth,
      gap: parseFloat(cs.columnGap) || 0,
      itemCount,
    })
    return facts
  }
  return facts
}

/**
 * 本按钮该用哪种形态。
 * `icon` 这一档只服务「与半宽入口抢同一行且放不下文字」：同槽有整宽条目时换行各自独占
 * 一行（见 `needsFooterWrap`），注入 wrap 后 `wrapped` 为真、形态随之落到 `row`。
 * @param {{rail?: boolean, lane?: boolean, wrapped?: boolean, available?: number, needed?: number}} facts
 *   `lane` 本按钮处在一条横向 flex 行里；`wrapped` 该行当前允许换行（自己或其它插件注入）
 * @returns {'share'|'icon'|'row'}
 */
export function resolveFooterSize(facts = {}) {
  if (facts.rail === true) return 'icon'
  if (facts.lane !== true || facts.wrapped === true) return 'row'
  const available = Number(facts.available)
  const needed = Number(facts.needed)
  // 量不到（未挂载 / 非浏览器）或镜像未渲染：维持共享一行的既有形态
  if (!Number.isFinite(available) || !Number.isFinite(needed) || needed <= 0) return 'share'
  return available >= needed ? 'share' : 'icon'
}

/**
 * 是否要把宿主行换成 `wrap`、各方各占一整行。
 *
 * 两种情况：
 *   ① 同槽有「整宽条目」（`claimsFooterRow`）而本按钮放不下——它本来就要占满一行，同处
 *      一行只会互相压扁，换行后各占一行（0.10.1 起对整宽占用者的既有处理）；
 *   ② 连 36px 图标都放不下——无论占用者是谁，本按钮都需要一行自己的位置。
 * 放得下（`available ≥ needed`）时恒 false：不动宿主布局。
 * 判定用「不换行时能分到多少」（available 是反事实口径），因此已在 wrap 容器里且空间
 * 仍不足时保持 true（不来回抖），占用者消失后 available 回升即自动还原。
 * @param {{rail?: boolean, lane?: boolean, available?: number, needed?: number, wideOccupant?: boolean}} facts
 * @returns {boolean}
 */
export function needsFooterWrap(facts = {}) {
  if (facts.rail === true || facts.lane !== true) return false
  const available = Number(facts.available)
  if (!Number.isFinite(available)) return false
  if (available < FOOTER_ICON_WIDTH) return true
  const needed = Number(facts.needed)
  if (Number.isFinite(needed) && needed > 0 && available >= needed) return false
  return facts.wideOccupant === true
}
