// index.d.ts — dsh-chat-import 类型面（手写维护，随工具 schema 变更同步）
//
// 本包是零构建纯 ESM 插件：index.mjs 只导出 Cordis 插件入口（apply/inject/name/Config）
// 与少量 host 面辅助函数；工具由 apply 动态注册，不在此模块导出。因此本文件把「工具调用面」
// 声明为一个类型化接口（ToolSurface），供 TS 调用方参考参数/返回结构，而不是伪装成真实的
// 模块导出。
//
// 结构对齐 lib/tools/*.mjs 注册的工具 schema 与 lib/tools/schema.mjs 的 import_chat 输出
// oneOf（单文件/批量 × 预览/实导入）。格式枚举（ChatFormat / ScanFormat / ExportFormat /
// LocalJsonlFormat）与 ToolSurface 的工具名由 test/tool-surface.test.mjs 对照运行时清单校验，
// 漂移即测试失败。

// ---------- Cordis 插件入口（index.mjs 的真实导出） ----------

export declare const name: string
export declare const inject: string[]
/**
 * 0.1.7 设置模型：条目 Config（字段均 volatile，命名空间 = profile 条目 id）。
 * 宿主自带的 schemastery 没有 volatile 时为 undefined，走 legacy 命名空间注册。
 */
export declare const Config: unknown

/** 本插件消费的 host 公开服务最小面（sessionPersistence / fs / tools / workspaceRegistry）。 */
export interface HostContext {
  tools: { register(tool: unknown): unknown }
  get?(name: string): unknown
  inject?(deps: string[], callback?: (ctx: Record<string, unknown>) => void): unknown
}

/** config：宿主解析后的条目配置（0.1.7 下 volatile 字段是带 get() 的实时引用）。 */
export declare function apply(ctx: HostContext, config?: unknown): void
/** opencode 历史库（SQLite，同步只读）→ 中间会话 JSON 数组；读不到库时抛错。 */
export declare function readOpencodeDb(dbPath: string, options?: { fullHistory?: boolean; filter?: (session: unknown) => boolean }): unknown[]
/** zcode 历史库（SQLite，同步只读）→ 中间会话 JSON 数组；读不到库时抛错。 */
export declare function readZcodeDb(dbPath: string): unknown[]
/** DSH 会话 → Claude Code JSONL（export_chat format=claude 的执行体）；uuid 工厂可注入（测试确定性）。 */
export declare function exportClaudeSession(
  ctx: HostContext,
  args: Omit<ExportChatParams, 'format' | 'path'> & { version?: string; gitBranch?: string },
  options?: { uuid?: () => string },
): Promise<ExportChatResult>

// ---------- 工具调用面（ToolSurface：apply 注册的全部工具） ----------
// import_chat 是全部聊天导入格式的统一分发入口：format 必填（ChatFormat），专属参数
// （compacted / branch / sessionIds / fullHistory / includeToolUseResult / lineage /
// lineageMode / parseFormat）只对相应 format 生效。export_chat 是 DSH → 外部格式出边的
// 统一入口：format 必填（ExportFormat），cwd 仅 claude 有效、path 仅非 claude 有效。

export interface ToolSurface {
  import_chat(options: ImportChatOptions): Promise<ImportResult>
  import_agents(options?: AgentsImportOptions): Promise<AgentsImportResult>
  import_mcp(options?: ImportMcpParams): Promise<ImportMcpResult>
  import_settings(options?: ImportSettingsParams): Promise<ImportSettingsResult>
  doctor(): Promise<DoctorResult>
  export_chat(options: ExportChatParams): Promise<ExportChatResult>
  export_bundle(options: ExportBundleParams): Promise<ExportBundleResult>
  restore_bundle(options: RestoreBundleParams): Promise<RestoreBundleResult>
  verify_session(options: { sessionId: string }): Promise<VerifySessionResult>
  list_imported_sessions(): Promise<ListImportedResult>
  retract_import(options: RetractParams): Promise<RetractResult>
  scan_discover(options?: ScanDiscoverParams): Promise<ScanDiscoverResult>
}

// ---------- 导入工具公共参数与返回 ----------

