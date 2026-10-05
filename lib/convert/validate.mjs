// lib/convert/validate.mjs — 导入事件日志的轻量结构校验（verify_session 与导入落盘共用）。
//
// 白名单 = 本插件自产标记 + 宿主 @deepseek-ai/dsh-session 的已知事件词汇表；对齐宿主
// KNOWN_SESSION_EVENT_TYPES，只对真正未知的类型报警（宿主每加事件类型都要同步，否则会
// 把合法事件误报成 unknown-type，把真正的结构问题挤出上报上限）。
//
// 迁移风险在这里点名（宿主迁移器 / V4 codec fail-closed 的形状）：
//   * surface-before-first-step：第一个 step/start 之前出现 surface 事件 → v2→v3 迁移拒载；
//   * system-head-missing：surface 已有别的 surface 事件而 protected head 未建立 →
//     v3→v4 迁移拒载（"system/message requires a protected first surface head"）；
//   * compaction-*：原生压缩事务（start/summary/替换用检查点/end）括号不配对、遮蔽范围与
//     shadowedSeqs 不一致、检查点标记与括号 compactionId 不一致、sourceEventSeqs 漏掉被遮蔽
//     节点 → 宿主 SurfaceManager 的 assertProvenance 会直接拒载整份日志；
//   * retired-tool-result-wrapper：解释性 content 槽位里残留 `tool-result` 包装（V4 退休语法）
//     → 宿主 V4 codec 见即拒载整份日志。
// ── 会话事件结构校验────────────────────────────────────────────
// 轻量自检：seq 连续无重复、事件类型白名单、surface 事件必须带 surfaceOp
//（'append' 或 compaction 的 replace 对象）、tool/result 的 sourceEventSeqs 必须
// 指向集合内存在的 tool/call（其它 surface 事件在原生会话可指向 assistant/chunk
// 等源事件，不校验）、首个 step/start 之前不得有 surface 事件（见下）。指向集合外的
// 引用合法（append 尾片的跨轮引用指向前段已导入事件，此处无法验证）——不报。
// 返回 { ok, problems: [{ kind, seq, message }] }，problems 封顶
// VALIDATION_PROBLEM_CAP 条；畸形条目（缺 seq / 非对象）以 null seq 上报。
// verify_session 面向「已导入/任意 DSH 会话」：原生 DSH 会话含 permission/preset、
// sandbox/mode、assistant/chunk、request/header 等运行时/状态事件，硬编码小清单
// 会持续落后宿主而把这些合法事件误报为 unknown-type。故对齐宿主
// KNOWN_SESSION_EVENT_TYPES（0.1.1-rc.2，见 dsh-session/lib/types/known-event-types.js），
// 仅对真正未知的类型报警；导入保留的 durable 类型仍由 convert/dsh.mjs 的 DURABLE 集合
// 单独控制，与本白名单无关。
//
// surface-before-first-step（issue #66）：第一个 step/start 之前出现 surface 事件时，
// 宿主 v2→v3 迁移在首个 step/start 处插入 system head 会改变时序，迁移器 fail-closed
// 拒绝整份日志（"format v2 surface before first step cannot acquire a system head
// without changing chronology"）→ 旧格式工件打不开、读路径（导出/撤回/校验）也
// 读不到。本插件不再产出该形状（环境变更声明在首个 step/start 之后），此检查让「存量
// 旧格式工件」在导入/校验时就能被点名，而不是等宿主迁移时静默拒载。
export const SESSION_EVENT_TYPES = [
  // 本插件自产 / 客户端流事件（宿主词汇表外，见上）
  'session/imported',
  'assistant/chunk',
  // 以下对齐宿主 @deepseek-ai/dsh-session 的 KNOWN_SESSION_EVENT_TYPES（0.1.5 时代，
  // 含 system/message、developer/message、assistant/attempt、model/selection、
  // subagent/catalog、deliverables/presented、image/offload、workspace/changes、
  // tool/ptc-dispatch* 等新事件）。白名单滞后会把宿主合法事件误报成 unknown-type——
  // 2026-09-22 实测：一个 V4 会话里有 4 种新事件被误报，把真正的问题挤出上报上限。
  'agent-preset/selected',
  'agent/inbox/spliced',
  'approval/asked', 'approval/decided', 'approval/policy',
  'assistant/attempt', 'assistant/message',
  'command/done', 'command/run',
  'compaction/end', 'compaction/prune', 'compaction/start', 'compaction/summary',
  'deliverables/presented',
  'developer/message',
  'feedback/message-delete', 'feedback/message-put', 'feedback/record',
  'goal/change',
  'hook/invoked', 'hook/result',
  'image/offload',
  'llm/retry', 'llm/retry-started',
  'model/selection',
  'permission/preset',
  'plan/mode',
  'request/header', 'request/context',
  'sandbox/mode',
  'schedule/change',
  'session-log-deepseek/delivery-accepted',
  'session/end-seed',
  'session/title', 'session/title-llm-request',
  'step/start', 'step/end',
  'subagent/catalog', 'subagent/descriptor', 'subagent/model-selection-policy',
  'system/message',
  'team/member', 'team/message/delivered', 'team/message/queued', 'team/task',
  'todo/write',
  'tool-workflow/agent-end', 'tool-workflow/agent-start', 'tool-workflow/run-end', 'tool-workflow/run-start',
  'tool/call', 'tool/result',
  'tool/code-dispatch', 'tool/code-dispatch-start',
  'tool/ptc-dispatch', 'tool/ptc-dispatch-start',
  'turn/start', 'turn/end',
  'user/message',
  'web/deepseek-search-llm-request',
  'workspace/changes',
]
// 白名单的 Set 镜像：逐事件判定 O(1)（数组 includes 是整表线性扫，10 万事件会话上白花
// 数倍校验耗时）；数组本身是导出契约，保持不变。
const SESSION_EVENT_TYPES_SET = new Set(SESSION_EVENT_TYPES)
// 与宿主 SURFACE_TYPES 同口径（system/message 与 developer/message 也是 surface 事件）
const SURFACE_EVENT_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
export const VALIDATION_PROBLEM_CAP = 20

