// lib/host-session.mjs — 宿主会话落盘适配（DSH 宿主契约面）
//
// 导入编排（lib/import-core.mjs）决定「写什么」，本模块负责「按宿主契约怎么写」：
// 会话格式代次探测与显式代次覆盖、header 白名单与无损 JSON 清洗、按代次归一事件形状
// （工具结果 V3/V4、V4 生产者 kind、替换标记拼写）、create（agents.create 优先，回退
// sessionPersistence）与 append 的统一入口、「会话 id 已被占用」错误判定，以及
// sessionPersistence 两套形状（句柄式 / 直写式）的列会话 / 读事件 / 写会话 ABI——形状差异
// 只在这里认一次（见文件末「宿主持久化 API 适配」段）。
// 依赖 ctx（host 服务），非纯函数；不 import 任何 DSH 包。

import { isAbsolute } from 'node:path'
import { shapeToolResults, SESSION_FORMAT_VERSION } from './convert/index.mjs'
import { resolveDefaultModelInfo } from './budget.mjs'

// 无损 JSON 清洗：宿主对 meta 与种子事件做快照冻结
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

/** 本次调用期间生效的显式目标代次（无覆盖时 undefined）——权威代次信号，不是推断值。 */
export function formatVersionOverride(ctx) {
  return formatVersionOverrides.get(ctx)
}

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
// 都会让整次创建被拒（"format v2 header has unexpected field sourceId"）。
// 转换层的 meta 自带 sourceId / provider / model 等插件自有字段（它们只服务 registry
// 与导出协议，从不落盘 header），落盘前必须按白名单重建。
const HOST_HEADER_FIELDS = ['version', 'id', 'createdAt', 'isSeeded', 'delegationDepth', 'cwd', 'parentSession', 'origin', 'agentPreset']

// 落盘前的 meta 归一：补齐宿主 header 必填字段、按白名单裁字段、
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
// 写错方向宿主会整份拒载（V4 上写旧名报 "replacement start must be a non-negative safe
// integer"，导入带压缩的会话在 V4 宿主上打不开）。合成层按 released-v2
// 拼写产出，所以这里按世代双向归一：≥4 代改名到 startSeq/endSeq，<4 代改回 start/end
//（DSH 源回灌可能带进任一拼写，见 lib/convert/dsh.mjs）；已是目标拼写的原样通过，幂等。
// hostVersion 是宿主**原生**代次（hostNativeFormatVersion）；探不到时由调用方回退目标代次。
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
export async function targetSessionFormatVersion(ctx, targetId) {
  if (typeof targetId !== 'string' || targetId === '') return undefined
  for (const header of await listPersistedHeaders(ctx)) {
    if (header && header.id === targetId && Number.isSafeInteger(header.version)) return header.version
  }
  return undefined
}

