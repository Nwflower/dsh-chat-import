// lib/discovery/discover.mjs — 会话发现主流程：目标展开 → 逐目标扫描（TTL / 进行中去重 / 书签）
// → 状态标注（importStatus + git 分支）→ query 过滤与排序

import { dirnameOf } from './common.mjs'
import { scanCache, inflightScans, createBookmarkStore } from './scan-cache.mjs'
import { gitStatusOf } from './git-status.mjs'
import { resolveImportStatus } from './import-status.mjs'
import { FORMATS, defaultRoots, sourceOf, fileFormatsForPath } from './registry.mjs'
import { createRunHost } from './run-host.mjs'

// 单格式扫描：单个数据根读取失败（权限/损坏）只跳过该格式，不拖垮整次发现
//（host 的 stat/readText/readDir 已把常见缺失归一为 null；此处兜底异常）。
// bm 为可选持久化书签 store（缺省走纯扫描）。
export async function scanFormat(host, format, target, bm, emit) {
  const source = sourceOf(format)
  if (!source) return []
  try {
    return await source.scan(host, target, { bm, emit, format })
  } catch {
    // 该格式扫描抛错（个别根损坏等）→ 返回空，其余格式不受影响
    return []
  }
}

// 目标展开：path 缺省 → 各来源默认根（数组根逐个展开，null 根跳过）；
// path 目录 → format 指定则单格式、否则全部格式探测；path 文件 → 路径特征判格式。
async function buildTargets({ path, format, roots, host }) {
  const targets = []
  const push = (fmt, target) => { if (target !== null && target !== undefined) targets.push([fmt, String(target)]) }
  if (path) {
    const st = await host.stat(path)
    if (!st) return []
    if (st.type === 'file') {
      const fmts = format ? [format] : fileFormatsForPath(path)
      for (const f of fmts) push(f, path)
      return targets
    }
    const fmts = format ? [format] : FORMATS
    for (const f of fmts) push(f, path)
    return targets
  }
  const fmts = format ? [format] : FORMATS
  for (const f of fmts) {
    const root = roots[f]
    if (Array.isArray(root)) {
      for (const r of root) push(f, r)
    } else {
      push(f, root)
    }
  }
  return targets
}

function matchQuery(s, query) {
  // query 缺省（undefined/null）等同空串不过滤——产出路径（onEntry）与旧调用方共用
  const q = query === null || query === undefined ? '' : String(query).trim().toLowerCase()
  if (!q) return true
  return [s.title, s.project, s.sourcePath].some((v) => typeof v === 'string' && v.toLowerCase().includes(q))
}

/** 会话发现主入口。返回 { sessions, total }（按最近活跃降序）。
 * archivedIds（可选）为已归档会话 id 集合，传给 resolveImportStatus 标注 'archived'
 *（调用方从 workspaceRegistry.archivedSessionIds 取，见 lib/imports.mjs 的
 * archivedSessionIds 助手；缺省不标注）。
 * persistedIds（可选）为宿主当前已加载/持久化的会话 id 集合（Set 或数组）：过滤宿主已加载的
 * 原生会话（避免 DSH 自身会话自扫描与重导），并让 resolveImportStatus 把「注册表指向的会话
 * 已被删除」标成 not-imported。 */
