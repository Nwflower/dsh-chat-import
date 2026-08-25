// lib/convert/workbuddy.mjs — WorkBuddy（腾讯 AI 编程应用）会话 JSONL → DSH 会话（纯函数）
//
// WorkBuddy 每个会话一个 transcript（~/.workbuddy/projects/<project-hash>/<session-uuid>.jsonl），
// 逐行事件 JSON：message（user/assistant + content block）、reasoning、function_call、
// function_call_result、file-history-snapshot。本模块把这些事件还原为统一的回合中间结构，
// 再交给 synthesizeSession 合成 DSH 事件日志（seq 连续 / surfaceOp / tool 配对纪律）。
//
// 事件词汇（从真实 transcript 归纳）：
//   message            role user|assistant，content: [{type: input_text|output_text|image_blob_ref, text}]
//                      —— user 消息常被 WorkBuddy 注入 system-reminder / project_context /
//                      connector-status / expert_selection 等系统上下文，人类真实提问包在
//                      <user_query>…</user_query> 里；提取失败时回退剥壳出剩余纯文本。
//   reasoning          rawContent: [{type: reasoning_text, text}]，挂到紧随其后的 assistant 步。
//   function_call      { callId, name, arguments(JSON 字符串), status, providerData.model }
//                      —— 工具调用；status: incomplete / isPartialAborted 表示被打断的草稿。
//   function_call_result { callId, name, status, output:{type,text} | {content} }
//                      —— 结果可能乱序/跨会话片段到达，按 callId 配对，孤儿结果丢弃。
//   file-history-snapshot  运行期元数据，跳过。

import {
  SESSION_FORMAT_VERSION,
  applyBudgetTrim,
  mintSessionId,
  parseJsonlLines,
  parseTime,
  synthesizeSession,
} from './core.mjs'

// REQ-27 标题归一统一规则：去首尾空白、折叠内部空白；超 80 字符截断加省略号。
const TITLE_MAX_LEN = 80
const TITLE_ELLIPSIS = '…'
function normalizeTitle(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return ''
  return t.length <= TITLE_MAX_LEN ? t : t.slice(0, TITLE_MAX_LEN - TITLE_ELLIPSIS.length) + TITLE_ELLIPSIS
}

// 从 WorkBuddy 注入的 user content 里提取人类真实提问。
// 优先取 <user_query>…</user_query> 包住的正文；缺失时剥掉 system-reminder 整块、
// 去 HTML 标签后取剩余纯文本。始终去首尾空白。
export function extractWorkbuddyUserQuery(content) {
  const texts = []
  for (const block of content || []) {
    if (!block || typeof block !== 'object') continue
    if (typeof block.text === 'string') texts.push(block.text)
  }
  const joined = texts.join('\n')
  // 1) 权威：<user_query> 包住的正文（含多行到闭合标签）
  const m = /<user_query>([\s\S]*?)<\/user_query>/.exec(joined)
  if (m && m[1] && m[1].trim()) return m[1].trim()
  // 2) 回退：剥掉 <system-reminder>…</system-reminder> 大块后去标签取纯文本
  const stripped = joined.replace(/<system-reminder[\s\S]*?<\/system-reminder>/gi, '')
  const withoutTags = stripped.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  return withoutTags
}

// WorkBuddy message content block → DSH 文本/推理块。
// output_text / input_text / text 经 text 字段 → { type:'text' }；image_blob_ref 是
// 运行期图片引用（本地路径，导入后无意义），跳过（不虚构文本）。
function mapTextBlock(block) {
  if (!block || typeof block !== 'object') return null
  if ((block.type === 'output_text' || block.type === 'input_text' || block.type === 'text')
    && typeof block.text === 'string' && block.text.length > 0) {
    return { type: 'text', text: block.text }
  }
  return null
}

