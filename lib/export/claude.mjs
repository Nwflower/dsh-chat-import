// lib/export/claude.mjs — DSH 会话事件 → Claude Code JSONL 序列化器（纯函数，零 DSH 依赖）
//
// 与 lib/convert/ 相对：convert 把外部 transcript 合成 DSH 事件日志（导入），本模块
// 把 DSH 事件日志（只读来源）反向序列化为 Claude Code JSONL（导出），
// 目标可被真实 Claude Code `--resume` 加载。记录顺序 = DSH seq 顺序；文件布局：
//   line1 mode / line2 permission-mode → 首个 user（parentUuid:null）→（custom-title）→
//   对话记录 → 末尾补发缺失 tool_result；每行一个 `\n`，文件以恰好一个换行结尾。
//
// 标题写 custom-title（/rename 载体）而非 ai-title：Claude Code 把 custom-title 当
// 用户自定义标题（权威、不被改写），ai-title 是它随对话自动生成/改写的记录——写
// ai-title 等于把 DSH 标题标成「生成标题」，续聊后可能被它自己生成的新标题覆盖。
// 实测本机 24 份被 /rename 过的真实转录只有 custom-title、没有 ai-title（同一版本
// 2.1.x 写出的两种形态），位置与 ai-title 相同：首个 user 记录之后。
//
// 降级显式计数（绝不静默）：user/message 且 source.kind≠'user' → skippedInjections；
// 非 text 内容块（图片等）→ skippedBlocks；孤儿 tool/result（查不到 tool/call）→
// droppedToolResults；有 call 无 result（中断的原生会话）→ 文件末尾补发空
// tool_result（content:[]，parentUuid 指向声明该调用的 assistant）。
//
//
// 根目录 export.mjs 是本模块的 re-export shim（保持既有 public export 名与相对
// 顺序不变；index.mjs / lib/ / test/ 等既有 import 路径无需改动）。

import { randomUUID, createHash } from 'node:crypto'
import { toolResultOf } from '../convert/index.mjs'

// Claude Code projects 目录 slug：非字母数字字符全部替换为 '-'，不合并连续 '-'。
export function slugifyClaudeCwd(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-')
}

// 事件时间 → ISO8601（缺失回退 meta.createdAt，再回退 Date.now()）。
function eventIso(ev, meta, fallbackMs) {
  const ms = typeof ev.time === 'number' ? ev.time
    : meta && typeof meta.createdAt === 'number' ? meta.createdAt
      : fallbackMs !== undefined ? fallbackMs : Date.now()
  return new Date(ms).toISOString()
}

// DSH content 块（或裸字符串）→ Claude Code 文本载荷：单 text 块→字符串、
// 多块→数组、空/无 text→[]；非 text 块跳过并计数。
function textPayload(blocks) {
  if (typeof blocks === 'string') return { value: blocks, skipped: 0 }
  if (!Array.isArray(blocks)) return { value: [], skipped: 0 }
  const texts = []
  let skipped = 0
  for (const b of blocks) {
    if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else skipped++
  }
  return { value: texts.length === 0 ? [] : texts.length === 1 ? texts[0] : texts, skipped }
}

// tool_use input：arguments 是 JSON 字符串；解析失败回退 {}。
function safeParseJson(s) {
  if (typeof s !== 'string') return {}
  try { return JSON.parse(s) } catch { return {} }
}

// 是否存在可导出 surface 事件（user 直连提问 / assistant / tool/result）。
function hasSurfaceEvents(events) {
  return (Array.isArray(events) ? events : []).some((ev) => ev && (
    (ev.type === 'user/message' && ev.data && ev.data.source && ev.data.source.kind === 'user') ||
    ev.type === 'assistant/message' ||
    ev.type === 'tool/result'
  ))
}

