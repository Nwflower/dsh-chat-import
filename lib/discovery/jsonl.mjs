// lib/discovery/jsonl.mjs — 逐行 JSONL 转录族的发现：codex、cursor、reasonix、openclaw、pi
//
// 各来源的转录都是「一个会话 = 一个（或一条链的）.jsonl」，只读文件头抽元数据；
// 结构签名（session_meta / agent-transcripts 布局 / session 头 version 字段…）不符即自拒。

import { join } from 'node:path'
import { normalizeTitle } from '../convert/util.mjs'
import { parseCursorEmbeddedTimestamp, stripCursorTitleDecorations, isCursorNonRepoSlug } from '../cwd-map.mjs'
import { codexThreadIdFromName, codexNameTimestamp } from '../sources/codex.mjs'
import {
  HEAD_MAX_BYTES, basenameOf, dirnameOf, slashPath, siblingPath, parseJsonlHead, contentText,
  firstUserRawText, firstUserTitle, parseTimeValue, firstNumber, projectFromRecord, makeEntry, emitEach,
} from './common.mjs'
import { walkFiles } from './walk.mjs'
import { probeSource } from './scan-cache.mjs'

// codex：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl 与 ~/.codex/archived_sessions/
// rollout-*.jsonl（首记录 session_meta 为格式签名；walkFiles 递归，扁平目录同样适用）。
// rollout 文件发现。新版 Codex CLI 会把一个会话**拆成多个分页文件**（issue #57）：
// 同 thread 的所有分页共享文件名前缀（首个 UUID = thread id），后续页带 `_<pageId>` 后缀，
// 每页首行 session_meta 带 history_mode/history_base 指向上一页。因此**按 thread 分组，
// 一条链只出一个条目**：sourcePath = 链的首页（导入的幂等键，追加新页不变）、标题取首页
// 的首条用户消息（修复「两条同名条目」）、createdAt 取最早页、lastActiveAt 取最新页 mtime。
// 子代理 rollout（thread_source='subagent' / source.subagent）仍按文件级跳过。
async function scanCodex(host, target, { bm, emit }) {
  const files = []
  await walkFiles(host, target, files, (name) => /\.jsonl$/i.test(name))
  // 先收集每個文件的 stat 与头部元数据（probeSource 的书签按文件粒度，保持既有 TTL 行为）
  const statByPath = new Map()
  const groups = new Map()
  for (const file of files) {
    const st = await host.stat(file.path)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    const entries = await probeSource(bm, 'codex', file.path, fp, async () => {
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      const meta = recs.find((r) => r && r.type === 'session_meta' && r.payload && typeof r.payload === 'object')
      if (!meta) return []
      const payload = meta.payload
      // Codex 子代理 rollout（thread_source='subagent' / source.subagent）不是独立会话：
      // 发现层跳过（对齐 claude/qoder 的「辅助 transcript 跳过」），不进 scan_discover 的
      // scanned 计数。判定内联镜像 convert/codex.mjs 的 codexSubagentMarker，
      // 避免 discovery 引入 convert 依赖链（本模块既有 reasonixStemTime 同款约定）。
      if (payload.thread_source === 'subagent' || (payload.source && typeof payload.source === 'object' && payload.source.subagent)) return []
      return [{ payload, recs, timestamp: meta.timestamp }]
    })
    if (entries.length === 0) continue
    const probed = entries[0]
    const payload = probed.payload
    statByPath.set(file.path, st)
    // 分组键：文件名第一个 UUID（thread id）优先，退回 payload.id（两者按报告者实测一致）
    const threadId = codexThreadIdFromName(file.name)
      || (typeof payload.id === 'string' && payload.id ? payload.id : null)
    if (!threadId) continue
    if (!groups.has(threadId)) groups.set(threadId, [])
    groups.get(threadId).push({
      path: file.path, name: file.name, payload, recs: probed.recs,
      createdAt: parseTimeValue(probed.timestamp) ?? parseTimeValue(payload.timestamp),
      cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
    })
  }
  const out = []
  for (const [threadId, pages] of groups) {
    // 页序：文件名内嵌时间戳（rollout-YYYY-MM-DDThh-mm-ss-）单调递增；mtime 回退
    const mtimeOf = (p) => statByPath.get(p.path)?.mtimeMs ?? null
    const sorted = [...pages].sort((a, b) => {
      const ta = codexNameTimestamp(a.name) || ''
      const tb = codexNameTimestamp(b.name) || ''
      if (ta !== tb) return ta < tb ? -1 : 1
      return (mtimeOf(a) ?? 0) - (mtimeOf(b) ?? 0)
    })
    const root = sorted[0]
    const head = sorted[sorted.length - 1]
    // 指纹取链的复合（size 求和 + mtime 最大）：新增一页即变化，触发 append
    let sizeSum = 0
    let mtimeMax = 0
    for (const p of sorted) {
      const s = statByPath.get(p.path)
      sizeSum += s?.sizeBytes ?? 0
      mtimeMax = Math.max(mtimeMax, s?.mtimeMs ?? 0)
    }
    const createdAt = root.createdAt
      ?? sorted.map((p) => p.createdAt).find((v) => v !== undefined)
    const title = firstUserTitle(root.recs, (r) => (r && r.type === 'response_item' && r.payload && r.payload.type === 'message' && r.payload.role === 'user' ? contentText(r.payload.content) : ''))
      // 首页没有可读用户消息（如被裁剪）→ 回退最新页的标题线索
      || firstUserTitle(head.recs, (r) => (r && r.type === 'response_item' && r.payload && r.payload.type === 'message' && r.payload.role === 'user' ? contentText(r.payload.content) : ''))
    const entries = await probeSource(bm, 'codex', root.path, { mtimeMs: mtimeMax, sizeBytes: sizeSum }, async () => [makeEntry({
      format: 'codex', sessionId: threadId, title,
      project: projectFromRecord(root.cwd, () => codexLayoutProject(root.path)),
      createdAt, lastActiveAt: mtimeMax || undefined,
      sourcePath: root.path, cwd: root.cwd,
    })])
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// cursor：~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl
//（布局签名：路径含 agent-transcripts 且 fileStem == 父目录名）。
// project/cwd：slug 经 host.resolveCursorSlug 还原为真实工作区路径（见 cwd-map.mjs）。
async function scanCursor(host, target, { bm, emit }) {
  const files = []
  await walkFiles(host, target, files, (name) => /\.jsonl$/i.test(name))
  const out = []
  for (const file of files) {
    if (!/agent-transcripts/i.test(file.path)) continue
    const stem = basenameOf(file.name).replace(/\.jsonl$/i, '')
    if (stem !== basenameOf(dirnameOf(file.path))) continue
    const st = await host.stat(file.path)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    const entries = await probeSource(bm, 'cursor', file.path, fp, async () => {
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      const extractUser = (r) => (r && r.role === 'user' ? String(contentText(r.message && r.message.content)).replace(/<\/?user_query>/g, '') : '')
      const rawFirst = firstUserRawText(recs, extractUser)
      const tsFromTitle = rawFirst ? parseCursorEmbeddedTimestamp(rawFirst) : undefined
      const title = rawFirst ? normalizeTitle(stripCursorTitleDecorations(rawFirst)) : null
      const slug = cursorLayoutProject(file.path)
      const cwd = host.resolveCursorSlug && slug ? await host.resolveCursorSlug(slug) : null
      const createdAt = tsFromTitle ?? null
      const lastActiveAt = typeof st.mtimeMs === 'number' ? st.mtimeMs : (tsFromTitle ?? null)
      return [makeEntry({
        format: 'cursor', sessionId: stem, title,
        project: projectFromRecord(cwd, () => null),
        createdAt, lastActiveAt, sourcePath: file.path, cwd,
      })]
    }, (hit) => patchCursorCacheEntries(host, hit, file.path, fp))
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// cursor 书签读时补丁：旧缓存常带 cwd=null、project=原始 slug；命中 mtime+size 后
// 仍经 resolveCursorSlug 还原真实工作区，并从 title 补 createdAt（不重读 jsonl）。
async function patchCursorCacheEntries(host, entries, sourcePath, fp) {
  if (!Array.isArray(entries) || entries.length === 0) return { entries, changed: false }
  const slug = cursorLayoutProject(sourcePath)
  let changed = false
  const out = []
  for (const entry of entries) {
    if (!entry || entry.format !== 'cursor') {
      out.push(entry)
      continue
    }
    const next = { ...entry }
    const rawTitle = typeof entry.title === 'string' ? entry.title : ''

    if (isCursorNonRepoSlug(slug)) {
      if (next.cwd !== null) { next.cwd = null; changed = true }
      if (next.project !== null) { next.project = null; changed = true }
    } else if (host.resolveCursorSlug) {
      const cwd = await host.resolveCursorSlug(slug)
      const project = projectFromRecord(cwd, () => null)
      if (next.cwd !== cwd) { next.cwd = cwd; changed = true }
      if (next.project !== project) { next.project = project; changed = true }
    }

    if (rawTitle.includes('<timestamp>') || rawTitle.includes('<user_query>')) {
      const cleaned = normalizeTitle(stripCursorTitleDecorations(rawTitle))
      const title = cleaned || null
      if (next.title !== title) { next.title = title; changed = true }
    }

    if (next.createdAt === null) {
      const ts = parseCursorEmbeddedTimestamp(rawTitle)
      if (typeof ts === 'number' && Number.isFinite(ts)) {
        next.createdAt = ts
        changed = true
      }
    }

    if (next.lastActiveAt === null) {
      const la = typeof fp.mtimeMs === 'number' ? fp.mtimeMs : (next.createdAt ?? null)
      if (la !== null) {
        next.lastActiveAt = la
        changed = true
      }
    }

    out.push(next)
  }
  return { entries: out, changed }
}

// reasonix：~/.reasonix/sessions/desktop-*.jsonl（子代理 subagent-sub-* 默认过滤，不发现），
// 排除 .events/.conflicts/.guardian 伴生；会话 id = 文件 stem；project 走 projects/<slug> 布局。
// 桌面版：<state root>/projects/<slug>/sessions/*.jsonl（.titles.json 权威标题
// + slug 布局 project；stem 任意，无 desktop- 前缀要求）——按文件路径形态分派，
// 两种根（CLI sessions 目录 / 桌面版根）统一扫描。
function isReasonixSidecar(name) {
  return /\.(events|conflicts|guardian)\.jsonl$/i.test(name)
}

async function scanReasonix(host, target, { bm, emit }) {
  const files = []
  await walkFiles(host, target, files, (name) => /\.jsonl$/i.test(name) && !isReasonixSidecar(name))
  const out = []
  const titleCache = new Map()
  for (const file of files) {
    const stem = basenameOf(file.name).replace(/\.jsonl$/i, '')
    // 桌面版布局：projects/<slug>/sessions/<file>.jsonl（stem 无前缀限制）
    const desktop = /projects[\\/][^\\/]+[\\/]sessions/i.test(String(file.path))
    // CLI 布局只发现主会话 desktop-*；subagent-sub-* 子代理默认过滤（对齐 claude/qoder
    // 的「辅助 transcript 跳过」语义，避免目录扫描产出碎片会话）。
    if (!desktop && !/^desktop-/.test(stem)) continue
    const st = await host.stat(file.path)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    const entries = await probeSource(bm, 'reasonix', file.path, fp, async () => {
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      if (!recs.some((r) => r && typeof r === 'object' && r.role === 'user')) return []
      // 桌面版：目录级 .titles.json 权威标题（basename → 标题）
      let explicit = ''
      if (desktop) {
        const titlesPath = siblingPath(file.path, '.titles.json')
        let titles = titleCache.get(titlesPath)
        if (titles === undefined) {
          try {
            titles = JSON.parse((await host.readText(titlesPath)) || '{}')
          } catch {
            titles = {}
          }
          titleCache.set(titlesPath, titles)
        }
        if (titles && typeof titles[stem] === 'string' && titles[stem].trim()) explicit = titles[stem].trim()
      }
      const title = normalizeTitle(explicit) || firstUserTitle(recs, (r) => (r && r.role === 'user' && typeof r.content === 'string' ? r.content : ''))
      const createdAt = firstNumber(recs, (r) => (r && typeof r.createdAt === 'number' ? r.createdAt : undefined))
      return [makeEntry({
        format: 'reasonix', sessionId: stem, title,
        project: reasonixLayoutProject(file.path),
        createdAt: createdAt ?? reasonixStemTime(stem), lastActiveAt: st.mtimeMs, sourcePath: file.path,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// reasonixStemTime 镜像（lib/convert/reasonix.mjs 的导出，本地内联避免引入
// convert 依赖链）：stem 内嵌桌面会话创建时刻（本地时间），转录无时间戳时回退。
function reasonixStemTime(stem) {
  const m = String(stem || '').match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/)
  if (!m) return null
  const month = +m[2]
  const day = +m[3]
  const hour = +m[4]
  const minute = +m[5]
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null
  const t = new Date(+m[1], month - 1, day, hour, minute)
  return Number.isNaN(t.getTime()) ? null : t.getTime()
}

// openclaw：~/.openclaw/agents/<agent>/sessions/*.jsonl；同目录 sessions.json 索引
// 提供 displayName 作标题（内联 openclawDisplayNames 语义，避免引 convert 依赖链）。
async function openclawNames(indexJson) {
  const map = new Map()
  let index
  try { index = JSON.parse(indexJson) } catch { return map }
  if (!index || typeof index !== 'object') return map
  for (const entry of Object.values(index)) {
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.sessionId === 'string' && typeof entry.displayName === 'string' && entry.displayName.trim()) {
      map.set(entry.sessionId, entry.displayName.trim())
    }
  }
  return map
}

async function scanOpenclaw(host, target, { bm, emit }) {
  const files = []
  await walkFiles(host, target, files, (name) => /\.jsonl$/i.test(name))
  const out = []
  const nameCache = new Map()
  for (const file of files) {
    if (!/\bagents\b.*\bsessions\b/i.test(file.path)) continue
    const indexPath = siblingPath(file.path, 'sessions.json')
    const st = await host.stat(file.path)
    if (!st) continue
    const ist = await host.stat(indexPath)
    // 标题可能来自伴生 sessions.json → fingerprint 含伴生文件（任一变化 → 重读）
    const fp = {
      mtimeMs: st.mtimeMs + '|' + (ist ? ist.mtimeMs : ''),
      sizeBytes: st.size + (ist ? ist.size : 0),
    }
    const entries = await probeSource(bm, 'openclaw', file.path, fp, async () => {
      let names = nameCache.get(indexPath)
      if (names === undefined) {
        names = await openclawNames(await host.readText(indexPath))
        nameCache.set(indexPath, names)
      }
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      if (!recs.some((r) => r && typeof r === 'object' && (r.type === 'session' || r.type === 'message'))) return []
      const sessRec = recs.find((r) => r && r.type === 'session')
      const sessionId = sessRec && typeof sessRec.id === 'string' && sessRec.id
        ? sessRec.id
        : basenameOf(file.name).replace(/\.jsonl$/i, '')
      const title = names.get(sessionId)
        || firstUserTitle(recs, (r) => (r && r.type === 'message' && r.message && r.message.role === 'user' ? contentText(r.message.content) : ''))
      const cwd = sessRec && typeof sessRec.cwd === 'string' ? sessRec.cwd : undefined
      const createdAt = sessRec ? parseTimeValue(sessRec.timestamp) : undefined
      return [makeEntry({
        format: 'openclaw', sessionId, title,
        project: projectFromRecord(cwd, () => openclawLayoutProject(file.path)),
        createdAt, lastActiveAt: st.mtimeMs, sourcePath: file.path, cwd,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// pi：~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl（树形条目）。格式签名 =
// 会话头 type:"session" 带 version（1|2|3）字段——与 hermes/openclaw 的 session 头区分。
// 标题：活动路径上最后的 session_info.name，缺省回退首条真实 user 文本（只读文件头）。
async function scanPi(host, target, { emit }) {
  const files = []
  await walkFiles(host, target, files, (name) => /\.jsonl$/i.test(name))
  const out = []
  for (const file of files) {
    const head = await host.readHead(file.path, HEAD_MAX_BYTES)
    if (head === null || head === '') continue
    const recs = parseJsonlHead(head)
    const header = recs.find((r) => r && r.type === 'session' && typeof r.version === 'number')
    if (!header) continue
    const sessionId = typeof header.id === 'string' && header.id ? header.id
      : basenameOf(file.name).replace(/\.jsonl$/i, '')
    let name = ''
    for (let i = recs.length - 1; i >= 0; i--) {
      const r = recs[i]
      if (r && r.type === 'session_info' && typeof r.name === 'string' && r.name.trim()) {
        name = r.name.trim()
        break
      }
    }
    const title = normalizeTitle(name) || firstUserTitle(recs, (r) => (r && r.type === 'message' && r.message && r.message.role === 'user' ? contentText(r.message.content) : ''))
    const cwd = typeof header.cwd === 'string' ? header.cwd : undefined
    const createdAt = parseTimeValue(header.timestamp)
    const st = await host.stat(file.path)
    const entry = makeEntry({
      format: 'pi', sessionId, title,
      project: projectFromRecord(cwd, () => null),
      createdAt, lastActiveAt: st && st.mtimeMs, sourcePath: file.path, cwd,
    })
    out.push(entry)
    await emitEach(emit, [entry])
  }
  return out
}

// 项目名布局：~/.codex/sessions/YYYY/MM/<DD>/ → 'YYYY/MM'（archived_sessions 扁平目录无布局）。
function codexLayoutProject(sourcePath) {
  const m = slashPath(sourcePath).match(/\/sessions\/(\d{4})\/(\d{2})\//)
  return m ? m[1] + '/' + m[2] : null
}

// ~/.cursor/projects/<slug>/agent-transcripts/… → slug（真实工作区由 host.resolveCursorSlug 还原）。
function cursorLayoutProject(sourcePath) {
  const m = slashPath(sourcePath).match(/\/projects\/([^/]+)\/agent-transcripts\//i)
  return m ? m[1] : null
}

// 桌面版 <state root>/projects/<slug>/sessions/… → slug。
function reasonixLayoutProject(sourcePath) {
  const m = slashPath(sourcePath).match(/\/projects\/([^/]+)\//i)
  return m ? m[1] : null
}

// ~/.openclaw/agents/<agent>/sessions/… → agent。
function openclawLayoutProject(sourcePath) {
  const m = slashPath(sourcePath).match(/\/agents\/([^/]+)\/sessions\//)
  return m ? m[1] : null
}

// ── 来源描述符（注册与顺序见 ./registry.mjs；字段契约见该文件头）──────────────────

const isJsonl = (lower) => lower.endsWith('.jsonl')

export const codexSource = {
  format: 'codex',
  // sessions/YYYY/MM/DD/ 与扁平的 archived_sessions/ 双根
  roots: (home) => [join(home, '.codex', 'sessions'), join(home, '.codex', 'archived_sessions')],
  scan: scanCodex,
  layoutProject: codexLayoutProject,
  matchFile: (lower) => isJsonl(lower) && /(^|[\\/])rollout-/.test(lower),
  fileFallback: ['jsonl'],
}

export const cursorSource = {
  format: 'cursor',
  roots: (home) => join(home, '.cursor', 'projects'),
  scan: scanCursor,
  layoutProject: cursorLayoutProject,
  matchFile: (lower) => isJsonl(lower) && /\bagent-transcripts\b/.test(lower),
  fileFallback: ['jsonl'],
}

export const reasonixSource = {
  format: 'reasonix',
  // CLI 会话目录 + 桌面版状态根（Windows APPDATA；无此变量的平台只扫 CLI 根）
  roots: (home, env) => {
    const cli = join(home, '.reasonix', 'sessions')
    return env.APPDATA ? [cli, join(env.APPDATA, 'reasonix')] : cli
  },
  scan: scanReasonix,
  layoutProject: reasonixLayoutProject,
  matchFile: (lower) => isJsonl(lower) && /(^|[\\/])(desktop|subagent)-/.test(lower),
  fileFallback: ['jsonl'],
}

export const openclawSource = {
  format: 'openclaw',
  roots: (home) => join(home, '.openclaw', 'agents'),
  scan: scanOpenclaw,
  layoutProject: openclawLayoutProject,
  matchFile: (lower) => isJsonl(lower) && /\bagents\b.*\bsessions\b/.test(lower),
  fileFallback: ['jsonl'],
}

export const piSource = {
  format: 'pi',
  roots: (home) => join(home, '.pi', 'agent', 'sessions'),
  scan: scanPi,
  // 无路径特征时不进通用 JSONL 回退（会话头签名与 hermes/openclaw 的 session 头相近）
  matchFile: (lower) => isJsonl(lower) && /\.pi[\\/]agent[\\/]sessions[\\/]/.test(lower),
}
