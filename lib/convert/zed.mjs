// lib/convert/zed.mjs — Zed（zed-industries/zed）Agent 线程 → DSH 会话（纯函数）
//
// 存储：<data_dir>/threads/threads.db（SQLite）。data_dir 按平台（上游 crates/paths）：
//   macOS   ~/Library/Application Support/Zed
//   Linux   $XDG_DATA_HOME/zed（默认 ~/.local/share/zed）
//   Windows %LOCALAPPDATA%\Zed（目录名是 "Zed"，不是小写）
//   `--user-data-dir <dir>` 会整体改写 data_dir → <dir>/threads/threads.db；`ZED_STATETLESS`
//   之类的内存库不落盘（扫不到属正常）。注意与 <data_dir>/db/db.sqlite（Zed 自己的数据库）
//   无关，别混淆。
//
// 表 `threads`（上游 db.rs：1×CREATE + 3×ALTER + 1×UPDATE，无索引、无其它表）：
//   id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at TEXT NOT NULL,
//   data_type TEXT NOT NULL, data BLOB NOT NULL,
//   parent_id TEXT, folder_paths TEXT, folder_paths_order TEXT, created_at TEXT
//   —— `summary` 就是线程标题（不是 title）；`data_type ∈ {json, zstd}`，**写入端恒 zstd**
//      （压缩等级 3，标准帧、无自定义头），`json` 只剩读取兼容；
//   —— `parent_id` 非空 = **子代理线程**（上游 UI 会过滤掉这些行，ThreadStore 亦然）；
//   —— `folder_paths` 是**多根工作区的路径集合**，用 `\n` 连接（字典序），
//      `folder_paths_order` 用 `,` 连接索引（还原原始顺序；缺失/长度不符时按字典序退化）；
//   —— `created_at` 由 ALTER 补列，老库可能为 NULL。
//
// data 解压后是 `SerializedThread = DbThread 的 flatten + version`：
//   · version === '0.3.0'（当前）→ DbThread：{ title, messages, updated_at, model,
//     detailed_summary, cumulative_token_usage, request_token_usage, profile,
//     subagent_context, thinking_* , sandbox_* , initial_project_snapshot, … }
//     messages 元素是 **serde 默认外部标签**：
//       {"User": { id, content: [UserMessageContent] }}
//       {"Agent": { content: [AgentMessageContent], tool_results: { <tool_use_id>: … }, reasoning_details }}
//       "Resume"（unit 变体 → 裸字符串；UI 续聊标记，不进对话）
//       {"Compaction": {"Summary": "…"}} 或 {"ProviderNative": {…}}
//       —— Compaction 是压缩落点（v1.7 起 /compact 与自动压缩都写它，语义是「用摘要替换整段
//          历史」）：默认导入为 DSH 原生压缩检查点（其前的轮 log-only、日志保全量，
//          模型视角 = 摘要 + 压缩点之后的内容）；fullHistory: true 时不发检查点、摘要退回
//          reasoning 块。ProviderNative（不透明 items）读不到摘要，只计数。
//     UserMessageContent = {"Text": "…"} | {"Mention": {uri}} | {"Image": {…}}
//     AgentMessageContent = {"Text": "…"} | {"Thinking": {text, signature}} |
//                            {"RedactedThinking": "…"} | {"ToolUse": LanguageModelToolUse}
//     LanguageModelToolUse = { id, name, raw_input(J原始 JSON 文本), input: {type,value},
//                              is_input_complete, thought_signature }
//     LanguageModelToolResult = { tool_use_id, tool_name, is_error, content: [{"Text"}|{"Image"}], output }
//   · version 缺失或非 '0.3.0' → 上游走 legacy_thread 升级分支，形状是
//     { version, summary, updated_at, messages: [SerializedMessage] }，其中
//     SerializedMessage = { id, role: 'user'|'assistant'|'system',
//       segments: [{"type":"text"|"thinking"|"RedactedThinking", …}],
//       tool_uses: [{id,name,input}], tool_results: [{tool_use_id,is_error,content,output}],
//       is_visible }。本模块两种方言都实现（老库不该因版本判错而整条读不出来）。
//
// 时间戳：行级 created_at/updated_at 是 RFC3339（上游 to_rfc3339 写，带 +00:00 偏移，
// 秒的小数位可能到 9 位）；**线程内消息完全没有时间戳**（Message 类型里没有任何时间字段），
// 所以逐消息时间只能缺省（synthesizeSession 用会话级 createdAt），绝不伪造精确值。
// 工具结果：v0.3.0 挂在同一条 Agent 消息的 tool_results **对象**（键 = tool_use_id）；
// legacy 是消息上的数组。两者都按 id 配对，孤儿结果丢弃并计数。

