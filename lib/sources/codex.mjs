// lib/sources/codex.mjs — Codex 分页 rollout（issue #57）的链解析与导入编排
//
// 新版 Codex CLI（0.154.0-alpha.6.2 起，issue #57）会把一个会话的 rollout **拆成多个文件**：
// 同一 thread 的所有分页共享文件名前缀 `rollout-<时间戳>-<threadId>`，后续页带 `_<pageId>`
// 后缀；每页第一行 session_meta 里 `history_mode: "paginated"`、
// `history_base: { thread_id: <上一页 id>, end_ordinal_exclusive, end_byte_offset }`
// 指向上一页；首页没有 history_base。**thread id（payload.id）在各页之间保持一致**
//（报告者实测：面板里两条同题条目的 sessionId 相同），分页只改文件名后缀。
//
// 链的两条解析规则（刻意不依赖 history_base 的内部字段语义 —— 那部分只有报告者的转述，
// 上游源码未核对）：
//   1. **分组**：文件名里第一个 UUID = thread id（codexThreadIdFromName）——同前缀即同链。
//      另一分页文件的 UUID 不会恰好以本 thread 的 UUID 开头（随机），不会误并。
//   2. **排序**：文件名内嵌时间戳 `rollout-YYYY-MM-DDThh-mm-ss-` 单调递增 → 按它排序即页序；
//      mtime 回退。history_base 只用作导入结果的**诊断**（页间 id 对不上要显式上报）。
//
// 幂等键：**规范 sourcePath = 链的首页**（追加新页不会改变首页）→ registry 键稳定；
// 指纹用**链上全部分页的复合 stat**（grokbuildStat 同款：size 求和、version 拼接），
// 新增一页即指纹变化 → 既有会话走 append 增量，而不是跳过或另建副本。
//
// convertCodexJsonl 对拼接天然安全：session_meta 的 sourceId/cwd/createdAt 都有 `!x` 守卫，
// 第二页起的 meta 行会被整行 continue 掉；轮次由 user 消息驱动，页边界不产生新轮次。
import { convertCodexJsonl } from '../convert/index.mjs'
import { markTrimmedSource } from '../budget.mjs'
import {
  loadImports, unwrapRecord, listPersistedIds, archivedSessionIds, argsFingerprint,
  decideSingle, isSessionIdChange,
} from '../imports.mjs'
import { finalizeConvertedSession, importTranscript, previewEntry, attachConversionDetails, runImportBatch } from '../import-core.mjs'

// 文件名 → thread id：第一个 UUID 形态的段（发现层 scanCodex 的分组键同用它）
export function codexThreadIdFromName(name) {
  const m = String(name).match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/)
  return m ? m[0] : undefined
}

// 文件名内嵌的页创建时间（rollout-YYYY-MM-DDThh-mm-ss-…）→ 可比较字符串；取不到 null
export function codexNameTimestamp(name) {
  const m = String(name).match(/rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-/)
  return m ? m[1] : null
}

// 分隔符无关的 dirname（宿主/mock 可能传入任意分隔符风格的路径；node:path 的
// dirname 依赖运行平台，Windows 反斜杠路径在 Linux 上会解析成单段文件名）
// 结果**保留调用方原有的分隔符风格**：路径会继续回传给宿主 fs，改写风格可能让目录列举静默失配
function dirnameAny(p) {
  const s = String(p)
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  if (i === -1) return '.'
  return i === 0 ? s[0] : s.slice(0, i) // 根路径（`/x`、`\x`）保留单分隔符
}

// 拼接子路径，沿用父目录的分隔符风格（同上：不改写风格）
function joinAny(dir, name) {
  const d = String(dir)
  if (/[\\/]$/.test(d)) return d + name
  const last = Math.max(d.lastIndexOf('/'), d.lastIndexOf('\\'))
  const sep = last === -1 ? '/' : d[last]
  return d + sep + name
}

