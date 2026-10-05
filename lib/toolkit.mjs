// lib/toolkit.mjs — import_chat 分发器：全部聊天导入来源收敛为单一工具 + 共用的导入分发核心
//
// 来源 spec 表在 lib/tools/import-sources.mjs（字段契约见该文件头），makeImportChatTool 把它
// 登记进 IMPORT_SPECS 并收敛成一个 import_chat 工具（format 枚举选来源，共用一份参数表——
// 按来源各注册一个工具会让常驻 schema 成倍膨胀）。输出 schema 在 lib/tools/schema.mjs，
// 结果文案在 lib/tools/import-render.mjs（工具 render 与 /import 命令共用）。
//
// runImportSpec 是三个入口共用的唯一分发实现：import_chat 工具（buildImportExecutor）、
// 面板 POST /api-import/import 与 /import 命令（importDiscoveryItem）。三者只在「参数从哪来」
// 上不同（工具 = 模型给的全量参数 + 预算链 + 设置偏好；面板 / 命令 = 发现条目 + 调用方已
// 解析的预算），分发树（目录 / 单会话目录 / 一库多会话文件 / 单文件）只有这一份。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveImportBudget } from './budget.mjs'
import { readImportPrefs } from './import-prefs.mjs'
import { IMPORT_OUTPUT_SCHEMA } from './tools/schema.mjs'
import { renderImportResult } from './tools/import-render.mjs'
import {
  importTranscript, importDirectory, previewTranscript, previewDirectory, isPreview,
} from './import-core.mjs'

// format → spec：makeImportChatTool 注册 import_chat 时登记（含 local-jsonl），与工具是否
// 注入无关——面板 / 命令在工具隐藏（injectTools: 'off'）时照常经它导入。
export const IMPORT_SPECS = new Map()

// 重导语义的一句话版（docs/architecture.md D13）：源未变跳过、源增长续写新轮次、force:true
// 另存完整副本。
const descriptionSuffix = ' Re-import: unchanged source skipped, grown source appends new turns; force:true saves a full copy.'

// 描述瘦身契约（工具上下文）：模型常驻成本优先——枚举只保留「名字 + path 形状」，
// 行为细节（batch 形态、回退、lineage 收缩）不进 schema，由执行结果与错误文本按需携带。
const CHAT_FORMATS = [
  ['claude', 'Claude Code JSONL (~/.claude/projects)'],
  ['codex', 'Codex / ChatGPT CLI rollout JSONL (~/.codex)'],
  ['chatgpt', 'ChatGPT web export conversations.json (one file, all sessions)'],
  ['cursor', 'Cursor agent transcript JSONL (~/.cursor/projects)'],
  ['gemini', 'Gemini CLI session JSON (~/.gemini/history)'],
  ['antigravity', 'Antigravity session transcript (~/.gemini/antigravity / antigravity-cli)'],
  ['reasonix', 'Reasonix session JSONL (~/.reasonix/sessions)'],
  ['opencode', 'opencode db opencode.db — V1 or V2 schema (~/.local/share/opencode)'],
  ['mimocode', 'mimocode db mimocode.db (~/.local/share/mimocode)'],
  ['kilocode', 'Kilo Code db kilo.db (~/.local/share/kilo)'],
  ['teleagent', 'TeleAgent db teleagent.db (TeleAgent/users/<account>)'],
  ['zcode', 'z.ai zcode db.sqlite (~/.zcode/cli/db) or zcode://<sessionId>'],
  ['grokbuild', 'Grok Build session directory (summary.json + chat_history.jsonl)'],
  ['openclaw', 'OpenClaw session JSONL (~/.openclaw/agents)'],
  ['hermes', 'Hermes db state.db (~/.hermes)'],
  ['pi', 'Pi session JSONL (~/.pi/agent/sessions)'],
  ['kimi', 'Kimi CLI / Kimi Code session directory (wire.jsonl + state.json)'],
  ['qoder', 'Qoder CLI session JSONL (~/.qoder/projects)'],
  ['workbuddy', 'WorkBuddy session JSONL (~/.workbuddy/projects)'],
  ['qwen', 'Qwen Work CN (千问办公) session JSONL (~/.qwenworkcn/projects)'],
  ['trae', 'Trae Work state.vscdb (Trae/User/workspaceStorage or globalStorage)'],
  ['vibe', 'Mistral Vibe CLI session directory (~/.vibe/logs/session)'],
  ['continue', 'Continue session JSON (~/.continue/sessions)'],
  ['cline', 'Cline session messages.json (~/.cline/data/sessions)'],
  ['goose', 'Goose session db sessions.db (~/.local/share/goose/sessions)'],
  ['zed', 'Zed agent thread db threads.db (<data_dir>/threads)'],
  ['crush', 'Crush session db crush.db (<project>/.crush)'],
  ['dsh', 'DSH V0-V3 session logs session[.vN].jsonl[.zstd] ($DSH_HOME/sessions)'],
  ['dsh4', 'DSH V4+ session logs session.v4.jsonl[.zstd] ($DSH_HOME/sessions)'],
  ['local-jsonl', 'Any local session file/dir — .jsonl/.jsonl.zstd/.json/.dshbundle.json; three-level auto-detect, parseFormat forces a parser'],
]

