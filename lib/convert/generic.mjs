// lib/convert/generic.mjs — generic（interchange v1 会话文档）→ DSH 会话（纯函数）
//
// 对外契约见 docs/INTERCHANGE.md §1：一份 JSON 文档，
//   { "interchange": "dsh-chat-import", "version": 1, "meta": {...}, "turns": [...] }
// 内容标记（interchange 键）让文件导入的探测层第一级直接命中，不必按路径猜、也不必
// 试遍所有转换器。这份文档同时是「长尾来源」的落点：agent/skill 把任意外部工具的
// 转录写成它，插件按普通文件导入即可，不需要为每个来源内置转换器。
//
// 校验与降级（D4 失败要大声，绝不静默）：
//   * 内容标记存在但版本 ≠ 1 → 整体拒绝（不猜、不半读）；
//   * .dshbundle 便携包（"bundle" 标记）不是本格式 → 拒绝并指向 restore_bundle；
//   * 未知块类型 / 拿不到字节的图片（降级 [image] 占位）/ 畸形的轮与步 / 孤儿工具结果 /
//     非法 usage 全部计数，随结果透出；
//   * 0 轮文档给出 skipReason（调用方据此拒绝导入空壳会话——blank 会话在宿主侧栏不可见）。
// turns 的形状与各源转换器产出的 IR 一致（prompt / promptBlocks / steps / time / usage /
// compaction / shadowed / aborted）；本文件只做校验与归一，不虚构任何内容。
//
// 工具结果的落点：写在 step `content` 里的 `tool-result` 块按 toolCallId 派生进
// `step.toolResults`（显式列表优先，与 tool-call 块的派生对称）；写在 promptBlocks 或结果
// 内层的结果块无处安放，丢弃并计入 skippedBlocks。正文里绝不残留结果包装——宿主 V4 codec
//（dsh-session-format-v3-to-v4）见到解释性 content 里的 tool-result 即拒载整份日志。
//
// 图片块两种状态都接受：待落地 { type:'image', data, mediaType, name? }（宿主层经
// ctx.attachments 落成附件）与已是引用 { type:'image', attachment:{...} }（DSH 源回灌、
// 导出再导入）；拿不到合法载荷时降级为 [image] 文本并计入 imagesDegraded。
import {
  SESSION_FORMAT_VERSION,
  finishSession,
  mintSessionId,
  parseTimeMs,
  sanitizeParseError,
} from './core.mjs'
import { IMAGE_PLACEHOLDER, imageBlockFromSource } from './image.mjs'
import { sanitizeUsage } from './events.mjs'
import { normalizeTitle, skipResult } from './util.mjs'

/** 内容标记值（与 export/index.mjs 的 bundle 标记同源字符串，两处都不得单方面改名）。 */
export const INTERCHANGE_MARKER = 'dsh-chat-import'
/** 本插件当前只认 v1；升版本必须同时改这里、INTERCHANGE.md 与 bundle 的 format 字段。 */
const INTERCHANGE_VERSION = 1

// ── 内容标记嗅探（探测层第一级）──────────────────────────────────
// 只扫前 64KB：大文件不必整读，标记按契约出现在文档顶部；扫不到就交给下一级探测。
// 返回 'generic'（interchange 文档）/ 'bundle'（便携包）/ null。
const MARKER_RE = /"(interchange|bundle)"\s*:\s*"dsh-chat-import"/
export function sniffInterchangeMarker(raw) {
  if (typeof raw !== 'string') return null
  const m = MARKER_RE.exec(raw.slice(0, 65536))
  if (!m) return null
  return m[1] === 'bundle' ? 'bundle' : 'generic'
}

// 内容块归一：只认 IR 的已知块类型（text / reasoning / image / tool-call / tool-result），
// 未知类型计数丢弃。返回 { blocks, toolResults, skipped, imagesDegraded }。
//
// tool-result 是**结果容器**的块类型，不是正文块：宿主 V4 codec（dsh-session-format-v3-to-v4
// 的 assertV4RetiredSyntax）见到 assistant/user 等解释性 content 里的 tool-result 包装即
// 拒载整份日志（"must not contain a released tool-result wrapper"，issue #77）。所以正文
// 里不许留结果块：
//   * collectToolResults=true（step.content 专用）——结果块收集进 toolResults 交调用方并入
//     step.toolResults（与 tool-call 块的派生对称，内容不丢）；
//   * 其它位置（promptBlocks / 结果内层 content）无处安放——整块丢弃并计入 skipped
//     （不虚构、也不硬塞进别处）。丢弃的整块不再递归计数内层图片：内容已经不要了。
function sanitizeBlocks(input, collectToolResults = false) {
  const blocks = []
  const toolResults = []
  let skipped = 0
  let imagesDegraded = 0
  for (const b of Array.isArray(input) ? input : []) {
    if (!b || typeof b !== 'object') { skipped += 1; continue }
    if (b.type === 'text' && typeof b.text === 'string') { blocks.push({ type: 'text', text: b.text }); continue }
    if (b.type === 'reasoning' && typeof b.text === 'string') { blocks.push({ type: 'reasoning', text: b.text }); continue }
    if (b.type === 'image') {
      const mapped = imageBlockFromSource(b)
      if (mapped) blocks.push(mapped)
      else { blocks.push({ type: 'text', text: IMAGE_PLACEHOLDER }); imagesDegraded += 1 }
      continue
    }
    if (b.type === 'tool-call' && typeof b.id === 'string' && b.id && typeof b.name === 'string' && b.name) {
      const args = typeof b.arguments === 'string' ? b.arguments
        : b.arguments === undefined || b.arguments === null ? '{}'
          : JSON.stringify(b.arguments)
      blocks.push({ type: 'tool-call', id: b.id, name: b.name, arguments: args })
      continue
    }
    if (b.type === 'tool-result') {
      if (!collectToolResults || typeof b.toolCallId !== 'string' || !b.toolCallId) { skipped += 1; continue }
      const inner = sanitizeBlocks(b.content)
      skipped += inner.skipped
      imagesDegraded += inner.imagesDegraded
      toolResults.push({ toolCallId: b.toolCallId, content: inner.blocks, isError: b.isError === true })
      continue
    }
    skipped += 1
  }
  return { blocks, toolResults, skipped, imagesDegraded }
}


