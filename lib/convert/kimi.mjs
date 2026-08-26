// lib/convert/kimi.mjs — Kimi CLI / Kimi Code 会话 wire.jsonl → DSH 会话（纯函数）
//
// 存储有两种布局，本转换器同时支持：
//   旧 Kimi CLI（MoonshotAI/kimi-cli 官方布局）：
//     ~/.kimi/sessions/<workdir-md5>/<session-id>/{wire.jsonl, context.jsonl, state.json}
//     ~/.kimi/kimi.json —— work_dirs: [{ path, kaos, last_session_id }]，md5(path) 即
//     sessions 下的目录名（kaos 非本地时前缀 `<kaos>_`）。
//   新 Kimi Code 独立版：
//     ~/.kimi-code/sessions/<workspace-id>/<session-id>/agents/main/wire.jsonl
//     ~/.kimi-code/sessions/<workspace-id>/<session-id>/state.json
//
// 旧 wire.jsonl 首行是 `{"type":"metadata","protocol_version":"…"}`，其后每行一条记录：
//   {"timestamp": <秒>, "message": {"type": "<PascalCase 事件名>", "payload": {…}}}
// 旧事件流（wire/types.py Event 联合 + kosong 流式回调）：
//   TurnBegin / SteerInput —— 用户输入（str 或 ContentPart 数组，TextPart 有 {text}）；
//   StepBegin {n} —— 新一轮 agent 步骤；TurnEnd —— 回合结束；
//   TextPart / ThinkPart —— assistant 内容（流式分块，需合并）；
//   ToolCall {id, function:{name, arguments}} —— 工具调用（arguments 是 JSON 字符串）；
//   ToolCallPart —— 流式参数分块（最终 ToolCall 已带完整参数，跳过）；
//   ToolResult {tool_call_id, return_value:{is_error, output, message, display}} —— 工具结果；
//   SubagentEvent —— 子代理事件镜像（主线程跳过计数，子代理有自己的 wire.jsonl）。
// 其余（StatusUpdate / Notification / ApprovalRequest / CompactionBegin 等）为状态或
// 控制事件，跳过。
//
// 新 wire.jsonl 每行直接是 `{type, time, …}` 对象，关键事件：
//   turn.prompt {input: ContentPart[]} —— 用户输入；
//   context.append_message {message:{role:'user', content}} —— 用户消息落上下文（与
//     turn.prompt 成对出现，转换层以 turn.prompt 建轮、append_message 兜底）；
//   context.append_loop_event {event:{type:'step.begin'|'content.part'|'tool.call'|
//     'tool.result'|'step.end', …}} —— assistant 内容 / 工具调用与结果；
//   turn.ended {reason} —— 回合结束。
// 消息 → 回合映射：TurnBegin/SteerInput 或 turn.prompt → 新轮（prompt）；步骤内
// content 块 + toolCalls + toolResults → synthesizeSession（配对不变量与其余源一致）。
// 标题：args.title（index 层从 state.json custom_title / 新态 isCustomTitle+title 读）
// > 首条 user 文本。args：sourcePath / sessionId / budget / kimiId / cwd / title 透传。

import {
  SESSION_FORMAT_VERSION,
  applyBudgetTrim,
  mintSessionId,
  parseJsonlLines,
  parseTime,
  synthesizeSession,
} from './core.mjs'

// REQ-27 标题归一统一规则：去首尾空白、折叠内部空白；超 80 字符截断加省略号；
// 空白返回空串。core.mjs 属禁改面，各源按文件内联同款（改规则需同步多处）。
const TITLE_MAX_LEN = 80
const TITLE_ELLIPSIS = '…'
function normalizeTitle(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return ''
  return t.length <= TITLE_MAX_LEN ? t : t.slice(0, TITLE_MAX_LEN - TITLE_ELLIPSIS.length) + TITLE_ELLIPSIS
}

// TurnBegin/SteerInput 的 user_input → 纯文本：字符串原样；ContentPart 数组取 text。
function kimiUserInputText(input) {
  if (typeof input === 'string') return input
  if (Array.isArray(input)) {
    return input
      .map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : ''))
      .join('')
  }
  return ''
}

