// lib/convert/goose.mjs — Goose（aaif-goose/goose）会话 → DSH 会话（纯函数）
//
// 存储：<data_dir>/sessions/sessions.db（SQLite WAL；v1.10.0 起取代旧的
// sessions/*.jsonl）。data_dir 由平台决定，`GOOSE_PATH_ROOT`（仅绝对路径）可整体改写：
//   Linux   ~/.local/share/goose/sessions/sessions.db
//   macOS   ~/Library/Application Support/Block/goose/sessions/sessions.db
//   Windows %APPDATA%\Block\goose\data\sessions\sessions.db
// 旧 jsonl **仍留在磁盘**（上游只在首次建库时全量迁移一次、之后不再管），所以本插件
// 只以 sessions.db 为来源——同目录 jsonl 一律不读，避免重复导入。
//
// 本模块消费 lib/goose.mjs 从两张表抽出的中间 JSON（保持 goose 自己的字段名与块词汇）：
//   { id, name, description, workingDir, providerName, sessionType, parentSessionId,
//     createdAt, updatedAt, systemPrompt?,
//     messages: [ { role, createdTimestamp, metadata?, content: [ block... ] } ] }
//   sessions 表：id / name（LLM 生成或用户设置的标题）/ description（遗留，读时 name 非空
//   优先）/ working_dir（启动 cwd）/ session_type / parent_session_id / created_at /
//   updated_at（见下：两种文本格式混存）
//   messages 表：一条消息一行，content_json 是该消息的**整个 content 块数组**
//
// 块词汇（crates/goose-provider-types 的 MessageContentBlock，serde tag="type" camelCase）：
//   text{text} / thinking{thinking,signature} / redactedThinking{data}（密文，跳过）/
//   toolRequest{id, tool_call:{status, value:{name, arguments}}} /
//   toolResponse{id, tool_result:{status, value|error}} /
//   image|document（附件）/ toolConfirmationRequest|actionRequired（UI 交互）/
//   systemNotification|error（运行期横幅）——后三类不进对话，计数上报。
//   旧形状 {type:'reasoning', text} 兼容（上游读取时才迁移成 thinking，库里可能仍是旧串）。
// 配对键是 **toolRequest.id ↔ toolResponse.id**（模型给的 call id）；`tool_call`/
// `tool_result` 只是信封名，里面是 `{status, value}`（error 时没有 value）。
// 请求在 assistant 消息里、结果在 user 消息里——所以 user 消息同样要区分「人类提问」与
// 「结果载体」（与 cline/claude 同一纪律）；载体里若还带正文，挂到该步而不是开新轮。
//
// 时间戳：messages.created_timestamp 是 Unix 整数（秒；历史库可能有毫秒值），
// sessions.created_at/updated_at 是 SQLite CURRENT_TIMESTAMP 文本（UTC 但**不带时区**，
// 需按 UTC 解析），而 import_session 路径会写 RFC3339——两种格式混存，故两种都认。
// 标题取 name 非空优先、否则 description；cwd 取 working_dir。

import {
  SESSION_FORMAT_VERSION,
  applyBudgetTrim,
  mintSessionId,
  synthesizeSession,
} from './core.mjs'
import { posix, win32 } from 'node:path'
import { contentText, normalizeTitle } from './util.mjs'

// ── 路径解析（纯函数；发现层与 lib/goose.mjs 共用同一份，避免两处规则漂移）──────
// 用 node:path 的 posix/win32 显式拼接（按目标平台取），而不是按运行平台隐式 join：
// 这样在 Windows 上也能算对 Linux/macOS 路径（反之亦然），测试可跨平台断言。
function joinFor(platform, ...parts) {
  return platform === 'win32' ? win32.join(...parts) : posix.join(...parts)
}

// GOOSE_PATH_ROOT 仅在**绝对路径**时生效（相对路径/空串被上游忽略，有单测）。
function isAbsoluteLike(p) {
  const s = String(p)
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(s)
}

