// lib/export/opencode.mjs — DSH 会话事件 → opencode `import` JSON（纯函数）
//
// 目标形态（opencode CLI 契约，来自上游源码核对，非推测）：
//   packages/opencode/src/cli/cmd/import.ts —— `opencode import <file>` 读入
//     { info: <Session.Info>, messages: [{ info: <SessionV1.Info>, parts: [<SessionV1.Part>] }] }，
//     逐层过 Schema.decodeUnknownSync 校验后写 session/message/part 三表；
//     info 的 projectID / directory / path 由导入端**覆盖**（生成端可省略）。
//   packages/opencode/src/session/session.ts —— Session.Info（会话 info）。
//   packages/schema/src/v1/session.ts —— SessionV1.Info / SessionV1.Part（消息与 part）。
//
// 生成端必须满足的硬约束（这些是解码期就会抛错的点）：
//   * **id 前缀被校验**：会话 `ses…`、消息 `msg…`、part `prt…`（前缀不对直接抛 ParseError）。
//   * **每个 part 都要 `id` / `sessionID` / `messageID`** —— 导入端插入前会把这三个键
//     从 data 里剔掉，但解码要求它们存在。
//   * assistant 消息的 `cost` / `tokens`（含 cache.read/write）与 step-finish 的
//     `cost` / `tokens` 是**必填**；事件带 provider 回报 usage 时如实回填（DSH 原生
//     会话与 claude/opencode/reasonix 等源的导入会话都有），没有才写 0 并计入
//     usageUnknown，在导出结果里显式上报（绝不静默假装有数）。
//   * 时间戳是 epoch 毫秒的**非负整数**（NonNegativeInt；assistant 的 time.created 也是整数）。
//
// id 全部由 DSH 会话 id / 轮次 / 调用 id 哈希派生（确定性）：同一会话重复导出得到同一组
// id，导入端 messages/parts 走 onConflictDoNothing，因此重导是幂等的而不是堆副本。
//
// 只写 opencode 能表达的最小集合：user / assistant 消息 + text / reasoning / tool part
// 与 step-start / step-finish 结构块。附件类块（图片、文件、patch、subtask）不写，计入
// skippedBlocks；非人类注入消息（环境变更声明等）不写，计入 skippedInjections。
import { createHash } from 'node:crypto'
import { toolResultOf } from '../convert/shape.mjs'
import { sanitizeParseError } from '../convert/core.mjs'
import { unmapOpencodeToolName } from '../convert/opencode.mjs'

// 会话 info 的 version：opencode 自己写的是「创建该会话的 app 版本」，对我们是不透明字符串。
// 写一个合法 semver（而不是本插件的版本号，避免被当成 opencode 版本参与其自身迁移判断）。
const SESSION_VERSION = '1.0.0'
// 导入会话在 opencode 侧落到的 agent / mode：用 opencode 自带的主 agent 名，
// 保证面板与 UI 能正常渲染（解码对这两个字段只要求是非空字符串）。
const AGENT = 'build'
// 源日志没有模型信息时的回退（user 消息的 model 是必填结构）。
const UNKNOWN_PROVIDER = 'unknown'
const UNKNOWN_MODEL = 'unknown'

const digest = (value, len) => createHash('sha256').update(String(value)).digest('hex').slice(0, len)
const sessionIdFor = (dshId) => 'ses_' + digest('session:' + dshId, 32)
const messageIdFor = (opencodeId, key) => 'msg_' + digest(opencodeId + ':message:' + key, 32)
const partIdFor = (opencodeId, key) => 'prt_' + digest(opencodeId + ':part:' + key, 32)

