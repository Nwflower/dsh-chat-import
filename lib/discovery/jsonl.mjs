// lib/discovery/jsonl.mjs — 逐行 JSONL 转录族的发现：codex、cursor、reasonix、openclaw、pi、omp
//
// 各来源的转录都是「一个会话 = 一个（或一条链的）.jsonl」，只读文件头抽元数据；
// 结构签名（session_meta / agent-transcripts 布局 / session 头 version 字段…）不符即自拒。

import { join } from 'node:path'
import { normalizeTitle } from '../convert/util.mjs'
import { reasonixStemTime } from '../convert/reasonix.mjs'
import { codexSubagentMarker, codexUserPrompt } from '../convert/codex.mjs'
import { openclawDisplayNames } from '../convert/openclaw.mjs'
import { parseCursorEmbeddedTimestamp, stripCursorTitleDecorations, isCursorNonRepoSlug } from '../cwd-map.mjs'
import { groupCodexThreads, sortCodexPages } from '../sources/codex.mjs'
import {
  HEAD_MAX_BYTES, TAIL_MAX_BYTES, fileFingerprint, compositeFingerprint, basenameOf, dirnameOf, slashPath, siblingPath,
  parseJsonlHead, contentText, firstUserRawText, firstUserTitle, parseTimeValue, firstNumber,
  projectFromRecord, makeEntry, emitEach,
} from './common.mjs'
import { walkFiles } from './walk.mjs'
import { probeSource } from './scan-cache.mjs'

