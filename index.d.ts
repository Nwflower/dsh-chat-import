// index.d.ts — dsh-chat-import 类型面（手写维护，随工具 schema 变更同步）
//
// 本包是零构建纯 ESM 插件：index.mjs 只导出 Cordis 插件入口（apply/inject/name）
// 与少量 host 面辅助函数；15 个工具由 apply 动态注册，不在此模块导出。
// 因此本文件把「工具调用面」声明为一个类型化接口（ToolSurface），供 TS 调用方
// 参考参数/返回结构，而不是伪装成真实的模块导出。
//
// 结构对齐 lib/tools.mjs 注册的 schema 与 lib/toolkit.mjs 的 makeImportChatTool
// 输出 oneOf（单文件/批量 × 预览/实导入）。修改工具 schema 时须同步此处。

// ---------- Cordis 插件入口（index.mjs 的真实导出） ----------

export declare const name: string
export declare const inject: string[]

/** 本插件消费的 host 公开服务最小面（sessionPersistence / fs / tools / workspaceRegistry）。 */
export interface HostContext {
  tools: { register(tool: unknown): unknown }
  get?(name: string): unknown
  inject?(deps: string[], callback?: (ctx: Record<string, unknown>) => void): unknown
}

export declare function apply(ctx: HostContext): void
export declare function readOpencodeDb(...args: unknown[]): Promise<unknown>
export declare function readZcodeDb(...args: unknown[]): Promise<unknown>
export declare function exportClaudeSession(
  ctx: HostContext,
  args: ExportClaudeParams,
  options?: { registryDir?: string },
): Promise<ExportClaudeResult>

// ---------- 工具调用面（ToolSurface：apply 注册的 15 个工具） ----------
// import_chat 是 18 个聊天导入源（17 个面板来源 + local-jsonl）的统一分发入口：
// format 必填（源枚举），专属参数（compacted / branch / sessionIds / fullHistory /
// lineage / parseFormat）只对相应 format 生效。

export interface ToolSurface {
  import_chat(options: ImportChatOptions): Promise<ImportResult>
  import_agents(options?: AgentsImportOptions): Promise<AgentsImportResult>
  export_claude(options: ExportClaudeParams): Promise<ExportClaudeResult>
  export_codex(options: ExportTargetParams): Promise<ExportTargetResult>
  export_kimi(options: ExportTargetParams): Promise<ExportTargetResult>
  export_bundle(options: ExportBundleParams): Promise<ExportBundleResult>
  restore_bundle(options: RestoreBundleParams): Promise<RestoreBundleResult>
  verify_session(options: { sessionId: string }): Promise<VerifySessionResult>
  sync_to_claude(options: SyncToClaudeParams): Promise<SyncToClaudeResult>
  list_imported_sessions(): Promise<ListImportedResult>
  retract_import(options: RetractParams): Promise<RetractResult>
  scan_discover(options?: ScanDiscoverParams): Promise<ScanDiscoverResult>
}

// ---------- 导入工具公共参数与返回 ----------

export interface ImportOptions {
  /** 源 transcript / 数据库 / 会话目录路径；目录模式递归扫描，每文件/每会话独立导入。 */
  path: string
  /** true 时即使已导入也以新 id（import-<src>-<n>）另存完整副本，旧会话原样保留。 */
  force?: boolean
  /** 上下文预算（token 数），超长会话按三层保护裁剪；优先级 参数 > env > 动态模型窗口 > 静态 550k。 */
  budget?: number
  /** true 时 dry-run 预览——不落盘、不写 registry、不归组，仅返回将导入会话清单。 */
  preview?: boolean
  /** preview 的兼容别名（语义相同）。 */
  dryRun?: boolean
  /** 目标 DSH 会话 id（仅单文件导入时生效，默认 import-<源sessionId>；目录模式 / SQLite 库源忽略）。 */
  sessionId?: string
  /** 目录模式是否递归子目录（默认 true；SQLite 库源忽略）。 */
  recursive?: boolean
}

export type LocalJsonlFormat =
  | 'dsh' | 'claude' | 'codex' | 'cursor' | 'reasonix' | 'pi' | 'openclaw' | 'hermes' | 'qoder'

