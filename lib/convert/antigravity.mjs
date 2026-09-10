// lib/convert/antigravity.mjs — Antigravity CLI (agy) 会话转录 → DSH 会话（纯函数）
//
// Antigravity CLI 是 Gemini CLI 的后续产品，但与 Gemini CLI 共享 ~/.gemini 前缀、
// 存储格式完全不同（Gemini CLI 是 <slot>/chats/session-*.json，本工具是每会话一份
// 独立存储），因此独立成源而非复用 gemini.mjs。
//
// 存储：~/.gemini/antigravity-cli/
//   conversations/<conversationId>.db        每会话命中记录（正文为 protobuf blob）
//   brain/<conversationId>/.system_generated/logs/transcript.jsonl
//                                            逐行 JSON 转录（本转换器的输入）
//   brain/<conversationId>/.system_generated/messages/*.json
//                                            异步任务回执（工具结果的补充来源）
//   annotations/<conversationId>.pbtxt       会话标题
//
// 选 transcript.jsonl 而非 conversations/*.db：后者把每步编码成 protobuf
// step_payload，需要 schema 才能解；前者是同一轨迹的明文逐行 JSON，字段稳定。
//
// transcript.jsonl 记录（每行一个对象，键随 type 变化）：
//   { step_index, source, type, status, created_at, content?, thinking?, tool_calls? }
//   USER_INPUT       source=USER_EXPLICIT，content 是包在 <USER_REQUEST> 里的提问；
//                    同时可能带 <ADDITIONAL_METADATA> 信封（环境/工作区元信息）→ 剥壳。
//   PLANNER_RESPONSE source=MODEL，content 是正文，thinking 是思考摘要，
//                    tool_calls 是 [{name, args}]（args 值多为带引号的字符串）。
//   GENERIC          source=MODEL，status=DONE 时 content 即**工具结果**
//                    （"…\nThe command exited with code N.\nOutput:\n…"）；
//                    status=RUNNING 表示后台任务刚启动，不是结果。
//   SYSTEM_MESSAGE   框架发给模型的系统通知（非用户、非工具输出）→ 跳过。
//   CHECKPOINT / ERROR_MESSAGE → 前者跳过，后者保留为正文以免失败被抹掉。
//
// 工具结果配对：Antigravity 不把结果内联在调用上，也不回指调用步——结果落在**紧接
// 其调用步之后**的 GENERIC/DONE 记录上。因此按「最近一个尚无结果的未决调用」配对
//（一次 planner 步可发多个调用，逐个消费）。未能配对的后台任务（fire-and-forget）
// 显式标注结果缺失，不留空结果、不虚构输出。

import {
  SESSION_FORMAT_VERSION,
  applyBudgetTrim,
  mintSessionId,
  parseJsonlLines,
  parseTime,
  synthesizeSession,
} from './core.mjs'

// REQ-27 标题归一统一规则：去首尾空白、折叠内部空白；超 80 字符截断加省略号；
// 空白返回空串。core.mjs 属禁改面，各源按文件内联同款（改规则需逐源同步）。
const TITLE_MAX_LEN = 80
const TITLE_ELLIPSIS = '…'
function normalizeTitle(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return ''
  return t.length <= TITLE_MAX_LEN ? t : t.slice(0, TITLE_MAX_LEN - TITLE_ELLIPSIS.length) + TITLE_ELLIPSIS
}

// 结果缺失时的显式占位（区分「确实没有输出」与「转录里没带回来」）。
const NO_OUTPUT_BACKGROUND = '(no output captured — background task, result not in transcript)'
const NO_OUTPUT_TASK_CONTROL = '(task control call — no direct output)'

// 任务控制类调用自身不产出输出（真正的工作由它派生出去，另行回报）。
const TASK_CONTROL_TOOLS = new Set(['manage_task', 'schedule'])

// Antigravity 把 shell 风格参数存成带引号的字符串（"55"、/"a b"/）→ 还原为字面值，
// 让 JSON.stringify 后的 arguments 在 DSH 侧保持可读。
function unquote(value) {
  if (typeof value !== 'string') return value
  const s = value.trim()
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s)
    } catch {
      return s.slice(1, -1)
    }
  }
  return value
}

function normalizeArgs(args) {
  if (!args || typeof args !== 'object') return {}
  const out = {}
  for (const [key, value] of Object.entries(args)) out[key] = unquote(value)
  return out
}

// <USER_REQUEST> 内的正文即真实提问；<ADDITIONAL_METADATA> 是脚手架元信息，剥掉。
export function unwrapUserRequest(text) {
  let s = String(text ?? '')
  const m = s.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i)
  if (m) s = m[1]
  s = s.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
  s = s.replace(/<\/?USER_REQUEST>/gi, '')
  return s.trim()
}