// 专属参数的处理集（local-jsonl 的强制解析器枚举与 index.d.ts LocalJsonlFormat 一致）
const PARSE_FORMATS = ['dsh', 'claude', 'codex', 'cursor', 'reasonix', 'pi', 'openclaw', 'hermes', 'qoder', 'vibe', 'generic']

// 全部来源共享一份公共参数表；单会话参数（sessionId / recursive）由一库多会话来源自然忽略。
const COMMON_PARAMS = {
  path: {
    type: 'string',
    required: true,
    description: 'Source transcript / database / session directory path (shape per format enum).',
  },
  force: {
    type: 'boolean',
    description: 'Optional: force-import as a fresh copy (import-<src>-<n>) even if already imported.',
  },
  budget: {
    type: 'integer',
    description: 'Optional: context budget in tokens for the three-layer crop; default 550k (param > env DSH_IMPORT_CONTEXT_BUDGET > model window).',
  },
  storeImages: {
    type: 'boolean',
    description: 'Optional: default true — images in the source become host attachments (ctx.attachments) so they survive in DSH. Set false to keep [image] text placeholders only (env DSH_IMPORT_STORE_IMAGES=0 does the same).',
  },
  preview: {
    type: 'boolean',
    description: 'Optional: true dry-runs — zero writes, returns only the would-import list.',
  },
  dryRun: {
    type: 'boolean',
    description: 'Optional: alias of preview.',
  },
  sessionId: {
    type: 'string',
    description: 'Optional: target DSH session id (single-file imports only; default import-<source id>).',
  },
  recursive: {
    type: 'boolean',
    description: 'Optional: recurse into subdirectories in directory mode (default true).',
  },
  expectedHash: {
    type: 'string',
    description: 'Optional: expected SHA-256 (lowercase hex); mismatch fails loudly, nothing written.',
  },
  restamp: {
    type: 'boolean',
    description: 'Optional: true shifts imported timestamps to now (relative gaps kept); default keeps source times.',
  },
  workspaceMode: {
    type: 'string',
    enum: ['auto', 'dedicated', 'per-project'],
    description: 'Optional: grouping — auto | per-project | dedicated (all imports into one workspace).',
  },
  workspaceDir: {
    type: 'string',
    description: 'Optional: workspace directory when workspaceMode=dedicated.',
  },
  cwdRemap: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from: { type: 'string', required: true },
        to: { type: 'string', required: true },
      },
    },
    description: 'Optional: rewrite source cwd prefixes for cross-machine migration, e.g. [{from:"D:/work",to:"/home/me/work"}] (longest prefix wins; applies to new imports only — already-imported sources are skipped, use force for a fresh copy).',
  },
}

