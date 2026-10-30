// lib/convert/codearts.mjs — CodeArts Desktop 会话 → DSH 会话（纯函数）
//
// 存储（华为云码道 CodeArts 桌面客户端，内置 built_in_agent）：
//   默认根：~/.codearts/kernel/sessions（或 $CODEARTS_HOME/kernel/sessions）
//   布局：sessions/<启动时间戳>-<8位hash>/<session-uuid>/ 内三份文件
//     meta.json           会话元数据（session_id / title / working_directory /
//                         used_tokens / current_model / created_at / updated_at）
//     history.jsonl       消息序列（JSONL，一行一条）
//     messages.index.jsonl 消息索引（offset + len，指向 history.jsonl 内的字节区间）
//
// history.jsonl 每行一条消息（Rust serde 序列化，字段名首字母大写）：
//   {
//     id: 'msg_…', role: 'User' | 'Assistant' | 'Tool',
//     content: { SinglePart: { Text: { id, text } } }
//            | { MultiPart: [ { Text: {…} } | { ToolCall: {…} } | { ToolResult: {…} } ] },
//     timestamp: '2026-10-29T21:47:28.572955600Z',   // RFC3339，纳秒精度
//     model_ref: { provider_id, model_id },
//     token_usage: null | { … },
//     finish_reason: null | 'stop' | 'tool_calls',
//     reasoning_content: null | '…',                  // assistant 的推理正文
//     synthetic: false,                               // true = 上下文注入（非真人提问）
//     agent: 'CLI Agent'
//   }
//
// 关键转换语义：
//   1. 用户提问（role:'User'）：开新轮（turn）。synthetic:true 的消息是宿主的上下文注入
//      （当前是 todowrite 的「## Current Todo List」快照），不是真人输入——它同样开轮，
//      但 promptSource 标为 plugin（{kind:'plugin',plugin:'chat-import'}），不进消息计数、
//      不作标题回退（与 kimi 的注入口径一致）。
//   2. 助手消息（role:'Assistant'）：一步（step）。正文走 Text 块，推理走 reasoning 块，
//      工具调用走 ToolCall 块（arguments 是对象，序列化为 JSON 字符串）。
//   3. 工具结果（role:'Tool'）：按 ToolResult.tool_call_id 配对回声明该调用的 step。
//      配不上的孤儿结果计数 droppedToolResults 并丢弃；调用缺结果的由合成层补空结果。
//      结果正文取 tool_result.formatted_output（源侧渲染好的文本）；缺失时退回
//      tool_output / error / title 的 JSON 序列化。
//   4. 标题优先取 meta.json 的 title；cwd 取 meta.json 的 working_directory。
//   5. 预算裁剪与事件合成走 core 的 finishSession。
//
// 与 opencode 的关系：CodeArts 的 kernel 是 opencode 的 Rust 重写（msg_ / prt_ 前缀、
// agent / synthetic 字段同源），但存储从 sqlite 换成 JSONL、part 从对象换成 serde 枚举，
// 因此不复用 opencode 的转换器——形状不同（opencode 的 part 是 {type, text} 扁平块，
// 这里是 SinglePart / MultiPart 变体）。

import {
  SESSION_FORMAT_VERSION,
  finishSession,
  mintSessionId,
  parseJsonlLines,
  parseTimeMs,
} from './core.mjs'
import { normalizeTitle, skipResult } from './util.mjs'
import { alignStepResults, createTurns, dropDuplicateCalls } from './ir.mjs'

/**
 * CodeArts 时间戳 → 毫秒。源是 RFC3339 且带纳秒（'…28.572955600Z'），
 * Date.parse 只认毫秒——纳秒部分会被截断丢弃，不影响毫秒口径。
 */
export function parseCodeartsTime(value) {
  return parseTimeMs(value) ?? undefined
}

/**
 * 取出一个内容容器里的元素数组。CodeArts 的 content 有三种形态：
 *   { SinglePart: { Text: {…} } }   单块
 *   { MultiPart: [ … ] }              多块
 *   缺省 / null                       空
 * 统一摊平成数组，调用方只处理元素。
 */
function partsOf(content) {
  if (!content || typeof content !== 'object') return []
  if (Array.isArray(content.MultiPart)) return content.MultiPart.filter((p) => p && typeof p === 'object')
  if (content.SinglePart && typeof content.SinglePart === 'object') return [content.SinglePart]
  return []
}

/**
 * 从一个 part 里取出文本。part 是 { Text: { id, text } } 变体；text 缺失返回空串。
 */
function textOf(part) {
  const t = part && part.Text
  return t && typeof t.text === 'string' ? t.text : ''
}

/**
 * 工具调用的 arguments → JSON 字符串。源里是对象（不是 Claude 风格的字符串），
 * 非对象时按原样字符串化。
 */
function argumentsOf(call) {
  const a = call && call.arguments
  if (a === undefined || a === null) return '{}'
  if (typeof a === 'string') return a
  try {
    return JSON.stringify(a)
  } catch {
    // 循环引用等不可序列化的载荷：退化成空对象，不让整份会话失败
    return '{}'
  }
}

