// lib/backfill.mjs — REQ-36 反向同步：把 DSH 会话新增轮次增量写回 Claude Code JSONL
// （双向同步桥 B 第一步）。纯逻辑 + ctx 注入：只消费 sessionPersistence（list +
// readFrom）与 fs（resolve/stat/readText/writeText），registry 走 lib/imports.mjs；
// 本文件自身零 DSH 依赖（工具注册层的 @deepseek-ai/dsh-tools 依赖在
// lib/tools.mjs / lib/toolkit.mjs）。
//
// 写回语义：
//   - 目标 = 导入源文件（target:'source'）或 export_claude 导出的副本
//     （target:'copy'，需要 registry 的 exports 映射）。
//   - 首同步（无 writeback）：基线 = 文件实测事件数（convert 文件）+ 文件尾 uuid，
//     初始化 writeback 后继续（不写任何内容）。
//   - 之后每次同步先过三闸守卫（纯函数 evaluateWritebackGuards）：文件缩小 →
//     sourceShrunk；size/version 变化 → conflictDetected 'source-modified-externally'；
//     文件尾 uuid ≠ 水印 prevUuid → 'tail-mismatch'。force 跳过三闸并重锚定：
//     以文件实测事件数重锚水印、文件尾 uuid 作新 prevUuid（不重复写已入文件内容）。
//   - 增量写回：readFrom(水印) → tailClaudeEvents 截完整轮 → serializeClaudeJsonlTail
//     （无头、首条 parentUuid=prevUuid）→ CAS（replaceIfVersion）追加 → 预检
//     verifyClaudeJsonl（失败用写前内容回滚，不推进水印）→ 更新 registry
//     （turns 重转保 REQ-24 重导幂等、events/sizeBytes/version/writeback）。
//   - 绝不静默覆盖：任何冲突都以 skipped + conflictDetected/sourceShrunk 上报。
//
// dryRun：完整计算（含预检）但不写盘、不更新 registry。

import { randomUUID } from 'node:crypto'
import { convertClaudeJsonl } from '../convert.mjs'
import { serializeClaudeJsonlTail, tailClaudeEvents, verifyClaudeJsonl } from '../export.mjs'
import { loadImports, rememberImport, unwrapRecord, resolveRegistryDir, findSourcePathByDshId } from './imports.mjs'

// 解析文件内容里最后一个非空行的记录 uuid（写回链尾锚点）。
export function readFileTailUuid(content) {
  const lines = String(content).split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim()
    if (!t) continue
    try {
      const rec = JSON.parse(t)
      return rec && typeof rec.uuid === 'string' ? rec.uuid : null
    } catch {
      return null // 末行畸形 → 无法确定链尾
    }
  }
  return null
}

// 解析文件内容里的 sessionId（mode 记录优先，其余记录取首个带 sessionId 的）。
// 写回记录的 sessionId 必须与目标文件一致，否则 Claude Code loader 拒载。
export function readFileSessionId(content) {
  for (const line of String(content).split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const rec = JSON.parse(t)
      if (rec && typeof rec.sessionId === 'string') return rec.sessionId
    } catch {
      // 畸形行跳过，继续找
    }
  }
  return null
}

// 三闸守卫（纯函数，便于单测）：文件缩小 / 外部修改 / 尾链失配。
// force=true 跳过三闸，返回重锚定 prevUuid（当前文件尾 uuid）——调用方同时以
// 文件实测事件数重锚水印，避免把已入文件的轮次重复写回。
export function evaluateWritebackGuards(wb, { size, version, fileTailUuid, force = false }) {
  if (!wb) return { ok: true }
  if (!force) {
    if (size < wb.lastSize) return { ok: false, sourceShrunk: true }
    if (size !== wb.lastSize || version !== wb.lastVersion) return { ok: false, conflictDetected: 'source-modified-externally' }
    if (fileTailUuid !== wb.prevUuid) return { ok: false, conflictDetected: 'tail-mismatch' }
  }
  if (force) return { ok: true, reanchorPrevUuid: fileTailUuid }
  return { ok: true }
}

// 剥掉守卫结果的 ok 标志（只留对外上报字段）。
function guardFields(g) {
  if (!g) return undefined
  const { ok, ...rest } = g
  return rest
}

// 尾部事件里最后一个闭合轮次号（写回水印的 lastWrittenTurn）。
function lastTurnOf(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev && ev.type === 'turn/end' && ev.data && typeof ev.data.turn === 'number') return ev.data.turn
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev && ev.type === 'turn/start' && ev.data && typeof ev.data.turn === 'number') return ev.data.turn
  }
  return null
}

