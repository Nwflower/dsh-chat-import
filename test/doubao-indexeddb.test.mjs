// test/doubao-indexeddb.test.mjs — Chromium IndexedDB 读取层：LevelDB 帧 / snappy / SSV 三层解码
//
// 这一层不做「猜」：每一层的格式都有明确的源头（LevelDB 的 log/sstable 布局、Blink 的
// IDBValue 包装、V8 的结构化序列化 tag）。用例逐层构造**合成字节**，验证解码器在正常与
// 畸形输入下的行为——真实豆包库只作为端到端的那一条（手工构造的字节保证跨平台可跑）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodeIdbKey,
  decodeIdbValue,
  decodeKeyPrefix,
  deserializeV8,
  levelDbFiles,
  levelDbFingerprint,
  readIndexedDb,
  readLevelDb,
  readLevelDbHistory,
  readVarint,
  snappyUncompress,
  ssvPayloadOffset,
  unwrapIdbValue,
} from '../lib/sources/chromium-indexeddb.mjs'

// ── 合成字节的构造件 ──────────────────────────────────────────────────────────

/** V8 结构化序列化：对象 {"a":"b"} */
function v8Object(entries) {
  const parts = [Buffer.from([0x6f])] // kBeginJSObject
  for (const [key, value] of entries) {
    parts.push(v8OneByteString(key))
    parts.push(v8OneByteString(value))
  }
  parts.push(Buffer.from([0x7b, entries.length * 2])) // kEndJSObject + numProperties(varint)
  return Buffer.concat(parts)
}

function v8OneByteString(text) {
  const body = Buffer.from(text, 'latin1')
  return Buffer.concat([Buffer.from([0x22, body.length]), body])
}

function v8TwoByteString(text) {
  const body = Buffer.from(text, 'utf16le')
  return Buffer.concat([Buffer.from([0x63, body.length]), body])
}

function varintBytes(value) {
  const out = []
  let n = value
  do {
    let byte = n & 0x7f
    n = Math.floor(n / 128)
    if (n > 0) byte |= 0x80
    out.push(byte)
  } while (n > 0)
  return Buffer.from(out)
}

/** Blink SSV 信封：FF <ver> FE <8 字节偏移> <4 字节长度> + V8 负载 */
function ssv(payload) {
  return Buffer.concat([
    Buffer.from([0xff, 0x15, 0xfe]), // kVersionTag, version 21, trailer tag
    Buffer.alloc(12), // trailer：offset(uint64) + size(uint32)，内容对本层无意义
    payload,
  ])
}

/** IndexedDB 值（未包装的 SSV） */
function idbValue(payload) {
  return ssv(payload)
}

// ── varint ─────────────────────────────────────────────────────────────────────

test('readVarint：单字节与多字节', () => {
  assert.deepEqual(readVarint(Buffer.from([0x05]), 0), [5, 1])
  assert.deepEqual(readVarint(Buffer.from([0x80, 0x01]), 0), [128, 2])
})

test('readVarint：越界抛错（不返回半个数）', () => {
  assert.throws(() => readVarint(Buffer.from([0x80]), 0), /越界/)
})

// ── snappy ─────────────────────────────────────────────────────────────────────

test('snappyUncompress：literal-only 块', () => {
  // 长度为 5，随后一个 literal（tag = (5-1)<<2 = 0x10）
  const compressed = Buffer.from([5, 0x10, 0x68, 0x65, 0x6c, 0x6c, 0x6f])
  assert.equal(snappyUncompress(compressed).toString('latin1'), 'hello')
})

test('snappyUncompress：copy 回引', () => {
  // "ab" 的 literal + copy(offset=2,len=4) → "ababab"
  const compressed = Buffer.from([6, 0x04, 0x61, 0x62, 0x01, 0x02])
  assert.equal(snappyUncompress(compressed).toString('latin1'), 'ababab')
})

test('snappyUncompress：畸形输入抛错', () => {
  assert.throws(() => snappyUncompress(Buffer.from([0x05])), /snappy/)
})

// ── IdbKey ─────────────────────────────────────────────────────────────────────

