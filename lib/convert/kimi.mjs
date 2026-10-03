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
// 压缩（新 apply_compaction / 旧 CompactionEnd）：导入为 **DSH 原生压缩检查点**——全量历史
// 留在日志里，截点处发一次 compaction 事务（摘要作检查点；跨截点那一轮就地一分为二），模型
// 视角 = 摘要 + 截点之后的内容，与源一致；fullHistory:true 时不发检查点。旧格式 wire 只有
// 配对标记、**没有摘要载荷**（摘要只写 context.jsonl）时退化为既有切窗口并上报
// compactionSummaryMissing（不虚构摘要）。context.clear / context.undo 是同族破坏性生命周期
// 事件，暂不映射（截断语义与轮次模型差异大）。
// 标题：args.title（index 层从 state.json custom_title / 新态 isCustomTitle+title 读）
// > 首条 user 文本。args：sourcePath / sessionId / budget / kimiId / cwd / title 透传。

import {
  SESSION_FORMAT_VERSION,
  IMAGE_PLACEHOLDER,
  applyBudgetTrim,
  imageBlockFromSource,
  mintSessionId,
  parseJsonlLines,
  parseTime,
  parseTimeMs,
  synthesizeSession,
} from './core.mjs'

// 标题归一统一规则：去首尾空白、折叠内部空白；超 80 字符截断加省略号；
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
// 取 text/think，媒体部分（image_url 等）有可落地字节时产出 IR image 块，拿不到字节
// （Kimi 自有 blob 存储的 `blobref:<mime>;<hash>`，其 file/index.json 不映射该 hash）
// 则占位并回调 onMedia 计数——不再静默丢弃。
function mapToolOutput(output, onMedia) {
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
      } else if (part.type === 'image_url' || part.type === 'image'
        || part.type === 'video_url' || part.type === 'audio_url') {
        const img = imageBlockFromSource(part)
        if (img) blocks.push(img)
        else {
          if (typeof onMedia === 'function') onMedia()
          blocks.push({ type: 'text', text: IMAGE_PLACEHOLDER })
        }
      }
    }
    return blocks
  }
  return []
}