import {
  SESSION_FORMAT_VERSION,
  finishSession,
  mintSessionId,
  parseTimeMs,
} from './core.mjs'
import { joinForPlatform as joinFor, normalizeTitle, skipResult } from './util.mjs'
import { alignStepResults, dropDuplicateCalls, shadowTurns } from './ir.mjs'

// ── 路径解析（纯函数；发现层与 lib/zed.mjs 共用同一份）─────────────────────────

/** Zed 数据根（threads/ 与 db/ 的父目录）。 */
export function zedDataDir(home, env = process.env, platform = process.platform) {
  if (platform === 'win32' && env.LOCALAPPDATA) return joinFor(platform, String(env.LOCALAPPDATA), 'Zed')
  if (platform === 'darwin') return joinFor(platform, String(home), 'Library', 'Application Support', 'Zed')
  const xdg = env.XDG_DATA_HOME
  if (xdg && /^([a-zA-Z]:[\\/]|[\\/])/.test(String(xdg))) return joinFor(platform, String(xdg), 'zed')
  return joinFor(platform, String(home), '.local', 'share', 'zed')
}

/** Zed 线程库所在目录（发现层的默认根）。 */
export function zedThreadsDir(home, env = process.env, platform = process.platform) {
  return joinFor(platform, zedDataDir(home, env, platform), 'threads')
}

/** Zed 线程库路径。 */
export function zedThreadsDbPath(home, env = process.env, platform = process.platform) {
  return joinFor(platform, zedThreadsDir(home, env, platform), 'threads.db')
}


// folder_paths / folder_paths_order → 有序工作区路径数组（上游 PathList 的编码：
// `\n` 连接路径、`,` 连接索引；索引缺失或长度不符时退化为字典序）
export function zedFolderPaths(folderPaths, folderPathsOrder) {
  const paths = typeof folderPaths === 'string' && folderPaths
    ? folderPaths.split('\n').filter((p) => p)
    : []
  if (paths.length <= 1) return paths
  const order = typeof folderPathsOrder === 'string' && folderPathsOrder
    ? folderPathsOrder.split(',').map((n) => Number.parseInt(n, 10))
    : []
  if (order.length !== paths.length || order.some((i) => !Number.isInteger(i) || i < 0 || i >= paths.length)) {
    return paths
  }
  return order.map((i) => paths[i])
}

// v0.3.0 工具结果 content → 文本（外部标签 [{"Text": …} | {"Image": …}]）；图片不计入文本
function v3ResultText(result) {
  const parts = []
  let images = 0
  const items = Array.isArray(result && result.content) ? result.content : []
  for (const item of items) {
    if (item && typeof item === 'object' && typeof item.Text === 'string' && item.Text) parts.push(item.Text)
    else if (item && typeof item === 'object' && item.Image) images++
  }
  if (parts.length === 0 && typeof result?.output === 'string' && result.output) parts.push(result.output)
  return { text: parts.length > 0 ? parts.join('\n') : null, images }
}