test('decodeIdbKey：字符串键按 UTF-16BE 解（Chromium 的 EncodeString 是大端）', () => {
  const text = 'default-chat-im-protocol-store'
  const body = Buffer.alloc(text.length * 2)
  for (let i = 0; i < text.length; i++) body.writeUInt16BE(text.charCodeAt(i), i * 2)
  const key = Buffer.concat([Buffer.from([1]), varintBytes(text.length), body])
  const got = decodeIdbKey(key, 0)
  assert.equal(got.value, text)
  assert.equal(got.pos, key.length)
})

test('decodeIdbKey：数字 / 数组 / null', () => {
  const num = Buffer.concat([Buffer.from([3]), (() => {
    const b = Buffer.alloc(8)
    b.writeDoubleLE(42.5)
    return b
  })()])
  assert.equal(decodeIdbKey(num, 0).value, 42.5)

  const arr = Buffer.concat([
    Buffer.from([4]),
    varintBytes(2),
    // 每个元素是 UTF-16BE 字符串：长度前缀是「字符数」，字节数是 2×字符数
    Buffer.concat([Buffer.from([1]), varintBytes(1), Buffer.from([0x00, 0x41])]),
    Buffer.concat([Buffer.from([1]), varintBytes(1), Buffer.from([0x00, 0x42])]),
  ])
  assert.deepEqual(decodeIdbKey(arr, 0).value, ['A', 'B'])

  assert.equal(decodeIdbKey(Buffer.from([0]), 0).value, null)
})

// ── KeyPrefix ──────────────────────────────────────────────────────────────────

test('decodeKeyPrefix：首字节的位段描述三段字节数', () => {
  // 0x00 → db 1B / os 1B / index 1B；db=1 os=1 index=1
  const key = Buffer.from([0x00, 0x01, 0x01, 0x01])
  const got = decodeKeyPrefix(key)
  assert.deepEqual([got.databaseId, got.objectStoreId, got.indexId], [1, 1, 1])
  assert.equal(got.end, 4)
})

test('decodeKeyPrefix：空 / 过短返回 null', () => {
  assert.equal(decodeKeyPrefix(Buffer.from([0x00])), null)
})

// ── IDBValue 包装 ─────────────────────────────────────────────────────────────

test('unwrapIdbValue：snappy 包装（FF 11 02）被解开', () => {
  const payload = Buffer.from([1, 2, 3, 4, 5])
  // snappy：长度 5 + literal tag
  const compressed = Buffer.concat([Buffer.from([5, 0x10]), payload])
  const wrapped = Buffer.concat([Buffer.from([0xff, 0x11, 0x02]), compressed])
  assert.deepEqual(unwrapIdbValue(wrapped), payload)
})

test('unwrapIdbValue：外置 blob 包装（FF 11 01）返回 null（本层不解 Blob）', () => {
  const wrapped = Buffer.from([0xff, 0x11, 0x01, 0x0a, 0x00])
  assert.equal(unwrapIdbValue(wrapped), null)
})

test('unwrapIdbValue：未包装的值原样返回', () => {
  const raw = Buffer.from([0xff, 0x15, 0xfe, 0x00])
  assert.deepEqual(unwrapIdbValue(raw), raw)
})

// ── SSV 头与 V8 解码 ──────────────────────────────────────────────────────────

test('ssvPayloadOffset：FF <ver> FE <trailer> 之后的偏移', () => {
  const body = ssv(Buffer.from([0x30]))
  assert.equal(ssvPayloadOffset(body), 15)
})

test('ssvPayloadOffset：没有 SSV 头返回 -1', () => {
  assert.equal(ssvPayloadOffset(Buffer.from([0x30, 0x30])), -1)
})

test('deserializeV8：对象 / 字符串 / 数字 / 布尔 / null', () => {
  assert.deepEqual(deserializeV8(v8Object([['state', 'ok']]), 0).value, { state: 'ok' })

  const str = v8TwoByteString('中文')
  assert.equal(deserializeV8(str, 0).value, '中文')

  const dbl = Buffer.concat([Buffer.from([0x4e]), (() => {
    const b = Buffer.alloc(8)
    b.writeDoubleLE(1.5)
    return b
  })()])
  assert.equal(deserializeV8(dbl, 0).value, 1.5)

  assert.equal(deserializeV8(Buffer.from([0x54]), 0).value, true)
  assert.equal(deserializeV8(Buffer.from([0x46]), 0).value, false)
  assert.equal(deserializeV8(Buffer.from([0x30]), 0).value, null)
  assert.equal(deserializeV8(Buffer.from([0x5f]), 0).value, undefined)
})

