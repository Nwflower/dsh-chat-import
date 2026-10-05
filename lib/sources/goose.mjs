// lib/sources/goose.mjs — Goose（aaif-goose/goose）SQLite 会话库读取与导入编排
//
// 库 = <data_dir>/sessions/sessions.db（WAL → 同目录另有 -wal/-shm）。data_dir 的解析
// 顺序（上游 crates/goose/src/config/paths.rs）：
//   GOOSE_PATH_ROOT 为**绝对路径**时 → $ROOT/data/...（相对路径/空串会被忽略，上游有单测）
//   否则按平台：Windows %APPDATA%\Block\goose\data、macOS ~/Library/Application Support/
//   Block/goose、Linux ~/.local/share/goose（macOS 走 etcetera 的 macOS 策略 →
//   <author>/<app_name> 两层，作者名刻意保留 "Block"）。
//
// 两张表（DDL 内联在 session_manager.rs，CURRENT_SCHEMA_VERSION=16，靠 ALTER TABLE 逐列迁移
// → 老库可能缺列，故本模块的列访问全部按存在性自适应）：
//   sessions(id, name, description, user_set_name, session_type, working_dir,
//            created_at, updated_at, extension_data, total_tokens…, accumulated_*,
//            schedule_id, recipe_json, user_recipe_values_json, provider_name,
//            model_config_json, goose_mode, archived_at, project_id, parent_session_id)
//     —— **没有 message_count 列**（上游查询期按 metadata_json.userVisible 计算），
//        name 是 LLM/用户标题，description 是遗留列（读时 name 非空优先）
//   messages(id INTEGER PK, message_id, session_id, role, content_json, created_timestamp,
//            timestamp, tokens, metadata_json)
//     —— 一条消息一行，content_json 是该消息的整个 content 块数组
//
// 读取约定：
//   - 只读打开；签名不符（缺表/缺列）返回 null，发现层据此回退（不抛错）。
//   - 只取顶层会话：排除 session_type ∈ {sub_agent, hidden} 与 parent_session_id 非空的行。
//   - 消息按 (created_timestamp, id) 升序；metadata_json.userVisible === false 的消息是
//     agent-only，不进对话（与上游 message_count 的口径一致）。
//   - 时间戳归一为毫秒：created_timestamp 是 Unix 整数（秒，历史库可能毫秒）；
//     sessions.created_at/updated_at 是 CURRENT_TIMESTAMP 文本（UTC **不带时区** → 按 UTC
//     解析）或 import 路径写的 RFC3339 → 两种都认。
//   - 旧版 sessions/*.jsonl **不读**：上游只在首次建库时全量迁移一次且不删除旧文件，
//     读它会与库重复导入（同 id 插入会失败）。
//
// importGooseFile/Directory 把库里每个会话独立落盘（sessionIds 过滤、库指纹短路径、
// 逐会话 append），恒返回批量形态——与 importZcodeFile/importOpencodeFile 同构（共享编排
// 在 lib/import-core.mjs）。
import { convertGooseJson } from '../convert/index.mjs'
import { gooseDataDir, gooseSessionsDir, gooseDefaultDbPath } from '../convert/goose.mjs'
import { sessionSelection } from '../import-state.mjs'
import { importMultiSource, convertSessionItems, previewSessionSet, selectionSet } from '../import-core.mjs'
import { readOptionalDb, columnsOf, resolveDbInDirectory } from './sqlite.mjs'

// 路径规则在 lib/convert/goose.mjs（纯函数，发现层复用同一份）；这里只转发给工具层。
export { gooseDataDir, gooseSessionsDir, gooseDefaultDbPath }

// CURRENT_TIMESTAMP 文本（"YYYY-MM-DD HH:MM:SS"，UTC 但不带时区）→ 毫秒；RFC3339 直接解析。
function gooseTextTime(v) {
  if (typeof v !== 'string' || !v) return null
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? v.replace(' ', 'T') + 'Z' : v
  const n = Date.parse(iso)
  return Number.isFinite(n) ? n : null
}

// Unix 整数（秒，历史库可能毫秒）→ 毫秒
function gooseEpochTime(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return v < 1e11 ? Math.trunc(v) * 1000 : v
}

// sessions 行 → 轻量摘要（发现层用；不含消息）
function summaryOf(row, cols, messageCount = null) {
  const pick = (name) => (cols.has(name) ? row[name] : undefined)
  const name = typeof pick('name') === 'string' ? pick('name').trim() : ''
  const description = typeof pick('description') === 'string' ? pick('description').trim() : ''
  const workingDir = typeof pick('working_dir') === 'string' ? pick('working_dir') : ''
  return {
    id: typeof row.id === 'string' && row.id ? row.id : null,
    title: name || description,
    cwd: workingDir || null,
    sessionType: typeof pick('session_type') === 'string' ? pick('session_type') : '',
    parentSessionId: typeof pick('parent_session_id') === 'string' ? pick('parent_session_id') : '',
    providerName: typeof pick('provider_name') === 'string' ? pick('provider_name') : '',
    createdAt: gooseTextTime(pick('created_at')),
    updatedAt: gooseTextTime(pick('updated_at')),
    messageCount,
  }
}

/** 库签名与顶层会话行（导入与发现共用；签名不符 → null，打不开 / 损坏 / 锁定由
 * readOptionalDb 归一为 null：发现层回退、导入层显式报错）。 */
function gooseRows(db) {
  const scols = columnsOf(db, 'sessions')
  const mcols = columnsOf(db, 'messages')
  // 签名：sessions 有 id/session_type/working_dir，messages 有 session_id/content_json
  const ok = scols.has('id') && scols.has('session_type') && scols.has('working_dir')
    && mcols.has('session_id') && mcols.has('content_json')
  if (!ok) return null
  const rows = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all()
    .filter((row) => {
      const type = row.session_type
      const parent = scols.has('parent_session_id') ? row.parent_session_id : null
      return type !== 'sub_agent' && type !== 'hidden' && !parent && typeof row.id === 'string' && row.id
    })
  return { scols, mcols, rows }
}

