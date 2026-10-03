// lib/sources/zed.mjs — Zed 线程库（threads.db）读取与导入编排
//
// 库 = <data_dir>/threads/threads.db（路径规则见 lib/convert/zed.mjs，发现层与导入层共用）。
// 单表 `threads`（无索引、无其它表）：id / summary / updated_at / data_type / data BLOB /
// parent_id / folder_paths / folder_paths_order / created_at。
//   · `data_type ∈ {json, zstd}`，**写入端恒 zstd**（等级 3 的标准帧、无自定义头、无 dictID）
//     —— 用 `fzstd`（纯 JS、已是本仓库依赖）解压，避免依赖 Node 内置 zstd 的版本下限。
//   · `parent_id` 非空 = 子代理线程（上游 UI/ThreadStore 都过滤这些行）→ 本模块同样跳过。
//   · 解压后是 `SerializedThread`（DbThread + version = '0.3.0'）；version 缺失或不同 →
//     上游走 legacy 升级分支，转换器两种方言都认。
//   · `folder_paths` 是**工作区路径集合**（`\n` 连接 + `,` 索引还原顺序）→ 会话 cwd 取首项。
//   · 时间只有行级 created_at/updated_at（RFC3339）；线程内消息没有时间戳。
//
// importZedFile/Directory 把库里每个线程独立落盘（sessionIds 过滤、库指纹短路径、逐线程
// append），恒返回批量形态；标题钉成「Zed · 话题」与 cline/continue/goose 同款。
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Buffer } from 'node:buffer'
import { decompress } from 'fzstd'
import { convertZedJson, zedDataDir, zedThreadsDir, zedThreadsDbPath, zedFolderPaths } from '../convert/index.mjs'
import { loadImports, unwrapRecord, listPersistedIds, archivedSessionIds, argsFingerprint, decideMulti } from '../imports.mjs'
import { finalizeConvertedSession, previewEntry } from '../import-core.mjs'
import { markTrimmedSource } from '../budget.mjs'

// 路径规则在 lib/convert/zed.mjs（纯函数）；这里转发给工具层。
export { zedDataDir, zedThreadsDir, zedThreadsDbPath, zedFolderPaths }

function closeQuietly(db) {
  try {
    db.close()
  } catch {
    // 关闭失败不影响调用方要的结论（读不到 / 已读完）
  }
}

function columnsOf(db, table) {
  return new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map((c) => c.name))
}

// 库签名 + 行读取（读不到 / 非 Zed 线程库 → null）。签名按上游事实：**只有 threads 一张表**
// 且 data_type / data / summary 三列共存。
function readZedRows(dbPath) {
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    return null
  }
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    if (tables.length !== 1 || tables[0] !== 'threads') {
      closeQuietly(db)
      return null
    }
    const cols = columnsOf(db, 'threads')
    if (!cols.has('id') || !cols.has('summary') || !cols.has('data_type') || !cols.has('data')) {
      closeQuietly(db)
      return null
    }
    const rows = db.prepare('SELECT * FROM threads').all()
      .filter((row) => typeof row.id === 'string' && row.id
        // 子代理线程（parent_id 非空）不单独成会话，与上游 UI 过滤一致
        && !(cols.has('parent_id') && row.parent_id))
    return { db, cols, rows }
  } catch {
    // 表结构不符 / 库损坏 / 锁定：按「无此库」处理
    closeQuietly(db)
    return null
  }
}

