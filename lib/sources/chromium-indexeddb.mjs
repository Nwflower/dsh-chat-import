// lib/sources/chromium-indexeddb.mjs — Chromium/Electron 应用的 IndexedDB 只读读取器（host 面底层）
//
// 豆包桌面版这类 Chromium 应用把 IndexedDB 落在 LevelDB 目录里
//（`<User Data>/<profile>/IndexedDB/<origin>_0.indexeddb.leveldb`）。要读出里面的 JS 值
// 必须过三层编码，缺一层就只能拿到二进制噪声：
//
//   1. LevelDB —— 目录里是 SSTable(`.ldb`) + 预写日志(`.log`)。**SSTable 里存的是
//      「内部键」：用户键 + 8 字节尾标（小端 `(sequence << 8) | type`，type 1=写入
//      0=删除）；WriteBatch 里的键没有尾标。** 不剥尾标，后面每一层都会解出垃圾。
//      `.ldb` 的数据块与索引块可能是 snappy 压缩的。
//   2. IDBValue —— 值是 Blink 的 SerializedScriptValue，但先被 Chromium 包了一层
//      （`third_party/blink/.../idb_value_wrapping.cc`）：`FF 11 02` = 其后是 snappy
//      压缩的 SSV；`FF 11 01` = SSV 被外置成 Blob（本模块不解外置值，按「读不到」上报）。
//   3. SerializedScriptValue —— 以 `FF <版本> FE <trailer>` 开头，其后的字节才是 V8 的
//      结构化序列化流（`value-serializer.cc`）。V8 的 `deserialize()` 只认第三种，故
//      本模块自带一个按 tag 走的读取器（下面 deserializeV8）。
//
// 键编码来自 `indexed_db_leveldb_coding.cc`：`KeyPrefix`（首字节按位段描述三段的字节数）
// 后跟 data/exists 记录的用户键或元数据字节。对象存储名在
// `ObjectStoreMetaDataKey`（前缀 4 个 0 + 50 + varint(osId) + 200 + 键）。
//
// 读取约定（与 docs/architecture.md D5 同口径）：只读、不假设 schema、读不到就返回 null
// 或空集合，不抛异常给调用方；畸形记录计数后跳过，不静默吞掉。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const BLOCK_SIZE = 32768
const SNAPPY_MAX_OUTPUT = 512 * 1024 * 1024

// ── CRC32C（LevelDB 记录帧的校验；不校验也行，但坏帧会让整轮解析错位）──────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32c(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// LevelDB 的掩码：((crc >> 15) | (crc << 17)) + 0xa282ead8
function unmaskCrc(masked) {
  const rot = (masked - 0xa282ead8) >>> 0
  return ((rot >>> 17) | (rot << 15)) >>> 0
}