export async function appendHostEvents(ctx, targetId, events) {
  const version = (await targetSessionFormatVersion(ctx, targetId)) ?? (await hostSessionFormatVersion(ctx))
  // 替换标记拼写跟宿主 runtime 世代走，可能与目标 header 代次不同 → 单独取原生代次
  await ctx.sessionPersistence.append(targetId, prepareHostEvents(events, targetId, version, await hostNativeFormatVersion(ctx)))
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
export async function createSession(ctx, meta, events) {
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
      // 吞掉它等于让重铸逻辑永远不触发，同一批幽灵目录每轮重导重复失败。
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

// 默认模型绑定 → { provider, model, maxTokens? }；探测链与预算动态解析共用
// （lib/budget.mjs resolveDefaultModelInfo），任一环不可用时返回 undefined（不阻塞导入）。
async function resolveAgentOptions(ctx) {
  const resolved = await resolveDefaultModelInfo(ctx)
  if (!resolved) return undefined
  const info = resolved.info
  const maxTokens = info && typeof info.defaultMaxTokens === 'number' && info.defaultMaxTokens > 0 ? info.defaultMaxTokens : undefined
  return { provider: resolved.provider, model: resolved.model, ...(maxTokens ? { maxTokens } : {}) }
}

// 宿主 create 拒绝「会话 id 已被占用」的错误判定：宿主并列定义了
// 两种同类错误（@deepseek-ai/dsh-session-persistence 的 lib/index.js）——
//   SessionAlreadyExistsError：`session "<id>" already exists`（内存索引残留幽灵 id，
//     list 未必暴露）；
//   SessionAlreadyOwnedError：`session "<id>" is already owned by an active write handle`
//     （进程内写句柄唯一性，长驻宿主上必然出现；另起进程的同名会话则正常）。
// 命中即另铸新 id 重试。优先按 `err.name` 判定——宿主每新增一种措辞就不必再追文案；
// 文案只作兜底（老宿主、被包了一层的错误、mock host 的 `duplicate session <id>`）。
const SESSION_TAKEN_ERROR_NAMES = new Set(['SessionAlreadyExistsError', 'SessionAlreadyOwnedError'])
export function isSessionTakenError(err) {
  if (SESSION_TAKEN_ERROR_NAMES.has(String((err && err.name) || ''))) return true
  const msg = String((err && err.message) || err)
  return /already exists|duplicate session|already owned by an active write handle/i.test(msg)
}

// ── 宿主持久化 API 适配 ──────────────────────────────────────────────────────
// sessionPersistence 有两套形状，插件用到的三个面各不相同：
//   句柄式（当前宿主）：list() → [{ header, revision, sizeBytes }]；读走 open(id, 'read')
//                      → handle.read(offset, length) → { events }；create(header) 返回写
//                      句柄，续写走 handle.append(events)；
//   直写式（旧宿主）  ：list() → header 数组；readFrom(id, fromSeq) / inspect(id) 读事件；
//                      create(header) 无返回值，续写走 append(id, events)。
// 只在本层认两套形状，其余模块继续用「列会话 / 读事件 / 建会话」的语义。

/** list() 的一个元素 → 会话 header（新旧两种形状都认）。 */
export function persistedHeaderOf(entry) {
  if (!entry || typeof entry !== 'object') return undefined
  return entry.header && typeof entry.header === 'object' ? entry.header : entry
}

/** 列出宿主里的会话 header（list 不可用 / 读盘失败 → 空数组）。 */
export async function listPersistedHeaders(ctx) {
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof sp.list !== 'function') return []
  try {
    const entries = await sp.list()
    return (Array.isArray(entries) ? entries : []).map(persistedHeaderOf).filter(Boolean)
  } catch {
    return []
  }
}

/** 持久化服务是否提供「读事件」面（新旧任一形态）。 */
export function canReadSessionEvents(sp) {
  return !!sp && (typeof sp.readFrom === 'function' || typeof sp.open === 'function')
}

/** 读会话「元数据 + 事件」（fromSeq 起），新旧宿主统一形态。读不到 / 服务不可用 →
 * null，调用方保守处理。新宿主没有 readFrom，用 open(id,'read') 的写句柄：meta 取
 * handle.header，事件取 handle.read()。读句柄关闭失败不影响已读到的事件，只上报。 */
export async function readSessionRecord(ctx, id, fromSeq = 0) {
  const sp = ctx.get('sessionPersistence')
  if (!sp) return null
  if (typeof sp.readFrom === 'function') {
    try {
      const out = await sp.readFrom(id, fromSeq)
      return out && Array.isArray(out.events) ? { meta: out.meta, events: out.events } : null
    } catch {
      return null
    }
  }
  if (typeof sp.open !== 'function') return null
  let handle
  try {
    handle = await sp.open(id, 'read')
    const out = await handle.read(fromSeq, Number.MAX_SAFE_INTEGER)
    return out && Array.isArray(out.events) ? { meta: handle.header, events: out.events } : null
  } catch {
    return null
  } finally {
    if (handle && typeof handle.close === 'function') {
      try {
        await handle.close()
      } catch (err) {
        // 释放读句柄失败不影响已读到的事件，但也不静默：宿主租约可能滞留
        console.error('会话读句柄关闭失败（' + id + '）: ' + String((err && err.message) || err))
      }
    }
  }
}

/** 读会话事件（fromSeq 起）；语义同 {@link readSessionRecord}，只取事件面。 */
export async function readSessionEvents(ctx, id, fromSeq = 0) {
  const record = await readSessionRecord(ctx, id, fromSeq)
  return record === null ? null : record.events
}

/** 写入一个新会话（create + 落事件），兼容新旧两套写入 API：
 * 新宿主 create(header) 返回写句柄，事件经 handle.append(events) 落盘、flush 建持久化
 * 屏障，最后关句柄释放写租约；旧宿主 create(header) 无返回值，续写走 append(id, events)。 */
export async function writeSession(ctx, header, events) {
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof sp.create !== 'function') throw new Error('sessionPersistence 不可用（缺少 create）')
  const handle = await sp.create(header)
  if (handle && typeof handle.append === 'function') {
    try {
      await handle.append(events)
      if (typeof handle.flush === 'function') await handle.flush()
    } finally {
      if (typeof handle.close === 'function') {
        try {
          await handle.close()
        } catch (err) {
          // 数据已 flush；关句柄失败只影响写租约释放，上报而不改判导入结果
          console.error('会话写句柄关闭失败（' + header.id + '）: ' + String((err && err.message) || err))
        }
      }
    }
    return
  }
  if (typeof sp.append === 'function') {
    await sp.append(header.id, events)
    return
  }
  throw new Error('sessionPersistence 写入面不可用（create 未返回写句柄，且没有 append(id, events)）')
}

/** header 列表 → 会话 id 集合。同一趟 list() 的两种消费共用它：原生会话过滤 / 导入状态要 id
 * 集合，标题提示要 header 本身（身份凭证）——两处都先取 listPersistedHeaders 再各取所需，
 * 不重复调 list()。 */
export function persistedIdSet(headers) {
  const ids = new Set()
  for (const h of Array.isArray(headers) ? headers : []) {
    if (h && typeof h.id === 'string' && h.id) ids.add(h.id)
  }
  return ids
}

/** 已持久化会话 id 快照（就地可增，供批量内避让）。 */
export async function listPersistedIds(ctx) {
  return persistedIdSet(await listPersistedHeaders(ctx))
}

/** 已归档会话 id 集合（workspaceRegistry 的全局归档集；服务缺席 / 不可读 → 空集）。
 * 归档只把会话隐藏出分组界面，会话仍在 sessionPersistence 中且占用原 id——导入层
 * 据此把「记录目标已归档」视作可重导：建后缀新副本（mintForceSessionId），
 * 归档会话原样保留（平台无取消归档面，重导即新建可见副本）。 */
export function archivedSessionIds(ctx) {
  try {
    const wr = ctx.get('workspaceRegistry')
    const ids = wr && typeof wr.archivedSessionIds !== 'undefined' ? wr.archivedSessionIds : null
    return new Set(Array.isArray(ids) ? ids : [])
  } catch {
    // workspaceRegistry 未初始化 / 不可读：按无归档处理（保守回退，状态显示已导入）
    return new Set()
  }
}

/** 已存储日志事件数：宿主日志的实际长度是权威续写游标（用户在 DSH 续聊后
 * registry 的 events 会过期）；读不到返回 null → 调用方保守跳过续写。 */
export async function storedEventCount(ctx, dshId) {
  const events = await readSessionEvents(ctx, dshId, 0)
  return events === null ? null : events.length
}
