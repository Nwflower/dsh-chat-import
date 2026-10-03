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
// previewDirectory。依赖 ctx（host 服务），非纯函数；不 import 任何 DSH 包。

import { isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import { markTrimmedSource } from './budget.mjs'
import { forgetWorkspaceIgnore } from './ignore.mjs'
import { validateSessionEvents, shapeToolResults, SESSION_FORMAT_VERSION } from './convert/index.mjs'
import { materializeImages } from './attachments.mjs'
import { resolveClaudeCwd, decodeClaudeSlug } from './cwd-map.mjs'
import { attachPlannedWorkspace, planWorkspaceGroup } from './workspace-group.mjs'
// 归组的公开面（命令层从本模块取，避免它直接依赖 workspace-group.mjs 的内部函数）
export { defaultDedicatedWorkspaceDir } from './workspace-group.mjs'
import {
  loadImports, rememberImport, unwrapRecord, listPersistedIds, archivedSessionIds, listPersistedHeaders,
  writeSession, argsFingerprint, isSessionIdChange, decideSingle, mintForceSessionId, storedEventCount,
  beginRegistryBatch, endRegistryBatch,
} from './imports.mjs'
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
  // 图片降级占位数、后端工具调用数、无法映射的结果块数、未知输出块数、
  // 畸形工具参数数。失败要大声：这些计数原本只停在转换器返回值，工具结果里看不到。
  // images 不在此列：它由宿主层（runDecision 的附件落地）计数，含义是「落成附件的张数」。
  for (const k of ['metaMessages', 'imagesDegraded', 'toolUseResultsMerged', 'backendToolCalls', 'droppedToolResultBlocks', 'droppedMalformedOutputs', 'droppedMalformedArgs']) {
    if (typeof out[k] === 'number' && out[k] > 0) res[k] = out[k]
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

// 归组（工作区挂接）已整体移入 lib/workspace-group.mjs：宿主只接受 cwd 与工作区路径
// 逐字相等的挂接，所以目标工作区必须在**创建会话之前**定下来并写进 header.cwd；旧实现
// 在这里先 create 再按「cwd → 源文件目录」回退 attach，在宿主上必然被拒（源目录被建成
// 空工作区、会话仍留在「未分组」，失败只写 console.error）。见 docs/architecture.md D16。

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

// 导入会话加入默认 preset scope + 绑定默认模型（provider/model/maxTokens），
// 使导入会话与正常会话工具一致（read/edit/glob/grep 等 25+ 工具可见、tool_calls 为
// 标准 JSON）且自动压缩可触发。优先走 ctx.agents.create（setup 钩子里
// agentPresets.mount 把 agent 加入默认 preset scope；agentOptions 绑定默认模型）——
// agents 是可选 host 服务，缺席/抛错回退 sessionPersistence 直写（导入工具本身不依赖
// preset scope；新旧两类写入 API 的差异由 imports.mjs 的 writeSession 收敛）。
// 补录预设模式：正常会话创建时 apiproxy 的 composeAgent 会把 preset id 写回
// SessionHeader.agentPreset（UI 据此渲染「预设模式」chip）；导入路径直接调
// agents.create 且 setup 里 mount 不返回 id，导致 header 无 agentPreset → UI 空。
// 这里在 create 前 resolve 默认 preset id 并写进 meta.agentPreset，让导入会话与
// 正常会话一样显示预设模式；resolve 失败（无 roster/无默认值）时保持现状（工具仍
// 经 mount 可用，仅不落盘 preset 身份）。
// 无损 JSON 清洗（issue #41 ②）：宿主对 meta 与种子事件做快照冻结
// （snapshotJsonValue），出现 undefined / 非有限数 / -0 / 非纯对象原型的字段即整份
// 拒绝创建（"seed event at index N is not losslessly JSON-serializable"）。转换层各源
// 按「有才写」构造可选字段，但透传源与第三方数据仍可能漏出，这里在落盘边界统一
// 剥离：属性值为 undefined 直接去掉；数组元素无法剥离（长度是语义）→ 归一为 null。
// 剥离即上报（失败要大声），不静默改变产物形状。
export function sanitizeJsonValue(value, path = '', stripped = [], ancestors = new Set()) {
  if (value === null) return null
  const t = typeof value
  if (t === 'string' || t === 'boolean') return value
  if (t === 'number') {
    if (Number.isFinite(value) && !Object.is(value, -0)) return value
    stripped.push(path + ' (非有限数)')
    return null
  }
  if (t !== 'object') {
    stripped.push(path + ' (' + t + ')')
    return undefined
  }
  if (ancestors.has(value)) {
    stripped.push(path + ' (循环引用)')
    return undefined
  }
  const isArray = Array.isArray(value)
  if (!isArray) {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) stripped.push(path + ' (非纯对象原型)')
  }
  ancestors.add(value)
  let out
  if (isArray) {
    out = []
    for (let i = 0; i < value.length; i++) {
      const item = sanitizeJsonValue(value[i], path + '[' + i + ']', stripped, ancestors)
      // 数组元素无法剥离（长度是语义）：归一为 null，保持下标与长度
      out.push(item === undefined ? null : item)
    }
  } else {
    out = {}
    for (const key of Object.keys(value)) {
      const item = sanitizeJsonValue(value[key], path + '.' + key, stripped, ancestors)
      if (item === undefined) continue
      out[key] = item
    }
  }
  ancestors.delete(value)
  return out
}

// 宿主会话格式版本（meta.version 会被宿主 header 校验逐字比对，不符即拒绝创建）。
// 插件不 import 宿主包，运行时按可用信号探测，全部不可得时退回转换层的默认版本：
// ① 持久化服务显式暴露的版本字段（宿主未来可提供）；
// ② 已有会话 header 的 version——宿主 list() 返回的 header 已迁移到当前格式版本，
//    故存量里最大的 version 即宿主当前写入版本（空库无参考）。
// 结果按 ctx 缓存：批量导入每个会话都探测一次会把 list() 变成 O(n²)。
const hostVersionCache = new WeakMap()

function explicitHostVersion(ctx) {
  const sp = ctx.get('sessionPersistence')
  for (const v of [sp && sp.formatVersion, sp && sp.currentVersion]) {
    if (Number.isSafeInteger(v) && v >= 0) return v
  }
  return undefined
}

// 每次导入的**目标格式版本覆盖**（面板「导入到 → DSH（V3/V4 会话格式）」）：宿主只按
// header.version 落盘（sessionPersistence.create(header) 认它），所以想产出 V3 generation
// 就必须把 header 与事件形状都按 V3 走。覆盖是 per-ctx 的 WeakMap，只在调用期间生效，
// 调用方（面板）逐条串行导入，不跨请求共享。
const formatVersionOverrides = new WeakMap()

/**
 * 在给定目标格式版本下执行一次导入编排（create 与 append 都按它走）。
 * @param ctx - 插件上下文（覆盖按它隔离）
 * @param version - 目标宿主会话格式版本（3 / 4）；undefined 表示不覆盖
 * @param fn - 编排函数
 */
export async function withHostFormatVersion(ctx, version, fn) {
  if (version !== 3 && version !== 4) return await fn()
  const previous = formatVersionOverrides.get(ctx)
  formatVersionOverrides.set(ctx, version)
  try {
    return await fn()
  } finally {
    if (previous === undefined) formatVersionOverrides.delete(ctx)
    else formatVersionOverrides.set(ctx, previous)
  }
}

// 宿主**原生**当前代次，不受 formatVersionOverrides 影响。agents.create 恒按原生代次种
// 会话，所以「显式目标代次是否就是原生代次」必须按它判断——hostSessionFormatVersion 在
// 覆盖生效时返回覆盖值，会让相等判断恒成立、把旧代次也塞进只认原生形状的 store。
export async function hostNativeFormatVersion(ctx) {
  const cached = hostVersionCache.get(ctx)
  if (cached !== undefined) return cached
  let version = explicitHostVersion(ctx)
  if (version === undefined) {
    // list 不可用（服务缺席 / 读盘失败）时 listPersistedHeaders 返回空数组，等价退回默认版本
    for (const header of await listPersistedHeaders(ctx)) {
      const v = header.version
      if (Number.isSafeInteger(v) && v >= 0 && (version === undefined || v > version)) version = v
    }
  }
  if (version === undefined) version = SESSION_FORMAT_VERSION
  hostVersionCache.set(ctx, version)
  return version
}

export async function hostSessionFormatVersion(ctx) {
  const override = formatVersionOverrides.get(ctx)
  if (override !== undefined) return override
  return hostNativeFormatVersion(ctx)
}

// 宿主 header 字段白名单。写入路径把 header 按 released-v2 schema 严格校验（v3 的
// encodeCurrentHeader 先降级成 v2 再查）：必填 version / id / createdAt / isSeeded /
// delegationDepth，可选 cwd / parentSession / origin / agentPreset——白名单外的任何键
// 都会让整次创建被拒（"format v2 header has unexpected field sourceId"，issue #41 ③）。
// 转换层的 meta 自带 sourceId / provider / model 等插件自有字段（它们只服务 registry
// 与导出协议，从不落盘 header），落盘前必须按白名单重建。
const HOST_HEADER_FIELDS = ['version', 'id', 'createdAt', 'isSeeded', 'delegationDepth', 'cwd', 'parentSession', 'origin', 'agentPreset']

// 落盘前的 meta 归一（issue #41 ①②③）：补齐宿主 header 必填字段、按白名单裁字段、
// 做无损 JSON 清洗。导入的会话都是全新会话（不是从别处继承事件前缀的 seed 会话），
// isSeeded 恒为 false；导入会话都在顶层，delegationDepth 恒为 0。
export function prepareHostMeta(meta, version) {
  const source = { ...meta, version, isSeeded: false, delegationDepth: 0 }
  const header = {}
  for (const key of HOST_HEADER_FIELDS) {
    if (source[key] !== undefined) header[key] = source[key]
  }
  // 宿主另行要求 cwd 是绝对路径（"format v2 header cwd must be absolute"）：源记录里
  // 的相对路径 / 跨平台路径剔除即可（会话退化为未分组），绝不因此拒绝整次导入
  if (typeof header.cwd !== 'string' || !isAbsolute(header.cwd)) delete header.cwd
  // createdAt 必须是非负安全整数；源时间戳缺失/越界时回落当前时间
  if (!Number.isSafeInteger(header.createdAt) || header.createdAt < 0) header.createdAt = Date.now()
  const stripped = []
  const safe = sanitizeJsonValue(header, 'meta', stripped)
  if (stripped.length > 0) {
    console.error('meta 含不可无损 JSON 序列化的字段，已剥离：' + stripped.slice(0, 10).join('; '))
  }
  return safe
}

// 事件批的无损 JSON 清洗；剥离明细按会话聚合上报（不逐事件刷屏）。
// version 为目标宿主格式版本：落盘前把工具结果归一到该版本的形状（V3 wrapper / V4 一级
// tool 消息）。宿主核心 Session 对两种形状是**互斥**校验的（V3 要求 content[0].type ===
// 'tool-result'，V4 要求 message.toolCallId 且禁 wrapper），所以这一步必须跟着
// hostSessionFormatVersion() 走，不能只吐一种。幂等，重复调用无副作用。
// hostVersion 为宿主**原生**代次（hostNativeFormatVersion）：替换标记的拼写只认它，
// 与目标 header 代次无关（见 shapeReplaceOps）。省略时回退 version，便于纯函数测试。
export function prepareHostEvents(events, sessionId, version = SESSION_FORMAT_VERSION, hostVersion = version) {
  const stripped = []
  const safe = sanitizeJsonValue(events, 'events', stripped)
  // 事件 envelope 的 data 是宿主必填字段：清洗会把值为 undefined 的 data 键整个剥掉，
  // 这里补回空对象，让「形状畸形」止步于丢一个空 data，而不是整批被拒
  for (const ev of safe) {
    if (ev && typeof ev === 'object' && ev.data === undefined) ev.data = {}
  }
  if (stripped.length > 0) {
    console.error('会话 ' + sessionId + ' 的事件含不可无损 JSON 序列化的字段，已剥离：' + stripped.slice(0, 10).join('; '))
  }
  // 形状分流放在清洗之后：sanitize 会深拷贝，先分流再清洗只是白做一遍；且分流只看
  // 已清洗过的安全值，不会把不可序列化残留带进新对象。
  //
  // 未知的更高版本（V5+）大声告警：本插件的形状分支是「一版一支」，没有「>= N 都同形」
  // 的假设——宿主换版时旧插件会按已知的最高版本产出，多半会被新宿主拒载，这里让用户先看到
  // 「插件还没跟进 N」而不是只看到一次莫名其妙的导入失败。只报一次（每个版本一条）。
  if (version > KNOWN_HOST_VERSIONS.at(-1) && !warnedHostVersions.has(version)) {
    warnedHostVersions.add(version)
    console.error('宿主会话格式版本 ' + version + ' 未知（本插件已知 ' + KNOWN_HOST_VERSIONS.join(' / ')
      + '）：按已知最高版本 ' + KNOWN_HOST_VERSIONS.at(-1) + ' 的形状产出，导入可能被宿主拒绝——请升级 dsh-chat-import')
  }
  return shapeReplaceOps(shapeMessageSources(shapeToolResults(safe, version), version), version, hostVersion)
}

// 替换标记的**名字**跟宿主 runtime 的世代走，不跟目标 header 代次走——两代宿主对
// surfaceOp 的拼写是互斥校验的，而这条与文件代次无关：
//   * dsh-session ≤ 0.1.x：runtime isReplaceOp 只认 { op:'replace', start, end }
//     （即已发布的 released-v2 写法）；
//   * dsh-session ≥ 0.2.0：runtime isReplaceOp 与 released V3/V4 两代 codec 都只认
//     { op:'replace', startSeq, endSeq }（V3 codec 会报 "requires exact replace fields
//     op/startSeq/endSeq"），连写 V3 代次的会话也一样。
// 写错方向宿主会整份拒载：V4 上写旧名报 "replacement start must be a non-negative safe
// integer"（issue：导入带压缩的 Claude 会话在 V4 宿主上打不开）。合成层按 released-v2
// 拼写产出，所以这里按世代双向归一：≥4 代改名到 startSeq/endSeq，<4 代改回 start/end
//（DSH 源回灌可能带进任一拼写，见 lib/convert/dsh.mjs）；已是目标拼写的原样通过，幂等。
// hostVersion 是宿主**原生**代次（import-core 的 hostNativeFormatVersion）；探不到时由
// 调用方回退目标代次，与本函数此前的行为一致。
function shapeReplaceOps(events, version, hostVersion) {
  const v4Names = version >= 4 || hostVersion >= 4
  return events.map((ev) => {
    const op = ev && ev.surfaceOp
    if (!op || typeof op !== 'object' || op.op !== 'replace') return ev
    const hasOld = Object.hasOwn(op, 'start') && Object.hasOwn(op, 'end')
    const hasSeq = Object.hasOwn(op, 'startSeq') && Object.hasOwn(op, 'endSeq')
    if (v4Names && hasOld && !hasSeq) return { ...ev, surfaceOp: { op: 'replace', startSeq: op.start, endSeq: op.end } }
    if (!v4Names && hasSeq && !hasOld) return { ...ev, surfaceOp: { op: 'replace', start: op.startSeq, end: op.endSeq } }
    return ev
  })
}

// 已知的宿主会话格式版本（形状分支一一对应）。宿主广告更高版本时告警而不是静默假设同形。
const KNOWN_HOST_VERSIONS = [3, 4]
const warnedHostVersions = new Set()

// V4 退役了 source.kind = 'plugin'：宿主迁移器把 {kind:'plugin', plugin:'X'} 改写成生产者
// 自己的 kind，读路径对 V4 日志直接拒绝 'plugin'（"format v4 message requires a producer-owned
// source kind"）。导入自产的环境变更声明与 system head 都用 kind='plugin'，写 V4 时必须同步
// 改写，否则宿主读不回自己刚写下的日志。V3 保持原样（'plugin' 是 V3 的合法形状）。
//
// 改写规则逐条对齐宿主 dsh-session-format-v3-to-v4 的 producerKind()：只写 'plugin:<name>'
// 不够——宿主把其中几个 V3 插件名换成了生产者自己的 kind，压缩检查点的 'compact' →
// 'compact-checkpoint' 就是其一。宿主的 isCompactCheckpointSource（压缩 invariant、会话
// 引用投影、trajectory 渲染都吃它）只认后者；写错会让检查点在宿主眼里退化成一条普通
// user 消息（摘要从会话引用投影里消失、轨迹不折叠）。DSH 源回灌可能带出表里任意一条，
// 所以整表照抄，而不是只补 compact。
const SYSTEM_PROMPT_PLUGIN = '@deepseek-ai/dsh-system-prompt'
// 宿主 RENAMED_PRODUCERS：V3 插件名 → 当前生产者 kind。
const RENAMED_PRODUCERS = {
  compact: 'compact-checkpoint',
  'tools-code-mode': 'ptc-mode',
  'tools-ptc': 'ptc-mode',
  'dsh-compaction-basic': 'compact-basic',
  [SYSTEM_PROMPT_PLUGIN]: 'runtime-context',
}
// 宿主 RELEASED_SAME_NAME_PRODUCERS：V3 插件名即当前生产者 kind。
const SAME_NAME_PRODUCERS = new Set([
  'agent-instructions', 'session-reference', 'team-message', 'goal', 'skill-invocation',
  'skill-catalog', 'coordinator', 'subagent-report', 'subagent-settled', 'webhook',
  'agent-message', 'model-selection', 'plan-mode', 'time-context', 'tmux-context',
  'user-approval', 'repeat-tool-reminder', 'tool-cordis', 'cordis-host-runner', 'tool-goal',
  'tool-jobs', 'hooks-codex', 'hooks-claude-code', 'schedule', 'dsh-session-title-llm',
])
// system head 是角色敏感的特例：同一插件名在 system 角色上是 'system-prompt'（dsh-session
// 种子校验要求 "message must have system-prompt source"），其余角色才落 runtime-context。
function producerKind(plugin, role) {
  if (plugin === SYSTEM_PROMPT_PLUGIN && role === 'system') return 'system-prompt'
  if (Object.hasOwn(RENAMED_PRODUCERS, plugin)) return RENAMED_PRODUCERS[plugin]
  if (SAME_NAME_PRODUCERS.has(plugin)) return plugin
  return 'plugin:' + plugin
}
function shapeMessageSources(events, version) {
  if (!(version >= 4)) return events
  const fixSource = (source, role) => {
    if (!source || typeof source !== 'object' || source.kind !== 'plugin' || typeof source.plugin !== 'string') return source
    const { plugin, ...rest } = source
    return { ...rest, kind: producerKind(plugin, role) }
  }
  const fixMessage = (message) => {
    if (!message || typeof message !== 'object') return message
    const source = fixSource(message.source, message.role)
    return source === message.source ? message : { ...message, source }
  }
  return events.map((ev) => {
    if (!ev || typeof ev !== 'object' || !ev.data || typeof ev.data !== 'object') return ev
    // user/message 的 data 就是消息本身；其余消息类事件把消息放在 data.message 里
    if (ev.type === 'user/message') {
      const next = fixMessage(ev.data)
      return next === ev.data ? ev : { ...ev, data: next }
    }
    if (ev.type === 'system/message' || ev.type === 'assistant/message' || ev.type === 'tool/result') {
      const next = fixMessage(ev.data.message)
      return next === ev.data.message ? ev : { ...ev, data: { ...ev.data, message: next } }
    }
    return ev
  })
}

// 续写路径的统一落盘入口：append 与 create 走同一套无损 JSON 清洗，否则带
// undefined 的尾事件会在 append 时被宿主整批拒绝（create 已清洗、append 漏洗会让
// 「首次导入成功、增量续写失败」这种最难查的不一致出现）。
// 续写的形状必须跟**目标会话自己的代次**走，不能跟宿主当前版本走：V4 宿主上给一条
// 早先导入的 V3 会话续写时，按 V4 形状写会与文件代次不一致而被宿主拒绝（旧代次会话
// 增量重导的既有隐患）。探不到该会话的 header 时才回退宿主当前版本。
async function targetSessionFormatVersion(ctx, targetId) {
  if (typeof targetId !== 'string' || targetId === '') return undefined
  for (const header of await listPersistedHeaders(ctx)) {
    if (header && header.id === targetId && Number.isSafeInteger(header.version)) return header.version
  }
  return undefined
}

async function appendHostEvents(ctx, targetId, events) {
  const version = (await targetSessionFormatVersion(ctx, targetId)) ?? (await hostSessionFormatVersion(ctx))
  // 替换标记拼写跟宿主 runtime 世代走，可能与目标 header 代次不同 → 单独取原生代次
  await ctx.sessionPersistence.append(targetId, prepareHostEvents(events, targetId, version, await hostNativeFormatVersion(ctx)))
}

async function createSession(ctx, meta, events) {
  const hostVersion = await hostSessionFormatVersion(ctx)
  // 宿主原生代次（不受显式目标代次覆盖影响）：替换标记拼写与 agents.create 判定都用它
  const nativeVersion = await hostNativeFormatVersion(ctx)
  const hostMeta = prepareHostMeta(meta, hostVersion)
  const hostEvents = prepareHostEvents(events, hostMeta.id, hostVersion, nativeVersion)
  const agents = ctx.get('agents')
  // 显式代次目标（面板「导入到 → DSH（V3/V4 会话格式）」）必须落成指定 generation：
  // agents.create 只按宿主**原生**代次种会话，所以只有「目标代次 = 原生代次」时才走它
  // （代次不等时只能 sessionPersistence.create 直写，它按 header.version 选文件名）。
  // 相等时走 agents.create 还有一层必要副作用：它会 enter + announce 会话 → 宿主
  // api-session-controller 转发 api-session/added → 客户端会话列表即时出现新会话；
  // sessionPersistence.create 只落盘、不进内存会话表，导入后必须刷新页面才看得到。
  const override = formatVersionOverrides.get(ctx)
  const useAgents = agents && typeof agents.create === 'function'
    && (override === undefined || override === nativeVersion)
  if (useAgents) {
    let presetId
    try {
      const ap = ctx.get('agentPresets')
      if (ap && typeof ap.resolve === 'function') {
        const preset = await ap.resolve()
        if (preset && typeof preset.id === 'string' && preset.id) presetId = preset.id
      }
    } catch {
      // 无默认 preset / roster 未配置：不落盘 preset 身份，其余照旧
    }
    try {
      await agents.create({
        sessionId: hostMeta.id,
        meta: { ...hostMeta, ...(presetId ? { agentPreset: presetId } : {}) },
        seed: hostEvents,
        agentOptions: await resolveAgentOptions(ctx),
        setup: (agentCtx) => {
          const ap2 = ctx.get('agentPresets')
          return ap2 && typeof ap2.mount === 'function' ? ap2.mount(agentCtx, presetId).then(() => {}) : undefined
        },
      })
      return
    } catch (err) {
      // 宿主内存索引残留同名会话（幽灵 id）：原样上抛，交给 runDecision 的
      // 「另铸新 id 重试」——回退路径在这里必然失败（legacy schema 与当前格式互斥），
      // 吞掉它等于让重铸逻辑永远不触发，同一批幽灵目录每轮重导重复失败（issue #41 ④）。
      if (isSessionTakenError(err)) throw err
      // 其它失败（宿主服务不可用 / meta 校验拒绝）→ 回退 sessionPersistence，不静默；
      // 回退也失败时把两条错误一起抛出：真正的原因通常在最外层的那条上。
      console.error('agents.create 失败，回退 sessionPersistence: ' + String((err && err.message) || err))
      try {
        await writeSession(ctx, hostMeta, hostEvents)
      } catch (fallbackErr) {
        // 回退也撞「会话已存在」同样原样上抛：重铸逻辑要看到干净的 session-taken 错误
        if (isSessionTakenError(fallbackErr)) throw fallbackErr
        throw new Error('agents.create 失败（' + String((err && err.message) || err)
          + '），sessionPersistence 回退亦失败（' + String((fallbackErr && fallbackErr.message) || fallbackErr) + '）')
      }
      return
    }
  }
  await writeSession(ctx, hostMeta, hostEvents)
}

// 默认模型解析：agentDefaultModel.currentSelection + llm.resolveModelInfo
// → { provider, model, maxTokens? }；任一环不可用/抛错返回 undefined（不阻塞导入，
// 与 预算动态解析同一容错口径）。
async function resolveAgentOptions(ctx) {
  try {
    const adm = ctx.get('agentDefaultModel')
    const llm = ctx.get('llm')
    if (!adm || typeof adm.currentSelection !== 'function') return undefined
    if (!llm || typeof llm.resolveModelInfo !== 'function') return undefined
    const selection = adm.currentSelection()
    if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') return undefined
    const info = await llm.resolveModelInfo(selection.provider, selection.model)
    const maxTokens = info && typeof info.defaultMaxTokens === 'number' && info.defaultMaxTokens > 0 ? info.defaultMaxTokens : undefined
    return { provider: selection.provider, model: selection.model, ...(maxTokens ? { maxTokens } : {}) }
  } catch {
    return undefined
  }
}

// 宿主 create 拒绝「会话 id 已被占用」的错误判定（issue #22 / #55）：宿主并列定义了
// 两种同类错误（@deepseek-ai/dsh-session-persistence 的 lib/index.js）——
//   SessionAlreadyExistsError：`session "<id>" already exists`（内存索引残留幽灵 id，
//     list 未必暴露）；
//   SessionAlreadyOwnedError：`session "<id>" is already owned by an active write handle`
//     （进程内写句柄唯一性，长驻宿主上必然出现；另起进程的同名会话则正常）。
// 命中即另铸新 id 重试。优先按 `err.name` 判定——宿主每新增一种措辞就不必再追文案；
// 文案只作兜底（老宿主、被包了一层的错误、mock host 的 `duplicate session <id>`）。
const SESSION_TAKEN_ERROR_NAMES = new Set(['SessionAlreadyExistsError', 'SessionAlreadyOwnedError'])
function isSessionTakenError(err) {
  if (SESSION_TAKEN_ERROR_NAMES.has(String((err && err.name) || ''))) return true
  const msg = String((err && err.message) || err)
  return /already exists|duplicate session|already owned by an active write handle/i.test(msg)
}

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
      : formatVersionOverrides.get(ctx)
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
      // 宿主内存索引残留同名会话（幽灵，list 未暴露但 create 拒绝，issue #22）：
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

// 解析单个 transcript（状态机入口）：stat → registry 短路径判定 → 读取转换 →
// decideSingle 决策落盘 → 归组。幂等键 = sourcePath（fs 服务归一化路径）。persisted
// 可传入共享快照（批量模式），缺省按需取一次。
export async function importTranscript(ctx, target, args, convert, { registryDir, persisted, fingerprintKeys = [], readText, sourceLabel, importFormat } = {}) {
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  const archivedIds = archivedSessionIds(ctx)
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const stat = await ctx.fs.stat(target)
  const registry = await loadImports(registryDir)
  let known = unwrapRecord(registry.imports[sourcePath])
  // 同路径若已是多会话源导入（kind:'multi'，子表结构不适用于单会话状态机）→ 视作
  // 无记录重导；撞 id 由 persisted 避让 / legacy 回填兜底。
  if (known && known.kind !== 'single') known = null
  // 记录指向的会话已不存在（被删 / DSH_HOME 迁移）或被归档（隐藏但仍占 id）
  // → 视作无记录重导（归档会话保留，重导建后缀新副本）
  if (known && (!known.dshId || !persistedSet.has(known.dshId) || archivedIds.has(known.dshId))) known = null
  const fingerprint = argsFingerprint(args, fingerprintKeys)

  // S3 短路径（不 readText）：force / replace / 显式 sessionId 变更需读文件重转，不在此跳过
  if (known && args.force !== true && args.replace !== true && !isSessionIdChange(args, known.dshId)) {
    if (typeof known.args === 'string' && fingerprint !== known.args) {
      return { sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported', argsChanged: true }
    }
    // 预算变化（文件未变）→ 跳过并报告（同 argsChanged 语义）；需要按新预算
    // 导入用 force:true。budget 为 index 层解析后的实际预算（registry 记录同一口径）。
    if (typeof known.budget === 'number' && known.budget !== args.budget) {
      return { sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported', budgetChanged: true }
    }
    if (stat && stat.version === known.version && stat.size === known.sizeBytes) {
      // 未变：短路径跳过（不 readText），重复导入同一会话幂等
      return { sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported' }
    }
  }

  const raw = readText ? await readText(ctx, target) : await ctx.fs.readText(target)
  // expectedHash：调用方可传入源文件 SHA-256 做强校验；不匹配失败大声，不落盘。
  if (typeof args.expectedHash === 'string' && args.expectedHash) {
    const actual = createHash('sha256').update(raw).digest('hex')
    if (actual !== args.expectedHash.toLowerCase()) {
      throw new Error('expectedHash mismatch: 期望 ' + args.expectedHash + '，实际 ' + actual)
    }
  }
  const out = markTrimmedSource(convert(raw, { ...args, sourcePath }), args)
  finalizeConvertedSession(out, args, sourceLabel)
  restampSession(out, args)
  await applyCwdHint(ctx, out, sourcePath)
  applyCwdRemap(out, args) // cwdHint 补出的 cwd 同样适用；已改写过则幂等返回
  // 无可导入内容（空文件 / 非目标格式 / 辅助 transcript）：计入 skipped，不落盘空会话
  if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
    const res = { sessionId: 'none', turns: 0, messages: 0, toolCalls: 0, skipped: 1, alreadyImported: false, status: 'skipped' }
    if (out.skipReason) res.skipReason = out.skipReason
    return attachConversionDetails(out, res)
  }  const decision = await decideSingle(ctx, { known, converted: out, stat, args, fingerprint, persisted: persistedSet, sourcePath, budget: args.budget, archivedIds, importFormat })
  return mergeImageCounts(out, attachConversionDetails(out, await runDecision(ctx, decision, registryDir, sourcePath, persistedSet, {
    workspaceMode: args.workspaceMode,
    workspaceDir: args.workspaceDir,
    storeImages: storeImagesEnabled(args),
  })))
}

// 图片落地开关（默认开，对齐「尽可能落回 DSH」）：参数 storeImages=false 或环境变量
// DSH_IMPORT_STORE_IMAGES=0 时，图片只留 [image] 占位（省磁盘），并照实计入 imagesDegraded。
export function storeImagesEnabled(args = {}) {
  if (args.storeImages === false) return false
  if (args.storeImages === true) return true
  return process.env.DSH_IMPORT_STORE_IMAGES !== '0'
}

// 图片计数合并：宿主层（runDecision）报「落成附件」的 images 与「保存失败降级」的
// imagesDegraded，转换层报「拿不到字节」的 imagesDegraded，两者同口径相加。
function mergeImageCounts(out, res) {
  if (typeof out.imagesDegraded === 'number' && out.imagesDegraded > 0) {
    res.imagesDegraded = (typeof res.imagesDegraded === 'number' ? res.imagesDegraded : 0) + out.imagesDegraded
  }
  return res
}

// 递归收集目录下的 .jsonl 文件。顺序依赖 ctx.fs.listDir 的名称排序契约（mock host
// 按名排序，真实 fs 服务同契），collector 自身不做二次排序。
export async function collectJsonlFiles(ctx, dirTarget, out, recursive) {
  const entries = await ctx.fs.listDir(dirTarget)
  for (const entry of entries) {
    if (entry.type === 'directory') {
      if (recursive) await collectJsonlFiles(ctx, entry.target, out, recursive)
    } else if (entry.type === 'file' && /\.jsonl$/i.test(entry.name) && !isSidecarJsonl(entry.name)) {
      out.push(entry.target)
    }
  }
}

// 会话主 transcript 的伴生 JSONL（事件日志 / 冲突日志 / 守护文件）不是会话本身，
// 目录批量扫描时排除（Reasonix V2 的 <id>.events.jsonl 是 WAL，非主 transcript）。
export function isSidecarJsonl(name) {
  return /\.(events|conflicts|guardian)\.jsonl$/i.test(name)
}

// 递归收集目录下的 .json 文件（ChatGPT 导出）。顺序依赖 ctx.fs.listDir 的名称排序
// 契约（同 collectJsonlFiles）。
export async function collectJsonFiles(ctx, dirTarget, out, recursive) {
  const entries = await ctx.fs.listDir(dirTarget)
  for (const entry of entries) {
    if (entry.type === 'directory') {
      if (recursive) await collectJsonFiles(ctx, entry.target, out, recursive)
    } else if (entry.type === 'file' && /\.json$/i.test(entry.name)) {
      out.push(entry.target)
    }
  }
}

// 把单文件结果归一为批量 results 条目（skipReason → reason；可选字段原样带过）。
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
  for (const k of ['skipReason', 'error', 'appendedTurns', 'appendedEvents', 'appendedSkipped', 'sourceShrunk', 'storedShrunk', 'changedInPlace', 'argsChanged', 'budgetChanged', 'backfilled', 'droppedBoundaryResults', 'orphanToolResults', 'duplicateToolResults', 'metaMessages', 'images', 'imagesDegraded', 'toolUseResultsMerged', 'backendToolCalls', 'droppedToolResultBlocks', 'droppedMalformedOutputs', 'droppedMalformedArgs', 'externalAgent', 'reimported', 'staleGhost', 'trimmed', 'skippedLines', 'secrets', 'permissionCount', 'walMerged', 'walRecords', 'compacted', 'compactions', 'compactionSummaryMissing', 'replaced', 'workspace', 'workspaceMode', 'workspaceCreated', 'ungrouped', 'ungroupedReason']) {
    if (single[k] !== undefined) item[k === 'skipReason' ? 'reason' : k] = single[k]
  }
  return item
}

// 批量导入：把 collector 选出的 transcript 分别导入（每个 target 走
// importTranscript 状态机，共享 persisted 快照与 registry 目录）。collector 额外接收
// args，可为带显式谱系的来源保守筛选；默认仍是每个 JSONL 一条会话。
// deriveArgs(target) 允许按文件派生转换参数（可 async；Cursor 取文件名 composer id，
// Reasonix 读同目录 meta.json 拿 workspace/summary）；collect 默认收集 .jsonl。
export async function importDirectory(ctx, dirTarget, args, { convert, sourceLabel, importFormat, deriveArgs, collect, registryDir, fingerprintKeys = [], readText }) {
  const files = []
  const collector = collect || collectJsonlFiles
  await collector(ctx, dirTarget, files, args.recursive !== false, args)
  const results = []
  let imported = 0
  let alreadyImported = 0
  let appended = 0
  let reimported = 0
  let skipped = 0
  let failed = 0
  // 图片落地汇总（>0 才占键）：与单项结果同口径（images 落成附件、imagesDegraded 占位）
  let images = 0
  let imagesDegraded = 0
  // 未归组会话数汇总（>0 才占键）：批量导入同样要看得见「这些会话不在任何工作区下」
  let ungrouped = 0
  const persisted = await listPersistedIds(ctx)
  // 批处理通道：批内每文件的 rememberImport 只进内存，末尾一次提交（此前每文件
  // 一次读-改-写 + fsync，批 200 条 ≈ 1.4s 纯 registry 开销）。finally 保证失败也提交。
  beginRegistryBatch(registryDir)
  try {
    for (const target of files) {
      const path = target.displayPath || ctx.fs.processPath(target)
      try {
        const derived = deriveArgs ? await deriveArgs(target) : {}
        // 展开 args（含 预算 budget/budgetSource），deriveArgs 可覆盖
        const single = await importTranscript(ctx, target, { ...args, ...derived, force: args.force === true, replace: args.replace === true }, convert, { registryDir, persisted, fingerprintKeys, readText, sourceLabel, importFormat })
        if (typeof single.images === 'number') images += single.images
        if (typeof single.imagesDegraded === 'number') imagesDegraded += single.imagesDegraded
        if (typeof single.ungrouped === 'number') ungrouped += single.ungrouped
        else if (single.ungrouped) ungrouped += 1
        if (single.status === 'imported') imported++
        else if (single.status === 'replaced') imported++
        else if (single.status === 'appended') appended++
        else if (single.status === 'already-imported') alreadyImported++
        else skipped++
        if (single.reimported) reimported++
        const item = batchItem(path, single)
        if (item.status === 'skipped' && !item.reason) item.reason = 'not a ' + sourceLabel + ' transcript (no user turns)'
        results.push(item)
      } catch (err) {
        failed++
        results.push({ path, status: 'failed', error: String((err && err.message) || err) })
      }
    }
  } finally {
    await endRegistryBatch()
  }
  return {
    total: files.length, imported, alreadyImported, appended, reimported, skipped, failed,
    ...(images > 0 ? { images } : {}),
    ...(imagesDegraded > 0 ? { imagesDegraded } : {}),
    ...(ungrouped > 0 ? { ungrouped } : {}),
    results,
  }
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

// 标准单文件预览：readText + convert（与 importTranscript 同源），零副作用。
export async function previewTranscript(ctx, target, args, convert, { readText } = {}) {
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const raw = readText ? await readText(ctx, target) : await ctx.fs.readText(target)
  // dry-run 与落盘同口径：预览也要走 cwd 重映射，否则预览显示的 cwd 不是最终落盘值
  const out = applyCwdRemap(markTrimmedSource(convert(raw, { ...args, sourcePath }), args), args)
  return previewEntry(out)
}

// 标准目录预览：逐文件 readText + convert（与 importDirectory 同源），零副作用。
export async function previewDirectory(ctx, dirTarget, args, { convert, deriveArgs, collect, readText } = {}) {
  const files = []
  const collector = collect || collectJsonlFiles
  await collector(ctx, dirTarget, files, args.recursive !== false, args)
  const results = []
  for (const target of files) {
    const path = target.displayPath || ctx.fs.processPath(target)
    try {
      const derived = deriveArgs ? await deriveArgs(target) : {}
      const raw = readText ? await readText(ctx, target) : await ctx.fs.readText(target)
      // 同 previewTranscript：预览与落盘同口径（含 cwd 重映射）
      const out = applyCwdRemap(markTrimmedSource(convert(raw, { ...args, ...derived, sourcePath: path }), args), args)
      results.push({ path, ...previewEntry(out) })
    } catch (err) {
      results.push({ path, status: 'failed', error: String((err && err.message) || err) })
    }
  }
  return { total: files.length, results }
}
