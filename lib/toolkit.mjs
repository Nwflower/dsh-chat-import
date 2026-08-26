// lib/toolkit.mjs — 导入工具工厂：18 个聊天导入源收敛为单一 import_chat 分发器。
//
// 收敛动机（工具瘦身）：18 个 import_* 各自携带重复的公共参数块与长描述，每轮
// 模型请求合计约 34k 字符 schema（编译形态）；合并后单工具一轮约 3.5k 字符，
// 与 UI 面板（POST /api-import/import）行为完全一致。output 巨型 oneOf schema
// 从不进入模型请求（宿主 ToolSchema 只投影 name/description/parameters），原样保留。
//
// registryDir / fingerprintKeys 语义不变（imports registry args 指纹）；带 format
// 的来源沿旧契约登记进 IMPORT_SPECS（REQ-41 Stage 2），lib/panel.mjs 的
// importDiscoveryItem 与 lib/command.mjs 的 /import 命令继续消费同一 spec
//（io/derive/registry/convert/sourceLabel），面板与命令行为零变化。
// lib/import-variants.mjs（chatgpt / grokbuild / hermes / kimi 编排）原样复用。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveImportBudget } from './budget.mjs'
import { readImportPrefs } from './import-prefs.mjs'
import {
  importTranscript, importDirectory, previewTranscript, previewDirectory, isPreview,
} from './import-core.mjs'

// REQ-41 Stage 2：面板批量导入（POST /api-import/import）与 /import 命令按 format
// 复用工具层同一套导入编排。登记与 makeImportChatTool 同一 spec 集合（local-jsonl
// 不是面板来源，不登记——与旧 import_local_jsonl 语义一致）。
export const IMPORT_SPECS = new Map()

// 增量续写语义（REQ-24）：与工具 description 的「幂等跳过」表述互补
const descriptionSuffix = ' 重复导入已导入的源文件会增量续写新增轮次（源文件未变则跳过）；force:true 以新 id 另存完整副本。'

// format 枚举（值 = 来源短名，与 discovery FORMATS / 面板 SOURCE_FORMAT 兼容；
// 描述携带路径形态与专属参数，替代原 18 个独立工具的 description + path 描述）。
const CHAT_FORMATS = [
  ['claude', 'Claude Code JSONL transcript（~/.claude/projects，目录可递归）'],
  ['codex', 'Codex / ChatGPT CLI rollout JSONL（~/.codex/sessions，目录可递归）'],
  ['chatgpt', 'ChatGPT 网页导出 conversations.json（JSON 数组，一文件含全部会话，恒批量）'],
  ['cursor', 'Cursor agent transcript JSONL（~/.cursor/projects/<slug>/agent-transcripts）'],
  ['gemini', 'Gemini CLI 会话 JSON（~/.gemini/history/<slot>/chats/session-*.json）'],
  ['reasonix', 'Reasonix 会话 JSONL（~/.reasonix/sessions 或 %APPDATA% 下 projects 布局）'],
  ['opencode', 'opencode SQLite 历史库 opencode.db（~/.local/share/opencode，恒批量）'],
  ['mimocode', 'mimocode SQLite 历史库 mimocode.db（opencode fork，~/.local/share/mimocode，恒批量）'],
  ['zcode', 'z.ai zcode 历史库 db.sqlite（~/.zcode/cli/db，恒批量）或 zcode://<sessionId> 伪路径'],
  ['grokbuild', 'Grok Build 会话目录（summary.json + chat_history.jsonl）或 ~/.grok/sessions 根'],
  ['openclaw', 'OpenClaw 会话 JSONL（~/.openclaw/agents/<agent>/sessions）'],
  ['hermes', 'Hermes 历史库 state.db（~/.hermes）或 sessions/*.jsonl 回退（db 不可用时），.db 恒批量'],
  ['pi', 'Pi Coding Agent 会话 JSONL（~/.pi/agent/sessions/<cwd md5>）'],
  ['kimi', 'Kimi CLI / Kimi Code 会话目录（wire.jsonl + state.json；旧 ~/.kimi 新 ~/.kimi-code）'],
  ['qoder', 'Qoder CLI 会话 JSONL（~/.qoder/projects/<encoded-project>）'],
  ['workbuddy', 'WorkBuddy（腾讯 AI 编码）会话 JSONL（~/.workbuddy/projects）'],
  ['dsh', 'DSH 自身会话日志 session.jsonl / session.jsonl.zstd（~/.dsh/sessions，目录递归）'],
  ['local-jsonl', '任意本地 JSONL（自动识别；可 parseFormat 强制指定解析器）'],
]

