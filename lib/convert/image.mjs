// lib/convert/image.mjs — 图片来源 → IR `image` 块的统一构造（纯函数，零宿主依赖）
//
// IR 的图片块与宿主 @deepseek-ai/dsh-llm 的 ImageBlock 同构，但**分两种状态**：
//   1. 待落地：{ type:'image', data:<base64>, mediaType, name? }
//      转换层能拿到字节时产出；宿主层（lib/attachments.mjs）经 ctx.attachments 存成
//      附件后替换为引用。字节永远不写进会话日志（宿主的 ImageBlock 只认 attachment）。
//   2. 已是引用：{ type:'image', attachment:{ attachmentId, mediaType, bytes, width, height, name? } }
//      DSH 源（dsh/dsh4）回灌、或导出再导入时直接从源日志带过来；宿主层原样保留
//      （内容寻址，同一张图不会重复存）。
//
// 拿不到字节的来源（如 Kimi 的 `blobref:image/png;<hash>`，其 blob 索引不映射该 hash）
// 不构造 image 块：转换器照旧产出 `[image]` 文本占位并计入 imagesDegraded（失败要大声）。
//
// 上限：宿主附件服务第一版只收 PNG/JPEG/WebP/GIF，且会话日志不该被异常载荷撑爆——
// 超过 MAX_IMAGE_BASE64_CHARS 的载荷直接拒绝（调用方降级为占位文本），不静默截断图片。

/** 宿主附件服务接受的图片类型（@deepseek-ai/dsh-attachment 第一版口径）。 */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** 单个图片载荷的 base64 字符上限（约 18MB 二进制）：超过即拒绝，降级为占位。 */
export const MAX_IMAGE_BASE64_CHARS = 24 * 1024 * 1024

/** 降级占位文本（与各源既有口径一致，便于导出侧识别）。 */
export const IMAGE_PLACEHOLDER = '[image]'

/** 媒体类型归一：小写、去参数、image/jpg → image/jpeg；非宿主可收类型返回 null。 */
export function normalizeImageMediaType(mediaType) {
  if (typeof mediaType !== 'string') return null
  const base = mediaType.trim().toLowerCase().split(';')[0].trim()
  const normalized = base === 'image/jpg' ? 'image/jpeg' : base
  return IMAGE_MEDIA_TYPES.includes(normalized) ? normalized : null
}

/** 按魔数嗅探图片类型（源只给了字节、没给媒体类型时用）。 */
export function sniffImageMediaType(bytes) {
  if (!bytes || typeof bytes.length !== 'number' || bytes.length < 12) return null
  const b = bytes
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return null
}

/** 展示名归一：只留文件名（绝不带本地路径），去空白、限长、无则省略。 */
export function imageDisplayName(name) {
  if (typeof name !== 'string') return undefined
  const raw = name.trim()
  // 内联载荷 / 引用式「名字」没有展示价值（data URL、base64 逗号式、blobref/URL 方案）
  if (!raw || /^(data|blobref|https?|file):/i.test(raw) || raw.includes(';base64,')) return undefined
  const base = raw.split(/[\\/]/).pop() || ''
  if (!base || base.length > 120) return undefined
  return base
}

/**
 * base64 + 媒体类型 → IR image 块（拿不到合法载荷时返回 null，由调用方降级）。
 * @param data - 规范 base64（允许含换行，会被剥离）
 * @param mediaType - 源声明的媒体类型
 * @param name - 可选展示名（只留文件名）
 */
export function imageBlockFromBase64(data, mediaType, name) {
  if (typeof data !== 'string') return null
  const payload = data.replace(/\s+/g, '')
  if (payload.length === 0 || payload.length > MAX_IMAGE_BASE64_CHARS) return null
  const mt = normalizeImageMediaType(mediaType)
  if (!mt) return null
  const block = { type: 'image', data: payload, mediaType: mt }
  const display = imageDisplayName(name)
  if (display) block.name = display
  return block
}

