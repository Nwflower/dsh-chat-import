// agents.test.mjs — REQ-59 外部 agent/mode prompt → DSH skills 资产
// 纯函数单测（parseFrontmatter / collectCandidates / planSkillWrites / resolveAgentsHome）
// + 集成测试（runAgentsImport 走真实临时目录，mkdtemp——最接近真实 fs 服务，且
// 避免 mock 树与 node:path 运算的跨平台分隔符差异）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseFrontmatter, yamlScalar, collectCandidates, planSkillWrites, skillFrontmatter,
  resolveAgentsHome, runAgentsImport,
} from '../lib/agents.mjs'
import { makeFs } from './_support/fake-host.mjs'

// ── 纯函数：parseFrontmatter ────────────────────────────────────────────────

test('parseFrontmatter: 标准 frontmatter + body', () => {
  const p = parseFrontmatter('---\nname: my-agent\ndescription: does things\n---\nbody text')
  assert.equal(p.frontmatter.name, 'my-agent')
  assert.equal(p.frontmatter.description, 'does things')
  assert.equal(p.body, 'body text')
})

test('parseFrontmatter: 嵌套 YAML 保留（permission: edit: deny）', () => {
  const p = parseFrontmatter('---\nname: a\npermission:\n  edit: deny\n  read: allow\n---\nbody')
  assert.equal(p.frontmatter.name, 'a')
  assert.ok(p.frontmatter.permission.includes('edit: deny'))
  assert.ok(p.frontmatter.permission.includes('read: allow'))
})

test('parseFrontmatter: 无 frontmatter 返回 null', () => {
  assert.equal(parseFrontmatter('plain text'), null)
})

// 全套 frontmatter 形态（借鉴 sjh9714/dsh-movein 的 skill-vanish 形态清单，MIT）：
// 未引号 / 单双引号 / block scalar / 冒号后无空格。迁移后 description 不应把
// 引号字符或 block 标记带进值——否则 DSH 完整 YAML 解析会静默丢弃技能（#1401）。
test('parseFrontmatter: 全套 YAML 标量形态解析正确', () => {
  const cases = [
    ['未引号+冒号空格', 'Priority order: check the cache first', 'Priority order: check the cache first'],
    ['单引号', "'Priority: check cache'", 'Priority: check cache'],
    ['双引号', '"Priority: check cache"', 'Priority: check cache'],
    ['冒号后无空格', '10:30', '10:30'],
    ['单引号内转义', "'it''s-a-server'", "it's-a-server"],
  ]
  for (const [label, input, expected] of cases) {
    const p = parseFrontmatter(`---\nname: s\ndescription: ${input}\n---\nbody`)
    assert.equal(p.frontmatter.description, expected, label)
  }
})

test('parseFrontmatter: block scalar 折叠（>）与保留换行（|）', () => {
  const folded = parseFrontmatter('---\nname: s\ndescription: >-\n  Priority order:\n  check the cache first\n---\nbody')
  assert.equal(folded.frontmatter.description, 'Priority order: check the cache first')
  const literal = parseFrontmatter('---\nname: s\ndescription: |-\n  line one\n  line two\n---\nbody')
  assert.equal(literal.frontmatter.description, 'line one\nline two')
})

test('yamlScalar: 引号去壳与转义还原', () => {
  assert.equal(yamlScalar("'a: b'"), 'a: b')
  assert.equal(yamlScalar('"a: b"'), 'a: b')
  assert.equal(yamlScalar('plain'), 'plain')
  assert.equal(yamlScalar("'it''s'"), "it's")
})

// ── 纯函数：collectCandidates ───────────────────────────────────────────────

