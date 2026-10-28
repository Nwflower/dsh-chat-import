// host-abi.test.mjs — 加载期 ABI 守卫的形态契约
//
// 背景：本插件早先在 lib/tools.mjs 里具名 import 了宿主内部符号
// TOOL_RUNTIME_SCHEDULER 作为「解析到旧 dsh-tools 副本就大声报错」的哨兵。
// 具名 import 是链接期解析：宿主构建不导出该名字时，整个模块加载失败
// （does not provide an export named ...），插件在 apply() 之前就死了，
// 连哨兵自己的报错都没机会抛。
//
// 0.2.2 的「scoped executors 与工具注册分离」重构删掉了这个内部符号，
// ToolRuntime 成为 ToolsService 的别名。同一版本号的 npm 构建仍导出它、
// 桌面版打包的构建不再导出——同版本不同产物，这类问题在开发机上永远复现不了。
//
// 这条用例守住修复后的形态：哨兵改用具名空间 import 拿到的运行时能力检查，
// 两版宿主各认一个信号（旧版 TOOL_RUNTIME_SCHEDULER、新版 ToolsService），
// 不再有任何「宿主可能不导出的具名 import」把整个模块的加载拖垮。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as dshTools from '@deepseek-ai/dsh-tools'

const toolsSource = readFileSync(new URL('../lib/tools.mjs', import.meta.url), 'utf8')

test('lib/tools.mjs 不用具名 import 引用宿主内部符号', () => {
  // 只看真正的值 import（`import type` 编译期擦除，不会导致链接失败）。
  const fromDshTools = [...toolsSource.matchAll(/^import\s+(?!type\s)[^\n]*from\s+'([^']+)'/gm)]
    .map((m) => m[1])
    .filter((spec) => spec === '@deepseek-ai/dsh-tools')
  assert.ok(fromDshTools.length > 0, 'lib/tools.mjs 仍应从 @deepseek-ai/dsh-tools 取依赖')
  // 具名空间 import：`import * as dshTools from '...'`，后面用 dshTools.xxx 取。
  assert.match(toolsSource, /import\s+\*\s+as\s+\w+\s+from\s+'@deepseek-ai\/dsh-tools'/,
    'dsh-tools 依赖应是具名空间 import：宿主不导出某个名字时不应导致模块链接失败')
  // 修复前的那一行：具名 import 一个宿主内部符号。
  assert.doesNotMatch(toolsSource, /import\s*\{[^}]*TOOL_RUNTIME_SCHEDULER[^}]*\}\s*from\s*'@deepseek-ai\/dsh-tools'/,
    '不得具名 import TOOL_RUNTIME_SCHEDULER：0.2.2 起不再导出该符号')
})

test('ABI 哨兵在注册期检查两版宿主的信号', () => {
  // 旧副本（0.1.x）与新副本（0.2.x）各提供一个信号，任一存在即通过。
  assert.match(toolsSource, /typeof\s+\w+\.ToolsService\s*===\s*'function'/,
    '守卫应接受新版宿主的 ToolsService')
  assert.match(toolsSource, /typeof\s+\w+\.TOOL_RUNTIME_SCHEDULER\s*===\s*'symbol'/,
    '守卫应接受旧版宿主的 TOOL_RUNTIME_SCHEDULER')
  assert.match(toolsSource, /requires\s+>=\s*0\.1\.0-rc\.6\s+<\s*0\.3\.0/,
    '守卫报错文案应点名 dsh-tools 的版本区间')
  // 检查必须在 registerTools 内（运行期）而不是模块顶层（链接期）。
  assert.ok(toolsSource.indexOf('export function registerTools') < toolsSource.indexOf('const hasHostAbi'),
    'ABI 检查应在 registerTools 里执行，模块加载本身不应因宿主符号缺席而失败')
})

test('本仓库安装的 dsh-tools 副本满足守卫的信号要求', () => {
  // 守卫的判定必须对 peer 区间的当前副本成立，否则插件在正常宿主上也过不去。
  const hasSignal = typeof dshTools.ToolsService === 'function'
    || typeof dshTools.TOOL_RUNTIME_SCHEDULER === 'symbol'
  assert.equal(hasSignal, true, '安装的 dsh-tools 应满足 ABI 守卫（两版信号至少一个）')
})
