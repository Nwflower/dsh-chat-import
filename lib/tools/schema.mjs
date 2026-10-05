// lib/tools/schema.mjs — 工具输出 schema 的共享片段 + import_chat 输出 schema
//
// 片段在多个工具 / 多个分支间按引用共享，一律深冻结：defineTool 编译时只读不改，冻结
// 保证任何一处就地改动都当场抛错，而不是悄悄串到别的工具上。
//
// import_chat 的输出 schema（IMPORT_OUTPUT_SCHEMA）= oneOf 四态：单文件预览 / 批量预览 /
// 单文件导入 / 批量导入。宿主 ToolSchema 只投影 name/description/parameters——output 不进
// 模型请求，但它是结构契约：宿主按它校验工具返回值，测试用 validateJsonSchemaValue 守护。
// 单文件结果与批量条目共用同一份「导入报告」字段表（IMPORT_REPORT_PROPS），新增结果字段
// 只改这一处，两态不会再各漂各的。

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

const required = (schema) => ({ ...schema, required: true })
const str = { type: 'string' }
const int = { type: 'integer' }
const bool = { type: 'boolean' }

/** `T | null`：发现 / 识别结果里「来源没有这个字段」用 null 显式表示。 */
export const nullable = (type) => deepFreeze({ oneOf: [{ type }, { type: 'null' }] })

/** 重导另铸副本的缘由（docs/architecture.md D13）。 */
export const REIMPORT_REASONS = deepFreeze(['continued-in-dsh', 'baseline-missing', 'forced', 'session-id-changed'])

/** 重导另铸副本：previous 是原会话、current 是新副本、reason 点名缘由；两个会话都保留。 */
export const REIMPORTED_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    previous: required(str),
    current: required(str),
    reason: { type: 'string', required: true, enum: REIMPORT_REASONS },
  },
})

/** 会话结构校验的单条问题（verify_session 与导入后校验共用）：seq 为 null 表示不定位到事件。 */
export const PROBLEM_ITEM_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: required(str),
    seq: { ...nullable('integer'), required: true },
    message: required(str),
  },
})

/** 导入结果的工作区归组字段：workspace = 目标工作区路径、workspaceMode = 归组方式、
 * workspaceCreated = 本次新建了工作区；ungrouped / ungroupedReason = 未归组会话数 + 首个原因。 */
export const WORKSPACE_PROPS = deepFreeze({
  workspace: str,
  workspaceMode: str,
  workspaceCreated: bool,
  ungrouped: int,
  ungroupedReason: str,
})

// ── import_chat 结果片段 ─────────────────────────────────────────────────

// cwdRemap 命中报告（见 lib/import-core.mjs applyCwdRemap）：reason 只在拒绝改写时出现
const CWD_REMAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: required(str),
    to: required(str),
    original: required(str),
    mapped: required(str),
    absolute: required(bool),
    reason: str,
  },
}

// local-jsonl 的三级探测结果：命中的解析器、命中层级、是否便携包、逐格式试跑的失败原因
const DETECTION_PROPS = {
  detectedFormat: str,
  detectedBy: { type: 'string', enum: ['override', 'marker', 'path-hint', 'content'] },
  bundle: bool,
  failures: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: { format: required(str), reason: required(str) },
    },
  },
}

// 预览条目（零副作用：无 sessionId / status 等写入态字段）；counted = 规模计数是否必有
const previewEntryProps = (counted) => {
  const count = counted ? required(int) : int
  return {
    title: str,
    cwd: str,
    cwdRemap: CWD_REMAP_SCHEMA,
    createdAt: int,
    turns: count,
    messages: count,
    toolCalls: count,
    skipped: count,
    skipReason: str,
    ...DETECTION_PROPS,
  }
}

// 畸形行明细 / secrets 位置 / permission 计数：只含行号与 kind，绝不含内容
const LINE_ISSUE_PROPS = {
  skippedLines: {
    type: 'array',
    items: { type: 'object', additionalProperties: false, properties: { line: required(int), error: required(str) } },
  },
  secrets: {
    type: 'array',
    items: { type: 'object', additionalProperties: false, properties: { line: required(int), kind: required(str) } },
  },
  permissionCount: int,
}

// 上下文预算裁剪报告（见 lib/budget.mjs）
const TRIMMED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    budget: required(int),
    source: { type: 'string', enum: ['param', 'env', 'dynamic', 'default'], required: true },
    originalTokens: required(int),
    estimatedTokens: required(int),
    croppedBlocks: required(int),
    droppedTurns: required(int),
    droppedMessages: required(int),
    droppedToolCalls: required(int),
    droppedToolResults: required(int),
    droppedOversized: required(int),
    summaryInserted: required(bool),
  },
}

// 宿主残留幽灵会话（retract 后工件已删）时重导自动另铸后缀新 id：previous = 幽灵原 id、
// current = 新落盘 id
const STALE_GHOST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { previous: required(str), current: required(str) },
}

// registry 记录指向的会话已不在宿主里（日志被删 / DSH_HOME 迁移）：按无记录重建，
// previous = 记录里的旧会话 id、reason = 'session-log-missing'
const STALE_REGISTRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { previous: required(str), reason: required(str) },
}

