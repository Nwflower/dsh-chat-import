// lib/sources/hermes.mjs — Hermes（本地 AI 编码 CLI）SQLite 历史库读取
//
// Hermes 会话存于 ~/.hermes/（Windows %LOCALAPPDATA%\hermes）：state.db（SQLite，
// 权威索引）+ sessions/*.jsonl|.json（回退）。readHermesDb 只读打开 state.db
//（node:sqlite 只读，对齐 lib/sources/zcode.mjs readZcodeDb），把
// sessions + messages 两表抽成中间会话 JSON 数组（供 convertHermesJson 消费）：
//   { id, title, cwd, createdAt, messages: [{ role, content, ts }] }
// content 原样保留（string 或 Claude 风格 block 数组——DB 里 block 数组以 JSON 文本
// 存储，读时解析回数组）；ts/createdAt 归一为毫秒。列名兼容两种变体（cc-switch 的
// cwd|directory、started_at|created_at、ended_at|updated_at；hermes-agent 的
// messages.timestamp），messages 按时间升序（无时间列回退 rowid, id）。不设
// cc-switch 的 LIMIT 500：导入不应静默丢弃第 500 个之后的会话。db 不可用（不存在 /
// 非 SQLite / 无 sessions 表 / 查询失败）返回 null，由导入层（lib/import-variants.mjs）
// 回退 sessions/*.jsonl。
import { parseHermesTime } from '../convert/hermes.mjs'
import { readOptionalDb, columnsOf, hasTable } from './sqlite.mjs'

// hermes 库 → 会话级摘要（发现层用）：只查 sessions 表 + 每会话 MAX(messages 时间列)，
// 不读 messages 正文（全量读取器为统计消息数会整读每会话 messages 并解析 content
// block 数组——发现层不再需要消息条数）。列名变体自适应与 readHermesDb 同源
//（cwd|directory、started_at|created_at、ended_at|updated_at、messages.created_at|
// timestamp）。db 不可用（不存在 / 非 SQLite / 无 sessions 表 / 查询失败）返回 null，
// 由发现层回退 sessions/*.jsonl。
export function readHermesDbSummaries(dbPath) {
  // 文件不存在 / 非 SQLite / 损坏 / 查询失败 → readOptionalDb 归一为 null（发现层回退 JSONL）
  return readOptionalDb(dbPath, (db) => {
    if (!hasTable(db, 'sessions')) return null // 无 sessions 表 → 不是 hermes 库
    const sCols = columnsOf(db, 'sessions')
    const cwdCol = pickCol(sCols, 'cwd', 'directory')
    const startCol = pickCol(sCols, 'started_at', 'created_at')
    const endCol = pickCol(sCols, 'ended_at', 'updated_at')
    const mCols = columnsOf(db, 'messages')
    const timeCol = pickCol(mCols, 'created_at', 'timestamp')
    // 最近一条消息时间：时间列与 session_id 列都在才算（无时间列的变体不做这条子查询）
    const lastMsg = timeCol && mCols.has('session_id')
      ? ', (SELECT MAX(m."' + timeCol + '") FROM messages m WHERE m.session_id = s.id) AS lastMsg'
      : ''
    const rows = db.prepare('SELECT s.*' + lastMsg + ' FROM sessions s ORDER BY s.rowid DESC').all()
    const out = []
    for (const row of rows) {
      const id = typeof row.id === 'string' && row.id ? row.id : undefined
      if (!id) continue // 缺 id 的脏行不成会话（cc-switch 同款）
      const startedAt = startCol ? parseHermesTime(row[startCol]) : undefined
      const endedAt = endCol ? parseHermesTime(row[endCol]) : undefined
      out.push({
        id,
        title: typeof row.title === 'string' && row.title ? row.title : undefined,
        cwd: cwdCol && typeof row[cwdCol] === 'string' && row[cwdCol] ? row[cwdCol] : undefined,
        createdAt: startedAt ?? endedAt,
        lastActiveAt: lastMsg && row.lastMsg !== null && row.lastMsg !== undefined
          ? parseHermesTime(row.lastMsg)
          : (endedAt ?? undefined),
      })
    }
    return out
  })
}

