// lib/import-variants.mjs — 特殊形态来源的导入 / 预览编排
//
// 标准单文件/目录批量由 lib/import-core.mjs 覆盖；这里收编「形态不同」的来源：
//   chatgpt   —— 单个 conversations.json 含多会话（逐会话独立落盘）
//   grokbuild —— 源是会话目录（summary.json + chat_history.jsonl 复合指纹）
//   hermes    —— state.db（SQLite，恒批量）或 sessions/*.jsonl 回退
//   kimi      —— 源是会话目录（旧 wire.jsonl + state.json + kimi.json workdir 映射；
//               新 ~/.kimi-code 为 agents/main/wire.jsonl + state.json cwd/title，
//               缺 state.json 时回退 workspaces.json）
// 以及这四个来源的 dry-run 预览（与正式导入同源的只读重演，零副作用）。
// SQLite 库类来源（opencode / mimocode / teleagent / kilocode / zcode / goose / zed /
// crush / trae）的预览与各自导入编排同住 lib/sources/<src>.mjs。
// 依赖 ctx（host 服务），非纯函数。

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  convertChatgptJson, convertGrokbuildJson, convertHermesJson, convertKimiWire,
} from './convert/index.mjs'
import {
  importTranscript, importDirectory, collectJsonlFiles, collectJsonFiles,
  previewTranscript, previewDirectory, previewConverted, previewEach,
  runImportBatch, finishConversion, commitSingle, importMultiSource, convertSessionItems, previewSessionSet,
} from './import-core.mjs'
import { createBatchTally, tallyBatch, batchSummary, failedItem, collectSessionDirs } from './import-batch.mjs'
import { loadKnownRecord, singleShortPath, compositeStat } from './import-state.mjs'
import { listPersistedIds, argsFingerprint, beginRegistryBatch, endRegistryBatch } from './imports.mjs'
import { readHermesDb } from './sources/hermes.mjs'

// ── ChatGPT 导出导入：单个 conversations.json 可能含多个会话，每个会话独立落盘
//（逐会话判增 append / 消失 missingFromSource；force=全量新副本）。registry 子表为
// conversations；文件级 version/size 未变走「源未变」短路径（共享编排见 lib/import-core.mjs）。
export async function importChatgptFile(ctx, target, args, { registryDir, persisted } = {}) {
  return importMultiSource(ctx, target, args, {
    registryDir, persisted, subTable: 'conversations', importFormat: 'chatgpt',
    load: async (path) => {
      // branch 参数透传（main 默认 / all 全部分支会话）；整文件 / 个别会话无可导入内容只计数
      const { conversations, skipped } = convertChatgptJson(await ctx.fs.readText(target), { ...args, sourcePath: path })
      const items = []
      for (const conv of conversations) {
        await finishConversion(ctx, conv, args, { sourcePath: path, sourceLabel: 'ChatGPT' })
        items.push({ key: conv.meta.sourceId || conv.meta.id, converted: conv })
      }
      return { items, extraSkipped: skipped }
    },
  })
}

// ChatGPT 目录导入：扫描 .json 文件，每个文件可含多个会话。
export async function importChatgptDirectory(ctx, dirTarget, args, { registryDir, persisted } = {}) {
  const files = await collectJsonFiles(ctx, dirTarget, [], args.recursive !== false)
  const tally = createBatchTally()
  const results = []
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  // 批处理通道：逐文件的 registry 记录合并为末尾一次提交（同 importDirectory）。
  beginRegistryBatch(registryDir)
  try {
    for (const target of files) {
      try {
        const r = await importChatgptFile(ctx, target, args, { registryDir, persisted: persistedSet })
        tallyBatch(tally, r)
        results.push(...r.results)
      } catch (err) {
        tally.failed++
        results.push(failedItem(target.displayPath || ctx.fs.processPath(target), err))
      }
    }
  } finally {
    await endRegistryBatch()
  }
  return batchSummary(tally, results.length, results)
}