// 一个会话的消息行 → 中间 JSON 的 messages[]（含 userVisible 过滤与系统提示词收集）
function readMessages(db, mcols, sessionId) {
  const pick = (row, name) => (mcols.has(name) ? row[name] : undefined)
  const order = mcols.has('created_timestamp') ? 'created_timestamp, id' : 'id'
  const out = []
  let systemPrompt
  let visible = 0
  for (const row of db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY ' + order).all(sessionId)) {
    let metadata = null
    const rawMeta = pick(row, 'metadata_json')
    if (typeof rawMeta === 'string' && rawMeta) {
      try {
        metadata = JSON.parse(rawMeta)
      } catch {
        // 畸形 metadata_json 只丢元数据（按 userVisible 默认 true 处理），不影响消息本体
        metadata = null
      }
    }
    const role = typeof row.role === 'string' ? row.role : ''
    let content = []
    const rawContent = pick(row, 'content_json')
    if (typeof rawContent === 'string' && rawContent) {
      try {
        const parsed = JSON.parse(rawContent)
        content = Array.isArray(parsed) ? parsed : []
      } catch {
        // 畸形 content_json：该消息无内容可导 → 仍保留行（role/时间），由转换器跳过
        content = []
      }
    }
    if (role === 'system') {
      // 系统提示词不进对话；开关开启时由转换器作为上下文注入（与 zcode/hermes 同款）
      const text = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n\n')
      if (text) systemPrompt = systemPrompt ? systemPrompt + '\n\n' + text : text
      continue
    }
    if (role !== 'user' && role !== 'assistant') continue
    if (metadata && metadata.userVisible === false) continue
    visible++
    out.push({
      role,
      createdTimestamp: gooseEpochTime(pick(row, 'created_timestamp')),
      metadata,
      content,
    })
  }
  return { messages: out, systemPrompt, visible }
}

/** Goose 库 → 顶层会话摘要数组（发现层用，不读消息体）。非 Goose 库/读不到 → null。 */
export function readGooseSessions(dbPath) {
  // 不再按会话统计消息条数（面板不展示；上游口径的 userVisible 计数是每会话一次
  // SQL 聚合，属发现期无谓开销）→ summaryOf 的 messageCount 缺省 null。
  return readOptionalDb(dbPath, gooseRows, (_db, read) => read.rows.map((row) => summaryOf(row, read.scols)))
}

/** Goose 库 → 完整中间会话 JSON 数组（导入/预览用，含消息与系统提示词）。 */
export function readGooseDb(dbPath) {
  return readOptionalDb(dbPath, gooseRows, (db, read) => {
    const out = []
    for (const row of read.rows) {
      const { messages, systemPrompt, visible } = readMessages(db, read.mcols, row.id)
      const summary = summaryOf(row, read.scols, visible)
      out.push({
        id: summary.id,
        name: summary.title,
        description: read.scols.has('description') ? row.description : '',
        workingDir: summary.cwd,
        providerName: summary.providerName,
        sessionType: summary.sessionType,
        parentSessionId: summary.parentSessionId,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        systemPrompt,
        messages,
      })
    }
    return out
  })
}

const NOT_GOOSE_DB = '不是 Goose 会话库（缺 sessions/messages 表或列）: '

function readGooseDbOrThrow(path) {
  const sessions = readGooseDb(path)
  if (!sessions) throw new Error(NOT_GOOSE_DB + path)
  return sessions
}

const gooseConvertOne = (args, path) => (s) => convertGooseJson(JSON.stringify(s), { ...args, sourcePath: path })

// 库里每个会话独立落盘（sessionIds 过滤 + 库指纹 / WAL 短路径 + 逐会话 append）。
export async function importGooseFile(ctx, target, args, { registryDir, persisted, fingerprintKeys = [] } = {}) {
  const selection = sessionSelection(args)
  return importMultiSource(ctx, target, args, {
    registryDir, persisted, fingerprintKeys, sqlite: true, selection, importFormat: 'goose',
    load: (path) => convertSessionItems(ctx, readGooseDbOrThrow(path), {
      path, args, wanted: selectionSet(selection), sourceLabel: 'Goose', convertOne: gooseConvertOne(args, path),
    }),
  })
}

// 目录导入：在目录里定位 sessions.db（无递归），再走单库导入
export async function importGooseDirectory(ctx, dirTarget, args, options = {}) {
  return importGooseFile(ctx, await resolveDbInDirectory(ctx, dirTarget, 'sessions.db'), args, options)
}

// ── dry-run 预览（与正式导入同源的只读重演：绕开 registry / decideMulti / 落盘，零副作用）──

// goose 预览：sessions.db 一库多会话；sessionIds 过滤与导入同口径（面板多选预览只列所选
// 会话），标题与落盘一样钉成「Goose · 话题」（dry-run 不该显示另一个标题）。
export async function previewGooseFile(ctx, target, args) {
  const path = target.displayPath || ctx.fs.processPath(target)
  const sessions = readGooseDbOrThrow(path)
  const results = previewSessionSet(sessions, {
    path, args, wanted: selectionSet(sessionSelection(args)), sourceLabel: 'Goose', convertOne: gooseConvertOne(args, path),
  })
  return { total: sessions.length, results }
}

export async function previewGooseDirectory(ctx, dirTarget, args) {
  return previewGooseFile(ctx, await resolveDbInDirectory(ctx, dirTarget, 'sessions.db'), args)
}