export async function discoverSessions({ path, format, query, home, host: baseHost, imports, cache, cacheDir, archivedIds, onEntry, persistedIds } = {}) {
  if (!baseHost || typeof baseHost.stat !== 'function' || typeof baseHost.readHead !== 'function'
    || typeof baseHost.readText !== 'function' || typeof baseHost.readDir !== 'function') {
    throw new Error('discoverSessions 需要 host（stat/readHead/readText/readDir/readSessions）')
  }
  // 本次发现内目录列举 / stat / slug 解码记忆化（各来源扫描器共享同一棵树的查询结果）
  const host = createRunHost(baseHost)
  const roots = defaultRoots({ home })
  const targets = await buildTargets({ path, format, roots, host })
  const ttlCache = cache ?? scanCache
  // 持久化书签懒加载：30s 内 TTL 全命中时不碰盘；save 只在有更新时原子写
  const bmStore = cacheDir ? await createBookmarkStore(String(cacheDir)) : null
  // onEntry（可选）逐条产出：状态标注（importStatus + git 分支）与 query 过滤移到
  // 产出路径，调用方边扫边渲染（面板流式）；缺省时只在扫描结束后整体返回。
  const reg = imports && typeof imports === 'object' ? imports : {}
  const persisted = persistedIds instanceof Set ? persistedIds
    : Array.isArray(persistedIds) ? new Set(persistedIds)
    : null
  // 宿主已加载的原生会话（native session）：id 存在于 sessionPersistence 中、且在 imports
  // 注册表里无导入记录。该类会话本就存在于宿主中，不应作为外部待导入会话扫出（避免套娃与自导入）。
  const isPersistedNative = (entry) => {
    if (!persisted || !entry || !entry.sessionId || !persisted.has(entry.sessionId)) return false
    // DSH 自身来源例外：dsh / dsh4 的条目就是宿主自己的会话日志，用途正是把某条日志
    // 复制 / 迁移成另一代次的会话（V3 ↔ V4），按「宿主已加载」隐藏就等于这个来源永远为空。
    // 其余来源照旧隐藏（避免把宿主已有的外部会话当待导入项套娃自导）。
    if (entry.format === 'dsh' || entry.format === 'dsh4') return false
    const record = reg[entry.sourcePath]
    return !record
  }
  const gitCache = new Map()
  const emitMapped = typeof onEntry === 'function'
    ? async (entry) => {
      if (isPersistedNative(entry)) return
      const mapped = {
        ...entry,
        importStatus: resolveImportStatus(reg, entry.sourcePath, entry.sessionId, archivedIds, persisted),
        ...(await gitStatusOf(entry.cwd || dirnameOf(entry.sourcePath), gitCache)),
      }
      if (matchQuery(mapped, query)) onEntry(mapped)
    }
    : null
  const all = []
  for (const [fmt, target] of targets) {
    const key = fmt + '|' + target
    let entries = ttlCache.get(key)
    let startedHere = false
    if (entries === undefined) {
      // 进行中扫描去重：同 key 并发调用共享一个 Promise，避免多会话同时启动时叠加全量扫描。
      let inflight = inflightScans.get(key)
      if (!inflight) {
        inflight = (async () => {
          try {
            // 本调用启动的扫描：walker 内已按条目逐条 emit（emitMapped 一路透传）
            const result = await scanFormat(host, fmt, target, bmStore, emitMapped)
            ttlCache.set(key, result)
            return result
          } finally {
            inflightScans.delete(key)
          }
        })()
        inflightScans.set(key, inflight)
        startedHere = true
      }
      entries = await inflight
    }
    // 缓存命中 / 加入他人正在跑的扫描：本调用没有机会逐条产出 → 整批补齐
    //（自己启动的扫描已在 walker 内逐条 emit，绝不重复）。
    if (emitMapped && !startedHere && entries.length > 0) {
      for (const e of entries) await emitMapped(e)
    }
    all.push(...entries)
  }
  if (bmStore) {
    try {
      await bmStore.save()
    } catch (err) {
      // 书签写盘失败只影响下次缓存，不影响本次扫描结果
      console.warn('[dsh-chat-import] scan 书签写盘失败（不影响本次扫描）：' + String((err && err.message) || err))
    }
  }
  const visible = persisted ? all.filter((e) => !isPersistedNative(e)) : all
  const sessions = await Promise.all(visible.map(async (e) => ({
    ...e,
    importStatus: resolveImportStatus(reg, e.sourcePath, e.sessionId, archivedIds, persisted),
    ...(await gitStatusOf(e.cwd || dirnameOf(e.sourcePath), gitCache)),
  })))
  const filtered = query ? sessions.filter((s) => matchQuery(s, query)) : sessions
  filtered.sort((a, b) => (b.lastActiveAt ?? b.createdAt ?? 0) - (a.lastActiveAt ?? a.createdAt ?? 0))
  return { sessions: filtered, total: filtered.length }
}
