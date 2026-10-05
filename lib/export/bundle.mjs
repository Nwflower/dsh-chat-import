// lib/export/bundle.mjs — DSH 会话 → interchange bundle（纯函数，零 DSH 依赖）
//
// 通用可校验备份格式。bundle 是 interchange v1 的备份编码（事件级无损）：
//   文档见 docs/INTERCHANGE.md §4。导出 = 把会话日志（session 头 + 事件 JSONL）包进
//   信封 + 双层 SHA-256 指纹（会话级 sha256.session = hash(log)；文件级
//   sha256.bundle = hash(除 bundle 指纹外的全部字段规范化 JSON)）。损坏检测 =
//   还原时重算指纹比对，不匹配即大声报错（不静默）。
// 跨机器：originalCwd（机器相关原路径）+ landingHint（建议落点 basename）；
//   还原时原 cwd 不可达 → 按轻量 cwd 回退归组并报告（见 lib/restore.mjs）。

import { createHash } from 'node:crypto'
import { INTERCHANGE_MARKER } from '../convert/generic.mjs'

// bundle 命名空间与 interchange 文档的内容标记是同一字符串（文件导入的标记嗅探两者共用）
export const BUNDLE_NAMESPACE = INTERCHANGE_MARKER
export const BUNDLE_FORMAT = 'interchange-v1'
export const BUNDLE_VERSION = 1

// 事件日志 → 可还原的 JSONL 文本（convertDshJsonl 的直接输入）：session 头 +
// 按 seq 升序的事件行。事件行原样保留（surfaceOp / sourceEventSeqs / ignorable），
// 只把非字符串字段规范序列化（JSON.stringify 顺序由对象构造顺序决定——事件对象
// 原样 JSON.stringify，不改键序，保证指纹稳定）。
export function sessionLogToJsonl(meta, events) {
  const lines = []
  const header = { type: 'session' }
  if (meta && typeof meta.id === 'string' && meta.id) header.id = meta.id
  if (meta && typeof meta.cwd === 'string' && meta.cwd) header.cwd = meta.cwd
  if (meta && typeof meta.createdAt === 'number') header.createdAt = meta.createdAt
  lines.push(JSON.stringify(header))
  for (const ev of Array.isArray(events) ? events : []) {
    if (ev && typeof ev === 'object') lines.push(JSON.stringify(ev))
  }
  return lines.join('\n') + '\n'
}

function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

// 构造 bundle 文档（fingerprint 字段由本函数填充）。
export function serializeBundle({ meta, events, sourceSessionId, cwd, title, exportedAt = Date.now() }) {
  const log = sessionLogToJsonl(meta, events)
  const originalCwd = typeof cwd === 'string' && cwd ? cwd
    : (meta && typeof meta.cwd === 'string' && meta.cwd ? meta.cwd : null)
  const landingHint = originalCwd
    ? String(originalCwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || null
    : null
  const base = {
    bundle: BUNDLE_NAMESPACE,
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt,
    sourceSessionId,
    title: title || undefined,
    originalCwd,
    landingHint,
    log,
    sha256: { session: sha256Hex(log) },
  }
  return { ...base, sha256: { ...base.sha256, bundle: sha256Hex(canonicalBundleBody(base)) } }
}

// 文件级指纹的规范化输入：除 sha256.bundle 外的全部字段（键序稳定，测试确定性）。
function canonicalBundleBody(doc) {
  const { sha256, ...rest } = doc
  return JSON.stringify({ ...rest, sha256 })
}

// bundle 结构 + 指纹校验。返回 { ok, problems: string[] }；指纹不匹配即大声失败。
export function verifyBundle(doc) {
  const problems = []
  if (!doc || typeof doc !== 'object') return { ok: false, problems: ['bundle 不是对象'] }
  if (doc.bundle !== BUNDLE_NAMESPACE) problems.push('bundle 命名空间不符: ' + String(doc.bundle))
  if (doc.format !== BUNDLE_FORMAT) problems.push('bundle format 不符: ' + String(doc.format))
  if (doc.version !== BUNDLE_VERSION) problems.push('bundle version 不符: ' + String(doc.version))
  if (typeof doc.log !== 'string' || !doc.log.trim()) problems.push('log 缺失或非字符串')
  const s = doc.sha256
  if (!s || typeof s !== 'object') {
    problems.push('sha256 缺失')
  } else {
    if (typeof s.session !== 'string' || s.session !== sha256Hex(doc.log || '')) {
      problems.push('会话级指纹不匹配（log 损坏或被篡改）')
    }
    if (typeof s.bundle !== 'string' || s.bundle !== sha256Hex(canonicalBundleBody({ ...doc, sha256: { ...s, bundle: undefined } }))) {
      problems.push('文件级指纹不匹配（bundle 被篡改）')
    }
  }
  return { ok: problems.length === 0, problems }
}
