// lib/convert/jcode.mjs — jcode 会话 JSON → DSH 会话（纯函数）
//
// 存储：~/.jcode/sessions/session_<short>_<ts>_<hash>.json（每文件一个完整会话快照，
// 同目录另有 .bak，发现层只认 session_*.json）。字段（实测契约）：
//   id / parent_id / title / created_at / updated_at / messages[] / provider_key / model /
//   working_dir / short_name / status / env_snapshots / compaction / ...
// title 常为 null，会话的人名在 short_name（ant / badger / fox 这类短名）。
//
// 消息（Anthropic 风格块）：
//   role user | assistant；content 数组块 text / reasoning / tool_use / tool_result / image；
//   assistant 带 timestamp（ISO，纳秒精度）与 token_usage{input_tokens,output_tokens}；
//   display_role=system 的 user 消息是运行时注入（<system-reminder> 环境上下文），
//   不是人类发言——跳过并计数（injectionSkipped），不建轮次。
//
// 轮次映射：一条真实 user 消息 → 一个 turn；assistant 消息 → 一个 step（tool_use → tool-call，
// 记入未配对调用）；tool_result 块（user 角色）→ 挂回声明它的 step，按 tool_use_id 配对；
// 孤儿与重复结果丢弃计数。无 id 的调用整块丢弃（无法配对）。
//
// 标题优先级：args.displayName > title > short_name > 首条真实提问 > cwd basename。
// link 的 short_name/title 存在时钉 session/title 事件——DSH 自动回退首问对 jcode 不合适，
// 它的会话名是会话本身的标识。
import { SESSION_FORMAT_VERSION, finishSession, mintSessionId } from './core.mjs'
import { normalizeTitle, skipResult } from './util.mjs'
import { alignStepResults, dropDuplicateCalls } from './ir.mjs'
import { IMAGE_PLACEHOLDER, imageBlockFromBase64 } from './image.mjs'

// jcode 的 created_at/updated_at 是纳秒 ISO（2026-06-17T07:31:23.435490575Z）；Date.parse
// 在部分引擎不接受 9 位小数，按毫秒截断后再解析。
export function jcodeTimeMs(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    const ms = Math.round(value < 1e11 ? value * 1000 : value)
    return Number.isSafeInteger(ms) ? ms : null
  }
  if (typeof value !== 'string') return null
  const m = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}/.exec(value)
  const parsed = Date.parse(m ? `${m[0]}Z` : value)
  return Number.isFinite(parsed) ? parsed : null
}

// 内容 → 纯文本（text 块的投影；标题、空轮判定、prompt 用）。
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

function pathBasename(value) {
  const t = String(value ?? '').trim().replace(/[\\/]+$/, '')
  return t ? (t.split(/[\\/]/).pop() || '') : ''
}

// jcode 图片块 {type:'image', media_type, data:<base64>} → IR image 块（待落地）。
// 拿不到合法载荷时不构造（调用方计数降级）。
function jcodeImageBlock(block) {
  const mediaType = block.mediaType || block.media_type || block.mime_type || block.mime
  if (typeof block.data !== 'string') return null
  return imageBlockFromBase64(block.data, mediaType, block.name)
}

// 单块映射：text / reasoning / thinking / tool_use / image。未知块返回 null 并计数。
function mapBlock(block, counters) {
  if (!block || typeof block !== 'object') {
    counters.unknownBlocks += 1
    return null
  }
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? { type: 'text', text: block.text } : null
    case 'reasoning':
    case 'thinking':
      return typeof block.text === 'string' ? { type: 'reasoning', text: block.text } : null
    case 'image': {
      const img = jcodeImageBlock(block)
      if (img === null) counters.imagesDegraded += 1
      return img
    }
    case 'tool_use':
      return {
        type: 'tool-call',
        id: block.id,
        name: block.name,
        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
      }
    default:
      counters.unknownBlocks += 1
      return null
  }
}

// tool_result 的内部内容 → IR content 块；拿不到图片字节时用占位文本并计数。
function resultContent(inner, counters) {
  if (typeof inner === 'string') {
    const text = inner.trim()
    return text ? [{ type: 'text', text }] : []
  }
  if (!Array.isArray(inner)) return []
  const out = []
  for (const block of inner) {
    if (block && block.type === 'image') {
      const img = jcodeImageBlock(block)
      out.push(img ?? { type: 'text', text: IMAGE_PLACEHOLDER })
      if (img === null) counters.imagesDegraded += 1
      continue
    }
    const mapped = mapBlock(block, counters)
    if (mapped) out.push(mapped)
  }
  return out
}

// token_usage → DSH TokenUsage（input/output 必须是非负安全整数；不满足整份丢弃）。
function usageOf(tokenUsage) {
  if (!tokenUsage || typeof tokenUsage !== 'object') return undefined
  const input = tokenUsage.input_tokens
  const output = tokenUsage.output_tokens
  if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0) return undefined
  const usage = { inputTokens: input, outputTokens: output }
  for (const [key, target] of [['cache_read_tokens', 'cacheReadTokens'], ['cache_write_tokens', 'cacheWriteTokens']]) {
    const value = tokenUsage[key]
    if (Number.isSafeInteger(value) && value >= 0) usage[target] = value
  }
  return usage
}

