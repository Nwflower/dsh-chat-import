// lib/convert/dsh.mjs — DSH 自身会话日志（session.jsonl / session.jsonl.zstd）
// → DSH 会话事件。DSH 事件日志本就是目标格式：保留对话核心事件并重排 seq，
// 丢弃流式 chunk 与运行时安全/头状态（导入会话由新宿主重新生成这些状态）。
import { mintSessionId } from './core.mjs'

const DURABLE = new Set([
  'turn/start',
  'step/start',
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'step/end',
  'turn/end',
  'session/title',
])

function safeText(blocks) {
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      return b.text.trim().replace(/\s+/g, ' ').slice(0, 80)
    }
  }
  return ''
}

export function convertDshJsonl(raw, args = {}) {
  const lines = String(raw || '').split('\n')
  const parsed = []
  let skippedLines = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      parsed.push({ line: i + 1, value: JSON.parse(line) })
    } catch {
      // 畸形行：计入 skipped（DSH 日志尾部的流式行可能是完整 JSON 才忽略）
      skippedLines++
    }
  }

  const sessionRec = parsed.find((p) => p.value && p.value.type === 'session' && p.value.id)?.value || {}
  const headerRec = parsed.find((p) => p.value && p.value.type === 'request/header' && p.value.data && p.value.data.header)?.value
  const header = headerRec ? headerRec.data.header : null
  const config = header && header.config && typeof header.config === 'object' ? header.config : {}

  const sourceId = String(sessionRec.id || '')
  const fileStem = String(args.sourcePath || '').split(/[\\/]/).pop() || ''
  const idSlug = sourceId || fileStem.replace(/\.jsonl(?:\.zstd)?$/i, '')
  const metaId = mintSessionId(idSlug)

  const createdAt = Number.isFinite(sessionRec.createdAt)
    ? sessionRec.createdAt
    : (parsed.find((p) => p.value && typeof p.value.time === 'number')?.value?.time ?? Date.now())

  const sourceEvents = []
  const oldToNew = new Map()
  let skipped = skippedLines
  for (const p of parsed) {
    const ev = p.value
    if (!ev || typeof ev !== 'object') continue
    if (!DURABLE.has(ev.type)) continue
    if (!Number.isFinite(ev.seq)) continue
    const data = ev.data && typeof ev.data === 'object' ? ev.data : {}
    const next = {
      type: ev.type,
      seq: sourceEvents.length,
      time: Number.isFinite(ev.time) ? ev.time : createdAt,
      data,
    }
    if (typeof ev.surfaceOp === 'string') next.surfaceOp = ev.surfaceOp
    // 保留 tool/result → tool/call 关联（原值是重排前 seq，下方 oldToNew 统一重映射）
    if (Array.isArray(ev.sourceEventSeqs)) next.sourceEventSeqs = ev.sourceEventSeqs
    oldToNew.set(ev.seq, next.seq)
    sourceEvents.push(next)
  }

  // sourceEventSeqs 重映射到新 seq（指向日志内部事件）。
  for (const ev of sourceEvents) {
    if (Array.isArray(ev.sourceEventSeqs)) {
      ev.sourceEventSeqs = ev.sourceEventSeqs.map((s) => (oldToNew.has(s) ? oldToNew.get(s) : s))
    }
  }

  const titleEvent = [...sourceEvents].reverse().find((e) => e.type === 'session/title' && e.data && typeof e.data.title === 'string')
  const title = titleEvent ? String(titleEvent.data.title) : (() => {
    const u = sourceEvents.find((e) => e.type === 'user/message' && e.data && Array.isArray(e.data.content))
    return u ? safeText(u.data.content) : ''
  })()

  const model = (() => {
    if (typeof config.model === 'string') return config.model
    const a = [...sourceEvents].reverse().find((e) => e.type === 'assistant/message' && e.data && e.data.message && e.data.message.source && typeof e.data.message.source.model === 'string')
    return a ? a.data.message.source.model : undefined
  })()
  const provider = (() => {
    if (typeof config.provider === 'string') return config.provider
    const a = [...sourceEvents].reverse().find((e) => e.type === 'assistant/message' && e.data && e.data.message && e.data.message.source && typeof e.data.message.source.provider === 'string')
    return a ? a.data.message.source.provider : 'dsh'
  })()

  // turns IR（REQ-24 增量续写依赖真实轮次，不能只给计数）：按 turn/start 分组，
  // 每轮 prompt = 首个 user/message 文本，steps = 该轮 assistant 消息（含工具）。
  // tool/result 挂到同轮最近的 tool/call 所在 step（DSH 日志 tool/result 在 step/end 前）。
  const turns = []
  const turnOrder = []
  for (const ev of sourceEvents) {
    if (ev.type === 'turn/start') {
      turnOrder.push(turns.length)
      turns.push({ prompt: '', steps: [] })
    }
  }
  const stepByTurn = new Map() // turnIndex -> stepIndex
  let curTurn = -1
  let curStep = -1
  for (const ev of sourceEvents) {
    if (ev.type === 'turn/start') {
      curTurn++
      curStep = -1
      stepByTurn.set(curTurn, -1)
    } else if (ev.type === 'assistant/message') {
      curStep++
      if (curTurn >= 0) {
        const t = turns[curTurn]
        if (!t.steps[curStep]) t.steps[curStep] = { content: [], toolCalls: [], toolResults: [] }
        const blocks = ev.data && ev.data.message && Array.isArray(ev.data.message.content) ? ev.data.message.content : []
        for (const b of blocks) {
          if (b && b.type === 'text' && typeof b.text === 'string') {
            t.steps[curStep].content.push({ type: 'text', text: b.text })
          } else if (b && b.type === 'tool-call') {
            t.steps[curStep].content.push(b)
            t.steps[curStep].toolCalls.push(b)
          }
        }
        stepByTurn.set(curTurn, curStep)
      }
    } else if (ev.type === 'user/message') {
      if (curTurn >= 0 && turns[curTurn].prompt === '') {
        const blocks = ev.data && Array.isArray(ev.data.content) ? ev.data.content : []
        const text = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
        if (text) turns[curTurn].prompt = text
      }
    } else if (ev.type === 'tool/result') {
      const tid = ev.data && ev.data.toolCallId
      if (curTurn >= 0 && tid) {
        const t = turns[curTurn]
        const stepIdx = stepByTurn.get(curTurn) ?? -1
        const step = stepIdx >= 0 ? t.steps[stepIdx] : null
        if (step) step.toolResults.push({ toolCallId: tid, content: [], isError: !!(ev.data && ev.data.isError) })
      }
    }
  }
  for (const t of turns) {
    t.steps = t.steps.filter(Boolean)
  }
  const messages = sourceEvents.filter((e) => e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result').length
  const toolCalls = sourceEvents.filter((e) => e.type === 'tool/call').length

  // 事件净化（issue #34）：dsh ≥ 0.1.2-alpha 的读取路径按 envelope 键白名单
  //（type/seq/time/data/surfaceOp/sourceEventSeqs）与事件类型白名单 fail-closed——
  // 旧插件版本写入的 session/imported 标记、ignorable 等词汇表外键会让整份日志被拒载。
  // 导入即净化：过滤历史标记、键收敛到白名单、seq 密集重排（sourceEventSeqs 引用
  // 同步重映射），保证重导产物在新旧宿主上都能打开。
  const events = []
  const seqMap = new Map()
  let nextSeq = 0
  for (const ev of sourceEvents) {
    if (!ev || typeof ev.type !== 'string') continue
    if (ev.type === 'session/imported') continue
    const out = {
      type: ev.type,
      seq: nextSeq,
      time: typeof ev.time === 'number' ? ev.time : createdAt,
      data: ev.data === undefined ? {} : ev.data,
    }
    if (typeof ev.surfaceOp === 'string') out.surfaceOp = ev.surfaceOp
    if (Array.isArray(ev.sourceEventSeqs)) out.sourceEventSeqs = ev.sourceEventSeqs
    seqMap.set(ev.seq, nextSeq)
    events.push(out)
    nextSeq++
  }
  for (const ev of events) {
    if (ev.sourceEventSeqs) ev.sourceEventSeqs = ev.sourceEventSeqs.map((s) => seqMap.get(s) ?? s)
  }

  return {
    meta: {
      id: metaId,
      sourceId: sourceId || idSlug,
      cwd: typeof sessionRec.cwd === 'string' ? sessionRec.cwd : undefined,
      createdAt,
      provider,
      model,
    },
    events,
    turns,
    title,
    messages,
    toolCalls,
    skipped,
  }
}
