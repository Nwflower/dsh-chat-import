// panel-discovery.test.mjs — 发现面板（src/client/discovery.js）里的纯函数：
// 从 bundle 切出来求值，测的就是发布的那份逻辑（面板没有 DOM 测试环境，组件本身只能读
// 源码断言，见 panel-layout.test.mjs）。依赖的其它片段函数按需切出或注入替身。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { NO_WORKSPACE_KEY, workspaceKey } from '../lib/panel-filter.mjs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** 切出 bundle 里一段 4 空格基准缩进的顶层声明（从 start 标记到同缩进的收尾）。 */
function topLevel(startMarker, endMarker = '\n    }') {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, 'lib/client.js 缺少 ' + startMarker)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, startMarker + ' 没有可识别的收尾')
  return source.slice(start, end + endMarker.length)
}
const line = (marker) => topLevel(marker, ';')

/** 把若干段 bundle 源码拼成一个作用域，返回 names 里列出的绑定；deps 作为参数注入。 */
function load(snippets, names, deps = {}) {
  const keys = Object.keys(deps)
  return new Function(...keys, snippets.join('\n') + '\nreturn { ' + names.join(', ') + ' };')(...keys.map((k) => deps[k]))
}

const LIST = [line('const LIST_ROW_H = '), line('const LIST_HEAD_H = '), line('const LIST_OVERSCAN_MIN = ')]
const {
  nextHot, filterByTime, groupSessions, layoutGroups, windowRange,
  importSummary, alreadyImportedItems, localImportedPath, LIST_ROW_H, LIST_HEAD_H,
} = load([
  ...LIST,
  line('const TIME_FILTER_MS = '),
  line('const byTimeDesc = '),
  line('const NO_HOT = '),
  topLevel('function nextHot('),
  topLevel('function filterByTime('),
  line('const groupLatest = '),
  topLevel('function groupSessions('),
  topLevel('function layoutGroups('),
  topLevel('function windowRange('),
  topLevel('function importSummary('),
  topLevel('function alreadyImportedItems('),
  topLevel('function localImportedPath('),
], ['nextHot', 'filterByTime', 'groupSessions', 'layoutGroups', 'windowRange', 'importSummary',
  'alreadyImportedItems', 'localImportedPath', 'LIST_ROW_H', 'LIST_HEAD_H'], {
  NO_WORKSPACE_KEY,
  workspaceKey,
  fmtImportResult: (results) => 'imported:' + results.length,
  fmtTransferResult: (results, target) => 'transfer:' + target,
})
const t = (key, vars) => key + (vars ? JSON.stringify(vars) : '')

test('nextHot：进入点亮该行与所在分组，离开该行时连同分组一起熄灭', () => {
  const off = { key: null, group: null }
  const a = nextHot(off, 'a', null, 'G1')
  assert.deepEqual(a, { key: 'a', group: 'G1' })
  // 回归：此前离开行只熄灭行、分组状态是个恒等式（永不复位），组头一直亮着、折叠箭头一直露着
  assert.deepEqual(nextHot(a, null, 'a', 'G1'), off)
})

test('nextHot：交错的进入 / 离开不会熄掉新点亮的行', () => {
  const b = nextHot({ key: 'a', group: 'G1' }, 'b', null, 'G2')
  assert.deepEqual(b, { key: 'b', group: 'G2' })
  // 旧行 a 的失焦 / 离开晚到：点亮的已是 b，保持不变（同一个对象，不触发重渲染）
  assert.equal(nextHot(b, null, 'a', 'G1'), b)
  // 重复进入同一行（悬停后再聚焦行内按钮）返回同一个对象
  assert.equal(nextHot(b, 'b', null, 'G2'), b)
  // 没有分组信息时按 null 记
  assert.deepEqual(nextHot(b, 'c', null, undefined), { key: 'c', group: null })
})

test('filterByTime：按最后活跃（缺省创建）时间落在窗口内过滤；不筛选时原样返回', () => {
  const now = 100 * 86400000
  const list = [
    { id: 'fresh', lastActiveAt: now - 3600000 },
    { id: 'week', lastActiveAt: now - 3 * 86400000 },
    { id: 'old', createdAt: now - 20 * 86400000 },
    { id: 'none' },
  ]
  assert.equal(filterByTime(list, '', now), list)
  assert.deepEqual(filterByTime(list, '24h', now).map((s) => s.id), ['fresh'])
  assert.deepEqual(filterByTime(list, '7d', now).map((s) => s.id), ['fresh', 'week'])
  assert.deepEqual(filterByTime(list, '30d', now).map((s) => s.id), ['fresh', 'week', 'old'])
})

