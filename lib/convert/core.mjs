// lib/convert/core.mjs — 共享转换核心（纯函数，无宿主依赖）
//
// 各源格式的 `convertXxx(raw, args)`（同目录每个来源一个文件；权威清单是 lib/discovery.mjs
// 的 FORMATS）把原始 transcript 解析成统一的回合中间结构，再经本模块的 finishSession
// （预算裁剪 trim.mjs + 事件合成 events.mjs）落成 DSH 事件日志，保证所有源事件纪律一致。
// 本模块收各源共用的基础件：格式版本、时间戳与会话 id 口径、Claude 风格内容块映射、
// 逐行 JSONL 解析（含畸形行与疑似 secret 上报）、增量续写的尾部截取。
import { applyBudgetTrim } from './trim.mjs'
import { synthesizeSession } from './events.mjs'
import { isEnvInjectionEvent } from './shape.mjs'
import { imageBlockFromSource } from './image.mjs'

// 宿主会话格式版本（dsh 的 SESSION_FORMAT_VERSION；0.1.5 起为 3）。写进 meta.version，
// 由宿主 header 校验逐字比对——版本不符的 create 会被直接拒绝（"session header
// version must be 3"）。纯函数层取当前宿主的 3 作为默认值；ctx 层落盘前再用宿主
// 实际版本覆盖（见 lib/import-core.mjs 的 applyHostMeta），让插件跟随宿主升级。
export const SESSION_FORMAT_VERSION = 3

// 时间戳 → 毫秒（全部来源的唯一口径）。数字是 Unix 秒（< 1e11）或毫秒（≥ 1e11），结果
// 取整为安全整数——宿主要求事件 time / header.createdAt 是安全整数，而 ChatGPT 导出的
// create_time 是带小数的秒（如 1767583930.285031），直接 ×1000 得到浮点毫秒会让整份会话
// 被拒；字符串按 Date.parse。拿不到 / 畸形返回 null：逐记录时间参与会话时钟推进，用
// 「现在」顶替会让后续事件倒挂、耗时统计失真。
// truncSeconds：秒值先截断到整秒再换算（hermes / vibe 对齐 cc-switch 按整秒取时间的
// 口径）；缺省保留小数秒的毫秒精度。
export function parseTimeMs(value, { truncSeconds = false } = {}) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    const ms = Math.round(value < 1e11 ? (truncSeconds ? Math.trunc(value) : value) * 1000 : value)
    return Number.isSafeInteger(ms) ? ms : null
  }
  if (typeof value === 'string') {
    const n = Date.parse(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

// 必须有值的时间（meta.createdAt 等）：同 parseTimeMs，拿不到时回退当前时刻。
export function parseTime(value) {
  return parseTimeMs(value) ?? Date.now()
}

// 转换器收尾：turns 先过预算裁剪（budget 缺省/非正数即不裁），再合成事件日志；extra
//（标题、各源计数）覆盖/追加在合成结果上。compacted（实际发射了原生压缩检查点）与
// trimmed（预算保护实际生效）只在为真时占键。synth 是 synthesizeSession 的其余入参。
export function finishSession(turns, budget, synth, extra) {
  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, budget)
  const syn = synthesizeSession({ ...synth, turns: seedTurns })
  return {
    ...syn,
    ...extra,
    ...(syn.compactions ? { compacted: true } : {}),
    ...(trimmed ? { trimmed } : {}),
  }
}

// 把源 sessionId 折成合法的 DSH SessionId 片段。
export function mintSessionId(sourceId) {
  const slug = String(sourceId || '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 64)
  return 'import-' + (slug || String(Date.now()))
}

// Claude content block → DSH content block。文本→text、思考→reasoning、工具调用→tool-call、
// 图片→IR image 块（待宿主层落成附件；拿不到字节时返回 null，由调用方降级占位并计数）。
export function mapContentBlock(block) {
  if (!block) return null
  if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text }
  if (block.type === 'thinking' && typeof block.thinking === 'string') return { type: 'reasoning', text: block.thinking }
  if (block.type === 'image') return imageBlockFromSource(block)
  if (block.type === 'tool_use') {
    return { type: 'tool-call', id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) }
  }
  return null
}

