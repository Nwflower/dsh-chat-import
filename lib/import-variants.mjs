// lib/import-variants.mjs — 特殊形态来源的导入 / 预览编排
//
// 标准单文件/目录批量由 lib/import-core.mjs 覆盖；这里收编「形态不同」的来源：
//   chatgpt   —— 单个 conversations.json 含多会话（逐会话独立落盘，REQ-24）
//   grokbuild —— 源是会话目录（summary.json + chat_history.jsonl 复合指纹）
//   hermes    —— state.db（SQLite，恒批量）或 sessions/*.jsonl 回退
//   kimi      —— 源是会话目录（旧 wire.jsonl + state.json + kimi.json workdir 映射；
//               新 ~/.kimi-code 为 agents/main/wire.jsonl + state.json cwd/title）
// 以及 opencode / zcode / hermes / grokbuild / chatgpt / kimi 的 REQ-17 dry-run 预览
//（与正式导入同源的只读重演，零副作用）。依赖 ctx（host 服务），非纯函数。

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  convertChatgptJson, convertGrokbuildJson, convertHermesJson, convertKimiWire,
  convertOpencodeJson, convertMimocodeJson, convertZcodeJson,
} from '../convert.mjs'
import { markTrimmedSource } from './budget.mjs'
import {
  importTranscript, importDirectory, collectJsonlFiles, collectJsonFiles,
  previewTranscript, previewDirectory, previewEntry, attachReq26, runDecision, batchItem,
  finalizeConvertedSession,
} from './import-core.mjs'
import {
  loadImports, unwrapRecord, listPersistedIds, archivedSessionIds,
  argsFingerprint, isSessionIdChange, decideSingle, decideMulti,
} from './imports.mjs'
import { readHermesDb } from './hermes.mjs'
import { readOpencodeDb } from './opencode.mjs'
import { readMimocodeDb } from './mimocode.mjs'
import { readZcodeDb, readZcodeTranscript, zcodeDefaultDbPath } from './zcode.mjs'

// ── ChatGPT 导出导入：单个 conversations.json 可能含多个会话，每个会话独立落盘
//（REQ-24：逐会话判增 append / 消失 missingFromSource；force=全量新副本）。
export async function importChatgptFile(ctx, target, args, { registryDir, persisted } = {}) {
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  const archivedIds = archivedSessionIds(ctx)
  const path = target.displayPath || ctx.fs.processPath(target)
  const stat = await ctx.fs.stat(target)
  const registry = await loadImports(registryDir)
  let known = unwrapRecord(registry.imports[path])
  if (known && known.kind !== 'multi') known = null
  const fingerprint = argsFingerprint(args, [])

  // S3 短路径（不 readText）：version/size 未变 → 逐会话跳过。仅当记录里所有会话
  // 仍存在且未被归档时短路径才成立（会话被删 / DSH_HOME 迁移 / 被归档 → 走全量重导）
  if (known && (!known.conversations || typeof known.conversations !== 'object')) known = null
  if (known && args.force !== true && args.replace !== true) {
    const subs = Object.values(known.conversations)
    const allPersisted = subs.length > 0 && subs.every((sub) => persistedSet.has(sub.dshId) && !archivedIds.has(sub.dshId))
    // REQ-37：预算变化 → 跳过并上报 budgetChanged（同 argsChanged 语义）
    if (allPersisted && typeof known.budget === 'number' && known.budget !== args.budget) {
      const results = Object.entries(known.conversations).map(([, sub]) => ({
        path, status: 'already-imported', sessionId: sub.dshId, turns: sub.turns, messages: 0, toolCalls: 0, skipped: 0, budgetChanged: true,
      }))
      return { total: results.length, imported: 0, alreadyImported: results.length, appended: 0, skipped: 0, failed: 0, results }
    }
    if (allPersisted && stat && stat.version === known.version && stat.size === known.sizeBytes) {
      const results = Object.entries(known.conversations).map(([, sub]) => ({
        path, status: 'already-imported', sessionId: sub.dshId, turns: sub.turns, messages: 0, toolCalls: 0, skipped: 0,
      }))
      return { total: results.length, imported: 0, alreadyImported: results.length, appended: 0, skipped: 0, failed: 0, results }
    }
  }

  const raw = await ctx.fs.readText(target)
  // REQ-19：branch 参数透传（main 默认 / all 全部分支会话）
  const { conversations, skipped: skippedFiles } = convertChatgptJson(raw, { ...args, sourcePath: path })
  for (const conv of conversations) {
    markTrimmedSource(conv, args)
    finalizeConvertedSession(conv, args, 'ChatGPT')
  }
  const items = conversations.map((conv) => ({ key: conv.meta.sourceId || conv.meta.id, converted: conv }))
  const decision = await decideMulti(ctx, { known, items, stat, args, fingerprint, persisted: persistedSet, sourcePath: path, subTable: 'conversations', budget: args.budget, archivedIds, importFormat: 'chatgpt' })
  const missing = known ? Object.keys(known.conversations).filter((k) => !items.some((i) => i.key === k)) : []
  const result = await runDecision(ctx, decision, registryDir, path, persistedSet, { workspaceMode: args.workspaceMode, workspaceDir: args.workspaceDir })
  return {
    ...result,
    total: result.results.length + skippedFiles,
    skipped: result.skipped + skippedFiles,
    ...(missing.length ? { missingFromSource: missing } : {}),
  }
}

