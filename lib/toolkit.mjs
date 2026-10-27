// lib/toolkit.mjs — import_chat 分发器：全部聊天导入来源收敛为单一工具 + 共用的导入分发核心
//
// 来源 spec 表在 lib/tools/import-sources.mjs（字段契约见该文件头），makeImportChatTool 把它
// 登记进 IMPORT_SPECS 并收敛成一个 import_chat 工具（format 枚举选来源，共用一份参数表——
// 按来源各注册一个工具会让常驻 schema 成倍膨胀）。输出 schema 在 lib/tools/schema.mjs，
// 结果文案在 lib/tools/import-render.mjs（工具 render 与 /import 命令共用）。
//
// 描述瘦身契约（工具上下文）：schema 是每轮都要付的常驻成本，只留「调用必需」——枚举、
// 必填项、一行参数说明；29 个来源的 path 形状表、参数长文与重导细则搬进 docs/IMPORT-GUIDE.md，
// 由运行时 skill dsh-chat-import-usage 按需加载（注册见 lib/skill.mjs，成本护栏见
// test/tools-injection.test.mjs）。行为细节（batch 形态、回退、lineage 收缩）不进 schema，
// 由执行结果与错误文本按需携带。
//
// runImportSpec 是三个入口共用的唯一分发实现：import_chat 工具（buildImportExecutor）、
// 面板 POST /api-import/import 与 /import 命令（importDiscoveryItem）。三者只在「参数从哪来」
// 上不同（工具 = 模型给的全量参数 + 预算链 + 设置偏好；面板 / 命令 = 发现条目 + 调用方已
// 解析的预算），分发树（目录 / 单会话目录 / 一库多会话文件 / 单文件）只有这一份。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveImportBudget } from './budget.mjs'
import { readImportPrefs } from './import-prefs.mjs'
import { USAGE_SKILL_NAME } from './skill.mjs'
import { IMPORT_OUTPUT_SCHEMA } from './tools/schema.mjs'
import { renderImportResult } from './tools/import-render.mjs'
import {
  importTranscript, importDirectory, previewTranscript, previewDirectory, isPreview, DESTINATION_FINGERPRINT_KEYS,
} from './import-core.mjs'

// format → spec：makeImportChatTool 注册 import_chat 时登记（含 local-jsonl），与工具是否
// 注入无关——面板 / 命令在工具隐藏（injectTools: 'off'）时照常经它导入。
export const IMPORT_SPECS = new Map()

// 重导语义的一句话版（docs/architecture.md D13）：源未变跳过、源增长续写新轮次、force:true
// 另存完整副本。
const descriptionSuffix = ' Re-import: unchanged source skipped, grown source appends new turns; force:true saves a full copy.'

// 来源表：单一事实源。format 枚举、命令面别名、docs/IMPORT-GUIDE.md 的表格都由它派生
//（指南表格与它的对账在 test/import-guide.test.mjs，手抄漂移会被门禁拦住）。
export const CHAT_FORMATS = [
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
  ['omp', 'oh-my-pi session JSONL (~/.omp/agent/sessions)'],
  ['kimi', 'Kimi CLI / Kimi Code session directory (wire.jsonl + state.json)'],
  ['qoder', 'Qoder CLI session JSONL (~/.qoder/projects / ~/.qoder-cn/projects)'],
  ['workbuddy', 'WorkBuddy session JSONL (~/.workbuddy/projects)'],
  ['qwen', 'Qwen Work CN (千问办公) session JSONL (~/.qwenworkcn/projects)'],
  ['trae', 'Trae Work state.vscdb (Trae/User/workspaceStorage or globalStorage)'],
  ['doubao', 'Doubao Desktop chat IndexedDB (<User Data>/<profile>/IndexedDB/chrome_doubao-chat_0.indexeddb.leveldb)'],
  ['vibe', 'Mistral Vibe CLI session directory (~/.vibe/logs/session)'],
  ['continue', 'Continue session JSON (~/.continue/sessions)'],
  ['copilot-vscode', 'GitHub Copilot VS Code session JSON (<User>/workspaceStorage/<hash>/chatSessions)'],
  ['copilot-cli', 'GitHub Copilot CLI session events.jsonl (~/.copilot/session-state/<id>)'],
  ['cline', 'Cline session messages.json (~/.cline/data/sessions)'],
  ['goose', 'Goose session db sessions.db (~/.local/share/goose/sessions)'],
  ['zed', 'Zed agent thread db threads.db (<data_dir>/threads)'],
  ['crush', 'Crush session db crush.db (<project>/.crush)'],
  ['dsh', 'DSH V0-V3 session logs session[.vN].jsonl[.zstd] ($DSH_HOME/sessions)'],
  ['dsh4', 'DSH V4+ session logs session.v4.jsonl[.zstd] ($DSH_HOME/sessions)'],
  ['local-jsonl', 'Any local session file/dir — .jsonl/.jsonl.zstd/.json/.dshbundle.json; three-level auto-detect, parseFormat forces a parser'],
]

// 专属参数的处理集（local-jsonl 的强制解析器枚举与 index.d.ts LocalJsonlFormat 一致）
const PARSE_FORMATS = ['dsh', 'claude', 'codex', 'cursor', 'reasonix', 'pi', 'openclaw', 'hermes', 'qoder', 'vibe', 'generic', 'copilot-vscode', 'copilot-cli']

