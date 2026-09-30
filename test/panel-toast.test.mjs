// panel-toast.test.mjs — 导入落点 Toast 的契约：
//   1. 归组信息（workspace / workspaceCreated / ungrouped）→ 一句「落到哪了」的文案，
//      没有落点信息时返回空串（不弹噪音）；
//   2. ToastHost 注册进官方 shell.overlay（与宿主自己的 toast 同一个槽）；
//   3. 官方 Toast 是 require 来的（@deepseek-ai/dsh-client-ui-primitives），**必须包在
//      try/catch 里并有自绘兜底**——插件支持 dsh ≥ 0.1.5-rc.1，旧宿主没有该包时不能把
//      面板整个拖垮（见 docs/architecture.md D17）。
//
// 为什么第 1 条直接取源码求值而不是断源码文本：文案是纯函数（只依赖 t），把它从
// bundle 里切出来跑，测的是真正会执行的那份逻辑；面板没有 DOM 测试环境，其余三条
// 只能读源码（沿用 panel-layout.test.mjs 的做法）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** 取出 bundle 里 4 空格基准缩进的顶层函数源码（函数体到同样缩进的收尾 `}`）。 */
function topLevelFunction(name) {
  const start = source.indexOf('function ' + name + '(')
  assert.notEqual(start, -1, 'lib/client.js 缺少函数 ' + name)
  const end = source.indexOf('\n    }\n', start)
  assert.notEqual(end, -1, name + ' 没有可识别的收尾')
  return source.slice(start, end + '\n    }'.length)
}

// 字典替身：只需 {name} 插值，与 i18n.js 的 fill 同语义
const t = (key, vars) => {
  const dict = {
    'toast.landed': '导入完成 → {where}',
    'toast.newWorkspace': '（本次新建该工作区）',
    'toast.ungrouped': '；另有 {n} 个未归组（侧栏「未分组」）',
    'toast.written': '已写入 {where}',
    'result.separator': '，',
  }
  const raw = dict[key]
  assert.ok(raw !== undefined, '缺少字典键 ' + key)
  return String(raw).replace(/\{(\w+)\}/g, (_, k) => String(vars && vars[k] !== undefined ? vars[k] : ''))
}

const landingToast = new Function('t', topLevelFunction('landingToast') + '\nreturn landingToast;')(t)

test('落点文案：单一工作区 + 本次新建 + 未归组计数', () => {
  const line = landingToast([
    { status: 'imported', workspace: 'C:\\x\\dsh-chat-import-workspace', workspaceMode: 'dedicated', workspaceCreated: true },
  ], t)
  assert.equal(line, '导入完成 → C:\\x\\dsh-chat-import-workspace（本次新建该工作区）')
})

test('落点文案：多个落点去重、最多列两个并省略', () => {
  const line = landingToast([
    { workspace: 'D:\\a' },
    { workspace: 'D:\\b' },
    { workspace: 'D:\\a' },
    { workspace: 'D:\\c' },
  ], t)
  assert.equal(line, '导入完成 → D:\\a，D:\\b …')
})

test('落点文案：未归组会在同一句里点名', () => {
  const line = landingToast([
    { workspace: 'D:\\a' },
    { status: 'imported', ungrouped: 2, ungroupedReason: 'cwd-is-home' },
  ], t)
  assert.equal(line, '导入完成 → D:\\a；另有 2 个未归组（侧栏「未分组」）')
})

test('落点文案：转投（非 DSH 目标）落点是写出的文件', () => {
  const line = landingToast([
    { status: 'imported', transferred: 1, files: [{ filePath: 'C:\\out\\sess.jsonl' }] },
  ], t)
  assert.equal(line, '已写入 C:\\out\\sess.jsonl')
})

test('落点文案：无落点信息（全部幂等跳过 / 失败）时不弹提示', () => {
  assert.equal(landingToast([], t), '')
  assert.equal(landingToast([{ status: 'already-imported' }], t), '')
  assert.equal(landingToast([{ status: 'failed', error: 'boom' }], t), '')
})

test('ToastHost 注册进官方 shell.overlay（与宿主自己的 toast 同一个槽）', () => {
  assert.match(source, /ctx\.slots\.inject\("shell\.overlay"/, 'ToastHost 必须经 slots.inject 挂到 shell.overlay')
  assert.match(source, /id: "chat-import\.landing-toast"/, 'overlay 条目要带自己的 id')
  assert.match(source, /locale: LOCALE_NS/, 'overlay 条目要声明字典命名空间（文案随语言切换）')
})

test('官方 Toast 是 require 来的，且缺包时退回自绘横幅', () => {
  assert.match(source, /require\("@deepseek-ai\/dsh-client-ui-primitives"\)/, '应复用官方 primitives 的 Toast')
  const tryAt = source.indexOf('require("@deepseek-ai/dsh-client-ui-primitives")')
  const guardAt = source.lastIndexOf('try {', tryAt)
  assert.notEqual(guardAt, -1, 'require 必须包在 try 里（旧宿主没有该包）')
  assert.match(source, /catch \{\s*\n\s*\/\/[^\n]*\n\s*HostToast = null;/, 'catch 要落到 HostToast = null')
  assert.match(source, /function FallbackToast\(/, '必须有无 primitives 时的自绘横幅')
  assert.match(source, /React\.createElement\(FallbackToast/, 'HostToast 缺席时渲染自绘横幅')
})

test('Toast 生命周期：显式给 holdMs，且新提示用 key 重开一条', () => {
  assert.match(source, /const TOAST_HOLD_MS = \d+;/, 'holdMs 必须是常量而非 undefined（否则官方 Toast 不会自动消失）')
  assert.match(source, /const TOAST_ACTION_HOLD_MS = \d+;/, '带动作的提示要有自己的（更长的）holdMs')
  assert.match(source, /holdMs = actions\.length > 0 \? TOAST_ACTION_HOLD_MS : TOAST_HOLD_MS/, '按是否有动作选 holdMs')
  assert.match(source, /holdMs,/, '要把 holdMs 传给官方 Toast')
  assert.match(source, /key: toast\.seq/, '用递增 seq 当 key，连续导入才会重开横幅')
  assert.match(source, /onDone: \(\) => setToast\(null\)/, '官方 Toast 结束后要清掉本地状态')
})

test('面板内自绘黄条已并入官方 Toast（动作按钮 = 原来的「忽略警告」）', () => {
  // 面板里不再有底部浮层：状态、JSX、样式三处都不该再出现
  assert.doesNotMatch(source, /skippedToast/, 'DiscoveryPanel 不应再有 skippedToast 状态')
  assert.doesNotMatch(source, /style\.toast\b/, '面板里不应再画自绘 toast')
  assert.doesNotMatch(source, /toastText:|toastAction:/, 'styles.js 里不应再留旧浮层样式')
  // 跳过提示与动作走同一条官方 Toast（动作透传给官方组件）
  assert.match(source, /const skipLine = skipped\.length > 0 \? t\("toast\.skipped"/, '跳过条数要进 Toast 文案')
  assert.match(source, /label: t\("toast\.ignore"\), onClick: \(\) => doImport\(skipped, \{ force: true \}\)/, '动作 = 用 force 重导这批会话')
  assert.match(source, /\.\.\.\(actions\.length > 0 \? \{ actions \} : \{\}\)/, '有动作时把 actions 透传给官方 Toast')
})

test('导入成功路径把落点提示推给 Toast（面板不在眼前时也能看到）', () => {
  assert.match(source, /showAppToast\(toastText, skipped\.length > 0/, '导入结果处理里要调用落点提示并带动作')
})

