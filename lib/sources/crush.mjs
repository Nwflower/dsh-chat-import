// lib/sources/crush.mjs — Crush（charmbracelet/crush）会话库读取与导入编排
//
// 库 = <数据目录>/crush.db（**数据目录在项目里**，默认 `<项目>/.crush`；用户级目录只放
// JSON 状态）。路径与注册表规则见 lib/convert/crush.mjs（发现层与导入层共用）。
//
// 读取约定：
//   · 只读打开；签名不符（缺表/缺列）返回 null，发现层据此跳过（不抛错）。
//   · 表：sessions（含 parent_session_id / summary_message_id / 三种用量列）、
//     messages（parts TEXT + is_summary_message + finished_at + provider）、
//     files（每次 write/edit 的文件快照，不读）、read_files（「已读」记账，不读）。
//     签名判定用 sessions+messages 的关键列组合 + read_files 存在。
//   · **DB 里没有 cwd**：项目路径只能来自 projects.json 的 path 或库文件位置反推
//     （cwd 可能低于库目录——`.crush` 允许在上层目录被找到）→ 由导入参数 args.cwd 带入。
//   · 时间戳全部 INTEGER **Unix 秒**；parts 是 JSON 文本，解析失败/非数组按空数组处理
//     （该消息仍保留 role/时间，转换器按空 parts 跳过）。
//   · 子会话（parent_session_id 非空）与标题生成会话（id 前缀 `title-`）不单独成会话。
//
// importCrushFile/Directory 把库里每个 root 会话独立落盘（sessionIds 过滤、库指纹短路径、
// 逐会话 append），恒返回批量形态；标题钉成「Crush · 话题」。
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { convertCrushJson, crushProjectDbPath, crushRegistryPath, crushUserDataDir, parseCrushProjects } from '../convert/index.mjs'
import { sessionSelection } from '../import-state.mjs'
import { importMultiSource, convertSessionItems, previewSessionSet, selectionSet } from '../import-core.mjs'
import { readOptionalDb, columnsOf, tableNames, locateDbInDirectory } from './sqlite.mjs'

// 路径规则在 lib/convert/crush.mjs（纯函数）；这里转发给工具层与发现层。
export { crushUserDataDir, crushRegistryPath, crushProjectDbPath, parseCrushProjects }

// 库签名 + root 会话行（签名不符 → null；打不开 / 损坏 / 锁定由 readOptionalDb 归一为 null）。
// 签名按上游事实：sessions 有 parent_session_id + summary_message_id + prompt_tokens，
// messages 有 parts + is_summary_message + finished_at，且存在 read_files 表。
function crushRows(db) {
  const tables = tableNames(db)
  if (!tables.has('sessions') || !tables.has('messages') || !tables.has('read_files')) return null
  const scols = columnsOf(db, 'sessions')
  const mcols = columnsOf(db, 'messages')
  const ok = scols.has('parent_session_id') && scols.has('summary_message_id') && scols.has('prompt_tokens')
    && mcols.has('parts') && mcols.has('is_summary_message') && mcols.has('finished_at')
  if (!ok) return null
  // 只取 root 会话（子会话由 parent_session_id 标出；标题生成会话靠 id 前缀）
  const rows = db.prepare('SELECT * FROM sessions WHERE parent_session_id IS NULL ORDER BY updated_at DESC').all()
    .filter((row) => typeof row.id === 'string' && row.id && !row.id.startsWith('title-'))
  return { scols, mcols, rows }
}

// Unix 秒 → 毫秒（缺省/非法 → null，不虚构时间）
function crushMs(v) {
  return typeof v === 'number' && Number.isFinite(v) ? (v < 1e11 ? Math.trunc(v) * 1000 : v) : null
}

// parts JSON 文本 → 数组（畸形/非数组 → []，该消息仍保留 role/时间）
function parseParts(raw) {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // 畸形 parts：该消息无内容可导，但仍参与轮次边界（user 消息空 parts 自然不开轮）
    return []
  }
}

/** Crush 库 → root 会话摘要数组（发现层用，不读消息体）。非 Crush 库/读不到 → null。 */
export function readCrushSessions(dbPath) {
  return readOptionalDb(dbPath, crushRows, (_db, read) => read.rows.map((row) => ({
    id: row.id,
    title: typeof row.title === 'string' ? row.title : '',
    parentSessionId: typeof row.parent_session_id === 'string' ? row.parent_session_id : null,
    createdAt: crushMs(row.created_at),
    updatedAt: crushMs(row.updated_at),
  })))
}

/** Crush 库 → 完整中间 JSON 数组（导入/预览用：含每条消息的 parts 原文）。 */
export function readCrushDb(dbPath) {
  return readOptionalDb(dbPath, crushRows, (db, read) => {
    const out = []
    const messagesOf = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, rowid')
    for (const row of read.rows) {
      const messages = messagesOf.all(row.id)
        .map((m) => ({
          id: m.id,
          role: typeof m.role === 'string' ? m.role : '',
          parts: parseParts(m.parts),
          model: typeof m.model === 'string' ? m.model : null,
          provider: typeof m.provider === 'string' ? m.provider : null,
          createdAt: crushSeconds(m.created_at),
          finishedAt: crushSeconds(m.finished_at),
          isSummaryMessage: m.is_summary_message === 1 ? 1 : 0,
        }))
      out.push({
        id: row.id,
        parentSessionId: typeof row.parent_session_id === 'string' ? row.parent_session_id : null,
        title: typeof row.title === 'string' ? row.title : '',
        messageCount: Number.isFinite(row.message_count) ? row.message_count : null,
        promptTokens: Number.isFinite(row.prompt_tokens) ? row.prompt_tokens : null,
        completionTokens: Number.isFinite(row.completion_tokens) ? row.completion_tokens : null,
        cost: Number.isFinite(row.cost) ? row.cost : null,
        summaryMessageId: typeof row.summary_message_id === 'string' ? row.summary_message_id : null,
        // 会话级时间戳归一为**毫秒**（与其它源的中间 JSON 同口径，转换器直接落 meta）；
        // 消息级时间戳保留原始 Unix 秒：转换器 crushTime 归一后透传进 IR 逐步时间
        //（assistant 用 finished_at → 模型耗时统计），同时作 meta.createdAt 兜底
        createdAt: crushMs(row.created_at),
        updatedAt: crushMs(row.updated_at),
        messages,
      })
    }
    return out
  })
}