// 非负整数毫秒（assistant 的 time.created 与表列 time_created 都要求整数）
function ms(value, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

function eventMs(ev, meta, fallback) {
  if (ev && typeof ev.time === 'number' && Number.isFinite(ev.time)) return Math.trunc(ev.time)
  if (meta && typeof meta.createdAt === 'number') return Math.trunc(meta.createdAt)
  return fallback !== undefined ? fallback : 0
}

// content 块数组 → 文本（只取 text 块；其余块计入 skipped）。与 codex 导出同口径。
function textOf(blocks) {
  if (typeof blocks === 'string') return { value: blocks, skipped: 0 }
  if (!Array.isArray(blocks)) return { value: '', skipped: 0 }
  let skipped = 0
  const texts = []
  for (const b of blocks) {
    if (b && b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else skipped++
  }
  return { value: texts.join('\n'), skipped }
}

// assistant 消息的 content → 文本 + 推理（两种块都进 part，其余算跳过）。
// 不能复用 textOf：那会把 reasoning 当成「不支持的附件块」重复计数。
function partsOfAssistant(blocks) {
  const texts = []
  const reasonings = []
  let skipped = 0
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (b && b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else if (b && b.type === 'reasoning' && typeof b.text === 'string') reasonings.push(b.text)
    else skipped++
  }
  return { text: texts.join('\n'), reasonings, skipped }
}

function hasSurfaceEvents(events) {
  return (Array.isArray(events) ? events : []).some((ev) => ev && (
    (ev.type === 'user/message' && ev.data && ev.data.source && ev.data.source.kind === 'user')
    || ev.type === 'assistant/message'
    || ev.type === 'tool/result'
  ))
}

// 工具参数：DSH 存的是 JSON 字符串（各源转换器统一 stringify），opencode 要对象。
function argsObject(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { value: raw, ok: true }
  if (typeof raw !== 'string' || !raw.trim()) return { value: {}, ok: true }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { value: parsed, ok: true }
    return { value: { value: parsed }, ok: true }
  } catch {
    // 参数不是合法 JSON（少数源原样保留文本）：包一层 value 键，不丢原文
    return { value: { value: raw }, ok: false }
  }
}

const zeroTokens = () => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

function slugOf(title, opencodeId) {
  const base = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'dsh-import-' + opencodeId.slice(-8)
}

/** DSH 会话事件 → `{ info, messages }`（opencode import 文档对象）。 */
export function buildOpencodeImportDoc({ meta, events, sessionUuid, cwd, title }) {
  const list = Array.isArray(events) ? events : []
  if (!hasSurfaceEvents(list)) throw new Error('无可导出内容')
  const opencodeId = sessionIdFor(sessionUuid)
  const dir = (typeof cwd === 'string' && cwd) || (meta && meta.cwd) || ''
  const titleText = String(title || '').trim() || 'DSH import'

  const messages = []
  const partByCallId = new Map()
  const settledCalls = new Set()
  let current = null
  let lastUserId = null
  let skippedInjections = 0
  let skippedBlocks = 0
  let toolCalls = 0
  let toolResults = 0
  let usageUnknown = 0
  const callTimes = new Map()

  const pushUser = (ev, text, ts) => {
    const id = messageIdFor(opencodeId, 'u' + messages.length)
    const parts = [{
      id: partIdFor(opencodeId, 'u' + messages.length + ':0'),
      sessionID: opencodeId,
      messageID: id,
      type: 'text',
      text,
      time: { start: ts },
    }]
    messages.push({
      info: {
        id,
        sessionID: opencodeId,
        role: 'user',
        time: { created: ts },
        agent: AGENT,
        model: { providerID: UNKNOWN_PROVIDER, modelID: UNKNOWN_MODEL },
      },
      parts,
    })
    current = { userId: id, assistantId: null }
    lastUserId = id
  }

  const pushAssistant = (ev, ts) => {
    const id = messageIdFor(opencodeId, 'a' + messages.length)
    // 用量计数：事件携带 provider 回报 usage（DSH 原生会话的 live usage，或导入时从
    // claude/opencode/reasonix 等源转录映射的 usage）→ 如实回填；事件没有才写 0 并计数上报
    const usage = ev.data && typeof ev.data === 'object' ? ev.data.usage : undefined
    const int = (v) => Number.isSafeInteger(v) && v >= 0
    let tokens
    if (usage && typeof usage === 'object' && int(usage.inputTokens) && int(usage.outputTokens)) {
      tokens = {
        input: usage.inputTokens,
        output: usage.outputTokens,
        reasoning: int(usage.reasoningTokens) ? usage.reasoningTokens : 0,
        cache: {
          read: int(usage.cacheReadTokens) ? usage.cacheReadTokens : 0,
          write: int(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0,
        },
      }
    } else {
      usageUnknown++
      tokens = zeroTokens()
    }
    // parentID 必填：优先本轮的 user 消息；转录中途开始（只有 assistant）时回退最近一条
    // user 消息，都没有才退化成自身（保持「msg… 前缀 + 非空」的解码要求）
    const parent = (current && current.userId) || lastUserId || id
    messages.push({
      info: {
        id,
        sessionID: opencodeId,
        role: 'assistant',
        time: { created: ts, completed: ts },
        parentID: parent,
        modelID: UNKNOWN_MODEL,
        providerID: UNKNOWN_PROVIDER,
        mode: AGENT,
        agent: AGENT,
        path: { cwd: dir, root: dir },
        cost: 0,
        tokens,
      },
      parts: [{
        id: partIdFor(opencodeId, 'a' + messages.length + ':step'),
        sessionID: opencodeId,
        messageID: id,
        type: 'step-start',
      }],
    })
    if (current) current.assistantId = id
    return messages[messages.length - 1]
  }

  const currentAssistant = () => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].info.role === 'assistant' && (!current || messages[i].info.id === current.assistantId)) return messages[i]
    }
    return null
  }

  for (const ev of list) {
    if (!ev) continue
    const ts = eventMs(ev, meta)
    const data = ev.data || {}
    if (ev.type === 'user/message') {
      if (!data.source || data.source.kind !== 'user') { skippedInjections++; continue }
      const { value: text, skipped } = textOf(data.content)
      skippedBlocks += skipped
      if (!text) continue
      pushUser(ev, text, ts)
      continue
    }
    if (ev.type === 'assistant/message') {
      const msg = data.message || {}
      const holder = pushAssistant(ev, ts)
      const { text, reasonings, skipped } = partsOfAssistant(msg.content)
      skippedBlocks += skipped
      if (text) {
        holder.parts.push({
          id: partIdFor(opencodeId, 'a' + (messages.length - 1) + ':text'),
          sessionID: opencodeId,
          messageID: holder.info.id,
          type: 'text',
          text,
          time: { start: ts },
        })
      }
      let ri = 0
      for (const reasoning of reasonings) {
        holder.parts.push({
          id: partIdFor(opencodeId, 'a' + (messages.length - 1) + ':r' + ri++),
          sessionID: opencodeId,
          messageID: holder.info.id,
          type: 'reasoning',
          text: reasoning,
          // reasoning 的 time 是必填（text 的可选）——解码期就会校验
          time: { start: ts },
        })
      }
      continue
    }
    if (ev.type === 'tool/call') {
      const holder = currentAssistant()
      if (!holder) { skippedBlocks++; continue }
      const callId = data.callId || partIdFor(opencodeId, 'call' + toolCalls)
      const args = argsObject(data.arguments)
      const part = {
        id: partIdFor(opencodeId, 'call:' + callId),
        sessionID: opencodeId,
        messageID: holder.info.id,
        type: 'tool',
        callID: String(callId),
        tool: unmapOpencodeToolName(String(data.name || 'unknown')),
        state: {
          status: 'completed',
          input: args.value,
          output: '',
          title: String(data.name || 'unknown'),
          metadata: {},
          time: { start: ts, end: ts },
        },
      }
      holder.parts.push(part)
      partByCallId.set(String(callId), part)
      callTimes.set(String(callId), ts)
      toolCalls++
      continue
    }
    if (ev.type === 'tool/result') {
      // toolResultOf 形状无关（V3 wrapper / V4 一级 tool 消息都认）：宿主升到 V4 后
      // 仍按 wrapper 找会静默丢掉全部工具结果
      const result = toolResultOf(ev)
      const callId = result && result.callId
      if (!callId) { skippedBlocks++; continue }
      const block = { content: result.blocks, isError: result.isError }
      const part = partByCallId.get(String(callId))
      if (!part) { skippedBlocks++; continue }
      const { value: output, skipped } = textOf(block && block.content)
      skippedBlocks += skipped
      const start = callTimes.get(String(callId)) ?? ts
      const isError = block && block.isError === true
      part.state = isError
        ? { status: 'error', input: part.state.input, error: output, time: { start, end: ms(ts, start) } }
        : { status: 'completed', input: part.state.input, output, title: part.state.title, metadata: {}, time: { start, end: ms(ts, start) } }
      settledCalls.add(String(callId))
      toolResults++
    }
  }

  if (messages.length === 0) throw new Error('无可导出内容')

  // 没有对应结果的调用：保持 completed + 空 output（与 codex 导出同口径），单独计数
  let droppedToolResults = 0
  for (const callId of partByCallId.keys()) {
    if (!settledCalls.has(callId)) droppedToolResults++
  }

  const firstTs = ms(meta && meta.createdAt, eventMs(list[0], meta, 0))
  const lastTs = ms(list.length > 0 ? list[list.length - 1].time : undefined, firstTs)
  const info = {
    id: opencodeId,
    slug: slugOf(titleText, opencodeId),
    title: titleText,
    version: SESSION_VERSION,
    time: { created: firstTs, updated: Math.max(firstTs, lastTs) },
  }
  if (dir) info.metadata = { dshCwd: dir }

  return {
    doc: { info, messages },
    stats: {
      sessionId: opencodeId,
      messageCount: messages.length,
      partCount: messages.reduce((n, m) => n + m.parts.length, 0),
      toolCalls,
      toolResults,
      droppedToolResults,
      skippedInjections,
      skippedBlocks,
      usageUnknown,
    },
  }
}