/** import_chat 的源格式枚举（值 = 来源短名，与面板来源 / discovery FORMATS 一致）。 */
export type ChatFormat =
  | 'claude' | 'codex' | 'chatgpt' | 'cursor' | 'gemini' | 'reasonix' | 'opencode'
  | 'mimocode' | 'zcode' | 'grokbuild' | 'openclaw' | 'hermes' | 'pi' | 'kimi'
  | 'qoder' | 'workbuddy' | 'dsh' | 'local-jsonl'

/** import_chat 参数：公共导入参数（ImportOptions）+ 源格式 + 源专属参数。 */
export interface ImportChatOptions extends ImportOptions {
  /** 源格式（必填），决定 path 形态与解析器。 */
  format: ChatFormat
  /** 仅 claude：true 时只导最后一次压缩摘要 + 尾部（compacted 摘要导入）；默认 false 全量。 */
  compacted?: boolean
  /** 仅 chatgpt：'main'（默认）只重建主线程；'all' 枚举全部分支会话。 */
  branch?: 'main' | 'all'
  /** 仅 opencode / mimocode / zcode：只导入指定源会话 id（缺省导入全部）。 */
  sessionIds?: string[]
  /** 仅 opencode / mimocode / pi：true 时导入全量历史（忽略对话压缩）；默认 false 尊重压缩。 */
  fullHistory?: boolean
  /** 仅 hermes：'tail' 只导 lineage 链尾（叶子会话）。 */
  lineage?: 'tail'
  /** 仅 local-jsonl：强制按指定格式解析；缺省自动识别。 */
  parseFormat?: LocalJsonlFormat
}

export type ImportStatus = 'imported' | 'already-imported' | 'appended' | 'skipped' | 'failed'

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

/** REQ-57 落盘会话结构校验报告（导入结果附加字段，仅校验失败时出现）。 */
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

export interface SingleImportResult {
  mode: 'single'
  sessionId: string
  status: ImportStatus
  turns: number
  messages: number
  toolCalls: number
  skipped?: number
  skippedLines?: LineIssue[]
  secrets?: SecretLocation[]
  permissionCount?: number
  skipReason?: string
  alreadyImported: boolean
  appendedTurns?: number
  appendedEvents?: number
  appendedSkipped?: string
  sourceShrunk?: boolean
  changedInPlace?: boolean
  argsChanged?: boolean
  budgetChanged?: boolean
  backfilled?: boolean
  droppedBoundaryResults?: number
  trimmed?: TrimReport | null
  forceImported?: { previous: string; current: string }
  /** issue #22：宿主内存残留幽灵会话（retract 后工件已删）时重导自动另铸后缀新 id，
   * previous = 幽灵原 id、current = 新落盘 id。 */
  staleGhost?: { previous: string; current: string }
  validation?: ValidationReport
}

export interface BatchItemResult {
  path: string
  status: ImportStatus
  sessionId?: string
  turns?: number
  messages?: number
  toolCalls?: number
  skipped?: number
  reason?: string
  error?: string
  appendedTurns?: number
  appendedEvents?: number
  sourceShrunk?: boolean
  changedInPlace?: boolean
  argsChanged?: boolean
  budgetChanged?: boolean
  backfilled?: boolean
  trimmed?: TrimReport | null
  forceImported?: { previous: string; current: string }
  /** issue #22：同 SingleImportResult.staleGhost（批量条目）。 */
  staleGhost?: { previous: string; current: string }
  validation?: ValidationReport
}

export interface BatchImportResult {
  mode: 'batch'
  total: number
  imported: number
  alreadyImported: number
  appended: number
  skipped: number
  failed: number
  missingFromSource?: string[]
  results: BatchItemResult[]
}