/** `data:image/png;base64,…` → IR image 块（非 data URL / 非图片返回 null）。 */
export function imageBlockFromDataUrl(url) {
  if (typeof url !== 'string') return null
  const m = /^data:([a-z0-9.+/-]+);base64,(.*)$/is.exec(url.trim())
  if (!m) return null
  return imageBlockFromBase64(m[2], m[1])
}

/** 字节 → IR image 块（媒体类型缺失时按魔数嗅探；不可识别则返回 null）。 */
export function imageBlockFromBytes(bytes, mediaType, name) {
  if (!bytes || typeof bytes.length !== 'number' || bytes.length === 0) return null
  if (bytes.length > MAX_IMAGE_BASE64_CHARS * 3 / 4) return null
  const mt = normalizeImageMediaType(mediaType) || sniffImageMediaType(bytes)
  if (!mt) return null
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  return imageBlockFromBase64(buf.toString('base64'), mt, name)
}

/** 该内容块是否是 IR 的图片块（待落地或已是引用）。 */
export function isImageBlock(block) {
  if (!block || typeof block !== 'object' || block.type !== 'image') return false
  if (typeof block.data === 'string' && block.data.length > 0) return true
  return !!(block.attachment && typeof block.attachment === 'object')
}

// 各源把图片塞进内容块的方式高度一致（媒体类型 + base64/URL 各换几个键名），这里统一
// 认下已知形态，转换器只调用本函数、不各自判形状：
//   claude   { type:'image', source:{ type:'base64', media_type, data } }
//   codex    { type:'input_image', image_url:'data:…' } / { type:'image_url', url }
//   grokbuild{ type:'image', url:'data:…' } / { type:'image', data:<base64> }
//   pi       { type:'image', mimeType, data }
//   opencode { type:'file', mime, url:'data:…' | data:<base64> }
// 拿不到字节（http(s) URL、blobref 引用、缺字段）返回 null，调用方降级为占位文本。
export function imageBlockFromSource(block) {
  if (!block || typeof block !== 'object') return null
  // 已是宿主附件引用（DSH 源回灌 / 导出再导入）→ 原样保留，宿主层不重复存
  if (block.attachment && typeof block.attachment === 'object'
    && typeof block.attachment.attachmentId === 'string' && block.attachment.attachmentId) {
    return { type: 'image', attachment: block.attachment }
  }
  const source = block.source && typeof block.source === 'object' ? block.source : null
  const imageUrl = block.imageUrl && typeof block.imageUrl === 'object' ? block.imageUrl : null
  const data = typeof block.data === 'string' ? block.data
    : source && typeof source.data === 'string' ? source.data
      : undefined
  const mediaType = block.mediaType || block.mimeType || block.mime_type || block.mime
    || (source && (source.media_type || source.mediaType || source.mime_type))
    || (imageUrl && imageUrl.mediaType)
    || undefined
  const url = typeof block.url === 'string' ? block.url
    : typeof block.image_url === 'string' ? block.image_url
      : imageUrl && typeof imageUrl.url === 'string' ? imageUrl.url
        : source && typeof source.url === 'string' ? source.url
          : undefined
  const name = block.name || block.filename || block.fileName
    || (imageUrl && imageUrl.name) || undefined
  // data URL 优先：媒体类型内嵌且可信（源声明的键名因源而异）
  if (typeof url === 'string') return imageBlockFromDataUrl(url)
  if (typeof data === 'string') {
    // 少数源把整个 data URL 塞进 data 字段
    const fromUrl = imageBlockFromDataUrl(data)
    if (fromUrl) return fromUrl
    // 源没给媒体类型时按魔数嗅探（只看 base64 头部几个字节，不整段解码）
    let mt = mediaType
    if (!normalizeImageMediaType(mt) && typeof Buffer !== 'undefined') {
      mt = sniffImageMediaType(Buffer.from(data.slice(0, 32), 'base64')) || mt
    }
    return imageBlockFromBase64(data, mt, name)
  }
  if (block.bytes instanceof Uint8Array) return imageBlockFromBytes(block.bytes, mediaType, name)
  return null
}
