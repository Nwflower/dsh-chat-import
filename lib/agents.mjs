// lib/agents.mjs — REQ-59 外部 agent/mode prompt 落盘转换为 DSH skills 资产
//
// 把 pi（~/.pi/agent/{agents,prompts}/*.md）与 opencode（~/.config/opencode/
// {agents,skill}/*.md）的自定义 agent / mode prompt / skill 转换为 DSH 持久化
// skill bundle：`$DSH_AGENTS_HOME/skills/<name>/SKILL.md`（`$DSH_AGENTS_HOME`
// 缺省 `~/.agents`，即默认 `~/.agents/skills/<name>/SKILL.md`）。
//
// 与 REQ-28（context-bridge.mjs）互补：REQ-28 是运行时只读桥接（Claude 侧、
// scoped systemPrompt / skills.registerProvider、销毁即撤销）；本模块是落盘资产
// 迁移（pi/opencode 侧、写 user-agents root、持久生效）。
//
// 结构：本模块分两层——
//   1. 纯函数核心（零 ctx、可独立单测）：parseFrontmatter / collectCandidates /
//      planSkillWrites。
//   2. ctx 驱动层：readMdFiles / collectAgents / existingBundles /
//      applySkillPlan（写面） / runAgentsImport（读源目录 → 规划 → 预览或落盘）。
// 目标路径解析（resolveAgentsHome）与源目录发现（defaultPiRoot / opencodeConfigRoot）
// 独立成纯函数，便于测试注入。
//
// 语义（对标同类生态插件 dsh-import-agents lib/agents.mjs，2026-08-15 源码逐行核实）：
//   - 来源带 `kind: dsh | skill` frontmatter 的 md 视为已是 DSH 技能，不重复导入；
//   - plan/apply 分离：planSkillWrites 纯函数先规划（write/complete/skip + 原因），
//     不触碰文件系统；applySkillPlan（ctx 写面）才写盘（单条写）；
//   - 幂等：目标 SKILL.md 内容相同 → skip；同名冲突 → `-<source>` 后缀消歧
//     （已占用则 skip）；已存在 bundle 目录但缺 SKILL.md → 原地补全（保留如
//     scripts/ 等既有内容，如 kimi-vision）；
//   - 嵌套 YAML（如 pi agent 的 permission: edit: deny）保留在 frontmatter 中。

import { homedir } from 'node:os'
import { join } from 'node:path'

/** user-agents root：`$DSH_AGENTS_HOME`（缺省 `~/.agents`）。纯函数。 */
export function resolveAgentsHome(env = process.env) {
  return env.DSH_AGENTS_HOME || join(homedir(), '.agents')
}

/** pi 根目录：`~/.pi/agent`。纯函数（便于测试注入）。 */
export function defaultPiRoot(env = process.env) {
  return join(env.HOME || homedir(), '.pi', 'agent')
}

/** opencode 配置根：`~/.config/opencode`（Linux/macOS）；Windows 走 ~/.config 同款。 */
export function opencodeConfigRoot(env = process.env) {
  return join(env.HOME || homedir(), '.config', 'opencode')
}

/** Claude 配置根：`~/.claude`（REQ-61 资产源）。纯函数。 */
export function defaultClaudeRoot(env = process.env) {
  return join(env.HOME || homedir(), '.claude')
}

/** Codex 配置根：`~/.codex`（REQ-64 资产源）。纯函数。 */
export function defaultCodexRoot(env = process.env) {
  return join(env.HOME || homedir(), '.codex')
}

/** YAML 标量解析（轻量）：单/双引号去引号并还原转义；其余原样返回。
 * 借鉴 sjh9714/dsh-movein 的 frontmatter 形态清单（MIT）——plain scalar 外的
 * 单引号 / 双引号写法在迁移后不应把引号字符带进 description。纯函数。 */
export function yamlScalar(value) {
  const s = String(value)
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1).replace(/''/g, "'")
  }
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return s
}