/**
 * 工具结果正文。formatted_output 是源侧渲染好的文本（优先）；缺失时按
 * tool_output → error → title 逐级回退，都拿不到才用 JSON 序列化整块。
 */
function resultText(result) {
  if (!result || typeof result !== 'object') return ''
  const r = result.tool_result
  if (!r || typeof r !== 'object') return ''
  if (typeof r.formatted_output === 'string' && r.formatted_output) return r.formatted_output
  if (typeof r.tool_output === 'string' && r.tool_output) return r.tool_output
  if (r.tool_output !== undefined && r.tool_output !== null) {
    try {
      return JSON.stringify(r.tool_output)
    } catch {
      // 不可序列化的载荷：继续往下一级回退
    }
  }
  if (typeof r.error === 'string' && r.error) return r.error
  if (r.error !== undefined && r.error !== null) {
    try {
      return JSON.stringify(r.error)
    } catch {
      // 同上
    }
  }
  if (typeof r.title === 'string' && r.title) return r.title
  return ''
}

/**
 * 工具结果是否算失败。源侧 success:false 记 error 字段（实测为 'Cancelled' 之类）。
 */
function resultIsError(result) {
  const r = result && result.tool_result
  return Boolean(r && typeof r === 'object' && r.success === false)
}

/**
 * token_usage → DSH usage。源侧字段：prompt_tokens / completion_tokens / reasoning_tokens /
 * cached_tokens（+ total_tokens / max_tokens，DSH 的 usage 形状里没有对应槽位，忽略）。
 * 非负整数才映射，任一桶不合法就整份丢弃（宿主投影会对它做算术）。
 */
function usageOf(record) {
  const u = record && record.token_usage
  if (!u || typeof u !== 'object') return undefined
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null)
  const inputTokens = num(u.prompt_tokens)
  const outputTokens = num(u.completion_tokens)
  if (inputTokens === null || outputTokens === null) return undefined
  const usage = { inputTokens, outputTokens }
  const cacheReadTokens = num(u.cached_tokens)
  if (cacheReadTokens !== null) usage.cacheReadTokens = cacheReadTokens
  const reasoningTokens = num(u.reasoning_tokens)
  if (reasoningTokens !== null) usage.reasoningTokens = reasoningTokens
  return usage
}

/**
 * 转换一份 CodeArts 会话为 DSH 会话。
 *
 * @param {string|object} raw - history.jsonl 文本，或包含 meta 与 messages 的中间对象
 * @param {object} args - 导入选项（args.meta 为 meta.json 内容）
 */