// 工具结果文本兜底：output 为空时回退 return_value.message（对模型的说明文本），
// 避免空结果吞掉可见信息；output 非空时以 output 为准（message 是补充说明）。
function toolResultContent(returnValue, onMedia) {
  const rv = returnValue && typeof returnValue === 'object' ? returnValue : {}
  const blocks = mapToolOutput(rv.output, onMedia)
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
  // 逐行解析带行号明细（畸形行计数不设限，明细封顶 200）+ secrets 位置
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
  // 拿不到字节的媒体块数（Kimi 的 blobref 引用无法解析）：以 [image] 占位并计数
  let imagesDegraded = 0
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

  // 当前步骤构造：行级时间戳（recTime）透传进 IR；null 不占键
  const mkStep = (time) => {
    const s = { content: [], toolCalls: [], toolResults: [] }
    if (time !== null) s.time = time
    return s
  }

  // 压缩截点标记：截点前已建的轮次与进行中步骤退出模型视角（压缩丢弃全部
  // assistant/tool 内容，保留的 verbatim user 消息由摘要承载）；后续内容开新步骤。
  // cur 缺省（轮间）时 turn 记为已建轮数 → 截点前轮次全部丢弃。
  const markCompactionCut = (summaryText, time) => {
    compactionCut = {
      turn: cur ? turns.length - 1 : turns.length,
      step: cur ? cur.steps.length : 0,
      summary: summaryText,
      ...(time !== null && time !== undefined ? { time } : {}),
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
    // 行级时间戳 → IR time（逐步模型耗时 / 工具耗时的原料；null 时 advance 自然跳过）
    const recTime = parseTimeMs(recTs)

    if (isNewWire) {
      const type = rec.type
      if (type === 'turn.prompt') {
        const prompt = kimiUserInputText(rec.input).trim()
        if (!prompt) continue
        cur = { prompt, steps: [] }
        if (recTime !== null) cur.time = recTime
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
        if (recTime !== null) cur.time = recTime
        turns.push(cur)
        step = null
        if (firstUserText === null) firstUserText = prompt
      } else if (type === 'context.append_loop_event') {
        const event = rec.event && typeof rec.event === 'object' ? rec.event : {}
        const et = event.type
        if (et === 'step.begin') {
          if (!cur) continue
          step = mkStep(recTime)
          cur.steps.push(step)
        } else if (et === 'content.part') {
          if (!cur) continue
          if (!step) {
            step = mkStep(recTime)
            cur.steps.push(step)
          }
          const part = event.part && typeof event.part === 'object' ? event.part : {}
          if (part.type === 'text' && typeof part.text === 'string' && part.text) {
            appendContent({ type: 'text', text: part.text })
          } else if (part.type === 'think' && typeof part.think === 'string' && part.think) {
            appendContent({ type: 'reasoning', text: part.think })
          } else if (part.type === 'image_url' || part.type === 'image'
            || part.type === 'video_url' || part.type === 'audio_url') {
            // Kimi 的媒体引用是自有 blob 存储的 `blobref:<mime>;<hash>`（其 file/index.json
            // 不映射该 hash，插件无法解析字节）→ 占位 + 计数；若某天 wire 直接带 data URL，
            // imageBlockFromSource 会照常产出可落地的 IR image 块。
            const img = imageBlockFromSource(part)
            if (img) appendContent(img)
            else { imagesDegraded++; appendContent({ type: 'text', text: IMAGE_PLACEHOLDER }) }
          }
        } else if (et === 'tool.call') {
          if (!cur) continue
          if (!step) {
            step = mkStep(recTime)
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
            ...(recTime !== null ? { time: recTime } : {}),
            content: toolResultContent(rv, () => { imagesDegraded++ }),
            isError: rv.is_error === true,
          })
        } else if (et === 'step.end') {
          step = null
        }
      } else if (type === 'context.apply_compaction') {
        // 上下文压缩落点（自动与 full compaction 流程都经此 durable 记录）：
        // 记截点 + 摘要，压缩后的视角由循环继续自然建轮/建步
        markCompactionCut(compactionSummaryText(rec), recTime)
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
      if (recTime !== null) cur.time = recTime
      turns.push(cur)
      step = null
      if (firstUserText === null) firstUserText = prompt
    } else if (type === 'TurnEnd') {
      step = null
    } else if (type === 'StepBegin') {
      if (!cur) continue
      step = mkStep(recTime)
      cur.steps.push(step)
    } else if (type === 'TextPart' || type === 'ThinkPart') {
      if (!cur) continue
      // 无 StepBegin 的内容（slash 命令回复等）挂当前轮隐式步骤，不丢可见文本
      if (!step) {
        step = mkStep(recTime)
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
        step = mkStep(recTime)
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
        ...(recTime !== null ? { time: recTime } : {}),
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
        markCompactionCut('', recTime)
      }
    }
    // 其余事件（StatusUpdate / StepInterrupted / ApprovalRequest /
    // ToolCallPart / Notification / PlanDisplay / Btw* / Hook* / MCP*）为状态、控制或
    // 流式分块事件：不产生对话内容，跳过
  }

  // 原生压缩检查点（见 lib/convert/events.mjs）：现代载体 `context.apply_compaction` 带摘要
  // → 截点之前的轮与「进行中轮在截点前已建的步骤」是 log-only（正文照常留在日志里），跨截点
  // 那一轮**就地一分为二**：前段标 shadowed，后段作为边界轮（空 prompt，检查点即它的 user 侧
  // 消息）。截点前后模型视角 = 摘要 + 截点之后的内容，与源一致。
  //
  // 旧格式 wire（CompactionBegin/End 配对）只有标记、**没有摘要载荷**（摘要只写
  // context.jsonl，不在 wire 里）→ 无从还原源侧摘要。这种情况保持既有的切窗口：宁可日志里
  // 丢前段，也不给模型一条空摘要（且显式上报 compactionSummaryMissing，不静默）。
  let compactionSummaryMissing = false
  if (compactionCut && args.fullHistory !== true) {
    if (compactionCut.summary) {
      const cutTurn = compactionCut.turn
      const straddle = turns[cutTurn] || null
      const head = straddle ? straddle.steps.slice(0, compactionCut.step) : []
      const tail = straddle ? straddle.steps.slice(compactionCut.step) : null
      const pre = turns.slice(0, cutTurn)
      const rest = turns.slice(cutTurn + (straddle ? 1 : 0))
      // 可遮蔽内容 = 截点之前的轮 / 步骤，或跨界轮自己的提问（它也会发一条 user/message）
      const shadowable = pre.length > 0 || head.length > 0
        || (straddle !== null && String(straddle.prompt ?? '').trim() !== '')
      if (shadowable) {
        for (const t of pre) t.shadowed = true
        const rebuilt = [...pre]
        if (straddle) rebuilt.push({ ...straddle, steps: head, shadowed: true })
        const checkpoint = { summary: compactionCut.summary, provider: 'kimi', model: 'kimi', ...(compactionCut.time !== undefined ? { time: compactionCut.time } : {}) }
        if (tail && tail.length > 0) {
          rebuilt.push({ prompt: '', steps: tail, compaction: checkpoint }, ...rest)
        } else if (rest.length > 0) {
          // 截点落在轮之间：检查点挂到截点之后的第一个轮（该轮自己的提问保持可见）
          rebuilt.push({ ...rest[0], compaction: checkpoint }, ...rest.slice(1))
        } else {
          // 压缩之后什么都没有：留一个只装检查点的边界轮，否则边界无处发射
          rebuilt.push({ prompt: '', steps: [], compaction: checkpoint })
        }
        turns.length = 0
        turns.push(...rebuilt)
      } else {
        // 截点之前没有可遮蔽的会话节点（wire 以压缩摘要开头）：宿主不变式要求 shadowedSeqs
        // 非空 → 发不出检查点。摘要退回既有形态（首个可用步骤的 reasoning 块），不虚构也不
        // 丢正文；连轮都没有（wire 只有一条 apply_compaction）时不造轮，由导入层按
        // 「无用户回合」跳过并上报。
        const host = straddle || turns[0] || null
        if (host) {
          if (host.steps.length === 0) host.steps.push(mkStep(null))
          host.steps[0].content.unshift({ type: 'reasoning', text: compactionCut.summary })
        }
      }
    } else {
      compactionSummaryMissing = true
      turns.splice(0, compactionCut.turn)
      if (turns.length > 0 && compactionCut.step > 0) turns[0].steps.splice(0, compactionCut.step)
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

  // 标题：args.title（state.json custom_title，显式）钉 session/title 事件；
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
  // compacted/compactions：原生压缩检查点（syn.compactions）是实际发射的检查点数；
  // 旧格式 wire 无摘要、退化为切窗口时以 compactionSummaryMissing 显式点名前段已丢。
  return {
    ...syn,
    title: finalTitle,
    droppedToolResults,
    subagentEvents,
    // 图片/媒体降级数（>0 才占键）：blobref 引用无法解析时以 [image] 占位导入的张数
    ...(imagesDegraded > 0 ? { imagesDegraded } : {}),
    ...(syn.compactions ? { compacted: true } : {}),
    ...(compactionSummaryMissing ? { compactionSummaryMissing: true } : {}),
    ...(trimmed ? { trimmed } : {}),
  }
}
