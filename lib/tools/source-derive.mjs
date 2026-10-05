// lib/tools/source-derive.mjs — 来源 spec 的 host 面派生 / 收集（经 ctx.fs 旁读 sidecar）
//
// 只服务没有独立 lib/sources/<src>.mjs 适配器的文件型来源：cursor / antigravity /
// reasonix / openclaw / continue 的 derive.args（按文件派生转换参数）与 derive.collect
// （目录批量的选材）。转换本身在 lib/convert/*（纯函数）；这里只做「读旁路文件 → 喂参数」。
//
// ctx.fs 是目标对象契约：只有 resolve 收路径字符串，readText / listDir / stat 只收
// resolve 出的目标——旁读一律先 resolve。sidecar 缺失是合法形态（会话未重命名 / 无 WAL /
// 无索引），各处的 catch 都只吞「读不到旁路文件」这一种情形并写明降级口径。

import { join } from 'node:path'
import { indexTaskMessages, parseAnnotationTitle, readContinueIndex } from '../convert/index.mjs'
import { openclawDisplayNames } from '../convert/openclaw.mjs'
import { parseReasonixSemantic, selectReasonixMaximalBranches } from '../convert/reasonix-lineage.mjs'
import { collectJsonlFiles } from '../import-core.mjs'
import { greedyDecodeSlugPath, resolveCursorSlugPath, cursorSlugFromTranscriptPath } from '../cwd-map.mjs'

/** 目标的显示路径（displayPath 优先，缺省经 ctx.fs.processPath 还原）。 */
export function targetPath(ctx, target) {
  return target.displayPath || ctx.fs.processPath(target)
}

/** 文件名 stem：路径最后一段去掉扩展名（默认 .jsonl）——多数文件型来源的稳定源 id。 */
export function fileStem(path, ext = /\.jsonl$/i) {
  const base = String(path).split(/[\\/]/).pop() || ''
  return base.replace(ext, '')
}

// ── cursor ────────────────────────────────────────────────────────────────

// cursor：行内无会话 id，用文件名（composer uuid）作稳定 id；cwd 从 projects/<slug> 还原
export async function cursorDeriveArgs(ctx, target) {
  const p = targetPath(ctx, target)
  const derived = { cursorId: fileStem(p) }
  const slug = cursorSlugFromTranscriptPath(p)
  if (slug) {
    const cwd = await resolveCursorSlugPath(ctx, slug)
    if (cwd) derived.cwd = cwd
  }
  return derived
}

// ── antigravity ───────────────────────────────────────────────────────────

// antigravity：目录批量只收 canonical 输入 brain/<id>/.system_generated/logs/
// transcript.jsonl——同目录的 transcript_full.jsonl 与其它伴生日志不是独立会话
//（按同 id 重复导入只会撞幂等键/产生噪音），发现层与导入层的选材口径保持一致。
// 路径判定与 antigravityDeriveArgs 的 brain 正则同源（/brain/<id>/ 定位会话）。
const ANTIGRAVITY_TRANSCRIPT_RE = /\/brain\/[^/]+\/\.system_generated\/logs\/transcript\.jsonl$/i

export async function collectAntigravityTranscripts(ctx, dirTarget, out, recursive) {
  const candidates = []
  await collectJsonlFiles(ctx, dirTarget, candidates, recursive)
  for (const target of candidates) {
    const p = String(target.displayPath || target.targetKey || '').replace(/\\/g, '/')
    if (ANTIGRAVITY_TRANSCRIPT_RE.test(p)) out.push(target)
  }
}

