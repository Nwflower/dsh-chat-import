// lib/cwd-map.mjs — REQ-39 full：cwd 权威映射 + 沙箱防护（host 面，消费 ctx.fs）
//
// 三来源优先级（同类生态插件同款）：解析器结果 > 扫描提示（权威映射）> 兜底解码。
//   1. Claude：~/.claude.json 的 projects 键做权威映射（键 = 真实路径，slugify 后与
//      会话目录名比对：精确 / basename / 下划线变体），失败才 ASCII slug 解码回退
//     （'C--Users-名-proj' → 'C:\Users\名\proj'，含 '-' 的目录名天然歧义 → 仅兜底）；
//   2. Reasonix：项目 slug 贪心解码——磁盘存在性逐段匹配（剩余整段 → 单段 → 合并
//      ≤3 段），兼容含 '-' 的目录名；
//   3. 沙箱防护：cwd = 用户主目录时 dsh 沙箱 ACL 会拒绝（temp 在 workspace 内，pwsh
//      等工具直接失败）——isHomePath 判断，候选含主目录一律跳过（回退源文件目录）。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile, readdir } from 'node:fs/promises'

// 路径归一（跨平台：折叠尾部斜杠、反斜杠换正斜杠；主目录比较再小写折叠）。
function norm(p) {
  return String(p ?? '').replace(/[\\/]+$/, '').replace(/\\/g, '/')
}

export function isHomePath(path) {
  const home = norm(homedir())
  return Boolean(home) && norm(path).toLowerCase() === home.toLowerCase()
}

// Claude 项目 slug（匹配用编码）：非字母数字（含 CJK 字母）→ '-'。与
// lib/export/claude.mjs 的 slugifyClaudeCwd（输出目录名用，严格 ASCII）不同：
// Claude 真实项目目录名保留中文（'C--Users-千川白浪-…'），匹配必须同款编码。
export function slugifyClaudeCwd(cwd) {
  return String(cwd).replace(/[^\p{L}\p{N}]/gu, '-')
}

// ASCII slug 解码（兜底，有损）：'C--Users-名-proj' → 'C:\Users\名\proj'。
// 首段后接 '--' 视为盘符边界（Windows）；其余 '-' 视为路径分隔符。含 '-' 的目录名
// 会被误拆（歧义已知，仅作最后兜底，优先权威映射）。
export function decodeClaudeSlug(slug) {
  const s = String(slug ?? '')
  if (!s) return null
  const m = s.match(/^([A-Za-z])--(.*)$/)
  if (m) return m[1] + ':\\' + m[2].replace(/-/g, '\\')
  return s.replace(/-/g, '\\')
}

// 读 ~/.claude.json 的 projects 键集合（缺失/损坏返回 null）。
async function readClaudeProjects(ctx) {
  try {
    const target = await ctx.fs.resolve(homedir() + '\\.claude.json')
    const raw = await ctx.fs.readText(target)
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.projects === 'object' && parsed.projects !== null) {
      return Object.keys(parsed.projects)
    }
    return []
  } catch {
    // 文件缺失/损坏/非对象：按无映射处理（回退 slug 解码）
    return null
  }
}

// Claude 权威映射：slug（会话目录名）→ 真实路径。匹配策略：
//   精确（slugify(key) === slug）> basename（key 的 basename slugify 后 === slug）>
//   下划线变体（slug 中 '-' 换 '_' 后匹配）。无命中返回 null（调用方走解码回退）。
export async function resolveClaudeCwd(ctx, slug, _sourcePath) {
  if (!slug) return null
  const keys = await readClaudeProjects(ctx)
  if (!Array.isArray(keys)) return null
  const target = slugifyClaudeCwd(slug)
  const underscore = slug.replace(/-/g, '_')
  for (const key of keys) {
    if (slugifyClaudeCwd(key) === target) return key
  }
  for (const key of keys) {
    const base = String(key).split(/[\\/]/).pop() || ''
    if (slugifyClaudeCwd(base) === target) return key
  }
  for (const key of keys) {
    if (String(key).includes(underscore) || slugifyClaudeCwd(key) === underscore) return key
  }
  return null
}