// ToolResult.return_value.output → DSH content blocks：字符串按文本；ContentPart 数组
// 取 text/think（image/audio/video 等媒体无文本表示，跳过）。
function mapToolOutput(output) {
  if (typeof output === 'string') {
    const text = output.trim()
    return text ? [{ type: 'text', text }] : []
  }
  if (Array.isArray(output)) {
    const blocks = []
    for (const part of output) {
      if (!part || typeof part !== 'object') continue
      if (part.type === 'text' && typeof part.text === 'string' && part.text) {
        blocks.push({ type: 'text', text: part.text })
      } else if (part.type === 'think' && typeof part.think === 'string' && part.think) {
        blocks.push({ type: 'reasoning', text: part.think })
      }
    }
    return blocks
  }
  return []
}

// 工具结果文本兜底：output 为空时回退 return_value.message（对模型的说明文本），
// 避免空结果吞掉可见信息；output 非空时以 output 为准（message 是补充说明）。
function toolResultContent(returnValue) {
  const rv = returnValue && typeof returnValue === 'object' ? returnValue : {}
  const blocks = mapToolOutput(rv.output)
  if (blocks.length > 0) return blocks
  const message = typeof rv.message === 'string' && rv.message.trim() ? rv.message.trim() : ''
  return message ? [{ type: 'text', text: message }] : []
}