test('collectCandidates: 收集 + name 兜底 + kind:dsh 过滤', () => {
  const files = [
    { file: '/x/agents/helper.md', text: '---\nname: Helper\n---\nbody' },
    { file: '/x/agents/no-name.md', text: 'no frontmatter' },
    { file: '/x/agents/already-dsh.md', text: '---\nname: Skip\nkind: dsh\n---\nbody' },
    { file: '/x/agents/already-skill.md', text: '---\nname: Skip2\nkind: skill\n---\nbody' },
  ]
  const out = collectCandidates(files, { source: 'pi', kind: 'agent' })
  assert.equal(out.length, 2)
  assert.equal(out[0].name, 'Helper')
  assert.equal(out[1].name, 'no-name') // 无 frontmatter → 文件名 stem 兜底
  assert.ok(out.every((c) => c.source === 'pi' && c.kind === 'agent'))
})

test('collectCandidates: nameFrom 覆盖（pi prompt 前缀）', () => {
  const files = [{ file: '/x/prompts/refactor.md', text: '---\ndescription: refactor mode\n---\nbody' }]
  const out = collectCandidates(files, { source: 'pi', kind: 'prompt', nameFrom: (f) => 'pi-prompt-' + f.slice(0, -3).split(/[\\/]/).pop() })
  assert.equal(out.length, 1)
  assert.equal(out[0].name, 'pi-prompt-refactor')
})

// ── 纯函数：skillFrontmatter（issue #13：description 含 `: ` 时 YAML 转义）──

test('skillFrontmatter: description 含冒号空格时单引号转义，避免 DSH 静默丢弃', () => {
  const out = skillFrontmatter({ name: 'deploy', source: 'claude', kind: 'skill', description: 'Deploy: production helper (use when: releasing)', body: 'x', extraFrontmatter: {} })
  assert.ok(out.includes("description: 'Deploy: production helper (use when: releasing)'"))
  // 单引号本身也要转义（YAML 单引号标量 '' = 字面单引号）
  const withQuote = skillFrontmatter({ name: 'q', source: 'pi', kind: 'agent', description: "It's: tricky", body: 'x', extraFrontmatter: {} })
  assert.ok(withQuote.includes("description: 'It''s: tricky'"))
})

test('skillFrontmatter: 缺省 description（Imported from ...）同样转义', () => {
  const out = skillFrontmatter({ name: 'a', source: 'pi', kind: 'agent', description: '', body: 'x', extraFrontmatter: {} })
  assert.ok(out.includes("description: 'Imported from pi (agent: a)'"))
})

// ── 纯函数：planSkillWrites ────────────────────────────────────────────────

test('planSkillWrites: 全新 bundle → write', () => {
  const root = join('agents', 'skills')
  const candidates = [{ name: 'a', source: 'pi', kind: 'agent', description: '', body: 'x' }]
  const plans = planSkillWrites({ skillsRoot: root, existing: new Map() }, candidates)
  assert.equal(plans.length, 1)
  assert.equal(plans[0].action, 'write')
  assert.equal(plans[0].target, join(root, 'a', 'SKILL.md'))
})

test('planSkillWrites: 内容相同 → skip（幂等）', () => {
  const candidates = [{ name: 'a', source: 'pi', kind: 'agent', description: '', body: 'x' }]
  const content = skillFrontmatter(candidates[0]) + 'x'
  const existing = new Map([['a', { content }]])
  const plans = planSkillWrites({ skillsRoot: join('agents', 'skills'), existing }, candidates)
  assert.equal(plans.length, 1)
  assert.equal(plans[0].action, 'skip')
  assert.equal(plans[0].reason, 'identical content')
})

test('planSkillWrites: 同名跨源冲突 → -source 后缀消歧', () => {
  const candidates = [
    { name: 'shared', source: 'pi', kind: 'agent', description: '', body: 'pi body' },
    { name: 'shared', source: 'opencode', kind: 'agent', description: '', body: 'oc body' },
  ]
  const plans = planSkillWrites({ skillsRoot: '/s', existing: new Map() }, candidates)
  assert.equal(plans.length, 2)
  assert.equal(plans[0].action, 'write')
  assert.equal(plans[0].name, 'shared')
  assert.equal(plans[1].action, 'write')
  assert.equal(plans[1].name, 'shared-opencode')
  assert.equal(plans[1].renamed, true)
})

