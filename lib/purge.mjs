// lib/purge.mjs — 导入历史展示 + 批量撤回（删除本插件创建的会话/工作区挂接）
//
// 平台 sessionPersistence 无官方 delete 面；本模块按社区插件 dsh-session-cleaner
// 同款 out-of-band 维护：可选 agents/sessions 服务停 agent、detach 内存索引、
// workspaceRegistry.detachSession 解挂、rm 工件目录（locate 或 $DSH_HOME/sessions
// 扫描），最后 removeImport 清 registry。只处理 imports registry 记录过的会话
//（0.8.3 起日志不再写 session/imported 标记，归属以 registry 为权威，issue #34；
// 旧日志标记仍作正向证据）。

import { access, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadImports, removeImport, updateImport, unwrapRecord, canReadSessionEvents, registryEntries } from './imports.mjs'
import { rememberIgnore } from './ignore.mjs'
import { readSessionLog, sessionTitleFromEvents, sessionArtifactPath, retractIgnoreKey } from './retract.mjs'

// DSH 会话 id 合法字符：支持字母、数字、连字符以及下划线（mintSessionId 会引入下划线），长 1~128。
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

function sessionsRoot(env = process.env) {
  return join(env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
}

/** registry 展平为 UI 历史条目（sourcePath / sessionId / 计数 / 时间）。重导另铸的
 * 历史副本（record.copies）同样是本插件导入的真实会话，一并列出并标记 copy:true。 */
export async function listImportHistory(ctx, registryDir) {
  const registry = await loadImports(registryDir)
  const sp = ctx.get('sessionPersistence')
  const entries = []
  for (const entry of registryEntries(registry.imports)) {
    const item = {
      sourcePath: entry.sourcePath,
      sessionId: entry.dshId,
      turns: typeof entry.turns === 'number' ? entry.turns : undefined,
      events: typeof entry.events === 'number' ? entry.events : undefined,
      importedAt: typeof entry.importedAt === 'number' ? entry.importedAt : undefined,
      kind: entry.subTable ? 'multi' : 'single',
    }
    if (entry.subKey !== undefined) item.sourceSessionId = entry.subKey
    if (entry.copy) item.copy = true
    if (canReadSessionEvents(sp)) {
      const info = await readSessionLog(ctx, entry.dshId)
      if (info) {
        const title = sessionTitleFromEvents(info.events)
        if (title) item.title = title
        item.artifactPath = sessionArtifactPath(sp, { id: entry.dshId })
      }
    }
    entries.push(item)
  }
  entries.sort((a, b) => (b.importedAt || 0) - (a.importedAt || 0))
  return { total: entries.length, entries }
}

/** 从 registry 收集全部 dshId → sourcePath 映射（multi 子表 + 历史副本展开）。 */
export function collectRegistryTargets(imports) {
  return registryEntries(imports).map((e) => ({ sourcePath: e.sourcePath, sessionId: e.dshId }))
}

async function disposeAgentFiber(agent) {
  const fiber = agent && agent.ctx && agent.ctx.fiber
  if (!fiber || typeof fiber._unload !== 'function') return false
  try {
    await fiber._unload()
    return true
  } catch {
    return false
  }
}

function detachLiveStore(sessions, sessionId) {
  const entry = sessions && sessions.store && typeof sessions.store.get === 'function'
    ? sessions.store.get(sessionId)
    : undefined
  if (!entry || entry.detach === undefined) return false
  entry.detach()
  return true
}

async function detachWorkspaces(workspaceRegistry, sessionId) {
  if (!workspaceRegistry || typeof workspaceRegistry.list !== 'function') return 0
  let removed = 0
  for (const ws of workspaceRegistry.list()) {
    const ids = ws && ws.sessionIds
    if (!Array.isArray(ids) || !ids.includes(sessionId)) continue
    if (typeof ws.detachSession === 'function') await ws.detachSession(sessionId)
    removed++
  }
  return removed
}

// rm 后目录必须消失。仍存在 = 文件被占用 / 权限拒绝（Windows 只读文件、Linux 只读
// 目录等）→ 抛错让调用方中止：deleteImportedSession 中止后不清 registry、
// clearSessionArtifactsForReplace 中止后不重导——避免留下插件再也管不到的幽灵会话。
async function removeDirectoryOrThrow(dir) {
  try {
    await rm(dir, { recursive: true, force: true })
  } catch {
    // rm 报错不复述：统一以存在性复查为准（目录本就不存在时 force rm 静默成功）
  }
  try {
    await access(dir)
  } catch {
    return
  }
  throw new Error('会话工件删除失败（文件被占用或权限拒绝）：' + dir)
}

async function removeArtifactsByLocate(sp, sessionId) {
  if (!sp || typeof sp.locate !== 'function') return 0
  const path = sessionArtifactPath(sp, { id: sessionId })
  if (!path) return 0
  try {
    await access(path)
  } catch {
    return 0
  }
  await removeDirectoryOrThrow(path)
  return 1
}

async function removeArtifactsByScan(sessionId, env = process.env) {
  const root = sessionsRoot(env)
  let removed = 0
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue
    const dir = join(root, proj.name, sessionId)
    try {
      await access(dir)
    } catch {
      continue
    }
    await removeDirectoryOrThrow(dir)
    removed++
  }
  return removed
}

