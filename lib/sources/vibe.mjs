// lib/sources/vibe.mjs — Mistral Vibe CLI 会话读取与导入编排（host 面，非纯函数）
//
// 存储布局（mistralai/mistral-vibe）：
//   ~/.vibe/logs/session/<session_dir>/ 里包含：
//     meta.json       元数据文件（session_id / title / environment.working_directory 等）
//     messages.jsonl  消息记录（LLMMessage 序列）
//
// 本模块负责：
//   1. 目录发现与会话列表抽取（listVibeSessions / readVibeSessionSummary）
//   2. 复合 stat 指纹计算（messages.jsonl + meta.json 联合指纹）
//   3. 单会话导入状态机（importVibeSession）、目录批量（importVibeDirectory）与只读预览

import { join } from 'node:path'
import { convertVibeJson, parseVibeTime } from '../convert/vibe.mjs'
import { markTrimmedSource } from '../budget.mjs'
import {
  previewEntry,
  attachConversionDetails,
  runDecision,
  finalizeConvertedSession,
  runImportBatch,
} from '../import-core.mjs'
import {
  loadImports,
  unwrapRecord,
  listPersistedIds,
  archivedSessionIds,
  argsFingerprint,
  isSessionIdChange,
  decideSingle,
} from '../imports.mjs'

export const VIBE_SESSION_FILE = 'messages.jsonl'
export const VIBE_META_FILE = 'meta.json'

/**
 * 跨平台解析 Vibe 默认数据根。
 */
export function vibeUserDataDirs(home) {
  const dirs = []
  if (process.env.VIBE_HOME) {
    dirs.push(join(process.env.VIBE_HOME, 'logs', 'session'))
  }
  if (home) {
    dirs.push(join(home, '.vibe', 'logs', 'session'))
  }
  return dirs
}

function parentOf(p) {
  const s = String(p).replace(/[\\/]+$/, '').split(/[\\/]/)
  s.pop()
  return s.join('/')
}

export async function vibeMessagesTarget(ctx, targetPath) {
  const p = typeof targetPath === 'string' ? targetPath : (targetPath.displayPath || ctx.fs.processPath(targetPath))
  if (/messages\.jsonl$/i.test(p)) {
    return ctx.fs.resolve(p)
  }
  return ctx.fs.resolve(join(p, VIBE_SESSION_FILE))
}

export async function vibeMetaTarget(ctx, targetPath) {
  const p = typeof targetPath === 'string' ? targetPath : (targetPath.displayPath || ctx.fs.processPath(targetPath))
  if (/messages\.jsonl$/i.test(p)) {
    return ctx.fs.resolve(join(parentOf(p), VIBE_META_FILE))
  }
  return ctx.fs.resolve(join(p, VIBE_META_FILE))
}

export async function vibeStat(ctx, messagesTarget, metaTarget) {
  const m = await ctx.fs.stat(messagesTarget)
  const s = metaTarget ? await ctx.fs.stat(metaTarget) : null
  return {
    type: 'file',
    size: (m && typeof m.size === 'number' ? m.size : 0) + (s && typeof s.size === 'number' ? s.size : 0),
    version: (m ? m.version : '') + '|' + (s ? s.version : ''),
  }
}

export async function vibeIsSessionDir(hostOrCtx, dir) {
  const dirPath = typeof dir === 'string' ? dir : (dir.displayPath || hostOrCtx.fs?.processPath(dir))
  const msgPath = join(dirPath, VIBE_SESSION_FILE)
  const st = hostOrCtx.stat ? await hostOrCtx.stat(msgPath) : await hostOrCtx.fs.stat(await hostOrCtx.fs.resolve(msgPath))
  return Boolean(st && st.type === 'file')
}

export async function collectVibeSessions(ctx, dirTarget, out, recursive = true) {
  const entries = await ctx.fs.listDir(dirTarget)
  for (const entry of entries) {
    if (entry.type !== 'directory') continue
    const sub = await ctx.fs.resolve(entry.target.displayPath || entry.target.targetKey)
    if (await vibeIsSessionDir(ctx, sub)) {
      out.push(sub)
    } else if (recursive) {
      await collectVibeSessions(ctx, sub, out, recursive)
    }
  }
}

export async function listVibeSessions(host, dir) {
  const out = []
  if (await vibeIsSessionDir(host, dir)) {
    out.push(String(dir))
    return out
  }
  const entries = await host.readDir(dir)
  for (const entry of entries || []) {
    if (entry.type !== 'directory') continue
    const sub = join(dir, entry.name)
    if (await vibeIsSessionDir(host, sub)) {
      out.push(sub)
    }
  }
  return out
}

export async function readVibeSessionSummary(host, sessionDir) {
  const metaPath = join(sessionDir, VIBE_META_FILE)
  const messagesPath = join(sessionDir, VIBE_SESSION_FILE)
  let meta = null
  try {
    const metaText = await host.readText(metaPath)
    meta = JSON.parse(metaText)
  } catch {}

  let title = meta && typeof meta.title === 'string' ? meta.title : ''
  if (!title) {
    try {
      const head = await host.readHead(messagesPath, 4096)
      if (head) {
        const lines = head.split('\n')
        for (const line of lines) {
          if (!line.trim()) continue
          const m = JSON.parse(line)
          if (m && m.role === 'user') {
            const text = typeof m.content === 'string'
              ? m.content
              : (Array.isArray(m.content) ? m.content.map((p) => p.text || '').join(' ') : '')
            if (text.trim()) {
              title = text.trim()
              break
            }
          }
        }
      }
    } catch {}
  }

  return {
    id: meta && typeof meta.session_id === 'string' ? meta.session_id : (sessionDir.split(/[\\/]/).pop() || 'unknown'),
    title,
    directory: meta?.environment?.working_directory || meta?.origin_directory || null,
    createdAt: meta ? parseVibeTime(meta.start_time) : null,
    model: meta?.config?.active_model || null,
  }
}