test('planSkillWrites: 后缀也被占 → skip', () => {
  const candidates = [
    { name: 'shared', source: 'pi', kind: 'agent', description: '', body: 'pi body' },
    { name: 'shared', source: 'opencode', kind: 'agent', description: '', body: 'oc body' },
    { name: 'shared', source: 'opencode', kind: 'skill', description: '', body: 'oc2 body' },
  ]
  const plans = planSkillWrites({ skillsRoot: '/s', existing: new Map() }, candidates)
  assert.equal(plans.length, 3)
  const third = plans[2]
  assert.equal(third.action, 'skip')
  assert.ok(third.reason.includes('conflict'))
})

test('planSkillWrites: 既有 bundle 不同内容 → 后缀消歧；目录缺 SKILL.md → complete', () => {
  const root = join('agents', 'skills')
  // bundle 'a' 已存在不同内容
  const candidates = [{ name: 'a', source: 'pi', kind: 'agent', description: '', body: 'new' }]
  const existing = new Map([['a', { content: 'old content' }]])
  const plans = planSkillWrites({ skillsRoot: root, existing }, candidates)
  assert.equal(plans.length, 1)
  assert.equal(plans[0].action, 'write')
  assert.equal(plans[0].name, 'a-pi')
  assert.equal(plans[0].target, join(root, 'a-pi', 'SKILL.md'))

  // bundle 'b' 目录存在但无 SKILL.md（如 kimi-vision 保留 scripts/）
  const candidates2 = [{ name: 'b', source: 'opencode', kind: 'skill', description: '', body: 'b2' }]
  const existing2 = new Map([['b', null]])
  const plans2 = planSkillWrites({ skillsRoot: root, existing: existing2 }, candidates2)
  assert.equal(plans2.length, 1)
  assert.equal(plans2[0].action, 'complete')
  assert.equal(plans2[0].target, join(root, 'b', 'SKILL.md'))
})

// ── 纯函数：resolveAgentsHome ───────────────────────────────────────────────

test('resolveAgentsHome: $DSH_AGENTS_HOME 优先，缺省 ~/.agents', () => {
  assert.equal(resolveAgentsHome({ DSH_AGENTS_HOME: '/custom/agents' }), '/custom/agents')
  const home = resolveAgentsHome({})
  assert.ok(home.endsWith('.agents'))
})

// ── 集成：runAgentsImport（真实临时目录）────────────────────────────────────

// 真实 fs 适配层：lib/agents.mjs 需要的 resolve/stat/readText/listDir/writeText 接到 node:fs 上
// （共享 fake host 的 fs 契约，读写真实临时目录，产物直接到磁盘上验收）。
const realFs = () => makeFs({}, { real: true, writeThrough: true })

