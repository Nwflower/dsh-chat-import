// lib/export-tool.mjs — export_claude 反向导出：把 DSH 会话日志只读
// 序列化为 Claude Code JSONL。只消费 sessionPersistence（list + readFrom）+ fs
// （resolve + writeText），绝不 load/prepare、绝不改写会话日志（append-only 只读
// 来源）。文件写到 <outputDir>/<slug>/<uuid>.jsonl（新 uuid v4 铸键 + createIfAbsent
// 不覆盖双保险；dryRun 不写盘）。uuid 工厂可注入（测试确定性），默认 randomUUID。
// 导出产物路径只在返回值 mapping 里（不落 registry）。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { slugifyClaudeCwd, serializeClaudeJsonl, serializeBundle, serializeCodexJsonl, serializeKimiWire, serializeOpencodeJson } from './export/index.mjs'
import { exportDegradations } from './convert/index.mjs'
import { resolveImagesForExport } from './attachments.mjs'
import { listPersistedHeaders, readSessionRecord, canReadSessionEvents } from './imports.mjs'

// 导出的只读前置：确认持久化服务有 list + 读事件面、会话存在，再整份读回 header / meta /
// 事件。三种导出共用（任一缺失都大声失败，不导出半截产物）。
async function readExportSource(ctx, sessionId) {
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof sp.list !== 'function' || !canReadSessionEvents(sp)) {
    throw new Error('sessionPersistence 不可用（需要 list + 读事件面）')
  }
  const headers = await listPersistedHeaders(ctx)
  const header = headers.find((h) => h.id === sessionId)
  if (!header) throw new Error('会话不存在: ' + sessionId)
  const sessionRecord = await readSessionRecord(ctx, sessionId, 0)
  if (!sessionRecord) throw new Error('会话日志读不到：' + sessionId)
  return { header, meta: sessionRecord.meta, events: sessionRecord.events }
}

// 会话里的 session/title 事件标题（首条带字符串标题的；没有则 undefined）。
function sessionTitleOf(events) {
  const ev = Array.isArray(events)
    ? events.find((e) => e && e.type === 'session/title' && e.data && typeof e.data.title === 'string')
    : undefined
  return ev ? ev.data.title : undefined
}

export async function exportClaudeSession(ctx, args, { uuid = randomUUID } = {}) {
  const { header, meta, events } = await readExportSource(ctx, args.sessionId)
  const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : header.cwd
  if (typeof cwd !== 'string' || !cwd) {
    throw new Error('导出需要 cwd：会话 header 无 cwd 且未提供 cwd 参数')
  }
  const sessionUuid = uuid()
  const slug = slugifyClaudeCwd(cwd)
  // 图片解引用（导出方向的反向替换）：会话日志里只有附件引用，Claude 的 JSONL 需要
  // base64——经 ctx.attachments.readImage 读回；读不到时该块按 [image] 占位导出并计入
  // unavailableImages（降级里以 attachment-skipped 如实上报，不静默丢图）。
  const images = await resolveImagesForExport(ctx, events)
  const out = serializeClaudeJsonl({ meta, events, sessionUuid, cwd, version: args.version, gitBranch: args.gitBranch }, { uuid })
  if (images.unavailable > 0) out.unavailableImages = images.unavailable
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
    // 图片：images = 读回字节并写成目标格式图片载荷的块数；unavailableImages = 读不到
    // 字节、按 [image] 占位导出的块数（>0 才占键）
    ...(images.resolved > 0 ? { images: images.resolved } : {}),
    ...(images.unavailable > 0 ? { unavailableImages: images.unavailable } : {}),
  }
  // 导出产物路径只在返回值里（mapping）：不写 registry，导出是可重复的只读动作，
  // 每次铸新 uuid 与 createIfAbsent 双保险，绝不覆盖既有文件。
  return {
    mode: 'single',
    sessionId: sessionUuid,
    sourceSessionId: args.sessionId,
    filePath,
    slug,
    cwd,
    recordCount: out.recordCount,
    ...(out.title ? { title: out.title } : {}),
    // 降级显式报告：导出过程的有损项（孤儿结果/注入跳过/附件跳过）逐条列出
    ...(exportDegradations(out) ? { degradations: exportDegradations(out) } : {}),
    dryRun: args.dryRun === true,
    mapping,
  }
}