// ChatGPT 目录导入：扫描 .json 文件，每个文件可含多个会话。
export async function importChatgptDirectory(ctx, dirTarget, args, { registryDir, persisted } = {}) {
  const files = []
  await collectJsonFiles(ctx, dirTarget, files, args.recursive !== false)
  const results = []
  let imported = 0
  let alreadyImported = 0
  let appended = 0
  let skipped = 0
  let failed = 0
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  for (const target of files) {
    try {
      const r = await importChatgptFile(ctx, target, args, { registryDir, persisted: persistedSet })
      imported += r.imported
      alreadyImported += r.alreadyImported
      appended += r.appended
      skipped += r.skipped
      failed += r.failed
      results.push(...r.results)
    } catch (err) {
      const path = target.displayPath || ctx.fs.processPath(target)
      failed++
      results.push({ path, status: 'failed', error: String((err && err.message) || err) })
    }
  }
  return { total: results.length, imported, alreadyImported, appended, skipped, failed, results }
}

// ── import_grokbuild 编排：源是会话目录（summary.json + chat_history.jsonl）────

// 会话目录复合 stat：两文件 size/version 拼接（任一文件变化 → 复合指纹变化 → 重读）。
// registry 的 sizeBytes/version 落复合值，REQ-24 短路径判定对双文件都有效。
export async function grokbuildStat(ctx, summaryTarget, chatTarget) {
  const s = await ctx.fs.stat(summaryTarget)
  const c = await ctx.fs.stat(chatTarget)
  return {
    type: 'file',
    size: (s && typeof s.size === 'number' ? s.size : 0) + (c && typeof c.size === 'number' ? c.size : 0),
    version: (s ? s.version : '') + '|' + (c ? c.version : ''),
  }
}