// 专属参数的处理集（local-jsonl 的强制解析器枚举与 index.d.ts LocalJsonlFormat 一致）
const PARSE_FORMATS = ['dsh', 'claude', 'codex', 'cursor', 'reasonix', 'pi', 'openclaw', 'hermes', 'qoder']

// REQ-09 参数收敛：全部源共享一份公共参数表（分发器单工具形态，不再按源复制）。
// opencode/mimocode/zcode 原 drop 的 sessionId/recursive 由 SQLite 源自然忽略。
const COMMON_PARAMS = {
  path: {
    type: 'string',
    required: true,
    description: '源 transcript / 数据库 / 会话目录路径（具体形态随 format，见 format 枚举说明）。',
  },
  force: {
    type: 'boolean',
    description: '可选：true 时即使已导入也以新 id（import-<src>-<n>）另存一份完整副本，旧会话原样保留。',
  },
  budget: {
    type: 'integer',
    description: '可选：上下文预算（token 数），超长会话按三层保护裁剪。优先级：本参数 > 环境变量 DSH_IMPORT_CONTEXT_BUDGET > 动态模型窗口（agentDefaultModel + llm）> 静态默认 550k。',
  },
  preview: {
    type: 'boolean',
    description: '可选：true 时 dry-run 预览——不落盘、不写 imports registry、不归组，仅返回将导入会话清单（标题 / cwd / 时间 / 规模 / 跳过明细），确认后再正式导入（去掉 preview 再调一次即可）。',
  },
  dryRun: {
    type: 'boolean',
    description: '可选：preview 的兼容别名（语义相同：不落盘、仅返回将导入会话清单）。',
  },
  sessionId: {
    type: 'string',
    description: '可选：目标 DSH 会话 id（仅单文件导入时生效，默认 import-<源sessionId>；目录模式忽略）。',
  },
  recursive: {
    type: 'boolean',
    description: '可选：目录模式是否递归子目录（默认 true）。',
  },
  expectedHash: {
    type: 'string',
    description: '可选：源文件期望 SHA-256（小写 hex）；传入后导入前做强校验，不匹配则失败且不落盘。',
  },
  restamp: {
    type: 'boolean',
    description: '可选：true 时把导入会话的时间戳平移到当前时间（保持相对间隔），适合导入后置顶显示；默认 false 保留源时间。',
  },
  workspaceMode: {
    type: 'string',
    enum: ['auto', 'dedicated', 'per-project'],
    description: '可选：归组模式——auto/per-project 按 cwd 或源目录归组；dedicated 把所有导入会话挂到单个专用工作区（默认 $DSH_HOME/dsh-chat-import-workspace，可用 workspaceDir 覆盖）。',
  },
  workspaceDir: {
    type: 'string',
    description: '可选：workspaceMode=dedicated 时的工作区目录；默认 $DSH_HOME/dsh-chat-import-workspace。',
  },
}

// 源专属参数（仅对应 format 消费，其余 format 忽略；原各工具 schema.extra 合并，
// 描述标注适用格式）。zcode:// 伪路径的会话 id 由 spec.derive 从 path 提取。
const EXTRA_PARAMS = {
  compacted: {
    type: 'boolean',
    description: '可选（仅 claude）：true 时只导最后一次压缩摘要 + 尾部（Claude compacted 摘要导入，超长会话主动压缩还原）；默认 false 全量。',
  },
  branch: {
    type: 'string',
    enum: ['main', 'all'],
    description: "可选（仅 chatgpt）：'main'（默认）只重建主线程（children 最后一个）；'all' 枚举全部分支会话（每条 root→leaf 路径一个会话，分支会话标题带分支标记）。",
  },
  sessionIds: {
    type: 'array',
    items: { type: 'string' },
    description: '可选（仅 opencode/mimocode/zcode）：只导入指定源会话 id（缺省导入全部会话）。',
  },
  fullHistory: {
    type: 'boolean',
    description: '可选（仅 opencode/mimocode/pi）：true 时导入全量历史（忽略对话压缩）；默认 false 尊重压缩（只导最后一次摘要 + 尾巴）。',
  },
  lineage: {
    type: 'string',
    enum: ['tail'],
    description: "可选（仅 hermes）：'tail' 只导 lineage 链尾（叶子会话，非任何会话的父会话）；压缩分叉父会话跳过并在报告标注。",
  },
  parseFormat: {
    type: 'string',
    enum: PARSE_FORMATS,
    description: '可选（仅 local-jsonl）：强制按指定格式解析；缺省自动识别（路径特征 + 首条有效会话结构）。',
  },
}