// WorkBuddy 会话 JSONL → 统一的回合中间结构。
// 事件流水：user 消息开新轮；assistant message / reasoning / function_call 聚成「一步」；
// function_call_result 按 callId 挂回所属步（乱序/跨片段结果：命中 drop 用 status!=completed；
// 孤儿结果无匹配调用且无当前步时丢弃）。回退标题 = 首个真实提问（只回填 title，不钉事件）。
export function convertWorkbuddyJsonl(raw, args = {}) {
  // REQ-26：逐行解析带行号明细 + secrets 位置
  const { recs, skipped, skippedLines, secrets } = parseJsonlLines(raw)

  let sourceId = null
  let cwd = null
  let createdAt = null
  let model = null

  // callId → 它所属的 step（乱序 function_call_result 配对）
  const callSteps = new Map()

  const turns = []
  let cur = null
  let lastStep = null
  // WorkBuddy 的 reasoning 事件在对应 assistant message 之前独立到达：缓存为
  // pendingReasoning，等下一步 assistant/function_call 落定时前插到该步内容头部
  //（只前插一次；新开用户回合 / 无后续步时清空，避免把上次被打断的思考串到下轮）。
  let pendingReasoning = null
  // 丢弃的孤儿 function_call_result 计数（transcript 里没有对应 function_call——
  // 中途开始的转录 / 调用被过滤/打断；挂 lastStep 会投影出无 call 的孤儿 tool 消息，
  // 被模型 API 拒绝，claude 转换器同款纪律）
  let droppedOrphanResults = 0

  // 新开一个用户提问回合。
  const openTurn = (prompt) => {
    cur = { prompt, steps: [] }
    turns.push(cur)
    lastStep = null
    pendingReasoning = null
  }

  // 追加一步 assistant 产物（文本 / 推理 / 工具调用）；没有当前回合时忽略。
  // 带前置推理：新步以 pendingReasoning 起头（reasoning 在 assistant 前到达）。
  const openStep = () => {
    if (!cur) return null
    const step = { content: [], toolCalls: [], toolResults: [] }
    if (pendingReasoning) {
      step.content.push({ type: 'reasoning', text: pendingReasoning })
      pendingReasoning = null
    }
    cur.steps.push(step)
    lastStep = step
    return step
  }

  for (const rec of recs) {
    const env = rec && rec.type
    if (!env) continue
    if (env === 'message') {
      const payload = rec
      if (!sourceId && typeof payload.sessionId === 'string') sourceId = payload.sessionId
      if (!cwd && typeof payload.cwd === 'string') cwd = payload.cwd
      if (createdAt === null) createdAt = parseTime(payload.timestamp)
      if (payload.role === 'user') {
        const prompt = extractWorkbuddyUserQuery(payload.content)
        if (prompt) openTurn(prompt)
      } else if (payload.role === 'assistant') {
        const step = openStep()
        if (step) {
          for (const block of payload.content || []) {
            const b = mapTextBlock(block)
            if (b) step.content.push(b)
          }
        }
      }
      // 其它角色（system/developer 注入）忽略
    } else if (env === 'reasoning') {
      if (createdAt === null) createdAt = parseTime(rec.timestamp)
      const texts = []
      for (const block of rec.rawContent || []) {
        if (block && block.type === 'reasoning_text' && typeof block.text === 'string' && block.text) {
          texts.push(block.text)
        }
      }
      if (texts.length === 0) continue
      pendingReasoning = texts.join('\n')
    } else if (env === 'function_call') {
      if (createdAt === null) createdAt = parseTime(rec.timestamp)
      const payload = rec
      if (!sourceId && typeof payload.sessionId === 'string') sourceId = payload.sessionId
      if (!cwd && typeof payload.cwd === 'string') cwd = payload.cwd
      // 打断/草稿调用（isPartialAborted / incomplete）无结果、不保留
      const pd = payload.providerData
      if (pd && (pd.isPartialAborted || pd.discard)) continue
      // 一条 function_call 可能没有前置 assistant 步：新开一步承载其 tool-call
      const step = lastStep || openStep()
      if (!step) continue
      const callId = payload.callId
      let argumentsText
      if (typeof payload.arguments === 'string') {
        argumentsText = payload.arguments
      } else {
        argumentsText = typeof payload.arguments === 'object' && payload.arguments !== null
          ? JSON.stringify(payload.arguments)
          : JSON.stringify(payload.arguments ?? {})
      }
      const mapped = { id: callId, name: payload.name || 'unknown', arguments: argumentsText }
      // assistant 消息内容必须携带 tool-call block（wire 从 content 派生 tool_calls）
      step.content.push({ type: 'tool-call', ...mapped })
      step.toolCalls.push(mapped)
      if (callId) callSteps.set(callId, step)
    } else if (env === 'function_call_result') {
      if (createdAt === null) createdAt = parseTime(rec.timestamp)
      const payload = rec
      // 非完成的运行期结果（incomplete / error）不落盘
      if (payload.status && payload.status !== 'completed') continue
      // 只按 callId 配对：孤儿结果（无匹配 function_call——转录从中途开始 / 调用被
      // 过滤）一律丢弃并计数，绝不挂 lastStep——挂最近一步会投影出无 call 的孤儿
      // tool 消息，被模型 API 拒绝（claude 转换器同款纪律）
      const step = payload.callId ? callSteps.get(payload.callId) : null
      if (!step) { droppedOrphanResults++; continue }
      const text = workbuddyResultText(payload.output, payload.providerData)
      if (text === null) continue
      step.toolResults.push({
        toolCallId: payload.callId,
        content: [{ type: 'text', text }],
        isError: false,
      })
    }
    // file-history-snapshot 及其余运行期事件忽略
  }

  const sessionId = args.sessionId || mintSessionId(sourceId || args.workbuddyId)
  const src = sourceId || args.workbuddyId || sessionId
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: createdAt ?? Date.now() }
  meta.sourceId = src
  if (cwd) meta.cwd = cwd

  // REQ-27 标题兜底：WorkBuddy 无显式标题源 → 首问兜底（只回填 title，不钉事件）
  const finalTitle = normalizeTitle(turns.length > 0 ? turns[0].prompt : '')
  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, args.budget)
  const syn = synthesizeSession({
    meta,
    turns: seedTurns,
    title: undefined,
    provider: 'workbuddy',
    model,
    skipped,
    records: recs.length,
    skippedLines,
    secrets,
    imported: { sourcePath: args.sourcePath },
  })
  return {
    ...syn,
    title: finalTitle,
    droppedOrphanResults,
    ...(trimmed ? { trimmed } : {}),
  }
}

// WorkBuddy function_call_result → 纯文本结果。
// output 常见形态：{ type:'text', text }；providerData.toolResult 还带 title/content；
// 纯字符串原样；object 取 .text / .content / .output；取不到返回 null（不虚构）。
function workbuddyResultText(output, providerData) {
  const pdTool = providerData && providerData.toolResult
  const candidates = [output, pdTool]
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c
    if (c && typeof c === 'object') {
      if (typeof c.text === 'string' && c.text) return c.text
      if (typeof c.content === 'string' && c.content) return c.content
      if (typeof c.output === 'string' && c.output) return c.output
    }
  }
  if (typeof output === 'string' && output) return output
  return null
}
