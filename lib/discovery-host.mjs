// lib/discovery-host.mjs — 会话发现（scan_discover 只读工具）host 适配
//
// 发现核心在 lib/discovery.mjs（纯函数，host 注入）。这里把 ctx.fs 与 SQLite 读取器
// 适配成 host：stat/readHead/readText/readDir + readSessions（发现层只取会话摘要——
// opencode/zcode/hermes 走各家 read*DbSummaries，只查 session 表、不读 message/part
// 正文：面板不再展示消息条数，不必为统计它整读消息并逐 cell JSON.parse，那是发现期
// 同步块的来源之一）。readHead 优先走 streamText 有界读头（大 transcript 不整读）；
// readTail 优先走 readByteRange 按偏移只读末尾窗口；readBytes 有界读原始字节（.zstd 日志）。
// 宿主 fs 缺对应能力时逐级回退（streamText → readText 截取）。
// 面板路由（lib/panel.mjs）与 scan_discover 共用 makeDiscoveryHost。

import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { TextDecoder } from 'node:util'
import { discoverSessions } from './discovery.mjs'
import { readOpencodeDbSummaries } from './sources/opencode.mjs'
import { readMimocodeDbSummaries } from './sources/mimocode.mjs'
import { readKilocodeDbSummaries } from './sources/kilocode.mjs'
import { readZcodeDbSummaries } from './sources/zcode.mjs'
import { readHermesDbSummaries } from './sources/hermes.mjs'
import { readClineDb } from './sources/cline.mjs'
import { readGooseSessions } from './sources/goose.mjs'
import { readZedThreads } from './sources/zed.mjs'
import { readCrushSessions } from './sources/crush.mjs'
import { readTraeDbSummaries } from './sources/trae.mjs'
import { loadImports, archivedSessionIds, listPersistedIds } from './imports.mjs'
import { resolveCursorSlugPath, knownWorkspacePaths } from './cwd-map.mjs'

// SQLite 会话摘要（发现用）：format → (dbPath) => [{ id, title, directory, createdAt, lastActiveAt, … }] | null。
// opencode 系（含 teleagent/mimocode/kilocode fork）/zcode/hermes/trae 走各自轻量摘要读取器
//（只查 session 表 + 每会话 MAX(time_created)，不读 message/part 正文）；goose/zed/crush/cline
// 本就是元数据级读取。读取器对「不是该来源的库」返回 null，发现层按该格式无会话处理。
// 键集合须与发现层描述符的 sessionsFromHost 一致（test/discovery-registry.test.mjs 对账）。
const DB_SUMMARY_READERS = {
  // opencode 与 teleagent 无发现期过滤（teleagent 是 opencode 派生、schema 同构）
  opencode: (dbPath) => readOpencodeDbSummaries(dbPath).map(pickSummary),
  teleagent: (dbPath) => readOpencodeDbSummaries(dbPath).map(pickSummary),
  // mimocode：摘要路径按标题前缀剔除后台任务会话（agent 双信号需读消息，摘要不读，
  // 见 mimocode.mjs；导入路径仍走 isMimocodeBackgroundSession 全量精确剔除）
  mimocode: (dbPath) => readMimocodeDbSummaries(dbPath).map(pickSummary),
  // kilocode：摘要路径按 parent_id / time_archived 列剔除子/归档会话（同全量口径，
  // SQL 层直接完成，见 kilocode.mjs）
  kilocode: (dbPath) => readKilocodeDbSummaries(dbPath).map(pickSummary),
  zcode: (dbPath) => readZcodeDbSummaries(dbPath).map(pickSummary),
  hermes: (dbPath) => mapRows(readHermesDbSummaries(dbPath), (s) => ({
    id: s.id, title: s.title, directory: s.cwd,
    createdAt: s.createdAt, lastActiveAt: s.lastActiveAt,
  })),
  // cline：sessions.db 只有元数据（无 title/message_count 列）→ 直接透传摘要，
  // 发现层再按需补 manifest 标题并 stat 校验转写是否存在
  cline: (dbPath) => mapRows(readClineDb(dbPath), (s) => ({
    id: s.id, title: s.title, prompt: s.prompt, directory: s.cwd,
    cwd: s.cwd, createdAt: s.createdAt, lastActiveAt: s.lastActiveAt,
    messagesPath: s.messagesPath,
  })),
  // goose：sessions.db 也是元数据 + 消息同库；发现只需摘要（sessionIds 过滤与
  // 逐会话导入在 lib/sources/goose.mjs，用 readGooseDb 读全量）
  goose: (dbPath) => mapRows(readGooseSessions(dbPath), (s) => ({
    id: s.id, title: s.title, directory: s.cwd,
    createdAt: s.createdAt ?? undefined, lastActiveAt: s.updatedAt ?? undefined,
  })),
  // zed：threads 单表（标题在 summary 列）；时间只有行级 created_at/updated_at（RFC3339），
  // 消息数需要解压每个 zstd blob 才有 → 发现层留空（保持廉价路径）
  zed: (dbPath) => mapRows(readZedThreads(dbPath), (s) => ({
    id: s.id, title: s.title, directory: s.cwd,
    createdAt: s.createdAt ? (Date.parse(s.createdAt) || undefined) : undefined,
    lastActiveAt: s.updatedAt ? (Date.parse(s.updatedAt) || undefined) : undefined,
  })),
  // crush：sessions 表有秒级时间戳；**没有 cwd 列** → directory 留空，
  // 项目路径由扫描器按注册表/库位置补（见 lib/discovery/sqlite.mjs 的 crush 扫描器）
  crush: (dbPath) => mapRows(readCrushSessions(dbPath), (s) => ({
    id: s.id, title: s.title, directory: null,
    createdAt: s.createdAt ?? undefined, lastActiveAt: s.updatedAt ?? undefined,
  })),
  trae: (dbPath) => readTraeDbSummaries(dbPath).map((s) => ({
    id: s.id, title: s.title, directory: s.directory,
    createdAt: s.createdAt, lastActiveAt: s.lastActiveAt,
  })),
}

