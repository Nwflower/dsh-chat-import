// lib/tools.mjs — 15 个工具的注册（import_chat 分发器 + import_agents + doctor +
// import_mcp + import_settings + export_claude/codex/kimi + export_bundle/restore_bundle +
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
  convertHermesJson, convertKimiWire, convertQoderJsonl, convertWorkbuddyJsonl, convertDshJsonl, convertLocalJsonl,
} from '../convert.mjs'
import { openclawDisplayNames } from './convert/openclaw.mjs'
import { markTrimmedSource } from './budget.mjs'
import { runDecision, collectJsonFiles } from './import-core.mjs'
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
import { greedyDecodeSlugPath } from './cwd-map.mjs'

export function registerTools(ctx, registryDir) {
  // 声明 TOOL_RUNTIME_SCHEDULER 命名导入：一旦解析到旧副本 dsh-tools@0.0.1-rc.1
  //（只导出 TOOL_REGISTRY_SCHEDULER），模块加载即失败并大声报错，而不是静默用旧
  // ABI 注册工具、最终让宿主 agent-loop 在调度时崩溃
  //（Cannot read properties of undefined (reading 'prepare')）并污染会话历史。
  if (typeof TOOL_RUNTIME_SCHEDULER !== 'symbol') {
    throw new Error('dsh-chat-import: resolved @deepseek-ai/dsh-tools lacks TOOL_RUNTIME_SCHEDULER — requires ^0.1.0-rc.6')
  }
  // REQ-09 分组 spec：derive/io/label/registry 子对象，新源加一行即可；工具层
  // 专属参数（compacted/branch/sessionIds/fullHistory/lineage/parseFormat）与 format
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
    // cursor：行内无会话 id，用文件名（composer uuid）作稳定 id，保证幂等
    {
      format: 'cursor',
      sourceLabel: 'Cursor',
      convert: convertCursorJsonl,
      registry: { dir: registryDir },
      derive: {
        args: (target) => {
          const p = target.displayPath || ctx.fs.processPath(target)
          const base = String(p).split(/[\\/]/).pop() || ''
          return { cursorId: base.replace(/\.jsonl$/i, '') }
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
        args: async (target) => {
          const p = target.displayPath || ctx.fs.processPath(target)
          const base = String(p).split(/[\\/]/).pop() || ''
          const stem = base.replace(/\.jsonl$/i, '')
          const derived = { reasonixId: stem }
          try {
            // meta 与 transcript 同目录：<stem>.meta.json
            const metaPath = String(p).replace(/[\\/][^\\/]*\.jsonl$/i, '') + '\\' + stem + '.meta.json'
            const metaTarget = await ctx.fs.resolve(metaPath)
            const raw = await ctx.fs.readText(metaTarget)
            const meta = JSON.parse(raw)
            if (meta && typeof meta.workspace === 'string' && meta.workspace) derived.cwd = meta.workspace
            if (meta && typeof meta.summary === 'string' && meta.summary.trim()) derived.title = meta.summary.trim()
          } catch {
            // meta 缺失（子代理或旧文件）不致命：仍按 stem 导入，仅无 cwd/标题
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
          try {
            // REQ-22：WAL 与 checkpoint 同目录：<stem>.events.jsonl（V2 事件日志权威，
            // 自动合并；无 WAL 的旧版本/子代理文件自然回退纯 checkpoint）
            const walPath = String(p).replace(/[\\/][^\\/]*\.jsonl$/i, '') + '\\' + stem + '.events.jsonl'
            const walTarget = await ctx.fs.resolve(walPath)
            derived.walText = await ctx.fs.readText(walTarget)
          } catch {
            // 无 WAL：纯 checkpoint 导入
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
      '把 pi（~/.pi/agent/{agents,prompts}）、opencode（~/.config/opencode/{agents,skill}）、' +
      'Claude（~/.claude/memory/<group>/*.md、~/.claude/skills/<skill>/SKILL.md、项目 CLAUDE.md）与 ' +
      'Codex（~/.codex/skills/<skill>/SKILL.md、~/.codex/instructions.md、~/.codex/AGENTS.md、~/.codex/config.toml）的 ' +
      '自定义 agent / mode prompt / skill / 指令 / 配置参考转换为 DSH 持久化 skill 资产：' +
      '$DSH_AGENTS_HOME/skills/<name>/SKILL.md（$DSH_AGENTS_HOME 缺省 ~/.agents）。' +
      '缺省 dry-run：只返回 write/complete/skip 规划清单（零副作用）；apply:true 才落盘。' +
      '语义：同名冲突加 -<source> 后缀消歧、内容相同幂等跳过、已带 kind:dsh 的源不重复导入、' +
      'bundle 目录缺 SKILL.md 时原地补全（保留既有 scripts/ 等）。返回规划/落盘明细。',
    parameters: {
      apply: {
        type: 'boolean',
        description: '可选：true 时实际写盘（缺省 false = dry-run 预览，零副作用）。',
      },
      piRoot: {
        type: 'string',
        description: '可选：pi 根目录（默认 ~/.pi/agent）。',
      },
      opencodeRoot: {
        type: 'string',
        description: '可选：opencode 配置根（默认 ~/.config/opencode）。',
      },
      agentsHome: {
        type: 'string',
        description: '可选：DSH user-agents 根（默认 $DSH_AGENTS_HOME 或 ~/.agents），skills 写到其下 skills/。',
      },
      claudeRoot: {
        type: 'string',
        description: '可选：Claude 配置根（默认 ~/.claude），收集 memory/<group>/*.md 与 skills/<skill>/SKILL.md。',
      },
      claudeProjectRoot: {
        type: 'string',
        description: '可选：项目根目录（含 CLAUDE.md 时落为 claude-md 资产；不指定则跳过项目 CLAUDE.md）。',
      },
      codexRoot: {
        type: 'string',
        description: '可选：Codex 配置根（默认 ~/.codex），收集 skills/instructions.md/AGENTS.md/config.toml。',
      },
      preview: {
        type: 'boolean',
        description: '可选：dry-run 别名（与缺省行为一致，显式声明零副作用）。',
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
  // REQ-66 doctor：迁移后健康检查（对标 dsh-movein doctor）。只读，不写任何文件。
  ctx.tools.register(defineTool({
    name: 'doctor',
    description:
      '只读健康检查：imports registry 是否可读、已导入会话是否仍存在于 sessionPersistence、' +
      'DSH user-agents skills 是否落盘、workspaceRegistry 是否可用。对标 dsh-movein doctor，' +
      '不写文件、不触发导入/同步/删除。返回 checks/issues/totals。',
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
      '读取 Claude .mcp.json / ~/.claude.json 与 Codex config.toml 的 MCP server 配置，' +
      '生成可人工审阅的 DSH MCP client YAML 片段。默认 dry-run（零写盘）；apply:true 时' +
      '把片段写到 $DSH_HOME/dsh-chat-import/mcp-mirror.cordis.yml（或 outPath），' +
      '不会自动修改 profile 的 cordis.patch.yml——合并前请人工核对 dsh-mcp-client 契约。',
    parameters: {
      claudeMcpPath: {
        type: 'string',
        description: '可选：Claude MCP 配置文件路径（默认 ~/.claude.json；也兼容项目 .mcp.json 内容）。',
      },
      codexConfigPath: {
        type: 'string',
        description: '可选：Codex config.toml 路径（默认 ~/.codex/config.toml）。',
      },
      apply: {
        type: 'boolean',
        description: '可选：true 时写盘生成片段（默认 false = dry-run）。',
      },
      outPath: {
        type: 'string',
        description: '可选：apply 时输出路径（默认 $DSH_HOME/dsh-chat-import/mcp-mirror.cordis.yml）。',
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
      '只读解析 Claude settings.json 与 Codex config.toml 的关键配置（model / permissions / hooks / env / model_provider），' +
      '返回迁移到 DSH 时的建议与不可直接映射项。不写任何文件、不自动应用。',
    parameters: {
      claudeSettingsPath: {
        type: 'string',
        description: '可选：Claude settings.json 路径（默认 ~/.claude/settings.json）。',
      },
      codexConfigPath: {
        type: 'string',
        description: '可选：Codex config.toml 路径（默认 ~/.codex/config.toml）。',
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
  // REQ-16 反向导出：独立注册（导出流程与导入状态机完全不同）。
  ctx.tools.register(defineTool({
    name: 'export_claude',
    description:
      '把 DSH 会话日志（只读，不 load/prepare、不改写历史事件）序列化为 Claude Code JSONL 并写入 ' +
      '<outputDir>/<slug>/<uuid>.jsonl，可被真实 Claude Code --resume 续聊。' +
      '参数：sessionId 必填；cwd 可选（默认取会话 header.cwd，两者皆无则报错）；' +
      'outputDir 可选（默认 ~/.claude/projects）；dryRun 可选（只序列化不写盘）。' +
      'user/assistant/tool_result 按 seq 顺序映射，tool_result 挂在声明其 tool_use 的 assistant 上（' +
      '并行结果扇出同一 assistant）；中断会话末尾补发空 tool_result；孤儿结果丢弃并计数；' +
      '非人类注入跳过计数。返回目标文件路径、记录数与 mapping（sourceSessionId → 新 uuid，imports registry 预留）。',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: '要导出的 DSH 会话 id（必填）。',
      },
      cwd: {
        type: 'string',
        description: '可选：覆盖导出记录的 cwd（默认取会话 header.cwd；两者皆无则报错）。',
      },
      outputDir: {
        type: 'string',
        description: '可选：Claude Code projects 根目录（默认 ~/.claude/projects），文件写到 <outputDir>/<slug>/<uuid>.jsonl。',
      },
      dryRun: {
        type: 'boolean',
        description: '可选：true 时不写盘，只序列化并返回目标路径与统计。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['single'], required: true },
          sessionId: { type: 'string', required: true },
          sourceSessionId: { type: 'string', required: true },
          filePath: { type: 'string', required: true },
          slug: { type: 'string', required: true },
          cwd: { type: 'string', required: true },
          recordCount: { type: 'integer', required: true },
          title: { type: 'string' },
          dryRun: { type: 'boolean', required: true },
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
          mapping: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              sourceSessionId: { type: 'string', required: true },
              sessionUuid: { type: 'string', required: true },
              slug: { type: 'string', required: true },
              filePath: { type: 'string', required: true },
              turns: { type: 'integer', required: true },
              messages: { type: 'integer', required: true },
              toolCalls: { type: 'integer', required: true },
              toolResults: { type: 'integer', required: true },
              droppedToolResults: { type: 'integer', required: true },
              skippedInjections: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (args, value) => {
        // REQ-21：降级逐条报告（孤儿结果/注入跳过/附件跳过），不静默
        const degNote = (value.degradations || []).map((d) => d.id + ' ' + d.count).join('、')
        return [{
          type: 'text',
          text: (value.dryRun ? '导出预览（dryRun，未写盘）：' : '已导出：')
            + '会话 ' + value.sourceSessionId + ' → ' + value.filePath
            + '（' + value.recordCount + ' 条记录、' + value.mapping.toolCalls + ' 次工具调用'
            + (degNote ? '；降级：' + degNote : '') + '）',
        }]
      },
    },
    async execute(args) {
      return exportClaudeSession(ctx, args, { registryDir })
    },
  }))
  // REQ-56/62 export_bundle / restore_bundle：DSH 会话 → interchange bundle（SHA-256
  // 双层指纹 + 事件级无损 + 跨机器落点信息），还原 = 指纹校验 → convertDshJsonl
  // 状态机（幂等键 = bundle 路径）；跨机器 cwd 不可达走 REQ-39-lite 回退归组并报告
  //（不静默）。bundle 格式见 docs/INTERCHANGE.md §4。
  ctx.tools.register(defineTool({
    name: 'export_bundle',
    description:
      '把 DSH 会话导出为通用 interchange bundle（REQ-56）：SHA-256 双层指纹（会话级 + 文件级，' +
      '损坏可检测）、事件级无损（还原 = 可继续 DSH 会话）、携带跨机器落点信息（originalCwd + ' +
      'landingHint，REQ-62）。' +
      '参数：sessionId 必填；path 可选（输出文件路径，缺省 <outputDir>/<sessionId>.dshbundle.json）；' +
      'outputDir 可选（默认 ~/.dsh/exports）；dryRun 可选（只序列化不写盘）。' +
      '只读会话日志（list + readFrom），绝不改写历史事件；写盘 createIfAbsent 不覆盖。' +
      '返回目标文件路径、双层指纹与落点信息。',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: '要导出的 DSH 会话 id（必填）。',
      },
      path: {
        type: 'string',
        description: '可选：输出文件路径（缺省 <outputDir>/<sessionId>.dshbundle.json）。',
      },
      outputDir: {
        type: 'string',
        description: '可选：输出目录（默认 ~/.dsh/exports），文件写到 <outputDir>/<sessionId>.dshbundle.json。',
      },
      dryRun: {
        type: 'boolean',
        description: '可选：true 时不写盘，只序列化并返回目标路径与指纹。',
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
      '把 interchange bundle（export_bundle 产物）还原为可继续的 DSH 会话（REQ-56/62）。' +
      '校验双层 SHA-256 指纹（损坏检测，不匹配大声报错不静默）→ 事件级无损还原（复用 ' +
      'import_dsh 状态机，幂等键 = bundle 路径；重复还原跳过、force:true 另存副本）。' +
      '跨机器（REQ-62）：bundle 的 originalCwd 在另一台机器不可达时按 REQ-39-lite 回退' +
      '归组到 bundle 文件所在目录，结果报告 cwdAvailable:false + groupedTo + restoreNote。' +
      '参数：path 必填（bundle 文件或含 .dshbundle.json 的目录）；sessionId 可选（覆盖还原' +
      '会话 id）；preview/dryRun 可选（dry-run 预览零副作用）；force/recursive 同导入语义。' +
      '返回还原状态（imported / already-imported / skipped）与跨机器落点报告。',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'interchange bundle 文件（.dshbundle.json）的路径，或包含 .dshbundle.json 的目录路径（目录模式逐文件还原）。',
      },
      sessionId: {
        type: 'string',
        description: '可选：覆盖还原出的 DSH 会话 id（默认 import-<源会话 id>）。',
      },
      force: {
        type: 'boolean',
        description: '可选：true 时即使已还原也以新 id 另存完整副本，旧会话原样保留。',
      },
      preview: {
        type: 'boolean',
        description: '可选：true 时 dry-run 预览——不落盘、不写 registry、不归组，仅返回将还原会话清单。',
      },
      dryRun: {
        type: 'boolean',
        description: '可选：preview 的兼容别名（语义相同）。',
      },
      recursive: {
        type: 'boolean',
        description: '可选：目录模式是否递归子目录（默认 true）。',
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
          alreadyImported: { type: 'boolean' },
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
  // REQ-23 矩阵化互转：export_codex / export_kimi 与 export_claude 同构（只读会话
  // 日志 → 目标格式 JSONL，createIfAbsent 不覆盖、dryRun、降级报告），补齐
  // DSH↔Claude↔Codex↔Kimi 四向矩阵的 DSH→Codex / DSH→Kimi 两条出边（入边由
  // import_chat format=codex/kimi 覆盖；Claude 双向由 export_claude + import_chat
  // format=claude 覆盖）。
  for (const [toolName, ext, serialize, label] of [
    ['export_codex', 'rollout.jsonl', 'codex', 'Codex rollout JSONL'],
    ['export_kimi', 'wire.jsonl', 'kimi', 'Kimi CLI wire.jsonl'],
  ]) {
    ctx.tools.register(defineTool({
      name: toolName,
      description:
        '把 DSH 会话日志（只读，不 load/prepare、不改写历史事件）序列化为 ' + label + ' 并写入 ' +
        'path（或 <outputDir>/<sessionId>.' + ext + '，outputDir 缺省 ~/.dsh/exports），' +
        '可被 import_chat format=' + serialize + ' 再导入（矩阵化互转）。' +
        '参数：sessionId 必填；path 可选（输出文件路径）；outputDir 可选；dryRun 可选。' +
        '降级逐条报告（REQ-21）；返回目标文件路径、记录数与工具计数。',
      parameters: {
        sessionId: { type: 'string', required: true, description: '要导出的 DSH 会话 id（必填）。' },
        path: { type: 'string', description: '可选：输出文件路径（缺省 <outputDir>/<sessionId>.' + ext + '）。' },
        outputDir: { type: 'string', description: '可选：输出目录（默认 ~/.dsh/exports）。' },
        dryRun: { type: 'boolean', description: '可选：true 时不写盘，只序列化并返回目标路径与统计。' },
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
            toolCalls: { type: 'integer', required: true },
            toolResults: { type: 'integer', required: true },
            dryRun: { type: 'boolean', required: true },
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
        render: (args, value) => [{
          type: 'text',
          text: (value.dryRun ? '导出预览（dryRun，未写盘）：' : '已导出：')
            + '会话 ' + value.sessionId + ' → ' + value.filePath
            + '（' + value.recordCount + ' 条记录、' + value.toolCalls + ' 次工具调用'
            + ((value.degradations || []).length ? '；降级：' + value.degradations.map((d) => d.id + ' ' + d.count).join('、') : '') + '）',
        }],
      },
      async execute(args) {
        return serialize === 'codex' ? exportCodexSession(ctx, args) : exportKimiSession(ctx, args)
      },
    }))
  }
  ctx.tools.register(defineTool({
    name: 'verify_session',
    description:
      '只读校验已导入/任意 DSH 会话的结构（REQ-23）：事件结构（seq 连续 / 类型白名单 / ' +
      'surfaceOp / sourceEventSeqs 指向 tool/call）、回合平衡（turn/step 配对）、工具配对' +
      '（每个 tool/call 有 tool/result、每个 tool/result 有对应调用）。' +
      '零副作用：list + readFrom 只读，绝不 load/prepare、绝不改写。' +
      '问题逐条定位（kind + seq + message，封顶 20 条），repairHints 按 kind 给出修复建议' +
      '（重导 / 闭合半开轮 / 源转录边界说明），失败大声不静默。返回 { ok, problems, repairHints }。',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: '要校验的 DSH 会话 id（必填）。',
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
  // JSONL（目标 = 导入源文件或 export_claude 副本）。写回核心在 lib/backfill.mjs
  //（纯逻辑 + ctx 注入，零 DSH 依赖）；uuid 工厂经 syncClaudeSession 的 args.uuid
  // 注入（测试确定性），工具 schema 不暴露它。
  ctx.tools.register(defineTool({
    name: 'sync_to_claude',
    description:
      '反向同步（REQ-36）：把 DSH 会话新增完整轮次增量写回 Claude Code JSONL，' +
      '供真实 Claude Code --resume 续聊。目标 target:"source"（默认）写回导入源文件，' +
      'target:"copy" 写回上次 export_claude 导出的副本（需先导出）。' +
      '守卫不静默覆盖：源文件缩小（sourceShrunk）、被外部修改（source-modified-externally）、' +
      '文件尾 uuid 与写回水印失配（tail-mismatch）、并发写者（write-version-mismatch）一律跳过并上报；' +
      'force:true 跳过三闸并以当前文件重锚定（水印 + 链尾）。' +
      '只写由 turn/end 闭合的完整轮（半开进行中轮次不写，报 incompleteFinalTurn）；' +
      'dryRun 只计算不写盘。返回 status: synced | no-new-turns | skipped 与写回水印。',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: '要写回的 DSH 会话 id（必须是由本插件导入的会话，带 session/imported 标记）。',
      },
      target: {
        type: 'string',
        description: "可选：写回目标 'source'（默认，导入源文件）| 'copy'（export_claude 导出的副本，需先导出）。",
      },
      force: {
        type: 'boolean',
        description: '可选：true 时跳过三闸守卫并以当前文件重锚定（水印 + 链尾），可能覆盖外部修改；默认 false。',
      },
      dryRun: {
        type: 'boolean',
        description: '可选：true 时完整计算（含格式预检）但不写盘、不更新 registry。',
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
      '只读列出本插件导入的全部 DSH 会话（REQ-33）：按会话日志首事件 session/imported 标记筛选' +
      '（标记是权威信号；日志读不到时用 imports registry 的 dshId 集合兜底），无标记会话不出现。' +
      '每个命中会话返回 sessionId / title（session/title 事件，无显式标题则省略）/ sourcePath / ' +
      'artifactPath（sessionPersistence.locate 报工件路径）/ importedAt。' +
      '零副作用：不落盘、不写 registry、不调用任何删除。返回 { total, sessions }。',
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
      '撤回（只读引导，REQ-33）：识别导入会话并移除其 imports registry 记录，输出手动删除工件路径。' +
      '绝不删除会话或工件（平台 sessionPersistence 无 delete 面，本插件不调用任何删除）。' +
      '入参 sessionId 或 sourcePath 二选一：sessionId 从会话日志 session/imported 标记定位源文件' +
      '（标记留在日志，重复撤回幂等）；sourcePath 直接按 registry 幂等键移除。' +
      'registry 记录移除后，按引导删除工件副本再重导即全新导入（副本仍在时重导按 legacy 回填基线幂等跳过；' +
      '宿主内存残留幽灵 id 时重导自动另铸后缀新 id 并报告 staleGhost，issue #22）。' +
      '返回 removed:true 与 manualDelete 引导' +
      '（工件路径由 sessionPersistence.locate 给出）。',
    parameters: {
      sessionId: {
        type: 'string',
        description: '要撤回的 DSH 会话 id（与 sourcePath 二选一；从日志标记 / registry 定位源文件）。',
      },
      sourcePath: {
        type: 'string',
        description: '要撤回的源文件路径（与 sessionId 二选一；直接按 registry 幂等键移除记录）。',
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
      '只读扫描本机 15 种外部聊天记录格式的已知数据根（Claude Code / Codex / Cursor / ' +
      'Gemini CLI / Reasonix / opencode / zcode / Grok Build / OpenClaw / Pi Coding Agent / ' +
      'Hermes / Kimi CLI / Qoder CLI / ChatGPT 导出 / DSH 会话日志），返回结构化会话索引（format / sessionId / title / project / cwd / ' +
      'createdAt / lastActiveAt / messageCount / sourcePath / gitBranch / gitDirty / importStatus），供批导入前预览。' +
      'path 可选：给定时在该根下按格式探测（目录或单文件）；缺省扫全部格式的默认数据根。' +
      'format 可选：只扫指定格式（chatgpt 无自动根，需 path 显式指向 conversations.json；dsh 默认根为 ~/.dsh/sessions）。' +
      'query 可选：按标题 / 项目 / 路径子串过滤（忽略大小写）。' +
      '进程内 30s TTL 缓存：同 key 30 秒内重复扫描直接命中，不重读源文件。' +
      '持久化 mtime/size 书签（scan-cache.json）：跨进程重启后未变文件免重扫。' +
      '只读工具：不写库、不 create/append、不修改任何会话或 registry。返回 { sessions, total }。',
    parameters: {
      path: {
        type: 'string',
        description: '可选：扫描根（目录或单文件，如 ~/.claude/projects、某个 .jsonl 或 conversations.json）。缺省扫全部格式的默认数据根。',
      },
      format: {
        type: 'string',
        enum: FORMATS,
        description: '可选：只扫指定格式；缺省按路径探测全部格式。',
      },
      query: {
        type: 'string',
        description: '可选：按标题 / 项目 / 路径子串过滤（忽略大小写）。',
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