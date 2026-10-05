// test/_support/discovery-host.mjs — 发现层用例共用的 host（lib/discovery.mjs 的注入面：stat /
// readHead / readTail / readText / readDir / readSessions）。
//
//   memoryHost(files)  内存 host：path → 节点的 Map，可观测读计数。节点：{ type: 'dir' } |
//                      { type: 'file', text, mtimeMs? }。子项按「前缀 + 无更深分隔符」判定，分隔符
//                      跟随父路径（Windows / POSIX 夹具都能用）。counters 记录调用次数，dirsByPath
//                      记录每个目录被列举的次数（验证一次发现内的目录列举记忆化）。readSessions 委托
//                      host.dbSessions（可选）。
//   withDirs(root, files)  补齐夹具里文件路径的全部祖先目录节点。
//   diskHost({ readSessions })  真实磁盘 host（夹具写进临时目录）：stat 给 { type, size, mtimeMs }，
//                      readHead 只读前 maxBytes 字节，读不了的文件 / 目录回 null；readSessions 由用例
//                      注入（数据库源的摘要读取器），缺省 null。
import { open, readFile, readdir, stat } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { join } from 'node:path'

export function memoryHost(files) {
  const counters = { reads: 0, stats: 0, dirs: 0, db: 0, tails: 0 }
  const dirsByPath = new Map()
  const sep = (p) => (String(p).includes('\\') ? '\\' : '/')
  const host = {
    counters,
    dirsByPath,
    dbSessions: null,
    async stat(path) {
      counters.stats++
      const v = files.get(path)
      if (!v) return null
      return v.type === 'dir' ? { type: 'directory' } : { type: 'file', size: v.text.length, mtimeMs: v.mtimeMs }
    },
    async readText(path) {
      counters.reads++
      const v = files.get(path)
      return v && v.type === 'file' ? v.text : null
    },
    async readHead(path, maxBytes) {
      counters.reads++
      const v = files.get(path)
      return v && v.type === 'file' ? v.text.slice(0, maxBytes) : null
    },
    async readTail(path, maxBytes) {
      counters.reads++
      counters.tails++
      const v = files.get(path)
      return v && v.type === 'file' ? v.text.slice(-maxBytes) : null
    },
    async readDir(path) {
      counters.dirs++
      dirsByPath.set(path, (dirsByPath.get(path) || 0) + 1)
      const s = sep(path)
      const prefix = String(path).endsWith(s) ? String(path) : String(path) + s
      const out = []
      for (const [p, v] of files) {
        if (!p.startsWith(prefix) || p === prefix) continue
        const rest = p.slice(prefix.length)
        if (rest.includes('\\') || rest.includes('/')) continue
        out.push({ name: rest, type: v.type === 'dir' ? 'directory' : 'file', path: p })
      }
      return out.sort((a, b) => a.name.localeCompare(b.name))
    },
    async readSessions(kind, dbPath) {
      counters.db++
      return typeof host.dbSessions === 'function' ? host.dbSessions(kind, dbPath) : null
    },
  }
  return host
}

// 把若干文件路径的全部祖先目录（root 及以下）登记为 dir 节点，省去夹具里逐层手写目录。
export function withDirs(root, files) {
  const sep = String(root).includes('\\') ? '\\' : '/'
  const out = new Map(files)
  out.set(root, { type: 'dir' })
  for (const p of files.keys()) {
    if (!p.startsWith(root + sep)) continue
    const parts = p.slice(root.length + 1).split(sep)
    let cur = root
    for (const part of parts.slice(0, -1)) {
      cur = cur + sep + part
      if (!out.has(cur)) out.set(cur, { type: 'dir' })
    }
  }
  return out
}

export function diskHost({ readSessions } = {}) {
  return {
    async stat(path) {
      try {
        const s = await stat(path)
        return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, mtimeMs: s.mtimeMs }
      } catch {
        return null // 不存在 / 不可访问
      }
    },
    async readHead(path, maxBytes) {
      let fh
      try {
        fh = await open(path, 'r')
        const b = Buffer.alloc(Math.min(maxBytes, 64 * 1024))
        const { bytesRead } = await fh.read(b, 0, b.length, 0)
        return b.subarray(0, bytesRead).toString('utf8')
      } catch {
        return null // 不存在 / 是目录
      } finally {
        if (fh) await fh.close()
      }
    },
    async readText(path) {
      try { return await readFile(path, 'utf8') } catch { /* 不存在 / 是目录 */ return null }
    },
    async readDir(path) {
      let entries
      try { entries = await readdir(path, { withFileTypes: true }) } catch { /* 目录不存在 */ return null }
      return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file', path: join(path, e.name) }))
    },
    async readSessions(kind, dbPath) {
      return typeof readSessions === 'function' ? readSessions(kind, dbPath) : null
    },
  }
}
