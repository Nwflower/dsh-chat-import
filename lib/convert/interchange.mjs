// lib/convert/interchange.mjs — 导出降级规则与降级清单（纯函数，零 DSH 依赖）
//
// 只保留导出链路实际使用的降级策略表与汇总函数：
//   DEGRADATION_RULES     降级规则定义
//   summarizeDegradations 导出/互转结果里的计数 → 结构化降级清单
//   exportDegradations    序列化器输出 → 结果字段 degradations
// 不 import 任何 DSH 包。

// ── 互转保真度降级策略────────────────────────────────────────────
// 目标格式缺能力时插件哲学「失败要大声」：降级必须显式报告，不能静默。策略三态：
//   lossless        无损（目标格式可表达，无降级）
//   text-fallback   降级为文本块（如 ChatGPT 工具消息按文本挂最近一步）
//   skip-placeholder 跳过 + 占位（如 Cursor 无 tool_result → 导入器补发空结果）
// 每条规则标注触发条件；summarizeDegradations 把导出/互转结果里的计数映射为
// 结构化降级清单（导出结果附加 degradations 字段，render 展示人类可读摘要）。
export const DEGRADATION_RULES = [
  {
    id: 'tool-result-missing',
    capability: 'toolResults',
    strategy: 'skip-placeholder',
    when: '目标格式不记录工具结果（Cursor 等）→ 导入器兜底补发空 tool/result，保持配对不变量',
    kind: 'toolResultFallback',
  },
  {
    id: 'tool-result-text-fallback',
    capability: 'toolResults',
    strategy: 'text-fallback',
    when: '源格式工具消息无结构化参数（ChatGPT 网页导出）→ 按文本挂最近一步',
    kind: 'toolMessageTextFallback',
  },
  {
    id: 'reasoning-encrypted',
    capability: 'reasoning',
    strategy: 'skip-placeholder',
    when: '源格式推理内容不可见（Codex 加密）→ 无内容可导入',
    kind: 'reasoningUnavailable',
  },
  {
    id: 'cwd-missing',
    capability: 'cwd',
    strategy: 'text-fallback',
    when: '源格式无工作目录（ChatGPT / Grok Build）→ 会话不归组工作区（回退源目录归组）',
    kind: 'cwdMissing',
  },
  {
    id: 'branch-collapsed',
    capability: 'branches',
    strategy: 'text-fallback',
    when: '目标会话无分支概念（DSH 单线程）→ 分支会话只导主线程',
    kind: 'branchCollapsed',
  },
  {
    id: 'attachment-skipped',
    capability: 'attachments',
    strategy: 'skip-placeholder',
    when: '非文本内容块（图片等）目标格式无法表达 → 跳过并计数',
    kind: 'attachmentSkipped',
  },
  {
    id: 'compacted-unavailable',
    capability: 'compacted',
    strategy: 'text-fallback',
    when: '源格式无压缩摘要（Claude 等）→ 超长会话由预算三层保护被动截断',
    kind: 'compactionUnavailable',
  },
  {
    id: 'injection-skipped',
    capability: null,
    strategy: 'skip-placeholder',
    when: '非人类注入消息（system-reminder 等）不进入会话 → 跳过并计数',
    kind: 'injectionSkipped',
  },
  {
    id: 'orphan-tool-result',
    capability: 'toolResults',
    strategy: 'skip-placeholder',
    when: '源日志无对应 tool/call 的工具结果（中途开始的 transcript）→ 丢弃并计数',
    kind: 'orphanToolResult',
  },
  {
    id: 'usage-unknown',
    capability: null,
    strategy: 'text-fallback',
    when: '目标格式要求用量计数（opencode 的 cost / tokens）而事件没有 provider 回报 usage → 写 0 并显式报告（事件带 usage 时如实回填）',
    kind: 'usageUnknown',
  },
]

// 把导出/转换结果里的降级计数映射为结构化降级清单（只列 count > 0 的项；
// 导出侧无对应计数的能力缺口不重复列出）。counts 键见各规则 kind。
// 返回 [{ id, kind, strategy, count }]。
export function summarizeDegradations(counts = {}) {
  const out = []
  for (const rule of DEGRADATION_RULES) {
    const count = counts[rule.kind]
    if (typeof count === 'number' && count > 0) {
      out.push({ id: rule.id, kind: rule.kind, strategy: rule.strategy, count })
    }
  }
  return out
}

// 导出序列化器输出 → 降级计数（export_* 结果附 degradations 字段）。
// 序列化器统一返回 droppedToolResults / skippedInjections / skippedBlocks 计数；
// 本函数映射到规则 kind 并汇总（空清单返回 undefined，不占结果键）。
export function exportDegradations(out) {
  const counts = {}
  if (out.droppedToolResults) counts.orphanToolResult = out.droppedToolResults
  if (out.skippedInjections) counts.injectionSkipped = out.skippedInjections
  // 附件跳过 = 未知块类型 + 拿不到字节的图片（导出时无法还原成目标格式的图片载荷）
  const attachments = (out.skippedBlocks || 0) + (out.unavailableImages || 0)
  if (attachments) counts.attachmentSkipped = attachments
  if (out.usageUnknown) counts.usageUnknown = out.usageUnknown
  const list = summarizeDegradations(counts)
  return list.length > 0 ? list : undefined
}