// ── snappy（raw block 格式，无 framing）──────────────────────────────────────────
/** snappy 原始块解压。格式见 snappy 的 format_description；畸形输入抛错由调用方计数。 */
export function snappyUncompress(input) {
  let pos = 0
  let outLen = 0
  let shift = 0
  for (;;) {
    if (pos >= input.length) throw new Error('snappy: 长度前缀截断')
    const b = input[pos++]
    outLen += (b & 0x7f) * 2 ** shift
    if (b < 0x80) break
    shift += 7
    if (shift > 35) throw new Error('snappy: 长度前缀过长')
  }
  if (outLen > SNAPPY_MAX_OUTPUT) throw new Error('snappy: 解压长度异常 ' + outLen)
  const out = Buffer.alloc(outLen)
  let opos = 0
  while (pos < input.length && opos < outLen) {
    const tag = input[pos++]
    const type = tag & 3
    if (type === 0) {
      let len = tag >> 2
      if (len >= 60) {
        const extra = len - 59
        if (pos + extra > input.length) throw new Error('snappy: literal 长度截断')
        len = 0
        for (let i = 0; i < extra; i++) len += input[pos + i] * 2 ** (8 * i)
        pos += extra
      }
      len += 1
      if (pos + len > input.length || opos + len > outLen) throw new Error('snappy: literal 越界')
      input.copy(out, opos, pos, pos + len)
      pos += len
      opos += len
    } else {
      let len
      let offset
      if (type === 1) {
        if (pos >= input.length) throw new Error('snappy: copy1 截断')
        len = ((tag >> 2) & 0x7) + 4
        offset = ((tag >> 5) << 8) | input[pos++]
      } else if (type === 2) {
        if (pos + 1 >= input.length) throw new Error('snappy: copy2 截断')
        len = (tag >> 2) + 1
        offset = input[pos] | (input[pos + 1] << 8)
        pos += 2
      } else {
        if (pos + 3 >= input.length) throw new Error('snappy: copy4 截断')
        len = (tag >> 2) + 1
        offset = input[pos] | (input[pos + 1] << 8) | (input[pos + 2] << 16) | (input[pos + 3] << 24)
        pos += 4
      }
      if (offset === 0 || offset > opos || opos + len > outLen) throw new Error('snappy: copy 越界')
      for (let i = 0; i < len; i++) {
        out[opos] = out[opos - offset]
        opos++
      }
    }
  }
  if (opos !== outLen) throw new Error(`snappy: 解压长度不符 ${opos} != ${outLen}`)
  return out
}

// ── varint（LevelDB 与 Blink 都用 protobuf 风格的无符号 varint）─────────────────────
export function readVarint(buf, pos) {
  let result = 0
  let shift = 0
  let byte
  do {
    if (pos >= buf.length) throw new Error('varint 越界')
    byte = buf[pos++]
    result += (byte & 0x7f) * 2 ** shift
    shift += 7
    if (shift > 63) throw new Error('varint 过长')
  } while (byte >= 0x80)
  return [result, pos]
}

// ── LevelDB：SSTable ────────────────────────────────────────────────────────────
function readBlock(buf, offset, size) {
  if (offset < 0 || size < 0 || offset + size + 1 > buf.length) return null
  const raw = buf.subarray(offset, offset + size)
  const type = buf[offset + size]
  if (type === 0) return raw
  if (type === 1) {
    try {
      return snappyUncompress(raw)
    } catch {
      return null
    }
  }
  return null
}

function blockEntries(block) {
  const entries = []
  let pos = 0
  let key = Buffer.alloc(0)
  while (pos < block.length) {
    let shared
    let nonShared
    let vlen
    try {
      ;[shared, pos] = readVarint(block, pos)
      ;[nonShared, pos] = readVarint(block, pos)
      ;[vlen, pos] = readVarint(block, pos)
    } catch {
      break
    }
    // 全 0 是 restart 数组起点：其后的 restarts 是索引，不再是条目
    if (shared === 0 && nonShared === 0 && vlen === 0) break
    if (pos + nonShared + vlen > block.length) break
    key = Buffer.concat([key.subarray(0, shared), block.subarray(pos, pos + nonShared)])
    pos += nonShared
    entries.push({ key, value: block.subarray(pos, pos + vlen) })
    pos += vlen
  }
  return entries
}

function sstEntries(buf) {
  if (buf.length < 48) return []
  const footer = buf.subarray(buf.length - 48)
  let p = 0
  let indexOff
  let indexSize
  try {
    // footer = metaindex(2×varint) + index(2×varint) + magic(8)
    ;[, p] = readVarint(footer, p)
    ;[, p] = readVarint(footer, p)
    ;[indexOff, p] = readVarint(footer, p)
    ;[indexSize] = readVarint(footer, p)
  } catch {
    return []
  }
  const indexBlock = readBlock(buf, indexOff, indexSize)
  if (!indexBlock) return []
  const out = []
  for (const handle of blockEntries(indexBlock)) {
    let r = 0
    let dataOff
    let dataSize
    try {
      ;[dataOff, r] = readVarint(handle.value, r)
      ;[dataSize] = readVarint(handle.value, r)
    } catch {
      continue
    }
    const dataBlock = readBlock(buf, dataOff, dataSize)
    if (dataBlock) out.push(...blockEntries(dataBlock))
  }
  return out
}

