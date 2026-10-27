// lib/convert/copilot-cli.mjs — Copilot CLI session-state events.jsonl → DSH 会话（纯函数）
//
// Contract: GitHub Copilot CLI writes one append-only event stream per session at
// `~/.copilot/session-state/<session-uuid>/events.jsonl` (root migrates with
// COPILOT_HOME). Each line is `{ id, parentId, timestamp, type, data }` with an
// ISO-8601 UTC timestamp; `session.start` is the first line and carries
// `sessionId`/`selectedModel`/`context{cwd, gitRoot, branch, …}`. The format has
// no upstream stability contract (github/copilot-cli#3551), so unknown event
// types are counted and skipped, never fatal. `/rewind` truncates the file, so
// file order is the linear projection; `parentId` is replay bookkeeping (some
// internal `model.*` events carry dangling parents) and is not used for ordering.
// Prompts keep `data.content` (typed text); replies join reasoning with the
// message body; `assistant.message.toolRequests[]` declares calls that
// `tool.execution_start`/`tool.execution_complete` pair up by `toolCallId`.
// `session.compaction_complete.summaryContent` becomes a native DSH compaction
// checkpoint (turns before the boundary are log-only); `fullHistory: true`
// keeps the full surface and skips the checkpoint. Titles have no explicit
// source → first user prompt (same fallback as codex); the cross-session index
// DBs are not consulted. hook/permission/model/subagent/skill/session
// bookkeeping events and `system.message` are harness metadata: counted
// (metaMessages) and dropped.
import {
  SESSION_FORMAT_VERSION,
  finishSession,
  mintSessionId,
  parseJsonlLines,
  parseTime,
  parseTimeMs,
} from './core.mjs'
import { contentText, normalizeTitle, skipResult } from './util.mjs'
import { createTurns, dropDuplicateCalls, shadowTurns } from './ir.mjs'

// 已知「仅记账」事件：不进对话、计数后丢弃。前缀族（hook./permission./model./
// subagent./skill.）单独列出——官方 schema 未冻结，新成员按族吸收。
const META_EVENT_TYPES = new Set([
  'system.message', 'assistant.turn_start', 'assistant.turn_end',
  'session.task_complete', 'session.plan_changed', 'session.mode_changed',
  'session.resume', 'session.error', 'session.info', 'session.usage_record',
  'session.usage_checkpoint', 'session.context_changed', 'session.compaction_start',
  'session.shutdown',
])
const META_EVENT_PREFIXES = ['hook.', 'permission.', 'model.', 'subagent.', 'skill.']

// 会话元数据（发现层与转换层共用同一份提取口径）：session.start 给 id / cwd / 时间 /
// 模型；标题取头部窗口里的首条人类提问（不归一，调用方按用途处理）。无 session.start
// 返回 null——不是 Copilot CLI 事件流。
export function copilotCliHeadMeta(recs) {
  const start = recs.find((r) => r && r.type === 'session.start' && r.data && typeof r.data === 'object')
  if (!start) return null
  const data = start.data
  const context = data.context && typeof data.context === 'object' ? data.context : {}
  let title = null
  for (const rec of recs) {
    if (!rec || rec.type !== 'user.message' || !rec.data || typeof rec.data !== 'object') continue
    const text = typeof rec.data.content === 'string' ? rec.data.content.trim() : ''
    if (text) { title = text; break }
  }
  return {
    id: typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : null,
    cwd: typeof context.cwd === 'string' && context.cwd ? context.cwd : null,
    createdAt: parseTimeMs(start.timestamp) ?? parseTimeMs(data.startTime),
    model: typeof data.selectedModel === 'string' && data.selectedModel ? data.selectedModel : null,
    title,
  }
}

// 消息正文：content 字符串原样；块数组按 contentText 取文本（宽容未知形态）。两者皆空
// 返回 ''（调用方按空内容处理）。
function messageBody(content) {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  return contentText(content, { types: null, skipEmpty: true })
}