// 按 spec 构建执行器：闭包解析 io/derive/label/registry 后返回 (args) => result，
// 与原 makeImportTool.execute 完全同构（budget → prefs → preview → stat 分发）。
export function buildImportExecutor(ctx, spec) {
  const {
    io = {}, derive = {}, label = {}, registry = {},
  } = spec
  const {
    file: importFile, dir: importDir, previewFile, previewDir, alwaysBatch, fileBatch, dirSingle,
  } = io
  const { args: deriveArgs, collect } = derive
  const deriveFn = deriveArgs || (async () => ({}))
  const registryDir = registry.dir
  const fingerprintKeys = registry.fingerprintKeys || []
  const importSingle = importFile
    || ((c, t, a) => importTranscript(c, t, a, spec.convert, { registryDir, fingerprintKeys, readText: spec.readText }))
  const importBatch = importDir
    || ((c, d, a) => importDirectory(c, d, a, { convert: spec.convert, sourceLabel: spec.sourceLabel, deriveArgs: deriveFn, collect, registryDir, fingerprintKeys, readText: spec.readText }))
  const previewSingle = previewFile || ((c, t, a) => previewTranscript(c, t, a, spec.convert, { readText: spec.readText }))
  const previewBatch = previewDir || ((c, d, a) => previewDirectory(c, d, a, { convert: spec.convert, deriveArgs: deriveFn, collect, readText: spec.readText }))
  return async (args) => {
    // REQ-37：解析上下文预算（参数 > env > 动态模型窗口 > 静态默认），盖写进
    // args.budget（token 数，转换层裁剪消费、registry 记录）与 args.budgetSource
    // （裁剪上报标注来源）；预算变化经 registry 比对 → budgetChanged 跳过。
    const budgetInfo = await resolveImportBudget(ctx, args)
    // 导入偏好（chat-import 设置命名空间）：「导入系统提示词作为上下文注入」开关
    // （默认关）。读值合并进 args，随既有 args → convert(raw, args) 路径送达各源
    // 转换器；设置服务缺席时 readImportPrefs 回退默认，不阻塞导入。
    const prefs = readImportPrefs(ctx)
    const effective = { ...args, budget: budgetInfo.budget, budgetSource: budgetInfo.source, importSystemPrompt: prefs.importSystemPrompt === true }
    // REQ-17：preview/dryRun=true 走预览分支（照常 resolve/stat/readText/convert，
    // 但零副作用——不落盘、不写 registry、不归组；见 preview* 实现）
    const preview = isPreview(args)
    const flag = preview ? { preview: true } : {}
    const target = await ctx.fs.resolve(effective.path)
    const info = await ctx.fs.stat(target)
    if (info && info.type === 'directory') {
      // grokbuild / kimi：会话目录（含 summary.json / wire.jsonl）视作单源 → 单会话导入
      if (dirSingle && await dirSingle(ctx, target)) {
        const fileArgs = { ...effective, ...(await deriveFn(target)) }
        const single = preview ? await previewSingle(ctx, target, fileArgs) : await importSingle(ctx, target, fileArgs)
        return { mode: 'single', ...flag, ...single }
      }
      const batch = preview ? await previewBatch(ctx, target, effective) : await importBatch(ctx, target, effective)
      return { mode: 'batch', ...flag, ...batch }
    }
    // 单文件：合并按文件派生的转换参数（可 async；Cursor 的 composer id、Reasonix 的 meta）
    const fileArgs = { ...effective, ...(await deriveFn(target)) }
    // hermes：.db 单文件恒返回批量形态（SQLite 一库多会话）
    if (alwaysBatch || (fileBatch && await fileBatch(ctx, target))) {
      const batch = preview ? await previewSingle(ctx, target, fileArgs) : await importSingle(ctx, target, fileArgs)
      return { mode: 'batch', ...flag, ...batch }
    }
    const single = preview ? await previewSingle(ctx, target, fileArgs) : await importSingle(ctx, target, fileArgs)
    return { mode: 'single', ...flag, ...single }
  }
}