async function assertPluginSession(sessionId, registry) {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('非法 sessionId：' + sessionId)
  const hit = collectRegistryTargets(registry.imports).find((t) => t.sessionId === sessionId)
  if (!hit) throw new Error('会话不在 imports registry：' + sessionId)
  return hit
}

// 删除一个会话后修剪它所在的源记录（返回修剪后的记录；null = 整条移除）：
//   multi  —— 摘掉命中的子会话，子表全空才移除整条记录；
//   single —— 删掉的可能是重导另铸的历史副本（record.copies）——那是用户自己的另一条
//             会话，不能连带把主记录的账删掉：命中副本只摘这一条，命中主记录则把最新的
//             副本提升为主记录（其余保留），都没有才移除整条记录。
function pruneRecord(record, sessionId) {
  if (!record) return null
  if (record.kind === 'multi') {
    let anyLeft = false
    for (const table of ['conversations', 'sessions']) {
      const subs = record[table] && typeof record[table] === 'object' ? record[table] : null
      if (!subs) continue
      for (const [key, sub] of Object.entries(subs)) {
        if (sub && sub.dshId === sessionId) delete subs[key]
      }
      if (Object.keys(subs).length > 0) anyLeft = true
    }
    return anyLeft ? record : null
  }
  const copies = Array.isArray(record.copies) ? record.copies : []
  const copyAt = copies.findIndex((c) => c && c.dshId === sessionId)
  if (copyAt >= 0) {
    copies.splice(copyAt, 1)
    if (copies.length > 0) record.copies = copies
    else delete record.copies
    return record
  }
  if (copies.length > 0 && record.dshId === sessionId) {
    const [promoted, ...rest] = copies
    const { copies: _drop, ...kept } = record
    return {
      ...kept,
      ...promoted,
      // 副本没有本次的源指纹（args/budget/sizeBytes 属于当前主记录）——保留记录的
      // 源级字段，只把会话级字段换成被提升的那条，避免把旧副本的计数当新基线。
      budget: record.budget,
      sizeBytes: record.sizeBytes,
      mtimeMs: record.mtimeMs,
      version: record.version,
      args: record.args,
      importedAt: record.importedAt,
      ...(rest.length > 0 ? { copies: rest } : {}),
    }
  }
  return null
}

// 修剪 registry 记录（串行读-改-写，读的是链上最新落盘值，不会吞掉并发写入）并打墓碑：
// 删除（purge）是用户显式动作，打永久墓碑，源增长/重扫都不会把它带回来；多会话源只墓碑
// 被删的子会话。
async function pruneRegistryAfterDelete(registryDir, sourcePath, sessionId) {
  let ignoreKey = sourcePath
  await updateImport(registryDir, sourcePath, (raw) => {
    const record = unwrapRecord(raw)
    ignoreKey = retractIgnoreKey(record, sourcePath, sessionId)
    return pruneRecord(record, sessionId)
  })
  await rememberIgnore(registryDir, { key: ignoreKey, reason: 'retracted', dshId: sessionId })
}

/** 覆盖刷新前清理会话工件（保留 registry 与工作区挂接）。 */
export async function clearSessionArtifactsForReplace(ctx, sessionId) {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('非法 sessionId：' + sessionId)
  const agents = ctx.get('agents')
  const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
  if (agent !== undefined && agent.status === 'running') {
    throw new Error('会话正在运行，请先停止再刷新：' + sessionId)
  }
  if (agent !== undefined) {
    const stopped = await disposeAgentFiber(agent)
    if (!stopped) throw new Error('无法停止附着 agent：' + sessionId)
  }
  const sessions = ctx.get('sessions')
  detachLiveStore(sessions, sessionId)
  const sp = ctx.get('sessionPersistence')
  let files = await removeArtifactsByLocate(sp, sessionId)
  if (files === 0) files = await removeArtifactsByScan(sessionId)
  if (sp && typeof sp.remove === 'function') {
    try { await sp.remove(sessionId) } catch { /* 测试 mock / 可选宿主面：移除内存索引 */ }
  }
  return { sessionId, files }
}

/** 删除单个本插件导入的会话（工件 + 挂接 + registry 子项）；返回摘要。 */
export async function deleteImportedSession(ctx, registryDir, sessionId, { registry } = {}) {
  const data = registry || await loadImports(registryDir)
  const hit = await assertPluginSession(sessionId, data)
  const agents = ctx.get('agents')
  const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
  if (agent !== undefined && agent.status === 'running') {
    throw new Error('会话正在运行，请先停止再删除：' + sessionId)
  }
  if (agent !== undefined) {
    const stopped = await disposeAgentFiber(agent)
    if (!stopped) throw new Error('无法停止附着 agent：' + sessionId)
  }
  const sessions = ctx.get('sessions')
  const detached = detachLiveStore(sessions, sessionId)
  const wr = ctx.get('workspaceRegistry')
  const workspaces = await detachWorkspaces(wr, sessionId)
  const sp = ctx.get('sessionPersistence')
  let files = await removeArtifactsByLocate(sp, sessionId)
  if (files === 0) files = await removeArtifactsByScan(sessionId)
  await pruneRegistryAfterDelete(registryDir, hit.sourcePath, sessionId)
  return { sessionId, sourcePath: hit.sourcePath, detached, workspaces, files }
}

