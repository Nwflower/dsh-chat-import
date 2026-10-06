// lib/convert/cline.mjs — Cline（现代 SDK 与 VS Code legacy）会话 → DSH 会话（纯函数）
//
// 存储（cline/cline 4.1.18 的文件式存储，main @ 6e8bea1）：<sessionsDir>/<sessionId>/ 里
// 恰好三类文件，恒以 <sessionId> 为前缀 ——
//   <sessionId>.json            session manifest（权威元数据：metadata.title / cwd /
//                               workspace_root / started_at / model / provider）
//   <sessionId>.messages.json   完整消息数组 + system_prompt（**消息只在这里**）
//   <sessionId>.compaction.json 压缩侧车（可选，仅压缩后存在）——Cline 的
//                               SessionCompactionState（version:1、source_message_count、
//                               messages:[摘要消息, ...保留尾巴]）。lib/sources/cline.mjs
//                               读出 { summary, sourceMessageCount } 经 args.compaction 传入：
//                               默认发 DSH 原生压缩检查点（前 N 条 canonical 消息 log-only、
//                               摘要进检查点），messages.json 的全量历史照常留在日志里。
// Classic VS Code extension data lives in globalStorage/<extension>/tasks/<id>/:
//   state/taskHistory.json (index), tasks/<id>/api_conversation_history.json (messages),
//   tasks/<id>/ui_messages.json (display-only title fallback).
// 路径优先级：sessionsDir = $CLINE_SESSION_DATA_DIR → <dataDir>/sessions；
// dataDir = $CLINE_DATA_DIR → <clineDir>/data；clineDir = $CLINE_DIR → ~/.cline。
// 子代理/团队任务**不建自己的目录**：它们的消息写成 <rootSessionId>/<agentId>.messages.json
// （团队任务 <agentId>__<teamTaskId>.messages.json），靠文件内 agent 字段区分。
// 同级的 db/sessions.db 是 SQLite 元数据索引（不存消息，只有 messages_path 指向本文件），
// 由 lib/sources/cline.mjs 读取并经 args 把 cwd/createdAt/title 传进来——本模块只管转写。
//
// messages.json 的 v1 契约（上游 sdk/packages/core/docs/messages-contract-v1.md；顶层
// version 声明版本、增量字段允许不升版 → 容忍未知键）：
//   { version: 1, updated_at, agent: 'lead'|'subagent'|'teammate', sessionId, taskType?,
//     origin?, messages: Message[], system_prompt? }
//   Message{ id?, role: 'user'|'assistant', content: Block[] | string, ts?, modelInfo?,
//            metrics?, metadata?, agent? }
//   Block（Anthropic 原生形状，不是 gateway 的 kebab-case）：
//     text{text} / thinking{thinking,signature?} / redacted_thinking{data}(密文，丢弃) /
//     tool_use{id,name,input:对象} / tool_result{tool_use_id,content:string|块[],is_error?} /
//     image|file|media（附件，丢弃：源能力矩阵里 attachments=false）
//
// 三处关键语义：
//   1. **没有独立的 tool/system 角色**：工具结果是挂在 **user 消息**上的 `tool_result`
//      块（Anthropic 原生），所以 user 消息要区分「人类提问」与「结果载体」——只有不带
//      tool_result 块的 user 消息才开新轮（claude.mjs 同款判定，同为该形状）。
//   2. `content` 契约上恒为数组，但类型定义允许字符串（`string | ContentBlock[]`）→ 两种
//      都容忍；`tool_result.content` 更是明确允许字符串，漏掉会把整段工具输出丢成空结果。
//   3. 一轮里可能有**多条 assistant 消息**（上游文档：transient failure + retry 后前一条
//      仍保留其 modelInfo/metrics，只有末条带该轮 metrics）→ 一条 assistant = 一步，
//      不做「失败重发 step」折叠；但同一 tool_use.id 重复出现仍要防（DSH 折叠器对同一
//      callId 只允许一次 start，第二次会硬异常并吞掉其后整段轨迹）。
//
// 子代理/团队会话（agent != 'lead'）默认不单独成会话，与 reasonix 子代理、kilocode
// 子会话的既有语义一致。

import {
  SESSION_FORMAT_VERSION,
  finishSession,
  mapContentBlock,
  mintSessionId,
  parseTimeMs,
} from './core.mjs'
import { contentText, normalizeTitle, skipResult } from './util.mjs'
import { alignStepResults, createTurns, dropDuplicateCalls } from './ir.mjs'

