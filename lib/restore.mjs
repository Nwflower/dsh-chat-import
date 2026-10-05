// lib/restore.mjs — restore_bundle：interchange bundle → 可继续 DSH 会话（host 面）
//
// 还原 = registry「源未变」短路径（未变的 bundle 不读不校验）→ 读 bundle 文件 →
// verifyBundle 双层指纹校验（损坏检测，失败大声抛错）→ 抽取 log 文本 → 复用 import_dsh
// 同款状态机（convertDshJsonl + decideSingle + runDecision，幂等键 = bundle 文件路径）。
// 跨机器：bundle 携带 originalCwd（A 机原
// 路径）；B 机不可达时 attachToWorkspace 按轻量 cwd 回退到 bundle 文件目录归组，
// 结果报告 cwdAvailable:false + landingHint + groupedTo + restoreNote（不静默）。
// dryRun/preview 走标准预览分支（零副作用）。

import { convertDshJsonl } from './convert/index.mjs'
import { verifyBundle } from './export/index.mjs'
import { finishConversion, decideAndRunSingle, isEmptyConversion, isPreview, previewConverted } from './import-core.mjs'
import { createBatchTally, tallyItem, failedItem } from './import-batch.mjs'
import { loadKnownRecord, singleShortPath } from './import-state.mjs'
import { argsFingerprint, beginRegistryBatch, endRegistryBatch } from './imports.mjs'

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
  if (isPreview(args)) {
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
    const out = previewConverted(convertDshJsonl(doc.log, { ...args, sourcePath }), args)
    return { mode: 'single', preview: true, ...out, originalCwd: doc.originalCwd ?? null, landingHint: doc.landingHint ?? null }
  }

  // 正式还原：幂等状态机（registry 短路径 → 读 → 校验 → 决策落盘）。短路径只看
  // registry 与 stat：bundle 未变（version/size 同上次还原）即跳过，不读也不重算指纹——
  // 内容一旦被改动，stat 随之变化，照常走下方的完整校验。
  const state = await loadKnownRecord(ctx, sourcePath, { registryDir })
  const fingerprint = argsFingerprint(args, [])
  const skip = singleShortPath(state.known, args, fingerprint, stat)
  if (skip) return { mode: 'single', ...skip }

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

  // 还原是 DSH 会话的事件级回放：不钉来源标题（标题原样保留），其余收尾同其它来源
  const out = await finishConversion(ctx, convertDshJsonl(doc.log, { ...args, sourcePath }), args, { sourcePath, pinTitle: false })
  if (isEmptyConversion(out)) {
    return { mode: 'single', sessionId: 'none', turns: 0, messages: 0, toolCalls: 0, skipped: 1, alreadyImported: false, status: 'skipped', skipReason: 'bundle 无可导入内容' }
  }
  // 不附加转换明细：restore_bundle 的输出 schema 只认还原相关字段
  const res = await decideAndRunSingle(ctx, out, { ...state, stat, args, fingerprint, sourcePath, importFormat: 'dsh', registryDir })

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

// 目录模式还原：目录下每个 .dshbundle.json 独立还原（复用 importDirectory 收集器
// 不需要——bundle 是显式路径，目录批量按 .dshbundle.json 收集逐文件走 restoreBundle）。
export async function restoreBundleDirectory(ctx, dirTarget, args, { registryDir } = {}) {
  const files = []
  await collectBundleFiles(ctx, dirTarget, files, args.recursive !== false)
  const results = []
  const tally = createBatchTally()
  // 批处理通道：逐 bundle 的 registry 记录合并为末尾一次提交（同 importDirectory）。
  beginRegistryBatch(registryDir)
  try {
    for (const target of files) {
      const path = target.displayPath || ctx.fs.processPath(target)
      try {
        const single = await restoreBundle(ctx, { ...args, path, force: args.force === true }, { registryDir })
        tallyItem(tally, single)
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
        tally.failed++
        results.push(failedItem(path, err))
      }
    }
  } finally {
    await endRegistryBatch()
  }
  // restore_bundle 的批量 schema 只有这几个计数（reimported 在它的 schema 里是逐条对象）
  const { imported, alreadyImported, appended, skipped, failed } = tally
  return { mode: 'batch', total: files.length, imported, alreadyImported, appended, skipped, failed, results }
}

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
