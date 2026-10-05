// lib/discovery/sqlite.mjs — SQLite 库族的发现：opencode 系（opencode/mimocode/kilocode/teleagent）、
// zcode、goose、zed、crush、trae、hermes
//
// 一库多会话；会话摘要一律经 host.readSessions(format, dbPath) 取（读取器在 host 侧，
// 见 lib/discovery-host.mjs）——本模块不直接打开 SQLite。书签指纹含 WAL 边车（sqliteFingerprint）。

import { join } from 'node:path'
import { crushProjectDbPath, parseCrushProjects } from '../convert/crush.mjs'
import { listTraeDatabases } from '../sources/trae.mjs'
import { normalizeTitle } from '../convert/util.mjs'
import {
  HEAD_MAX_BYTES, basenameOf, parseJsonlHead, contentText, firstUserTitle, parseTimeValue, firstNumber,
  projectFromRecord, makeEntry, emitEach,
} from './common.mjs'
import { walkFiles } from './walk.mjs'
import { probeSource } from './scan-cache.mjs'

// Trae Work / Trae CN use VS Code-style User roots. The SOLO variants are
// separate products but share the same workspaceStorage/globalStorage layout.
export function traeUserDataDirs(home) {
  const names = ['Trae', 'Trae CN', 'TRAE SOLO CN', 'TRAE SOLO']
  if (process.platform === 'win32') {
    if (!process.env.APPDATA) return []
    return names.map((name) => join(process.env.APPDATA, name, 'User'))
  }
  if (process.platform === 'darwin') {
    return names.map((name) => join(home, 'Library', 'Application Support', name, 'User'))
  }
  const configHome = process.env.XDG_CONFIG_HOME || join(home, '.config')
  return names.map((name) => join(configHome, name, 'User'))
}

// SQLite 库的扫描指纹：主文件 mtime/size + WAL 边车（-wal / -shm）stat 签名。WAL
// 模式下新写入只落 -wal，主文件在 checkpoint 前 mtime/size 不变——只看主文件会让
// 持久化书签命中过期缓存（面板长期显示旧会话列表、新会话不可见）。边车缺失记 '-'
//（checkpoint 删除 -wal 也构成指纹变化）。host.stat 返回 null/undefined 均按缺失。
export async function sqliteFingerprint(host, dbStat, dbPath) {
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

export function scanOpencode(host, target, bm, emit) { return scanSqlite(host, 'opencode', target, 'opencode.db', bm, emit) }

export function scanMimocode(host, target, bm, emit) { return scanSqlite(host, 'mimocode', target, 'mimocode.db', bm, emit) }

export function scanKilocode(host, target, bm, emit) { return scanSqlite(host, 'kilocode', target, 'kilo.db', bm, emit) }

export function scanZcode(host, target, bm, emit) { return scanSqlite(host, 'zcode', target, 'db.sqlite', bm, emit) }

// teleagent：opencode 派生（schema 同构），但落点是**多账户目录**
// ~/.local/share/TeleAgent/users/<账户ID>/teleagent.db（issue #60 实测）。三种目标形态：
//   账户目录（内含 teleagent.db）/ 库文件 → 标准 scanSqlite；
//   users/ 目录 → 枚举账户子目录逐库扫描；
//   TeleAgent/ 数据根 → 下钻一层 users/ 再枚举。
// （crush 的「枚举目录 → 候选 DB」是同一形态的先例。）
export async function scanTeleagent(host, target, bm, emit) {
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

// Trae Work：User 根下的 workspaceStorage/<hash>/state.vscdb 与 globalStorage/state.vscdb。
// listTraeDatabases 只展开这两种已知布局；每个库的摘要由 discovery-host 的只读读取器
// 提供，WAL 边车也纳入书签指纹，避免会话写入 WAL 后列表停留在旧状态。
export async function scanTrae(host, target, bm, emit) {
  const dbPaths = await listTraeDatabases(host, target)
  const out = []
  for (const dbPath of dbPaths) {
    const dbStat = await host.stat(dbPath)
    if (!dbStat) continue
    const fp = await sqliteFingerprint(host, dbStat, dbPath)
    const entries = await probeSource(bm, 'trae', dbPath, fp, async () => {
      const sessions = await host.readSessions('trae', dbPath)
      if (!sessions) return []
      return sessions.map((session) => makeEntry({
        format: 'trae',
        sessionId: session.id,
        title: normalizeTitle(session.title),
        project: projectFromRecord(session.directory, () => null),
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt,
        sourcePath: dbPath,
        cwd: session.directory || null,
      }))
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// goose：<dataDir>/sessions/sessions.db（SQLite 一库多会话，经 host.readSessions 复用
// lib/sources/goose.mjs）。旧版 sessions/*.jsonl **不扫**：上游只在首次建库时全量迁移且不删旧文件，
// 扫它们会与库里的同一批会话重复导入。
export function scanGoose(host, target, bm, emit) {
  return scanSqlite(host, 'goose', target, 'sessions.db', bm, emit)
}

// zed：<data_dir>/threads/threads.db（单表 threads + zstd blob，经 host.readSessions 复用
// lib/sources/zed.mjs）。子代理线程（parent_id 非空）由读取层过滤。
export function scanZed(host, target, bm, emit) {
  return scanSqlite(host, 'zed', target, 'threads.db', bm, emit)
}

// crush：库是**项目内**的 <数据目录>/crush.db（默认 <项目>/.crush）。发现依赖三条线索：
//   ① 用户级 projects.json（`{"projects":[{path,data_dir,last_accessed}]}`）——每个 data_dir
//      指向一个绝对库路径；② 宿主工作区列表（host.listWorkspaces）→ 逐个探测
//      <工作区>/.crush/crush.db；③ 显式 path（项目目录 / 数据目录 / crush.db 本身）。
// DB 里**没有 cwd** → 会话项目取注册表里的项目路径，回退「库目录以 .crush 结尾 → 父目录」。
export async function scanCrush(host, target, bm, emit) {
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

// hermes：~/.hermes/state.db（复用 readHermesDb，权威索引）→ 恒批量；db 不可用时回退
// 递归扫 sessions/*.jsonl（flat {role,content,ts} / nested {type:"session"|"message"}）。
function hermesUserText(r) {
  if (!r || typeof r !== 'object') return ''
  if (r.type === 'message' && r.message && typeof r.message === 'object' && r.message.role === 'user') return contentText(r.message.content)
  if (r.role === 'user') return contentText(r.content)
  return ''
}

export async function scanHermes(host, target, bm, emit) {
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
