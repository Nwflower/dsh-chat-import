// lib/session-hints.mjs — 列表条目的宿主侧「标题提示」：宿主持久投影缓存（ctx.sessionProjectionCache）
//
// 为什么需要它：发现层为了不整读几十 MB 的 .zstd 日志，压缩后超过 DSH_ZSTD_SCAN_MAX_BYTES 的
// 会话按布局目录名兜底构造条目（lib/discovery/dsh.mjs）——标题为空、project 退回布局名。而宿主
// 早把这些会话的标题折叠好存进了 session_projcache 域，本模块把它当**提示**读出来，只补「来源
// 自己没取到标题」的条目：不解压、不整读，也不改动任何已有取值（决策见 docs/architecture.md D23）。
//
// 读法逐字对齐宿主自己的会话列表（api-session-controller 的 projectionsFor）：
//   cachedSnapshot(header, ['title']) ?? cachedPredecessorTitle(header)
// 身份由调用方手里的 header（sessionPersistence.list() 的那份）作证，命中才取值；跨 Session 格式
// 代次（V3 行 / V4 宿主）由 cachedPredecessorTitle 接住。缓存行可能落后于日志（节流写回），所以
// 它只能兜底，绝不覆盖来源已经读到的标题。
//
// 服务是机会式消费（不进 inject）：部署没挂 session-projection-cache 时本模块整体退化为「没有
// 提示」，发现层照旧工作。读取一律走 ctx.get(name)——用属性代理读未声明服务会穿过外部 shadow
// 失配（宿主 postmortem 0001）。

import { basenameOf } from './discovery/common.mjs'

// 只有 DSH 来源的条目，sessionId 才是宿主会话 id（其它来源的 id 属于别的键空间，不能拿来查缓存）。
const HINT_FORMATS = new Set(['dsh', 'dsh4'])

// 提示字段：title 缺失才补；cwd / createdAt 一并带出，让兜底条目与解析成功的条目同口径
//（project 由 cwd 派生、git 分支按 cwd 解析、创建时间不再退化成文件 mtime）。
function hintOf(header, title) {
  const hint = {}
  if (title) hint.title = title
  if (typeof header.cwd === 'string' && header.cwd) {
    hint.cwd = header.cwd
    const base = basenameOf(header.cwd)
    if (base) hint.project = base
  }
  if (Number.isFinite(header.createdAt)) hint.createdAt = header.createdAt
  return Object.keys(hint).length > 0 ? hint : null
}

const titleOfBlock = (block) => {
  const v = block && block.values ? block.values.title : undefined
  return typeof v === 'string' ? v.trim() : ''
}

/** headers（sessionPersistence.list() 的结果）→ id → header。缺 id 的项跳过。 */
function headerMapOf(headers) {
  const byId = new Map()
  for (const h of headers || []) {
    if (h && typeof h.id === 'string' && h.id && !byId.has(h.id)) byId.set(h.id, h)
  }
  return byId
}

// 会话在发现期间结束（agent scope 失活，Cordis INACTIVE_EFFECT）不是故障，不记警告——与
// lib/prompt-hint.mjs 同一判据。
const isInactive = (err) => !!err && err.code === 'INACTIVE_EFFECT'

/**
 * 造一个提示提供器：`(entry) => hint | null`，同步、零 I/O（缓存的服务面读的是内存表）。
 *
 * @param ctx - 插件 ctx（只用于机会式 `ctx.get('sessionProjectionCache')`）
 * @param headers - 宿主当前持久化会话的 header 列表（或 id→header 的 Map），作身份凭证
 * @returns 提供器；服务缺席 / 读失败时恒返回 null（首次失败在宿主日志留一行，之后不再重试、
 *   也不逐条刷屏）
 */
export function makeSessionHintProvider(ctx, headers) {
  const byId = headers instanceof Map ? headers : headerMapOf(headers)
  const memo = new Map()
  let cache
  let resolved = false
  let disabled = false

  const service = () => {
    if (resolved) return cache
    resolved = true
    try {
      const s = ctx && typeof ctx.get === 'function' ? ctx.get('sessionProjectionCache') : undefined
      cache = s && typeof s.cachedSnapshot === 'function' ? s : undefined
    } catch (err) {
      disabled = true
      if (!isInactive(err)) console.warn('[dsh-chat-import] 会话标题提示不可用（改用来源自身的标题）：' + String((err && err.message) || err))
    }
    return cache
  }

  return (entry) => {
    if (disabled || !entry || !HINT_FORMATS.has(entry.format)) return null
    const id = entry.sessionId
    if (typeof id !== 'string' || !id) return null
    const header = byId.get(id)
    if (!header) return null // 磁盘上的日志不在宿主持久化列表里（旧代次 / 半成品 / 宿主读不出）：没有身份凭证
    if (memo.has(id)) return memo.get(id)
    let hint = null
    try {
      const c = service()
      if (c) {
        // 当前代次优先，跨格式代次退回 predecessor 的 title-only hint（宿主同序）
        const block = c.cachedSnapshot(header, ['title']) ?? c.cachedPredecessorTitle(header)
        hint = hintOf(header, titleOfBlock(block))
      }
    } catch (err) {
      disabled = true
      if (!isInactive(err)) console.warn('[dsh-chat-import] 会话标题提示读取失败（改用来源自身的标题）：' + String((err && err.message) || err))
    }
    memo.set(id, hint)
    return hint
  }
}
