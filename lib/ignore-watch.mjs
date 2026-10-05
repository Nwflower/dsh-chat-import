// lib/ignore-watch.mjs — 自动忽略：把 DSH 的「归档 / 取消归档 / 删工作区」同步进忽略表。
//
// 数据源是 workspace domain 的 `domain/changed`（dsh-storage-domain 公开事件）：
//   - 全局态写入（table='' / key=''）：archivedSessionIds 增删 → 归档打墓碑
//     （reason 'archived'）、取消归档解除墓碑；
//   - workspaces 表 deleted（墓碑事件不带旧值）→ 用进程内工作区快照拿到被删记录，
//     把它名下的导入会话逐个打 'workspace-deleted' 墓碑，并登记工作区忽略记录；
//   - workspaces 表 put（会话挂接）→ 工作区出现新会话 → 解除工作区忽略（用户规则）。
//
// 设计约束：只消费公开事件；快照进程内维护（删记录的回调拿不到旧值，必须自留快照）；
// 失败只告警不抛出——忽略是辅助能力，绝不阻塞导入主流程。
import { findSourceEntryByDshId, loadImports } from './imports.mjs'
import {
  forgetIgnoreByDshId,
  forgetWorkspaceIgnore,
  normalizeCwd,
  rememberIgnores,
  rememberWorkspaceIgnore,
  sourceIgnoreKey,
} from './ignore.mjs'

/** workspace domain 名（dsh-workspace spec.name）。 */
const WORKSPACE_DOMAIN = 'workspace'

export function registerIgnoreWatch(ctx, registryDir) {
  // workspaceRegistry 是 host 服务、可能在插件 apply 之后才发布（与 webServer 同一
  // 晚挂载模式）：用 ctx.inject 等到服务可用再挂监听；无 inject 的宿主（测试）直接挂。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['workspaceRegistry'], (serviceCtx) => mount(serviceCtx, registryDir))
    return
  }
  mount(ctx, registryDir)
}

function mount(ctx, registryDir) {
  const wr = ctx.get('workspaceRegistry')
  if (!wr || typeof wr.list !== 'function') return

  let workspaces = new Map()
  let archived = new Set()
  let seeded = false
  let chain = Promise.resolve()

  // 单链串行：domain/changed 的写顺序即快照顺序，避免并发读改写错快照
  const run = (task) => {
    chain = chain.then(task).catch((err) => {
      console.warn('[dsh-chat-import] 忽略监听失败：' + String((err && err.message) || err))
    })
    return chain
  }

  // 给一批会话打墓碑：registry 读一次、忽略表一次读-改-写（同内容的墓碑不重写文件——
  // 启动补墓碑每次都会把全部已归档会话再登记一遍）。返回实际定位到的忽略键（不是本插件
  // 导入的会话没有记录，跳过）。
  const tombstone = async (dshIds, reason) => {
    if (dshIds.length === 0) return []
    const registry = await loadImports(registryDir)
    const entries = []
    for (const dshId of dshIds) {
      const entry = findSourceEntryByDshId(registry.imports, dshId)
      if (!entry) continue
      entries.push({
        key: sourceIgnoreKey(entry.sourcePath, entry.subTable, entry.subKey),
        reason,
        dshId,
        ...(entry.subTable ? { subTable: entry.subTable } : {}),
        ...(entry.subKey ? { subKey: entry.subKey } : {}),
      })
    }
    await rememberIgnores(registryDir, entries)
    return entries.map((e) => e.key)
  }

  const workspacePathOf = (sessionId) => {
    for (const record of workspaces.values()) {
      if (Array.isArray(record.sessionIds) && record.sessionIds.includes(sessionId)) return record.path
    }
    return ''
  }

  const snapshotWorkspace = (value) => ({
    path: typeof value?.path === 'string' ? value.path : '',
    sessionIds: Array.isArray(value?.sessionIds) ? [...value.sessionIds] : [],
  })

  const seed = async () => {
    const next = new Map()
    for (const w of wr.list()) {
      if (w && typeof w.id === 'string') next.set(w.id, snapshotWorkspace(w))
    }
    workspaces = next
    archived = new Set(Array.isArray(wr.archivedSessionIds) ? wr.archivedSessionIds : [])
    seeded = true
    // 已在归档态的会话补墓碑：插件升级前已归档的会话同样纳入「不再重导」
    await tombstone([...archived], 'archived')
  }

  const handleGlobal = async (value) => {
    const next = new Set(Array.isArray(value?.archivedSessionIds) ? value.archivedSessionIds : [])
    await tombstone([...next].filter((id) => !archived.has(id)), 'archived')
    for (const id of archived) {
      if (next.has(id)) continue
      await forgetIgnoreByDshId(registryDir, id)
      // 取消归档 = 该工作区出现活动：解除工作区忽略（旧会话墓碑保留）
      const cwd = workspacePathOf(id)
      if (cwd) await forgetWorkspaceIgnore(registryDir, cwd)
    }
    archived = next
  }

  const handleWorkspaceDeleted = async (key) => {
    const record = workspaces.get(key)
    workspaces.delete(key)
    if (!record || record.path === '') return
    const keys = await tombstone(record.sessionIds, 'workspace-deleted')
    await rememberWorkspaceIgnore(registryDir, record.path, keys)
  }

  const handleWorkspacePut = async (key, value) => {
    const previous = workspaces.get(key)
    const next = snapshotWorkspace(value)
    workspaces.set(key, next)
    if (!previous || normalizeCwd(previous.path) !== normalizeCwd(next.path)) return
    const added = next.sessionIds.filter((id) => !previous.sessionIds.includes(id))
    if (added.length > 0) await forgetWorkspaceIgnore(registryDir, next.path)
  }

  const handle = async (change) => {
    if (!seeded) await seed()
    if (!change || change.domain !== WORKSPACE_DOMAIN) return
    if (change.operation === 'put' && change.table === '' && change.key === '') {
      await handleGlobal(change.value)
      return
    }
    if (change.table !== 'workspaces') return
    if (change.operation === 'deleted') {
      await handleWorkspaceDeleted(change.key)
      return
    }
    if (change.operation === 'put') {
      await handleWorkspacePut(change.key, change.value)
    }
  }

  ctx.on('domain/changed', (change) => {
    void run(() => handle(change))
  })
  void run(seed)
}
