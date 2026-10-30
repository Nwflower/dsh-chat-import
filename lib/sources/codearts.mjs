// lib/sources/codearts.mjs — CodeArts Desktop 会话读取与导入编排（host 面，非纯函数）
//
// 存储布局（华为云码道 CodeArts 桌面客户端）：
//   ~/.codearts/kernel/sessions/<启动桶>/<session-uuid>/
//     meta.json            会话元数据（session_id / title / working_directory /
//                          used_tokens / current_model / created_at / updated_at）
//     history.jsonl        消息序列
//     messages.index.jsonl 消息索引（指向 history.jsonl 的字节区间）
//
// 与其它「每会话一目录」来源的差别：会话目录**是两层**——外层是启动桶
// （sessions/<时间戳>-<hash>/），内层才是会话目录（<session-uuid>/）。
// 发现层要下钻两层才能拿到会话；导入的幂等键取**内层**会话目录路径。
//
// 发现层（lib/discovery/session-dirs.mjs）与本模块共用 listCodeartsSessions，
// 两侧扫描的是同一棵树——但走不同的 host 抽象（发现层是 host，本模块是 ctx.fs）。

import { join } from 'node:path'
import { convertCodeartsJson, parseCodeartsTime } from '../convert/codearts.mjs'
import { isAbsoluteLike } from '../convert/util.mjs'
import { previewConverted, previewEach, runImportBatch, finishConversion, commitSingle } from '../import-core.mjs'
import { listPersistedIds, argsFingerprint } from '../imports.mjs'
import { loadKnownRecord, singleShortPath, compositeStat } from '../import-state.mjs'

export const CODEARTS_HISTORY_FILE = 'history.jsonl'
export const CODEARTS_META_FILE = 'meta.json'

/**
 * 跨平台解析 CodeArts 默认数据根。
 *
 * `CODEARTS_HOME` 只认**绝对路径**：空白串、相对路径一律忽略并回退默认根（与 cline 的
 * `isAbsoluteLike` 口径一致）。裸拼 join(相对路径) 会产出一个指向工作目录的相对「根」，
 * 面板会把它当真实来源列出来——那比缺失更糟。
 */
export function codeartsUserDataDirs(home) {
  const dirs = []
  const envHome = process.env.CODEARTS_HOME
  if (typeof envHome === 'string' && envHome.trim() && isAbsoluteLike(envHome.trim())) {
    dirs.push(join(envHome.trim(), 'kernel', 'sessions'))
  }
  if (home) {
    dirs.push(join(home, '.codearts', 'kernel', 'sessions'))
  }
  return dirs
}

/**
 * 列出 CodeArts 数据根下的全部会话目录（两层下钻）。
 * 外层桶目录（sessions/<时间戳>-<hash>/）不是会话；内层 <session-uuid>/ 才是。
 * target 三种形态都收：sessions 根（下钻两层）、启动桶（下钻一层）、会话目录本身（自识别）。
 */
export async function listCodeartsSessions(host, dir) {
  const self = await host.stat(join(dir, CODEARTS_HISTORY_FILE))
  if (self && self.type === 'file') return [String(dir)]
  const out = []
  const buckets = await host.readDir(dir)
  for (const bucket of buckets || []) {
    if (bucket.type !== 'directory') continue
    const bucketPath = bucket.path || join(dir, bucket.name)
    const bSt = await host.stat(join(bucketPath, CODEARTS_HISTORY_FILE))
    if (bSt && bSt.type === 'file') {
      out.push(bucketPath)
      continue
    }
    const inner = await host.readDir(bucketPath)
    for (const entry of inner || []) {
      if (entry.type !== 'directory') continue
      const p = entry.path || join(bucketPath, entry.name)
      const st = await host.stat(join(p, CODEARTS_HISTORY_FILE))
      if (st && st.type === 'file') out.push(p)
    }
  }
  return out
}

/**
 * 递归收集会话目录（与 collectSessionDirs 同语义）：目录含 history.jsonl 即会话，
 * 收下不下钻；否则 recursive 时下钻。本来源的会话目录是两层，递归自然覆盖。
 */