// 记录生成循环：推 mode/permission-mode 头，首个 user 后推 custom-title（标题入参
// 优先，缺省扫 session/title 事件取首个），其余记录按 DSH seq 顺序串成 parentUuid 链。
// 返回 records 与降级计数。
function serializeClaudeRecords(events, { meta, sessionUuid, cwd, version, gitBranch, title }, { uuid }) {
  const list = Array.isArray(events) ? events : []
  const sessionId = String(sessionUuid)
  let resolvedTitle = typeof title === 'string' && title.trim() ? title.trim() : undefined
  if (!resolvedTitle) {
    for (const ev of list) {
      if (ev && ev.type === 'session/title' && ev.data && typeof ev.data.title === 'string' && ev.data.title.trim()) {
        resolvedTitle = ev.data.title.trim()
        break
      }
    }
  }

  const records = []
  // tool/call → 声明它的 assistant 记录 uuid：并行结果扇出（同一 step 多个 result）
  // 与跨 step 延迟结果都锚定声明方，而不是结果所在 step
  const callIdToAssistant = new Map()
  const declaredCalls = [] // { callId, assistantUuid }
  const resultedCallIds = new Set()
  const assistantUuidByStep = new Map() // 't:<turn>:s:<step>' → assistant uuid
  let droppedToolResults = 0
  let skippedInjections = 0
  let skippedBlocks = 0
  let toolCalls = 0
  let toolResults = 0
  let firstUserEmitted = false
  let lastTimeMs = null
  let currentTurn = null
  let currentStep = null
  // parentUuid 链尾：首个 surface 记录 parentUuid=null 起链，之后逐条接续。
  let prevUuid = null

  const stepKey = (turn, step) => 't:' + turn + ':s:' + step

  records.push({ type: 'mode', mode: 'normal', sessionId })
  records.push({ type: 'permission-mode', permissionMode: 'default', sessionId })

  for (const ev of list) {
    if (!ev) continue
    if (typeof ev.time === 'number' && (lastTimeMs === null || ev.time >= lastTimeMs)) lastTimeMs = ev.time
    const data = ev.data || {}
    switch (ev.type) {
      case 'turn/start':
        if (typeof data.turn === 'number') currentTurn = data.turn
        break
      case 'step/start':
        if (typeof data.step === 'number') currentStep = data.step
        break
      case 'step/end':
      case 'turn/end':
      case 'session/imported':
        break
      case 'session/title':
        break // 标题在首个 user 记录后统一放置（custom-title）
      case 'user/message': {
        if (!data.source || data.source.kind !== 'user') { skippedInjections++; break }
        const { value: content, skipped } = textPayload(data.content)
        skippedBlocks += skipped
        const record = {
          type: 'user',
          message: { role: 'user', content },
          parentUuid: prevUuid,
          uuid: uuid(),
          timestamp: eventIso(ev, meta),
          ...(data.promptId ? { promptId: data.promptId } : {}),
          permissionMode: 'default',
          origin: { kind: 'human' },
          promptSource: 'typed',
          userType: 'external',
          entrypoint: 'cli',
          cwd,
          sessionId,
          ...(version ? { version } : {}),
          ...(gitBranch ? { gitBranch } : {}),
        }
        records.push(record)
        prevUuid = record.uuid
        if (!firstUserEmitted) {
          firstUserEmitted = true
          if (resolvedTitle) records.push({ type: 'custom-title', customTitle: resolvedTitle, sessionId })
        }
        break
      }
      case 'assistant/message': {
        const msg = data.message || {}
        const blocks = Array.isArray(msg.content) ? msg.content : []
        const content = []
        let hasToolUse = false
        for (const b of blocks) {
          if (!b || typeof b !== 'object') continue
          if (b.type === 'text' && typeof b.text === 'string') {
            content.push({ type: 'text', text: b.text })
          } else if (b.type === 'reasoning' && typeof b.text === 'string') {
            content.push({ type: 'thinking', thinking: b.text, signature: '' })
          } else if (b.type === 'tool-call' && typeof b.id === 'string') {
            hasToolUse = true
            content.push({ type: 'tool_use', id: b.id, name: typeof b.name === 'string' ? b.name : '', input: safeParseJson(b.arguments) })
          } else {
            skippedBlocks++
          }
        }
        const model = msg.source && typeof msg.source.model === 'string' ? msg.source.model : undefined
        const turn = typeof data.turn === 'number' ? data.turn : currentTurn
        const step = typeof data.step === 'number' ? data.step : currentStep
        const record = {
          type: 'assistant',
          parentUuid: prevUuid,
          uuid: uuid(),
          timestamp: eventIso(ev, meta),
          message: {
            type: 'message',
            // 确定性 id：对 data.message.id（缺失时退 'seq'+seq）做 sha1 截断——
            // 全量导出与增量写回共用本循环，同一 DSH 消息必须产出相同
            // message id，--resume 才不会产生重复消息；哈希同时保证字符合法、定长。
            id: 'msg_' + createHash('sha1').update(String(msg.id ?? 'seq' + ev.seq)).digest('hex').slice(0, 24),
            role: 'assistant',
            content,
            ...(model ? { model } : {}),
            stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
          },
          sessionId,
        }
        records.push(record)
        prevUuid = record.uuid
        assistantUuidByStep.set(stepKey(turn, step), record.uuid)
        break
      }
      case 'tool/call': {
        const turn = typeof data.turn === 'number' ? data.turn : currentTurn
        const step = typeof data.step === 'number' ? data.step : currentStep
        const assistantUuid = assistantUuidByStep.get(stepKey(turn, step))
        if (assistantUuid !== undefined) {
          callIdToAssistant.set(data.callId, assistantUuid)
          declaredCalls.push({ callId: data.callId, assistantUuid })
        }
        toolCalls++
        break
      }
      case 'tool/result': {
        // 形状无关读取：V3 是 content[0] 的 wrapper，V4 是一级 message.toolCallId /
        // message.content（宿主升到 V4 后仍按 wrapper 扫会丢掉全部工具结果）
        const result = toolResultOf(ev)
        if (result) {
          const b = { toolCallId: result.callId, content: result.blocks, isError: result.isError }
          const assistantUuid = callIdToAssistant.get(b.toolCallId)
          if (assistantUuid === undefined) { droppedToolResults++; continue }
          const { value: content, skipped } = textPayload(b.content)
          skippedBlocks += skipped
          const record = {
            type: 'user',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: b.toolCallId, content, ...(b.isError === true ? { is_error: true } : {}) }] },
            parentUuid: assistantUuid,
            uuid: uuid(),
            timestamp: eventIso(ev, meta),
            ...(data.promptId ? { promptId: data.promptId } : {}),
            sourceToolAssistantUUID: assistantUuid,
            userType: 'external',
            entrypoint: 'cli',
            cwd,
            sessionId,
          }
          records.push(record)
          resultedCallIds.add(b.toolCallId)
          prevUuid = record.uuid
          toolResults++
        }
        break
      }
      default:
        break // todo/write、chunk 事件等一律跳过
    }
  }

  // 有 call 无 result（中断的原生会话）→ 文件末尾补发空 tool_result（content:[]，
  // parentUuid 指向声明 assistant；时间戳取最后一条事件，确定性）
  for (const { callId, assistantUuid } of declaredCalls) {
    if (resultedCallIds.has(callId)) continue
    const record = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: [] }] },
      parentUuid: assistantUuid,
      uuid: uuid(),
      timestamp: eventIso({ time: lastTimeMs }, meta),
      sourceToolAssistantUUID: assistantUuid,
      userType: 'external',
      entrypoint: 'cli',
      cwd,
      sessionId,
    }
    records.push(record)
    prevUuid = record.uuid
    toolResults++
  }

  return {
    records,
    toolCalls,
    toolResults,
    droppedToolResults,
    skippedInjections,
    skippedBlocks,
    title: firstUserEmitted && resolvedTitle ? resolvedTitle : undefined,
  }
}

