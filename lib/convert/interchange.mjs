// lib/convert/interchange.mjs — interchange v1：跨格式会话交换协议（纯函数，零 DSH 依赖）
//
// REQ-18 把 lib/convert/core.mjs 内部的 turns IR 显式化为可评审、可校验、可版本化的
// 中立交换格式：interchange v1。它是「源 ↔ 目标双向适配器」的中立面——
//   convert/（各源 → IR）与 export/（IR/事件 → 各目标）都围绕它工作；
// REQ-56 的便携 bundle（export_bundle / restore_bundle）与 REQ-21 的降级策略也在此
// 定义。协议正文见 docs/INTERCHANGE.md（本模块是它的机器可读实现）。
//
// 本模块只含纯函数与常量：schema 描述（JSON Schema draft 2020-12 子集）、
// validateInterchange 校验器、SOURCE_CAPABILITIES 能力矩阵、DEGRADATION_RULES 降级
// 规则表、summarizeDegradations 降级汇总。不 import 任何 DSH 包。

export const INTERCHANGE_VERSION = 1
export const INTERCHANGE_NAMESPACE = 'dsh-chat-import'

// ── interchange v1 文档结构 ────────────────────────────────────────────────
// 文档顶层：
//   { interchange: 'dsh-chat-import', version: 1, meta: {…}, title?, provider, model?,
//     turns: [{ prompt, steps: [{ content, toolCalls, toolResults }] }] }
// content 块类型：text / reasoning / tool-call / tool-result（与 DSH 事件同构）。
// meta：{ id, createdAt, cwd?, sourceId? }——cwd 机器相关（REQ-62 落点提示）；sourceId
// 为源会话 id（各源显式写入，不从 import- 前缀反解）。
export const INTERCHANGE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'dsh-chat-import interchange v1',
  type: 'object',
  additionalProperties: false,
  properties: {
    interchange: { type: 'string', const: INTERCHANGE_NAMESPACE },
    version: { type: 'integer', const: INTERCHANGE_VERSION },
    meta: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        createdAt: { type: 'number' },
        cwd: { type: 'string' },
        sourceId: { type: 'string' },
      },
    },
    title: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    turns: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                content: { type: 'array' },
                toolCalls: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string' },
                      name: { type: 'string' },
                      arguments: { type: 'string' },
                    },
                    required: ['id', 'name', 'arguments'],
                  },
                },
                toolResults: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      toolCallId: { type: 'string' },
                      content: { type: 'array' },
                      isError: { type: 'boolean' },
                    },
                    required: ['toolCallId', 'content'],
                  },
                },
              },
            },
          },
        },
        required: ['prompt'],
      },
    },
  },
  required: ['interchange', 'version', 'meta', 'turns'],
}

// 轻量结构校验（对齐 validateSessionEvents 的风格：逐条上报、封顶 20 条）。
// 校验内容：顶层字段、meta.id / createdAt、turns 结构（steps 数组、toolCalls 项、
// toolResults 项）。content 块数组元素不深检（各源内容块同构，synthesizeSession 兜底）。
export function validateInterchange(ir) {
  const problems = []
  const report = (kind, message) => { if (problems.length < 20) problems.push({ kind, message }) }
  if (!ir || typeof ir !== 'object') return { ok: false, problems: [{ kind: 'not-object', message: 'interchange 文档不是对象' }] }
  if (ir.interchange !== INTERCHANGE_NAMESPACE) report('namespace', 'interchange 字段缺省或非 ' + INTERCHANGE_NAMESPACE)
  if (ir.version !== INTERCHANGE_VERSION) report('version', 'version 应为 ' + INTERCHANGE_VERSION + '，实际 ' + String(ir.version))
  if (!ir.meta || typeof ir.meta !== 'object') {
    report('meta', 'meta 缺失或非对象')
  } else {
    if (typeof ir.meta.id !== 'string' || !ir.meta.id) report('meta-id', 'meta.id 缺失')
    if (typeof ir.meta.createdAt !== 'number') report('meta-created-at', 'meta.createdAt 缺失或非数字')
  }
  if (!Array.isArray(ir.turns)) {
    report('turns', 'turns 缺失或非数组')
  } else {
    for (let i = 0; i < ir.turns.length; i++) {
      const t = ir.turns[i]
      if (!t || typeof t !== 'object') { report('turn', 'turns[' + i + '] 不是对象'); continue }
      if (typeof t.prompt !== 'string') report('turn-prompt', 'turns[' + i + '].prompt 缺失或非字符串')
      if (t.steps !== undefined && !Array.isArray(t.steps)) report('turn-steps', 'turns[' + i + '].steps 非数组')
      if (Array.isArray(t.steps)) {
        for (let j = 0; j < t.steps.length; j++) {
          const s = t.steps[j]
          if (!s || typeof s !== 'object') { report('step', 'turns[' + i + '].steps[' + j + '] 不是对象'); continue }
          for (const tc of Array.isArray(s.toolCalls) ? s.toolCalls : []) {
            if (!tc || typeof tc.id !== 'string' || typeof tc.name !== 'string') {
              report('tool-call', 'turns[' + i + '].steps[' + j + '] 的 toolCalls 项缺 id/name')
            }
          }
          for (const tr of Array.isArray(s.toolResults) ? s.toolResults : []) {
            if (!tr || typeof tr.toolCallId !== 'string' || !Array.isArray(tr.content)) {
              report('tool-result', 'turns[' + i + '].steps[' + j + '] 的 toolResults 项缺 toolCallId/content')
            }
          }
        }
      }
    }
  }
  return { ok: problems.length === 0, problems }
}