export function convertCodeartsJson(raw, args = {}) {
  let metaObj = args.meta && typeof args.meta === 'object' ? args.meta : null
  let messagesList = null
  let rawRecords = 0
  let skipped = 0
  let skippedLines = []
  let secrets = []

  if (typeof raw === 'object' && raw !== null) {
    if (Array.isArray(raw.messages)) {
      messagesList = raw.messages
      metaObj = metaObj || raw.meta || null
      rawRecords = raw.messages.length
    }
  } else if (typeof raw === 'string') {
    const parsed = parseJsonlLines(raw, { requireObject: true })
    messagesList = parsed.recs
    rawRecords = parsed.recs.length
    skipped = parsed.skipped
    skippedLines = parsed.skippedLines
    secrets = parsed.secrets
  }

  // 认不出的入参（空对象 / 数组 / 数字 / null / {messages:非数组}）按「无消息」处理并走
  // skipResult：转换器是各调用路径（local-jsonl 探测、宿主导入、预览）都直接调的，
  // 契约上不抛异常——抛了会让整次批量导入在该条上中断（vibe 同口径兜底）。
  if (!Array.isArray(messagesList)) messagesList = []

  const sourceId = (metaObj && typeof metaObj.session_id === 'string' && metaObj.session_id)
    || args.codeartsId
    || args.sourceId
    || null
  const cwd = (metaObj && typeof metaObj.working_directory === 'string' && metaObj.working_directory)
    || args.cwd
    || null
  const explicitTitle = (metaObj && typeof metaObj.title === 'string' && metaObj.title.trim())
    || (typeof args.title === 'string' && args.title.trim())
    || null
  const model = (metaObj && metaObj.current_model && typeof metaObj.current_model.model_id === 'string' && metaObj.current_model.model_id)
    || args.model
    || null
  const createdAt = (metaObj && parseCodeartsTime(metaObj.created_at))
    || parseCodeartsTime(args.createdAt)
    || null

  const turnQueue = createTurns()
  const turns = turnQueue.turns
  let curTurn = null
  let droppedToolResults = 0
  let injectedPrompts = 0
  // 标题回退只取首条真人提问；全是注入时 finalTitle 为空串 = 明确「没有话题」，
  // pin 层落「未命名 · 日期」（与 claude / kimi 同口径——注入内容永不钉成标题）。
  let firstRealPrompt = null

  for (const m of messagesList) {
    if (!m || typeof m !== 'object') {
      skipped++
      continue
    }

    const role = String(m.role || '').toLowerCase()

    if (role === 'user') {
      const parts = partsOf(m.content)
      let prompt = ''
      for (const p of parts) {
        const t = textOf(p)
        if (t) {
          prompt = t
          break
        }
      }
      const recTime = parseCodeartsTime(m.timestamp)
      curTurn = turnQueue.open(prompt, recTime)
      // synthetic = 宿主的上下文注入（todowrite 快照等），不是真人输入：
      // 仍开轮（内容顺序即模型可见顺序），但来源标 plugin，不进消息计数、不作标题回退。
      if (m.synthetic === true) {
        curTurn.promptSource = { kind: 'plugin', plugin: 'chat-import' }
        injectedPrompts++
      } else if (prompt && firstRealPrompt === null) {
        firstRealPrompt = prompt
      }
      continue
    }

    if (role === 'assistant') {
      if (!curTurn) {
        // 无前驱提问的孤儿 assistant 丢弃（回合平衡）
        skipped++
        continue
      }
      const recTime = parseCodeartsTime(m.timestamp)
      // 模型回退链（opencode 同口径）：消息级 model_ref 优先，会话级 current_model 兜底
      //——meta 的 current_model 是「最后一次」的模型，中途切换过模型时逐步各记各的才不失真。
      const stepModel = (m.model_ref && typeof m.model_ref.model_id === 'string' && m.model_ref.model_id)
        || model || undefined
      const step = {
        model: stepModel,
        content: [],
        toolCalls: [],
        toolResults: [],
      }
      if (recTime !== undefined) step.time = recTime
      const usage = usageOf(m)
      if (usage) step.usage = usage

      const reasoning = typeof m.reasoning_content === 'string' ? m.reasoning_content : ''
      if (reasoning) step.content.push({ type: 'reasoning', text: reasoning })

      for (const p of partsOf(m.content)) {
        if (p.Text) {
          const t = textOf(p)
          if (t) step.content.push({ type: 'text', text: t })
          continue
        }
        if (p.ToolCall) {
          const call = p.ToolCall
          const callId = typeof call.id === 'string' && call.id ? call.id : null
          if (!callId) {
            // 无 id 的调用无法与结果配对：丢弃并计数
            skipped++
            continue
          }
          const name = typeof call.name === 'string' && call.name ? call.name : 'tool'
          const argsStr = argumentsOf(call)
          step.toolCalls.push({ id: callId, name, arguments: argsStr })
          step.content.push({ type: 'tool-call', id: callId, name, arguments: argsStr })
        }
      }
      curTurn.steps.push(step)
      continue
    }

    if (role === 'tool') {
      for (const p of partsOf(m.content)) {
        if (!p.ToolResult) continue
        const tr = p.ToolResult
        const callId = typeof tr.tool_call_id === 'string' && tr.tool_call_id ? tr.tool_call_id : null
        let targetStep = null
        if (callId) {
          // 先在当前轮里找声明该调用的 step；不在则回看已开的轮（跨轮异步工具）。
          for (let t = turns.length - 1; t >= 0 && !targetStep; t--) {
            const steps = turns[t].steps
            for (let i = steps.length - 1; i >= 0; i--) {
              if (steps[i].toolCalls.some((c) => c.id === callId)) {
                targetStep = steps[i]
                break
              }
            }
          }
        }
        if (!targetStep || !callId) {
          droppedToolResults++
          continue
        }
        const recTime = parseCodeartsTime(m.timestamp)
        targetStep.toolResults.push({
          toolCallId: callId,
          content: [{ type: 'text', text: resultText(tr) }],
          isError: resultIsError(tr),
          ...(recTime !== undefined ? { time: recTime } : {}),
        })
      }
      continue
    }

    skipped++
  }

  if (turns.length === 0) {
    return skipResult('no user turns found in CodeArts session', {
      skipped: rawRecords || 1, records: rawRecords, skippedLines, secrets,
    })
  }

  // 共用件整理（AGENTS.md：调用与结果的整理走 ir.mjs，来源不另写）：
  // 同一 callId 的重复 tool-call 只留首次（DSH 折叠器对第二次同 id start 会硬异常并吞掉
  // 整段轨迹，宁可少一条重复）；同一步内并行结果按调用声明顺序稳定排序。真实转录无重复
  // callId，这两步对正常数据是恒等操作，只挡畸形输入。
  const droppedDuplicateCalls = dropDuplicateCalls(turns)
  alignStepResults(turns)

  const sessionId = mintSessionId(sourceId)
  const meta = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: createdAt ?? Date.now(),
  }
  if (sourceId) meta.sourceId = sourceId
  if (cwd) meta.cwd = cwd

  const finalTitle = normalizeTitle(explicitTitle || firstRealPrompt || '')
  return finishSession(turns, args.budget, {
    meta,
    title: explicitTitle ? finalTitle : undefined,
    provider: 'codearts',
    model,
    skipped,
    records: rawRecords,
    skippedLines,
    secrets,
  }, { title: finalTitle, droppedToolResults, droppedDuplicateCalls, injectedPrompts })
}
