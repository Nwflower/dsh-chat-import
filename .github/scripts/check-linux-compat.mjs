// .github/scripts/check-linux-compat.mjs — 跨平台路径纪律静态检查（CI + 本地 pre-push）
//
// 背景：CI（ubuntu + node 22）的 npm test 曾长期红而本地（Windows）全绿——测试用
// 反斜杠合成路径（mock 树键），代码里的 join() 在 posix 下对反斜杠路径产出混合
// 分隔符（'D:\demo\x/summary.json'），mock 的裸 tree[key] 查找在 Linux 落空；
// 或断言把 node:path 运算结果与写死的反斜杠字面量比较（posix 下 dirname 行为不同）。
//
// 规则（违反即失败，退出码 1）：
//   1. mock 树查找必须做分隔符归一：每一处读 mock 树的 `tree[key]`（stat / readText /
//      listDir 等）要么就地查归一后的键（同一行带 norm…() / .replace(…)），要么在同一个
//      mock 里（前后 NORM_REACH 行内）有 `.replace(/\\/g, …)` 归一——此前只要整个文件
//      任何地方（哪怕注释里）出现过一次该字面量就整文件放行。不算查找的：给树赋值
//      （`tree[k] = …`）、断言里读树（键是测试自己算的）、写路径的 createIfAbsent 存在性
//      检查。新写的 mock 优先复用 test/_support/ 下的共享 fake host（已按分隔符归一查树）。
//   2. 断言不得把 dirname()/join()/basename()/relative() 的结果与写死的
//      'X:\…' 反斜杠字面量比较（期望值必须用同口径 node:path 函数计算）。
//   3. 夹具/断言里的 cwd 值不得写死盘符路径：`lib/import-core.mjs` 落盘前按宿主
//      isAbsolute 剔除跨平台 cwd（宿主要求 header.cwd 绝对），写死 'D:\…' 的夹具在
//      Linux CI 上 cwd 整条被剔除 → 断言拿到 undefined、分组落到「(未分组)」。夹具请用
//      `hostAbs('D:/demo/proj')`（test/_support/host-path.mjs）：Windows 上得到
//      'D:\demo\proj'，POSIX 上得到 '/demo/proj'，两侧语义一致。
//      例外：`IS_WINDOWS ? 'D:\…' : undefined` 这类显式按平台断言的跨平台路径用例。
//
// 用法：node .github/scripts/check-linux-compat.mjs（无参数，扫描 test/*.test.mjs）。

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('../../test/', import.meta.url))
const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs'))
const problems = []
const normMark = '/\\\\/g' // 源文本里 `.replace(/\\/g, …)` 的字面量
// 归一字面量离查找点多远仍算「同一个 mock 里」（mock 的 stat / readText / readDir 通常挨着写）
const NORM_REACH = 10
const isComment = (line) => /^\s*(?:\/\/|\/?\*)/.test(line)

/** 一行里读 mock 树的位置（`tree[…]` 后面不是赋值）；返回是否至少有一处。 */
function readsTree(line) {
  const re = /\btree\s*\[/g
  let m
  while ((m = re.exec(line)) !== null) {
    let depth = 0
    let end = m.index + m[0].length - 1
    for (; end < line.length; end++) {
      if (line[end] === '[') depth++
      else if (line[end] === ']' && --depth === 0) break
    }
    if (!/^\s*=(?!=)/.test(line.slice(end + 1))) return true
  }
  return false
}

for (const file of files) {
  const src = readFileSync(join(dir, file), 'utf8')
  const lines = src.split(/\r?\n/)

  // 规则 1：每处读 mock 树的查找都要有就近的分隔符归一（注释里的字面量不算）
  const normLines = lines.flatMap((l, i) => (!isComment(l) && l.includes(normMark) ? [i] : []))
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isComment(line) || !readsTree(line)) continue
    if (/^\s*assert\b/.test(line) || line.includes('createIfAbsent')) continue
    if (/\bnorm\w*\(|\.replace\(/.test(line)) continue // 就地查归一后的键（三态命中那一行）
    if (normLines.some((k) => Math.abs(k - i) <= NORM_REACH)) continue
    problems.push(
      `${file}:${i + 1} mock 树查找（tree[key]）附近没有分隔符归一——Linux CI 会因代码 join() ` +
      `产出混合分隔符而查不到。请改用 test/_support/ 下的共享 fake host，或在该 mock 里按` +
      `「原键 → .replace(/\\\\/g, '/') 归一 → 反斜杠归一」三态查树。`
    )
  }

  // 规则 2：node:path 结果不得与写死的反斜杠字面量比较
  const pathCall = '(?:dirname|join|basename|relative)\\s*\\('
  const driveLit = "['\"][A-Za-z]:\\\\"
  const cmp = '\\s*(?:===|!==|==|!=)\\s*'
  const r1 = new RegExp(`${pathCall}[^)]*\\)${cmp}${driveLit}`)
  const r2 = new RegExp(`${driveLit}[^'\"]*['\"]${cmp}${pathCall}`)
  for (let i = 0; i < lines.length; i++) {
    if (r1.test(lines[i]) || r2.test(lines[i])) {
      problems.push(
        `${file}:${i + 1} 断言把 dirname()/join()/basename()/relative() 的结果与写死的 ` +
        `反斜杠路径比较——posix（Linux CI）下结果不同（如 dirname('D:\\…') 为 '.'）。` +
        `期望值必须用同口径 node:path 函数计算。`
      )
    }
  }
  // 规则 3：cwd / directory 字段与断言不得写死盘符路径（须经 hostAbs 取宿主绝对形态）
  // 只在**集成面**（import 插件入口（lib/index.mjs）/ import-core 的文件，即真走落盘归一的那条管线）
  // 检查：纯转换器/纯函数层的 cwd 是原样透传的，写盘符字面量不会在 Linux 上翻车。
  // 例外面：显式按平台断言的跨平台路径用例（`IS_WINDOWS ? 'D:\…' : undefined`）。
  const integration = /from '\.\.\/(?:lib\/)?index\.mjs'|import-core/.test(src)
  const cwdDrive = /(\bcwd\s*[:=]\s*|\bcwd\s*,\s*|\bdirectory\s*[:=]\s*|\bdirectory\s*,\s*)'[A-Za-z]:[\\/]/
  for (let i = 0; i < lines.length && integration; i++) {
    if (!cwdDrive.test(lines[i])) continue
    if (lines[i].includes('IS_WINDOWS')) continue
    problems.push(
      `${file}:${i + 1} cwd/directory 夹具或断言写死了盘符路径——import-core 按宿主 isAbsolute ` +
      `剔除跨平台 cwd，Linux CI 上 cwd 会整条丢掉。请用 test/_support/host-path.mjs 的 ` +
      `hostAbs('D:/demo/proj')；确需按平台断言的跨平台用例请显式写成 IS_WINDOWS ? 'D:\\…' : undefined。`
    )
  }
}

if (problems.length > 0) {
  console.error('check-linux-compat: FAIL — 跨平台路径纪律违规：')
  for (const p of problems) console.error('  - ' + p)
  console.error('修复后重跑；这是 CI 上 npm test 长期红（Linux 专属）的防回归护栏。')
  process.exit(1)
}
console.log(`check-linux-compat: OK — ${files.length} 个测试文件无跨平台路径违规`)