// export_bundle 执行体：DSH 会话 → interchange bundle（SHA-256 双层指纹，
// 事件级无损，见 lib/export/bundle.mjs 与 docs/INTERCHANGE.md §4）。只读会话日志
// （list + readFrom），绝不 load/prepare/改写；写文件 createIfAbsent 不覆盖；
// dryRun 不写盘。输出路径：args.path（显式）或 <outputDir>/<sessionId>.dshbundle.json
// （outputDir 缺省 ~/.dsh/exports）。
export async function exportBundleSession(ctx, args, _opts = {}) {
  const { meta, events } = await readExportSource(ctx, args.sessionId)
  const list = Array.isArray(events) ? events : []
  const doc = serializeBundle({
    meta,
    events: list,
    sourceSessionId: args.sessionId,
    cwd: typeof args.cwd === 'string' && args.cwd ? args.cwd : undefined,
    title: sessionTitleOf(list),
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

// 矩阵化互转通用导出执行体（export_codex / export_kimi / export_opencode）：
// DSH 会话 → 目标格式文件（serialize 注入），只读会话日志、写盘 createIfAbsent、dryRun
// 不写盘、降级逐条报告。与 export_claude 同构，但目标不是 Claude
// 不落 registry）。field 指序列化器里承载文件正文的键
//（行式格式是 jsonl，opencode 是单个 JSON 文档 json）。
async function exportTargetFile(ctx, args, { serialize, ext, field = 'jsonl', resolveImages = false }) {
  const { header, meta, events } = await readExportSource(ctx, args.sessionId)
  // 只有目标格式能承载图片（Codex 的 input_image）时才解引用附件——Kimi 的 wire 只认
  // 自有 blob 存储的 blobref、opencode 的 file part 也另需外部文件，读了字节也写不回去，
  // 那两种格式照旧把图片块计为 skippedBlocks（降级里以 attachment-skipped 上报）。
  const images = resolveImages ? await resolveImagesForExport(ctx, events) : null
  const out = serialize({
    meta, events, sessionUuid: args.sessionId,
    cwd: typeof args.cwd === 'string' && args.cwd ? args.cwd : header.cwd,
    title: sessionTitleOf(events),
  })
  if (images && images.unavailable > 0) out.unavailableImages = images.unavailable
  const filePath = typeof args.path === 'string' && args.path
    ? args.path
    : join(args.outputDir || join(homedir(), '.dsh', 'exports'), args.sessionId + '.' + ext)
  if (args.dryRun !== true) {
    const target = await ctx.fs.resolve(filePath)
    await ctx.fs.writeText(target, out[field], { kind: 'createIfAbsent', displayPath: filePath })
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
  return exportTargetFile(ctx, args, { serialize: serializeCodexJsonl, ext: 'rollout.jsonl', resolveImages: true })
}

export function exportKimiSession(ctx, args) {
  return exportTargetFile(ctx, args, { serialize: serializeKimiWire, ext: 'wire.jsonl' })
}

// DSH 会话 → opencode `import <file>` 可读的 JSON（写 .opencode.json）。
// 与 codex/kimi 同款落盘约定（默认 ~/.dsh/exports），因为 opencode 侧需要显式执行
// `opencode import <文件>`——我们不直接写它的 SQLite 库（那会绕过它的迁移与校验）。
export function exportOpencodeSession(ctx, args) {
  return exportTargetFile(ctx, args, { serialize: serializeOpencodeJson, ext: 'opencode.json', field: 'json' })
}
