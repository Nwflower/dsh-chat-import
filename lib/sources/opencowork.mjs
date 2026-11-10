// lib/sources/opencowork.mjs — openCoWork / NextCoWork 双 schema SQLite 读取与导入编排
//
// legacy：~/.open-cowork/data.db（projects/sessions/messages；content + sort_order）。
// next：~/.next-cowork/data/nextcowork.db（workspaces/sessions/messages；parts + ordinal）。
// 不按应用版本猜测，直接用表与关键列签名区分；两种库的会话都归一成
// lib/convert/opencowork.mjs 消费的中间 JSON。
//
// 只读与列自适应统一走 sources/sqlite.mjs；签名不符 / 文件不可读返回 null，导入层大声报错。
// legacy cwd 取 sessions.working_folder，空时按 project_id 回退 projects.working_folder；
// next 取 root_path_at_creation，并过滤 parent_session_id 非空的子代理会话。
// 摘要只读 sessions/projects，不读消息正文；完整读取把 legacy content 与 next parts 按上游
// 规则解析成 blocks，畸形 JSON 不静默吞掉，而以 invalidBlocks 交给转换器计数。
import { convertOpencoworkJson } from '../convert/index.mjs'
import { parseTimeMs } from '../convert/core.mjs'
import { sessionSelection } from '../import-state.mjs'
import { importMultiSource, convertSessionItems, previewSessionSet, selectionSet } from '../import-core.mjs'
import { readOptionalDb, columnsOf, tableNames, locateDbInDirectory } from './sqlite.mjs'

const LEGACY = 'legacy'
const NEXT = 'next'

function hasColumns(cols, names) {
  return names.every((name) => cols.has(name))
}

function layoutOf(db) {
  const tables = tableNames(db)
  if (!tables.has('sessions') || !tables.has('messages')) return null
  const scols = columnsOf(db, 'sessions')
  const mcols = columnsOf(db, 'messages')
  if (hasColumns(scols, ['id', 'title', 'workspace_id', 'root_path_at_creation', 'created_at', 'updated_at'])
    && hasColumns(mcols, ['id', 'session_id', 'role', 'parts', 'ordinal', 'created_at'])) {
    return { layout: NEXT, scols, mcols }
  }
  if (hasColumns(scols, ['id', 'title', 'working_folder', 'created_at', 'updated_at'])
    && hasColumns(mcols, ['id', 'session_id', 'role', 'content', 'sort_order', 'created_at'])) {
    return { layout: LEGACY, scols, mcols }
  }
  return null
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value : null
}

function time(value) {
  return typeof value === 'number' ? parseTimeMs(value) : null
}

function readRows(db) {
  const sig = layoutOf(db)
  if (!sig) return null
  const projects = new Map()
  if (sig.layout === LEGACY && tableNames(db).has('projects')) {
    for (const row of db.prepare('SELECT * FROM projects').all()) {
      if (typeof row.id === 'string' && row.id) projects.set(row.id, row)
    }
  }
  const rows = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC, id ASC').all()
    .filter((row) => {
      if (typeof row.id !== 'string' || !row.id) return false
      if (sig.layout === NEXT && sig.scols.has('parent_session_id') && row.parent_session_id) return false
      return true
    })
  return { ...sig, rows, projects }
}

function summaryOf(row, read) {
  const project = read.layout === LEGACY && read.scols.has('project_id')
    ? read.projects.get(row.project_id)
    : null
  const ownCwd = read.layout === NEXT ? text(row.root_path_at_creation) : text(row.working_folder)
  const cwd = ownCwd || (project ? text(project.working_folder) : null)
  return {
    id: row.id,
    title: text(row.title) || '',
    cwd,
    directory: cwd,
    model: read.layout === NEXT ? text(row.model) : (read.scols.has('model_id') ? text(row.model_id) : null),
    createdAt: time(row.created_at),
    updatedAt: time(row.updated_at),
    lastActiveAt: time(row.updated_at),
    layout: read.layout,
  }
}