// Reasonix slug 贪心解码：磁盘存在性逐段匹配，兼容含 '-' 的目录名。
// slug 形如 'c--users--name--proj'（Windows 小写 + ':'/'\\'/'/' → '-'）。贪心策略：
// 在每段分界处优先「剩余整段作为完整路径」→ 其次「单段」→ 其次「合并 ≤3 段」，
// 命中即返回；全程不命中返回 null。存在性经 ctx.fs.stat（目录）。
export async function greedyDecodeSlugPath(ctx, slug) {
  const s = String(slug ?? '')
  if (!s) return null
  const segments = s.split('-').filter(Boolean)
  if (segments.length === 0) return null
  const head = segments[0]
  // 候选驱动器前缀（小写盘符 → 大写）：'c' → 'C:\'
  const drive = /^[a-z]$/.test(head) ? head.toUpperCase() + ':\\' : null
  const rest = drive ? segments.slice(1) : segments
  const joinPath = (parts) => (drive ? drive : '') + parts.join('\\')
  const exists = async (p) => {
    try {
      const info = await ctx.fs.stat(await ctx.fs.resolve(p))
      return !!(info && info.type === 'directory')
    } catch {
      return false
    }
  }
  // 1) 剩余整段（'c--users--name--proj' → 'C:\users\name\proj' 直接命中）
  if (await exists(joinPath(rest))) return joinPath(rest)
  // 2) 贪心逐段：已匹配前缀上追加，每步优先「剩余整段」→「单段」→「合并 2~3 段」。
  // 合并 = 把多个 slug 段用 '-' 重新拼回一个目录名（含 '-' 的目录名被编码拆散，
  // 如 'my-proj' → 'my','proj'）。
  const matched = []
  let i = 0
  while (i < rest.length) {
    if (await exists(joinPath([...matched, ...rest.slice(i)]))) {
      matched.push(...rest.slice(i))
      return joinPath(matched)
    }
    if (await exists(joinPath([...matched, rest[i]]))) {
      matched.push(rest[i])
      i++
      continue
    }
    let consumed = null
    for (let n = 2; n <= 3 && i + n <= rest.length; n++) {
      const merged = rest.slice(i, i + n).join('-')
      if (await exists(joinPath([...matched, merged]))) { consumed = n; break }
    }
    if (consumed !== null) {
      matched.push(rest.slice(i, i + consumed).join('-'))
      i += consumed
      continue
    }
    return null
  }
  return matched.length > 0 ? joinPath(matched) : null
}

// ── Cursor 项目 slug（\ 与 . 均编码为 -；盘符小写单字母前缀 e-/c-）────────────

const CURSOR_NON_REPO_SLUGS = new Set(['empty-window'])

/** Cursor agent-transcript 路径 → projects/<slug> 段；非 Cursor 布局返回 null。 */
export function cursorSlugFromTranscriptPath(sourcePath) {
  const p = String(sourcePath ?? '').replace(/\\/g, '/')
  const m = p.match(/\/projects\/([^/]+)\/agent-transcripts\//i)
  return m ? m[1] : null
}

/** 无真实仓库对应、不应解码为磁盘路径的 Cursor slug（空窗口 / 纯数字项目 id）。 */
export function isCursorNonRepoSlug(slug) {
  const s = String(slug ?? '')
  if (!s || CURSOR_NON_REPO_SLUGS.has(s)) return true
  return /^\d+$/.test(s)
}

/** Windows 绝对路径 → Cursor projects/<slug> 目录名（与 Cursor 编码规则对齐）。 */
export function encodeCursorSlug(absPath) {
  const p = String(absPath ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const m = p.match(/^([A-Za-z]):\/?(.*)$/)
  if (!m) return null
  const drive = m[1].toLowerCase()
  const tail = m[2]
    .split('/')
    .filter(Boolean)
    .map((seg) => seg.replace(/\./g, '-'))
    .join('-')
  return tail ? drive + '-' + tail : drive
}

/** 从 Cursor 首条 user 文本的 <timestamp>…</timestamp> 解析毫秒时间戳。 */
export function parseCursorEmbeddedTimestamp(text) {
  const m = String(text ?? '').match(/<timestamp>\s*([^<]+?)\s*<\/timestamp>/i)
  if (!m) return undefined
  const cleaned = m[1].replace(/\s*\(UTC[^)]*\)\s*/gi, ' ').trim()
  const n = Date.parse(cleaned)
  return Number.isFinite(n) ? n : undefined
}

/** 剥离 Cursor 标题中的 <timestamp> 与 <user_query> 包裹，供面板展示。 */
export function stripCursorTitleDecorations(text) {
  return String(text ?? '')
    .replace(/<timestamp>[\s\S]*?<\/timestamp>\s*/gi, '')
    .replace(/<\/?user_query>/gi, '')
    .trim()
}

let workspacePathCache = null
let workspacePathCacheAt = 0
const WORKSPACE_PATH_CACHE_MS = 30_000

/** 测试用：清空 workspace 路径缓存。 */
export function clearWorkspacePathCache() {
  workspacePathCache = null
  workspacePathCacheAt = 0
}

function collectPathsFromWorkspaceJson(node, paths) {
  if (!node || typeof node !== 'object') return
  if (typeof node.path === 'string' && node.path) paths.add(node.path)
  if (typeof node.cwd === 'string' && node.cwd) paths.add(node.cwd)
  for (const key of ['workspaces', 'items', 'list']) {
    const arr = node[key]
    if (!Array.isArray(arr)) continue
    for (const item of arr) {
      if (typeof item === 'string' && item) paths.add(item)
      else collectPathsFromWorkspaceJson(item, paths)
    }
  }
}

/** 读取 DSH profile storages/workspace.json 中的已知工作区路径（best-effort）。 */
async function loadDshWorkspaceJsonPaths() {
  const paths = new Set()
  const base = process.env.DSH_HOME || join(homedir(), '.dsh')
  try {
    const profilesDir = join(base, 'profiles')
    const profiles = await readdir(profilesDir, { withFileTypes: true })
    for (const prof of profiles) {
      if (!prof.isDirectory()) continue
      const file = join(profilesDir, prof.name, 'storages', 'workspace.json')
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'))
        collectPathsFromWorkspaceJson(parsed, paths)
      } catch {
        // 单 profile 缺失/损坏：跳过
      }
    }
  } catch {
    // profiles 目录不可用
  }
  return paths
}