export type WorkspaceMode = 'auto' | 'dedicated' | 'per-project'

export interface ImportOptions {
  /** 源 transcript / 数据库 / 会话目录路径；目录模式递归扫描，每文件/每会话独立导入。 */
  path: string
  /** true 时即使已导入也以新 id（import-<src>-<n>）另存完整副本，旧会话原样保留。 */
  force?: boolean
  /** 上下文预算（token 数），超长会话按三层保护裁剪；优先级 参数 > env > 动态模型窗口 > 静态 550k。 */
  budget?: number
  /** 源里的图片落成宿主附件（默认 true）；false 只留 [image] 文本占位（env DSH_IMPORT_STORE_IMAGES=0 同效）。 */
  storeImages?: boolean
  /** true 时 dry-run 预览——不落盘、不写 registry、不归组，仅返回将导入会话清单。 */
  preview?: boolean
  /** preview 的兼容别名（语义相同）。 */
  dryRun?: boolean
  /** 目标 DSH 会话 id（仅单文件导入时生效，默认 import-<源sessionId>；目录模式 / SQLite 库源忽略）。 */
  sessionId?: string
  /** 目录模式是否递归子目录（默认 true；SQLite 库源忽略）。 */
  recursive?: boolean
  /** 期望的源文件 SHA-256（小写 hex）；不符时大声失败、不写任何东西。 */
  expectedHash?: string
  /** true 时把导入的时间戳平移到当前（保留相对间隔）；默认保留源时间。 */
  restamp?: boolean
  /** 归组方式：auto（默认）/ per-project / dedicated（全部导入进同一个工作区）。 */
  workspaceMode?: WorkspaceMode
  /** workspaceMode=dedicated 时的工作区目录。 */
  workspaceDir?: string
  /** 跨机器迁移时改写源 cwd 前缀（最长前缀胜出；只作用于新导入，已导入的源请用 force 另建副本）。 */
  cwdRemap?: Array<{ from: string; to: string }>
}

export type LocalJsonlFormat =
  | 'dsh' | 'claude' | 'codex' | 'cursor' | 'reasonix' | 'pi' | 'openclaw' | 'hermes' | 'qoder' | 'vibe'
  /** interchange v1 会话文档（内容标记 "interchange":"dsh-chat-import"；长尾来源与 skill 路线的落点）。 */
  | 'generic'

/** import_chat 的源格式枚举（值 = 来源短名；除 local-jsonl 外与 discovery 的 ScanFormat 一致）。 */
export type ChatFormat =
  | 'claude' | 'codex' | 'chatgpt' | 'cursor' | 'gemini' | 'antigravity' | 'reasonix' | 'opencode'
  | 'mimocode' | 'kilocode' | 'teleagent' | 'zcode' | 'grokbuild' | 'openclaw' | 'hermes' | 'pi'
  | 'kimi' | 'qoder' | 'workbuddy' | 'qwen' | 'trae' | 'vibe' | 'continue' | 'cline' | 'goose'
  | 'zed' | 'crush' | 'dsh' | 'dsh4' | 'local-jsonl'

/** import_chat 参数：公共导入参数（ImportOptions）+ 源格式 + 源专属参数。 */
export interface ImportChatOptions extends ImportOptions {
  /** 源格式（必填），决定 path 形态与解析器。 */
  format: ChatFormat
  /** 仅 claude：历史兼容别名。压缩导入默认即发射原生压缩检查点，无需该参数。 */
  compacted?: boolean
  /** 仅 chatgpt：'main'（默认）只重建主线程；'all' 枚举全部分支会话。 */
  branch?: 'main' | 'all'
  /** 仅一库多会话来源（opencode / mimocode / kilocode / teleagent / zcode / goose / zed / crush）：只导入指定源会话 id（缺省导入全部）。 */
  sessionIds?: string[]
  /** 仅压缩感知来源（claude / codex / pi / kimi / zed / crush / continue / zcode / cline / opencode 及其 fork）：true 时导入全量历史并**不发**压缩检查点（模型看到全量）；默认 false 尊重压缩（日志保全量、模型只见摘要 + 压缩点之后）。该开关进参数指纹，换值须重导。 */
  fullHistory?: boolean
  /** 仅 claude：true 时把结构化 toolUseResult sidecar（编辑 diff、问答、退出码等）以文本并入工具结果。进参数指纹，换值须 force。 */
  includeToolUseResult?: boolean
  /** 仅 hermes：'tail' 只导 lineage 链尾（叶子会话）。 */
  lineage?: 'tail'
  /** 仅 reasonix 目录：canonical（默认）只折叠有严格语义前缀及明确 parent_id 谱系证明的恢复祖先；physical 逐文件导入。 */
  lineageMode?: 'canonical' | 'physical'
  /** 仅 local-jsonl：强制按指定格式解析；缺省自动识别（内容标记 > 路径特征 > 逐格式试跑）。 */
  parseFormat?: LocalJsonlFormat
}