test('deserializeV8：int32 zigzag', () => {
  assert.equal(deserializeV8(Buffer.from([0x49, 0x00]), 0).value, 0)
  assert.equal(deserializeV8(Buffer.from([0x49, 0x01]), 0).value, -1)
  assert.equal(deserializeV8(Buffer.from([0x49, 0x02]), 0).value, 1)
})

test('deserializeV8：密集数组', () => {
  const arr = Buffer.concat([
    Buffer.from([0x41]),
    varintBytes(2),
    Buffer.from([0x30]), // null
    Buffer.from([0x54]), // true
    Buffer.from([0x24, 0x00, 0x02]), // kEndDenseJSArray + 两个 varint
  ])
  assert.deepEqual(deserializeV8(arr, 0).value, [null, true])
})

test('deserializeV8：对象引用指回先出现的对象', () => {
  // {"a": <obj X>} 里第二个属性引用 X 的 id（首个对象 id=0）
  const shared = Buffer.concat([
    Buffer.from([0x6f]), // 外层对象
    v8OneByteString('first'),
    Buffer.from([0x6f]), // 内层对象（id=1）
    v8OneByteString('k'),
    Buffer.from([0x46]), // false
    Buffer.from([0x7b, 0x02]),
    v8OneByteString('again'),
    Buffer.from([0x5e, 0x01]), // 引用 id=1
    Buffer.from([0x7b, 0x04]),
  ])
  const value = deserializeV8(shared, 0).value
  assert.equal(value.again, value.first)
})

test('deserializeV8：未知 tag 抛错（不猜内容）', () => {
  assert.throws(() => deserializeV8(Buffer.from([0xee]), 0), /未知 tag/)
})

test('decodeIdbValue：未包装 SSV 端到端', () => {
  const value = idbValue(v8Object([['state', 'ok']]))
  assert.deepEqual(decodeIdbValue(value), { state: 'ok' })
})

test('decodeIdbValue：snappy 包装端到端', () => {
  const payload = v8Object([['a', 'b']])
  const compressed = Buffer.concat([Buffer.from([payload.length, ((payload.length - 1) << 2) | 0x00]), payload])
  // 上面的 literal tag 只适用于长度 ≤ 60；这里 payload 短，够用
  const wrapped = Buffer.concat([Buffer.from([0xff, 0x11, 0x02]), snappyUncompress.length ? compressed : compressed])
  const got = decodeIdbValue(wrapped)
  assert.deepEqual(got, { a: 'b' })
})

test('decodeIdbValue：解不开返回 undefined（调用方计数，不抛）', () => {
  assert.equal(decodeIdbValue(Buffer.from([0xff, 0x11, 0x01, 0x00])), undefined)
})

// ── LevelDB 目录读取 ──────────────────────────────────────────────────────────

/** 构造一条 LevelDB 的 `.log` 文件（WriteBatch 记录，key 无内部尾标）。 */
function logFile(entries) {
  const batchParts = [Buffer.alloc(8), Buffer.alloc(4)]
  batchParts[1].writeUInt32LE(entries.length)
  for (const { key, value, type = 1 } of entries) {
    batchParts.push(Buffer.from([type]))
    batchParts.push(varintBytes(key.length))
    batchParts.push(key)
    if (type !== 0) {
      batchParts.push(varintBytes(value.length))
      batchParts.push(value)
    }
  }
  const batch = Buffer.concat(batchParts)
  // LevelDB 记录头：crc(4) 长度(2) 类型(1)，类型 1 = full
  const header = Buffer.alloc(7)
  header.writeUInt16LE(batch.length, 4)
  header[6] = 1
  return Buffer.concat([header, batch])
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-doubao-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('readLevelDb：从 .log 读出键值；type=0 是删除标记', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, '000001.log'), logFile([
      { key: Buffer.from('a'), value: Buffer.from('1') },
      { key: Buffer.from('b'), value: Buffer.from('2') },
    ]))
    const got = readLevelDb(dir)
    assert.equal(got.length, 2)
    assert.deepEqual(got.map((e) => e.key.toString()).sort(), ['a', 'b'])
  })
})