/** Goose 数据根（含 sessions/ 的那一层）。env 默认取 process.env（测试可注入假环境）。 */
export function gooseDataDir(home, env = process.env, platform = process.platform) {
  const root = env.GOOSE_PATH_ROOT
  if (root && isAbsoluteLike(root)) return joinFor(platform, String(root), 'data')
  if (platform === 'win32' && env.APPDATA) return joinFor(platform, String(env.APPDATA), 'Block', 'goose', 'data')
  if (platform === 'darwin') return joinFor(platform, String(home), 'Library', 'Application Support', 'Block', 'goose')
  return joinFor(platform, String(home), '.local', 'share', 'goose')
}

/** Goose 会话目录（发现层的默认根）。 */
export function gooseSessionsDir(home, env = process.env, platform = process.platform) {
  return joinFor(platform, gooseDataDir(home, env, platform), 'sessions')
}

/** Goose 会话库路径。 */
export function gooseDefaultDbPath(home, env = process.env, platform = process.platform) {
  return joinFor(platform, gooseSessionsDir(home, env, platform), 'sessions.db')
}

// 结果文本：value 可能是 CallToolResult{content:[{type:'text',text}]}、裸块数组、
// 纯字符串或 {text}。取不到返回 null（不虚构）。
function toolResultText(value) {
  if (typeof value === 'string') return value || null
  const blocks = Array.isArray(value) ? value : (value && typeof value === 'object' && Array.isArray(value.content) ? value.content : null)
  if (blocks) {
    const texts = []
    for (const b of blocks) {
      if (typeof b === 'string' && b) texts.push(b)
      else if (b && typeof b === 'object' && typeof b.text === 'string' && b.text) texts.push(b.text)
    }
    return texts.length > 0 ? texts.join('\n') : null
  }
  if (value && typeof value === 'object' && typeof value.text === 'string' && value.text) return value.text
  return null
}

// toolResponse 信封 {status, value|error} → { text, isError }
function toolResponseResult(block) {
  const env = block.tool_result && typeof block.tool_result === 'object' ? block.tool_result : null
  const status = env ? env.status : undefined
  const value = env ? env.value : undefined
  const err = env ? env.error : undefined
  const text = toolResultText(value) ?? (typeof err === 'string' && err ? err : null)
  const isError = status === 'error' || (value && typeof value === 'object' && value.isError === true)
  return { text, isError }
}

// 块 → DSH 内容块。不认识的块返回 null（由调用方计数；绝不虚构文本）。
function mapGooseBlock(block) {
  if (!block || typeof block !== 'object') return null
  if (block.type === 'text') {
    return typeof block.text === 'string' && block.text ? { type: 'text', text: block.text } : null
  }
  if (block.type === 'thinking') {
    return typeof block.thinking === 'string' && block.thinking ? { type: 'reasoning', text: block.thinking } : null
  }
  // 旧形状：上游读取时把 {type:'reasoning',text} 迁移成 thinking，但库里可能仍是旧串
  if (block.type === 'reasoning') {
    return typeof block.text === 'string' && block.text ? { type: 'reasoning', text: block.text } : null
  }
  if (block.type === 'toolRequest') {
    const env = block.tool_call && typeof block.tool_call === 'object' ? block.tool_call : null
    const name = env && env.value && typeof env.value === 'object' && typeof env.value.name === 'string'
      ? env.value.name
      : null
    const id = typeof block.id === 'string' && block.id ? block.id : null
    // status:'error' 的请求没有可用的 value（无工具名/参数）→ 交给调用方计数跳过
    if (!id || !name) return null
    const rawArgs = env.value.arguments
    const argumentsText = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {})
    return { type: 'tool-call', id, name, arguments: argumentsText }
  }
  return null
}


