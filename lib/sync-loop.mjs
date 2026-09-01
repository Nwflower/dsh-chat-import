// lib/sync-loop.mjs — 双向增量同步编排（控制面板 + 定时巡检）
//
// 入站：对开启的来源跑 discover → importDiscoveryItem（复用幂等 / 续写状态机）。
// 出站：把 DSH 会话增量写回 Claude / Codex / Grok。导入源走源文件；原生会话
// 在对应 agent 默认根下落一份副本（outbound.json 记映射）。
// 默认关闭；apply 时不启定时器，避免测试进程挂起。只有面板打开开关才巡检。

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { discoverSessions, createScanCache } from './discovery.mjs'
import { makeDiscoveryHost } from './discovery-host.mjs'
import { loadImports, rememberImport, unwrapRecord, archivedSessionIds, findSourcePathByDshId } from './imports.mjs'
import { resolveImportBudget } from './budget.mjs'
import { importTranscript } from './import-core.mjs'
import { importGrokbuildSession } from './import-variants.mjs'
import { syncClaudeSession } from './backfill.mjs'
import { serializeClaudeJsonl, serializeClaudeJsonlTail, tailClaudeEvents, verifyClaudeJsonl, slugifyClaudeCwd } from '../export.mjs'
import { serializeCodexJsonl, serializeCodexJsonlTail, verifyCodexJsonl } from './export/codex.mjs'
import { serializeGrokbuildJsonl, serializeGrokbuildJsonlTail, verifyGrokbuildJsonl, buildGrokSummary } from './export/grokbuild.mjs'
import { convertClaudeJsonl, convertCodexJsonl, convertGrokbuildJson } from '../convert.mjs'
import {
  loadSyncConfig, saveSyncConfig, loadOutboundMap, rememberOutbound, SYNC_FORMATS, normalizeDirPath,
} from './sync-config.mjs'

const FORMAT_SOURCE = {
  claude: 'claude-code',
  codex: 'codex',
  grokbuild: 'grokbuild',
}

const TOOL_FORMAT = {
  'claude-code': 'claude',
  claude: 'claude',
  codex: 'codex',
  grokbuild: 'grokbuild',
}

const lastStatus = {
  running: false,
  lastRunAt: null,
  lastError: null,
  inbound: null,
  outbound: null,
}

let timer = null
let timerCtx = null
let timerRegistryDir = null

function homeDir() {
  return process.env.HOME || homedir()
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function localStamp(ms) {
  const d = new Date(ms || Date.now())
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + 'T' + pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds())
}

export function encodeGrokCwd(cwd) {
  return encodeURIComponent(String(cwd || ''))
}

export function defaultCodexPath(sessionUuid, createdAt, home = homeDir(), root) {
  const d = new Date(createdAt || Date.now())
  const y = d.getFullYear()
  const m = pad(d.getMonth() + 1)
  const day = pad(d.getDate())
  const base = root || join(home, '.codex', 'sessions')
  return join(base, String(y), m, day, 'rollout-' + localStamp(d.getTime()) + '-' + sessionUuid + '.jsonl')
}

export function defaultClaudePath(sessionUuid, cwd, home = homeDir(), root) {
  const base = root || join(home, '.claude', 'projects')
  return join(base, slugifyClaudeCwd(cwd || home), sessionUuid + '.jsonl')
}

export function defaultGrokDir(sessionUuid, cwd, home = homeDir(), root) {
  const base = root || join(home, '.grok', 'sessions')
  return join(base, encodeGrokCwd(cwd || home), sessionUuid)
}

function sessionTitle(events, fallback) {
  for (const ev of events || []) {
    if (ev && ev.type === 'session/title' && ev.data && typeof ev.data.title === 'string' && ev.data.title.trim()) {
      return ev.data.title.trim()
    }
  }
  return fallback || ''
}

function importedMarker(events) {
  const first = Array.isArray(events) && events[0]
  if (!first || first.type !== 'session/imported' || !first.data) return null
  return first.data
}

// DSH 子代理会话（subagent / subagent_fork 产出的 child）头标记：origin==='subagent'
//（展示分类）或 delegationDepth>0（权威深度，顶层 = 0 或缺省）。出站不写回子代理会话
//（REQ：双向同步按工作区过滤，子代理出入站均不写回）。
function isSubagentHeader(header) {
  if (!header || typeof header !== 'object') return false
  return header.origin === 'subagent' || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)
}