test('REQ-59 runAgentsImport: dry-run 预览零副作用 + apply 落盘 + provenance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-'))
  const piRoot = join(root, 'pi-agent')
  const ocRoot = join(root, 'opencode')
  const agentsHome = join(root, 'agents-home')
  mkdirSync(join(piRoot, 'agents'), { recursive: true })
  mkdirSync(join(piRoot, 'prompts'), { recursive: true })
  mkdirSync(join(ocRoot, 'agents'), { recursive: true })
  mkdirSync(join(ocRoot, 'skill'), { recursive: true })
  writeFileSync(join(piRoot, 'agents', 'reviewer.md'),
    '---\nname: reviewer\ndescription: review agent\npermission:\n  edit: deny\n---\nreview body')
  writeFileSync(join(piRoot, 'prompts', 'refactor.md'), '---\ndescription: refactor\n---\nrefactor body')
  writeFileSync(join(ocRoot, 'skill', 'search.md'), '---\ndescription: search skill\n---\nsearch body')

  const fsLike = realFs()
  const ctx = { fs: fsLike }

  // 1) dry-run：plan 返回但零写盘
  const dry = await runAgentsImport(ctx, { piRoot, opencodeRoot: ocRoot, codexRoot: join(root, 'codex'), claudeRoot: join(root, 'no-claude'), agentsHome })
  assert.equal(dry.total, 3)
  assert.equal(dry.planned, 3)
  assert.equal(dry.applied, 0)
  assert.equal(dry.skipped, 0)
  const actions = dry.results.map((r) => r.action)
  assert.deepEqual(actions.sort(), ['write', 'write', 'write'])
  assert.ok(!existsSync(join(agentsHome, 'skills')))

  // 2) apply：落盘 + frontmatter provenance
  const applied = await runAgentsImport(ctx, { piRoot, opencodeRoot: ocRoot, codexRoot: join(root, 'codex'), claudeRoot: join(root, 'no-claude'), agentsHome, apply: true })
  assert.equal(applied.applied, 3)
  const skillsRoot = join(agentsHome, 'skills')
  assert.ok(existsSync(join(skillsRoot, 'reviewer', 'SKILL.md')))
  assert.ok(existsSync(join(skillsRoot, 'pi-prompt-refactor', 'SKILL.md')))
  assert.ok(existsSync(join(skillsRoot, 'search', 'SKILL.md')))
  const reviewerSkill = readFileSync(join(skillsRoot, 'reviewer', 'SKILL.md'), 'utf8')
  assert.ok(reviewerSkill.includes('metadata:'))
  assert.ok(reviewerSkill.includes('source: pi'))
  assert.ok(reviewerSkill.includes('kind: agent'))
  assert.ok(reviewerSkill.includes('permission:')) // 嵌套 YAML 保留
  assert.ok(reviewerSkill.includes('review body'))

  // 3) 幂等：内容未变 → 全部 skip
  const again = await runAgentsImport(ctx, { piRoot, opencodeRoot: ocRoot, codexRoot: join(root, 'codex'), claudeRoot: join(root, 'no-claude'), agentsHome, apply: true })
  assert.equal(again.planned, 3)
  assert.equal(again.applied, 0)
  assert.equal(again.skipped, 3)
  assert.ok(again.results.every((r) => r.reason === 'identical content'))
})

test('REQ-59 runAgentsImport: kind:dsh 源过滤 + 缺目录静默空清单', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-'))
  const piRoot = join(root, 'pi-agent')
  const ocRoot = join(root, 'opencode')
  const agentsHome = join(root, 'agents-home')
  mkdirSync(join(piRoot, 'agents'), { recursive: true })
  writeFileSync(join(piRoot, 'agents', 'native.md'), '---\nname: native\nkind: dsh\n---\nbody')

  const ctx = { fs: realFs() }
  // 源带 kind:dsh → 0 候选；缺 opencode 目录 → 静默空
  //（claudeRoot 必须显式指向不存在的目录：缺省会读真实 ~/.claude，测试随机器环境漂移）
  const r1 = await runAgentsImport(ctx, { piRoot, opencodeRoot: ocRoot, codexRoot: join(root, 'codex'), claudeRoot: join(root, 'no-claude'), agentsHome })
  assert.equal(r1.total, 0)
  assert.equal(r1.planned, 0)

  // 全缺目录 → 空清单不报错
  const r2 = await runAgentsImport(ctx, { piRoot: join(root, 'missing-pi'), opencodeRoot: join(root, 'missing-oc'), codexRoot: join(root, 'missing-codex'), claudeRoot: join(root, 'no-claude'), agentsHome })
  assert.equal(r2.total, 0)
  assert.equal(r2.planned, 0)
})

test('REQ-59 runAgentsImport: 同名跨源冲突落盘为 -source 后缀', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-'))
  const piRoot = join(root, 'pi-agent')
  const ocRoot = join(root, 'opencode')
  const agentsHome = join(root, 'agents-home')
  mkdirSync(join(piRoot, 'agents'), { recursive: true })
  mkdirSync(join(ocRoot, 'agents'), { recursive: true })
  writeFileSync(join(piRoot, 'agents', 'shared.md'), '---\nname: shared\n---\npi body')
  writeFileSync(join(ocRoot, 'agents', 'shared.md'), '---\nname: shared\n---\noc body')

  const ctx = { fs: realFs() }
  const r = await runAgentsImport(ctx, { piRoot, opencodeRoot: ocRoot, codexRoot: join(root, 'codex'), claudeRoot: join(root, 'no-claude'), agentsHome, apply: true })
  assert.equal(r.applied, 2)
  const skillsRoot = join(agentsHome, 'skills')
  assert.ok(existsSync(join(skillsRoot, 'shared', 'SKILL.md')))
  assert.ok(existsSync(join(skillsRoot, 'shared-opencode', 'SKILL.md')))
})