// 单分发器工具：18 个聊天导入源（17 个面板来源 + local-jsonl）共用一个 schema 与
// 执行入口。render 按 args.format 动态解析该源 label（批量单位 / 跳过文案）。
// local-jsonl 的强制解析器经 parseFormat 注入（替换顶层 format 值，转换器读 args.format）。
export function makeImportChatTool(ctx, specs) {
  for (const spec of specs) if (spec.format) IMPORT_SPECS.set(spec.format, spec)
  const byFormat = new Map(specs.map((s) => [s.format, s]))
  const executors = new Map()
  const specOf = (format) => byFormat.get(format) || null
  const runOf = (spec) => {
    let run = executors.get(spec)
    if (!run) {
      run = buildImportExecutor(ctx, spec)
      executors.set(spec, run)
    }
    return run
  }
  return defineTool({
    name: 'import_chat',
    description:
      '从外部聊天记录导入历史对话为可继续的 DSH 会话（面板之外的会话内统一入口，18 种格式）。' +
      'format 必填（源格式枚举，值 = 来源短名；path 形态随 format）；其余公共参数见各参数说明。' +
      '单文件/单库 → 单会话，目录 → 批量；重复导入幂等跳过（增量续写新增轮次）。' +
      '返回新会话 id（或批量统计）与明细。' + descriptionSuffix,
    parameters: {
      format: {
        type: 'string',
        required: true,
        enum: CHAT_FORMATS.map(([f]) => f),
        description: '源格式（必填）：' + CHAT_FORMATS.map(([f, d]) => f + '=' + d).join('；'),
      },
      ...COMMON_PARAMS,
      ...EXTRA_PARAMS,
    },
    output: {
      schema: IMPORT_OUTPUT_SCHEMA,
      render: (args, value) => renderImportResult(args, value, specOf(args.format)),
    },
    async execute(args) {
      const spec = specOf(args.format)
      if (!spec) throw new Error('未知 format: ' + args.format)
      if (args.format === 'local-jsonl') {
        // 顶层 format 已被 'local-jsonl' 占用：强制解析器经 parseFormat 传入，
        // 剥掉顶层 format 后注入（缺省自动识别——转换器不读 format 即检测）
        const { format, parseFormat, ...rest } = args
        return runOf(spec)(parseFormat ? { ...rest, format: parseFormat } : rest)
      }
      return runOf(spec)(args)
    },
  })
}