// ── import_grokbuild 编排：源是会话目录（summary.json + chat_history.jsonl）────

// 会话目录复合 stat（summary.json + chat_history.jsonl，口径见 lib/import-state.mjs
// compositeStat）：任一文件变化 → 复合指纹变化 → 重读；registry 落复合值。kimi 会话目录
// （wire.jsonl + state.json）同一口径，kimiStat 是它的别名。
export function grokbuildStat(ctx, summaryTarget, chatTarget) {
  return compositeStat(ctx, [summaryTarget, chatTarget])
}

// 递归收集会话目录：目录含 summary.json 即会话（收下，不下钻）；否则 recursive 时
// 下钻（sessions 根 → <project>/ → <session_id>/ 两级结构）。
export function collectGrokbuildSessions(ctx, dirTarget, out, recursive) {
  return collectSessionDirs(ctx, dirTarget, out, recursive, async (sub) => {
    const sumStat = await ctx.fs.stat(await ctx.fs.resolve(join(sub.targetKey, 'summary.json')))
    return !!(sumStat && sumStat.type === 'file')
  })
}

// chat_history.jsonl 可选：会话目录缺失该文件（仅 summary 的会话）按空文本读，
// 转换层按无回合跳过（meta 仍来自 summary）。
export async function readGrokHistory(ctx, chatTarget) {
  try {
    return await ctx.fs.readText(chatTarget)
  } catch {
    // 缺失 chat_history.jsonl：视为无历史，不当作失败
    return ''
  }
}

// 单会话目录导入（状态机）：幂等键 = 会话目录路径；复合 stat 指纹；
// 读 summary.json + chat_history.jsonl 再转换落盘。persisted 可传共享快照。
export async function importGrokbuildSession(ctx, target, args, { registryDir, persisted } = {}) {
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const summaryTarget = await ctx.fs.resolve(join(sourcePath, 'summary.json'))
  const chatTarget = await ctx.fs.resolve(join(sourcePath, 'chat_history.jsonl'))
  const stat = await grokbuildStat(ctx, summaryTarget, chatTarget)
  const state = await loadKnownRecord(ctx, sourcePath, { registryDir, persisted })
  const fingerprint = argsFingerprint(args, [])
  const skip = singleShortPath(state.known, args, fingerprint, stat)
  if (skip) return skip

  const summaryText = await ctx.fs.readText(summaryTarget)
  const chatText = await readGrokHistory(ctx, chatTarget)
  // 空 chat_history / 畸形 summary 由 commitSingle 计入 skipped，不落盘空会话
  const out = await finishConversion(ctx, convertGrokbuildJson(summaryText, chatText, { ...args, sourcePath }), args, { sourcePath, sourceLabel: 'Grok Build' })
  return commitSingle(ctx, out, { ...state, stat, args, fingerprint, sourcePath, importFormat: 'grokbuild', registryDir })
}

// grokbuild 目录批量：递归扫 summary.json 收集会话目录，逐目录走单会话状态机。
export async function importGrokbuildDirectory(ctx, dirTarget, args, { registryDir, persisted } = {}) {
  const sessions = []
  await collectGrokbuildSessions(ctx, dirTarget, sessions, args.recursive !== false)
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  return runImportBatch(ctx, sessions,
    (target) => importGrokbuildSession(ctx, target, { ...args, force: args.force === true }, { registryDir, persisted: persistedSet }),
    { registryDir, skipReason: () => 'not a grokbuild session (no user turns)' })
}

// ── import_hermes 编排：state.db（SQLite，恒批量）或 sessions/*.jsonl 回退 ──────

// hermes 文件参数派生：无 session 记录时用文件 stem 作会话 id（幂等、确定性）。
export function hermesFileArgs(ctx, target) {
  const p = target.displayPath || ctx.fs.processPath(target)
  const base = String(p).split(/[\\/]/).pop() || ''
  return { fileStem: base.replace(/\.(jsonl|json)$/i, '') }
}

