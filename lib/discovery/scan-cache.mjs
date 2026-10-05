// lib/discovery/scan-cache.mjs — 扫描结果缓存：进程内 30s TTL、进行中扫描去重、scan-cache.json 持久化书签

import { join } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import { writeAtomic } from '../atomic-write.mjs'

export const SCAN_TTL_MS = 30000

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
export const scanCache = createScanCache()

export function clearScanCache() { scanCache.clear() }

// 进行中扫描去重（issue #16）：同 key 并发扫描共享一个 Promise，避免多个会话同时
// 启动时叠加全量扫描。key = `<format>|<target>`，与 TTL 缓存同口径。模块级共享——
// 同一 target 的物理状态是共享的，并发扫描结果必然相同。resolve 后自动清理。
export const inflightScans = new Map()

export function clearInflightScans() { inflightScans.clear() }

// ── 持久化 mtime/size 书签───────────────────────────────────────
// <cacheDir>/scan-cache.json：{ version, bookmarks: { <format>: { <sourcePath>:
// { mtimeMs, sizeBytes, entries } } } }。按 format 分表——同一源文件会被多种格式探测
//（无 format 的目录/文件探测），各格式提取结果不同，书签必须按格式隔离。entries = 该
// 源文件导出的会话条目（makeEntry 结果，importStatus 由 discoverSessions 统一填充，不
// 入书签）；多文件源的 mtimeMs 为复合串（grokbuild 会话目录两文件、openclaw 伴生
// sessions.json）。懒加载：进程内 30s TTL 命中时完全不碰盘，首次 get/remember 才读文件。
export const SCAN_CACHE_FILE = 'scan-cache.json'

// 书签条目的语义（某来源条目的字段口径、书签粒度）变化时递增；读到其它版本按空书签处理，
// 全量重扫一次后重写。
export const SCAN_CACHE_VERSION = 4

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

export async function createBookmarkStore(cacheDir) {
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

// 单源书签探测：fingerprint 命中 → 复用 entries，不读源内容；未命中 → probe() 重读
// 提取并写回书签（按 format 分表）。probe 返回 null（hermes db 不可用等）也入书签，调用方
// 按 null 处理。bm 为 null（未开持久化）时直接 probe。patchHit（可选）在命中时对旧条目做
// 读时补丁（返回 { entries, changed }，changed 时回写书签）——来源侧的派生字段口径演进时，
// 旧书签无需 bump SCAN_CACHE_VERSION 或重读源文件（见 cursor 扫描器）。
export async function probeSource(bm, format, sourcePath, fp, probe, patchHit) {
  if (!bm) return probe()
  const hit = await bm.get(format, sourcePath, fp)
  if (hit !== undefined) {
    if (hit !== null && typeof patchHit === 'function') {
      const patched = await patchHit(hit)
      if (patched.changed) await bm.remember(format, sourcePath, fp, patched.entries)
      return patched.entries
    }
    return hit
  }
  const entries = await probe()
  await bm.remember(format, sourcePath, fp, entries)
  return entries
}
