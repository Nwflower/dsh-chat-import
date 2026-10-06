// .github/scripts/check-test-discipline.mjs — 测试面纪律护栏（CI + 本地）
//
// 两条规则，都是「靠自觉必然漂移」的那类：
//
// 1. 每个来源格式至少有一个测试引用到它的实现。新增来源时最容易漏的就是测试：格式登记、spec、
//    扫描器都加了，测试没写，CI 照样绿 —— 这里按「转换器导出名 + 该来源 sources/<format>.mjs 的
//    全部导出名」在测试语料里找锚点，一个都不出现即失败。
// 2. 单个测试文件不超过 MAX_TEST_LINES：lib/ 有体量停止线，测试文件此前没有 —— 于是
//    index.test.mjs 长到 5000+ 行、失败只能靠搜索串定位。超线即失败（`_support/` 与 fixtures
//    不受限），拆分进行中的大文件在 OVERSIZE_ALLOWED 里显式记账，拆完必须删条目（见下）。
//
// 用法：node .github/scripts/check-test-discipline.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerTools } from '../../lib/tools.mjs'
import { IMPORT_SPECS } from '../../lib/toolkit.mjs'
import { FORMATS } from '../../lib/discovery/registry.mjs'

// 测试文件体量停止线（_support/ 与 fixtures 不限）：超线即拆分提案，机械触发。
const MAX_TEST_LINES = 1200
// 拆分进行中的记账：拆完一个删一个；条目若已达标会被下面第 3 条判为陈旧。
const OVERSIZE_ALLOWED = new Set([
  'index.test.mjs', // 5282 行：按 28 条 // ---- 横幅拆（来源族 + 导出/面板/文件导入各自成文件）
  'convert.test.mjs', // 2825 行：共享层（events/trim/validate/shape/ir/util/generic）与来源用例分家
])

const testDir = 'test'
const testFiles = readdirSync(testDir).filter((f) => f.endsWith('.test.mjs')).sort()
const corpus = testFiles.map((f) => readFileSync(join(testDir, f), 'utf8')).join('\n')

const problems = []

// ── 1. 每个来源至少有一个测试锚点 ────────────────────────────────────────────
// registerTools 用最小桩 ctx：这里只关心它把 spec 填进 IMPORT_SPECS（工具是否注册无关）。
registerTools({ get: () => undefined, tools: { register: () => () => {} } }, '.check-test-discipline')
for (const format of FORMATS) {
  const spec = IMPORT_SPECS.get(format)
  const anchors = new Set()
  if (spec && typeof spec.convert === 'function' && spec.convert.name) anchors.add(spec.convert.name)
  const sourcePath = `lib/sources/${format}.mjs`
  if (existsSync(sourcePath)) {
    const mod = await import('../../' + sourcePath)
    for (const name of Object.keys(mod)) anchors.add(name)
  }
  if (anchors.size === 0) {
    problems.push(`${format}: 既没有转换器锚点也没有 lib/sources/${format}.mjs，测试无从锚定`)
    continue
  }
  const hit = [...anchors].some((a) => new RegExp('\\b' + a + '\\b').test(corpus))
  if (!hit) problems.push(`${format}: 没有任何测试引用它的实现（可用锚点：${[...anchors].join(', ')}）`)
}

// ── 2. 测试文件体量停止线 ────────────────────────────────────────────────────
const oversize = []
for (const file of testFiles) {
  const lines = readFileSync(join(testDir, file), 'utf8').split('\n').length
  if (lines > MAX_TEST_LINES) oversize.push({ file, lines })
}
for (const { file, lines } of oversize) {
  if (!OVERSIZE_ALLOWED.has(file)) {
    problems.push(`${file}: ${lines} 行超过测试文件停止线 ${MAX_TEST_LINES}（先出拆分提案，_support/ 与该线无关）`)
  }
}

// ── 3. 记账不许陈旧 ─────────────────────────────────────────────────────────
for (const allowed of OVERSIZE_ALLOWED) {
  if (!oversize.some((o) => o.file === allowed)) {
    problems.push(`${allowed}: 已不再超线，请从 OVERSIZE_ALLOWED 删掉这条记账`)
  }
}

if (problems.length > 0) {
  console.error('check-test-discipline: FAIL — 测试面纪律：')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
console.log(`check-test-discipline: OK — ${FORMATS.length} 个来源都有测试锚点；${testFiles.length} 个测试文件（其中 ${OVERSIZE_ALLOWED.size} 个在拆分记账中，上限 ${MAX_TEST_LINES} 行）`)
