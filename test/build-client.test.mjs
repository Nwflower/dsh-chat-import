// build-client.test.mjs — scripts/build-client.mjs 的组装契约：
//   1. 内联模块（FRAGMENTS 里 lib/ 开头的条目）去掉顶格 export、整体缩进 4 格，其余字节不动；
//   2. 不是「纯模块」形态的输入一律拒绝（import / export default / export { } / 跨行模板
//      字符串）——宁可构建失败，也不拼出语义变了的代码；
//   3. 被 import 时只提供组装函数，不读写 lib/client.js（测试与 eslint 配置都会 import 它）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { FRAGMENTS, assemble, clientFragmentGlobals, inlineModule } from '../scripts/build-client.mjs'

test('inlineModule：去掉顶格 export、非空行缩进 4 格、顶部带来源标记', () => {
  const out = inlineModule('lib/x.mjs', [
    '// 头注释',
    'export const A = 1',
    '',
    'export function f(a) {',
    '  return a + A',
    '}',
    'export async function g() { return 1 }',
    'export class K {}',
    'const local = 2 // 未导出的声明原样保留',
  ].join('\r\n') + '\n\n')
  assert.deepEqual(out.split('\n'), [
    '    // ── 内联自 lib/x.mjs（宿主侧纯模块，构建时去掉 export 原样拼入；改它即改 bundle）──',
    '    // 头注释',
    '    const A = 1',
    '',
    '    function f(a) {',
    '      return a + A',
    '    }',
    '    async function g() { return 1 }',
    '    class K {}',
    '    const local = 2 // 未导出的声明原样保留',
  ])
})

test('inlineModule：拒绝无法安全内联的模块形态', () => {
  const bad = [
    ["import { x } from './y.mjs'", /import/],
    ["export default function f() {}", /export 形态/],
    ['export { a, b }', /export 形态/],
    ["export * from './y.mjs'", /export 形态/],
    ['const s = `第一行', /跨行模板字符串/],
  ]
  for (const [line, re] of bad) {
    assert.throws(() => inlineModule('lib/bad.mjs', 'export const ok = 1\n' + line + '\n'), re, line)
  }
  // 注释里的反引号（文档里写 `代码`）不算模板字符串
  assert.doesNotThrow(() => inlineModule('lib/ok.mjs', '// 见 `measure` 与 `\nexport const a = 1\n'))
})

test('FRAGMENTS 里的内联模块都是可以 import 的真实模块（测试直接 import 的就是它）', async () => {
  const modules = FRAGMENTS.filter((name) => name.startsWith('lib/'))
  assert.deepEqual(modules, ['lib/panel-filter.mjs', 'lib/footer-layout.mjs'])
  for (const name of modules) {
    const exported = await import(new URL('../' + name, import.meta.url))
    assert.ok(Object.keys(exported).length > 0, name + ' 应有导出')
  }
})

test('clientFragmentGlobals：片段共享作用域的全部顶层名字（eslint 逐片 no-undef 用）', () => {
  const globals = clientFragmentGlobals()
  // bundle 头部：浏览器全局 / factory 参数 / React 与 hooks 解构 / h
  for (const name of ['window', 'fetch', 'ResizeObserver', 'require', 'React', 'useState', 'useLayoutEffect', 'h']) {
    assert.equal(globals[name], 'readonly', name)
  }
  assert.equal(globals.module, 'writable')
  // 片段与内联模块的顶层声明；let 记 writable（entry.js 跨片给 localeSvc 赋值）
  for (const name of ['DICT', 'COLORS', 'postJson', 'DiscoveryPanel', 'SessionRow', 'NO_WORKSPACE_KEY', 'measureFooterLane', 'apply']) {
    assert.equal(globals[name], 'readonly', name)
  }
  assert.equal(globals.localeSvc, 'writable')
  // 函数体内的局部不是全局
  assert.equal(globals.scanKey, undefined)
  assert.equal(globals.toolBtn, undefined)
})

test('assemble：与磁盘上的 lib/client.js 一致；被 import 时不写盘', () => {
  const target = new URL('../lib/client.js', import.meta.url)
  const before = statSync(target).mtimeMs
  const bundle = assemble()
  assert.equal(statSync(target).mtimeMs, before, 'import / assemble 不应改写 lib/client.js')
  assert.equal(readFileSync(target, 'utf8').replace(/\r\n/g, '\n'), bundle,
    'lib/client.js 与 src/client/ 不同步——运行 npm run build:client')
  assert.match(bundle, /\n    const h = React\.createElement;\n/, 'bundle 头部提供 h 元素工厂')
})
