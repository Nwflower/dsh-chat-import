// lib/footer-layout.mjs — 侧边栏 footer 槽「同槽挤压」判定（纯函数）
//
// 与 lib/client.js 里的同名逻辑保持同步（浏览器 bundle 不做构建、不 import 模块，
// 只能各存一份，同 lib/panel-filter.mjs / lib/sidebar-compat.mjs 的既有模式）。
//
// 背景：#31 / #35 / #39 / #43 是同一类问题的四次复发——footer 槽是 nowrap 行，任何
// 「整宽条目」（cordis 徽标、插件市场 launcher、usage-billing 计费卡、cost-meter
// 费用卡、内置「手机连接」…）进来都会把同槽的「导入会话」按钮挤成窄条 / 文字截断。
// 早先按选择器白名单识别占用者，于是每出现一个新来源就得补一条，且 CSS-module 哈希
// 类名跨构建不稳定——永远追不上。
//
// 改为按**布局事实**判定，与「它是谁」无关：
//   ① 本插件的槽元素内容被裁（scrollWidth > clientWidth）：这是「被挤到显示不下」的
//      直接症状，无论占用者是否已被 flex 压扁都会留下这个痕迹；
//   ② 同槽有渲染宽度≈容器宽的可见条目：未被挤压的整宽条目。
// 半宽入口共享一行（#31 的预期行为）既不裁切也不整宽，两个信号都不命中，行为不变。

/** 槽元素内容被裁（文字截断 / 挤成窄条的直接症状）。留 1px 取整容差。 */
export function isFooterSqueezed(scrollWidth, clientWidth) {
  if (!Number.isFinite(scrollWidth) || !Number.isFinite(clientWidth)) return false
  return scrollWidth > clientWidth + 1
}

/**
 * 判定一个同槽兄弟条目是否是「把本按钮挤到显示不下」的占用者。
 * @param {object} entry 该条目的布局事实：`{ visible, position, width, height }`
 *   （visible 由 display / visibility / opacity 归并而来，position 为计算值）。
 * @param {object} context `{ containerWidth, squeezed }`——容器渲染宽度与本按钮是否已被裁。
 * @returns {boolean}
 */
export function isFooterOccupant(entry, context) {
  if (!entry || entry.visible !== true) return false
  // 脱离文档流的浮层（含本插件自己的 ShellPanel）不占行内空间
  if (entry.position === 'fixed' || entry.position === 'absolute') return false
  if (!(entry.width > 0) || !(entry.height > 0)) return false
  // 本按钮已被挤到内容显示不下：同槽任何占位条目都算占用者（占用者自己往往也被压扁，
  // 宽度不再等于容器宽，几何判据单靠 ② 会漏——#43 实测占用者 185px / 容器 256px）
  if (context && context.squeezed === true) return true
  return Number.isFinite(context && context.containerWidth) && entry.width >= context.containerWidth - 1
}
