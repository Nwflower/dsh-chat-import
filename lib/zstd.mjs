// lib/zstd.mjs — zstd 文本解码（DSH 的 .zstd 会话日志与 Codex 的 .jsonl.zst rollout）
//
// 用 fzstd 的纯 JS 解码，**不用** node:zlib 的原生 zstd：DSH 按「一条事件一次 flush」写
// 日志，磁盘上的 .zstd 因此是**多帧拼接**（本机实测：一条 6.5MB 压缩 / 33MB 明文的日志有
// 1962 帧），而 node:zlib 的 zstdDecompress / createZstdDecompress 只解第一帧、其余静默
// 丢弃，连截断帧都不报错。fzstd 自带多帧处理，且对截断 / 畸形载荷抛错（失败要大声）。
// 也不依赖系统 zstd 二进制：child_process 会触发宿主的 code-exec 判定。
//
// 代价是本机实测的同步解码耗时：129KB 压缩 / 492KB 明文 30ms，6.8MB / 33MB 1.8s（原生单帧
// 只要 130ms，但拿不到第二帧之后的内容，不能作为主路径）。解码整份文件时调用方要先做
// 大小上限判断；发现层只读文件头时走 readZstdPrefix，解到够用就停。
import { Buffer } from 'node:buffer'
import { createReadStream } from 'node:fs'
import { TextDecoder } from 'node:util'
import { decompress, Decompress } from 'fzstd'

const ZSTD_SUFFIX = /\.zst(?:d)?$/i

/** 文件名 / 路径是否带 zstd 压缩后缀（.zst 与 .zstd 都认）。 */
export function isZstdName(name) {
  return ZSTD_SUFFIX.test(String(name ?? ''))
}

/**
 * 同一 rollout 的明文与压缩两种落盘形态的兄弟路径：`.jsonl` ↔ `.jsonl.zst`。
 * 不是这对后缀 → null（调用方不再做别名查询）。
 */
export function siblingZstdPath(path) {
  const s = String(path ?? '')
  if (/\.jsonl\.zst$/i.test(s)) return s.replace(/\.zst$/i, '')
  if (/\.jsonl$/i.test(s)) return s + '.zst'
  return null
}

/** zstd 字节 → UTF-8 文本（多帧；畸形 / 截断抛错）。同步内核，新代码优先用它。 */
export function decodeZstdTextSync(buf) {
  return Buffer.from(decompress(buf)).toString('utf8')
}

/** 同步内核的异步外壳：保留历史调用面的 Promise 语义（拒绝而非同步 throw）。 */
export async function decodeZstdText(buf) {
  return decodeZstdTextSync(buf)
}

/**
 * 只解出文本前 maxChars 个字符：发现层读文件头用，几百 MB 的 rollout 不必整份解压。
 * 解到够用即停止读盘（for-await break 会关闭底层流）；文件结束时冲掉 TextDecoder 的
 * 多字节残留，不产生替换字符。
 */
export async function readZstdPrefix(path, maxChars, { chunkSize = 256 * 1024 } = {}) {
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 256 * 1024
  const decoder = new TextDecoder('utf-8')
  let text = ''
  let stopped = false
  const stream = new Decompress((chunk) => {
    text += decoder.decode(chunk, { stream: true })
  })
  for await (const chunk of createReadStream(path, { highWaterMark: chunkSize })) {
    stream.push(chunk)
    if (text.length >= cap) {
      stopped = true
      break
    }
  }
  if (!stopped) text += decoder.decode()
  return text.slice(0, cap)
}