export function convertGenericJson(raw, args = {}) {
  let doc = raw
  if (typeof raw === 'string') {
    try {
      doc = JSON.parse(raw)
    } catch (err) {
      return skipResult('generic: 文档不是合法 JSON（' + sanitizeParseError(err) + '）')
    }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return skipResult('generic: 顶层不是对象')
  if (doc.bundle === INTERCHANGE_MARKER) {
    return skipResult('generic: 这是 .dshbundle 便携包（"bundle" 标记），请用 restore_bundle 还原')
  }
  if (doc.interchange !== undefined && doc.interchange !== INTERCHANGE_MARKER) {
    return skipResult('generic: 未知内容标记 interchange=' + JSON.stringify(doc.interchange))
  }
  if (doc.interchange === INTERCHANGE_MARKER && Number(doc.version) !== INTERCHANGE_VERSION) {
    return skipResult('generic: 不支持的 interchange 版本 ' + JSON.stringify(doc.version)
      + '（本插件只认 v' + INTERCHANGE_VERSION + '）')
  }

  let malformedTurns = 0
  let malformedSteps = 0
  let skippedBlocks = 0
  let imagesDegraded = 0
  let droppedToolResults = 0
  let usageDropped = 0
  const turns = []

  for (const t of Array.isArray(doc.turns) ? doc.turns : []) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) { malformedTurns += 1; continue }
    const turn = { prompt: typeof t.prompt === 'string' ? t.prompt : '', steps: [] }
    const turnTime = parseTimeMs(t.time)
    if (turnTime !== null) turn.time = turnTime
    const promptBlocks = sanitizeBlocks(t.promptBlocks)
    skippedBlocks += promptBlocks.skipped
    imagesDegraded += promptBlocks.imagesDegraded
    if (promptBlocks.blocks.length > 0) turn.promptBlocks = promptBlocks.blocks
    if (t.aborted === true) turn.aborted = true
    if (t.shadowed === true) turn.shadowed = true
    const comp = t.compaction
    if (comp && typeof comp === 'object' && typeof comp.summary === 'string' && comp.summary.trim()) {
      turn.compaction = {
        summary: comp.summary,
        provider: typeof comp.provider === 'string' && comp.provider ? comp.provider : 'generic',
      }
      if (typeof comp.model === 'string' && comp.model) turn.compaction.model = comp.model
      const ct = parseTimeMs(comp.time)
      if (ct !== null) turn.compaction.time = ct
    }
    for (const s of Array.isArray(t.steps) ? t.steps : []) {
      if (!s || typeof s !== 'object' || Array.isArray(s)) { malformedSteps += 1; continue }
      const step = { content: [], toolCalls: [], toolResults: [] }
      const stepTime = parseTimeMs(s.time)
      if (stepTime !== null) step.time = stepTime
      if (typeof s.model === 'string' && s.model) step.model = s.model
      if (s.usage && typeof s.usage === 'object') {
        // usage 守卫在 events.mjs（写入 assistant/message.data.usage 前的最后一道）；
        // 这里提前校验一次，为的是把「给了但非法」的用量大声计出来，而不是静默丢弃。
        if (sanitizeUsage(s.usage)) step.usage = s.usage
        else usageDropped += 1
      }
      const content = sanitizeBlocks(s.content, true)
      skippedBlocks += content.skipped
      imagesDegraded += content.imagesDegraded
      step.content.push(...content.blocks)
      // 工具调用：显式 toolCalls 列表为准；列表缺失/漏项时从 content 里的 tool-call 块派生
      //（IR 允许两种写法，synthesizeSession 只从 step.toolCalls 发 tool/call 事件）。
      const seen = new Set()
      for (const c of Array.isArray(s.toolCalls) ? s.toolCalls : []) {
        if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id || typeof c.name !== 'string' || !c.name) continue
        if (seen.has(c.id)) continue
        const cArgs = typeof c.arguments === 'string' ? c.arguments
          : c.arguments === undefined || c.arguments === null ? '{}'
            : JSON.stringify(c.arguments)
        step.toolCalls.push({ id: c.id, name: c.name, arguments: cArgs })
        seen.add(c.id)
      }
      for (const b of step.content) {
        if (b.type !== 'tool-call' || seen.has(b.id)) continue
        step.toolCalls.push(b)
        seen.add(b.id)
      }
      const seenResults = new Set()
      for (const r of Array.isArray(s.toolResults) ? s.toolResults : []) {
        if (!r || typeof r !== 'object' || typeof r.toolCallId !== 'string' || !r.toolCallId) { droppedToolResults += 1; continue }
        const inner = sanitizeBlocks(r.content)
        skippedBlocks += inner.skipped
        imagesDegraded += inner.imagesDegraded
        const result = { toolCallId: r.toolCallId, content: inner.blocks, isError: r.isError === true }
        const rt = parseTimeMs(r.time)
        if (rt !== null) result.time = rt
        step.toolResults.push(result)
        seenResults.add(r.toolCallId)
      }
      // 结果块从 content 派生：显式 toolResults 列表为准，列表缺失/漏项时补上（与上面
      // tool-call 的派生对称）。同一 toolCallId 只保留首现（显式列表里的重复由
      // synthesizeSession 按既有口径计 duplicateToolResults，此处不改写该行为）。
      for (const r of content.toolResults) {
        if (seenResults.has(r.toolCallId)) continue
        step.toolResults.push(r)
        seenResults.add(r.toolCallId)
      }
      turn.steps.push(step)
    }
    // 既无提问、又无步骤、也没有压缩摘要的轮没有任何内容可落盘：计数丢弃（不产出空轮）。
    if (!turn.prompt.trim() && turn.steps.length === 0 && !turn.compaction) { malformedTurns += 1; continue }
    turns.push(turn)
  }

  // 孤儿工具结果（toolCallId 在任何步里都找不到对应调用）：synthesizeSession 不会发射它，
  // 内容会静默消失——这里先识别出来计数（内容不虚构、也不硬塞进别处）。
  const callIds = new Set()
  for (const t of turns) for (const s of t.steps) for (const c of s.toolCalls) callIds.add(c.id)
  for (const t of turns) {
    for (const s of t.steps) {
      const kept = []
      for (const r of s.toolResults) {
        if (callIds.has(r.toolCallId)) kept.push(r)
        else droppedToolResults += 1
      }
      s.toolResults = kept
    }
  }

  if (turns.length === 0) {
    return skipResult('generic: 文档没有可导入的轮次（turns 为空或全部畸形）', {
      malformedTurns, malformedSteps, skippedBlocks, imagesDegraded, droppedToolResults, usageDropped,
    })
  }

  const rawMeta = doc.meta && typeof doc.meta === 'object' ? doc.meta : {}
  const sourceId = typeof rawMeta.sourceId === 'string' && rawMeta.sourceId ? rawMeta.sourceId
    : typeof rawMeta.id === 'string' && rawMeta.id ? rawMeta.id : null
  // 会话 id 一律走 mintSessionId（与所有内置源一致：宿主侧看到的永远是 import-<slug>，
  // 文档里的 meta.id 只当 slug 来源）。外部文档直接指定宿主会话 id 会把命名约定交给来源，
  // 与 D13 的副本命名（import-<id>-<n>）也对不上。
  const sessionId = args.sessionId || mintSessionId(sourceId || rawMeta.id || args.fileStem || 'generic')
  const createdAt = parseTimeMs(rawMeta.createdAt)
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: createdAt !== null ? createdAt : Date.now() }
  if (sourceId) meta.sourceId = sourceId
  const cwd = typeof rawMeta.cwd === 'string' && rawMeta.cwd ? rawMeta.cwd : (typeof args.cwd === 'string' && args.cwd ? args.cwd : null)
  if (cwd) meta.cwd = cwd

  const provider = typeof doc.provider === 'string' && doc.provider ? doc.provider : 'generic'
  const model = typeof doc.model === 'string' && doc.model ? doc.model : null
  const title = normalizeTitle(typeof doc.title === 'string' && doc.title ? doc.title : turns[0].prompt)
  return finishSession(turns, args.budget, {
    meta,
    provider,
    model,
    // 畸形行的口径：本文档是整体 JSON，没有「逐行」概念——明细走下面的 malformedTurns /
    // malformedSteps / skippedBlocks 计数；skipped 恒为 0（不用 undefined 占键：结果是
    // 对外契约，schema 里它是整数）。
    skipped: 0,
  }, { title, malformedTurns, malformedSteps, skippedBlocks, imagesDegraded, droppedToolResults, usageDropped })
}