/**
 * 导入状态：replaced = 同 id 删工件后全量重导（面板「刷新已导入」）；ignored = 被忽略表
 * （撤回墓碑 / 归档 / 删除的工作区）挡下；failed 只出现在批量条目（该条抛错）。
 */
export type ImportStatus = 'imported' | 'replaced' | 'already-imported' | 'appended' | 'skipped' | 'ignored' | 'failed'

export type ReimportReason = 'continued-in-dsh' | 'baseline-missing' | 'forced' | 'session-id-changed'

export interface TrimReport {
  budget: number
  source: 'param' | 'env' | 'dynamic' | 'default'
  originalTokens: number
  estimatedTokens: number
  croppedBlocks: number
  droppedTurns: number
  droppedMessages: number
  droppedToolCalls: number
  droppedToolResults: number
  droppedOversized: number
  summaryInserted: boolean
}

export interface LineIssue {
  line: number
  error: string
}

/** 落盘会话结构校验报告（导入结果附加字段，仅校验失败时出现）。 */
export interface ValidationReport {
  ok: boolean
  problems: Array<{
    kind: string
    seq: number | null
    message: string
  }>
}

export interface SecretLocation {
  line: number
  kind: string
}

/** cwdRemap 命中报告：reason 只在拒绝改写（如 parent-traversal）时出现。 */
export interface CwdRemapReport {
  from: string
  to: string
  original: string
  mapped: string
  absolute: boolean
  reason?: string
}

