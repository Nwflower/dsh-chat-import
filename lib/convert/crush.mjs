// lib/convert/crush.mjs — Crush（charmbracelet/crush）会话 → DSH 会话（纯函数）
//
// 存储：SQLite `crush.db`（WAL + secure_delete），**位于「数据目录」而不是用户 home**。
// 数据目录的解析（上游 internal/config/{config.go,load.go}）：
//   · 默认值常量 `.crush`，从当前工作目录**向上找最近的 `.crush`，边界是 git 工作树根**；
//     找不到才用 `<cwd>/.crush`，最后 SmartJoin 成绝对路径。
//   · 配置键是 `options.data_directory`（`crush.json`）；`--data-dir/-D` 可覆盖。
//   · 用户级目录（$CRUSH_GLOBAL_DATA > $XDG_DATA_HOME/crush > Win %LOCALAPPDATA%\crush >
//     ~/.local/share/crush）**只放 JSON 状态**（README 明文），会话库不在那里。
//   · 因此「发现」必须靠 `<用户级目录>/projects.json` —— `{"projects":[{"path","data_dir",
//     "last_accessed"}]}`（按 last_accessed 降序，无 schema 版本号；文件缺失即空列表），
//     或由宿主提供的工作区列表逐个探测 `<项目>/.crush/crush.db`。库位置可能与 cwd 不同
//     （`.crush` 可能在上层目录被找到），故会话 cwd 取注册表里的项目路径。
//
// 表（goose 迁移，8 个；逐字列名见 internal/db/migrations/*.sql + sqlc 生成的 models.go）：
//   sessions(id PK, parent_session_id, title NOT NULL, message_count, prompt_tokens,
//            completion_tokens, cost REAL, updated_at INTEGER, created_at INTEGER,
//            summary_message_id, todos)
//   messages(id PK, session_id, role, parts TEXT, model, created_at, updated_at,
//            finished_at, provider, is_summary_message, prism_*)
//   files(...)       = 每次 write/edit 的完整文件快照（不是会话附件表，不读）
//   read_files(...)  = 「文件已读」记账（不读）
// 时间戳全部是 **Unix 秒**（INTEGER，SQL 侧 strftime('%s','now')）。
//
// `parts` 是 **TEXT（JSON 字符串）**，形状是 wrapper 数组：`[{"type":…,"data":{…}}]`，
// 判别式 8 种：text / reasoning / tool_call / tool_result / finish / image_url /
// shell_command / binary（binary 的字段是 PascalCase：Path/MIMEType/Data）。
//   tool_call.data   = { id, name, input(原始 JSON 字符串), provider_executed, finished }
//   tool_result.data = { tool_call_id, name, content, data, mime_type, metadata, is_error }
//   配对：tool_call.id ↔ tool_result.tool_call_id；结果通常在**单独一条 role='tool' 的消息**里。
// role 只有 user/assistant/system/tool 四个；非 assistant 消息创建时会自动补一条
// `{"type":"finish","data":{"reason":"stop"}}`（结构块，不读）。
//
// 子会话：`parent_session_id` 非空的是子会话（上游 ListSessions 直接过滤掉）。三类中
// **标题生成会话**（id 前缀 `title-`，title "Generate a title"）不是真实对话，必须排除；
// 子代理会话（id 形如 `<父消息ID>$$<toolCallID>`）与 task 会话同样不单独成会话。
//
// 与上游的一处**有意偏差**：未知 part 判别式上游会让整条消息解析失败（丢消息），我们只跳过
// 那个 part 并计数（`skippedBlocks`）——宁可少一个块，也不要整条对话消失。

import {
  SESSION_FORMAT_VERSION,
  applyBudgetTrim,
  mintSessionId,
  parseTimeMs,
  synthesizeSession,
} from './core.mjs'
import { posix, win32 } from 'node:path'
import { normalizeTitle } from './util.mjs'
import { alignStepResults, dropDuplicateCalls } from './ir.mjs'

// ── 路径解析（纯函数；发现层与 lib/crush.mjs 共用同一份）─────────────────────
function joinFor(platform, ...parts) {
  return platform === 'win32' ? win32.join(...parts) : posix.join(...parts)
}

function isAbsoluteLike(p) {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(String(p))
}