test('groupSessions：组按最新活跃降序（并列按名升序），组内时间倒序，未分组钉最后', () => {
  const groups = groupSessions([
    { project: 'b', lastActiveAt: 5 },
    { project: null, lastActiveAt: 99 },
    { project: 'a', lastActiveAt: 1 },
    { project: 'a', lastActiveAt: 5 },
    { project: 'c', createdAt: 9 },
  ])
  assert.deepEqual(groups.map((g) => g.name), ['c', 'a', 'b', NO_WORKSPACE_KEY])
  assert.deepEqual(groups[1].list.map((s) => s.lastActiveAt), [5, 1])
  assert.deepEqual(groupSessions([]), [])
})

test('layoutGroups + windowRange：折叠组只占组头；窗口外的行由等高占位块撑住', () => {
  const groups = [{ name: 'a', list: new Array(100).fill({}) }, { name: 'b', list: new Array(5).fill({}) }]
  const laid = layoutGroups(groups, new Set())
  assert.deepEqual(laid.map((e) => e.rowsTop), [LIST_HEAD_H, LIST_HEAD_H * 2 + 100 * LIST_ROW_H])
  assert.deepEqual(layoutGroups(groups, new Set(['a'])).map((e) => e.rowsTop), [LIST_HEAD_H, LIST_HEAD_H * 2])

  // 视口在第一组中段：只挂载视口 ± 一屏的行，上下占位 + 行高之和恒等于整组高度
  const win = { top: LIST_HEAD_H + 50 * LIST_ROW_H, h: 10 * LIST_ROW_H }
  const r = windowRange(100, laid[0].rowsTop, win)
  assert.ok(r.first > 0 && r.last < 100 && r.last > r.first, JSON.stringify(r))
  assert.equal(r.padTop, r.first * LIST_ROW_H)
  assert.equal(r.padTop + (r.last - r.first) * LIST_ROW_H + r.padBottom, 100 * LIST_ROW_H)
  // 第二组整组在视口下方很远：不挂载任何行，整组高度都在占位块里
  const far = windowRange(5, laid[1].rowsTop + 10000, win)
  assert.equal(far.last, far.first)
  assert.equal(far.padTop + far.padBottom, 5 * LIST_ROW_H)
})

test('importSummary：DSH 目标报导入计数、转投报转投摘要；归档结果如实附在后面', () => {
  assert.equal(importSummary({ results: [{}], target: 'dsh4' }, false, t), 'imported:1')
  assert.equal(importSummary({ results: [{}], target: 'claude' }, false, t), 'transfer:claude')
  assert.equal(importSummary({ results: [{}, {}], archived: 2 }, true, t), 'imported:2\narchive.done{"n":2}')
  assert.equal(importSummary({ results: [], archiveUnsupported: true, archiveSkipped: 1 }, true, t),
    'imported:0\narchive.unsupported\narchive.skipped{"n":1}')
  // 不归档时不附任何归档字样，即使响应里带了计数
  assert.equal(importSummary({ results: [], archived: 3 }, false, t), 'imported:0')
})

test('alreadyImportedItems / localImportedPath：force 重导批次与「本地打标不重扫」的判定', () => {
  const items = [{ sourcePath: '/a' }, { sourcePath: '/b' }]
  const results = [{ status: 'already-imported', sourcePath: '/b' }, { status: 'imported', sourcePath: '/a' }]
  assert.deepEqual(alreadyImportedItems(results, items), [{ sourcePath: '/b' }])
  assert.deepEqual(alreadyImportedItems(undefined, items), [])

  const single = [{ status: 'imported', mode: 'single', sourcePath: '/a' }]
  assert.equal(localImportedPath(single, false, false), '/a')
  assert.equal(localImportedPath(single, true, false), '', 'force 另铸新会话 id，必须重扫')
  assert.equal(localImportedPath(single, false, true), '', '归档旧会话改变了别的行，必须重扫')
  assert.equal(localImportedPath([{ status: 'imported', mode: 'batch', sourcePath: '/a' }], false, false), '')
  assert.equal(localImportedPath(results, false, false), '', '多条结果走重扫')
  assert.equal(localImportedPath([{ status: 'appended', mode: 'single', sourcePath: '/a' }], false, false), '')
})