const HERMES_DB_UNAVAILABLE = 'hermes db 不可用（非 SQLite / 无 sessions 表）: '

// 压缩分叉 lineage：isParent = 有子会话的会话（压缩分叉父节点，通常无消息、内容由子会话承接）。
// lineage:'tail' 只导叶子链尾，父会话进 dropped（调用方点名跳过，不静默）。
function hermesLineage(sessions, args) {
  const isParent = new Set(sessions.filter((s) => sessions.some((o) => o.id !== s.id && o.parentSessionId === s.id)).map((s) => s.id))
  if (args.lineage !== 'tail') return { kept: sessions, dropped: [], isParent }
  return { kept: sessions.filter((s) => !isParent.has(s.id)), dropped: sessions.filter((s) => isParent.has(s.id)), isParent }
}

const hermesConvertOne = (args, path) => (s) => convertHermesJson(JSON.stringify(s), { ...args, sourcePath: path })

// hermes 单库导入：DB 内每个会话独立落盘，恒返回批量形态（对齐 importOpencodeFile）。
// 库指纹 + WAL 边车签名短路径；逐会话判增 append / 会话消失 missingFromSource。
// sessions 可预读传入（目录模式已读一次判 db 可用性，避免二次打开）。
export async function importHermesDbFile(ctx, target, args, { registryDir, persisted, sessions } = {}) {
  return importMultiSource(ctx, target, args, {
    registryDir, persisted, sqlite: true, importFormat: 'hermes',
    load: async (path) => {
      const all = sessions ?? readHermesDb(path)
      if (all === null) throw new Error(HERMES_DB_UNAVAILABLE + path)
      const { kept, dropped, isParent } = hermesLineage(all, args)
      const converted = await convertSessionItems(ctx, kept, {
        path, args, sourceLabel: 'Hermes', convertOne: hermesConvertOne(args, path),
        // 无用户回合跳过；compaction 父会话（有子会话）标注 lineage 原因
        skipReason: (s) => 'no user turns (session ' + s.id + ')' + (isParent.has(s.id) ? '（compaction 分叉父会话，lineage）' : ''),
      })
      const lineageSkipped = dropped.map((s) => ({ path, status: 'skipped', reason: 'lineage tail: parent session ' + s.id + '（有子会话，非叶子链尾）' }))
      return { ...converted, preSkipped: [...lineageSkipped, ...converted.preSkipped] }
    },
  })
}

// hermes 目录导入：优先定位 state.db（SQLite 恒批量）；db 不可用（readHermesDb
// 返回 null：目录无 state.db / 非 hermes 库）→ 回退递归扫 .jsonl（逐文件单会话）。
export async function importHermesDirectory(ctx, dirTarget, args, { registryDir, persisted } = {}) {
  const dirPath = dirTarget.displayPath || ctx.fs.processPath(dirTarget)
  const dbPath = join(dirPath, 'state.db')
  const dbTarget = await ctx.fs.resolve(dbPath)
  const dbSessions = readHermesDb(dbPath)
  if (dbSessions !== null) {
    return importHermesDbFile(ctx, dbTarget, args, { registryDir, persisted, sessions: dbSessions })
  }
  return importDirectory(ctx, dirTarget, args, { convert: convertHermesJson, sourceLabel: 'Hermes', deriveArgs: (target) => hermesFileArgs(ctx, target), collect: collectJsonlFiles, registryDir })
}

// hermes 单文件入口：.db → SQLite 恒批量；.jsonl/.json → 标准单会话导入。
export async function importHermesFile(ctx, target, args, { registryDir } = {}) {
  const path = target.displayPath || ctx.fs.processPath(target)
  if (/\.db$/i.test(String(path))) {
    return importHermesDbFile(ctx, target, args, { registryDir })
  }
  return importTranscript(ctx, target, args, convertHermesJson, { registryDir })
}

