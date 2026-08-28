// lib/purge.mjs — 导入历史展示 + 批量撤回（删除本插件创建的会话/工作区挂接）
//
// 平台 sessionPersistence 无官方 delete 面；本模块按社区插件 dsh-session-cleaner
// 同款 out-of-band 维护：可选 agents/sessions 服务停 agent、detach 内存索引、
// workspaceRegistry.detachSession 解挂、rm 工件目录（locate 或 $DSH_HOME/sessions
// 扫描），最后 removeImport 清 registry。只处理 imports registry 记录过的会话，
// 且优先要求 session/imported 标记（registry 兜底仅当日志读不到时放行）。

import { access, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadImports, removeImport, saveImports, unwrapRecord } from './imports.mjs'

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/

function sessionsRoot(env = process.env) {
  return join(env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
}

async function readSessionLog(sp, id) {
  if (!sp || typeof sp.readFrom !== 'function') return null
  try {
    const { events } = await sp.readFrom(id, 0)
    const list = Array.isArray(events) ? events : []
    const first = list.length > 0 ? list[0] : undefined
    return { marker: first && first.type === 'session/imported' ? first : null, events: list }
  } catch {
    return null
  }
}

function sessionTitleFromEvents(events) {
  if (!Array.isArray(events)) return undefined
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev && ev.type === 'session/title' && ev.data && typeof ev.data.title === 'string' && ev.data.title) {
      return ev.data.title
    }
  }
  return undefined
}

function sessionArtifactPath(sp, header) {
  try {
    const loc = sp && typeof sp.locate === 'function' ? sp.locate(header) : undefined
    return loc && typeof loc.path === 'string' ? loc.path : null
  } catch {
    return null
  }
}

/** registry 展平为 UI 历史条目（sourcePath / sessionId / 计数 / 时间）。 */
export async function listImportHistory(ctx, registryDir) {
  const registry = await loadImports(registryDir)
  const sp = ctx.get('sessionPersistence')
  const entries = []
  for (const [sourcePath, raw] of Object.entries(registry.imports || {})) {
    const record = unwrapRecord(raw)
    if (!record || typeof record !== 'object') continue
    if (record.kind === 'multi') {
      for (const table of ['conversations', 'sessions']) {
        const subs = record[table] && typeof record[table] === 'object' ? record[table] : {}
        for (const [sourceSessionId, sub] of Object.entries(subs)) {
          if (!sub || typeof sub.dshId !== 'string') continue
          const item = {
            sourcePath,
            sessionId: sub.dshId,
            sourceSessionId,
            turns: typeof sub.turns === 'number' ? sub.turns : undefined,
            events: typeof sub.events === 'number' ? sub.events : undefined,
            importedAt: typeof record.importedAt === 'number' ? record.importedAt : undefined,
            kind: 'multi',
          }
          if (sp) {
            const info = await readSessionLog(sp, sub.dshId)
            if (info) {
              const title = sessionTitleFromEvents(info.events)
              if (title) item.title = title
              item.artifactPath = sessionArtifactPath(sp, { id: sub.dshId })
            }
          }
          entries.push(item)
        }
      }
    } else if (typeof record.dshId === 'string') {
      const item = {
        sourcePath,
        sessionId: record.dshId,
        turns: typeof record.turns === 'number' ? record.turns : undefined,
        events: typeof record.events === 'number' ? record.events : undefined,
        importedAt: typeof record.importedAt === 'number' ? record.importedAt : undefined,
        kind: 'single',
      }
      if (sp) {
        const info = await readSessionLog(sp, record.dshId)
        if (info) {
          const title = sessionTitleFromEvents(info.events)
          if (title) item.title = title
          item.artifactPath = sessionArtifactPath(sp, { id: record.dshId })
        }
      }
      entries.push(item)
    }
  }
  entries.sort((a, b) => (b.importedAt || 0) - (a.importedAt || 0))
  return { total: entries.length, entries }
}

