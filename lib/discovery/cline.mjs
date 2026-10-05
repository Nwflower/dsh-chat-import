// lib/discovery/cline.mjs — Cline 的发现：SDK 文件式存储（sessions.db 索引 + 每会话一目录）
// 与 SDK 迁移前的 VS Code globalStorage 旧版任务（taskHistory.json + tasks/<id>/）

import { join } from 'node:path'
import {
  clineLegacyTaskHistoryPath, clineLegacyUiMessagesPath, clineMessagesPath, parseClineLegacyTaskHistory,
  readClineManifest,
} from '../convert/cline.mjs'
import { normalizeTitle } from '../convert/util.mjs'
import {
  HEAD_MAX_BYTES, fileFingerprint, compositeFingerprint, basenameOf, dirnameOf, contentText, firstUserTitle,
  parseTimeValue, projectFromRecord, makeEntry, emitEach,
} from './common.mjs'
import { walkFiles } from './walk.mjs'
import { probeSource } from './scan-cache.mjs'
import { sqliteFingerprint } from './sqlite.mjs'

// cline 的目录解析（上游 sdk/packages/shared/src/storage/paths.ts）：
//   sessionsDir = $CLINE_SESSION_DATA_DIR → <dataDir>/sessions
//   dataDir     = $CLINE_DATA_DIR → <clineDir>/data
//   clineDir    = $CLINE_DIR → ~/.cline
// 另有 $CLINE_DB_DATA_DIR 只影响索引库所在目录（<dbDir>/sessions.db）。
function clineDataDir(home, env) {
  if (env.CLINE_DATA_DIR) return env.CLINE_DATA_DIR
  const clineDir = env.CLINE_DIR || join(home, '.cline')
  return join(clineDir, 'data')
}

function clineSessionsDir(home, env) {
  return env.CLINE_SESSION_DATA_DIR || join(clineDataDir(home, env), 'sessions')
}

// Before the SDK migration Cline stored VS Code tasks in the extension's
// globalStorage directory. Keep an explicit override for portable/remote VS
// Code profiles, then cover the standard stable, Insiders and VSCodium roots.
export function clineLegacyStorageDirs(home, env = process.env) {
  const override = env.CLINE_LEGACY_GLOBAL_STORAGE_DIR
    || env.CLINE_VSCODE_GLOBAL_STORAGE_DIR
  if (override) return [override]
  const names = ['Code', 'Code - Insiders', 'VSCodium']
  if (process.platform === 'win32') {
    if (!env.APPDATA) return []
    return names.map((name) => join(env.APPDATA, name, 'User', 'globalStorage', 'saoudrizwan.claude-dev'))
  }
  if (process.platform === 'darwin') {
    return names.map((name) => join(home, 'Library', 'Application Support', name, 'User', 'globalStorage', 'saoudrizwan.claude-dev'))
  }
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config')
  return names.map((name) => join(configHome, name, 'User', 'globalStorage', 'saoudrizwan.claude-dev'))
}

// 旧版任务路径解析（与 lib/sources/cline.mjs 的同名私有函数同口径；该模块未导出它们）：
// <globalStorage>/tasks/<id>/api_conversation_history.json → globalStorage 根 / 任务 id。
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

async function scanClineLegacy(host, target, { bm, emit }) {
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
    const apiStat = await host.stat(file.path)
    if (!apiStat || apiStat.type !== 'file') continue
    // 条目字段来自 api 历史（mtime / 标题回退）、taskHistory 索引项（标题 / cwd / 时间）与
    // ui_messages（标题回退）→ 三者的复合指纹
    const uiStat = await host.stat(clineLegacyUiMessagesPath(root, id))
    const fp = compositeFingerprint(apiStat, historyStat, uiStat)
    const entries = await probeSource(bm, 'cline', file.path, fp, async () => [makeEntry({
      format: 'cline', sessionId: id, title: await clineLegacyTitle(host, root, id, item, file.path),
      project: projectFromRecord(item && item.cwdOnTaskInitialization, () => null),
      createdAt: item ? parseTimeValue(item.ts) : undefined,
      lastActiveAt: apiStat.mtimeMs,
      sourcePath: file.path,
      cwd: item && typeof item.cwdOnTaskInitialization === 'string' ? item.cwdOnTaskInitialization : null,
    })])
    out.push(...entries)
  }
  await emitEach(emit, out)
  return out
}

// cline：文件式存储，每会话一目录 <sessionsDir>/<id>/，内有 <id>.messages.json（消息 +
// system_prompt）、<id>.json（manifest：metadata.title / cwd / started_at）与可选的
// <id>.compaction.json；子代理/团队任务的消息写在主会话目录内（<agentId>.messages.json），
// 不算独立会话。元数据索引在 <dataDir>/db/sessions.db（SQLite，只有元数据、用
// messages_path 指向转写）——**DB 优先**：拿权威会话清单 + cwd/时间/标题，逐个 stat 校验
// 转写是否存在；DB 不可用（老库缺列、锁定、非 Cline 库、用户只给了目录）则回退扫
// *.messages.json 并读 manifest 取元数据。标题优先 DB 的 metadata_json.title，为空才读
// manifest（上游 listSessions 同样以 manifest 的 metadata.title 覆盖 DB）。目标是旧版
// VS Code globalStorage（taskHistory.json + tasks/）时走旧版任务扫描。
async function scanCline(host, target, { bm, emit }) {
  const legacy = await scanClineLegacy(host, target, { bm, emit })
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
    const fp = fileFingerprint(st2)
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

// ── 来源描述符（注册与顺序见 ./registry.mjs；字段契约见该文件头）──────────────────

export const clineSource = {
  format: 'cline',
  sessionsFromHost: true,
  // SDK 会话目录与 SDK 迁移前的 VS Code globalStorage 根并列：两者文件布局不相交
  roots: (home, env) => [clineSessionsDir(home, env), ...clineLegacyStorageDirs(home, env)],
  scan: scanCline,
  // 转写 <sessionId>.messages.json / 旧版 tasks/<id>/api_conversation_history.json 独占；
  // 索引库 sessions.db 与 goose 同名，只作候选
  matchFile: (lower) => {
    if (/\.messages\.json$/.test(lower) || /[\\/]tasks[\\/][^\\/]+[\\/]api_conversation_history\.json$/.test(lower)) return 'only'
    return /sessions\.db$/.test(lower)
  },
}