// 工具参数：对象 → 标准 JSON 文本；字符串原样（已序列化）；其余形态保底 '{}'。
function toolArguments(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return '{}'
  try { return JSON.stringify(value) } catch { return '{}' }
}

// 工具结果正文：result.content 字符串 → 单文本块；块数组逐块取 text（未知块计数）；
// content 缺失时回退 detailedContent 字符串。返回 { content, malformed }。
function toolResultContent(result, counts) {
  if (!result || typeof result !== 'object') return { content: [], malformed: 0 }
  const raw = result.content !== undefined ? result.content : result.detailedContent
  if (typeof raw === 'string') return { content: raw ? [{ type: 'text', text: raw }] : [], malformed: 0 }
  if (Array.isArray(raw)) {
    const content = []
    let malformed = 0
    for (const block of raw) {
      if (block && typeof block === 'object' && typeof block.text === 'string') {
        if (block.text) content.push({ type: 'text', text: block.text })
      } else {
        malformed++
      }
    }
    return { content, malformed }
  }
  if (raw === null || raw === undefined) return { content: [], malformed: 0 }
  counts.droppedMalformedOutputs++
  return { content: [], malformed: 0 }
}

// 推理正文：reasoningText（扁平文本）优先——它与 reasoningBlocks 是同一内容的两种承载，
// 两者并存时只取文本，避免重复导入；缺失时块数组逐块取 text 拼接（未知块计数）。
function reasoningTextOf(data, counts) {
  if (typeof data.reasoningText === 'string' && data.reasoningText.trim()) return data.reasoningText
  if (!Array.isArray(data.reasoningBlocks)) {
    if (data.reasoningBlocks !== null && data.reasoningBlocks !== undefined) counts.droppedMalformedOutputs++
    return ''
  }
  const parts = []
  for (const block of data.reasoningBlocks) {
    if (block && typeof block === 'object' && typeof block.text === 'string' && block.text) {
      parts.push(block.text)
    } else if (block) {
      counts.droppedMalformedOutputs++
    }
  }
  return parts.join('\n')
}

