// lib/sources/trae.mjs — Trae Work state.vscdb 读取、发现路径与导入编排
//
// Trae Work 使用 VS Code 风格的 SQLite ItemTable。主会话存储键为
// memento/icube-ai-agent-storage；旧版/变体可能使用 ChatStore、chat.ChatSessionStore.index
// 或安装后缀的 icube-ai-* 键。只读读取这些已知键，按会话 id 去重，再复用 opencode
// 的逐库幂等/增量导入状态机。路径适配覆盖 workspaceStorage 与 globalStorage，
// Windows 的 Trae / TRAE SOLO CN / TRAE SOLO 三类 User 根由 discovery 提供。

import { join } from 'node:path'
import { TextDecoder } from 'node:util'
import { withReadOnlyDb, columnsOf } from './sqlite.mjs'
import { convertTraeJson, extractTraeSessions, normalizeTraeSession } from '../convert/trae.mjs'
import { importOpencodeFile } from './opencode.mjs'
import { beginRegistryBatch, endRegistryBatch, listPersistedIds } from '../imports.mjs'
import { previewEntry } from '../import-core.mjs'
import { createBatchTally, tallyBatch, batchSummary, failedItem } from '../import-batch.mjs'
import { markTrimmedSource } from '../budget.mjs'

export const TRAE_DB_NAME = 'state.vscdb'
export const TRAE_STORAGE_KEY = 'memento/icube-ai-agent-storage'
export const TRAE_FALLBACK_KEYS = [
  'chat.ChatSessionStore.index',
  'ChatStore',
  'memento/icube-ai-chat-storage-7467774676505887760',
  'memento/icube-ai-ng-chat-storage-7467774676505887760',
]

function decodeSqlValue(value) {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return new TextDecoder().decode(value)
  return value === undefined || value === null ? '' : String(value)
}

function readJsonValue(db, statement, key) {
  const row = statement.get(key)
  if (!row) return null
  const text = decodeSqlValue(row.value)
  if (!text.trim()) return null
  try { return JSON.parse(text) } catch { return null }
}

// 库里没有任何 Trae 会话条目（没有已知键，或键在但列表为空）。workspaceStorage 下
// 大多数 state.vscdb 属于从没开过 Trae 对话的工作区，目录模式据此静默跳过；
// 条目存在却一条都认不出（疑似格式漂移）仍走普通 Error 大声失败。
export const TRAE_NO_SESSIONS = 'TRAE_NO_SESSIONS'

export function isTraeNoSessionsError(error) {
  return Boolean(error && error.code === TRAE_NO_SESSIONS)
}

function sessionRows(db) {
  const columns = columnsOf(db, 'ItemTable')
  if (!columns.has('key') || !columns.has('value')) {
    throw new Error('Trae Work 数据库缺少 ItemTable(key,value)')
  }
  const statement = db.prepare('SELECT value FROM ItemTable WHERE key = ?')
  const keys = [TRAE_STORAGE_KEY, ...TRAE_FALLBACK_KEYS]
  const seen = new Set()
  const sessions = []
  let entries = 0
  for (const key of keys) {
    const value = readJsonValue(db, statement, key)
    if (value === null) continue
    const items = extractTraeSessions(value)
    entries += items.length
    for (const item of items) {
      const session = normalizeTraeSession(item, sessions.length)
      if (!session || session.messages.length === 0 || seen.has(session.id)) continue
      seen.add(session.id)
      sessions.push(session)
    }
  }
  if (sessions.length === 0 && entries === 0) {
    throw Object.assign(new Error('Trae Work 数据库没有会话'), { code: TRAE_NO_SESSIONS })
  }
  if (sessions.length === 0) throw new Error('Trae Work 数据库没有可识别会话')
  return sessions
}

export function readTraeDb(dbPath) {
  return withReadOnlyDb(dbPath, sessionRows)
}

function timeValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 100000000000 ? Math.trunc(value * 1000) : Math.trunc(value)
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return timeValue(numeric)
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

export function readTraeDbSummaries(dbPath) {
  return readTraeDb(dbPath).map((session) => {
    const times = [session.createdAt, ...(session.messages || []).map((message) => message.createdAt)]
      .map(timeValue).filter((value) => value !== undefined)
    const createdAt = timeValue(session.createdAt)
    return {
      id: session.id,
      title: session.title,
      directory: session.directory,
      createdAt,
      lastActiveAt: times.length ? Math.max(...times) : createdAt,
    }
  })
}

function entryPath(entry, parent, name) {
  return entry && entry.path ? entry.path : join(parent, name)
}

/**
 * Return only known Trae database layouts; this intentionally does not recursively
 * walk arbitrary user files.
 */
