// lib/discovery.mjs — 会话发现：统一扫描全部来源格式，返回结构化索引
//
// 只读发现层：通过注入的 host 接口访问文件/DB/SQLite，不 import node:sqlite 或 DSH 服务。
// 提供 30s 进程缓存与 scan-cache.json 持久化书签；支持 path/format/query 过滤，以及
// 标题、项目名、消息数提取。

import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { readFile as fread, stat as fstat } from 'node:fs/promises'
import { parseCursorEmbeddedTimestamp, stripCursorTitleDecorations, isCursorNonRepoSlug } from './cwd-map.mjs'
import { isDshSessionFile, dshSessionLogVersion, decodeZstdText } from './sources/dsh.mjs'
import { realWorkspaceDir } from './convert/qwen.mjs'
import { readContinueIndex } from './convert/continue.mjs'
import {
  clineLegacyTaskHistoryPath,
  clineLegacyUiMessagesPath,
  clineMessagesPath,
  parseClineLegacyTaskHistory,
  readClineManifest,
} from './convert/cline.mjs'
import { gooseSessionsDir } from './convert/goose.mjs'
import { zedThreadsDir } from './convert/zed.mjs'
import { codexThreadIdFromName, codexNameTimestamp } from './sources/codex.mjs'
import { crushUserDataDir, crushProjectDbPath, parseCrushProjects } from './convert/crush.mjs'

export const FORMATS = [
  'claude', 'codex', 'cursor', 'gemini', 'antigravity', 'reasonix', 'opencode', 'mimocode',
  'zcode', 'grokbuild', 'openclaw', 'pi', 'hermes', 'kimi', 'kilocode', 'qoder', 'chatgpt', 'workbuddy', 'qwen', 'continue', 'cline', 'goose',
  // dsh 按日志代次拆两项：dsh = V3（含 v0–v3），dsh4 = V4。同一份会话目录、同一个扫描器，
  // 用请求的 format 过滤——面板来源列表要能分别只看 V3 / V4。
  'dsh4', 'zed', 'crush', 'teleagent', 'dsh',
]

export const SCAN_TTL_MS = 30000
export const TITLE_MAX_LEN = 80
export const TITLE_ELLIPSIS = '…'
export const HEAD_MAX_BYTES = 256 * 1024

// ── 默认数据根（path 缺省时扫描全部；chatgpt 无自动根）────────────────────
// cline 的目录解析（上游 sdk/packages/shared/src/storage/paths.ts）：
//   sessionsDir = $CLINE_SESSION_DATA_DIR → <dataDir>/sessions
//   dataDir     = $CLINE_DATA_DIR → <clineDir>/data
//   clineDir    = $CLINE_DIR → ~/.cline
// 另有 $CLINE_DB_DATA_DIR 只影响索引库所在目录（<dbDir>/sessions.db）。
function clineDataDir(home) {
  if (process.env.CLINE_DATA_DIR) return process.env.CLINE_DATA_DIR
  const clineDir = process.env.CLINE_DIR || join(home, '.cline')
  return join(clineDir, 'data')
}
function clineSessionsDir(home) {
  return process.env.CLINE_SESSION_DATA_DIR || join(clineDataDir(home), 'sessions')
}

// Before the SDK migration Cline stored VS Code tasks in the extension's
// globalStorage directory. Keep an explicit override for portable/remote VS
// Code profiles, then cover the standard stable, Insiders and VSCodium roots.
export function clineLegacyStorageDirs(home) {
  const override = process.env.CLINE_LEGACY_GLOBAL_STORAGE_DIR
    || process.env.CLINE_VSCODE_GLOBAL_STORAGE_DIR
  if (override) return [override]
  const names = ['Code', 'Code - Insiders', 'VSCodium']
  if (process.platform === 'win32') {
    if (!process.env.APPDATA) return []
    return names.map((name) => join(process.env.APPDATA, name, 'User', 'globalStorage', 'saoudrizwan.claude-dev'))
  }
  if (process.platform === 'darwin') {
    return names.map((name) => join(home, 'Library', 'Application Support', name, 'User', 'globalStorage', 'saoudrizwan.claude-dev'))
  }
  const configHome = process.env.XDG_CONFIG_HOME || join(home, '.config')
  return names.map((name) => join(configHome, name, 'User', 'globalStorage', 'saoudrizwan.claude-dev'))
}

export function defaultRoots({ home = homedir() } = {}) {
  // 桌面端/新端根（Windows APPDATA/LOCALAPPDATA；Linux 无此环境变量 → null 跳过）
  const appData = process.env.APPDATA || null
  const localAppData = process.env.LOCALAPPDATA || null
  const reasonixDesktop = appData ? join(appData, 'reasonix') : null
  const claude3p = localAppData ? join(localAppData, 'Claude-3p', 'claude-code-sessions') : null
  // grokbuild 双根：sessions + archived_sessions（cc-switch session_roots 同款）
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
    grokbuild: [join(home, '.grok', 'sessions'), join(home, '.grok', 'archived_sessions')],
    openclaw: join(home, '.openclaw', 'agents'),
    pi: join(home, '.pi', 'agent', 'sessions'),
    hermes: join(home, '.hermes'),
    kimi: [join(home, '.kimi', 'sessions'), join(home, '.kimi-code', 'sessions')],
    qoder: join(home, '.qoder', 'projects'),
    workbuddy: join(home, '.workbuddy', 'projects'),
    qwen: join(home, '.qwenworkcn', 'projects'),
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
    // 回退 ~/.dsh（CLI 直跑，DSH_HOME 未设）。
    dsh: join(process.env.DSH_HOME || join(home, '.dsh'), 'sessions'),
  }
}

// ── 30s TTL 扫描缓存 ────────────────────────────────────────────────────
export function createScanCache({ ttlMs = SCAN_TTL_MS, now = () => Date.now() } = {}) {
  const map = new Map()
  return {
    get(key) {
      const hit = map.get(key)
      if (!hit) return undefined
      if (now() - hit.ts < ttlMs) return hit.data
      map.delete(key)
      return undefined
    },
    set(key, data) { map.set(key, { ts: now(), data }) },
    clear() { map.clear() },
    get size() { return map.size },
  }
}

// 默认缓存：进程内共享（同 key 30s 内命中不重扫）。测试用 clearScanCache 隔离。
const scanCache = createScanCache()
export function clearScanCache() { scanCache.clear() }

// 进行中扫描去重（issue #16）：同 key 并发扫描共享一个 Promise，避免多个会话同时
// 启动时叠加全量扫描。key = `<format>|<target>`，与 TTL 缓存同口径。模块级共享——
// 同一 target 的物理状态是共享的，并发扫描结果必然相同。resolve 后自动清理。
const inflightScans = new Map()
export function clearInflightScans() { inflightScans.clear() }

// ── 持久化 mtime/size 书签───────────────────────────────────────
// <cacheDir>/scan-cache.json：{ version, bookmarks: { <format>: { <sourcePath>:
// { mtimeMs, sizeBytes, entries } } } }。按 format 分表——同一源文件会被多种格式探测
//（无 format 的目录/文件探测），各格式提取结果不同，书签必须按格式隔离。entries = 该
// 源文件导出的会话条目（makeEntry 结果，importStatus 由 discoverSessions 统一填充，不
// 入书签）；多文件源的 mtimeMs 为复合串（grokbuild 会话目录两文件、openclaw 伴生
// sessions.json）。懒加载：进程内 30s TTL 命中时完全不碰盘，首次 get/remember 才读文件。
export const SCAN_CACHE_FILE = 'scan-cache.json'
// v3：Grok Build 的 project/cwd 解码修复改变了书签条目的语义——v2 书签命中会继续复用
// 编码的 project（%XX）与 null cwd，故 bump 版本整体失效旧缓存，强制重扫回填。
export const SCAN_CACHE_VERSION = 3