// 尾部包含的新轮数（turn/start 计数；续写轮不含 turn/start → 0）。
function countTurns(events) {
  let n = 0
  for (const ev of events) if (ev && ev.type === 'turn/start') n++
  return n
}

// 合并后的 registry 单条记录（保留原字段，刷新 turns/events/指纹/writeback）。
function mergedRecord(record, { dshId, turns, events, sizeBytes, version, writeback }) {
  return {
    ...(record && typeof record === 'object' ? record : {}),
    kind: 'single',
    dshId,
    turns,
    events,
    sizeBytes,
    version,
    writeback,
  }
}

// 无可写内容时（no-new-turns）落基线水印：记录已存在只补 writeback（不动
// turns/events/指纹——文件没变）；legacy 无记录则建最小基线记录。
async function persistBaseline(dir, sourcePath, record, { header, wb, stat, dryRun }) {
  if (dryRun) return
  // 引用同一性判定：wb 未变时即 record.writeback 本体（183 行别名）；force 重锚定
  // 会新建 wb 对象 → 恒不等 → 必然写盘。不是深比较。
  if (record && typeof record === 'object' && record.writeback === wb) return
  const merged = record && typeof record === 'object'
    ? { ...record, writeback: wb }
    : { kind: 'single', dshId: header.id, turns: wb.lastWrittenTurn, events: wb.lastWrittenSeq, sizeBytes: stat.size, version: stat.version, writeback: wb }
  await rememberImport(dir, sourcePath, merged)
}

/**
 * 增量写回：把 DSH 会话新增完整轮序列化为无头 Claude JSONL 片段，追加到目标文件。
 *
 * @param {object} ctx DSH host ctx（fs / get('sessionPersistence')）。
 * @param {{sessionId: string, target?: 'source'|'copy', uuid?: () => string,
 *         force?: boolean, dryRun?: boolean}} args target 缺省 'source'（导入源
 *       文件）；'copy' 需要先 export_claude（registry exports 映射）。uuid 工厂
 *       可注入（测试确定性），默认 randomUUID。force 跳过三闸并重锚定。
 * @param {{registryDir?: string}} [opts] registry 目录，缺省 resolveRegistryDir()。
 * @returns {{mode:'single', status:'synced'|'no-new-turns'|'skipped', sessionId,
 *          sourcePath, target, filePath, appendedTurns?, appendedEvents?,
 *          appendedRecords?, conflictDetected?, sourceShrunk?, storedShrunk?,
 *          incompleteFinalTurn?, precheckFailed?, precheck?, dryRun, writeback?}}
 */