/** 解析 md frontmatter：返回 { frontmatter, body, raw }；无 frontmatter 返回 null。
 * 简单键值行经 yamlScalar 去引号；`key: |` / `key: >` 等 block scalar 折叠后续
 * 缩进行为多行值；其余嵌套 YAML（如 permission: edit: deny）逐行追加保留结构。
 * 纯函数。 */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (match === null) return null
  const frontmatter = {}
  let currentKey
  let blockMode = null // 'folded' | 'literal'：正在收集 block scalar 的后续缩进行
  for (const line of match[1].split(/\r?\n/)) {
    if (blockMode !== null) {
      const indent = /^\s*/.exec(line)[0]
      if (line.trim().length > 0 && indent.length > 0) {
        // block scalar 内容行：folded（>）以空格折叠，literal（|）保留换行
        const sep = blockMode === 'folded' ? ' ' : '\n'
        const prev = frontmatter[currentKey] ?? ''
        frontmatter[currentKey] = prev.length > 0 ? `${prev}${sep}${line.trim()}` : line.trim()
        continue
      }
      blockMode = null // 无缩进行结束 block scalar
    }
    const simple = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (simple) {
      currentKey = simple[1]
      const raw = simple[2]
      if (/^[>|][+-]?$/.test(raw)) {
        frontmatter[currentKey] = ''
        blockMode = raw[0] === '>' ? 'folded' : 'literal'
      } else {
        frontmatter[currentKey] = yamlScalar(raw)
      }
    } else if (currentKey !== undefined && line.trim().length > 0) {
      // 嵌套 YAML（如 permission: edit: deny）——保留原始缩进行
      frontmatter[currentKey] = `${frontmatter[currentKey] ?? ''}\n${line}`
    }
  }
  return { frontmatter, body: match[2], raw: text }
}

/** 候选：{ name, source, kind, sourceFile, description, body, extraFrontmatter }。纯函数。 */

/**
 * 从一组「已读内容」构造候选（纯函数；读取由调用方完成）。
 * @param {{file:string, text:string}[]} files 源文件清单（path + 内容）
 * @param {object} opts { source, kind, nameFrom } —— nameFrom(file) 缺省取文件名 stem
 * @returns {{name, source, kind, sourceFile, description, body, extraFrontmatter}[]}
 *   候选；带 `kind: dsh | skill` frontmatter 的源被过滤（已是 DSH 技能，不重复导入）。
 *   extraFrontmatter = 原 frontmatter 中除 name/description 外的键（含嵌套 YAML 原样保留），
 *   供 skillFrontmatter 写回——同类生态插件语义「保留源 frontmatter 结构」。
 */
export function collectCandidates(files, opts) {
  const { source, kind, nameFrom } = opts
  const candidates = []
  for (const f of files) {
    const parsed = parseFrontmatter(f.text)
    const fm = parsed?.frontmatter ?? {}
    if (fm.kind === 'dsh' || fm.kind === 'skill') continue // 已是 DSH 技能，跳过
    const stem = f.file.slice(0, -3).split(/[\\/]/).pop() || ''
    const name = String(fm.name ?? (nameFrom ? nameFrom(f.file) : stem)).trim() || stem
    const extraFrontmatter = {}
    for (const [k, v] of Object.entries(fm)) {
      if (k !== 'name' && k !== 'description') extraFrontmatter[k] = v
    }
    candidates.push({
      name,
      source,
      kind,
      sourceFile: f.file,
      description: String(fm.description ?? '').trim(),
      body: parsed === null ? f.text : parsed.body,
      extraFrontmatter,
    })
  }
  return candidates
}

/** YAML 单引号标量转义（`'` → `''`）。DSH 用完整 YAML 解析器读 SKILL.md，
 * description 含 `: ` 时 plain scalar 会触发 nested mapping 错误、技能被静默丢弃
 * （issue #13 / deepseek-ai/deepseek-harness#1401）。纯函数。 */
export function yamlSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** DSH skill frontmatter（provenance：name / description / metadata.source / metadata.kind
 * + 源 frontmatter 的其余键原样保留）。description 统一单引号转义。纯函数。 */
export function skillFrontmatter(candidate) {
  const lines = ['---', `name: ${candidate.name}`]
  if (candidate.description.length > 0) {
    lines.push(`description: ${yamlSingleQuote(candidate.description)}`)
  } else {
    lines.push(`description: ${yamlSingleQuote(`Imported from ${candidate.source} (${candidate.kind}: ${candidate.name})`)}`)
  }
  // 源 frontmatter 的额外键（permission 等）原样写回，保持嵌套 YAML 结构
  for (const [k, v] of Object.entries(candidate.extraFrontmatter ?? {})) {
    lines.push(`${k}: ${v}`)
  }
  lines.push('metadata:')
  lines.push(`  source: ${candidate.source}`)
  lines.push(`  kind: ${candidate.kind}`)
  lines.push('---')
  return `${lines.join('\n')}\n`
}

