// lib/retract.mjs — REQ-33 导入识别 / 撤回（只读）
//
// 上游缺口：平台 sessionPersistence 无 delete 面（create / append / locate /
// readRaw / prepare / load / inspect / readFrom / list / listSnapshots，无
// remove），fs 亦无 removeFile——「撤回」= 识别 + 引导手动删工件 + 移除 imports
// registry 记录（removeImport），绝不调用任何删除。
//
// list_imported_sessions：只读枚举 list() 的每个会话，imports registry 的 dshId 反查
// 是权威信号（0.8.3 起日志不再写 session/imported 标记，issue #34）；旧日志标记仍作
// 兜底证据（registry 记录被撤回后标记留在日志里）。命中会话用 locate() 取工件路径、
// 同一份事件里取 session/title 标题。
//
// retract_import：按 sessionId（imports registry 反查优先、旧日志标记兜底）或
// sourcePath 定位 registry 键 → removeImport 移除记录 → 返回手动删除引导。幂等：
// 标记留在日志里，记录移除后再次撤回仍能定位、removeImport 空转。

import { loadImports, removeImport, unwrapRecord } from './imports.mjs'

// 读会话日志一次：{ marker, events }。marker 为 session/imported 首事件或 null；
// readFrom 不可用 / 读失败返回 null → 调用方用 registry 兜底（单会话读失败不
// 打断识别枚举，也不视为无标记）。
async function readSessionLog(sp, id) {
  if (!sp || typeof sp.readFrom !== 'function') return null
  try {
    const { events } = await sp.readFrom(id, 0)
    const list = Array.isArray(events) ? events : []
    const first = list.length > 0 ? list[0] : undefined
    return { marker: first && first.type === 'session/imported' ? first : null, events: list }
  } catch {
    // 日志读不到（损坏 / 后端瞬断）：交给 registry 兜底识别
    return null
  }
}

// imports registry 的 dshId 索引：dshId → { sourcePath, importedAt }。single 记录
// 取 dshId；multi 记录取 conversations/sessions 子表全部 dshId（同一 sourcePath
// 可对应多个会话）；旧版纯字符串记录（无 dshId）跳过。
function registryDshIdMap(imports) {
  const map = new Map()
  for (const [sourcePath, raw] of Object.entries(imports || {})) {
    const record = unwrapRecord(raw)
    if (!record || typeof record !== 'object') continue
    if (record.kind === 'multi') {
      const sub = record.conversations || record.sessions
      if (sub && typeof sub === 'object') {
        for (const s of Object.values(sub)) {
          if (s && typeof s.dshId === 'string') {
            map.set(s.dshId, { sourcePath, importedAt: typeof record.importedAt === 'number' ? record.importedAt : undefined })
          }
        }
      }
    } else if (typeof record.dshId === 'string') {
      map.set(record.dshId, { sourcePath, importedAt: typeof record.importedAt === 'number' ? record.importedAt : undefined })
    }
  }
  return map
}

// 会话标题：session/title 事件 data.title（日志末尾，倒扫）。无显式标题源
//（codex/cursor/gemini 等首问兜底）返回 undefined，DSH UI 自动回退首条 user 文本。
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

// 会话工件路径：sessionPersistence.locate(header)（同步、不落盘不物化）。SQLite
// 等无单会话工件的后端返回 undefined → null；locate 抛错按无工件处理。
function sessionArtifactPath(sp, header) {
  try {
    const loc = sp && typeof sp.locate === 'function' ? sp.locate(header) : undefined
    return loc && typeof loc.path === 'string' ? loc.path : null
  } catch {
    // 异常 header：locate 抛错按无工件处理，不打断识别枚举
    return null
  }
}

export async function listImportedSessions(ctx, registryDir) {
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof sp.list !== 'function' || typeof sp.readFrom !== 'function') {
    throw new Error('sessionPersistence 不可用（需要 list + readFrom + locate）')
  }
  const headers = await sp.list()
  const byDshId = registryDshIdMap((await loadImports(registryDir)).imports)
  const sessions = []
  for (const header of headers) {
    const rec = byDshId.get(header.id)
    const info = await readSessionLog(sp, header.id)
    if (rec) {
      // registry 反查是权威信号（0.8.3 起日志不再写标记，issue #34）；旧日志标记
      // 的 importedAt 仍比 registry 快照精确，取得到就用它
      const entry = {
        sessionId: header.id,
        sourcePath: rec.sourcePath,
        artifactPath: sessionArtifactPath(sp, header),
      }
      if (info) {
        const title = sessionTitleFromEvents(info.events)
        if (title) entry.title = title
        const marker = info.marker
        if (marker && marker.data && typeof marker.data.importedAt === 'number') entry.importedAt = marker.data.importedAt
        else if (typeof rec.importedAt === 'number') entry.importedAt = rec.importedAt
      } else if (typeof rec.importedAt === 'number') {
        entry.importedAt = rec.importedAt
      }
      sessions.push(entry)
    } else if (info && info.marker) {
      // 旧日志标记兜底：registry 记录已被撤回但标记仍在日志（二次撤回定位依赖）
      const data = info.marker.data || {}
      const title = sessionTitleFromEvents(info.events)
      const entry = {
        sessionId: header.id,
        sourcePath: typeof data.sourcePath === 'string' && data.sourcePath ? data.sourcePath : null,
        artifactPath: sessionArtifactPath(sp, header),
      }
      if (title) entry.title = title
      if (typeof data.importedAt === 'number') entry.importedAt = data.importedAt
      sessions.push(entry)
    }
  }
  return { total: sessions.length, sessions }
}

