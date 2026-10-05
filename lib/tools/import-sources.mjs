// lib/tools/import-sources.mjs — import_chat 的来源 spec 表（每个来源一行：转换器 /
// 编排 io / 派生 derive / 批量标签 label / registry 指纹键）
//
// buildImportSources(ctx, registryDir) 产出全部来源 spec，由 lib/toolkit.mjs 的
// makeImportChatTool 收敛为单一 import_chat 分发器并登记进 IMPORT_SPECS（面板 / 命令
// 复用同一 spec）。特殊形态来源（chatgpt / grokbuild / hermes / kimi）的编排在
// lib/import-variants.mjs；SQLite 库类来源的编排与预览在 lib/sources/<src>.mjs。
// 依赖 ctx（derive 经 ctx.fs 旁读 sidecar），非纯函数。

import { join } from 'node:path'
import {
  convertClaudeJsonl, convertChatgptJson, convertCursorJsonl,
  convertGeminiJson, convertReasonixJsonl, convertPiJsonl, convertOpencodeJson,
  convertAntigravityJsonl, indexTaskMessages, parseAnnotationTitle,
  convertMimocodeJson, convertKilocodeJson, convertZcodeJson, convertGrokbuildJson, convertOpenclawJson,
  convertTeleagentJson,
  convertHermesJson, convertKimiWire, convertQoderJsonl, convertWorkbuddyJsonl, convertQwenJsonl, convertDshJsonl, convertLocalJsonl,
  convertContinueJson, readContinueIndex, convertClineJson, convertGooseJson, convertZedJson, convertCrushJson, convertTraeJson, convertVibeJson,
} from '../convert/index.mjs'
import { importVibeFile, importVibeDirectory, previewVibeFile, previewVibeDirectory, vibeIsSessionDir } from '../sources/vibe.mjs'
import { openclawDisplayNames } from '../convert/openclaw.mjs'
import { clineDeriveArgs, collectClineFiles } from '../sources/cline.mjs'
import { importGooseFile, importGooseDirectory, previewGooseFile, previewGooseDirectory } from '../sources/goose.mjs'
import { importZedFile, importZedDirectory, previewZedFile, previewZedDirectory } from '../sources/zed.mjs'
import { importCodexFile, importCodexDirectory, previewCodexFile, previewCodexDirectory } from '../sources/codex.mjs'
import { importCrushFile, importCrushDirectory, crushDeriveArgs, previewCrushFile, previewCrushDirectory } from '../sources/crush.mjs'
import { markTrimmedSource } from '../budget.mjs'
import { runDecision, collectJsonFiles, collectJsonlFiles } from '../import-core.mjs'
import { parseReasonixSemantic, selectReasonixMaximalBranches } from '../convert/reasonix-lineage.mjs'
import { importOpencodeFile, importOpencodeDirectory, previewOpencodeFile, previewOpencodeDirectory } from '../sources/opencode.mjs'
import { importMimocodeFile, importMimocodeDirectory, previewMimocodeFile, previewMimocodeDirectory } from '../sources/mimocode.mjs'
import { importTeleagentFile, importTeleagentDirectory, previewTeleagentFile, previewTeleagentDirectory } from '../sources/teleagent.mjs'
import { importKilocodeFile, importKilocodeDirectory, previewKilocodeFile, previewKilocodeDirectory } from '../sources/kilocode.mjs'
import { importZcodeFile, importZcodeDirectory, previewZcodeFile, previewZcodeDirectory } from '../sources/zcode.mjs'
import { importTraeFile, importTraeDirectory, previewTraeFile, previewTraeDirectory } from '../sources/trae.mjs'
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
import { readDshText, collectDshFiles } from '../sources/dsh.mjs'
import { greedyDecodeSlugPath, resolveCursorSlugPath, cursorSlugFromTranscriptPath } from '../cwd-map.mjs'

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

