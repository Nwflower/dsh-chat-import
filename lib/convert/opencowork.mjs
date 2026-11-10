// lib/convert/opencowork.mjs — openCoWork / NextCoWork SQLite 会话 → DSH 会话（纯函数）
//
// 同一 format 覆盖两种互不相同的上游存储，host 读取层先把它们归一成这里的中间 JSON：
//   { id, layout: 'legacy'|'next', title, cwd, model, createdAt, updatedAt,
//     messages: [{ id, role, createdAt, blocks, invalidBlocks? }] }
//
// legacy：~/.open-cowork/data.db（1.0.0 / 1.3.27 / 1.4.0 源码可证）。messages.content 是
// TEXT，写库时 JSON.stringify(string|ContentBlock[])，读库时 JSON.parse 后只接受 string /
// 数组，其它对象回退原文。角色为 system/user/assistant/tool；tool_use{id,name,input} 与
// tool_result{toolUseId,content,isError} 使用 camelCase；thinking 的正文键是 thinking。
// next：~/.next-cowork/data/nextcowork.db（v2.0.0+，v2.8.9 复核）。messages.parts 是 JSON
// 数组文本，顺序键 ordinal；AgentMessage.role 只有 user/assistant；tool_call{callId,name,input}
// 与 tool_result{callId,output:{content,...},isError} 配对，thinking 的正文键是 text。
// 工具结果放在 user 消息里，结果载体不能再开新轮。parent_session_id 非空的是子代理转录，
// 读取层过滤后这里再挡一次，防止手工构造的中间 JSON 绕过。
//
// 首版范围：正文、thinking、工具调用/结果、标题/cwd/时间。图片引用、子代理/UI 标记、
// 原生压缩检查点不臆造映射；未知或畸形块计 unknownEvents，孤儿结果计 orphanResults，
// 已知但无法还原的图片另计 imagesDegraded。两个计数沿用公开导入结果的既有字段。
import {
  SESSION_FORMAT_VERSION,
  finishSession,
  mapContentBlock,
  mintSessionId,
} from './core.mjs'
import { contentText, joinForPlatform as joinFor, normalizeTitle, skipResult } from './util.mjs'
import { alignStepResults, createTurns, dropDuplicateCalls } from './ir.mjs'

/** 两种默认库路径；发现层与导入说明共用，path 由目标平台而不是当前进程平台决定。 */
export function opencoworkDefaultDbPaths(home, platform = process.platform) {
  return [
    joinFor(platform, String(home), '.open-cowork', 'data.db'),
    joinFor(platform, String(home), '.next-cowork', 'data', 'nextcowork.db'),
  ]
}

function resultCallId(block) {
  if (typeof block.toolUseId === 'string' && block.toolUseId) return block.toolUseId
  if (typeof block.callId === 'string' && block.callId) return block.callId
  return null
}