// 事件里是否含「带内联 data 的图片块」（应已由 lib/attachments.mjs 落成 attachment 引用）。
// 递归进 tool-result 的内层 content：V3 wrapper 与 V4 一级 content 两种形状都覆盖。
function hasInlineImageData(ev, depth = 0) {
  if (depth > 3) return false
  const data = ev && typeof ev.data === 'object' && ev.data !== null ? ev.data : null
  if (!data) return false
  const message = data.message && typeof data.message === 'object' ? data.message : null
  for (const blocks of [message && message.content, data.content]) {
    if (!Array.isArray(blocks)) continue
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'image' && typeof b.data === 'string' && b.data.length > 0) return true
      if (b.type === 'tool-result' && Array.isArray(b.content) && hasInlineImageData({ data: { content: b.content } }, depth + 1)) return true
    }
  }
  return false
}

// 宿主 V4 codec 的退休语法（dsh-session-format-v3-to-v4：assertV4RetiredSyntax /
// assertV4SystemMessageFields）：**解释性 content 槽位**里出现 `tool-result` 包装即拒载整份
// 日志（"must not contain a released tool-result wrapper"）。V4 里结果只作为 tool/result 事件的
// role:'tool' 一级字段存在，所以只查非 tool/result 事件——V3 形状的 tool/result 事件本身带的
// 就是那个包装（写侧由 shapeToolResults 分流）。
// 命中返回槽位名（写进告警），不命中返回 null。槽位清单与宿主逐条对齐：漏一个槽位，坏日志就
// 只能等宿主报一句无从下手的孤儿错误（issue #77 的「pinpointing this took three layers」）。
function retiredToolResultSlot(ev) {
  if (!ev || ev.type === 'tool/result') return null
  const data = ev.data && typeof ev.data === 'object' ? ev.data : null
  if (!data) return null
  const slots = []
  if (ev.type === 'user/message') slots.push(['content', data.content])
  else if (ev.type === 'assistant/message' || ev.type === 'developer/message' || ev.type === 'team/message/queued') {
    slots.push(['message.content', data.message && data.message.content])
  } else if (ev.type === 'system/message') slots.push(['message.content', data.message && data.message.content])
  else if (ev.type === 'compaction/summary') slots.push(['summary', data.summary], ['rawOutput', data.rawOutput])
  else if (ev.type === 'tool/ptc-dispatch') slots.push(['content', data.content])
  else if (ev.type === 'agent/inbox/spliced') {
    for (const m of Array.isArray(data.inserted) ? data.inserted : []) slots.push(['inserted[].content', m && m.content])
  } else if (ev.type === 'session/title-llm-request') {
    for (const m of Array.isArray(data.messages) ? data.messages : []) slots.push(['messages[].content', m && m.content])
  }
  for (const [name, content] of slots) {
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b && typeof b === 'object' && b.type === 'tool-result') return name
    }
  }
  return null
}

