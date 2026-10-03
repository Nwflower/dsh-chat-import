// lib/convert/vibe.mjs — Mistral Vibe CLI 会话 → DSH 会话（纯函数）
//
// 存储（mistralai/mistral-vibe）：
//   默认根：~/.vibe/logs/session（或 $VIBE_HOME/logs/session）
//   每个会话目录名形如 session_<timestamp>_<shortId>，内含两份文件：
//     meta.json       元数据（session_id / title / environment.working_directory /
//                     origin_directory / start_time / config.active_model 等）
//     messages.jsonl  LLMMessage 消息序列（JSONL）
//
// LLMMessage 格式（vibe.core.types.LLMMessage）：
//   role: 'user' | 'assistant' | 'tool' | 'system'
//   content: string | list of text parts | null
//   reasoning_content: string | null （assistant 推理内容 → reasoning 块）
//   tool_calls: list of { id, type: 'function', function: { name, arguments } }
//   tool_call_id: string （role === 'tool' 时对应的 tool_call id）
//   tool_result: { output: ..., duration: ..., cancelled: bool }
//   images: list of { source: { kind: 'inline', data } | { kind: 'file', path }, alias, mime_type }
//   context_boundary: 'compaction' （上下文压缩边界标记）
//   injected: bool
//
// 关键转换语义：
//   1. 用户提问（role: 'user'）：开新轮（turn）；若带 context_boundary === 'compaction'，
//      则标记该轮之前的压缩检查点（compaction = { summary, provider: 'mistral-vibe', model }）。
//   2. 助手消息（role: 'assistant'）：一步（step）；提取 reasoning_content（reasoning 块）、
//      content（text 块）以及 tool_calls（tool-call 块与 toolCalls 列表）。
//   3. 工具结果（role: 'tool'）：按 tool_call_id 配对回该 step 的 toolResults。未配对的
//      孤儿结果计数 droppedToolResults 并丢弃。
//   4. 标题优先级：meta.title > 首问文本截断。
//   5. 预算裁剪走 applyBudgetTrim；最终走 synthesizeSession 输出。

import {
  SESSION_FORMAT_VERSION,
  IMAGE_PLACEHOLDER,
  applyBudgetTrim,
  imageBlockFromSource,
  mintSessionId,
  parseJsonlLines,
  synthesizeSession,
} from './core.mjs'

const TITLE_MAX_LEN = 80
const TITLE_ELLIPSIS = '…'

/**
 * 标题归一：去首尾空白、折叠内部空白；超 80 字符截断加省略号；空白返回空串。
 */
export function normalizeTitle(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return ''
  return t.length <= TITLE_MAX_LEN ? t : t.slice(0, TITLE_MAX_LEN - TITLE_ELLIPSIS.length) + TITLE_ELLIPSIS
}

/**
 * ISO 8601 或时间戳解析为毫秒。
 */
export function parseVibeTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : Math.trunc(value) * 1000
  }
  if (typeof value === 'string' && value) {
    const n = Date.parse(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/**
 * 提取 content / reasoning_content 文本（支持 string 或 list/dict 数组）。
 */
function extractTextContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((p) => {
      if (typeof p === 'string') return p
      if (p && typeof p === 'object') {
        if (typeof p.text === 'string') return p.text
        if (typeof p.content === 'string') return p.content
      }
      return ''
    }).filter(Boolean).join('\n')
  }
  return ''
}

/**
 * 从 Vibe 消息的 images 数组解析 IR image 块。
 */
function extractImageBlocks(images) {
  if (!Array.isArray(images)) return []
  const blocks = []
  for (const img of images) {
    if (!img || typeof img !== 'object') continue
    const source = img.source
    const mediaType = typeof img.mime_type === 'string' ? img.mime_type : 'image/png'
    const name = typeof img.alias === 'string' ? img.alias : undefined
    if (source && typeof source === 'object' && source.kind === 'inline' && typeof source.data === 'string') {
      const b = imageBlockFromSource({ data: source.data, mediaType, name })
      if (b) {
        blocks.push(b)
        continue
      }
    }
    // 无法获取内联 base64 时降级为占位文本
    blocks.push({ type: 'text', text: IMAGE_PLACEHOLDER })
  }
  return blocks
}

