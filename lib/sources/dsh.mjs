// lib/sources/dsh.mjs — DSH 自身会话日志的读取与目录收集适配。DSH 落盘是 zstd 压缩
// JSONL，fs.readText 不解压，因此这里用 fzstd 解码（纯 JS，见 lib/zstd.mjs 的取舍）。
// 不依赖系统 zstd 二进制，也避免 child_process 触发安全扫描的 code-exec 判定。
import { readFileSync } from 'node:fs'
import { decodeZstdTextSync } from '../zstd.mjs'
import { collectFiles } from '../import-batch.mjs'

// 历史调用方从本模块导入 decodeZstdText（lib/discovery/dsh.mjs 等）：解码实现已收进
// lib/zstd.mjs 供 Codex 的 .jsonl.zst 共用，这里保留同名转出。
export { decodeZstdText } from '../zstd.mjs'

// 会话工件按代次命名：v0 是 `session.jsonl`，vN（N>=1）是 `session.vN.jsonl`，
// 压缩再加 `.zstd` 后缀。这与宿主 sessionFormatLogFilename() 的口径一致。
// 只认 v0 会漏掉当前代次——本机 52 个会话里有 48 个是 v3，全部扫不出来。
const DSH_SESSION_LOG = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/i

/**
 * 读出一个 DSH 会话日志文件名对应的格式代次。
 * @param name - 目录项名称，可含压缩后缀。
 * @returns 代次（v0 为 0），或 undefined 表示不是会话日志。
 */
export function dshSessionLogVersion(name) {
  const m = DSH_SESSION_LOG.exec(String(name || ''))
  return m ? Number(m[1] ?? 0) : undefined
}

export function isDshSessionFile(name) {
  return dshSessionLogVersion(name) !== undefined
}

// 宿主 target → 可读路径（displayPath 优先；调用方可能是纯路径字符串）。
export function dshPath(target) {
  return target.displayPath || target.path || target
}

export async function readDshText(ctx, target) {
  const path = dshPath(target)
  if (/\.zstd$/i.test(path)) {
    return decodeZstdTextSync(readFileSync(path))
  }
  return ctx.fs.readText(target)
}

// 递归收集目录下的 session.jsonl(.zstd)；跳过 events/conflicts/guardian 等伴生文件。
// versionOk 是代次谓词：面板把 dsh 来源拆成 V3 / V4 两项，目录导入按所选来源过滤
//（V3 桶是 v0–v3，V4 桶是 v4+，所以是谓词而不是精确匹配）；缺省收全部。
export function collectDshFiles(ctx, dirTarget, out, recursive, versionOk) {
  return collectFiles(ctx, dirTarget, out, recursive, (entry) => isDshSessionFile(entry.name)
    && (versionOk === undefined || versionOk(dshSessionLogVersion(entry.name) ?? 0)))
}