// 一行 → 线程对象（`data` 解压 + JSON.parse）。解压/解析失败返回 null（调用方跳过并计数）。
function decodeThreadRow(row) {
  const dataType = String(row.data_type || '').toLowerCase()
  let text
  try {
    if (dataType === 'zstd') {
      const bytes = row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data)
      text = Buffer.from(decompress(bytes)).toString('utf8')
    } else if (dataType === 'json') {
      text = typeof row.data === 'string' ? row.data : Buffer.from(row.data).toString('utf8')
    } else {
      // 上游遇到未知 data_type 会直接报错（bail!）→ 这里同样拒绝，不猜格式
      return null
    }
  } catch {
    // 压缩帧损坏 / 非 UTF-8：跳过该线程（绝不半读）
    return null
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Zed 线程库 → 线程摘要数组（发现层用，不解压 blob）。非 Zed 库/读不到 → null。 */
export function readZedThreads(dbPath) {
  const read = readZedRows(dbPath)
  if (!read) return null
  try {
    const out = []
    for (const row of read.rows) {
      const folderPaths = read.cols.has('folder_paths') ? row.folder_paths : null
      const folderOrder = read.cols.has('folder_paths_order') ? row.folder_paths_order : null
      const paths = zedFolderPaths(folderPaths, folderOrder)
      out.push({
        id: row.id,
        title: typeof row.summary === 'string' ? row.summary : '',
        cwd: paths.length > 0 ? paths[0] : null,
        folderPaths: paths,
        createdAt: read.cols.has('created_at') ? row.created_at : null,
        updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
      })
    }
    return out
  } finally {
    read.db.close()
  }
}

/** Zed 线程库 → 完整中间 JSON 数组（导入/预览用：解压 + 附行级元数据）。 */
export function readZedDb(dbPath) {
  const read = readZedRows(dbPath)
  if (!read) return null
  try {
    const out = []
    const failed = []
    for (const row of read.rows) {
      const thread = decodeThreadRow(row)
      if (!thread) { failed.push(row.id); continue }
      const paths = zedFolderPaths(
        read.cols.has('folder_paths') ? row.folder_paths : null,
        read.cols.has('folder_paths_order') ? row.folder_paths_order : null,
      )
      out.push({
        ...thread,
        // 行级元数据优先于 blob 内字段（同源；DB 列是查询依据）
        id: row.id,
        summary: typeof row.summary === 'string' && row.summary ? row.summary : thread.summary,
        created_at: read.cols.has('created_at') && row.created_at ? row.created_at : thread.created_at,
        updated_at: typeof row.updated_at === 'string' && row.updated_at ? row.updated_at : thread.updated_at,
        folderPaths: paths,
      })
    }
    return { threads: out, failed }
  } finally {
    read.db.close()
  }
}

/** 库里每个线程独立落盘（sessionIds 过滤 + 库指纹短路径 + 逐线程 append）。 */
export async function importZedFile(ctx, target, args, { registryDir, persisted, runDecision, markTrimmedSource, fingerprintKeys = [] } = {}) {
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  const archivedIds = archivedSessionIds(ctx)
  const path = target.displayPath || ctx.fs.processPath(target)
  const stat = await ctx.fs.stat(target)
  const registry = await loadImports(registryDir)
  let known = unwrapRecord(registry.imports[path])
  if (known && known.kind !== 'multi') known = null
  const fingerprint = argsFingerprint(args, fingerprintKeys)

  // S3 短路径（不重读 SQLite）：记录里所有线程仍存在且未归档时成立
  if (known && (!known.sessions || typeof known.sessions !== 'object')) known = null
  if (known && args.force !== true) {
    const subs = Object.values(known.sessions)
    const allPersisted = subs.length > 0 && subs.every((sub) => persistedSet.has(sub.dshId) && !archivedIds.has(sub.dshId))
    if (allPersisted) {
      const skipResults = () => Object.entries(known.sessions).map(([, sub]) => ({
        path, status: 'already-imported', sessionId: sub.dshId, turns: sub.turns, messages: 0, toolCalls: 0, skipped: 0,
      }))
      if (typeof known.args === 'string' && fingerprint !== known.args) {
        const results = skipResults().map((r) => ({ ...r, argsChanged: true }))
        return { total: results.length, imported: 0, alreadyImported: results.length, appended: 0, skipped: 0, failed: 0, results }
      }
      if (typeof known.budget === 'number' && known.budget !== args.budget) {
        const results = skipResults().map((r) => ({ ...r, budgetChanged: true }))
        return { total: results.length, imported: 0, alreadyImported: results.length, appended: 0, skipped: 0, failed: 0, results }
      }
      if (stat && stat.version === known.version && stat.size === known.sizeBytes) {
        const count = Object.keys(known.sessions).length
        return { total: count, imported: 0, alreadyImported: count, appended: 0, skipped: 0, failed: 0, results: skipResults() }
      }
    }
  }

  const decoded = readZedDb(path)
  if (!decoded) throw new Error('不是 Zed 线程库（缺 threads 单表或 data_type/data/summary 列）: ' + path)
  const wanted = Array.isArray(args.sessionIds) && args.sessionIds.length > 0 ? new Set(args.sessionIds) : null
  const items = []
  const preSkipped = []
  for (const thread of decoded.threads) {
    if (wanted && !wanted.has(thread.id)) continue
    const out = finalizeConvertedSession(
      markTrimmedSource(convertZedJson(JSON.stringify(thread), {
        ...args,
        zedId: thread.id,
        cwd: thread.folderPaths && thread.folderPaths.length > 0 ? thread.folderPaths[0] : undefined,
        sourcePath: path,
      }), args),
      args,
      'Zed',
    )
    if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
      preSkipped.push({ path, status: 'skipped', reason: 'no user turns (thread ' + thread.id + ')' })
      continue
    }
    items.push({ key: thread.id, converted: out })
  }
  for (const id of decoded.failed) {
    // 解压/解析失败的线程显式上报，不静默少导
    preSkipped.push({ path, status: 'skipped', reason: 'undecodable thread payload (' + id + ')' })
  }
  const decision = await decideMulti(ctx, {
    known, items, stat, args, fingerprint, persisted: persistedSet, sourcePath: path,
    subTable: 'sessions', budget: args.budget, archivedIds, importFormat: 'zed',
  })
  const missing = known && known.sessions
    ? Object.keys(known.sessions).filter((k) => !decoded.threads.some((t) => t.id === k))
    : []
  const result = await runDecision(ctx, decision, registryDir, path, persistedSet, { workspaceMode: args.workspaceMode, workspaceDir: args.workspaceDir })
  return {
    ...result,
    total: decoded.threads.length,
    skipped: result.skipped + preSkipped.length,
    results: [...preSkipped, ...result.results],
    ...(missing.length ? { missingFromSource: missing } : {}),
  }
}

