// lib/tools/import-sources.mjs — import_chat 的来源 spec 表
//
// buildImportSources(ctx, registryDir) 产出全部来源 spec，由 lib/toolkit.mjs 的
// makeImportChatTool 收敛为单一 import_chat 分发器并登记进 IMPORT_SPECS（面板 / 命令
// 复用同一 spec）。spec 字段契约：
//   format / sourceLabel   来源短名（= import_chat 的 format 枚举值）与人类可读标签
//   convert / readText     纯函数转换器；readText 覆盖默认 ctx.fs.readText（DSH 的 zstd）
//   io                     自带编排的来源：file / dir（导入）、previewFile / previewDir（预览）、
//                          alwaysBatch（单文件也恒批量，一库多会话）/ fileBatch（按文件判定批量）/
//                          dirSingle（目录本身是一个会话；单会话导入器自行派生参数）
//   derive                 args（按文件派生转换参数，可 async）/ collect（目录批量的选材）
//   registry               dir + fingerprintKeys（改变转换产物的参数，换值须重导）
//   label                  批量结果文案的单位与跳过原因（缺省「文件」）
//   multiSession           一库多会话且导入器按 args.sessionIds 过滤：面板 / 命令多选时只导所选，
//                          import_chat 的 sessionIds 参数描述也由它派生
// 缺省 io 的来源走 lib/import-core.mjs 的标准状态机（importTranscript / importDirectory）。
// 特殊形态来源（chatgpt / grokbuild / hermes / kimi）的编排在 lib/import-variants.mjs；
// 库类来源的编排与预览在 lib/sources/<src>.mjs；文件型来源的旁读派生在 ./source-derive.mjs。

import { join } from 'node:path'
import {
  convertClaudeJsonl, convertChatgptJson, convertCursorJsonl,
  convertGeminiJson, convertReasonixJsonl, convertPiJsonl, convertOpencodeJson,
  convertAntigravityJsonl,
  convertMimocodeJson, convertKilocodeJson, convertZcodeJson, convertGrokbuildJson, convertOpenclawJson,
  convertTeleagentJson,
  convertHermesJson, convertKimiWire, convertQoderJsonl, convertWorkbuddyJsonl, convertQwenJsonl, convertDshJsonl, convertLocalJsonl,
  convertContinueJson, convertClineJson, convertGooseJson, convertZedJson, convertCrushJson, convertTraeJson, convertVibeJson,
} from '../convert/index.mjs'
import { importVibeFile, importVibeDirectory, previewVibeFile, previewVibeDirectory, vibeIsSessionDir } from '../sources/vibe.mjs'
import { importGooseFile, importGooseDirectory, previewGooseFile, previewGooseDirectory } from '../sources/goose.mjs'
import { importZedFile, importZedDirectory, previewZedFile, previewZedDirectory } from '../sources/zed.mjs'
import { importCodexFile, importCodexDirectory, previewCodexFile, previewCodexDirectory } from '../sources/codex.mjs'
import { importCrushFile, importCrushDirectory, crushDeriveArgs, previewCrushFile, previewCrushDirectory } from '../sources/crush.mjs'
import { importOpencodeFile, importOpencodeDirectory, previewOpencodeFile, previewOpencodeDirectory } from '../sources/opencode.mjs'
import { importMimocodeFile, importMimocodeDirectory, previewMimocodeFile, previewMimocodeDirectory } from '../sources/mimocode.mjs'
import { importTeleagentFile, importTeleagentDirectory, previewTeleagentFile, previewTeleagentDirectory } from '../sources/teleagent.mjs'
import { importKilocodeFile, importKilocodeDirectory, previewKilocodeFile, previewKilocodeDirectory } from '../sources/kilocode.mjs'
import { importZcodeFile, importZcodeDirectory, previewZcodeFile, previewZcodeDirectory } from '../sources/zcode.mjs'
import { importTraeFile, importTraeDirectory, previewTraeFile, previewTraeDirectory } from '../sources/trae.mjs'
import { clineDeriveArgs, collectClineFiles } from '../sources/cline.mjs'
import { readDshText, collectDshFiles } from '../sources/dsh.mjs'
import { markTrimmedSource } from '../budget.mjs'
import { runDecision, collectJsonFiles } from '../import-core.mjs'
import {
  importChatgptFile, importChatgptDirectory,
  importGrokbuildSession, importGrokbuildDirectory,
  importHermesFile, importHermesDirectory, hermesFileArgs,
  importKimiFile, importKimiDirectory, kimiDeriveArgs, kimiIsSessionDir,
  previewChatgptFile, previewChatgptDirectory,
  previewGrokbuildSession, previewGrokbuildDirectory,
  previewHermesFile, previewHermesDirectory,
  previewKimiFile, previewKimiDirectory,
} from '../import-variants.mjs'
import {
  targetPath, fileStem, cursorDeriveArgs, antigravityDeriveArgs, collectAntigravityTranscripts,
  collectReasonixFiles, reasonixDeriveArgs, openclawDeriveArgs, continueDeriveArgs,
} from './source-derive.mjs'