// The pre-SDK VS Code extension stored task data outside the shared SDK
// directory. These helpers are shared by discovery and import so both paths
// use the same legacy layout.
export function clineLegacyTaskHistoryPath(globalStorageDir) {
  const sep = String(globalStorageDir).includes('\\') ? '\\' : '/'
  return String(globalStorageDir).replace(/[\\/]+$/, '') + sep + 'state' + sep + 'taskHistory.json'
}

export function clineLegacyApiHistoryPath(globalStorageDir, id) {
  const sep = String(globalStorageDir).includes('\\') ? '\\' : '/'
  const base = String(globalStorageDir).replace(/[\\/]+$/, '')
  return base + sep + 'tasks' + sep + id + sep + 'api_conversation_history.json'
}

export function clineLegacyUiMessagesPath(globalStorageDir, id) {
  const sep = String(globalStorageDir).includes('\\') ? '\\' : '/'
  const base = String(globalStorageDir).replace(/[\\/]+$/, '')
  return base + sep + 'tasks' + sep + id + sep + 'ui_messages.json'
}

// 旧版任务转写路径 <globalStorage>/tasks/<id>/api_conversation_history.json 的解析（导入侧
// lib/sources/cline.mjs 与发现层 lib/discovery/cline.mjs 共用）：任务 id / globalStorage 根；
// 不是该形态返回 null。两种分隔符都认，文件名与 tasks 段不区分大小写。
export function clineLegacyTaskIdFromPath(path) {
  const value = String(path).replace(/[\\/]+$/, '')
  const parts = value.split(/[\\/]/)
  if (parts.length < 2 || parts[parts.length - 1].toLowerCase() !== 'api_conversation_history.json') return null
  const taskId = parts[parts.length - 2]
  const tasksIndex = parts.length - 3
  return parts[tasksIndex] && parts[tasksIndex].toLowerCase() === 'tasks' && taskId ? taskId : null
}

export function clineLegacyRootFromApiPath(path) {
  const value = String(path)
  const marker = value.match(/[\\/]tasks[\\/][^\\/]+[\\/]api_conversation_history\.json$/i)
  if (!marker) return null
  return value.slice(0, marker.index)
}

export function parseClineLegacyTaskHistory(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value)
      ? value.filter((item) => item && typeof item === 'object' && typeof item.id === 'string' && item.id)
      : []
  } catch {
    return []
  }
}

// 会话目录下的规范转写路径：<sessionsDir>/<id>/<id>.messages.json。发现层与
// lib/sources/cline.mjs（DB 的 messages_path 缺失时）共用同一口径。
export function clineMessagesPath(sessionsDir, id) {
  const sep = String(sessionsDir).includes('\\') ? '\\' : '/'
  const base = String(sessionsDir).replace(/[\\/]+$/, '')
  return base + sep + id + sep + id + '.messages.json'
}

// session manifest（<id>.json）→ { title, cwd, startedAt }；解析失败返回 null（调用方回退
// DB 字段）。manifest 的 metadata.title 是上游 listSessions 认可的**权威标题**（覆盖 DB
// 行），但本插件在发现层只把 DB 的 metadata_json.title 当快路径、为空时才读 manifest——
// 少读一个文件是常态路径，两者不一致时以 manifest 为准（与上游同序）。
export function readClineManifest(raw) {
  if (typeof raw !== 'string' || !raw) return null
  let doc
  try {
    doc = JSON.parse(raw)
  } catch {
    return null
  }
  if (!doc || typeof doc !== 'object') return null
  const meta = doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : null
  const title = meta && typeof meta.title === 'string' ? meta.title : ''
  const cwd = typeof doc.cwd === 'string' && doc.cwd
    ? doc.cwd
    : (typeof doc.workspace_root === 'string' && doc.workspace_root ? doc.workspace_root : null)
  const startedAt = typeof doc.started_at === 'string' && doc.started_at ? doc.started_at : null
  return { title, cwd, startedAt }
}


// content 是 ContentBlock[]（契约明示「恒为数组」），但类型定义允许字符串形态
// （`content: string | ContentBlock[]`）→ 两种都容忍：字符串按纯文本块处理。
function contentBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return Array.isArray(content) ? content : []
}