export async function collectCodeartsSessions(ctx, dirTarget, out, recursive = true) {
  const target = dirTarget.targetKey !== undefined
    ? dirTarget
    : await ctx.fs.resolve(dirTarget.displayPath || ctx.fs.processPath(dirTarget))
  const dirPath = target.displayPath || target.targetKey
  const st = await ctx.fs.stat(await ctx.fs.resolve(join(dirPath, CODEARTS_HISTORY_FILE)))
  if (st && st.type === 'file') {
    out.push(target)
    return out
  }
  const entries = await ctx.fs.listDir(target)
  for (const entry of entries || []) {
    if (entry.type !== 'directory') continue
    const sub = await ctx.fs.resolve(entry.target.displayPath || entry.target.targetKey)
    await collectCodeartsSessions(ctx, sub, out, recursive)
  }
  return out
}

/** 目录本身是不是一个会话目录（含 history.jsonl）。工具面用它判「目录即单会话」。 */
export async function codeartsIsSessionDir(hostOrCtx, dir) {
  const dirPath = typeof dir === 'string' ? dir : (dir.displayPath || hostOrCtx.fs?.processPath(dir))
  const st = hostOrCtx.stat
    ? await hostOrCtx.stat(join(dirPath, CODEARTS_HISTORY_FILE))
    : await hostOrCtx.fs.stat(await hostOrCtx.fs.resolve(join(dirPath, CODEARTS_HISTORY_FILE)))
  return Boolean(st && st.type === 'file')
}

/** meta.json → 对象。缺失 / 损坏 / 非 JSON 都不致命：返回 null（标题回退首问、cwd 留空）。 */
async function readCodeartsMeta(readText) {
  try {
    return JSON.parse(await readText())
  } catch {
    // meta.json 读不到或不是 JSON：按「无元数据」处理
    return null
  }
}

/**
 * 发现期标题兜底：history.jsonl 头部（4KB）里第一条真人提问。头部按字节截断，
 * 末行常是半截 JSON，所以逐行解析、跳过解析不了的行。synthetic 的上下文注入
 * （todowrite 快照等）不算真人提问。
 */
async function firstUserPromptTitle(host, historyPath) {
  let head
  try {
    head = await host.readHead(historyPath, 4096)
  } catch {
    // history.jsonl 不可读（权限 / 并发删除）：没有兜底标题，会话照常列出
    return ''
  }
  for (const line of String(head || '').split('\n')) {
    if (!line.trim()) continue
    let m
    try {
      m = JSON.parse(line)
    } catch {
      // 头部截断的末行 / 畸形行：跳过，继续找下一条 user 消息
      continue
    }
    if (!m || String(m.role || '').toLowerCase() !== 'user' || m.synthetic === true) continue
    const text = m.content?.SinglePart?.Text?.text
    if (typeof text === 'string' && text.trim()) return text.trim()
  }
  return ''
}

export async function readCodeartsSessionSummary(host, sessionDir) {
  const meta = await readCodeartsMeta(() => host.readText(join(sessionDir, CODEARTS_META_FILE)))
  let title = meta && typeof meta.title === 'string' ? meta.title : ''
  if (!title) title = await firstUserPromptTitle(host, join(sessionDir, CODEARTS_HISTORY_FILE))

  return {
    id: meta && typeof meta.session_id === 'string' ? meta.session_id : (sessionDir.split(/[\\/]/).pop() || 'unknown'),
    title,
    directory: meta?.working_directory || null,
    createdAt: meta ? parseCodeartsTime(meta.created_at) : null,
    updatedAt: meta ? parseCodeartsTime(meta.updated_at) : null,
    model: meta?.current_model?.model_id || null,
  }
}

/** 会话目录路径归一：直传 history.jsonl 时取它的父目录。 */
function sessionDirOf(sourcePath) {
  return /history\.jsonl$/i.test(sourcePath) ? sourcePath.replace(/[\\/]history\.jsonl$/i, '') : sourcePath
}

/**
 * 导入参数派生：从 meta.json 取标题 / cwd / 模型 / 源 id。
 */