// 来源专属参数（仅对应 format 消费，其余 format 忽略；描述标注适用格式）。zcode:// 伪路径的
// 会话 id 由 spec.derive 从 path 提取。
const EXTRA_PARAMS = {
  compacted: {
    type: 'boolean',
    description: 'Optional (claude only, legacy alias): importing the compaction summary is the default behavior now (native compaction checkpoints).',
  },
  branch: {
    type: 'string',
    enum: ['main', 'all'],
    description: "Optional (chatgpt only): 'main' (default) main thread only; 'all' one session per branch path.",
  },
  // 适用来源由 spec 的 multiSession 派生（见 makeImportChatTool）
  sessionIds: {
    type: 'array',
    items: { type: 'string' },
  },
  fullHistory: {
    type: 'boolean',
    description: 'Optional (claude/codex/pi/kimi/zed/crush/continue/zcode/cline/opencode and its forks): true imports the full history without native compaction checkpoints; default false respects compaction (the model sees the summary checkpoint plus what follows).',
  },
  includeToolUseResult: {
    type: 'boolean',
    description: 'Optional (claude only): true also imports the structured toolUseResult sidecar (edit diffs via structuredPatch/bashEditDiff, questions/answers, exit codes and other scalar metadata) as text appended to each tool result. Default false; large transcripts grow noticeably, and the flag is part of the argument fingerprint (changing it requires force).',
  },
  lineage: {
    type: 'string',
    enum: ['tail'],
    description: "Optional (hermes only): 'tail' imports only lineage leaf sessions.",
  },
  lineageMode: {
    type: 'string',
    enum: ['canonical', 'physical'],
    description: "Optional (reasonix only): 'canonical' (default) collapses proven recovery ancestors; 'physical' one session per JSONL.",
  },
  parseFormat: {
    type: 'string',
    enum: PARSE_FORMATS,
    description: 'Optional (local-jsonl only): force a parser; default auto-detects (content marker > path hint > parser trial). generic = interchange v1 doc.',
  },
}

// spec → 四个编排函数（缺省 io 的来源回退 import-core 的标准状态机），按 spec 缓存。
const specOps = new WeakMap()
function opsOf(spec) {
  let ops = specOps.get(spec)
  if (ops) return ops
  const { io = {}, derive = {}, registry = {} } = spec
  const deriveArgs = derive.args || (async () => ({}))
  const std = {
    convert: spec.convert,
    readText: spec.readText,
    sourceLabel: spec.sourceLabel,
    importFormat: spec.format,
    registryDir: registry.dir,
    fingerprintKeys: registry.fingerprintKeys || [],
  }
  ops = {
    deriveArgs,
    dirSingle: io.dirSingle,
    // 单文件也恒返回批量形态（一库多会话）/ 按文件判定（hermes：.db 批量、.jsonl 单会话）
    batchFile: io.alwaysBatch ? async () => true : (io.fileBatch || (async () => false)),
    importSingle: io.file
      || ((c, t, a) => importTranscript(c, t, a, std.convert, { registryDir: std.registryDir, fingerprintKeys: std.fingerprintKeys, readText: std.readText, sourceLabel: std.sourceLabel, importFormat: std.importFormat })),
    importBatch: io.dir
      || ((c, d, a) => importDirectory(c, d, a, { ...std, deriveArgs, collect: derive.collect })),
    previewSingle: io.previewFile || ((c, t, a) => previewTranscript(c, t, a, std.convert, { readText: std.readText })),
    previewBatch: io.previewDir
      || ((c, d, a) => previewDirectory(c, d, a, { convert: std.convert, deriveArgs, collect: derive.collect, readText: std.readText })),
  }
  specOps.set(spec, ops)
  return ops
}

/**
 * 按 spec 导入（或零副作用预览）一个路径：stat → 目录（dirSingle 判定为单会话目录则单会话，
 * 否则批量）/ 文件（alwaysBatch / fileBatch 判定一库多会话则批量形态，否则单会话）。
 * args 是最终参数（预算 / 偏好已由调用方解析）；按文件派生的转换参数（derive.args）只在
 * 文件分支合并——目录批量由编排逐文件派生，单会话目录的导入器自行派生（kimi）。
 * @returns {Promise<object>} { mode: 'single'|'batch', preview?: true, ...编排结果 }
 */