/** 从 registry 收集全部 dshId → sourcePath 映射（multi 子表展开）。 */
export function collectRegistryTargets(imports) {
  const targets = []
  for (const [sourcePath, raw] of Object.entries(imports || {})) {
    const record = unwrapRecord(raw)
    if (!record || typeof record !== 'object') continue
    if (record.kind === 'multi') {
      for (const table of ['conversations', 'sessions']) {
        const subs = record[table] && typeof record[table] === 'object' ? record[table] : {}
        for (const sub of Object.values(subs)) {
          if (sub && typeof sub.dshId === 'string') targets.push({ sourcePath, sessionId: sub.dshId })
        }
      }
    } else if (typeof record.dshId === 'string') {
      targets.push({ sourcePath, sessionId: record.dshId })
    }
  }
  return targets
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

async function assertPluginSession(ctx, sessionId, registry) {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('非法 sessionId：' + sessionId)
  const hit = collectRegistryTargets(registry.imports).find((t) => t.sessionId === sessionId)
  if (!hit) throw new Error('会话不在 imports registry：' + sessionId)
  const sp = ctx.get('sessionPersistence')
  const info = sp ? await readSessionLog(sp, sessionId) : null
  if (info && !info.marker) {
    throw new Error('会话无 session/imported 标记，拒绝删除：' + sessionId)
  }
  return hit
}

async function pruneRegistryAfterDelete(registryDir, sourcePath, sessionId) {
  const data = await loadImports(registryDir)
  const raw = data.imports[sourcePath]
  const record = unwrapRecord(raw)
  if (!record) {
    await removeImport(registryDir, sourcePath)
    return
  }
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
    if (!anyLeft) await removeImport(registryDir, sourcePath)
    else await saveImports(registryDir, data)
    return
  }
  await removeImport(registryDir, sourcePath)
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
  const hit = await assertPluginSession(ctx, sessionId, data)
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

async function cleanupOrphanWorkspaces(ctx) {
  const wr = ctx.get('workspaceRegistry')
  let workspacesRemoved = 0
  if (!wr || typeof wr.list !== 'function') return workspacesRemoved
  for (const ws of wr.list()) {
    const path = ws && (ws.path || ws.cwd)
    const ids = ws && ws.sessionIds
    if (!path || !Array.isArray(ids) || ids.length > 0) continue
    const looksOrphan = /agent-transcripts[/\\][0-9a-f-]{36}/i.test(String(path))
      || String(path).includes('dsh-chat-import-workspace')
    if (!looksOrphan) continue
    if (typeof ws.remove === 'function') {
      try { await ws.remove(); workspacesRemoved++ } catch { /* 工作区删除失败不阻断 */ }
    } else if (typeof wr.remove === 'function') {
      try { await wr.remove(path); workspacesRemoved++ } catch { /* 工作区删除失败不阻断 */ }
    }
  }
  return workspacesRemoved
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
  return { total: uniqueIds.length, deleted, failed, workspacesRemoved, results }
}

/** 按 sourcePath 删除 registry 记录关联的全部会话。 */
export async function purgeBySourcePath(ctx, registryDir, sourcePath, { confirm } = {}) {
  if (confirm !== true) throw new Error('删除需要 confirm:true')
  if (typeof sourcePath !== 'string' || !sourcePath) throw new Error('缺少 sourcePath')
  const registry = await loadImports(registryDir)
  if (!Object.prototype.hasOwnProperty.call(registry.imports, sourcePath)) {
    return { sourcePath, deleted: 0, failed: 0, results: [] }
  }
  const record = unwrapRecord(registry.imports[sourcePath])
  const ids = []
  if (record && record.kind === 'multi') {
    for (const table of ['conversations', 'sessions']) {
      const subs = record[table] && typeof record[table] === 'object' ? record[table] : {}
      for (const sub of Object.values(subs)) {
        if (sub && typeof sub.dshId === 'string') ids.push(sub.dshId)
      }
    }
  } else if (record && typeof record.dshId === 'string') {
    ids.push(record.dshId)
  }
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
