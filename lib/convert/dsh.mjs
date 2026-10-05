// lib/convert/dsh.mjs — DSH 自身会话日志（session.jsonl / session.jsonl.zstd）
// → DSH 会话事件。DSH 事件日志本就是目标格式：保留对话核心事件并重排 seq，
// 丢弃流式 chunk 与运行时安全/头状态（导入会话由新宿主重新生成这些状态）。
// sourceEventSeqs 归一化（issue #38）：新版 DSH 写出的区间对压缩格式展开为密集
// 整数数组，指向已丢弃事件（chunk）的悬空引用在重映射时丢弃——宿主 agents.create
// 的 provenance 校验要求密集、无重复、且严格早于当前事件的引用。
import { mintSessionId, parseJsonlLines, SESSION_FORMAT_VERSION, IMAGE_PLACEHOLDER, imageBlockFromSource, isEnvInjectionEvent } from './core.mjs'
import { contentText } from './util.mjs'

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
  // 原生压缩事务：重导一个压缩过的 DSH 会话必须原样保留（否则模型上下文会退回全量历史）。
  // 检查点（替换用 user/message）本就在 DURABLE 里，这三类是它的括号。
  'compaction/start',
  'compaction/summary',
  'compaction/end',
])

// 透传净化（issue #41）：宿主 dsh >= 0.1.5 对种子事件 fail-closed，旧宿主 / 旧插件
// 写出的日志有几处不合规会让整份种子被拒——落盘前逐条补齐：
// - surface 事件（user/assistant/tool-result）必须带 surfaceOp 标记；
// - assistant/message 必须带 settlement 字段 stream（数组）；
// - tool/result 必须能关联 callId（source.callId 与消息/content 上的一侧一致）。
// 注意这里**只归一 callId 关联，不定形状**：V3（wrapper）/ V4（一级 tool 消息）两种形状
// 都由宿主互斥校验，具体产出哪种由落盘前的 hostSessionFormatVersion() 决定
//（lib/import-core.mjs 的 prepareHostEvents）。源日志可能是任一代次（本机 52 个会话里
// 48 个是 v3），在这里钉死形状只会让升级到 V4 宿主后整份导入被拒。
// 返回 false 表示该事件无法归一（两侧都没有 callId，无法关联任何 tool/call）：调用方
// 丢弃并计数上报，保留只会让整份导入失败。
const PASSTHROUGH_SURFACE = new Set(['user/message', 'assistant/message', 'tool/result'])

function normalizePassthroughEvent(ev) {
  // 压缩检查点带的是 surfaceOp:{op:'replace',…} 对象：只在完全没有 surfaceOp 时补 append，
  // 否则会把替换写成追加（摘要变成一条普通 user 消息、括号失去替换件）。
  if (PASSTHROUGH_SURFACE.has(ev.type) && ev.surfaceOp === undefined) ev.surfaceOp = 'append'
  const data = ev.data
  if (!data || typeof data !== 'object') return true
  if (ev.type === 'assistant/message') {
    if (!Array.isArray(data.stream)) data.stream = []
    return true
  }
  if (ev.type !== 'tool/result') return true
  const message = data.message
  if (!message || typeof message !== 'object') return false
  const content = Array.isArray(message.content) ? message.content : null
  const block = content && content.length === 1 && content[0] && typeof content[0] === 'object' ? content[0] : undefined
  const source = message.source && typeof message.source === 'object' ? message.source : undefined
  const fromMessage = typeof message.toolCallId === 'string' && message.toolCallId ? message.toolCallId : undefined
  const fromBlock = block && block.type === 'tool-result' && typeof block.toolCallId === 'string' && block.toolCallId
    ? block.toolCallId : undefined
  const fromSource = source && typeof source.callId === 'string' && source.callId ? source.callId : undefined
  const callId = fromBlock || fromMessage || fromSource
  if (!callId) return false
  // V3 输入：wrapper 缺 toolCallId 时补齐（旧日志曾把它省略）
  if (block && block.type === 'tool-result') block.toolCallId = callId
  message.source = { ...(source || {}), kind: 'tool', callId }
  return true
}