// 目录 deny-list 判定：dir（会话 cwd / 源文件目录）归一后等于某排除目录或位于其下
//（前缀匹配含子目录）。空 dir 或空排除集 → 不排除（保守，照常同步）。
function isExcludedDir(dir, excludeDirs) {
  const norm = normalizeDirPath(dir)
  if (!norm || !Array.isArray(excludeDirs) || excludeDirs.length === 0) return false
  for (const ex of excludeDirs) {
    const e = normalizeDirPath(ex)
    if (!e) continue
    if (norm === e || norm.startsWith(e + '/')) return true
  }
  return false
}

// 发现条目 → 排除判定的目录键：优先 cwd；cwd 缺失回退源文件所在目录（claude
// projects/<slug> 无 cwd、codex 无 cwd 等仍可按源目录排除）。
function entryDir(s) {
  if (s && typeof s.cwd === 'string' && s.cwd) return s.cwd
  if (s && typeof s.sourcePath === 'string') return dirname(s.sourcePath)
  return ''
}

function outboundPaths(map) {
  const set = new Set()
  const mappings = map && map.mappings && typeof map.mappings === 'object' ? map.mappings : {}
  for (const entry of Object.values(mappings)) {
    if (!entry || typeof entry !== 'object') continue
    for (const slot of Object.values(entry)) {
      if (!slot || typeof slot !== 'object') continue
      if (typeof slot.filePath === 'string') set.add(slot.filePath)
      if (typeof slot.dirPath === 'string') set.add(slot.dirPath)
    }
  }
  return set
}

async function ensureParent(filePath) {
  await mkdir(dirname(filePath), { recursive: true })
}

async function writeNew(ctx, filePath, content) {
  await ensureParent(filePath)
  const target = await ctx.fs.resolve(filePath)
  await ctx.fs.writeText(target, content, { kind: 'createIfAbsent', displayPath: filePath })
}

async function appendFile(ctx, filePath, existing, tail, verify, expectedVersion) {
  const target = await ctx.fs.resolve(filePath)
  // 用读取时刻（convertExisting）的 version 做替换守卫：读取后到写入前若被外部
  // 进程改过，replaceIfVersion 失败 → 本轮放弃、下轮重试，避免覆盖并发写入。
  const newContent = existing.endsWith('\n') ? existing + tail : existing + '\n' + tail
  const check = verify(newContent)
  if (!check.ok) return { ok: false, precheck: check }
  const outcome = await ctx.fs.writeText(target, newContent, { kind: 'replaceIfVersion', version: expectedVersion })
  return { ok: true, content: newContent, version: outcome && outcome.version, size: Buffer.byteLength(newContent) }
}

function countTurns(events) {
  let n = 0
  for (const ev of events || []) if (ev && ev.type === 'turn/start') n++
  return n
}

function lastTurnOf(events) {
  for (let i = (events || []).length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev && ev.type === 'turn/end' && ev.data && typeof ev.data.turn === 'number') return ev.data.turn
  }
  return countTurns(events)
}