// 原子写：同目录 temp + fsync + rename（复刻 lib/imports.mjs 的 writeAtomic）。
async function writeAtomic(filePath, data) {
  const tmp = join(dirname(filePath), '.' + randomUUID() + '.tmp')
  try {
    const handle = await open(tmp, 'wx')
    try {
      await handle.writeFile(data, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, filePath)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

// 进程内写串行链：并发扫描不互相覆盖（同 imports registry 模式）。
let cacheWriteChain = Promise.resolve()

// 直接读盘（等待未决写完成后读）：缺失返回空；损坏/版本不符按空书签处理（告警）。
async function readScanCache(cacheDir) {
  await cacheWriteChain.catch(() => {})
  try {
    const parsed = JSON.parse(await readFile(join(cacheDir, SCAN_CACHE_FILE), 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.version === SCAN_CACHE_VERSION
      && parsed.bookmarks && typeof parsed.bookmarks === 'object' && !Array.isArray(parsed.bookmarks)) {
      return parsed.bookmarks
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.warn('[dsh-chat-import] scan-cache 损坏，按空书签处理：' + String((err && err.message) || err))
    }
  }
  return {}
}

function writeScanCache(cacheDir, data) {
  const run = cacheWriteChain.then(async () => {
    await mkdir(cacheDir, { recursive: true })
    await writeAtomic(join(cacheDir, SCAN_CACHE_FILE), JSON.stringify(data, null, 2) + '\n')
  })
  cacheWriteChain = run.catch(() => {})
  return run
}

// 书签 store：按 format 分表（同源文件被多格式探测时互不串扰）。get（指纹签名命中
// → entries 副本 / null；未命中 → undefined）。指纹签名 = fp 全字段稳定序列化——
// SQLite 源的 fp 带 walSig 扩展键（见 sqliteFingerprint），签名比对天然覆盖；旧记录
// 无 sig 字段时按旧 mtime+size 口径比对，但仅当 fp 形状与旧口径一致（无扩展键）才
// 允许命中（SQLite 源的扩展 fp 对旧记录一律未命中 → 强制重扫一次，自愈 WAL 盲区期
// 写入的过期缓存）。
function fpSignature(fp) {
  const keys = Object.keys(fp).sort()
  return JSON.stringify(keys.map((k) => [k, fp[k]]))
}

async function createBookmarkStore(cacheDir) {
  let map = null
  let dirty = false
  const ensure = async () => {
    if (map === null) map = await readScanCache(cacheDir)
    return map
  }
  const table = async (format) => {
    const m = await ensure()
    if (!m[format] || typeof m[format] !== 'object') m[format] = {}
    return m[format]
  }
  return {
    async get(format, sourcePath, fp) {
      const t = await table(format)
      const bm = t[sourcePath]
      if (!bm) return undefined
      const sig = fpSignature(fp)
      if (typeof bm.sig === 'string') {
        if (bm.sig !== sig) return undefined
      } else {
        // 旧记录：fp 带扩展键（SQLite 源 walSig 等）时不允许按旧口径命中
        if (sig !== fpSignature({ mtimeMs: fp.mtimeMs, sizeBytes: fp.sizeBytes })) return undefined
        if (bm.mtimeMs !== fp.mtimeMs || bm.sizeBytes !== fp.sizeBytes) return undefined
      }
      return bm.entries === null ? null : bm.entries.map((e) => ({ ...e }))
    },
    async remember(format, sourcePath, fp, entries) {
      const t = await table(format)
      t[sourcePath] = { mtimeMs: fp.mtimeMs, sizeBytes: fp.sizeBytes, sig: fpSignature(fp), entries }
      dirty = true
    },
    async save() {
      if (map === null || !dirty) return
      await writeScanCache(cacheDir, { version: SCAN_CACHE_VERSION, bookmarks: map })
      dirty = false
    },
  }
}

// 单源书签探测：fingerprint（mtimeMs+sizeBytes）命中 → 复用 entries，不读源内容；
// 未命中 → probe() 重读提取并写回书签（按 format 分表）。probe 返回 null（hermes db
// 不可用等）也入书签，调用方按 null 处理。bm 为 null（未开持久化）时直接 probe，行为
// 与旧版一致。cursor 命中时另走 patchCursorCacheEntries（slug 解码 / 时间戳补全），
// 旧书签无需 bump version 或重读 jsonl。
async function probeSource(bm, format, sourcePath, fp, probe, host) {
  if (!bm) return probe()
  const hit = await bm.get(format, sourcePath, fp)
  if (hit !== undefined) {
    if (format === 'cursor' && hit !== null && host) {
      const patched = await patchCursorCacheEntries(host, hit, sourcePath, fp)
      if (patched.changed) await bm.remember(format, sourcePath, fp, patched.entries)
      return patched.entries
    }
    return hit
  }
  const entries = await probe()
  await bm.remember(format, sourcePath, fp, entries)
  return entries
}

// cursor 书签读时补丁：旧缓存常带 cwd=null、project=原始 slug；命中 mtime+size 后
// 仍经 resolveCursorSlug 还原真实工作区，并从 title 补 createdAt（不重读 jsonl）。
async function patchCursorCacheEntries(host, entries, sourcePath, fp) {
  if (!Array.isArray(entries) || entries.length === 0) return { entries, changed: false }
  const slug = layoutProject(sourcePath, 'cursor')
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

// ── 通用助手（纯函数）───────────────────────────────────────────────────
function pathSegments(p) {
  return String(p ?? '').split(/[\\/]/).filter((s) => s.length > 0)
}
function basenameOf(p) {
  const s = pathSegments(p)
  return s[s.length - 1] ?? ''
}
// 取父目录：标签回退（项目名）与 kimiWorkDir 自底向上找 kimi.json 都用它；host 侧
// stat/readText 会归一分隔符，故此处归一后拼接安全（与 import-variants 的 parentOf 同语义）。
function dirnameOf(p) {
  const s = pathSegments(p)
  s.pop()
  return s.join('/')
}

// 同目录伴生文件路径：保留原分隔符（host 给的同目录子项路径必须原样可查）。
function siblingPath(filePath, suffixName) {
  const m = String(filePath).match(/[\\/][^\\/]+$/)
  return m ? filePath.slice(0, m.index + 1) + suffixName : filePath
}

// 递归遍历不进入的目录名：聊天记录从不在这些目录下；node_modules / .git 等在
// pnpm 符号链接结构下会引发组合爆炸或无意义遍历，单次扫描实际永不结束（issue #16）。
const WALK_SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.venv', 'venv',
  'dist', 'build', '.next', '.turbo', '.cache', 'target', 'out',
  '.idea', '.vscode', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.DS_Store',
])
// 深度兜底：合法聊天记录根不超过 5 层（如 .codex/sessions/YYYY/MM/DD/file），
// 12 层覆盖任意合理布局，同时切断病态深递归 / 循环符号链接（issue #16）。
const WALK_MAX_DEPTH = 12

// 递归收集匹配文件（目录缺失/不可读 → 空，发现阶段静默跳过该根）。
// 跳过 node_modules 等目录 + 限深，避免 pnpm 符号链接结构下组合爆炸（issue #16）。
// 目标本身是文件时（显式给出某个会话日志/转录路径）按其文件名匹配：目录形态的扫描器
// （dsh / claude / codex…）此前对单文件目标恒返回空，fileFormatsForPath 判出来的格式
// 因此形同虚设（`discoverSessions({ path: '<某个 session.jsonl>' })` 恒 0 条）。
async function walkFiles(host, target, out, match, depth = 0) {
  if (depth > WALK_MAX_DEPTH) return
  const entries = await host.readDir(target)
  if (!entries || entries.length === 0) {
    // 读不到目录项：目标可能是文件，也可能是缺失的根（stat 拿不到 → 静默跳过）
    const st = await host.stat(target)
    const name = basenameOf(target)
    if (st && st.type === 'file' && match(name)) out.push({ name, type: 'file', path: target })
    return
  }
  for (const e of entries) {
    if (e.type === 'directory') {
      if (WALK_SKIP_DIRS.has(e.name)) continue
      await walkFiles(host, e.path, out, match, depth + 1)
    } else if (e.type === 'file' && match(e.name)) {
      out.push(e)
    }
  }
}

// JSONL 头解析：畸形/截断行跳过（发现阶段只取元数据，不整读、不做行级明细）。
function parseJsonlHead(head) {
  const recs = []
  for (const line of String(head ?? '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    try { recs.push(JSON.parse(t)) } catch { /* 截断尾行/畸形行跳过 */ }
  }
  return recs
}

// 上下文 token 数（会话规模指标）：只读转录尾部取
// 最后一条带用量的记录——Claude 每条 assistant 的 message.usage.input_tokens 即该轮
// 上下文 token（Anthropic API 精确值）；Kimi 的 usage.record 带 usage{inputOther,
// inputCacheRead}（输入 = 未命中 + 前缀缓存命中）。只读尾部、不做整读计数，值随书签缓存。
const TAIL_MAX_BYTES = 64 * 1024

// Claude 尾部 → 最后一条 assistant 的 input_tokens（无则 null）。
function claudeContextTokens(tailText) {
  let last = null
  for (const line of String(tailText ?? '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    let r
    try { r = JSON.parse(t) } catch { continue }
    const u = r && r.message && r.message.usage
    if (u && typeof u.input_tokens === 'number' && Number.isFinite(u.input_tokens)) last = u.input_tokens
  }
  return last
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

// 注入过滤前缀（首行命中即视为系统注入，不当标题）。空文本也视为注入。
const INJECT_MARKERS = [
  '<environment_context>', '<system-reminder>', '<user_instructions>',
  '<local-command-caveat>', '<command-name>', '<permissions>',
  '# AGENTS.md', '# Files mentioned', 'The user is asking about',
  '# Context from my IDE setup:',
]
export function isInjectedTitle(text) {
  const t = String(text ?? '').trim()
  if (!t) return true
  const lower = t.toLowerCase()
  return INJECT_MARKERS.some((m) => lower.startsWith(m.toLowerCase()))
}

// 标题归一（同款规则）：折叠空白、80 字符截断加省略号；空白返回 ''。
export function normalizeTitle(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return ''
  return t.length <= TITLE_MAX_LEN ? t : t.slice(0, TITLE_MAX_LEN - TITLE_ELLIPSIS.length) + TITLE_ELLIPSIS
}

// content → 纯文本：string 原样；block 数组取各 block 的 text 字段（tool_result 不算
// 用户提问，跳过）——input_text/output_text 块自带 text，无需按类型分支；{text} 对象取 text。
function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'tool_result') continue
      if (typeof block.text === 'string' && block.text.trim()) parts.push(block.text)
    }
    return parts.join('\n')
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text
  return ''
}

// 首条真实 user 文本（注入过滤；不归一，供 Cursor 时间戳解析）。
function firstUserRawText(recs, extract) {
  for (const rec of recs) {
    const text = extract(rec)
    const t = String(text ?? '').trim()
    if (!t || isInjectedTitle(t)) continue
    return t
  }
  return null
}
// 首条真实 user 文本（注入过滤 + 归一）；无 → null。
function firstUserTitle(recs, extract) {
  const raw = firstUserRawText(recs, extract)
  return raw ? normalizeTitle(raw) : null
}

// 时间戳 → 毫秒：数字 >1e12 为毫秒原样、否则秒 ×1000；RFC3339 字符串解析
//（对齐 cc-switch parse_timestamp_to_ms / lib/convert/hermes parseHermesTime）。
function parseTimeValue(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : Math.trunc(v) * 1000
  if (typeof v === 'string' && v) {
    const n = Date.parse(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function firstString(recs, pick) {
  for (const r of recs) {
    const v = pick(r)
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

function firstNumber(recs, pick) {
  for (const r of recs) {
    const v = pick(r)
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

// 项目名：记录内 cwd/directory basename 优先，否则布局正则回退。
function projectFromRecord(cwd, layoutFallback) {
  const base = cwd ? basenameOf(cwd) : ''
  return base || layoutFallback() || null
}

// 结构化条目（未知字段统一 null，保证 schema 稳定）。
// cwd = 会话记录里的完整工作区路径（git 状态等按目录解析的增强信息用；无记录为 null，
// 发现层 fallback 到源文件目录）。
function makeEntry({ format, sessionId, title, project, createdAt, lastActiveAt, contextTokens, sourcePath, cwd }) {
  const intOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null)
  return {
    format,
    sessionId,
    title: title || null,
    project: project || null,
    createdAt: intOrNull(createdAt),
    lastActiveAt: intOrNull(lastActiveAt),
    contextTokens: intOrNull(contextTokens),
    sourcePath,
    cwd: cwd || null,
    importStatus: null, // discoverSessions 统一填充（本模块不做 registry I/O）
  }
}

// ── 项目名布局正则（按源目录布局提取）───────────────────────────
export function layoutProject(sourcePath, format) {
  const p = String(sourcePath ?? '').replace(/\\/g, '/')
  switch (format) {
    case 'claude': {
      const m = p.match(/\/projects\/([^/]+)\/[^/]+\.jsonl$/i)
      return m ? m[1] : null
    }
    case 'cursor': {
      const m = p.match(/\/projects\/([^/]+)\/agent-transcripts\//i)
      return m ? m[1] : null
    }
    case 'reasonix': {
      const m = p.match(/\/projects\/([^/]+)\//i)
      return m ? m[1] : null
    }
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
    case 'openclaw': {
      const m = p.match(/\/agents\/([^/]+)\/sessions\//)
      return m ? m[1] : null
    }
    case 'codex': {
      const m = p.match(/\/sessions\/(\d{4})\/(\d{2})\//)
      return m ? m[1] + '/' + m[2] : null
    }
    case 'gemini': {
      const m = p.match(/\/history\/([^/]+)\/chats\//)
      return m ? m[1] : null
    }
    case 'antigravity': {
      // ~/.gemini/(antigravity|antigravity-cli|antigravity-ide)/brain/<id>/
      // .system_generated/logs/transcript.jsonl：无项目分目录概念（每会话一个 id
      // 目录）→ 固定源标签，工作区由 cwd 归组。
      const m = p.match(/\/brain\/([^/]+)\//)
      return m ? 'antigravity' : null
    }
    case 'dsh': {
      // $DSH_HOME/sessions/<encoded-workspace>/<session-id>/session[.vN].jsonl[.zstd]
      const m = p.match(/\/sessions\/([^/]+)\/[^/]+\/([^/]+)$/i)
      if (!m || !isDshSessionFile(m[2])) return null
      return decodeDshProjectKey(m[1])
    }
    case 'qoder': {
      // ~/.qoder/projects/<encoded-project>/<sessionId>.jsonl（项目目录名 = cwd 的
      // '/'→'-' 编码，best-effort 解码后取 basename 作项目名；记录内 cwd 优先）。
      const m = p.match(/\/projects\/([^/]+)\/[^/]+\.jsonl$/i)
      if (!m) return null
      const decoded = m[1].replace(/-/g, '/')
      return decoded.split('/').filter(Boolean).pop() || m[1]
    }
    case 'workbuddy': {
      // ~/.workbuddy/projects/<project-hash>/<session-uuid>.jsonl。project-hash 是
      // cwd 的哈希（不可逆），只能作标签；记录内 cwd 由 projectFromRecord 优先。
      const m = p.match(/\/\.workbuddy\/projects\/([^/]+)\/[^/]+\.jsonl$/i)
      return m ? m[1] : null
    }
    default:
      return null
  }
}

// ── 各格式扫描器（自拒：结构不匹配返回 []）──────────────────────────────

// 逐条产出（面板流式扫描底座）：emit 缺省时纯收集（既有全部调用零变化）；给定
// emit 时按与 out 收集数组一致的顺序逐条转发，调用方边扫边渲染、不必等全量。
// async：emit 可能做异步状态标注（git 分支），await 让事件循环逐条让出——
// 扫描期间宿主 Web 服务不被同步 fs 冻住。
async function emitEach(emit, entries) {
  if (!emit || !entries || entries.length === 0) return
  for (const e of entries) await emit(e)
}

// claude：~/.claude/projects/<slug>/<sessionId>.jsonl，只取主 transcript
//（fileStem == sessionId；agent-* 子代理/辅助 transcript 跳过）。
// 目标为 Claude-3p 新端根（claude-code-sessions）时走 scanClaude3p。
async function scanClaude(host, target, bm, emit) {
  if (/claude-code-sessions/i.test(String(target))) return scanClaude3p(host, target, bm, emit)
  const files = []
  await walkFiles(host, target, files, (name) => /\.jsonl$/i.test(name))
  const out = []
  for (const file of files) {
    const stem = basenameOf(file.name).replace(/\.jsonl$/i, '')
    if (stem.startsWith('agent-')) continue
    const st = await host.stat(file.path)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    const entries = await probeSource(bm, 'claude', file.path, fp, async () => {
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      const sessionId = firstString(recs, (r) => r && r.sessionId)
      if (!sessionId || sessionId !== stem) return []
      const cwd = firstString(recs, (r) => r && r.cwd)
      const createdAt = firstNumber(recs, (r) => (r && r.timestamp !== undefined ? parseTimeValue(r.timestamp) : undefined))
      const title = firstUserTitle(recs, (r) => (r && r.type === 'user' && r.message && r.message.role === 'user' ? contentText(r.message.content) : ''))
      const contextTokens = st.size <= HEAD_MAX_BYTES
        ? claudeContextTokens(head)
        : claudeContextTokens(await host.readTail(file.path, TAIL_MAX_BYTES))
      return [makeEntry({
        format: 'claude', sessionId, title,
        project: projectFromRecord(cwd, () => layoutProject(file.path, 'claude')),
        createdAt, lastActiveAt: st.mtimeMs, contextTokens, sourcePath: file.path, cwd,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// codex：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl 与 ~/.codex/archived_sessions/
// rollout-*.jsonl（首记录 session_meta 为格式签名；walkFiles 递归，扁平目录同样适用）。
// 项目目录名的 ~XXXX 是宿主 projectKey() 的 code-unit 转义（四位大写十六进制）。
// 此前按 decodeURIComponent('%XXXX') 解，得到控制字符加字面量余数：
// '--…-DSH~0020Repo--' 会解成 U+0000 + '20Repo'，而不是 'DSH Repo'。
// 还原本身有损——分隔符已折叠成 '-'，无法区分它与字面量连字符；这里只如实还原
// ~XXXX 转义，不臆测路径结构。
function decodeDshProjectKey(encoded) {
  return String(encoded).replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

// codex：rollout 文件发现。新版 Codex CLI 会把一个会话**拆成多个分页文件**（issue #57）：
// 同 thread 的所有分页共享文件名前缀（首个 UUID = thread id），后续页带 `_<pageId>` 后缀，
// 每页首行 session_meta 带 history_mode/history_base 指向上一页。因此**按 thread 分组，
// 一条链只出一个条目**：sourcePath = 链的首页（导入的幂等键，追加新页不变）、标题取首页
// 的首条用户消息（修复「两条同名条目」）、createdAt 取最早页、lastActiveAt 取最新页 mtime。
// 子代理 rollout（thread_source='subagent' / source.subagent）仍按文件级跳过。
async function scanCodex(host, target, bm, emit) {
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
      // 发现层跳过（对齐 claude/qoder 的「辅助 transcript 跳过」），不再进 scan_discover 或
      // sync 入站的 scanned 计数。判定内联镜像 convert/codex.mjs 的 codexSubagentMarker，
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
      project: projectFromRecord(root.cwd, () => layoutProject(root.path, 'codex')),
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
async function scanCursor(host, target, bm, emit) {
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
      const slug = layoutProject(file.path, 'cursor')
      const cwd = host.resolveCursorSlug && slug ? await host.resolveCursorSlug(slug) : null
      const createdAt = tsFromTitle ?? null
      const lastActiveAt = typeof st.mtimeMs === 'number' ? st.mtimeMs : (tsFromTitle ?? null)
      return [makeEntry({
        format: 'cursor', sessionId: stem, title,
        project: projectFromRecord(cwd, () => null),
        createdAt, lastActiveAt, sourcePath: file.path, cwd,
      })]
    }, host)
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// antigravity：~/.gemini/(antigravity|antigravity-cli|antigravity-ide)/ 的
// 每会话一目录布局（Antigravity 是 Gemini CLI 的后续产品，共用 ~/.gemini 前缀但
// 存储形态不同，故独立成源；根名随产品版本分化，三根共用同一内层布局）：
//   conversations/<id>.db | <id>.pb                   命中记录（.db=SQLite、.pb=
//                                                       protobuf，正文都不读）
//   brain/<id>/.system_generated/logs/transcript.jsonl 明文逐行 JSON（发现与导入都读它）
//   annotations/<id>.pbtxt                             标题（protobuf 文本格式）
// 条目按 conversations/*.db + *.pb 枚举（会话即该文件；新旧格式可能同名并存，按 id
// 去重），sourcePath 指向 transcript.jsonl——它才是导入输入；缺 transcript 的会话
// 无正文可导，不产出条目。
async function scanAntigravity(host, target, bm, emit) {
  const convDir = join(target, 'conversations')
  const brainDir = join(target, 'brain')
  const annoDir = join(target, 'annotations')
  const files = []
  await walkFiles(host, convDir, files, (name) => /\.(db|pb)$/i.test(name))
  const seen = new Set()
  const out = []
  for (const file of files) {
    const id = basenameOf(file.name).replace(/\.(db|pb)$/i, '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    const transcriptPath = join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl')
    const st = await host.stat(transcriptPath)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    const entries = await probeSource(bm, 'antigravity', transcriptPath, fp, async () => {
      // 只读头部抽元数据（大转录不整读）：标题取首条 USER_INPUT，cwd 按 tool_calls 频次。
      const head = await host.readHead(transcriptPath)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      if (recs.length === 0) return []
      let title = ''
      const cwdCounts = new Map()
      for (const rec of recs) {
        if (!rec || typeof rec !== 'object') continue
        if (!title && rec.type === 'USER_INPUT') {
          title = antigravityPromptTitle(rec.content)
        }
        if (Array.isArray(rec.tool_calls)) {
          for (const tc of rec.tool_calls) {
            const v = antigravityUnquote(tc && tc.args && tc.args.Cwd)
            if (typeof v === 'string' && v.startsWith('/')) cwdCounts.set(v, (cwdCounts.get(v) || 0) + 1)
          }
        }
      }
      let cwd = null
      let best = 0
      for (const [v, n] of cwdCounts) if (n > best) { cwd = v; best = n }
      // 标题权威来源是 annotations/<id>.pbtxt（重命名后同步）；缺失回退首问。
      const annoRaw = await host.readText(join(annoDir, id + '.pbtxt'))
      const annoTitle = antigravityAnnotationTitle(annoRaw)
      if (annoTitle) title = annoTitle
      return [makeEntry({
        format: 'antigravity',
        sessionId: id,
        title,
        project: layoutProject(transcriptPath, 'antigravity'),
        createdAt: parseTimeValue(recs[0] && recs[0].created_at),
        lastActiveAt: st.mtimeMs,
        sourcePath: transcriptPath,
        cwd,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// gemini：~/.gemini/history/<slot>/chats/session-*.json（顶层
// { sessionId, startTime, directories, messages: [{ type, content, ... }] }）。
async function scanGemini(host, target, bm, emit) {
  const files = []
  await walkFiles(host, target, files, (name) => /^session-.+\.json$/i.test(name))
  const out = []
  for (const file of files) {
    const st = await host.stat(file.path)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    const entries = await probeSource(bm, 'gemini', file.path, fp, async () => {
      const raw = await host.readText(file.path)
      if (raw === null || raw === '') return []
      let chat
      try { chat = JSON.parse(raw) } catch { return [] }
      if (!chat || typeof chat !== 'object' || !Array.isArray(chat.messages)) return []
      const stem = basenameOf(file.name).replace(/\.json$/i, '')
      const sessionId = typeof chat.sessionId === 'string' && chat.sessionId ? chat.sessionId : stem
      const title = firstUserTitle(chat.messages, (m) => (m && m.type === 'user' ? geminiPartsText(m.content) : ''))
      const dir = Array.isArray(chat.directories) && chat.directories.length > 0 ? chat.directories[0] : undefined
      return [makeEntry({
        format: 'gemini', sessionId, title,
        project: projectFromRecord(dir, () => layoutProject(file.path, 'gemini')),
        createdAt: parseTimeValue(chat.startTime), lastActiveAt: st.mtimeMs, sourcePath: file.path, cwd: dir,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

function geminiPartsText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : ''))
    .join('\n')
}

// ── antigravity 头部解析辅助（发现层不依赖 convert 层，按同款规则内联）──────
// Antigravity 把提问包在 <USER_REQUEST> 里，另带 <ADDITIONAL_METADATA> 脚手架 → 剥壳。
function antigravityUnwrapUserRequest(text) {
  let s = String(text ?? '')
  const m = s.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i)
  if (m) s = m[1]
  s = s.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
  s = s.replace(/<\/?USER_REQUEST>/gi, '')
  return s.trim()
}

// USER_INPUT 记录 → 标题候选（复用统一标题归一，超 80 字符截断加省略号）。
function antigravityPromptTitle(content) {
  return normalizeTitle(antigravityUnwrapUserRequest(content))
}

// annotations/<id>.pbtxt 是 protobuf 文本格式（title:"…"）；只取标题字段。
function antigravityAnnotationTitle(raw) {
  const m = String(raw ?? '').match(/title\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (!m) return ''
  try {
    return normalizeTitle(JSON.parse(`"${m[1]}"`))
  } catch {
    return normalizeTitle(m[1])
  }
}

// Antigravity 把 shell 风格参数存成带引号字符串（"55"）→ 还原字面值。
function antigravityUnquote(value) {
  if (typeof value !== 'string') return value
  const s = value.trim()
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s)
    } catch {
      return s.slice(1, -1)
    }
  }
  return value
}

// reasonix：~/.reasonix/sessions/desktop-*.jsonl（子代理 subagent-sub-* 默认过滤，不发现），
// 排除 .events/.conflicts/.guardian 伴生；会话 id = 文件 stem；project 走 projects/<slug> 布局。
// 桌面版：<state root>/projects/<slug>/sessions/*.jsonl（.titles.json 权威标题
// + slug 布局 project；stem 任意，无 desktop- 前缀要求）——按文件路径形态分派，
// 两种根（CLI sessions 目录 / 桌面版根）统一扫描。
function isReasonixSidecar(name) {
  return /\.(events|conflicts|guardian)\.jsonl$/i.test(name)
}
async function scanReasonix(host, target, bm, emit) {
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
        project: layoutProject(file.path, 'reasonix'),
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

// Claude-3p 新端：claude-code-sessions/<account>/<org>/local_<id>.json 元数据
// （sessionId/cliSessionId/cwd/title/lastActivityAt）。cliSessionId → 反查
// ~/.claude/projects/<slug>/*.jsonl（文件名 stem + 首行 sessionId 校验，#63904 同款）；
// 命中 → 合并进 claude 会话（标题/cwd/lastActivityAt 取元数据，sourcePath = jsonl，
// 幂等同 cliSessionId）；未命中 → 降级为元数据会话（sourcePath = 元数据 json，
// 转写缺失的降级元数据会话——导入侧对该 json 无内容会 skipped，属边界文档化）。
async function scanClaude3p(host, target, bm, emit) {
  const files = []
  await walkFiles(host, target, files, (name) => /\.json$/i.test(name))
  const out = []
  for (const file of files) {
    const st = await host.stat(file.path)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    const entries = await probeSource(bm, 'claude', file.path, fp, async () => {
      const raw = await host.readText(file.path)
      if (raw === null || raw === '') return []
      let meta
      try {
        meta = JSON.parse(raw)
      } catch {
        return []
      }
      if (!meta || typeof meta !== 'object') return []
      const sessionId = typeof meta.sessionId === 'string' && meta.sessionId
        ? meta.sessionId
        : basenameOf(file.name).replace(/\.json$/i, '')
      const cliId = typeof meta.cliSessionId === 'string' && meta.cliSessionId ? meta.cliSessionId : null
      const cwd = typeof meta.cwd === 'string' && meta.cwd ? meta.cwd : null
      const title = typeof meta.title === 'string' && meta.title.trim() ? normalizeTitle(meta.title) : null
      const lastActiveAt = parseTimeValue(meta.lastActivityAt)
      const createdAt = parseTimeValue(meta.createdAt)
      if (cliId) {
        const jsonlPath = await findJsonlBySessionId(host, cliId, join(homedir(), '.claude', 'projects'))
        if (jsonlPath) {
          return [makeEntry({
            format: 'claude', sessionId: cliId, title,
            project: cwd ? basenameOf(cwd) : layoutProject(jsonlPath, 'claude'),
            createdAt, lastActiveAt, sourcePath: jsonlPath, cwd,
          })]
        }
      }
      return [makeEntry({
        format: 'claude', sessionId, title,
        project: cwd ? basenameOf(cwd) : null,
        createdAt, lastActiveAt, sourcePath: file.path, cwd,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// cliSessionId → ~/.claude/projects/<slug>/<cliSessionId>.jsonl（文件名精确匹配 +
// 首行 sessionId 校验）；找不到返回 null（调用方降级元数据会话）。
async function findJsonlBySessionId(host, cliSessionId, projectsRoot) {
  const files = []
  await walkFiles(host, projectsRoot, files, (name) => name === cliSessionId + '.jsonl')
  for (const file of files) {
    const head = await host.readHead(file.path, 4096)
    if (parseJsonlHead(head).some((r) => r && r.sessionId === cliSessionId)) return file.path
  }
  return null
}

// SQLite 库的扫描指纹：主文件 mtime/size + WAL 边车（-wal / -shm）stat 签名。WAL
// 模式下新写入只落 -wal，主文件在 checkpoint 前 mtime/size 不变——只看主文件会让
// 持久化书签命中过期缓存（面板长期显示旧会话列表、新会话不可见）。边车缺失记 '-'
//（checkpoint 删除 -wal 也构成指纹变化）。host.stat 返回 null/undefined 均按缺失。
async function sqliteFingerprint(host, dbStat, dbPath) {
  const side = []
  for (const sfx of ['-wal', '-shm']) {
    const st = await host.stat(dbPath + sfx)
    side.push(st && st.type === 'file'
      ? String(st.size ?? '') + ':' + String(st.mtimeMs ?? st.version ?? '')
      : '-')
  }
  return { mtimeMs: dbStat.mtimeMs, sizeBytes: dbStat.size, walSig: side.join('|') }
}

// opencode / zcode：SQLite 一库多会话，经 host.readSessions 复用 lib 读取器
//（不重写 SQL）；目标为目录时定位固定库文件名（无递归，对齐 import 目录模式）。
async function scanSqlite(host, format, target, dbName, bm, emit) {
  const st = await host.stat(target)
  if (!st) return []
  let dbPath = target
  if (st.type === 'directory') {
    const candidate = join(target, dbName)
    const cst = await host.stat(candidate)
    if (!cst || cst.type !== 'file') return []
    dbPath = candidate
  } else if (!new RegExp(dbName.replace(/\./g, '\\.') + '$', 'i').test(target)) {
    return []
  }
  const dbStat = await host.stat(dbPath)
  if (!dbStat) return []
  const fp = await sqliteFingerprint(host, dbStat, dbPath)
  const entries = await probeSource(bm, format, dbPath, fp, async () => {
    const sessions = await host.readSessions(format, dbPath)
    if (!sessions) return []
    return sessions.map((s) => makeEntry({
      format, sessionId: s.id, title: normalizeTitle(s.title),
      project: s.directory ? basenameOf(s.directory) : null,
      createdAt: s.createdAt, lastActiveAt: s.lastActiveAt, sourcePath: dbPath,
      cwd: s.directory || null,
    }))
  })
  await emitEach(emit, entries)
  return entries
}
function scanOpencode(host, target, bm, emit) { return scanSqlite(host, 'opencode', target, 'opencode.db', bm, emit) }
function scanMimocode(host, target, bm, emit) { return scanSqlite(host, 'mimocode', target, 'mimocode.db', bm, emit) }
function scanKilocode(host, target, bm, emit) { return scanSqlite(host, 'kilocode', target, 'kilo.db', bm, emit) }
function scanZcode(host, target, bm, emit) { return scanSqlite(host, 'zcode', target, 'db.sqlite', bm, emit) }

// teleagent：opencode 派生（schema 同构），但落点是**多账户目录**
// ~/.local/share/TeleAgent/users/<账户ID>/teleagent.db（issue #60 实测）。三种目标形态：
//   账户目录（内含 teleagent.db）/ 库文件 → 标准 scanSqlite；
//   users/ 目录 → 枚举账户子目录逐库扫描；
//   TeleAgent/ 数据根 → 下钻一层 users/ 再枚举。
// （crush 的「枚举目录 → 候选 DB」是同一形态的先例。）
async function scanTeleagent(host, target, bm, emit) {
  const st = await host.stat(target)
  if (!st) return []
  if (st.type !== 'directory') return scanSqlite(host, 'teleagent', target, 'teleagent.db', bm, emit)
  const dbDirect = await host.stat(join(target, 'teleagent.db'))
  if (dbDirect && dbDirect.type === 'file') return scanSqlite(host, 'teleagent', target, 'teleagent.db', bm, emit)
  const usersDir = basenameOf(target).toLowerCase() === 'users' ? target : join(target, 'users')
  const accounts = await host.readDir(usersDir)
  if (!accounts) return []
  const out = []
  for (const e of accounts) {
    if (e.type !== 'directory') continue
    out.push(...await scanSqlite(host, 'teleagent', e.path, 'teleagent.db', bm, emit))
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
      const title = normalizeTitle(explicit) || firstUserTitle(recs, (r) => (r && r.type === 'user' ? contentText(r.content) : ''))
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
async function scanOpenclaw(host, target, bm, emit) {
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
        project: projectFromRecord(cwd, () => layoutProject(file.path, 'openclaw')),
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
async function scanPi(host, target, bm, emit) {
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

// qoder：~/.qoder/projects/<encoded-project>/<sessionId>.jsonl。结构同 Claude（type
// user/assistant + content block），子代理 transcript（<sessionId>/subagents/*.jsonl）
// 跳过；标题 ai-title > last-prompt > 首问；cwd 取记录内 cwd。
async function scanQoder(host, target, bm, emit) {
  // 路径签名自拒：Qoder JSONL 与 Claude 结构高度一致，纯内容无法区分，只能靠
  // 目录布局（~/.qoder/projects/）区分——非 qoder 根直接返回空，避免误扫 claude 等。
  if (!/\.qoder[\\/]projects([\\/]|$)/i.test(String(target))) return []
  const files = []
  await walkFiles(host, target, files, (name) => /\.jsonl$/i.test(name))
  const out = []
  for (const file of files) {
    if (/\bsubagents[\\/]/.test(file.path)) continue
    const stem = basenameOf(file.name).replace(/\.jsonl$/i, '')
    const st = await host.stat(file.path)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    const entries = await probeSource(bm, 'qoder', file.path, fp, async () => {
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      const sessionId = firstString(recs, (r) => r && r.sessionId)
      if (!sessionId || sessionId !== stem) return []
      const cwd = firstString(recs, (r) => r && r.cwd)
      const createdAt = firstNumber(recs, (r) => (r && r.timestamp !== undefined ? parseTimeValue(r.timestamp) : undefined))
      const aiTitle = firstString(recs, (r) => (r && r.type === 'ai-title' ? r.aiTitle : undefined))
      const lastPrompt = firstString(recs, (r) => (r && r.type === 'last-prompt' ? r.lastPrompt : undefined))
      const title = normalizeTitle(aiTitle || lastPrompt)
        || firstUserTitle(recs, (r) => (r && r.type === 'user' && r.message && r.message.role === 'user' ? contentText(r.message.content) : ''))
      return [makeEntry({
        format: 'qoder', sessionId, title,
        project: projectFromRecord(cwd, () => layoutProject(file.path, 'qoder')),
        createdAt, lastActiveAt: st.mtimeMs, sourcePath: file.path, cwd,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// workbuddy：~/.workbuddy/projects/<project-hash>/<session-uuid>.jsonl。逐行事件 JSON
//（message / reasoning / function_call / function_call_result / file-history-snapshot）；
// 标题 = <user_query> 提取的首条真实提问（注入过滤）；cwd 取记录内 cwd。
function workbuddyUserQuery(recs) {
  for (const r of recs) {
    if (!r || typeof r !== 'object') continue
    if (r.type === 'message' && r.role === 'user' && Array.isArray(r.content)) {
      const joined = contentText(r.content)
      const m = /<user_query>([\s\S]*?)<\/user_query>/.exec(joined)
      const text = m && m[1] && m[1].trim()
        ? m[1].trim()
        : joined.replace(/<system-reminder[\s\S]*?<\/system-reminder>/gi, '')
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      if (text) return text
    }
  }
  return ''
}
async function scanWorkbuddy(host, target, bm, emit) {
  // 路径签名自拒：WorkBuddy 事件 JSON 与其它 JSONL 均不同，但用目录布局
  //（~/.workbuddy/projects/）区分最稳——非 workbuddy 根直接返回空。
  if (!/\.workbuddy[\\/]projects([\\/]|$)/i.test(String(target))) return []
  const files = []
  await walkFiles(host, target, files, (name) => /\.jsonl$/i.test(name))
  const out = []
  for (const file of files) {
    const stem = basenameOf(file.name).replace(/\.jsonl$/i, '')
    const st = await host.stat(file.path)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    const entries = await probeSource(bm, 'workbuddy', file.path, fp, async () => {
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      const sessionId = firstString(recs, (r) => r && r.sessionId) || stem
      if (!sessionId) return []
      const cwd = firstString(recs, (r) => r && r.cwd)
      const createdAt = firstNumber(recs, (r) => (r && r.timestamp !== undefined ? parseTimeValue(r.timestamp) : undefined))
      const title = normalizeTitle(workbuddyUserQuery(recs))
      return [makeEntry({
        format: 'workbuddy', sessionId, title,
        project: projectFromRecord(cwd, () => layoutProject(file.path, 'workbuddy')),
        createdAt, lastActiveAt: st.mtimeMs, sourcePath: file.path, cwd,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// qwen（千问办公）：~/.qwenworkcn/projects/<slug>/<session-uuid>.jsonl。转写明文、
// 事件词汇与 Claude 同构（convert/qwen.mjs）。标题 = 首问（humanInput.text 权威，
// 回退 text 块并跳过 <system 注入块）；项目 = 首行 workspace-directories 里非
// .qwenworkcn 的真实工作文件夹（slug 目录名是存储层混写，禁作项目；记录内 cwd 是
// 千问临时工作区，同禁）。同会话双 slug 副本（-sessions-<hash>-mnt 与 workspace
// slug 并存）按 sessionId 去重留 mtime 最新的副本。
function qwenUserQuery(recs) {
  for (const r of recs) {
    if (!r || typeof r !== 'object' || r.type !== 'user' || !r.message) continue
    const hi = r.humanInput
    if (hi && typeof hi === 'object' && typeof hi.text === 'string' && hi.text.trim()) return hi.text
    const blocks = Array.isArray(r.message.content) ? r.message.content : null
    if (blocks !== null) {
      const texts = blocks
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string'
          && b.text.trim() && !/^<system/.test(b.text.trim()))
        .map((b) => b.text)
      if (texts.length > 0) return texts.join('\n')
    } else if (typeof r.message.content === 'string' && r.message.content.trim()
      && !/^<system/.test(r.message.content.trim())) {
      return r.message.content
    }
  }
  return ''
}
async function scanQwen(host, target, bm, emit) {
  // 路径签名自拒：只认 ~/.qwenworkcn/projects/ 布局——非千问根直接返回空。
  if (!/\.qwenworkcn[\\/]projects([\\/]|$)/i.test(String(target))) return []
  const files = []
  await walkFiles(host, target, files, (name) => /\.jsonl$/i.test(name))
  const bySession = new Map()
  for (const file of files) {
    const stem = basenameOf(file.name).replace(/\.jsonl$/i, '')
    const st = await host.stat(file.path)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    const entries = await probeSource(bm, 'qwen', file.path, fp, async () => {
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      const sessionId = firstString(recs, (r) => r && r.sessionId) || stem
      // 文件名 ≠ 记录 sessionId 的是辅助/异构转写，不建会话（双 slug 副本两者一致）
      if (!sessionId || sessionId !== stem) return []
      const wsDir = firstString(recs, (r) => (r && r.type === 'workspace-directories'
        ? realWorkspaceDir(r.directories)
        : undefined))
      const createdAt = firstNumber(recs, (r) => (r && r.timestamp !== undefined ? parseTimeValue(r.timestamp) : undefined))
      const title = normalizeTitle(qwenUserQuery(recs))
      return [makeEntry({
        format: 'qwen', sessionId, title,
        project: wsDir ? basenameOf(wsDir) : null,
        createdAt, lastActiveAt: st.mtimeMs, sourcePath: file.path, cwd: wsDir,
      })]
    })
    for (const e of entries) {
      const prev = bySession.get(e.sessionId)
      if (!prev || (e.lastActiveAt ?? 0) > (prev.lastActiveAt ?? 0)) bySession.set(e.sessionId, e)
    }
  }
  const out = [...bySession.values()]
  for (const e of out) await emitEach(emit, [e])
  return out
}

// hermes：~/.hermes/state.db（复用 readHermesDb，权威索引）→ 恒批量；db 不可用时回退
// 递归扫 sessions/*.jsonl（flat {role,content,ts} / nested {type:"session"|"message"}）。
function hermesUserText(r) {
  if (!r || typeof r !== 'object') return ''
  if (r.type === 'message' && r.message && typeof r.message === 'object' && r.message.role === 'user') return contentText(r.message.content)
  if (r.role === 'user') return contentText(r.content)
  return ''
}
async function scanHermes(host, target, bm, emit) {
  const st = await host.stat(target)
  if (!st) return []
  let dbPath = null
  if (st.type === 'file') {
    if (!/state\.db$/i.test(target)) return []
    dbPath = target
  } else {
    const candidate = join(target, 'state.db')
    const cst = await host.stat(candidate)
    if (cst && cst.type === 'file') dbPath = candidate
  }
  if (dbPath) {
    const dbStat = await host.stat(dbPath)
    if (!dbStat) return []
    const fp = await sqliteFingerprint(host, dbStat, dbPath)
    // probe 返回 null = 非 hermes 库（readSessions 不可用）→ 也入书签，回退扫 jsonl
    const dbEntries = await probeSource(bm, 'hermes', dbPath, fp, async () => {
      const sessions = await host.readSessions('hermes', dbPath)
      if (sessions === null) return null
      return sessions.map((s) => makeEntry({
        format: 'hermes', sessionId: s.id, title: normalizeTitle(s.title),
        project: s.directory ? basenameOf(s.directory) : null,
        createdAt: s.createdAt, lastActiveAt: s.lastActiveAt, sourcePath: dbPath,
      }))
    })
    if (dbEntries !== null) {
      await emitEach(emit, dbEntries)
      return dbEntries
    }
  }
  const files = []
  await walkFiles(host, target, files, (name) => /\.jsonl$/i.test(name))
  const out = []
  for (const file of files) {
    const fst = await host.stat(file.path)
    if (!fst) continue
    const fp = { mtimeMs: fst.mtimeMs, sizeBytes: fst.size }
    const entries = await probeSource(bm, 'hermes', file.path, fp, async () => {
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      if (!recs.some((r) => r && typeof r === 'object' && (r.role === 'user' || r.type === 'session' || r.type === 'message'))) return []
      const sessRec = recs.find((r) => r && r.type === 'session')
      const sessionId = sessRec && typeof sessRec.id === 'string' && sessRec.id
        ? sessRec.id
        : basenameOf(file.name).replace(/\.jsonl$/i, '')
      const explicitTitle = sessRec && typeof sessRec.title === 'string' && sessRec.title.trim() ? sessRec.title : ''
      const title = explicitTitle || firstUserTitle(recs, hermesUserText)
      const cwd = sessRec && typeof sessRec.cwd === 'string' ? sessRec.cwd : undefined
      const createdAt = firstNumber(recs, (r) => {
        if (!r || typeof r !== 'object') return undefined
        const v = r.timestamp ?? r.ts ?? (r.message && typeof r.message === 'object' ? r.message.ts : undefined)
        return v !== undefined ? parseTimeValue(v) : undefined
      })
      return [makeEntry({
        format: 'hermes', sessionId, title: normalizeTitle(title),
        project: projectFromRecord(cwd, () => null),
        createdAt, lastActiveAt: fst.mtimeMs, sourcePath: file.path,
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

// cline：文件式存储，每会话一目录 <sessionsDir>/<id>/，内有 <id>.messages.json（消息 +
// system_prompt）、<id>.json（manifest：metadata.title / cwd / started_at）与可选的
// <id>.compaction.json；子代理/团队任务的消息写在主会话目录内（<agentId>.messages.json），
// 不算独立会话。元数据索引在 <dataDir>/db/sessions.db（SQLite，只有元数据、用
// messages_path 指向转写）——**DB 优先**：拿权威会话清单 + cwd/时间/标题，逐个 stat 校验
// 转写是否存在；DB 不可用（老库缺列、锁定、非 Cline 库、用户只给了目录）则回退扫
// *.messages.json 并读 manifest 取元数据。标题优先 DB 的 metadata_json.title，为空才读
// manifest（上游 listSessions 同样以 manifest 的 metadata.title 覆盖 DB）。
function legacyRootForPath(path) {
  const value = String(path)
  const match = value.match(/^(.*)[\\/]tasks[\\/][^\\/]+(?:[\\/]api_conversation_history\.json)?$/i)
  if (match) return match[1]
  if (basenameOf(value).toLowerCase() === 'tasks') return dirnameOf(value)
  return value
}

function legacyTaskIdForPath(path) {
  const value = String(path)
  const match = value.match(/[\\/]tasks[\\/]([^\\/]+)[\\/]api_conversation_history\.json$/i)
  return match ? match[1] : null
}

async function clineLegacyTitle(host, root, id, item, apiPath) {
  if (item && typeof item.task === 'string' && item.task.trim()) return normalizeTitle(item.task)
  const uiPath = clineLegacyUiMessagesPath(root, id)
  const uiHead = await host.readHead(uiPath, HEAD_MAX_BYTES)
  if (uiHead) {
    try {
      const ui = JSON.parse(uiHead)
      const title = firstUserTitle(Array.isArray(ui) ? ui : [], (entry) => {
        if (!entry || typeof entry !== 'object') return ''
        // `ask` is a short UI category (for example "followup"), while
        // `text` carries the human prompt. Never expose the category or an
        // assistant status row as a title.
        const isUserPrompt = entry.type === 'ask' || entry.say === 'task'
        return isUserPrompt && typeof entry.text === 'string' ? entry.text : ''
      })
      if (title) return title
    } catch {
      // The bounded head may end mid-array; fall through to the API history.
    }
  }
  const apiHead = await host.readHead(apiPath, HEAD_MAX_BYTES)
  if (apiHead) {
    try {
      const api = JSON.parse(apiHead)
      const title = firstUserTitle(Array.isArray(api) ? api : [], (entry) => {
        if (!entry || typeof entry !== 'object' || entry.role !== 'user') return ''
        return contentText(entry.content)
      })
      if (title) return title
    } catch {
      // The history can exceed the bounded head; title remains unknown.
    }
  }
  return null
}

async function scanClineLegacy(host, target, emit) {
  const st = await host.stat(target)
  if (!st) return []
  const targetPath = String(target)
  const isApiFile = st.type === 'file' && /^api_conversation_history\.json$/i.test(basenameOf(targetPath))
  const root = legacyRootForPath(targetPath)
  const historyPath = clineLegacyTaskHistoryPath(root)
  const historyStat = await host.stat(historyPath)
  const indexed = historyStat && historyStat.type === 'file'
    ? parseClineLegacyTaskHistory(await host.readText(historyPath))
    : []
  const files = []
  if (isApiFile) files.push({ name: basenameOf(targetPath), type: 'file', path: targetPath })
  else {
    const tasksPath = join(root, 'tasks')
    await walkFiles(host, tasksPath, files, (name) => /^api_conversation_history\.json$/i.test(name))
  }
  if (files.length === 0) return []
  const byId = new Map(indexed.map((item) => [item.id, item]))
  const out = []
  for (const file of files) {
    const id = legacyTaskIdForPath(file.path)
    if (!id) continue
    const item = byId.get(id) || null
    // When taskHistory exists it is the authoritative session list. An
    // explicit file remains importable, while directory scans skip orphan
    // task files that the Cline UI no longer indexes.
    if (indexed.length > 0 && !item && !isApiFile) continue
    const st2 = await host.stat(file.path)
    if (!st2 || st2.type !== 'file') continue
    const title = await clineLegacyTitle(host, root, id, item, file.path)
    out.push(makeEntry({
      format: 'cline', sessionId: id, title,
      project: projectFromRecord(item && item.cwdOnTaskInitialization, () => null),
      createdAt: item ? parseTimeValue(item.ts) : undefined,
      lastActiveAt: st2.mtimeMs,
      sourcePath: file.path,
      cwd: item && typeof item.cwdOnTaskInitialization === 'string' ? item.cwdOnTaskInitialization : null,
    }))
  }
  await emitEach(emit, out)
  return out
}

async function scanCline(host, target, bm, emit) {
  const legacy = await scanClineLegacy(host, target, emit)
  if (legacy.length > 0) return legacy
  const st = await host.stat(target)
  if (!st) return []
  const candidates = []
  if (st.type === 'file') {
    if (!/sessions\.db$/i.test(String(target))) return []
    candidates.push(String(target))
  } else {
    // <dataDir>/db/sessions.db（target 为 <dataDir> 或 <sessionsDir> 两种入口都对）
    candidates.push(join(target, 'db', 'sessions.db'))
    candidates.push(join(target, '..', 'db', 'sessions.db'))
  }
  for (const dbPath of candidates) {
    const dbStat = await host.stat(dbPath)
    if (!dbStat || dbStat.type !== 'file') continue
    const fp = await sqliteFingerprint(host, dbStat, dbPath)
    const entries = await probeSource(bm, 'cline', dbPath, fp, async () => {
      const sessions = await host.readSessions('cline', dbPath)
      if (!sessions || sessions.length === 0) return []
      const sessionsDir = join(dbPath, '..', '..', 'sessions')
      const out = []
      for (const s of sessions) {
        const path = s.messagesPath && /[\\/]/.test(s.messagesPath)
          ? s.messagesPath
          : clineMessagesPath(sessionsDir, s.id)
        const mst = await host.stat(path)
        // 转写缺失（会话已删 / 尚未落盘）→ 不列出：面板里点了也导不进来
        if (!mst || mst.type !== 'file') continue
        const title = await clineEntryTitle(host, sessionsDir, s)
        out.push(makeEntry({
          format: 'cline', sessionId: s.id, title,
          project: projectFromRecord(s.cwd, () => null),
          createdAt: s.createdAt ?? undefined, lastActiveAt: s.lastActiveAt ?? mst.mtimeMs,
          sourcePath: path, cwd: s.cwd,
        }))
      }
      return out
    })
    await emitEach(emit, entries)
    return entries
  }
  // 回退：DB 不可用 → 扫目录里的转写文件（可能来自用户显式传的 sessions 目录）
  const files = []
  await walkFiles(host, target, files, (name) => /\.messages\.json$/i.test(name))
  const out = []
  for (const file of files) {
    const base = basenameOf(file.name)
    const sessionId = base.replace(/\.messages\.json$/i, '')
    // 子代理/团队消息文件（<agentId>.messages.json，与目录名不同名）不是独立会话：
    // 目录名才是 sessionId，故同目录内除 <dir>.messages.json 之外的文件一律不算会话
    const dirName = String(file.path).replace(/\\/g, '/').split('/').slice(-2, -1)[0]
    if (dirName && sessionId !== dirName) continue
    const st2 = await host.stat(file.path)
    if (!st2) continue
    const fp = { mtimeMs: st2.mtimeMs, sizeBytes: st2.size }
    const entries = await probeSource(bm, 'cline', file.path, fp, async () => {
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      // 结构签名：SDK v1 转写顶层有 version + sessionId + messages
      if (!/"version"\s*:\s*\d+/.test(head) || !/"sessionId"\s*:/.test(head) || !/"messages"\s*:\s*\[/.test(head)) {
        return []
      }
      const agent = /"agent"\s*:\s*"([^"]+)"/.exec(head)
      if (agent && agent[1] !== 'lead') return [] // 子代理 / 团队任务不单独成会话
      const updatedAt = /"updated_at"\s*:\s*"([^"]+)"/.exec(head)
      const manifestPath = join(file.path, '..', sessionId + '.json')
      const man = readClineManifest(await host.readHead(manifestPath, HEAD_MAX_BYTES))
      return [makeEntry({
        format: 'cline', sessionId,
        title: normalizeTitle(man && man.title ? man.title : ''),
        project: projectFromRecord(man && man.cwd, () => null),
        createdAt: parseTimeValue(man && man.startedAt),
        lastActiveAt: parseTimeValue(updatedAt && updatedAt[1]) ?? st2.mtimeMs,
        sourcePath: file.path, cwd: (man && man.cwd) || null,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// 条目标题：DB 的 metadata_json.title 优先，为空才读 manifest（少读一个文件是常态路径）。
async function clineEntryTitle(host, sessionsDir, s) {
  if (typeof s.title === 'string' && s.title.trim()) return normalizeTitle(s.title)
  const manifestPath = join(sessionsDir, s.id, s.id + '.json')
  const man = readClineManifest(await host.readHead(manifestPath, HEAD_MAX_BYTES))
  if (man && man.title.trim()) return normalizeTitle(man.title)
  return normalizeTitle(typeof s.prompt === 'string' ? s.prompt : '')
}

// goose：<dataDir>/sessions/sessions.db（SQLite 一库多会话，经 host.readSessions 复用
// lib/sources/goose.mjs）。旧版 sessions/*.jsonl **不扫**：上游只在首次建库时全量迁移且不删旧文件，
// 扫它们会与库里的同一批会话重复导入。
function scanGoose(host, target, bm, emit) {
  return scanSqlite(host, 'goose', target, 'sessions.db', bm, emit)
}

// zed：<data_dir>/threads/threads.db（单表 threads + zstd blob，经 host.readSessions 复用
// lib/sources/zed.mjs）。子代理线程（parent_id 非空）由读取层过滤。
function scanZed(host, target, bm, emit) {
  return scanSqlite(host, 'zed', target, 'threads.db', bm, emit)
}

// crush：库是**项目内**的 <数据目录>/crush.db（默认 <项目>/.crush）。发现依赖三条线索：
//   ① 用户级 projects.json（`{"projects":[{path,data_dir,last_accessed}]}`）——每个 data_dir
//      指向一个绝对库路径；② 宿主工作区列表（host.listWorkspaces）→ 逐个探测
//      <工作区>/.crush/crush.db；③ 显式 path（项目目录 / 数据目录 / crush.db 本身）。
// DB 里**没有 cwd** → 会话项目取注册表里的项目路径，回退「库目录以 .crush 结尾 → 父目录」。
async function scanCrush(host, target, bm, emit) {
  const st = await host.stat(target)
  if (!st) return []
  const dbPaths = []
  const seen = new Set()
  const pushDb = async (p) => {
    const s = await host.stat(p)
    if (s && s.type === 'file' && !seen.has(p)) { seen.add(p); dbPaths.push(p) }
  }
  const projects = new Map() // dbDir(归一) → 项目路径
  const norm = (p) => String(p ?? '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  if (st.type === 'file') {
    if (!/crush\.db$/i.test(String(target))) return []
    await pushDb(target)
  } else {
    // 目标自己就是项目目录 / 数据目录 / 用户级目录
    await pushDb(join(target, '.crush', 'crush.db'))
    await pushDb(join(target, 'crush.db'))
    const registryRaw = await host.readText(join(target, 'projects.json'))
    for (const entry of parseCrushProjects(registryRaw)) {
      const dbPath = entry.dataDir ? join(entry.dataDir, 'crush.db') : crushProjectDbPath(entry.path)
      await pushDb(dbPath)
      projects.set(norm(entry.dataDir || join(entry.path, '.crush')), entry.path)
    }
    // 宿主已知工作区（DSH 里注册/打开过的项目）→ 项目内探测。**只在目标是用户级数据目录时**
    // 才做：用户显式指定某个项目目录时，不该顺带把别的项目也扫进来。
    const isUserDataDir = /[\\/]crush$/i.test(String(target))
      || (await host.stat(join(target, 'projects.json'))) !== null
    if (isUserDataDir && typeof host.listWorkspaces === 'function') {
      for (const ws of await host.listWorkspaces()) await pushDb(crushProjectDbPath(ws))
    }
  }
  const out = []
  for (const dbPath of dbPaths) {
    const dbStat = await host.stat(dbPath)
    if (!dbStat) continue
    const fp = await sqliteFingerprint(host, dbStat, dbPath)
    const dir = dbPath.replace(/[\\/][^\\/]*$/, '')
    const projectPath = projects.get(norm(dir)) || (/[\\/]\.crush$/i.test(dir) ? dir.replace(/[\\/]\.crush$/i, '') : null)
    const entries = await probeSource(bm, 'crush', dbPath, fp, async () => {
      const sessions = await host.readSessions('crush', dbPath)
      if (!sessions) return []
      return sessions.map((s) => makeEntry({
        format: 'crush', sessionId: s.id, title: normalizeTitle(s.title),
        project: projectFromRecord(projectPath, () => null),
        createdAt: s.createdAt ?? undefined, lastActiveAt: s.updatedAt ?? dbStat.mtimeMs,
        sourcePath: dbPath, cwd: projectPath,
      }))
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

// importStatus：查 imports registry（调用方 loadImports 后传入的 imports 映射）。
// single 源（claude/codex/.../hermes-jsonl）路径命中 → imported；multi 源
//（opencode/zcode/hermes-db/chatgpt）按会话 id 查子表——命中 → imported、子表非空但
// 本会话不在 → partial（源已部分导入）、否则 not-imported。archivedIds（可选，Set/
// 数组）为 workspaceRegistry 的全局归档集：记录关联的会话已被归档（隐藏但仍占 id）
// → 'archived'，供面板/scan_discover 显示可重导而非已导入。
//
// persistedIds（可选，Set/数组）为宿主当前持久化的会话 id 集合：注册表记录指向的会话
// **已不在宿主**（被删除）→ 'not-imported'，而不是 'imported'。否则面板会把一个已经
// 没有对应会话的源显示成「同步」（同步的语义是给已存在的会话追加新轮次，会话没了就无从
// 同步），用户也没法把它重新导入。已删除优先于已归档：归档后又被删除同样是 not-imported。
export function resolveImportStatus(imports, sourcePath, sessionId, archivedIds, persistedIds) {
  const archived = archivedIds instanceof Set ? archivedIds
    : Array.isArray(archivedIds) ? new Set(archivedIds) : null
  const persisted = persistedIds instanceof Set ? persistedIds
    : Array.isArray(persistedIds) ? new Set(persistedIds) : null
  const isArchived = (id) => archived !== null && typeof id === 'string' && archived.has(id)
  const isGone = (id) => persisted !== null && typeof id === 'string' && !persisted.has(id)
  // 记录关联会话的状态：宿主里已不存在 → 未导入；存在但已归档 → archived；否则已导入。
  const statusOf = (id) => {
    if (isGone(id)) return 'not-imported'
    return isArchived(id) ? 'archived' : 'imported'
  }
  const record = imports && typeof imports === 'object' ? imports[sourcePath] : undefined
  if (record === undefined) return 'not-imported'
  if (typeof record === 'string') return statusOf(record) // 旧版纯字符串记录
  if (!record || typeof record !== 'object') return 'not-imported'
  if (record.kind === 'multi') {
    const sub = record.conversations || record.sessions
    if (sub && typeof sub === 'object') {
      const own = sub[sessionId]
      if (typeof own === 'string') return statusOf(own) // 旧版子表字符串记录
      if (own && typeof own === 'object' && typeof own.dshId === 'string') return statusOf(own.dshId)
      if (Object.keys(sub).length > 0) return 'partial'
    }
    return 'not-imported'
  }
  if (typeof record.dshId === 'string') return statusOf(record.dshId)
  return 'imported'
}

// ── git 状态─────────────────────────────────────────────────────
// 会话条目的 git 分支/dirty：探针目录 = 条目 cwd（记录内完整路径）或源文件目录。
// 纯 JS 解析 .git/HEAD 拿分支名（向上找 .git 目录或 .git 文件，兼容 worktree）；
// 非仓库 / 权限失败一律 null（静默缺省）。gitDirty 因无法在不调用 git 命令的
// 前提下可靠判断，降级为 null（安全扫描将 child_process 判为 critical，路线 A
// 已移除所有 execFileSync）。结果按探针目录缓存（一次扫描内复用，Promise 记忆化
// 支持并发去重）；只在 discoverSessions 后处理里计算——不入 TTL/书签缓存（分支是
// 扫描时刻的瞬时状态，缓存会过期）。async（fs/promises）：扫描在宿主事件循环上
// 跑，同步 stat/readFile 会在后台扫描期间冻住整个 Web 服务（面板轮询/其它请求）。
async function gitStatusOf(probe, cache) {
  if (typeof probe !== 'string' || !probe.trim() || cache.has(probe)) {
    return cache.get(probe) || { gitBranch: null, gitDirty: null }
  }
  const p = computeGitStatus(probe).catch(() => ({ gitBranch: null, gitDirty: null }))
  cache.set(probe, p)
  return p
}

async function findGitDir(probe) {
  let dir = resolve(probe)
  for (;;) {
    const dotGit = join(dir, '.git')
    try {
      const st = await fstat(dotGit)
      if (st.isDirectory()) return dotGit
      if (st.isFile()) {
        // worktree/submodule：.git 是指向真实 git 目录的 gitdir: 文件
        const content = (await fread(dotGit, 'utf8')).trim()
        const m = /^gitdir:\s*(.+)$/.exec(content)
        if (m) return m[1].trim()
      }
    } catch {
      // 继续向上找
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

async function computeGitStatus(probe) {
  const gitDir = await findGitDir(probe)
  if (!gitDir) return { gitBranch: null, gitDirty: null }
  try {
    const head = (await fread(join(gitDir, 'HEAD'), 'utf8')).trim()
    const m = /^ref:\s+refs\/heads\/(.+)$/.exec(head)
    const branch = m ? m[1] : head.slice(0, 7) // detached HEAD：短 hash 近似
    return { gitBranch: branch || null, gitDirty: null }
  } catch {
    return { gitBranch: null, gitDirty: null }
  }
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
