// lib/import-core.mjs — 共享导入编排（标准单文件 / 目录批量状态机 + 标准预览）
//
// 所有标准形态来源（Claude / Codex / Cursor / Gemini / Reasonix / Pi / OpenClaw
// 以及 hermes .jsonl 回退）共用的编排：importTranscript（REQ-24 状态机入口：
// stat → registry 短路径判定 → 读取转换 → decideSingle 决策落盘 → 归组）、
// importDirectory（目录批量，逐文件走同一状态机）、runDecision（执行决策并落盘）、
// attachToWorkspace / warmProjection（归组 + 投影缓存预热）。kimi 的 wire.jsonl
// 单文件也走 importTranscript（经 import-variants.mjs 的 importKimiFile）。
// REQ-17 dry-run 预览的共享件也在此：isPreview / previewEntry / previewTranscript /
// previewDirectory。依赖 ctx（host 服务），非纯函数；不 import 任何 DSH 包。

import { dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { markTrimmedSource } from './budget.mjs'
import { validateSessionEvents, SESSION_FORMAT_VERSION } from '../convert.mjs'
import { isHomePath, resolveClaudeCwd, decodeClaudeSlug } from './cwd-map.mjs'
import {
  loadImports, rememberImport, unwrapRecord, listPersistedIds, archivedSessionIds, listPersistedHeaders,
  writeSession, argsFingerprint, isSessionIdChange, decideSingle, mintForceSessionId,
} from './imports.mjs'
import { pinSourcedSessionTitle, sourceLabelFromImportedEvents } from './sourced-title.mjs'
import { clearSessionArtifactsForReplace } from './purge.mjs'

// REQ-39：转换层无 cwd 记录时输出 cwdHint（Claude 项目 slug 目录名）——这里消费：
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

// REQ-26：把转换层的畸形行明细 / secrets 位置 / permission 计数附加到公开结果。
// decideItem（lib/imports.mjs）只透传固定字段，这三个字段在此补透；非空才附加
//（schema 均为可选字段，空值不占键）。
export function attachReq26(out, res) {
  if (out.skippedLines && out.skippedLines.length > 0) res.skippedLines = out.skippedLines
  if (out.secrets && out.secrets.length > 0) res.secrets = out.secrets
  if (out.permissionCount && out.permissionCount > 0) res.permissionCount = out.permissionCount
  return res
}

/** 转换后统一钉住「来源 · 话题」标题（有回合才写 session/title）。 */
export function finalizeConvertedSession(out, args, sourceLabel) {
  const label = sourceLabel || args.sourceLabel || sourceLabelFromImportedEvents(out.events)
  if (label && out.turns && out.turns.length > 0) pinSourcedSessionTitle(out, label)
  return out
}

// REQ-72 restamp：把会话内所有时间戳平移到当前时间，保持相对间隔（对标
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

// 把导入的会话挂到其 cwd 对应的工作区（否则会显示为"未分组"）。
// REQ-39-lite 可见性回退：cwd 在本地不存在/不可解析（realpath 拒绝——跨机器迁移
// transcript 的常见情况）时，改用源文件所在目录（源本身是目录则用它自己）归组，
// 避免导入会话全部堆进「未分组」导致在工作区找不到。所有候选都失败才放弃归组。
/** 默认 dedicated workspace 目录：$DSH_HOME/dsh-chat-import-workspace。 */
export function defaultDedicatedWorkspaceDir(env = process.env) {
  const base = env.DSH_HOME || join(homedir(), '.dsh')
  return join(base, 'dsh-chat-import-workspace')
}

export async function attachToWorkspace(ctx, meta, sourcePath, options = {}) {
  const wr = ctx.get('workspaceRegistry')
  if (!wr || typeof wr.resolveByPath !== 'function') return false
  // REQ-70 dedicated 模式：把所有导入会话挂到单个专用工作区
  const mode = options.workspaceMode || options.mode
  if (mode === 'dedicated') {
    const dir = options.workspaceDir || options.dir || defaultDedicatedWorkspaceDir()
    try {
      await mkdir(dir, { recursive: true })
      let ws = await wr.resolveByPath(dir)
      if (!ws) ws = await wr.create(dir)
      if (!ws) return false
      await ws.attachSession(meta.id)
      return true
    } catch (err) {
      console.error('dedicated workspace attach failed for ' + dir + ':', String((err && err.message) || err))
      return false
    }
  }
  const candidates = []
  if (meta.cwd) candidates.push(meta.cwd)
  if (sourcePath) {
    try {
      const target = await ctx.fs.resolve(sourcePath)
      const info = await ctx.fs.stat(target)
      candidates.push(info && info.type === 'directory' ? sourcePath : dirname(sourcePath))
    } catch {
      // 源路径 stat 失败（已删除等）：跳过源目录回退，仅剩 cwd 候选
    }
  }
  for (const path of candidates) {
    // REQ-39 沙箱防护：cwd = 用户主目录时 dsh 沙箱 ACL 拒绝（temp 在 workspace 内，
    // pwsh 等工具直接失败）——主目录候选一律跳过，回退源文件目录
    if (isHomePath(path)) continue
    try {
      let ws = await wr.resolveByPath(path)
      if (!ws) ws = await wr.create(path)
      await ws.attachSession(meta.id)
      return true
    } catch (err) {
      console.error('workspace attach failed for ' + path + ':', String((err && err.message) || err))
    }
  }
  return false
}

// 预热投影缓存：冷读一次持久化会话并回写，让侧边栏无需打开会话即可显示
// 标题/模型等元数据（否则列表先显示 cwd 目录名，点开后才出现真实标题）。
// 失败不影响导入结果，仅记录日志。
export async function warmProjection(ctx, sessionId) {
  const projectionCache = ctx.get('sessionProjectionCache')
  if (!projectionCache || typeof projectionCache.coldSnapshot !== 'function') return false
  try {
    await projectionCache.coldSnapshot(sessionId)
    return true
  } catch (err) {
    console.error('projection warm-up failed:', String((err && err.message) || err))
    return false
  }
}

// REQ-43：导入会话加入默认 preset scope + 绑定默认模型（provider/model/maxTokens），
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

export async function hostSessionFormatVersion(ctx) {
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
export function prepareHostEvents(events, sessionId) {
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
  return safe
}

// 续写路径的统一落盘入口：append 与 create 走同一套无损 JSON 清洗，否则带
// undefined 的尾事件会在 append 时被宿主整批拒绝（create 已清洗、append 漏洗会让
// 「首次导入成功、增量续写失败」这种最难查的不一致出现）。
async function appendHostEvents(ctx, targetId, events) {
  await ctx.sessionPersistence.append(targetId, prepareHostEvents(events, targetId))
}

async function createSession(ctx, meta, events) {
  const hostMeta = prepareHostMeta(meta, await hostSessionFormatVersion(ctx))
  const hostEvents = prepareHostEvents(events, hostMeta.id)
  const agents = ctx.get('agents')
  if (agents && typeof agents.create === 'function') {
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
      // 吞掉它等于让重铸逻辑永远不触发，同一批幽灵目录每轮同步重复失败（issue #41 ④）。
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

// 默认模型解析（REQ-43）：agentDefaultModel.currentSelection + llm.resolveModelInfo
// → { provider, model, maxTokens? }；任一环不可用/抛错返回 undefined（不阻塞导入，
// 与 REQ-37 预算动态解析同一容错口径）。
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

// 宿主 create 拒绝「会话已存在」的错误判定（issue #22）：真实 DSH 报
// `session "<id>" already exists in this backend`（内存索引残留幽灵 id，list 未必
// 暴露），mock host 报 `duplicate session <id>`。命中即另铸新 id 重试。
function isSessionTakenError(err) {
  const msg = String((err && err.message) || err)
  return /already exists|duplicate session/i.test(msg)
}

// 执行 decideSingle / decideMulti 返回的决策并落盘；剥离 __ 载荷后返回公开结果。
// create 时才归组（append 续写不重复 attachToWorkspace）；persisted 就地更新供批量
// 内 id 避让；__record（新导入记录）经 rememberImport 写回 registry。
// REQ-57：落盘的每组事件跑轻量结构校验（seq 连续 / 类型白名单 / surfaceOp /
// sourceEventSeqs），有问题的会话在公开结果里附加 validation（失败大声，不静默）。
export async function runDecision(ctx, decision, registryDir, sourcePath, persisted, options = {}) {
  const validation = { ok: true, problems: [] }
  const check = (events) => {
    if (!Array.isArray(events) || events.length === 0) return
    const r = validateSessionEvents(events)
    if (!r.ok) {
      validation.ok = false
      const room = 20 - validation.problems.length
      if (room > 0) validation.problems.push(...r.problems.slice(0, room))
    }
  }
  if (decision.__action === 'create') {
    const { __meta, __events } = decision
    let meta = __meta
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
    await attachToWorkspace(ctx, meta, sourcePath, options)
    await warmProjection(ctx, meta.id)
    persisted.add(meta.id)
  } else if (decision.__action === 'replace') {
    const { __meta, __events } = decision
    const targetId = decision.sessionId
    await clearSessionArtifactsForReplace(ctx, targetId)
    await createSession(ctx, __meta, __events)
    check(__events)
    await warmProjection(ctx, targetId)
    persisted.add(targetId)
  } else if (decision.__action === 'append') {
    await appendHostEvents(ctx, decision.__targetId, decision.__tailEvents)
    check(decision.__tailEvents)
  } else if (decision.__action === 'multi') {
    for (const r of decision.__replaces || []) {
      await clearSessionArtifactsForReplace(ctx, r.targetId)
      await createSession(ctx, r.meta, r.events)
      check(r.events)
      await warmProjection(ctx, r.targetId)
      persisted.add(r.targetId)
    }
    for (const c of decision.__creates) {
      let meta = c.meta
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
      await attachToWorkspace(ctx, meta, sourcePath, options)
      await warmProjection(ctx, meta.id)
      persisted.add(meta.id)
    }
    for (const a of decision.__appends) {
      await appendHostEvents(ctx, a.targetId, a.events)
      check(a.events)
    }
  }
  if (decision.__record) await rememberImport(registryDir, sourcePath, decision.__record)
  const pub = {}
  for (const [k, v] of Object.entries(decision)) {
    if (!k.startsWith('__')) pub[k] = v
  }
  if (!validation.ok) pub.validation = validation
  return pub
}

// 解析单个 transcript（REQ-24 状态机入口）：stat → registry 短路径判定 → 读取转换 →
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
    // REQ-37：预算变化（文件未变）→ 跳过并报告（同 argsChanged 语义）；需要按新预算
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
  // REQ-72 expectedHash：调用方可传入源文件 SHA-256 做强校验；不匹配失败大声，不落盘。
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
  // 无可导入内容（空文件 / 非目标格式 / 辅助 transcript）：计入 skipped，不落盘空会话
  if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
    const res = { sessionId: 'none', turns: 0, messages: 0, toolCalls: 0, skipped: 1, alreadyImported: false, status: 'skipped' }
    if (out.skipReason) res.skipReason = out.skipReason
    return attachReq26(out, res)
  }
  const decision = await decideSingle(ctx, { known, converted: out, stat, args, fingerprint, persisted: persistedSet, sourcePath, budget: args.budget, archivedIds, importFormat })
  return attachReq26(out, await runDecision(ctx, decision, registryDir, sourcePath, persistedSet, {
    workspaceMode: args.workspaceMode,
    workspaceDir: args.workspaceDir,
  }))
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
  for (const k of ['skipReason', 'error', 'appendedTurns', 'appendedEvents', 'appendedSkipped', 'sourceShrunk', 'changedInPlace', 'argsChanged', 'budgetChanged', 'backfilled', 'droppedBoundaryResults', 'forceImported', 'staleGhost', 'trimmed', 'skippedLines', 'secrets', 'permissionCount', 'walMerged', 'walRecords', 'compacted', 'replaced']) {
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
  let skipped = 0
  let failed = 0
  const persisted = await listPersistedIds(ctx)
  for (const target of files) {
    const path = target.displayPath || ctx.fs.processPath(target)
    try {
      const derived = deriveArgs ? await deriveArgs(target) : {}
      // 展开 args（含 REQ-37 预算 budget/budgetSource），deriveArgs 可覆盖
      const single = await importTranscript(ctx, target, { ...args, ...derived, force: args.force === true, replace: args.replace === true }, convert, { registryDir, persisted, fingerprintKeys, readText, sourceLabel, importFormat })
      if (single.status === 'imported') imported++
      else if (single.status === 'replaced') imported++
      else if (single.status === 'appended') appended++
      else if (single.status === 'already-imported') alreadyImported++
      else skipped++
      const item = batchItem(path, single)
      if (item.status === 'skipped' && !item.reason) item.reason = 'not a ' + sourceLabel + ' transcript (no user turns)'
      results.push(item)
    } catch (err) {
      failed++
      results.push({ path, status: 'failed', error: String((err && err.message) || err) })
    }
  }
  return { total: files.length, imported, alreadyImported, appended, skipped, failed, results }
}

// ── REQ-17 导入 dry-run 预览（preview / dryRun 别名）────────────────────────
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
  return entry
}

// 标准单文件预览：readText + convert（与 importTranscript 同源），零副作用。
export async function previewTranscript(ctx, target, args, convert, { readText } = {}) {
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const raw = readText ? await readText(ctx, target) : await ctx.fs.readText(target)
  const out = markTrimmedSource(convert(raw, { ...args, sourcePath }), args)
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
      const out = markTrimmedSource(convert(raw, { ...args, ...derived, sourcePath: path }), args)
      results.push({ path, ...previewEntry(out) })
    } catch (err) {
      results.push({ path, status: 'failed', error: String((err && err.message) || err) })
    }
  }
  return { total: files.length, results }
}
