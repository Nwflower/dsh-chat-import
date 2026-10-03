// lib/upload.mjs — 浏览器侧会话文件的上传暂存（面板「从文件导入」的上传通道）
//
// 为什么需要它：浏览器页面拿不到本地文件路径，只有 File 对象；把文件分片 POST 给宿主是
// 远程部署（反代后、无本地盘访问）唯一能把文件送进导入管道的路。本机桌面端走路径直读，
// 不经过这里（见 lib/file-import.mjs 的路径模式）。
//
// 协议（HTTP 路由在 lib/panel.mjs；本文件只管状态与磁盘）：
//   init     { name, size, sha256 }      → { uploadId, chunkSize, receivedOffset, completed?, path? }
//   chunk    { uploadId, offset, data }  → { receivedOffset }
//   complete { uploadId }                → { path }
// 不变式与防护：
//   * init 幂等：同 (sha256, size) 收敛到同一 uploadId——页面刷新 / 断线后客户端拿
//     receivedOffset 续传，已传完的会话直接回 completed + path（零重传）；
//   * offset 必须等于已收字节数（乱序、重放、空洞一律拒绝），分片只追加；
//   * complete 复核整文件 sha256，与 init 声明不符即拒绝并保留分片（可重传纠错）；
//   * 配额：单文件 ≤ MAX_UPLOAD_BYTES（默认 256MiB，env DSH_IMPORT_UPLOAD_MAX_BYTES）、
//     暂存总量 ≤ MAX_STAGING_BYTES（默认 2GiB），超限拒绝新 init（不静默丢旧件）；
//   * 文件名 sanitize（只取 basename、去控制字符、限长 120），落点固定在
//     <registryDir>/uploads/<uploadId>/ 内，路径不可逃逸；
//   * 未完成上传 24h 后由 gcUploads 回收（每次 init 顺带惰性回收，路由另有显式清理）。
//
// 暂存文件的生命周期：导入后**保留**——registry 以该路径为源键，D13 的「源增长 → 增量
// 续写」依赖源文件仍在；历史页删除条目或显式清理时由调用方 removeUpload。
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** 起始分片大小：base64 后约 853KiB，稳在常见反代 1MiB body 限制之下（413 时客户端减半）。 */
export const UPLOAD_CHUNK_SIZE = 640 * 1024
/** 单文件上限（字节）。 */
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024
/** 暂存目录总量上限（字节）。 */
export const MAX_STAGING_BYTES = 2 * 1024 * 1024 * 1024
/** 未完成上传的回收时限。 */
export const UPLOAD_IDLE_MS = 24 * 60 * 60 * 1000

export function uploadsDir(registryDir) {
  return join(registryDir, 'uploads')
}

export function maxUploadBytes() {
  const raw = Number(process.env.DSH_IMPORT_UPLOAD_MAX_BYTES)
  return Number.isSafeInteger(raw) && raw > 0 ? raw : MAX_UPLOAD_BYTES
}

// 展示名 → 暂存文件名：只取 basename、去控制字符与路径分隔、折叠空白、限长；空则回退
// 'upload'。绝不用于拼接目录（目录由 uploadId 决定）。
export function sanitizeUploadName(name) {
  const base = basename(String(name || '').replace(/[\u0000-\u001f\u007f]/g, '')).replace(/[\\/]/g, '')
  const trimmed = base.trim().replace(/\s+/g, '_')
  if (!trimmed || trimmed === '.' || trimmed === '..') return 'upload'
  return trimmed.length > 120 ? trimmed.slice(-120) : trimmed
}

function manifestPath(registryDir, uploadId) {
  return join(uploadsDir(registryDir), uploadId, 'manifest.json')
}
function dataPath(registryDir, uploadId) {
  return join(uploadsDir(registryDir), uploadId, 'data')
}

async function readManifest(registryDir, uploadId) {
  // uploadId 来自网络：只接受 UUID 形态，杜绝 '../' 之类的目录穿越
  if (!/^[0-9a-f-]{36}$/i.test(String(uploadId || ''))) return null
  try {
    return JSON.parse(await readFile(manifestPath(registryDir, uploadId), 'utf8'))
  } catch {
    return null // 目录不存在 / manifest 损坏：一律当「没有这个上传」，由调用方报错
  }
}

async function writeManifest(registryDir, manifest) {
  const file = manifestPath(registryDir, manifest.uploadId)
  await mkdir(join(uploadsDir(registryDir), manifest.uploadId), { recursive: true })
  // 先写临时文件再改名：manifest 是续传状态的唯一真相，半截写入会让续传位置回退/错乱
  const tmp = file + '.tmp'
  await writeFile(tmp, JSON.stringify(manifest), 'utf8')
  await rename(tmp, file)
}