export function convertKimiWire(raw, args = {}) {
  // REQ-26：逐行解析带行号明细（畸形行计数不设限，明细封顶 200）+ secrets 位置
  const { recs, skipped, skippedLines, secrets } = parseJsonlLines(raw)

  let createdAt = null
  let firstUserText = null
  const turns = []
  let cur = null
  let step = null
  // callId → 声明它的 step：ToolResult 按 id 挂回 call 所在 step（synthesizeSession
  // 按会话级 callId 索引回填 sourceEventSeqs）
  const callSteps = new Map()
  const unresolved = []
  const resolved = new Set()
  let droppedToolResults = 0
  let subagentEvents = 0

  // 当前轮内追加内容块：连续同类流式分块（TextPart/ThinkPart）合并成单块。
  const appendContent = (block) => {
    const last = step.content[step.content.length - 1]
    if (last && last.type === block.type && block.type === 'text') {
      last.text += block.text
      return
    }
    if (last && last.type === block.type && block.type === 'reasoning') {
      last.text += block.text
      return
    }
    step.content.push(block)
  }

  for (const rec of recs) {
    if (!rec || typeof rec !== 'object') continue
    // 新 Kimi Code wire 每行直接是 {type,…}（context.append_message 也带 message 字段，
    // 但 message 是普通消息对象而非旧格式的 {type,payload}）；旧 Kimi CLI wire 每行是
    // {timestamp, message:{type,payload}}。两种格式在同一转换器内自动识别。
    const isNewWire = typeof rec.type === 'string' && !(rec.message && typeof rec.message === 'object' && typeof rec.message.type === 'string')
    const recTs = isNewWire ? (rec.time ?? rec.created_at ?? rec.timestamp) : rec.timestamp
    if (createdAt === null && recTs !== undefined) createdAt = parseTime(recTs)

    if (isNewWire) {
      const type = rec.type
      if (type === 'turn.prompt') {
        const prompt = kimiUserInputText(rec.input).trim()
        if (!prompt) continue
        cur = { prompt, steps: [] }
        turns.push(cur)
        step = null
        if (firstUserText === null) firstUserText = prompt
      } else if (type === 'context.append_message') {
        // turn.prompt 已建轮；这里只作为没有 turn.prompt 时的兜底，避免重复轮次
        if (cur) continue
        const message = rec.message && typeof rec.message === 'object' ? rec.message : {}
        if (message.role !== 'user') continue
        const prompt = kimiUserInputText(message.content).trim()
        if (!prompt) continue
        cur = { prompt, steps: [] }
        turns.push(cur)
        step = null
        if (firstUserText === null) firstUserText = prompt
      } else if (type === 'context.append_loop_event') {
        const event = rec.event && typeof rec.event === 'object' ? rec.event : {}
        const et = event.type
        if (et === 'step.begin') {
          if (!cur) continue
          step = { content: [], toolCalls: [], toolResults: [] }
          cur.steps.push(step)
        } else if (et === 'content.part') {
          if (!cur) continue
          if (!step) {
            step = { content: [], toolCalls: [], toolResults: [] }
            cur.steps.push(step)
          }
          const part = event.part && typeof event.part === 'object' ? event.part : {}
          if (part.type === 'text' && typeof part.text === 'string' && part.text) {
            appendContent({ type: 'text', text: part.text })
          } else if (part.type === 'think' && typeof part.think === 'string' && part.think) {
            appendContent({ type: 'reasoning', text: part.think })
          }
        } else if (et === 'tool.call') {
          if (!cur) continue
          if (!step) {
            step = { content: [], toolCalls: [], toolResults: [] }
            cur.steps.push(step)
          }
          const id = typeof event.toolCallId === 'string' ? event.toolCallId : ''
          const name = typeof event.name === 'string' ? event.name : ''
          if (!id || !name) continue
          const argumentsText = event.args !== undefined
            ? JSON.stringify(event.args ?? {})
            : '{}'
          const block = { type: 'tool-call', id, name, arguments: argumentsText }
          step.content.push(block)
          step.toolCalls.push(block)
          callSteps.set(id, step)
          unresolved.push(id)
        } else if (et === 'tool.result') {
          if (!cur) continue
          const callId = typeof event.toolCallId === 'string' ? event.toolCallId : ''
          if (!callId || !callSteps.has(callId) || resolved.has(callId)) {
            droppedToolResults++
            continue
          }
          resolved.add(callId)
          const i = unresolved.indexOf(callId)
          if (i !== -1) unresolved.splice(i, 1)
          const owner = callSteps.get(callId)
          if (!owner) { droppedToolResults++; continue }
          const rv = event.result && typeof event.result === 'object' ? event.result : {}
          owner.toolResults.push({
            toolCallId: callId,
            content: toolResultContent(rv),
            isError: rv.is_error === true,
          })
        } else if (et === 'step.end') {
          step = null
        }
      } else if (type === 'turn.ended') {
        step = null
      }
      // 其余新事件（metadata / profile.bind / config.update / llm.request / usage.record
      // / plugin.session_start / llm.tools_snapshot / permission.set_mode 等）为状态或
      // 内部请求记录，不产生对话内容，跳过
      continue
    }

    const msg = rec.message
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') continue
    const type = msg.type
    const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {}

    if (type === 'TurnBegin' || type === 'SteerInput') {
      // SteerInput 是回合进行中追加的用户输入（下一 step 前）——按用户消息开新轮，
      // 与其余源「每条 user 消息一轮」的回合模型一致
      const prompt = kimiUserInputText(payload.user_input).trim()
      if (!prompt) continue
      cur = { prompt, steps: [] }
      turns.push(cur)
      step = null
      if (firstUserText === null) firstUserText = prompt
    } else if (type === 'TurnEnd') {
      step = null
    } else if (type === 'StepBegin') {
      if (!cur) continue
      step = { content: [], toolCalls: [], toolResults: [] }
      cur.steps.push(step)
    } else if (type === 'TextPart' || type === 'ThinkPart') {
      if (!cur) continue
      // 无 StepBegin 的内容（slash 命令回复等）挂当前轮隐式步骤，不丢可见文本
      if (!step) {
        step = { content: [], toolCalls: [], toolResults: [] }
        cur.steps.push(step)
      }
      if (type === 'TextPart') {
        if (typeof payload.text === 'string' && payload.text) appendContent({ type: 'text', text: payload.text })
      } else if (typeof payload.think === 'string' && payload.think) {
        appendContent({ type: 'reasoning', text: payload.think })
      }
    } else if (type === 'ToolCall') {
      if (!cur) continue
      if (!step) {
        step = { content: [], toolCalls: [], toolResults: [] }
        cur.steps.push(step)
      }
      const id = typeof payload.id === 'string' ? payload.id : ''
      const fn = payload.function && typeof payload.function === 'object' ? payload.function : {}
      const name = typeof fn.name === 'string' ? fn.name : ''
      if (!id || !name) continue
      const argumentsText = typeof fn.arguments === 'string' && fn.arguments ? fn.arguments : '{}'
      const block = { type: 'tool-call', id, name, arguments: argumentsText }
      step.content.push(block)
      step.toolCalls.push(block)
      callSteps.set(id, step)
      unresolved.push(id)
    } else if (type === 'ToolResult') {
      if (!cur) continue
      const callId = typeof payload.tool_call_id === 'string' ? payload.tool_call_id : ''
      if (!callId || !callSteps.has(callId) || resolved.has(callId)) {
        // 孤儿结果（无对应调用 / 重复结果）丢弃计数（对齐 claude/openclaw 语义）
        droppedToolResults++
        continue
      }
      resolved.add(callId)
      const i = unresolved.indexOf(callId)
      if (i !== -1) unresolved.splice(i, 1)
      const owner = callSteps.get(callId)
      if (!owner) { droppedToolResults++; continue }
      owner.toolResults.push({
        toolCallId: callId,
        content: toolResultContent(payload.return_value),
        isError: !!(payload.return_value && typeof payload.return_value === 'object' && payload.return_value.is_error === true),
      })
    } else if (type === 'SubagentEvent') {
      // 子代理事件镜像（parent wire 里的 SubagentEvent 包内层事件）：主线程会话不
      // 展开子代理内部流转（父 Agent 工具的 ToolCall/ToolResult 已保留），跳过计数
      subagentEvents++
    }
    // 其余事件（StatusUpdate / StepInterrupted / CompactionBegin / ApprovalRequest /
    // ToolCallPart / Notification / PlanDisplay / Btw* / Hook* / MCP*）为状态、控制或
    // 流式分块事件：不产生对话内容，跳过
  }

  // 源会话 id：args.kimiId（index 层传会话目录名）> sourcePath 的会话目录名。
  // 新布局 wire 在 …/agents/main/wire.jsonl，会话目录要再向上两级。
  const fileStem = (() => {
    if (typeof args.sourcePath !== 'string') return null
    const segs = String(args.sourcePath).replace(/[\\/]+$/, '').split(/[\\/]/)
    const base = segs[segs.length - 1] || ''
    if (/^wire\.jsonl$/i.test(base)) {
      const parent = segs[segs.length - 2] || ''
      const grand = segs[segs.length - 3] || ''
      if (/^main$/i.test(parent) && /^agents$/i.test(grand)) return segs[segs.length - 4] || null
      return parent || null
    }
    return base.replace(/\.jsonl$/i, '') || null
  })()
  const srcId = (typeof args.kimiId === 'string' && args.kimiId) ? args.kimiId : (fileStem || null)
  const meta = {
    version: SESSION_FORMAT_VERSION,
    id: args.sessionId || mintSessionId(srcId),
    createdAt: createdAt ?? Date.now(),
  }
  if (srcId) meta.sourceId = srcId
  if (typeof args.cwd === 'string' && args.cwd) meta.cwd = args.cwd

  // REQ-27 标题：args.title（state.json custom_title，显式）钉 session/title 事件；
  // 首问只回填 out.title（DSH 自动回退首条 user 文本，钉与不钉结果相同）
  const customTitle = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : null
  const finalTitle = normalizeTitle(customTitle || firstUserText)
  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, args.budget)
  const syn = synthesizeSession({
    meta,
    turns: seedTurns,
    title: customTitle ? finalTitle : undefined,
    provider: 'kimi',
    model: 'kimi',
    skipped,
    records: recs.length,
    skippedLines,
    secrets,
    imported: { sourcePath: args.sourcePath },
  })
  return { ...syn, title: finalTitle, droppedToolResults, subagentEvents, ...(trimmed ? { trimmed } : {}) }
}