/** Crush 用户级数据目录（只放 JSON 状态；projects.json 在这里）。 */
export function crushUserDataDir(home, env = process.env, platform = process.platform) {
  const override = env.CRUSH_GLOBAL_DATA
  if (override && isAbsoluteLike(override)) return String(override)
  const xdg = env.XDG_DATA_HOME
  if (platform === 'win32' && env.LOCALAPPDATA) return joinFor(platform, String(env.LOCALAPPDATA), 'crush')
  if (xdg && isAbsoluteLike(xdg)) return joinFor(platform, String(xdg), 'crush')
  return joinFor(platform, String(home), '.local', 'share', 'crush')
}

/** 项目注册表路径：<用户级数据目录>/projects.json。 */
export function crushRegistryPath(home, env = process.env, platform = process.platform) {
  return joinFor(platform, crushUserDataDir(home, env, platform), 'projects.json')
}

/** 项目数据目录里的库路径：<项目>/.crush/crush.db（默认 data_directory 就是 `.crush`）。 */
export function crushProjectDbPath(projectDir, platform = process.platform) {
  return joinFor(platform, String(projectDir), '.crush', 'crush.db')
}

/**
 * projects.json → 项目条目数组（`path` + 绝对 `data_dir`）。
 * 容错：文件缺失/畸形返回空数组（上游自己也是「缺失即空列表」）；条目缺 path 丢弃。
 * 注册表**没有 schema 版本号**，故只取这两个字段、忽略其余。
 */
export function parseCrushProjects(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return []
  let doc
  try {
    doc = JSON.parse(raw)
  } catch {
    return []
  }
  const list = doc && typeof doc === 'object' && Array.isArray(doc.projects) ? doc.projects : []
  const out = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const path = typeof entry.path === 'string' && entry.path ? entry.path : null
    if (!path) continue
    out.push({
      path,
      dataDir: typeof entry.data_dir === 'string' && entry.data_dir ? entry.data_dir : null,
      lastAccessed: typeof entry.last_accessed === 'string' ? entry.last_accessed : null,
    })
  }
  return out
}


// 标题生成会话 / 空壳会话的识别：不是真实对话，不导入
function isSyntheticSession(id, title) {
  if (typeof id === 'string' && id.startsWith('title-')) return true
  const t = String(title || '').trim().toLowerCase()
  return t === 'generate a title' || t === 'new agent session' && false
}

// tool_result.data.content → 文本；取不到返回 null（不虚构）
function crushResultText(data) {
  if (!data || typeof data !== 'object') return null
  if (typeof data.content === 'string' && data.content) return data.content
  if (Array.isArray(data.content)) {
    const texts = data.content
      .map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : (typeof b === 'string' ? b : '')))
      .filter(Boolean)
    if (texts.length > 0) return texts.join('\n')
  }
  return null
}

