// lib/attachments.mjs — 会话事件里的 IR 图片块 → 宿主附件（ctx.attachments）
//
// 落盘边界的最后一道替换：转换层产出 `{ type:'image', data:<base64>, mediaType, name? }`
// （见 lib/convert/image.mjs），**字节绝不能写进会话日志**——宿主 @deepseek-ai/dsh-llm 的
// ImageBlock 只认 `{ type:'image', attachment: ImageAttachmentRef }`，消费方从不持久化
// base64/路径/URL。所以写盘前：
//   * 已是附件引用（DSH 源回灌 / 导出再导入）→ 原样保留，计入 stored（内容寻址，不重复存）；
//   * 有待落地字节 → `ctx.attachments.saveImage(...)` 落成不可变对象，替换为返回的引用；
//   * 服务缺席（可选服务）/ 类型不收（第一版只收 PNG/JPEG/WebP/GIF）/ 超限 / 载荷畸形
//     → 替换为 `[image]` 文本占位并计入 degraded（失败要大声，绝不把 base64 留在日志里）。
//
// 幂等：替换后的引用块再跑一次是空操作（stored 会重复计一次，调用方每批只跑一次）。
// 副作用边界：saveImage 失败可能留下不可达的内容寻址对象（宿主无 GC，见 dsh-attachment
// 的已知限制）；这是它明确允许的形态，不因此让整次导入失败。
//
// 上限：单会话最多落 MAX_IMAGES_PER_SESSION 张，超出部分降级为占位（防止异常转录把磁盘
// 撑爆；计数照实上报，不静默截断）。

import { IMAGE_PLACEHOLDER, imageBlockFromSource, normalizeImageMediaType } from './convert/image.mjs'

/** 单会话落成附件的图片上限（超出降级为占位并计数）。 */
export const MAX_IMAGES_PER_SESSION = 500

// 附件引用是当前世代（V4）宿主的概念：V3 generation 的落点（面板「导入到 → DSH（V3）」）
// 目标宿主不认识 `attachment` 形状，写进去的图片块在那边读不出来。所以目标代次 < 本值时
// 一律降级为 [image] 占位（含已是引用的块），并计入 degraded——宁可占位，也不产出旧宿主
// 打不开的日志。见 docs/architecture.md D14。
export const MIN_IMAGE_BLOCK_VERSION = 4

/** 目标会话代次是否支持附件引用（未知代次按支持处理，跟随宿主当前行为）。 */
export function supportsImageBlocks(targetVersion) {
  return !Number.isSafeInteger(targetVersion) || targetVersion >= MIN_IMAGE_BLOCK_VERSION
}

/** 宿主附件服务（@deepseek-ai/dsh-attachment 的 AttachmentStore，服务名 "attachments"）。 */
export function attachmentService(ctx) {
  const svc = ctx && typeof ctx.get === 'function' ? ctx.get('attachments') : null
  return svc && typeof svc.saveImage === 'function' ? svc : null
}

/** base64 → 字节（载荷已在转换层校验过形状与上限）。 */
export function base64ToBytes(b64) {
  return Buffer.from(String(b64), 'base64')
}

// 事件里可能出现内容块数组的三个位置：user/assistant 消息的 message.content、
// V3 tool/result 的 wrapper 内层 content、以及少数事件把块挂在 data.content。
function contentArraysOf(ev) {
  const out = []
  const data = ev && typeof ev.data === 'object' && ev.data !== null ? ev.data : null
  if (!data) return out
  const message = data.message && typeof data.message === 'object' ? data.message : null
  if (message && Array.isArray(message.content)) out.push(message.content)
  if (Array.isArray(data.content)) out.push(data.content)
  return out
}