// antigravity：目录批量只收 canonical 输入 brain/<id>/.system_generated/logs/
// transcript.jsonl——同目录的 transcript_full.jsonl 与其它伴生日志不是独立会话
//（按同 id 重复导入只会撞幂等键/产生噪音），发现层与导入层的选材口径保持一致。
// 路径判定与 derive.args 的 brain 正则同源（/brain/<id>/ 定位会话）。
const ANTIGRAVITY_TRANSCRIPT_RE = /\/brain\/[^/]+\/\.system_generated\/logs\/transcript\.jsonl$/i
async function collectAntigravityTranscripts(ctx, dirTarget, out, recursive) {
  const candidates = []
  await collectJsonlFiles(ctx, dirTarget, candidates, recursive)
  for (const target of candidates) {
    const p = String(target.displayPath || target.targetKey || '').replace(/\\/g, '/')
    if (ANTIGRAVITY_TRANSCRIPT_RE.test(p)) out.push(target)
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

export function buildImportSources(ctx, registryDir) {
  // 分组 spec：derive/io/label/registry 子对象，新源加一行即可；工具层
  // 专属参数（compacted/branch/sessionIds/fullHistory/lineage/lineageMode/parseFormat）与 format
  // 枚举描述集中在 lib/toolkit.mjs（分发器共同参数表）——此处 spec 只留执行所需。
  // codex 的参数指纹键：fullHistory 改变转换产物（是否尊重上下文压缩），换值须重导
  const CODEX_FINGERPRINT_KEYS = ['fullHistory']
  // 压缩感知来源（claude / codex / pi / opencode 系 / kimi / zed / crush / continue / zcode）：
  // fullHistory 改变转换产物（写不写原生压缩检查点），换值须重导 → 同一组指纹键
  const COMPACTION_FINGERPRINT_KEYS = ['fullHistory']
  const IMPORT_SOURCES = [
    // claude：文件名 stem 传给转换器做「主 transcript」判定（subagent/workflow
    // 辅助 transcript 记录携带父 sessionId，按它建会话会与主 transcript 撞 id 导致
    // 主内容被跳过）。权威映射在转换层（convertClaudeJsonl 无 cwd 记录时输出
    // cwdHint slug，importTranscript 消费 resolveClaudeCwd）。
    {
      format: 'claude',
      sourceLabel: 'Claude Code',
      convert: convertClaudeJsonl,
      // compaction 默认落原生检查点（fullHistory 入参数指纹：换值须重导）；
      // includeToolUseResult 改变转换产物（要不要并入 toolUseResult sidecar），同入指纹
      registry: { dir: registryDir, fingerprintKeys: ['fullHistory', 'includeToolUseResult'] },
      derive: {
        args: (target) => {
          const p = target.displayPath || ctx.fs.processPath(target)
          const base = String(p).split(/[\\/]/).pop() || ''
          return { fileStem: base.replace(/\.jsonl$/i, '') }
        },
      },
    },
    // codex：rollout 文件（新版会把一个会话拆成多个分页文件，issue #57）——
    // 任意一页都解析整链一次导入（幂等键 = 链首页路径），目录模式按 thread 分组批量。
    // compaction 默认尊重（只导最后一次压缩后的窗口，fullHistory 入参数指纹）
    { format: 'codex', sourceLabel: 'Codex/ChatGPT',
      io: {
        file: (c, t, a) => importCodexFile(c, t, a, { registryDir, runDecision, markTrimmedSource, fingerprintKeys: CODEX_FINGERPRINT_KEYS }),
        dir: (c, d, a) => importCodexDirectory(c, d, a, { registryDir, runDecision, markTrimmedSource, fingerprintKeys: CODEX_FINGERPRINT_KEYS }),
        previewFile: (c, t, a) => previewCodexFile(c, t, a),
        previewDir: (c, d, a) => previewCodexDirectory(c, d, a),
      },
      registry: { dir: registryDir, fingerprintKeys: CODEX_FINGERPRINT_KEYS } },
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
    // antigravity：Antigravity（2.0 / CLI / IDE）与 Gemini CLI 共用 ~/.gemini 前缀但
    // 存储不同。导入输入是 brain/<id>/.system_generated/logs/transcript.jsonl（逐行
    // JSON）；标题与异步任务回执在同级目录，由 derive.args 经 ctx.fs 旁读后喂给纯
    // 函数转换器。ctx.fs 是目标对象契约（只有 resolve 收路径字符串，readText/
    // listDir 只收 resolve 出的目标），旁读一律先 resolve；annotations/messages
    // 缺失是合法形态（会话未重命名 / 无后台任务），容错为无标题 / 无回执。
    {
      format: 'antigravity',
      sourceLabel: 'Antigravity',
      convert: convertAntigravityJsonl,
      registry: { dir: registryDir },
      derive: {
        collect: collectAntigravityTranscripts,
        args: async (target) => {
          const p = target.displayPath || ctx.fs.processPath(target)
          // .../brain/<id>/.system_generated/logs/transcript.jsonl → .../brain/<id>
          const m = String(p).replace(/\\/g, '/').match(/^(.*)\/brain\/([^/]+)\//)
          if (!m) return {}
          const brainDir = m[1] + '/brain/' + m[2]
          const antigravityId = m[2]
          const derived = { antigravityId }
          try {
            const annoTarget = await ctx.fs.resolve(join(brainDir, '..', '..', 'annotations', antigravityId + '.pbtxt'))
            const annoRaw = await ctx.fs.readText(annoTarget)
            const annoTitle = parseAnnotationTitle(annoRaw)
            if (annoTitle) derived.annotationTitle = annoTitle
          } catch {
            // annotations 缺失/不可读：标题回退首问（与转换层同款降级）
          }
          try {
            const msgTarget = await ctx.fs.resolve(join(brainDir, '.system_generated', 'messages'))
            const names = await ctx.fs.listDir(msgTarget)
            if (Array.isArray(names) && names.length > 0) {
              const recs = []
              for (const entry of names) {
                const name = typeof entry === 'string' ? entry : entry && entry.name
                if (!name || !name.endsWith('.json')) continue
                const raw = await ctx.fs.readText(await ctx.fs.resolve(join(brainDir, '.system_generated', 'messages', name)))
                if (raw === null || raw === '') continue
                try {
                  recs.push(JSON.parse(raw))
                } catch { /* 畸形回执跳过；转换层 skipped 只统计转录行 */ }
              }
              if (recs.length > 0) derived.taskMessages = indexTaskMessages(recs)
            }
          } catch {
            // messages 缺失/不可读：无异步任务回执可补（fire-and-forget 缺结果
            // 由转换层显式标注，不静默虚构）
          }
          return derived
        },
      },
    },
    // reasonix：会话 id 用文件名 stem（幂等）；cwd/标题从同目录 <stem>.meta.json
    // 派生；桌面版 projects/<slug>/sessions 布局下标题走目录级 .titles.json
    // 权威索引、cwd 走 slug 贪心解码；V2 WAL（<stem>.events.jsonl）
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
          // 桌面版布局：projects/<slug>/sessions/<stem>.jsonl
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
            // cwd = slug 贪心解码（meta.json 无 workspace 时）
            if (!derived.cwd) {
              const decoded = await greedyDecodeSlugPath(ctx, slug)
              if (decoded) derived.cwd = decoded
            }
          }
          if (annotated?.walText !== null && annotated?.walText !== undefined) {
            derived.walText = annotated.walText
          } else {
            try {
              // WAL 与 checkpoint 同目录：<stem>.events.jsonl（V2 事件日志权威，
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
    //（mimocode.db、provider 标签、后台任务会话过滤）收在 lib/sources/mimocode.mjs /
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
    // kilocode 源：Kilo Code（opencode 的 fork）本地历史库 ~/.local/share/kilo/kilo.db
    //（SQLite 三表 schema 为 opencode 超集，核心对话列同构），读取/导入/预览复用
    // opencode 管线——kilocode 专属差异（kilo.db、provider 标签、跳过子/归档会话）
    // 收在 lib/sources/kilocode.mjs / lib/convert/kilocode.mjs。
    {
      format: 'kilocode',
      sourceLabel: 'Kilo Code',
      convert: convertKilocodeJson,
      io: {
        file: (c, t, a) => importKilocodeFile(c, t, a, { registryDir, runDecision, markTrimmedSource }),
        dir: (c, d, a) => importKilocodeDirectory(c, d, a, { registryDir, runDecision, markTrimmedSource }),
        previewFile: (c, t, a) => previewKilocodeFile(c, t, a),
        previewDir: (c, d, a) => previewKilocodeDirectory(c, d, a),
        alwaysBatch: true,
      },
      registry: { dir: registryDir },
      label: { batch: '会话', skipped: '无用户回合' },
    },
    // teleagent 源：TeleAgent（星辰超级智能体，中电信 TeleAI）桌面客户端，会话库
    // ~/.local/share/TeleAgent/users/<账户>/teleagent.db（opencode 派生，SQLite 三表
    // schema 同构，issue #60 实测）。读取/导入/预览复用 opencode 管线——teleagent
    // 专属差异（teleagent.db、多账户目录、provider 标签）收在 lib/sources/teleagent.mjs /
    // lib/convert/teleagent.mjs。一库多会话恒批量；目录模式定位库文件（无递归）。
    {
      format: 'teleagent',
      sourceLabel: 'TeleAgent',
      convert: convertTeleagentJson,
      io: {
        file: (c, t, a) => importTeleagentFile(c, t, a, { registryDir, runDecision, markTrimmedSource }),
        dir: (c, d, a) => importTeleagentDirectory(c, d, a, { registryDir, runDecision, markTrimmedSource }),
        previewFile: (c, t, a) => previewTeleagentFile(c, t, a),
        previewDir: (c, d, a) => previewTeleagentDirectory(c, d, a),
        alwaysBatch: true,
      },
      registry: { dir: registryDir },
      label: { batch: '会话', skipped: '无用户回合' },
    },
    // Trae Work：VS Code 风格 state.vscdb（ItemTable）一库多会话；目录模式覆盖
    // Trae User 根、workspaceStorage/globalStorage 以及单个 workspace 数据库。
    {
      format: 'trae',
      sourceLabel: 'Trae Work',
      convert: convertTraeJson,
      io: {
        file: (c, t, a) => importTraeFile(c, t, a, { registryDir, runDecision, markTrimmedSource }),
        dir: (c, d, a) => importTraeDirectory(c, d, a, { registryDir, runDecision, markTrimmedSource }),
        previewFile: (c, t, a) => previewTraeFile(c, t, a),
        previewDir: (c, d, a) => previewTraeDirectory(c, d, a),
        alwaysBatch: true,
      },
      registry: { dir: registryDir },
      label: { batch: '会话', skipped: '无用户回合' },
    },
    // Mistral Vibe CLI：~/.vibe/logs/session/<session_dir>/（messages.jsonl + meta.json）
    {
      format: 'vibe',
      sourceLabel: 'Mistral Vibe',
      convert: convertVibeJson,
      io: {
        file: (c, t, a) => importVibeFile(c, t, a, { registryDir, runDecision, markTrimmedSource, fingerprintKeys: COMPACTION_FINGERPRINT_KEYS }),
        dir: (c, d, a) => importVibeDirectory(c, d, a, { registryDir, runDecision, markTrimmedSource, fingerprintKeys: COMPACTION_FINGERPRINT_KEYS }),
        previewFile: (c, t, a) => previewVibeFile(c, t, a),
        previewDir: (c, d, a) => previewVibeDirectory(c, d, a),
        dirSingle: async (ctx, target) => vibeIsSessionDir(ctx, target),
      },
      registry: { dir: registryDir, fingerprintKeys: COMPACTION_FINGERPRINT_KEYS },
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
        file: (c, t, a) => importZcodeFile(c, t, a, { registryDir, runDecision, markTrimmedSource, fingerprintKeys: COMPACTION_FINGERPRINT_KEYS }),
        dir: (c, d, a) => importZcodeDirectory(c, d, a, { registryDir, runDecision, markTrimmedSource, fingerprintKeys: COMPACTION_FINGERPRINT_KEYS }),
        previewFile: (c, t, a) => previewZcodeFile(c, t, a),
        previewDir: (c, d, a) => previewZcodeDirectory(c, d, a),
        alwaysBatch: true,
      },
      // compaction 默认落原生检查点（fullHistory 入参数指纹：换值须重导）
      registry: { dir: registryDir, fingerprintKeys: COMPACTION_FINGERPRINT_KEYS },
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
        file: (c, t, a) => importKimiFile(c, t, a, { registryDir, fingerprintKeys: COMPACTION_FINGERPRINT_KEYS }),
        dir: (c, d, a) => importKimiDirectory(c, d, a, { registryDir, fingerprintKeys: COMPACTION_FINGERPRINT_KEYS }),
        previewFile: (c, t, a) => previewKimiFile(c, t, a),
        previewDir: (c, d, a) => previewKimiDirectory(c, d, a),
        dirSingle: async (ctx, target) => kimiIsSessionDir(ctx, target),
      },
      derive: { args: (target) => kimiDeriveArgs(ctx, target) },
      // compaction 默认落原生检查点（fullHistory 入参数指纹：换值须重导）
      registry: { dir: registryDir, fingerprintKeys: COMPACTION_FINGERPRINT_KEYS },
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
    // continue 源：文件名 stem（sessionId）作稳定源 id 兜底（文件内 sessionId 优先）；
    // 创建时间只在同目录 sessions.json 索引里，由发现层读索引后经 args.createdAt 带入
    {
      format: 'continue',
      sourceLabel: 'Continue',
      convert: convertContinueJson,
      // compaction 默认落原生检查点（fullHistory 入参数指纹：换值须重导）
      registry: { dir: registryDir, fingerprintKeys: COMPACTION_FINGERPRINT_KEYS },
      derive: {
        args: async (target) => {
          const p = target.displayPath || ctx.fs.processPath(target)
          const base = String(p).split(/[\\/]/).pop() || ''
          const stem = base.replace(/\.json$/i, '')
          const derived = { continueId: stem }
          try {
            // sessions.json 索引与会话文件同目录：只有索引带 dateCreated（会话文件内部
            // 没有时间戳），能读到就带上作会话创建时间
            const dirPath = String(p).replace(/[\\/][^\\/]*\.json$/i, '')
            const indexTarget = await ctx.fs.resolve(join(dirPath, 'sessions.json'))
            const known = readContinueIndex(await ctx.fs.readText(indexTarget)).get(stem)
            if (known && Number.isFinite(known.createdAt)) derived.createdAt = known.createdAt
          } catch {
            // 索引缺失/损坏不致命：仍按文件名 stem 导入，仅创建时间回退导入时刻
          }
          return derived
        },
      },
    },
    // cline 源：元数据 DB 优先（<dataDir>/db/sessions.db 的 sessions 表：cwd/started_at/
    // metadata_json.title），manifest 的 metadata.title 补齐权威标题；现代目录导入只收
    // <sessionId>.messages.json，legacy VS Code globalStorage 目录则收
    // tasks/<id>/api_conversation_history.json（manifest / compaction / 子代理消息文件不当作会话）
    {
      format: 'cline',
      sourceLabel: 'Cline',
      convert: convertClineJson,
      // compaction 侧车默认落原生检查点（fullHistory 入参数指纹：换值须重导）
      registry: { dir: registryDir, fingerprintKeys: COMPACTION_FINGERPRINT_KEYS },
      derive: {
        args: (target) => clineDeriveArgs(ctx, target),
        collect: collectClineFiles,
      },
    },
    // goose 源：aaif-goose（原 Block）的会话库 <dataDir>/sessions/sessions.db
    //（SQLite，一库多会话恒批量）。旧版 sessions/*.jsonl 不读——上游只在首次建库时全量
    // 迁移且不删除旧文件，读它会与库里的同一批会话重复导入。目录模式定位 sessions.db
    //（无递归）；sessionIds 过滤走库里逐会话落盘（同 zcode/opencode）。
    {
      format: 'goose',
      sourceLabel: 'Goose',
      convert: convertGooseJson,
      io: {
        file: (c, t, a) => importGooseFile(c, t, a, { registryDir, runDecision, markTrimmedSource }),
        dir: (c, d, a) => importGooseDirectory(c, d, a, { registryDir, runDecision, markTrimmedSource }),
        previewFile: (c, t, a) => previewGooseFile(c, t, a),
        previewDir: (c, d, a) => previewGooseDirectory(c, d, a),
        alwaysBatch: true,
      },
      registry: { dir: registryDir },
      label: { batch: '会话', skipped: '无用户回合' },
    },
    // zed 源：Zed 编辑器的 Agent 线程库 <data_dir>/threads/threads.db（单表 threads +
    // zstd blob，一库多线程恒批量）。子代理线程（parent_id 非空）由读取层跳过；目录模式
    // 自动定位 threads.db（<dir>/threads.db 或 <dir>/threads/threads.db）。
    {
      format: 'zed',
      sourceLabel: 'Zed',
      convert: convertZedJson,
      io: {
        file: (c, t, a) => importZedFile(c, t, a, { registryDir, runDecision, markTrimmedSource, fingerprintKeys: COMPACTION_FINGERPRINT_KEYS }),
        dir: (c, d, a) => importZedDirectory(c, d, a, { registryDir, runDecision, markTrimmedSource, fingerprintKeys: COMPACTION_FINGERPRINT_KEYS }),
        previewFile: (c, t, a) => previewZedFile(c, t, a),
        previewDir: (c, d, a) => previewZedDirectory(c, d, a),
        alwaysBatch: true,
      },
      registry: { dir: registryDir },
      label: { batch: '线程', skipped: '无用户回合' },
    },
    // crush 源：Charm 的 Crush。库在**项目里**（<项目>/.crush/crush.db），用户级目录只有
    // JSON 状态 → 一库多会话恒批量；目录模式接受「项目目录」或「数据目录」；cwd 由
    // projects.json 反查（DB 里没有 cwd 列）。
    {
      format: 'crush',
      sourceLabel: 'Crush',
      convert: convertCrushJson,
      io: {
        file: (c, t, a) => importCrushFile(c, t, a, { registryDir, runDecision, markTrimmedSource, fingerprintKeys: COMPACTION_FINGERPRINT_KEYS }),
        dir: (c, d, a) => importCrushDirectory(c, d, a, { registryDir, runDecision, markTrimmedSource, fingerprintKeys: COMPACTION_FINGERPRINT_KEYS }),
        previewFile: (c, t, a) => previewCrushFile(c, t, a),
        previewDir: (c, d, a) => previewCrushDirectory(c, d, a),
        alwaysBatch: true,
      },
      // compaction 默认落原生检查点（fullHistory 入参数指纹：换值须重导）
      registry: { dir: registryDir, fingerprintKeys: COMPACTION_FINGERPRINT_KEYS },
      derive: { args: (target) => crushDeriveArgs(ctx, target) },
      label: { batch: '会话', skipped: '无用户回合' },
    },
    // dsh 源：.zstd 由 fzstd 纯 JS 解压后走同一转换器；目录递归收集 session.jsonl(.zstd)。
    // 按日志代次拆两项（dsh = V0–V3 / dsh4 = V4+）：转换器同一个，目录收集按代次谓词过滤，
    // 面板来源列表因此能分别只看 V3 / V4。
    {
      format: 'dsh',
      sourceLabel: 'DSH V3',
      convert: convertDshJsonl,
      readText: readDshText,
      derive: { collect: (c, d, o, r) => collectDshFiles(c, d, o, r, (v) => v < 4) },
      registry: { dir: registryDir },
    },
    {
      format: 'dsh4',
      sourceLabel: 'DSH V4',
      convert: convertDshJsonl,
      readText: readDshText,
      derive: { collect: (c, d, o, r) => collectDshFiles(c, d, o, r, (v) => v >= 4) },
      registry: { dir: registryDir },
    },
    // 本地 JSONL：任意 .jsonl 路径，转换器按路径特征 + 内容自动识别，也可用
    // parseFormat 参数强制指定解析器。不是「面板来源」——不登记 IMPORT_SPECS。
    { format: 'local-jsonl', sourceLabel: 'Local JSONL', convert: convertLocalJsonl, registry: { dir: registryDir } },
  ]
  return IMPORT_SOURCES
}