// ── import_kimi 编排：源是会话目录（wire.jsonl + state.json）──────────────────
// Kimi CLI 布局（MoonshotAI/kimi-cli 官方布局）：~/.kimi/sessions/<workdir-md5>/
// <session-id>/{wire.jsonl, state.json, subagents/}，~/.kimi/kimi.json 的
// work_dirs[{path, kaos}] 经 md5(path)（kaos 非本地时前缀 `<kaos>_`）映射目录名。
// 会话目录 = 含 wire.jsonl 的目录（subagents/<id>/wire.jsonl 是子代理，不并入主线程
// 批量——转换层对 SubagentEvent 镜像跳过计数）。

// 会话目录复合 stat：wire.jsonl + state.json（标题在 state.json，custom_title 变更也要
// 触发重读），与 grokbuildStat 同一口径。
export const kimiStat = grokbuildStat

// 递归收集会话目录：目录含 wire.jsonl（旧）或 agents/main/wire.jsonl（新）即会话
//（收下，不下钻——子代理 wire 不并入）；否则 recursive 时下钻。
export function collectKimiSessions(ctx, dirTarget, out, recursive) {
  return collectSessionDirs(ctx, dirTarget, out, recursive, (sub) => kimiIsSessionDir(ctx, sub))
}

// 分隔符无关的父目录（跨平台纪律：不依赖 node:path dirname 对反斜杠路径的行为）。
function parentOf(p) {
  const s = String(p).replace(/[\\/]+$/, '').split(/[\\/]/)
  s.pop()
  return s.join('/')
}

// 会话目录内定位 wire.jsonl：旧布局直接放会话目录，新 Kimi Code 放在
// agents/main/wire.jsonl（session 目录本身仍以 state.json 为伴生文件）。
export async function kimiWireTarget(ctx, dir) {
  const dirPath = typeof dir === 'string' ? dir : (dir.displayPath || ctx.fs.processPath(dir))
  const root = await ctx.fs.resolve(join(dirPath, 'wire.jsonl'))
  const rootStat = await ctx.fs.stat(root)
  if (rootStat && rootStat.type === 'file') return root
  const agent = await ctx.fs.resolve(join(dirPath, 'agents', 'main', 'wire.jsonl'))
  const agentStat = await ctx.fs.stat(agent)
  if (agentStat && agentStat.type === 'file') return agent
  return root
}

export async function kimiIsSessionDir(ctx, dir) {
  const wire = await kimiWireTarget(ctx, dir)
  const st = await ctx.fs.stat(wire)
  return !!(st && st.type === 'file')
}

// kimi.json workdir 映射（自底向上找 ≤6 层）：目录名 = md5(path) 或 `<kaos>_<md5>`。
// 找不到 kimi.json / 无匹配条目 → null（cwd 缺省，归组回退源目录）。
async function kimiWorkDirByHash(ctx, startPath, hashDirName) {
  if (!hashDirName) return null
  let dir = parentOf(startPath)
  for (let i = 0; i < 6; i++) {
    const metaTarget = await ctx.fs.resolve(join(dir, 'kimi.json'))
    const st = await ctx.fs.stat(metaTarget)
    if (st && st.type === 'file') {
      try {
        const meta = JSON.parse(await ctx.fs.readText(metaTarget))
        for (const wd of (meta && Array.isArray(meta.work_dirs) ? meta.work_dirs : [])) {
          if (!wd || typeof wd.path !== 'string' || !wd.path) continue
          const hex = createHash('md5').update(wd.path, 'utf8').digest('hex')
          const kaos = typeof wd.kaos === 'string' && wd.kaos ? wd.kaos : 'local'
          if (hex === hashDirName || (kaos + '_' + hex) === hashDirName) return wd.path
        }
      } catch {
        // kimi.json 损坏：无 cwd 映射（不致命）
        return null
      }
      return null
    }
    const next = parentOf(dir)
    if (next === dir) return null
    dir = next
  }
  return null
}

