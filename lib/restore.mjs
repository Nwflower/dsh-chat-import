// lib/restore.mjs — restore_bundle：interchange bundle → 可继续 DSH 会话（host 面）
//
// 还原 = 读 bundle 文件 → verifyBundle 双层指纹校验（损坏检测，失败大声
// 抛错）→ 抽取 log 文本 → 复用 import_dsh 同款状态机（convertDshJsonl + decideSingle
// + runDecision，幂等键 = bundle 文件路径）。跨机器：bundle 携带 originalCwd（A 机原
// 路径）；B 机不可达时 attachToWorkspace 按轻量 cwd 回退到 bundle 文件目录归组，
// 结果报告 cwdAvailable:false + landingHint + groupedTo + restoreNote（不静默）。
// dryRun/preview 走标准预览分支（零副作用）。

import { convertDshJsonl } from './convert/index.mjs'
import { verifyBundle } from './export/index.mjs'
import { markTrimmedSource } from './budget.mjs'
import { runDecision } from './import-core.mjs'
import {
  loadImports, unwrapRecord, listPersistedIds, archivedSessionIds,
  argsFingerprint, isSessionIdChange, decideSingle,
  beginRegistryBatch, endRegistryBatch,
} from './imports.mjs'

// 跨机器落点判定：originalCwd 是否可达（stat 目录）。可达性只用于**报告**，实际归组
// 由 runDecision 的 workspace-group 决定（返回 workspace / ungrouped*），这里不再替它
// 猜「已回退归组到 bundle 目录」——那句在宿主上根本不成立（见 docs/architecture.md D16）。
async function cwdReachable(ctx, originalCwd) {
  if (typeof originalCwd !== 'string' || !originalCwd) return false
  try {
    const st = await ctx.fs.stat(await ctx.fs.resolve(originalCwd))
    return !!(st && st.type === 'directory')
  } catch {
    return false
  }
}