// 消息级时间戳：保留 Unix 秒（转换器经 crushTime 归一为毫秒；finished_at 同理）
function crushSeconds(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * 从 projects.json 反查某个库所属的项目路径（DB 里没有 cwd）。
 * 匹配规则：注册表条目的 `data_dir` 与该库所在目录同路径（分隔符归一后比较）；
 * 匹配不到时回退「库目录以 .crush 结尾 → 取它的父目录」，再兜底 null。
 */
export function crushProjectPathFor(dbDir, registryRaw) {
  const norm = (p) => String(p ?? '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  const want = norm(dbDir)
  for (const entry of parseCrushProjects(registryRaw)) {
    if (entry.dataDir && norm(entry.dataDir) === want) return entry.path
  }
  const parts = norm(dbDir).split('/')
  if (parts.length > 1 && parts[parts.length - 1] === '.crush') return dbDir.replace(/[\\/]\.crush[\\/]*$/, '')
  return null
}

const NOT_CRUSH_DB = '不是 Crush 会话库（缺 sessions/messages/read_files 表或关键列）: '

// 逐会话转换参数：crushId 取会话 id（DB 里没有 cwd，由 args.cwd 带入）。
const crushConvertOne = (args, path) => (s) => convertCrushJson(JSON.stringify(s), { ...args, crushId: s.id, sourcePath: path })

function readCrushDbOrThrow(path) {
  const sessions = readCrushDb(path)
  if (!sessions) throw new Error(NOT_CRUSH_DB + path)
  return sessions
}

// 库里每个 root 会话独立落盘（sessionIds 过滤 + 库指纹 / WAL 短路径 + 逐会话 append）。
export async function importCrushFile(ctx, target, args, { registryDir, persisted, fingerprintKeys = [] } = {}) {
  const selection = sessionSelection(args)
  return importMultiSource(ctx, target, args, {
    registryDir, persisted, fingerprintKeys, sqlite: true, selection, importFormat: 'crush',
    load: (path) => convertSessionItems(ctx, readCrushDbOrThrow(path), {
      path, args, wanted: selectionSet(selection), sourceLabel: 'Crush', convertOne: crushConvertOne(args, path),
    }),
  })
}

// 目录里的库：`<dir>/.crush/crush.db` → `<dir>/crush.db`（`<dir>` 本身就是数据目录）
const CRUSH_DB_CANDIDATES = [['.crush', 'crush.db'], ['crush.db']]

export async function importCrushDirectory(ctx, dirTarget, args, options = {}) {
  return importCrushFile(ctx, await locateDbInDirectory(ctx, dirTarget, CRUSH_DB_CANDIDATES, ['crush.db']), args, options)
}

/**
 * 单文件/单库导入参数派生：会话 id（库文件名 → crush）与**项目 cwd**（DB 里没有 cwd）。
 * cwd 取法：同目录的 `crush.json`（`options.data_directory` 覆盖）→ 用户级 projects.json
 * 反查（data_dir 匹配）→ 库目录以 `.crush` 结尾时取父目录。
 */
export async function crushDeriveArgs(ctx, target) {
  const p = target.displayPath || ctx.fs.processPath(target)
  const dir = dirname(String(p))
  const derived = { crushId: 'crush' }
  // 1) 用户级注册表反查（首选：给的是绝对库路径与真实项目路径）
  try {
    const registryPath = crushRegistryPath(homedir(), process.env, process.platform)
    const raw = await ctx.fs.readText(await ctx.fs.resolve(registryPath))
    const projectPath = crushProjectPathFor(dir, raw)
    if (projectPath) derived.cwd = projectPath
  } catch {
    // 注册表不可读（不存在 / 无权限）：继续用几何回退
  }
  // 2) 几何回退：<项目>/.crush/crush.db → cwd 取 <项目>
  if (!derived.cwd) {
    const fallback = crushProjectPathFor(dir, null)
    if (fallback) derived.cwd = fallback
  }
  return derived
}

// ── dry-run 预览（与正式导入同源的只读重演：绕开 registry / decideMulti / 落盘，零副作用）──

// crush 预览：项目内 crush.db 一库多会话；标题与落盘一样钉成「Crush · 话题」。
export async function previewCrushFile(ctx, target, args) {
  const path = target.displayPath || ctx.fs.processPath(target)
  const sessions = readCrushDbOrThrow(path)
  const results = previewSessionSet(sessions, {
    path, args, wanted: selectionSet(sessionSelection(args)), sourceLabel: 'Crush', convertOne: crushConvertOne(args, path),
  })
  return { total: sessions.length, results }
}

export async function previewCrushDirectory(ctx, dirTarget, args) {
  return previewCrushFile(ctx, await locateDbInDirectory(ctx, dirTarget, CRUSH_DB_CANDIDATES, ['crush.db']), args)
}