/** 单文件结果与批量条目共用的导入报告字段（>0 / 非空才占键）。 */
export interface ImportReport {
  /** Reasonix V2 WAL 合并报告。 */
  walMerged?: boolean
  walRecords?: number
  /** 日志里带了原生压缩检查点（来源工具的上下文压缩被导入为 `compaction/*` 事务）。 */
  compacted?: boolean
  /** 原生压缩检查点数量（>0 才占键）。 */
  compactions?: number
  /** 源压缩只有边界、没有摘要正文（Kimi 旧格式 wire）→ 该源退化为切窗口，前段历史不进日志。 */
  compactionSummaryMissing?: boolean
  appendedTurns?: number
  appendedEvents?: number
  /** 源已增长但读不到 DSH 侧日志长度 → 不续写也不复制，跳过。 */
  appendedSkipped?: string
  sourceShrunk?: boolean
  /** DSH 侧会话日志比上次落盘的基线短（被外部截短）→ 不写、跳过。 */
  storedShrunk?: boolean
  changedInPlace?: boolean
  argsChanged?: boolean
  budgetChanged?: boolean
  /** 旧版本导入的会话：补登 registry 记录（不重写会话）。 */
  backfilled?: boolean
  droppedBoundaryResults?: number
  /** 工具结果归位丢弃计数（孤儿 / 重复）。 */
  orphanToolResults?: number
  duplicateToolResults?: number
  /** isMeta 记录数（Claude：宿主写进转录的非提问内容，不开轮、不参与标题）。 */
  metaMessages?: number
  /** 落成宿主附件的图片数（经 ctx.attachments 存成不可变对象，日志里只有引用）。 */
  images?: number
  /** 未能落地、以 [image] 文本占位导入的图片数（服务缺席 / 类型不收 / 超限 / 源无字节）。 */
  imagesDegraded?: number
  /** Claude 富结果 sidecar 合并数（includeToolUseResult: true 时 > 0）。 */
  toolUseResultsMerged?: number
  /** 只计数不映射的后端工具调用数（Grok Build 的 backend_tool_call）。 */
  backendToolCalls?: number
  /** 无法映射成内容块的工具结果块数（未知块类型，已计数上报）。 */
  droppedToolResultBlocks?: number
  /** 工具输出块数组里的未知块类型数（Codex）。 */
  droppedMalformedOutputs?: number
  /** 未能转成标准 JSON、原样保留的工具参数条数（Codex custom_tool_call）。 */
  droppedMalformedArgs?: number
  /**
   * Codex Desktop「导入外部 agent 会话」展平信封的还原计数（任一 > 0 才占键）：
   * calls = 还原的 tool-call 数、results = 配上调用的结果数、
   * orphanResults = 找不到调用而保留为正文的结果数、malformed = 未闭合信封 / 认不出的载荷数。
   */
  externalAgent?: { calls: number; results: number; orphanResults: number; malformed: number }
  /** 本次导入会话挂接到的 DSH 工作区路径（归组成功时才有；见 docs/architecture.md D16）。 */
  workspace?: string
  /** 归组方式：已有工作区沿用 workspace / 就地建项目工作区 project / 专用导入工作区 dedicated。 */
  workspaceMode?: string
  /** 本次是否为归组新建了工作区（侧栏会多出一个分组）。 */
  workspaceCreated?: boolean
  /** 未归组的会话数（>0 才占键）：会话已导入，但停在侧栏「未分组」下。 */
  ungrouped?: number
  /** 未归组的首个原因（no-registry / cwd-is-home / create-failed: … / attach-failed: …）。 */
  ungroupedReason?: string
  trimmed?: TrimReport | null
  /** 重导另铸副本：`previous` 原会话、`current` 新副本、`reason` 点名缘由。两个会话都保留。 */
  reimported?: { previous: string; current: string; reason: ReimportReason }
  /** 宿主内存残留幽灵会话（retract 后工件已删）时重导自动另铸后缀新 id。 */
  staleGhost?: { previous: string; current: string }
  /** registry 记录指向的会话已不在宿主里（日志被删 / DSH_HOME 迁移）→ 按无记录重建。 */
  staleRegistry?: { previous: string; reason: string }
  validation?: ValidationReport
}

export interface SingleImportResult extends ImportReport {
  mode: 'single'
  sessionId: string
  status: Exclude<ImportStatus, 'failed'>
  turns: number
  messages: number
  toolCalls: number
  skipped?: number
  skippedLines?: LineIssue[]
  secrets?: SecretLocation[]
  permissionCount?: number
  skipReason?: string
  alreadyImported: boolean
  /** 落盘的 cwd 经 cwdRemap 改写时的命中报告（与预览同口径）。 */
  cwdRemap?: CwdRemapReport
}

export interface BatchItemResult extends ImportReport {
  path: string
  status: ImportStatus
  sessionId?: string
  turns?: number
  messages?: number
  toolCalls?: number
  skipped?: number
  skippedLines?: LineIssue[]
  secrets?: SecretLocation[]
  permissionCount?: number
  alreadyImported?: boolean
  reason?: string
  error?: string
}

export interface BatchImportResult {
  mode: 'batch'
  total: number
  imported: number
  alreadyImported: number
  appended: number
  /** 其中「重导另铸副本」的条数（已含在 imported 里，单独点名便于解释新增会话）。 */
  reimported?: number
  skipped: number
  failed: number
  missingFromSource?: string[]
  /** 本批落成宿主附件的图片总数（>0 才占键）。 */
  images?: number
  /** 本批以 [image] 占位降级的图片总数（>0 才占键）。 */
  imagesDegraded?: number
  /** 本批未归组的会话数（>0 才占键）：会话已导入，停在侧栏「未分组」下。 */
  ungrouped?: number
  /** 单库多会话源把本轮落点摊平到顶层：同 SingleImportResult 的归组字段。 */
  workspace?: string
  workspaceMode?: string
  workspaceCreated?: boolean
  ungroupedReason?: string
  results: BatchItemResult[]
}