async function inboundOnce(ctx, registryDir, config, { home, path } = {}) {
  const formats = config.inbound.enabled ? config.inbound.formats : []
  const summary = { scanned: 0, imported: 0, appended: 0, skipped: 0, failed: 0, excludedDirs: 0, errors: [] }
  if (formats.length === 0) return summary
  const registry = await loadImports(registryDir)
  const outbound = await loadOutboundMap(registryDir)
  const skipPaths = outboundPaths(outbound)
  const budgetInfo = await resolveImportBudget(ctx, {})
  const host = makeDiscoveryHost(ctx)
  const archivedIds = archivedSessionIds(ctx)
  const sessions = []
  for (const format of formats) {
    const found = await discoverSessions({
      format,
      host,
      home,
      path: formats.length === 1 ? path : undefined,
      imports: registry.imports,
      cacheDir: registryDir,
      archivedIds,
    })
    for (const s of found.sessions || []) {
      if (skipPaths.has(s.sourcePath)) continue
      // 按目录 deny-list：cwd（或源目录）命中排除目录 → 跳过（默认行为不变，零排除集零开销）
      if (isExcludedDir(entryDir(s), config.inbound.excludeDirs)) {
        summary.excludedDirs++
        continue
      }
      sessions.push(s)
    }
  }
  summary.scanned = sessions.length
  for (const s of sessions) {
    try {
      const args = { path: s.sourcePath, force: false, budget: budgetInfo.budget, budgetSource: budgetInfo.source }
      const target = await ctx.fs.resolve(s.sourcePath)
      const out = s.format === 'grokbuild'
        ? await importGrokbuildSession(ctx, target, args, { registryDir })
        : await importTranscript(ctx, target, args, s.format === 'codex' ? convertCodexJsonl : convertClaudeJsonl, { registryDir, importFormat: s.format })
      if (out.mode === 'batch') {
        summary.imported += out.imported || 0
        summary.appended += out.appended || 0
        summary.skipped += (out.alreadyImported || 0) + (out.skipped || 0)
        summary.failed += out.failed || 0
      } else if (out.status === 'imported') summary.imported++
      else if (out.status === 'appended') summary.appended++
      else if (out.status === 'failed') summary.failed++
      else summary.skipped++
    } catch (err) {
      summary.failed++
      if (summary.errors.length < 8) {
        summary.errors.push({ sourcePath: s.sourcePath, error: String((err && err.message) || err) })
      }
    }
  }
  return summary
}

async function serializeFull(format, payload) {
  if (format === 'claude') return serializeClaudeJsonl(payload)
  if (format === 'codex') return serializeCodexJsonl(payload)
  return serializeGrokbuildJsonl(payload)
}

async function serializeTail(format, payload) {
  if (format === 'claude') return serializeClaudeJsonlTail(payload)
  if (format === 'codex') return serializeCodexJsonlTail(payload)
  return serializeGrokbuildJsonlTail(payload)
}

function verifyOf(format) {
  if (format === 'claude') return verifyClaudeJsonl
  if (format === 'codex') return verifyCodexJsonl
  return verifyGrokbuildJsonl
}

async function convertExisting(format, ctx, mapping) {
  if (format === 'grokbuild') {
    const dir = mapping.dirPath
    const chatTarget = await ctx.fs.resolve(join(dir, 'chat_history.jsonl'))
    const chatStat = await ctx.fs.stat(chatTarget)
    if (!chatStat || chatStat.type !== 'file') return { missing: true }
    const summaryTarget = await ctx.fs.resolve(join(dir, 'summary.json'))
    let summaryText = '{}'
    try { summaryText = await ctx.fs.readText(summaryTarget) } catch { /* 仅有历史、无 summary */ }
    const chatText = await ctx.fs.readText(chatTarget)
    return { converted: convertGrokbuildJson(summaryText, chatText, {}), chatText, summaryText, dir, stat: chatStat }
  }
  const target = await ctx.fs.resolve(mapping.filePath)
  const stat = await ctx.fs.stat(target)
  if (!stat || stat.type !== 'file') return { missing: true }
  const text = await ctx.fs.readText(target)
  const converted = format === 'claude' ? convertClaudeJsonl(text, {}) : convertCodexJsonl(text, {})
  return { converted, text, stat }
}

async function seedMapping(ctx, format, header, meta, events, sourcePath, roots = {}) {
  const sessionUuid = randomUUID()
  const cwd = header.cwd || meta.cwd || homeDir()
  if (format === 'claude') {
    return { filePath: sourcePath || defaultClaudePath(sessionUuid, cwd, homeDir(), roots.claude), sessionUuid, lastWrittenSeq: 0, lastWrittenTurn: 0 }
  }
  if (format === 'codex') {
    return { filePath: sourcePath || defaultCodexPath(sessionUuid, header.createdAt || meta.createdAt, homeDir(), roots.codex), sessionUuid, lastWrittenSeq: 0, lastWrittenTurn: 0 }
  }
  const dir = sourcePath || defaultGrokDir(sessionUuid, cwd, homeDir(), roots.grokbuild)
  return { dirPath: dir, filePath: join(dir, 'chat_history.jsonl'), sessionUuid, lastWrittenSeq: 0, lastWrittenTurn: 0 }
}