// 按 sha256 找已完成/在传的同指纹上传（幂等 init 的判据）。
async function findByHash(registryDir, sha256, size) {
  const root = uploadsDir(registryDir)
  let ids = []
  try { ids = await readdir(root) } catch { return null }
  for (const id of ids) {
    const m = await readManifest(registryDir, id)
    if (m && m.sha256 === sha256 && m.size === size) return m
  }
  return null
}

async function stagingBytes(registryDir) {
  const root = uploadsDir(registryDir)
  let ids = []
  try { ids = await readdir(root) } catch { return 0 }
  let total = 0
  for (const id of ids) {
    const m = await readManifest(registryDir, id)
    if (m && typeof m.received === 'number') total += m.received
  }
  return total
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * 打开（或续传）一个上传。同 (sha256, size) 的既有上传原样返回——这是断线与刷新后的
 * 续传入口，也是同一文件重复上传的幂等闸。
 */
export async function uploadInit(registryDir, { name, size, sha256 } = {}) {
  if (!Number.isSafeInteger(size) || size <= 0) {
    return { ok: false, code: 'invalid-size', error: '文件大小非法' }
  }
  if (size > maxUploadBytes()) {
    return { ok: false, code: 'too-large', error: '文件超过单文件上限 ' + maxUploadBytes() + ' 字节' }
  }
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) {
    return { ok: false, code: 'invalid-hash', error: '缺少 sha256 指纹（客户端负责计算）' }
  }
  await gcUploads(registryDir)
  const existing = await findByHash(registryDir, sha256.toLowerCase(), size)
  if (existing) {
    return {
      ok: true, uploadId: existing.uploadId, chunkSize: UPLOAD_CHUNK_SIZE,
      receivedOffset: existing.received,
      ...(existing.completed ? { completed: true, path: existing.path } : {}),
    }
  }
  if (await stagingBytes(registryDir) + size > MAX_STAGING_BYTES) {
    return { ok: false, code: 'staging-full', error: '上传暂存已满，请先清理暂存目录' }
  }
  const uploadId = randomUUID()
  const manifest = {
    uploadId,
    name: sanitizeUploadName(name),
    size,
    sha256: sha256.toLowerCase(),
    received: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completed: false,
  }
  await writeManifest(registryDir, manifest)
  await writeFile(dataPath(registryDir, uploadId), Buffer.alloc(0))
  return { ok: true, uploadId, chunkSize: UPLOAD_CHUNK_SIZE, receivedOffset: 0 }
}

/** 追加一个分片（offset 必须接在已收字节之后）。 */
export async function uploadChunk(registryDir, { uploadId, offset, data } = {}) {
  const manifest = await readManifest(registryDir, uploadId)
  if (!manifest) return { ok: false, code: 'not-found', error: '上传不存在或已过期' }
  if (manifest.completed) return { ok: false, code: 'completed', error: '该上传已完成，无需再传分片' }
  if (!Number.isSafeInteger(offset) || offset !== manifest.received) {
    // 断线重连时客户端可能落后/超前：把真实位置带回去，让它对齐后续传（不是静默丢弃）
    return { ok: false, code: 'offset-mismatch', error: '分片偏移不符', receivedOffset: manifest.received }
  }
  let buffer
  try {
    buffer = Buffer.from(String(data || ''), 'base64')
  } catch {
    return { ok: false, code: 'bad-chunk', error: '分片不是合法 base64' }
  }
  if (buffer.length === 0) return { ok: false, code: 'bad-chunk', error: '空分片' }
  if (manifest.received + buffer.length > manifest.size) {
    return { ok: false, code: 'overflow', error: '分片越过文件末尾', receivedOffset: manifest.received }
  }
  await appendFile(dataPath(registryDir, uploadId), buffer)
  manifest.received += buffer.length
  manifest.updatedAt = Date.now()
  await writeManifest(registryDir, manifest)
  return { ok: true, receivedOffset: manifest.received }
}