export function validateSessionEvents(events) {
  const problems = []
  const report = (kind, seq, message) => {
    if (problems.length < VALIDATION_PROBLEM_CAP) problems.push({ kind, seq, message })
  }
  if (!Array.isArray(events)) {
    return { ok: false, problems: [{ kind: 'not-array', seq: null, message: 'events 不是数组' }] }
  }
  const bySeq = new Map()
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') {
      report('malformed', null, '事件条目不是对象')
      continue
    }
    const seq = typeof ev.seq === 'number' && Number.isInteger(ev.seq) ? ev.seq : null
    if (seq === null) {
      report('missing-seq', null, '事件缺整数 seq：' + String(ev.type))
      continue
    }
    if (bySeq.has(seq)) report('duplicate-seq', seq, 'seq 重复：' + seq)
    bySeq.set(seq, ev)
  }
  const sorted = [...bySeq.keys()].sort((a, b) => a - b)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) report('seq-gap', sorted[i], 'seq 不连续：' + sorted[i - 1] + ' → ' + sorted[i])
  }
  for (const ev of bySeq.values()) {
    if (!SESSION_EVENT_TYPES_SET.has(ev.type)) report('unknown-type', ev.seq, '未知事件类型：' + String(ev.type))
    if (SURFACE_EVENT_TYPES.has(ev.type) && ev.surfaceOp === undefined) {
      report('missing-surface-op', ev.seq, 'surface 事件缺 surfaceOp：' + ev.type)
    }
    // 图片块只能以宿主附件引用进日志（见 lib/attachments.mjs 与 docs/architecture.md D14）：
    // 带 data 的 IR 图片块说明落地那一步被绕过，base64 会整段写进会话日志（体积与语义双错）。
    // 宿主只认 attachment 形状，这里点名，让回归在导入/校验时就被发现。
    if (hasInlineImageData(ev)) {
      report('inline-image-data', ev.seq, '图片块带内联 data（应为 attachment 引用）：落地步骤被绕过')
    }
    const retiredSlot = retiredToolResultSlot(ev)
    if (retiredSlot !== null) {
      report('retired-tool-result-wrapper', ev.seq, '解释性 content 里残留 tool-result 包装（' + retiredSlot
        + '）：宿主 v4 codec 见即拒载整份日志，结果只能作为 tool/result 事件的一级字段')
    }
    if (ev.type === 'tool/result' && Array.isArray(ev.sourceEventSeqs)) {
      for (const ref of ev.sourceEventSeqs) {
        const target = bySeq.get(ref)
        if (target && target.type !== 'tool/call') report('source-event-seqs-not-call', ev.seq, 'sourceEventSeqs 指向非 tool/call：' + ref)
      }
    }
  }
  // system head（宿主 v3→v4 迁移 fail-closed 的形状）：surface 的第一个事件必须是
  // system/message——它是「protected head」，此后宿主的 system/message 都以它为替换锚点。
  // 导入会话若从 user/message 起（旧版本插件的产物），宿主续聊写 system/message 时迁移器
  // 直接拒载整份日志（"system/message requires a protected first surface head"），
  // 且由它 seed 出来的续聊会话同样打不开。此处点名，让存量工件在导入/校验时就能被发现。
  {
    let hasSurface = false
    let head
    for (const s of sorted) {
      const ev = bySeq.get(s)
      if (ev.type === 'system/message') {
        if (ev.surfaceOp === 'append') {
          if (!hasSurface && head === undefined) head = s
        }
        if (hasSurface && head === undefined) {
          report('system-head-missing', s, 'system/message 之前已有 surface 事件，且没有 protected head：宿主 v3→v4 迁移会拒载整份日志')
        }
      }
      if (SURFACE_EVENT_TYPES.has(ev.type)) hasSurface = true
    }
  }
  // 原生压缩事务（compaction/start → summary → 替换用 user/message → end）：宿主
  // @deepseek-ai/dsh-compaction 的契约，导入自产的检查点也必须满足——括号配对、遮蔽范围是
  // 连续 surface 区间、替换件的 sourceEventSeqs 覆盖全部被遮蔽节点、checkpoint 标记与括号
  // 的 compactionId 一致。这里点名，让「形状坏了但宿主 assertProvenance 拒载」的日志在导入/
  // 校验时就能被发现，而不是等宿主报 surface replace 错误。
  {
    const open = new Map() // compactionId → { start, summary }
    const surfaceOrder = [] // 已发射的 surface 节点（按 seq 顺序，含 protected head）
    const known = new Set(sorted)
    for (const s of sorted) {
      const ev = bySeq.get(s)
      if (SURFACE_EVENT_TYPES.has(ev.type)) surfaceOrder.push(s)
      if (ev.type === 'compaction/start') {
        const id = ev.data && ev.data.compactionId
        if (typeof id !== 'string' || id.length === 0) {
          report('compaction-id-missing', s, 'compaction/start 缺非空 compactionId')
          continue
        }
        if (open.has(id)) report('compaction-id-duplicate', s, 'compactionId 重复：' + id)
        open.set(id, { start: s, summary: null })
        continue
      }
      if (ev.type === 'compaction/summary') {
        const id = ev.data && ev.data.compactionId
        const bracket = open.get(id)
        if (!bracket || bracket.summary) {
          report('compaction-summary-orphan', s, 'compaction/summary 没有对应的 compaction/start：' + String(id))
          continue
        }
        bracket.summary = s
        const seqs = Array.isArray(ev.data.shadowedSeqs) ? ev.data.shadowedSeqs : null
        const range = ev.data.shadowedRange
        if (seqs === null || seqs.length === 0) {
          report('compaction-shadow-empty', s, 'compaction/summary 的 shadowedSeqs 为空（宿主不变式要求非空）')
        } else {
          if (!range || seqs[0] !== range.start || seqs[seqs.length - 1] !== range.end) {
            report('compaction-shadow-range', s, 'shadowedRange 与 shadowedSeqs 首尾不一致')
          }
          for (const ref of seqs) {
            if (!known.has(ref)) report('compaction-shadow-unknown', s, 'shadowedSeqs 指向不存在的事件：' + ref)
          }
        }
        continue
      }
      if (ev.type === 'compaction/end') {
        const id = ev.data && ev.data.compactionId
        const bracket = open.get(id)
        if (!bracket || !bracket.summary) {
          report('compaction-end-orphan', s, 'compaction/end 之前没有 summary：' + String(id))
          continue
        }
        open.delete(id)
        continue
      }
      // 替换用检查点消息：surfaceOp 为 replace 对象时必须带全部被遮蔽节点的溯源。
      // source 与端点都按 V3/V4 双形状读（与 toolResultOf 同口径）：V3 是
      // {kind:'plugin',plugin:'compact'} + surfaceOp.{start,end}，V4 是生产者自有
      // kind 'compact-checkpoint'（宿主 RENAMED_PRODUCERS）+ surfaceOp.{startSeq,endSeq}
      //（宿主 ≥0.2.0 的 runtime 与两代 released codec 都只认后者）。只认一种会让
      // verify_session 对本插件刚写出的 V4 会话误报。
      if (ev.type === 'user/message' && ev.surfaceOp && typeof ev.surfaceOp === 'object') {
        const src = ev.data && ev.data.source
        const isCheckpoint = !!src && ((src.kind === 'plugin' && src.plugin === 'compact') || src.kind === 'compact-checkpoint')
        if (!isCheckpoint) {
          report('compaction-checkpoint-source', s, '替换用 user/message 的 source 不是 compact 检查点标记（V3 plugin:compact / V4 compact-checkpoint）')
          continue
        }
        const bracket = open.get(src.compactionId)
        if (!bracket || !bracket.summary) {
          report('compaction-checkpoint-orphan', s, '检查点消息没有配套的 compaction/start + summary')
          continue
        }
        const summaryEv = bySeq.get(bracket.summary)
        const seqs = Array.isArray(summaryEv.data.shadowedSeqs) ? summaryEv.data.shadowedSeqs : []
        const op = ev.surfaceOp
        const start = op.start === undefined ? op.startSeq : op.start
        const end = op.end === undefined ? op.endSeq : op.end
        if (typeof op.op !== 'string' || start === undefined || end === undefined) {
          report('compaction-checkpoint-op', s, 'surfaceOp 不是 {op,start,end}（V3）或 {op,startSeq,endSeq}（V4）')
        } else if (!surfaceOrder.includes(start) || !surfaceOrder.includes(end)) {
          report('compaction-checkpoint-op', s, 'surfaceOp 的替换端点不在此前的 surface 节点里')
        }
        const proven = new Set(Array.isArray(ev.sourceEventSeqs) ? ev.sourceEventSeqs : [])
        for (const ref of seqs) {
          if (!proven.has(ref)) report('compaction-provenance-missing', s, 'sourceEventSeqs 缺被遮蔽节点：' + ref)
        }
      }
    }
    for (const [id, bracket] of open) {
      report('compaction-unclosed', bracket.start, 'compaction/start 没有闭合（缺 summary/end）：' + id)
    }
  }
  // 首个 step/start 之前的 surface 事件（issue #66）：宿主 v2→v3 迁移 fail-closed 的形状
  const firstStepStart = sorted.find((s) => bySeq.get(s).type === 'step/start')
  if (firstStepStart !== undefined) {
    for (const s of sorted) {
      if (s > firstStepStart) break
      const ev = bySeq.get(s)
      if (SURFACE_EVENT_TYPES.has(ev.type)) {
        report('surface-before-first-step', s, 'surface 事件早于首个 step/start（' + ev.type + '）：旧格式日志迁移到 v3 时会被宿主拒载')
      }
    }
  }
  // 按 seq 排序后返回：上报上限（VALIDATION_PROBLEM_CAP）只保留前若干条，先报最早的结构性
  // 问题（如 system head 缺失）——否则日志尾部的噪声会把开头的问题挤出上报
  problems.sort((a, b) => (a.seq ?? -1) - (b.seq ?? -1))
  return { ok: problems.length === 0, problems }
}
