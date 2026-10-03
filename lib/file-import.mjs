// lib/file-import.mjs — 面板「从文件导入」的 host 面编排（路径 / 目录 / 上传件）
//
// 与发现条目导入（lib/panel.mjs 的 importDiscoveryItem）的分工：入口是**用户直接给的
// 文件或目录**，没有发现层清单与 sessionId，格式靠三级探测（lib/convert/local-jsonl.mjs）
// 或用户显式指定。命中 .dshbundle 便携包时转交 restore_bundle——便携包是事件级无损备份，
// 走普通转换只会被当成「未识别」，必须走它自己的指纹校验 + 还原状态机。
//
// 预览与导入共用同一套判定（预览零副作用，复用 import-core 的 previewEntry /
// applyCwdRemap 与 budget 的 markTrimmedSource，保证「预览显示的 cwd/规模 == 落盘」）：
//   * 单文件 → local-jsonl 单文件；bundle → restore_bundle；
//   * 目录   → 递归收集可识别文件（.jsonl / .jsonl.zstd / .json / .dshbundle.json，跳过
//              node_modules 与 .git）后按批处理，未识别的文件逐条给出失败原因而非静默跳过；
//   * vibe 形态的会话目录（messages.jsonl + meta.json）由 deriveImportFileArgs 补
//     meta/cwd/title/model —— 于是 ~/.vibe/logs/session 这类目录也能从文件导入走通，
//     且 meta 映射只有一份（该来源自己的 host 适配器）。
//
// zstd 读取走 lib/sources/dsh.mjs 的 readDshText（多帧 fzstd 解压 + 明文直读）：
// local-jsonl 的其它来源没有 zstd 通道，漏传会把压缩字节当文本读出 0 轮。
import { convertLocalJsonl, sniffInterchangeMarker } from './convert/index.mjs'
import { importTranscript, importDirectory, previewEntry, applyCwdRemap } from './import-core.mjs'
import { markTrimmedSource } from './budget.mjs'
import { readDshText } from './sources/dsh.mjs'
import { vibeDeriveArgs } from './sources/vibe.mjs'
import { restoreBundle } from './restore.mjs'

/** 递归收集时跳过的目录名（构建产物 / 版本库元数据，不可能有会话转写）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn'])

/** 文件导入可识别的后缀（探测仍以内容为准，这里只决定「要不要尝试」）。 */
export function isImportableName(name) {
  const lower = String(name || '').toLowerCase()
  return lower.endsWith('.jsonl') || lower.endsWith('.jsonl.zstd')
    || lower.endsWith('.zstd') || lower.endsWith('.json') || lower.endsWith('.dshbundle')
}

/** 递归收集目录里的候选文件（host 面；与 import-core 的 collector 约定同签名）。 */
export async function collectImportableFiles(ctx, dirTarget, out, recursive = true) {
  let entries = []
  try {
    entries = await ctx.fs.listDir(dirTarget)
  } catch {
    return // 读不到的目录：留给上层报「路径不可读」，此处不静默造空列表
  }
  for (const entry of entries) {
    if (entry.type === 'directory') {
      if (recursive && !SKIP_DIRS.has(entry.name)) await collectImportableFiles(ctx, entry.target, out, recursive)
    } else if (entry.type === 'file' && isImportableName(entry.name)) {
      out.push(entry.target)
    }
  }
}

/**
 * 按文件派生转换参数：Mistral Vibe 的会话目录里 messages.jsonl 由同目录 meta.json 提供
 * title / cwd / model / 源 id。meta 映射归该来源的 host 适配器（vibeDeriveArgs），本文件
 * 只判「是不是那种文件」，不重写一份 meta 解析（避免同一来源的第 3 处副本）。
 */
export async function deriveImportFileArgs(ctx, target) {
  const p = target && (target.displayPath || target.path) ? (target.displayPath || target.path) : String(target || '')
  if (/[\\/]?messages\.jsonl$/i.test(p)) return await vibeDeriveArgs(ctx, target)
  return {}
}

// 有界读头（bundle 标记只看文件头；streamText 缺失时退回整读截断）。
async function readHead(ctx, target, cap = 65536) {
  try {
    if (typeof ctx.fs.streamText === 'function') {
      const iter = await ctx.fs.streamText(target)
      let out = ''
      for await (const chunk of iter) {
        out += chunk
        if (out.length >= cap) break
      }
      return out.slice(0, cap)
    }
    return (await ctx.fs.readText(target)).slice(0, cap)
  } catch {
    return null // 读不到头：交给后续正常读取路径报错（这里不吞掉真正的失败）
  }
}

// 显式指定的解析器：'auto'/空 = 自动识别；其余必须是 local-jsonl 认识的格式名。
export function normalizeFormatArg(format) {
  if (typeof format !== 'string' || !format || format === 'auto') return undefined
  return format
}

function errorText(err) {
  return String((err && err.message) || err)
}

/**
 * 预览：单文件返回 { kind:'single', ...previewEntry, detectedFormat, detectedBy, failures }，
 * 目录返回 { kind:'batch', total, results:[同款条目] }。零副作用（不落盘、不写 registry）。
 */