// render 按当前源的 label 取批量单位与跳过文案（原 makeImportTool 的闭包 label
// 改为按 args.format 动态解析，批量文案如 opencode「共扫描 N 个会话」保持）。
function renderImportResult(args, value, spec) {
  const label = (spec && spec.label) || {}
  const sourceLabel = (spec && spec.sourceLabel) || 'transcript'
  const batchUnit = label.batch || '文件'
  const skippedNote = label.skipped
  // REQ-17 dry-run 预览：人类可读清单（未落盘提示 + 逐条明细摘要）
  if (value.preview === true) {
    if (value.mode === 'batch') {
      const detail = (value.results || []).slice(0, 5).map((r) => '  - ' + r.path
        + (r.title ? '：' + r.title : '')
        + (r.skipReason ? '：' + r.skipReason : '')
        + (r.status === 'failed' && r.error ? '：' + r.error : ''))
      return [{
        type: 'text',
        text: '预览（dry-run，未落盘）：共 ' + value.total + ' 个' + batchUnit
          + (detail.length ? '\n' + detail.join('\n') : ''),
      }]
    }
    return [{
      type: 'text',
      text: '预览（dry-run，未落盘）：'
        + (value.title ? '《' + value.title + '》' : '')
        + (value.turns > 0 ? value.turns + ' 轮对话' : '无可导入内容')
        + '（' + value.messages + ' 条消息、' + value.toolCalls + ' 次工具调用'
        + (value.skipped ? '、跳过 ' + value.skipped : '') + '）'
        + (value.skipReason ? '\n跳过原因：' + value.skipReason : ''),
    }]
  }
  // REQ-37 裁剪上报摘要（trimmed 存在时追加一行人类可读说明）
  const trimmedNote = (v) => {
    const t = v && v.trimmed
    if (!t) return ''
    const bits = []
    if (t.droppedTurns > 0) bits.push('裁剪 ' + t.droppedTurns + ' 轮')
    if (t.croppedBlocks > 0) bits.push('裁剪 ' + t.croppedBlocks + ' 条超长内容')
    if (t.droppedOversized > 0) bits.push('丢弃 ' + t.droppedOversized + ' 条超半消息')
    if (t.summaryInserted) bits.push('已插入摘要')
    return bits.length > 0 ? '（' + bits.join('，') + '，估算 ' + t.estimatedTokens + '/' + t.budget + ' tokens，来源 ' + t.source + '）' : ''
  }
  // REQ-26 畸形行明细 + secrets/permission 计数：只含行号与 kind，绝不拼入内容
  const req26Note = (v) => {
    const skippedLines = v.skippedLines || []
    const counts = []
    if (v.secrets && v.secrets.length > 0) counts.push('secrets 命中 ' + v.secrets.length + ' 处')
    if (v.permissionCount) counts.push('permission ' + v.permissionCount + ' 条')
    if (skippedLines.length === 0) return counts.join('、')
    const lines = skippedLines.slice(0, 20).map((s) => 'L' + s.line).join('/')
    const more = skippedLines.length > 20 ? ' …' : ''
    return '畸形行明细：' + lines + more + (counts.length ? '（' + counts.join('、') + '）' : '')
  }
  if (value.mode === 'batch') {
    const bits = []
    bits.push('共扫描 ' + value.total + ' 个' + batchUnit)
    if (value.imported) bits.push('新增 ' + value.imported + ' 个会话')
    if (value.appended) bits.push('续写 ' + value.appended + ' 个会话')
    if (value.alreadyImported) bits.push('已存在 ' + value.alreadyImported + ' 个')
    if (value.skipped) bits.push('跳过 ' + value.skipped + ' 个（' + (skippedNote || '非 ' + sourceLabel + ' transcript') + '）')
    if (value.failed) bits.push('失败 ' + value.failed + ' 个')
    const trimmedItems = (value.results || []).filter((r) => r.trimmed).length
    if (trimmedItems) bits.push(trimmedItems + ' 个会话触发预算裁剪')
    // 错误处理打磨：失败/跳过原因要可见，不只计数（最多展示 5 条）
    const problems = (value.results || []).filter((r) => r.status === 'failed' || r.status === 'skipped').slice(0, 5)
    const detail = problems.map((r) => '  - ' + r.path + (r.error ? '：' + r.error : r.reason ? '：' + r.reason : ''))
    return [{
      type: 'text',
      text: '批量导入完成：' + bits.join('，') + (detail.length ? '\n' + detail.join('\n') : ''),
    }]
  }
  if (value.status === 'skipped' && value.sessionId === 'none') {
    return [{
      type: 'text',
      text: '跳过导入：' + (value.skipReason || '非 ' + sourceLabel + ' transcript')
        + (req26Note(value) ? '\n' + req26Note(value) : ''),
    }]
  }
  if (value.status === 'appended') {
    return [{
      type: 'text',
      text: '会话 ' + value.sessionId + ' 已续写 ' + value.appendedTurns + ' 轮、' + value.appendedEvents + ' 条事件（源文件新增轮次）。' + trimmedNote(value),
    }]
  }
  if (value.status === 'imported' && value.forceImported) {
    return [{
      type: 'text',
      text: '已强制导入完整副本 → 会话 ' + value.forceImported.current + '（前身 ' + value.forceImported.previous + ' 原样保留）。' + trimmedNote(value),
    }]
  }
  if (value.alreadyImported) {
    const why = value.sourceShrunk
      ? '源文件轮次减少（sourceShrunk），跳过；需要完整副本请用 force:true'
      : value.changedInPlace
        ? '源文件在既有轮次内变化（append-only 无法改写），跳过'
        : value.argsChanged
          ? '导入参数已变化（args-changed），跳过；需要按新参数导入请用 force:true'
          : value.budgetChanged
            ? '上下文预算已变化（budget-changed），跳过；需要按新预算导入请用 force:true'
            : value.appendedSkipped
            ? '源文件已增长但无法确定已存日志长度，跳过增量续写'
            : value.backfilled
              ? '已回填导入记录（旧版本导入的会话）'
              : '源文件未变化'
    return [{
      type: 'text',
      text: '会话 ' + value.sessionId + ' 已存在，跳过导入：' + why + '。',
    }]
  }
  return [{
    type: 'text',
    text: '已导入 ' + value.turns + ' 轮对话（' + value.messages + ' 条消息、' + value.toolCalls + ' 次工具调用）→ 会话 ' + value.sessionId + (value.skipped ? '（跳过 ' + value.skipped + ' 行畸形记录）' : '') + trimmedNote(value) + (req26Note(value) ? '\n' + req26Note(value) : ''),
  }]
}