export async function runImportSpec(ctx, spec, args, { preview = false } = {}) {
  const ops = opsOf(spec)
  const flag = preview ? { preview: true } : {}
  const target = await ctx.fs.resolve(args.path)
  const info = await ctx.fs.stat(target)
  if (info && info.type === 'directory') {
    if (ops.dirSingle && await ops.dirSingle(ctx, target)) {
      const single = preview ? await ops.previewSingle(ctx, target, args) : await ops.importSingle(ctx, target, args)
      return { mode: 'single', ...flag, ...single }
    }
    const batch = preview ? await ops.previewBatch(ctx, target, args) : await ops.importBatch(ctx, target, args)
    return { mode: 'batch', ...flag, ...batch }
  }
  const fileArgs = { ...args, ...(await ops.deriveArgs(target)) }
  const mode = await ops.batchFile(ctx, target) ? 'batch' : 'single'
  const out = preview ? await ops.previewSingle(ctx, target, fileArgs) : await ops.importSingle(ctx, target, fileArgs)
  return { mode, ...flag, ...out }
}

// import_chat 的执行体：解析上下文预算（参数 > env > 动态模型窗口 > 静态默认，盖写进
// args.budget / budgetSource——转换层裁剪与 registry 记录消费）与导入偏好（「导入系统提示词
// 作为上下文注入」，默认开；设置服务缺席时回退默认），再交给 runImportSpec。
export function buildImportExecutor(ctx, spec) {
  return async (args) => {
    const budgetInfo = await resolveImportBudget(ctx, args)
    const prefs = readImportPrefs(ctx)
    const effective = { ...args, budget: budgetInfo.budget, budgetSource: budgetInfo.source, importSystemPrompt: prefs.importSystemPrompt === true }
    return runImportSpec(ctx, spec, effective, { preview: isPreview(args) })
  }
}

/**
 * 面板 / 命令入口：按发现条目（format + sourcePath，一库多会话来源可带所选 sessionIds）导入。
 * 预算由调用方解析一次（批内共享）；导入系统提示词偏好与工具层同源。
 * @param {object} opts { force, replace, budget, budgetSource, storeImages }——storeImages 缺省
 *   走 import-core 的默认（落图片，除非环境变量关闭）；转投到导不出图片的目标时传 false。
 */
export async function importDiscoveryItem(ctx, format, sourcePath, sessionIds, { force, replace, budget, budgetSource, storeImages } = {}) {
  const spec = IMPORT_SPECS.get(format)
  if (!spec) throw new Error('未知格式: ' + format)
  const args = { path: sourcePath, force: force === true, replace: replace === true, budget, budgetSource, importSystemPrompt: readImportPrefs(ctx).importSystemPrompt === true }
  if (storeImages !== undefined) args.storeImages = storeImages
  if (spec.multiSession && Array.isArray(sessionIds) && sessionIds.length > 0) args.sessionIds = [...new Set(sessionIds)]
  return runImportSpec(ctx, spec, args)
}

// 描述里的格式数由枚举实时推导：新增来源只改 CHAT_FORMATS。local-jsonl 是兜底解析器而非
// 一个来源，不计入。
const CHAT_SOURCE_COUNT = CHAT_FORMATS.length - 1

/** import_chat 接受的全部 format（命令面 / 面板的别名表由此派生，不另行手写）。 */
export const CHAT_FORMAT_NAMES = CHAT_FORMATS.map(([name]) => name)

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
      'Import external chat transcripts into continuable DSH sessions (' + CHAT_SOURCE_COUNT + ' formats). ' +
      'format required (see enum; path shape per format). Single file/db → one session, ' +
      'directory → batch. Returns new session id(s) or batch stats.' + descriptionSuffix,
    parameters: {
      format: {
        type: 'string',
        required: true,
        enum: CHAT_FORMATS.map(([f]) => f),
        description: 'Source format (required): ' + CHAT_FORMATS.map(([f, d]) => f + '=' + d).join('; '),
      },
      ...COMMON_PARAMS,
      ...EXTRA_PARAMS,
      sessionIds: {
        ...EXTRA_PARAMS.sessionIds,
        description: 'Optional (' + specs.filter((s) => s.multiSession).map((s) => s.format).join('/') + ' only): import only these source session ids.',
      },
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