/** 预览条目（零副作用）：local-jsonl 额外带三级探测结果。 */
export interface PreviewEntry {
  title?: string
  cwd?: string
  cwdRemap?: CwdRemapReport
  createdAt?: number
  turns?: number
  messages?: number
  toolCalls?: number
  skipped?: number
  skipReason?: string
  detectedFormat?: string
  detectedBy?: 'override' | 'marker' | 'path-hint' | 'content'
  bundle?: boolean
  failures?: Array<{ format: string; reason: string }>
}

export interface PreviewResult extends PreviewEntry {
  mode: 'single' | 'batch'
  preview: true
  total?: number
  results?: Array<PreviewEntry & { path: string; status?: 'failed'; error?: string }>
}

export type ImportResult = SingleImportResult | BatchImportResult | PreviewResult

// ---------- import_agents ----------

export interface AgentsImportOptions {
  /** true 时实际写盘（缺省 false = dry-run 预览，零副作用）。 */
  apply?: boolean
  /** pi 根目录（默认 ~/.pi/agent）。 */
  piRoot?: string
  /** opencode 配置根（默认 ~/.config/opencode）。 */
  opencodeRoot?: string
  /** Claude 配置根（默认 ~/.claude），收集 memory/<group>/*.md 与 skills/<skill>/SKILL.md。 */
  claudeRoot?: string
  /** 项目根目录（含 CLAUDE.md 时落为 claude-md 资产；不指定则跳过）。 */
  claudeProjectRoot?: string
  /** Codex 配置根（默认 ~/.codex）。 */
  codexRoot?: string
  /** DSH user-agents 根（默认 $DSH_AGENTS_HOME 或 ~/.agents），skills 写到其下 skills/。 */
  agentsHome?: string
  /** dry-run 别名。 */
  preview?: boolean
}

export interface AgentsImportResult {
  total: number
  planned: number
  applied: number
  skipped: number
  results: Array<{
    name: string
    source: string
    kind: string
    action: 'write' | 'complete' | 'skip'
    reason?: string
    target?: string
  }>
}

// ---------- doctor（只读健康检查） ----------

export interface DoctorResult {
  ok: boolean
  checks: Array<{ name: string; ok: boolean; detail?: string }>
  issues: string[]
  totals: { records: number; sessions: number; missingSessions: number; skills: number }
}

// ---------- import_mcp（Claude/Codex MCP → DSH MCP client 镜像计划） ----------

export interface ImportMcpParams {
  /** Claude MCP 配置文件路径（默认 ~/.claude.json；也兼容项目 .mcp.json 内容）。 */
  claudeMcpPath?: string
  /** Codex config.toml 路径（默认 ~/.codex/config.toml）。 */
  codexConfigPath?: string
  /** true 时写盘生成片段（默认 false = dry-run）。 */
  apply?: boolean
  /** apply 时输出路径（默认 $DSH_HOME/dsh-chat-import/mcp-mirror.cordis.yml）。 */
  outPath?: string
}

export interface ImportMcpResult {
  total: number
  servers: Array<{ source: string; name: string; command: string; args: string[]; env: Record<string, string> }>
  planText: string
  writtenTo?: string
}

// ---------- import_settings（Claude/Codex 配置迁移建议，只读） ----------

export interface ImportSettingsParams {
  /** Claude settings.json 路径（默认 ~/.claude/settings.json）。 */
  claudeSettingsPath?: string
  /** Codex config.toml 路径（默认 ~/.codex/config.toml）。 */
  codexConfigPath?: string
}

export interface ImportSettingsResult {
  total: number
  suggestions: Array<{ key: string; source: string; value: string; suggestion: string; unmappable: boolean }>
  sources: string[]
}

// ---------- export_chat（DSH → 外部格式出边） ----------

export type ExportFormat = 'claude' | 'codex' | 'kimi' | 'opencode'