async function writeGrokSummary(ctx, mapping, header, meta, events, dryRun) {
  const path = join(mapping.dirPath, 'summary.json')
  if (!dryRun) {
    try {
      const target = await ctx.fs.resolve(path)
      const parsed = JSON.parse(await ctx.fs.readText(target))
      // 真实 Grok 会话目录以目录名 ↔ summary.info.id 绑定；刷新时保留既有 id，
      // 只有新建（无 summary）才落新随机 id
      if (parsed && parsed.info && typeof parsed.info.id === 'string' && parsed.info.id) {
        mapping.sessionUuid = parsed.info.id
      }
    } catch {
      // 无既有 summary / 解析失败：按新建处理，使用映射里的 sessionUuid
    }
  }
  const summary = buildGrokSummary({
    sessionUuid: mapping.sessionUuid,
    cwd: header.cwd || meta.cwd || '',
    title: sessionTitle(events, header.title),
    createdAt: meta.createdAt || header.createdAt,
    updatedAt: Date.now(),
    numMessages: (events || []).filter((e) => e && (e.type === 'user/message' || e.type === 'assistant/message')).length,
  })
  if (dryRun) return
  await ensureParent(path)
  const target = await ctx.fs.resolve(path)
  const stat = await ctx.fs.stat(target)
  const text = JSON.stringify(summary, null, 2) + '\n'
  if (!stat || stat.type !== 'file') {
    await ctx.fs.writeText(target, text, { kind: 'createIfAbsent', displayPath: path })
  } else {
    try {
      await ctx.fs.writeText(target, text, { kind: 'replaceIfVersion', version: stat.version })
    } catch {
      // 摘要刷新失败不阻断历史写回
    }
  }
}