// 同一步内多个结果按 call 顺序对齐（并行工具的结果可能分批到达；claude/zcode 同款）
function alignStepResults(step) {
  if (step.toolResults.length < 2 || step.toolCalls.length === 0) return
  const order = new Map(step.toolCalls.map((c, i) => [c.id, i]))
  step.toolResults.sort((a, b) => {
    const ia = order.get(a.toolCallId)
    const ib = order.get(b.toolCallId)
    return (ia === undefined ? Number.MAX_SAFE_INTEGER : ia) - (ib === undefined ? Number.MAX_SAFE_INTEGER : ib)
  })
}

// 重复 callId 防御：保留首次出现，后续重复的 tool-call 块整块丢弃并计数（DSH 折叠器对
// 同一 callId 的第二次 start 会硬异常、并静默吞掉其后整段轨迹）。
function dropDuplicateCalls(turns) {
  const seen = new Set()
  let dropped = 0
  for (const t of turns) {
    for (const s of t.steps) {
      const keptCalls = []
      const keptContent = []
      for (const block of s.content) {
        if (block.type === 'tool-call') {
          if (seen.has(block.id)) { dropped++; continue }
          seen.add(block.id)
          keptCalls.push(block)
        }
        keptContent.push(block)
      }
      s.content = keptContent
      s.toolCalls = keptCalls
    }
  }
  return dropped
}