// ── REQ-61：Claude 资产（memory 分组 / skills bundle / 项目 CLAUDE.md）──────

test('REQ-61 runAgentsImport: Claude memory/skills/CLAUDE.md 落盘 + provenance + 幂等', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-'))
  const claudeRoot = join(root, 'claude')
  const projectRoot = join(root, 'proj')
  const agentsHome = join(root, 'agents-home')
  mkdirSync(join(claudeRoot, 'memory', 'project'), { recursive: true })
  mkdirSync(join(claudeRoot, 'memory', 'feedback'), { recursive: true })
  mkdirSync(join(claudeRoot, 'skills', 'my-skill'), { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  writeFileSync(join(claudeRoot, 'memory', 'project', 'api.md'), '---\ndescription: project api notes\n---\napi body')
  writeFileSync(join(claudeRoot, 'memory', 'feedback', 'prefer-x.md'), 'prefer x body')
  writeFileSync(join(claudeRoot, 'skills', 'my-skill', 'SKILL.md'), '---\nname: My Skill\ndescription: does things\n---\nskill body')
  writeFileSync(join(projectRoot, 'CLAUDE.md'), '# CLAUDE.md\nproject instructions')

  const ctx = { fs: realFs() }
  // 1) dry-run：4 个候选（2 memory + 1 skill + 1 CLAUDE.md），零写盘
  const dry = await runAgentsImport(ctx, { piRoot: join(root, 'no-pi'), opencodeRoot: join(root, 'no-oc'), codexRoot: join(root, 'no-codex'), claudeRoot, claudeProjectRoot: projectRoot, agentsHome })
  assert.equal(dry.total, 4)
  assert.equal(dry.planned, 4)
  assert.equal(dry.applied, 0)
  const names = dry.results.map((r) => r.name).sort()
  assert.deepEqual(names, ['My Skill', 'claude-md', 'feedback-prefer-x', 'project-api'].sort())
  assert.ok(!existsSync(join(agentsHome, 'skills')))

  // 2) apply：落盘 + provenance（source: claude）
  const applied = await runAgentsImport(ctx, { piRoot: join(root, 'no-pi'), opencodeRoot: join(root, 'no-oc'), codexRoot: join(root, 'no-codex'), claudeRoot, claudeProjectRoot: projectRoot, agentsHome, apply: true })
  assert.equal(applied.applied, 4)
  const skillsRoot = join(agentsHome, 'skills')
  const projectSkill = readFileSync(join(skillsRoot, 'project-api', 'SKILL.md'), 'utf8')
  assert.ok(projectSkill.includes('source: claude'))
  assert.ok(projectSkill.includes('kind: memory'))
  assert.ok(projectSkill.includes('api body'))
  const claudeMd = readFileSync(join(skillsRoot, 'claude-md', 'SKILL.md'), 'utf8')
  assert.ok(claudeMd.includes('kind: project'))
  assert.ok(claudeMd.includes('project instructions'))

  // 3) 幂等：内容未变 → 全部 skip
  const again = await runAgentsImport(ctx, { piRoot: join(root, 'no-pi'), opencodeRoot: join(root, 'no-oc'), codexRoot: join(root, 'no-codex'), claudeRoot, claudeProjectRoot: projectRoot, agentsHome, apply: true })
  assert.equal(again.planned, 4)
  assert.equal(again.applied, 0)
  assert.equal(again.skipped, 4)
})

test('REQ-61: Claude 源带 kind:skill frontmatter 过滤 + 缺目录静默空清单', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-'))
  const claudeRoot = join(root, 'claude')
  const agentsHome = join(root, 'agents-home')
  mkdirSync(join(claudeRoot, 'skills', 'native-skill'), { recursive: true })
  writeFileSync(join(claudeRoot, 'skills', 'native-skill', 'SKILL.md'), '---\nname: native\nkind: skill\n---\nbody')
  const ctx = { fs: realFs() }
  // 已是 DSH 技能（kind:skill）→ 0 候选
  const r = await runAgentsImport(ctx, { piRoot: join(root, 'no-pi'), opencodeRoot: join(root, 'no-oc'), codexRoot: join(root, 'no-codex'), claudeRoot, agentsHome })
  assert.equal(r.total, 0)
  // 缺 Claude 目录 → 静默空清单不报错
  const r2 = await runAgentsImport(ctx, { piRoot: join(root, 'no-pi'), opencodeRoot: join(root, 'no-oc'), codexRoot: join(root, 'no-codex'), claudeRoot: join(root, 'no-claude'), agentsHome })
  assert.equal(r2.total, 0)
})

