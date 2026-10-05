// lib/convert/hermes.mjs — Hermes（本地 AI 编码 CLI）会话 → DSH 会话（纯函数，第 11 源）
//
// Hermes 双源会话统一转换（cc-switch 同款语义）：中间 JSON（index 层从 state.db
// 抽取，见 lib/hermes.mjs readHermesDb）或 JSONL 文本（sessions/*.jsonl|.json
// 回退）：
//   flat    {role, content, ts}
//   nested  {type:"session"|"message", message:{role, content}, timestamp}
// 判别：整体 JSON.parse 出带 messages 数组的对象 → 中间 JSON；否则按行解析 →
// JSONL（单行 JSONL 恰好含整会话对象时也能正确走中间 JSON 分支）。session/init
// 行提供 id/title/cwd/model 元数据（首个非空胜出，对齐 cc-switch scan）；createdAt
// 取首条消息时间戳。无任何可解析记录（records===0）返回空 meta（畸形/空输入）。
//
// content 为 string 或 Claude 风格 block 数组。assistant 的 text/thinking/tool_use
// 经 mapContentBlock 映射（tool_use 同时登记 tool/call）；user 消息的 tool_result
// 块按 tool_use_id 挂回 call 所属 step（跨 step 也行，与 claude.mjs 同款），孤儿
// 结果丢弃并计数上报 droppedToolResults；user 的 string/text 块开新轮（tool_result
// 独占消息不开轮），assistant 消息 = 一步。无前驱提问的孤儿 assistant 丢弃（回合
// 平衡）。标题归一（80 字符截断）后走 synthesizeSession，provider='hermes'。
import {
  SESSION_FORMAT_VERSION,
  applyBudgetTrim,
  mapContentBlock,
  mintSessionId,
  parseJsonlLines,
  parseTime,
  parseTimeMs,
  synthesizeSession,
} from './core.mjs'
import { contentText, normalizeTitle } from './util.mjs'
import { alignStepResults } from './ir.mjs'

// 时间戳 → 毫秒，拿不到为 undefined。秒值截断到整秒（对齐 cc-switch 的
// parse_timestamp_to_ms）；SQLite 读取层（lib/sources/hermes.mjs）与 JSONL 共用。
export function parseHermesTime(value) {
  return parseTimeMs(value, { truncSeconds: true }) ?? undefined
}

