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
// 图片块两种状态都接受：待落地 { type:'image', data, mediaType, name? }（宿主层经
// ctx.attachments 落成附件）与已是引用 { type:'image', attachment:{...} }（DSH 源回灌、
// 导出再导入）；拿不到合法载荷时降级为 [image] 文本并计入 imagesDegraded。
import {
  SESSION_FORMAT_VERSION,
  IMAGE_PLACEHOLDER,
  applyBudgetTrim,
  imageBlockFromSource,
  mintSessionId,
  parseTimeMs,
  synthesizeSession,
} from './core.mjs'
import { sanitizeUsage } from './events.mjs'

/** 内容标记值（与 export/index.mjs 的 bundle 标记同源字符串，两处都不得单方面改名）。 */
export const INTERCHANGE_MARKER = 'dsh-chat-import'
/** 本插件当前只认 v1；升版本必须同时改这里、INTERCHANGE.md 与 bundle 的 format 字段。 */
export const INTERCHANGE_VERSION = 1

// 标题归一统一规则：去首尾空白、折叠内部空白；超 80 字符截断加省略号（各源文件内联同款）。
const TITLE_MAX_LEN = 80
const TITLE_ELLIPSIS = '…'
function normalizeTitle(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return ''
  return t.length <= TITLE_MAX_LEN ? t : t.slice(0, TITLE_MAX_LEN - TITLE_ELLIPSIS.length) + TITLE_ELLIPSIS
}

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
// 未知类型计数丢弃。返回 { blocks, skipped, imagesDegraded }。
function sanitizeBlocks(input) {
  const blocks = []
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
    if (b.type === 'tool-result' && typeof b.toolCallId === 'string' && b.toolCallId) {
      const inner = sanitizeBlocks(b.content)
      skipped += inner.skipped
      imagesDegraded += inner.imagesDegraded
      blocks.push({
        type: 'tool-result',
        toolCallId: b.toolCallId,
        content: inner.blocks,
        ...(b.isError === true ? { isError: true } : {}),
      })
      continue
    }
    skipped += 1
  }
  return { blocks, skipped, imagesDegraded }
}

// 0 轮 / 整体拒绝的统一返回（形状与其它转换器一致，调用方只看 skipReason）。
function rejected(reason, extra = {}) {
  return {
    meta: null, events: [], turns: [], title: null, messages: 0, toolCalls: 0,
    skipped: 0, records: 0, skippedLines: [], secrets: [], permissionCount: 0,
    ...extra, skipReason: reason,
  }
}

export function convertGenericJson(raw, args = {}) {
  let doc = raw
  if (typeof raw === 'string') {
    try {
      doc = JSON.parse(raw)
    } catch (err) {
      return rejected('generic: 文档不是合法 JSON（' + String((err && err.message) || err) + '）')
    }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return rejected('generic: 顶层不是对象')
  if (doc.bundle === INTERCHANGE_MARKER) {
    return rejected('generic: 这是 .dshbundle 便携包（"bundle" 标记），请用 restore_bundle 还原')
  }
  if (doc.interchange !== undefined && doc.interchange !== INTERCHANGE_MARKER) {
    return rejected('generic: 未知内容标记 interchange=' + JSON.stringify(doc.interchange))
  }
  if (doc.interchange === INTERCHANGE_MARKER && Number(doc.version) !== INTERCHANGE_VERSION) {
    return rejected('generic: 不支持的 interchange 版本 ' + JSON.stringify(doc.version)
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
      const content = sanitizeBlocks(s.content)
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
      for (const r of Array.isArray(s.toolResults) ? s.toolResults : []) {
        if (!r || typeof r !== 'object' || typeof r.toolCallId !== 'string' || !r.toolCallId) { droppedToolResults += 1; continue }
        const inner = sanitizeBlocks(r.content)
        skippedBlocks += inner.skipped
        imagesDegraded += inner.imagesDegraded
        const result = { toolCallId: r.toolCallId, content: inner.blocks, isError: r.isError === true }
        const rt = parseTimeMs(r.time)
        if (rt !== null) result.time = rt
        step.toolResults.push(result)
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
    return rejected('generic: 文档没有可导入的轮次（turns 为空或全部畸形）', {
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
  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, args.budget)
  const syn = synthesizeSession({
    meta,
    turns: seedTurns,
    provider,
    model,
    // 畸形行的口径：本文档是整体 JSON，没有「逐行」概念——明细走下面的 malformedTurns /
    // malformedSteps / skippedBlocks 计数；skipped 恒为 0（不用 undefined 占键：结果是
    // 对外契约，schema 里它是整数）。
    skipped: 0,
    ...(args.sourcePath ? { imported: { sourcePath: args.sourcePath } } : {}),
  })
  return {
    ...syn,
    title,
    malformedTurns,
    malformedSteps,
    skippedBlocks,
    imagesDegraded,
    droppedToolResults,
    usageDropped,
    ...(trimmed ? { trimmed } : {}),
  }
}