export async function vibeDeriveArgs(ctx, target) {
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const metaTarget = await vibeMetaTarget(ctx, sourcePath)
  let meta = null
  try {
    const metaText = await ctx.fs.readText(metaTarget)
    meta = JSON.parse(metaText)
  } catch {}
  return {
    meta,
    cwd: meta?.environment?.working_directory || meta?.origin_directory || undefined,
    title: meta?.title || undefined,
    vibeId: meta?.session_id || undefined,
    model: meta?.config?.active_model || undefined,
  }
}

export async function importVibeSession(ctx, target, args, { registryDir, persisted, fingerprintKeys = [] } = {}) {
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  const archivedIds = archivedSessionIds(ctx)
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const registry = await loadImports(registryDir)
  let known = unwrapRecord(registry.imports[sourcePath])
  if (known && known.kind !== 'single') known = null
  if (known && (!known.dshId || !persistedSet.has(known.dshId) || archivedIds.has(known.dshId))) known = null
  const fingerprint = argsFingerprint(args, fingerprintKeys)
  const derived = await vibeDeriveArgs(ctx, target)
  const merged = { ...args, ...derived }

  const messagesTarget = await vibeMessagesTarget(ctx, sourcePath)
  const metaTarget = await vibeMetaTarget(ctx, sourcePath)
  const stat = await vibeStat(ctx, messagesTarget, metaTarget)

  if (known && merged.force !== true && merged.replace !== true && !isSessionIdChange(merged, known.dshId)) {
    if (typeof known.args === 'string' && fingerprint !== known.args) {
      return { sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported', argsChanged: true }
    }
    if (typeof known.budget === 'number' && known.budget !== merged.budget) {
      return { sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported', budgetChanged: true }
    }
    if (stat && stat.version === known.version && stat.size === known.sizeBytes) {
      return { sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0, alreadyImported: true, status: 'already-imported' }
    }
  }

  const messagesText = await ctx.fs.readText(messagesTarget)
  const out = markTrimmedSource(convertVibeJson(messagesText, { ...merged, sourcePath }), merged)
  finalizeConvertedSession(out, merged, 'Mistral Vibe')

  if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
    const res = { sessionId: 'none', turns: 0, messages: 0, toolCalls: 0, skipped: 1, alreadyImported: false, status: 'skipped' }
    if (out.skipReason) res.skipReason = out.skipReason
    return attachConversionDetails(out, res)
  }

  const decision = await decideSingle(ctx, {
    known,
    converted: out,
    stat,
    args: merged,
    fingerprint,
    persisted: persistedSet,
    sourcePath,
    budget: merged.budget,
    archivedIds,
    importFormat: 'vibe',
  })

  return attachConversionDetails(
    out,
    await runDecision(ctx, decision, registryDir, sourcePath, persistedSet, {
      workspaceMode: args.workspaceMode,
      workspaceDir: args.workspaceDir,
    })
  )
}

export async function importVibeFile(ctx, target, args, options = {}) {
  const info = await ctx.fs.stat(target)
  if (info && info.type === 'directory') {
    return importVibeSession(ctx, target, args, options)
  }
  return importVibeSession(ctx, target, args, options)
}

// vibe 目录批量：目录本身是会话目录时按一条处理，否则递归收集会话目录；逐会话走单会话
// 状态机，计数与结果条目同其它目录批量（lib/import-batch.mjs 口径）。
export async function importVibeDirectory(ctx, dirTarget, args, options = {}) {
  const sessions = []
  if (await vibeIsSessionDir(ctx, dirTarget)) sessions.push(dirTarget)
  else await collectVibeSessions(ctx, dirTarget, sessions, args.recursive !== false)
  const persisted = options.persisted ?? await listPersistedIds(ctx)
  return runImportBatch(ctx, sessions,
    (target) => importVibeSession(ctx, target, args, { ...options, persisted }),
    { registryDir: options.registryDir, skipReason: () => 'not a vibe session (no user turns)' })
}

export async function previewVibeSession(ctx, target, args) {
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const derived = await vibeDeriveArgs(ctx, target)
  const messagesTarget = await vibeMessagesTarget(ctx, sourcePath)
  const messagesText = await ctx.fs.readText(messagesTarget)
  const out = markTrimmedSource(convertVibeJson(messagesText, { ...args, ...derived, sourcePath }), args)
  return previewEntry(out)
}

export async function previewVibeFile(ctx, target, args) {
  const info = await ctx.fs.stat(target)
  if (info && info.type === 'directory') return previewVibeSession(ctx, target, args)
  return previewVibeSession(ctx, target, args)
}

export async function previewVibeDirectory(ctx, dirTarget, args) {
  const isSingle = await vibeIsSessionDir(ctx, dirTarget)
  if (isSingle) {
    const single = await previewVibeSession(ctx, dirTarget, args)
    return { total: 1, results: [{ path: dirTarget.displayPath || ctx.fs.processPath(dirTarget), ...single }] }
  }
  const sessions = []
  await collectVibeSessions(ctx, dirTarget, sessions, args.recursive !== false)
  const results = []
  for (const target of sessions) {
    const path = target.displayPath || ctx.fs.processPath(target)
    try {
      results.push({ path, ...(await previewVibeSession(ctx, target, args)) })
    } catch (err) {
      results.push({ path, status: 'failed', error: String((err && err.message) || err) })
    }
  }
  return { total: sessions.length, results }
}