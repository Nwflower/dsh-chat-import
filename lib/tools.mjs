// lib/tools.mjs — 13 个工具的注册（import_chat 分发器 + import_agents + doctor +
// import_mcp + import_settings + export_chat 三合一 + export_bundle/restore_bundle +
// sync_to_claude + list_imported_sessions + retract_import + scan_discover +
// verify_session）
//
// apply 入口只做两件事：本文件的 registerTools（工具注册）与 lib/panel.mjs 的
// registerPanelRoutes（webServer 路由，可选服务延迟挂载）。18 个聊天导入源（17 个
// 面板来源 + 本地 JSONL）由 makeImportChatTool（lib/toolkit.mjs）收敛为单一
// import_chat 分发器——同一 spec 集合登记 IMPORT_SPECS 供面板 POST /api-import/import
// 与 /import 命令复用（面板 / 命令行为零变化）。特殊形态来源（chatgpt / grokbuild /
// hermes / opencode / zcode 的导入编排与预览）在 lib/import-variants.mjs。依赖 ctx
// （host 服务），非纯函数。

import { defineTool, TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import {
  convertClaudeJsonl, convertCodexJsonl, convertChatgptJson, convertCursorJsonl,
  convertGeminiJson, convertReasonixJsonl, convertPiJsonl, convertOpencodeJson,
  convertMimocodeJson, convertZcodeJson, convertGrokbuildJson, convertOpenclawJson,
  convertHermesJson, convertKimiWire, convertQoderJsonl, convertWorkbuddyJsonl, convertQwenJsonl, convertDshJsonl, convertLocalJsonl,
} from '../convert.mjs'
import { openclawDisplayNames } from './convert/openclaw.mjs'
import { markTrimmedSource } from './budget.mjs'
import { runDecision, collectJsonFiles, collectJsonlFiles } from './import-core.mjs'
import { parseReasonixSemantic, selectReasonixMaximalBranches } from './convert/reasonix-lineage.mjs'
import { syncClaudeSession } from './backfill.mjs'
import { importOpencodeFile, importOpencodeDirectory } from './opencode.mjs'
import { importMimocodeFile, importMimocodeDirectory } from './mimocode.mjs'
import { importZcodeFile, importZcodeDirectory } from './zcode.mjs'
import { FORMATS } from './discovery.mjs'
import { makeImportChatTool } from './toolkit.mjs'
import {
  importChatgptFile, importChatgptDirectory,
  importGrokbuildSession, importGrokbuildDirectory,
  importHermesFile, importHermesDirectory, hermesFileArgs,
  importKimiFile, importKimiDirectory, kimiDeriveArgs, kimiIsSessionDir,
  previewChatgptFile, previewChatgptDirectory,
  previewGrokbuildSession, previewGrokbuildDirectory,
  previewHermesFile, previewHermesDirectory,
  previewKimiFile, previewKimiDirectory,
  previewOpencodeFile, previewOpencodeDirectory,
  previewMimocodeFile, previewMimocodeDirectory,
  previewZcodeFile, previewZcodeDirectory,
} from './import-variants.mjs'
import { exportClaudeSession, exportBundleSession, exportCodexSession, exportKimiSession } from './export-tool.mjs'
import { restoreBundle, restoreBundleDirectory } from './restore.mjs'
import { verifySession } from './verify.mjs'
import { listImportedSessions, retractImport } from './retract.mjs'
import { runScanDiscover } from './discovery-host.mjs'
import { runAgentsImport } from './agents.mjs'
import { runDoctor } from './doctor.mjs'
import { runMcpMirror } from './mcp.mjs'
import { runSettingsSuggest } from './settings.mjs'
import { readDshText, collectDshFiles } from './dsh.mjs'
import { greedyDecodeSlugPath, resolveCursorSlugPath, cursorSlugFromTranscriptPath } from './cwd-map.mjs'

function reasonixSiblingPath(path, stem, suffix) {
  const value = String(path)
  const slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  const separator = value.includes('\\') ? '\\' : '/'
  const dir = slash >= 0 ? value.slice(0, slash) : '.'
  return dir + separator + stem + suffix
}

async function readReasonixMeta(ctx, target) {
  const path = target.displayPath || ctx.fs.processPath(target)
  const base = String(path).split(/[\\/]/).pop() || ''
  const stem = base.replace(/\.jsonl$/i, '')
  const sidecars = [String(path) + '.meta', reasonixSiblingPath(path, stem, '.meta.json')]
  for (const [index, sidecar] of sidecars.entries()) {
    try {
      const resolved = await ctx.fs.resolve(sidecar)
      const meta = JSON.parse(await ctx.fs.readText(resolved))
      if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
        return { meta, modern: index === 0 }
      }
    } catch {
      // Missing or malformed sidecars are not lineage evidence; try the legacy layout.
    }
  }
  return { meta: null, modern: false }
}

async function readReasonixWal(ctx, path, stem) {
  try {
    const target = await ctx.fs.resolve(reasonixSiblingPath(path, stem, '.events.jsonl'))
    return await ctx.fs.readText(target)
  } catch {
    // No readable WAL means the checkpoint JSONL is the complete known source.
    return null
  }
}

async function collectReasonixFiles(ctx, dirTarget, out, recursive, args = {}) {
  const physical = []
  await collectJsonlFiles(ctx, dirTarget, physical, recursive)
  if (args.lineageMode === 'physical') {
    out.push(...physical)
    return
  }

  const candidates = []
  for (const target of physical) {
    const path = target.displayPath || ctx.fs.processPath(target)
    const base = String(path).split(/[\\/]/).pop() || ''
    const stem = base.replace(/\.jsonl$/i, '')
    const [{ meta, modern }, raw, walText] = await Promise.all([
      readReasonixMeta(ctx, target),
      ctx.fs.readText(target),
      readReasonixWal(ctx, path, stem),
    ])
    const parsed = parseReasonixSemantic(raw)
    candidates.push({
      target,
      path,
      meta: modern ? meta : null,
      legacyMeta: modern ? null : meta,
      modern,
      semantic: parsed.semantic,
      parseErrors: parsed.parseErrors,
      hasWal: walText !== null,
      walText,
    })
  }

  const selection = selectReasonixMaximalBranches(candidates)
  const groupByPath = new Map()
  for (const group of selection.groups) {
    group.selected.forEach((candidate, index) => groupByPath.set(candidate.path, {
      topicId: group.topicId,
      branchIndex: index + 1,
      branchCount: group.selected.length,
      meta: candidate.meta,
      modern: candidate.modern,
      walText: candidate.walText,
    }))
  }
  for (const candidate of selection.selected) {
    out.push({
      ...candidate.target,
      // 未分组（无 topic key）候选没有 groupByPath 条目：meta 取「现代 ?? 旧版」
      // sidecar，独立现代文件同样派生 cwd/标题，与组内成员一致
      reasonixLineage: groupByPath.get(candidate.path) || {
        branchIndex: 1,
        branchCount: 1,
        meta: candidate.meta ?? candidate.legacyMeta,
        modern: candidate.modern,
        walText: candidate.walText,
      },
    })
  }
}

