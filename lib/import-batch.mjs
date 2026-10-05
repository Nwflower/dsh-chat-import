// lib/import-batch.mjs — 批量导入的共用件：目录收集、批量计数口径、结果条目归一
//
// 目录批量（标准来源 / grokbuild / kimi / vibe / codex / bundle）、多会话源（一库多会话
// 的 decideMulti）与嵌套批（面板多选、Trae 多库）都按同一口径计数：
//   imported        新落一份会话（含 replace 覆盖重导——同样是完整写入一份）
//   appended        既有会话续写尾部
//   alreadyImported 源未变 / 内容未变 / 只能跳过的已导入状态
//   skipped         无可导入内容 / 被忽略（ignored）
//   failed          单项抛错（不中断整批）
//   reimported      其中「重导另铸副本」的条数（已含在 imported 里）
// 图片与未归组汇总（images / imagesDegraded / ungrouped）>0 才占键。计数口径各写一份时
// 已经漂移过（有的批量把 replaced 记成 skipped），所以收在这里。
// 无依赖：只消费调用方传入的 ctx.fs 与结果对象。

// ── 目录收集 ──────────────────────────────────────────────────────────────

/**
 * 递归收集目录下满足 accept(entry) 的文件 target，追加进 out 并返回 out。顺序依赖
 * ctx.fs.listDir 的名称排序契约（mock host 按名排序，真实 fs 服务同契），不做二次排序。
 * recursive 为 false 时只看本层。
 */
export async function collectFiles(ctx, dirTarget, out, recursive, accept) {
  for (const entry of await ctx.fs.listDir(dirTarget)) {
    if (entry.type === 'directory') {
      if (recursive) await collectFiles(ctx, entry.target, out, recursive, accept)
    } else if (entry.type === 'file' && accept(entry)) {
      out.push(entry.target)
    }
  }
  return out
}

// 会话主 transcript 的伴生 JSONL（事件日志 / 冲突日志 / 守护文件）不是会话本身，
// 目录批量扫描时排除（Reasonix V2 的 <id>.events.jsonl 是 WAL，非主 transcript）。
export function isSidecarJsonl(name) {
  return /\.(events|conflicts|guardian)\.jsonl$/i.test(name)
}

/** 递归收集 .jsonl（排除伴生 JSONL）。第 5 个参数（collector 协议里的 args）不消费。 */
export function collectJsonlFiles(ctx, dirTarget, out, recursive) {
  return collectFiles(ctx, dirTarget, out, recursive, (e) => /\.jsonl$/i.test(e.name) && !isSidecarJsonl(e.name))
}

/** 递归收集 .json（ChatGPT 导出 / Gemini 会话）。 */
export function collectJsonFiles(ctx, dirTarget, out, recursive) {
  return collectFiles(ctx, dirTarget, out, recursive, (e) => /\.json$/i.test(e.name))
}

// ── 批量计数 ──────────────────────────────────────────────────────────────

/** 空计数器（键集即批量结果的计数口径）。 */
export function createBatchTally() {
  return { imported: 0, alreadyImported: 0, appended: 0, reimported: 0, skipped: 0, failed: 0, images: 0, imagesDegraded: 0, ungrouped: 0 }
}

/** 单项结果（单会话导入结果 / decideMulti 的逐会话决策）按 status 计入。 */
export function tallyItem(tally, item) {
  const status = item && item.status
  if (status === 'imported' || status === 'replaced') tally.imported++
  else if (status === 'appended') tally.appended++
  else if (status === 'already-imported') tally.alreadyImported++
  else if (status === 'failed') tally.failed++
  else tally.skipped++
  if (item && item.reimported) tally.reimported++
  if (item && typeof item.images === 'number') tally.images += item.images
  if (item && typeof item.imagesDegraded === 'number') tally.imagesDegraded += item.imagesDegraded
  if (item && typeof item.ungrouped === 'number') tally.ungrouped += item.ungrouped
  else if (item && item.ungrouped) tally.ungrouped += 1
  return tally
}

/** 嵌套批量结果（多会话源的单库结果 / 子批）逐键累加。 */
export function tallyBatch(tally, batch) {
  for (const key of Object.keys(tally)) {
    if (batch && typeof batch[key] === 'number') tally[key] += batch[key]
  }
  return tally
}

/** 批量结果骨架：total + 计数 + 汇总（图片 / 未归组 >0 才占键）+ results。 */
export function batchSummary(tally, total, results) {
  return {
    total,
    imported: tally.imported,
    alreadyImported: tally.alreadyImported,
    appended: tally.appended,
    reimported: tally.reimported,
    skipped: tally.skipped,
    failed: tally.failed,
    ...(tally.images > 0 ? { images: tally.images } : {}),
    ...(tally.imagesDegraded > 0 ? { imagesDegraded: tally.imagesDegraded } : {}),
    ...(tally.ungrouped > 0 ? { ungrouped: tally.ungrouped } : {}),
    results,
  }
}

// ── 结果条目 ──────────────────────────────────────────────────────────────

// 单文件结果透到批量条目的可选字段（skipReason 改名 reason，其余原样）。
const BATCH_ITEM_FIELDS = [
  'skipReason', 'error', 'appendedTurns', 'appendedEvents', 'appendedSkipped', 'sourceShrunk', 'storedShrunk',
  'changedInPlace', 'argsChanged', 'budgetChanged', 'backfilled', 'droppedBoundaryResults', 'orphanToolResults',
  'duplicateToolResults', 'metaMessages', 'images', 'imagesDegraded', 'toolUseResultsMerged', 'backendToolCalls',
  'droppedToolResultBlocks', 'droppedMalformedOutputs', 'droppedMalformedArgs', 'externalAgent', 'reimported',
  'staleGhost', 'trimmed', 'skippedLines', 'secrets', 'permissionCount', 'walMerged', 'walRecords', 'compacted',
  'compactions', 'compactionSummaryMissing', 'replaced', 'workspace', 'workspaceMode', 'workspaceCreated',
  'ungrouped', 'ungroupedReason',
]

/** 把单文件结果归一为批量 results 条目（skipReason → reason；可选字段原样带过）。 */
export function batchItem(path, single) {
  const item = {
    path,
    status: single.status,
    sessionId: single.sessionId,
    turns: single.turns,
    messages: single.messages,
    toolCalls: single.toolCalls,
    skipped: single.skipped,
  }
  for (const k of BATCH_ITEM_FIELDS) {
    if (single[k] !== undefined) item[k === 'skipReason' ? 'reason' : k] = single[k]
  }
  return item
}

/** 单项失败条目（失败要大声：错误原文进结果，不中断整批）。 */
export function failedItem(path, err) {
  return { path, status: 'failed', error: String((err && err.message) || err) }
}
