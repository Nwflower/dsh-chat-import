// lib/discovery-host.mjs — REQ-25/REQ-40 会话发现（scan_discover 只读工具）host 适配
//
// 发现核心在 lib/discovery.mjs（纯函数，host 注入）。这里把 ctx.fs 与 SQLite 读取器
// 适配成 host：stat/readHead/readText/readDir + readSessions（复用 readOpencodeDb /
// readZcodeDb / readHermesDb，不重写 SQL）。readHead 优先走 streamText 有界读头
//（大 transcript 不整读）；无 streamText（如测试 mock）回退 readText 截断。
// REQ-41 面板路由（lib/panel.mjs）与 scan_discover 共用 makeDiscoveryHost。

import { join } from 'node:path'
import { discoverSessions } from './discovery.mjs'
import { readOpencodeDb } from './opencode.mjs'
import { readMimocodeDb } from './mimocode.mjs'
import { readZcodeDb } from './zcode.mjs'
import { readHermesDb } from './hermes.mjs'
import { loadImports, archivedSessionIds } from './imports.mjs'
import { resolveCursorSlugPath } from './cwd-map.mjs'

// SQLite 会话摘要（发现用）：每会话 id/title/directory/createdAt/lastActiveAt/
// messageCount。读不到（缺失/锁定/非 SQLite）返回 null，发现层按该格式无会话处理。
function dbSessionSummaries(kind, dbPath) {
  try {
    if (kind === 'opencode') {
      return readOpencodeDb(dbPath).map((s) => dbSummary(s, 'createdAt'))
    }
    // mimocode 是 opencode fork（schema 同构），readMimocodeDb 复用通用读取器并
    // 剔除 MiMo 后台任务会话（checkpoint-writer / AutoDream / AutoDistill）
    if (kind === 'mimocode') {
      return readMimocodeDb(dbPath).map((s) => dbSummary(s, 'createdAt'))
    }
    if (kind === 'zcode') {
      return readZcodeDb(dbPath).map((s) => dbSummary(s, 'createdAt'))
    }
    if (kind === 'hermes') {
      const rows = readHermesDb(dbPath)
      return rows === null ? null : rows.map((s) => ({
        id: s.id, title: s.title, directory: s.cwd,
        createdAt: s.createdAt, lastActiveAt: lastMsgTime(s.messages, 'ts'),
        messageCount: s.messages.length,
      }))
    }
  } catch {
    // 读不到 / 锁定 / 非 SQLite：按无该格式会话处理（发现是预览，不抛）
  }
  return null
}

function dbSummary(s, timeKey) {
  return {
    id: s.id, title: s.title, directory: s.directory,
    createdAt: s.createdAt, lastActiveAt: lastMsgTime(s.messages, timeKey),
    messageCount: s.messages.length,
  }
}

// 最后一条消息时间（最近活跃近似）；无消息/无时间 → undefined。
function lastMsgTime(messages, key) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const v = messages[i] && messages[i][key]
    if (typeof v === 'number') return v
  }
  return undefined
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
        const target = await resolve(path)
        if (typeof fs.streamText === 'function') {
          // 有界读头：取到 maxBytes 即停（for-await break 自动 close 迭代器）
          const iter = await fs.streamText(target)
          let out = ''
          for await (const chunk of iter) {
            out += chunk
            if (out.length >= maxBytes) break
          }
          return out.slice(0, maxBytes)
        }
        const text = await fs.readText(target)
        return text.slice(0, maxBytes)
      } catch {
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
    async readSessions(kind, dbPath) {
      return dbSessionSummaries(kind, dbPath)
    },
    resolveCursorSlug(slug) {
      return resolveCursorSlugPath(ctx, slug)
    },
  }
}

// scan_discover 执行：registry 只读 loadImports（importStatus 标注）+ workspaceRegistry
// 全局归档集（已归档会话标注 'archived'，供重导预览），发现层零副作用（不写库、不
// create/append、不 touch 任何会话）。30s TTL 缓存由 discovery 模块持有；REQ-40 持久化
// mtime/size 书签落 $DSH_HOME/dsh-chat-import/scan-cache.json（与 imports registry
// 同目录），跨进程未变文件免重扫（写盘原子写，失败不影响扫描结果）。
export async function runScanDiscover(ctx, args, registryDir) {
  const registry = await loadImports(registryDir)
  return discoverSessions({
    path: args.path,
    format: args.format,
    query: args.query,
    host: makeDiscoveryHost(ctx),
    imports: registry.imports,
    cacheDir: registryDir,
    archivedIds: archivedSessionIds(ctx),
  })
}