export async function restoreBundle(ctx, args, { registryDir } = {}) {
  const target = await ctx.fs.resolve(args.path)
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const stat = await ctx.fs.stat(target)

  // 标准 dry-run 预览（与 import_dsh 同源）：不校验指纹之外的副作用（只读转换）
  if (args.preview === true || args.dryRun === true) {
    const raw = await ctx.fs.readText(target)
    let doc
    try {
      doc = JSON.parse(raw)
    } catch {
      return { mode: 'single', preview: true, turns: 0, messages: 0, toolCalls: 0, skipped: 1, skipReason: 'bundle 解析失败（非 JSON）' }
    }
    const check = verifyBundle(doc)
    if (!check.ok) {
      return { mode: 'single', preview: true, turns: 0, messages: 0, toolCalls: 0, skipped: 1, skipReason: 'bundle 校验失败: ' + check.problems.join('；') }
    }
    const out = markTrimmedSource(convertDshJsonl(doc.log, { ...args, sourcePath }), args)
    return { mode: 'single', preview: true, ...previewEntryOf(out), originalCwd: doc.originalCwd ?? null, landingHint: doc.landingHint ?? null }
  }

  // 正式还原：幂等状态机（registry 短路径 → 读 → 校验 → 决策落盘）
  const raw = await ctx.fs.readText(target)
  let doc
  try {
    doc = JSON.parse(raw)
  } catch (err) {
    throw new Error('bundle 解析失败: ' + String((err && err.message) || err))
  }
  const check = verifyBundle(doc)
  if (!check.ok) {
    throw new Error('bundle 校验失败（损坏检测）: ' + check.problems.join('；'))
  }

  const persisted = await listPersistedIds(ctx)
  const archivedIds = archivedSessionIds(ctx)
  const registry = await loadImports(registryDir)
  let known = unwrapRecord(registry.imports[sourcePath])
  if (known && known.kind !== 'single') known = null
  if (known && (!known.dshId || !persisted.has(known.dshId) || archivedIds.has(known.dshId))) known = null
  const fingerprint = argsFingerprint(args, [])

  if (known && args.force !== true && !isSessionIdChange(args, known.dshId)) {
    if (typeof known.args === 'string' && fingerprint !== known.args) {
      return { mode: 'single', sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported', argsChanged: true }
    }
    if (stat && stat.version === known.version && stat.size === known.sizeBytes) {
      return { mode: 'single', sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported' }
    }
  }

  const out = markTrimmedSource(convertDshJsonl(doc.log, { ...args, sourcePath }), args)
  if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
    return { mode: 'single', sessionId: 'none', turns: 0, messages: 0, toolCalls: 0, skipped: 1, alreadyImported: false, status: 'skipped', skipReason: 'bundle 无可导入内容' }
  }
  const decision = await decideSingle(ctx, { known, converted: out, stat, args, fingerprint, persisted, sourcePath, budget: args.budget, archivedIds, importFormat: 'dsh' })
  const res = await runDecision(ctx, decision, registryDir, sourcePath, persisted, { workspaceMode: args.workspaceMode, workspaceDir: args.workspaceDir })

  const originalCwd = typeof doc.originalCwd === 'string' ? doc.originalCwd : null
  const cwdAvailable = await cwdReachable(ctx, originalCwd)
  const groupedTo = typeof res.workspace === 'string' && res.workspace ? res.workspace : ''
  return {
    mode: 'single',
    ...res,
    sourceSessionId: doc.sourceSessionId,
    originalCwd,
    cwdAvailable,
    ...(doc.landingHint ? { landingHint: doc.landingHint } : {}),
    ...(groupedTo ? { groupedTo } : {}),
    // cwd 不可达必须报告（不静默），不阻断还原：说明原 cwd、本次实际落点（或未归组原因）
    ...(!cwdAvailable && originalCwd
      ? { restoreNote: '原 cwd 不可达（跨机器）: ' + originalCwd + '；' + (groupedTo ? '本次落点 ' + groupedTo : '未归组（' + (res.ungroupedReason || '原因未知') + '）') }
      : {}),
  }
}

// 预览条目（与 import-core previewEntry 同源，本地避免额外依赖）。
function previewEntryOf(out) {
  const noContent = !out.meta || (Array.isArray(out.turns) && out.turns.length === 0 && Array.isArray(out.events) && out.events.length === 0)
  const entry = {
    turns: Array.isArray(out.turns) ? out.turns.length : 0,
    messages: out.messages || 0,
    toolCalls: out.toolCalls || 0,
    skipped: noContent ? 1 : (out.skipped || 0),
  }
  if (out.title) entry.title = out.title
  if (out.meta && typeof out.meta.cwd === 'string' && out.meta.cwd) entry.cwd = out.meta.cwd
  if (out.meta && typeof out.meta.createdAt === 'number') entry.createdAt = out.meta.createdAt
  if (out.skipReason) entry.skipReason = out.skipReason
  return entry
}

// 目录模式还原：目录下每个 .dshbundle.json 独立还原（复用 importDirectory 收集器
// 不需要——bundle 是显式路径，目录批量按 .dshbundle.json 收集逐文件走 restoreBundle）。
export async function restoreBundleDirectory(ctx, dirTarget, args, { registryDir } = {}) {
  const files = []
  await collectBundleFiles(ctx, dirTarget, files, args.recursive !== false)
  const results = []
  let imported = 0
  let alreadyImported = 0
  let appended = 0
  let skipped = 0
  let failed = 0
  // 批处理通道：逐 bundle 的 registry 记录合并为末尾一次提交（同 importDirectory）。
  beginRegistryBatch(registryDir)
  try {
    for (const target of files) {
      const path = target.displayPath || ctx.fs.processPath(target)
      try {
        const single = await restoreBundle(ctx, { ...args, path, force: args.force === true }, { registryDir })
        if (single.status === 'imported') imported++
        else if (single.status === 'appended') appended++
        else if (single.status === 'already-imported') alreadyImported++
        else skipped++
        results.push({
          path,
          status: single.status,
          sessionId: single.sessionId,
          turns: single.turns,
          messages: single.messages,
          toolCalls: single.toolCalls,
          skipped: single.skipped,
          ...(single.restoreNote ? { restoreNote: single.restoreNote } : {}),
          ...(single.cwdAvailable !== undefined ? { cwdAvailable: single.cwdAvailable } : {}),
          ...(single.groupedTo ? { groupedTo: single.groupedTo } : {}),
          ...(single.ungrouped ? { ungrouped: single.ungrouped } : {}),
          ...(single.ungroupedReason ? { ungroupedReason: single.ungroupedReason } : {}),
          ...(single.error ? { error: single.error } : {}),
          ...(single.skipReason ? { reason: single.skipReason } : {}),
        })
      } catch (err) {
        failed++
        results.push({ path, status: 'failed', error: String((err && err.message) || err) })
      }
    }
  } finally {
    await endRegistryBatch()
  }
  return { mode: 'batch', total: files.length, imported, alreadyImported, appended, skipped, failed, results }}

// 递归收集 .dshbundle.json（顺序依赖 ctx.fs.listDir 名称排序契约）。
async function collectBundleFiles(ctx, dirTarget, out, recursive) {
  const entries = await ctx.fs.listDir(dirTarget)
  for (const entry of entries) {
    if (entry.type === 'directory') {
      if (recursive) await collectBundleFiles(ctx, entry.target, out, recursive)
    } else if (entry.type === 'file' && /\.dshbundle\.json$/i.test(entry.name)) {
      out.push(entry.target)
    }
  }
}
