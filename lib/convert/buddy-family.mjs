// lib/convert/buddy-family.mjs — 腾讯 buddy 家族（CodeBuddy Code / WorkBuddy）会话 JSONL 的
// 共用转换引擎（纯函数）。
//
// 背景（docs/architecture.md D21：同口径逻辑只留一份）：CodeBuddy Code CLI 与 WorkBuddy
// Desktop 写的是同一套事件词汇——`message`（user/assistant + 文本块）、`reasoning`、
// `function_call`、`function_call_result`、`file-history-snapshot`，都带
// `sessionId / parentId / timestamp / cwd` 扩展字段，工具结果都按 callId 配对回声明该
// 调用的步。两者只在三处不同：目录布局、user 提问的包壳、以及各家私有的 custom 条目。
// 因此这里放共用的状态机与配对纪律，差异由 profile（见文件尾 PROFILE 契约）描述。
//
// 布局差异（profile.layout 负责，本模块不碰路径）：
//   CodeBuddy Code  ~/.codebuddy/projects/<projectKey>/<sessionId>.jsonl（+ .meta.json）
//   WorkBuddy       ~/.workbuddy/projects/<project-hash>/<session-uuid>.jsonl
//
// 事件词汇（从 CodeBuddy Code v2.179.3 的条目类型与 WorkBuddy 真实 transcript 归纳）：
//   message               role user|assistant；content 是字符串或块数组
//                         （input_text / output_text / input_image …）。user 消息常被注入
//                         系统上下文，真人提问的提取口径由 profile 决定。
//   reasoning             推理正文，独立于 assistant message 到达；挂到紧随其后的步。
//   function_call         { callId, name, arguments（JSON 字符串或对象）, status,
//                           providerData:{ model, usage, rawUsage, isPartialAborted } }
//   function_call_result  { callId, name, status, output }；结果可能乱序/跨步到达。
//   file-history-snapshot 运行期元数据，跳过。
//   custom 条目           各家的标题 / 主题 / 压缩摘要 / 计量快照等（见 profile.itemKinds），
//                         一律不产对话内容；其中可作标题的由 profile.titleOf 决定。
//
// 配对与丢弃纪律（与 claude / codearts 同口径，失败要大声）：
//   * function_call_result 只按 callId 配到声明该调用的步；孤儿结果丢弃并计数
//     （droppedOrphanResults）——挂「最近一步」会投影出无 call 的孤儿 tool 消息，
//     被模型 API 拒绝。
//   * 被打断/丢弃的草稿调用（providerData.isPartialAborted / discard）不落盘。
//   * 同一 callId 重复出现由 ir.mjs 的 dropDuplicateCalls 收口（DSH 折叠器对第二次
//     同 id start 会硬异常并吞掉整段轨迹）。
import {
  SESSION_FORMAT_VERSION,
  finishSession,
  mintSessionId,
  parseJsonlLines,
  parseTime,
  parseTimeMs,
} from './core.mjs'
import { normalizeTitle } from './util.mjs'
import { createTurns, dropDeadRetrySteps } from './ir.mjs'

/**
 * 把一条 buddy 事件规整成「内容块数组」。content 可能是：
 *   * 数组                       —— 原样（块形状由调用方解释）
 *   * 字符串                     —— 包成单个文本块（CodeBuddy 的 OpenAI Agents SDK 形态）
 *   * 缺省 / null / 其它         —— 空数组
 * @param {(block: object) => object|null} mapBlock 块 → DSH 内容块，返回 null 表示跳过
 */
function blocksOf(content, mapBlock) {
  const list = Array.isArray(content) ? content : (typeof content === 'string' ? [{ type: 'text', text: content }] : [])
  const out = []
  for (const b of list) {
    const mapped = mapBlock(b)
    if (mapped) out.push(mapped)
  }
  return out
}

/** function_call 的 arguments → JSON 字符串。源侧可能是字符串或对象。 */
function argumentsText(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return '{}'
  try {
    return JSON.stringify(value)
  } catch {
    // 循环引用等不可序列化的载荷：退化成空对象，不让整份会话失败
    return '{}'
  }
}