// tool_result 的 content 是 `string | (text|image|file)[]`：字符串形态要包成文本块，
// 否则整段工具输出会被静默丢掉（只取数组分支会得到空结果）。
function toolResultBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  return content.map(mapContentBlock).filter(Boolean)
}

// Classic Cline persisted the full API history and recorded the range omitted
// from the model context in taskHistory.json. Reapply that omission when
// importing so a resumed session does not regain an oversized context. The
// first user/assistant pair is retained, matching Cline's migration logic.
function applyLegacyDeletedRange(messages, range) {
  const end = Array.isArray(range) ? range[1] : undefined
  if (!Number.isInteger(end) || end < 2 || end >= messages.length - 1) return messages
  const truncated = [...messages.slice(0, 2), ...messages.slice(end + 1)]
  const firstAfterCut = truncated[2]
  if (firstAfterCut && typeof firstAfterCut === 'object'
    && firstAfterCut.role === 'user' && Array.isArray(firstAfterCut.content)) {
    const content = firstAfterCut.content.filter((block) => !(block && block.type === 'tool_result'))
    if (content.length !== firstAfterCut.content.length) truncated[2] = { ...firstAfterCut, content }
  }
  return truncated
}

// Cline messages.json → 统一的回合中间结构（turns/steps，见 core.mjs synthesizeSession）。
export function convertClineJson(raw, args = {}) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return skipResult('not a Cline session (invalid JSON)', { skipped: 1 })
  }
  const legacy = args.legacyTask === true && Array.isArray(parsed)
  const session = legacy
    ? {
        version: 0,
        agent: 'lead',
        sessionId: args.clineId || args.sessionId,
        messages: applyLegacyDeletedRange(parsed, args.legacyDeletedRange),
      }
    : parsed
  if (!session || typeof session !== 'object' || !Array.isArray(session.messages)) {
    return skipResult('not a Cline session (no messages array)', { skipped: 1 })
  }

  const sourceId = typeof session.sessionId === 'string' && session.sessionId ? session.sessionId : null
  // 子代理 / 团队任务会话（agent 字段非 'lead'）不单独成会话：它们是主会话的旁支，
  // 与 reasonix 子代理、kilocode 子会话的既有语义一致
  if (typeof session.agent === 'string' && session.agent && session.agent !== 'lead') {
    return skipResult('Cline ' + session.agent + ' session (' + (sourceId || 'unknown') + '); only the lead session becomes a session', {
      skipped: 1, records: session.messages.length,
    })
  }

  const messages = session.messages
  const turnQueue = createTurns()
  const turns = turnQueue.turns
  let cur = null
  let model = null
  // 首条消息时间戳（契约里 ts 只在 assistant 消息上，用户消息没有）→ 创建时间兜底
  let firstTs = null
  // callId → 所属 step（tool_result 块后置到达，必须按 id 挂回 call 所在步）
  const callSteps = new Map()
  let droppedToolResults = 0
  // 压缩侧车（<id>.compaction.json，见文件头存储说明）经 args.compaction 传入：
  //   { summary, sourceMessageCount } —— Cline 的 SessionCompactionState 说 source_message_count
  //   条 canonical 消息被折叠进摘要，messages.json 仍保全量。默认据此发 DSH 原生压缩检查点
  //（前 N 条 canonical 消息 log-only、摘要进检查点），模型视角 = 摘要 + 保留窗口 = 源的投影。
  const compaction = args.compaction && typeof args.compaction === 'object'
    && typeof args.compaction.summary === 'string' && args.compaction.summary.trim()
    && Number.isInteger(args.compaction.sourceMessageCount) && args.compaction.sourceMessageCount >= 0
    && args.fullHistory !== true
    ? args.compaction
    : null
  let canonicalIdx = 0
  // canonical 消息计数口径必须与上游 canonicalSourceMessages 一致：displayOnly 消息不计数
  const isDisplayOnly = (m) => !!(m && m.metadata && m.metadata.displayOnly === true)

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    // 逐消息时间：契约里 ts 只在 assistant 消息上（user 消息没有）→ 只透传 step.time；
    // 轮与工具结果不造时间（step.start 落在上一个已知时间，模型耗时仍真实）。ts 与
    // updated_at 都可能缺失，缺失就是 null，绝不拿导入时刻冒充创建时间。
    const msgTime = parseTimeMs(msg.ts)
    if (firstTs === null) firstTs = msgTime
    if (!model && msg.modelInfo && typeof msg.modelInfo === 'object'
      && typeof msg.modelInfo.id === 'string' && msg.modelInfo.id) {
      model = msg.modelInfo.id
    }
    // 压缩边界：第 sourceMessageCount 条 canonical 消息处（其前的消息都被摘要覆盖）
    if (compaction && !isDisplayOnly(msg)) {
      if (canonicalIdx === compaction.sourceMessageCount) {
        turnQueue.shadowAll()
        cur = null
        turnQueue.setCompaction({ summary: compaction.summary.trim(), provider: 'cline', model: model || undefined })
      }
      canonicalIdx += 1
    }
    const blocks = contentBlocks(msg.content)
    if (msg.role === 'user') {
      const hasToolResult = blocks.some((b) => b && b.type === 'tool_result')
      if (hasToolResult) {
        // 结果载体：按 tool_use_id 挂到调用所属步；孤儿结果（转录从中途开始）丢弃并
        // 计数——挂最近一步会投影出无 call 的孤儿 tool 消息，被模型 API 拒绝
        for (const block of blocks) {
          if (!block || block.type !== 'tool_result') continue
          const step = callSteps.get(block.tool_use_id)
          if (!step) { droppedToolResults++; continue }
          step.toolResults.push({
            toolCallId: block.tool_use_id,
            content: toolResultBlocks(block.content),
            isError: block.is_error === true,
          })
        }
      } else {
        const prompt = contentText(blocks)
        // 空文本的 user 消息（纯非文本块）不开新轮：不虚构提问
        if (prompt.trim()) {
          cur = turnQueue.open(prompt)
        }
      }
    } else if (msg.role === 'assistant') {
      // 保留窗口从 assistant 消息起头（边界落在轮中间）：空 prompt 轮承载检查点后的产物
      if (!cur && turnQueue.hasCompaction()) {
        cur = turnQueue.flush()
      }
      if (!cur) continue
      // 一条 assistant 消息 = 一步
      const step = { content: [], toolCalls: [], toolResults: [] }
      if (msgTime !== null) step.time = msgTime
      for (const block of blocks) {
        const mapped = mapContentBlock(block)
        if (!mapped) continue
        step.content.push(mapped)
        if (mapped.type === 'tool-call') step.toolCalls.push(mapped)
      }
      cur.steps.push(step)
      for (const tc of step.toolCalls) callSteps.set(tc.id, step)
    }
    // 其它角色（未知形态）忽略
  }

  // 待落检查点没等到新轮（压缩点在转录末尾）：空 prompt 轮兜住，否则边界无处发射
  turnQueue.flush()

  const droppedDuplicateCalls = dropDuplicateCalls(turns)
  alignStepResults(turns)

  const sessionId = args.sessionId || mintSessionId(sourceId || args.clineId)
  const src = sourceId || args.clineId || sessionId
  const meta = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    // 创建时间只存在于 DB 索引（messages.json 里只有 updated_at 与 assistant 的 ts）：
    // args.createdAt 优先，其次首条消息 ts，再次 updated_at，最后导入时刻
    createdAt: args.createdAt ?? firstTs ?? parseTimeMs(session.updated_at) ?? Date.now(),
  }
  meta.sourceId = src
  const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : null
  if (cwd) meta.cwd = cwd

  // 标题兜底：messages.json 无标题字段（标题在 DB 索引里，由 args.title 带入）
  const explicitTitle = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : ''
  const finalTitle = normalizeTitle(explicitTitle || (turns.length > 0 ? turns[0].prompt : ''))
  // 系统提示词只在「导入系统提示词」开关开启时收集（与 zcode/grokbuild/hermes 同款）
  const systemPrompt = args.importSystemPrompt === true
    && typeof session.system_prompt === 'string' && session.system_prompt.trim()
    ? session.system_prompt
    : undefined
  return finishSession(turns, args.budget, {
    meta,
    title: explicitTitle ? finalTitle : undefined,
    provider: 'cline',
    model: model || (typeof args.modelId === 'string' && args.modelId ? args.modelId : null),
    skipped: 0,
    records: messages.length,
    systemPrompt,
  }, { title: finalTitle, droppedToolResults, droppedDuplicateCalls })
}