/** 单文件 / 批量条目共用的导入报告字段（>0 / 非空才占键的计数与标注）。 */
const IMPORT_REPORT_PROPS = {
  // Reasonix WAL 合并 / 原生压缩检查点导入报告
  walMerged: bool,
  walRecords: int,
  compacted: bool,
  compactions: int,
  compactionSummaryMissing: bool,
  // 增量续写与跳过原因（docs/architecture.md D13）：storedShrunk = DSH 侧日志比上次落盘的
  // 基线短（被外部截短）→ 不写、跳过
  appendedTurns: int,
  appendedEvents: int,
  appendedSkipped: str,
  sourceShrunk: bool,
  storedShrunk: bool,
  changedInPlace: bool,
  argsChanged: bool,
  budgetChanged: bool,
  backfilled: bool,
  droppedBoundaryResults: int,
  // 工具结果归位丢弃计数（孤儿 / 重复，见 synthesizeSession 配对预扫描）
  orphanToolResults: int,
  duplicateToolResults: int,
  // 转换层保真 / 降级计数（见 import-core.attachConversionDetails）；图片：images = 落成
  // 宿主附件的张数、imagesDegraded = 降级为 [image] 占位的张数；toolUseResultsMerged =
  // Claude 富结果 sidecar 合并数（includeToolUseResult:true 时 >0）
  metaMessages: int,
  images: int,
  imagesDegraded: int,
  toolUseResultsMerged: int,
  backendToolCalls: int,
  droppedToolResultBlocks: int,
  droppedMalformedOutputs: int,
  droppedMalformedArgs: int,
  // 展平信封还原（Codex Desktop 外部导入的 rollout）：calls = 还原的 tool-call 数、
  // results = 配上调用的结果数、orphanResults = 找不到调用而保留为正文的结果数、
  // malformed = 未闭合信封 / 认不出的载荷数（见 lib/convert/codex.mjs）
  externalAgent: {
    type: 'object',
    additionalProperties: false,
    properties: {
      calls: required(int),
      results: required(int),
      orphanResults: required(int),
      malformed: required(int),
    },
  },
  ...WORKSPACE_PROPS,
  trimmed: TRIMMED_SCHEMA,
  reimported: REIMPORTED_SCHEMA,
  staleGhost: STALE_GHOST_SCHEMA,
  staleRegistry: STALE_REGISTRY_SCHEMA,
  validation: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: required(bool),
      problems: { type: 'array', required: true, items: PROBLEM_ITEM_SCHEMA },
    },
  },
}

/** 已落盘 / 已判定的导入状态（单文件）：replaced = 同 id 删工件后全量重导（面板「刷新已导入」）；
 * 批量条目另有 'failed'（该条抛错）。 */
const IMPORT_STATUSES = ['imported', 'replaced', 'already-imported', 'appended', 'skipped', 'ignored']

export const IMPORT_OUTPUT_SCHEMA = deepFreeze({
  oneOf: [
    // 单文件 dry-run 预览：无写入态字段（sessionId/status/alreadyImported 等）
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['single'], required: true },
        preview: { type: 'boolean', const: true, required: true },
        ...previewEntryProps(true),
      },
    },
    // 目录（批量）dry-run 预览：同 total/results 骨架，无写入态计数
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['batch'], required: true },
        preview: { type: 'boolean', const: true, required: true },
        total: required(int),
        results: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: required(str),
              ...previewEntryProps(false),
              status: { type: 'string', enum: ['failed'] },
              error: str,
            },
          },
        },
      },
    },
    // 单文件模式
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['single'], required: true },
        sessionId: required(str),
        turns: required(int),
        messages: required(int),
        toolCalls: required(int),
        skipped: int,
        ...LINE_ISSUE_PROPS,
        skipReason: str,
        alreadyImported: required(bool),
        status: { type: 'string', required: true, enum: IMPORT_STATUSES },
        // 落盘的 cwd 经 cwdRemap 改写时的命中报告（与预览同口径）
        cwdRemap: CWD_REMAP_SCHEMA,
        ...IMPORT_REPORT_PROPS,
      },
    },
    // 目录（批量）模式
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['batch'], required: true },
        total: required(int),
        imported: required(int),
        alreadyImported: required(int),
        appended: required(int),
        // 其中「重导另铸副本」的条数（已含在 imported 里，单独点名便于解释新增会话）
        reimported: int,
        skipped: required(int),
        failed: required(int),
        // 图片 / 归组汇总（>0 才占键，与 importDirectory 的顶层产物同口径）；单库多会话
        //（SQLite/JSON 库）源把本轮落点摊平到顶层，含义同单文件结果
        images: int,
        imagesDegraded: int,
        ...WORKSPACE_PROPS,
        missingFromSource: { type: 'array', items: str },
        results: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: required(str),
              status: { type: 'string', required: true, enum: [...IMPORT_STATUSES, 'failed'] },
              sessionId: str,
              turns: int,
              messages: int,
              toolCalls: int,
              skipped: int,
              ...LINE_ISSUE_PROPS,
              alreadyImported: bool,
              reason: str,
              error: str,
              ...IMPORT_REPORT_PROPS,
            },
          },
        },
      },
    },
  ],
})