/**
 * 转换一份 buddy 家族会话。
 *
 * @param {string} raw 会话 JSONL 文本
 * @param {object} args 导入选项（args.budget / args.sessionId / 各源的 id 参数）
 * @param {object} profile 来源差异描述，字段见下
 * @param {string} profile.provider 落进 synth 的 provider 名（'codebuddy' / 'workbuddy'）
 * @param {(rec: object) => string} profile.userPrompt 从 user message 记录提取真人提问
 * @param {(block: object) => object|null} profile.mapBlock 内容块 → DSH 块
 * @param {(rec: object) => object|null} [profile.titleOf] 从 custom 条目取显式标题
 * @param {(rec: object) => boolean} [profile.skipCall] 该 function_call 是否丢弃
 * @param {(rec: object) => string|null} [profile.resultText] 结果正文，null = 丢弃该结果
 * @param {(rec: object) => boolean} [profile.resultIsError] 结果是否算失败
 * @param {(rec: object) => string|null} [profile.reasoningText] 从 reasoning 记录取正文
 * @param {(rec: object) => string|null} [profile.modelOf] 从记录取模型名
 * @param {(rec: object) => object|undefined} [profile.usageOf] 从记录取逐步 usage
 * @param {string} [profile.idArg] args 上承载源会话 id 的字段名
 * @param {(counts: object) => object} [profile.extraCounts] 追加到结果上的来源专属计数
 */
