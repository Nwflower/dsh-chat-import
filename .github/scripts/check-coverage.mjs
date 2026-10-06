// .github/scripts/check-coverage.mjs — 覆盖率结构护栏（读 npm run coverage 的输出）
//
// 为什么需要：全局 line 95% 会盖住单文件的空洞 —— 实测 lib/ignore-command.mjs（/ignore 与
// /unignore 命令）只有 18.6% 行覆盖，而 1403 个用例、95% 全局数字都照常绿。本脚本从覆盖率
// 报告的树状行里解析每个文件的 line/branch，另加两类检查：
//   1. 每个 lib 文件的行覆盖 ≥ FILE_MIN（与全局下限同口径）；
//   2. 每个 lib 子目录的「逐文件行覆盖均值」≥ 该目录下限（防新目录整体偏薄）。
// 另外确认没有失败用例：本脚本要接在管道后面，不能让 runner 的失败被管道吞掉。
//
// 用法：node --test --experimental-test-coverage --test-coverage-lines=75 "test/*.test.mjs" \
//         | node .github/scripts/check-coverage.mjs
//      （本地排查可传 --file=dev/_cov.txt 读文件）
import { readFileSync } from 'node:fs'

const FILE_MIN = 75
// 逐文件行覆盖下限（当前实测值向下取整，作为不许回退的棘轮）
const DIR_MIN = {
  'lib': 90, // 顶层文件（含 command / purge / ignore / settings 等功能面）
  'lib/convert': 95,
  'lib/discovery': 93,
  'lib/export': 95,
  'lib/sources': 92,
  'lib/tools': 94,
}
// 已知空洞：显式记账，补完测试必须删条目（条目若已达标会被判陈旧）
const KNOWN_GAPS = new Map([
  ['lib/ignore-command.mjs', '18.6%：/ignore、/unignore、/ignores 三个命令没有用例（待补）'],
])

const fileArg = process.argv.find((a) => a.startsWith('--file='))
const text = fileArg ? readFileSync(fileArg.slice('--file='.length), 'utf8') : readFileSync(0, 'utf8')
const lines = text.split('\n')

// ── 1. 失败用例不许被管道吞掉 ────────────────────────────────────────────────
const failLine = lines.find((l) => /^\u2139\s+fail\s+\d+/.test(l.replace(/\r/g, '')))
const failed = failLine ? Number(/\d+/.exec(failLine)[0]) : 0
const problems = []
if (failed > 0) problems.push(`有 ${failed} 个失败用例（本脚本接在管道后，必须显式检查）`)

// ── 2. 解析树状覆盖率（目录行无数字、文件行有数字，缩进即层级）────────────────
const stack = []
const files = []
let globalLine = null
for (const raw of lines) {
  const l = raw.replace(/\r/g, '')
  if (/^\u2139\s+all files\s*\|/.test(l)) {
    globalLine = Number(/\|\s*([\d.]+)\s*\|/.exec(l)[1])
    continue
  }
  const m = /^\u2139(\s+)(\S.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|/.exec(l)
  if (!m) continue
  const indent = m[1].length
  const name = m[2].trim()
  const nums = [m[3], m[4]].map((s) => (s === '' ? null : Number(s)))
  const level = indent - 1
  if (nums[0] === null) {
    stack[level] = name
    stack.length = level + 1
    continue
  }
  const dir = stack.slice(0, level).join('/')
  files.push({ path: (dir ? dir + '/' : '') + name, line: nums[0], branch: nums[1] })
}

if (globalLine !== null && globalLine < 75) problems.push(`全局行覆盖 ${globalLine}% 低于下限 75%`)

// ── 3. 逐文件下限 + 棘轮 ────────────────────────────────────────────────────
const libFiles = files.filter((f) => f.path.startsWith('lib/'))
for (const f of libFiles) {
  if (f.line >= FILE_MIN) continue
  if (KNOWN_GAPS.has(f.path)) continue
  problems.push(`${f.path}: 行覆盖 ${f.line}% 低于 ${FILE_MIN}%（全局数字会盖住这种单文件空洞）`)
}
for (const [path, why] of KNOWN_GAPS) {
  const f = libFiles.find((x) => x.path === path)
  if (!f) problems.push(`${path}: 记账里的文件不存在了，请从 KNOWN_GAPS 删掉`)
  else if (f.line >= FILE_MIN) problems.push(`${path}: 行覆盖已升到 ${f.line}%（≥${FILE_MIN}%），请从 KNOWN_GAPS 删掉这条记账（原记录：${why}）`)
}

// ── 4. 逐目录均值下限 ──────────────────────────────────────────────────────
const byDir = new Map()
for (const f of libFiles) {
  const dir = f.path.split('/').slice(0, -1).join('/') || 'lib'
  if (!byDir.has(dir)) byDir.set(dir, [])
  byDir.get(dir).push(f)
}
for (const [dir, min] of Object.entries(DIR_MIN)) {
  const list = byDir.get(dir)
  if (!list || list.length === 0) { problems.push(`${dir}: 目录下限有记账但目录下没有文件`); continue }
  const avg = list.reduce((s, x) => s + x.line, 0) / list.length
  if (avg < min) {
    const worst = [...list].sort((a, b) => a.line - b.line).slice(0, 3).map((x) => `${x.path} ${x.line}%`).join('、')
    problems.push(`${dir}: 行覆盖均值 ${avg.toFixed(1)}% 低于 ${min}%（最低三个：${worst}）`)
  }
}

if (problems.length > 0) {
  console.error('check-coverage: FAIL — 覆盖率结构：')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
const avgOf = (dir) => {
  const list = byDir.get(dir) || []
  return list.length === 0 ? '—' : (list.reduce((s, x) => s + x.line, 0) / list.length).toFixed(1)
}
console.log(`check-coverage: OK — 全局 ${globalLine}%、${libFiles.length} 个 lib 文件逐个 ≥${FILE_MIN}%`
  + `（记账空洞 ${KNOWN_GAPS.size} 个）；目录均值 ` + Object.keys(DIR_MIN).map((d) => `${d} ${avgOf(d)}%`).join(' / '))