test('readLevelDb：后写覆盖先写（同名键只有一个存活值）', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, '000001.log'), logFile([
      { key: Buffer.from('k'), value: Buffer.from('old') },
      { key: Buffer.from('k'), value: Buffer.from('new') },
    ]))
    const got = readLevelDb(dir)
    assert.equal(got.length, 1)
    assert.equal(got[0].value.toString(), 'new')
  })
})

test('readLevelDbHistory：同一键的全部历史版本按写入顺序保留', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, '000001.log'), logFile([
      { key: Buffer.from('k'), value: Buffer.from('v1') },
      { key: Buffer.from('k'), value: Buffer.from('v2') },
      { key: Buffer.from('k'), value: Buffer.from('v3') },
    ]))
    const history = readLevelDbHistory(dir)
    const versions = history.get(Buffer.from('k').toString('base64'))
    assert.equal(versions.length, 3)
    assert.deepEqual(versions.map((v) => v.value.toString()), ['v1', 'v2', 'v3'])
  })
})

test('readLevelDbHistory：删除记成一个 null 版本（看得到「这一刻被删了」）', () => {
  withTempDir((dir) => {
    // 两个批次：先写入、再删除（同批次内的序号相同，跨批次才与真实日志同形）
    const first = logFile([{ key: Buffer.from('k'), value: Buffer.from('v1') }])
    writeFileSync(join(dir, '000001.log'), first)
    writeFileSync(join(dir, '000002.log'), logFile([{ key: Buffer.from('k'), type: 0 }]))
    const versions = readLevelDbHistory(dir).get(Buffer.from('k').toString('base64'))
    assert.equal(versions.length, 2)
    assert.equal(versions[1].value, null)
  })
})

test('readLevelDb：空目录 / 不存在的目录返回空数组', () => {
  withTempDir((dir) => {
    assert.deepEqual(readLevelDb(dir), [])
    assert.deepEqual(readLevelDb(join(dir, 'nope')), [])
  })
})

test('levelDbFiles / levelDbFingerprint：只列 LevelDB 文件，指纹含大小与 mtime', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, '000001.log'), logFile([{ key: Buffer.from('a'), value: Buffer.from('1') }]))
    writeFileSync(join(dir, 'CURRENT'), 'MANIFEST-000001\n')
    writeFileSync(join(dir, 'LOCK'), '')
    assert.deepEqual(levelDbFiles(dir), ['000001.log'])
    const fp = levelDbFingerprint(dir)
    assert.match(fp, /^000001\.log:\d+:/)
  })
})

// ── readIndexedDb：端到端（合成库）─────────────────────────────────────────────

/** 构造一条数据记录键：KeyPrefix(db,os,index=1) + EncodeIDBKey(string) */
function dataRecordKey(db, os, userKey) {
  const prefix = Buffer.from([0x00, db, os, 0x01])
  const body = Buffer.alloc(userKey.length * 2)
  for (let i = 0; i < userKey.length; i++) body.writeUInt16BE(userKey.charCodeAt(i), i * 2)
  return Buffer.concat([prefix, Buffer.from([1]), varintBytes(userKey.length), body])
}

test('readIndexedDb：解出数据记录的用户键与值', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, '000001.log'), logFile([
      { key: dataRecordKey(1, 1, 'store-key'), value: Buffer.from(idbValue(v8Object([['state', 'ok']]))) },
    ]))
    const got = readIndexedDb(dir)
    assert.equal(got.records.length, 1)
    assert.equal(got.records[0].key, 'store-key')
    assert.deepEqual(got.records[0].value, { state: 'ok' })
    assert.equal(got.undecodable, 0)
  })
})