export async function previewFileTarget(ctx, { path: sourcePath, format, budget, budgetSource, importSystemPrompt } = {}) {
  if (typeof sourcePath !== 'string' || !sourcePath) return { ok: false, error: '缺少路径' }
  let target
  let info
  try {
    target = await ctx.fs.resolve(sourcePath)
    info = await ctx.fs.stat(target)
  } catch (err) {
    return { ok: false, error: '路径无法访问：' + errorText(err) }
  }
  if (!info) return { ok: false, error: '路径不存在：' + sourcePath }
  const base = { format: normalizeFormatArg(format), budget, budgetSource, importSystemPrompt }
  if (info.type === 'directory') {
    const files = []
    await collectImportableFiles(ctx, target, files, true)
    const results = []
    for (const f of files) results.push(await previewOneTarget(ctx, f, base))
    return { ok: true, kind: 'batch', total: files.length, results }
  }
  const one = await previewOneTarget(ctx, target, base)
  return { ok: true, kind: 'single', ...one }
}

// 单个目标的预览条目（单文件路径与目录批处理共用）。
async function previewOneTarget(ctx, target, base) {
  const p = target.displayPath || ctx.fs.processPath(target)
  let raw
  try {
    raw = await readDshText(ctx, target)
  } catch (err) {
    return { path: p, status: 'failed', error: '读取失败：' + errorText(err) }
  }
  // 便携包：识别但不在普通导入里转换——面板把它标成「还原」，导入走 restore_bundle
  if (sniffInterchangeMarker(raw) === 'bundle') {
    return { path: p, bundle: true, note: 'interchange 便携包：导入即还原为可继续的 DSH 会话' }
  }
  let derived = {}
  try {
    derived = await deriveImportFileArgs(ctx, target)
  } catch (err) {
    return { path: p, status: 'failed', error: '派生参数失败：' + errorText(err) }
  }
  let out
  try {
    out = markTrimmedSource(convertLocalJsonl(raw, { ...base, ...derived, sourcePath: p }), base)
    out = applyCwdRemap(out, base)
  } catch (err) {
    return { path: p, status: 'failed', error: '解析失败：' + errorText(err) }
  }
  const entry = { path: p, ...previewEntry(out) }
  if (out.detectedFormat) entry.detectedFormat = out.detectedFormat
  if (out.detectedBy) entry.detectedBy = out.detectedBy
  if (Array.isArray(out.failures) && out.failures.length > 0) entry.failures = out.failures
  // 附加降级计数（>0 才占键）：面板把这些摊在预览卡片里，与导入结果同口径
  for (const k of ['imagesDegraded', 'skippedBlocks', 'malformedTurns', 'malformedSteps', 'droppedToolResults', 'usageDropped', 'secrets']) {
    const v = out[k]
    if (typeof v === 'number' && v > 0) entry[k] = v
    else if (Array.isArray(v) && v.length > 0) entry[k] = v.length
  }
  return entry
}

/**
 * 导入：单文件 → 状态机（幂等 / 增量 / force 全套继承），目录 → 批处理；
 * bundle → restore_bundle。返回 { ok, kind:'single'|'batch'|'bundle', ...result }。
 */
export async function importFileTarget(ctx, options = {}) {
  const {
    registryDir, path: sourcePath, format, force, replace, budget, budgetSource,
    importSystemPrompt, workspaceMode, workspaceDir, cwdRemap, storeImages, restamp, sessionId,
  } = options
  if (typeof sourcePath !== 'string' || !sourcePath) return { ok: false, error: '缺少路径' }
  let target
  let info
  try {
    target = await ctx.fs.resolve(sourcePath)
    info = await ctx.fs.stat(target)
  } catch (err) {
    return { ok: false, error: '路径无法访问：' + errorText(err) }
  }
  if (!info) return { ok: false, error: '路径不存在：' + sourcePath }
  const displayPath = target.displayPath || ctx.fs.processPath(target)
  // bundle 只可能是 JSON 文档：.jsonl / .zstd 不必读头（省一次整读），按后缀先分流
  if (info.type === 'file' && !/\.jsonl(\.zstd)?$/i.test(displayPath)) {
    const head = await readHead(ctx, target)
    if (sniffInterchangeMarker(head) === 'bundle') {
      const out = await restoreBundle(ctx, {
        path: sourcePath, force: force === true, replace: replace === true,
        budget, budgetSource, workspaceMode, workspaceDir, cwdRemap, storeImages, restamp,
      }, { registryDir })
      return { ok: true, kind: 'bundle', mode: 'single', ...out }
    }
  }
  const args = {
    path: sourcePath,
    ...(force === true ? { force: true } : {}),
    ...(replace === true ? { replace: true } : {}),
    budget, budgetSource, importSystemPrompt,
    ...(workspaceMode ? { workspaceMode } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(cwdRemap ? { cwdRemap } : {}),
    ...(storeImages !== undefined ? { storeImages } : {}),
    ...(restamp === true ? { restamp: true } : {}),
    ...(sessionId ? { sessionId } : {}),
  }
  const forced = normalizeFormatArg(format)
  const withFormat = forced ? { ...args, format: forced } : args
  try {
    if (info.type === 'directory') {
      const out = await importDirectory(ctx, target, withFormat, {
        convert: convertLocalJsonl,
        sourceLabel: 'Local JSONL',
        importFormat: 'local-jsonl',
        collect: collectImportableFiles,
        deriveArgs: (t) => deriveImportFileArgs(ctx, t),
        registryDir,
        readText: readDshText,
      })
      return { ok: true, kind: 'batch', mode: 'batch', ...out }
    }
    const derived = await deriveImportFileArgs(ctx, target)
    const out = await importTranscript(ctx, target, { ...withFormat, ...derived }, convertLocalJsonl, {
      registryDir, readText: readDshText, sourceLabel: 'Local JSONL', importFormat: 'local-jsonl',
    })
    return { ok: true, kind: 'single', mode: 'single', ...out }
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}