/**
 * 规划技能写盘（纯函数，不触碰文件系统；skillsRoot 与既有 bundle 状态由调用方注入）。
 * @param {object} state { skillsRoot, existing: Map<name, {content?} | null> }
 *   —— existing.get(name) = { content }（bundle 已有 SKILL.md）或 null（bundle 目录存在但
 *   无 SKILL.md）或 undefined（无该 bundle）。
 * @param {object[]} candidates collectCandidates 输出
 * @returns {{target, name, action:'write'|'complete'|'skip', renamed?, reason?}[]}
 */
export function planSkillWrites(state, candidates) {
  const plans = []
  const taken = new Map() // 本次规划内已占用的目标名 → 内容
  for (const candidate of candidates) {
    const content = `${skillFrontmatter(candidate)}${candidate.body}`
    let name = candidate.name
    let renamed = false
    if (taken.has(name)) {
      // 本次规划内另一源已占同名 → 加源后缀消歧；后缀也被占则 skip
      const suffixed = `${name}-${candidate.source}`
      if (taken.has(suffixed)) {
        plans.push({ name, action: 'skip', candidate, reason: `name conflict (${suffixed} already taken)` })
        continue
      }
      name = suffixed
      renamed = true
    }
    const existing = state.existing.get(name)
    if (existing !== undefined && existing !== null && existing.content === content) {
      plans.push({ name, action: 'skip', candidate, target: join(state.skillsRoot, name, 'SKILL.md'), reason: 'identical content' })
      continue
    }
    if (existing !== undefined && existing !== null) {
      // bundle 已有不同内容：加源后缀；后缀也被占则 skip
      const suffixed = `${name}-${candidate.source}`
      if (taken.has(suffixed) || state.existing.get(suffixed) !== undefined) {
        plans.push({ name, action: 'skip', candidate, reason: `name conflict (${suffixed} already exists)` })
        continue
      }
      name = suffixed
      renamed = true
      plans.push({ name: suffixed, action: 'write', candidate, target: join(state.skillsRoot, suffixed, 'SKILL.md'), renamed: true })
      taken.set(suffixed, content)
      continue
    }
    if (existing === null) {
      // bundle 目录存在但无 SKILL.md（如 kimi-vision 保留 scripts/）→ 原地补全
      plans.push({ name, action: 'complete', candidate, target: join(state.skillsRoot, name, 'SKILL.md') })
      taken.set(name, content)
      continue
    }
    plans.push({ name, action: 'write', candidate, target: join(state.skillsRoot, name, 'SKILL.md'), renamed })
    taken.set(name, content)
  }
  return plans
}

/** 读目录下全部 .md 文件内容（缺目录返回 []；单个文件读失败跳过）。ctx 驱动层，
 * 适配仓库 fs 抽象（resolve/stat/readText/listDir，target 对象 + targetKey）。 */
export async function readMdFiles(fsLike, dir) {
  const dirTarget = await fsLike.resolve(dir)
  let entries
  try {
    entries = await fsLike.listDir(dirTarget)
  } catch {
    return [] // 缺目录/无权限：空清单（不报错）
  }
  const out = []
  for (const entry of entries) {
    if (entry.type === 'file' && /\.md$/i.test(entry.name)) {
      try {
        out.push({ file: entry.target.targetKey, text: await fsLike.readText(entry.target) })
      } catch {
        // 单文件读失败跳过（损坏/权限），不影响其余
      }
    }
  }
  return out
}

/** 收集 pi + opencode 的全部候选（ctx 驱动层）。每个源目录独立收集并打标签。 */
export async function collectAgents(fsLike, { piRoot, opencodeRoot }) {
  const candidates = []
  candidates.push(...collectCandidates(await readMdFiles(fsLike, join(piRoot, 'agents')), { source: 'pi', kind: 'agent' }))
  candidates.push(...collectCandidates(await readMdFiles(fsLike, join(piRoot, 'prompts')), { source: 'pi', kind: 'prompt', nameFrom: (file) => `pi-prompt-${file.slice(0, -3).split(/[\\/]/).pop()}` }))
  candidates.push(...collectCandidates(await readMdFiles(fsLike, join(opencodeRoot, 'agents')), { source: 'opencode', kind: 'agent' }))
  candidates.push(...collectCandidates(await readMdFiles(fsLike, join(opencodeRoot, 'skill')), { source: 'opencode', kind: 'skill' }))
  return candidates
}

