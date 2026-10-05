// check-linux-compat.test.mjs — .github/scripts/check-linux-compat.mjs 规则 1（mock 树查找
// 必须做分隔符归一）按「每个查找点」判定：此前只要文件里任何地方（哪怕注释里）出现过一次
// `.replace(/\\/g, …)` 字面量，整个文件的裸 tree[key] 查找就都放行。
// 每个用例把脚本拷进临时目录（脚本按自身位置找 ../../test/），在那里放夹具测试文件再跑。
// 夹具里写 TREE[，落盘时才换成 tree[——免得本文件自己被规则 1 扫成「裸查找」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../.github/scripts/check-linux-compat.mjs', import.meta.url))
const NORM = String.raw`const norm = (p) => String(p).replace(/\\/g, '/')`
const filler = (n) => Array.from({ length: n }, (_, i) => `const pad${i} = ${i}`)

/** 在临时目录里放一个夹具测试文件并跑脚本，返回 { status, stderr }。 */
function check(name, lines) {
  const dir = mkdtempSync(join(tmpdir(), 'linux-compat-'))
  try {
    mkdirSync(join(dir, '.github', 'scripts'), { recursive: true })
    mkdirSync(join(dir, 'test'))
    copyFileSync(SCRIPT, join(dir, '.github', 'scripts', 'check-linux-compat.mjs'))
    writeFileSync(join(dir, 'test', name), lines.join('\n').replaceAll('TREE[', 'tree[') + '\n')
    const r = spawnSync(process.execPath, [join(dir, '.github', 'scripts', 'check-linux-compat.mjs')], { encoding: 'utf8' })
    return { status: r.status, stderr: r.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('归一字面量远在别处（另一个 mock）不再替这里的裸查找担保', () => {
  const r = check('far.test.mjs', [
    NORM,
    ...filler(30),
    'const host = {',
    '  stat: async (p) => {',
    '    const v = TREE[p]',
    '    return v === undefined ? null : { type: "file" }',
    '  },',
    '}',
  ])
  assert.equal(r.status, 1, r.stderr)
  assert.match(r.stderr, /far\.test\.mjs:34 mock 树查找/)
  assert.match(r.stderr, /test\/_support\//, '修复提示指向共享 fake host')
})

test('注释里提到归一字面量不算归一', () => {
  const r = check('comment.test.mjs', [
    String.raw`// 记得 .replace(/\\/g, '/') 归一`,
    'const host = { readText: async (p) => TREE[p] ?? null }',
  ])
  assert.equal(r.status, 1, r.stderr)
  assert.match(r.stderr, /comment\.test\.mjs:2 /)
})

test('三态命中的 lookup、紧挨归一的 mock、给树赋值与断言读树都放行', () => {
  const r = check('ok.test.mjs', [
    NORM,
    'const host = {',
    '  lookup(p) { const f = norm(p); return TREE[p] ?? TREE[f] }',
    '  stat: async (p) => (TREE[p] !== undefined ? { type: "file" } : null),',
    '}',
    ...filler(30),
    "TREE['D:/x'] = 'seed'",
    "assert.equal(TREE['D:/x'], 'seed')",
    "if (options.kind === 'createIfAbsent' && TREE[key] !== undefined) throw new Error('EEXIST')",
  ])
  assert.equal(r.status, 0, r.stderr)
})