// Antigravity（2.0 / CLI / IDE）与 Gemini CLI 共用 ~/.gemini 前缀但存储不同：标题在
// <brain 根>/../../annotations/<id>.pbtxt，异步任务回执在 brain/<id>/.system_generated/
// messages/*.json，由这里旁读后喂给纯函数转换器。两者缺失都是合法形态（会话未重命名 /
// 无后台任务），容错为无标题 / 无回执。
export async function antigravityDeriveArgs(ctx, target) {
  const p = targetPath(ctx, target)
  // .../brain/<id>/.system_generated/logs/transcript.jsonl → .../brain/<id>
  const m = String(p).replace(/\\/g, '/').match(/^(.*)\/brain\/([^/]+)\//)
  if (!m) return {}
  const brainDir = m[1] + '/brain/' + m[2]
  const antigravityId = m[2]
  const derived = { antigravityId }
  try {
    const annoTarget = await ctx.fs.resolve(join(brainDir, '..', '..', 'annotations', antigravityId + '.pbtxt'))
    const annoTitle = parseAnnotationTitle(await ctx.fs.readText(annoTarget))
    if (annoTitle) derived.annotationTitle = annoTitle
  } catch {
    // annotations 缺失/不可读：标题回退首问（与转换层同款降级）
  }
  try {
    const msgTarget = await ctx.fs.resolve(join(brainDir, '.system_generated', 'messages'))
    const names = await ctx.fs.listDir(msgTarget)
    if (Array.isArray(names) && names.length > 0) {
      const recs = []
      for (const entry of names) {
        const name = typeof entry === 'string' ? entry : entry && entry.name
        if (!name || !name.endsWith('.json')) continue
        const raw = await ctx.fs.readText(await ctx.fs.resolve(join(brainDir, '.system_generated', 'messages', name)))
        if (raw === null || raw === '') continue
        try {
          recs.push(JSON.parse(raw))
        } catch { /* 畸形回执跳过；转换层 skipped 只统计转录行 */ }
      }
      if (recs.length > 0) derived.taskMessages = indexTaskMessages(recs)
    }
  } catch {
    // messages 缺失/不可读：无异步任务回执可补（fire-and-forget 缺结果
    // 由转换层显式标注，不静默虚构）
  }
  return derived
}

// ── reasonix ──────────────────────────────────────────────────────────────

// 与 checkpoint 同目录的兄弟文件（<stem>.meta.json / <stem>.events.jsonl），保留输入的分隔符风格
function reasonixSiblingPath(path, stem, suffix) {
  const value = String(path)
  const slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  const separator = value.includes('\\') ? '\\' : '/'
  const dir = slash >= 0 ? value.slice(0, slash) : '.'
  return dir + separator + stem + suffix
}

// sidecar 两代布局：现代 <file>.meta（topic_title / workspace_root / scope）优先，
// 旧版 <stem>.meta.json（summary / workspace）回退。
async function readReasonixMeta(ctx, target) {
  const path = targetPath(ctx, target)
  const stem = fileStem(path)
  const sidecars = [String(path) + '.meta', reasonixSiblingPath(path, stem, '.meta.json')]
  for (const [index, sidecar] of sidecars.entries()) {
    try {
      const resolved = await ctx.fs.resolve(sidecar)
      const meta = JSON.parse(await ctx.fs.readText(resolved))
      if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
        return { meta, modern: index === 0 }
      }
    } catch {
      // Missing or malformed sidecars are not lineage evidence; try the legacy layout.
    }
  }
  return { meta: null, modern: false }
}

async function readReasonixWal(ctx, path, stem) {
  try {
    const target = await ctx.fs.resolve(reasonixSiblingPath(path, stem, '.events.jsonl'))
    return await ctx.fs.readText(target)
  } catch {
    // No readable WAL means the checkpoint JSONL is the complete known source.
    return null
  }
}

// reasonix 目录批量：canonical（默认）按 lineage 证据折叠恢复祖先、只收极大分支；
// physical 逐文件导入。选中的目标带 reasonixLineage 注记（分支序号 + 已读的 meta / WAL），
// reasonixDeriveArgs 据此免重读。
export async function collectReasonixFiles(ctx, dirTarget, out, recursive, args = {}) {
  const physical = []
  await collectJsonlFiles(ctx, dirTarget, physical, recursive)
  if (args.lineageMode === 'physical') {
    out.push(...physical)
    return
  }

  const candidates = []
  for (const target of physical) {
    const path = targetPath(ctx, target)
    const stem = fileStem(path)
    const [{ meta, modern }, raw, walText] = await Promise.all([
      readReasonixMeta(ctx, target),
      ctx.fs.readText(target),
      readReasonixWal(ctx, path, stem),
    ])
    const parsed = parseReasonixSemantic(raw)
    candidates.push({
      target,
      path,
      meta: modern ? meta : null,
      legacyMeta: modern ? null : meta,
      modern,
      semantic: parsed.semantic,
      parseErrors: parsed.parseErrors,
      hasWal: walText !== null,
      walText,
    })
  }

  const selection = selectReasonixMaximalBranches(candidates)
  const groupByPath = new Map()
  for (const group of selection.groups) {
    group.selected.forEach((candidate, index) => groupByPath.set(candidate.path, {
      topicId: group.topicId,
      branchIndex: index + 1,
      branchCount: group.selected.length,
      meta: candidate.meta,
      modern: candidate.modern,
      walText: candidate.walText,
    }))
  }
  for (const candidate of selection.selected) {
    out.push({
      ...candidate.target,
      // 未分组（无 topic key）候选没有 groupByPath 条目：meta 取「现代 ?? 旧版」
      // sidecar，独立现代文件同样派生 cwd/标题，与组内成员一致
      reasonixLineage: groupByPath.get(candidate.path) || {
        branchIndex: 1,
        branchCount: 1,
        meta: candidate.meta ?? candidate.legacyMeta,
        modern: candidate.modern,
        walText: candidate.walText,
      },
    })
  }
}