/**
 * 转换 Vibe 会话记录为 DSH 会话。
 * @param {string|object} raw - messages.jsonl 文本、或包含 meta 与 messages 的中间对象
 * @param {object} args - 导入选项
 */
export function convertVibeJson(raw, args = {}) {
  let metaObj = args.meta || null
  let messagesList = null

  if (typeof raw === 'object' && raw !== null) {
    if (Array.isArray(raw.messages)) {
      messagesList = raw.messages
      metaObj = metaObj || raw.meta || raw
    } else {
      metaObj = metaObj || raw
    }
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.startsWith('{') && !trimmed.includes('\n')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object') {
          if (Array.isArray(parsed.messages)) {
            messagesList = parsed.messages
            metaObj = metaObj || parsed.meta || parsed
          } else if (parsed.session_id || parsed.environment) {
            metaObj = metaObj || parsed
          }
        }
      } catch {
        // 不是单行完整 JSON，按普通 JSONL 解析
      }
    }
  }

  const skippedLines = []
  const secrets = []
  let rawRecords = 0
  let skipped = 0

  if (!messagesList && typeof raw === 'string') {
    const parsed = parseJsonlLines(raw)
    rawRecords = parsed.recs.length
    skipped = parsed.skipped
    skippedLines.push(...parsed.skippedLines)
    secrets.push(...parsed.secrets)
    messagesList = parsed.recs
  } else if (messagesList) {
    rawRecords = messagesList.length
  } else {
    messagesList = []
  }

  const sourceId = (metaObj && typeof metaObj.session_id === 'string' && metaObj.session_id)
    || args.vibeId
    || args.sourceId
    || null
  const cwd = (metaObj && metaObj.environment && typeof metaObj.environment.working_directory === 'string' && metaObj.environment.working_directory)
    || (metaObj && typeof metaObj.origin_directory === 'string' && metaObj.origin_directory)
    || args.cwd
    || null
  const explicitTitle = (metaObj && typeof metaObj.title === 'string' && metaObj.title.trim())
    || (typeof args.title === 'string' && args.title.trim())
    || null
  const model = (metaObj && metaObj.config && typeof metaObj.config.active_model === 'string' && metaObj.config.active_model)
    || args.model
    || null
  const createdAt = (metaObj && parseVibeTime(metaObj.start_time))
    || parseVibeTime(args.createdAt)
    || null

  const turns = []
  let curTurn = null
  let droppedToolResults = 0
  let pendingCompaction = null

  for (const m of messagesList) {
    if (!m || typeof m !== 'object') {
      skipped++
      continue
    }

    const role = String(m.role || '').toLowerCase()
    if (role === 'system') {
      // system 消息跳过（DSH 会话自带 system head，避免污染）
      continue
    }

    if (m.context_boundary === 'compaction') {
      const summaryText = extractTextContent(m.content) || extractTextContent(m.reasoning_content) || 'Context Compaction'
      pendingCompaction = {
        summary: summaryText,
        provider: 'mistral-vibe',
        model: model || 'mistral-vibe',
      }
      continue
    }

    if (role === 'user') {
      const prompt = extractTextContent(m.content) || (typeof m.input_text === 'string' ? m.input_text : '')
      const imageBlocks = extractImageBlocks(m.images)
      const promptBlocks = imageBlocks.length > 0
        ? [{ type: 'text', text: prompt }, ...imageBlocks]
        : undefined

      curTurn = {
        prompt,
        ...(promptBlocks ? { promptBlocks } : {}),
        steps: [],
        ...(pendingCompaction ? { compaction: pendingCompaction } : {}),
      }
      pendingCompaction = null
      turns.push(curTurn)
      continue
    }

    if (role === 'assistant') {
      if (!curTurn) {
        // 无前驱提问的孤儿 assistant 丢弃（回合平衡）
        skipped++
        continue
      }

      const contentText = extractTextContent(m.content)
      const reasoningText = extractTextContent(m.reasoning_content)
      const imageBlocks = extractImageBlocks(m.images)
      const step = {
        model: model || undefined,
        content: [],
        toolCalls: [],
        toolResults: [],
      }

      if (reasoningText) {
        step.content.push({ type: 'reasoning', text: reasoningText })
      }
      if (contentText) {
        step.content.push({ type: 'text', text: contentText })
      }
      for (const ib of imageBlocks) {
        step.content.push(ib)
      }

      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (!tc || typeof tc !== 'object') continue
          const callId = typeof tc.id === 'string' && tc.id ? tc.id : ('call_' + Math.random().toString(36).slice(2, 10))
          const fnName = (tc.function && typeof tc.function.name === 'string' && tc.function.name) || 'tool'
          let argsStr = '{}'
          if (tc.function && typeof tc.function.arguments === 'string') {
            argsStr = tc.function.arguments
          } else if (tc.function && tc.function.arguments && typeof tc.function.arguments === 'object') {
            argsStr = JSON.stringify(tc.function.arguments)
          }
          step.toolCalls.push({ id: callId, name: fnName, arguments: argsStr })
          step.content.push({ type: 'tool-call', id: callId, name: fnName, arguments: argsStr })
        }
      }

      curTurn.steps.push(step)
      continue
    }

    if (role === 'tool') {
      const callId = typeof m.tool_call_id === 'string' && m.tool_call_id ? m.tool_call_id : null
      let targetStep = null

      if (callId && curTurn) {
        for (let i = curTurn.steps.length - 1; i >= 0; i--) {
          if (curTurn.steps[i].toolCalls.some((c) => c.id === callId)) {
            targetStep = curTurn.steps[i]
            break
          }
        }
        if (!targetStep && turns.length > 1) {
          for (let t = turns.length - 2; t >= 0; t--) {
            for (let i = turns[t].steps.length - 1; i >= 0; i--) {
              if (turns[t].steps[i].toolCalls.some((c) => c.id === callId)) {
                targetStep = turns[t].steps[i]
                break
              }
            }
            if (targetStep) break
          }
        }
      }

      if (targetStep && callId) {
        let resText = extractTextContent(m.content)
        if (!resText && m.tool_result && m.tool_result.output !== undefined) {
          resText = typeof m.tool_result.output === 'string'
            ? m.tool_result.output
            : JSON.stringify(m.tool_result.output)
        }
        const isError = Boolean(m.tool_result && m.tool_result.cancelled)
        targetStep.toolResults.push({
          toolCallId: callId,
          content: [{ type: 'text', text: resText || '' }],
          isError,
        })
      } else {
        droppedToolResults++
      }
      continue
    }

    skipped++
  }

  // 无可导入内容
  if (turns.length === 0) {
    return {
      meta: null,
      events: [],
      turns: [],
      title: undefined,
      messages: 0,
      toolCalls: 0,
      skipped: rawRecords || 1,
      records: rawRecords,
      skippedLines,
      secrets,
      skipReason: 'no user turns found in Mistral Vibe session',
    }
  }

  const sessionId = mintSessionId(sourceId, 'import-vibe-')
  const meta = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: createdAt ?? Date.now(),
  }
  if (sourceId) meta.sourceId = sourceId
  if (cwd) meta.cwd = cwd

  const finalTitle = normalizeTitle(explicitTitle || (turns.length > 0 ? turns[0].prompt : ''))
  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, args.budget)

  const syn = synthesizeSession({
    meta,
    turns: seedTurns,
    title: explicitTitle ? finalTitle : undefined,
    provider: 'mistral-vibe',
    model,
    skipped,
    records: rawRecords,
    skippedLines,
    secrets,
    imported: { sourcePath: args.sourcePath },
    fullHistory: args.fullHistory,
  })

  return {
    ...syn,
    title: finalTitle,
    droppedToolResults,
    ...(trimmed ? { trimmed } : {}),
  }
}