// 递归处理一个块数组：image 块就地替换；tool-result wrapper 的内层 content 递归。
async function replaceInBlocks(ctx, svc, blocks, limit, tally, warnings, options = {}) {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (!block || typeof block !== 'object') continue
    if (block.type === 'image') {
      const next = await replaceImageBlock(ctx, svc, block, limit, tally, warnings, options)
      blocks[i] = next
      continue
    }
    if (block.type === 'tool-result' && Array.isArray(block.content)) {
      await replaceInBlocks(ctx, svc, block.content, limit, tally, warnings, options)
    }
  }
}

async function replaceImageBlock(ctx, svc, block, limit, tally, warnings, options = {}) {
  const allowRefs = options.allowRefs !== false
  // 已是引用：目标代次支持时原样保留（DSH 源回灌 / 导出再导入，不重复存）；
  // 目标代次 < 4 时旧宿主读不出引用 → 降级为占位（不把打不开的日志写出去）
  if (block.attachment && typeof block.attachment === 'object') {
    if (allowRefs) {
      tally.stored++
      return block
    }
    tally.degraded++
    return degradedBlock(block.attachment)
  }
  const data = typeof block.data === 'string' ? block.data : null
  const mediaType = normalizeImageMediaType(block.mediaType)
  if (!data || !mediaType) {
    tally.degraded++
    warnings.push('图片块缺少可落地字节（data/mediaType）')
    return degradedBlock(block)
  }
  if (tally.stored >= limit) {
    tally.degraded++
    warnings.push('单会话图片数超过上限 ' + limit + '，其余降级为占位')
    return degradedBlock(block)
  }
  if (!svc) {
    tally.degraded++
    warnings.push('宿主未提供 attachments 服务，图片降级为占位')
    return degradedBlock(block)
  }
  try {
    const ref = await svc.saveImage({
      data: base64ToBytes(data),
      mediaType,
      ...(typeof block.name === 'string' && block.name ? { name: block.name } : {}),
    })
    tally.stored++
    return { type: 'image', attachment: ref }
  } catch (err) {
    tally.degraded++
    warnings.push('附件保存失败（' + String((err && err.message) || err) + '）')
    return degradedBlock(block)
  }
}

// 降级块：保留可诊断的信息（名字），但绝不带字节
function degradedBlock(block) {
  const name = typeof block.name === 'string' && block.name ? block.name : ''
  return { type: 'text', text: name ? IMAGE_PLACEHOLDER + ' ' + name : IMAGE_PLACEHOLDER }
}

/**
 * 就地替换一批事件里的图片块。
 * @param ctx - 插件上下文（读可选服务 attachments）
 * @param events - 待落盘事件数组（就地修改；返回同一数组便于链式调用）
 * @param options - { maxImages }
 * @returns { events, stored, degraded }
 */
export async function materializeImages(ctx, events, options = {}) {
  const list = Array.isArray(events) ? events : []
  const tally = { stored: 0, degraded: 0 }
  const warnings = []
  if (list.length === 0) return { events: list, ...tally }
  const limit = Number.isSafeInteger(options.maxImages) && options.maxImages > 0
    ? options.maxImages
    : MAX_IMAGES_PER_SESSION
  // storeImages=false：显式关闭图片落地（只留占位，省磁盘）。已是引用的块照旧保留——
  // 引用不产生新的字节，且丢掉它会让源会话里的图片凭空消失。
  const store = options.storeImages !== false
  // 目标代次 < 4（面板选 V3 落点）：附件引用在那边读不出来 → 全部降级为占位
  const versionOk = supportsImageBlocks(options.targetVersion)
  const svc = store && versionOk ? attachmentService(ctx) : null
  if (!store) warnings.push('已按参数关闭图片落地（storeImages=false），图片降级为占位')
  else if (!versionOk) warnings.push('目标会话代次 v' + options.targetVersion + ' 不支持附件引用，图片降级为占位')
  for (const ev of list) {
    for (const blocks of contentArraysOf(ev)) {
      await replaceInBlocks(ctx, svc, blocks, limit, tally, warnings, { allowRefs: versionOk })
    }
  }
  // 每条不同原因只报一次（失败要大声，但不刷屏）
  for (const msg of [...new Set(warnings)]) {
    console.error('[dsh-chat-import] 图片落地降级：' + msg)
  }
  return { events: list, ...tally }
}