// transcript 在字段被截断时以 "\n... (truncated)" 收尾 → 去掉标记保留可得正文。
function stripTruncationMarker(text) {
  if (typeof text !== 'string') return ''
  return text.replace(/\n*\.\.\.\s*\(truncated\)\s*$/i, '')
}

// annotations/*.pbtxt 是 protobuf 文本格式（title:"…"），标题行是唯一需要的字段。
export function parseAnnotationTitle(raw) {
  const m = String(raw ?? '').match(/title\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (!m) return ''
  try {
    return String(JSON.parse(`"${m[1]}"`)).trim()
  } catch {
    return m[1].trim()
  }
}

// 会话工作目录：Antigravity 在工具参数里逐次记录 Cwd，取出现次数最多者。
function dominantCwd(recs) {
  const counts = new Map()
  for (const rec of recs) {
    if (!rec || !Array.isArray(rec.tool_calls)) continue
    for (const call of rec.tool_calls) {
      const args = call && call.args
      if (!args || typeof args !== 'object') continue
      const cwd = unquote(args.Cwd)
      if (typeof cwd === 'string' && cwd.startsWith('/')) {
        counts.set(cwd, (counts.get(cwd) || 0) + 1)
      }
    }
  }
  let best = null
  let bestCount = 0
  for (const [cwd, count] of counts) {
    if (count > bestCount) {
      best = cwd
      bestCount = count
    }
  }
  return best
}

// messages/*.json（异步任务回执）→ stepIndex → 文本列表。这些回执在导出的转录里
// 只留标题行，正文需从伴生目录补读；转换器只接受调用方已读好的映射，保持纯函数。
export function indexTaskMessages(records) {
  const byStep = new Map()
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue
    const tool = rec.sourceMetadata && rec.sourceMetadata.tool
    const stepIndex = tool && Number.isFinite(tool.stepIndex) ? tool.stepIndex : null
    if (stepIndex === null) continue
    const text = typeof rec.content === 'string' ? rec.content : ''
    if (!text) continue
    if (!byStep.has(stepIndex)) byStep.set(stepIndex, [])
    byStep.get(stepIndex).push(text)
  }
  return byStep
}

