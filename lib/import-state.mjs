// lib/import-state.mjs — 导入状态机的共享序曲：registry 记录装载与「源未变」短路径
//
// 每个导入入口在读源之前都要先回答同一个问题：这个源上次导入的记录还作数吗、源变了
// 没有？（重导语义见 docs/architecture.md D13：源未变即跳过且不重读源。）两种记录形态：
//   single —— 一个源文件 / 会话目录对应一条会话（标准来源、grokbuild、kimi、vibe、codex
//              分页链、bundle）；
//   multi  —— 一个库 / 文件含多条会话，子表（sessions / conversations）逐会话记账
//              （chatgpt、hermes state.db、opencode 及其 fork、zcode、crush、goose、zed、trae）。
// 判定逻辑曾按来源各抄一份，抄本逐渐漂移（WAL 边车签名、选择性导入守卫、replace 旁路只
// 在部分来源存在），所以收在这里。本模块不读源；唯一的读盘例外是单会话短路径的存量
// 形状闸（singleShortPathChecked，D26）：缺形状戳的旧记录在跳过生效前读一次**目标会话
// 日志**（不是源）做一次性校验，干净则补戳写回 registry——此后该记录与其余记录一样
// 只看 registry 与 stat。

import {
  loadImports, unwrapRecord, updateImport, listPersistedIds, archivedSessionIds, isSessionIdChange,
  sqliteWalSig, legacyShapeVerdict, STORED_SHAPE_VERSION,
} from './imports.mjs'

export { sqliteWalSig, STORED_SHAPE_VERSION }

/**
 * 装载源记录：同形态（kind）且仍然作数的记录才作为 known 返回，否则 null（视作无记录重导）。
 *   single：记录指向的会话已不存在（被删 / DSH_HOME 迁移）或已被归档（隐藏但仍占 id）→ null
 *           （归档会话保留，重导走「无记录」分支建后缀新副本）；
 *   multi ：缺子表 → null（子会话是否仍在由短路径逐个判定，决策层逐会话处理）。
 * persisted 可传入共享快照（批量模式），缺省按需取一次。
 * @returns {Promise<{ known: object | null, persisted: Set<string>, archivedIds: Set<string> }>}
 */
export async function loadKnownRecord(ctx, sourcePath, { registryDir, persisted, kind = 'single', subTable = 'sessions' } = {}) {
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  const archivedIds = archivedSessionIds(ctx)
  const registry = await loadImports(registryDir)
  let known = unwrapRecord(registry.imports[sourcePath])
  if (known && known.kind !== kind) known = null
  if (known && kind === 'single' && (!known.dshId || !persistedSet.has(known.dshId) || archivedIds.has(known.dshId))) known = null
  if (known && kind === 'multi' && (!known[subTable] || typeof known[subTable] !== 'object')) known = null
  return { known, persisted: persistedSet, archivedIds }
}

// 预算比对只在本次给出了预算口径时进行：预算是转换层裁剪的输入，未解析预算的调用方
//（restore_bundle 工具）不能拿「没给」去和记录里的预算比出一个变化来。
function budgetChanged(known, args) {
  return typeof known.budget === 'number' && typeof args.budget === 'number' && known.budget !== args.budget
}

function alreadyImported(known, flag) {
  return {
    sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0,
    alreadyImported: true, status: 'already-imported', ...flag,
  }
}

/**
 * 单会话源的「源未变」短路径（不读源）。force / replace / 显式 sessionId 变更必须重读
 * 重转，不在此跳过。参数指纹或预算变了而源未重导 → 跳过并点名（argsChanged /
 * budgetChanged；要按新参数导入用 force）。返回单文件结果或 null（短路径不成立）。
 */
export function singleShortPath(known, args, fingerprint, stat) {
  if (!known || args.force === true || args.replace === true || isSessionIdChange(args, known.dshId)) return null
  if (typeof known.args === 'string' && fingerprint !== known.args) return alreadyImported(known, { argsChanged: true })
  if (budgetChanged(known, args)) return alreadyImported(known, { budgetChanged: true })
  if (stat && stat.version === known.version && stat.size === known.sizeBytes) return alreadyImported(known)
  return null
}

/**
 * 单会话短路径 + 存量形状闸（D26，所有单会话来源的统一入口）。
 *
 * 背景：旧版转换器写出的日志可能缺 protected head / 标题引用未重映射，宿主重启读取即
 * 拒载；日志 append-only，升级插件不会修复存量。而「源未变」短路径连源都不读，用户
 * 「升级后重导一次」的自然动作被静默跳过，坏会话永远打不开。本闸在短路径**即将生效**
 * 时（源未变、非 force/replace）对缺形状戳的旧记录补一次一次性校验：
 *   - 有戳 / 短路径不成立：与原 singleShortPath 完全一致，不多读；
 *   - 干净：补戳写回 registry（一次性），照常跳过；
 *   - 损坏：在 known 上挂 __repair（'replace' = 实测长度等于基线的纯镜像，同 id 重建；
 *     'copy' = 已续聊 / 无基线 / 读不回，保守另铸副本），返回 null 放行完整重导，
 *     由 decideItem 消费标记执行修复（修复动作沿用 D13 的守卫，绝不销毁用户续聊）；
 *   - 宿主没有读事件面：无法校验，维持原跳过语义（不盖章、不修复）。
 * 多会话源（multiShortPath）不设闸：它们的转换器不经 DSH 日志回灌，产不出这两类旧形状。
 * @param {object} ctx 插件上下文（读目标日志用）
 * @param {object|null} known registry 记录（可被挂 __repair / shape）
 * @param {{registryDir?: string, sourcePath?: string}} refs 补戳写回所需的 registry 坐标
 * @returns {Promise<object|null>} 跳过结果（同 singleShortPath），或 null（放行重导）
 */