// Goose 会话（lib/goose.mjs 抽出的中间 JSON）→ DSH 会话。
export function convertGooseJson(raw, args = {}) {
  let session
  try {
    session = JSON.parse(raw)
  } catch {
    return {
      meta: null, events: [], turns: [], title: undefined, messages: 0, toolCalls: 0,
      skipped: 1, records: 0, skippedLines: [], secrets: [],
      skipReason: 'not a Goose session (invalid JSON)',
    }
  }
  if (!session || typeof session !== 'object' || !Array.isArray(session.messages)) {
    return {
      meta: null, events: [], turns: [], title: undefined, messages: 0, toolCalls: 0,
      skipped: 1, records: 0, skippedLines: [], secrets: [],
      skipReason: 'not a Goose session (no messages array)',
    }
  }

  const sourceId = typeof session.id === 'string' && session.id ? session.id : null
  // 子代理会话 / 隐藏会话不单独成会话（上游：parent_session_id + session_type='sub_agent'；
  // hidden 是 UI 隐藏的辅助会话）。读取层已过滤，这里再挡一道以防手工构造的中间 JSON。
  const sessionType = typeof session.sessionType === 'string' ? session.sessionType : ''
  const parentId = typeof session.parentSessionId === 'string' ? session.parentSessionId : ''
  if (sessionType === 'sub_agent' || sessionType === 'hidden' || parentId) {
    return {
      meta: null, events: [], turns: [], title: undefined, messages: 0, toolCalls: 0,
      skipped: 1, records: session.messages.length, skippedLines: [], secrets: [],
      skipReason: 'Goose ' + (sessionType || 'sub_agent') + ' session (' + (sourceId || 'unknown')
        + '); only top-level sessions become sessions',
    }
  }

  const messages = session.messages
  const turns = []
  let cur = null
  let lastStep = null
  let firstTs = null
  const callSteps = new Map()
  let droppedToolResults = 0
  let skippedBlocks = 0

  const openTurn = (prompt, time) => {
    cur = { prompt, steps: [] }
    if (time !== undefined) cur.time = time
    turns.push(cur)
    lastStep = null
  }
  const openStep = (time) => {
    if (!cur) return null
    const step = { content: [], toolCalls: [], toolResults: [] }
    if (time !== undefined) step.time = time
    cur.steps.push(step)
    lastStep = step
    return step
  }

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    if (firstTs === null && Number.isFinite(msg.createdTimestamp)) firstTs = msg.createdTimestamp
    // 读取层已归一为毫秒（created_timestamp 秒/毫秒混存 → gooseEpochTime）→ IR time
    const msgTime = Number.isFinite(msg.createdTimestamp) ? msg.createdTimestamp : undefined
    const blocks = Array.isArray(msg.content) ? msg.content : []
    if (msg.role === 'user') {
      const responses = blocks.filter((b) => b && b.type === 'toolResponse')
      // 用户消息里除 text / toolResponse 之外的块（actionRequired、toolConfirmationRequest、
      // 附件、密文…）都不进对话，逐个计数，绝不静默吞掉
      for (const block of blocks) {
        if (!block || block.type === 'text' || block.type === 'toolResponse') continue
        skippedBlocks++
      }
      if (responses.length > 0) {
        for (const block of responses) {
          const id = typeof block.id === 'string' ? block.id : null
          const step = id ? callSteps.get(id) : null
          // 孤儿结果（转录从中途开始 / 调用已被预算裁掉）丢弃并计数：挂最近一步会投影出
          // 无 call 的孤儿 tool 消息，被模型 API 拒绝
          if (!step) { droppedToolResults++; continue }
          const { text, isError } = toolResponseResult(block)
          step.toolResults.push({
            toolCallId: id,
            ...(msgTime !== undefined ? { time: msgTime } : {}),
            content: text === null ? [] : [{ type: 'text', text }],
            isError,
          })
        }
        // 结果载体里的人类补充正文：挂到该步（DSH 的轮次里没有「轮中 user 消息」位置，
        // 开新轮会把后续 assistant 步骤割裂到错误回合）
        const carrierText = contentText(blocks, { skipEmpty: true })
        if (carrierText) {
          const step = lastStep || (cur ? openStep(msgTime) : null)
          if (step) step.content.push({ type: 'text', text: carrierText })
        }
      } else {
        const prompt = contentText(blocks, { skipEmpty: true })
        if (prompt.trim()) openTurn(prompt, msgTime)
      }
    } else if (msg.role === 'assistant' && cur) {
      const step = openStep(msgTime)
      for (const block of blocks) {
        const mapped = mapGooseBlock(block)
        if (!mapped) { skippedBlocks++; continue }
        step.content.push(mapped)
        if (mapped.type === 'tool-call') {
          step.toolCalls.push(mapped)
          callSteps.set(mapped.id, step)
        }
      }
    }
    // role='system'（系统提示词，读取层已收集）与其它角色不进对话
  }

  const droppedDuplicateCalls = dropDuplicateCalls(turns)
  for (const t of turns) for (const s of t.steps) alignStepResults(s)

  const sessionId = args.sessionId || mintSessionId(sourceId || args.gooseId)
  const src = sourceId || args.gooseId || sessionId
  const meta = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    // 创建时间：上游 sessions.created_at 是 UTC 文本（两种格式混存，读取层已归一为毫秒）
    createdAt: args.createdAt ?? (Number.isFinite(session.createdAt) ? session.createdAt : null)
      ?? firstTs ?? Date.now(),
  }
  meta.sourceId = src
  const cwd = typeof session.workingDir === 'string' && session.workingDir ? session.workingDir : null
  if (cwd) meta.cwd = cwd

  // 标题：name（LLM 生成或用户改名）优先，空则回退 description（遗留列）；都空再首问兜底
  const explicit = typeof session.name === 'string' && session.name.trim()
    ? session.name.trim()
    : (typeof session.description === 'string' && session.description.trim() ? session.description.trim() : '')
  const finalTitle = normalizeTitle(explicit || (turns.length > 0 ? turns[0].prompt : ''))
  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, args.budget)
  const systemPrompt = args.importSystemPrompt === true
    && typeof session.systemPrompt === 'string' && session.systemPrompt.trim()
    ? session.systemPrompt
    : undefined
  const syn = synthesizeSession({
    meta,
    turns: seedTurns,
    title: explicit ? finalTitle : undefined,
    provider: 'goose',
    skipped: 0,
    records: messages.length,
    systemPrompt,
    imported: { sourcePath: args.sourcePath },
  })
  return {
    ...syn,
    title: finalTitle,
    droppedToolResults,
    droppedDuplicateCalls,
    skippedBlocks,
    ...(trimmed ? { trimmed } : {}),
  }
}