export function convertBuddyJsonl(raw, args = {}, profile) {
  const { recs, skipped, skippedLines, secrets } = parseJsonlLines(raw)

  let sourceId = null
  let cwd = null
  let createdAt = null
  let model = null
  let explicitTitle = null

  // callId → 声明该调用的 step（乱序 function_call_result 配对）
  const callSteps = new Map()

  const turnQueue = createTurns()
  const turns = turnQueue.turns
  let cur = null
  let lastStep = null
  // reasoning 事件在对应 assistant message 之前独立到达：缓存为 pendingReasoning，
  // 等下一步 assistant / function_call 落定时前插到该步内容头部（只前插一次；新开用户
  // 回合 / 无后续步时清空，避免把上次被打断的思考串到下轮）。
  let pendingReasoning = null
  // 丢弃的孤儿 function_call_result 计数（transcript 里没有对应 function_call——
  // 中途开始的转录 / 调用被过滤或打断）
  let droppedOrphanResults = 0
  // 丢弃的 custom 运行期条目计数（标题 / 计量 / 恢复标记等，只计数不进正文）
  let droppedMetaItems = 0

  const openTurn = (prompt, time) => {
    cur = turnQueue.open(prompt, time)
    lastStep = null
    pendingReasoning = null
  }

  const openStep = (time) => {
    if (!cur) return null
    const step = { content: [], toolCalls: [], toolResults: [] }
    if (time !== null && time !== undefined) step.time = time
    if (pendingReasoning) {
      step.content.push({ type: 'reasoning', text: pendingReasoning })
      pendingReasoning = null
    }
    cur.steps.push(step)
    lastStep = step
    return step
  }

  // 逐步 usage：消息级优先，其次调用级（CodeBuddy 把用量挂在 assistant message 与
  // function_call 两者的 providerData 上）。非负整数四桶才映射，见各源 usageOf。
  const usageOf = (rec) => {
    if (!profile.usageOf) return undefined
    try {
      return profile.usageOf(rec) || undefined
    } catch {
      // 用量映射失败不影响正文：该步不落 usage（宿主投影自己会算）
      return undefined
    }
  }

  const takeMeta = (rec) => {
    if (!sourceId && typeof rec.sessionId === 'string') sourceId = rec.sessionId
    if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd
    if (createdAt === null) createdAt = parseTime(rec.timestamp)
  }

  for (const rec of recs) {
    const env = rec && rec.type
    if (!env) continue
    const recTime = parseTimeMs(rec && rec.timestamp)

    if (env === 'message') {
      takeMeta(rec)
      if (rec.role === 'user') {
        const prompt = profile.userPrompt(rec)
        if (prompt) openTurn(prompt, recTime)
      } else if (rec.role === 'assistant') {
        const step = openStep(recTime)
        if (step) {
          for (const b of blocksOf(rec.content, profile.mapBlock)) step.content.push(b)
          const usage = usageOf(rec)
          if (usage) step.usage = usage
        }
        if (!model && profile.modelOf) model = profile.modelOf(rec) || model
      }
      // 其它角色（system / developer 注入）忽略
      continue
    }

    if (env === 'reasoning') {
      if (createdAt === null) createdAt = parseTime(rec.timestamp)
      const text = profile.reasoningText ? profile.reasoningText(rec) : null
      if (text) pendingReasoning = text
      continue
    }

    if (env === 'function_call') {
      takeMeta(rec)
      if (profile.skipCall && profile.skipCall(rec)) continue
      // 一条 function_call 可能没有前置 assistant 步：新开一步承载其 tool-call
      const step = lastStep || openStep(recTime)
      if (!step) continue
      if (!model && profile.modelOf) model = profile.modelOf(rec) || model
      const callUsage = usageOf(rec)
      if (callUsage && !step.usage) step.usage = callUsage
      const callId = typeof rec.callId === 'string' && rec.callId ? rec.callId : null
      if (!callId) {
        // 无 callId 的调用无法与结果配对：丢弃并计数（skipped 已由 parseJsonlLines 之外的
        // 口径统一在这里累加，调用方从结果上看到）
        skipped++
        continue
      }
      const mapped = { id: callId, name: rec.name || 'unknown', arguments: argumentsText(rec.arguments) }
      // assistant 消息内容必须携带 tool-call block（wire 从 content 派生 tool_calls）
      step.content.push({ type: 'tool-call', ...mapped })
      step.toolCalls.push(mapped)
      callSteps.set(callId, step)
      continue
    }

    if (env === 'function_call_result') {
      if (createdAt === null) createdAt = parseTime(rec.timestamp)
      // 非完成的运行期结果（incomplete / error）不落盘
      if (rec.status && rec.status !== 'completed') continue
      // 只按 callId 配对：孤儿结果一律丢弃并计数，绝不挂 lastStep
      const step = rec.callId ? callSteps.get(rec.callId) : null
      if (!step) { droppedOrphanResults++; continue }
      const text = profile.resultText ? profile.resultText(rec) : null
      if (text === null || text === undefined) continue
      step.toolResults.push({
        toolCallId: rec.callId,
        ...(recTime !== null ? { time: recTime } : {}),
        content: [{ type: 'text', text }],
        isError: profile.resultIsError ? Boolean(profile.resultIsError(rec)) : false,
      })
      continue
    }

    if (profile.titleOf) {
      const t = profile.titleOf(rec)
      if (t) { explicitTitle = t; continue }
    }
    // file-history-snapshot 与其余运行期 / 计量 custom 条目：跳过并计数（失败要大声）
    droppedMetaItems++
  }

  const droppedRetrySteps = dropDeadRetrySteps(turns)

  const idArg = profile.idArg
  const sessionId = args.sessionId || mintSessionId(sourceId || (idArg ? args[idArg] : null))
  const src = sourceId || (idArg ? args[idArg] : null) || sessionId
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: createdAt ?? Date.now() }
  meta.sourceId = src
  if (cwd) meta.cwd = cwd

  // 标题：显式标题（custom-title / ai-title）优先；否则首问兜底（只回填 title，不钉事件）。
  // pinFallbackTitle 决定无显式标题时是否把兜底标题也写进结果——WorkBuddy 历来如此
  // （保持既有行为），CodeBuddy 不钉（注入内容永不钉成标题，与 kimi / claude 同口径）。
  const finalTitle = normalizeTitle(explicitTitle || (turns.length > 0 ? turns[0].prompt : ''))
  const counts = {
    title: (explicitTitle || profile.pinFallbackTitle) ? finalTitle : undefined,
    droppedOrphanResults,
    droppedRetrySteps,
    droppedMetaItems,
  }
  if (profile.extraCounts) Object.assign(counts, profile.extraCounts({ turns, recs, skipped }))
  return finishSession(turns, args.budget, {
    meta,
    provider: profile.provider,
    model,
    skipped,
    records: recs.length,
    skippedLines,
    secrets,
  }, counts)
}
