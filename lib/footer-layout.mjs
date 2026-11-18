// lib/footer-layout.mjs — 侧栏 footer 槽形态判定（纯函数，sidebar.footer.action 插件动作规范 v1）
//
// 浏览器侧跑的就是这一份：scripts/build-client.mjs 把本文件去掉 export、整体缩进后原样
// 内联进 lib/client.js（见该脚本文件头的「内联模块」），ImportButton 直接调用这里的
// measureFooterLane / resolveFooterForm，测试直接 import 本模块。因此本文件必须保持
// 「零 import、只有顶格 export 声明、无跨行模板字符串」的纯模块形态。
//
// 背景：footer 槽是宿主 ui-sidebar 的一条不换行 flex 行（`.footerActions`），同槽条目
// 抢这条行。历史上两条判据都已失效：① 选择器白名单认「占用者是谁」——来源还在增加、
// CSS-module 哈希类名跨构建不稳定，永远追不上；② 以 `[data-slot=...]` 槽出口为锚量
// 「内容被裁」——出口是 ui-renderer SlotOutlet 的 display:contents 外壳，条目都渲染在
// 它内部、外壳自己没有盒子（clientWidth/scrollWidth 恒 0），判定在生产里恒不命中。
//
// 规范 v1 改用与占用者身份无关的容量规则，且判定输入与本按钮自身形态无关（不再需要
// 宽度镜像，判定不会自我振荡）：
//
//   count    = 同一行内占位者数量（含本按钮；display:contents 外壳逐层展开收集）
//   rowWidth = 行可用内容宽（row.clientWidth；宿主 .footerActions 无 gap/padding，
//              间距由插件的 margin 出）
//   required(count) = count*MAX_LABEL_BOX + (count-1)*ROW_GAP + ROW_PADDING
//   showLabel = count<=COUNT_LIMIT && rowWidth>=required(count)
//
// 全有或全无：showLabel 为假时每个占位者都变 icon——各插件用同一规则同一输入独立
// 求值即收敛，不需要协商，也不写宿主 DOM（不再给宿主行注入 flex-wrap）。label/icon
// 是仅有的两种形态，无中间态；row 只保留给「容器形状」（纵排容器 lane=false / 宿主或
// 别人已做成换行的容器 wrapped=true），由 ImportButton 按 lane/wrapped 判定，整宽自占一行。
//
// 量宽度的一步 measureFooterLane 只经 view.getComputedStyle（默认 globalThis，即浏览器
// 的 window）与元素自身的几何读 DOM，测试可注入假视图（见 test/footer-layout.test.mjs
// 的假 DOM 用例）。锚点必须是本按钮自己——向上找行时跳过 display:contents 外壳（多级
// 嵌套一并跳过），行内条目也经同款展开逐层收集。

/** 图标形态宽度（36×36，与 rail 态同款；规范 v1 圆角 12px，不是 50%） */
export const FOOTER_ICON_WIDTH = 36

/** 容量规则（规范 v1 §B）：单个 label 盒宽上限，只用于容量估算，不是样式约束 */
export const MAX_LABEL_BOX = 112

/** 容量规则：同行至多 COUNT_LIMIT 个占位者可保留文字，超过则全部 icon */
export const COUNT_LIMIT = 2

/** 容量规则：相邻占位者之间预留的间距（两侧 margin 2px+2px 之和） */
export const ROW_GAP = 4

/** 容量规则：行左右预留的边距（侧栏 inline padding 8px×2） */
export const ROW_PADDING = 16

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
 * 以本按钮为锚点量出它所在行的事实（宿主无关：视图经 `view` 注入，测试可传假 DOM）。
 *
 * 锚点必须是本按钮自己——`[data-slot=...]` 槽出口并不是本按钮：它是 ui-renderer 的
 * `SlotOutlet`，一个 `display:contents` 外壳（条目都渲染在它内部、外壳自己没有盒子），
 * 因此向上找行时要跳过它（多级嵌套一并跳过），行内条目也要经同款展开逐层收集。
 * @param {object} button 本插件按钮元素
 * @param {object} view 视图对象（默认 globalThis）：只用它的 `getComputedStyle`
 * @returns {{row: object|null, lane: boolean, wrapped: boolean, count: number, rowWidth: number}}
 *   `row` 宿主行元素（观测用）；`lane` 该行是横向的（纵排容器为 false）；`wrapped` 该行
 *   当前允许换行（宿主或其它插件做成）；`count` 行内占位者数量（含本按钮；lane=false
 *   时不收集，保持 0）；`rowWidth` 行可用内容宽（row.clientWidth；量不到为 NaN）
 */
export function measureFooterLane(button, view = globalThis) {
  const facts = { row: null, lane: false, wrapped: false, count: 0, rowWidth: NaN }
  const styleOf = view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle.bind(view) : null
  if (!button || styleOf === null) return facts
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
    facts.rowWidth = row.clientWidth
    let count = 1 // 本按钮自己
    const collect = (container) => {
      for (const child of container.children) {
        const childCs = styleOf(child)
        // 槽出口（display:contents）把条目摊进行里：继续展开，别把它当成一个条目
        if (childCs.display === 'contents') { collect(child); continue }
        if (child.contains(button)) continue // 含本按钮的条目（含包裹层）已在初始值里计过
        const rect = child.getBoundingClientRect()
        if (!occupiesFooterLane({ position: childCs.position, width: rect.width, height: rect.height })) continue
        count += 1
      }
    }
    collect(row)
    facts.count = count
    return facts
  }
  return facts
}

/**
 * 容量判定（规范 v1 §B 主规则）：该不该保留文字形态。输入只有占位者数量与行宽，
 * 与本按钮当前形态无关——同槽各插件用同一规则独立求值即收敛（全有或全无）。
 *
 * 边界语义：
 *   count<=0 → label（参考实现口径：没有占位者就没有竞争）；
 *   count>COUNT_LIMIT → icon（与行宽无关）；
 *   rowWidth 非有限（NaN / ±Infinity / undefined）→ icon。量不到行宽时取 icon 而非
 *   label：真实管线里「未挂载 / 找不到行」已由 ImportButton 的 lane=false → row 分支
 *   兜住，能走到这里的必须是已量到的横向行（clientWidth 恒有限）；仍出现非有限值说明
 *   视图异常，icon 是安全紧凑态——不溢出行、不挤同槽条目，文字保留在 title /
 *   aria-label。这也与参考实现 rowWidth>=required 对 NaN 为 false 的口径一致。
 * @param {number} count 同一行内占位者数量（含本按钮）
 * @param {number} rowWidth 行可用内容宽
 * @returns {'label'|'icon'}
 */
export function resolveFooterForm(count, rowWidth) {
  if (count <= 0) return 'label'
  if (count > COUNT_LIMIT) return 'icon'
  if (!Number.isFinite(rowWidth)) return 'icon'
  const required = count * MAX_LABEL_BOX + (count - 1) * ROW_GAP + ROW_PADDING
  return rowWidth >= required ? 'label' : 'icon'
}