export interface ExportChatParams {
  /** 目标格式（必填）：claude=Claude Code JSONL（可 --resume 续聊）；codex=Codex rollout JSONL；kimi=Kimi CLI wire.jsonl；opencode=供 `opencode import <file>` 的 JSON。 */
  format: ExportFormat
  /** 要导出的 DSH 会话 id（必填）。 */
  sessionId: string
  /** 覆盖导出记录的 cwd（仅 claude；默认取会话 header.cwd；两者皆无则报错）。 */
  cwd?: string
  /** 输出文件路径（仅 codex / kimi / opencode；缺省 <outputDir>/<sessionId>.<ext>）。 */
  path?: string
  /** 输出目录（claude 默认 ~/.claude/projects，文件写到 <outputDir>/<slug>/<uuid>.jsonl；其余默认 ~/.dsh/exports）。 */
  outputDir?: string
  /** true 时不写盘，只序列化并返回目标路径与统计。 */
  dryRun?: boolean
}

/** claude 导出的会话映射：只在返回值里，不写 imports registry。 */
export interface ExportMapping {
  sourceSessionId: string
  sessionUuid: string
  slug: string
  filePath: string
  turns: number
  messages: number
  toolCalls: number
  toolResults: number
  droppedToolResults: number
  skippedInjections: number
  /** 读回字节并写进目标格式的图片块数（>0 才占键）。 */
  images?: number
  /** 读不到字节、以 [image] 占位导出的图片块数（>0 才占键）。 */
  unavailableImages?: number
}

export interface ExportChatResult {
  mode: 'single'
  sessionId: string
  filePath: string
  recordCount: number
  dryRun: boolean
  /** claude 分支：原会话 id / slug / cwd / 标题（其余目标无）。 */
  sourceSessionId?: string
  slug?: string
  cwd?: string
  title?: string
  /** claude 分支：会话映射（其余目标无）。 */
  mapping?: ExportMapping
  /** codex / kimi / opencode 分支：工具调用/结果计数（claude 无顶层计数，见 mapping）。 */
  toolCalls?: number
  toolResults?: number
  /** 降级清单（有损项逐条报告；仅非空时出现）。 */
  degradations?: Array<{ id: string; kind: string; strategy: 'lossless' | 'text-fallback' | 'skip-placeholder'; count: number }>
}

// ---------- verify_session（只读结构校验 + repair 提示） ----------

export interface VerifySessionResult {
  mode: 'single'
  sessionId: string
  ok: boolean
  eventCount: number
  turns: number
  title?: string
  problems: Array<{ kind: string; seq: number | null; message: string }>
  repairHints: Array<{ kind: string; hint: string }>
}

// ---------- export_bundle / restore_bundle（interchange bundle） ----------

export interface ExportBundleParams {
  /** 要导出的 DSH 会话 id（必填）。 */
  sessionId: string
  /** 输出文件路径（缺省 <outputDir>/<sessionId>.dshbundle.json）。 */
  path?: string
  /** 输出目录（默认 ~/.dsh/exports）。 */
  outputDir?: string
  /** true 时不写盘，只序列化并返回目标路径与指纹。 */
  dryRun?: boolean
}

export interface ExportBundleResult {
  mode: 'single'
  sessionId: string
  filePath: string
  eventCount: number
  dryRun: boolean
  originalCwd?: string
  landingHint?: string
  sha256: { session: string; bundle: string }
}

export interface RestoreBundleParams {
  /** bundle 文件（.dshbundle.json）或含 .dshbundle.json 的目录路径（必填）。 */
  path: string
  /** 覆盖还原出的 DSH 会话 id（默认 import-<源会话 id>）。 */
  sessionId?: string
  /** true 时即使已还原也以新 id 另存完整副本。 */
  force?: boolean
  /** true 时 dry-run 预览（零副作用）。 */
  preview?: boolean
  /** preview 的兼容别名。 */
  dryRun?: boolean
  /** 目录模式是否递归子目录（默认 true）。 */
  recursive?: boolean
}