export function registerTools(ctx, registryDir) {
  // 声明 TOOL_RUNTIME_SCHEDULER 命名导入：一旦解析到旧副本 dsh-tools@0.0.1-rc.1
  //（只导出 TOOL_REGISTRY_SCHEDULER），模块加载即失败并大声报错，而不是静默用旧
  // ABI 注册工具、最终让宿主 agent-loop 在调度时崩溃
  //（Cannot read properties of undefined (reading 'prepare')）并污染会话历史。
  if (typeof TOOL_RUNTIME_SCHEDULER !== 'symbol') {
    throw new Error('dsh-chat-import: resolved @deepseek-ai/dsh-tools lacks TOOL_RUNTIME_SCHEDULER — requires ^0.1.0-rc.6')
  }
  // REQ-09 分组 spec：derive/io/label/registry 子对象，新源加一行即可；工具层
  // 专属参数（compacted/branch/sessionIds/fullHistory/lineage/lineageMode/parseFormat）与 format
  // 枚举描述集中在 lib/toolkit.mjs（分发器共同参数表）——此处 spec 只留执行所需。
  const IMPORT_SOURCES = [
    // claude：文件名 stem 传给转换器做「主 transcript」判定（subagent/workflow
    // 辅助 transcript 记录携带父 sessionId，按它建会话会与主 transcript 撞 id 导致
    // 主内容被跳过）。REQ-39 权威映射在转换层（convertClaudeJsonl 无 cwd 记录时输出
    // cwdHint slug，importTranscript 消费 resolveClaudeCwd）。
    {
      format: 'claude',
      sourceLabel: 'Claude Code',
      convert: convertClaudeJsonl,
      registry: { dir: registryDir },
      derive: {
        args: (target) => {
          const p = target.displayPath || ctx.fs.processPath(target)
          const base = String(p).split(/[\\/]/).pop() || ''
          return { fileStem: base.replace(/\.jsonl$/i, '') }
        },
      },
    },
    { format: 'codex', sourceLabel: 'Codex/ChatGPT', convert: convertCodexJsonl, registry: { dir: registryDir } },
    // chatgpt：conversations.json 恒批量 importChatgptFile（目录模式扫描 .json）
    {
      format: 'chatgpt',
      sourceLabel: 'ChatGPT',
      convert: convertChatgptJson,
      io: {
        file: (c, t, a) => importChatgptFile(c, t, a, { registryDir }),
        dir: (c, d, a) => importChatgptDirectory(c, d, a, { registryDir }),
        previewFile: (c, t, a) => previewChatgptFile(c, t, a),
        previewDir: (c, d, a) => previewChatgptDirectory(c, d, a),
        alwaysBatch: true,
      },
      registry: { dir: registryDir },
    },
    // cursor：行内无会话 id，用文件名（composer uuid）作稳定 id；cwd 从 projects/<slug> 还原
    {
      format: 'cursor',
      sourceLabel: 'Cursor',
      convert: convertCursorJsonl,
      registry: { dir: registryDir },
      derive: {
        args: async (target) => {
          const p = target.displayPath || ctx.fs.processPath(target)
          const base = String(p).split(/[\\/]/).pop() || ''
          const derived = { cursorId: base.replace(/\.jsonl$/i, '') }
          const slug = cursorSlugFromTranscriptPath(p)
          if (slug) {
            const cwd = await resolveCursorSlugPath(ctx, slug)
            if (cwd) derived.cwd = cwd
          }
          return derived
        },
      },
    },
    // gemini：单会话 .json（非 JSONL），目录收集走 collectJsonFiles
    { format: 'gemini', sourceLabel: 'Gemini CLI', convert: convertGeminiJson, derive: { collect: collectJsonFiles }, registry: { dir: registryDir } },
    // reasonix：会话 id 用文件名 stem（幂等）；cwd/标题从同目录 <stem>.meta.json
    // 派生；REQ-45 桌面版 projects/<slug>/sessions 布局下标题走目录级 .titles.json
    // 权威索引、cwd 走 slug 贪心解码（REQ-39）；REQ-22 V2 WAL（<stem>.events.jsonl）
    // 读取经 args.walText 传入转换层合并。
    {
      format: 'reasonix',
      sourceLabel: 'Reasonix',
      convert: convertReasonixJsonl,
      registry: { dir: registryDir },
      derive: {
        collect: collectReasonixFiles,
        args: async (target) => {
          const p = target.displayPath || ctx.fs.processPath(target)
          const base = String(p).split(/[\\/]/).pop() || ''
          const stem = base.replace(/\.jsonl$/i, '')
          const derived = { reasonixId: stem }
          const annotated = target.reasonixLineage
          const loaded = annotated
            ? { meta: annotated.meta, modern: annotated.modern }
            : await readReasonixMeta(ctx, target)
          const meta = loaded.meta
          if (meta) {
            if (loaded.modern) {
              if (meta.scope !== 'global' && typeof meta.workspace_root === 'string' && meta.workspace_root) {
                derived.cwd = meta.workspace_root
              }
              if (typeof meta.topic_title === 'string' && meta.topic_title.trim()) {
                derived.title = meta.topic_title.trim()
              }
            } else {
              if (typeof meta.workspace === 'string' && meta.workspace) derived.cwd = meta.workspace
              if (typeof meta.summary === 'string' && meta.summary.trim()) derived.title = meta.summary.trim()
            }
          }
          if (annotated?.branchCount > 1 && derived.title) {
            derived.title += `（分支 ${annotated.branchIndex}/${annotated.branchCount}）`
          }
          // REQ-45 桌面版布局：projects/<slug>/sessions/<stem>.jsonl
          const segs = String(p).replace(/[\\/]+$/, '').split(/[\\/]/)
          const sessionsIdx = segs.lastIndexOf('sessions')
          if (sessionsIdx >= 2 && segs[sessionsIdx - 2] === 'projects') {
            const slug = segs[sessionsIdx - 1]
            const sessionDir = segs.slice(0, sessionsIdx + 1).join('\\')
            // 目录级 .titles.json 权威标题（basename → 标题）
            if (!derived.title) {
              try {
                const titlesTarget = await ctx.fs.resolve(join(sessionDir, '.titles.json'))
                const titles = JSON.parse(await ctx.fs.readText(titlesTarget))
                if (titles && typeof titles[stem] === 'string' && titles[stem].trim()) {
                  derived.title = titles[stem].trim()
                }
              } catch {
                // .titles.json 缺失/损坏：标题回退首问（不致命）
              }
            }
            // cwd = slug 贪心解码（REQ-39；meta.json 无 workspace 时）
            if (!derived.cwd) {
              const decoded = await greedyDecodeSlugPath(ctx, slug)
              if (decoded) derived.cwd = decoded
            }
          }
          if (annotated?.walText !== null && annotated?.walText !== undefined) {
            derived.walText = annotated.walText
          } else {
            try {
              // REQ-22：WAL 与 checkpoint 同目录：<stem>.events.jsonl（V2 事件日志权威，
              // 自动合并；无 WAL 的旧版本/子代理文件自然回退纯 checkpoint）
              const walPath = reasonixSiblingPath(p, stem, '.events.jsonl')
              const walTarget = await ctx.fs.resolve(walPath)
              derived.walText = await ctx.fs.readText(walTarget)
            } catch {
              // 无 WAL：纯 checkpoint 导入
            }
          }
          return derived
        },
      },
    },
    // opencode：一库多会话（单 .db 文件也恒批量）；目录模式自动定位 opencode.db
    {
      format: 'opencode',
      sourceLabel: 'opencode',
      convert: convertOpencodeJson,
      io: {
        file: (c, t, a) => importOpencodeFile(c, t, a, { registryDir, runDecision, markTrimmedSource }),
        dir: (c, d, a) => importOpencodeDirectory(c, d, a, { registryDir, runDecision, markTrimmedSource }),
        previewFile: (c, t, a) => previewOpencodeFile(c, t, a),
        previewDir: (c, d, a) => previewOpencodeDirectory(c, d, a),
        alwaysBatch: true,
      },
      registry: { dir: registryDir },
      label: { batch: '会话', skipped: '无用户回合' },
    },
    // mimocode 源：opencode 的 fork（SQLite 三表 schema 同构，仅 session 表无 model
    // 列、库文件名不同），读取/导入/预览复用 opencode 管线——mimocode 专属差异
    //（mimocode.db、provider 标签、后台任务会话过滤）收在 lib/mimocode.mjs /
    // lib/convert/mimocode.mjs。
    {
      format: 'mimocode',
      sourceLabel: 'mimocode',
      convert: convertMimocodeJson,
      io: {
        file: (c, t, a) => importMimocodeFile(c, t, a, { registryDir, runDecision, markTrimmedSource }),
        dir: (c, d, a) => importMimocodeDirectory(c, d, a, { registryDir, runDecision, markTrimmedSource }),
        previewFile: (c, t, a) => previewMimocodeFile(c, t, a),
        previewDir: (c, d, a) => previewMimocodeDirectory(c, d, a),
        alwaysBatch: true,
      },
      registry: { dir: registryDir },
      label: { batch: '会话', skipped: '无用户回合' },
    },
    // zcode 源：z.ai 官方 CLI（zcode.z.ai）会话存储 ~/.zcode/cli/db/db.sqlite
    //（SQLite 权威索引）+ 旧版 transcript.jsonl 回退。一库多会话恒批量；目录模式
    // 自动定位 db.sqlite（无递归）；zcode://<id> 伪路径走默认库只导该会话（derive
    // 从 path 提取 zcodeId，importZcodeFile 还会从原始 args.path 兜底再取一次）。
    {
      format: 'zcode',
      sourceLabel: 'zcode',
      convert: convertZcodeJson,
      io: {
        file: (c, t, a) => importZcodeFile(c, t, a, { registryDir, runDecision, markTrimmedSource }),
        dir: (c, d, a) => importZcodeDirectory(c, d, a, { registryDir, runDecision, markTrimmedSource }),
        previewFile: (c, t, a) => previewZcodeFile(c, t, a),
        previewDir: (c, d, a) => previewZcodeDirectory(c, d, a),
        alwaysBatch: true,
      },
      registry: { dir: registryDir },
      derive: {
        args: (target) => {
          const p = target.displayPath || ctx.fs.processPath(target)
          if (typeof p === 'string' && p.startsWith('zcode://')) {
            return { zcodeId: p.slice('zcode://'.length) }
          }
          return {}
        },
      },
      label: { batch: '会话', skipped: '无用户回合' },
    },
    // grokbuild 源：会话目录（含 summary.json + chat_history.jsonl）→ mode single；
    // sessions/archived_sessions 根（递归扫 summary.json）→ 批量。转换器
    // convertGrokbuildJson 需读两个文件再转换，编排见 lib/import-variants.mjs。
    {
      format: 'grokbuild',
      sourceLabel: 'Grok Build',
      convert: convertGrokbuildJson,
      io: {
        file: (c, t, a) => importGrokbuildSession(c, t, a, { registryDir }),
        dir: (c, d, a) => importGrokbuildDirectory(c, d, a, { registryDir }),
        previewFile: (c, t, a) => previewGrokbuildSession(c, t, a),
        previewDir: (c, d, a) => previewGrokbuildDirectory(c, d, a),
        // 会话目录（含 summary.json）视作单源走单会话导入；其余目录走批量扫描
        dirSingle: async (ctx, target) => {
          const dirPath = target.displayPath || ctx.fs.processPath(target)
          const sumTarget = await ctx.fs.resolve(join(dirPath, 'summary.json'))
          const sumStat = await ctx.fs.stat(sumTarget)
          return !!(sumStat && sumStat.type === 'file')
        },
      },
      registry: { dir: registryDir },
      label: { batch: '会话', skipped: '无用户回合' },
    },
    // openclaw 源：sessions.json 索引提供 displayName 作会话标题（derive 按文件
    // stem 查 openclawDisplayNames 纯函数）
    {
      format: 'openclaw',
      sourceLabel: 'OpenClaw',
      convert: convertOpenclawJson,
      registry: { dir: registryDir },
      derive: {
        args: async (target) => {
          const p = target.displayPath || ctx.fs.processPath(target)
          const base = String(p).split(/[\\/]/).pop() || ''
          const stem = base.replace(/\.jsonl$/i, '')
          const derived = { openclawId: stem }
          try {
            // sessions.json 与 transcript 同目录：<dir>/sessions.json（displayName 索引）
            const dirPath = String(p).replace(/[\\/][^\\/]*\.jsonl$/i, '')
            const indexTarget = await ctx.fs.resolve(join(dirPath, 'sessions.json'))
            const name = openclawDisplayNames(await ctx.fs.readText(indexTarget)).get(stem)
            if (name) derived.displayName = name
          } catch {
            // sessions.json 缺失/损坏不致命：仍按 stem 导入，仅无 displayName
          }
          return derived
        },
      },
    },
    // hermes 源：~/.hermes/state.db（SQLite 权威索引，恒批量）+ sessions/*.jsonl
    // 回退（db 不可用 readHermesDb 返回 null 时）。.db 单文件恒批量（对齐
    // import_opencode）；单 .jsonl = 单会话（mode single）；目录优先 state.db、
    // 不可用则递归扫 .jsonl。
    {
      format: 'hermes',
      sourceLabel: 'Hermes',
      convert: convertHermesJson,
      io: {
        file: (c, t, a) => importHermesFile(c, t, a, { registryDir }),
        dir: (c, d, a) => importHermesDirectory(c, d, a, { registryDir }),
        previewFile: (c, t, a) => previewHermesFile(c, t, a),
        previewDir: (c, d, a) => previewHermesDirectory(c, d, a),
        // .db 单文件恒返回批量形态（SQLite 一库多会话）；.jsonl 走单会话导入
        fileBatch: (ctx, target) => /\.db$/i.test(String(target.displayPath || ctx.fs.processPath(target))),
      },
      derive: { args: (target) => hermesFileArgs(ctx, target) },
      registry: { dir: registryDir },
      label: { batch: '会话', skipped: '无用户回合' },
    },
    // pi 源：活动分支（叶→根）重建、compaction 默认尊重（fullHistory 入参数指纹）；
    // 头行缺失时用文件名 stem 作稳定源 id（幂等）
    {
      format: 'pi',
      sourceLabel: 'Pi Coding Agent',
      convert: convertPiJsonl,
      registry: { dir: registryDir, fingerprintKeys: ['fullHistory'] },
      derive: {
        args: (target) => {
          const p = target.displayPath || ctx.fs.processPath(target)
          const base = String(p).split(/[\\/]/).pop() || ''
          return { piId: base.replace(/\.jsonl$/i, '') }
        },
      },
    },
    // kimi 源：会话目录（旧 wire.jsonl 或新 agents/main/wire.jsonl）视作单源
    //（dirSingle 判定），sessions 根走批量；subagents/ 子代理 wire 不并入主线程
    {
      format: 'kimi',
      sourceLabel: 'Kimi CLI',
      convert: convertKimiWire,
      io: {
        file: (c, t, a) => importKimiFile(c, t, a, { registryDir }),
        dir: (c, d, a) => importKimiDirectory(c, d, a, { registryDir }),
        previewFile: (c, t, a) => previewKimiFile(c, t, a),
        previewDir: (c, d, a) => previewKimiDirectory(c, d, a),
        dirSingle: async (ctx, target) => kimiIsSessionDir(ctx, target),
      },
      derive: { args: (target) => kimiDeriveArgs(ctx, target) },
      registry: { dir: registryDir },
      label: { batch: '会话', skipped: '无用户回合' },
    },
    // qoder 源：文件名 stem 传给转换器做「主 transcript」判定（<sessionId>/subagents/
    // *.jsonl 辅助 transcript 记录携带父 sessionId）
    {
      format: 'qoder',
      sourceLabel: 'Qoder CLI',
      convert: convertQoderJsonl,
      registry: { dir: registryDir },
      derive: {
        args: (target) => {
          const p = target.displayPath || ctx.fs.processPath(target)
          const base = String(p).split(/[\\/]/).pop() || ''
          return { fileStem: base.replace(/\.jsonl$/i, '') }
        },
      },
    },
    // workbuddy 源：文件名 stem（session-uuid）作稳定源 id 兜底（事件内 sessionId 优先）
    {
      format: 'workbuddy',
      sourceLabel: 'WorkBuddy',
      convert: convertWorkbuddyJsonl,
      registry: { dir: registryDir },
      derive: {
        args: (target) => {
          const p = target.displayPath || ctx.fs.processPath(target)
          const base = String(p).split(/[\\/]/).pop() || ''
          return { workbuddyId: base.replace(/\.jsonl$/i, '') }
        },
      },
    },
    // qwen（千问办公）源：文件名 stem（session-uuid）与记录 sessionId 的一致性由
    // 转换器校验（双 slug 副本两者一致、辅助/异构转写不一致被跳过）
    {
      format: 'qwen',
      sourceLabel: '千问办公',
      convert: convertQwenJsonl,
      registry: { dir: registryDir },
      derive: {
        args: (target) => {
          const p = target.displayPath || ctx.fs.processPath(target)
          const base = String(p).split(/[\\/]/).pop() || ''
          return { fileStem: base.replace(/\.jsonl$/i, '') }
        },
      },
    },
    // dsh 源：.zstd 由 fzstd 纯 JS 解压后走同一转换器；目录递归收集 session.jsonl(.zstd)
    {
      format: 'dsh',
      sourceLabel: 'DSH',
      convert: convertDshJsonl,
      readText: readDshText,
      derive: { collect: collectDshFiles },
      registry: { dir: registryDir },
    },
    // 本地 JSONL：任意 .jsonl 路径，转换器按路径特征 + 内容自动识别，也可用
    // parseFormat 参数强制指定解析器。不是「面板来源」——不登记 IMPORT_SPECS。
    { format: 'local-jsonl', sourceLabel: 'Local JSONL', convert: convertLocalJsonl, registry: { dir: registryDir } },
  ]
  ctx.tools.register(makeImportChatTool(ctx, IMPORT_SOURCES))
  // REQ-59/61/64 外部 agent/mode prompt/skill/config → DSH skills 资产：
  // 非会话导入，独立注册。收集 pi/opencode/Claude/Codex 的自定义 agent / mode prompt /
  // skill / instructions / config，转换为 `$DSH_AGENTS_HOME/skills/<name>/SKILL.md`
  // bundle（provenance frontmatter）。缺省 dry-run 预览（plan 清单零副作用）；
  // apply:true 才写盘。
  ctx.tools.register(defineTool({
    name: 'import_agents',
    description:
      'Convert custom agent / mode prompt / skill / instruction / config assets from pi ' +
      '(~/.pi/agent/{agents,prompts}), opencode (~/.config/opencode/{agents,skill}), Claude ' +
      '(~/.claude/memory/<group>/*.md, ~/.claude/skills/<skill>/SKILL.md, project CLAUDE.md), ' +
      'and Codex (~/.codex/skills/<skill>/SKILL.md, ~/.codex/instructions.md, ~/.codex/AGENTS.md, ' +
      '~/.codex/config.toml) into persistent DSH skill assets at ' +
      '$DSH_AGENTS_HOME/skills/<name>/SKILL.md (defaults to ~/.agents). Call this when migrating ' +
      'agent personas, skills, or CLI configs from another tool into DSH. Defaults to dry-run: ' +
      'returns a write/complete/skip plan (zero side effects); apply:true persists. Semantics: ' +
      'name clashes get a -<source> suffix, identical content is skipped idempotently, sources ' +
      'already tagged kind:dsh are not re-imported, and a bundle dir missing SKILL.md is ' +
      'completed in place (keeping existing scripts/ etc.). Returns the plan/applied detail.',
    parameters: {
      apply: {
        type: 'boolean',
        description: 'Optional: true persists the plan to disk (default false = dry-run preview, zero side effects).',
      },
      piRoot: {
        type: 'string',
        description: 'Optional: pi root (default ~/.pi/agent).',
      },
      opencodeRoot: {
        type: 'string',
        description: 'Optional: opencode config root (default ~/.config/opencode).',
      },
      agentsHome: {
        type: 'string',
        description: 'Optional: DSH user-agents root (default $DSH_AGENTS_HOME or ~/.agents); skills are written under its skills/.',
      },
      claudeRoot: {
        type: 'string',
        description: 'Optional: Claude config root (default ~/.claude), collecting memory/<group>/*.md and skills/<skill>/SKILL.md.',
      },
      claudeProjectRoot: {
        type: 'string',
        description: 'Optional: project root (a CLAUDE.md there becomes a claude-md asset; skipped when not given).',
      },
      codexRoot: {
        type: 'string',
        description: 'Optional: Codex config root (default ~/.codex), collecting skills / instructions.md / AGENTS.md / config.toml.',
      },
      preview: {
        type: 'boolean',
        description: 'Optional: dry-run alias (same as default behavior; explicit zero side effects).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          planned: { type: 'integer', required: true },
          applied: { type: 'integer', required: true },
          skipped: { type: 'integer', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                source: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                action: { type: 'string', enum: ['write', 'complete', 'skip'], required: true },
                reason: { type: 'string' },
                target: { type: 'string' },
              },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: (value.applied > 0 ? '已落盘：' : '预览（dry-run，未落盘）：')
          + value.total + ' 个候选 → 规划 ' + value.planned + ' 条'
          + (value.applied > 0 ? '（落盘 ' + value.applied + '）' : '')
          + (value.skipped > 0 ? '、跳过 ' + value.skipped : ''),
      }],
    },
    async execute(args) {
      return runAgentsImport(ctx, args)
    },
  }))
  // REQ-66 doctor：迁移后健康检查。只读，不写任何文件。
  ctx.tools.register(defineTool({
    name: 'doctor',
    description:
      'Read-only health check for the chat-import plugin: whether the imports registry is ' +
      'readable, imported sessions still exist in sessionPersistence, DSH user-agents skills ' +
      'are on disk, and workspaceRegistry is available. Call this after migration or when ' +
      'imports appear to be missing. Never writes files, never triggers import/sync/delete. ' +
      'Returns checks/issues/totals.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          checks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                ok: { type: 'boolean', required: true },
                detail: { type: 'string' },
              },
            },
          },
          issues: {
            type: 'array',
            required: true,
            items: { type: 'string' },
          },
          totals: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              records: { type: 'integer', required: true },
              sessions: { type: 'integer', required: true },
              missingSessions: { type: 'integer', required: true },
              skills: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: 'doctor: ok=' + value.ok + '\n'
          + (value.checks || []).map((c) => (c.ok ? '[ok] ' : '[!!] ') + c.name + '：' + (c.detail || '')).join('\n')
          + ((value.issues || []).length > 0 ? '\nissues: ' + value.issues.join('; ') : ''),
      }],
    },
    async execute() {
      return runDoctor(ctx, registryDir)
    },
  }))
  // REQ-68 MCP 镜像：Claude/Codex MCP → DSH MCP client 计划。默认 dry-run；
  // apply=true 只把生成 YAML 片段写到 outPath（绝不直接改 profile）。
  ctx.tools.register(defineTool({
    name: 'import_mcp',
    description:
      'Mirror MCP server configs from Claude (.mcp.json / ~/.claude.json) and Codex ' +
      '(config.toml) into a reviewable DSH MCP client YAML fragment. Call this when migrating ' +
      'MCP servers from Claude Code or Codex into DSH. Defaults to dry-run (zero writes); ' +
      'apply:true writes the fragment to $DSH_HOME/dsh-chat-import/mcp-mirror.cordis.yml ' +
      '(or outPath). Never auto-modifies the profile cordis.patch.yml — review the generated ' +
      'fragment manually against the dsh-mcp-client contract before merging.',
    parameters: {
      claudeMcpPath: {
        type: 'string',
        description: 'Optional: Claude MCP config path (default ~/.claude.json; also accepts project .mcp.json content).',
      },
      codexConfigPath: {
        type: 'string',
        description: 'Optional: Codex config.toml path (default ~/.codex/config.toml).',
      },
      apply: {
        type: 'boolean',
        description: 'Optional: true writes the generated fragment (default false = dry-run).',
      },
      outPath: {
        type: 'string',
        description: 'Optional: output path when apply (default $DSH_HOME/dsh-chat-import/mcp-mirror.cordis.yml).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          servers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                source: { type: 'string', required: true },
                name: { type: 'string', required: true },
                command: { type: 'string', required: true },
                args: { type: 'array', required: true, items: { type: 'string' } },
                env: { type: 'object', required: true, additionalProperties: true },
              },
            },
          },
          planText: { type: 'string', required: true },
          writtenTo: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: (value.writtenTo ? '已写入 MCP 镜像片段：' : 'MCP 镜像计划（dry-run，未落盘）：')
          + value.total + ' 个 server'
          + (value.total > 0 ? '\n' + (value.servers || []).map((s) => '  - ' + s.source + '/' + s.name + ' (' + s.command + ')').join('\n') : ''),
      }],
    },
    async execute(args) {
      return runMcpMirror(ctx, args)
    },
  }))
  // REQ-71 settings/config 翻译建议：Claude settings.json / Codex config.toml → 建议。
  // 只读，不自动应用。
  ctx.tools.register(defineTool({
    name: 'import_settings',
    description:
      'Read-only migration advice: parse key settings from Claude settings.json and Codex ' +
      'config.toml (model / permissions / hooks / env / model_provider) and return suggestions ' +
      'for moving them to DSH, plus items that cannot be mapped directly. Call this when ' +
      'migrating CLI configuration into DSH. Never writes files or applies anything.',
    parameters: {
      claudeSettingsPath: {
        type: 'string',
        description: 'Optional: Claude settings.json path (default ~/.claude/settings.json).',
      },
      codexConfigPath: {
        type: 'string',
        description: 'Optional: Codex config.toml path (default ~/.codex/config.toml).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          suggestions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                source: { type: 'string', required: true },
                value: { type: 'string', required: true },
                suggestion: { type: 'string', required: true },
                unmappable: { type: 'boolean', required: true },
              },
            },
          },
          sources: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: '配置建议：' + value.total + ' 条（来源：' + (value.sources || []).join(', ') + '）'
          + (value.total > 0 ? '\n' + value.suggestions.map((s) => '  - [' + s.source + '] ' + s.key + '：' + s.suggestion + (s.unmappable ? '（不可直接映射）' : '')).join('\n') : ''),
      }],
    },
    async execute(args) {
      return runSettingsSuggest(ctx, args)
    },
  }))
  // REQ-16/REQ-23/REQ-21 反向导出：export_claude / export_codex / export_kimi 三合一为
  // export_chat({ format, ... })。只读会话日志 → 目标格式 JSONL；导出流程与导入状态机
  // 完全不同，但三个目标（Claude/Codex/Kimi）共享同一工具面：sessionId 必填、
  // createIfAbsent 不覆盖、dryRun 不写盘、降级逐条报告。claude 额外把 mapping 落进
  // imports registry（exportClaudeSession 内完成，供 sync_to_claude target:'copy'）。
  ctx.tools.register(defineTool({
    name: 'export_chat',
    description:
      'Serialize a DSH session log (read-only: list + readFrom, never load/prepare or rewrite ' +
      'history) into an external chat format, re-importable via import_chat. Call this when the ' +
      'user wants to move or back up a DSH session into Claude Code / Codex / Kimi CLI. ' +
      'format is required: "claude" writes a resumable Claude Code JSONL at ' +
      '<outputDir>/<slug>/<uuid>.jsonl (default ~/.claude/projects); "codex" and "kimi" write a ' +
      'rollout/wire JSONL at path or <outputDir>/<sessionId>.<ext> (default ~/.dsh/exports). ' +
      'cwd applies to claude only (default: session header.cwd; error when neither present); ' +
      'path applies to codex/kimi only. dryRun serializes without writing. Returns the target ' +
      'file path, counts, degradations, and (claude) the export mapping used by sync_to_claude ' +
      'target:"copy".',
    parameters: {
      format: {
        type: 'string',
        required: true,
        enum: ['claude', 'codex', 'kimi'],
        description: 'Target format (required): claude=Claude Code JSONL (resumable with --resume); codex=Codex rollout JSONL; kimi=Kimi CLI wire.jsonl.',
      },
      sessionId: {
        type: 'string',
        required: true,
        description: 'DSH session id to export (required).',
      },
      cwd: {
        type: 'string',
        description: 'Optional (claude only): override the exported cwd (default: session header.cwd; error when neither present).',
      },
      path: {
        type: 'string',
        description: 'Optional (codex/kimi only): output file path (default <outputDir>/<sessionId>.rollout.jsonl or .wire.jsonl).',
      },
      outputDir: {
        type: 'string',
        description: 'Optional: output directory (claude default ~/.claude/projects, file at <outputDir>/<slug>/<uuid>.jsonl; codex/kimi default ~/.dsh/exports).',
      },
      dryRun: {
        type: 'boolean',
        description: 'Optional: true serializes without writing, returning target path and stats.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['single'], required: true },
          sessionId: { type: 'string', required: true },
          filePath: { type: 'string', required: true },
          recordCount: { type: 'integer', required: true },
          dryRun: { type: 'boolean', required: true },
          // claude 分支：sourceSessionId/slug/cwd/title/mapping
          sourceSessionId: { type: 'string' },
          slug: { type: 'string' },
          cwd: { type: 'string' },
          title: { type: 'string' },
          mapping: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sourceSessionId: { type: 'string' },
              sessionUuid: { type: 'string' },
              slug: { type: 'string' },
              filePath: { type: 'string' },
              turns: { type: 'integer' },
              messages: { type: 'integer' },
              toolCalls: { type: 'integer' },
              toolResults: { type: 'integer' },
              droppedToolResults: { type: 'integer' },
              skippedInjections: { type: 'integer' },
            },
          },
          // codex/kimi 分支：toolCalls/toolResults（无 mapping）
          toolCalls: { type: 'integer' },
          toolResults: { type: 'integer' },
          // REQ-21 降级逐条报告（三类导出共享）：有损项（孤儿结果/注入跳过/附件跳过）
          degradations: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                strategy: { type: 'string', enum: ['lossless', 'text-fallback', 'skip-placeholder'], required: true },
                count: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (args, value) => {
        const isClaude = value.mapping !== null && value.mapping !== undefined
        const srcId = isClaude ? value.sourceSessionId : value.sessionId
        const calls = isClaude ? value.mapping.toolCalls : value.toolCalls
        const degNote = (value.degradations || []).map((d) => d.id + ' ' + d.count).join('、')
        return [{
          type: 'text',
          text: (value.dryRun ? '导出预览（dryRun，未写盘）：' : '已导出：')
            + '会话 ' + srcId + ' → ' + value.filePath
            + '（' + value.recordCount + ' 条记录、' + (calls || 0) + ' 次工具调用'
            + (degNote ? '；降级：' + degNote : '') + '）',
        }]
      },
    },
    async execute(args) {
      const { format, ...rest } = args
      if (format === 'claude') return exportClaudeSession(ctx, rest, { registryDir })
      if (format === 'codex') return exportCodexSession(ctx, rest)
      return exportKimiSession(ctx, rest)
    },
  }))
  // REQ-56/62 export_bundle / restore_bundle：DSH 会话 → interchange bundle（SHA-256
  // 双层指纹 + 事件级无损 + 跨机器落点信息），还原 = 指纹校验 → convertDshJsonl
  // 状态机（幂等键 = bundle 路径）；跨机器 cwd 不可达走 REQ-39-lite 回退归组并报告
  //（不静默）。bundle 格式见 docs/INTERCHANGE.md §4。
  ctx.tools.register(defineTool({
    name: 'export_bundle',
    description:
      'Export a DSH session into a portable interchange bundle: SHA-256 dual-layer checksums ' +
      '(session-level + file-level, tamper detectable), event-level lossless (restoring yields ' +
      'a continuable DSH session), and cross-machine landing info (originalCwd + landingHint). ' +
      'Call this to back up or move sessions between machines. sessionId required; path ' +
      'optional (default <outputDir>/<sessionId>.dshbundle.json); outputDir optional (default ' +
      '~/.dsh/exports); dryRun serializes without writing. Reads session logs only (list + ' +
      'readFrom), never rewrites history; writes use createIfAbsent (no overwrite). Returns ' +
      'target path, dual checksums and landing info.',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'DSH session id to export (required).',
      },
      path: {
        type: 'string',
        description: 'Optional: output file path (default <outputDir>/<sessionId>.dshbundle.json).',
      },
      outputDir: {
        type: 'string',
        description: 'Optional: output directory (default ~/.dsh/exports); file is written to <outputDir>/<sessionId>.dshbundle.json.',
      },
      dryRun: {
        type: 'boolean',
        description: 'Optional: true serializes only, writes nothing.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['single'], required: true },
          sessionId: { type: 'string', required: true },
          filePath: { type: 'string', required: true },
          eventCount: { type: 'integer', required: true },
          dryRun: { type: 'boolean', required: true },
          originalCwd: { type: 'string' },
          landingHint: { type: 'string' },
          sha256: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              session: { type: 'string', required: true },
              bundle: { type: 'string', required: true },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: (value.dryRun ? '导出预览（dryRun，未写盘）：' : '已导出 bundle：')
          + '会话 ' + value.sessionId + ' → ' + value.filePath
          + '（' + value.eventCount + ' 条事件；会话级 ' + value.sha256.session.slice(0, 12) + '…'
          + (value.originalCwd ? '；原 cwd ' + value.originalCwd : '') + '）',
      }],
    },
    async execute(args) {
      return exportBundleSession(ctx, args, { registryDir })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'restore_bundle',
    description:
      'Restore a portable interchange bundle (produced by export_bundle) back into a ' +
      'continuable DSH session. Verifies the dual SHA-256 checksums (tampered bundles fail ' +
      'loudly, never silently) then restores losslessly via the import state machine ' +
      '(idempotency key = bundle path; repeat restores are skipped, force:true saves a copy ' +
      'under a new id). Cross-machine: when the bundle originalCwd is unreachable on this ' +
      'machine, the session is grouped into the bundle file directory and the result reports ' +
      'cwdAvailable:false + groupedTo + restoreNote. path required (bundle file or a directory ' +
      'of .dshbundle.json files); sessionId optional (override restored session id); ' +
      'preview/dryRun give a zero-side-effect preview; force/recursive follow import semantics. ' +
      'Returns restore status (imported / already-imported / skipped) and landing report.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Path to the .dshbundle.json bundle file, or a directory of bundles (directory mode restores each).',
      },
      sessionId: {
        type: 'string',
        description: 'Optional: override the restored DSH session id (default import-<source session id>).',
      },
      force: {
        type: 'boolean',
        description: 'Optional: true saves a full copy under a new id even if already restored; the old session is kept.',
      },
      preview: {
        type: 'boolean',
        description: 'Optional: true dry-runs the preview — no writes, no registry, no grouping; returns only the would-restore list.',
      },
      dryRun: {
        type: 'boolean',
        description: 'Optional: preview compatibility alias (same semantics).',
      },
      recursive: {
        type: 'boolean',
        description: 'Optional: whether directory mode recurses into subdirectories (default true).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['single', 'batch'], required: true },
          preview: { type: 'boolean' },
          sessionId: { type: 'string' },
          sourceSessionId: { type: 'string' },
          status: { type: 'string', enum: ['imported', 'already-imported', 'appended', 'skipped'] },
          turns: { type: 'integer' },
          messages: { type: 'integer' },
          toolCalls: { type: 'integer' },
          skipped: { type: 'integer' },
          skipReason: { type: 'string' },
          originalCwd: { type: 'string' },
          cwdAvailable: { type: 'boolean' },
          landingHint: { type: 'string' },
          groupedTo: { type: 'string' },
          restoreNote: { type: 'string' },
          title: { type: 'string' },
          createdAt: { type: 'integer' },
          total: { type: 'integer' },
          imported: { type: 'integer' },
          alreadyImported: { oneOf: [{ type: 'boolean' }, { type: 'integer' }] },
          appended: { type: 'integer' },
          failed: { type: 'integer' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                status: { type: 'string', required: true },
                sessionId: { type: 'string' },
                turns: { type: 'integer' },
                messages: { type: 'integer' },
                toolCalls: { type: 'integer' },
                skipped: { type: 'integer' },
                restoreNote: { type: 'string' },
                cwdAvailable: { type: 'boolean' },
                error: { type: 'string' },
                reason: { type: 'string' },
              },
            },
          },
        },
      },
      render: (args, value) => {
        if (value.preview === true) {
          return [{
            type: 'text',
            text: '还原预览（dry-run，未落盘）：'
              + (value.title ? '《' + value.title + '》' : '')
              + (value.turns > 0 ? value.turns + ' 轮对话' : '无可导入内容')
              + (value.skipped ? '（跳过 ' + value.skipped + '）' : '')
              + (value.skipReason ? '\n跳过原因：' + value.skipReason : ''),
          }]
        }
        if (value.mode === 'batch') {
          const bits = ['共还原 ' + value.total + ' 个 bundle']
          if (value.imported) bits.push('新增 ' + value.imported)
          if (value.appended) bits.push('续写 ' + value.appended)
          if (value.alreadyImported) bits.push('已存在 ' + value.alreadyImported)
          if (value.skipped) bits.push('跳过 ' + value.skipped)
          if (value.failed) bits.push('失败 ' + value.failed)
          const notes = (value.results || []).filter((r) => r.restoreNote).slice(0, 3).map((r) => '  - ' + r.path + '：' + r.restoreNote)
          return [{
            type: 'text',
            text: '批量还原完成：' + bits.join('，') + (notes.length ? '\n' + notes.join('\n') : ''),
          }]
        }
        if (value.status === 'skipped') {
          return [{ type: 'text', text: '跳过还原：' + (value.skipReason || 'bundle 无内容') }]
        }
        return [{
          type: 'text',
          text: '已还原 ' + value.turns + ' 轮对话（' + value.messages + ' 条消息、' + value.toolCalls + ' 次工具调用）→ 会话 ' + value.sessionId
            + (value.restoreNote ? '\n' + value.restoreNote : ''),
        }]
      },
    },
    async execute(args) {
      const target = await ctx.fs.resolve(args.path)
      const info = await ctx.fs.stat(target)
      if (info && info.type === 'directory') {
        return restoreBundleDirectory(ctx, target, args, { registryDir })
      }
      return restoreBundle(ctx, args, { registryDir })
    },
  }))
  // REQ-23 矩阵化互转出边已并入 export_chat（format=claude/codex/kimi）：DSH 会话
  // 日志 → 目标格式 JSONL，createIfAbsent 不覆盖、dryRun、降级逐条报告。入边由
  // import_chat format=claude/codex/kimi 覆盖；四向矩阵（DSH↔Claude↔Codex↔Kimi）
  // 的 DSH→Codex / DSH→Kimi 出边与 Claude 双向（export_chat format=claude + 入边）
  // 全部经 export_chat 单一入口。
  ctx.tools.register(defineTool({
    name: 'verify_session',
    description:
      'Read-only structural validation of an imported (or any) DSH session: event structure ' +
      '(seq continuity / type whitelist / surfaceOp / sourceEventSeqs pointing at tool/call), ' +
      'turn balance (turn/step pairing), and tool pairing (every tool/call has a tool/result ' +
      'and vice versa). Call this to diagnose a session that fails to resume or misbehaves. ' +
      'Zero side effects: list + readFrom only, never load/prepare or rewrite. Issues are ' +
      'reported per item (kind + seq + message, capped at 20); repairHints give per-kind fixes ' +
      '(re-import / close half-open turns / source transcript boundary notes); failures are ' +
      'loud. Returns { ok, problems, repairHints }.',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'DSH session id to validate (required).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['single'], required: true },
          sessionId: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          eventCount: { type: 'integer', required: true },
          turns: { type: 'integer', required: true },
          title: { type: 'string' },
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
          repairHints: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                hint: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: '会话 ' + value.sessionId + '（' + value.turns + ' 轮、' + value.eventCount + ' 条事件）'
          + (value.ok ? '：结构校验通过 ✅'
            : '：发现 ' + value.problems.length + ' 个问题\n'
              + value.problems.slice(0, 10).map((p) => '  - [' + p.kind + '] ' + (p.seq !== null ? 'seq ' + p.seq + '：' : '') + p.message).join('\n')
              + (value.repairHints.length ? '\n修复建议：\n' + value.repairHints.map((h) => '  - ' + h.kind + '：' + h.hint).join('\n') : '')),
      }],
    },
    async execute(args) {
      return verifySession(ctx, args)
    },
  }))
  // REQ-36 反向同步（双向同步桥 B 第一步）：把 DSH 会话新增轮次增量写回 Claude Code
  // JSONL（目标 = 导入源文件或 export_chat format=claude 副本）。写回核心在
  // lib/backfill.mjs（纯逻辑 + ctx 注入，零 DSH 依赖）；uuid 工厂经 syncClaudeSession
  // 的 args.uuid 注入（测试确定性），工具 schema 不暴露它。
  ctx.tools.register(defineTool({
    name: 'sync_to_claude',
    description:
      'Write back new complete turns from a DSH session into its Claude Code JSONL source, so ' +
      'the changes are resumable in real Claude Code (--resume). Call this after continuing an ' +
      'imported conversation inside DSH, when you want the source transcript to catch up. ' +
      'target:"source" (default) writes back to the original imported file; target:"copy" ' +
      'writes back to a copy previously produced by export_chat format=claude (must be exported ' +
      'first). Guards never overwrite silently: sourceShrunk, source modified externally, ' +
      'tail uuid/watermark mismatch, and concurrent writer version mismatch are all skipped and ' +
      'reported; force:true skips the guards and re-anchors on the current file (watermark + ' +
      'tail). Only turn/end-closed complete turns are written (half-open in-progress turns are ' +
      'not, reported as incompleteFinalTurn); dryRun only computes, never writes. Returns ' +
      'status: synced | no-new-turns | skipped plus the writeback watermark.',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'DSH session id to write back (must be imported by this plugin, carrying a session/imported marker).',
      },
      target: {
        type: 'string',
        description: "Optional: 'source' (default, the imported source file) | 'copy' (a copy from export_chat format=claude; must be exported first).",
      },
      force: {
        type: 'boolean',
        description: 'Optional: true skips the guards and re-anchors on the current file (watermark + tail); may overwrite external edits; default false.',
      },
      dryRun: {
        type: 'boolean',
        description: 'Optional: true fully computes (incl. format precheck) without writing or updating the registry.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['single'], required: true },
          status: { type: 'string', required: true, enum: ['synced', 'no-new-turns', 'skipped'] },
          sessionId: { type: 'string', required: true },
          sourcePath: { type: 'string', required: true },
          target: { type: 'string', required: true, enum: ['source', 'copy'] },
          filePath: { type: 'string', required: true },
          appendedTurns: { type: 'integer' },
          appendedEvents: { type: 'integer' },
          appendedRecords: { type: 'integer' },
          conflictDetected: { type: 'string', enum: ['source-modified-externally', 'tail-mismatch', 'write-version-mismatch'] },
          sourceShrunk: { type: 'boolean' },
          storedShrunk: { type: 'boolean' },
          incompleteFinalTurn: { type: 'boolean' },
          precheckFailed: { type: 'boolean' },
          rollbackError: { type: 'string' },
          reason: { type: 'string' },
          precheck: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              recordCount: { type: 'integer' },
              lastUuid: { type: 'string' },
              errors: {
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
            },
          },
          dryRun: { type: 'boolean', required: true },
          writeback: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessionUuid: { type: 'string', required: true },
              filePath: { type: 'string', required: true },
              lastWrittenSeq: { type: 'integer', required: true },
              lastWrittenTurn: { type: 'integer' },
              prevUuid: { type: 'string' },
              lastSize: { type: 'integer', required: true },
              lastVersion: { type: 'string', required: true },
              writtenAt: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (args, value) => {
        const where = value.target === 'copy' ? '导出副本' : '源文件'
        if (value.status === 'skipped') {
          let why
          if (value.sourceShrunk) why = '源文件缩小（sourceShrunk），跳过写回'
          else if (value.conflictDetected === 'source-modified-externally') why = '源文件被外部修改（size/version 变化），跳过写回'
          else if (value.conflictDetected === 'tail-mismatch') why = '文件尾 uuid 与写回水印失配（tail-mismatch），跳过写回'
          else if (value.conflictDetected === 'write-version-mismatch') why = '并发写者已改动文件（write-version-mismatch），跳过写回'
          else if (value.storedShrunk) why = 'DSH 会话日志比写回水印短（storedShrunk），跳过写回'
          else if (value.precheckFailed) why = '写回预检失败（格式校验不通过），已回滚'
          else why = value.reason || '跳过写回'
          return [{ type: 'text', text: '会话 ' + value.sessionId + ' ' + why + '（' + where + '）。' }]
        }
        if (value.status === 'no-new-turns') {
          return [{ type: 'text', text: '会话 ' + value.sessionId + ' 无新增完整轮次'
            + (value.incompleteFinalTurn ? '（存在进行中的半开轮次，闭合后再同步）' : '')
            + '（' + where + '）。' }]
        }
        return [{ type: 'text', text: (value.dryRun ? '写回预览（dryRun，未写盘）：' : '已写回：')
          + '会话 ' + value.sessionId + ' → ' + value.filePath
          + '（' + value.appendedTurns + ' 轮、' + value.appendedEvents + ' 条事件、' + value.appendedRecords + ' 条记录'
          + (value.conflictDetected || value.sourceShrunk ? '，force 覆盖守卫：' + (value.conflictDetected || 'sourceShrunk') : '')
          + '）。' }]
      },
    },
    async execute(args) {
      return syncClaudeSession(ctx, args, { registryDir })
    },
  }))
  // REQ-33 导入识别 / 撤回（只读）：平台无 delete 面（sessionPersistence.remove /
  // fs.removeFile 未提供，见 lib/retract.mjs 段落）——list_imported_sessions 只读
  // 识别（标记权威 + registry 兜底），retract_import 移除 registry 记录 + 引导手动删
  // 工件，绝不调用任何删除。
  ctx.tools.register(defineTool({
    name: 'list_imported_sessions',
    description:
      'Read-only listing of every DSH session imported by this plugin. Sessions are filtered ' +
      'by the session/imported marker in their log head (authoritative; when the log is ' +
      'unreadable the imports registry dshId set is used as fallback) — sessions without the ' +
      'marker never appear. Call this to see what is imported and where its source artifact ' +
      'lives. Each hit returns sessionId / title (from session/title event, omitted when no ' +
      'explicit title) / sourcePath / artifactPath (sessionPersistence.locate) / importedAt. ' +
      'Zero side effects: no writes, no registry updates, no deletions. Returns { total, sessions }.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          sessions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string', required: true },
                title: { type: 'string' },
                sourcePath: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                artifactPath: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                importedAt: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: '已识别导入会话 ' + value.total + ' 个' + (value.total === 0 ? '' : '\n' + value.sessions.map((s) =>
          '  - ' + s.sessionId + (s.title ? '《' + s.title + '》' : '') + ' ← ' + s.sourcePath
          + '\n    工件路径：' + (s.artifactPath || '无（后端无单会话工件）')).join('\n')),
      }],
    },
    async execute() {
      return listImportedSessions(ctx, registryDir)
    },
  }))
  ctx.tools.register(defineTool({
    name: 'retract_import',
    description:
      'Read-only guided un-import: drop an imported session from the imports registry and ' +
      'print the manual-delete steps for its artifact. Call this to undo an import. Never ' +
      'deletes sessions or artifacts itself (the platform sessionPersistence has no delete ' +
      'surface; this plugin never calls any deletion). Pass sessionId or sourcePath: sessionId ' +
      'locates the source file via the session/imported marker in the log (the marker stays in ' +
      'the log, so repeated retracts are idempotent); sourcePath directly removes the registry ' +
      'record by its idempotency key. After the record is removed, deleting the artifact copy ' +
      'and re-importing yields a fresh import (while the copy remains, re-import is skipped as ' +
      'an idempotent legacy backfill; if the host still holds a stale ghost id in memory, ' +
      're-import auto-casts a suffixed new id and reports staleGhost). Returns removed:true ' +
      'and the manualDelete guide (artifact path via sessionPersistence.locate).',
    parameters: {
      sessionId: {
        type: 'string',
        description: 'DSH session id to retract (alternative to sourcePath; source file located via log marker / registry).',
      },
      sourcePath: {
        type: 'string',
        description: 'Source file path to retract (alternative to sessionId; directly removes the registry record by idempotency key).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'boolean', required: true, const: true },
          sourcePath: { type: 'string', required: true },
          artifactPath: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          wasRegistered: { type: 'boolean', required: true },
          manualDelete: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: '已撤回：registry 记录 ' + value.sourcePath + ' 已移除'
          + (value.wasRegistered ? '' : '（此前已移除，幂等）') + '。\n' + value.manualDelete,
      }],
    },
    async execute(args) {
      return retractImport(ctx, args, registryDir)
    },
  }))
  // REQ-25/REQ-40 会话发现：只读扫描（发现核心在 lib/discovery.mjs，host 适配见
  // lib/discovery-host.mjs；30s TTL 缓存进程内共享 + 持久化 mtime 书签跨进程免重扫）。
  // 零副作用：不写库、不 create/append，registry 只读 loadImports 供 importStatus
  // 标注（书签文件是缓存元数据，非会话数据）。
  ctx.tools.register(defineTool({
    name: 'scan_discover',
    description:
      'Read-only scan of the local default data roots for 17 external chat formats (Claude ' +
      'Code, Codex, Cursor, Gemini CLI, Reasonix, opencode, mimocode, zcode, Grok Build, ' +
      'OpenClaw, Pi, Hermes, Kimi CLI, Qoder CLI, ChatGPT exports, WorkBuddy, DSH session ' +
      'logs), returning a structured session index (format / sessionId / title / project / ' +
      'cwd / createdAt / lastActiveAt / messageCount / sourcePath / gitBranch / gitDirty / ' +
      'importStatus) to preview before batch import. path optional: when given, probes that ' +
      'root only (directory or single file); default scans all formats default roots. format ' +
      'optional: scan one format only (chatgpt has no auto root — point path at ' +
      'conversations.json; dsh default root is ~/.dsh/sessions). query optional: substring ' +
      'filter on title / project / path (case-insensitive). In-process 30s TTL cache: ' +
      'repeated scans of the same key within 30s hit the cache without re-reading sources. ' +
      'Persistent mtime/size bookmarks (scan-cache.json): unchanged files skip re-scanning ' +
      'across process restarts. Read-only: no DB writes, no create/append, no session or ' +
      'registry mutation. Returns { sessions, total }.',
    parameters: {
      path: {
        type: 'string',
        description: 'Optional: scan root (directory or single file, e.g. ~/.claude/projects, a .jsonl, or conversations.json). Default scans all formats default roots.',
      },
      format: {
        type: 'string',
        enum: FORMATS,
        description: 'Optional: scan only this format; default probes all formats by path.',
      },
      query: {
        type: 'string',
        description: 'Optional: substring filter on title / project / path (case-insensitive).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          sessions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                format: { type: 'string', enum: FORMATS, required: true },
                sessionId: { type: 'string', required: true },
                title: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                project: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                createdAt: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                lastActiveAt: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                messageCount: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                sourcePath: { type: 'string', required: true },
                cwd: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                gitBranch: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                gitDirty: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
                importStatus: { type: 'string', enum: ['imported', 'partial', 'not-imported', 'archived'], required: true },
              },
            },
          },
        },
      },
      render: (args, value) => {
        const byFormat = {}
        for (const s of value.sessions) byFormat[s.format] = (byFormat[s.format] || 0) + 1
        const formatBits = Object.entries(byFormat).map(([f, n]) => f + ' ' + n)
        const imported = value.sessions.filter((s) => s.importStatus === 'imported').length
        const partial = value.sessions.filter((s) => s.importStatus === 'partial').length
        const archived = value.sessions.filter((s) => s.importStatus === 'archived').length
        const pending = value.sessions.filter((s) => s.importStatus === 'not-imported').length
        const statusBits = ['已导入 ' + imported]
        if (partial) statusBits.push('部分 ' + partial)
        if (archived) statusBits.push('已归档 ' + archived)
        statusBits.push('未导入 ' + pending)
        return [{
          type: 'text',
          text: '扫描完成：共发现 ' + value.total + ' 个会话（' + formatBits.join('、') + '；'
            + statusBits.join('、') + '）' + (args.query ? '（query=' + args.query + '）' : ''),
        }]
      },
    },
    async execute(args) {
      return runScanDiscover(ctx, args, registryDir)
    },
  }))
}
