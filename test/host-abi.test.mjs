// host-abi.test.mjs — 加载期 ABI 守卫的形态契约
//
// 背景：本插件早先在 lib/tools.mjs 里具名 import 了宿主内部符号
// TOOL_RUNTIME_SCHEDULER 作为「解析到旧 dsh-tools 副本就大声报错」的哨兵。
// 具名 import 是链接期解析：宿主构建不导出该名字时，整个模块加载失败
// （does not provide an export named ...），插件在 apply() 之前就死了，
// 连哨兵自己的报错都没机会抛。
//
// DSH 0.2.1-rc.3 的「scoped executors 与工具注册分离」重构删掉了这个内部符号。
// 同一版本号的 npm 构建仍导出它，桌面版打包的构建不再导出——同版本不同产物，
// 行为不一致，这类问题在开发机上永远复现不了。
//
// 这条用例守住修复后的形态：哨兵改成用具名空间 import 拿到的运行时能力检查，
// 不再有任何「宿主可能不导出的具名 import」把整个模块的加载拖垮。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as dshTools from '@deepseek-ai/dsh-tools'

const toolsSource = readFileSync(new URL('../lib/tools.mjs', import.meta.url), 'utf8')

test('lib/tools.mjs 不用具名 import 引用宿主内部符号', () => {
  // 只看真正的值 import（`import type` 编译期擦除，不会导致链接失败）。
  const valueImports = [...toolsSource.matchAll(/^import\s+(?!type\s)[^\n]*from\s+'([^']+)'/gm)].map((m) => m[1])
  const fromDshTools = valueImports.filter((spec) => spec === '@deepseek-ai/dsh-tools')
  assert.ok(fromDshTools.length > 0, 'lib/tools.mjs 仍应从 @deepseek-ai/dsh-tools 取依赖')
  // 具名空间 import：`import * as dshTools from '...'`，后面用 dshTools.xxx 取。
  assert.match(toolsSource, /import\s+\*\s+as\s+\w+\s+from\s+'@deepseek-ai\/dsh-tools'/,
    'dsh-tools 依赖应是具名空间 import：宿主不导出某个名字时不应导致模块链接失败')
  // 修复前的那一行：具名 import 一个宿主内部符号。
  assert.doesNotMatch(toolsSource, /import\s*\{[^}]*TOOL_RUNTIME_SCHEDULER[^}]*\}\s*from\s*'@deepseek-ai\/dsh-tools'/,
    '不得具名 import TOOL_RUNTIME_SCHEDULER：宿主 0.2.1-rc.3 起不再导出该符号')
})

test('ABI 哨兵检查的是本插件真正依赖的能力', () => {
  // 工具定义工厂与工具运行时服务类：这两个是 lib/tools.mjs 及其工具模块的依赖面。
  assert.equal(typeof dshTools.defineTool, 'function')
  assert.equal(typeof dshTools.ToolRuntime, 'function')
  assert.match(toolsSource, /typeof\s+\w+\.defineTool\s*!==\s*'function'/,
    '守卫应检查 defineTool（工具定义工厂）')
  assert.match(toolsSource, /typeof\s+\w+\.ToolRuntime\s*!==\s*'function'/,
    '守卫应检查 ToolRuntime（工具运行时服务类）')
  assert.match(toolsSource, /requires\s+>=\s*0\.1\.0-rc\.6\s+<\s*0\.3\.0/,
    '守卫报错文案应点名 dsh-tools 的版本区间')
})

test('ToolRuntime 命名在 peer 区间内稳定（0.0.1-rc.3 起改名）', () => {
  // 0.0.1-rc.1 / rc.2 叫 ToolRegistry，rc.3 起改名 ToolRuntime。守卫依赖这个改名，
  // 注释里写明了分界；版本区间下限 0.1.0-rc.6 落在改名之后。
  assert.equal(dshTools.ToolRegistry, undefined, '0.1.0-rc.6 之后不应再有 ToolRegistry')
  assert.equal(typeof dshTools.ToolRuntime, 'function')
})