function safeText(blocks) {
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      return b.text.trim().replace(/\s+/g, ' ').slice(0, 80)
    }
  }
  return ''
}

// 区间对展开上限：防御畸形/恶意源日志的巨型区间（如 [1, 1e9]）打爆内存；
// 超限的区间对视为无效引用，交由重映射阶段与悬空引用同路丢弃（不做静默截断）。
const MAX_RANGE_SPAN = 1_000_000

// sourceEventSeqs 归一化第一步（issue #38）：新版 DSH 把连续引用压缩写成区间对
// [[14,24]]（seq 14→24），宿主 agents.create 校验要求密集非负安全整数数组
// [14,…,24]。展开两端均为安全整数、0 ≤ start ≤ end 且跨度可控的二元组；
// 其它元素（畸形对 / 非数组元素）原样透传给重映射阶段统一处置。
function expandSourceEventSeqs(seqs) {
  if (!Array.isArray(seqs)) return seqs
  const out = []
  for (const ref of seqs) {
    if (Array.isArray(ref) && ref.length === 2
      && Number.isSafeInteger(ref[0]) && Number.isSafeInteger(ref[1])
      && ref[0] >= 0 && ref[0] <= ref[1] && ref[1] - ref[0] < MAX_RANGE_SPAN) {
      for (let s = ref[0]; s <= ref[1]; s++) out.push(s)
    } else {
      out.push(ref)
    }
  }
  return out
}

// sourceEventSeqs 归一化第二步：重映射到新 seq，并丢弃悬空引用——引用指向被转换
// 丢弃的事件（流式 chunk / 运行时状态，不在 DURABLE）时无映射可查，保留会让引用
// 错位指向无关且更晚的事件，违反宿主 provenance 校验（must reference earlier）。
// 同时去重（保持首现顺序）防畸形重叠区间展开后命中宿主 duplicates 校验。
// 返回空数组时调用方应删除该键：宿主对空数组的豁免仅限 assistant/message
//（surface.js assertProvenance），无键对全部事件类型合法且产出更干净。
function remapSourceEventSeqs(seqs, seqMap) {
  const out = []
  const seen = new Set()
  for (const s of seqs) {
    const mapped = seqMap.get(s)
    if (mapped === undefined || seen.has(mapped)) continue
    seen.add(mapped)
    out.push(mapped)
  }
  return out
}