// ── Codex 资产（skills / instructions.md / AGENTS.md / config.toml）────

test('runAgentsImport: Codex skills/instructions/AGENTS/config 落盘 + provenance + 幂等', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-'))
  const codexRoot = join(root, 'codex')
  const agentsHome = join(root, 'agents-home')
  mkdirSync(join(codexRoot, 'skills', 'codex-search'), { recursive: true })
  writeFileSync(join(codexRoot, 'skills', 'codex-search', 'SKILL.md'), '---\nname: Codex Search\ndescription: codex search skill\n---\nsearch body')
  writeFileSync(join(codexRoot, 'instructions.md'), '# Instructions\nfollow these')
  writeFileSync(join(codexRoot, 'AGENTS.md'), '# Codex AGENTS\nagents body')
  writeFileSync(join(codexRoot, 'config.toml'), 'model = "gpt-5"\n[extra]\nkey = "value"')

  const ctx = { fs: realFs() }
  // 1) dry-run：4 个候选，零写盘
  const dry = await runAgentsImport(ctx, {
    piRoot: join(root, 'no-pi'), opencodeRoot: join(root, 'no-oc'),
    claudeRoot: join(root, 'no-claude'), codexRoot,
    agentsHome,
  })
  assert.equal(dry.total, 4)
  assert.equal(dry.planned, 4)
  assert.equal(dry.applied, 0)
  const names = dry.results.map((r) => r.name).sort()
  assert.deepEqual(names, ['Codex Search', 'codex-agents', 'codex-config', 'codex-instructions'].sort())
  assert.ok(!existsSync(join(agentsHome, 'skills')))

  // 2) apply：落盘 + provenance（source: codex）
  const applied = await runAgentsImport(ctx, {
    piRoot: join(root, 'no-pi'), opencodeRoot: join(root, 'no-oc'),
    claudeRoot: join(root, 'no-claude'), codexRoot,
    agentsHome, apply: true,
  })
  assert.equal(applied.applied, 4)
  const skillsRoot = join(agentsHome, 'skills')
  const configSkill = readFileSync(join(skillsRoot, 'codex-config', 'SKILL.md'), 'utf8')
  assert.ok(configSkill.includes('source: codex'))
  assert.ok(configSkill.includes('kind: config'))
  assert.ok(configSkill.includes('model = "gpt-5"'))
  const instructionsSkill = readFileSync(join(skillsRoot, 'codex-instructions', 'SKILL.md'), 'utf8')
  assert.ok(instructionsSkill.includes('kind: instruction'))
  assert.ok(instructionsSkill.includes('follow these'))

  // 3) 幂等：内容未变 → 全部 skip
  const again = await runAgentsImport(ctx, {
    piRoot: join(root, 'no-pi'), opencodeRoot: join(root, 'no-oc'),
    claudeRoot: join(root, 'no-claude'), codexRoot,
    agentsHome, apply: true,
  })
  assert.equal(again.planned, 4)
  assert.equal(again.applied, 0)
  assert.equal(again.skipped, 4)
})