/** 收尾：整文件指纹复核 → 改名到最终路径（幂等：重复调用返回同一路径）。 */
export async function uploadComplete(registryDir, { uploadId } = {}) {
  const manifest = await readManifest(registryDir, uploadId)
  if (!manifest) return { ok: false, code: 'not-found', error: '上传不存在或已过期' }
  if (manifest.completed && manifest.path) return { ok: true, path: manifest.path }
  if (manifest.received !== manifest.size) {
    return { ok: false, code: 'incomplete', error: '文件未传完', receivedOffset: manifest.received }
  }
  const bytes = await readFile(dataPath(registryDir, uploadId))
  const actual = sha256Hex(bytes)
  if (actual !== manifest.sha256) {
    // 指纹不符：保留分片供重传，但不产出可导入文件（损坏的数据绝不静默进管道）
    return { ok: false, code: 'hash-mismatch', error: 'sha256 校验失败（传输损坏）', receivedOffset: manifest.received }
  }
  const finalPath = join(uploadsDir(registryDir), uploadId, manifest.name)
  await rename(dataPath(registryDir, uploadId), finalPath)
  manifest.completed = true
  manifest.path = finalPath
  manifest.updatedAt = Date.now()
  await writeManifest(registryDir, manifest)
  return { ok: true, path: finalPath, name: manifest.name, size: manifest.size }
}

/**
 * 回收未完成上传（默认 24h 未更新）。已完成件绝不自动删除——它们是 registry 的源键。
 * @returns 回收条数。
 */
export async function gcUploads(registryDir, { maxAgeMs = UPLOAD_IDLE_MS, now = Date.now() } = {}) {
  const root = uploadsDir(registryDir)
  let ids = []
  try { ids = await readdir(root) } catch { return 0 }
  let removed = 0
  for (const id of ids) {
    const m = await readManifest(registryDir, id)
    if (!m) { await rm(join(root, id), { recursive: true, force: true }); removed += 1; continue }
    if (m.completed === true) continue
    if (now - (m.updatedAt || m.createdAt || 0) > maxAgeMs) {
      await rm(join(root, id), { recursive: true, force: true })
      removed += 1
    }
  }
  return removed
}

/** uploadId → 已完成的暂存文件路径（未完成 / 不存在返回 null）。路由与清理入口共用。 */
export async function uploadResolvedPath(registryDir, uploadId) {
  const manifest = await readManifest(registryDir, uploadId)
  return manifest && manifest.completed === true && manifest.path ? manifest.path : null
}

/** 删除一个上传（暂存文件 + 分片），历史页/撤回删除条目时调用。 */
export async function removeUpload(registryDir, uploadId) {
  const manifest = await readManifest(registryDir, uploadId)
  if (!manifest) return false
  await rm(join(uploadsDir(registryDir), uploadId), { recursive: true, force: true })
  return true
}

/**
 * 清理暂存：删除**未被 registry 引用**的已完成上传与全部未完成上传。
 * keepPaths 由调用方从 registry 记录的 sourcePath 收集（lib/imports.mjs）。
 */
export async function cleanupStaging(registryDir, keepPaths = []) {
  const root = uploadsDir(registryDir)
  const keep = new Set(keepPaths.map((p) => String(p).toLowerCase()))
  let ids = []
  try { ids = await readdir(root) } catch { return { removed: 0, kept: 0 } }
  let removed = 0
  let kept = 0
  for (const id of ids) {
    const m = await readManifest(registryDir, id)
    const referenced = m && m.path && keep.has(String(m.path).toLowerCase())
    if (m && (m.completed !== true || !referenced)) {
      await rm(join(root, id), { recursive: true, force: true })
      removed += 1
    } else {
      kept += 1
    }
  }
  return { removed, kept }
}

/** 暂存用量（面板展示与配额判断）。 */
export async function uploadsStats(registryDir) {
  const root = uploadsDir(registryDir)
  let ids = []
  try { ids = await readdir(root) } catch { ids = [] }
  let pending = 0
  let completed = 0
  let bytes = 0
  for (const id of ids) {
    const m = await readManifest(registryDir, id)
    if (!m) continue
    bytes += m.received || 0
    if (m.completed === true) completed += 1
    else pending += 1
  }
  return { pending, completed, bytes, limitBytes: MAX_STAGING_BYTES, dir: root }
}

/** 路径是否位于本插件的上传暂存目录内（面板据此给「来自上传」标记与清理入口）。 */
export function isUploadPath(registryDir, path) {
  const root = uploadsDir(registryDir)
  const p = String(path || '')
  const norm = (s) => s.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
  return norm(p).startsWith(norm(root) + '/')
}

/** 定期 stat 暂存文件（registry 记录比对用；文件被用户清掉时返回 null）。 */
export async function uploadFileStat(path) {
  try {
    const st = await stat(path)
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null
  } catch {
    return null
  }
}