export async function syncClaudeSession(ctx, { sessionId, target = 'source', uuid, force = false, dryRun = false }, { registryDir } = {}) {
  const uuidFactory = typeof uuid === 'function' ? uuid : randomUUID
  const dir = registryDir || resolveRegistryDir()
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof sp.list !== 'function' || typeof sp.readFrom !== 'function') {
    throw new Error('sessionPersistence 不可用（需要 list + readFrom）')
  }

  // 1. header + 导入归属（只有本插件导入的会话能写回）：imports registry 反查优先
  //（0.8.3 起日志不再写 session/imported 标记，issue #34），旧日志标记兜底
  const headers = await sp.list()
  const header = headers.find((h) => h.id === sessionId)
  if (!header) throw new Error('会话不存在: ' + sessionId)
  const { meta, events } = await sp.readFrom(sessionId, 0)
  const registry = await loadImports(dir)
  const first = Array.isArray(events) && events.length > 0 ? events[0] : undefined
  const markerSourcePath = first && first.type === 'session/imported' && first.data
    && typeof first.data.sourcePath === 'string' ? first.data.sourcePath : null
  const sourcePath = findSourcePathByDshId(registry.imports, sessionId) ?? markerSourcePath
  if (!sourcePath) {
    throw new Error('非导入会话（imports registry 无记录且无导入标记），暂不支持写回')
  }
  const readFromLength = Array.isArray(events) ? events.length : 0

  // 2. registry 记录（REQ-24 幂等键 = 源文件路径）
  const record = unwrapRecord(registry.imports[sourcePath])
  if (record && record.kind !== 'single') {
    throw new Error('多会话源暂不支持写回（kind=' + record.kind + '）')
  }

  // 3. 目标文件：source = 导入源路径；copy = 上次 export_claude 的副本
  const filePath = target === 'copy'
    ? (record && Array.isArray(record.exports) && record.exports[0] && typeof record.exports[0].filePath === 'string' ? record.exports[0].filePath : null)
    : sourcePath
  if (target === 'copy' && filePath === null) {
    throw new Error('先 export_claude 建立写回副本（registry 无 exports 映射）')
  }
  const targetObj = await ctx.fs.resolve(filePath)

  // 4. 目标文件 stat（缺失 → source-missing 跳过）
  const stat = await ctx.fs.stat(targetObj)
  if (!stat || stat.type !== 'file') {
    return { mode: 'single', status: 'skipped', reason: 'source-missing', sessionId, sourcePath, target, filePath, dryRun }
  }

  // 5. 三闸守卫（force 跳过并重锚定；文件尾 uuid 需读文件）
  let wb = record && record.writeback && typeof record.writeback === 'object' ? record.writeback : null
  let overridden = undefined // force 覆盖的守卫（上报用）
  let fileContent = null
  if (wb) {
    fileContent = await ctx.fs.readText(targetObj)
    const fileTailUuid = readFileTailUuid(fileContent)
    const wouldGuard = evaluateWritebackGuards(wb, { size: stat.size, version: stat.version, fileTailUuid, force: false })
    if (force) {
      overridden = guardFields(wouldGuard)
      // force 重锚定：水印 = 文件代表的事件数（避免把已入文件轮次重复写回），
      // prevUuid = 当前文件尾 uuid，指纹 = 当前 stat
      const fileConverted = convertClaudeJsonl(fileContent, {})
      wb = {
        ...wb,
        lastWrittenSeq: Array.isArray(fileConverted.events) ? fileConverted.events.length : 0,
        lastWrittenTurn: Array.isArray(fileConverted.turns) ? fileConverted.turns.length : wb.lastWrittenTurn,
        prevUuid: fileTailUuid,
        lastSize: stat.size,
        lastVersion: stat.version,
        writtenAt: Date.now(),
      }
    } else if (!wouldGuard.ok) {
      return { mode: 'single', status: 'skipped', sessionId, sourcePath, target, filePath, dryRun, writeback: wb, ...guardFields(wouldGuard) }
    }
  }
  // storedShrunk：DSH 日志比水印短（append-only 不应发生；会话被重建等）
  if (wb && readFromLength < wb.lastWrittenSeq) {
    return { mode: 'single', status: 'skipped', storedShrunk: true, sessionId, sourcePath, target, filePath, dryRun, writeback: wb }
  }

  // 6. 首同步（无 writeback）：基线 = 文件实测事件数 + 文件尾 uuid（不写内容）。
  //    文件实测为 0 事件（空/仅头 JSONL）时以导入记录事件数兜底（文件内容即导入
  //    内容），记录也没有才用 DSH 日志长度——避免首同步把文件里已含的内容当增量重写。
  if (!wb) {
    fileContent = await ctx.fs.readText(targetObj)
    const fileConverted = convertClaudeJsonl(fileContent, {})
    const fileEvents = Array.isArray(fileConverted.events) ? fileConverted.events.length : 0
    const regEvents = record && typeof record.events === 'number' ? record.events : 0
    const baselineEvents = fileEvents > 0
      ? Math.max(fileEvents, regEvents)
      : (regEvents || readFromLength)
    const baselineTurns = Array.isArray(fileConverted.turns)
      ? fileConverted.turns.length
      : (record && typeof record.turns === 'number' ? record.turns : 0)
    const sessionUuid = target === 'copy'
      ? record.exports[0].sessionUuid
      : readFileSessionId(fileContent)
    if (typeof sessionUuid !== 'string' || !sessionUuid) {
      throw new Error('无法从目标文件确定 sessionId（写回记录的 sessionId 必须与文件一致）')
    }
    wb = {
      sessionUuid,
      filePath,
      lastWrittenSeq: baselineEvents,
      lastWrittenTurn: baselineTurns,
      prevUuid: readFileTailUuid(fileContent),
      lastSize: stat.size,
      lastVersion: stat.version,
      writtenAt: Date.now(),
    }
  }

  // 7. 截取水印之后、已由 turn/end 闭合的完整轮（半开尾轮整轮丢弃）
  const tailRead = await sp.readFrom(sessionId, wb.lastWrittenSeq)
  const tail = tailClaudeEvents(Array.isArray(tailRead.events) ? tailRead.events : [], { fromSeq: wb.lastWrittenSeq })
  const cwd = typeof header.cwd === 'string' && header.cwd
    ? header.cwd
    : (meta && typeof meta.cwd === 'string' ? meta.cwd : undefined)

  // 无可写内容：落基线水印（首同步 / force 重锚定），返回 no-new-turns
  if (tail.events.length === 0) {
    await persistBaseline(dir, sourcePath, record, { header, wb, stat, dryRun })
    return {
      mode: 'single', status: 'no-new-turns', sessionId, sourcePath, target, filePath, dryRun,
      writeback: wb,
      ...(tail.droppedIncompleteTurn ? { incompleteFinalTurn: true } : {}),
    }
  }

  // 8. 序列化尾部（无头、首条 parentUuid = 水印 prevUuid）
  const tailOut = serializeClaudeJsonlTail({
    meta,
    events: tail.events,
    sessionUuid: wb.sessionUuid,
    cwd,
    prevUuid: wb.prevUuid,
  }, { uuid: uuidFactory })
  if (tailOut.recordCount === 0) {
    // 防御：有事件但无记录可写（理论不可达），按无可写内容处理
    await persistBaseline(dir, sourcePath, record, { header, wb, stat, dryRun })
    return { mode: 'single', status: 'no-new-turns', sessionId, sourcePath, target, filePath, dryRun, writeback: wb }
  }

  // 9. 拼接 + CAS 写回（replaceIfVersion：观测版本不匹配 → 并发写者，不覆盖）
  const content = fileContent
  const newContent = content.endsWith('\n') ? content + tailOut.jsonl : content + '\n' + tailOut.jsonl
  const appendedTurns = countTurns(tail.events)
  const nextWriteback = {
    sessionUuid: wb.sessionUuid,
    filePath,
    lastWrittenSeq: wb.lastWrittenSeq + tail.events.length,
    lastWrittenTurn: lastTurnOf(tail.events) ?? wb.lastWrittenTurn,
    prevUuid: tailOut.lastUuid,
    lastSize: newContent.length,
    lastVersion: stat.version, // dryRun 用观测版本占位；写盘路径在成功后覆盖
    writtenAt: Date.now(),
  }
  if (dryRun) {
    // dryRun：不写盘，只对内存拼接结果预检
    const check = verifyClaudeJsonl(newContent)
    if (!check.ok) {
      return { mode: 'single', status: 'skipped', precheckFailed: true, precheck: check, sessionId, sourcePath, target, filePath, dryRun, writeback: wb }
    }
    return {
      mode: 'single', status: 'synced', dryRun: true,
      sessionId, sourcePath, target, filePath,
      appendedTurns, appendedEvents: tail.events.length, appendedRecords: tailOut.recordCount,
      ...(overridden || {}),
      writeback: nextWriteback,
    }
  }
  let outcome
  try {
    outcome = await ctx.fs.writeText(targetObj, newContent, { kind: 'replaceIfVersion', version: stat.version })
  } catch (_) {
    // 吞掉 CAS 拒绝（FS_STALE_VERSION = 并发写者已改文件），上报冲突、不覆盖、不推进水印
    return {
      mode: 'single', status: 'skipped', conflictDetected: 'write-version-mismatch',
      sessionId, sourcePath, target, filePath, dryRun, writeback: wb,
    }
  }

  // 10. 预检（写坏即用写前内容回滚，不推进水印）
  const check = verifyClaudeJsonl(newContent)
  if (!check.ok) {
    try {
      await ctx.fs.writeText(targetObj, content, { kind: 'replaceIfVersion', version: outcome.version })
    } catch (err) {
      // 回滚也失败（并发写者）：文件停留在预检失败内容上，上报且不推进水印
      return {
        mode: 'single', status: 'skipped', precheckFailed: true, precheck: check,
        rollbackError: String((err && err.message) || err),
        sessionId, sourcePath, target, filePath, dryRun, writeback: wb,
      }
    }
    return {
      mode: 'single', status: 'skipped', precheckFailed: true, precheck: check,
      sessionId, sourcePath, target, filePath, dryRun, writeback: wb,
    }
  }

  // 11. 更新 registry：turns 重转（保 REQ-24 重导幂等）、events = DSH 事件数、
  //     指纹 + writeback（prevUuid = 本次尾部最后一条记录的 uuid）
  const converted = convertClaudeJsonl(newContent, {})
  nextWriteback.lastVersion = outcome.version
  await rememberImport(dir, sourcePath, mergedRecord(record, {
    dshId: header.id,
    turns: Array.isArray(converted.turns) ? converted.turns.length : 0,
    events: readFromLength,
    sizeBytes: newContent.length,
    version: outcome.version,
    writeback: nextWriteback,
  }))
  return {
    mode: 'single', status: 'synced', dryRun: false,
    sessionId, sourcePath, target, filePath,
    appendedTurns, appendedEvents: tail.events.length, appendedRecords: tailOut.recordCount,
    ...(overridden || {}),
    writeback: nextWriteback,
  }
}
