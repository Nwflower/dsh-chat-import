// Cursor 的可选工作区登记册（host 面）：composerHeaders 无公开 schema 承诺。
// 仅认 composerId、可选 workspaceId/value；value.workspaceIdentifier.uri.fsPath
// 或 workspaceStorage/<workspaceId>/workspace.json.folder 指向现存目录才采用。
// 缺库、锁库、schema 漂移均视为无登记，调用方保留 projects/<slug> 解码兜底。
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { columnsOf, hasTable, readOptionalDb } from './sqlite.mjs'

export function cursorUserDataDir(home = homedir(), env = process.env, platform = process.platform) {
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Cursor', 'User')
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Cursor', 'User')
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Cursor', 'User')
}

const workspaceCache = new WeakMap()
const CACHE_MS = 30_000

function parseWorkspaceJson(raw, counts, category) {
  try { return JSON.parse(raw) } catch {
    counts[category]++
    return null
  }
}

function reportDegradation(userRoot, counts) {
  if (!Object.values(counts).some(Boolean)) return
  console.warn('[dsh-chat-import] cursor 工作区登记册读取降级（' + userRoot + '）：'
    + Object.entries(counts).map(([key, count]) => key + '=' + count).join(', ')
    + '；无可用工作区时回退 slug')
}

function folderPath(value) {
  if (typeof value !== 'string' || !value) return null
  if (isAbsolute(value)) return value
  try {
    const uri = new URL(value)
    return uri.protocol === 'file:' ? fileURLToPath(uri) : null
  } catch {
    // 不是本机文件 URI：不能作为本机 cwd。
    return null
  }
}

async function directoryPath(ctx, value, counts) {
  const path = folderPath(value)
  if (!path) return null
  try {
    const st = await ctx.fs.stat(await ctx.fs.resolve(path))
    return st && st.type === 'directory' ? path : null
  } catch {
    // 缺目录由 stat 返回空值；抛错是读取失败，不能静默当作没有工作区。
    counts.readFailures++
    return null
  }
}

async function loadWorkspaces(ctx, userRoot, counts) {
  const target = await ctx.fs.resolve(join(userRoot, 'globalStorage', 'state.vscdb'))
  const st = await ctx.fs.stat(target)
  if (!st || st.type !== 'file') return null
  const dbPath = typeof ctx.fs.processPath === 'function' ? ctx.fs.processPath(target) : target.displayPath
  // 查询也属于可选探测：即使表存在，列漂移或独占锁也不能阻断 JSONL 扫描。
  const rows = readOptionalDb(dbPath, (db) => {
    if (!hasTable(db, 'composerHeaders')) return null
    const cols = columnsOf(db, 'composerHeaders')
    if (!cols.has('composerId')) return null
    const optional = ['workspaceId', 'value'].map((col) => cols.has(col) ? col : 'NULL AS ' + col)
    return db.prepare('SELECT composerId, ' + optional.join(', ') + ' FROM composerHeaders').all()
  })
  if (rows === null) return null // 缺表 / 锁库等可选探测失败不入缓存。
  const paths = new Map()
  for (const row of rows) {
    if (typeof row.composerId !== 'string' || !row.composerId.trim()) continue
    const header = row.value === null || row.value === undefined ? null : parseWorkspaceJson(row.value, counts, 'malformedHeaders')
    let path = await directoryPath(ctx, header?.workspaceIdentifier?.uri?.fsPath, counts)
    if (!path && typeof row.workspaceId === 'string' && /^[\w-]+$/.test(row.workspaceId)) {
      try {
        const sidecar = await ctx.fs.resolve(join(userRoot, 'workspaceStorage', row.workspaceId, 'workspace.json'))
        const st = await ctx.fs.stat(sidecar)
        if (st && st.type === 'file') {
          const workspace = parseWorkspaceJson(await ctx.fs.readText(sidecar), counts, 'malformedSidecars')
          path = await directoryPath(ctx, workspace?.folder, counts)
        }
      } catch {
        // 缺文件由 stat 返回空值；实际读取失败计数后继续其它登记行。
        counts.readFailures++
      }
    }
    if (path) paths.set(row.composerId, path)
  }
  return paths
}

async function registryFingerprint(ctx, userRoot) {
  const dbPath = join(userRoot, 'globalStorage', 'state.vscdb')
  const signatures = await Promise.all(['', '-wal'].map(async (suffix) => {
    const st = await ctx.fs.stat(await ctx.fs.resolve(dbPath + suffix))
    return st ? [st.size, st.mtimeMs, st.version].join(':') : '-'
  }))
  return signatures.join('|')
}

/** 发现缓存 30s，DB/WAL 指纹变化即失效；导入用 fresh 强制重读，不复用在途探测。 */
export async function readCursorComposerWorkspaces(ctx, { fresh = false } = {}) {
  const userRoot = cursorUserDataDir()
  const counts = { malformedHeaders: 0, malformedSidecars: 0, readFailures: 0 }
  let fingerprint
  try {
    fingerprint = await registryFingerprint(ctx, userRoot)
  } catch {
    counts.readFailures++
    reportDegradation(userRoot, counts)
    workspaceCache.delete(ctx)
    return new Map()
  }
  const cached = workspaceCache.get(ctx)
  const now = Date.now()
  if (!fresh && cached && cached.userRoot === userRoot && cached.fingerprint === fingerprint
    && now - cached.at < CACHE_MS) return cached.promise
  const record = { userRoot, fingerprint, at: now }
  record.promise = (async () => {
    let paths = null
    try {
      paths = await loadWorkspaces(ctx, userRoot, counts)
      return paths || new Map()
    } catch (err) {
      if (err?.code === 'DSH_SQLITE_UNAVAILABLE') throw err
      counts.readFailures++
      return new Map()
    } finally {
      // 坏行随成功结果缓存，避免逐会话重复读库 / 告警；读取失败才重试，且不清掉并发 fresh 的新结果。
      if ((!paths || counts.readFailures > 0) && workspaceCache.get(ctx) === record) workspaceCache.delete(ctx)
      reportDegradation(userRoot, counts)
    }
  })()
  workspaceCache.set(ctx, record)
  return record.promise
}

export async function cursorComposerWorkspace(ctx, composerId, options) {
  return (await readCursorComposerWorkspaces(ctx, options)).get(composerId) || null
}
