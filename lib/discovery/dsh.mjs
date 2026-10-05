// lib/discovery/dsh.mjs — DSH 自身会话日志的发现（dsh = V0–V3 日志、dsh4 = V4 日志）
//
// $DSH_HOME/sessions/<encoded-workspace>/<session-id>/session[.vN].jsonl[.zstd]；同一份目录、
// 同一个扫描器，按文件名里的日志代次归到 dsh / dsh4，请求单一格式时按它过滤。

import { join } from 'node:path'
import { isDshSessionFile, dshSessionLogVersion, decodeZstdText } from '../sources/dsh.mjs'
import { normalizeTitle } from '../convert/util.mjs'
import {
  HEAD_MAX_BYTES, TAIL_MAX_BYTES, fileFingerprint, slashPath, parseJsonlHead, contentText, firstUserTitle,
  parseTimeValue, projectFromRecord, makeEntry, emitEach,
} from './common.mjs'
import { walkFiles } from './walk.mjs'
import { probeSource } from './scan-cache.mjs'

// 项目目录名 = 宿主 projectKey()：非安全字符按 ~XXXX（四位十六进制 UTF-16 code unit）转义，
// 不是 %XX（'--…-DSH~0020Repo--' 还原为 'DSH Repo'）。还原本身有损——路径分隔符已折叠成
// '-'，无法与字面量连字符区分；这里只还原 ~XXXX 转义，不臆测路径结构。
function decodeDshProjectKey(encoded) {
  return String(encoded).replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

// dsh：$DSH_HOME/sessions/<encoded-workspace>/<session-id>/session[.vN].jsonl[.zstd]。
// session 首行提供 id / cwd / createdAt；最新的 session/title 事件作标题，没有则回退首条真实
// user 文本。全部读取经注入 host：
//   明文日志只读头（HEAD_MAX_BYTES）+ 尾（TAIL_MAX_BYTES）两段——会话头在头部，改名追加在尾部；
//     标题事件只出现在两段之间的超大日志会退回头部最后一次标题（不为它整读几十 MB 的日志）。
//   .zstd 经 host.readBytes 有界读原始字节、纯 JS 全帧解压（实测约 2s/MB 压缩明文）；超过
//     DSH_ZSTD_SCAN_MAX_BYTES、或 host 读不到字节时不解压，按布局目录名（<session-id>）兜底
//     构造条目：列表可见、可导入（导入路径 readDshText 全量解压，标题以导入结果为准）。
// 导入产物目录（import-<id>）同样列出：DSH 来源的用途之一是把已导入的会话迁移到另一代次
//（V3 ↔ V4）；重导不会覆盖原会话（新会话 id 是 import-<源 id>），幂等判定照常兜底。
const DSH_ZSTD_SCAN_MAX_BYTES = 256 * 1024

async function scanDsh(host, target, { bm, emit, format: onlyFormat }) {
  const files = []
  await walkFiles(host, target, files, (name) => isDshSessionFile(name))
  const out = []
  for (const file of files) {
    // 请求了单一格式时按日志代次过滤
    const fmt = dshFormatOf(file.name)
    if (onlyFormat !== undefined && fmt !== onlyFormat) continue
    const st = await host.stat(file.path)
    if (!st) continue
    const zstd = /\.zstd$/i.test(file.path)
    const byDirName = () => [dirNameEntry(fmt, file.path, st)]
    let entries
    if (zstd && (st.size > DSH_ZSTD_SCAN_MAX_BYTES || typeof host.readBytes !== 'function')) {
      entries = byDirName()
    } else {
      entries = await probeSource(bm, fmt, file.path, fileFingerprint(st), async () => {
        if (zstd) {
          const bytes = await host.readBytes(file.path, DSH_ZSTD_SCAN_MAX_BYTES)
          if (!bytes) return byDirName()
          let text
          try {
            text = await decodeZstdText(bytes)
          } catch {
            // 非法 / 截断的 zstd 帧：不是可读的会话日志，不列出
            return []
          }
          return dshEntry(fmt, file.path, st, parseJsonlHead(text), [])
        }
        const head = await host.readHead(file.path, HEAD_MAX_BYTES)
        if (head === null || head === '') return []
        const tail = st.size > HEAD_MAX_BYTES && typeof host.readTail === 'function'
          ? await host.readTail(file.path, TAIL_MAX_BYTES)
          : null
        return dshEntry(fmt, file.path, st, parseJsonlHead(head), tail ? parseJsonlHead(tail) : [])
      })
    }
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// 头部记录给会话头与首问；标题取尾部（新）→ 头部的最后一个 session/title。
function dshEntry(format, sourcePath, st, headRecs, tailRecs) {
  const sessionRec = headRecs.find((r) => r && r.type === 'session' && typeof r.id === 'string' && r.id)
  if (!sessionRec) return []
  const lastTitle = (recs) => [...recs].reverse().find((r) => r && r.type === 'session/title' && r.data && typeof r.data.title === 'string')
  const titleRec = lastTitle(tailRecs) || lastTitle(headRecs)
  const title = titleRec
    ? normalizeTitle(titleRec.data.title)
    : firstUserTitle(headRecs, (r) => (r && r.type === 'user/message' && r.data && Array.isArray(r.data.content) ? contentText(r.data.content) : ''))
  return [makeEntry({
    format, sessionId: sessionRec.id, title,
    project: projectFromRecord(sessionRec.cwd, () => dshLayoutProject(sourcePath)),
    createdAt: Number.isFinite(sessionRec.createdAt) ? sessionRec.createdAt : parseTimeValue(sessionRec.createdAt),
    lastActiveAt: st.mtimeMs, sourcePath, cwd: sessionRec.cwd,
  })]
}

// 内容不可得（大 .zstd / host 读不到字节）：DSH 布局目录名即会话 id，时间取文件 mtime。
function dirNameEntry(format, sourcePath, st) {
  const parts = String(sourcePath).split(/[\\/]/)
  return makeEntry({
    format, sessionId: parts[parts.length - 2], title: '',
    project: dshLayoutProject(sourcePath),
    createdAt: st.mtimeMs, lastActiveAt: st.mtimeMs, sourcePath,
  })
}

// 项目名布局：$DSH_HOME/sessions/<encoded-workspace>/<session-id>/session[.vN].jsonl[.zstd]
// → 解码后的 workspace 键。
function dshLayoutProject(sourcePath) {
  const m = slashPath(sourcePath).match(/\/sessions\/([^/]+)\/[^/]+\/([^/]+)$/i)
  if (!m || !isDshSessionFile(m[2])) return null
  return decodeDshProjectKey(m[1])
}

// ── 来源描述符（注册与顺序见 ./registry.mjs；字段契约见该文件头）──────────────────

// 日志代次决定来源：v0–v3 归 dsh（V3），v4+ 归 dsh4（V4）。
function dshFormatOf(fileName) {
  return (dshSessionLogVersion(fileName) ?? 0) >= 4 ? 'dsh4' : 'dsh'
}

// DSH 会话日志根随宿主 DSH_HOME 走（桌面端 harness 域 ≠ ~/.dsh），与 registryDir
//（$DSH_HOME/dsh-chat-import）同一存储域；env 缺省回退 ~/.dsh（CLI 直跑）。dsh 与 dsh4
// 是同一目录的两个代次桶，两者都登记根。
const dshRoots = (home, env) => join(env.DSH_HOME || join(home, '.dsh'), 'sessions')
// <…>/sessions/<workspace>/<session>/session[.vN].jsonl[.zstd] 独占，按代次分流
const dshMatchFile = (format) => (lower, base) =>
  (/(^|[\\/])sessions[\\/]/.test(lower) && isDshSessionFile(base) && dshFormatOf(base) === format ? 'only' : false)

export const dshSource = {
  format: 'dsh',
  roots: dshRoots,
  scan: scanDsh,
  layoutProject: dshLayoutProject,
  matchFile: dshMatchFile('dsh'),
}

export const dsh4Source = {
  format: 'dsh4',
  roots: dshRoots,
  scan: scanDsh,
  layoutProject: dshLayoutProject,
  matchFile: dshMatchFile('dsh4'),
}
