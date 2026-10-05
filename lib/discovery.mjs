// lib/discovery.mjs — 会话发现：统一扫描全部来源格式，返回结构化索引
//
// 只读发现层：通过注入的 host 接口访问文件/DB/SQLite，不 import node:sqlite 或 DSH 服务。
// 提供 30s 进程缓存与 scan-cache.json 持久化书签；支持 path/format/query 过滤，以及
// 标题、项目名、消息数提取。

import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { readFile as fread } from 'node:fs/promises'
import { isDshSessionFile, dshSessionLogVersion, decodeZstdText } from './sources/dsh.mjs'
import { readContinueIndex } from './convert/continue.mjs'
import { gooseSessionsDir } from './convert/goose.mjs'
import { zedThreadsDir } from './convert/zed.mjs'
import { crushUserDataDir } from './convert/crush.mjs'
import { vibeUserDataDirs, listVibeSessions, readVibeSessionSummary } from './sources/vibe.mjs'
// 注入识别与信封剥离的唯一真相源（D3 纯函数层；本文件此前的 INJECT_MARKERS /
// stripPastedWrapper 副本已在 2026-09 收敛到该模块）
import { stripUserQueryWrapper } from './convert/inject.mjs'
import { normalizeTitle } from './convert/util.mjs'
import {
  HEAD_MAX_BYTES, TAIL_MAX_BYTES, basenameOf, dirnameOf, parseJsonlHead, contentText, firstUserTitle, parseTimeValue, firstNumber, projectFromRecord, makeEntry, emitEach,
} from './discovery/common.mjs'
import { WALK_SKIP_DIRS, WALK_MAX_DEPTH, walkFiles } from './discovery/walk.mjs'
import { scanCache, inflightScans, createBookmarkStore, probeSource } from './discovery/scan-cache.mjs'
import { gitStatusOf } from './discovery/git-status.mjs'
import { resolveImportStatus } from './discovery/import-status.mjs'
import {
  scanClaude, scanQoder, scanWorkbuddy, scanQwen, claudeLayoutProject, qoderLayoutProject, workbuddyLayoutProject,
} from './discovery/claude.mjs'
import {
  scanCodex, scanCursor, scanReasonix, scanOpenclaw, scanPi, codexLayoutProject, cursorLayoutProject, reasonixLayoutProject, openclawLayoutProject,
} from './discovery/jsonl.mjs'
import { scanGemini, scanAntigravity, geminiLayoutProject, antigravityLayoutProject } from './discovery/gemini.mjs'
import {
  traeUserDataDirs, scanOpencode, scanMimocode, scanKilocode, scanZcode, scanTeleagent, scanTrae, scanGoose, scanZed, scanCrush, scanHermes,
} from './discovery/sqlite.mjs'
import { clineSessionsDir, clineLegacyStorageDirs, scanCline } from './discovery/cline.mjs'

export const FORMATS = [
  'claude', 'codex', 'cursor', 'gemini', 'antigravity', 'reasonix', 'opencode', 'mimocode',
  'zcode', 'grokbuild', 'openclaw', 'pi', 'hermes', 'kimi', 'kilocode', 'qoder', 'chatgpt', 'workbuddy', 'qwen', 'continue', 'cline', 'goose',
  // dsh 按日志代次拆两项：dsh = V3（含 v0–v3），dsh4 = V4。同一份会话目录、同一个扫描器，
  // 用请求的 format 过滤——面板来源列表要能分别只看 V3 / V4。
  'dsh4', 'zed', 'crush', 'teleagent', 'trae', 'vibe', 'dsh',
]

// 标题口径与转换层同源（lib/convert/util.mjs），这里只为既有调用方转出
export { TITLE_MAX_LEN, TITLE_ELLIPSIS, normalizeTitle } from './convert/util.mjs'
export { HEAD_MAX_BYTES, isInjectedTitle } from './discovery/common.mjs'
export {
  SCAN_TTL_MS, createScanCache, clearScanCache, clearInflightScans, SCAN_CACHE_FILE, SCAN_CACHE_VERSION,
} from './discovery/scan-cache.mjs'
export { resolveImportStatus } from './discovery/import-status.mjs'
export { traeUserDataDirs } from './discovery/sqlite.mjs'
export { clineLegacyStorageDirs } from './discovery/cline.mjs'