// 定位 sessionId 对应的 registry 键（sourcePath）：imports registry 反查优先
//（0.8.3 起日志不再写标记，issue #34）；旧日志标记 data.sourcePath 兜底（registry
// 记录被撤回后标记仍在日志里 → 二次撤回幂等）。都不是本插件导入的会话返回 null。
async function findSourcePathForSession(sp, sessionId, registry) {
  for (const [key, raw] of Object.entries(registry.imports || {})) {
    const record = unwrapRecord(raw)
    if (!record || typeof record !== 'object') continue
    if (record.kind === 'multi') {
      const sub = record.conversations || record.sessions
      if (sub && typeof sub === 'object' && Object.values(sub).some((s) => s && s.dshId === sessionId)) return key
    } else if (record.dshId === sessionId) {
      return key
    }
  }
  const info = sp ? await readSessionLog(sp, sessionId) : null
  if (info && info.marker && info.marker.data && typeof info.marker.data.sourcePath === 'string' && info.marker.data.sourcePath) {
    return info.marker.data.sourcePath
  }
  return null
}

// 记录关联的全部 DSH 会话 id（single: [dshId]；multi: 子表全部）。
function recordDshIds(record) {
  if (!record || typeof record !== 'object') return []
  if (record.kind === 'multi') {
    const sub = record.conversations || record.sessions
    return sub && typeof sub === 'object'
      ? Object.values(sub).map((s) => s && s.dshId).filter((id) => typeof id === 'string')
      : []
  }
  return typeof record.dshId === 'string' ? [record.dshId] : []
}

async function findHeader(sp, id) {
  if (!sp || typeof sp.list !== 'function') return null
  try {
    const headers = await sp.list()
    return headers.find((h) => h.id === id) || null
  } catch {
    // list 失败（后端不可用）：按找不到 header 处理，工件路径留 null
    return null
  }
}

export async function retractImport(ctx, args, registryDir) {
  const sp = ctx.get('sessionPersistence')
  const sessionId = typeof args.sessionId === 'string' && args.sessionId ? args.sessionId : null
  const sourcePath = typeof args.sourcePath === 'string' && args.sourcePath ? args.sourcePath : null
  if (!sessionId && !sourcePath) throw new Error('retract_import 需要 sessionId 或 sourcePath（二选一）')
  const registry = await loadImports(registryDir)
  const key = sourcePath || await findSourcePathForSession(sp, sessionId, registry)
  if (!key) {
    throw new Error('会话无导入标记且不在 imports registry: ' + sessionId + '（不是本插件导入的会话）')
  }
  const wasRegistered = Object.prototype.hasOwnProperty.call(registry.imports, key)
  const record = unwrapRecord(registry.imports[key])
  const ids = recordDshIds(record)
  await removeImport(registryDir, key)

  // 工件路径：仅 sessionId 时用该会话 header；仅 sourcePath 且记录只关联一个会话
  // 时用它（multi 多会话 → 逐个用 sessionId 撤回才能拿到各自工件路径）
  let artifactPath = null
  if (sessionId) {
    const header = await findHeader(sp, sessionId)
    artifactPath = header ? sessionArtifactPath(sp, header) : null
  } else if (ids.length === 1) {
    const header = await findHeader(sp, ids[0])
    artifactPath = header ? sessionArtifactPath(sp, header) : null
  }
  const manualDelete = artifactPath
    ? '请手动删除工件目录 ' + artifactPath + '（本插件不删会话，DSH 无 delete 面）。'
      + 'DSH 宿主内存索引仍保留该会话 id（幽灵会话），彻底从会话列表消失需重启 dsh；'
      + '期间同源重导会自动另铸后缀新 id 并报告 staleGhost（issue #22）。'
    : ids.length > 1
      ? '该源文件导入了 ' + ids.length + ' 个会话，请用 list_imported_sessions 按 sessionId 逐个撤回以获取各工件路径（本插件不删会话，DSH 无 delete 面）'
      : '会话工件不存在（可能已手动删除）；registry 记录已移除（本插件不删会话，DSH 无 delete 面）。'
        + '若宿主内存仍残留该会话 id（幽灵会话），彻底消失需重启 dsh，期间同源重导会自动另铸后缀新 id（issue #22）'
  return { removed: true, sourcePath: key, artifactPath, manualDelete, wasRegistered }
}
