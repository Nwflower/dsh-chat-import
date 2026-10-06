// lib/discovery/session-dirs.mjs — 「每会话一目录」族的发现：kimi（wire.jsonl + state.json）、
// grokbuild（summary.json + chat_history.jsonl）、vibe（messages.jsonl + meta.json）
//
// 会话单位是目录而不是文件：sourcePath = 会话目录，书签指纹取目录内主文件与伴生文件的复合
// stat（任一变化即重读）。

import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { stripUserQueryWrapper } from '../convert/inject.mjs'
import { normalizeTitle } from '../convert/util.mjs'
import { vibeUserDataDirs, listVibeSessions, readVibeSessionSummary } from '../sources/vibe.mjs'
import {
  compositeFingerprint, HEAD_MAX_BYTES, TAIL_MAX_BYTES, basenameOf, dirnameOf, slashPath, parseJsonlHead,
  contentText, firstUserTitle, parseTimeValue, firstNumber, projectFromRecord, makeEntry, emitEach,
} from './common.mjs'
import { WALK_SKIP_DIRS, WALK_MAX_DEPTH } from './walk.mjs'
import { probeSource } from './scan-cache.mjs'

// Kimi 尾部 → 最后一条 usage 记录的输入 token（inputOther + inputCacheRead；无则 null）。
function kimiContextTokens(tailText) {
  let last = null
  for (const line of String(tailText ?? '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    let r
    try { r = JSON.parse(t) } catch { continue }
    const u = r && r.usage && typeof r.usage === 'object' ? r.usage : null
    if (u && (typeof u.inputOther === 'number' || typeof u.inputCacheRead === 'number')) {
      last = (typeof u.inputOther === 'number' ? u.inputOther : 0)
        + (typeof u.inputCacheRead === 'number' ? u.inputCacheRead : 0)
    }
  }
  return last
}

// kimi：旧 ~/.kimi/sessions/<workdir-md5>/<session-id>/wire.jsonl 或新
// ~/.kimi-code/sessions/<workspace-id>/<session-id>/agents/main/wire.jsonl（会话目录
// = 含任一 wire.jsonl 的目录；subagents/ 子代理 wire 不发现）。标题 = state.json
// custom_title / isCustomTitle+title > 首个 user 文本；cwd 优先 state.json.cwd/workDir，旧
// 布局回退 ~/.kimi/kimi.json（md5 映射），新布局再回退 ~/.kimi-code/workspaces.json；
// createdAt = 首条记录 timestamp/time；标题只读文件头取（不做整读计数）。
async function walkKimiSessions(host, dir, out, depth = 0) {
  if (depth > WALK_MAX_DEPTH) return
  const entries = await host.readDir(dir)
  if (!entries) return
  for (const e of entries) {
    if (e.type !== 'directory') continue
    if (WALK_SKIP_DIRS.has(e.name)) continue
    const rootWire = join(e.path, 'wire.jsonl')
    const agentWire = join(e.path, 'agents', 'main', 'wire.jsonl')
    const st = await host.stat(rootWire)
    const finalSt = st && st.type === 'file' ? st : await host.stat(agentWire)
    if (finalSt && finalSt.type === 'file') out.push(e.path)
    else await walkKimiSessions(host, e.path, out, depth + 1)
  }
}

// kimi.json workdir 映射（自底向上找 ≤6 层）：目录名 = md5(path) 或 `<kaos>_<md5>`。
async function kimiWorkDir(host, sessionDir, hashDirName) {
  if (!hashDirName) return null
  let dir = dirnameOf(sessionDir)
  for (let i = 0; i < 6; i++) {
    const metaPath = join(dir, 'kimi.json')
    if (await host.stat(metaPath)) {
      try {
        const meta = JSON.parse(await host.readText(metaPath))
        for (const wd of (meta && Array.isArray(meta.work_dirs) ? meta.work_dirs : [])) {
          if (!wd || typeof wd.path !== 'string' || !wd.path) continue
          const hex = createHash('md5').update(wd.path, 'utf8').digest('hex')
          const kaos = typeof wd.kaos === 'string' && wd.kaos ? wd.kaos : 'local'
          if (hex === hashDirName || (kaos + '_' + hex) === hashDirName) return wd.path
        }
      } catch {
        // kimi.json 损坏：无 cwd 映射（发现阶段不致命）
      }
      return null
    }
    const next = dirnameOf(dir)
    if (next === dir) return null
    dir = next
  }
  return null
}

// Kimi Code 的新布局在 state.json 缺失时，用 ~/.kimi-code/workspaces.json
// 按 sessions/<workspace-id> 目录名回退工作区根目录。
async function kimiCodeWorkDir(host, sessionDir, workspaceId) {
  if (!workspaceId) return null
  const rawPath = String(sessionDir)
  const marker = rawPath.toLowerCase().indexOf('.kimi-code')
  const beforeMarker = rawPath[marker - 1]
  const afterMarker = rawPath[marker + '.kimi-code'.length]
  if (marker < 0 || (beforeMarker && !/[\\/]/.test(beforeMarker))
    || (afterMarker && !/[\\/]/.test(afterMarker))) return null
  const home = rawPath.slice(0, marker + '.kimi-code'.length)
  const metaPath = join(home, 'workspaces.json')
  const st = await host.stat(metaPath)
  if (!st || st.type !== 'file') return null
  try {
    const meta = JSON.parse(await host.readText(metaPath))
    const entry = meta && meta.workspaces && typeof meta.workspaces === 'object'
      ? meta.workspaces[workspaceId]
      : null
    const root = typeof entry === 'string' ? entry : entry && entry.root
    return typeof root === 'string' && root.trim() ? root : null
  } catch {
    // workspaces.json 损坏：发现阶段静默降级
    return null
  }
}

// 新旧 kimi wire 记录 → 首条 user 文本提取。
function kimiUserText(rec) {
  if (!rec || typeof rec !== 'object') return ''
  const m = rec.message
  if (m && typeof m === 'object' && (m.type === 'TurnBegin' || m.type === 'SteerInput')) {
    return contentText(m.payload && typeof m.payload === 'object' ? m.payload.user_input : '')
  }
  if (rec.type === 'turn.prompt') return contentText(rec.input)
  if (rec.type === 'context.append_message') {
    const message = rec.message && typeof rec.message === 'object' ? rec.message : {}
    return message.role === 'user' ? contentText(message.content) : ''
  }
  return ''
}

// 新旧 kimi wire 记录 → 首条时间戳（毫秒）。
function kimiRecordTime(rec) {
  if (!rec || typeof rec !== 'object') return undefined
  if (rec.timestamp !== undefined) return parseTimeValue(rec.timestamp)
  if (rec.time !== undefined) return parseTimeValue(rec.time)
  if (rec.created_at !== undefined) return parseTimeValue(rec.created_at)
  return undefined
}

async function scanKimi(host, target, { bm, emit }) {
  const dirs = []
  const selfWire = join(target, 'wire.jsonl')
  const selfStat = await host.stat(selfWire)
  const selfAgentWire = join(target, 'agents', 'main', 'wire.jsonl')
  const selfAgentStat = await host.stat(selfAgentWire)
  if ((selfStat && selfStat.type === 'file') || (selfAgentStat && selfAgentStat.type === 'file')) {
    dirs.push(String(target))
  } else {
    await walkKimiSessions(host, target, dirs)
  }
  const out = []
  for (const dir of dirs) {
    let wirePath = join(dir, 'wire.jsonl')
    let wst = await host.stat(wirePath)
    if (!wst || wst.type !== 'file') {
      wirePath = join(dir, 'agents', 'main', 'wire.jsonl')
      wst = await host.stat(wirePath)
    }
    if (!wst || wst.type !== 'file') continue
    const statePath = join(dir, 'state.json')
    const sst = await host.stat(statePath)
    // 标题 / cwd 可能来自伴生 state.json → fingerprint 含伴生文件（任一变化 → 重读）
    const fp = compositeFingerprint(wst, sst)
    const entries = await probeSource(bm, 'kimi', dir, fp, async () => {
      let customTitle = ''
      let stateCwd = ''
      if (sst) {
        try {
          const state = JSON.parse(await host.readText(statePath))
          if (state) {
            if (typeof state.custom_title === 'string' && state.custom_title.trim()) {
              customTitle = state.custom_title.trim()
            } else if (state.isCustomTitle === true && typeof state.title === 'string' && state.title.trim()) {
              customTitle = state.title.trim()
            }
            const rawCwd = [state.cwd, state.workDir].find((v) => typeof v === 'string' && v.trim())
            if (rawCwd) stateCwd = rawCwd
          }
        } catch {
          // state.json 损坏：标题回退 wire、cwd 回退 kimi.json 映射
        }
      }
      const head = await host.readHead(wirePath, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      if (!recs.some((r) => kimiUserText(r))) return []
      const title = customTitle || firstUserTitle(recs, kimiUserText)
      const createdAt = firstNumber(recs, kimiRecordTime)
      const hashDirName = basenameOf(dirnameOf(dir))
      const cwd = stateCwd
        || await kimiWorkDir(host, dir, hashDirName)
        || await kimiCodeWorkDir(host, dir, hashDirName)
      const contextTokens = wst.size <= HEAD_MAX_BYTES
        ? kimiContextTokens(head)
        : kimiContextTokens(await host.readTail(wirePath, TAIL_MAX_BYTES))
      return [makeEntry({
        format: 'kimi', sessionId: basenameOf(dir), title,
        project: projectFromRecord(cwd, () => hashDirName),
        createdAt, lastActiveAt: wst.mtimeMs, contextTokens, sourcePath: dir, cwd,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// grokbuild：~/.grok/sessions/<project>/<session_id>/（含 archived_sessions/），
// 会话目录 = 含 summary.json 的目录（不再下钻）；标题 generated_title >
// session_summary > 首条 user 文本；lastActiveAt = summary/chat_history mtime 取大。
// 复用 walkFiles 同款目录黑名单 + 限深。

// grokbuild 会话目录判据（目录含 summary.json）的唯一一份。三处消费者各用各的宿主面，
// 因此只把「怎么取 stat」交给调用方：statOf(path) 返回 stat 或 null/undefined。
//   discovery 走查：host.stat 直接吃路径
//   ctx.fs 面（import-variants 的目录批量、tools 的单目录判定）：statOf = fsStatOf(ctx)
export async function grokbuildIsSessionDir(statOf, dir) {
  const st = await statOf(join(String(dir), 'summary.json'))
  return !!(st && st.type === 'file')
}

/** ctx.fs 面的 statOf 适配：路径 → resolve → stat（差异只在这一处）。 */
export function fsStatOf(ctx) {
  return async (p) => ctx.fs.stat(await ctx.fs.resolve(p))
}

async function walkGrokbuildSessions(host, dir, out, depth = 0) {
  if (depth > WALK_MAX_DEPTH) return
  const entries = await host.readDir(dir)
  if (!entries) return
  for (const e of entries) {
    if (e.type !== 'directory') continue
    if (WALK_SKIP_DIRS.has(e.name)) continue
    if (await grokbuildIsSessionDir((p) => host.stat(p), e.path)) out.push(e.path)
    else await walkGrokbuildSessions(host, e.path, out, depth + 1)
  }
}

async function scanGrokbuild(host, target, { bm, emit }) {
  const dirs = []
  await walkGrokbuildSessions(host, target, dirs)
  const out = []
  for (const dir of dirs) {
    const sst = await host.stat(join(dir, 'summary.json'))
    if (!sst) continue
    const cst = await host.stat(join(dir, 'chat_history.jsonl'))
    // 会话目录 = 双文件复合指纹（任一文件变化 → 重读）
    const fp = compositeFingerprint(sst, cst)
    const entries = await probeSource(bm, 'grokbuild', dir, fp, async () => {
      const sumRaw = await host.readText(join(dir, 'summary.json'))
      if (sumRaw === null) return []
      let summary
      try { summary = JSON.parse(sumRaw) } catch { return [] }
      if (!summary || typeof summary !== 'object') return []
      const info = summary.info && typeof summary.info === 'object' ? summary.info : {}
      const sessionId = typeof info.id === 'string' && info.id ? info.id : basenameOf(dir)
      const explicit = typeof summary.generated_title === 'string' && summary.generated_title.trim()
        ? summary.generated_title
        : (typeof summary.session_summary === 'string' && summary.session_summary.trim() ? summary.session_summary : '')
      const chatRaw = await host.readHead(join(dir, 'chat_history.jsonl'), HEAD_MAX_BYTES)
      const recs = chatRaw ? parseJsonlHead(chatRaw) : []
      // 标题兜底：跳过 synthetic_reason 非空且 ≠'human' 的 user 行（压缩摘要 / system_reminder
      // 注入不是话题）；v0 行无 type 有 role；文本剥 <user_query> 信封后再判注入。
      const title = normalizeTitle(explicit) || firstUserTitle(recs, (r) => {
        if (!r || (r.type ?? r.role) !== 'user') return ''
        const reason = typeof r.synthetic_reason === 'string' && r.synthetic_reason ? r.synthetic_reason : null
        if (reason && reason !== 'human') return ''
        return stripUserQueryWrapper(contentText(r.content))
      })
      const createdAt = parseTimeValue(summary.created_at) ?? parseTimeValue(summary.updated_at) ?? parseTimeValue(summary.last_active_at)
      const mtimes = [cst && cst.mtimeMs, sst && sst.mtimeMs].filter((v) => typeof v === 'number')
      const cwd = typeof info.cwd === 'string' && info.cwd ? info.cwd : null
      return [makeEntry({
        format: 'grokbuild', sessionId, title,
        // 项目名优先取记录内 cwd 的 basename（真实路径），缺失时按目录布局解码回退
        project: projectFromRecord(cwd, () => grokbuildLayoutProject(dir)),
        cwd,
        createdAt, lastActiveAt: mtimes.length ? Math.max(...mtimes) : null, sourcePath: dir,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// vibe：~/.vibe/logs/session/<session_dir>/，会话目录含 messages.jsonl + meta.json。
async function scanVibe(host, target, { bm, emit }) {
  const sessionDirs = await listVibeSessions(host, target)
  const out = []
  for (const dir of sessionDirs) {
    const msgPath = join(dir, 'messages.jsonl')
    const mst = await host.stat(msgPath)
    if (!mst || mst.type !== 'file') continue
    const metaPath = join(dir, 'meta.json')
    const metast = await host.stat(metaPath)
    const fp = compositeFingerprint(mst, metast)
    const entries = await probeSource(bm, 'vibe', dir, fp, async () => {
      const summary = await readVibeSessionSummary(host, dir)
      return [makeEntry({
        format: 'vibe',
        sessionId: summary.id,
        title: normalizeTitle(summary.title),
        project: projectFromRecord(summary.directory, () => null),
        createdAt: summary.createdAt,
        sourcePath: dir,
        cwd: summary.directory || null,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// 项目名布局：~/.grok/(archived_)sessions/<编码 cwd>/<session_id> → cwd 末段。
// 会话目录名 = cwd 整路径的 encodeURIComponent（同步层 encodeGrokCwd 同款），原样展示会以
// %XX 乱码出现在面板工作区列；解码后取末段作项目名。
function grokbuildLayoutProject(sourcePath) {
  const m = slashPath(sourcePath).match(/\/(?:sessions|archived_sessions)\/([^/]+)\/[^/]+$/)
  if (!m) return null
  try {
    return basenameOf(decodeURIComponent(m[1])) || m[1]
  } catch {
    // 畸形 %XX 序列（非法 UTF-8 等）原样回退，不臆测
    return m[1]
  }
}

// ── 来源描述符（注册与顺序见 ./registry.mjs；字段契约见该文件头）──────────────────

export const kimiSource = {
  format: 'kimi',
  roots: (home) => [join(home, '.kimi', 'sessions'), join(home, '.kimi-code', 'sessions')],
  scan: scanKimi,
  matchFile: (lower) => lower.endsWith('.jsonl') && /(\.kimi|\.kimi-code)[\\/]sessions[\\/]/.test(lower),
}

export const grokbuildSource = {
  format: 'grokbuild',
  // sessions + archived_sessions 双根；GROK_HOME 非空时替代 ~/.grok
  roots: (home, env) => {
    const grokHome = env.GROK_HOME || join(home, '.grok')
    return [join(grokHome, 'sessions'), join(grokHome, 'archived_sessions')]
  },
  scan: scanGrokbuild,
  layoutProject: grokbuildLayoutProject,
}

export const vibeSource = {
  format: 'vibe',
  roots: (home) => vibeUserDataDirs(home),
  scan: scanVibe,
  matchFile: (lower) => lower.endsWith('.jsonl') && /(\.vibe[\\/]logs[\\/]session|messages\.jsonl$)/.test(lower),
}