/** 序列化为文件内容（JSON 文本，恰好一个换行结尾）。 */
export function serializeOpencodeJson(input, opts = {}) {
  const { doc, stats } = buildOpencodeImportDoc(input, opts)
  return { json: JSON.stringify(doc, null, 2) + '\n', recordCount: stats.partCount, ...stats }
}

/**
 * 只读结构校验：把「opencode import 能不能吃下这份 JSON」里**可在本地判定**的部分
 * 查一遍（前缀、必填字段、类型、配对）。上游解码器是权威，这里是与它同源的护栏——
 * 序列化器漂移时测试会先红，而不是等用户跑 `opencode import` 才发现。
 * 返回 `{ ok, errors }`（errors 封顶 20 条）。
 */
export function verifyOpencodeImportJson(text) {
  const errors = []
  const push = (msg) => { if (errors.length < 20) errors.push(msg) }
  const src = String(text)
  if (!src.endsWith('\n')) push('文件必须以恰好一个换行结尾')
  if (/\n\s*\n\s*$/.test(src)) push('文件结尾有多余空行')
  let doc
  try {
    doc = JSON.parse(src)
  } catch (err) {
    return { ok: false, errors: ['JSON 解析失败: ' + sanitizeParseError(err)] }
  }
  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['顶层不是对象'] }
  const info = doc.info
  if (!info || typeof info !== 'object') push('缺少 info')
  else {
    if (typeof info.id !== 'string' || !info.id.startsWith('ses')) push('info.id 必须以 ses 开头')
    for (const key of ['slug', 'title', 'version']) {
      if (typeof info[key] !== 'string') push('info.' + key + ' 必须是字符串')
    }
    const time = info.time
    if (!time || typeof time !== 'object') push('缺少 info.time')
    else {
      for (const key of ['created', 'updated']) {
        const v = time[key]
        if (!Number.isInteger(v) || v < 0) push('info.time.' + key + ' 必须是非负整数')
      }
    }
  }
  const messages = doc.messages
  if (!Array.isArray(messages) || messages.length === 0) push('messages 必须是非空数组')
  else {
    const messageIds = new Set()
    for (let i = 0; i < messages.length; i++) {
      const entry = messages[i]
      const at = 'messages[' + i + ']'
      if (!entry || typeof entry !== 'object') { push(at + ' 不是对象'); continue }
      const mi = entry.info
      if (!mi || typeof mi !== 'object') { push(at + '.info 缺失'); continue }
      if (typeof mi.id !== 'string' || !mi.id.startsWith('msg')) push(at + '.info.id 必须以 msg 开头')
      if (typeof mi.sessionID !== 'string' || !mi.sessionID.startsWith('ses')) push(at + '.info.sessionID 必须以 ses 开头')
      if (mi.role !== 'user' && mi.role !== 'assistant') push(at + '.info.role 只能是 user / assistant')
      if (mi.role === 'user') {
        if (!mi.time || !Number.isFinite(mi.time.created) || mi.time.created < 0) push(at + ' user 缺少合法的 time.created')
        if (typeof mi.agent !== 'string') push(at + ' user 缺少 agent')
        if (!mi.model || typeof mi.model.providerID !== 'string' || typeof mi.model.modelID !== 'string') push(at + ' user 缺少 model.providerID / modelID')
      } else if (mi.role === 'assistant') {
        if (!mi.time || !Number.isInteger(mi.time.created) || mi.time.created < 0) push(at + ' assistant 的 time.created 必须是非负整数')
        if (typeof mi.parentID !== 'string' || !mi.parentID.startsWith('msg')) push(at + ' assistant 缺少 parentID')
        for (const key of ['modelID', 'providerID', 'mode', 'agent']) {
          if (typeof mi[key] !== 'string') push(at + ' assistant 缺少 ' + key)
        }
        if (!mi.path || typeof mi.path.cwd !== 'string' || typeof mi.path.root !== 'string') push(at + ' assistant 缺少 path.cwd / root')
        if (!Number.isFinite(mi.cost)) push(at + ' assistant 缺少 cost')
        const t = mi.tokens
        if (!t || !['input', 'output', 'reasoning'].every((k) => Number.isFinite(t[k]))
          || !t.cache || !Number.isFinite(t.cache.read) || !Number.isFinite(t.cache.write)) {
          push(at + ' assistant 缺少 tokens（含 cache.read / cache.write）')
        }
      }
      if (typeof mi.id === 'string') messageIds.add(mi.id)
      const parts = entry.parts
      if (!Array.isArray(parts)) { push(at + '.parts 必须是数组'); continue }
      for (let j = 0; j < parts.length; j++) {
        const p = parts[j]
        const pat = at + '.parts[' + j + ']'
        if (!p || typeof p !== 'object') { push(pat + ' 不是对象'); continue }
        if (typeof p.id !== 'string' || !p.id.startsWith('prt')) push(pat + '.id 必须以 prt 开头')
        if (typeof p.sessionID !== 'string' || !p.sessionID.startsWith('ses')) push(pat + '.sessionID 必须以 ses 开头')
        // 每个 part 的 messageID 必须是真实插入过的消息 id（part.message_id 是外键）
        if (typeof p.messageID !== 'string' || !p.messageID.startsWith('msg')) push(pat + '.messageID 必须以 msg 开头')
        else if (!messageIds.has(p.messageID) && !messages.some((m) => m.info && m.info.id === p.messageID)) {
          push(pat + '.messageID 指向不存在的消息')
        }
        if (p.type === 'text') {
          if (typeof p.text !== 'string') push(pat + ' text 缺少 text')
        } else if (p.type === 'reasoning') {
          if (typeof p.text !== 'string') push(pat + ' reasoning 缺少 text')
          if (!p.time || !Number.isInteger(p.time.start) || p.time.start < 0) push(pat + ' reasoning 缺少 time.start')
        } else if (p.type === 'tool') {
          if (typeof p.callID !== 'string' || typeof p.tool !== 'string') push(pat + ' tool 缺少 callID / tool')
          const st = p.state
          if (!st || typeof st !== 'object') push(pat + ' tool 缺少 state')
          else if (st.status === 'completed') {
            for (const key of ['output', 'title']) {
              if (typeof st[key] !== 'string') push(pat + ' tool.completed 缺少 ' + key)
            }
            if (!st.input || typeof st.input !== 'object') push(pat + ' tool.completed 缺少 input 对象')
            if (!st.metadata || typeof st.metadata !== 'object') push(pat + ' tool.completed 缺少 metadata')
            if (!st.time || !Number.isInteger(st.time.start)) push(pat + ' tool.completed 缺少 time.start')
          } else if (st.status === 'error') {
            if (typeof st.error !== 'string') push(pat + ' tool.error 缺少 error')
            if (!st.input || typeof st.input !== 'object') push(pat + ' tool.error 缺少 input 对象')
            if (!st.time || !Number.isInteger(st.time.start)) push(pat + ' tool.error 缺少 time.start')
          } else {
            push(pat + ' tool.state.status 只能是 completed / error（本导出器不写 pending / running）')
          }
        } else if (p.type === 'step-start') {
          // 只有 base 字段，无额外必填
        } else if (p.type === 'step-finish') {
          if (typeof p.reason !== 'string' || !Number.isFinite(p.cost) || !p.tokens) push(pat + ' step-finish 缺少 reason / cost / tokens')
        } else {
          push(pat + ' 未知 part 类型: ' + String(p.type))
        }
      }
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, messages: Array.isArray(messages) ? messages.length : 0 }
}