// legacy 工具结果 content → 文本（内容块形状不固定，容错取 text）
function legacyResultText(result) {
  const parts = []
  const items = Array.isArray(result && result.content) ? result.content : []
  for (const item of items) {
    if (typeof item === 'string' && item) parts.push(item)
    else if (item && typeof item === 'object' && typeof item.text === 'string' && item.text) parts.push(item.text)
  }
  const output = result && result.output
  if (typeof output === 'string' && output) parts.push(output)
  else if (output && typeof output === 'object' && typeof output.text === 'string' && output.text) parts.push(output.text)
  return parts.length > 0 ? parts.join('\n') : null
}

// tool_use → 统一 { id, name, arguments }（v0.3.0 与 legacy 的形状不同，分两个取参口径）
function v3ToolCall(toolUse) {
  const id = typeof toolUse?.id === 'string' && toolUse.id ? toolUse.id : null
  const name = typeof toolUse?.name === 'string' && toolUse.name ? toolUse.name : null
  if (!id || !name) return null
  const rawInput = toolUse.raw_input
  let argsText
  if (typeof rawInput === 'string' && rawInput) argsText = rawInput
  else if (toolUse.input && typeof toolUse.input === 'object') {
    argsText = toolUse.input.type === 'text' && typeof toolUse.input.value === 'string'
      ? toolUse.input.value
      : JSON.stringify(toolUse.input.value ?? {})
  } else argsText = '{}'
  return { type: 'tool-call', id, name, arguments: argsText }
}

function legacyToolCall(toolUse) {
  const id = typeof toolUse?.id === 'string' && toolUse.id ? toolUse.id : null
  const name = typeof toolUse?.name === 'string' && toolUse.name ? toolUse.name : null
  if (!id || !name) return null
  const input = toolUse.input
  const argsText = typeof input === 'string' ? input : JSON.stringify(input ?? {})
  return { type: 'tool-call', id, name, arguments: argsText }
}