// 转录 JSONL → DSH 会话。args:
//   antigravityId  源会话 id（conversations/<id>.db 的 <id>）——派生 DSH 会话 id 与 sourceId
//   sessionId      覆盖派生 id
//   sourcePath     记录进 imported.sourcePath
//   budget         上下文预算（core 三层裁剪）
//   annotationRaw / annotationTitle  annotations/<id>.pbtxt 原文或已解析标题
//   taskMessages   indexTaskMessages() 的结果（可缺省）
//   cwd            覆盖从 tool_calls 推断的工作目录
export function convertAntigravityJsonl(raw, args = {}) {
  // REQ-26：逐行解析带行号明细（畸形行计数不设限，明细封顶 200）+ secrets 位置
  const { recs, skipped, skippedLines, secrets } = parseJsonlLines(raw)

  const taskMessages = args.taskMessages instanceof Map ? args.taskMessages : new Map()
  const turns = []
  let cur = null

  // 未决调用：结果落在其后的 GENERIC/DONE 记录上，按发出顺序逐个配对。
  let pending = []
  const flushPending = () => {
    for (const entry of pending) {
      if (entry.resultText !== null) {
        entry.call.result.push({ type: 'text', text: entry.resultText })
        continue
      }
      if (TASK_CONTROL_TOOLS.has(entry.call.name)) {
        entry.call.result.push({ type: 'text', text: NO_OUTPUT_TASK_CONTROL })
        continue
      }
      // fire-and-forget：转录未带回输出 → 如实标注，不虚构空结果。
      entry.call.status = 'background'
      entry.call.result.push({ type: 'text', text: NO_OUTPUT_BACKGROUND })
    }
    pending = []
  }
  // 一次 planner 步可发多个调用，其结果按发出顺序逐条到达 → 取**最早**的未决调用
  //（正序扫描），保证「先发的调用先拿结果」，与转录中的到达顺序一致。
  const takePending = (resultStep) => {
    for (let i = 0; i < pending.length; i++) {
      const entry = pending[i]
      if (entry.resultText !== null) continue
      if (resultStep === null || entry.stepIndex === null || entry.stepIndex < resultStep) return entry
    }
    return null
  }

  let model = null
  let createdAt = null
  let firstPrompt = ''

  for (const rec of recs) {
    if (!rec || typeof rec !== 'object') continue
    const type = rec.type
    const stepIndex = Number.isFinite(rec.step_index) ? rec.step_index : null
    if (createdAt === null && rec.created_at) createdAt = rec.created_at

    if (type === 'USER_INPUT') {
      flushPending()
      const prompt = unwrapUserRequest(stripTruncationMarker(rec.content))
      if (!prompt) continue
      if (!firstPrompt) firstPrompt = prompt
      cur = { prompt, steps: [] }
      turns.push(cur)
      continue
    }

    if (type === 'PLANNER_RESPONSE') {
      flushPending()
      // 无用户轮的孤立回复（会话被截断等）→ 丢弃，避免产出无 prompt 的 step。
      if (!cur) continue
      const step = { content: [], toolCalls: [], toolResults: [] }
      if (model === null) model = 'antigravity-auto'
      const text = stripTruncationMarker(rec.content).trim()
      if (text) step.content.push({ type: 'text', text })
      if (typeof rec.thinking === 'string' && rec.thinking.trim()) {
        step.content.push({ type: 'reasoning', text: rec.thinking.trim() })
      }
      if (Array.isArray(rec.tool_calls)) {
        for (let i = 0; i < rec.tool_calls.length; i++) {
          const tc = rec.tool_calls[i]
          if (!tc || typeof tc !== 'object') continue
          const call = {
            id: 'agy-' + (stepIndex ?? turns.length) + '-' + i,
            name: typeof tc.name === 'string' && tc.name ? tc.name : 'unknown',
            arguments: JSON.stringify(normalizeArgs(tc.args)),
            // 结果由后续 GENERIC 记录回填；result 数组在 flush 时定稿。
            result: [],
          }
          step.content.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments })
          step.toolCalls.push(call)
          pending.push({ stepIndex, call, resultText: null })
        }
      }
      if (step.content.length > 0) cur.steps.push(step)
      continue
    }

    if (type === 'GENERIC') {
      // status=RUNNING：后台任务刚启动（不是结果）→ 不消费未决调用。
      if (rec.status !== 'DONE') continue
      const text = stripTruncationMarker(rec.content).trim()
      if (!text) continue
      const entry = takePending(stepIndex)
      if (entry) {
        // 转录行只留任务回执摘要（"Task … finished"），正文在同 step 的伴生
        // messages/*.json 里 → 有正文时以它为准，否则用转录行。
        const viaMessage = stepIndex !== null ? taskMessages.get(stepIndex) : null
        entry.resultText = viaMessage && viaMessage.length > 0 ? viaMessage[0] : text
        continue
      }
      // 转录里没配上的异步回执：仍尝试用伴生 messages/ 正文补齐最近一个未决调用。
      const fallback = takePending(null)
      if (fallback) {
        const viaMessage = stepIndex !== null ? taskMessages.get(stepIndex) : null
        fallback.resultText = viaMessage && viaMessage.length > 0 ? viaMessage[0] : text
      }
      continue
    }

    if (type === 'ERROR_MESSAGE') {
      // 失败要大声：错误正文并入当前 step，不留静默缺口。
      const text = stripTruncationMarker(rec.content).trim()
      if (!text || !cur) continue
      const step = { content: [{ type: 'text', text: '[error] ' + text }], toolCalls: [], toolResults: [] }
      cur.steps.push(step)
    }
  }
  flushPending()

  // toolCalls[].result 定稿 → toolResults（core 的 toolResult 契约：content 文本块数组）。
  for (const turn of turns) {
    for (const step of turn.steps) {
      for (const call of step.toolCalls) {
        step.toolResults.push({
          toolCallId: call.id,
          content: call.result,
          isError: false,
        })
        delete call.result
      }
    }
  }

  const sessionId = args.sessionId || mintSessionId(args.antigravityId)
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: parseTime(createdAt) }
  if (args.antigravityId) meta.sourceId = args.antigravityId
  const cwd = args.cwd || dominantCwd(recs)
  if (typeof cwd === 'string' && cwd) meta.cwd = cwd

  const annotationTitle = args.annotationTitle !== undefined
    ? args.annotationTitle
    : parseAnnotationTitle(args.annotationRaw)
  const finalTitle = normalizeTitle(annotationTitle) || normalizeTitle(firstPrompt)

  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, args.budget)
  const out = synthesizeSession({
    meta,
    turns: seedTurns,
    title: undefined,
    provider: 'antigravity',
    model,
    skipped,
    records: recs.length,
    skippedLines,
    secrets,
    imported: { sourcePath: args.sourcePath },
  })
  const result = trimmed ? { ...out, trimmed } : out
  return { ...result, title: finalTitle }
}