test('readIndexedDb：同一键的多版本都留在 versions 里', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, '000001.log'), logFile([
      { key: dataRecordKey(1, 1, 'k'), value: Buffer.from(idbValue(v8Object([['v', 'old']]))) },
      { key: dataRecordKey(1, 1, 'k'), value: Buffer.from(idbValue(v8Object([['v', 'new']]))) },
    ]))
    const got = readIndexedDb(dir)
    assert.equal(got.records.length, 1)
    assert.equal(got.records[0].versionCount, 2)
    assert.equal(got.records[0].versions.length, 2)
    assert.deepEqual(got.records[0].value, { v: 'new' })
  })
})

test('readIndexedDb：解不开的记录计入 undecodable（不静默丢）', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, '000001.log'), logFile([
      { key: dataRecordKey(1, 1, 'good'), value: Buffer.from(idbValue(v8Object([['a', 'b']]))) },
      // 外置 blob 包装：本层不解 → undecodable
      { key: dataRecordKey(1, 1, 'blob'), value: Buffer.from([0xff, 0x11, 0x01, 0x00]) },
    ]))
    const got = readIndexedDb(dir)
    assert.equal(got.records.length, 1)
    assert.equal(got.undecodable, 1)
  })
})

test('readIndexedDb：非数据记录（index != 1）不参与', () => {
  withTempDir((dir) => {
    // indexId 2 的键
    const key = Buffer.concat([Buffer.from([0x00, 1, 1, 0x02]), Buffer.from([0])])
    writeFileSync(join(dir, '000001.log'), logFile([{ key, value: Buffer.from('x') }]))
    assert.equal(readIndexedDb(dir).records.length, 0)
  })
})

// ── V8 tag 覆盖：IndexedDB 里会出现的其余类型 ──────────────────────────────────

test('deserializeV8：稀疏数组 / Map / Set', () => {
  const sparse = Buffer.concat([
    Buffer.from([0x61]),
    varintBytes(4),
    Buffer.from([0x49, 0x02]), // 键是 kInt32 zigzag: 2 -> 1
    v8OneByteString('x'),
    Buffer.from([0x40, 0x00, 0x04]), // kEndSparseJSArray + numProperties + length
  ])
  // 长度 4、只放了 key=1 的元素 → 其余是空洞
  assert.equal(deserializeV8(sparse, 0).value.length, 4)
  assert.equal(deserializeV8(sparse, 0).value[1], 'x')

  const map = Buffer.concat([
    Buffer.from([0x3b]), // kBeginJSMap
    v8OneByteString('k'),
    v8OneByteString('v'),
    Buffer.from([0x3a, 0x01]), // kEndJSMap + length
  ])
  const mapValue = deserializeV8(map, 0).value
  assert.ok(mapValue instanceof Map)
  assert.equal(mapValue.get('k'), 'v')

  const set = Buffer.concat([
    Buffer.from([0x27]), // kBeginJSSet
    v8OneByteString('m'),
    Buffer.from([0x2c, 0x01]), // kEndJSSet + length
  ])
  const setValue = deserializeV8(set, 0).value
  assert.ok(setValue instanceof Set)
  assert.equal(setValue.has('m'), true)
})

test('deserializeV8：Date / 包装对象 / 正则', () => {
  const dateBytes = Buffer.alloc(8)
  dateBytes.writeDoubleLE(1700000000000)
  const date = Buffer.concat([Buffer.from([0x44]), dateBytes])
  assert.equal(deserializeV8(date, 0).value.getTime(), 1700000000000)

  const numObj = Buffer.concat([Buffer.from([0x6e]), dateBytes])
  assert.equal(deserializeV8(numObj, 0).value, 1700000000000)

  assert.equal(deserializeV8(Buffer.from([0x79]), 0).value, true)
  assert.equal(deserializeV8(Buffer.from([0x78]), 0).value, false)

  // 字符串对象：其后的字符串被读出（本层按值返回）
  const strObj = Buffer.concat([Buffer.from([0x73]), v8OneByteString('inner')])
  assert.equal(deserializeV8(strObj, 0).value, 'inner')
})