const stemOf = (file) => String(file).slice(0, -3).split(/[\\/]/).pop() || ''
const parentNameOf = (file) => String(file).split(/[\\/]/).slice(-2)[0] || ''

// 读 dir 下全部子目录里的 .md（一层：memory 的 feedback/project/reference/user 布局）。
async function readGroupedMd(fsLike, dir) {
  const dirTarget = await fsLike.resolve(dir)
  let entries
  try {
    entries = await fsLike.listDir(dirTarget)
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (entry.type !== 'directory') continue
    out.push(...await readMdFiles(fsLike, entry.target.targetKey))
  }
  return out
}

// 读 dir 下全部子目录的 SKILL.md（skills 布局：<dir>/<skill>/SKILL.md；缺文件跳过）。
async function readSkillBundles(fsLike, dir) {
  const dirTarget = await fsLike.resolve(dir)
  let entries
  try {
    entries = await fsLike.listDir(dirTarget)
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (entry.type !== 'directory') continue
    const skillFile = join(entry.target.targetKey, 'SKILL.md')
    try {
      out.push({ file: skillFile, text: await fsLike.readText(await fsLike.resolve(skillFile)) })
    } catch {
      // 目录缺 SKILL.md（损坏/半成品）跳过
    }
  }
  return out
}

/**
 * REQ-61 收集 Claude 资产候选（ctx 驱动层，复用 collectCandidates 的 provenance 语义）：
 *   - memory：`~/.claude/memory/<group>/<name>.md` —— 名字 `group-stem` 前缀保序；
 *   - skills：`~/.claude/skills/<skill>/SKILL.md` —— 名字取 skill 目录名；
 *   - 项目 CLAUDE.md：仅显式 `claudeProjectRoot` 时读取（名字 claude-md）。
 * 与 REQ-28 context-bridge 互补：bridge 是运行时 scoped 注入，本项是持久资产，可同时生效。
 */
export async function collectClaudeCandidates(fsLike, { claudeRoot, claudeProjectRoot }) {
  const candidates = []
  candidates.push(...collectCandidates(await readGroupedMd(fsLike, join(claudeRoot, 'memory')), {
    source: 'claude', kind: 'memory',
    nameFrom: (file) => `${parentNameOf(file)}-${stemOf(file)}`,
  }))
  candidates.push(...collectCandidates(await readSkillBundles(fsLike, join(claudeRoot, 'skills')), {
    source: 'claude', kind: 'skill',
    nameFrom: (file) => parentNameOf(file),
  }))
  if (claudeProjectRoot) {
    const mdFile = join(claudeProjectRoot, 'CLAUDE.md')
    try {
      const target = await fsLike.resolve(mdFile)
      const text = await fsLike.readText(target)
      candidates.push(...collectCandidates([{ file: mdFile, text }], {
        source: 'claude', kind: 'project', nameFrom: () => 'claude-md',
      }))
    } catch {
      // 项目根无 CLAUDE.md / 读失败：跳过（不报错）
    }
  }
  return candidates
}

// 读单个 md/toml 文件作为候选（缺文件/读失败静默跳过；供 Codex instructions/AGENTS/config）。
async function readSingleCandidate(fsLike, file, { source, kind, nameFrom }) {
  try {
    const target = await fsLike.resolve(file)
    const text = await fsLike.readText(target)
    return collectCandidates([{ file, text }], { source, kind, nameFrom })
  } catch {
    return []
  }
}

/**
 * REQ-64 收集 Codex 资产候选（ctx 驱动层）：
 *   - skills：`~/.codex/skills/<skill>/SKILL.md` —— 名字取 skill 目录名；
 *   - instructions：`~/.codex/instructions.md` —— 名字 `codex-instructions`；
 *   - AGENTS：`~/.codex/AGENTS.md` —— 名字 `codex-agents`；
 *   - config：`~/.codex/config.toml` —— 名字 `codex-config`（作为参考资产落为 skill bundle，
 *     不直接改 DSH 配置；真正的配置翻译建议见后续 REQ-71）。
 */