export interface RestoreBundleResult {
  mode: 'single' | 'batch'
  preview?: boolean
  sessionId?: string
  sourceSessionId?: string
  status?: 'imported' | 'already-imported' | 'appended' | 'skipped' | 'ignored'
  turns?: number
  messages?: number
  toolCalls?: number
  skipped?: number
  skipReason?: string
  /** 原 cwd（机器相关，跨机器还原时 B 机通常不可达）。 */
  originalCwd?: string
  /** 原 cwd 在本机是否可达（目录存在）。 */
  cwdAvailable?: boolean
  /** 建议落点（originalCwd basename）。 */
  landingHint?: string
  /** 实际归组目录（cwd 不可达时 = bundle 文件目录）。 */
  groupedTo?: string
  /** 跨机器还原报告（cwd 不可达时出现，不静默）。 */
  restoreNote?: string
  /** 归组结果：含义同 import_chat 的单文件结果。 */
  workspace?: string
  workspaceMode?: string
  workspaceCreated?: boolean
  ungrouped?: number
  ungroupedReason?: string
  title?: string
  createdAt?: number
  alreadyImported?: boolean | number
  total?: number
  imported?: number
  appended?: number
  failed?: number
  /** 还原走同一套重导语义（docs/architecture.md D13）。 */
  storedShrunk?: boolean
  reimported?: { previous: string; current: string; reason: ReimportReason }
  results?: Array<{
    path: string
    status: string
    sessionId?: string
    turns?: number
    messages?: number
    toolCalls?: number
    skipped?: number
    restoreNote?: string
    cwdAvailable?: boolean
    groupedTo?: string
    ungrouped?: number
    ungroupedReason?: string
    error?: string
    reason?: string
    storedShrunk?: boolean
    reimported?: { previous: string; current: string; reason: ReimportReason }
  }>
}

// ---------- list_imported_sessions / retract_import ----------

export interface ImportedSessionInfo {
  sessionId: string
  title?: string
  sourcePath: string | null
  artifactPath: string | null
  importedAt?: number
}

export interface ListImportedResult {
  total: number
  sessions: ImportedSessionInfo[]
}

export interface RetractParams {
  /** 要撤回的 DSH 会话 id（与 sourcePath 二选一；从日志标记 / registry 定位源文件）。 */
  sessionId?: string
  /** 要撤回的源文件路径（与 sessionId 二选一；直接按 registry 幂等键移除记录）。 */
  sourcePath?: string
}

export interface RetractResult {
  removed: true
  sourcePath: string
  artifactPath: string | null
  wasRegistered: boolean
  manualDelete: string
}

// ---------- scan_discover ----------

/** 发现层可扫描的格式（= lib/discovery.mjs 的 FORMATS；比 ChatFormat 少 local-jsonl）。 */
export type ScanFormat =
  | 'claude' | 'codex' | 'cursor' | 'gemini' | 'antigravity' | 'reasonix' | 'opencode' | 'mimocode'
  | 'zcode' | 'grokbuild' | 'openclaw' | 'pi' | 'hermes' | 'kimi' | 'kilocode' | 'qoder'
  | 'chatgpt' | 'workbuddy' | 'qwen' | 'continue' | 'cline' | 'goose' | 'dsh4' | 'zed'
  | 'crush' | 'teleagent' | 'trae' | 'vibe' | 'dsh'

export type ImportStatusLabel = 'imported' | 'partial' | 'not-imported' | 'archived'

export interface ScanDiscoverParams {
  /** 扫描根（目录或单文件）。缺省扫全部格式的默认数据根。 */
  path?: string
  /** 只扫指定格式；缺省按路径探测全部格式。 */
  format?: ScanFormat
  /** 按标题 / 项目 / 路径子串过滤（忽略大小写）。 */
  query?: string
}

export interface DiscoveredSession {
  format: ScanFormat
  sessionId: string
  title?: string | null
  project?: string | null
  cwd?: string | null
  createdAt?: number | null
  lastActiveAt?: number | null
  contextTokens?: number | null
  sourcePath: string
  gitBranch?: string | null
  gitDirty?: boolean | null
  importStatus: ImportStatusLabel
}

/** 扫描失败被跳过的目标（权限 / 库损坏 / 读取器异常）：其余目标照常产出。 */
export interface ScanWarning {
  format: ScanFormat
  /** 失败的扫描目标（数据根、库文件或单个转录路径）。 */
  target: string
  error: string
}

export interface ScanDiscoverResult {
  total: number
  sessions: DiscoveredSession[]
  /** 本次扫描失败的目标；空数组 = 全部目标扫描成功。 */
  warnings: ScanWarning[]
}