// legacy rowToMessage：JSON.parse 后只接受 string / 数组；null 变空正文，其它对象回退原文。
function legacyBlocks(raw) {
  if (typeof raw !== 'string') return { blocks: [], invalidBlocks: 1 }
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'string') return { blocks: [{ type: 'text', text: parsed }] }
    if (Array.isArray(parsed)) return { blocks: parsed }
    if (parsed === null) return { blocks: [] }
    return { blocks: [{ type: 'text', text: raw }] }
  } catch {
    return { blocks: [{ type: 'text', text: raw }] }
  }
}

function nextBlocks(raw) {
  if (typeof raw !== 'string') return { blocks: [], invalidBlocks: 1 }
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? { blocks: parsed } : { blocks: [], invalidBlocks: 1 }
  } catch {
    return { blocks: [], invalidBlocks: 1 }
  }
}

function messagesOf(db, read, sessionId) {
  const order = read.layout === NEXT ? 'ordinal ASC, id ASC' : 'sort_order ASC, created_at ASC, id ASC'
  return db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY ' + order).all(sessionId)
    .map((row) => {
      const parsed = read.layout === NEXT ? nextBlocks(row.parts) : legacyBlocks(row.content)
      return {
        id: typeof row.id === 'string' ? row.id : '',
        role: typeof row.role === 'string' ? row.role : '',
        createdAt: time(row.created_at),
        ...parsed,
      }
    })
}

/** 双 schema 库 → 顶层会话摘要（发现层用，不读消息正文）。非目标库/读不到 → null。 */
export function readOpencoworkSessions(dbPath) {
  return readOptionalDb(dbPath, readRows, (_db, read) => read.rows.map((row) => summaryOf(row, read)))
}

/** 双 schema 库 → 完整中间会话数组（导入/预览用）。 */
export function readOpencoworkDb(dbPath) {
  return readOptionalDb(dbPath, readRows, (db, read) => read.rows.map((row) => {
    const summary = summaryOf(row, read)
    return {
      ...summary,
      parentSessionId: read.layout === NEXT && read.scols.has('parent_session_id') ? row.parent_session_id : null,
      messages: messagesOf(db, read, row.id),
    }
  }))
}

const NOT_OPENCOWORK_DB = '不是 openCoWork / NextCoWork 会话库（两代 sessions/messages 关键列均不匹配）: '

function readOpencoworkDbOrThrow(path) {
  const sessions = readOpencoworkDb(path)
  if (!sessions) throw new Error(NOT_OPENCOWORK_DB + path)
  return sessions
}

const convertOne = (args, path) => (session) => convertOpencoworkJson(JSON.stringify(session), { ...args, sourcePath: path })

/** 单库多会话：sessionIds、WAL 指纹、源未变短路径与增量续写全部由共用状态机处理。 */
export async function importOpencoworkFile(ctx, target, args, { registryDir, persisted, fingerprintKeys = [] } = {}) {
  const selection = sessionSelection(args)
  return importMultiSource(ctx, target, args, {
    registryDir, persisted, fingerprintKeys, sqlite: true, selection, importFormat: 'opencowork',
    load: (path) => convertSessionItems(ctx, readOpencoworkDbOrThrow(path), {
      path, args, wanted: selectionSet(selection), sourceLabel: 'openCoWork', convertOne: convertOne(args, path),
    }),
  })
}

// 接受 .open-cowork 根、.next-cowork 根或其 data/ 子目录，以及任意只含一个目标库的目录。
const DB_CANDIDATES = [['data.db'], ['data', 'nextcowork.db'], ['nextcowork.db']]

export async function importOpencoworkDirectory(ctx, dirTarget, args, options = {}) {
  return importOpencoworkFile(ctx, await locateDbInDirectory(ctx, dirTarget, DB_CANDIDATES, ['data.db']), args, options)
}

export async function previewOpencoworkFile(ctx, target, args) {
  const path = target.displayPath || ctx.fs.processPath(target)
  const sessions = readOpencoworkDbOrThrow(path)
  const results = previewSessionSet(sessions, {
    path, args, wanted: selectionSet(sessionSelection(args)), sourceLabel: 'openCoWork', convertOne: convertOne(args, path),
  })
  return { total: sessions.length, results }
}

export async function previewOpencoworkDirectory(ctx, dirTarget, args) {
  return previewOpencoworkFile(ctx, await locateDbInDirectory(ctx, dirTarget, DB_CANDIDATES, ['data.db']), args)
}
