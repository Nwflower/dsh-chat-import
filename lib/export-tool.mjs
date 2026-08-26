// lib/export-tool.mjs — export_claude 反向导出（REQ-16）：把 DSH 会话日志只读
// 序列化为 Claude Code JSONL。只消费 sessionPersistence（list + readFrom）+ fs
// （resolve + writeText），绝不 load/prepare、绝不改写会话日志（append-only 只读
// 来源）。文件写到 <outputDir>/<slug>/<uuid>.jsonl（新 uuid v4 铸键 + createIfAbsent
// 不覆盖双保险；dryRun 不写盘）。uuid 工厂可注入（测试确定性），默认 randomUUID。
// 导入会话（日志带 session/imported 标记）导出成功后把 mapping 落进 imports
// registry（record.exports = [mapping]），供 REQ-36 sync_to_claude 的 target:'copy'
// 定位写回副本；原生会话无 sourcePath 键，不落库（mapping 仍在返回值里）。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { slugifyClaudeCwd, serializeClaudeJsonl, serializeBundle, serializeCodexJsonl, serializeKimiWire } from '../export.mjs'
import { exportDegradations } from '../convert.mjs'
import { loadImports, rememberImport, unwrapRecord } from './imports.mjs'

export async function exportClaudeSession(ctx, args, { uuid = randomUUID, registryDir } = {}) {
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof sp.list !== 'function' || typeof sp.readFrom !== 'function') {
    throw new Error('sessionPersistence 不可用（需要 list + readFrom）')
  }
  const headers = await sp.list()
  const header = headers.find((h) => h.id === args.sessionId)
  if (!header) throw new Error('会话不存在: ' + args.sessionId)
  const { meta, events } = await sp.readFrom(args.sessionId, 0)
  const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : header.cwd
  if (typeof cwd !== 'string' || !cwd) {
    throw new Error('导出需要 cwd：会话 header 无 cwd 且未提供 cwd 参数')
  }
  const sessionUuid = uuid()
  const slug = slugifyClaudeCwd(cwd)
  const out = serializeClaudeJsonl({ meta, events, sessionUuid, cwd, version: args.version, gitBranch: args.gitBranch }, { uuid })
  const filePath = join(args.outputDir || join(homedir(), '.claude', 'projects'), slug, sessionUuid + '.jsonl')
  if (args.dryRun !== true) {
    const target = await ctx.fs.resolve(filePath)
    await ctx.fs.writeText(target, out.jsonl, { kind: 'createIfAbsent', displayPath: filePath })
  }
  const mapping = {
    sourceSessionId: args.sessionId,
    sessionUuid,
    slug,
    filePath,
    turns: (events ?? []).filter((e) => e && e.type === 'turn/start').length,
    messages: (events ?? []).filter((e) => e && (e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result')).length,
    toolCalls: out.toolCalls,
    toolResults: out.toolResults,
    droppedToolResults: out.droppedToolResults,
    skippedInjections: out.skippedInjections,
  }
  // 导入会话（带 session/imported 标记）导出成功后把 mapping 落进 registry
  // （exports[0] 即 REQ-36 写回副本映射）；原生会话无 sourcePath 键，跳过
  if (registryDir && args.dryRun !== true) {
    const first = Array.isArray(events) && events.length > 0 ? events[0] : undefined
    if (first && first.type === 'session/imported' && first.data && typeof first.data.sourcePath === 'string') {
      const reg = await loadImports(registryDir)
      const record = unwrapRecord(reg.imports[first.data.sourcePath])
      if (record) await rememberImport(registryDir, first.data.sourcePath, { ...record, exports: [mapping] })
    }
  }
  return {
    mode: 'single',
    sessionId: sessionUuid,
    sourceSessionId: args.sessionId,
    filePath,
    slug,
    cwd,
    recordCount: out.recordCount,
    ...(out.title ? { title: out.title } : {}),
    // REQ-21 降级显式报告：导出过程的有损项（孤儿结果/注入跳过/附件跳过）逐条列出
    ...(exportDegradations(out) ? { degradations: exportDegradations(out) } : {}),
    dryRun: args.dryRun === true,
    mapping,
  }
}

// REQ-56 export_bundle 执行体：DSH 会话 → interchange bundle（SHA-256 双层指纹，
// 事件级无损，见 lib/export/bundle.mjs 与 docs/INTERCHANGE.md §4）。只读会话日志
// （list + readFrom），绝不 load/prepare/改写；写文件 createIfAbsent 不覆盖；
// dryRun 不写盘。输出路径：args.path（显式）或 <outputDir>/<sessionId>.dshbundle.json
// （outputDir 缺省 ~/.dsh/exports）。
export async function exportBundleSession(ctx, args, _opts = {}) {
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof sp.list !== 'function' || typeof sp.readFrom !== 'function') {
    throw new Error('sessionPersistence 不可用（需要 list + readFrom）')
  }
  const headers = await sp.list()
  const header = headers.find((h) => h.id === args.sessionId)
  if (!header) throw new Error('会话不存在: ' + args.sessionId)
  const { meta, events } = await sp.readFrom(args.sessionId, 0)
  const list = Array.isArray(events) ? events : []
  const titleEvent = list.find((e) => e && e.type === 'session/title' && e.data && typeof e.data.title === 'string')
  const doc = serializeBundle({
    meta,
    events: list,
    sourceSessionId: args.sessionId,
    cwd: typeof args.cwd === 'string' && args.cwd ? args.cwd : undefined,
    title: titleEvent ? titleEvent.data.title : undefined,
    exportedAt: typeof args.exportedAt === 'number' ? args.exportedAt : undefined,
  })
  const filePath = typeof args.path === 'string' && args.path
    ? args.path
    : join(args.outputDir || join(homedir(), '.dsh', 'exports'), args.sessionId + '.dshbundle.json')
  if (args.dryRun !== true) {
    const target = await ctx.fs.resolve(filePath)
    await ctx.fs.writeText(target, JSON.stringify(doc, null, 2) + '\n', { kind: 'createIfAbsent', displayPath: filePath })
  }
  return {
    mode: 'single',
    sessionId: args.sessionId,
    filePath,
    eventCount: list.length,
    sha256: doc.sha256,
    ...(doc.originalCwd ? { originalCwd: doc.originalCwd } : {}),
    ...(doc.landingHint ? { landingHint: doc.landingHint } : {}),
    dryRun: args.dryRun === true,
  }
}