export function defaultRoots({ home = homedir() } = {}) {
  const dshSessions = join(process.env.DSH_HOME || join(home, '.dsh'), 'sessions')
  // 桌面端/新端根（Windows APPDATA/LOCALAPPDATA；Linux 无此环境变量 → null 跳过）
  const appData = process.env.APPDATA || null
  const localAppData = process.env.LOCALAPPDATA || null
  const reasonixDesktop = appData ? join(appData, 'reasonix') : null
  const claude3p = localAppData ? join(localAppData, 'Claude-3p', 'claude-code-sessions') : null
  // grokbuild 双根：sessions + archived_sessions（cc-switch session_roots 同款）；
  // GROK_HOME 非空时替代 ~/.grok（用户把 Grok 数据目录挪走时默认根仍能命中）
  const grokHome = process.env.GROK_HOME || join(home, '.grok')
  return {
    claude: claude3p
      ? [join(home, '.claude', 'projects'), claude3p]
      : join(home, '.claude', 'projects'),
    // codex 双根：sessions/YYYY/MM/DD/ 与扁平的 archived_sessions/（与 grokbuild 同构；
    // 归档目录此前未纳入默认根，其下的 rollout 完全扫不到）
    codex: [join(home, '.codex', 'sessions'), join(home, '.codex', 'archived_sessions')],
    cursor: join(home, '.cursor', 'projects'),
    gemini: join(home, '.gemini', 'history'),
    // antigravity：Antigravity 与 Gemini CLI 共用 ~/.gemini 前缀但存储根不同（与
    // gemini 并列）。根随产品版本分化：Antigravity 2.0 / 部分 IDE 用 antigravity、
    // 旧 CLI 用 antigravity-cli、另一些 IDE 发行用 antigravity-ide（Google 官方
    // hooks 文档实测），三根并列扫——缺失的根由 walkFiles 静默落空，不产生噪音。
    antigravity: [
      join(home, '.gemini', 'antigravity'),
      join(home, '.gemini', 'antigravity-cli'),
      join(home, '.gemini', 'antigravity-ide'),
    ],
    reasonix: reasonixDesktop
      ? [join(home, '.reasonix', 'sessions'), reasonixDesktop]
      : join(home, '.reasonix', 'sessions'),
    opencode: join(home, '.local', 'share', 'opencode', 'opencode.db'),
    mimocode: join(home, '.local', 'share', 'mimocode', 'mimocode.db'),
    // teleagent：XDG 风格多账户目录（Windows 上同样在 ~/.local/share，issue #60 实测），
    // 根给到 users/ 层，扫描器枚举账户目录取各库（<账户>/teleagent.db）
    teleagent: join(home, '.local', 'share', 'TeleAgent', 'users'),
    kilocode: join(home, '.local', 'share', 'kilo', 'kilo.db'),
    zcode: join(home, '.zcode', 'cli', 'db', 'db.sqlite'),
    grokbuild: [join(grokHome, 'sessions'), join(grokHome, 'archived_sessions')],
    openclaw: join(home, '.openclaw', 'agents'),
    pi: join(home, '.pi', 'agent', 'sessions'),
    hermes: join(home, '.hermes'),
    kimi: [join(home, '.kimi', 'sessions'), join(home, '.kimi-code', 'sessions')],
    qoder: join(home, '.qoder', 'projects'),
    workbuddy: join(home, '.workbuddy', 'projects'),
    qwen: join(home, '.qwenworkcn', 'projects'),
    trae: traeUserDataDirs(home),
    vibe: vibeUserDataDirs(home),
    // continue：全局单一会话目录（VS Code / JetBrains / CLI 三端共用同一份）；
    // Continue core 自身的解析顺序是 $CONTINUE_GLOBAL_DIR 优先、否则 ~/.continue，
    // 故这里同样跟环境变量走——用户把它指到别处时默认根仍能命中。
    continue: process.env.CONTINUE_GLOBAL_DIR
      ? join(process.env.CONTINUE_GLOBAL_DIR, 'sessions')
      : join(home, '.continue', 'sessions'),
    // cline：文件式存储的会话目录 <dataDir>/sessions（每会话一目录）。路径优先级与上游
    // 一致：sessionsDir = $CLINE_SESSION_DATA_DIR → <dataDir>/sessions；dataDir =
    // $CLINE_DATA_DIR → <clineDir>/data；clineDir = $CLINE_DIR → ~/.cline。
    // Cline modern SDK sessions plus the pre-SDK VS Code globalStorage tasks.
    // Both roots are scanned; they have disjoint file layouts and are
    // therefore safe to expose together.
    cline: [clineSessionsDir(home), ...clineLegacyStorageDirs(home)],
    // goose：库在 <dataDir>/sessions/sessions.db（路径规则见 lib/convert/goose.mjs，
    // 与导入层共用同一份；GOOSE_PATH_ROOT 绝对路径优先、否则按平台）
    goose: gooseSessionsDir(home),
    // zed：线程库在 <data_dir>/threads/threads.db（路径规则见 lib/convert/zed.mjs；
    // --user-data-dir 会整体改写 data_dir，那种安装需显式传 path）
    zed: zedThreadsDir(home),
    // crush：库在**项目里**（<项目>/.crush/crush.db），用户级目录只有 JSON 状态 →
    // 默认根取用户级目录，扫描器再用其 projects.json 与宿主工作区列表逐个探测项目库
    crush: crushUserDataDir(home),
    chatgpt: null,
    // dsh：DSH 自身会话随宿主 DSH_HOME 走——桌面端 harness 域
    //（%APPDATA%\dsh-desktop\harness）≠ ~/.dsh，env 优先与 registryDir
    //（$DSH_HOME/dsh-chat-import，index.mjs 同源）保持一个存储域；env 缺省
    // 回退 ~/.dsh（CLI 直跑，DSH_HOME 未设）。dsh4 是同一目录的 V4 代次桶（scanDsh 按
    // 请求格式过滤代次），必须同样登记根——否则默认扫描永远看不到 V4 日志。
    dsh: dshSessions,
    dsh4: dshSessions,
  }
}

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