// 把转换输出（convertXxx 的结果，含 meta/turns/title/provider/model）序列化为
// interchange v1 文档。turns 为裁剪后的 seedTurns（trimTurns 输出与 IR 同构）。
// sourceId 显式透传（不反解 import- 前缀）；cwd 原样携带（机器相关，REQ-62 落点提示）。
export function serializeInterchange(converted) {
  const meta = (converted && converted.meta) || {}
  return {
    interchange: INTERCHANGE_NAMESPACE,
    version: INTERCHANGE_VERSION,
    meta: {
      id: meta.id,
      createdAt: meta.createdAt,
      ...(typeof meta.cwd === 'string' && meta.cwd ? { cwd: meta.cwd } : {}),
      ...(typeof meta.sourceId === 'string' && meta.sourceId ? { sourceId: meta.sourceId } : {}),
    },
    ...(converted.title ? { title: converted.title } : {}),
    provider: converted.provider || 'unknown',
    ...(converted.model ? { model: converted.model } : {}),
    turns: Array.isArray(converted.turns) ? converted.turns : [],
  }
}

// ── 各源能力矩阵（REQ-18 语义文档的机器可读部分）─────────────────────────────
// 描述「源格式能记录什么」；缺能力 = 该源固有的有损项（REQ-21 降级规则据此判定，
// 不把源格式缺失当插件缺陷）。键：
//   toolResults   工具结果是否结构化记录（cursor 无 → 导入时兜底补空结果）
//   reasoning     推理内容是否记录（codex 加密 → 不可见即降级）
//   cwd           工作目录是否记录（chatgpt 是聊天无 cwd；grokbuild 无）
//   branches      会话内分支是否保留（chatgpt mapping DAG / pi 树）
//   attachments   附件（图片等非文本块）是否记录
//   compacted     压缩摘要是否感知（opencode/zcode/pi/kimi 有 compaction 还原）
export const SOURCE_CAPABILITIES = {
  claude: { toolResults: true, reasoning: true, cwd: true, branches: false, attachments: true, compacted: false },
  codex: { toolResults: true, reasoning: false, cwd: true, branches: false, attachments: true, compacted: false },
  chatgpt: { toolResults: true, reasoning: false, cwd: false, branches: true, attachments: true, compacted: false },
  cursor: { toolResults: false, reasoning: false, cwd: false, branches: false, attachments: false, compacted: false },
  gemini: { toolResults: true, reasoning: true, cwd: true, branches: false, attachments: false, compacted: false },
  antigravity: { toolResults: true, reasoning: true, cwd: true, branches: false, attachments: false, compacted: false },
  reasonix: { toolResults: true, reasoning: true, cwd: true, branches: false, attachments: false, compacted: false },
  opencode: { toolResults: true, reasoning: true, cwd: true, branches: false, attachments: true, compacted: true },
  zcode: { toolResults: true, reasoning: true, cwd: true, branches: false, attachments: false, compacted: true },
  grokbuild: { toolResults: true, reasoning: true, cwd: false, branches: false, attachments: false, compacted: false },
  openclaw: { toolResults: true, reasoning: false, cwd: true, branches: false, attachments: false, compacted: false },
  hermes: { toolResults: true, reasoning: true, cwd: true, branches: false, attachments: false, compacted: false },
  pi: { toolResults: true, reasoning: true, cwd: true, branches: true, attachments: false, compacted: true },
  kimi: { toolResults: true, reasoning: true, cwd: true, branches: false, attachments: false, compacted: true },
  qoder: { toolResults: true, reasoning: true, cwd: true, branches: false, attachments: false, compacted: false },
  dsh: { toolResults: true, reasoning: true, cwd: true, branches: false, attachments: true, compacted: false },
}

// ── 互转保真度降级策略（REQ-21）────────────────────────────────────────────
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

// 导出序列化器输出 → 降级计数（REQ-21：export_* 结果附 degradations 字段）。
// 序列化器统一返回 droppedToolResults / skippedInjections / skippedBlocks 计数；
// 本函数映射到规则 kind 并汇总（空清单返回 undefined，不占结果键）。
export function exportDegradations(out) {
  const counts = {}
  if (out.droppedToolResults) counts.orphanToolResult = out.droppedToolResults
  if (out.skippedInjections) counts.injectionSkipped = out.skippedInjections
  if (out.skippedBlocks) counts.attachmentSkipped = out.skippedBlocks
  const list = summarizeDegradations(counts)
  return list.length > 0 ? list : undefined
}
