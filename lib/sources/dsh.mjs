// lib/sources/dsh.mjs — DSH 自身会话日志的读取与目录收集适配。DSH 落盘是 zstd 压缩
// JSONL，fs.readText 不解压，因此这里用 fzstd 解码（纯 JS，见 decodeZstdText 的取舍）。
// 不依赖系统 zstd 二进制，也避免 child_process 触发安全扫描的 code-exec 判定。
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { decompress } from 'fzstd'
import { collectFiles } from '../import-batch.mjs'

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

// zstd 会话正文 → UTF-8 文本。
//
// 用 fzstd 的纯 JS 解码，**不用** node:zlib 的原生 zstd：宿主按「一条事件一次 flush」
// 写日志，磁盘上的 .zstd 因此是**多帧拼接**（本机实测：一条 6.5MB 压缩 / 33MB 明文的
// 日志有 1962 帧），而 node:zlib 的 zstdDecompress / createZstdDecompress 只解第一帧、
// 其余**静默丢弃**，连截断帧都不报错（无法用部分结果判断完整性）。只解首帧就只剩
// session 头那一行：转换出 0 轮、标题为空，整份导入被当成「无可导入内容」跳过——
// 这正是「导入并归档只会归档旧会话、不建新会话」的根因。fzstd 自带多帧处理，且对
// 截断 / 畸形载荷抛错（失败要大声）。
// 代价是本机实测的同步解码耗时：129KB 压缩 / 492KB 明文 30ms，6.8MB / 33MB 1.8s
//（原生单帧只要 130ms，但拿不到第二帧之后的内容，不能作为主路径）。
export async function decodeZstdText(buf) {
  return Buffer.from(decompress(buf)).toString('utf8')
}

export function dshPath(target) {
  return target.displayPath || target.path || target
}

export async function readDshText(ctx, target) {
  const path = dshPath(target)
  if (/\.zstd$/i.test(path)) {
    return decodeZstdText(readFileSync(path))
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
