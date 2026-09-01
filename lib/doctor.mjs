// lib/doctor.mjs — REQ-66 迁移后健康检查（对标 dsh-movein doctor）
//
// 只读检查：imports registry 可读性、导入会话是否仍存在于 sessionPersistence、
// DSH user-agents skills 是否落盘、workspaceRegistry 是否可用。不写任何文件、
// 不触发导入/同步/删除。供 `doctor` 工具与 `/doctor` 命令共用。

import { join } from 'node:path'
import { loadImports, unwrapRecord, listPersistedIds } from './imports.mjs'
import { resolveAgentsHome } from './agents.mjs'

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
    if (sp && typeof sp.readFrom === 'function') {
      for (const id of ids.slice(0, 200)) {
        try {
          const { events } = await sp.readFrom(id, 0)
          const first = Array.isArray(events) && events.length > 0 ? events[0] : undefined
          if (first && first.type === 'session/imported') {
            legacyMarkers++
            if (legacyIds.length < 10) legacyIds.push(id)
          }
        } catch {
          // 日志读不到（已是幽灵会话）：不计入 legacy 标记
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