// codex：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl 与扁平的 ~/.codex/archived_sessions/
// rollout-*.jsonl（首记录 session_meta 为格式签名；walkFiles 递归，扁平目录同样适用）。
// Codex CLI 会把一个会话拆成多个分页 rollout：同 thread 的分页共享文件名前缀（首个 UUID =
// thread id），后续页带 `_<pageId>` 后缀。按 thread 分组（groupCodexThreads，与导入侧同一
// 口径），一条链只出一个条目：sourcePath = 链的首页（导入幂等键，追加新页不变）、标题优先取
// session_index.jsonl 的 thread_name，缺失才回退首问（首页没有则取最新页）；createdAt 取最早可得的页、lastActiveAt 优先取日志时间。
// 文件名不含 thread id 的 rollout 各自成链，sessionId 取 session_meta.payload.id。
// 子代理 rollout（thread_source='subagent' / source.subagent）按文件级跳过。
// 书签粒度 = 单页：每页只存拼链所需的摘要（payload.id / cwd / 创建时间 / 首问标题），链条目
// 由页摘要在内存里拼出——任一页变化只重读该页。
async function scanCodex(host, target, { bm, emit }) {
  const files = []
  await walkFiles(host, target, files, (name) => /\.jsonl$/i.test(name))
  const pageOf = new Map() // path → { st, summary }
  const accepted = []
  for (const file of files) {
    const st = await host.stat(file.path)
    if (!st) continue
    const summaries = await probeSource(bm, 'codex', file.path, fileFingerprint(st), async () => {
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      const meta = recs.find((r) => r && r.type === 'session_meta' && r.payload && typeof r.payload === 'object')
      if (!meta) return []
      const payload = meta.payload
      // 子代理 rollout 不是独立会话（对齐 claude/qoder 的「辅助 transcript 跳过」），判定与导入侧同一份
      if (codexSubagentMarker(payload)) return []
      const tail = typeof host.readTail === 'function' ? await host.readTail(file.path, TAIL_MAX_BYTES) : null
      // shortcut: 有界头尾窗口可能遗漏超长末行的时间，需要精确全量统计时再扩展读取。
      const times = [...recs, ...parseJsonlHead(tail)].map((r) => parseTimeValue(r?.timestamp)).filter(Number.isFinite)
      const createdAt = parseTimeValue(meta.timestamp) ?? parseTimeValue(payload.timestamp) ?? null
      return [{
        id: typeof payload.id === 'string' && payload.id ? payload.id : null,
        cwd: typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : null,
        createdAt,
        lastActiveAt: times.length ? Math.max(...times) : createdAt,
        title: firstUserTitle(recs, codexUserText),
      }]
    })
    if (summaries.length === 0) continue
    pageOf.set(file.path, { st, summary: summaries[0] })
    accepted.push(file)
  }
  const out = []
  const titleIndexes = new Map()
  for (const [threadKey, grouped] of groupCodexThreads(accepted)) {
    // 页序：文件名内嵌时间戳单调递增；同名时间戳按 mtime、再按文件名
    const pages = sortCodexPages(grouped, (p) => pageOf.get(p.path).st.mtimeMs ?? null)
    const summaries = pages.map((p) => pageOf.get(p.path).summary)
    const root = summaries[0]
    const sessionId = threadKey.startsWith('file:') ? root.id : threadKey
    if (!sessionId) continue
    const mtimeMax = Math.max(0, ...pages.map((p) => pageOf.get(p.path).st.mtimeMs ?? 0))
    const activityTimes = summaries.map((s) => s.lastActiveAt).filter(Number.isFinite)
    const home = pages[0].path.match(/^(.*[\/\\])(?:sessions|archived_sessions)[\/\\]/)
    const indexPath = home ? home[1] + 'session_index.jsonl' : siblingPath(target, 'session_index.jsonl')
    if (!titleIndexes.has(indexPath)) titleIndexes.set(indexPath, await readCodexTitleIndex(host, indexPath))
    const titles = titleIndexes.get(indexPath)
    const indexedTitle = titles.get(sessionId)
    const entries = [makeEntry({
      format: 'codex', sessionId,
      title: indexedTitle || root.title || summaries[summaries.length - 1].title,
      project: projectFromRecord(root.cwd, () => codexLayoutProject(pages[0].path)),
      createdAt: summaries.map((x) => x.createdAt).find((v) => v !== null && v !== undefined),
      lastActiveAt: activityTimes.length ? Math.max(...activityTimes) : mtimeMax || undefined,
      sourcePath: pages[0].path, cwd: root.cwd,
    })]
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// 标题索引独立于 rollout 更新；不放进页书签，每次实际扫描重新读取一次。
async function readCodexTitleIndex(host, path) {
  const titles = new Map()
  const stat = await host.stat(path)
  if (!stat || stat.type !== 'file') return titles
  // 旧的自定义 discovery host 只有 readText，保留兼容；正式宿主提供流式 readLines。
  const lines = typeof host.readLines === 'function' ? host.readLines(path) : (await host.readText(path) || '').split(/\r?\n/)
  for await (const line of lines) {
    const row = parseJsonlHead(line)[0]
    if (typeof row?.id !== 'string' || typeof row?.thread_name !== 'string') continue
    const title = row.thread_name.trim()
    if (title) titles.set(row.id, title)
  }
  return titles
}

// codex 的 user 文本抽取直接复用转换层的 codexUserPrompt（注入 / 页面上下文信封 / 块类型的
// 口径只有那一份，见 AGENTS.md「标题 / 正文抽取用共用件」）：首问兜底因此与导入的开轮文本
// 逐字同源，不再靠发现层自己拼一遍。payload.content 为字符串（旧形态）时按单块喂进去。
function codexUserText(r) {
  if (!r || r.type !== 'response_item' || !r.payload || r.payload.type !== 'message' || r.payload.role !== 'user') return ''
  const content = r.payload.content
  return codexUserPrompt(Array.isArray(content) ? content : [{ type: 'input_text', text: contentText(content) }])
}

// cursor：~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl
//（布局签名：路径含 agent-transcripts 且 fileStem == 父目录名）。
// project/cwd：composer 登记册优先，缺登记才经 host.resolveCursorSlug 解码旧目录名。
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
    const fp = fileFingerprint(st)
    const entries = await probeSource(bm, 'cursor', file.path, fp, async () => {
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      const extractUser = (r) => (r && r.role === 'user' ? String(contentText(r.message && r.message.content)).replace(/<\/?user_query>/g, '') : '')
      const rawFirst = firstUserRawText(recs, extractUser)
      const tsFromTitle = rawFirst ? parseCursorEmbeddedTimestamp(rawFirst) : undefined
      const title = rawFirst ? normalizeTitle(stripCursorTitleDecorations(rawFirst)) : null
      const slug = cursorLayoutProject(file.path)
      const cwd = (host.cursorComposerWorkspace && await host.cursorComposerWorkspace(stem))
        || (host.resolveCursorSlug && slug ? await host.resolveCursorSlug(slug) : null)
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
// 仍查询 composer 登记册（缺登记回退 slug），并从 title 补 createdAt（不重读 jsonl）。
async function patchCursorCacheEntries(host, entries, sourcePath, fp) {
  if (!Array.isArray(entries) || entries.length === 0) return { entries, changed: false }
  const slug = cursorLayoutProject(sourcePath)
  const composerId = basenameOf(sourcePath).replace(/\.jsonl$/i, '')
  const registeredCwd = host.cursorComposerWorkspace ? await host.cursorComposerWorkspace(composerId) : null
  let changed = false
  const out = []
  for (const entry of entries) {
    if (!entry || entry.format !== 'cursor') {
      out.push(entry)
      continue
    }
    const next = { ...entry }
    const rawTitle = typeof entry.title === 'string' ? entry.title : ''

    if (registeredCwd) {
      const project = projectFromRecord(registeredCwd, () => null)
      if (next.cwd !== registeredCwd) { next.cwd = registeredCwd; changed = true }
      if (next.project !== project) { next.project = project; changed = true }
    } else if (isCursorNonRepoSlug(slug)) {
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
    const fp = fileFingerprint(st)
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
    const fp = compositeFingerprint(st, ist)
    const entries = await probeSource(bm, 'openclaw', file.path, fp, async () => {
      let names = nameCache.get(indexPath)
      if (names === undefined) {
        names = openclawDisplayNames(await host.readText(indexPath))
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
async function scanPi(host, target, { bm, emit }) {
  const files = []
  await walkFiles(host, target, files, (name) => /\.jsonl$/i.test(name))
  const out = []
  for (const file of files) {
    const st = await host.stat(file.path)
    if (!st) continue
    const entries = await probeSource(bm, 'pi', file.path, fileFingerprint(st), async () => {
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      const header = recs.find((r) => r && r.type === 'session' && typeof r.version === 'number')
      if (!header) return []
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
      return [makeEntry({
        format: 'pi', sessionId, title,
        project: projectFromRecord(cwd, () => null),
        createdAt: parseTimeValue(header.timestamp), lastActiveAt: st.mtimeMs, sourcePath: file.path, cwd,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// omp（oh-my-pi）：~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl
// （与 pi 同族：session 头 + id/parentId 树）。格式签名 = 会话头 type:"session" 且带 version
// 或 id（v1 头没有 version）；首行的定宽标题槽（type:"title"）是当前标题的来源，旧文件没有。
// 标题：标题槽 > header.title > 头窗口里最后的 title_change，缺省回退首条真实 user 文本。
async function scanOmp(host, target, { bm, emit }) {
  const files = []
  await walkFiles(host, target, files, (name) => /\.jsonl$/i.test(name))
  const out = []
  for (const file of files) {
    const st = await host.stat(file.path)
    if (!st) continue
    const entries = await probeSource(bm, 'omp', file.path, fileFingerprint(st), async () => {
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      const header = recs.find((r) => r && r.type === 'session'
        && (typeof r.version === 'number' || typeof r.id === 'string'))
      if (!header) return []
      const base = basenameOf(file.name).replace(/\.jsonl$/i, '')
      // 文件名 <timestamp>_<sessionId>.jsonl：会话 id 在第一个下划线之后（缺头 id 时兜底）
      const stemId = base.includes('_') ? base.slice(base.indexOf('_') + 1) : base
      const sessionId = typeof header.id === 'string' && header.id ? header.id : stemId
      let name = ''
      const slot = recs.find((r) => r && r.type === 'title' && typeof r.title === 'string' && r.title.trim())
      if (slot) name = slot.title.trim()
      else if (typeof header.title === 'string' && header.title.trim()) name = header.title.trim()
      else {
        for (let i = recs.length - 1; i >= 0; i--) {
          const r = recs[i]
          if (r && r.type === 'title_change' && typeof r.title === 'string' && r.title.trim()) {
            name = r.title.trim()
            break
          }
        }
      }
      const title = normalizeTitle(name) || firstUserTitle(recs, (r) => (r && r.type === 'message' && r.message && r.message.role === 'user' ? contentText(r.message.content) : ''))
      const cwd = typeof header.cwd === 'string' ? header.cwd : undefined
      return [makeEntry({
        format: 'omp', sessionId, title,
        project: projectFromRecord(cwd, () => null),
        createdAt: parseTimeValue(header.timestamp), lastActiveAt: st.mtimeMs, sourcePath: file.path, cwd,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
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

export const ompSource = {
  format: 'omp',
  roots: (home) => join(home, '.omp', 'agent', 'sessions'),
  scan: scanOmp,
  // 同上：头签名与 pi/hermes/openclaw 相近，只认路径特征（.omp/agent/sessions/）
  matchFile: (lower) => isJsonl(lower) && /\.omp[\\/]agent[\\/]sessions[\\/]/.test(lower),
}