/** Crush 会话（lib/crush.mjs 从两表抽出的中间 JSON）→ DSH 会话。 */
export function convertCrushJson(raw, args = {}) {
  let session
  try {
    session = JSON.parse(raw)
  } catch {
    return {
      meta: null, events: [], turns: [], title: undefined, messages: 0, toolCalls: 0,
      skipped: 1, records: 0, skippedLines: [], secrets: [],
      skipReason: 'not a Crush session (invalid JSON)',
    }
  }
  if (!session || typeof session !== 'object' || !Array.isArray(session.messages)) {
    return {
      meta: null, events: [], turns: [], title: undefined, messages: 0, toolCalls: 0,
      skipped: 1, records: 0, skippedLines: [], secrets: [],
      skipReason: 'not a Crush session (no messages array)',
    }
  }

  const sourceId = typeof session.id === 'string' && session.id ? session.id : null
  const title = typeof session.title === 'string' ? session.title : ''
  // 子会话（parent_session_id 非空）与标题生成会话不单独成会话
  if (session.parentSessionId) {
    return {
      meta: null, events: [], turns: [], title: undefined, messages: 0, toolCalls: 0,
      skipped: 1, records: session.messages.length, skippedLines: [], secrets: [],
      skipReason: 'Crush sub-session (' + (sourceId || 'unknown') + '); only root sessions become sessions',
    }
  }
  if (isSyntheticSession(sourceId, title)) {
    return {
      meta: null, events: [], turns: [], title: undefined, messages: 0, toolCalls: 0,
      skipped: 1, records: session.messages.length, skippedLines: [], secrets: [],
      skipReason: 'Crush title-generation session (' + (sourceId || 'unknown') + '); not a conversation',
    }
  }

  const turns = []
  let cur = null
  let systemPrompt
  let model = null
  const callSteps = new Map()
  let droppedToolResults = 0
  let droppedDuplicateCalls = 0
  let skippedBlocks = 0
  let compactionSummaries = 0
  // 待落到下一个开启轮的压缩检查点（原生事务，见 events.mjs）
  let pendingCompaction = null

  const openTurn = (prompt, time) => {
    cur = { prompt, steps: [] }
    if (time !== null && time !== undefined) cur.time = time
    if (pendingCompaction) {
      cur.compaction = pendingCompaction
      pendingCompaction = null
    }
    turns.push(cur)
  }
  const openStep = (time) => {
    // 压缩点之后以产物（无提问）起头：开一个空 prompt 轮承载检查点与其后内容
    if (!cur && pendingCompaction) openTurn('', time)
    if (!cur) return null
    const step = { content: [], toolCalls: [], toolResults: [] }
    if (time !== null && time !== undefined) step.time = time
    cur.steps.push(step)
    return step
  }
  const attachResult = (step, toolCallId, text, isError, time) => {
    if (!step) { droppedToolResults++; return }
    step.toolResults.push({
      toolCallId,
      ...(time !== null && time !== undefined ? { time } : {}),
      content: text === null ? [] : [{ type: 'text', text }],
      isError: isError === true,
    })
  }
  // parts 文本块 → 字符串数组；未知判别式只计数（见文件头的有意偏差说明）
  const textOf = (parts) => {
    const out = []
    for (const part of Array.isArray(parts) ? parts : []) {
      if (!part || typeof part !== 'object') continue
      if (part.type === 'text' && part.data && typeof part.data.text === 'string' && part.data.text) {
        out.push(part.data.text)
      } else if (part.type !== 'finish' && part.type !== 'tool_call' && part.type !== 'tool_result'
        && part.type !== 'reasoning') {
        skippedBlocks++ // image_url / shell_command / binary / 未知判别式
      }
    }
    return out
  }

  for (const msg of session.messages) {
    if (!msg || typeof msg !== 'object') continue
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    if (!model && typeof msg.model === 'string' && msg.model) model = msg.model
    // 消息级时间戳（读取层保留 Unix 秒，parseTimeMs 归一毫秒）：assistant 用 finished_at
    //（回复完成时刻 = assistant/message 的事件时间，step.start→message 即模型耗时），
    // 缺 finished_at 回退 created_at；其余角色用 created_at
    const msgTime = msg.role === 'assistant'
      ? parseTimeMs(msg.finishedAt) ?? parseTimeMs(msg.createdAt)
      : parseTimeMs(msg.createdAt)
    // 自动摘要消息（is_summary_message=1，会话的 summary_message_id 指向它）是压缩产物：
    // 默认导入为 **DSH 原生压缩检查点**——此刻已建的轮全部 log-only（正文照常留在日志里），
    // 摘要作检查点并挂到压缩点之后的第一个轮；fullHistory: true 时不发检查点，摘要按既有形态
    //（reasoning 块）还原压缩边界。
    if (msg.isSummaryMessage === 1 || msg.isSummaryMessage === true) {
      const text = textOf(parts).join('\n').trim()
      if (text) {
        compactionSummaries++
        if (args.fullHistory === true) {
          const step = cur && cur.steps.length > 0 ? cur.steps[cur.steps.length - 1] : openStep(msgTime)
          if (step) step.content.push({ type: 'reasoning', text: 'Compaction summary:\n\n' + text })
        } else {
          for (const t of turns) t.shadowed = true
          cur = null
          pendingCompaction = { summary: text, provider: 'crush', model: model || undefined }
          if (msgTime !== null) pendingCompaction.time = msgTime
        }
      }
      continue
    }
    if (msg.role === 'user') {
      const prompt = textOf(parts).join('\n')
      if (prompt.trim()) openTurn(prompt, msgTime)
    } else if (msg.role === 'assistant') {
      const step = openStep(msgTime)
      if (!step) continue
      for (const part of parts) {
        if (!part || typeof part !== 'object') continue
        const data = part.data && typeof part.data === 'object' ? part.data : {}
        if (part.type === 'text') {
          if (typeof data.text === 'string' && data.text) step.content.push({ type: 'text', text: data.text })
        } else if (part.type === 'reasoning') {
          if (typeof data.thinking === 'string' && data.thinking) step.content.push({ type: 'reasoning', text: data.thinking })
          else skippedBlocks++ // 只有签名/加密推理（responses_data）而没有可读正文
        } else if (part.type === 'tool_call') {
          const id = typeof data.id === 'string' && data.id ? data.id : null
          const name = typeof data.name === 'string' && data.name ? data.name : null
          if (!id || !name) { skippedBlocks++; continue }
          // input 是**原始 JSON 字符串**（不是对象）→ 原样作为 arguments
          const argumentsText = typeof data.input === 'string'
            ? data.input
            : JSON.stringify(data.input ?? {})
          const call = { type: 'tool-call', id, name, arguments: argumentsText }
          step.content.push(call)
          step.toolCalls.push(call)
          callSteps.set(id, step)
        } else if (part.type === 'tool_result') {
          // 结果通常在单独一条 role='tool' 消息里，但 part 层宽松 → 两处都收
          const toolCallId = typeof data.tool_call_id === 'string' && data.tool_call_id ? data.tool_call_id : null
          if (!toolCallId) { skippedBlocks++; continue }
          attachResult(callSteps.get(toolCallId) || null, toolCallId, crushResultText(data), data.is_error, msgTime)
        } else if (part.type !== 'finish') {
          skippedBlocks++ // image_url / shell_command / binary / 未知
        }
      }
    } else if (msg.role === 'tool') {
      for (const part of parts) {
        if (!part || typeof part !== 'object') continue
        if (part.type === 'tool_result') {
          const data = part.data && typeof part.data === 'object' ? part.data : {}
          const toolCallId = typeof data.tool_call_id === 'string' && data.tool_call_id ? data.tool_call_id : null
          if (!toolCallId) { skippedBlocks++; continue }
          attachResult(callSteps.get(toolCallId) || null, toolCallId, crushResultText(data), data.is_error, msgTime)
        } else if (part.type !== 'finish') {
          skippedBlocks++
        }
      }
    } else if (msg.role === 'system') {
      const text = textOf(parts).join('\n\n')
      if (text) systemPrompt = systemPrompt ? systemPrompt + '\n\n' + text : text
    }
    // 其它角色忽略
  }

  droppedDuplicateCalls = dropDuplicateCalls(turns)
  alignStepResults(turns)

  const sessionId = args.sessionId || mintSessionId(sourceId || args.crushId)
  const meta = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    // 时间戳：会话级 created_at（Unix 秒）经 args 传入；消息级 created_at/finished_at
    // 已透传进 IR 逐步时间（宿主耗时统计原料），createdAt 兜底仍取首条消息
    createdAt: args.createdAt ?? (Number.isFinite(session.createdAt) ? session.createdAt : null)
      ?? parseTimeMs(session.messages[0] && session.messages[0].createdAt) ?? Date.now(),
  }
  meta.sourceId = sourceId || sessionId
  const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : null
  if (cwd) meta.cwd = cwd

  // 待落检查点没等到新轮（会话正好停在压缩点）：空 prompt 轮兜住，否则边界无处发射
  if (pendingCompaction) {
    const tail = { prompt: '', steps: [], compaction: pendingCompaction }
    if (pendingCompaction.time !== undefined) tail.time = pendingCompaction.time
    turns.push(tail)
    pendingCompaction = null
  }

  const explicit = title.trim() ? title.trim() : ''
  const finalTitle = normalizeTitle(explicit || (turns.length > 0 ? turns[0].prompt : ''))
  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, args.budget)
  const syn = synthesizeSession({
    meta,
    turns: seedTurns,
    title: explicit ? finalTitle : undefined,
    provider: 'crush',
    model,
    skipped: 0,
    records: session.messages.length,
    systemPrompt: args.importSystemPrompt === true && systemPrompt ? systemPrompt : undefined,
    imported: { sourcePath: args.sourcePath },
  })
  return {
    ...syn,
    title: finalTitle,
    droppedToolResults,
    droppedDuplicateCalls,
    skippedBlocks,
    compactionSummaries,
    // compacted/compactions：原生压缩检查点（syn.compactions 是实际发射的检查点数）
    ...(syn.compactions ? { compacted: true } : {}),
    ...(trimmed ? { trimmed } : {}),
  }
}