// ── LevelDB：预写日志 ────────────────────────────────────────────────────────────
function logRecords(buf, stats) {
  const records = []
  let pos = 0
  let pending = null
  while (pos + 7 <= buf.length) {
    const inBlock = pos % BLOCK_SIZE
    if (inBlock > BLOCK_SIZE - 7) {
      pos += BLOCK_SIZE - inBlock // 块尾 padding
      continue
    }
    const masked = buf.readUInt32LE(pos)
    const len = buf.readUInt16LE(pos + 4)
    const type = buf[pos + 6]
    if (type === 0) {
      pos += 7 + len // 预分配块尾的 0 填充
      continue
    }
    if (pos + 7 + len > buf.length) break
    const payload = buf.subarray(pos + 7, pos + 7 + len)
    // 校验失败不中止：坏帧只说明这一帧不可信，后面的记录仍可能完好（失败要大声：
    // 计入 stats.badFrames 由调用方上报）
    if (unmaskCrc(masked) === crc32c(buf.subarray(pos + 6, pos + 7 + len))) {
      if (stats) stats.goodFrames++
    } else if (stats) {
      stats.badFrames++
    }
    pos += 7 + len
    if (type === 1) records.push(Buffer.from(payload))
    else if (type === 2) pending = Buffer.from(payload)
    else if (type === 3) pending = pending ? Buffer.concat([pending, payload]) : null
    else if (type === 4) {
      if (pending) {
        records.push(Buffer.concat([pending, payload]))
        pending = null
      }
    }
  }
  return records
}

// WriteBatch: seq(8) + count(4) + 每条 [type(1) keylen varint key (vallen varint value)]
// 注意：type 0（kTypeDeletion）**没有** value 段，后面直接跟下一条；按 value 读会把
// 下一条的 type 当成 vallen，整批错位。
function batchEntries(record) {
  const out = []
  if (record.length < 12) return out
  let pos = 12
  const count = record.readUInt32LE(8)
  for (let i = 0; i < count; i++) {
    if (pos >= record.length) break
    const type = record[pos++]
    let klen
    try {
      ;[klen, pos] = readVarint(record, pos)
      if (pos + klen > record.length) break
      const key = record.subarray(pos, pos + klen)
      pos += klen
      if (type === 0) {
        out.push({ type, key, value: null })
        continue
      }
      let vlen
      ;[vlen, pos] = readVarint(record, pos)
      if (pos + vlen > record.length) break
      const value = record.subarray(pos, pos + vlen)
      pos += vlen
      out.push({ type, key, value })
    } catch {
      break
    }
  }
  return out
}

/**
 * 剥离 SSTable 内部键的 8 字节尾标（`(sequence << 8) | type`）。
 *
 * **只对 `.ldb` 用**：LevelDB 的 `WriteBatch`（`.log`）存的已经是用户键本身，没有尾标；
 * 对日志键无条件剪 8 字节会把两条不同的键剁成同一个，整库读出来是错的。
 */
function stripInternalKey(key) {
  return key.length > 8 ? key.subarray(0, key.length - 8) : key
}

/**
 * 读一个 LevelDB 目录的全部存活记录（后写覆盖先写）。
 * `.ldb` 先入、`.log` 后入（日志更新）；`batchEntries` 里 type 0 是删除标记。
 * 非 LevelDB 目录 / 空目录返回空数组；文件读不到跳过（不是本来源的库不该让整轮扫描失败）。
 * @returns {Array<{key: Buffer, value: Buffer}>}
 */
export function readLevelDb(dir) {
  const out = []
  for (const versions of readLevelDbHistory(dir).values()) {
    // 取最后一个非删除版本（删除之后没有值可读时整条跳过）
    let latest = null
    for (const v of versions) if (v.value !== null) latest = v
    if (latest) out.push({ key: latest.key, value: latest.value })
  }
  return out
}