// 从一个 rollout 文件向上找名为 sessions 的最近祖先（分页可能落在不同日期目录）。
// 找不到返回 null（调用方退化为只扫文件所在目录）。
export function codexSessionsAncestor(filePath, maxLevels = 8) {
  let dir = dirnameAny(String(filePath))
  for (let i = 0; i < maxLevels; i++) {
    if (/(^|[\\/])sessions$/i.test(dir)) return dir
    const parent = dirnameAny(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

// 页序比较器（-1/0/1，供 Array.sort 直接使用）：
// 文件名时间戳优先，mtime 回退，最后按文件名稳定排序
function pageCmp(a, b, mtimeOf) {
  const ta = a.nameTs || ''
  const tb = b.nameTs || ''
  if (ta !== tb) return ta < tb ? -1 : 1
  const ma = mtimeOf(a) ?? 0
  const mb = mtimeOf(b) ?? 0
  if (ma !== mb) return ma - mb
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** 页序列按页序排列（返回新数组）。 */
export function sortCodexPages(pages, mtimeOf = () => null) {
  return [...pages].sort((a, b) => pageCmp(a, b, mtimeOf))
}

/**
 * 把一批 rollout 文件（`{ path, name }`）按 thread 分组成链，并排好页序。
 * 返回 `Map<threadId, pages[]>`，pages 元素为 `{ path, name, nameTs }`。
 * 文件名里没有 thread id 的（测试夹具 / 用户改名的副本）各自成单页组，不丢弃；
 * 供发现层（已在内存里持有全部文件）与目录导入复用。
 */
export function groupCodexThreads(files) {
  const groups = new Map()
  for (const file of files) {
    const name = String(file.name ?? '')
    const threadId = codexThreadIdFromName(name) ?? 'file:' + String(file.path).replace(/\\/g, '/')
    if (!groups.has(threadId)) groups.set(threadId, [])
    groups.get(threadId).push({ path: String(file.path), name, nameTs: codexNameTimestamp(name) })
  }
  for (const pages of groups.values()) {
    pages.sort((a, b) => pageCmp(a, b, () => null))
  }
  return groups
}

/**
 * 单文件导入的链解析：从目标页向上找 sessions 祖先目录，递归收集同 thread 的分页并排序。
 * fs 只需 stat / readHead / listDir 三个能力（discovery host 与 ctx.fs 各自适配成同形状）。
 * 返回 `pages[]`（`{ path, name, nameTs, headPayload }`，headPayload 为 session_meta.payload
 * 或 null）；一个分页都找不到（含目标自身无 thread id）→ null。
 *
 * 遍历**按 thread id 过滤**（不只按扩展名）：一个分页都收不到就说明该 thread 在树里没了，
 * 而全树 rollout 会在候选里堆到上限。预算分两个口径：`maxEntries` 数「看过的目录项」、
 * `maxPages` 数「本链的分页」，任一触顶都抛错——`~/.codex/sessions` 累积多年后可能有几千个
 * rollout，按文件数截断会静默导入一条缺页的链（正是 #57 要修的那类问题），宁可大声失败。
 */
export async function resolveCodexChain(fs, filePath, { maxEntries = 200000, maxPages = 2048 } = {}) {
  // 保持调用方传入的路径**原样**（含分隔符风格）：roots 会继续传给 fs.listDir，
  // 宿主/mock 对分隔符的容忍度不一，改写风格可能让目录列举静默失配
  const target = String(filePath)
  const baseName = target.split(/[\\/]/).pop() || ''
  const threadId = codexThreadIdFromName(baseName)
  if (!threadId) return null

  const ancestor = codexSessionsAncestor(target)
  const ownDir = dirnameAny(target)
  const roots = ancestor && ancestor !== ownDir ? [ancestor, ownDir] : [ownDir]
  // 多个搜索根（祖先 + 自身目录）会重复收到同一文件
  const walk = { threadId, maxEntries, maxPages, out: [], seen: new Set(), entries: 0, overflow: null }
  const seenRoot = new Set()
  for (const root of roots) {
    const key = root.replace(/\\/g, '/')
    if (seenRoot.has(key)) continue
    seenRoot.add(key)
    await walkThreadPages(fs, root, walk)
  }
  if (walk.overflow) {
    const what = walk.overflow === 'pages'
      ? `本链分页超过 ${maxPages} 页`
      : `目录树超过 ${maxEntries} 个目录项`
    throw new Error(`Codex 分页链扫描中止（${what}）：不导入可能缺页的会话，请缩小 path 到该会话所在目录`)
  }

  const pages = []
  for (const cand of walk.out) {
    pages.push({
      path: cand.path,
      name: cand.name,
      nameTs: codexNameTimestamp(cand.name),
      headPayload: await readHeadPayload(fs, cand.path),
    })
  }
  if (pages.length === 0) return null
  // 页序只依赖文件名时间戳（每页创建时写入，单调）；无时间戳的极端文件按名字稳定排序
  return sortCodexPages(pages)
}

// 链解析专用遍历：只收文件名含目标 thread id 的 rollout。同时命中预算时置 walk.overflow
// 并立刻上溯（调用方据此抛错），绝不返回一条看起来正常的半截链。
async function walkThreadPages(fs, dir, walk) {
  if (walk.overflow) return
  let entries
  try {
    entries = await fs.listDir(dir)
  } catch {
    // 目录不可读（权限/缺失）：该子树按空处理
    return
  }
  for (const entry of entries) {
    if (walk.overflow) return
    if (++walk.entries > walk.maxEntries) {
      walk.overflow = 'entries'
      return
    }
    const child = (entry.target && (entry.target.displayPath || entry.target.targetKey)) || joinAny(dir, entry.name)
    if (entry.type === 'directory') {
      await walkThreadPages(fs, child, walk)
      continue
    }
    if (entry.type !== 'file' || !/^rollout-.*\.jsonl$/i.test(entry.name)) continue
    if (!entry.name.includes(walk.threadId)) continue
    const key = child.replace(/\\/g, '/').toLowerCase()
    if (walk.seen.has(key)) continue
    if (walk.out.length >= walk.maxPages) {
      walk.overflow = 'pages'
      return
    }
    walk.seen.add(key)
    walk.out.push({ path: child, name: entry.name })
  }
}

// 递归收集 jsonl 文件；matcher 决定收哪些（链解析只要 rollout-*，目录导入收全部
// .jsonl —— 与既有 codex 目录批量同口径）。上限防御（会话树可能很大）。
async function collectJsonlFiles(fs, dir, out, maxFiles, matcher) {
  if (out.length >= maxFiles) return
  let entries
  try {
    entries = await fs.listDir(dir)
  } catch {
    // 目录不可读（权限/缺失）：该子树按空处理
    return
  }
  for (const entry of entries) {
    if (out.length >= maxFiles) return
    const child = (entry.target && (entry.target.displayPath || entry.target.targetKey)) || joinAny(dir, entry.name)
    if (entry.type === 'directory') {
      await collectJsonlFiles(fs, child, out, maxFiles, matcher)
    } else if (entry.type === 'file' && matcher(entry.name)) {
      out.push({ path: child })
    }
  }
}

// 读文件头并解析出 session_meta.payload（读不到/无 meta → null）
async function readHeadPayload(fs, path) {
  try {
    const head = await fs.readHead(path, 256 * 1024)
    if (!head) return null
    for (const line of head.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const rec = JSON.parse(t)
        if (rec && rec.type === 'session_meta' && rec.payload && typeof rec.payload === 'object') return rec.payload
        break // 首行不是 session_meta（无 meta 的文件）→ 停止
      } catch {
        break
      }
    }
  } catch {
    // 读不到头部：按无 meta 处理
  }
  return null
}

/** 链的复合 stat（grokbuildStat 同款）：size 求和、version 拼接（新增一页即变化）。 */
export function codexChainStat(stats) {
  let size = 0
  const versions = []
  for (const s of stats) {
    size += typeof s?.size === 'number' ? s.size : 0
    versions.push(typeof s?.version === 'string' ? s.version : '')
  }
  return { type: 'file', size, version: versions.join('|') }
}

// 链完整性诊断：第 2 页起每页的 history_base.thread_id 应出现在前一页的文件名里
//（报告者实测形状）。对不上只在导入结果里显式上报（codexChainGaps），不改页序。
function chainGaps(pages) {
  const gaps = []
  for (let i = 1; i < pages.length; i++) {
    const base = pages[i].headPayload && pages[i].headPayload.history_base
    if (!base || typeof base.thread_id !== 'string') continue
    if (!pages[i - 1].name.includes(base.thread_id)) gaps.push(pages[i].name)
  }
  return gaps
}

/** 链 → 中间转换结果（拼接各页文本，一次转换）。返回 { out, stat, rootPath, gaps }。 */
export async function buildCodexChainConversion(fs, pages, args, { sourceLabel = 'Codex/ChatGPT' } = {}) {
  const rootPath = pages[0].path
  const texts = []
  const stats = []
  for (const page of pages) {
    texts.push(await fs.readText(page.path))
    stats.push(await fs.stat(page.path))
  }
  // 拼接必须用换行分隔：各页文件不以换行结尾，直接 join 会让上一页最后一行与下一页
  // 首行（session_meta）合并成一行，JSON.parse 失败被跳过 —— 实测会静默丢掉前页最后
  // 一条 assistant 记录（turn1 变成只有 user 的空轮次）
  const out = finalizeConvertedSession(
    markTrimmedSource(convertCodexJsonl(texts.join('\n'), { ...args, sourcePath: rootPath }), args),
    args,
    sourceLabel,
  )
  const gaps = chainGaps(pages)
  if (gaps.length > 0) out.codexChainGaps = gaps
  return { out, stat: codexChainStat(stats), rootPath, gaps }
}

/**
 * 单链导入（sourcePath = 链的首页；增量：链复合指纹变化 → append 新轮次）。
 * pages 由 resolveCodexChain / groupCodexThreads 提供（已按页序排列）。
 */
export async function importCodexChain(ctx, pages, args, { registryDir, persisted, runDecision, sourceLabel = 'Codex/ChatGPT', fingerprintKeys = [] } = {}) {
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  const archivedIds = archivedSessionIds(ctx)
  const rootPath = pages[0].path
  const registry = await loadImports(registryDir)
  let known = unwrapRecord(registry.imports[rootPath])
  if (known && known.kind !== 'single') known = null
  // 记录指向的会话已不存在或被归档 → 视作无记录重导
  if (known && (!known.dshId || !persistedSet.has(known.dshId) || archivedIds.has(known.dshId))) known = null
  // fullHistory（压缩是否尊重）会改变转换产物 → 进参数指纹（pi/opencode 同款）：
  // 换值后重导走 args-changed 跳过，不静默沿用旧会话
  const fingerprint = argsFingerprint(args, fingerprintKeys)

  const fs = {
    readText: async (p) => ctx.fs.readText(await ctx.fs.resolve(p)),
    stat: async (p) => ctx.fs.stat(await ctx.fs.resolve(p)),
  }
  const { out, stat } = await buildCodexChainConversion(fs, pages, args, { sourceLabel })

  // S3 短路径（grokbuild 同款）：force / 显式 sessionId 变更需读文件建副本，不在此跳过
  if (known && args.force !== true && args.replace !== true && !isSessionIdChange(args, known.dshId)) {
    if (typeof known.args === 'string' && fingerprint !== known.args) {
      return alreadyImportedResult(known, 'argsChanged')
    }
    if (typeof known.budget === 'number' && known.budget !== args.budget) {
      return alreadyImportedResult(known, 'budgetChanged')
    }
    if (stat.version === known.version && stat.size === known.sizeBytes) {
      return alreadyImportedResult(known, null)
    }
  }

  if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
    const res = { sessionId: 'none', turns: 0, messages: 0, toolCalls: 0, skipped: 1, alreadyImported: false, status: 'skipped' }
    if (out.skipReason) res.skipReason = out.skipReason
    return attachConversionDetails(out, res)
  }
  const decision = await decideSingle(ctx, {
    known, converted: out, stat, args, fingerprint, persisted: persistedSet,
    sourcePath: rootPath, budget: args.budget, archivedIds, importFormat: 'codex',
  })
  return attachConversionDetails(out, await runDecision(ctx, decision, registryDir, rootPath, persistedSet, { workspaceMode: args.workspaceMode, workspaceDir: args.workspaceDir }))
}

function alreadyImportedResult(known, flag) {
  const res = {
    sessionId: known.dshId, turns: known.turns, messages: 0, toolCalls: 0, skipped: 0,
    alreadyImported: true, status: 'already-imported',
  }
  if (flag === 'argsChanged') res.argsChanged = true
  if (flag === 'budgetChanged') res.budgetChanged = true
  return res
}

// ctx.fs → 链解析所需的极小 fs 面（discovery host 与 ctx.fs 的公共子集）
function codexFs(ctx) {
  return {
    readText: async (p) => ctx.fs.readText(await ctx.fs.resolve(p)),
    stat: async (p) => ctx.fs.stat(await ctx.fs.resolve(p)),
    readHead: async (p, max) => {
      const t = await ctx.fs.resolve(p)
      if (typeof ctx.fs.streamText === 'function') {
        const iter = await ctx.fs.streamText(t)
        let out = ''
        for await (const chunk of iter) {
          out += chunk
          if (out.length >= max) break
        }
        return out.slice(0, max)
      }
      try {
        return (await ctx.fs.readText(t)).slice(0, max)
      } catch {
        return null
      }
    },
    listDir: async (p) => {
      const t = await ctx.fs.resolve(p)
      const entries = await ctx.fs.listDir(t)
      return entries.map((e) => ({
        name: e.name,
        type: e.type,
        target: (e.target && (e.target.displayPath || e.target.targetKey)) || joinAny(p, e.name),
      }))
    },
  }
}

/** 单文件导入：任意一页 → 整链一次导入（无法成链时回退通用单文件路径）。 */
export async function importCodexFile(ctx, target, args, { registryDir, persisted, runDecision, sourceLabel = 'Codex/ChatGPT', fingerprintKeys = [] } = {}) {
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const chain = await resolveCodexChain(codexFs(ctx), sourcePath)
  // 无法成链（文件名没有 thread id 等）：回退通用单文件路径，保持既有行为
  if (!chain) {
    return importTranscript(ctx, target, args, convertCodexJsonl, {
      registryDir, persisted, fingerprintKeys,
      sourceLabel: sourceLabel || 'Codex/ChatGPT', importFormat: 'codex',
    })
  }
  return importCodexChain(ctx, chain, args, { registryDir, persisted, runDecision, sourceLabel, fingerprintKeys })
}

/** 目录导入：收集全部 rollout → 按 thread 分组 → 逐链走单会话状态机，聚合为批量形态。 */
export async function importCodexDirectory(ctx, dirTarget, args, { registryDir, persisted, runDecision, sourceLabel = 'Codex/ChatGPT', fingerprintKeys = [] } = {}) {
  const dirPath = dirTarget.displayPath || ctx.fs.processPath(dirTarget)
  const groups = groupCodexThreads(await collectAllRollouts(ctx, dirPath))
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  // 每条链以首页为幂等键与结果路径
  return runImportBatch(ctx, [...groups],
    ([, pages]) => importCodexChain(ctx, pages, { ...args, force: args.force === true }, {
      registryDir, persisted: persistedSet, runDecision, sourceLabel, fingerprintKeys,
    }),
    { registryDir, pathOf: ([, pages]) => pages[0].path, skipReason: ([threadId]) => 'no user turns (thread ' + threadId + ')' })
}

/** 单文件预览：整链 dry-run（与落盘同口径）。 */
export async function previewCodexFile(ctx, target, args, { sourceLabel = 'Codex/ChatGPT' } = {}) {
  const sourcePath = target.displayPath || ctx.fs.processPath(target)
  const chain = await resolveCodexChain(codexFs(ctx), sourcePath)
  if (!chain) {
    const out = finalizeConvertedSession(
      markTrimmedSource(convertCodexJsonl(await ctx.fs.readText(await ctx.fs.resolve(sourcePath)), { ...args, sourcePath }), args),
      args,
      sourceLabel,
    )
    return previewEntry(out)
  }
  const { out } = await buildCodexChainConversion(codexFs(ctx), chain, args, { sourceLabel })
  return previewEntry(out)
}

/** 目录预览：逐链 dry-run，恒批量。 */
export async function previewCodexDirectory(ctx, dirTarget, args, { sourceLabel = 'Codex/ChatGPT' } = {}) {
  const dirPath = dirTarget.displayPath || ctx.fs.processPath(dirTarget)
  const groups = groupCodexThreads(await collectAllRollouts(ctx, dirPath))
  const results = []
  for (const [threadId, pages] of groups) {
    const { out } = await buildCodexChainConversion(codexFs(ctx), pages, args, { sourceLabel })
    if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
      results.push({ path: pages[0].path, skipped: 1, skipReason: 'no user turns (thread ' + threadId + ')' })
      continue
    }
    results.push({ path: pages[0].path, ...previewEntry(out) })
  }
  return { total: groups.size, results }
}

// 收集目录树下全部 rollout 文件（字符串路径；与既有 codex 目录批量同口径收 .jsonl）
async function collectAllRollouts(ctx, dirPath) {
  const out = []
  await collectJsonlFiles(codexFs(ctx), dirPath, out, 4096, (name) => /\.jsonl$/i.test(name))
  return out
}