/** Zed 线程（lib/zed.mjs 解压/解析后的中间 JSON）→ DSH 会话。 */
export function convertZedJson(raw, args = {}) {
  let thread
  try {
    thread = JSON.parse(raw)
  } catch {
    return skipResult('not a Zed thread (invalid JSON)', { skipped: 1 })
  }
  if (!thread || typeof thread !== 'object' || !Array.isArray(thread.messages)) {
    return skipResult('not a Zed thread (no messages array)', { skipped: 1 })
  }

  const version = typeof thread.version === 'string' ? thread.version : ''
  const v3 = version === '0.3.0'
  const sourceId = typeof args.zedId === 'string' && args.zedId ? args.zedId : null

  const turns = []
  // 已标 log-only 的轮数（多次压缩只走新增的轮）
  let shadowedTurns = 0
  let cur = null
  let systemPrompt
  let model = null
  if (thread.model && typeof thread.model === 'object' && typeof thread.model.model === 'string') {
    model = thread.model.model
  } else if (typeof thread.model === 'string' && thread.model) {
    model = thread.model
  }
  const callSteps = new Map()
  let droppedToolResults = 0
  let skippedBlocks = 0
  let compactionSummaries = 0
  // 待落到下一个开启轮的压缩检查点（原生事务，见 events.mjs）。Zed 的压缩语义是「用摘要
  // 替换整段历史」（v1.7 起 /compact 与自动压缩同此），消息里没有保留窗口标记 → 压缩消息
  // 之前的轮整段 log-only（正文仍留在日志里），模型只看得到摘要 + 压缩点之后的内容。
  let pendingCompaction = null

  const openTurn = (prompt) => {
    cur = { prompt, steps: [] }
    if (pendingCompaction) {
      cur.compaction = pendingCompaction
      pendingCompaction = null
    }
    turns.push(cur)
  }
  const openStep = (reasoningText) => {
    // 压缩点之后以产物（无提问）起头：开一个空 prompt 轮承载检查点与其后内容
    if (!cur && pendingCompaction) openTurn('')
    if (!cur) return null
    const step = { content: [], toolCalls: [], toolResults: [] }
    if (reasoningText) step.content.push({ type: 'reasoning', text: reasoningText })
    cur.steps.push(step)
    return step
  }
  const attachResult = (step, toolUseId, text, isError) => {
    if (!step) { droppedToolResults++; return }
    step.toolResults.push({
      toolCallId: toolUseId,
      content: text === null ? [] : [{ type: 'text', text }],
      isError: isError === true,
    })
  }

  if (v3) {
    for (const msg of thread.messages) {
      // unit 变体序列化成裸字符串（"Resume"）→ UI 续聊标记，不进对话
      if (typeof msg === 'string') continue
      if (!msg || typeof msg !== 'object') continue
      if (msg.User) {
        const blocks = Array.isArray(msg.User.content) ? msg.User.content : []
        const texts = []
        for (const block of blocks) {
          if (block && typeof block === 'object' && typeof block.Text === 'string' && block.Text) texts.push(block.Text)
          else skippedBlocks++ // Mention / Image 等上下文引用与附件不进对话
        }
        const prompt = texts.join('\n')
        // 手工 /compact 会先压一条 **空 content 的 User 消息**：不开轮、也不报错
        if (prompt.trim()) openTurn(prompt)
      } else if (msg.Agent) {
        const step = openStep(null)
        if (!step) continue
        for (const block of Array.isArray(msg.Agent.content) ? msg.Agent.content : []) {
          if (!block || typeof block !== 'object') continue
          if (typeof block.Text === 'string' && block.Text) {
            step.content.push({ type: 'text', text: block.Text })
          } else if (block.Thinking && typeof block.Thinking === 'object' && typeof block.Thinking.text === 'string' && block.Thinking.text) {
            step.content.push({ type: 'reasoning', text: block.Thinking.text })
          } else if (block.ToolUse) {
            const call = v3ToolCall(block.ToolUse)
            if (!call) { skippedBlocks++; continue }
            step.content.push(call)
            step.toolCalls.push(call)
            callSteps.set(call.id, step)
          } else {
            skippedBlocks++ // RedactedThinking / 未知块
          }
        }
        // 同一 Agent 消息上的工具结果（对象：键 = tool_use_id）。查不到调用（转录从中途
        // 开始 / 调用被裁掉）的结果**丢弃并计数**——挂当前步会投影出无 call 的孤儿 tool
        // 消息，被模型 API 拒绝（claude/cline/goose 同款纪律）。
        const results = msg.Agent.tool_results
        if (results && typeof results === 'object') {
          for (const [toolUseId, result] of Object.entries(results)) {
            const { text, images } = v3ResultText(result)
            skippedBlocks += images
            attachResult(callSteps.get(toolUseId) || null, toolUseId, text, result && result.is_error)
          }
        }
      } else if (msg.Compaction) {
        const summary = msg.Compaction.Summary
        if (typeof summary === 'string' && summary.trim()) {
          if (args.fullHistory === true) {
            // fullHistory：不发检查点，摘要按既有形态挂 reasoning 块（全量历史可见）
            const step = cur && cur.steps.length > 0 ? cur.steps[cur.steps.length - 1] : openStep(null)
            if (step) {
              step.content.push({ type: 'reasoning', text: 'Compaction summary:\n\n' + summary.trim() })
              compactionSummaries++
            }
          } else {
            // 原生压缩检查点：压缩点之前的轮整段 log-only，摘要由检查点承载
            shadowedTurns = shadowTurns(turns, shadowedTurns)
            cur = null
            compactionSummaries++
            pendingCompaction = { summary: summary.trim(), provider: 'zed', model: model || undefined }
          }
        } else {
          skippedBlocks++ // ProviderNative 压缩（不透明 items）不读
        }
      }
    }
  } else {
    // legacy 方言：role + segments/tool_uses/tool_results（老库）
    for (const msg of thread.messages) {
      if (!msg || typeof msg !== 'object') continue
      if (msg.is_visible === false) continue // agent-only 消息不进对话
      if (msg.role === 'system') {
        const texts = (Array.isArray(msg.segments) ? msg.segments : [])
          .filter((s) => s && s.type === 'text' && typeof s.text === 'string')
          .map((s) => s.text)
        if (texts.length > 0) systemPrompt = systemPrompt ? systemPrompt + '\n\n' + texts.join('\n') : texts.join('\n')
        continue
      }
      if (msg.role === 'user') {
        const texts = []
        for (const seg of Array.isArray(msg.segments) ? msg.segments : []) {
          if (seg && seg.type === 'text' && typeof seg.text === 'string' && seg.text) texts.push(seg.text)
          else if (seg && (seg.type === 'thinking' || seg.type === 'RedactedThinking')) skippedBlocks++
        }
        const prompt = texts.join('\n')
        if (prompt.trim()) openTurn(prompt)
        for (const result of Array.isArray(msg.tool_results) ? msg.tool_results : []) {
          const id = typeof result?.tool_use_id === 'string' ? result.tool_use_id : null
          if (!id) continue
          attachResult(callSteps.get(id) || null, id, legacyResultText(result), result && result.is_error)
        }
      } else if (msg.role === 'assistant' && cur) {
        const step = openStep(null)
        for (const seg of Array.isArray(msg.segments) ? msg.segments : []) {
          if (!seg || typeof seg !== 'object') continue
          if (seg.type === 'text' && typeof seg.text === 'string' && seg.text) step.content.push({ type: 'text', text: seg.text })
          else if (seg.type === 'thinking' && typeof seg.text === 'string' && seg.text) step.content.push({ type: 'reasoning', text: seg.text })
          else skippedBlocks++ // RedactedThinking 等
        }
        for (const toolUse of Array.isArray(msg.tool_uses) ? msg.tool_uses : []) {
          const call = legacyToolCall(toolUse)
          if (!call) { skippedBlocks++; continue }
          step.content.push(call)
          step.toolCalls.push(call)
          callSteps.set(call.id, step)
        }
        for (const result of Array.isArray(msg.tool_results) ? msg.tool_results : []) {
          const id = typeof result?.tool_use_id === 'string' ? result.tool_use_id : null
          if (!id) continue
          attachResult(callSteps.get(id) || null, id, legacyResultText(result), result && result.is_error)
        }
      }
    }
  }

  // 待落检查点没等到新轮（线程正好停在压缩点）：空 prompt 轮兜住，否则边界无处发射
  if (pendingCompaction) {
    turns.push({ prompt: '', steps: [], compaction: pendingCompaction })
    pendingCompaction = null
  }

  const droppedDuplicateCalls = dropDuplicateCalls(turns)
  alignStepResults(turns)

  const sessionId = args.sessionId || mintSessionId(sourceId || 'zed-' + (thread.id || ''))
  const meta = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    // 时间戳：行级 created_at/updated_at（RFC3339）由读取层经 args 传入；线程内消息没有
    // 任何时间字段，故不存在更细的兜底（绝不伪造逐消息精确时间）
    createdAt: args.createdAt ?? parseTimeMs(thread.updated_at) ?? parseTimeMs(thread.created_at) ?? Date.now(),
  }
  meta.sourceId = sourceId || sessionId
  const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : null
  if (cwd) meta.cwd = cwd

  const explicit = typeof thread.title === 'string' && thread.title.trim()
    ? thread.title.trim()
    : (typeof thread.summary === 'string' && thread.summary.trim() ? thread.summary.trim() : '')
  const finalTitle = normalizeTitle(explicit || (turns.length > 0 ? turns[0].prompt : ''))
  return finishSession(turns, args.budget, {
    meta,
    title: explicit ? finalTitle : undefined,
    provider: 'zed',
    model,
    skipped: 0,
    records: thread.messages.length,
    systemPrompt: args.importSystemPrompt === true && systemPrompt ? systemPrompt : undefined,
  }, { title: finalTitle, droppedToolResults, droppedDuplicateCalls, skippedBlocks, compactionSummaries })
}
