// image.test.mjs — IR 图片块构造（lib/convert/image.mjs）：来源形态识别、上限、降级口径。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  IMAGE_MEDIA_TYPES,
  MAX_IMAGE_BASE64_CHARS,
  imageBlockFromBase64,
  imageBlockFromBytes,
  imageBlockFromDataUrl,
  imageBlockFromSource,
  imageDisplayName,
  isImageBlock,
  normalizeImageMediaType,
  sniffImageMediaType,
} from '../lib/convert/image.mjs'

// 1×1 PNG（67 字节）与常见魔数：测试只关心形状与前缀，不关心像素
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG_B64, 'base64')
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])
const GIF_HEAD = Buffer.from('GIF89a' + '\u0000'.repeat(6), 'binary')
const WEBP_HEAD = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')])

test('normalizeImageMediaType: 归一、去参数、image/jpg→jpeg，非宿主可收类型返回 null', () => {
  assert.ok(IMAGE_MEDIA_TYPES.includes('image/png'))
  assert.equal(normalizeImageMediaType('IMAGE/PNG'), 'image/png')
  assert.equal(normalizeImageMediaType('image/jpeg; charset=binary'), 'image/jpeg')
  assert.equal(normalizeImageMediaType('image/jpg'), 'image/jpeg')
  assert.equal(normalizeImageMediaType('image/svg+xml'), null)
  assert.equal(normalizeImageMediaType('application/pdf'), null)
  assert.equal(normalizeImageMediaType(undefined), null)
})

test('sniffImageMediaType: 按魔数认 PNG/JPEG/GIF/WebP，短缓冲与未知返回 null', () => {
  assert.equal(sniffImageMediaType(PNG_BYTES), 'image/png')
  assert.equal(sniffImageMediaType(JPEG_HEAD), 'image/jpeg')
  assert.equal(sniffImageMediaType(GIF_HEAD), 'image/gif')
  assert.equal(sniffImageMediaType(WEBP_HEAD), 'image/webp')
  assert.equal(sniffImageMediaType(Buffer.from([1, 2, 3])), null)
  assert.equal(sniffImageMediaType(Buffer.alloc(32)), null)
})

test('imageDisplayName: 只留文件名、去路径、过长/无意义返回 undefined', () => {
  assert.equal(imageDisplayName('D:\\shots\\a.png'), 'a.png')
  assert.equal(imageDisplayName('/home/me/b.jpg'), 'b.jpg')
  assert.equal(imageDisplayName('  c.webp  '), 'c.webp')
  assert.equal(imageDisplayName(''), undefined)
  assert.equal(imageDisplayName('x'.repeat(200) + '.png'), undefined)
  assert.equal(imageDisplayName('data:image/png;base64,AAAA'), undefined)
  assert.equal(imageDisplayName(undefined), undefined)
})

test('imageBlockFromBase64: 剥离空白、带上媒体类型与文件名；非法载荷返回 null', () => {
  assert.deepEqual(imageBlockFromBase64(PNG_B64, 'image/png'), { type: 'image', data: PNG_B64, mediaType: 'image/png' })
  assert.deepEqual(imageBlockFromBase64('  AAAA\n', 'image/jpeg', 'D:\\x\\shot.png'),
    { type: 'image', data: 'AAAA', mediaType: 'image/jpeg', name: 'shot.png' })
  assert.equal(imageBlockFromBase64('', 'image/png'), null)
  assert.equal(imageBlockFromBase64('AAAA', 'image/svg+xml'), null)
  assert.equal(imageBlockFromBase64('A'.repeat(MAX_IMAGE_BASE64_CHARS + 1), 'image/png'), null, '超上限不上 IR')
})

