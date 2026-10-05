// lib/discovery/import-status.mjs — 发现条目的导入状态（只读查询 imports registry 映射，无 I/O）

// importStatus：查 imports registry（调用方 loadImports 后传入的 imports 映射）。
// single 源（claude/codex/.../hermes-jsonl）路径命中 → imported；multi 源
//（opencode/zcode/hermes-db/chatgpt）按会话 id 查子表——命中 → imported、子表非空但
// 本会话不在 → partial（源已部分导入）、否则 not-imported。archivedIds（可选，Set/
// 数组）为 workspaceRegistry 的全局归档集：记录关联的会话已被归档（隐藏但仍占 id）
// → 'archived'，供面板/scan_discover 显示可重导而非已导入。
//
// persistedIds（可选，Set/数组）为宿主当前持久化的会话 id 集合：注册表记录指向的会话
// **已不在宿主**（被删除）→ 'not-imported'，而不是 'imported'。否则面板会把一个已经
// 没有对应会话的源显示成「已导入」，用户也没法把它重新导入。已删除优先于已归档：
// 归档后又被删除同样是 not-imported。
export function resolveImportStatus(imports, sourcePath, sessionId, archivedIds, persistedIds) {
  const archived = archivedIds instanceof Set ? archivedIds
    : Array.isArray(archivedIds) ? new Set(archivedIds) : null
  const persisted = persistedIds instanceof Set ? persistedIds
    : Array.isArray(persistedIds) ? new Set(persistedIds) : null
  const isArchived = (id) => archived !== null && typeof id === 'string' && archived.has(id)
  const isGone = (id) => persisted !== null && typeof id === 'string' && !persisted.has(id)
  // 记录关联会话的状态：宿主里已不存在 → 未导入；存在但已归档 → archived；否则已导入。
  const statusOf = (id) => {
    if (isGone(id)) return 'not-imported'
    return isArchived(id) ? 'archived' : 'imported'
  }
  const record = imports && typeof imports === 'object' ? imports[sourcePath] : undefined
  if (record === undefined) return 'not-imported'
  if (typeof record === 'string') return statusOf(record) // 旧版纯字符串记录
  if (!record || typeof record !== 'object') return 'not-imported'
  if (record.kind === 'multi') {
    const sub = record.conversations || record.sessions
    if (sub && typeof sub === 'object') {
      const own = sub[sessionId]
      if (typeof own === 'string') return statusOf(own) // 旧版子表字符串记录
      if (own && typeof own === 'object' && typeof own.dshId === 'string') return statusOf(own.dshId)
      if (Object.keys(sub).length > 0) return 'partial'
    }
    return 'not-imported'
  }
  if (typeof record.dshId === 'string') return statusOf(record.dshId)
  return 'imported'
}