// 目录导入：目录里定位 threads.db（`<dir>/threads.db` 或 `<dir>/threads/threads.db`）
export async function importZedDirectory(ctx, dirTarget, args, options = {}) {
  const dirPath = dirTarget.displayPath || ctx.fs.processPath(dirTarget)
  for (const candidate of [join(dirPath, 'threads.db'), join(dirPath, 'threads', 'threads.db')]) {
    const info = await ctx.fs.stat(await ctx.fs.resolve(candidate))
    if (info && info.type === 'file') return importZedFile(ctx, await ctx.fs.resolve(candidate), args, options)
  }
  return importZedFile(ctx, await ctx.fs.resolve(join(dirPath, 'threads.db')), args, options)
}

// ── dry-run 预览（与正式导入同源的只读重演：绕开 registry / decideMulti / 落盘，零副作用）──

// zed 预览：threads.db 一库多线程，只读重演（绕开 registry / decideMulti / 落盘）。
export async function previewZedFile(ctx, target, args) {
  const path = target.displayPath || ctx.fs.processPath(target)
  const decoded = readZedDb(path)
  if (!decoded) throw new Error('不是 Zed 线程库（缺 threads 单表或 data_type/data/summary 列）: ' + path)
  const wanted = Array.isArray(args.sessionIds) && args.sessionIds.length > 0 ? new Set(args.sessionIds) : null
  const results = []
  for (const thread of decoded.threads) {
    if (wanted && !wanted.has(thread.id)) continue
    const out = finalizeConvertedSession(
      markTrimmedSource(convertZedJson(JSON.stringify(thread), {
        ...args,
        zedId: thread.id,
        cwd: thread.folderPaths && thread.folderPaths.length > 0 ? thread.folderPaths[0] : undefined,
        sourcePath: path,
      }), args),
      args,
      'Zed',
    )
    if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
      results.push({ path, skipped: 1, skipReason: 'no user turns (thread ' + thread.id + ')' })
      continue
    }
    results.push({ path, ...previewEntry(out) })
  }
  for (const id of decoded.failed) {
    results.push({ path, skipped: 1, skipReason: 'undecodable thread payload (' + id + ')' })
  }
  return { total: decoded.threads.length, results }
}

export async function previewZedDirectory(ctx, dirTarget, args) {
  const dirPath = dirTarget.displayPath || ctx.fs.processPath(dirTarget)
  for (const candidate of [join(dirPath, 'threads.db'), join(dirPath, 'threads', 'threads.db')]) {
    const info = await ctx.fs.stat(await ctx.fs.resolve(candidate))
    if (info && info.type === 'file') return previewZedFile(ctx, await ctx.fs.resolve(candidate), args)
  }
  return previewZedFile(ctx, await ctx.fs.resolve(join(dirPath, 'threads.db')), args)
}