test('imageBlockFromDataUrl: 只认 base64 的 data URL，非图片/非 data 返回 null', () => {
  assert.deepEqual(imageBlockFromDataUrl('data:image/png;base64,AAAA'), { type: 'image', data: 'AAAA', mediaType: 'image/png' })
  assert.equal(imageBlockFromDataUrl('data:text/plain;base64,AAAA'), null)
  assert.equal(imageBlockFromDataUrl('data:image/png,AAAA'), null, '非 base64 编码不收')
  assert.equal(imageBlockFromDataUrl('https://example.com/a.png'), null)
  assert.equal(imageBlockFromDataUrl(undefined), null)
})

test('imageBlockFromBytes: 按魔数补媒体类型；不可识别返回 null', () => {
  assert.deepEqual(imageBlockFromBytes(PNG_BYTES), { type: 'image', data: PNG_B64, mediaType: 'image/png' })
  assert.equal(imageBlockFromBytes(JPEG_HEAD)?.mediaType, 'image/jpeg')
  assert.deepEqual(imageBlockFromBytes(PNG_BYTES, 'image/jpeg'), { type: 'image', data: PNG_B64, mediaType: 'image/jpeg' },
    '显式媒体类型优先于魔数')
  assert.equal(imageBlockFromBytes(Buffer.from([1, 2, 3, 4])), null)
  assert.equal(imageBlockFromBytes(new Uint8Array(0)), null)
})

test('imageBlockFromSource: 认各源形态（claude/codex/grokbuild/pi/opencode）；无字节返回 null', () => {
  // claude
  assert.deepEqual(
    imageBlockFromSource({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }),
    { type: 'image', data: 'AAAA', mediaType: 'image/png' })
  // codex（data URL）
  assert.deepEqual(imageBlockFromSource({ type: 'input_image', image_url: 'data:image/jpeg;base64,BBBB' }),
    { type: 'image', data: 'BBBB', mediaType: 'image/jpeg' })
  // grokbuild（无媒体类型，按 base64 头部魔数嗅探）
  assert.deepEqual(imageBlockFromSource({ type: 'image', data: PNG_B64 }),
    { type: 'image', data: PNG_B64, mediaType: 'image/png' })
  // pi
  assert.deepEqual(imageBlockFromSource({ type: 'image', mimeType: 'image/webp', data: 'CCCC' }),
    { type: 'image', data: 'CCCC', mediaType: 'image/webp' })
  // OpenAI / Kimi ContentPart（image_url 是 { url } 对象，不是字符串）
  assert.deepEqual(imageBlockFromSource({ type: 'image_url', image_url: { url: 'data:image/png;base64,EEEE' } }),
    { type: 'image', data: 'EEEE', mediaType: 'image/png' })
  // opencode file part（mime + data URL）
  assert.deepEqual(imageBlockFromSource({ type: 'file', mime: 'image/gif', filename: 'x.gif', url: 'data:image/gif;base64,DDDD' }),
    { type: 'image', data: 'DDDD', mediaType: 'image/gif' })
  // 已是宿主附件引用 → 原样带过（DSH 源回灌）
  const ref = { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
  assert.deepEqual(imageBlockFromSource({ type: 'image', attachment: ref }), { type: 'image', attachment: ref })
  // 拿不到字节
  assert.equal(imageBlockFromSource({ type: 'image', source: { type: 'url', url: 'https://x/a.png' } }), null)
  assert.equal(imageBlockFromSource({ type: 'image_url', imageUrl: { url: 'blobref:image/png;deadbeef' } }), null)
  assert.equal(imageBlockFromSource({ type: 'image' }), null)
  assert.equal(imageBlockFromSource(null), null)
})

test('isImageBlock: 待落地（data）与已引用（attachment）都算图片块，非法形状不算', () => {
  assert.equal(isImageBlock({ type: 'image', data: 'AAAA', mediaType: 'image/png' }), true)
  assert.equal(isImageBlock({ type: 'image', attachment: { attachmentId: 'sha256:x' } }), true)
  assert.equal(isImageBlock({ type: 'image' }), false)
  assert.equal(isImageBlock({ type: 'text', text: 'x' }), false)
  assert.equal(isImageBlock(null), false)
})