export function convertHermesJson(raw, args = {}) {
  let chat = null
  try {
    chat = JSON.parse(raw)
  } catch {
    // 非整体 JSON → 按 JSONL 逐行解析
  }

  const messages = []
  let sourceId = null
  let title = null
  let cwd = null
  let model = null
  let createdAt = null
  let records = 0
  let skipped = 0
  // 畸形行行号明细（封顶 200）与疑似 secrets 位置（JSONL 分支填充）
  const skippedLines = []
  const secrets = []

  if (chat && typeof chat === 'object' && !Array.isArray(chat) && Array.isArray(chat.messages)) {
    // 中间 JSON（readHermesDb 抽取的单会话形态）
    sourceId = typeof chat.id === 'string' && chat.id ? chat.id : null
    title = typeof chat.title === 'string' && chat.title ? chat.title : null
    cwd = typeof chat.cwd === 'string' && chat.cwd ? chat.cwd : (typeof chat.directory === 'string' && chat.directory ? chat.directory : null)
    model = typeof chat.model === 'string' && chat.model ? chat.model : null
    createdAt = chat.createdAt
    records = chat.messages.length
    for (const m of chat.messages) {
      if (!m || typeof m !== 'object' || typeof m.role !== 'string') {
        skipped++
        continue
      }
      // readHermesDb 变体列（toolCalls / reasoning）透传给消息形状
      messages.push({
        role: m.role,
        content: m.content,
        ts: m.ts,
        ...(Array.isArray(m.toolCalls) ? { toolCalls: m.toolCalls } : {}),
        ...(typeof m.reasoning === 'string' && m.reasoning ? { reasoning: m.reasoning } : {}),
      })
    }
  } else {
    // JSONL：逐行解析；畸形行计数 skipped + 行号明细 + secrets 位置。
    // requireObject：解析成功但非对象（null/标量）同样算畸形行并记明细
    const parsed = parseJsonlLines(raw, { requireObject: true })
    skipped += parsed.skipped
    skippedLines.push(...parsed.skippedLines)
    secrets.push(...parsed.secrets)
    let firstTs = null
    for (const rec of parsed.recs) {
      records++
      const type = typeof rec.type === 'string' ? rec.type : ''
      if (type === 'session' || type === 'init') {
        // 会话元数据行：id/title/cwd/model（首个非空胜出）
        if (!sourceId) {
          const sid = typeof rec.id === 'string' ? rec.id : (typeof rec.sessionId === 'string' ? rec.sessionId : null)
          if (sid) sourceId = sid
        }
        if (!title && typeof rec.title === 'string' && rec.title) title = rec.title
        if (!cwd) {
          const d = typeof rec.cwd === 'string' ? rec.cwd : (typeof rec.directory === 'string' ? rec.directory : null)
          if (d) cwd = d
        }
        if (!model && typeof rec.model === 'string' && rec.model) model = rec.model
        continue
      }
      const msg = type === 'message' && rec.message && typeof rec.message === 'object' ? rec.message : rec
      const role = typeof msg.role === 'string' ? msg.role : null
      if (!role) {
        // 结构合法但非消息记录（无 role）：只计数，不记行号明细（非畸形行）
        skipped++
        continue
      }
      const ts = parseHermesTime(rec.timestamp ?? rec.ts ?? msg.timestamp ?? msg.ts)
      if (firstTs === null && ts !== undefined) firstTs = ts
      messages.push({ role, content: msg.content, ts })
    }
    if (createdAt === null) createdAt = firstTs
  }

  if (records === 0) {
    return { meta: null, events: [], turns: [], title: undefined, messages: 0, toolCalls: 0, skipped, records: 0, skippedLines, secrets }
  }

  const turns = []
  let cur = null
  // tool_use_id → 所属 step：tool_result 后置（可能跨 step 到达），按 id 挂回调用 step
  const callSteps = new Map()
  let droppedToolResults = 0
  // 开关开启时收集 system（系统提示词）文本，作为上下文注入保留
  let systemPrompt = null

  for (const m of messages) {
    if (m.role === 'system') {
      if (args.importSystemPrompt === true) {
        const text = contentText(m.content, { types: null, trim: true })
        if (text) systemPrompt = systemPrompt ? systemPrompt + '\n\n' + text : text
      }
      continue
    }
    if (m.role === 'user') {
      const texts = []
      const results = []
      if (typeof m.content === 'string') {
        if (m.content.trim()) texts.push(m.content)
      } else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b && typeof b === 'object' && b.type === 'tool_result') {
            results.push(b)
          } else if (b && typeof b === 'object' && typeof b.text === 'string' && b.text) {
            texts.push(b.text)
          }
        }
      }
      for (const r of results) {
        const callId = typeof r.tool_use_id === 'string' ? r.tool_use_id : (typeof r.tool_call_id === 'string' ? r.tool_call_id : null)
        const step = callId !== null ? callSteps.get(callId) : undefined
        if (!step) {
          // 孤儿工具结果：转录里没有对应 tool_use（中途开始）→ 丢弃并计数
          droppedToolResults++
          continue
        }
        const inner = (Array.isArray(r.content) ? r.content : [r.content])
          .map(mapContentBlock)
          .filter(Boolean)
        step.toolResults.push({
          toolCallId: callId,
          ...(typeof m.ts === 'number' ? { time: m.ts } : {}),
          content: inner,
          isError: r.is_error === true,
        })
      }
      const prompt = texts.map((s) => s.trim()).filter(Boolean).join('\n')
      if (prompt) {
        cur = { prompt, steps: [] }
        if (typeof m.ts === 'number') cur.time = m.ts
        turns.push(cur)
      }
    } else if (m.role === 'assistant') {
      if (!cur) continue // 无前驱提问的孤儿 assistant：丢弃保持回合平衡
      const step = { content: [], toolCalls: [], toolResults: [] }
      if (typeof m.ts === 'number') step.time = m.ts
      // hermes-agent 变体：reasoning 独立列 → 前置 reasoning 块
      if (typeof m.reasoning === 'string' && m.reasoning.trim()) {
        step.content.push({ type: 'reasoning', text: m.reasoning })
      }
      if (typeof m.content === 'string') {
        if (m.content.trim()) step.content.push({ type: 'text', text: m.content })
      } else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          const mapped = mapContentBlock(b)
          if (!mapped) continue
          if (mapped.type === 'tool-call') {
            step.content.push(mapped)
            step.toolCalls.push(mapped)
          } else {
            step.content.push(mapped)
          }
        }
      }
      // tool_calls 独立列（JSON 文本已在读取层解析）→ tool-call 块
      if (Array.isArray(m.toolCalls)) {
        for (const tc of m.toolCalls) {
          if (!tc || typeof tc !== 'object' || typeof tc.id !== 'string' || typeof tc.name !== 'string') continue
          const block = {
            type: 'tool-call',
            id: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.input ?? {}),
          }
          step.content.push(block)
          step.toolCalls.push(block)
        }
      }
      if (step.content.length === 0 && step.toolCalls.length === 0) continue // 空 step 不入轮
      cur.steps.push(step)
      for (const tc of step.toolCalls) callSteps.set(tc.id, step)
    }
  }

  alignStepResults(turns)

  const sessionId = args.sessionId || mintSessionId(sourceId || (typeof args.fileStem === 'string' ? args.fileStem : undefined))
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: parseTime(createdAt) }
  if (sourceId) meta.sourceId = sourceId
  if (cwd) meta.cwd = cwd

  // 标题：显式标题（session/title 记录）钉住；否则回填首问（DSH 自动回退同结果）
  const finalTitle = normalizeTitle(title || (turns.length > 0 ? turns[0].prompt : ''))
  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, args.budget)
  const out = synthesizeSession({
    meta,
    turns: seedTurns,
    title: title ? finalTitle : undefined,
    provider: 'hermes',
    model,
    skipped,
    records,
    skippedLines,
    secrets,
    imported: { sourcePath: args.sourcePath },
    systemPrompt,
  })
  return { ...out, title: finalTitle, droppedToolResults, ...(trimmed ? { trimmed } : {}) }
}