test('deserializeV8：正则占用对象引用表槽位（后续引用不整体错位）', () => {
  // 外层对象 id=0、正则 id=1、内层对象 id=2：最后一条引用必须解析到内层对象。
  // 正则若不占槽位，内层对象会顶到 id=1、引用 id=2 落到表外（undefined），
  // 其后所有引用同理整体错位。
  const reStream = Buffer.concat([
    Buffer.from([0x52]), // kRegExp
    v8OneByteString('foo.*'),
    Buffer.from([0x01]), // flags：本层不解释，但要吃掉
  ])
  const stream = Buffer.concat([
    Buffer.from([0x6f]), // 外层对象（id=0）
    v8OneByteString('re'),
    reStream,
    v8OneByteString('target'),
    Buffer.from([0x6f]), // 内层对象（id=2）
    v8OneByteString('k'),
    v8OneByteString('v'),
    Buffer.from([0x7b, 0x02]), // kEndJSObject + numProperties
    v8OneByteString('again'),
    Buffer.from([0x5e, 0x02]), // kObjectReference id=2
    Buffer.from([0x7b, 0x06]),
  ])
  const value = deserializeV8(stream, 0).value
  assert.ok(value.re instanceof RegExp)
  assert.equal(value.re.source, 'foo.*')
  assert.equal(value.again, value.target)
  assert.equal(value.again.k, 'v')
})

test('deserializeV8：字符串对象 / BigInt 对象也占对象引用表槽位', () => {
  // 外层对象 id=0、字符串对象 id=1、BigInt 对象 id=2。
  // refWrap 必须取回 "doubao"；refBig 取回 BigInt 的 null 占位——两条引用
  // 同时成立才说明两个包装对象都占了槽位。
  const strObj = Buffer.concat([Buffer.from([0x73]), v8OneByteString('doubao')])
  const bigObj = Buffer.from([0x7a, 0x02, 1, 0, 0, 0, 0, 0, 0, 0])
  const stream = Buffer.concat([
    Buffer.from([0x6f]),
    v8OneByteString('wrap'),
    strObj,
    v8OneByteString('big'),
    bigObj,
    v8OneByteString('refWrap'),
    Buffer.from([0x5e, 0x01]), // kObjectReference id=1
    v8OneByteString('refBig'),
    Buffer.from([0x5e, 0x02]), // kObjectReference id=2
    Buffer.from([0x7b, 0x08]),
  ])
  const value = deserializeV8(stream, 0).value
  assert.equal(value.wrap, 'doubao')
  assert.equal(value.refWrap, 'doubao')
  assert.equal(value.big, null)
  assert.equal(value.refBig, null)
})

test('deserializeV8：ArrayBuffer / 可变 ArrayBuffer', () => {
  const ab = Buffer.concat([Buffer.from([0x42]), varintBytes(3), Buffer.from([1, 2, 3])])
  assert.deepEqual([...deserializeV8(ab, 0).value], [1, 2, 3])

  const rab = Buffer.concat([Buffer.from([0x7e]), varintBytes(2), varintBytes(8), Buffer.from([9, 8])])
  assert.deepEqual([...deserializeV8(rab, 0).value], [9, 8])
})

test('deserializeV8：宿主对象与共享对象给占位符（内容不在 SSV 流里）', () => {
  assert.equal(deserializeV8(Buffer.from([0x5c]), 0).value, '[host object]')
  assert.equal(deserializeV8(Buffer.from([0x70, 0x00]), 0).value, '[shared object]')
})

test('deserializeV8：错误对象读出 message', () => {
  const err = Buffer.concat([
    Buffer.from([0x72]), // kError
    Buffer.from([0x54]), // TypeError 之类子 tag（取值落在 0x45..0x55 段）
    Buffer.from([0x6d]), // kMessage
    v8OneByteString('boom'),
    Buffer.from([0x2e]), // kEnd
  ])
  const got = deserializeV8(err, 0).value
  assert.equal(got.message, 'boom')
})

test('deserializeV8：截断的流抛错（不返回半个对象）', () => {
  assert.throws(() => deserializeV8(Buffer.from([0x6f, 0x22, 0x05]), 0), /V8/)
})

test('deserializeV8：BigInt 占位为 null（不在本层做数值转换）', () => {
  const bigint = Buffer.from([0x5a, 0x04, 0, 0, 0, 0, 0, 0, 0, 0])
  assert.equal(deserializeV8(bigint, 0).value, null)
})