// Kimi Code 的新布局在 state.json 缺失时，用 ~/.kimi-code/workspaces.json
// 按 sessions/<workspace-id> 目录名回退工作区根目录。
async function kimiCodeWorkDirById(ctx, startPath, workspaceId) {
  if (!workspaceId) return null
  const rawPath = String(startPath)
  const marker = rawPath.toLowerCase().indexOf('.kimi-code')
  const beforeMarker = rawPath[marker - 1]
  const afterMarker = rawPath[marker + '.kimi-code'.length]
  if (marker < 0 || (beforeMarker && !/[\\/]/.test(beforeMarker))
    || (afterMarker && !/[\\/]/.test(afterMarker))) return null
  const home = rawPath.slice(0, marker + '.kimi-code'.length)
  const metaTarget = await ctx.fs.resolve(join(home, 'workspaces.json'))
  const st = await ctx.fs.stat(metaTarget)
  if (!st || st.type !== 'file') return null
  try {
    const meta = JSON.parse(await ctx.fs.readText(metaTarget))
    const entry = meta && meta.workspaces && typeof meta.workspaces === 'object'
      ? meta.workspaces[workspaceId]
      : null
    const root = typeof entry === 'string' ? entry : entry && entry.root
    return typeof root === 'string' && root.trim() ? root : null
  } catch {
    // workspaces.json 损坏：保持现有静默降级，cwd 留空
    return null
  }
}

// kimi 派生参数：kimiId（会话目录名，幂等源 id）、cwd（state.json cwd 优先，
// 旧布局回退 kimi.json md5 映射）、title（state.json custom_title / 新态
// isCustomTitle+title，权威标题）。target 可以是会话目录或 wire.jsonl。
export async function kimiDeriveArgs(ctx, target) {
  const p = typeof target === 'string' ? target : (target.displayPath || ctx.fs.processPath(target))
  const segs = String(p).replace(/[\\/]+$/, '').split(/[\\/]/)
  const base = segs[segs.length - 1] || ''
  const isWireFile = /^wire\.jsonl$/i.test(base)
  const derived = {}
  let sessionDirName = ''
  let sessionDirPath = String(p)
  let hashDirName = ''
  if (isWireFile) {
    const parent = segs[segs.length - 2] || ''
    const grand = segs[segs.length - 3] || ''
    if (/^main$/i.test(parent) && /^agents$/i.test(grand)) {
      // 新 Kimi Code：…/sessions/<workspace-id>/<session-id>/agents/main/wire.jsonl
      sessionDirName = segs[segs.length - 4] || ''
      sessionDirPath = segs.slice(0, -3).join('/')
      hashDirName = segs[segs.length - 5] || ''
    } else {
      // 旧 Kimi CLI：…/sessions/<md5>/<session-id>/wire.jsonl
      sessionDirName = parent
      sessionDirPath = segs.slice(0, -1).join('/')
      hashDirName = grand
    }
  } else {
    sessionDirName = base
    sessionDirPath = String(p).replace(/[\\/]+$/, '')
    hashDirName = segs[segs.length - 2] || ''
  }
  if (sessionDirName) derived.kimiId = sessionDirName
  const stateTarget = await ctx.fs.resolve(join(sessionDirPath, 'state.json'))
  let state = null
  try {
    state = JSON.parse(await ctx.fs.readText(stateTarget))
  } catch {
    // state.json 缺失/损坏不致命：cwd 回退 kimi.json 映射，标题回退首问
  }
  // Kimi Code 的 state.json 用 workDir（新版同时写 cwd）；两者都读，避免错误回退到 ~/.kimi/kimi.json
  const stateCwd = state && [state.cwd, state.workDir].find((v) => typeof v === 'string' && v.trim())
  if (stateCwd) {
    derived.cwd = stateCwd
  } else {
    const cwd = await kimiWorkDirByHash(ctx, String(p), hashDirName)
      || await kimiCodeWorkDirById(ctx, String(p), hashDirName)
    if (cwd) derived.cwd = cwd
  }
  if (state) {
    if (typeof state.custom_title === 'string' && state.custom_title.trim()) {
      derived.title = state.custom_title.trim()
    } else if (state.isCustomTitle === true && typeof state.title === 'string' && state.title.trim()) {
      derived.title = state.title.trim()
    }
  }
  return derived
}