/**
 * 读 LevelDB 目录的**全部历史版本**：返回 `用户键(base64) → 该键写入过的每个值`（按写入顺序）。
 *
 * 为什么需要历史而不只看当前值：Chromium 的 IndexedDB 是「整条记录覆盖写」——豆包把会话的
 * **流式生成状态**存在一条固定主键的记录里（`state.mainTaskDataMap`），每次流式增量都整条重写；
 * 生成结束/页面刷新时再写一条**清空任务表**的快照。所以当前值往往只留最后一次清空，而真正的
 * 提问与回答全在被覆盖之前的那些版本里。只看当前值会把一个「有 40 多轮历史的本地库」读成空的。
 *
 * 同一主键的多个版本按 sequence 升序；`.ldb` 用内部键尾标里的 sequence，`.log` 用 WriteBatch 头。
 * 不同文件之间的先后：只在同一文件内可靠（SSTable 之间由写入时序决定并已按文件名升序，文件名
 * 编号单调递增），调用方只依赖「同键版本集合完整」这一点。
 * @returns {Map<string, Array<{key: Buffer, value: Buffer, seq: number}>>}
 */
export function readLevelDbHistory(dir) {
  const names = (() => {
    try {
      return readdirSync(dir).sort()
    } catch {
      return []
    }
  })()
  const versions = new Map()
  const push = (key, value, seq) => {
    const k = key.toString('base64')
    const list = versions.get(k)
    if (list) list.push({ key, value, seq })
    else versions.set(k, [{ key, value, seq }])
  }
  const stats = { goodFrames: 0, badFrames: 0 }
  for (const name of names.filter((n) => n.endsWith('.ldb'))) {
    let buf
    try {
      buf = readFileSync(join(dir, name))
    } catch {
      continue // 读不到：权限/占用，后续 log 里可能仍有同一批键
    }
    for (const e of sstEntries(buf)) {
      // SSTable 的内部键带 8 字节尾标（小端 (sequence << 8) | type）
      const seq = e.key.length > 8 ? Number(e.key.readBigUInt64LE(e.key.length - 8) >> 8n) : 0
      push(stripInternalKey(e.key), e.value, seq)
    }
  }
  for (const name of names.filter((n) => n.endsWith('.log'))) {
    let buf
    try {
      buf = readFileSync(join(dir, name))
    } catch {
      continue // 同上：缺一份日志只是少一批最新写入，不该让整库读不出来
    }
    for (const rec of logRecords(buf, stats)) {
      if (rec.length < 12) continue
      const base = Number(rec.readBigUInt64LE(0) >> 8n)
      for (const e of batchEntries(rec)) {
        // WriteBatch 的键没有尾标；type 0 = 删除，用一个「空值」占位把删除也当成一个版本，
        // 让调用方能看到「这一刻之后被删了」
        push(e.key, e.type === 0 ? null : e.value, base)
      }
    }
  }
  for (const list of versions.values()) {
    if (list.length > 1) list.sort((a, b) => a.seq - b.seq)
  }
  return versions
}

/** LevelDB 目录的当前文件名清单（发现层算指纹用；缺失返回空数组）。 */
export function levelDbFiles(dir) {
  try {
    return readdirSync(dir).filter((n) => n.endsWith('.ldb') || n.endsWith('.log')).sort()
  } catch {
    return []
  }
}

/** 指纹：文件名 + 大小 + mtime（LevelDB 会轮换文件，只 stat 目录不够）。 */
export function levelDbFingerprint(dir) {
  const parts = []
  for (const name of levelDbFiles(dir)) {
    try {
      const st = statSync(join(dir, name))
      parts.push(`${name}:${st.size}:${st.mtimeMs}`)
    } catch {
      parts.push(`${name}:?`)
    }
  }
  return parts.join('|')
}

// ── Chromium IndexedDB：键编码 ───────────────────────────────────────────────────
const OBJECT_STORE_DATA_INDEX_ID = 1