export async function collectCodexCandidates(fsLike, { codexRoot }) {
  const candidates = []
  candidates.push(...collectCandidates(await readSkillBundles(fsLike, join(codexRoot, 'skills')), {
    source: 'codex', kind: 'skill',
    nameFrom: (file) => parentNameOf(file),
  }))
  candidates.push(...await readSingleCandidate(fsLike, join(codexRoot, 'instructions.md'), {
    source: 'codex', kind: 'instruction', nameFrom: () => 'codex-instructions',
  }))
  candidates.push(...await readSingleCandidate(fsLike, join(codexRoot, 'AGENTS.md'), {
    source: 'codex', kind: 'instruction', nameFrom: () => 'codex-agents',
  }))
  candidates.push(...await readSingleCandidate(fsLike, join(codexRoot, 'config.toml'), {
    source: 'codex', kind: 'config', nameFrom: () => 'codex-config',
  }))
  return candidates
}

/** 探测 skillsRoot 下既有 bundle 状态：Map<name, {content}|null>（null = 目录存在无 SKILL.md）。ctx 驱动层。 */
export async function existingBundles(fsLike, skillsRoot) {
  const map = new Map()
  const dirTarget = await fsLike.resolve(skillsRoot)
  let entries
  try {
    entries = await fsLike.listDir(dirTarget)
  } catch {
    return map // 缺根目录：全无既有 bundle
  }
  for (const entry of entries) {
    if (entry.type !== 'directory') continue
    const skillFile = join(entry.target.targetKey, 'SKILL.md')
    const skillTarget = await fsLike.resolve(skillFile)
    try {
      const text = await fsLike.readText(skillTarget)
      map.set(entry.name, { content: text })
    } catch {
      map.set(entry.name, null) // 目录存在但无 SKILL.md
    }
  }
  return map
}

/** 落盘一条 plan 的写面（ctx 驱动层；skip 返回 false）。 */
export async function applySkillPlan(fsLike, plan) {
  if (plan.action === 'skip') return false
  const target = await fsLike.resolve(plan.target)
  await fsLike.writeText(target, `${skillFrontmatter(plan.renamed ? { ...plan.candidate, name: plan.name } : plan.candidate)}${plan.renamed ? plan.candidate.body : plan.candidate.body}`)
  return true
}

/**
 * REQ-59/61/64 入口：收集 pi/opencode/Claude/Codex 候选 → 规划 → （preview 时）只返回 plan /
 * （apply 时）落盘。
 * @param {object} ctx host ctx（fs 服务）
 * @param {object} args { piRoot?, opencodeRoot?, claudeRoot?, claudeProjectRoot?, codexRoot?, agentsHome?, apply?, preview? }
 * @returns {object} { total, planned, applied, skipped, results: [{name, source, kind, action, reason?, target?}] }
 */
export async function runAgentsImport(ctx, args = {}) {
  const piRoot = args.piRoot || defaultPiRoot()
  const opencodeRoot = args.opencodeRoot || opencodeConfigRoot()
  const claudeRoot = args.claudeRoot || defaultClaudeRoot()
  const claudeProjectRoot = args.claudeProjectRoot
  const codexRoot = args.codexRoot || defaultCodexRoot()
  const skillsRoot = join(args.agentsHome || resolveAgentsHome(), 'skills')
  const fsLike = ctx.fs
  const candidates = await collectAgents(fsLike, { piRoot, opencodeRoot })
  candidates.push(...await collectClaudeCandidates(fsLike, { claudeRoot, claudeProjectRoot }))
  candidates.push(...await collectCodexCandidates(fsLike, { codexRoot }))
  const existing = await existingBundles(fsLike, skillsRoot)
  const plans = planSkillWrites({ skillsRoot, existing }, candidates)
  const results = []
  let applied = 0
  let skipped = 0
  const doApply = args.apply === true && args.preview !== true
  for (const plan of plans) {
    if (plan.action === 'skip') {
      skipped++
      results.push({ name: plan.name, source: plan.candidate.source, kind: plan.candidate.kind, action: 'skip', reason: plan.reason })
      continue
    }
    if (doApply) {
      await applySkillPlan(fsLike, plan)
      applied++
    }
    results.push({ name: plan.name, source: plan.candidate.source, kind: plan.candidate.kind, action: plan.action, target: plan.target })
  }
  return { total: candidates.length, planned: plans.length, applied, skipped, results }
}