export async function listTraeDatabases(host, target) {
  const found = []
  const seen = new Set()
  const add = async (path) => {
    if (seen.has(path)) return
    const stat = await host.stat(path)
    if (stat && stat.type === 'file' && /(^|[\\/])state\.vscdb$/i.test(path)) {
      seen.add(path)
      found.push(path)
    }
  }
  const addContainer = async (path, kind) => {
    const stat = await host.stat(path)
    if (!stat || stat.type !== 'directory') return
    await add(join(path, TRAE_DB_NAME))
    // 目录名大小写不定（直接传入时取自路径末段）→ 统一小写比较
    if (kind.toLowerCase() !== 'workspacestorage') return
    const entries = await host.readDir(path)
    if (!entries) return
    for (const entry of entries) {
      if (entry.type === 'directory') await add(join(entryPath(entry, path, entry.name), TRAE_DB_NAME))
    }
  }
  const targetStat = await host.stat(target)
  if (!targetStat) return found
  if (targetStat.type === 'file') {
    await add(target)
    return found
  }
  await add(join(target, TRAE_DB_NAME))
  const base = String(target).split(/[\\/]/).pop().toLowerCase()
  if (base === 'workspacestorage' || base === 'globalstorage') {
    await addContainer(target, base)
  } else {
    await addContainer(join(target, 'workspaceStorage'), 'workspaceStorage')
    await addContainer(join(target, 'globalStorage'), 'globalStorage')
  }
  return found
}

export async function findTraeDatabases(ctx, target) {
  const path = target && typeof target === 'object'
    ? (target.displayPath || ctx.fs.processPath(target))
    : String(target)
  const host = {
    async stat(candidate) {
      try {
        const result = await ctx.fs.stat(await ctx.fs.resolve(candidate))
        return result ? { type: result.type } : null
      } catch { return null }
    },
    async readDir(candidate) {
      try {
        const entries = await ctx.fs.listDir(await ctx.fs.resolve(candidate))
        return entries.map((entry) => ({
          name: entry.name,
          type: entry.type,
          path: entry.target && (entry.target.displayPath || entry.target.targetKey),
        }))
      } catch { return null }
    },
  }
  return listTraeDatabases(host, path)
}

export async function importTraeFile(ctx, target, args, options = {}) {
  return importOpencodeFile(ctx, target, args, {
    ...options,
    convert: convertTraeJson,
    readDb: readTraeDb,
    sourceLabel: 'Trae Work',
    importFormat: 'trae',
  })
}

export async function importTraeDirectory(ctx, dirTarget, args, options = {}) {
  const paths = await findTraeDatabases(ctx, dirTarget)
  if (paths.length === 0) throw new Error('未找到 Trae Work state.vscdb：' + (dirTarget.displayPath || ctx.fs.processPath(dirTarget)))
  const persisted = options.persisted ?? await listPersistedIds(ctx)
  const results = []
  const tally = createBatchTally()
  let total = 0
  let empty = 0
  beginRegistryBatch(options.registryDir)
  try {
    for (const path of paths) {
      try {
        const target = await ctx.fs.resolve(path)
        const result = await importTraeFile(ctx, target, args, { ...options, persisted })
        total += typeof result.total === 'number' ? result.total : 0
        tallyBatch(tally, result)
        results.push(...(result.results || []))
      } catch (error) {
        if (isTraeNoSessionsError(error)) { empty++; continue }
        tally.failed++
        results.push(failedItem(path, error))
      }
    }
  } finally {
    await endRegistryBatch()
  }
  if (empty === paths.length) throw new Error('未找到 Trae Work 会话：' + (dirTarget.displayPath || ctx.fs.processPath(dirTarget)))
  return batchSummary(tally, total, results)
}

// ── dry-run 预览（与正式导入同源的只读重演：绕开 registry / decideMulti / 落盘，零副作用）──

// Trae Work 预览：与正式导入共用 state.vscdb 读取器和纯转换器；目录模式只枚举
// 已知的 workspaceStorage/globalStorage 布局，不递归扫描用户目录。
export async function previewTraeFile(ctx, target, args) {
  const path = target.displayPath || ctx.fs.processPath(target)
  const sessions = readTraeDb(path)
  const wanted = Array.isArray(args.sessionIds) && args.sessionIds.length > 0 ? new Set(args.sessionIds) : null
  const results = []
  for (const session of sessions) {
    if (wanted && !wanted.has(session.id)) continue
    const out = markTrimmedSource(convertTraeJson(JSON.stringify(session), { ...args, sourcePath: path }), args)
    if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
      results.push({ path, skipped: 1, skipReason: 'no user turns (session ' + session.id + ')' })
      continue
    }
    results.push({ path, ...previewEntry(out) })
  }
  return { total: sessions.length, results }
}

export async function previewTraeDirectory(ctx, dirTarget, args) {
  const paths = await findTraeDatabases(ctx, dirTarget)
  if (paths.length === 0) throw new Error('未找到 Trae Work state.vscdb：' + (dirTarget.displayPath || ctx.fs.processPath(dirTarget)))
  const results = []
  let total = 0
  let empty = 0
  for (const path of paths) {
    try {
      const target = await ctx.fs.resolve(path)
      const preview = await previewTraeFile(ctx, target, args)
      total += preview.total
      results.push(...preview.results)
    } catch (error) {
      if (isTraeNoSessionsError(error)) { empty++; continue }
      results.push({ path, status: 'failed', error: String((error && error.message) || error) })
    }
  }
  if (empty === paths.length) throw new Error('未找到 Trae Work 会话：' + (dirTarget.displayPath || ctx.fs.processPath(dirTarget)))
  return { total, results }
}