// 从一次完整转换中截取「第 fromTurn 轮及之后」的事件尾部，seq 从 fromSeq 重新编号（供
// 增量续写：重导把源文件新增轮次 append 进同一 DSH 会话）：
//   * 轮次边界由 turn/start 事件的 data.turn 决定（不是每个事件都带 data.turn）；
//   * session/title（无 turn）默认剥离（dropSessionEvents=true）——标题只在全量导入时写一次；
//     旧日志头部的 session/imported 标记（无 turn 包裹）同样不进尾部；
//   * 环境变更声明（isEnvInjectionEvent）恒不入选——它位于首个 turn 内、前段已有一条，
//     按轮次入选会在续写尾部中间再插一条注入；
//   * sourceEventSeqs 重映射到尾部新 seq；指向尾部之外的引用（跨轮异步工具：调用在已导入
//     前段、结果在新增尾部）原样保留——前段 seq 未变，旧值仍指向真实调用——并计入
//     droppedBoundaryResults；
//   * 其余字段原样保留（surfaceOp 等随事件走，续写不重写、不附加标题）。
export function tailSessionEvents(converted, { fromTurn, fromSeq, dropSessionEvents = true }) {
  const keep = []
  const oldToNew = new Map()
  let currentTurn = null
  let droppedBoundaryResults = 0
  for (const ev of converted.events ?? []) {
    if (ev && ev.type === 'turn/start' && ev.data && typeof ev.data.turn === 'number') {
      currentTurn = ev.data.turn
    }
    if (ev && ev.type === 'session/title') {
      if (dropSessionEvents) continue
      oldToNew.set(ev.seq, fromSeq + keep.length)
      keep.push(ev)
      continue
    }
    if (isEnvInjectionEvent(ev)) continue
    if (currentTurn !== null && currentTurn >= fromTurn) {
      if (Array.isArray(ev.sourceEventSeqs)) {
        for (const s of ev.sourceEventSeqs) {
          // 引用不在已处理的尾内事件里 → 指向尾外（前段 seq 未变，原样保留合法）
          if (!oldToNew.has(s)) droppedBoundaryResults++
        }
      }
      oldToNew.set(ev.seq, fromSeq + keep.length)
      keep.push(ev)
    }
  }
  return {
    firstTurn: fromTurn,
    droppedBoundaryResults,
    events: keep.map((ev, i) => {
      const next = { ...ev, seq: fromSeq + i }
      if (Array.isArray(ev.sourceEventSeqs)) {
        next.sourceEventSeqs = ev.sourceEventSeqs.map((s) => (oldToNew.has(s) ? oldToNew.get(s) : s))
      }
      return next
    }),
  }
}

// 畸形行明细封顶条数（计数 skipped 不设限）。
export const SKIPPED_LINES_CAP = 200