// REQ-23 矩阵化互转通用导出执行体（export_codex / export_kimi）：DSH 会话 →
// 目标格式 JSONL（serialize 注入），只读会话日志、写盘 createIfAbsent、dryRun
// 不写盘、降级逐条报告（REQ-21）。与 export_claude 同构，但目标不是 Claude
//（无 sync 写回副本，不落 registry exports）。
async function exportTargetFile(ctx, args, { serialize, ext }) {
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof sp.list !== 'function' || typeof sp.readFrom !== 'function') {
    throw new Error('sessionPersistence 不可用（需要 list + readFrom）')
  }
  const headers = await sp.list()
  const header = headers.find((h) => h.id === args.sessionId)
  if (!header) throw new Error('会话不存在: ' + args.sessionId)
  const { meta, events } = await sp.readFrom(args.sessionId, 0)
  const out = serialize({ meta, events, sessionUuid: args.sessionId })
  const filePath = typeof args.path === 'string' && args.path
    ? args.path
    : join(args.outputDir || join(homedir(), '.dsh', 'exports'), args.sessionId + '.' + ext)
  if (args.dryRun !== true) {
    const target = await ctx.fs.resolve(filePath)
    await ctx.fs.writeText(target, out.jsonl, { kind: 'createIfAbsent', displayPath: filePath })
  }
  return {
    mode: 'single',
    sessionId: args.sessionId,
    filePath,
    recordCount: out.recordCount,
    toolCalls: out.toolCalls,
    toolResults: out.toolResults,
    ...(exportDegradations(out) ? { degradations: exportDegradations(out) } : {}),
    dryRun: args.dryRun === true,
  }
}

export function exportCodexSession(ctx, args) {
  return exportTargetFile(ctx, args, { serialize: serializeCodexJsonl, ext: 'rollout.jsonl' })
}

export function exportKimiSession(ctx, args) {
  return exportTargetFile(ctx, args, { serialize: serializeKimiWire, ext: 'wire.jsonl' })
}