// 压缩感知来源的参数指纹键：fullHistory 改变转换产物（写不写原生压缩检查点 / 是否
// 尊重上下文压缩），换值须重导。
const FULL_HISTORY_KEYS = Object.freeze(['fullHistory'])

// 一库多会话来源的批量文案：结果按「会话」计，零回合会话按「无用户回合」跳过。
const SESSION_LABEL = Object.freeze({ batch: '会话', skipped: '无用户回合' })

// 自带 host 面编排的来源的 io 四件套：[导入单文件, 导入目录, 预览单文件, 预览目录]；
// opts 是透传给导入编排的 host 依赖（registryDir / runDecision / markTrimmedSource /
// fingerprintKeys），预览零副作用、不需要它。
function sourceIo([importFile, importDir, previewFile, previewDir], opts, extra = {}) {
  return {
    file: (c, t, a) => importFile(c, t, a, opts),
    dir: (c, d, a) => importDir(c, d, a, opts),
    previewFile,
    previewDir,
    ...extra,
  }
}

export function buildImportSources(ctx, registryDir) {
  const registry = Object.freeze({ dir: registryDir })
  const fullHistoryRegistry = Object.freeze({ dir: registryDir, fingerprintKeys: FULL_HISTORY_KEYS })
  // host 面编排的公共依赖：库类来源自己落盘（runDecision）、自己标注裁剪来源
  const hostOpts = Object.freeze({ registryDir, runDecision, markTrimmedSource })
  const fullHistoryOpts = Object.freeze({ ...hostOpts, fingerprintKeys: FULL_HISTORY_KEYS })
  // 文件名 stem 作源 id 的派生：{ [key]: stem }
  const stemArgs = (key) => (target) => ({ [key]: fileStem(targetPath(ctx, target)) })

  return [
    // claude：文件名 stem 传给转换器做「主 transcript」判定（subagent/workflow 辅助
    // transcript 记录携带父 sessionId，按它建会话会与主 transcript 撞 id 导致主内容被
    // 跳过）。cwd 权威映射在转换层（无 cwd 记录时输出 cwdHint slug，importTranscript
    // 消费 resolveClaudeCwd）。includeToolUseResult 改变转换产物（要不要并入
    // toolUseResult sidecar），与 fullHistory 同入指纹。
    {
      format: 'claude',
      sourceLabel: 'Claude Code',
      convert: convertClaudeJsonl,
      registry: { dir: registryDir, fingerprintKeys: [...FULL_HISTORY_KEYS, 'includeToolUseResult'] },
      derive: { args: stemArgs('fileStem') },
    },
    // codex：rollout 文件（新版会把一个会话拆成多个分页文件）——任意一页都解析整链一次
    // 导入（幂等键 = 链首页路径），目录模式按 thread 分组批量。
    {
      format: 'codex',
      sourceLabel: 'Codex/ChatGPT',
      io: sourceIo([importCodexFile, importCodexDirectory, previewCodexFile, previewCodexDirectory], fullHistoryOpts),
      registry: fullHistoryRegistry,
    },
    // chatgpt：conversations.json 恒批量（目录模式扫描 .json）
    {
      format: 'chatgpt',
      sourceLabel: 'ChatGPT',
      convert: convertChatgptJson,
      io: {
        file: (c, t, a) => importChatgptFile(c, t, a, { registryDir }),
        dir: (c, d, a) => importChatgptDirectory(c, d, a, { registryDir }),
        previewFile: previewChatgptFile,
        previewDir: previewChatgptDirectory,
        alwaysBatch: true,
      },
      registry,
    },
    {
      format: 'cursor',
      sourceLabel: 'Cursor',
      convert: convertCursorJsonl,
      registry,
      derive: { args: (target) => cursorDeriveArgs(ctx, target) },
    },
    // gemini：单会话 .json（非 JSONL），目录收集走 collectJsonFiles
    { format: 'gemini', sourceLabel: 'Gemini CLI', convert: convertGeminiJson, derive: { collect: collectJsonFiles }, registry },
    // antigravity：导入输入是 brain/<id>/.system_generated/logs/transcript.jsonl；标题与
    // 异步任务回执在同级目录，由 derive.args 旁读（见 ./source-derive.mjs）。
    {
      format: 'antigravity',
      sourceLabel: 'Antigravity',
      convert: convertAntigravityJsonl,
      registry,
      derive: {
        collect: collectAntigravityTranscripts,
        args: (target) => antigravityDeriveArgs(ctx, target),
      },
    },
    // reasonix：stem 作源 id；sidecar meta / 桌面版 .titles.json / WAL 旁读见 ./source-derive.mjs
    {
      format: 'reasonix',
      sourceLabel: 'Reasonix',
      convert: convertReasonixJsonl,
      registry,
      derive: {
        collect: collectReasonixFiles,
        args: (target) => reasonixDeriveArgs(ctx, target),
      },
    },
    // opencode：一库多会话（单 .db 文件也恒批量）；目录模式自动定位 opencode.db
    {
      format: 'opencode',
      sourceLabel: 'opencode',
      convert: convertOpencodeJson,
      io: sourceIo([importOpencodeFile, importOpencodeDirectory, previewOpencodeFile, previewOpencodeDirectory], hostOpts, { alwaysBatch: true }),
      registry,
      label: SESSION_LABEL,
      multiSession: true,
    },
    // opencode 的三个 fork（SQLite 三表 schema 同构 / 超集），读取 / 导入 / 预览复用
    // opencode 管线，各自差异（库文件名、provider 标签、会话过滤）收在
    // lib/sources/<src>.mjs 与 lib/convert/<src>.mjs：
    //   mimocode  —— mimocode.db，session 表无 model 列，过滤后台任务会话；
    //   kilocode  —— ~/.local/share/kilo/kilo.db，跳过子会话 / 归档会话；
    //   teleagent —— TeleAgent/users/<账户>/teleagent.db（多账户目录，目录模式无递归）。
    {
      format: 'mimocode',
      sourceLabel: 'mimocode',
      convert: convertMimocodeJson,
      io: sourceIo([importMimocodeFile, importMimocodeDirectory, previewMimocodeFile, previewMimocodeDirectory], hostOpts, { alwaysBatch: true }),
      registry,
      label: SESSION_LABEL,
      multiSession: true,
    },
    {
      format: 'kilocode',
      sourceLabel: 'Kilo Code',
      convert: convertKilocodeJson,
      io: sourceIo([importKilocodeFile, importKilocodeDirectory, previewKilocodeFile, previewKilocodeDirectory], hostOpts, { alwaysBatch: true }),
      registry,
      label: SESSION_LABEL,
      multiSession: true,
    },
    {
      format: 'teleagent',
      sourceLabel: 'TeleAgent',
      convert: convertTeleagentJson,
      io: sourceIo([importTeleagentFile, importTeleagentDirectory, previewTeleagentFile, previewTeleagentDirectory], hostOpts, { alwaysBatch: true }),
      registry,
      label: SESSION_LABEL,
      multiSession: true,
    },
    // Trae Work：VS Code 风格 state.vscdb（ItemTable）一库多会话；目录模式覆盖
    // Trae User 根、workspaceStorage/globalStorage 以及单个 workspace 数据库。
    {
      format: 'trae',
      sourceLabel: 'Trae Work',
      convert: convertTraeJson,
      io: sourceIo([importTraeFile, importTraeDirectory, previewTraeFile, previewTraeDirectory], hostOpts, { alwaysBatch: true }),
      registry,
      label: SESSION_LABEL,
    },
    // Mistral Vibe CLI：~/.vibe/logs/session/<session_dir>/（messages.jsonl + meta.json）；
    // 会话目录本身是一个会话（dirSingle）
    {
      format: 'vibe',
      sourceLabel: 'Mistral Vibe',
      convert: convertVibeJson,
      io: sourceIo([importVibeFile, importVibeDirectory, previewVibeFile, previewVibeDirectory], fullHistoryOpts, { dirSingle: vibeIsSessionDir }),
      registry: fullHistoryRegistry,
      label: SESSION_LABEL,
    },
    // zcode：z.ai 官方 CLI 会话库 ~/.zcode/cli/db/db.sqlite（SQLite 权威索引）+ 旧版
    // transcript.jsonl 回退。一库多会话恒批量；目录模式自动定位 db.sqlite（无递归）；
    // zcode://<id> 伪路径走默认库只导该会话（derive 从 path 提取 zcodeId，
    // importZcodeFile 还会从原始 args.path 兜底再取一次）。
    {
      format: 'zcode',
      sourceLabel: 'zcode',
      convert: convertZcodeJson,
      io: sourceIo([importZcodeFile, importZcodeDirectory, previewZcodeFile, previewZcodeDirectory], fullHistoryOpts, { alwaysBatch: true }),
      registry: fullHistoryRegistry,
      derive: {
        args: (target) => {
          const p = targetPath(ctx, target)
          return typeof p === 'string' && p.startsWith('zcode://') ? { zcodeId: p.slice('zcode://'.length) } : {}
        },
      },
      label: SESSION_LABEL,
      multiSession: true,
    },
    // grokbuild：会话目录（含 summary.json + chat_history.jsonl）→ 单会话；
    // sessions/archived_sessions 根（递归扫 summary.json）→ 批量。
    {
      format: 'grokbuild',
      sourceLabel: 'Grok Build',
      convert: convertGrokbuildJson,
      io: {
        file: (c, t, a) => importGrokbuildSession(c, t, a, { registryDir }),
        dir: (c, d, a) => importGrokbuildDirectory(c, d, a, { registryDir }),
        previewFile: previewGrokbuildSession,
        previewDir: previewGrokbuildDirectory,
        dirSingle: async (c, target) => {
          const sumStat = await c.fs.stat(await c.fs.resolve(join(targetPath(c, target), 'summary.json')))
          return !!(sumStat && sumStat.type === 'file')
        },
      },
      registry,
      label: SESSION_LABEL,
    },
    {
      format: 'openclaw',
      sourceLabel: 'OpenClaw',
      convert: convertOpenclawJson,
      registry,
      derive: { args: (target) => openclawDeriveArgs(ctx, target) },
    },
    // hermes：~/.hermes/state.db（SQLite 权威索引，恒批量）+ sessions/*.jsonl 回退
    //（db 不可用时）。.db 单文件恒批量；单 .jsonl = 单会话；目录优先 state.db、不可用则
    // 递归扫 .jsonl。
    {
      format: 'hermes',
      sourceLabel: 'Hermes',
      convert: convertHermesJson,
      io: {
        file: (c, t, a) => importHermesFile(c, t, a, { registryDir }),
        dir: (c, d, a) => importHermesDirectory(c, d, a, { registryDir }),
        previewFile: previewHermesFile,
        previewDir: previewHermesDirectory,
        fileBatch: (c, target) => /\.db$/i.test(String(targetPath(c, target))),
      },
      derive: { args: (target) => hermesFileArgs(ctx, target) },
      registry,
      label: SESSION_LABEL,
    },
    // pi：活动分支（叶→根）重建、compaction 默认尊重；头行缺失时用文件名 stem 作稳定源 id
    {
      format: 'pi',
      sourceLabel: 'Pi Coding Agent',
      convert: convertPiJsonl,
      registry: fullHistoryRegistry,
      derive: { args: stemArgs('piId') },
    },
    // kimi：会话目录（旧 wire.jsonl 或新 agents/main/wire.jsonl）视作单源（dirSingle，
    // 单会话导入器内部派生 kimiId/cwd/title），sessions 根走批量；subagents/ 子代理
    // wire 不并入主线程。单 wire.jsonl 文件由 derive.args 预先派生。
    {
      format: 'kimi',
      sourceLabel: 'Kimi CLI',
      convert: convertKimiWire,
      io: {
        file: (c, t, a) => importKimiFile(c, t, a, { registryDir, fingerprintKeys: FULL_HISTORY_KEYS }),
        dir: (c, d, a) => importKimiDirectory(c, d, a, { registryDir, fingerprintKeys: FULL_HISTORY_KEYS }),
        previewFile: previewKimiFile,
        previewDir: previewKimiDirectory,
        dirSingle: kimiIsSessionDir,
      },
      derive: { args: (target) => kimiDeriveArgs(ctx, target) },
      registry: fullHistoryRegistry,
      label: SESSION_LABEL,
    },
    // qoder：文件名 stem 传给转换器做「主 transcript」判定（<sessionId>/subagents/*.jsonl
    // 辅助 transcript 记录携带父 sessionId）
    { format: 'qoder', sourceLabel: 'Qoder CLI', convert: convertQoderJsonl, registry, derive: { args: stemArgs('fileStem') } },
    // workbuddy：文件名 stem（session-uuid）作稳定源 id 兜底（事件内 sessionId 优先）
    { format: 'workbuddy', sourceLabel: 'WorkBuddy', convert: convertWorkbuddyJsonl, registry, derive: { args: stemArgs('workbuddyId') } },
    // qwen（千问办公）：文件名 stem 与记录 sessionId 的一致性由转换器校验（双 slug 副本
    // 两者一致、辅助/异构转写不一致被跳过）
    { format: 'qwen', sourceLabel: '千问办公', convert: convertQwenJsonl, registry, derive: { args: stemArgs('fileStem') } },
    {
      format: 'continue',
      sourceLabel: 'Continue',
      convert: convertContinueJson,
      registry: fullHistoryRegistry,
      derive: { args: (target) => continueDeriveArgs(ctx, target) },
    },
    // cline：元数据 DB 优先（<dataDir>/db/sessions.db 的 sessions 表：cwd/started_at/
    // metadata_json.title），manifest 的 metadata.title 补齐权威标题；现代目录导入只收
    // <sessionId>.messages.json，legacy VS Code globalStorage 目录则收
    // tasks/<id>/api_conversation_history.json（manifest / compaction / 子代理消息文件不当作会话）
    {
      format: 'cline',
      sourceLabel: 'Cline',
      convert: convertClineJson,
      registry: fullHistoryRegistry,
      derive: {
        args: (target) => clineDeriveArgs(ctx, target),
        collect: collectClineFiles,
      },
    },
    // goose：会话库 <dataDir>/sessions/sessions.db（一库多会话恒批量）。旧版
    // sessions/*.jsonl 不读——上游只在首次建库时全量迁移且不删除旧文件，读它会与库里的
    // 同一批会话重复导入。目录模式定位 sessions.db（无递归）。
    {
      format: 'goose',
      sourceLabel: 'Goose',
      convert: convertGooseJson,
      io: sourceIo([importGooseFile, importGooseDirectory, previewGooseFile, previewGooseDirectory], hostOpts, { alwaysBatch: true }),
      registry,
      label: SESSION_LABEL,
      multiSession: true,
    },
    // zed：Agent 线程库 <data_dir>/threads/threads.db（单表 threads + zstd blob，一库多线程
    // 恒批量）。子代理线程（parent_id 非空）由读取层跳过；目录模式自动定位 threads.db。
    {
      format: 'zed',
      sourceLabel: 'Zed',
      convert: convertZedJson,
      io: sourceIo([importZedFile, importZedDirectory, previewZedFile, previewZedDirectory], fullHistoryOpts, { alwaysBatch: true }),
      registry,
      label: { ...SESSION_LABEL, batch: '线程' },
      multiSession: true,
    },
    // crush：库在**项目里**（<项目>/.crush/crush.db），用户级目录只有 JSON 状态 → 一库多
    // 会话恒批量；目录模式接受「项目目录」或「数据目录」；cwd 由 projects.json 反查。
    {
      format: 'crush',
      sourceLabel: 'Crush',
      convert: convertCrushJson,
      io: sourceIo([importCrushFile, importCrushDirectory, previewCrushFile, previewCrushDirectory], fullHistoryOpts, { alwaysBatch: true }),
      registry: fullHistoryRegistry,
      derive: { args: (target) => crushDeriveArgs(ctx, target) },
      label: SESSION_LABEL,
      multiSession: true,
    },
    // dsh：.zstd 由 fzstd 纯 JS 解压后走同一转换器；目录递归收集 session.jsonl(.zstd)。
    // 按日志代次拆两项（dsh = V0–V3 / dsh4 = V4+）：转换器同一个，目录收集按代次谓词过滤，
    // 面板来源列表因此能分别只看 V3 / V4。
    {
      format: 'dsh',
      sourceLabel: 'DSH V3',
      convert: convertDshJsonl,
      readText: readDshText,
      derive: { collect: (c, d, o, r) => collectDshFiles(c, d, o, r, (v) => v < 4) },
      registry,
    },
    {
      format: 'dsh4',
      sourceLabel: 'DSH V4',
      convert: convertDshJsonl,
      readText: readDshText,
      derive: { collect: (c, d, o, r) => collectDshFiles(c, d, o, r, (v) => v >= 4) },
      registry,
    },
    // 本地 JSONL：任意 .jsonl 路径，转换器按路径特征 + 内容自动识别，也可用 parseFormat
    // 参数强制指定解析器。不是面板来源（发现层不产出 local-jsonl 条目）。
    { format: 'local-jsonl', sourceLabel: 'Local JSONL', convert: convertLocalJsonl, registry },
  ]
}
