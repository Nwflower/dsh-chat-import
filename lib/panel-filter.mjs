// lib/panel-filter.mjs — 导入面板客户端筛选纯函数（workspace 下拉 + 可搬空计数）

/** 无真实工作区（cwd/project 均为空）条目的内部键。 */
export const NO_WORKSPACE_KEY = '__no_workspace__'

/** 会话 → 工作区筛选键（有 project 用 basename，否则归入无工作区桶）。 */
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

/** 从条目列表构建工作区下拉选项（按组内最新活跃时间降序，无工作区钉最后）。 */
export function buildWorkspaceOptions(items) {
  const map = new Map()
  for (const s of Array.isArray(items) ? items : []) {
    const key = workspaceKey(s)
    const latest = Math.max(
      map.has(key) ? map.get(key).latest : 0,
      (typeof s.lastActiveAt === 'number' ? s.lastActiveAt : 0)
        || (typeof s.createdAt === 'number' ? s.createdAt : 0),
    )
    map.set(key, { key, latest })
  }
  return [...map.values()].sort((a, b) => {
    if (a.key === NO_WORKSPACE_KEY) return 1
    if (b.key === NO_WORKSPACE_KEY) return -1
    return (b.latest - a.latest) || String(a.key).localeCompare(String(b.key))
  })
}

/** 当前筛选下可搬空（未导入且未归档）条目。 */
export function importableSessions(items, workspaceFilter) {
  const filtered = filterByWorkspace(items, workspaceFilter)
  return filtered.filter((s) => s.importStatus !== 'imported' && s.importStatus !== 'archived')
}
