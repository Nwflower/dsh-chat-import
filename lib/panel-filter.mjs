// lib/panel-filter.mjs — 导入面板的工作区筛选纯函数（工作区下拉 / 过滤 / 分组键）
//
// 浏览器面板里跑的就是这一份：scripts/build-client.mjs 把本文件去掉 export、整体缩进后原样
// 内联进 lib/client.js（见该脚本文件头的「内联模块」），测试直接 import 本模块。因此本文件
// 必须保持「零 import、只有顶格 export 声明、无跨行模板字符串」的纯模块形态。

/** 无真实工作区（project 为空）条目的内部键：排序钉最后，显示时经 t("noWorkspace") 翻译。 */
export const NO_WORKSPACE_KEY = '__no_workspace__'

/**
 * 会话 → 工作区筛选键。discovery 的 project 是文件夹名字符串或 null；非字符串一律归入
 * 无工作区桶（分组排序对键调用 localeCompare，键必须是字符串）。
 */
export function workspaceKey(entry) {
  if (entry && typeof entry.project === 'string' && entry.project) return entry.project
  return NO_WORKSPACE_KEY
}

/** 按工作区键过滤（'' = 全部）。 */
export function filterByWorkspace(items, workspaceFilter) {
  const list = Array.isArray(items) ? items : []
  if (!workspaceFilter) return list
  return list.filter((s) => workspaceKey(s) === workspaceFilter)
}

/**
 * 工作区下拉的选项 `{ key, latest, path }`：key / latest 供排序与过滤；path 是该组里最新
 * 会话的 cwd（discovery 的 project 通常只是文件夹名，下拉里用更淡的字把路径画在后面；同名
 * 不同路径时以最活跃的那个会话为准，时间并列取后到的）。按组内最新活跃（缺省创建）时间
 * 降序，时间并列按键名升序，无工作区钉最后。
 */
export function buildWorkspaceOptions(items) {
  const map = new Map()
  for (const s of Array.isArray(items) ? items : []) {
    const key = workspaceKey(s)
    const at = (typeof s.lastActiveAt === 'number' ? s.lastActiveAt : 0)
      || (typeof s.createdAt === 'number' ? s.createdAt : 0)
    const path = typeof s.cwd === 'string' ? s.cwd : ''
    const prev = map.get(key)
    if (!prev) {
      map.set(key, { key, latest: at, path })
    } else if (at >= prev.latest) {
      prev.latest = at
      prev.path = path
    }
  }
  return [...map.values()].sort((a, b) => {
    if (a.key === NO_WORKSPACE_KEY) return 1
    if (b.key === NO_WORKSPACE_KEY) return -1
    return (b.latest - a.latest) || String(a.key).localeCompare(String(b.key))
  })
}
