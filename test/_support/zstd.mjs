// test/_support/zstd.mjs — 合成 zstd 夹具
//
// 只用 **raw block 帧**（不压缩，块类型 0）：CI 跑 Node 22，`node:zlib` 的 zstd API 从
// 23.8 才有，不能拿它造夹具；`fzstd` 没有压缩端。raw block 是合法的 zstd 帧，走的是与
// 真实 rollout 完全相同的解码路径（单帧 / 多帧都覆盖），只是体积接近明文。
import { Buffer } from 'node:buffer'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function rawFrame(bytes) {
  const size = bytes.length
  let descriptor
  let contentSize
  if (size < 256) {
    descriptor = 0b0010_0000 // FCS flag 0 + single segment → 1 字节内容长度
    contentSize = Buffer.from([size])
  } else if (size <= 65791) {
    descriptor = 0b0110_0000 // FCS flag 1 → 2 字节，存 size - 256
    contentSize = Buffer.alloc(2)
    contentSize.writeUInt16LE(size - 256, 0)
  } else {
    descriptor = 0b1010_0000 // FCS flag 2 → 4 字节
    contentSize = Buffer.alloc(4)
    contentSize.writeUInt32LE(size, 0)
  }
  const parts = [MAGIC, Buffer.from([descriptor]), contentSize]
  let offset = 0
  do {
    const n = Math.min(65536, size - offset)
    const last = offset + n >= size ? 1 : 0
    const header = Buffer.alloc(3)
    header.writeUIntLE((n << 3) | last, 0, 3)
    parts.push(header, bytes.subarray(offset, offset + n))
    offset += n
  } while (offset < size)
  return Buffer.concat(parts)
}

/** 文本 → 单个 zstd 帧。 */
export function zstdBytes(text) {
  return rawFrame(Buffer.from(String(text), 'utf8'))
}

/** 文本 → 多个帧拼接（DSH 日志的落盘形态；验证多帧解码）。 */
export function zstdBytesFrames(text, frames = 2) {
  const chars = [...String(text)]
  const out = []
  for (let i = 0; i < frames; i++) {
    const part = chars.slice(Math.floor((chars.length * i) / frames), Math.floor((chars.length * (i + 1)) / frames)).join('')
    out.push(rawFrame(Buffer.from(part, 'utf8')))
  }
  return Buffer.concat(out)
}
