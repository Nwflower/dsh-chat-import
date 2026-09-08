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
// 上下文压缩（kimi-cli soul/kimisoul.py）：CompactionBegin…CompactionEnd 成对标记，
//   压缩失败只发 Begin 不发 End；标记无载荷，摘要只写 context.jsonl 不进 wire，
//   截点前内容按「已压缩丢弃」处理（无摘要可前置）。
// 其余（StatusUpdate / Notification / ApprovalRequest 等）为状态或控制事件，跳过。
//
// 新 wire.jsonl 每行直接是 `{type, time, …}` 对象，关键事件：
//   turn.prompt {input: ContentPart[]} —— 用户输入；
//   context.append_message {message:{role:'user', content}} —— 用户消息落上下文（与
//     turn.prompt 成对出现，转换层按同文本去重：成对记录跳过，不同文本开新轮）；
//   context.append_loop_event {event:{type:'step.begin'|'content.part'|'tool.call'|
//     'tool.result'|'step.end', …}} —— assistant 内容 / 工具调用与结果；
//   context.apply_compaction {summary|contextSummary, compactedCount, …} —— 上下文
//     压缩落点（agent-core-v2 ContextApplyCompaction，durable）：压缩后模型视角 =
//     保留的 verbatim user 消息 + 单条 user-role 摘要，assistant/tool 内容全部丢弃；
//   turn.ended {reason} —— 回合结束。
// 消息 → 回合映射：TurnBegin/SteerInput 或 turn.prompt → 新轮（prompt）；步骤内
// content 块 + toolCalls + toolResults → synthesizeSession（配对不变量与其余源一致）。
// 压缩（新 apply_compaction / 旧 CompactionEnd）：只保留最后一次压缩之后的模型视角，
// 摘要作 reasoning 块前置（opencode/zcode/pi/claude REQ-22 同款语义），避免把源已
// 压掉的前段全量历史灌回导入会话撑爆预算。context.clear / context.undo 是同族破坏性
// 生命周期事件，暂不映射（截断语义与轮次模型差异大）。
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

// context.apply_compaction payload → 摘要文本。三种变体（agent-core-v2 contextEvents
// z.union）：当前变体 summary 是字符串（媒体降级时模型可见变体在 contextSummary）；
// legacy 变体 summary 是 ContextMessage（取 text 部件 '\n' 拼接，kimi-code vis
// contextMessageText 同款）。无摘要返回空串。
function compactionSummaryText(payload) {
  if (!payload || typeof payload !== 'object') return ''
  const s = payload.summary
  if (typeof s === 'string') return s.trim()
  if (s && typeof s === 'object' && Array.isArray(s.content)) {
    const parts = []
    for (const p of s.content) {
      if (p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string' && p.text) parts.push(p.text)
    }
    const joined = parts.join('\n').trim()
    if (joined) return joined
  }
  return typeof payload.contextSummary === 'string' ? payload.contextSummary.trim() : ''
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
  // 上下文压缩截点 { turn, step, summary }：turn/step 记录截点时刻已建轮数/当前轮内
  // 已建步骤数，summary 是压缩摘要（新格式 apply_compaction 携带；旧格式 wire 只有
  // 配对标记、摘要只写 context.jsonl，置空）。多次压缩取最后一次（最终模型视角）。
  let compactionCut = null
  // 旧格式 CompactionBegin…End 配对守卫：压缩失败只发 Begin 不发 End，不成截点
  let compactionRunning = false

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

  // 压缩截点标记：截点前已建的轮次与进行中步骤退出模型视角（压缩丢弃全部
  // assistant/tool 内容，保留的 verbatim user 消息由摘要承载）；后续内容开新步骤。
  // cur 缺省（轮间）时 turn 记为已建轮数 → 截点前轮次全部丢弃。
  const markCompactionCut = (summaryText) => {
    compactionCut = {
      turn: cur ? turns.length - 1 : turns.length,
      step: cur ? cur.steps.length : 0,
      summary: summaryText,
    }
    step = null
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
        const message = rec.message && typeof rec.message === 'object' ? rec.message : {}
        if (message.role !== 'user') continue
        const prompt = kimiUserInputText(message.content).trim()
        if (!prompt) continue
        // turn.prompt 已建同文本轮 → append_message 是其成对落盘记录，跳过避免重复；
        // 不同文本是新的用户消息（压缩后续聊 / steer 追加 / 无 turn.prompt 的 wire）
        // → 开新轮，与旧格式 SteerInput「每条用户输入一轮」的回合模型一致
        if (cur && cur.prompt === prompt) continue
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
      } else if (type === 'context.apply_compaction') {
        // 上下文压缩落点（自动与 full compaction 流程都经此 durable 记录）：
        // 记截点 + 摘要，压缩后的视角由循环继续自然建轮/建步
        markCompactionCut(compactionSummaryText(rec))
      } else if (type === 'turn.ended') {
        step = null
      }
      // 其余新事件（metadata / profile.bind / config.update / llm.request / usage.record
      // / plugin.session_start / llm.tools_snapshot / permission.set_mode 等）为状态或
      // 内部请求记录，不产生对话内容，跳过；context.clear / context.undo 同为破坏性
      // 生命周期事件，暂不映射（见文件头注释）
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
    } else if (type === 'CompactionBegin') {
      // 压缩开始：只立配对守卫，不成截点（失败路径只发 Begin 不发 End）
      compactionRunning = true
    } else if (type === 'CompactionEnd') {
      // 压缩完成：成截点（wire 无摘要载荷，只写 context.jsonl → summary 置空）
      if (compactionRunning) {
        compactionRunning = false
        markCompactionCut('')
      }
    }
    // 其余事件（StatusUpdate / StepInterrupted / ApprovalRequest /
    // ToolCallPart / Notification / PlanDisplay / Btw* / Hook* / MCP*）为状态、控制或
    // 流式分块事件：不产生对话内容，跳过
  }

  // 尊重源上下文压缩（opencode/zcode/pi 同款语义）：丢弃截点前的轮次与当前轮截点前
  // 的步骤——那些内容已被源压缩退出模型视角，全量导入会把 pre-compaction 历史灌回
  // 导入会话撑爆预算（REQ-37 被动裁剪保的是「导入预算的锚点+尾部」，并非「源模型
  // 实际所见」）。步骤级截断天然保配对：tool/result 挂在 callSteps 声明的 step 上，
  // 调用与结果随 step 同进同退，不会产生孤立半对。
  if (compactionCut) {
    turns.splice(0, compactionCut.turn)
    if (turns.length > 0 && compactionCut.step > 0) turns[0].steps.splice(0, compactionCut.step)
    // 摘要 → reasoning 块前置到首个保留步骤（REQ-22 claude compacted 同款）。摘要文本
    // 可空（旧格式 wire 无摘要）。截断后无任何轮次（压缩先于首问且无后续内容）不虚构
    // 会话，空 turns 由导入层按 skipped 上报。
    if (compactionCut.summary && turns.length > 0) {
      const first = turns[0]
      if (first.steps.length === 0) first.steps.push({ content: [], toolCalls: [], toolResults: [] })
      first.steps[0].content.unshift({ type: 'reasoning', text: compactionCut.summary })
    }
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
  // compacted：压缩截断已生效（REQ-22 claude compacted 报告同款，imports.mjs 白名单键）
  return {
    ...syn,
    title: finalTitle,
    droppedToolResults,
    subagentEvents,
    ...(compactionCut ? { compacted: true } : {}),
    ...(trimmed ? { trimmed } : {}),
  }
}
