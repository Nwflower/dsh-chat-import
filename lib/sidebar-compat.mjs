// lib/sidebar-compat.mjs — dsh-better-sidebar 版本兼容纯函数
//
// 与 lib/client.js 里的同名逻辑保持同步（浏览器 bundle 不做构建、不 import 模块，
// 只能各存一份；纯函数放这里以便单测，见 lib/panel-filter.mjs 同款模式）。
//
// 背景：dsh-better-sidebar 0.19 起给 openTab 的 seed 接了原生右侧栏 surface，seed.path
// 的语义从「写进 tab 对象的数据」变成「要打开的工作区资源地址」——相对路径会按会话
// cwd 解析（surface.fileAddress），目录不存在就直接 realpath ENOENT → 400，tab 根本
// 打不开。而 0.18 恰恰相反：只有 seed.path / seed.url 存在时才会走 reducer 里的自动
// 展开分支（lib/client.js 的 `if (seed.path !== void 0 || seed.url !== void 0)`）。
// 同一个 seed 在两版里语义相反，只能按服务自报的版本分支。

/** 服务自报版本是否支持「不带 path 的原生 tab open」（dsh-better-sidebar >= 0.19）。
 * 版本缺失 / 非语义化时按支持处理：新版不带 path 一定能开 tab；旧版不带 path 只是
 * 不自动展开面板（用户再点一次即见），而按旧版语义带上 path 在新版会直接报错打不开
 * ——默认必须落在不会报错的那一侧。 */
export function supportsPathlessTabOpen(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(typeof version === 'string' ? version : '')
  if (!m) return true
  return Number(m[1]) > 0 || Number(m[2]) >= 19
}

/** openTab 的 seed：>= 0.19 不带 path（走原生 tab kind，revealIfOpened 默认 true）；
 * < 0.19 带上 path（0.18 只有带 path / url 才会自动展开侧边栏面板）。 */
export function importTabSeed(type, version) {
  return supportsPathlessTabOpen(version) ? { type } : { type, path: type }
}