// reasonix：会话 id 用文件名 stem（幂等）；cwd/标题从 sidecar meta 派生；桌面版
// projects/<slug>/sessions 布局下标题走目录级 .titles.json 权威索引、cwd 走 slug 贪心
// 解码；V2 WAL（<stem>.events.jsonl）经 args.walText 传入转换层合并。
export async function reasonixDeriveArgs(ctx, target) {
  const p = targetPath(ctx, target)
  const stem = fileStem(p)
  const derived = { reasonixId: stem }
  const annotated = target.reasonixLineage
  const loaded = annotated
    ? { meta: annotated.meta, modern: annotated.modern }
    : await readReasonixMeta(ctx, target)
  const meta = loaded.meta
  if (meta) {
    if (loaded.modern) {
      if (meta.scope !== 'global' && typeof meta.workspace_root === 'string' && meta.workspace_root) {
        derived.cwd = meta.workspace_root
      }
      if (typeof meta.topic_title === 'string' && meta.topic_title.trim()) {
        derived.title = meta.topic_title.trim()
      }
    } else {
      if (typeof meta.workspace === 'string' && meta.workspace) derived.cwd = meta.workspace
      if (typeof meta.summary === 'string' && meta.summary.trim()) derived.title = meta.summary.trim()
    }
  }
  if (annotated?.branchCount > 1 && derived.title) {
    derived.title += `（分支 ${annotated.branchIndex}/${annotated.branchCount}）`
  }
  // 桌面版布局：projects/<slug>/sessions/<stem>.jsonl
  const segs = String(p).replace(/[\\/]+$/, '').split(/[\\/]/)
  const sessionsIdx = segs.lastIndexOf('sessions')
  if (sessionsIdx >= 2 && segs[sessionsIdx - 2] === 'projects') {
    const slug = segs[sessionsIdx - 1]
    const sessionDir = segs.slice(0, sessionsIdx + 1).join('\\')
    // 目录级 .titles.json 权威标题（basename → 标题）
    if (!derived.title) {
      try {
        const titlesTarget = await ctx.fs.resolve(join(sessionDir, '.titles.json'))
        const titles = JSON.parse(await ctx.fs.readText(titlesTarget))
        if (titles && typeof titles[stem] === 'string' && titles[stem].trim()) {
          derived.title = titles[stem].trim()
        }
      } catch {
        // .titles.json 缺失/损坏：标题回退首问（不致命）
      }
    }
    // cwd = slug 贪心解码（meta.json 无 workspace 时）
    if (!derived.cwd) {
      const decoded = await greedyDecodeSlugPath(ctx, slug)
      if (decoded) derived.cwd = decoded
    }
  }
  if (annotated?.walText !== null && annotated?.walText !== undefined) {
    derived.walText = annotated.walText
  } else {
    // WAL 与 checkpoint 同目录：<stem>.events.jsonl（V2 事件日志权威，自动合并；
    // 无 WAL 的旧版本/子代理文件自然回退纯 checkpoint）
    const walText = await readReasonixWal(ctx, p, stem)
    if (walText !== null) derived.walText = walText
  }
  return derived
}

// ── openclaw / continue（同目录索引文件补元数据）──────────────────────────

// openclaw：sessions.json 索引提供 displayName 作会话标题（按文件 stem 查）
export async function openclawDeriveArgs(ctx, target) {
  const p = targetPath(ctx, target)
  const stem = fileStem(p)
  const derived = { openclawId: stem }
  try {
    // sessions.json 与 transcript 同目录：<dir>/sessions.json（displayName 索引）
    const dirPath = String(p).replace(/[\\/][^\\/]*\.jsonl$/i, '')
    const indexTarget = await ctx.fs.resolve(join(dirPath, 'sessions.json'))
    const name = openclawDisplayNames(await ctx.fs.readText(indexTarget)).get(stem)
    if (name) derived.displayName = name
  } catch {
    // sessions.json 缺失/损坏不致命：仍按 stem 导入，仅无 displayName
  }
  return derived
}

// continue：文件名 stem（sessionId）作稳定源 id 兜底（文件内 sessionId 优先）；创建时间
// 只在同目录 sessions.json 索引里（会话文件内部没有时间戳），能读到就带上
export async function continueDeriveArgs(ctx, target) {
  const p = targetPath(ctx, target)
  const stem = fileStem(p, /\.json$/i)
  const derived = { continueId: stem }
  try {
    const dirPath = String(p).replace(/[\\/][^\\/]*\.json$/i, '')
    const indexTarget = await ctx.fs.resolve(join(dirPath, 'sessions.json'))
    const known = readContinueIndex(await ctx.fs.readText(indexTarget)).get(stem)
    if (known && Number.isFinite(known.createdAt)) derived.createdAt = known.createdAt
  } catch {
    // 索引缺失/损坏不致命：仍按文件名 stem 导入，仅创建时间回退导入时刻
  }
  return derived
}
