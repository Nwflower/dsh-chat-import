// lib/discovery/dsh.mjs — DSH 自身会话日志的发现（dsh = V0–V3 日志、dsh4 = V4 日志）
//
// $DSH_HOME/sessions/<encoded-workspace>/<session-id>/session[.vN].jsonl[.zstd]；同一份目录、
// 同一个扫描器，按文件名里的日志代次归到 dsh / dsh4，请求单一格式时按它过滤。

import { readFile as fread } from 'node:fs/promises'
import { isDshSessionFile, dshSessionLogVersion, decodeZstdText } from '../sources/dsh.mjs'
import { normalizeTitle } from '../convert/util.mjs'
import {
  slashPath, parseJsonlHead, contentText, firstUserTitle, parseTimeValue, projectFromRecord, makeEntry, emitEach,
} from './common.mjs'
import { walkFiles } from './walk.mjs'
import { probeSource } from './scan-cache.mjs'

// 项目目录名 = 宿主 projectKey()：非安全字符按 ~XXXX（四位十六进制 UTF-16 code unit）转义，
// 不是 %XX（'--…-DSH~0020Repo--' 还原为 'DSH Repo'）。还原本身有损——路径分隔符已折叠成
// '-'，无法与字面量连字符区分；这里只还原 ~XXXX 转义，不臆测路径结构。
function decodeDshProjectKey(encoded) {
  return String(encoded).replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

// dsh：$DSH_HOME/sessions/<encoded-workspace>/<session-id>/session.jsonl(.zstd)。
// .zstd 用 fzstd 纯 JS 解压后取头；session 首行提供 id/cwd/createdAt，session/title
// 事件优先作标题，否则回退首条真实 user 文本。
// .zstd 取头需全帧解压（纯 JS 实测 ~2s/MB 压缩明文）——超过阈值的跳过解压，按
// DSH 布局目录名（<session-id>）兜底构造条目：列表可见、可导入（导入路径
// readDshText 全量解压、title 以导入结果为准），首次扫描不再分钟级；
// 之后条目随 mtime/size 书签跳过。
const DSH_ZSTD_SCAN_MAX_BYTES = 256 * 1024

export async function scanDsh(host, target, bm, emit, onlyFormat) {
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
        project: (fmt === 'dsh' ? dshLayoutProject(file.path) : null),
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
        project: projectFromRecord(sessionRec.cwd, () => (fmt === 'dsh' ? dshLayoutProject(file.path) : null)),
        createdAt: Number.isFinite(sessionRec.createdAt) ? sessionRec.createdAt : parseTimeValue(sessionRec.createdAt),
        lastActiveAt: st.mtimeMs, sourcePath: file.path, cwd: sessionRec.cwd,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// 项目名布局：$DSH_HOME/sessions/<encoded-workspace>/<session-id>/session[.vN].jsonl[.zstd]
// → 解码后的 workspace 键。
export function dshLayoutProject(sourcePath) {
  const m = slashPath(sourcePath).match(/\/sessions\/([^/]+)\/[^/]+\/([^/]+)$/i)
  if (!m || !isDshSessionFile(m[2])) return null
  return decodeDshProjectKey(m[1])
}