// 本插件可能建过的工作区路径形态：专用导入工作区、agent-transcripts/<uuid>，以及旧实现
// 在「cwd 不可用」时**为源 transcript 目录**误建的工作区（.claude/projects、.codex/
// sessions…）。只对成员为 0 的工作区生效——挂着会话的工作区一律不碰。
function looksOrphanWorkspace(path) {
  const p = String(path)
  return /agent-transcripts[/\\][0-9a-f-]{36}/i.test(p)
    || p.includes('dsh-chat-import-workspace')
    || /[/\\]\.claude[/\\]projects[/\\]/i.test(p)
    || /[/\\]\.codex[/\\](sessions|archived_sessions)[/\\]/i.test(p)
    || /[/\\]\.cursor[/\\]projects[/\\]/i.test(p)
    || /[/\\]\.gemini[/\\]/i.test(p)
}

/** 清理本插件创建且已无成员的工作区登记；返回被移除的路径数组。
 * 宿主 API 是 workspaceRegistry.delete(id)（实体自身没有 remove）——旧写法 ws.remove()/
 * wr.remove() 在现宿主上恒不命中，等于静默不清理。只删工作区登记：目录与会话日志保留，
 * 其会话（若有）回到「未分组」。单条失败不阻断其余（失败大声由调用方/用户可见列表兜底）。 */
export async function cleanupOrphanWorkspaces(ctx) {
  const wr = ctx.get('workspaceRegistry')
  const removed = []
  if (!wr || typeof wr.list !== 'function') return removed
  for (const ws of wr.list()) {
    const path = ws && (ws.path || ws.cwd)
    const ids = ws && ws.sessionIds
    if (!path || !Array.isArray(ids) || ids.length > 0) continue
    if (!looksOrphanWorkspace(path)) continue
    try {
      if (typeof wr.delete === 'function' && typeof ws.id === 'string' && ws.id) {
        await wr.delete(ws.id)
        removed.push(path)
      } else if (typeof ws.remove === 'function') {
        await ws.remove()
        removed.push(path)
      }
    } catch {
      // 单条删除失败（并发删除 / 权限）：不阻断其余，用户仍可在侧栏手动删除
    }
  }
  return removed
}

/** 批量删除 registry 中全部导入会话；需 confirm:true。 */
export async function purgeAllImports(ctx, registryDir, { confirm } = {}) {
  if (confirm !== true) {
    throw new Error('批量删除需要 confirm:true（不可逆，仅删除本插件导入的会话）')
  }
  const registry = await loadImports(registryDir)
  const uniqueIds = [...new Set(collectRegistryTargets(registry.imports).map((t) => t.sessionId))]
  const results = []
  let deleted = 0
  let failed = 0
  for (const sessionId of uniqueIds) {
    try {
      const out = await deleteImportedSession(ctx, registryDir, sessionId)
      deleted++
      results.push({ ...out, status: 'deleted' })
    } catch (err) {
      failed++
      results.push({ sessionId, status: 'failed', error: String((err && err.message) || err) })
    }
  }
  const workspacesRemoved = await cleanupOrphanWorkspaces(ctx)
  return { total: uniqueIds.length, deleted, failed, workspacesRemoved: workspacesRemoved.length, results }
}

/** 按 sourcePath 删除 registry 记录关联的全部会话。 */
export async function purgeBySourcePath(ctx, registryDir, sourcePath, { confirm } = {}) {
  if (confirm !== true) throw new Error('删除需要 confirm:true')
  if (typeof sourcePath !== 'string' || !sourcePath) throw new Error('缺少 sourcePath')
  const registry = await loadImports(registryDir)
  if (!Object.prototype.hasOwnProperty.call(registry.imports, sourcePath)) {
    return { sourcePath, deleted: 0, failed: 0, results: [] }
  }
  // 该源记录关联的全部会话 id（含重导历史副本），统一展开口径
  const ids = registryEntries({ [sourcePath]: registry.imports[sourcePath] }).map((e) => e.dshId)
  const results = []
  let deleted = 0
  let failed = 0
  for (const sessionId of ids) {
    try {
      const out = await deleteImportedSession(ctx, registryDir, sessionId)
      deleted++
      results.push({ ...out, status: 'deleted' })
    } catch (err) {
      failed++
      results.push({ sessionId, status: 'failed', error: String((err && err.message) || err) })
    }
  }
  await removeImport(registryDir, sourcePath)
  return { sourcePath, deleted, failed, results }
}