/**
 * 把 DSH 会话日志序列化为 Claude Code JSONL。
 *
 * @param {{meta?: object, events?: object[], sessionUuid: string, cwd: string,
 *         version?: string, gitBranch?: string, title?: string}} input
 *        events 为按 seq 升序的 SessionEvent[]；title 入参优先，缺省从
 *        session/title 事件取首个；version/gitBranch 可选透传到 user 记录。
 * @param {{uuid?: () => string}} [options] uuid 工厂（测试注入确定性序列，
 *        默认 randomUUID）。
 * @returns {{jsonl: string, recordCount: number, toolCalls: number,
 *          toolResults: number, droppedToolResults: number,
 *          skippedInjections: number, skippedBlocks: number, title?: string}}
 *          空会话（无任何可导出 surface 事件）抛错「无可导出内容」。
 */
export function serializeClaudeJsonl({ meta, events, sessionUuid, cwd, version, gitBranch, title }, { uuid = randomUUID } = {}) {
  if (!hasSurfaceEvents(events)) throw new Error('无可导出内容')
  const out = serializeClaudeRecords(events, { meta, sessionUuid, cwd, version, gitBranch, title }, { uuid })
  const jsonl = out.records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  return {
    jsonl,
    recordCount: out.records.length,
    toolCalls: out.toolCalls,
    toolResults: out.toolResults,
    droppedToolResults: out.droppedToolResults,
    skippedInjections: out.skippedInjections,
    skippedBlocks: out.skippedBlocks,
    title: out.title,
  }
}
