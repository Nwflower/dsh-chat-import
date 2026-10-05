// .github/scripts/build-check.mjs — 零构建包的「build」：发布面自检
//
// 本包纯 ESM、无编译步骤，plugin_check 仍要求 scripts.build / prepack。
// 这里把它实现为发布面完整性校验（诚实语义）：files 白名单逐项存在 +
// 所有发布的 .mjs/.js 通过 node --check 语法校验 + lockfile 根版本与
// package.json 一致。任何一项失败 exit 1，prepack 随即中止发布。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const jsFiles = []
const collectJs = (dir) => {
  for (const entry of readdirSafe(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) collectJs(full)
    else if (/\.(mjs|js|cjs)$/.test(entry)) jsFiles.push(full)
  }
}
const readdirSafe = (dir) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

// npm files 支持通配（单层 '*'，如 lib/*.mjs）；existsSync 无法直接校验通配条目，
// 这里把含 '*' 的条目展开为实际文件再校验（与 npm pack 的匹配语义一致）。
const expandEntry = (entry) => {
  if (!entry.includes('*')) return existsSync(join(root, entry)) ? [entry] : []
  const starIdx = entry.indexOf('*')
  const dirPart = entry.slice(0, starIdx)
  const pattern = entry.slice(starIdx)
  const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
  return readdirSafe(join(root, dirPart))
    .filter((name) => re.test(name))
    .map((name) => dirPart + name)
}

const missing = []
for (const entry of pkg.files || []) {
  const expanded = expandEntry(entry)
  if (expanded.length === 0) {
    missing.push(entry)
    continue
  }
  for (const real of expanded) {
    const full = join(root, real)
    if (statSync(full).isDirectory()) collectJs(full)
    else if (/\.(mjs|js|cjs)$/.test(real)) jsFiles.push(full)
  }
}

// 可达性：从发布入口（main / exports / bin）沿静态相对 import / export-from / 字面量
// 动态 import 走遍模块图，每个可达模块都必须在 files 白名单展开出的发布集合里——
// 新建子目录（如 lib/tools/）忘记登记时，npm pack 会静默漏发，安装后 import 即崩。
const shipped = new Set(jsFiles.map((f) => resolve(f)))
const entryPoints = [
  pkg.main,
  ...Object.values(pkg.exports || {}).flatMap((v) => (typeof v === 'string' ? [v] : Object.values(v || {}))),
  ...Object.values(pkg.bin || {}),
].filter((p) => typeof p === 'string' && /\.(mjs|js|cjs)$/.test(p))
const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s[^'"`]*?\sfrom\s*['"](\.{1,2}\/[^'"]+)['"]|(?:^|[\s;])import\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g
const unshipped = new Set()
const seen = new Set()
const stack = entryPoints.map((p) => resolve(root, p))
while (stack.length > 0) {
  const file = stack.pop()
  if (seen.has(file)) continue
  seen.add(file)
  if (!shipped.has(file)) unshipped.add(relative(root, file))
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    // 入口或依赖文件不存在：同样算「不可发布」，上面已记入 unshipped
    continue
  }
  for (const m of text.matchAll(IMPORT_RE)) stack.push(resolve(dirname(file), m[1] || m[2] || m[3]))
}

const syntaxErrors = []
for (const file of jsFiles) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (res.status !== 0) syntaxErrors.push(relative(root, file) + ': ' + (res.stderr || '').trim())
}

const lockOk = (() => {
  try {
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
    return lock.version === pkg.version
  } catch {
    return false
  }
})()

const failed = missing.length > 0 || unshipped.size > 0 || syntaxErrors.length > 0 || !lockOk
console.log('build-check: files=' + (pkg.files || []).length + ' js=' + jsFiles.length
  + ' reachable=' + seen.size + ' unshipped=' + unshipped.size
  + ' syntax-errors=' + syntaxErrors.length + ' lockfile-version-ok=' + lockOk)
if (missing.length) console.log('  missing from files whitelist: ' + missing.join(', '))
if (unshipped.size) console.log('  reachable from entry points but not in files: ' + [...unshipped].sort().join(', '))
for (const err of syntaxErrors) console.log('  ' + err)
if (failed) {
  console.error('build-check: FAILED — 发布面不完整（白名单缺项 / 可达模块未发布）、语法错误或 lockfile 与 package.json 版本不一致')
  process.exit(1)
}
console.log('build-check: OK')