// ── 项目名布局正则（按源目录布局提取）───────────────────────────
export function layoutProject(sourcePath, format) {
  const p = String(sourcePath ?? '').replace(/\\/g, '/')
  switch (format) {
    case 'claude': return claudeLayoutProject(sourcePath)
    case 'cursor': return cursorLayoutProject(sourcePath)
    case 'reasonix': return reasonixLayoutProject(sourcePath)
    case 'grokbuild': {
      const m = p.match(/\/(?:sessions|archived_sessions)\/([^/]+)\/[^/]+$/)
      if (!m) return null
      // Grok Build 会话目录名 = cwd 整路径的 encodeURIComponent（同步层 encodeGrokCwd
      // 同款），原样展示会以 %XX 乱码出现在面板工作区列；解码后取末段作项目名。
      try {
        return basenameOf(decodeURIComponent(m[1])) || m[1]
      } catch {
        // 畸形 %XX 序列（非法 UTF-8 等）原样回退，不臆测
        return m[1]
      }
    }
    case 'openclaw': return openclawLayoutProject(sourcePath)
    case 'codex': return codexLayoutProject(sourcePath)
    case 'gemini': return geminiLayoutProject(sourcePath)
    case 'antigravity': return antigravityLayoutProject(sourcePath)
    case 'dsh': {
      // $DSH_HOME/sessions/<encoded-workspace>/<session-id>/session[.vN].jsonl[.zstd]
      const m = p.match(/\/sessions\/([^/]+)\/[^/]+\/([^/]+)$/i)
      if (!m || !isDshSessionFile(m[2])) return null
      return decodeDshProjectKey(m[1])
    }
    case 'qoder': return qoderLayoutProject(sourcePath)
    case 'workbuddy': return workbuddyLayoutProject(sourcePath)
    default:
      return null
  }
}

// ── 各格式扫描器（自拒：结构不匹配返回 []）──────────────────────────────