async function outboundOne(ctx, registryDir, header, targetFormat, dryRun, roots = {}) {
  const sp = ctx.get('sessionPersistence')
  const { meta, events } = await sp.readFrom(header.id, 0)
  // 导入归属（sourcePath / originFormat）：imports registry 反查优先（记录自 0.8.3
  // 带 format 字段，issue #34），旧日志 session/imported 标记兜底
  const registry = await loadImports(registryDir)
  const regSourcePath = findSourcePathByDshId(registry.imports, header.id)
  const regRecord = regSourcePath ? unwrapRecord(registry.imports[regSourcePath]) : null
  const marker = importedMarker(events)
  const originFormat = (regRecord && typeof regRecord.format === 'string' && regRecord.format)
    || (marker && marker.tool ? TOOL_FORMAT[marker.tool] : null)
  const map = await loadOutboundMap(registryDir)
  const entry = (map.mappings[header.id] && typeof map.mappings[header.id] === 'object') ? map.mappings[header.id] : {}
  let mapping = entry[targetFormat]
  const sourcePath = regSourcePath
    ?? (marker && typeof marker.sourcePath === 'string' ? marker.sourcePath : null)
  const useSource = originFormat === targetFormat && sourcePath

  if (targetFormat === 'claude' && useSource && !dryRun) {
    try {
      const out = await syncClaudeSession(ctx, { sessionId: header.id, target: 'source', dryRun }, { registryDir })
      return { format: targetFormat, sessionId: header.id, ...out }
    } catch (err) {
      return { format: targetFormat, sessionId: header.id, status: 'failed', error: String((err && err.message) || err) }
    }
  }

  if (!mapping) {
    mapping = await seedMapping(ctx, targetFormat, header, meta || header, events, useSource ? sourcePath : null, roots)
  }

  const cwd = header.cwd || (meta && meta.cwd) || homeDir()
  const payloadBase = { meta, sessionUuid: mapping.sessionUuid, cwd }

  if (!mapping.lastWrittenSeq) {
    const existingSeed = await convertExisting(targetFormat, ctx, mapping)
    const fileEvents = existingSeed.converted && Array.isArray(existingSeed.converted.events)
      ? existingSeed.converted.events.length
      : 0
    if (!existingSeed.missing && fileEvents > 0) {
      // useSource 时水印取 registry 记录的权威 events 数——转换可能丢弃注入/空文本
      // 事件，转换产物计数不是合法 seq 切点；副本/崩溃恢复才回退转换计数
      let seedSeq = fileEvents
      let seedTurn = existingSeed.converted && Array.isArray(existingSeed.converted.turns)
        ? existingSeed.converted.turns.length
        : lastTurnOf(events)
      if (useSource && sourcePath) {
        const rec = unwrapRecord((await loadImports(registryDir)).imports[sourcePath])
        if (rec && rec.kind === 'single') {
          if (typeof rec.events === 'number') seedSeq = rec.events
          if (typeof rec.turns === 'number') seedTurn = rec.turns
        }
      }
      mapping = {
        ...mapping,
        lastWrittenSeq: seedSeq,
        lastWrittenTurn: seedTurn,
        lastSize: Buffer.byteLength(existingSeed.chatText !== undefined ? existingSeed.chatText : existingSeed.text || ''),
        writtenAt: Date.now(),
      }
      if (!dryRun) await rememberOutbound(registryDir, header.id, { [targetFormat]: mapping })
    } else {
      let full
      try {
        full = await serializeFull(targetFormat, { ...payloadBase, events })
      } catch (err) {
        return { format: targetFormat, sessionId: header.id, status: 'skipped', reason: String((err && err.message) || err) }
      }
      if (dryRun) {
        return { format: targetFormat, sessionId: header.id, status: 'synced', dryRun: true, filePath: mapping.filePath, appendedRecords: full.recordCount }
      }
      // 目标已存在但为空（或转换零事件）：以读取时刻 version 覆盖，避免 createIfAbsent EEXIST
      const writeTarget = existingSeed.missing
        ? (content) => writeNew(ctx, mapping.filePath, content)
        : async (content) => {
            const target = await ctx.fs.resolve(mapping.filePath)
            await ctx.fs.writeText(target, content, { kind: 'replaceIfVersion', version: existingSeed.stat.version })
          }
      if (targetFormat === 'grokbuild') {
        await ensureParent(mapping.filePath)
        await writeTarget(full.jsonl)
        await writeGrokSummary(ctx, mapping, header, meta || header, events, dryRun)
      } else {
        await writeTarget(full.jsonl)
      }
      const next = {
        ...mapping,
        lastWrittenSeq: events.length,
        lastWrittenTurn: lastTurnOf(events),
        lastSize: Buffer.byteLength(full.jsonl),
        writtenAt: Date.now(),
      }
      await rememberOutbound(registryDir, header.id, { [targetFormat]: next })
      return { format: targetFormat, sessionId: header.id, status: 'synced', filePath: mapping.filePath, appendedTurns: countTurns(events), appendedRecords: full.recordCount, dryRun: false }
    }
  }

  const existing = await convertExisting(targetFormat, ctx, mapping)
  if (existing.missing) {
    mapping.lastWrittenSeq = 0
    return outboundOne(ctx, registryDir, header, targetFormat, dryRun, roots)
  }
  if (mapping.lastSize && existing.stat && existing.stat.size < mapping.lastSize) {
    return { format: targetFormat, sessionId: header.id, status: 'skipped', sourceShrunk: true, filePath: mapping.filePath }
  }
  const tail = tailClaudeEvents(events, { fromSeq: mapping.lastWrittenSeq })
  if (tail.events.length === 0) {
    return { format: targetFormat, sessionId: header.id, status: 'no-new-turns', filePath: mapping.filePath, dryRun, ...(tail.droppedIncompleteTurn ? { incompleteFinalTurn: true } : {}) }
  }
  let piece
  try {
    piece = await serializeTail(targetFormat, { ...payloadBase, events: tail.events })
  } catch (err) {
    return { format: targetFormat, sessionId: header.id, status: 'skipped', reason: String((err && err.message) || err) }
  }
  if (dryRun) {
    return { format: targetFormat, sessionId: header.id, status: 'synced', dryRun: true, filePath: mapping.filePath, appendedTurns: countTurns(tail.events), appendedRecords: piece.recordCount }
  }
  const body = existing.chatText !== undefined ? existing.chatText : existing.text
  let writtenSize = 0
  if (targetFormat === 'grokbuild') {
    await ensureParent(mapping.filePath)
    const target = await ctx.fs.resolve(mapping.filePath)
    const newContent = (body || '').endsWith('\n') || !body ? (body || '') + piece.jsonl : body + '\n' + piece.jsonl
    const check = verifyGrokbuildJsonl(newContent)
    if (!check.ok) return { format: targetFormat, sessionId: header.id, status: 'skipped', precheckFailed: true, precheck: check }
    // 同样用读取时刻 version 做替换守卫，防止并发写被覆盖
    await ctx.fs.writeText(target, newContent, { kind: 'replaceIfVersion', version: existing.stat.version })
    writtenSize = Buffer.byteLength(newContent)
    await writeGrokSummary(ctx, mapping, header, meta || header, events, dryRun)
  } else {
    const appended = await appendFile(ctx, mapping.filePath, body || '', piece.jsonl, verifyOf(targetFormat), existing.stat.version)
    if (!appended.ok) return { format: targetFormat, sessionId: header.id, status: 'skipped', precheckFailed: true, precheck: appended.precheck }
    writtenSize = appended.size
  }
  const next = {
    ...mapping,
    lastWrittenSeq: events.length,
    lastWrittenTurn: lastTurnOf(tail.events),
    lastSize: writtenSize,
    writtenAt: Date.now(),
  }
  await rememberOutbound(registryDir, header.id, { [targetFormat]: next })
  if (useSource && sourcePath) {
    const rec = unwrapRecord((await loadImports(registryDir)).imports[sourcePath])
    if (rec && rec.kind === 'single') {
      await rememberImport(registryDir, sourcePath, {
        ...rec,
        turns: lastTurnOf(events),
        events: events.length,
        sizeBytes: next.lastSize,
      })
    }
  }
  return {
    format: targetFormat,
    sessionId: header.id,
    status: 'synced',
    filePath: mapping.filePath,
    appendedTurns: countTurns(tail.events),
    appendedRecords: piece.recordCount,
    dryRun: false,
  }
}