// 单会话目录导入（状态机）：幂等键 = 会话目录路径；复合 stat 指纹；读
// wire.jsonl + state.json 再转换落盘。persisted 可传共享快照。
export async function importKimiSession(ctx, target, args, { registryDir, persisted, fingerprintKeys = [] } = {}) {
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const merged = { ...args, ...(await kimiDeriveArgs(ctx, target)) }
  const wireTarget = await kimiWireTarget(ctx, sourcePath)
  const stateTarget = await ctx.fs.resolve(join(sourcePath, 'state.json'))
  const stat = await kimiStat(ctx, wireTarget, stateTarget)
  const state = await loadKnownRecord(ctx, sourcePath, { registryDir, persisted })
  const fingerprint = argsFingerprint(args, fingerprintKeys)
  const skip = singleShortPath(state.known, merged, fingerprint, stat)
  if (skip) return skip

  // 空 wire / 畸形文件由 commitSingle 计入 skipped，不落盘空会话
  const out = await finishConversion(ctx, convertKimiWire(await ctx.fs.readText(wireTarget), { ...merged, sourcePath }), merged, { sourcePath, sourceLabel: 'Kimi CLI' })
  return commitSingle(ctx, out, { ...state, stat, args: merged, fingerprint, sourcePath, importFormat: 'kimi', registryDir })
}

// kimi 目录批量：递归扫 wire.jsonl 收集会话目录，逐目录走单会话状态机。
export async function importKimiDirectory(ctx, dirTarget, args, { registryDir, persisted, fingerprintKeys } = {}) {
  const sessions = []
  await collectKimiSessions(ctx, dirTarget, sessions, args.recursive !== false)
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  return runImportBatch(ctx, sessions,
    (target) => importKimiSession(ctx, target, { ...args, force: args.force === true, replace: args.replace === true }, { registryDir, persisted: persistedSet, fingerprintKeys }),
    { registryDir, skipReason: () => 'not a kimi session (no user turns)' })
}

// kimi 单文件入口：会话目录 → 单会话状态机（importKimiSession）；wire.jsonl →
// 标准单文件导入（幂等键 = 文件路径；kimiId/cwd/title 由 deriveArgs 预先派生）。
export async function importKimiFile(ctx, target, args, { registryDir, fingerprintKeys } = {}) {
  const info = await ctx.fs.stat(target)
  if (info && info.type === 'directory') return importKimiSession(ctx, target, args, { registryDir, fingerprintKeys })
  return importTranscript(ctx, target, args, convertKimiWire, { registryDir, fingerprintKeys })
}

// ── 预览（特殊形态来源，与正式导入同源，零副作用）────────────────────

// ChatGPT 单文件预览：一个 conversations.json 逐会话预览（与 importChatgptFile 同源）。
export async function previewChatgptFile(ctx, target, args) {
  const path = target.displayPath || ctx.fs.processPath(target)
  // 与落盘同参：branch 等转换参数一并透传，预览列出的会话集合才与导入一致
  const { conversations, skipped } = convertChatgptJson(await ctx.fs.readText(target), { ...args, sourcePath: path })
  const results = conversations.map((conv) => ({ path, ...previewConverted(conv, args) }))
  if (skipped > 0) {
    // 整文件跳过（无合法会话）或个别会话无可导入内容：跳过明细聚合一条
    results.push({ path, skipped, skipReason: 'no importable conversations (' + skipped + ' skipped)' })
  }
  return { total: conversations.length + skipped, results }
}

