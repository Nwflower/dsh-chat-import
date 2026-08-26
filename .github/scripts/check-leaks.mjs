// .github/scripts/check-leaks.mjs — 提交泄漏扫描（本地 pre-commit + CI 兜底）
//
// 背景：dev/ 虽被 gitignore，但「内容级泄漏」——内部项目名 / 绝对路径 / 凭据写进会发布的
// 文件正文（如 docs/*.md 里引用内部项目路径）——gitignore 挡不住。本脚本做内容级扫描，分两层：
//   1. 通用规则（本文件内置，可安全提交）：凭据模式（GitHub PAT / AWS key / PEM 私钥）、
//      staged 路径命中 dev/（git add -f 误入库）。
//   2. 内部项目名黑名单：从 dev/leak-blocklist.txt（gitignore 本地文件）读取——黑名单本身
//      绝不入库（入库即把内部项目存在性泄露到公开仓库）。CI 无此文件 → 自动跳过本层。
//
// 用法：
//   node .github/scripts/check-leaks.mjs          # 扫仓库全部源文件（CI / 手动全量）
//   node .github/scripts/check-leaks.mjs --staged # 扫 git staged（本地 pre-commit）
//
// 确定性、零运行时依赖；违反即 exit 1。

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const staged = process.argv.includes('--staged')

// ── 待扫描文件集 ────────────────────────────────────────────────────────────
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dev', '.dsh-file-claim'])
const SOURCE_RE = /\.(mjs|js|cjs|json|md|yml|yaml|ts|txt|sh)$/

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function walkDir(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walkDir(full, out)
    else if (SOURCE_RE.test(name)) out.push(relative(root, full))
  }
}

function targetFiles() {
  if (staged) {
    return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
      .trim().split(/\r?\n/).filter(Boolean)
  }
  const out = []
  walkDir(root, out)
  return out
}

// ── 规则 ─────────────────────────────────────────────────────────────────────
// 通用凭据模式（公开已知格式，非项目特定，可安全提交）
const CRED_PATTERNS = [
  [/ghp_[A-Za-z0-9]{36}/, 'GitHub classic PAT (ghp_*)'],
  [/github_pat_[A-Za-z0-9_]{22,}/, 'GitHub fine-grained PAT (github_pat_*)'],
  [/gho_[A-Za-z0-9]{36}/, 'GitHub OAuth token (gho_*)'],
  [/ghu_[A-Za-z0-9]{36}/, 'GitHub user-to-server token (ghu_*)'],
  [/ghs_[A-Za-z0-9]{36}/, 'GitHub server-to-server token (ghs_*)'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key id (AKIA*)'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'PEM private key'],
]

// 内部项目名黑名单（本地，gitignore；CI 无此文件则跳过本层）
const BLOCKLIST_FILE = join(root, 'dev', 'leak-blocklist.txt')
const blocklist = (() => {
  if (!existsSync(BLOCKLIST_FILE)) return []
  return readFileSync(BLOCKLIST_FILE, 'utf8').split(/\r?\n/)
    .map((l) => l.split('#')[0].trim())
    .filter(Boolean)
})()

const problems = []
const files = targetFiles()

for (const file of files) {
  // 规则 1：dev/ 绝不入库（git add -f 误 stage）
  if (file === 'dev' || file.startsWith('dev/')) {
    problems.push(`${file}: dev/ 本地工程文件被 stage（gitignore 失效或被 -f 强制）——dev/ 绝不入库`)
    continue
  }
  let src
  try {
    src = readFileSync(join(root, file), 'utf8')
  } catch {
    continue // 二进制 / 已删除：跳过
  }
  const lines = src.split(/\r?\n/)
  for (const [re, label] of CRED_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) problems.push(`${file}:${i + 1}: 疑似凭据 ${label}`)
    }
  }
  for (const name of blocklist) {
    const needle = name.toLowerCase()
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) problems.push(`${file}:${i + 1}: 命中内部项目名黑名单「${name}」——内部参照只许在 dev/`)
    }
  }
}

if (problems.length > 0) {
  console.error(`check-leaks: FAIL — ${problems.length} 处泄漏/敏感内容：`)
  for (const p of problems) console.error('  - ' + p)
  console.error('内部参照移到 dev/；真实凭据立即轮换。')
  process.exit(1)
}
const note = blocklist.length ? `黑名单 ${blocklist.length} 条` : '黑名单未加载（CI，跳过内部名检查）'
console.log(`check-leaks: OK — 扫描 ${files.length} 文件，${note}`)