export function convertDshJsonl(raw, args = {}) {
  // 逐行解析带行号明细（畸形行计数不设限，明细封顶 200）+ secrets 位置。崩溃截断的
  // 尾行同样计入畸形行，不静默。
  const { recs, skipped, skippedLines, secrets } = parseJsonlLines(raw)
  // 拿不到可落地引用的图片数（畸形 image 块）：以 [image] 占位并计数
  let imagesDegraded = 0

  const sessionRec = recs.find((r) => r && r.type === 'session' && r.id) || {}
  const headerRec = recs.find((r) => r && r.type === 'request/header' && r.data && r.data.header)
  const header = headerRec ? headerRec.data.header : null
  const config = header && header.config && typeof header.config === 'object' ? header.config : {}

  const sourceId = String(sessionRec.id || '')
  const fileStem = String(args.sourcePath || '').split(/[\\/]/).pop() || ''
  const idSlug = sourceId || fileStem.replace(/\.jsonl(?:\.zstd)?$/i, '')
  const metaId = mintSessionId(idSlug)

  const createdAt = Number.isFinite(sessionRec.createdAt)
    ? sessionRec.createdAt
    : (recs.find((r) => r && typeof r.time === 'number')?.time ?? Date.now())

  const sourceEvents = []
  const oldToNew = new Map()
  for (const ev of recs) {
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
    // 压缩检查点的替换范围（V3 {op,start,end} / V4 {op,startSeq,endSeq}）：原值是重排前 seq，
    // 下方统一重映射（拼写随源日志保留，写目标会话时由 shapeReplaceOps 按宿主世代归一）
    else if (ev.surfaceOp && typeof ev.surfaceOp === 'object') next.surfaceOp = { ...ev.surfaceOp }
    // 保留 tool/result → tool/call 关联；区间对压缩格式先展开（原值是重排前 seq，
    // 下方 remapSourceEventSeqs 统一重映射并丢弃悬空引用）
    if (Array.isArray(ev.sourceEventSeqs)) next.sourceEventSeqs = expandSourceEventSeqs(ev.sourceEventSeqs)
    // 压缩摘要的 shadowedSeqs 同口径（旧宿主可能写成区间对）
    if (ev.type === 'compaction/summary' && Array.isArray(data.shadowedSeqs)) {
      next.data = { ...data, shadowedSeqs: expandSourceEventSeqs(data.shadowedSeqs) }
    }
    // V4 把压缩检查点的 source 换成生产者自有 kind 'compact-checkpoint'（宿主
    // RENAMED_PRODUCERS；本插件旧版曾写歪成 'plugin:compact'）。两种都还原成 V3 形状
    //（写 V4 时由 shapeMessageSources 的 producerKind 再改写一次）——宿主
    // isCompactCheckpointSource 只认检查点标记，认不出就会把它当普通 user 消息
    //（会话引用投影丢摘要、trajectory 不折叠）。
    if (data.source && typeof data.source === 'object'
      && (data.source.kind === 'compact-checkpoint' || data.source.kind === 'plugin:compact')) {
      const { kind: _kind, ...rest } = data.source
      next.data = { ...next.data, source: { kind: 'plugin', plugin: 'compact', ...rest } }
    }
    oldToNew.set(ev.seq, next.seq)
    sourceEvents.push(next)
  }

  // sourceEventSeqs 重映射到新 seq（指向日志内部事件）；无映射（指向被丢弃事件）的
  // 引用一并丢弃，语义见 remapSourceEventSeqs 注释。
  for (const ev of sourceEvents) {
    if (Array.isArray(ev.sourceEventSeqs)) {
      const remapped = remapSourceEventSeqs(ev.sourceEventSeqs, oldToNew)
      if (remapped.length > 0) ev.sourceEventSeqs = remapped
      else delete ev.sourceEventSeqs
    }
    // 压缩摘要的 shadowedSeqs 与检查点的替换范围必须走同一映射（否则检查点与被遮蔽列表
    // 会指向不同事件，宿主 assertProvenance / 遮蔽范围校验直接判不合法）
    if (ev.surfaceOp && typeof ev.surfaceOp === 'object' && ev.surfaceOp.op === 'replace') {
      const startKey = ev.surfaceOp.startSeq === undefined ? 'start' : 'startSeq'
      const endKey = startKey === 'start' ? 'end' : 'endSeq'
      const start = oldToNew.get(ev.surfaceOp[startKey])
      const end = oldToNew.get(ev.surfaceOp[endKey])
      // 端点指向被丢弃事件（畸形日志）时退回 append：摘要仍是可见的 user 消息，
      // 残留括号由 validateSessionEvents 的 compaction-* 检查点名
      ev.surfaceOp = start === undefined || end === undefined ? 'append' : { ...ev.surfaceOp, [startKey]: start, [endKey]: end }
    }
    if (ev.type === 'compaction/summary' && ev.data && Array.isArray(ev.data.shadowedSeqs)) {
      const seqs = remapSourceEventSeqs(ev.data.shadowedSeqs, oldToNew)
      ev.data = { ...ev.data, shadowedSeqs: seqs }
      if (seqs.length > 0) ev.data.shadowedRange = { start: seqs[0], end: seqs[seqs.length - 1] }
      else delete ev.data.shadowedRange
    }
  }

  const titleEvent = sourceEvents.findLast((e) => e.type === 'session/title' && e.data && typeof e.data.title === 'string')
  const title = titleEvent ? String(titleEvent.data.title) : (() => {
    // 跳过本插件自产的上下文注入（环境变更声明）：重导自己的导入会话时它不是用户提问
    const u = sourceEvents.find((e) => e.type === 'user/message' && !isEnvInjectionEvent(e) && e.data && Array.isArray(e.data.content))
    return u ? safeText(u.data.content) : ''
  })()

  const model = (() => {
    if (typeof config.model === 'string') return config.model
    const a = sourceEvents.findLast((e) => e.type === 'assistant/message' && e.data && e.data.message && e.data.message.source && typeof e.data.message.source.model === 'string')
    return a ? a.data.message.source.model : undefined
  })()
  const provider = (() => {
    if (typeof config.provider === 'string') return config.provider
    const a = sourceEvents.findLast((e) => e.type === 'assistant/message' && e.data && e.data.message && e.data.message.source && typeof e.data.message.source.provider === 'string')
    return a ? a.data.message.source.provider : 'dsh'
  })()

  // turns IR（增量续写依赖真实轮次，不能只给计数）：按 turn/start 分组，
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
          } else if (b && b.type === 'image') {
            // DSH 源里图片已是附件引用（同一附件存储域）→ 原样带过，宿主层不重复存
            const img = imageBlockFromSource(b)
            if (img) t.steps[curStep].content.push(img)
            else { imagesDegraded++; t.steps[curStep].content.push({ type: 'text', text: IMAGE_PLACEHOLDER }) }
          }
        }
        stepByTurn.set(curTurn, curStep)
      }
    } else if (ev.type === 'user/message') {
      // 本插件注入的环境变更声明不是用户提问（0.18.3 起它在首个 step/start 之后、
      // 真实提问之前；更早的日志里它排在首个 turn 之前）：不跳过就会顶掉该轮真实 prompt
      if (isEnvInjectionEvent(ev)) continue
      if (curTurn >= 0) {
        const blocks = ev.data && Array.isArray(ev.data.content) ? ev.data.content : []
        const text = contentText(blocks, { sep: '' })
        // 一个 turn 里可能有多条 user/message（steer 追加 / 轮中插话）：文本仍取第一条
        // （IR 每轮只有一个 prompt，既有语义不变），但图片**必须累积**——否则后一条会把
        // 前一条的图片覆盖掉（文本为空时 prompt 恒为 ''，每次都会重设 promptBlocks）。
        const firstUserMessage = turns[curTurn].prompt === '' && turns[curTurn].promptBlocks === undefined
        if (firstUserMessage && text) turns[curTurn].prompt = text
        const userImages = blocks.map((b) => (b && b.type === 'image' ? imageBlockFromSource(b) : null))
          .filter((b) => b !== null)
        if (userImages.length > 0) {
          if (Array.isArray(turns[curTurn].promptBlocks)) turns[curTurn].promptBlocks.push(...userImages)
          else {
            turns[curTurn].promptBlocks = [
              ...(text ? [{ type: 'text', text }] : []),
              ...userImages,
            ]
          }
        }
      }
    } else if (ev.type === 'tool/result') {
      // DSH 把工具身份放在 data.message（content[0].toolCallId 与 source.callId），
      // data 上没有顶层 toolCallId——按真实结构取，否则续写 IR 的 toolResults
      // 恒为空、增量续写读不到已有工具结果。
      const block = ev.data && ev.data.message && Array.isArray(ev.data.message.content)
        ? ev.data.message.content[0] : undefined
      const tid = block && typeof block.toolCallId === 'string' ? block.toolCallId : undefined
      if (curTurn >= 0 && tid) {
        const t = turns[curTurn]
        const stepIdx = stepByTurn.get(curTurn) ?? -1
        const step = stepIdx >= 0 ? t.steps[stepIdx] : null
        if (step) step.toolResults.push({
          toolCallId: tid,
          content: Array.isArray(block.content) ? block.content : [],
          isError: block.isError === true,
        })
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
  // 同步重映射——含区间对展开与悬空引用丢弃，见 remapSourceEventSeqs），保证重导
  // 产物在新旧宿主上都能打开。
  const events = []
  const seqMap = new Map()
  let nextSeq = 0
  let droppedEvents = 0
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
    // 压缩检查点的替换范围：与 sourceEventSeqs 同口径重映射（下面统一做）
    else if (ev.surfaceOp && typeof ev.surfaceOp === 'object') out.surfaceOp = { ...ev.surfaceOp }
    if (Array.isArray(ev.sourceEventSeqs)) out.sourceEventSeqs = expandSourceEventSeqs(ev.sourceEventSeqs)
    if (!normalizePassthroughEvent(out)) { droppedEvents++; continue }
    seqMap.set(ev.seq, nextSeq)
    events.push(out)
    nextSeq++
  }
  for (const ev of events) {
    if (ev.sourceEventSeqs) {
      const remapped = remapSourceEventSeqs(ev.sourceEventSeqs, seqMap)
      if (remapped.length > 0) ev.sourceEventSeqs = remapped
      else delete ev.sourceEventSeqs
    }
    // 压缩事务的重映射：替换范围（V3 start/end、V4 startSeq/endSeq）与被遮蔽序号列表都指向
    // 重排前的 seq，拼写随源日志保留。
    // 有效范围重映射失败（源日志本身就畸形）时退回 append：摘要仍是可见的 user 消息，
    // 残留括号由 validateSessionEvents 的 compaction-* 检查点名，不静默。
    if (ev.surfaceOp && typeof ev.surfaceOp === 'object' && ev.surfaceOp.op === 'replace') {
      const startKey = ev.surfaceOp.startSeq === undefined ? 'start' : 'startSeq'
      const endKey = startKey === 'start' ? 'end' : 'endSeq'
      const start = seqMap.get(ev.surfaceOp[startKey])
      const end = seqMap.get(ev.surfaceOp[endKey])
      if (start === undefined || end === undefined) ev.surfaceOp = 'append'
      else ev.surfaceOp = { ...ev.surfaceOp, [startKey]: start, [endKey]: end }
    }
    if (ev.type === 'compaction/summary' && ev.data && Array.isArray(ev.data.shadowedSeqs)) {
      const seqs = remapSourceEventSeqs(ev.data.shadowedSeqs, seqMap)
      ev.data = { ...ev.data, shadowedSeqs: seqs }
      if (seqs.length > 0) {
        ev.data.shadowedRange = { start: seqs[0], end: seqs[seqs.length - 1] }
      } else {
        delete ev.data.shadowedRange
      }
    }
  }
  const checkpoints = events.filter((e) => e.type === 'user/message' && e.surfaceOp && typeof e.surfaceOp === 'object'
    && e.data && e.data.source && e.data.source.kind === 'plugin' && e.data.source.plugin === 'compact').length

  return {
    // 可选字段按「有才写」展开：meta 会被宿主做无损 JSON 快照（snapshotJsonValue），
    // 值为 undefined 的键直接让 header 被拒（issue #41 ②）。
    meta: {
      version: SESSION_FORMAT_VERSION,
      id: metaId,
      sourceId: sourceId || idSlug,
      ...(typeof sessionRec.cwd === 'string' ? { cwd: sessionRec.cwd } : {}),
      createdAt,
      ...(typeof provider === 'string' && provider ? { provider } : {}),
      ...(typeof model === 'string' && model ? { model } : {}),
    },
    events,
    turns,
    title,
    messages,
    toolCalls,
    skipped,
    skippedLines,
    secrets,
    ...(droppedEvents > 0 ? { droppedEvents } : {}),
    // 图片降级数（>0 才占键）：畸形 image 块以 [image] 占位导入的张数
    ...(imagesDegraded > 0 ? { imagesDegraded } : {}),
    // compacted/compactions：重导保留的原生压缩检查点（源日志里的 compaction/* 事务）
    ...(checkpoints > 0 ? { compacted: true, compactions: checkpoints } : {}),
  }
}