/** KeyPrefix：首字节按位段给出 db/os/index 三段各占几字节。 */
export function decodeKeyPrefix(key) {
  if (key.length < 4) return null
  const first = key[0]
  const dbBytes = ((first >> 5) & 0x7) + 1
  const osBytes = ((first >> 2) & 0x7) + 1
  const indexBytes = (first & 0x3) + 1
  if (1 + dbBytes + osBytes + indexBytes > key.length) return null
  let pos = 1
  const readInt = (n) => {
    let v = 0n
    for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(key[pos + i])
    pos += n
    return Number(v)
  }
  const databaseId = readInt(dbBytes)
  const objectStoreId = readInt(osBytes)
  const indexId = readInt(indexBytes)
  return { databaseId, objectStoreId, indexId, end: pos }
}

// EncodeIDBKey：0=null 1=string(UTF-16BE) 2=date 3=number 4=array 5=min 6=binary
export function decodeIdbKey(buf, pos = 0) {
  const type = buf[pos++]
  switch (type) {
    case 0:
      return { value: null, pos }
    case 1: {
      const [len, p] = readVarint(buf, pos)
      if (p + len * 2 > buf.length) throw new Error('IndexedDB 字符串键越界')
      // Chromium 的 EncodeString 写的是 UTF-16BE（见 indexed_db_leveldb_coding.cc）
      let text = ''
      for (let i = 0; i < len; i++) text += String.fromCharCode(buf.readUInt16BE(p + i * 2))
      return { value: text, pos: p + len * 2 }
    }
    case 2:
    case 3:
      return { value: buf.readDoubleLE(pos), pos: pos + 8 }
    case 4: {
      const [len, p] = readVarint(buf, pos)
      const items = []
      let at = p
      for (let i = 0; i < len; i++) {
        const r = decodeIdbKey(buf, at)
        items.push(r.value)
        at = r.pos
      }
      return { value: items, pos: at }
    }
    case 5:
      return { value: null, pos }
    case 6: {
      const [len, p] = readVarint(buf, pos)
      return { value: buf.subarray(p, p + len), pos: p + len }
    }
    default:
      throw new Error('未知 IndexedDB 键类型 ' + type)
  }
}

// ── Blink SerializedScriptValue + V8 结构化序列化 ───────────────────────────────

/** 剥掉 IDBValue 包装，返回可交给 V8 读取器的字节；外置 Blob 值返回 null。 */
export function unwrapIdbValue(value) {
  // FF 11 02 = snappy 压缩的 SSV；FF 11 01 = SSV 外置成 Blob（内容在 .blob 文件里）
  for (let off = 0; off < Math.min(8, value.length - 2); off++) {
    if (value[off] !== 0xff || value[off + 1] !== 0x11) continue
    const kind = value[off + 2]
    if (kind === 0x02) {
      try {
        return snappyUncompress(value.subarray(off + 3))
      } catch {
        return null
      }
    }
    if (kind === 0x01) return null
  }
  return value
}

/** SSV 头（FF <ver> FE <trailer>）之后的 V8 负载起点；找不到返回 -1。 */
export function ssvPayloadOffset(buf) {
  // 版本 tag 是 0xFF，紧跟 varint 版本号，再跟 trailer tag 0xFE
  for (let i = 0; i + 2 < buf.length && i < 8; i++) {
    if (buf[i] !== 0xff) continue
    let pos = i + 1
    try {
      let [, p] = readVarint(buf, pos)
      // 兼容 Blink 的 trailer 标记（0xFE + 两个定宽字段）与直接进入 V8 流两种形态
      if (buf[p] === 0xfe) {
        const end = p + 1 + 8 + 4
        return end <= buf.length ? end : -1
      }
      // 没有 trailer：V8 流紧跟在版本号后
      return p
    } catch {
      return -1
    }
  }
  return -1
}