// 递归收集会话目录：目录含 summary.json 即会话（收下，不下钻）；否则 recursive 时
// 下钻（sessions 根 → <project>/ → <session_id>/ 两级结构）。
export async function collectGrokbuildSessions(ctx, dirTarget, out, recursive) {
  const entries = await ctx.fs.listDir(dirTarget)
  for (const entry of entries) {
    if (entry.type !== 'directory') continue
    const sub = await ctx.fs.resolve(entry.target.displayPath || entry.target.targetKey)
    const sumTarget = await ctx.fs.resolve(join(sub.targetKey, 'summary.json'))
    const sumStat = await ctx.fs.stat(sumTarget)
    if (sumStat && sumStat.type === 'file') {
      out.push(sub)
    } else if (recursive) {
      await collectGrokbuildSessions(ctx, sub, out, recursive)
    }
  }
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

// 单会话目录导入（REQ-24 状态机）：幂等键 = 会话目录路径；复合 stat 指纹；
// 读 summary.json + chat_history.jsonl 再转换落盘。persisted 可传共享快照。
export async function importGrokbuildSession(ctx, target, args, { registryDir, persisted } = {}) {
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  const archivedIds = archivedSessionIds(ctx)
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const registry = await loadImports(registryDir)
  let known = unwrapRecord(registry.imports[sourcePath])
  if (known && known.kind !== 'single') known = null
  // 记录指向的会话已不存在（被删 / DSH_HOME 迁移）或被归档（隐藏但仍占 id）
  // → 视作无记录重导（归档会话保留，重导建后缀新副本）
  if (known && (!known.dshId || !persistedSet.has(known.dshId) || archivedIds.has(known.dshId))) known = null
  const fingerprint = argsFingerprint(args, [])

  const summaryTarget = await ctx.fs.resolve(join(sourcePath, 'summary.json'))
  const chatTarget = await ctx.fs.resolve(join(sourcePath, 'chat_history.jsonl'))
  const stat = await grokbuildStat(ctx, summaryTarget, chatTarget)

  // S3 短路径（不 readText）：force / 显式 sessionId 变更需读文件建副本，不在此跳过
  if (known && args.force !== true && args.replace !== true && !isSessionIdChange(args, known.dshId)) {
    if (typeof known.args === 'string' && fingerprint !== known.args) {
      return { sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported', argsChanged: true }
    }
    // REQ-37：预算变化（文件未变）→ 跳过并报告（同 argsChanged 语义）
    if (typeof known.budget === 'number' && known.budget !== args.budget) {
      return { sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported', budgetChanged: true }
    }
    if (stat && stat.version === known.version && stat.size === known.sizeBytes) {
      return { sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported' }
    }
  }

  const summaryText = await ctx.fs.readText(summaryTarget)
  const chatText = await readGrokHistory(ctx, chatTarget)
  const out = markTrimmedSource(convertGrokbuildJson(summaryText, chatText, { ...args, sourcePath }), args)
  finalizeConvertedSession(out, args, 'Grok Build')
  // 无可导入内容（空 chat_history / 畸形 summary）：计入 skipped，不落盘空会话
  if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
    const res = { sessionId: 'none', turns: 0, messages: 0, toolCalls: 0, skipped: 1, alreadyImported: false, status: 'skipped' }
    if (out.skipReason) res.skipReason = out.skipReason
    return attachReq26(out, res)
  }
  const decision = await decideSingle(ctx, { known, converted: out, stat, args, fingerprint, persisted: persistedSet, sourcePath, budget: args.budget, archivedIds, importFormat: 'grokbuild' })
  return attachReq26(out, await runDecision(ctx, decision, registryDir, sourcePath, persistedSet, { workspaceMode: args.workspaceMode, workspaceDir: args.workspaceDir }))
}

// grokbuild 目录批量：递归扫 summary.json 收集会话目录，逐目录走单会话状态机。
export async function importGrokbuildDirectory(ctx, dirTarget, args, { registryDir, persisted } = {}) {
  const sessions = []
  await collectGrokbuildSessions(ctx, dirTarget, sessions, args.recursive !== false)
  const results = []
  let imported = 0
  let alreadyImported = 0
  let appended = 0
  let skipped = 0
  let failed = 0
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  for (const target of sessions) {
    const path = target.displayPath || ctx.fs.processPath(target)
    try {
      const single = await importGrokbuildSession(ctx, target, { ...args, force: args.force === true }, { registryDir, persisted: persistedSet })
      if (single.status === 'imported') imported++
      else if (single.status === 'appended') appended++
      else if (single.status === 'already-imported') alreadyImported++
      else skipped++
      const item = batchItem(path, single)
      if (item.status === 'skipped' && !item.reason) item.reason = 'not a grokbuild session (no user turns)'
      results.push(item)
    } catch (err) {
      failed++
      results.push({ path, status: 'failed', error: String((err && err.message) || err) })
    }
  }
  return { total: sessions.length, imported, alreadyImported, appended, skipped, failed, results }
}

// ── import_hermes 编排：state.db（SQLite，恒批量）或 sessions/*.jsonl 回退 ──────

// hermes 文件参数派生：无 session 记录时用文件 stem 作会话 id（幂等、确定性）。
export function hermesFileArgs(ctx, target) {
  const p = target.displayPath || ctx.fs.processPath(target)
  const base = String(p).split(/[\\/]/).pop() || ''
  return { fileStem: base.replace(/\.(jsonl|json)$/i, '') }
}

// hermes 单库导入：DB 内每个会话独立落盘，恒返回批量形态（对齐 importOpencodeFile）。
// REQ-24：DB 级 version/size 短路径检测；逐会话判增 append / 会话消失 missingFromSource。
// sessions 可预读传入（目录模式已读一次判 db 可用性，避免二次打开）。
export async function importHermesDbFile(ctx, target, args, { registryDir, persisted, sessions } = {}) {
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  const archivedIds = archivedSessionIds(ctx)
  const path = target.displayPath || ctx.fs.processPath(target)
  const stat = await ctx.fs.stat(target)
  const registry = await loadImports(registryDir)
  let known = unwrapRecord(registry.imports[path])
  if (known && known.kind !== 'multi') known = null
  const fingerprint = argsFingerprint(args, [])

  // S3 短路径（不重读 SQLite）。仅当记录里所有会话仍存在且未被归档时短路径才成立
  if (known && (!known.sessions || typeof known.sessions !== 'object')) known = null
  if (known && args.force !== true && args.replace !== true) {
    const subs = Object.values(known.sessions)
    const allPersisted = subs.length > 0 && subs.every((sub) => persistedSet.has(sub.dshId) && !archivedIds.has(sub.dshId))
    if (allPersisted) {
      const skipResults = () => Object.entries(known.sessions).map(([, sub]) => ({
        path, status: 'already-imported', sessionId: sub.dshId, turns: sub.turns, messages: 0, toolCalls: 0, skipped: 0,
      }))
      if (typeof known.args === 'string' && fingerprint !== known.args) {
        const results = skipResults().map((r) => ({ ...r, argsChanged: true }))
        return { total: results.length, imported: 0, alreadyImported: results.length, appended: 0, skipped: 0, failed: 0, results }
      }
      // REQ-37：预算变化 → 跳过并上报 budgetChanged（同 argsChanged 语义）
      if (typeof known.budget === 'number' && known.budget !== args.budget) {
        const results = skipResults().map((r) => ({ ...r, budgetChanged: true }))
        return { total: results.length, imported: 0, alreadyImported: results.length, appended: 0, skipped: 0, failed: 0, results }
      }
      if (stat && stat.version === known.version && stat.size === known.sizeBytes) {
        const count = Object.keys(known.sessions).length
        return { total: count, imported: 0, alreadyImported: count, appended: 0, skipped: 0, failed: 0, results: skipResults() }
      }
    }
  }

  const dbSessions0 = sessions ?? readHermesDb(path)
  if (dbSessions0 === null) throw new Error('hermes db 不可用（非 SQLite / 无 sessions 表）: ' + path)
  const preSkipped = []
  // REQ-51 lineage 过滤：lineage:'tail' 只导叶子链尾（非任何会话的父会话）；
  // 父会话（压缩分叉节点，通常无消息）跳过并标注 lineage 原因（不静默）
  let dbSessions = dbSessions0
  const isParent = new Set(dbSessions.filter((s) => dbSessions0.some((o) => o.id !== s.id && o.parentSessionId === s.id)).map((s) => s.id))
  if (args.lineage === 'tail') {
    const kept = dbSessions.filter((s) => !isParent.has(s.id))
    const dropped = dbSessions.filter((s) => isParent.has(s.id))
    dbSessions = kept
    for (const s of dropped) {
      preSkipped.push({ path, status: 'skipped', reason: 'lineage tail: parent session ' + s.id + '（有子会话，非叶子链尾）' })
    }
  }
  const items = []
  for (const s of dbSessions) {
    const out = markTrimmedSource(convertHermesJson(JSON.stringify(s), { ...args, sourcePath: path }), args)
    finalizeConvertedSession(out, args, 'Hermes')
    if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
      // 无用户回合跳过；compaction 父会话（有子会话）标注 lineage 原因
      const lineageNote = isParent.has(s.id) ? '（compaction 分叉父会话，lineage）' : ''
      preSkipped.push({ path, status: 'skipped', reason: 'no user turns (session ' + s.id + ')' + lineageNote })
      continue
    }
    items.push({ key: s.id, converted: out })
  }
  const decision = await decideMulti(ctx, { known, items, stat, args, fingerprint, persisted: persistedSet, sourcePath: path, subTable: 'sessions', budget: args.budget, archivedIds, importFormat: 'hermes' })
  const missing = known && known.sessions ? Object.keys(known.sessions).filter((k) => !dbSessions.some((s) => s.id === k)) : []
  const result = await runDecision(ctx, decision, registryDir, path, persistedSet, { workspaceMode: args.workspaceMode, workspaceDir: args.workspaceDir })
  return {
    ...result,
    total: dbSessions.length,
    skipped: result.skipped + preSkipped.length,
    results: [...preSkipped, ...result.results],
    ...(missing.length ? { missingFromSource: missing } : {}),
  }
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

// 会话目录复合 stat：wire.jsonl + state.json 两文件 size/version 拼接（任一文件变化
// → 复合指纹变化 → 重读；标题在 state.json，custom_title 变更也要触发重读）。
export async function kimiStat(ctx, wireTarget, stateTarget) {
  const w = await ctx.fs.stat(wireTarget)
  const s = await ctx.fs.stat(stateTarget)
  return {
    type: 'file',
    size: (w && typeof w.size === 'number' ? w.size : 0) + (s && typeof s.size === 'number' ? s.size : 0),
    version: (w ? w.version : '') + '|' + (s ? s.version : ''),
  }
}

// 递归收集会话目录：目录含 wire.jsonl（旧）或 agents/main/wire.jsonl（新）即会话
//（收下，不下钻——子代理 wire 不并入）；否则 recursive 时下钻。
export async function collectKimiSessions(ctx, dirTarget, out, recursive) {
  const entries = await ctx.fs.listDir(dirTarget)
  for (const entry of entries) {
    if (entry.type !== 'directory') continue
    const sub = await ctx.fs.resolve(entry.target.displayPath || entry.target.targetKey)
    if (await kimiIsSessionDir(ctx, sub)) {
      out.push(sub)
    } else if (recursive) {
      await collectKimiSessions(ctx, sub, out, recursive)
    }
  }
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
  if (state && typeof state.cwd === 'string' && state.cwd) {
    derived.cwd = state.cwd
  } else {
    const cwd = await kimiWorkDirByHash(ctx, String(p), hashDirName)
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

// 单会话目录导入（REQ-24 状态机）：幂等键 = 会话目录路径；复合 stat 指纹；读
// wire.jsonl + state.json 再转换落盘。persisted 可传共享快照。
export async function importKimiSession(ctx, target, args, { registryDir, persisted } = {}) {
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  const archivedIds = archivedSessionIds(ctx)
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const registry = await loadImports(registryDir)
  let known = unwrapRecord(registry.imports[sourcePath])
  if (known && known.kind !== 'single') known = null
  // 记录指向的会话已不存在（被删 / DSH_HOME 迁移）或被归档（隐藏但仍占 id）
  // → 视作无记录重导（归档会话保留，重导建后缀新副本）
  if (known && (!known.dshId || !persistedSet.has(known.dshId) || archivedIds.has(known.dshId))) known = null
  const fingerprint = argsFingerprint(args, [])
  const derived = await kimiDeriveArgs(ctx, target)
  const merged = { ...args, ...derived }

  const wireTarget = await kimiWireTarget(ctx, sourcePath)
  const stateTarget = await ctx.fs.resolve(join(sourcePath, 'state.json'))
  const stat = await kimiStat(ctx, wireTarget, stateTarget)

  // S3 短路径（不 readText）：force / 显式 sessionId 变更需读文件建副本，不在此跳过
  if (known && merged.force !== true && merged.replace !== true && !isSessionIdChange(merged, known.dshId)) {
    if (typeof known.args === 'string' && fingerprint !== known.args) {
      return { sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported', argsChanged: true }
    }
    // REQ-37：预算变化（文件未变）→ 跳过并报告（同 argsChanged 语义）
    if (typeof known.budget === 'number' && known.budget !== merged.budget) {
      return { sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported', budgetChanged: true }
    }
    if (stat && stat.version === known.version && stat.size === known.sizeBytes) {
      return { sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported' }
    }
  }

  const wireText = await ctx.fs.readText(wireTarget)
  const out = markTrimmedSource(convertKimiWire(wireText, { ...merged, sourcePath }), merged)
  finalizeConvertedSession(out, merged, 'Kimi CLI')
  // 无可导入内容（空 wire / 畸形文件）：计入 skipped，不落盘空会话
  if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
    const res = { sessionId: 'none', turns: 0, messages: 0, toolCalls: 0, skipped: 1, alreadyImported: false, status: 'skipped' }
    if (out.skipReason) res.skipReason = out.skipReason
    return attachReq26(out, res)
  }
  const decision = await decideSingle(ctx, { known, converted: out, stat, args: merged, fingerprint, persisted: persistedSet, sourcePath, budget: merged.budget, archivedIds, importFormat: 'kimi' })
  return attachReq26(out, await runDecision(ctx, decision, registryDir, sourcePath, persistedSet, { workspaceMode: args.workspaceMode, workspaceDir: args.workspaceDir }))
}

// kimi 目录批量：递归扫 wire.jsonl 收集会话目录，逐目录走单会话状态机。
export async function importKimiDirectory(ctx, dirTarget, args, { registryDir, persisted } = {}) {
  const sessions = []
  await collectKimiSessions(ctx, dirTarget, sessions, args.recursive !== false)
  const results = []
  let imported = 0
  let alreadyImported = 0
  let appended = 0
  let skipped = 0
  let failed = 0
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  for (const target of sessions) {
    const path = target.displayPath || ctx.fs.processPath(target)
    try {
      const single = await importKimiSession(ctx, target, { ...args, force: args.force === true, replace: args.replace === true }, { registryDir, persisted: persistedSet })
      if (single.status === 'imported') imported++
      else if (single.status === 'replaced') imported++
      else if (single.status === 'appended') appended++
      else if (single.status === 'already-imported') alreadyImported++
      else skipped++
      const item = batchItem(path, single)
      if (item.status === 'skipped' && !item.reason) item.reason = 'not a kimi session (no user turns)'
      results.push(item)
    } catch (err) {
      failed++
      results.push({ path, status: 'failed', error: String((err && err.message) || err) })
    }
  }
  return { total: sessions.length, imported, alreadyImported, appended, skipped, failed, results }
}

// kimi 单文件入口：会话目录 → 单会话状态机（importKimiSession）；wire.jsonl →
// 标准单文件导入（幂等键 = 文件路径；kimiId/cwd/title 由 deriveArgs 预先派生）。
export async function importKimiFile(ctx, target, args, { registryDir } = {}) {
  const info = await ctx.fs.stat(target)
  if (info && info.type === 'directory') return importKimiSession(ctx, target, args, { registryDir })
  return importTranscript(ctx, target, args, convertKimiWire, { registryDir })
}

// ── REQ-17 预览（特殊形态来源，与正式导入同源，零副作用）────────────────────

// ChatGPT 单文件预览：一个 conversations.json 逐会话预览（与 importChatgptFile 同源）。
export async function previewChatgptFile(ctx, target, args) {
  const path = target.displayPath || ctx.fs.processPath(target)
  const { conversations, skipped } = convertChatgptJson(await ctx.fs.readText(target), { sourcePath: path, budget: args.budget })
  const results = conversations.map((conv) => ({ path, ...previewEntry(conv) }))
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
  const out = markTrimmedSource(convertGrokbuildJson(await ctx.fs.readText(summaryTarget), await readGrokHistory(ctx, chatTarget), { ...args, sourcePath }), args)
  return previewEntry(out)
}

export async function previewGrokbuildDirectory(ctx, dirTarget, args) {
  const sessions = []
  await collectGrokbuildSessions(ctx, dirTarget, sessions, args.recursive !== false)
  const results = []
  for (const target of sessions) {
    const path = target.displayPath || ctx.fs.processPath(target)
    try {
      results.push({ path, ...(await previewGrokbuildSession(ctx, target, args)) })
    } catch (err) {
      results.push({ path, status: 'failed', error: String((err && err.message) || err) })
    }
  }
  return { total: sessions.length, results }
}

// hermes DB 预览：state.db 每会话转换（与 importHermesDbFile 同源），零副作用。
// REQ-51：lineage:'tail' 预览同样只列叶子链尾（与正式导入一致）。
export async function previewHermesDbFile(ctx, target, args, { sessions } = {}) {
  const path = target.displayPath || ctx.fs.processPath(target)
  const dbSessions0 = sessions ?? readHermesDb(path)
  if (dbSessions0 === null) throw new Error('hermes db 不可用（非 SQLite / 无 sessions 表）: ' + path)
  let dbSessions = dbSessions0
  if (args.lineage === 'tail') {
    const isParent = new Set(dbSessions.filter((s) => dbSessions0.some((o) => o.id !== s.id && o.parentSessionId === s.id)).map((s) => s.id))
    dbSessions = dbSessions.filter((s) => !isParent.has(s.id))
  }
  const results = []
  for (const s of dbSessions) {
    const out = markTrimmedSource(convertHermesJson(JSON.stringify(s), { ...args, sourcePath: path }), args)
    if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
      results.push({ path, skipped: 1, skipReason: 'no user turns (session ' + s.id + ')' })
      continue
    }
    results.push({ path, ...previewEntry(out) })
  }
  return { total: dbSessions.length, results }
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
  const out = markTrimmedSource(convertKimiWire(await ctx.fs.readText(wireTarget), { ...args, ...derived, sourcePath }), args)
  return previewEntry(out)
}

export async function previewKimiFile(ctx, target, args) {
  const info = await ctx.fs.stat(target)
  if (info && info.type === 'directory') return previewKimiSession(ctx, target, args)
  return previewTranscript(ctx, target, args, convertKimiWire)
}

export async function previewKimiDirectory(ctx, dirTarget, args) {
  const sessions = []
  await collectKimiSessions(ctx, dirTarget, sessions, args.recursive !== false)
  const results = []
  for (const target of sessions) {
    const path = target.displayPath || ctx.fs.processPath(target)
    try {
      results.push({ path, ...(await previewKimiSession(ctx, target, args)) })
    } catch (err) {
      results.push({ path, status: 'failed', error: String((err && err.message) || err) })
    }
  }
  return { total: sessions.length, results }
}

// opencode 预览：lib/opencode.mjs 的 importOpencodeFile 编排（registry / decideMulti /
// 落盘）不属于预览分支，这里用同源只读件重演「读库 → 逐会话转换 → 统计」：
// readOpencodeDb 只读 SQLite、convertOpencodeJson 纯函数，两者都零副作用。
export async function previewOpencodeFile(ctx, target, args) {
  const path = target.displayPath || ctx.fs.processPath(target)
  const sessions = readOpencodeDb(path, { fullHistory: args.fullHistory === true })
  const wanted = Array.isArray(args.sessionIds) && args.sessionIds.length > 0 ? new Set(args.sessionIds) : null
  const results = []
  for (const s of sessions) {
    if (wanted && !wanted.has(s.id)) continue
    const out = markTrimmedSource(convertOpencodeJson(JSON.stringify(s), { ...args, sourcePath: path }), args)
    if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
      results.push({ path, skipped: 1, skipReason: 'no user turns (session ' + s.id + ')' })
      continue
    }
    results.push({ path, ...previewEntry(out) })
  }
  return { total: sessions.length, results }
}

export async function previewOpencodeDirectory(ctx, dirTarget, args) {
  const dirPath = dirTarget.displayPath || ctx.fs.processPath(dirTarget)
  const dbTarget = await ctx.fs.resolve(join(dirPath, 'opencode.db'))
  return previewOpencodeFile(ctx, dbTarget, args)
}

// mimocode 预览：opencode fork，同构 SQLite 只读重演（readMimocodeDb 已兼容无 model
// 列 schema 并默认剔除后台任务会话），provider 标签为 mimocode。
export async function previewMimocodeFile(ctx, target, args) {
  const path = target.displayPath || ctx.fs.processPath(target)
  const sessions = readMimocodeDb(path, { fullHistory: args.fullHistory === true })
  const wanted = Array.isArray(args.sessionIds) && args.sessionIds.length > 0 ? new Set(args.sessionIds) : null
  const results = []
  for (const s of sessions) {
    if (wanted && !wanted.has(s.id)) continue
    const out = markTrimmedSource(convertMimocodeJson(JSON.stringify(s), { ...args, sourcePath: path }), args)
    if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
      results.push({ path, skipped: 1, skipReason: 'no user turns (session ' + s.id + ')' })
      continue
    }
    results.push({ path, ...previewEntry(out) })
  }
  return { total: sessions.length, results }
}

export async function previewMimocodeDirectory(ctx, dirTarget, args) {
  const dirPath = dirTarget.displayPath || ctx.fs.processPath(dirTarget)
  const dbTarget = await ctx.fs.resolve(join(dirPath, 'mimocode.db'))
  return previewMimocodeFile(ctx, dbTarget, args)
}

// zcode 预览：db.sqlite / transcript.jsonl 回退 / zcode://<id> 伪路径，同源只读重演
//（lib/zcode.mjs 编排不可改，预览绕开 registry / decideMulti / 落盘）。
export async function previewZcodeFile(ctx, target, args) {
  const rawPath = typeof args.path === 'string' ? args.path : ''
  const isPseudo = rawPath.startsWith('zcode://')
  const path = isPseudo ? rawPath : (target.displayPath || ctx.fs.processPath(target))
  const zcodeId = typeof args.zcodeId === 'string' && args.zcodeId
    ? args.zcodeId
    : isPseudo ? rawPath.slice('zcode://'.length) : undefined
  const sessions = isPseudo ? readZcodeDb(zcodeDefaultDbPath())
    : (/\.jsonl$/i.test(String(path)) ? readZcodeTranscript(path) : readZcodeDb(path))
  const wanted = zcodeId ? new Set([zcodeId])
    : (Array.isArray(args.sessionIds) && args.sessionIds.length > 0 ? new Set(args.sessionIds) : null)
  const results = []
  if (zcodeId && !sessions.some((s) => s.id === zcodeId)) {
    results.push({ path, skipped: 1, skipReason: 'zcode 会话不存在: ' + zcodeId })
  }
  for (const s of sessions) {
    if (wanted && !wanted.has(s.id)) continue
    const out = markTrimmedSource(convertZcodeJson(JSON.stringify(s), { ...args, sourcePath: path }), args)
    if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
      results.push({ path, skipped: 1, skipReason: 'no user turns (session ' + s.id + ')' })
      continue
    }
    results.push({ path, ...previewEntry(out) })
  }
  return { total: sessions.length, results }
}

export async function previewZcodeDirectory(ctx, dirTarget, args) {
  const dirPath = dirTarget.displayPath || ctx.fs.processPath(dirTarget)
  const dbTarget = await ctx.fs.resolve(join(dirPath, 'db.sqlite'))
  return previewZcodeFile(ctx, dbTarget, args)
}
