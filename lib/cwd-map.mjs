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