const V8_VERSION = 0xff
const V8_PADDING = 0x00
const V8_VERIFY_COUNT = 0x3f
const V8_THE_HOLE = 0x2d
const V8_UNDEFINED = 0x5f
const V8_NULL = 0x30
const V8_TRUE = 0x54
const V8_FALSE = 0x46
const V8_INT32 = 0x49
const V8_UINT32 = 0x55
const V8_DOUBLE = 0x4e
const V8_BIGINT = 0x5a
const V8_UTF8_STRING = 0x53
const V8_ONE_BYTE_STRING = 0x22
const V8_TWO_BYTE_STRING = 0x63
const V8_OBJECT_REFERENCE = 0x5e
const V8_BEGIN_OBJECT = 0x6f
const V8_END_OBJECT = 0x7b
const V8_BEGIN_SPARSE_ARRAY = 0x61
const V8_END_SPARSE_ARRAY = 0x40
const V8_BEGIN_DENSE_ARRAY = 0x41
const V8_END_DENSE_ARRAY = 0x24
const V8_DATE = 0x44
const V8_TRUE_OBJECT = 0x79
const V8_FALSE_OBJECT = 0x78
const V8_NUMBER_OBJECT = 0x6e
const V8_STRING_OBJECT = 0x73
const V8_BIGINT_OBJECT = 0x7a
const V8_REGEXP = 0x52
const V8_BEGIN_MAP = 0x3b
const V8_END_MAP = 0x3a
const V8_BEGIN_SET = 0x27
const V8_END_SET = 0x2c
const V8_ARRAY_BUFFER = 0x42
const V8_IMMUTABLE_ARRAY_BUFFER = 0x43
const V8_RESIZABLE_ARRAY_BUFFER = 0x7e
const V8_ERROR = 0x72
const V8_HOST_OBJECT = 0x5c
const V8_SHARED_OBJECT = 0x70

/**
 * V8 结构化序列化流 → JS 值（只认 IndexedDB 里会出现的 tag 子集）。
 * 不认识的 tag 抛错——调用方按「这条值读不出来」计数，不猜内容。
 * 宿主对象（Blob / File 等）读到占位字符串，其内部字段按已知宽度跳过。
 */