export interface PreviewResult {
  mode: 'single' | 'batch'
  preview: true
  total?: number
  title?: string
  cwd?: string
  createdAt?: number
  turns?: number
  messages?: number
  toolCalls?: number
  skipped?: number
  skipReason?: string
  results?: Array<{
    path: string
    title?: string
    cwd?: string
    createdAt?: number
    turns?: number
    messages?: number
    toolCalls?: number
    skipped?: number
    skipReason?: string
    status?: 'failed'
    error?: string
  }>
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

// ---------- export_codex / export_kimi（REQ-23 矩阵化互转） ----------

export interface ExportTargetParams {
  /** 要导出的 DSH 会话 id（必填）。 */
  sessionId: string
  /** 输出文件路径（缺省 <outputDir>/<sessionId>.rollout.jsonl 或 .wire.jsonl）。 */
  path?: string
  /** 输出目录（默认 ~/.dsh/exports）。 */
  outputDir?: string
  /** true 时不写盘，只序列化并返回目标路径与统计。 */
  dryRun?: boolean
}

export interface ExportTargetResult {
  mode: 'single'
  sessionId: string
  filePath: string
  recordCount: number
  toolCalls: number
  toolResults: number
  dryRun: boolean
  degradations?: Array<{ id: string; kind: string; strategy: 'lossless' | 'text-fallback' | 'skip-placeholder'; count: number }>
}

// ---------- verify_session（REQ-23 只读结构校验 + repair 提示） ----------

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

// ---------- export_claude / sync_to_claude ----------

export interface ExportClaudeParams {
  /** 要导出的 DSH 会话 id（必填）。 */
  sessionId: string
  /** 覆盖导出记录的 cwd（默认取会话 header.cwd；两者皆无则报错）。 */
  cwd?: string
  /** Claude Code projects 根目录（默认 ~/.claude/projects），文件写到 <outputDir>/<slug>/<uuid>.jsonl。 */
  outputDir?: string
  /** true 时不写盘，只序列化并返回目标路径与统计。 */
  dryRun?: boolean
}

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
}

export interface ExportClaudeResult {
  mode: 'single'
  sessionId: string
  sourceSessionId: string
  filePath: string
  slug: string
  cwd: string
  recordCount: number
  title?: string
  dryRun: boolean
  mapping: ExportMapping
  /** REQ-21 降级清单（有损项逐条报告；仅非空时出现）。 */
  degradations?: Array<{ id: string; kind: string; strategy: 'lossless' | 'text-fallback' | 'skip-placeholder'; count: number }>
}

// ---------- export_bundle / restore_bundle（REQ-56/62 interchange bundle） ----------

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
  status?: 'imported' | 'already-imported' | 'appended' | 'skipped'
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
  /** 实际归组目录（cwd 不可达时 = bundle 文件目录，REQ-39-lite 回退）。 */
  groupedTo?: string
  /** 跨机器还原报告（cwd 不可达时出现，不静默）。 */
  restoreNote?: string
  alreadyImported?: boolean | number
  total?: number
  imported?: number
  appended?: number
  failed?: number
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
    error?: string
    reason?: string
  }>
}

export interface SyncToClaudeParams {
  /** 要写回的 DSH 会话 id（必须是由本插件导入的会话，带 session/imported 标记）。 */
  sessionId: string
  /** 写回目标 'source'（默认，导入源文件）| 'copy'（export_claude 导出的副本）。 */
  target?: 'source' | 'copy'
  /** true 时跳过三闸守卫并以当前文件重锚定，可能覆盖外部修改。 */
  force?: boolean
  /** true 时完整计算（含格式预检）但不写盘、不更新 registry。 */
  dryRun?: boolean
}

export interface SyncToClaudeResult {
  mode: 'single'
  status: 'synced' | 'no-new-turns' | 'skipped'
  sessionId: string
  sourcePath: string
  target: 'source' | 'copy'
  filePath: string
  appendedTurns?: number
  appendedEvents?: number
  appendedRecords?: number
  conflictDetected?: 'source-modified-externally' | 'tail-mismatch' | 'write-version-mismatch'
  sourceShrunk?: boolean
  storedShrunk?: boolean
  incompleteFinalTurn?: boolean
  precheckFailed?: boolean
  rollbackError?: string
  reason?: string
  precheck?: {
    ok: boolean
    recordCount?: number
    lastUuid?: string
    errors?: LineIssue[]
  }
  dryRun: boolean
  writeback?: {
    sessionUuid: string
    filePath: string
    lastWrittenSeq: number
    lastWrittenTurn?: number
    prevUuid?: string
    lastSize: number
    lastVersion: string
    writtenAt: number
  }
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

export type ScanFormat =
  | 'claude' | 'codex' | 'cursor' | 'gemini' | 'reasonix' | 'opencode'
  | 'zcode' | 'grokbuild' | 'openclaw' | 'pi' | 'hermes' | 'kimi'
  | 'qoder' | 'chatgpt' | 'workbuddy' | 'dsh'

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
  messageCount?: number | null
  sourcePath: string
  gitBranch?: string | null
  gitDirty?: boolean | null
  importStatus: ImportStatusLabel
}

export interface ScanDiscoverResult {
  total: number
  sessions: DiscoveredSession[]
}