async function outboundOnce(ctx, registryDir, config, dryRun) {
  const targets = config.outbound.enabled ? config.outbound.targets : []
  const summary = { sessions: 0, synced: 0, skipped: 0, failed: 0, subagentSkipped: 0, excludedDirs: 0, results: [] }
  if (targets.length === 0) return summary
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof sp.list !== 'function' || typeof sp.readFrom !== 'function') {
    return { ...summary, failed: 1, results: [{ status: 'failed', error: 'sessionPersistence 不可用' }] }
  }
  const headers = await sp.list()
  summary.sessions = headers.length
  for (const header of headers) {
    // 子代理会话默认不写回（出入站均不写回），单独计数保持可见（不静默）。
    if (isSubagentHeader(header)) {
      summary.subagentSkipped++
      continue
    }
    // 按目录 deny-list：会话 cwd 命中排除目录 → 不写回（cwd 缺失保守照常）。
    if (isExcludedDir(header.cwd, config.outbound.excludeDirs)) {
      summary.excludedDirs++
      continue
    }
    for (const format of targets) {
      try {
        const one = await outboundOne(ctx, registryDir, header, format, dryRun, config.outbound.roots || {})
        if (one.status === 'synced') summary.synced++
        else if (one.status === 'failed') summary.failed++
        else summary.skipped++
        if (summary.results.length < 40) summary.results.push(one)
      } catch (err) {
        summary.failed++
        if (summary.results.length < 40) {
          summary.results.push({ format, sessionId: header.id, status: 'failed', error: String((err && err.message) || err) })
        }
      }
    }
  }
  return summary
}