export function deserializeV8(buf, start = 0) {
  let pos = start
  let nextId = 0
  const table = []

  const varint = () => {
    const [v, p] = readVarint(buf, pos)
    pos = p
    return v
  }
  const dbl = () => {
    if (pos + 8 > buf.length) throw new Error('V8: double 越界')
    const v = buf.readDoubleLE(pos)
    pos += 8
    return v
  }
  const stringOf = (encoding, length) => {
    const bytes = encoding === 'utf16' ? length * 2 : length
    if (pos + bytes > buf.length) throw new Error('V8: 字符串越界')
    const s = encoding === 'utf16'
      ? buf.toString('utf16le', pos, pos + bytes)
      : buf.toString(encoding, pos, pos + bytes)
    pos += bytes
    return s
  }

  const read = () => {
    if (pos >= buf.length) throw new Error('V8: 流截断')
    const tag = buf[pos++]
    switch (tag) {
      case V8_VERSION:
        varint()
        return read()
      case V8_PADDING:
        return read()
      case V8_VERIFY_COUNT:
        varint()
        return read()
      case V8_UNDEFINED:
      case V8_THE_HOLE:
        return undefined
      case V8_NULL:
        return null
      case V8_TRUE:
        return true
      case V8_FALSE:
        return false
      case V8_INT32: {
        const v = varint()
        return (v >>> 1) ^ -(v & 1)
      }
      case V8_UINT32:
        return varint()
      case V8_DOUBLE:
        return dbl()
      case V8_BIGINT: {
        const bitfield = varint()
        pos += Math.ceil(((bitfield >>> 2) || 1) / 8) * 8
        return null
      }
      case V8_UTF8_STRING:
        return stringOf('utf8', varint())
      case V8_ONE_BYTE_STRING:
        return stringOf('latin1', varint())
      case V8_TWO_BYTE_STRING: {
        if (buf[pos] === V8_PADDING) pos++ // 两字节串前的对齐填充
        const bytes = varint()
        return stringOf('utf16', bytes / 2)
      }
      case V8_OBJECT_REFERENCE:
        return table[varint()]
      case V8_BEGIN_OBJECT: {
        const obj = {}
        table[nextId++] = obj
        for (;;) {
          if (pos >= buf.length) throw new Error('V8: 对象未闭合')
          if (buf[pos] === V8_END_OBJECT) {
            pos++
            varint()
            return obj
          }
          const key = read()
          obj[String(key)] = read()
        }
      }
      case V8_BEGIN_DENSE_ARRAY: {
        const len = varint()
        const arr = new Array(len)
        table[nextId++] = arr
        for (let i = 0; i < len; i++) arr[i] = read()
        if (buf[pos] === V8_END_DENSE_ARRAY) {
          pos++
          varint()
          varint()
        }
        return arr
      }
      case V8_BEGIN_SPARSE_ARRAY: {
        const len = varint()
        const arr = new Array(len)
        table[nextId++] = arr
        for (;;) {
          if (pos >= buf.length) throw new Error('V8: 稀疏数组未闭合')
          if (buf[pos] === V8_END_SPARSE_ARRAY) {
            pos++
            varint()
            varint()
            return arr
          }
          // 键是完整的 V8 值（通常是 kInt32/kUint32），不是裸 varint
          const key = read()
          arr[Number(key)] = read()
        }
      }
      case V8_DATE:
        table[nextId++] = new Date(dbl())
        return table[nextId - 1]
      case V8_TRUE_OBJECT:
        table[nextId] = true
        return table[nextId++]
      case V8_FALSE_OBJECT:
        table[nextId] = false
        return table[nextId++]
      case V8_NUMBER_OBJECT:
        table[nextId++] = dbl()
        return table[nextId - 1]
      case V8_BIGINT_OBJECT: {
        const bitfield = varint()
        pos += Math.ceil(((bitfield >>> 2) || 1) / 8) * 8
        // 与其它包装对象一样占一个对象引用表槽位（本层值是 null 占位）
        table[nextId++] = null
        return null
      }
      case V8_STRING_OBJECT: {
        const s = read()
        table[nextId++] = s
        return s
      }
      case V8_REGEXP: {
        const pattern = read()
        varint()
        // 正则和对象/数组一样占一个对象引用表槽位；漏登记会让后续
        // kObjectReference 的 id 整体错位（读到别的对象或 undefined）。
        const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern))
        table[nextId++] = re
        return re
      }
      case V8_BEGIN_MAP: {
        const map = new Map()
        table[nextId++] = map
        for (;;) {
          if (pos >= buf.length) throw new Error('V8: Map 未闭合')
          if (buf[pos] === V8_END_MAP) {
            pos++
            varint()
            return map
          }
          const key = read()
          map.set(key, read())
        }
      }
      case V8_BEGIN_SET: {
        const set = new Set()
        table[nextId++] = set
        for (;;) {
          if (pos >= buf.length) throw new Error('V8: Set 未闭合')
          if (buf[pos] === V8_END_SET) {
            pos++
            varint()
            return set
          }
          set.add(read())
        }
      }
      case V8_ARRAY_BUFFER:
      case V8_IMMUTABLE_ARRAY_BUFFER: {
        const len = varint()
        if (pos + len > buf.length) throw new Error('V8: ArrayBuffer 越界')
        const bytes = buf.subarray(pos, pos + len)
        pos += len
        table[nextId++] = bytes
        return bytes
      }
      case V8_RESIZABLE_ARRAY_BUFFER: {
        const len = varint()
        varint()
        if (pos + len > buf.length) throw new Error('V8: 可变 ArrayBuffer 越界')
        const bytes = buf.subarray(pos, pos + len)
        pos += len
        table[nextId++] = bytes
        return bytes
      }
      case V8_ERROR: {
        // 错误对象：错误类型子 tag → 可选的 message / stack / cause，以 0x2e 结束
        const err = { name: 'Error', message: '', stack: '' }
        table[nextId++] = err
        let sub = buf[pos++]
        for (;;) {
          if (sub === 0x2e) break
          if (sub === 0x6d) err.message = String(read())
          else if (sub === 0x73) err.stack = String(read())
          else if (sub === 0x63) err.cause = read()
          else if (sub >= 0x45 && sub <= 0x55) err.name = 'Error'
          sub = buf[pos++]
        }
        return err
      }
      case V8_HOST_OBJECT:
        // Blob / File / ImageBitmap 等宿主对象：内容不在 SSV 流里（Blob 的字节在别处），
        // 按占位符保留——上层只关心文本，不拿它当正文。
        return '[host object]'
      case V8_SHARED_OBJECT:
        varint()
        return '[shared object]'
      default:
        throw new Error(`V8: 未知 tag 0x${tag.toString(16)} @${pos - 1}`)
    }
  }

  const value = read()
  return { value, consumed: pos - start, total: buf.length - start }
}

