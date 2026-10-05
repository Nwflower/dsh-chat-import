// lib/import-core.mjs — 共享导入编排（标准单文件 / 目录批量状态机 + 标准预览）
//
// 所有标准形态来源（Claude / Codex / Cursor / Gemini / Reasonix / Pi / OpenClaw
// 以及 hermes .jsonl 回退）共用的编排：importTranscript（状态机入口：
// stat → registry 短路径判定 → 读取转换 → decideSingle 决策落盘 → 归组）、
// importDirectory（目录批量，逐文件走同一状态机）、runDecision（执行决策并落盘）、
// planWorkspaceGroup / attachPlannedWorkspace（归组，见 lib/workspace-group.mjs）、
// warmProjection（投影缓存预热）。kimi 的 wire.jsonl
// 单文件也走 importTranscript（经 import-variants.mjs 的 importKimiFile）。
// dry-run 预览的共享件也在此：isPreview / previewEntry / previewTranscript /
// previewDirectory。宿主会话的写入契约（代次 / 形状归一 / create 与 append）在
// lib/host-session.mjs。依赖 ctx（host 服务），非纯函数；不 import 任何 DSH 包。

import { isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import { markTrimmedSource } from './budget.mjs'
import { forgetWorkspaceIgnore } from './ignore.mjs'
import { validateSessionEvents } from './convert/index.mjs'
import { materializeImages } from './attachments.mjs'
import { resolveClaudeCwd, decodeClaudeSlug } from './cwd-map.mjs'
import { attachPlannedWorkspace, planWorkspaceGroup } from './workspace-group.mjs'
// 归组的公开面（命令层从本模块取，避免它直接依赖 workspace-group.mjs 的内部函数）
export { defaultDedicatedWorkspaceDir } from './workspace-group.mjs'
import {
  rememberImport, listPersistedIds, argsFingerprint, decideSingle, decideMulti, mintForceSessionId, storedEventCount,
  beginRegistryBatch, endRegistryBatch,
} from './imports.mjs'
import { loadKnownRecord, singleShortPath, multiShortPath, sqliteWalSig } from './import-state.mjs'
import {
  collectJsonlFiles, createBatchTally, tallyItem, batchSummary, batchItem, failedItem,
} from './import-batch.mjs'
// 目录收集与批量条目归一的公开面（工具层 / 特殊形态来源从本模块取）
export { collectFiles, collectJsonlFiles, collectJsonFiles, isSidecarJsonl, batchItem } from './import-batch.mjs'
import {
  createSession, appendHostEvents, targetSessionFormatVersion, isSessionTakenError, formatVersionOverride,
} from './host-session.mjs'
import { pinSourcedSessionTitle, sourceLabelFromImportedEvents } from './sourced-title.mjs'
import { clearSessionArtifactsForReplace } from './purge.mjs'

// 转换层无 cwd 记录时输出 cwdHint（Claude 项目 slug 目录名）——这里消费：
// ~/.claude.json projects 权威映射（resolveClaudeCwd）失败再 ASCII slug 解码回退
// （decodeClaudeSlug，有损兜底）。只在转换输出真正缺 cwd 时触发（不读 claude.json
// 于每个文件）；解码结果可能不存在（跨机器）→ attachToWorkspace 回退源目录。
async function applyCwdHint(ctx, out, sourcePath) {
  if (!out || !out.meta || typeof out.meta.cwd === 'string' || !out.cwdHint) return out
  const mapped = await resolveClaudeCwd(ctx, out.cwdHint, sourcePath)
  if (mapped) {
    out.meta.cwd = mapped
  } else {
    const decoded = decodeClaudeSlug(out.cwdHint)
    if (decoded) out.meta.cwd = decoded
  }
  delete out.cwdHint
  return out
}

// 把转换层的畸形行明细 / secrets 位置 / permission 计数 / 工具结果丢弃计数附加到
// 公开结果。decideItem（lib/imports.mjs）只透传固定字段，这些字段在此补透；非空才
// 附加（schema 均为可选字段，空值不占键）。
export function attachConversionDetails(out, res) {
  if (out.skippedLines && out.skippedLines.length > 0) res.skippedLines = out.skippedLines
  if (out.secrets && out.secrets.length > 0) res.secrets = out.secrets
  if (out.permissionCount && out.permissionCount > 0) res.permissionCount = out.permissionCount
  if (out.cwdRemap) res.cwdRemap = out.cwdRemap
  if (out.orphanToolResults) res.orphanToolResults = out.orphanToolResults
  if (out.duplicateToolResults) res.duplicateToolResults = out.duplicateToolResults
  // 转换层保真 / 降级计数（>0 才附加；schema 均为可选字段）：isMeta 记录数、
  // 后端工具调用数、无法映射的结果块数、未知输出块数、畸形工具参数数。
  // 失败要大声：这些计数原本只停在转换器返回值，工具结果里看不到。
  for (const k of ['metaMessages', 'toolUseResultsMerged', 'backendToolCalls', 'droppedToolResultBlocks', 'droppedMalformedOutputs', 'droppedMalformedArgs']) {
    if (typeof out[k] === 'number' && out[k] > 0) res[k] = out[k]
  }
  // imagesDegraded 两个来源同口径相加：宿主层（runDecision 附件落地失败 / storeImages 关）
  // 已写进 res，转换层（拿不到字节）在 out 上。images 只由宿主层计数（落成附件的张数）。
  if (typeof out.imagesDegraded === 'number' && out.imagesDegraded > 0) {
    res.imagesDegraded = (typeof res.imagesDegraded === 'number' ? res.imagesDegraded : 0) + out.imagesDegraded
  }
  // 展平信封还原计数（整对象 >0 才附加）：Codex Desktop 外部导入的 rollout 里，工具调用被
  // 展平成正文文本信封，转换层还原成 tool-call/tool-result（见 lib/convert/codex.mjs）。
  // orphanResults / malformed 是降级项（结果保留为正文、载荷退化为原文），必须可见。
  if (out.externalAgent && (out.externalAgent.calls > 0 || out.externalAgent.results > 0
    || out.externalAgent.orphanResults > 0 || out.externalAgent.malformed > 0)) {
    res.externalAgent = out.externalAgent
  }
  return res
}

// cwd 重映射：跨机器迁移时，把源机的 cwd 前缀映射到本机等价路径。
//
// 背景：宿主用平台相关的 isAbsolute 校验 header.cwd（dsh-session/lib/index.js:786），
// 所以源机路径（如 Windows 的 D:\demo\proj 在 POSIX 上）在 prepareHostMeta 处被剔除，
// 会话退化为未分组。那个取舍是刻意的（绝不因 cwd 拒绝整次导入），本选项不推翻它——
// 只是给用户一个把源前缀改写成**本机**前缀的机会，改写结果仍要过同一道绝对性校验。
//
// 默认不启用：args.cwdRemap 缺失或为空数组时，本函数完全不碰 meta，既有行为不变。
// 规则按 from 长度降序匹配，长前缀优先，避免 '/a' 抢先命中 '/a/b'。
//
// 参数是模型/用户给的，因此按「失败要大声」严格校验：cwdRemap 不是数组、或某条规则
// 缺 from/to，直接抛错——静默忽略会让用户以为已经重映射了。
const CWD_TRAILING_SEP = /[\\/]+$/
const CWD_LEADING_SEP = /^[\\/]+/

function cwdRemapRules(args) {
  const raw = args && args.cwdRemap
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('cwdRemap 必须是 [{ from, to }] 数组')
  return raw
    .map((r, i) => {
      if (!r || typeof r.from !== 'string' || !r.from.trim() || typeof r.to !== 'string' || !r.to.trim()) {
        throw new Error('cwdRemap[' + i + '] 需要非空的 from 与 to 字符串')
      }
      return { from: r.from.trim().replace(CWD_TRAILING_SEP, ''), to: r.to.trim().replace(CWD_TRAILING_SEP, '') }
    })
    .filter((r) => r.from && r.to)
    .sort((a, b) => b.from.length - a.from.length)
}

/**
 * 按 args.cwdRemap 改写 out.meta.cwd（原地）。未启用或未命中时不做任何改动。
 * 只认首个成功的规则：改写后的路径通常不再匹配任何 from，重复调用即幂等。
 * @param out - 转换结果，读改 out.meta.cwd。
 * @param args - 导入参数。
 * @returns out 本身。
 */
export function applyCwdRemap(out, args) {
  if (!out || !out.meta || typeof out.meta.cwd !== 'string' || !out.meta.cwd) return out
  if (out.cwdRemap) return out // 已改写过：保持首次结果，重复调用不叠加
  const rules = cwdRemapRules(args)
  if (rules.length === 0) return out
  const cwd = out.meta.cwd
  for (const { from, to } of rules) {
    if (cwd !== from && !cwd.startsWith(from + '/') && !cwd.startsWith(from + '\\')) continue
    const rest = cwd.slice(from.length).replace(CWD_LEADING_SEP, '')
    const segments = rest ? rest.split(/[\\/]+/) : []
    // 源转录是不可信输入：余段里的 '..' 会把结果推出 to 之外（改写后的 cwd 决定归组，
    // 等于让转录指定一个任意工作区）。拒绝该规则的改写，并把拒绝原因如实记下上报。
    if (segments.includes('..')) {
      out.cwdRemap = { from, to, original: cwd, mapped: cwd, absolute: isAbsolute(cwd), reason: 'parent-traversal' }
      return out
    }
    const mapped = segments.length > 0 ? join(to, ...segments) : to
    out.meta.cwd = mapped
    // 失败要大声：改写结果仍需通过宿主绝对性校验，不通过则照旧被 prepareHostMeta 剔除。
    // 这里把事实与判定一并记下，由结果层上报，绝不静默改写。
    out.cwdRemap = { from, to, original: cwd, mapped, absolute: isAbsolute(mapped) }
    return out
  }
  return out
}

/** 转换后统一钉住「来源 · 话题」标题（有回合才写 session/title）。 */
export function finalizeConvertedSession(out, args, sourceLabel) {
  const label = sourceLabel || args.sourceLabel || sourceLabelFromImportedEvents(out.events)
  if (label && out.turns && out.turns.length > 0) pinSourcedSessionTitle(out, label)
  applyCwdRemap(out, args)
  return out
}

// restamp：把会话内所有时间戳平移到当前时间，保持相对间隔（对标
// kinyokun/dsh-session-import 的 restamp=1）。返回新对象或原地修改 out（调用方
// 不依赖原对象不变性）。
export function restampSession(out, args) {
  if (args.restamp !== true || !out || !out.meta) return out
  const events = Array.isArray(out.events) ? out.events : []
  const first = events.find((e) => e && typeof e.time === 'number')
  const base = first ? first.time : (typeof out.meta.createdAt === 'number' ? out.meta.createdAt : undefined)
  if (typeof base !== 'number') return out
  const delta = Date.now() - base
  const shift = (n) => (typeof n === 'number' ? n + delta : n)
  out.meta.createdAt = shift(out.meta.createdAt)
  for (const e of events) {
    if (e && typeof e.time === 'number') e.time = shift(e.time)
  }
  return out
}

// 归组（工作区挂接）在 lib/workspace-group.mjs：宿主只接受 cwd 与工作区路径逐字相等的
// 挂接，所以目标工作区必须在**创建会话之前**定下来并写进 header.cwd（runDecision 的
// prepareGrouping / finishGrouping）。见 docs/architecture.md D16。

// 预热投影缓存：冷读一次持久化会话并回写，让侧边栏无需打开会话即可显示
// 标题/模型等元数据（否则列表先显示 cwd 目录名，点开后才出现真实标题）。
// 宿主契约：coldSnapshot(meta, inheritedEventCount, events)——meta/events 由
// sessionPersistence.inspect 取回，导入会话日志无继承前缀 → inheritedEventCount
// 恒 0。失败不影响导入结果，仅记录日志。
// 返回值：成功 = 本次实测的持久化事件数（≥0）；服务缺席 / inspect 失败 = false。
// 返回事件数让落盘路径复用这次全量读取刷新 storedEvents 基线（同一份刚写完的日志，
// 不必再整读一遍只为拿 .length——大会话下这一来一回是导入热路径的显著开销）。
export async function warmProjection(ctx, sessionId) {
  const projectionCache = ctx.get('sessionProjectionCache')
  if (!projectionCache || typeof projectionCache.coldSnapshot !== 'function') return false
  try {
    const persistence = ctx.get('sessionPersistence')
    if (!persistence || typeof persistence.inspect !== 'function') return false
    const { meta, events } = await persistence.inspect(sessionId)
    await projectionCache.coldSnapshot(meta, 0, events)
    return Array.isArray(events) ? events.length : false
  } catch (err) {
    console.error('projection warm-up failed:', String((err && err.message) || err))
    return false
  }
}

// 宿主会话落盘适配（代次探测 / header 与事件形状归一 / create 与 append 入口）在
// lib/host-session.mjs；这里 re-export 既有公开面（面板、测试从本模块取）。
export {
  sanitizeJsonValue, prepareHostMeta, prepareHostEvents,
  withHostFormatVersion, hostNativeFormatVersion, hostSessionFormatVersion,
} from './host-session.mjs'

// 落盘后**实测** DSH 日志长度，作为「这条会话还是不是我们上次写完的样子」的基线
// （重导语义见 lib/imports.mjs 增长分支与 docs/architecture.md D13）。只有我们自己
// 刚写完才允许刷新基线：跳过路径上的日志可能已被用户在 DSH 里续聊，那时刷新基线会让
// 下一次重导误判成「纯镜像」，把导入轮次追加进用户自己的对话。读不到就留空（下一次
// 重导按「无基线」保守另铸副本，不静默假设）。
// knownCount：warmProjection 刚用 persistence.inspect 全量读回这份日志时的实测事件数——
// 同源同口径（inspect 与 read(0,MAX) 都是整份持久化日志），直接复用免去第二次整读；
// 缺席/无效时保留自有回读兜底（读不到 → 留空，保守语义不变）。
async function stampStoredEvents(ctx, record, sessionId, knownCount) {
  if (!record || typeof record !== 'object' || typeof sessionId !== 'string') return
  const n = Number.isSafeInteger(knownCount) && knownCount >= 0
    ? knownCount
    : await storedEventCount(ctx, sessionId)
  if (typeof n === 'number') record.storedEvents = n
}

// 执行 decideSingle / decideMulti 返回的决策并落盘；剥离 __ 载荷后返回公开结果。
// 归组只发生在 create（replace 亦重建会话，故同样归组；append 续写沿用既有工作区）；
// persisted 就地更新供批量内 id 避让；__record（新导入记录）经 rememberImport 写回 registry。
// 落盘的每组事件跑轻量结构校验（seq 连续 / 类型白名单 / surfaceOp /
// sourceEventSeqs），有问题的会话在公开结果里附加 validation（失败大声，不静默）。
export async function runDecision(ctx, decision, registryDir, sourcePath, persisted, options = {}) {
  const validation = { ok: true, problems: [] }
  // 图片落地：写盘前把 IR 图片块的字节经 ctx.attachments 落成宿主附件（引用进日志），
  // 拿不到服务/不能落地的降级为 [image] 占位并计数。见 lib/attachments.mjs。
  const imageTally = { stored: 0, degraded: 0 }
  const materialize = async (events, targetId) => {
    // 目标代次（只认**权威**来源，不用推断值）：续写看目标会话自己的 header 代次；
    // 新建/替换看面板是否显式指定了代次（formatVersionOverrides）。两者都没有时传
    // undefined —— 宿主代次未知/为当前代次，按支持附件引用处理，绝不因为「推断不出来」
    // 就把图片降级。V3 目标不支持附件引用，见 docs/architecture.md D14。
    const targetVersion = typeof targetId === 'string' && targetId
      ? await targetSessionFormatVersion(ctx, targetId)
      : formatVersionOverride(ctx)
    const r = await materializeImages(ctx, events, { storeImages: options.storeImages !== false, targetVersion })
    imageTally.stored += r.stored
    imageTally.degraded += r.degraded
    return r.events
  }
  const check = (events) => {
    if (!Array.isArray(events) || events.length === 0) return
    const r = validateSessionEvents(events)
    if (!r.ok) {
      validation.ok = false
      const room = 20 - validation.problems.length
      if (room > 0) validation.problems.push(...r.problems.slice(0, room))
    }
  }
  // 归组：宿主只接受「cwd 与工作区路径相等」的挂接，所以目标工作区必须在 create 之前
  // 定下来，并写进 header.cwd（prepare），create 之后再 attach（finish）。归组失败不影响
  // 落盘，但一律计数 + 上报 reason（失败要大声），不再只写 console.error。
  const grouping = { workspace: '', mode: '', created: false, ungrouped: 0, reason: '' }
  const groupOptions = { ...options, registryDir }
  const prepareGrouping = async (meta) => {
    const plan = await planWorkspaceGroup(ctx, meta, sourcePath, groupOptions)
    return {
      plan,
      // 只在与目标不同才换对象：meta 可能与 registry 记录同源，避免顺手改掉记录里的 cwd
      meta: plan.path && plan.path !== meta.cwd ? { ...meta, cwd: plan.path } : meta,
    }
  }
  const finishGrouping = async (plan, sessionId) => {
    const res = plan.path
      ? await attachPlannedWorkspace(ctx, plan, sessionId)
      : { ok: false, reason: plan.reason }
    const item = (Array.isArray(decision.results) ? decision.results : []).find((r) => r && r.sessionId === sessionId)
    if (res.ok) {
      grouping.workspace = res.path
      grouping.mode = res.mode
      if (res.created) grouping.created = true
      if (item) {
        item.workspace = res.path
        if (res.mode) item.workspaceMode = res.mode
        if (res.created) item.workspaceCreated = true
      }
      return
    }
    grouping.ungrouped += 1
    if (!grouping.reason && res.reason) grouping.reason = res.reason
    if (item) {
      item.ungrouped = 1
      if (res.reason) item.ungroupedReason = res.reason
    }
  }
  if (decision.__action === 'create') {
    const { __events } = decision
    await materialize(__events)
    let { meta, plan } = await prepareGrouping(decision.__meta)
    let remap = null
    try {
      await createSession(ctx, meta, __events)
    } catch (err) {
      // 宿主内存索引残留同名会话（幽灵，list 未暴露但 create 拒绝）：
      // 另铸后缀新 id 重试一次，registry 记录 / 决策载荷同步到新 id，不静默；
      // 其它 create 错误（meta 非法等）照常上抛。
      if (!isSessionTakenError(err)) throw err
      const newId = mintForceSessionId(persisted, meta.id)
      meta = { ...meta, id: newId }
      await createSession(ctx, meta, __events)
      remap = { previous: decision.__meta.id, current: newId }
      decision.__meta = meta
      decision.sessionId = newId
      if (decision.__itemRecord) decision.__itemRecord.dshId = newId
      if (decision.__record && decision.__record.kind === 'single') decision.__record.dshId = newId
      decision.staleGhost = remap
    }
    check(__events)
    await finishGrouping(plan, meta.id)
    const stored = await warmProjection(ctx, meta.id)
    persisted.add(meta.id)
    if (decision.__record) await stampStoredEvents(ctx, decision.__record, meta.id, stored)
  } else if (decision.__action === 'replace') {
    const { __meta, __events } = decision
    await materialize(__events)
    const targetId = decision.sessionId
    const { meta, plan } = await prepareGrouping(__meta)
    await clearSessionArtifactsForReplace(ctx, targetId)
    await createSession(ctx, meta, __events)
    check(__events)
    await finishGrouping(plan, targetId)
    const stored = await warmProjection(ctx, targetId)
    persisted.add(targetId)
    if (decision.__record) await stampStoredEvents(ctx, decision.__record, targetId, stored)
  } else if (decision.__action === 'append') {
    await materialize(decision.__tailEvents, decision.__targetId)
    await appendHostEvents(ctx, decision.__targetId, decision.__tailEvents)
    check(decision.__tailEvents)
  } else if (decision.__action === 'multi') {
    for (const r of decision.__replaces || []) {
      const { meta, plan } = await prepareGrouping(r.meta)
      await clearSessionArtifactsForReplace(ctx, r.targetId)
      await materialize(r.events)
      await createSession(ctx, meta, r.events)
      check(r.events)
      await finishGrouping(plan, r.targetId)
      const stored = await warmProjection(ctx, r.targetId)
      persisted.add(r.targetId)
      const sub = decision.__record && r.subTable ? decision.__record[r.subTable] : null
      await stampStoredEvents(ctx, sub && sub[r.key], r.targetId, stored)
    }
    for (const c of decision.__creates) {
      const prepared = await prepareGrouping(c.meta)
      let meta = prepared.meta
      await materialize(c.events)
      try {
        await createSession(ctx, meta, c.events)
      } catch (err) {
        // 同单会话分支：幽灵 id → 另铸后缀新 id 重试，父记录子表条目 / results
        // 条目同步到新 id（否则下次导入按已导入跳过指向幽灵 id）
        if (!isSessionTakenError(err)) throw err
        const newId = mintForceSessionId(persisted, meta.id)
        meta = { ...meta, id: newId }
        await createSession(ctx, meta, c.events)
        const remap = { previous: c.meta.id, current: newId }
        if (c.subTable && decision.__record && decision.__record[c.subTable]) {
          const sub = decision.__record[c.subTable][c.key]
          if (sub) sub.dshId = newId
        }
        for (const r of decision.results) {
          if (r && r.sessionId === c.meta.id) {
            r.sessionId = newId
            r.staleGhost = remap
          }
        }
      }
      check(c.events)
      await finishGrouping(prepared.plan, meta.id)
      const stored = await warmProjection(ctx, meta.id)
      persisted.add(meta.id)
      const sub = decision.__record && c.subTable ? decision.__record[c.subTable] : null
      await stampStoredEvents(ctx, sub && sub[c.key], meta.id, stored)
    }
    for (const a of decision.__appends) {
      await materialize(a.events, a.targetId)
      await appendHostEvents(ctx, a.targetId, a.events)
      check(a.events)
    }
  }
  // 被删工作区出现新会话：解除工作区忽略（旧会话的 'workspace-deleted' 墓碑保留，
  // 不会把已删除的源带回来）；失败只告警，不影响本次导入结果。
  if (Array.isArray(decision.__restoreWorkspaces)) {
    for (const cwd of decision.__restoreWorkspaces) {
      try {
        await forgetWorkspaceIgnore(registryDir, cwd)
      } catch (err) {
        console.warn('[dsh-chat-import] 恢复工作区忽略失败（' + cwd + '）：' + String((err && err.message) || err))
      }
    }
  }
  if (decision.__record) await rememberImport(registryDir, sourcePath, decision.__record)
  const pub = {}
  for (const [k, v] of Object.entries(decision)) {
    if (!k.startsWith('__')) pub[k] = v
  }
  // 图片落地计数（>0 才占键）：images = 落成宿主附件的张数；imagesDegraded = 以
  // [image] 文本占位导入的张数（转换层拿不到字节的由调用方合并进来）
  if (imageTally.stored > 0) pub.images = imageTally.stored
  if (imageTally.degraded > 0) pub.imagesDegraded = imageTally.degraded
  // 归组结果：成功给出目标工作区（+ 本次是否新建）；未归组按会话数计数并带首个原因，
  // 让「导入了但侧栏找不到」当场可见（未归组的会话仍在，只是落在「未分组」）。
  if (grouping.workspace) {
    pub.workspace = grouping.workspace
    if (grouping.mode) pub.workspaceMode = grouping.mode
    if (grouping.created) pub.workspaceCreated = true
  }
  if (grouping.ungrouped > 0) {
    pub.ungrouped = grouping.ungrouped
    if (grouping.reason) pub.ungroupedReason = grouping.reason
  }
  if (!validation.ok) pub.validation = validation
  return pub
}

// ── 状态机的共享收尾（所有来源、单会话与多会话同口径）────────────────────────

// 图片落地开关（默认开，对齐「尽可能落回 DSH」）：参数 storeImages=false 或环境变量
// DSH_IMPORT_STORE_IMAGES=0 时，图片只留 [image] 占位（省磁盘），并照实计入 imagesDegraded。
export function storeImagesEnabled(args = {}) {
  if (args.storeImages === false) return false
  if (args.storeImages === true) return true
  return process.env.DSH_IMPORT_STORE_IMAGES !== '0'
}

/** runDecision 的落盘选项（归组参数 + 图片落地开关）。每条落盘路径都经它取，开关对所有来源生效。 */
export function decisionOptions(args) {
  return { workspaceMode: args.workspaceMode, workspaceDir: args.workspaceDir, storeImages: storeImagesEnabled(args) }
}

/** 无可导入内容（空文件 / 非目标格式 / 辅助 transcript / 无用户回合的会话）：不落盘空会话。 */
export function isEmptyConversion(out) {
  return !out.meta || (out.turns.length === 0 && out.events.length === 0)
}

/**
 * 转换产物的统一收尾：预算来源标注 → 「来源 · 话题」标题与 cwd 重映射 → restamp →
 * cwdHint 补 cwd（补出的 cwd 同样过重映射；已改写过则幂等）。pinTitle:false 不钉来源
 * 标题（bundle 还原是 DSH 会话的事件级回放，标题原样保留）。
 */
export async function finishConversion(ctx, out, args, { sourcePath, sourceLabel, pinTitle = true } = {}) {
  markTrimmedSource(out, args)
  if (pinTitle) finalizeConvertedSession(out, args, sourceLabel)
  restampSession(out, args)
  await applyCwdHint(ctx, out, sourcePath)
  applyCwdRemap(out, args)
  return out
}

/**
 * 单会话源的决策落盘（decideSingle → runDecision），不附加转换明细。state 为
 * loadKnownRecord 的结果加 { stat, args, fingerprint, sourcePath, importFormat, registryDir }。
 */
export async function decideAndRunSingle(ctx, out, { known, stat, args, fingerprint, persisted, archivedIds, sourcePath, importFormat, registryDir }) {
  const decision = await decideSingle(ctx, { known, converted: out, stat, args, fingerprint, persisted, sourcePath, budget: args.budget, archivedIds, importFormat })
  return runDecision(ctx, decision, registryDir, sourcePath, persisted, decisionOptions(args))
}

/**
 * 单会话源的决策落盘：无可导入内容 → skipped（不落盘空会话）；否则决策 + 落盘。转换层
 * 明细（畸形行 / secrets / 降级计数）一并附加到公开结果。
 */
export async function commitSingle(ctx, out, state) {
  if (isEmptyConversion(out)) {
    const res = { sessionId: 'none', turns: 0, messages: 0, toolCalls: 0, skipped: 1, alreadyImported: false, status: 'skipped' }
    if (out.skipReason) res.skipReason = out.skipReason
    return attachConversionDetails(out, res)
  }
  return attachConversionDetails(out, await decideAndRunSingle(ctx, out, state))
}

// 解析单个 transcript（状态机入口）：stat → registry 短路径判定 → 读取转换 →
// decideSingle 决策落盘 → 归组。幂等键 = sourcePath（fs 服务归一化路径）。persisted
// 可传入共享快照（批量模式），缺省按需取一次。
export async function importTranscript(ctx, target, args, convert, { registryDir, persisted, fingerprintKeys = [], readText, sourceLabel, importFormat } = {}) {
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const stat = await ctx.fs.stat(target)
  const state = await loadKnownRecord(ctx, sourcePath, { registryDir, persisted })
  const fingerprint = argsFingerprint(args, fingerprintKeys)
  const skip = singleShortPath(state.known, args, fingerprint, stat)
  if (skip) return skip

  const raw = readText ? await readText(ctx, target) : await ctx.fs.readText(target)
  // expectedHash：调用方可传入源文件 SHA-256 做强校验；不匹配失败大声，不落盘。
  if (typeof args.expectedHash === 'string' && args.expectedHash) {
    const actual = createHash('sha256').update(raw).digest('hex')
    if (actual !== args.expectedHash.toLowerCase()) {
      throw new Error('expectedHash mismatch: 期望 ' + args.expectedHash + '，实际 ' + actual)
    }
  }
  const out = await finishConversion(ctx, convert(raw, { ...args, sourcePath }), args, { sourcePath, sourceLabel })
  return commitSingle(ctx, out, { ...state, stat, args, fingerprint, sourcePath, importFormat, registryDir })
}

// ── 批量 ─────────────────────────────────────────────────────────────────

const displayPathOf = (ctx) => (target) => target.displayPath || ctx.fs.processPath(target)

/**
 * 批量编排骨架：逐目标 importOne(target, path) → batchItem 归一 → 统一计数（口径见
 * lib/import-batch.mjs）；单项抛错记 failed，不中断整批。批内 registry 写合并为末尾一次
 * 提交（逐文件读-改-写 + fsync 在批 200 条时约 1.4s 纯 registry 开销），finally 保证中途
 * 失败也提交已落盘部分的记录。skipReason(target) 给「无可导入内容」的条目补默认原因。
 * 共享的 persisted 快照由调用方在 importOne 闭包里持有。
 */
export async function runImportBatch(ctx, targets, importOne, { registryDir, pathOf = displayPathOf(ctx), skipReason } = {}) {
  const tally = createBatchTally()
  const results = []
  beginRegistryBatch(registryDir)
  try {
    for (const target of targets) {
      const path = pathOf(target)
      try {
        const single = await importOne(target, path)
        tallyItem(tally, single)
        const item = batchItem(path, single)
        if (item.status === 'skipped' && !item.reason && skipReason) item.reason = skipReason(target)
        results.push(item)
      } catch (err) {
        tally.failed++
        results.push(failedItem(path, err))
      }
    }
  } finally {
    await endRegistryBatch()
  }
  return batchSummary(tally, targets.length, results)
}

// 目录批量：collector 选出的 transcript 逐个走 importTranscript 状态机（共享 persisted
// 快照与 registry 目录）。collector 额外接收 args，可为带显式谱系的来源保守筛选；默认仍是
// 每个 JSONL 一条会话。deriveArgs(target) 允许按文件派生转换参数（可 async；Cursor 取文件名
// composer id，Reasonix 读同目录 meta.json 拿 workspace/summary）；collect 默认收集 .jsonl。
export async function importDirectory(ctx, dirTarget, args, { convert, sourceLabel, importFormat, deriveArgs, collect, registryDir, fingerprintKeys = [], readText }) {
  const files = []
  await (collect || collectJsonlFiles)(ctx, dirTarget, files, args.recursive !== false, args)
  const persisted = await listPersistedIds(ctx)
  return runImportBatch(ctx, files, async (target) => {
    const derived = deriveArgs ? await deriveArgs(target) : {}
    // 展开 args（含预算 budget/budgetSource），deriveArgs 可覆盖
    return importTranscript(ctx, target, { ...args, ...derived, force: args.force === true, replace: args.replace === true }, convert, { registryDir, persisted, fingerprintKeys, readText, sourceLabel, importFormat })
  }, { registryDir, skipReason: () => 'not a ' + sourceLabel + ' transcript (no user turns)' })
}

// ── 多会话源（一库 / 一文件多会话，registry 记录 kind:'multi'）──────────────────

/** 显式选择 → 过滤集合（未选择 = null = 全部）。 */
export function selectionSet(selection) {
  return Array.isArray(selection) && selection.length > 0 ? new Set(selection) : null
}

const noUserTurns = (s) => 'no user turns (session ' + s.id + ')'

/**
 * 逐会话转换（导入用）：wanted 之外的会话跳过；每个会话经 convertOne(s) 转换、
 * finishConversion 收尾；无可导入内容的计入 preSkipped（原因点名源会话，不静默少导）。
 * 返回 commitMulti 的源侧字段：total / sourceIds 按源里读到的全部会话计（含未选中的）。
 */
export async function convertSessionItems(ctx, sessions, { path, args, wanted, convertOne, sourceLabel, skipReason = noUserTurns }) {
  const items = []
  const preSkipped = []
  for (const s of sessions) {
    if (wanted && !wanted.has(s.id)) continue
    const out = await finishConversion(ctx, convertOne(s), args, { sourcePath: path, sourceLabel })
    if (isEmptyConversion(out)) {
      preSkipped.push({ path, status: 'skipped', reason: skipReason(s) })
      continue
    }
    items.push({ key: s.id, converted: out })
  }
  return { items, preSkipped, total: sessions.length, sourceIds: sessions.map((s) => s.id) }
}

/**
 * 多会话源的决策落盘：decideMulti → runDecision，结果补上源侧口径——total（源里的会话数）、
 * 读取 / 转换阶段的跳过（preSkipped 条目 + extraSkipped 计数）、源里已消失的已知子会话
 * （missingFromSource；sourceIds 为源里读到的会话 id，缺省取本次转换出的会话键）。
 */
export async function commitMulti(ctx, { known, items, preSkipped = [], extraSkipped = 0, total, sourceIds, stat, walSig, args, fingerprint, persisted, archivedIds, sourcePath, subTable = 'sessions', importFormat, registryDir }) {
  const decision = await decideMulti(ctx, {
    known, items,
    // walSig 落进父记录，供下次短路径比对
    stat: stat && walSig !== undefined ? { ...stat, walSig } : stat,
    args, fingerprint, persisted, sourcePath, subTable, budget: args.budget, archivedIds, importFormat,
  })
  const ids = new Set(sourceIds ?? items.map((i) => i.key))
  const missing = known && known[subTable] ? Object.keys(known[subTable]).filter((k) => !ids.has(k)) : []
  const result = await runDecision(ctx, decision, registryDir, sourcePath, persisted, decisionOptions(args))
  return {
    ...result,
    total: total ?? items.length + preSkipped.length + extraSkipped,
    skipped: result.skipped + preSkipped.length + extraSkipped,
    results: [...preSkipped, ...result.results],
    ...(missing.length ? { missingFromSource: missing } : {}),
  }
}

/**
 * 多会话源的导入编排：registry 记录 → 「源未变」短路径（不读源；SQLite 源并入 WAL 边车
 * 签名，selection 守卫选择性补导）→ load(path) 读源并逐会话转换 → commitMulti。恒返回
 * 批量形态。load 只在短路径不成立时调用，返回 commitMulti 的源侧字段
 * { items, preSkipped?, extraSkipped?, total?, sourceIds? }。sourcePath 缺省取 target 的
 * 显示路径（伪路径来源显式给出幂等键）。
 */
export async function importMultiSource(ctx, target, args, { sourcePath, registryDir, persisted, subTable = 'sessions', fingerprintKeys = [], sqlite = false, selection, importFormat, load }) {
  const path = sourcePath ?? (target.displayPath || ctx.fs.processPath(target))
  const stat = await ctx.fs.stat(target)
  const state = await loadKnownRecord(ctx, path, { registryDir, persisted, kind: 'multi', subTable })
  const fingerprint = argsFingerprint(args, fingerprintKeys)
  // WAL 边车签名：主文件 stat 不变不代表库内容不变（WAL 未 checkpoint）
  const walSig = sqlite ? await sqliteWalSig(ctx, path) : undefined
  const skip = multiShortPath({ ...state, subTable, path, args, fingerprint, stat, walSig, selection })
  if (skip) return skip
  const loaded = await load(path)
  return commitMulti(ctx, { ...state, ...loaded, stat, walSig, args, fingerprint, sourcePath: path, subTable, importFormat, registryDir })
}

// ── 导入 dry-run 预览（preview / dryRun 别名）────────────────────────
// preview=true 时照常 resolve / readText / convert（拿到 meta/turns/title/messages/
// toolCalls/skipped 等统计），但绝不 create/append、绝不写 imports registry、绝不
// attachToWorkspace（零副作用）；也不触发增量续写 / 幂等 registry 读写——预览分支
// 完全绕开 loadImports / listPersistedIds / decideSingle / decideMulti / runDecision，
// 只做只读转换 + 统计。返回结构与正式导入同源（同 mode/total/results 骨架），只加
// preview:true 标记、去掉写入态字段（sessionId/status/alreadyImported 等）。
export function isPreview(args) {
  return !!(args && (args.preview === true || args.dryRun === true))
}

// 把转换输出压成预览条目：标题 / cwd / 时间 / 规模 / 跳过明细。与正式结果同口径
//（turns/messages/toolCalls/skipped 同 decideItem base 的来源），无值字段不占键。
// 跳过语义对齐 importTranscript：无可导入内容时该文件计 1 次跳过（正式 skipped 结果
// 即 hardcode skipped:1，不看转换层的畸形行计数）。
export function previewEntry(out) {
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
  // 三级探测的可解释信息（local-jsonl / 文件导入）：命中格式、判据与**每个候选格式的
  // 失败原因**。工具面 dry-run 因此能直接告诉调用方「识别成什么、凭什么、别的为什么不行」，
  // 不必让用户重跑一遍才发现文件根本不被支持。
  if (typeof out.detectedFormat === 'string' && out.detectedFormat) entry.detectedFormat = out.detectedFormat
  if (typeof out.detectedBy === 'string' && out.detectedBy) entry.detectedBy = out.detectedBy
  if (Array.isArray(out.failures) && out.failures.length > 0) entry.failures = out.failures
  if (out.bundle === true) entry.bundle = true
  return entry
}

// 预览与落盘同口径：预算来源标注 + cwd 重映射（预览显示的 cwd 必须是最终落盘值）。
// 不钉来源标题、不 restamp（预览报告的是源里的话题与时间）。
export function previewConverted(out, args) {
  return previewEntry(applyCwdRemap(markTrimmedSource(out, args), args))
}

// 标准单文件预览：readText + convert（与 importTranscript 同源），零副作用。
export async function previewTranscript(ctx, target, args, convert, { readText } = {}) {
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const raw = readText ? await readText(ctx, target) : await ctx.fs.readText(target)
  return previewConverted(convert(raw, { ...args, sourcePath }), args)
}

/** 逐目标预览（previewOne(target, path) 返回预览条目）：单项失败记 failed 条目，不中断。 */
export async function previewEach(ctx, targets, previewOne, { pathOf = displayPathOf(ctx) } = {}) {
  const results = []
  for (const target of targets) {
    const path = pathOf(target)
    try {
      results.push({ path, ...(await previewOne(target, path)) })
    } catch (err) {
      results.push(failedItem(path, err))
    }
  }
  return { total: targets.length, results }
}

// 标准目录预览：逐文件 readText + convert（与 importDirectory 同源），零副作用。
export async function previewDirectory(ctx, dirTarget, args, { convert, deriveArgs, collect, readText } = {}) {
  const files = []
  await (collect || collectJsonlFiles)(ctx, dirTarget, files, args.recursive !== false, args)
  return previewEach(ctx, files, async (target, path) => {
    const derived = deriveArgs ? await deriveArgs(target) : {}
    const raw = readText ? await readText(ctx, target) : await ctx.fs.readText(target)
    return previewConverted(convert(raw, { ...args, ...derived, sourcePath: path }), args)
  })
}

/**
 * 多会话源的预览（与 convertSessionItems 同源的只读重演）：逐会话转换 → 预览条目；无可导入
 * 内容的列为 skipped 条目。sourceLabel 给出时标题与落盘一样钉成「来源 · 话题」。
 * 返回 results 数组（total 口径由调用方按源会话数给出）。
 */
export function previewSessionSet(sessions, { path, args, wanted, convertOne, sourceLabel, skipReason = noUserTurns }) {
  const results = []
  for (const s of sessions) {
    if (wanted && !wanted.has(s.id)) continue
    const out = markTrimmedSource(convertOne(s), args)
    if (sourceLabel) finalizeConvertedSession(out, args, sourceLabel)
    else applyCwdRemap(out, args)
    if (isEmptyConversion(out)) {
      results.push({ path, skipped: 1, skipReason: skipReason(s) })
      continue
    }
    results.push({ path, ...previewEntry(out) })
  }
  return results
}