export async function previewChatgptDirectory(ctx, dirTarget, args) {
  const files = []
  await collectJsonFiles(ctx, dirTarget, files, args.recursive !== false)
  const results = []
  for (const target of files) {
    try {
      results.push(...(await previewChatgptFile(ctx, target, args)).results)
    } catch (err) {
      const path = target.displayPath || ctx.fs.processPath(target)
      results.push({ path, status: 'failed', error: String((err && err.message) || err) })
    }
  }
  return { total: results.length, results }
}

// grokbuild 单会话目录预览：读 summary.json + chat_history.jsonl 转换（与
// importGrokbuildSession 同源），零副作用。
export async function previewGrokbuildSession(ctx, target, args) {
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const summaryTarget = await ctx.fs.resolve(join(sourcePath, 'summary.json'))
  const chatTarget = await ctx.fs.resolve(join(sourcePath, 'chat_history.jsonl'))
  return previewConverted(convertGrokbuildJson(await ctx.fs.readText(summaryTarget), await readGrokHistory(ctx, chatTarget), { ...args, sourcePath }), args)
}

export async function previewGrokbuildDirectory(ctx, dirTarget, args) {
  const sessions = await collectGrokbuildSessions(ctx, dirTarget, [], args.recursive !== false)
  return previewEach(ctx, sessions, (target) => previewGrokbuildSession(ctx, target, args))
}

// hermes DB 预览：state.db 每会话转换（与 importHermesDbFile 同源），零副作用。
// lineage:'tail' 预览同样只列叶子链尾（与正式导入一致）。
export async function previewHermesDbFile(ctx, target, args, { sessions } = {}) {
  const path = target.displayPath || ctx.fs.processPath(target)
  const all = sessions ?? readHermesDb(path)
  if (all === null) throw new Error(HERMES_DB_UNAVAILABLE + path)
  const { kept } = hermesLineage(all, args)
  return { total: kept.length, results: previewSessionSet(kept, { path, args, convertOne: hermesConvertOne(args, path) }) }
}

export async function previewHermesFile(ctx, target, args) {
  const path = target.displayPath || ctx.fs.processPath(target)
  if (/\.db$/i.test(String(path))) return previewHermesDbFile(ctx, target, args)
  return previewTranscript(ctx, target, args, convertHermesJson)
}

export async function previewHermesDirectory(ctx, dirTarget, args) {
  const dirPath = dirTarget.displayPath || ctx.fs.processPath(dirTarget)
  const dbPath = join(dirPath, 'state.db')
  const dbTarget = await ctx.fs.resolve(dbPath)
  const dbSessions = readHermesDb(dbPath)
  if (dbSessions !== null) return previewHermesDbFile(ctx, dbTarget, args, { sessions: dbSessions })
  return previewDirectory(ctx, dirTarget, args, { convert: convertHermesJson, deriveArgs: (target) => hermesFileArgs(ctx, target), collect: collectJsonlFiles })
}

// kimi 单会话目录预览：读 wire.jsonl + state.json 派生参数转换（与
// importKimiSession 同源），零副作用。
export async function previewKimiSession(ctx, target, args) {
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const derived = await kimiDeriveArgs(ctx, target)
  const wireTarget = await kimiWireTarget(ctx, sourcePath)
  return previewConverted(convertKimiWire(await ctx.fs.readText(wireTarget), { ...args, ...derived, sourcePath }), args)
}

export async function previewKimiFile(ctx, target, args) {
  const info = await ctx.fs.stat(target)
  if (info && info.type === 'directory') return previewKimiSession(ctx, target, args)
  return previewTranscript(ctx, target, args, convertKimiWire)
}

export async function previewKimiDirectory(ctx, dirTarget, args) {
  const sessions = await collectKimiSessions(ctx, dirTarget, [], args.recursive !== false)
  return previewEach(ctx, sessions, (target) => previewKimiSession(ctx, target, args))
}