// dsh 项目目录名的 ~XXXX 是宿主 projectKey() 的 code-unit 转义（四位大写十六进制）。
// 此前按 decodeURIComponent('%XXXX') 解，得到控制字符加字面量余数：
// '--…-DSH~0020Repo--' 会解成 U+0000 + '20Repo'，而不是 'DSH Repo'。
// 还原本身有损——分隔符已折叠成 '-'，无法区分它与字面量连字符；这里只如实还原
// ~XXXX 转义，不臆测路径结构。
function decodeDshProjectKey(encoded) {
  return String(encoded).replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

// vibe：~/.vibe/logs/session/<session_dir>/，会话目录含 messages.jsonl + meta.json。
async function scanVibe(host, target, bm, emit) {
  const sessionDirs = await listVibeSessions(host, target)
  const out = []
  for (const dir of sessionDirs) {
    const msgPath = join(dir, 'messages.jsonl')
    const mst = await host.stat(msgPath)
    if (!mst || mst.type !== 'file') continue
    const metaPath = join(dir, 'meta.json')
    const metast = await host.stat(metaPath)
    const fp = {
      mtimeMs: mst.mtimeMs + '|' + (metast ? metast.mtimeMs : ''),
      sizeBytes: mst.size + (metast ? metast.size : 0),
    }
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

// grokbuild：~/.grok/sessions/<project>/<session_id>/（含 archived_sessions/），
// 会话目录 = 含 summary.json 的目录（不再下钻）；标题 generated_title >
// session_summary > 首条 user 文本；lastActiveAt = summary/chat_history mtime 取大。
// 复用 walkFiles 同款目录黑名单 + 限深（issue #16）。
async function walkGrokbuildSessions(host, dir, out, depth = 0) {
  if (depth > WALK_MAX_DEPTH) return
  const entries = await host.readDir(dir)
  if (!entries) return
  for (const e of entries) {
    if (e.type !== 'directory') continue
    if (WALK_SKIP_DIRS.has(e.name)) continue
    const sumPath = join(e.path, 'summary.json')
    const st = await host.stat(sumPath)
    if (st && st.type === 'file') out.push(e.path)
    else await walkGrokbuildSessions(host, e.path, out, depth + 1)
  }
}
async function scanGrokbuild(host, target, bm, emit) {
  const dirs = []
  await walkGrokbuildSessions(host, target, dirs)
  const out = []
  for (const dir of dirs) {
    const sst = await host.stat(join(dir, 'summary.json'))
    if (!sst) continue
    const cst = await host.stat(join(dir, 'chat_history.jsonl'))
    // 会话目录 = 双文件复合指纹（任一文件变化 → 重读；mtimeMs 为复合串）
    const fp = {
      mtimeMs: sst.mtimeMs + '|' + (cst ? cst.mtimeMs : ''),
      sizeBytes: sst.size + (cst ? cst.size : 0),
    }
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
        project: projectFromRecord(cwd, () => layoutProject(dir, 'grokbuild')),
        cwd,
        createdAt, lastActiveAt: mtimes.length ? Math.max(...mtimes) : null, sourcePath: dir,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
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

async function scanKimi(host, target, bm, emit) {
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
    const fp = {
      mtimeMs: wst.mtimeMs + '|' + (sst ? sst.mtimeMs : ''),
      sizeBytes: wst.size + (sst ? sst.size : 0),
    }
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

// chatgpt：无自动根；path 显式指向 conversations.json（或含它的目录）时解析
//（顶层 JSON 数组，每会话 { id, title, create_time, mapping }）。整文件多会话 →
// 书签按文件存全部 entries。
async function scanChatgpt(host, target, bm, emit) {
  const st = await host.stat(target)
  if (!st) return []
  let file = target
  if (st.type === 'directory') {
    const candidate = join(target, 'conversations.json')
    const cst = await host.stat(candidate)
    if (!cst || cst.type !== 'file') return []
    file = candidate
  } else if (!/\.json$/i.test(target)) {
    return []
  }
  const fst = await host.stat(file)
  if (!fst) return []
  const fp = { mtimeMs: fst.mtimeMs, sizeBytes: fst.size }
  const entries = await probeSource(bm, 'chatgpt', file, fp, async () => {
    const raw = await host.readText(file)
    if (raw === null || raw === '') return []
    let list
    try { list = JSON.parse(raw) } catch { return [] }
    if (!Array.isArray(list)) return []
    const out = []
    for (const conv of list) {
      if (!conv || typeof conv !== 'object' || typeof conv.id !== 'string') continue
      const mapping = conv.mapping && typeof conv.mapping === 'object' ? conv.mapping : {}
      let lastTs
      for (const node of Object.values(mapping)) {
        if (!node || typeof node !== 'object' || !node.message || typeof node.message !== 'object') continue
        const t = parseTimeValue(node.message.create_time)
        if (t !== undefined && (lastTs === undefined || t > lastTs)) lastTs = t
      }
      out.push(makeEntry({
        format: 'chatgpt', sessionId: conv.id,
        title: typeof conv.title === 'string' && conv.title.trim() ? normalizeTitle(conv.title) : null,
        project: null,
        createdAt: parseTimeValue(conv.create_time), lastActiveAt: lastTs, sourcePath: file,
      }))
    }
    return out
  })
  await emitEach(emit, entries)
  return entries
}

// dsh：$DSH_HOME/sessions/<encoded-workspace>/<session-id>/session.jsonl(.zstd)。
// .zstd 用 fzstd 纯 JS 解压后取头；session 首行提供 id/cwd/createdAt，session/title
// 事件优先作标题，否则回退首条真实 user 文本。
// .zstd 取头需全帧解压（纯 JS 实测 ~2s/MB 压缩明文）——超过阈值的跳过解压，按
// DSH 布局目录名（<session-id>）兜底构造条目：列表可见、可导入（导入路径
// readDshText 全量解压、title 以导入结果为准），首次扫描不再分钟级；
// 之后条目随 mtime/size 书签跳过。
const DSH_ZSTD_SCAN_MAX_BYTES = 256 * 1024

async function scanDsh(host, target, bm, emit, onlyFormat) {
  const files = []
  await walkFiles(host, target, files, (name) => isDshSessionFile(name))
  const out = []
  for (const file of files) {
    // 导入产物目录（import-<id>）**也列出**：DSH 来源的用途之一就是把一条已导入的会话
    // 迁移到另一代次（V3 ↔ V4），此前把它们跳过等于这条路径不存在。重导它们不会覆盖原会话
    // ——新会话 id 是 import-<源 id>（即 import-import-…），且幂等判定 / Toast「忽略警告」
    // 照常兜底。
    const parts = file.path.split(/[\\/]/)
    const dirName = parts[parts.length - 2]
    // 日志代次决定来源：v0–v3 归 dsh（V3），v4+ 归 dsh4（V4）。请求了单一格式时按它过滤。
    const fmt = (dshSessionLogVersion(file.name) ?? 0) >= 4 ? 'dsh4' : 'dsh'
    if (onlyFormat !== undefined && fmt !== onlyFormat) continue
    const st = await host.stat(file.path)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    // 大 .zstd 快路径：不解压取头（明文头在压缩帧里拿不到），目录名兜底 sessionId
    if (/\.zstd$/i.test(file.path) && st.size > DSH_ZSTD_SCAN_MAX_BYTES) {
      const entries = [makeEntry({
        format: fmt, sessionId: dirName, title: '',
        project: layoutProject(file.path, fmt),
        createdAt: st.mtimeMs, lastActiveAt: st.mtimeMs,
        sourcePath: file.path,
      })]
      out.push(...entries)
      await emitEach(emit, entries)
      continue
    }
    const entries = await probeSource(bm, fmt, file.path, fp, async () => {
      let text
      if (/\.zstd$/i.test(file.path)) {
        try {
          text = await decodeZstdText(await fread(file.path))
        } catch {
          return []
        }
      } else {
        text = await host.readText(file.path)
      }
      const recs = parseJsonlHead(text)
      const sessionRec = recs.find((r) => r && r.type === 'session' && typeof r.id === 'string' && r.id)
      if (!sessionRec) return []
      const titleRec = [...recs].reverse().find((r) => r && r.type === 'session/title' && r.data && typeof r.data.title === 'string')
      const title = titleRec
        ? normalizeTitle(titleRec.data.title)
        : firstUserTitle(recs, (r) => (r && r.type === 'user/message' && r.data && Array.isArray(r.data.content) ? contentText(r.data.content) : ''))
      return [makeEntry({
        format: fmt, sessionId: sessionRec.id, title,
        project: projectFromRecord(sessionRec.cwd, () => layoutProject(file.path, fmt)),
        createdAt: Number.isFinite(sessionRec.createdAt) ? sessionRec.createdAt : parseTimeValue(sessionRec.createdAt),
        lastActiveAt: st.mtimeMs, sourcePath: file.path, cwd: sessionRec.cwd,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// continue：<global>/sessions/<sessionId>.json（global = $CONTINUE_GLOBAL_DIR || ~/.continue，
// VS Code / JetBrains / CLI 三端共用）。同目录 sessions.json 是索引数组，只有它带
// dateCreated（会话文件本身没有时间戳）→ 索引命中时只做头部签名校验，不整读会话文件。
// 会话文件含 contextItems（内嵌所引用文件全文）可能很大，整读仅发生在索引未覆盖时。
// 项目取记录内 workspaceDirectory（目录是全局单一层，没有按项目分层的布局可解析）。
async function scanContinue(host, target, bm, emit) {
  const files = []
  await walkFiles(host, target, files, (name) => /\.json$/i.test(name))
  // 索引优先：一次读入 sessionId → { title, createdAt, cwd }
  let index = new Map()
  for (const file of files) {
    if (basenameOf(file.name).toLowerCase() !== 'sessions.json') continue
    const raw = await host.readText(file.path)
    if (raw === null || raw === '') continue
    index = readContinueIndex(raw)
    break
  }
  const out = []
  for (const file of files) {
    if (basenameOf(file.name).toLowerCase() === 'sessions.json') continue
    const stem = basenameOf(file.name).replace(/\.json$/i, '')
    const st = await host.stat(file.path)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    const known = index.get(stem) || null
    const entries = await probeSource(bm, 'continue', file.path, fp, async () => {
      // 结构签名：Continue 会话对象以 sessionId + history 开头（JetBrains 会留下 `{}`
      // 空文件、目录里也可能混入索引 → 只认两者都在的文件）。
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '' || !/"sessionId"\s*:/.test(head) || !/"history"\s*:/.test(head)) return []
      let createdAt = known ? known.createdAt : undefined
      let cwd = known ? known.cwd : null
      let title = known ? known.title : ''
      let sessionId = stem
      if (!known) {
        // 索引未覆盖（手工删改、写入中断）→ 整读该会话取元数据
        const raw = await host.readText(file.path)
        if (raw === null || raw === '') return []
        let session
        try { session = JSON.parse(raw) } catch { return [] }
        if (!session || typeof session !== 'object' || !Array.isArray(session.history)) return []
        sessionId = typeof session.sessionId === 'string' && session.sessionId ? session.sessionId : stem
        title = typeof session.title === 'string' ? session.title : ''
        cwd = typeof session.workspaceDirectory === 'string' && session.workspaceDirectory
          ? session.workspaceDirectory
          : null
      }
      return [makeEntry({
        format: 'continue', sessionId,
        // 默认标题（'New Session'）不是用户起的名字 → 交给首问兜底
        title: normalizeTitle(title === 'New Session' ? '' : title),
        project: projectFromRecord(cwd, () => null),
        createdAt: createdAt ?? undefined, lastActiveAt: st.mtimeMs,
        sourcePath: file.path, cwd,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

const SCANNERS = {
  claude: scanClaude,
  codex: scanCodex,
  cursor: scanCursor,
  gemini: scanGemini,
  antigravity: scanAntigravity,
  reasonix: scanReasonix,
  opencode: scanOpencode,
  mimocode: scanMimocode,
  kilocode: scanKilocode,
  zcode: scanZcode,
  grokbuild: scanGrokbuild,
  openclaw: scanOpenclaw,
  pi: scanPi,
  hermes: scanHermes,
  kimi: scanKimi,
  qoder: scanQoder,
  workbuddy: scanWorkbuddy,
  qwen: scanQwen,
  continue: scanContinue,
  cline: scanCline,
  goose: scanGoose,
  zed: scanZed,
  crush: scanCrush,
  chatgpt: scanChatgpt,
  teleagent: scanTeleagent,
  trae: scanTrae,
  vibe: scanVibe,
  dsh: scanDsh,
  dsh4: scanDsh,
}

// 单格式扫描：单个数据根读取失败（权限/损坏）只跳过该格式，不拖垮整次发现
//（host 的 stat/readText/readDir 已把常见缺失归一为 null；此处兜底异常）。
// bm 为可选持久化书签 store（缺省走纯扫描）。
export async function scanFormat(host, format, target, bm, emit) {
  const fn = SCANNERS[format]
  if (!fn) return []
  try {
    // 第五个参数是「请求的单一格式」：dsh / dsh4 共用一个扫描器，靠它过滤代次；其余扫描器忽略
    return await fn(host, target, bm, emit, format)
  } catch {
    // 该格式扫描抛错（个别根损坏等）→ 返回空，其余格式不受影响
    return []
  }
}

// 单文件路径 → 可消费它的候选格式（按扩展名 + 路径特征；无特征时回退探测
// claude/codex/cursor/reasonix/openclaw/hermes 六种通用 JSONL 格式，扫描器按结构
// 自拒）。pi 需路径特征（/pi/agent/sessions/）不入回退；kimi 是目录形态（wire.jsonl
// 在会话目录内），单文件回退也不覆盖它。
// 路径特征一律两种分隔符都认（Windows 路径此前整条判据都不命中，dsh 单文件导入会静默
// 落到通用 JSONL 回退）。
function fileFormatsForPath(path) {
  const lower = String(path).toLowerCase()
  const base = lower.slice(Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\')) + 1)
  // dsh：目录形态 <…>/sessions/<workspace>/<session>/session[.vN].jsonl[.zstd]
  if (/(^|[\\/])sessions[\\/]/.test(lower) && isDshSessionFile(base)) return [(dshSessionLogVersion(base) ?? 0) >= 4 ? 'dsh4' : 'dsh']
  if (/\.jsonl$/i.test(lower)) {
    const fmts = []
    if (/\bagent-transcripts\b/.test(lower)) fmts.push('cursor')
    if (/(^|[\\/])rollout-/.test(lower)) fmts.push('codex')
    if (/(^|[\\/])(desktop|subagent)-/.test(lower)) fmts.push('reasonix')
    if (/\.claude[\\/]/.test(lower)) fmts.push('claude')
    if (/\bagents\b.*\bsessions\b/.test(lower)) fmts.push('openclaw')
    if (/\.pi[\\/]agent[\\/]sessions[\\/]/.test(lower)) fmts.push('pi')
    if (/\.hermes[\\/]/.test(lower)) fmts.push('hermes')
    if (/(\.kimi|\.kimi-code)[\\/]sessions[\\/]/.test(lower)) fmts.push('kimi')
    if (/\.qoder[\\/]projects[\\/]/.test(lower)) fmts.push('qoder')
    if (/\.workbuddy[\\/]projects[\\/]/.test(lower)) fmts.push('workbuddy')
    if (/\.qwenworkcn[\\/]projects[\\/]/.test(lower)) fmts.push('qwen')
    if (/(\.vibe[\\/]logs[\\/]session|messages\.jsonl$)/.test(lower)) fmts.push('vibe')
    return fmts.length > 0 ? fmts : ['claude', 'codex', 'cursor', 'reasonix', 'openclaw', 'hermes']
  }
  if (/\.json$/i.test(lower)) {
    // continue 的会话文件是单个 JSON 对象（非 JSONL）且路径特征唯一：按目录签名
    // 直接命中断言，避免落到 gemini/chatgpt 探测（它们的结构签名都不含 history 数组）
    if (/(^|[\\/])\.continue[\\/]sessions[\\/]/.test(lower)) return ['continue']
    // cline 的转写固定叫 <sessionId>.messages.json（在 <sessionsDir>/<sessionId>/ 下）
    if (/\.messages\.json$/i.test(lower) || /[\\/]tasks[\\/][^\\/]+[\\/]api_conversation_history\.json$/i.test(lower)) return ['cline']
    return ['gemini', 'chatgpt']
  }
  if (/state\.vscdb$/i.test(lower) && /[\\/]((workspace|global)storage)[\\/]/i.test(lower)
    && /[\\/]trae(?: cn| solo(?: cn)?)?[\\/]/i.test(lower)) return ['trae']
  if (/\.db$/i.test(lower)) {
    if (/opencode\.db$/i.test(lower)) return ['opencode']
    if (/mimocode\.db$/i.test(lower)) return ['mimocode']
    if (/kilo\.db$/i.test(lower)) return ['kilocode']
    // sessions.db 是 Cline 与 Goose 共用的库文件名 → 两个候选都试，扫描器按表结构自拒
    if (/sessions\.db$/i.test(lower)) return ['cline', 'goose']
    if (/threads\.db$/i.test(lower)) return ['zed']
    if (/crush\.db$/i.test(lower)) return ['crush']
    if (/db\.sqlite$/i.test(lower)) return ['zcode']
    if (/state\.db$/i.test(lower)) return ['hermes']
    if (/teleagent\.db$/i.test(lower)) return ['teleagent']
    return ['opencode', 'zcode', 'hermes']
  }
  return []
}

// 目标展开：path 缺省 → 默认根（grokbuild 双根展开，chatgpt 无根跳过）；
// path 目录 → format 指定则单格式、否则全部格式探测；path 文件 → 扩展名探测。
async function buildTargets({ path, format, roots, host }) {
  const targets = []
  const push = (fmt, target) => { if (target !== null && target !== undefined) targets.push([fmt, String(target)]) }
  if (path) {
    const st = await host.stat(path)
    if (!st) return []
    if (st.type === 'file') {
      const fmts = format ? [format] : fileFormatsForPath(path)
      for (const f of fmts) push(f, path)
      return targets
    }
    const fmts = format ? [format] : FORMATS
    for (const f of fmts) push(f, path)
    return targets
  }
  const fmts = format ? [format] : FORMATS
  for (const f of fmts) {
    const root = roots[f]
    if (Array.isArray(root)) {
      for (const r of root) push(f, r)
    } else {
      push(f, root)
    }
  }
  return targets
}

function matchQuery(s, query) {
  // query 缺省（undefined/null）等同空串不过滤——产出路径（onEntry）与旧调用方共用
  const q = query === null || query === undefined ? '' : String(query).trim().toLowerCase()
  if (!q) return true
  return [s.title, s.project, s.sourcePath].some((v) => typeof v === 'string' && v.toLowerCase().includes(q))
}

/** 会话发现主入口：见文件头契约。返回 { sessions, total }（按最近活跃降序）。
 * archivedIds（可选）为已归档会话 id 集合，传给 resolveImportStatus 标注 'archived'
 *（调用方从 workspaceRegistry.archivedSessionIds 取，见 lib/imports.mjs 的
 * archivedSessionIds 助手；缺省不标注，行为与旧版一致）。
 * persistedIds（可选）为宿主当前已加载/持久化的会话 id 集合（Set 或数组），传给
 * discoverSessions 过滤宿主已加载的原生会话（避免 DSH 自身会话自扫描与重导），并让
 * resolveImportStatus 把「注册表指向的会话已被删除」标成 not-imported。 */
export async function discoverSessions({ path, format, query, home, host, imports, cache, cacheDir, archivedIds, onEntry, persistedIds } = {}) {
  if (!host || typeof host.stat !== 'function' || typeof host.readHead !== 'function'
    || typeof host.readText !== 'function' || typeof host.readDir !== 'function') {
    throw new Error('discoverSessions 需要 host（stat/readHead/readText/readDir/readSessions）')
  }
  const roots = defaultRoots({ home })
  const targets = await buildTargets({ path, format, roots, host })
  const ttlCache = cache ?? scanCache
  // 持久化书签懒加载：30s 内 TTL 全命中时不碰盘；save 只在有更新时原子写
  const bmStore = cacheDir ? await createBookmarkStore(String(cacheDir)) : null
  // onEntry（可选）逐条产出：状态标注（importStatus + git 分支）与 query 过滤移到
  // 产出路径，调用方边扫边渲染（面板流式）；缺省时整体行为与旧版完全一致。
  const reg = imports && typeof imports === 'object' ? imports : {}
  const persisted = persistedIds instanceof Set ? persistedIds
    : Array.isArray(persistedIds) ? new Set(persistedIds)
    : null
  // 宿主已加载的原生会话（native session）：id 存在于 sessionPersistence 中、且在 imports
  // 注册表里无导入记录。该类会话本就存在于宿主中，不应作为外部待导入会话扫出（避免套娃与自导入）。
  const isPersistedNative = (entry) => {
    if (!persisted || !entry || !entry.sessionId || !persisted.has(entry.sessionId)) return false
    // DSH 自身来源例外：dsh / dsh4 的条目就是宿主自己的会话日志，用途正是把某条日志
    // 复制 / 迁移成另一代次的会话（V3 ↔ V4），按「宿主已加载」隐藏就等于这个来源永远为空。
    // 其余来源照旧隐藏（避免把宿主已有的外部会话当待导入项套娃自导）。
    if (entry.format === 'dsh' || entry.format === 'dsh4') return false
    const record = reg[entry.sourcePath]
    return !record
  }
  const gitCache = new Map()
  const emitMapped = typeof onEntry === 'function'
    ? async (entry) => {
      if (isPersistedNative(entry)) return
      const mapped = {
        ...entry,
        importStatus: resolveImportStatus(reg, entry.sourcePath, entry.sessionId, archivedIds, persisted),
        ...(await gitStatusOf(entry.cwd || dirnameOf(entry.sourcePath), gitCache)),
      }
      if (matchQuery(mapped, query)) onEntry(mapped)
    }
    : null
  const all = []
  for (const [fmt, target] of targets) {
    const key = fmt + '|' + target
    let entries = ttlCache.get(key)
    let startedHere = false
    if (entries === undefined) {
      // 进行中扫描去重（issue #16）：同 key 并发调用共享一个 Promise，
      // 避免多会话同时启动时叠加全量扫描。
      let inflight = inflightScans.get(key)
      if (!inflight) {
        inflight = (async () => {
          try {
            // 本调用启动的扫描：walker 内已按条目逐条 emit（emitMapped 一路透传）
            const result = await scanFormat(host, fmt, target, bmStore, emitMapped)
            ttlCache.set(key, result)
            return result
          } finally {
            inflightScans.delete(key)
          }
        })()
        inflightScans.set(key, inflight)
        startedHere = true
      }
      entries = await inflight
    }
    // 缓存命中 / 加入他人正在跑的扫描：本调用没有机会逐条产出 → 整批补齐
    //（自己启动的扫描已在 walker 内逐条 emit，绝不重复）。
    if (emitMapped && !startedHere && entries.length > 0) {
      for (const e of entries) await emitMapped(e)
    }
    all.push(...entries)
  }
  if (bmStore) {
    try {
      await bmStore.save()
    } catch (err) {
      // 书签写盘失败只影响下次缓存，不影响本次扫描结果
      console.warn('[dsh-chat-import] scan 书签写盘失败（不影响本次扫描）：' + String((err && err.message) || err))
    }
  }
  const visible = persisted ? all.filter((e) => !isPersistedNative(e)) : all
  const sessions = await Promise.all(visible.map(async (e) => ({
    ...e,
    importStatus: resolveImportStatus(reg, e.sourcePath, e.sessionId, archivedIds, persisted),
    ...(await gitStatusOf(e.cwd || dirnameOf(e.sourcePath), gitCache)),
  })))
  const filtered = query ? sessions.filter((s) => matchQuery(s, query)) : sessions
  filtered.sort((a, b) => (b.lastActiveAt ?? b.createdAt ?? 0) - (a.lastActiveAt ?? a.createdAt ?? 0))
  return { sessions: filtered, total: filtered.length }
}