// 疑似 secrets 的保守正则清单（按优先级排列，首个命中即报告该 kind，去重）：
//   api-key：sk- 前缀（Anthropic/OpenAI）与 api_key / api-key 赋值；
//   token：ghp_ 前缀（GitHub PAT）与 token 赋值；
//   password / secret：对应关键字赋值；
//   authorization：Authorization 头（含 Bearer）。
// 只做「疑似」上报，不追求精确；键名与值都接受引号包裹（JSON 里 `"token": "x"`）。
// hint = 该正则匹配文本的必含子串（/i 正则按小写化行判定）：正则命中 ⇒ 行内含 hint，
// 预筛不命中必不命中——把不含任何关键字的干净行挡在正则测试之前。工具输出行动辄
// 数 KB，7 条正则各扫一遍全文占 parseJsonlLines 的一半开销（实测 30ms/44MB → 11.6ms）。
const SECRET_PATTERNS = [
  { kind: 'api-key', re: /\bsk-[A-Za-z0-9_-]{8,}\b/, hint: 'sk-' },
  { kind: 'token', re: /\bghp_[A-Za-z0-9]{20,}\b/, hint: 'ghp_' },
  { kind: 'api-key', re: /\bapi[_-]?key\s*["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{8,}\b/i, hint: 'key' },
  { kind: 'token', re: /\btoken\s*["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{8,}\b/i, hint: 'token' },
  { kind: 'password', re: /\bpassword\s*["']?\s*[:=]\s*["']?[^\s"']{4,}\b/i, hint: 'password' },
  { kind: 'secret', re: /\bsecret\s*["']?\s*[:=]\s*["']?[^\s"']{4,}\b/i, hint: 'secret' },
  { kind: 'authorization', re: /\bauthorization\s*["']?\s*[:=]\s*["']?(?:bearer\s+)?[A-Za-z0-9._~+/=-]{10,}\b/i, hint: 'authorization' },
]

// 命中 kind 数组（按正则优先级去重）；无命中返回空数组。
// 行先小写化一次，全部 hint 都在其上 indexOf（native 快速搜索）；全部不命中 →
// 零次正则测试直接返回，命中才对原行跑对应正则。
export function detectSecretKinds(line) {
  const s = String(line)
  const lower = s.toLowerCase()
  const kinds = []
  for (const { kind, re, hint } of SECRET_PATTERNS) {
    if (!lower.includes(hint)) continue
    if (!re.test(s)) continue
    if (!kinds.includes(kind)) kinds.push(kind)
  }
  return kinds
}

// JSON.parse 错误消息可能内嵌行内容片段（V8 的 `Unexpected token 'x', "…" is not valid
// JSON`，行中段出错时是带省略号的 `..."…"...` 形态；片段内可含嵌套引号，也可能含
// secret）——从片段的起始引号到 ` is not valid JSON` 之间整段替换为 `"…"` 后截断到 160
// 字符，绝不携带行内容；无片段的消息（纯位置描述）原样保留。凡把解析错误交给结果或
// 用户的地方都经由本函数。
export function sanitizeParseError(err) {
  const msg = String((err && err.message) || err)
    .replace(/"[\s\S]*(?= is not valid JSON)/, '"…"')
  return msg.length <= 160 ? msg : msg.slice(0, 160) + '…'
}

// 逐行 JSONL 解析（全部逐行来源共用，畸形行与疑似 secret 的上报口径由此统一）。返回
// { recs, skipped, skippedLines, secrets }：
//   recs        成功解析的记录；requireObject=true 时只含对象（其余计入 skipped）；
//   skipped     畸形行计数（不设限）；
//   skippedLines 行号明细 [{ line, error }]（行号从 1 起），封顶 SKIPPED_LINES_CAP 条；
//   secrets     疑似 secret 位置 [{ line, kind }]，每行至多一条（首个命中 kind）。
// 空白行忽略（不计 skipped）。整文件来源没有行的概念，只回 skippedLines: []（不虚构行号）。
export function parseJsonlLines(raw, { requireObject = false } = {}) {
  const recs = []
  let skipped = 0
  const skippedLines = []
  const secrets = []
  const lines = String(raw ?? '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t) continue
    const kinds = detectSecretKinds(t)
    if (kinds.length > 0) secrets.push({ line: i + 1, kind: kinds[0] })
    let rec
    try {
      rec = JSON.parse(t)
    } catch (err) {
      skipped++
      if (skippedLines.length < SKIPPED_LINES_CAP) {
        skippedLines.push({ line: i + 1, error: sanitizeParseError(err) })
      }
      continue
    }
    if (requireObject && (!rec || typeof rec !== 'object')) {
      skipped++
      if (skippedLines.length < SKIPPED_LINES_CAP) {
        skippedLines.push({ line: i + 1, error: 'non-object record' })
      }
      continue
    }
    recs.push(rec)
  }
  return { recs, skipped, skippedLines, secrets }
}

// 合成与校验的既有导入路径（测试直接从 core 取这两个入口）。
export { synthesizeSession } from './events.mjs'
export { validateSessionEvents } from './validate.mjs'