/**
 * 把附件引用读回字节（导出方向：会话事件 → 外部格式的 base64/data URL）。
 * 服务缺席或读不到时返回 null，由导出层按既有降级口径计数（不静默）。
 */
export async function readAttachmentBytes(ctx, ref) {
  const svc = ctx && typeof ctx.get === 'function' ? ctx.get('attachments') : null
  if (!svc || typeof svc.readImage !== 'function' || !ref || typeof ref !== 'object') return null
  try {
    const stored = await svc.readImage(ref)
    const data = stored && stored.data
    if (!data) return null
    return Buffer.isBuffer(data) ? data : Buffer.from(data)
  } catch (err) {
    console.error('[dsh-chat-import] 读取附件失败（' + String((err && err.message) || err) + '）')
    return null
  }
}

/**
 * 导出前的图片解引用（就地）：把 `{ type:'image', attachment }` 换成
 * `{ type:'image', data:<base64>, mediaType, name? }`（IR 的待落地形态），让纯函数导出
 * 序列化器能把它写进目标格式。读不到字节（服务缺席 / 对象缺失）→ 换成 `[image]` 占位
 * 文本并计数 unavailable（导出降级里以 attachment-skipped 如实上报）。
 *
 * 返回 { events, resolved, unavailable }。幂等：已是 data 形态的块不再处理。
 */
export async function resolveImagesForExport(ctx, events) {
  const list = Array.isArray(events) ? events : []
  const tally = { resolved: 0, unavailable: 0 }
  for (const ev of list) {
    for (const blocks of contentArraysOf(ev)) {
      await resolveInBlocks(ctx, blocks, tally)
    }
  }
  return { events: list, ...tally }
}

async function resolveInBlocks(ctx, blocks, tally) {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (!block || typeof block !== 'object') continue
    if (block.type === 'image') {
      // 先归一到 IR 形态：日志里可能是宿主原生 `{type:'image',attachment}`、也可能带着
      // 各来源的历史形状（claude 的 source.base64、codex 的 image_url…），导出前统一。
      const normalized = imageBlockFromSource(block)
      blocks[i] = await resolveImageBlock(ctx, normalized ?? block, tally)
      continue
    }
    if (block.type === 'tool-result' && Array.isArray(block.content)) {
      await resolveInBlocks(ctx, block.content, tally)
    }
  }
}

async function resolveImageBlock(ctx, block, tally) {
  if (typeof block.data === 'string' && block.data.length > 0 && normalizeImageMediaType(block.mediaType)) {
    tally.resolved++
    return block
  }
  // 读面只要求 readImage（不要求 saveImage）：判定能力用真正要调的那个方法，
  // 免得「只能读不能写」的宿主面被误判成读不了（readAttachmentBytes 自己会再兜一层）。
  const ref = block.attachment && typeof block.attachment === 'object' ? block.attachment : null
  const bytes = ref ? await readAttachmentBytes(ctx, ref) : null
  if (!bytes || bytes.length === 0) {
    tally.unavailable++
    const name = ref && typeof ref.name === 'string' && ref.name ? ref.name
      : typeof block.name === 'string' && block.name ? block.name : ''
    return { type: 'text', text: name ? IMAGE_PLACEHOLDER + ' ' + name : IMAGE_PLACEHOLDER }
  }
  const mediaType = normalizeImageMediaType(ref.mediaType) || normalizeImageMediaType(block.mediaType) || 'image/png'
  tally.resolved++
  return {
    type: 'image',
    data: bytes.toString('base64'),
    mediaType,
    ...(typeof ref.name === 'string' && ref.name ? { name: ref.name } : {}),
  }
}