// 全部来源共享一份公共参数表；单会话参数（sessionId / recursive）由一库多会话来源自然忽略。
//
// 描述瘦身规则（常驻成本）：参数**一律声明**（模型不知道存在的旋钮等于不存在），但只有
// 「不加载指南也判断得了、且给错会改变结果」的参数留一行说明；其余只声明，语义在
// docs/IMPORT-GUIDE.md（skill dsh-chat-import-usage），调用前加载一次即可。
const COMMON_PARAMS = {
  path: {
    type: 'string',
    required: true,
    description: 'Source transcript / database / session directory path (shape per format; see the usage skill).',
  },
  force: {
    type: 'boolean',
    description: 'Optional: force-import as a fresh copy (import-<src>-<n>) even if already imported.',
  },
  budget: {
    type: 'integer',
    description: 'Optional: context budget in tokens for the three-layer crop (default 550k; param > env > model window).',
  },
  storeImages: {
    type: 'boolean',
  },
  preview: {
    type: 'boolean',
    description: 'Optional: true dry-runs — zero writes, returns only the would-import list.',
  },
  dryRun: {
    type: 'boolean',
  },
  sessionId: {
    type: 'string',
  },
  recursive: {
    type: 'boolean',
  },
  expectedHash: {
    type: 'string',
  },
  restamp: {
    type: 'boolean',
  },
  workspaceMode: {
    type: 'string',
    enum: ['auto', 'dedicated', 'per-project'],
  },
  workspaceDir: {
    type: 'string',
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
  },
}

// 来源专属参数（仅对应 format 消费，其余 format 忽略）。同样只声明；适用来源与语义见指南
//（sessionIds / fullHistory 的适用名单由 spec 派生，见 makeImportChatTool）。
const EXTRA_PARAMS = {
  compacted: {
    type: 'boolean',
  },
  branch: {
    type: 'string',
    enum: ['main', 'all'],
  },
  // 适用来源由 spec 的 multiSession 派生（见 makeImportChatTool）
  sessionIds: {
    type: 'array',
    items: { type: 'string' },
  },
  // 适用来源由 spec 的 fullHistory 派生（见 makeImportChatTool）：文案里的名单不能手写，
  // 否则「声明支持的来源」与「真的会因它改变产物的来源」必然漂移。
  fullHistory: {
    type: 'boolean',
    description: 'Optional (compaction-aware sources): true imports the full history without native compaction checkpoints; default false respects compaction.',
  },
  includeToolUseResult: {
    type: 'boolean',
  },
  lineage: {
    type: 'string',
    enum: ['tail'],
  },
  lineageMode: {
    type: 'string',
    enum: ['canonical', 'physical'],
  },
  parseFormat: {
    type: 'string',
    enum: PARSE_FORMATS,
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
    // 汇聚点：来源 spec 的指纹键 + 与来源无关的投放参数（只在显式给出时进指纹）
    fingerprintKeys: [...(registry.fingerprintKeys || []), ...DESTINATION_FINGERPRINT_KEYS],
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
export async function importDiscoveryItem(ctx, format, sourcePath, sessionIds, { force, replace, budget, budgetSource, storeImages, workspaceMode, workspaceDir, restamp } = {}) {
  const spec = IMPORT_SPECS.get(format)
  if (!spec) throw new Error('未知格式: ' + format)
  const args = { path: sourcePath, force: force === true, replace: replace === true, budget, budgetSource, importSystemPrompt: readImportPrefs(ctx).importSystemPrompt === true }
  if (storeImages !== undefined) args.storeImages = storeImages
  // drop onto a sidebar workspace: dedicated mode pinned to that workspace's path
  if (workspaceMode) args.workspaceMode = workspaceMode
  if (workspaceDir) args.workspaceDir = workspaceDir
  if (restamp === true || restamp === 'end') args.restamp = restamp
  if (spec.multiSession && Array.isArray(sessionIds) && sessionIds.length > 0) args.sessionIds = [...new Set(sessionIds)]
  return runImportSpec(ctx, spec, args)
}

/**
 * Panel preview of one discovered item: the import dry-run (zero side effects) plus a message
 * sample. Multi-session sources preview only the requested session.
 */
export async function previewDiscoveryItem(ctx, format, sourcePath, sessionId, { sample } = {}) {
  const spec = IMPORT_SPECS.get(format)
  if (!spec) throw new Error('未知格式: ' + format)
  const args = { path: sourcePath, preview: true, previewSample: sample, importSystemPrompt: false }
  if (spec.multiSession && typeof sessionId === 'string' && sessionId) args.sessionIds = [sessionId]
  return runImportSpec(ctx, spec, args, { preview: true })
}

/** True when one source file holds many sessions (deleting the file would delete them all). */
export function isMultiSessionFormat(format) {
  const spec = IMPORT_SPECS.get(format)
  return !!(spec && spec.multiSession)
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
      'format required (enum = source id). Single file/db → one session, ' +
      'directory → batch. Returns new session id(s) or batch stats. ' +
      'Load the ' + USAGE_SKILL_NAME + ' skill for the per-format path table and parameter details.' +
      descriptionSuffix,
    parameters: {
      format: {
        type: 'string',
        required: true,
        enum: CHAT_FORMATS.map(([f]) => f),
        description: 'Source format (required); see the ' + USAGE_SKILL_NAME + ' skill for each format\'s path shape.',
      },
      ...COMMON_PARAMS,
      ...EXTRA_PARAMS,
      sessionIds: {
        ...EXTRA_PARAMS.sessionIds,
        description: 'Optional (' + specs.filter((s) => s.multiSession).map((s) => s.format).join('/') + ' only): import only these source session ids.',
      },
      fullHistory: {
        ...EXTRA_PARAMS.fullHistory,
        description: 'Optional (' + specs.filter((s) => s.fullHistory === true).map((s) => s.format).join('/')
          + ' only): true imports the full history without native compaction checkpoints; default false respects compaction.',
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