export function convertJcodeJson(raw, args = {}) {
  let session
  try {
    session = JSON.parse(String(raw ?? ''))
  } catch {
    return skipResult('invalid jcode session JSON')
  }
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    return skipResult('not a jcode session object')
  }

  const counters = { skippedInjections: 0, droppedToolResults: 0, imagesDegraded: 0, unknownBlocks: 0 }
  const messages = Array.isArray(session.messages) ? session.messages : []
  const turns = []
  const callSteps = new Map()
  const resolved = new Set()
  const allCallIds = []
  let cur = null
  let firstUserText = null

  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      counters.unknownBlocks += 1
      continue
    }
    const role = message.role
    const blocks = Array.isArray(message.content)
      ? message.content
      : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : []
    const time = jcodeTimeMs(message.timestamp)

    // 运行时注入（system-reminder）：跳过整条，不建轮次。
    if (role === 'user' && message.display_role === 'system') {
      counters.skippedInjections += 1
      continue
    }

    if (role === 'user') {
      const results = blocks.filter((b) => b && b.type === 'tool_result')
      if (results.length > 0) {
        for (const result of results) {
          const callId = typeof result.tool_use_id === 'string' ? result.tool_use_id : undefined
          if (!callId || !callSteps.has(callId) || resolved.has(callId)) {
            counters.droppedToolResults += 1
            continue
          }
          resolved.add(callId)
          const step = callSteps.get(callId)
          step.toolResults.push({
            toolCallId: callId,
            content: resultContent(result.content, counters),
            isError: result.is_error === true,
            ...(time !== null ? { time } : {}),
          })
        }
        continue
      }

      const prompt = textOf(blocks).trim()
      const images = blocks.filter((b) => b && b.type === 'image').map((b) => jcodeImageBlock(b))
      const hasImages = images.some((img) => img !== null) || blocks.some((b) => b && b.type === 'image')
      if (!prompt && !hasImages) continue
      cur = { prompt, steps: [] }
      if (time !== null) cur.time = time
      if (hasImages) {
        const promptBlocks = blocks
          .filter((b) => b && (b.type === 'text' || b.type === 'image'))
          .map((b) => (b.type === 'image' ? (jcodeImageBlock(b) ?? { type: 'text', text: IMAGE_PLACEHOLDER }) : { type: 'text', text: b.text }))
        cur.promptBlocks = promptBlocks
      }
      turns.push(cur)
      if (firstUserText === null) firstUserText = prompt
      continue
    }

    if (role === 'assistant') {
      if (!cur) {
        // 孤儿 assistant（没有前置真实提问）：用空 prompt 轮兜住，批量层按无用户回合跳过。
        cur = { prompt: '', steps: [] }
        turns.push(cur)
      }
      const step = { content: [], toolCalls: [], toolResults: [] }
      if (time !== null) step.time = time
      for (const block of blocks) {
        const mapped = mapBlock(block, counters)
        if (!mapped) continue
        if (mapped.type === 'tool-call') {
          if (typeof mapped.id !== 'string' || !mapped.id) {
            counters.unknownBlocks += 1
            continue
          }
          step.content.push(mapped)
          step.toolCalls.push(mapped)
          callSteps.set(mapped.id, step)
          allCallIds.push(mapped.id)
        } else {
          step.content.push(mapped)
        }
      }
      const usage = usageOf(message.token_usage)
      if (usage) step.usage = usage
      cur.steps.push(step)
      continue
    }

    counters.unknownBlocks += 1
  }

  alignStepResults(turns)
  const duplicateCalls = dropDuplicateCalls(turns)

  if (turns.length === 0) {
    return skipResult('jcode session has no user turn', {
      skippedInjections: counters.skippedInjections,
      unknownBlocks: counters.unknownBlocks,
    })
  }

  const fileStem = typeof args.sourcePath === 'string'
    ? String(args.sourcePath).split(/[\\/]/).pop().replace(/\.json$/i, '')
    : null
  const sourceId = typeof session.id === 'string' && session.id ? session.id : null
  const srcId = sourceId || args.jcodeId || fileStem || null
  const createdAt = jcodeTimeMs(session.created_at) ?? Date.now()
  const cwd = typeof session.working_dir === 'string' && session.working_dir ? session.working_dir : undefined

  const meta = {
    version: SESSION_FORMAT_VERSION,
    id: args.sessionId || mintSessionId(srcId),
    createdAt,
  }
  if (srcId) meta.sourceId = srcId
  if (cwd) meta.cwd = cwd

  // 标题：显式 displayName > title > short_name；都没有才回退首问（交给 DSH 自动回退）。
  const explicit = normalizeTitle(typeof args.displayName === 'string' ? args.displayName : '')
  const titled = normalizeTitle(typeof session.title === 'string' ? session.title : '')
  const shortName = normalizeTitle(typeof session.short_name === 'string' ? session.short_name : '')
  const topic = explicit || titled || shortName || normalizeTitle(firstUserText || pathBasename(cwd))
  const pinTitle = explicit || titled || shortName ? topic : undefined

  return finishSession(turns, args.budget, {
    meta,
    title: pinTitle,
    provider: 'jcode',
    model: typeof session.model === 'string' && session.model ? session.model : 'jcode',
    skipped: 0,
    records: messages.length,
    skippedLines: [],
    secrets: [],
  }, {
    title: topic || undefined,
    ...counters,
    duplicateCalls,
  })
}