async function knownWorkspacePaths(ctx) {
  const now = Date.now()
  if (workspacePathCache && now - workspacePathCacheAt < WORKSPACE_PATH_CACHE_MS) {
    return workspacePathCache
  }
  const paths = await loadDshWorkspaceJsonPaths()
  try {
    const wr = ctx && typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null
    if (wr && typeof wr.list === 'function') {
      for (const ws of wr.list()) {
        const p = ws && (ws.path || ws.cwd)
        if (typeof p === 'string' && p) paths.add(p)
      }
    }
  } catch {
    // workspaceRegistry 不可读：仅用 workspace.json
  }
  workspacePathCache = paths
  workspacePathCacheAt = now
  return paths
}

/** Cursor slug 贪心解码：在盘符前缀后逐段匹配目录，段内 `-` 可还原为 `.`（兼容 Funion.Client-develop）。 */
export async function greedyDecodeCursorSlugPath(ctx, slug) {
  const s = String(slug ?? '')
  const m = s.match(/^([a-z])-(.*)$/i)
  if (!m) return null
  const drive = m[1].toUpperCase() + ':\\'
  const segments = m[2].split('-').filter(Boolean)
  if (segments.length === 0) return null
  const exists = async (p) => {
    try {
      const info = await ctx.fs.stat(await ctx.fs.resolve(p))
      return !!(info && info.type === 'directory')
    } catch {
      return false
    }
  }
  const nameVariants = (parts) => {
    const out = new Set([parts.join('-')])
    if (parts.length === 2) out.add(parts[0] + '.' + parts[1])
    if (parts.length === 3) {
      out.add(parts[0] + '.' + parts[1] + '-' + parts[2])
      out.add(parts[0] + '.' + parts[1] + '.' + parts[2])
    }
    return [...out]
  }
  async function walk(i, prefix) {
    if (i >= segments.length) return (await exists(prefix)) ? prefix : null
    for (let n = segments.length - i; n >= 1; n--) {
      const chunk = segments.slice(i, i + n)
      for (const name of nameVariants(chunk)) {
        const next = prefix + name
        if (!(await exists(next))) continue
        if (i + n >= segments.length) return next
        const rest = await walk(i + n, next + '\\')
        if (rest) return rest
      }
    }
    return null
  }
  return walk(0, drive)
}

/** Cursor projects/<slug> → 真实工作区绝对路径（workspace.json / registry 正向匹配优先，再贪心解码）。 */
export async function resolveCursorSlugPath(ctx, slug) {
  if (!slug || isCursorNonRepoSlug(slug)) return null
  const paths = await knownWorkspacePaths(ctx)
  for (const p of paths) {
    if (encodeCursorSlug(p) === slug) return p
  }
  return greedyDecodeCursorSlugPath(ctx, slug)
}