export function convertCopilotCliJsonl(raw, args = {}) {
  const { recs, skipped, skippedLines, secrets } = parseJsonlLines(raw, { requireObject: true })
  const counts = {
    metaMessages: 0, unknownEvents: 0, droppedAttachments: 0,
    droppedMalformedOutputs: 0, missingToolOutputs: 0,
    unannouncedToolCalls: 0, orphanResults: 0,
  }
  let sourceId = null
  let cwd = null
  let createdAt = null
  let model = null
  // 步骤开启时刻生效的模型：session.model_change 逐步覆盖，旧步骤保留旧模型
  let currentModel = null
  // 标题话题：全量记录里的第一条人类提问（压缩只影响正文投影，不影响标题）
  let titleTopic = null
  // toolCallId → 所属 step（assistant.toolRequests 声明与 execution_* 事件跨行配对）
  const callSteps = new Map()

  const turnQueue = createTurns()
  const turns = turnQueue.turns
  // 已标 log-only 的轮数（多次压缩只走新增的轮）
  let shadowedTurns = 0
  let cur = null
  let lastStep = null

  const openTurn = (prompt, time) => {
    cur = turnQueue.open(prompt, time)
    lastStep = null
  }

  const openStep = (time) => {
    const step = { content: [], toolCalls: [], toolResults: [] }
    if (time !== null && time !== undefined) step.time = time
    if (currentModel) step.model = currentModel
    cur.steps.push(step)
    lastStep = step
    return step
  }

  // 压缩边界：此前轮全部 log-only，摘要落检查点（fullHistory 时不走这里）。
  const markCompaction = (text, time) => {
    shadowedTurns = shadowTurns(turns, shadowedTurns)
    cur = null
    lastStep = null
    turnQueue.setCompaction({
      summary: text, provider: 'copilot-cli', model: model || undefined,
      ...(time !== null && time !== undefined ? { time } : {}),
    })
  }

  for (const rec of recs) {
    const type = rec && typeof rec.type === 'string' ? rec.type : null
    const data = rec && rec.data && typeof rec.data === 'object' ? rec.data : null
    const recTime = parseTimeMs(rec && rec.timestamp)
    if (!type) { counts.unknownEvents++; continue }

    if (type === 'session.start') {
      if (data) {
        if (!sourceId && typeof data.sessionId === 'string' && data.sessionId) sourceId = data.sessionId
        if (!cwd && typeof data.context?.cwd === 'string' && data.context.cwd) cwd = data.context.cwd
        if (createdAt === null) createdAt = parseTime(rec.timestamp ?? data.startTime)
        if (!model && typeof data.selectedModel === 'string' && data.selectedModel) model = data.selectedModel
      }
      counts.metaMessages++
      continue
    }
    if (type === 'session.model_change') {
      if (data && typeof data.newModel === 'string' && data.newModel) {
        if (!model) model = data.newModel
        currentModel = data.newModel
      }
      counts.metaMessages++
      continue
    }
    // 压缩边界（#87 契约：session.compaction_* → 压缩检查点）。complete 才有摘要正文；
    // 只有 start 或没有可读摘要时不做标记（与 codex 同口径），fullHistory 保留全量。
    if (type === 'session.compaction_complete') {
      const text = args.fullHistory === true || !data || typeof data.summaryContent !== 'string'
        ? ''
        : data.summaryContent.trim()
      if (text) markCompaction(text, recTime)
      else counts.metaMessages++
      continue
    }
    if (type === 'user.message') {
      const prompt = data ? messageBody(data.content) : ''
      if (Array.isArray(data?.attachments) && data.attachments.length) counts.droppedAttachments++
      if (!prompt.trim()) { counts.metaMessages++; continue }
      if (titleTopic === null) titleTopic = prompt
      openTurn(prompt, recTime)
      continue
    }
    if (type === 'assistant.message') {
      if (!cur) {
        // 无当前回合：压缩点之后以回复起头时用空 prompt 轮承载（检查点本身就是这一轮
        // 的 user 侧消息），其余丢弃并计数。
        if (!turnQueue.hasCompaction()) { counts.metaMessages++; continue }
        openTurn('', recTime)
      }
      const step = openStep(recTime)
      const reasoning = data ? reasoningTextOf(data, counts) : ''
      if (reasoning) step.content.push({ type: 'reasoning', text: reasoning })
      const body = data ? messageBody(data.content) : ''
      if (body) step.content.push({ type: 'text', text: body })
      const requests = data && Array.isArray(data.toolRequests) ? data.toolRequests : []
      for (const request of requests) {
        if (!request || typeof request !== 'object') { counts.droppedMalformedOutputs++; continue }
        const id = typeof request.toolCallId === 'string' ? request.toolCallId : ''
        if (!id) { counts.droppedMalformedOutputs++; continue }
        const mapped = {
          id,
          name: typeof request.name === 'string' && request.name ? request.name : 'unknown',
          arguments: toolArguments(request.arguments),
        }
        step.content.push({ type: 'tool-call', ...mapped })
        step.toolCalls.push(mapped)
        callSteps.set(id, step)
      }
      // 纯信令消息（无正文/推理/调用）不留空步；lastStep 同步失效，否则后续按执行事件
      // 补出的 tool-call 会写进已经弹出、不再属于任何回合的 step（整段执行轨迹静默丢失）
      if (!step.content.length) {
        cur.steps.pop()
        if (lastStep === step) lastStep = null
      }
      continue
    }
    if (type === 'tool.execution_start') {
      if (!data || typeof data.toolCallId !== 'string' || !data.toolCallId) { counts.droppedMalformedOutputs++; continue }
      if (callSteps.has(data.toolCallId)) { counts.metaMessages++; continue }
      // 没有对应的 assistant.toolRequests 声明（流不完整 / schema 漂移）：按执行事件
      // 本身合成调用——宁可多一条可见调用，也不静默丢执行轨迹。
      if (!cur) {
        if (turnQueue.hasCompaction()) openTurn('', recTime)
        else { counts.orphanResults++; continue }
      }
      counts.unannouncedToolCalls++
      const step = lastStep || openStep(recTime)
      const mapped = {
        id: data.toolCallId,
        name: typeof data.toolName === 'string' && data.toolName ? data.toolName : 'unknown',
        arguments: toolArguments(data.arguments),
      }
      step.content.push({ type: 'tool-call', ...mapped })
      step.toolCalls.push(mapped)
      callSteps.set(data.toolCallId, step)
      continue
    }
    if (type === 'tool.execution_complete') {
      if (!data || typeof data.toolCallId !== 'string' || !data.toolCallId) { counts.droppedMalformedOutputs++; continue }
      let step = callSteps.get(data.toolCallId)
      if (!step) {
        // 结果先于可配对的调用（分页/截断流）：归位到最近一步并计数，与 codex 同口径
        if (!cur) { counts.orphanResults++; continue }
        counts.orphanResults++
        step = lastStep || openStep(recTime)
      }
      const { content, malformed } = toolResultContent(data.result, counts)
      counts.droppedMalformedOutputs += malformed
      if (!content.length) {
        // 失败执行没有可读结果时，error.message 是仅存的忠实内容：照实导入为正文
        const errorText = data.error && typeof data.error === 'object'
          && typeof data.error.message === 'string' ? data.error.message.trim() : ''
        if (errorText) content.push({ type: 'text', text: errorText })
      }
      if (!content.length) counts.missingToolOutputs++
      step.toolResults.push({
        toolCallId: data.toolCallId,
        ...(recTime !== null ? { time: recTime } : {}),
        content,
        isError: data.success === false || !!(data.error && typeof data.error === 'object'),
      })
      continue
    }
    if (type === 'abort') {
      if (cur) cur.aborted = true
      counts.metaMessages++
      continue
    }
    // system.message（系统提示词）与其余 session.* 事务事件都是 harness 元数据；
    // hook./permission./model./subagent./skill. 是已知的事件族前缀。这之外的名字
    // 计入 unknownEvents（格式无上游稳定承诺，schema 漂移要可诊断）。
    if (META_EVENT_TYPES.has(type) || META_EVENT_PREFIXES.some((p) => type.startsWith(p))) {
      counts.metaMessages++
    } else {
      counts.unknownEvents++
    }
  }

  // 待落检查点停在会话末尾时用空 prompt 轮兜住（否则「有边界无检查点」）。
  turnQueue.flush()

  if (!turns.length) {
    return skipResult('Copilot session has no conversation', {
      records: recs.length, skipped, skippedLines, secrets,
    })
  }
  // session.start 是第一行、也是「这是 Copilot CLI 事件流」的唯一签名；缺了它就不能认领
  // 任意带 user.message / assistant.message 的 JSONL（与 copilotCliHeadMeta 的判定同口径，
  // 否则 local-jsonl 会按内容把外来文件误判成 copilot-cli）。
  if (!recs.some((r) => r && r.type === 'session.start')) {
    return skipResult('Not a Copilot CLI event stream (no session.start)', {
      records: recs.length, skipped, skippedLines, secrets,
    })
  }
  counts.metaMessages += dropDuplicateCalls(turns)
  // session.start.sessionId 缺失（畸形流）时用首行信封 id 兜底：同为每流唯一且稳定
  if (!sourceId && recs.length && typeof recs[0].id === 'string' && recs[0].id) sourceId = recs[0].id
  const meta = {
    version: SESSION_FORMAT_VERSION,
    id: args.sessionId || mintSessionId(sourceId),
    createdAt: args.createdAt ?? createdAt ?? Date.now(),
  }
  if (sourceId) meta.sourceId = sourceId
  if (cwd || args.cwd) meta.cwd = cwd || args.cwd
  const finalTitle = normalizeTitle(titleTopic || (turns.length > 0 ? turns[0].prompt : ''))
  return finishSession(turns, args.budget, {
    meta, provider: 'copilot-cli', model, skipped, records: recs.length, skippedLines, secrets,
  }, {
    title: finalTitle,
    ...counts,
  })
}