// 导入结果 schema（各源共用）：oneOf = 单文件预览 / 批量预览 / 单文件 / 批量。
// 宿主 ToolSchema 只投影 name/description/parameters——output 不进模型请求，
// 但保留结构契约（与旧 18 个工具一致，validateJsonSchemaValue 测试依赖）。
const IMPORT_OUTPUT_SCHEMA = {
  oneOf: [
    // 单文件 dry-run 预览（REQ-17）：无写入态字段（sessionId/status/alreadyImported 等）
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['single'], required: true },
        preview: { type: 'boolean', const: true, required: true },
        title: { type: 'string' },
        cwd: { type: 'string' },
        createdAt: { type: 'integer' },
        turns: { type: 'integer', required: true },
        messages: { type: 'integer', required: true },
        toolCalls: { type: 'integer', required: true },
        skipped: { type: 'integer', required: true },
        skipReason: { type: 'string' },
      },
    },
    // 目录（批量）dry-run 预览（REQ-17）：同 total/results 骨架，无写入态计数
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['batch'], required: true },
        preview: { type: 'boolean', const: true, required: true },
        total: { type: 'integer', required: true },
        results: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              title: { type: 'string' },
              cwd: { type: 'string' },
              createdAt: { type: 'integer' },
              turns: { type: 'integer' },
              messages: { type: 'integer' },
              toolCalls: { type: 'integer' },
              skipped: { type: 'integer' },
              skipReason: { type: 'string' },
              status: { type: 'string', enum: ['failed'] },
              error: { type: 'string' },
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
        sessionId: { type: 'string', required: true },
        turns: { type: 'integer', required: true },
        messages: { type: 'integer', required: true },
        toolCalls: { type: 'integer', required: true },
        skipped: { type: 'integer' },
        skippedLines: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              line: { type: 'integer', required: true },
              error: { type: 'string', required: true },
            },
          },
        },
        secrets: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              line: { type: 'integer', required: true },
              kind: { type: 'string', required: true },
            },
          },
        },
        permissionCount: { type: 'integer' },
        skipReason: { type: 'string' },
        alreadyImported: { type: 'boolean', required: true },
        status: { type: 'string', required: true, enum: ['imported', 'already-imported', 'appended', 'skipped'] },
        // REQ-22：Reasonix WAL 合并 / Claude compacted 摘要导入报告
        walMerged: { type: 'boolean' },
        walRecords: { type: 'integer' },
        compacted: { type: 'boolean' },
        appendedTurns: { type: 'integer' },
        appendedEvents: { type: 'integer' },
        appendedSkipped: { type: 'string' },
        sourceShrunk: { type: 'boolean' },
        changedInPlace: { type: 'boolean' },
        argsChanged: { type: 'boolean' },
        budgetChanged: { type: 'boolean' },
        backfilled: { type: 'boolean' },
        droppedBoundaryResults: { type: 'integer' },
        trimmed: {
          type: 'object',
          additionalProperties: false,
          properties: {
            budget: { type: 'integer', required: true },
            source: { type: 'string', enum: ['param', 'env', 'dynamic', 'default'], required: true },
            originalTokens: { type: 'integer', required: true },
            estimatedTokens: { type: 'integer', required: true },
            croppedBlocks: { type: 'integer', required: true },
            droppedTurns: { type: 'integer', required: true },
            droppedMessages: { type: 'integer', required: true },
            droppedToolCalls: { type: 'integer', required: true },
            droppedToolResults: { type: 'integer', required: true },
            droppedOversized: { type: 'integer', required: true },
            summaryInserted: { type: 'boolean', required: true },
          },
        },
        forceImported: {
          type: 'object',
          additionalProperties: false,
          properties: {
            previous: { type: 'string', required: true },
            current: { type: 'string', required: true },
          },
        },
        // issue #22：宿主内存残留幽灵会话（retract 后工件已删）时重导自动另铸
        // 后缀新 id，previous = 幽灵原 id、current = 新落盘 id
        staleGhost: {
          type: 'object',
          additionalProperties: false,
          properties: {
            previous: { type: 'string', required: true },
            current: { type: 'string', required: true },
          },
        },
        validation: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            problems: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true },
                  seq: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
                  message: { type: 'string', required: true },
                },
              },
            },
          },
        },
      },
    },
    // 目录（批量）模式
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['batch'], required: true },
        total: { type: 'integer', required: true },
        imported: { type: 'integer', required: true },
        alreadyImported: { type: 'integer', required: true },
        appended: { type: 'integer', required: true },
        skipped: { type: 'integer', required: true },
        failed: { type: 'integer', required: true },
        missingFromSource: { type: 'array', items: { type: 'string' } },
        results: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              status: {
                type: 'string',
                required: true,
                enum: ['imported', 'already-imported', 'appended', 'skipped', 'failed'],
              },
              sessionId: { type: 'string' },
              turns: { type: 'integer' },
              messages: { type: 'integer' },
              toolCalls: { type: 'integer' },
              skipped: { type: 'integer' },
              skippedLines: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    line: { type: 'integer', required: true },
                    error: { type: 'string', required: true },
                  },
                },
              },
              secrets: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    line: { type: 'integer', required: true },
                    kind: { type: 'string', required: true },
                  },
                },
              },
              permissionCount: { type: 'integer' },
              alreadyImported: { type: 'boolean' },
              reason: { type: 'string' },
              error: { type: 'string' },
              // REQ-22：Reasonix WAL 合并 / Claude compacted 摘要导入报告
              walMerged: { type: 'boolean' },
              walRecords: { type: 'integer' },
              compacted: { type: 'boolean' },
              appendedTurns: { type: 'integer' },
              appendedEvents: { type: 'integer' },
              appendedSkipped: { type: 'string' },
              sourceShrunk: { type: 'boolean' },
              changedInPlace: { type: 'boolean' },
              argsChanged: { type: 'boolean' },
              budgetChanged: { type: 'boolean' },
              backfilled: { type: 'boolean' },
              droppedBoundaryResults: { type: 'integer' },
              trimmed: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  budget: { type: 'integer', required: true },
                  source: { type: 'string', enum: ['param', 'env', 'dynamic', 'default'], required: true },
                  originalTokens: { type: 'integer', required: true },
                  estimatedTokens: { type: 'integer', required: true },
                  croppedBlocks: { type: 'integer', required: true },
                  droppedTurns: { type: 'integer', required: true },
                  droppedMessages: { type: 'integer', required: true },
                  droppedToolCalls: { type: 'integer', required: true },
                  droppedToolResults: { type: 'integer', required: true },
                  droppedOversized: { type: 'integer', required: true },
                  summaryInserted: { type: 'boolean', required: true },
                },
              },
              forceImported: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  previous: { type: 'string', required: true },
                  current: { type: 'string', required: true },
                },
              },
              // issue #22：同单文件模式，staleGhost 标注幽灵避让
              staleGhost: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  previous: { type: 'string', required: true },
                  current: { type: 'string', required: true },
                },
              },
              validation: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ok: { type: 'boolean', required: true },
                  problems: {
                    type: 'array',
                    required: true,
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        kind: { type: 'string', required: true },
                        seq: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
                        message: { type: 'string', required: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  ],
}