/** host.readSessions 支持的 format（与发现层描述符的 sessionsFromHost 对账）。 */
export const DB_SUMMARY_FORMATS = Object.freeze(Object.keys(DB_SUMMARY_READERS))

function mapRows(rows, fn) {
  return rows === null ? null : rows.map(fn)
}


// 摘要读取器（opencode/zcode/hermes/fork）产出键名归一：directory 优先，cwd 兼容
// hermes 旧签名；只保留发现所需的字段（消息条数已不再展示，摘要里没有它）。
function pickSummary(s) {
  return {
    id: s.id,
    title: s.title,
    directory: s.directory ?? s.cwd,
    createdAt: s.createdAt,
    lastActiveAt: s.lastActiveAt,
  }
}

// 字节窗口 → 文本：窗口起点可能落在多字节字符中间，跳过开头的 UTF-8 续字节（至多 3 个）再解码；
// 被截断的首行由 JSONL 解析按畸形行丢弃。
function decodeUtf8Window(bytes, startsMidFile) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let start = 0
  if (startsMidFile) {
    while (start < buf.length && start < 3 && (buf[start] & 0xC0) === 0x80) start++
  }
  return new TextDecoder('utf-8').decode(buf.subarray(start))
}

export function makeDiscoveryHost(ctx) {
  const fs = ctx.fs
  const resolve = (p) => fs.resolve(p)
  return {
    async stat(path) {
      try {
        const info = await fs.stat(await resolve(path))
        return info ? { type: info.type, size: info.size, mtimeMs: info.mtimeMs } : null
      } catch {
        // 缺失 / 无权限：按不存在处理，发现层跳过该路径
        return null
      }
    },
    async readHead(path, maxBytes) {
      try {
        // 防御漏参：maxBytes 必须有限，否则 out.length>=maxBytes 恒 false、slice(0,undefined)
        // 返回全文 → 无界整读（discovery 曾有调用点漏传，antigravity 扫描读全文件）。
        const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 256 * 1024
        const target = await resolve(path)
        if (typeof fs.streamText === 'function') {
          // 有界读头：取到 maxBytes 即停（for-await break 自动 close 迭代器）
          const iter = await fs.streamText(target)
          let out = ''
          for await (const chunk of iter) {
            out += chunk
            if (out.length >= cap) break
          }
          return out.slice(0, cap)
        }
        const text = await fs.readText(target)
        return text.slice(0, cap)
      } catch {
        return null
      }
    },
    async readTail(path, maxBytes) {
      try {
        const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 64 * 1024
        const target = await resolve(path)
        if (typeof fs.readByteRange === 'function') {
          // 真尾读：按字节偏移只取末尾窗口，不流过整份文件（大 transcript 的尾部元数据路径）
          const info = await fs.stat(target)
          if (info && Number.isFinite(info.size)) {
            const offset = Math.max(0, info.size - cap)
            return decodeUtf8Window(await fs.readByteRange(target, { offset, length: cap }), offset > 0)
          }
        }
        if (typeof fs.streamText === 'function') {
          // 无字节窗口读的宿主：流式读到底，保留末尾 maxBytes 个字符。滚动窗口用 chunks 数组 +
          // 头部淘汰、最后一次性 join/slice（逐块 (tail+chunk).slice(-n) 会反复整串复制）。
          const iter = await fs.streamText(target)
          const chunks = []
          let total = 0
          for await (const chunk of iter) {
            const s = String(chunk)
            chunks.push(s)
            total += s.length
            while (total - chunks[0].length >= cap) {
              total -= chunks[0].length
              chunks.shift()
            }
          }
          return chunks.join('').slice(-cap)
        }
        const text = await fs.readText(target)
        return text.length > cap ? text.slice(-cap) : text
      } catch {
        return null
      }
    },
    // 有界读取整份文件的原始字节（不解码，供 .zstd 等二进制源）：超过 maxBytes 或读不到 → null。
    async readBytes(path, maxBytes) {
      try {
        const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 256 * 1024
        const target = await resolve(path)
        if (typeof fs.readBytes === 'function') return await fs.readBytes(target, undefined, cap)
        // 宿主 fs 无 readBytes：stat 守住上限后按宿主进程路径直读（与导入侧 readDshText 同口径）
        const info = await fs.stat(target)
        if (!info || info.type !== 'file' || !(info.size <= cap)) return null
        return await readFile(typeof fs.processPath === 'function' ? fs.processPath(target) : path)
      } catch {
        // 超限（FS_TOO_LARGE）/ 缺失 / 无权限：调用方按「内容不可得」降级
        return null
      }
    },
    async readText(path) {
      try {
        return await fs.readText(await resolve(path))
      } catch {
        // 缺失/非文本：null，发现层跳过该文件
        return null
      }
    },
    async readDir(path) {
      try {
        const entries = await fs.listDir(await resolve(path))
        return entries.map((e) => ({
          name: e.name,
          type: e.type,
          path: (e.target && (e.target.displayPath || e.target.targetKey)) || join(path, e.name),
        }))
      } catch {
        return null
      }
    },
    // 读取器对「不是该来源的库」返回 null；打不开 / 锁定 / 非 SQLite / 程序错误原样抛出——
    // 发现层把它记进该目标的 warnings，不再在这里静默成「无会话」。
    async readSessions(kind, dbPath) {
      const read = DB_SUMMARY_READERS[kind]
      return read ? read(dbPath) : null
    },
    resolveCursorSlug(slug) {
      return resolveCursorSlugPath(ctx, slug)
    },
    // 宿主侧「用户有哪些工作区」：项目内数据源（Crush 的 <项目>/.crush/crush.db）的发现入口。
    // 读不到就返回空数组（扫描器退化为只认显式 path / 用户级注册表）。
    async listWorkspaces() {
      try {
        return [...await knownWorkspacePaths(ctx)]
      } catch {
        return []
      }
    },
  }
}

// scan_discover 执行：registry 只读 loadImports（importStatus 标注）+ workspaceRegistry
// 全局归档集（已归档会话标注 'archived'，供重导预览），发现层零副作用（不写库、不
// create/append、不 touch 任何会话）。30s TTL 缓存由 discovery 模块持有；持久化
// mtime/size 书签落 $DSH_HOME/dsh-chat-import/scan-cache.json（与 imports registry
// 同目录），跨进程未变文件免重扫（写盘原子写，失败不影响扫描结果）。
export async function runScanDiscover(ctx, args, registryDir) {
  const registry = await loadImports(registryDir)
  // 工具输出 schema（lib/tools.mjs）尚未声明 warnings：只回 { sessions, total }，扫描失败由
  // discoverSessions 写进宿主日志
  const { sessions, total } = await discoverSessions({
    path: args.path,
    format: args.format,
    query: args.query,
    host: makeDiscoveryHost(ctx),
    imports: registry.imports,
    cacheDir: registryDir,
    archivedIds: archivedSessionIds(ctx),
    persistedIds: await listPersistedIds(ctx),
  })
  return { sessions, total }
}