export async function singleShortPathChecked(ctx, known, args, fingerprint, stat, { registryDir, sourcePath } = {}) {
  const skip = singleShortPath(known, args, fingerprint, stat)
  if (!skip || !known || known.shape === STORED_SHAPE_VERSION) return skip
  const { verdict, events } = await legacyShapeVerdict(ctx, known.dshId)
  if (verdict === 'no-read-face') return skip
  if (verdict === 'healthy') {
    known.shape = STORED_SHAPE_VERSION
    if (registryDir && sourcePath) {
      await updateImport(registryDir, sourcePath, (raw) => {
        const record = unwrapRecord(raw)
        return record ? { ...record, shape: STORED_SHAPE_VERSION } : undefined
      })
    }
    return skip
  }
  // corrupt / unreadable：放行重导。unreadable 无法量长度，一律按保守副本处理；
  // corrupt 且实测长度等于基线 = 纯镜像（用户没续聊过），同 id 原地重建。
  known.__repair = 'copy'
  if (verdict === 'corrupt') {
    const baseline = typeof known.storedEvents === 'number' ? known.storedEvents : null
    if (events !== null && baseline !== null && events.length === baseline) known.__repair = 'replace'
  }
  return null
}

/**
 * 多会话源的「源未变」短路径（不重读源）。成立条件全部满足才跳过：
 *   - 非 force / replace；
 *   - 显式选择（selection：sessionIds / zcodeId）里的每个会话都已在子表中——否则面板勾选
 *     「部分」会话补导会被库指纹判成 already-imported，新选中的会话漏导；
 *   - 子表记录的会话全部仍在且未归档（被删 / 迁移 / 归档 → 全量重导）；
 *   - 主文件 version/size 未变，且 SQLite 源的 WAL 边车签名（walSig，非 SQLite 源传
 *     undefined）也未变——WAL 模式下新写入在 checkpoint 前只落 -wal，主文件 stat 不变。
 * 参数指纹 / 预算变化同单会话口径逐会话点名。返回批量形态结果或 null。
 */
export function multiShortPath({ known, subTable = 'sessions', path, args, fingerprint, stat, walSig, persisted, archivedIds, selection }) {
  if (!known || args.force === true || args.replace === true) return null
  const subs = known[subTable]
  if (Array.isArray(selection) && selection.length > 0
    && !selection.every((id) => subs[id] && typeof subs[id] === 'object')) return null
  const entries = Object.values(subs)
  if (entries.length === 0 || !entries.every((sub) => persisted.has(sub.dshId) && !archivedIds.has(sub.dshId))) return null
  const skipAll = (flag) => {
    const results = entries.map((sub) => ({
      path, status: 'already-imported', sessionId: sub.dshId, turns: sub.turns, messages: 0, toolCalls: 0, skipped: 0, ...flag,
    }))
    return { total: results.length, imported: 0, alreadyImported: results.length, appended: 0, skipped: 0, failed: 0, results }
  }
  if (typeof known.args === 'string' && fingerprint !== known.args) return skipAll({ argsChanged: true })
  if (budgetChanged(known, args)) return skipAll({ budgetChanged: true })
  const walSame = walSig === undefined || known.walSig === walSig
  if (stat && stat.version === known.version && stat.size === known.sizeBytes && walSame) return skipAll()
  return null
}

/** 显式选择的源会话 id（args.sessionIds 非空时）；未选择返回 null（= 全部）。 */
export function sessionSelection(args) {
  return Array.isArray(args.sessionIds) && args.sessionIds.length > 0 ? args.sessionIds : null
}

/**
 * 多文件复合 stat（会话目录 summary.json + chat_history.jsonl、wire.jsonl + state.json、
 * codex 分页链）：size 求和、version 以 '|' 拼接——任一文件变化（含新增一页）复合指纹即变，
 * registry 的 sizeBytes / version 落复合值。缺失的文件按空计（size 0、version ''）。
 */
export function combineStats(stats) {
  let size = 0
  const versions = []
  for (const s of stats) {
    size += s && typeof s.size === 'number' ? s.size : 0
    versions.push(s && s.version !== undefined && s.version !== null ? String(s.version) : '')
  }
  return { type: 'file', size, version: versions.join('|') }
}

/** 逐个 stat 后合成复合 stat（target 为空的位置按缺失计）。 */
export async function compositeStat(ctx, targets) {
  const stats = []
  for (const t of targets) stats.push(t ? await ctx.fs.stat(t) : null)
  return combineStats(stats)
}