export function convertOpencoworkJson(raw, args = {}) {
  let session
  try {
    session = JSON.parse(raw)
  } catch {
    return skipResult('not an openCoWork session (invalid JSON)', { skipped: 1 })
  }
  if (!session || typeof session !== 'object' || !Array.isArray(session.messages)) {
    return skipResult('not an openCoWork session (no messages array)', { skipped: 1 })
  }

  const layout = session.layout === 'next' ? 'next' : 'legacy'
  const sourceId = typeof session.id === 'string' && session.id ? session.id : null
  if (layout === 'next' && typeof session.parentSessionId === 'string' && session.parentSessionId) {
    return skipResult('NextCoWork sub-agent session (' + (sourceId || 'unknown') + '); only top-level sessions become sessions', {
      skipped: 1, records: session.messages.length,
    })
  }

  const turnQueue = createTurns()
  const turns = turnQueue.turns
  let cur = null
  let lastStep = null
  let firstMessageTime = null
  let systemPrompt = null
  let unknownEvents = 0
  let orphanResults = 0
  let imagesDegraded = 0
  const callSteps = new Map()

  const messageTime = (msg) => {
    const value = Number.isFinite(msg.createdAt) ? msg.createdAt : null
    if (value !== null && firstMessageTime === null) firstMessageTime = value
    return value
  }
  const openTurn = (prompt, time) => {
    cur = turnQueue.open(prompt, time === null ? undefined : time)
    lastStep = null
  }
  const textOf = (blocks) => contentText(blocks, { skipEmpty: true })

  // 结果正文：legacy content 是 string|Array<text|image>；next output.content 是 string，
  // output.images 的 dataRef 需要旁读附件库，首版不虚构字节。
  const resultContent = (block) => {
    const legacy = block.type === 'tool_result' && Object.hasOwn(block, 'toolUseId')
    const output = legacy ? block.content : (block.output && typeof block.output === 'object' ? block.output.content : undefined)
    if (!legacy && (!block.output || typeof block.output !== 'object' || typeof block.output.content !== 'string')) {
      unknownEvents++
    }
    if (!legacy && block.output && Array.isArray(block.output.images) && block.output.images.length > 0) {
      imagesDegraded += block.output.images.length
    }
    const raw = Array.isArray(output) ? output : (typeof output === 'string' ? [{ type: 'text', text: output }] : [])
    const out = []
    for (const item of raw) {
      if (item && item.type === 'text' && typeof item.text === 'string') {
        out.push({ type: 'text', text: item.text })
      } else if (item && item.type === 'image') {
        const mapped = mapContentBlock(item)
        if (mapped) out.push(mapped)
        else { imagesDegraded++; unknownEvents++ }
      } else {
        unknownEvents++
      }
    }
    return out
  }

  const attachResult = (block, time) => {
    const id = resultCallId(block)
    const step = id ? callSteps.get(id) : null
    if (!step) { orphanResults++; return }
    step.toolResults.push({
      toolCallId: id,
      ...(time !== null ? { time } : {}),
      content: resultContent(block),
      isError: block.isError === true,
    })
  }

  const mapAssistantBlock = (block) => {
    if (!block || typeof block !== 'object') { unknownEvents++; return null }
    if (block.type === 'thinking') {
      const text = typeof block.thinking === 'string' ? block.thinking : block.text
      if (typeof text === 'string') return { type: 'reasoning', text }
      unknownEvents++
      return null
    }
    if (block.type === 'tool_use' || block.type === 'tool_call') {
      const id = typeof block.id === 'string' && block.id ? block.id
        : (typeof block.callId === 'string' && block.callId ? block.callId : null)
      const name = typeof block.name === 'string' && block.name ? block.name : null
      if (!id || !name) { unknownEvents++; return null }
      return {
        type: 'tool-call', id, name,
        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
      }
    }
    if (block.type === 'image') {
      const mapped = mapContentBlock(block)
      if (mapped) return mapped
      imagesDegraded++
      unknownEvents++
      return null
    }
    if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text }
    unknownEvents++
    return null
  }

  for (const msg of session.messages) {
    if (!msg || typeof msg !== 'object') { unknownEvents++; continue }
    unknownEvents += Number.isInteger(msg.invalidBlocks) ? msg.invalidBlocks : 0
    const time = messageTime(msg)
    const blocks = Array.isArray(msg.blocks) ? msg.blocks : []
    if (!Array.isArray(msg.blocks)) unknownEvents++

    if (msg.role === 'system') {
      const text = textOf(blocks)
      if (args.importSystemPrompt === true && text.trim()) {
        systemPrompt = systemPrompt ? systemPrompt + '\n\n' + text : text
      }
      for (const block of blocks) if (!block || block.type !== 'text') unknownEvents++
      continue
    }

    if (msg.role === 'user') {
      const results = blocks.filter((block) => block && block.type === 'tool_result')
      for (const block of results) attachResult(block, time)
      for (const block of blocks) {
        if (!block || (block.type !== 'text' && block.type !== 'tool_result')) unknownEvents++
      }
      const text = textOf(blocks)
      if (results.length > 0) {
        // 工具结果载体里的人类补充正文留在当前步，不另开用户回合。
        if (text.trim()) {
          const step = lastStep || (cur ? { content: [], toolCalls: [], toolResults: [] } : null)
          if (step) {
            if (time !== null) step.time = time
            step.content.push({ type: 'text', text })
            if (lastStep !== step) { cur.steps.push(step); lastStep = step }
          }
        }
      } else if (text.trim()) {
        openTurn(text, time)
      }
      continue
    }

    if (msg.role === 'assistant') {
      if (!cur) { unknownEvents += blocks.length; continue }
      const step = { content: [], toolCalls: [], toolResults: [] }
      if (time !== null) step.time = time
      for (const block of blocks) {
        if (block && block.type === 'tool_result') { attachResult(block, time); continue }
        const mapped = mapAssistantBlock(block)
        if (!mapped) continue
        step.content.push(mapped)
        if (mapped.type === 'tool-call') {
          step.toolCalls.push(mapped)
          callSteps.set(mapped.id, step)
        }
      }
      if (step.content.length > 0) { cur.steps.push(step); lastStep = step }
      continue
    }

    if (msg.role === 'tool') {
      // legacy 类型允许独立 tool 行；只有带 toolUseId 的 block 才能可靠配对。
      let found = false
      for (const block of blocks) {
        if (block && block.type === 'tool_result') { found = true; attachResult(block, time) }
        else unknownEvents++
      }
      if (!found && blocks.length === 0) orphanResults++
      continue
    }

    unknownEvents += Math.max(1, blocks.length)
  }

  turnQueue.flush()
  const droppedDuplicateCalls = dropDuplicateCalls(turns)
  alignStepResults(turns)

  const stableId = layout + '-' + (sourceId || args.opencoworkId || 'session')
  const sessionId = args.sessionId || mintSessionId(stableId)
  const meta = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: args.createdAt ?? (Number.isFinite(session.createdAt) ? session.createdAt : null)
      ?? firstMessageTime ?? Date.now(),
    sourceId: stableId,
  }
  if (typeof session.cwd === 'string' && session.cwd) meta.cwd = session.cwd

  const explicit = typeof session.title === 'string' ? session.title.trim() : ''
  const finalTitle = normalizeTitle(explicit || (turns.length > 0 ? turns[0].prompt : ''))
  return finishSession(turns, args.budget, {
    meta,
    title: explicit ? finalTitle : undefined,
    provider: 'opencowork',
    model: typeof session.model === 'string' && session.model ? session.model : undefined,
    skipped: 0,
    records: session.messages.length,
    systemPrompt: systemPrompt || undefined,
  }, { title: finalTitle, unknownEvents, orphanResults, droppedDuplicateCalls, imagesDegraded })
}