// ── REQ-54 watch 懒检查 ──────────────────────────────────────────────────
// 面板打开时触发（无常驻监听）：只对「已导入且 mtime 越过 importedAt」的源跑入站
// 续写——stat 级短路径幂等（未变 skip / 长大 append），无变化零动作。scan 走
// discovery 30s TTL 缓存，开销可控。返回 summary（triggered 恒 true——调用方在
// watch 未开启时不调本函数）。
export async function lazyInboundCheck(ctx, registryDir, { home, path } = {}) {
  const config = await loadSyncConfig(registryDir)
  // watch 未开启 / 入站未启用 → 零动作（面板侧也已门控，这里兜底）
  const formats = config.watch.enabled && config.inbound.enabled ? config.inbound.formats : []
  const summary = { triggered: true, scanned: 0, checked: 0, imported: 0, appended: 0, skipped: 0, failed: 0, excludedDirs: 0, errors: [] }
  if (formats.length === 0) return summary
  const registry = await loadImports(registryDir)
  const outbound = await loadOutboundMap(registryDir)
  const skipPaths = outboundPaths(outbound)
  const budgetInfo = await resolveImportBudget(ctx, {})
  const host = makeDiscoveryHost(ctx)
  const archivedIds = archivedSessionIds(ctx)
  for (const format of formats) {
    // 新 TTL 缓存：mtime 门控依赖当次扫描的 lastActiveAt，30s 共享缓存会冻结旧值
    //（持久化书签仍按 mtime/size 变化重扫，未变文件免重读）
    const found = await discoverSessions({
      format,
      host,
      home,
      path: formats.length === 1 ? path : undefined,
      imports: registry.imports,
      cacheDir: registryDir,
      archivedIds,
      cache: createScanCache(),
    })
    summary.scanned += (found.sessions || []).length
    for (const s of found.sessions || []) {
      if (skipPaths.has(s.sourcePath)) continue
      if (isExcludedDir(entryDir(s), config.inbound.excludeDirs)) {
        summary.excludedDirs++
        continue
      }
      const rec = unwrapRecord(registry.imports[s.sourcePath])
      if (!rec || rec.kind !== 'single') continue
      summary.checked++
      // mtime 门控：已导入源的 mtime 未越过 importedAt → 未增长，跳过（不重读）
      if (typeof rec.importedAt === 'number' && typeof s.lastActiveAt === 'number' && s.lastActiveAt <= rec.importedAt) continue
      try {
        const args = { path: s.sourcePath, force: false, budget: budgetInfo.budget, budgetSource: budgetInfo.source }
        const target = await ctx.fs.resolve(s.sourcePath)
        const out = s.format === 'grokbuild'
          ? await importGrokbuildSession(ctx, target, args, { registryDir })
          : await importTranscript(ctx, target, args, s.format === 'codex' ? convertCodexJsonl : convertClaudeJsonl, { registryDir, importFormat: s.format })
        if (out.mode === 'batch') {
          summary.imported += out.imported || 0
          summary.appended += out.appended || 0
          summary.skipped += (out.alreadyImported || 0) + (out.skipped || 0)
          summary.failed += out.failed || 0
        } else if (out.status === 'imported') summary.imported++
        else if (out.status === 'appended') summary.appended++
        else if (out.status === 'failed') summary.failed++
        else summary.skipped++
      } catch (err) {
        summary.failed++
        if (summary.errors.length < 8) {
          summary.errors.push({ sourcePath: s.sourcePath, error: String((err && err.message) || err) })
        }
      }
    }
  }
  return summary
}

export async function runSyncOnce(ctx, registryDir, { dryRun = false, home, path } = {}) {
  if (lastStatus.running) return { ok: false, error: '同步正在进行', ...lastStatus }
  lastStatus.running = true
  lastStatus.lastError = null
  try {
    const config = await loadSyncConfig(registryDir)
    const inbound = await inboundOnce(ctx, registryDir, config, { home, path })
    const outbound = await outboundOnce(ctx, registryDir, config, dryRun)
    const lastRun = { at: Date.now(), inbound, outbound, dryRun }
    await saveSyncConfig(registryDir, { ...config, lastRun })
    lastStatus.lastRunAt = lastRun.at
    lastStatus.inbound = inbound
    lastStatus.outbound = outbound
    return { ok: true, config: await loadSyncConfig(registryDir), inbound, outbound, dryRun }
  } catch (err) {
    lastStatus.lastError = String((err && err.message) || err)
    return { ok: false, error: lastStatus.lastError }
  } finally {
    lastStatus.running = false
  }
}

export function getSyncStatus() {
  return { ...lastStatus, timerActive: timer !== null, formats: SYNC_FORMATS }
}

export function stopSyncTimer() {
  if (timer) {
    globalThis.clearInterval(timer)
    timer = null
  }
}

export async function startSyncTimer(ctx, registryDir) {
  timerCtx = ctx
  timerRegistryDir = registryDir
  stopSyncTimer()
  const config = await loadSyncConfig(registryDir)
  if (!config.inbound.enabled && !config.outbound.enabled) return config
  timer = globalThis.setInterval(() => {
    runSyncOnce(timerCtx, timerRegistryDir).catch((err) => {
      lastStatus.lastError = String((err && err.message) || err)
    })
  }, config.intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return config
}

export function registerSyncLoop(ctx, registryDir) {
  startSyncTimer(ctx, registryDir).catch((err) => {
    console.warn('[dsh-chat-import] 同步定时器启动失败：' + String((err && err.message) || err))
  })
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => stopSyncTimer())
  }
}

export { FORMAT_SOURCE, lastStatus }