/**
 * IndexedDB 值（可能被 IDBValue 包装）→ JS 值。
 * 解不出返回 undefined（调用方计数后跳过），不抛错。
 */
export function decodeIdbValue(value) {
  const body = unwrapIdbValue(value)
  if (!body) return undefined
  // SSV 头可能被省略（旧版/直写），从 0 起逐个偏移试到第一个能完整解完且不越界的起点
  const start = ssvPayloadOffset(body)
  const candidates = start >= 0 ? [start] : []
  for (let i = 0; i < 8; i++) if (!candidates.includes(i)) candidates.push(i)
  for (const off of candidates) {
    try {
      return deserializeV8(body, off).value
    } catch {
      // 该起点解不动：换下一个候选（畸形值最终返回 undefined 由调用方计数）
    }
  }
  return undefined
}

/**
 * 读一个 Chromium IndexedDB 库：全部数据记录（用户键 + 已解码的 JS 值），含**被覆盖的历史版本**。
 *
 * 为什么交出历史而不只交当前值：见 `readLevelDbHistory` 的注释——豆包把流式生成状态写在一条固定
 * 主键上，完成后会用清空快照覆盖，只看当前值会得到空库。`versions` 字段就是同一条键写过的全部值
 * （按写入顺序），调用方自己决定怎么合并。
 *
 * 不解析对象存储名表：`ObjectStoreMetaDataKey` 的布局随 Chromium 版本漂移，而调用方真正需要的是
 * 「这条记录是什么」，用 **值形状** 判别比用元数据键稳（见 lib/sources/doubao.mjs）。
 * 解不开的键 / 值计数上报（`undecodable`），不静默丢弃。
 * @returns {{records: Array<{databaseId: number, objectStoreId: number, key: unknown, value: unknown, versions: unknown[], versionCount: number}>, undecodable: number, rawCount: number}}
 */
export function readIndexedDb(dir) {
  const history = readLevelDbHistory(dir)
  const data = []
  let undecodable = 0
  let rawCount = 0
  for (const versions of history.values()) {
    const first = versions[0]
    rawCount += versions.length
    const prefix = decodeKeyPrefix(first.key)
    if (!prefix || prefix.indexId !== OBJECT_STORE_DATA_INDEX_ID) continue
    let userKey
    try {
      ;({ value: userKey } = decodeIdbKey(first.key, prefix.end))
    } catch {
      undecodable++
      continue
    }
    // 每个版本单独解（被删除的版本 value 为 null，跳过但不计入失败）
    const decoded = []
    for (const v of versions) {
      if (v.value === null) continue
      const value = decodeIdbValue(v.value)
      if (value !== undefined) decoded.push(value)
    }
    if (decoded.length === 0) {
      undecodable++
      continue
    }
    data.push({
      databaseId: prefix.databaseId,
      objectStoreId: prefix.objectStoreId,
      key: userKey,
      value: decoded[decoded.length - 1],
      versions: decoded,
      versionCount: versions.length,
    })
  }
  return { records: data, undecodable, rawCount }
}