export function readHermesDb(dbPath) {
  // 文件不存在 / 非 SQLite / 损坏 / 查询失败 → readOptionalDb 归一为 null（导入层回退 JSONL）
  return readOptionalDb(dbPath, (db) => {
    if (!hasTable(db, 'sessions')) return null // 无 sessions 表 → 不是 hermes 库
    const sCols = columnsOf(db, 'sessions')
    const cwdCol = pickCol(sCols, 'cwd', 'directory')
    const startCol = pickCol(sCols, 'started_at', 'created_at')
    const endCol = pickCol(sCols, 'ended_at', 'updated_at')
    // 压缩分叉 lineage（parent_session_id 关联，父会话通常无消息、内容由
    // 子会话承接）——读出供导入层按 lineage 过滤/标注
    const parentCol = pickCol(sCols, 'parent_session_id', 'parent_id')
    const mCols = columnsOf(db, 'messages')
    const timeCol = pickCol(mCols, 'created_at', 'timestamp')
    // hermes-agent（NousResearch）变体：tool_calls / reasoning 存独立列
    //（JSON 文本）而非 content 内 block 数组——存在则读出进中间 JSON。
    const toolCallsCol = pickCol(mCols, 'tool_calls', 'tool_call')
    const reasoningCol = pickCol(mCols, 'reasoning')
    // 消息查询只依赖列形状，整库 prepare 一次（缺 session_id / role 列 → 会话无消息）
    const order = (timeCol || 'rowid') + (mCols.has('id') ? ', id' : '')
    const messagesOf = mCols.has('session_id') && mCols.has('role')
      ? db.prepare(
        `SELECT role, ${mCols.has('content') ? 'content' : "'' AS content"}, ${timeCol ? `${timeCol} AS ts` : 'NULL AS ts'}, ` +
        `${toolCallsCol ? `${toolCallsCol} AS tool_calls` : 'NULL AS tool_calls'}, ` +
        `${reasoningCol ? `${reasoningCol} AS reasoning` : 'NULL AS reasoning'} ` +
        `FROM messages WHERE session_id = ? ORDER BY ${order}`
      )
      : null

    const sessions = []
    for (const row of db.prepare('SELECT * FROM sessions ORDER BY rowid DESC').all()) {
      const id = typeof row.id === 'string' && row.id ? row.id : undefined
      if (!id) continue // 缺 id 的脏行不成会话（cc-switch 同款）
      const startedAt = startCol ? parseHermesTime(row[startCol]) : undefined
      const endedAt = endCol ? parseHermesTime(row[endCol]) : undefined
      const messages = []
      if (messagesOf) {
        for (const m of messagesOf.all(id)) {
          const role = typeof m.role === 'string' ? m.role : undefined
          if (!role) continue
          const content = hermesContent(m.content)
          if (content === undefined) continue // 空内容消息跳过（cc-switch 同款）
          const msg = { role, content, ts: timeCol ? parseHermesTime(m.ts) : undefined }
          const toolCalls = hermesToolCalls(m.tool_calls)
          const reasoning = hermesReasoning(m.reasoning)
          if (toolCalls !== undefined) msg.toolCalls = toolCalls
          if (reasoning !== undefined) msg.reasoning = reasoning
          messages.push(msg)
        }
      }
      sessions.push({
        id,
        title: typeof row.title === 'string' && row.title ? row.title : undefined,
        cwd: cwdCol && typeof row[cwdCol] === 'string' && row[cwdCol] ? row[cwdCol] : undefined,
        createdAt: startedAt ?? endedAt,
        messages,
        // parent_session_id 透出（压缩分叉关联；无该列/值为空不占键）
        ...(parentCol && typeof row[parentCol] === 'string' && row[parentCol] ? { parentSessionId: row[parentCol] } : {}),
      })
    }
    return sessions
  })
}

// 按优先级取第一个存在的列名（cols 为 columnsOf 的列名集合；兼容不同 hermes 变体列名）。
function pickCol(cols, ...names) {
  for (const n of names) if (cols.has(n)) return n
  return undefined
}

// content 归一：DB 存的是 TEXT——Claude 风格 block 数组以 JSON 文本存储 → 解析回
// 数组；其余字符串原样；空/缺失 → undefined（该消息跳过）。
function hermesContent(raw) {
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return undefined
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (Array.isArray(parsed)) return parsed.length > 0 ? parsed : undefined
      } catch {
        // 字面 '[' 开头的普通文本，按字符串保留
      }
    }
    return raw
  }
  if (Array.isArray(raw) && raw.length > 0) return raw
  return undefined
}

// hermes-agent 变体：tool_calls 列（JSON 文本）→ 工具调用数组
// [{ id, name, input }]。JSON 解析失败 / 非数组 / 空 → undefined（该消息无工具列，
// 静默降级现状）。arguments 与 input 同义（两种命名的列内字段都接受）。
function hermesToolCalls(raw) {
  let arr = raw
  if (raw === null || raw === undefined) return undefined
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return undefined
    try {
      arr = JSON.parse(trimmed)
    } catch {
      return undefined
    }
  }
  if (!Array.isArray(arr) || arr.length === 0) return undefined
  const out = []
  for (const t of arr) {
    if (!t || typeof t !== 'object') continue
    const id = typeof t.id === 'string' ? t.id : (typeof t.tool_call_id === 'string' ? t.tool_call_id : undefined)
    const name = typeof t.name === 'string' ? t.name : (typeof t.tool_name === 'string' ? t.tool_name : undefined)
    if (!id || !name) continue
    out.push({ id, name, input: t.arguments ?? t.input })
  }
  return out.length > 0 ? out : undefined
}

// hermes-agent 变体：reasoning 列（JSON 文本或普通文本）→ 推理字符串。
// JSON 字符串 / {content|text} 对象取正文；普通文本原样；空 → undefined。
function hermesReasoning(raw) {
  if (raw === null || raw === undefined) return undefined
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return undefined
    if (trimmed.startsWith('{') || trimmed.startsWith('"')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (typeof parsed === 'string') return parsed || undefined
        if (parsed && typeof parsed === 'object') {
          const c = typeof parsed.content === 'string' ? parsed.content : (typeof parsed.text === 'string' ? parsed.text : '')
          return c || undefined
        }
      } catch {
        // 以 { / " 开头的字面文本，按原样保留
      }
    }
    return raw
  }
  if (typeof raw === 'object') {
    const c = typeof raw.content === 'string' ? raw.content : (typeof raw.text === 'string' ? raw.text : '')
    return c || undefined
  }
  return undefined
}