export async function codeartsDeriveArgs(ctx, target) {
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const dir = sessionDirOf(sourcePath)
  const meta = await readCodeartsMeta(async () => ctx.fs.readText(await ctx.fs.resolve(join(dir, CODEARTS_META_FILE))))
  return {
    meta,
    cwd: meta?.working_directory || undefined,
    title: meta?.title || undefined,
    codeartsId: meta?.session_id || undefined,
    model: meta?.current_model?.model_id || undefined,
  }
}

/** 会话复合 stat：history.jsonl + meta.json（标题 / cwd 在 meta.json，变更也要触发重读）。 */
export async function codeartsStat(ctx, sessionDir) {
  return compositeStat(ctx, [
    await ctx.fs.resolve(join(sessionDir, CODEARTS_HISTORY_FILE)),
    await ctx.fs.resolve(join(sessionDir, CODEARTS_META_FILE)),
  ])
}

/**
 * 单会话目录导入（状态机）：幂等键 = 会话目录路径；复合 stat 指纹；
 * 读 history.jsonl + meta.json 派生参数再转换落盘。persisted 可传共享快照。
 */
export async function importCodeartsSession(ctx, target, args, { registryDir, persisted, fingerprintKeys = [] } = {}) {
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const sessionDir = sessionDirOf(sourcePath)
  const merged = { ...args, ...(await codeartsDeriveArgs(ctx, target)) }
  const stat = await codeartsStat(ctx, sessionDir)
  const state = await loadKnownRecord(ctx, sessionDir, { registryDir, persisted })
  const fingerprint = argsFingerprint(args, fingerprintKeys)
  const skip = singleShortPath(state.known, merged, fingerprint, stat)
  if (skip) return skip

  const historyText = await ctx.fs.readText(await ctx.fs.resolve(join(sessionDir, CODEARTS_HISTORY_FILE)))
  const out = await finishConversion(ctx, convertCodeartsJson(historyText, { ...merged, sourcePath }), merged, { sourcePath, sourceLabel: 'CodeArts Desktop' })
  return commitSingle(ctx, out, { ...state, stat, args: merged, fingerprint, sourcePath: sessionDir, importFormat: 'codearts', registryDir })
}

/** codearts 单文件入口：会话目录与直传 history.jsonl 走同一个单会话状态机。 */
export function importCodeartsFile(ctx, target, args, options = {}) {
  return importCodeartsSession(ctx, target, args, options)
}

/**
 * codearts 目录批量：递归收集会话目录，逐会话走单会话状态机。
 */
export async function importCodeartsDirectory(ctx, dirTarget, args, options = {}) {
  const sessions = await collectCodeartsSessions(ctx, dirTarget, [], args.recursive !== false)
  const persisted = options.persisted ?? await listPersistedIds(ctx)
  return runImportBatch(ctx, sessions,
    (target) => importCodeartsSession(ctx, target, args, { ...options, persisted }),
    { registryDir: options.registryDir, skipReason: () => 'not a CodeArts session (no user turns)' })
}

export async function previewCodeartsSession(ctx, target, args) {
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const sessionDir = sessionDirOf(sourcePath)
  const derived = await codeartsDeriveArgs(ctx, target)
  const historyText = await ctx.fs.readText(await ctx.fs.resolve(join(sessionDir, CODEARTS_HISTORY_FILE)))
  return previewConverted(convertCodeartsJson(historyText, { ...args, ...derived, sourcePath }), args)
}

/** 预览单文件入口：与 importCodeartsFile 同口径（会话目录 / history.jsonl 同一路径）。 */
export function previewCodeartsFile(ctx, target, args) {
  return previewCodeartsSession(ctx, target, args)
}

/** 目录预览：逐会话预览（与 importCodeartsDirectory 同口径）。 */
export async function previewCodeartsDirectory(ctx, dirTarget, args) {
  const sessions = await collectCodeartsSessions(ctx, dirTarget, [], args.recursive !== false)
  return previewEach(ctx, sessions, (target) => previewCodeartsSession(ctx, target, args))
}
