// lib/doctor.mjs — REQ-66 迁移后健康检查（对标 dsh-movein doctor）
//
// 只读检查：imports registry 可读性、导入会话是否仍存在于 sessionPersistence、
// DSH user-agents skills 是否落盘、workspaceRegistry 是否可用。不写任何文件、
// 不触发导入/同步/删除。供 `doctor` 工具与 `/doctor` 命令共用。

import { dirname, join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { loadImports, unwrapRecord, listPersistedIds, readSessionEvents, canReadSessionEvents } from './imports.mjs'
import { resolveAgentsHome } from './agents.mjs'

/** 磁盘上的导入会话工件目录 id 列表（`<sessionsRoot>/<bucket>/import-*`）。
 * 宿主的 list() 读不出的旧格式 / 半成品会话不会出现在 sessionPersistence 里，但目录
 * 仍占用 id——留着它们，重导时会撞 already-exists 只能另铸后缀新副本（issue #41）。
 * 只读列举，供 doctor 报告（清理是用户的决定，doctor 不动任何文件）。
 * @param {string} root 宿主会话工件根目录（由 registryDir 同域派生，见 runDoctor）。 */
export async function listImportArtifactIds(root) {
  const ids = []
  let buckets
  try {
    buckets = await readdir(root, { withFileTypes: true })
  } catch {
    return ids
  }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    let entries
    try {
      entries = await readdir(join(root, bucket.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('import-')) ids.push(entry.name)
    }
  }
  return ids
}

/** 从 imports registry 收集所有已导入会话 id（single + multi 子表）。纯整理。 */
export function collectImportedIds(registry) {
  const ids = []
  for (const entry of Object.values(registry.imports || {})) {
    const rec = unwrapRecord(entry)
    if (!rec) continue
    if (rec.kind === 'multi') {
      for (const table of ['conversations', 'sessions']) {
        const subs = rec[table] && typeof rec[table] === 'object' ? rec[table] : {}
        for (const sub of Object.values(subs)) {
          const r = unwrapRecord(sub)
          if (r && typeof r.dshId === 'string') ids.push(r.dshId)
        }
      }
    } else if (typeof rec.dshId === 'string') {
      ids.push(rec.dshId)
    }
  }
  return ids
}

/**
 * 执行健康检查（只读）。
 * @param {object} ctx host ctx（fs / sessionPersistence / workspaceRegistry）
 * @param {string} registryDir imports registry 目录
 * @returns {object} { ok, checks, issues, totals }
 */
export async function runDoctor(ctx, registryDir) {
  const checks = []
  const issues = []
  let records = 0
  let registryOk = true

  try {
    const registry = await loadImports(registryDir)
    records = Object.keys(registry.imports || {}).length
    checks.push({ name: 'registry', ok: true, detail: `${records} 条源导入记录` })
    if (records === 0) issues.push('imports registry 为空：没有可检查的导入记录')
  } catch (err) {
    registryOk = false
    checks.push({ name: 'registry', ok: false, detail: String((err && err.message) || err) })
    issues.push('imports registry 读取失败')
  }

  const ids = registryOk ? collectImportedIds(await loadImports(registryDir)) : []
  let persisted = new Set()
  try {
    persisted = await listPersistedIds(ctx)
  } catch {
    // sessionPersistence 缺席/失败按无持久化集处理，下方会报告缺失
  }
  const missingSessions = ids.filter((id) => !persisted.has(id))
  checks.push({
    name: 'sessions',
    ok: missingSessions.length === 0,
    detail: `${ids.length} 个导入会话，缺失 ${missingSessions.length}`,
  })
  if (missingSessions.length > 0) {
    issues.push(`以下导入会话在 sessionPersistence 中不存在：${missingSessions.slice(0, 10).join(', ')}${missingSessions.length > 10 ? ' …' : ''}`)
  }

  // 旧版导入标记检测（issue #34）：0.8.2 及以前在日志头写入 session/imported 事件——
  // dsh ≥ 0.1.2-alpha 的 fail-closed 事件词汇表会拒绝加载整份日志（会话点开即报
  // unknown event type）。面板「刷新已导入」（从源重新转换覆盖）可修复。
  let legacyMarkers = 0
  const legacyIds = []
  if (registryOk && ids.length > 0) {
    const sp = ctx.get('sessionPersistence')
    if (canReadSessionEvents(sp)) {
      for (const id of ids.slice(0, 200)) {
        // 读不到（已是幽灵会话）返回 null：不计入 legacy 标记
        const events = await readSessionEvents(ctx, id, 0)
        const first = events && events.length > 0 ? events[0] : undefined
        if (first && first.type === 'session/imported') {
          legacyMarkers++
          if (legacyIds.length < 10) legacyIds.push(id)
        }
      }
      checks.push({
        name: 'legacy-marker',
        ok: legacyMarkers === 0,
        detail: `已检查 ${Math.min(ids.length, 200)} 个会话，${legacyMarkers} 个带旧版导入标记`,
      })
      if (legacyMarkers > 0) {
        issues.push('以下会话日志带旧版 session/imported 标记，dsh ≥ 0.1.2-alpha 会拒绝加载'
          + '（issue #34）：' + legacyIds.join(', ') + (legacyMarkers > legacyIds.length ? ' …' : '')
          + '。可在导入面板对对应来源点「刷新已导入」修复（从源文件重新转换覆盖）。')
      }
    }
  }

  // 磁盘残留（issue #41）：既不在 registry、也不在 sessionPersistence 的导入工件
  // 目录——宿主读不出的旧格式/半成品会话。它们占用会话 id，重导会另铸带后缀的新
  // 副本；确认不需要后可手工删除。sessionPersistence 缺席时不做此判断（拿不到
  // 反证，宁可少报）。
  const sp0 = ctx.get('sessionPersistence')
  if (sp0 && typeof sp0.list === 'function') {
    // registryDir = `<DSH_HOME>/dsh-chat-import`，会话工件与之同域（index.mjs 传入口径）
    const sessionsRoot = join(dirname(registryDir), 'sessions')
    const stray = (await listImportArtifactIds(sessionsRoot)).filter((id) => !ids.includes(id) && !persisted.has(id))
    checks.push({
      name: 'stray-artifacts',
      ok: stray.length === 0,
      detail: stray.length === 0 ? '无残留导入会话目录' : `磁盘上有 ${stray.length} 个导入会话目录既不在 registry 也不在宿主`,
    })
    if (stray.length > 0) {
      issues.push('以下导入会话目录在磁盘上存在，但既不在 imports registry 也不在 sessionPersistence 中'
        + `（宿主读不出的旧格式或半成品会话）：${stray.slice(0, 10).join(', ')}${stray.length > 10 ? ' …' : ''}`
        + '。它们占用会话 id，重新导入会另铸带后缀的新副本；确认不需要后可手工删除对应目录。')
    }
  }

  let skillCount = 0
  try {
    const skillsRoot = join(resolveAgentsHome(), 'skills')
    const dirTarget = await ctx.fs.resolve(skillsRoot)
    const entries = await ctx.fs.listDir(dirTarget)
    skillCount = entries.filter((e) => e.type === 'directory').length
    checks.push({ name: 'skills', ok: true, detail: `${skillCount} 个 skill bundle` })
  } catch {
    checks.push({ name: 'skills', ok: false, detail: 'skills 目录不存在或不可读（尚未执行 import_agents 时正常）' })
  }

  let workspaceOk = false
  try {
    const wr = ctx.get('workspaceRegistry')
    workspaceOk = !!wr && typeof wr.resolveByPath === 'function'
    checks.push({ name: 'workspaceRegistry', ok: workspaceOk, detail: workspaceOk ? '可用' : '不可用（不会阻塞导入，但会话可能显示为未分组）' })
    if (!workspaceOk && ids.length > 0) issues.push('workspaceRegistry 不可用，已导入会话可能显示为未分组')
  } catch {
    checks.push({ name: 'workspaceRegistry', ok: false, detail: '读取失败' })
  }

  return {
    ok: issues.length === 0,
    checks,
    issues,
    totals: { records, sessions: ids.length, missingSessions: missingSessions.length, skills: skillCount },
  }
}
