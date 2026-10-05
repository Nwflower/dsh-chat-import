// panel-filter.test.mjs — 导入面板工作区筛选纯函数。
// lib/panel-filter.mjs 原样内联进 lib/client.js（scripts/build-client.mjs），这里测的就是面板
// 里跑的那份——此前 bundle 里另有一份副本（返回值多了下拉要用的 path、键判定口径也不同），
// 测试覆盖的是一份不发布的代码。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  NO_WORKSPACE_KEY,
  workspaceKey,
  filterByWorkspace,
  buildWorkspaceOptions,
} from '../lib/panel-filter.mjs'
import { inlineModule } from '../scripts/build-client.mjs'

const s = (project, status, extra = {}) => ({
  format: 'cursor',
  sessionId: extra.id || project || 'x',
  sourcePath: '/p',
  project: project || null,
  importStatus: status,
  lastActiveAt: extra.la ?? 0,
  createdAt: extra.ca ?? 0,
  ...(extra.cwd !== undefined ? { cwd: extra.cwd } : {}),
})

test('workspaceKey：有 project 用 basename，无则归入无工作区', () => {
  assert.equal(workspaceKey(s('demo.Client-app', 'not-imported')), 'demo.Client-app')
  assert.equal(workspaceKey(s(null, 'not-imported')), NO_WORKSPACE_KEY)
  assert.equal(workspaceKey(null), NO_WORKSPACE_KEY)
})

test('workspaceKey：非字符串 project 归入无工作区（分组排序对键调用 localeCompare）', () => {
  assert.equal(workspaceKey({ project: 42 }), NO_WORKSPACE_KEY)
  assert.equal(workspaceKey({ project: { name: 'x' } }), NO_WORKSPACE_KEY)
  assert.equal(workspaceKey({ project: '' }), NO_WORKSPACE_KEY)
})

test('filterByWorkspace：空串为全部，否则只保留匹配工作区', () => {
  const items = [s('Desktop', 'not-imported'), s('demo.Client-app', 'not-imported'), s(null, 'not-imported')]
  assert.equal(filterByWorkspace(items, '').length, 3)
  assert.equal(filterByWorkspace(items, 'Desktop').length, 1)
  assert.equal(filterByWorkspace(items, NO_WORKSPACE_KEY).length, 1)
  assert.deepEqual(filterByWorkspace(undefined, 'Desktop'), [])
})

test('buildWorkspaceOptions：按最新活跃降序，无工作区钉最后', () => {
  const items = [
    s(null, 'not-imported', { la: 100 }),
    s('Desktop', 'not-imported', { la: 300 }),
    s('demo.Client-app', 'not-imported', { la: 200 }),
  ]
  const opts = buildWorkspaceOptions(items)
  assert.deepEqual(opts.map((o) => o.key), ['Desktop', 'demo.Client-app', NO_WORKSPACE_KEY])
})

test('buildWorkspaceOptions：path 取组内最活跃会话的 cwd（同名不同路径以它为准，并列取后到的）', () => {
  const opts = buildWorkspaceOptions([
    s('app', 'not-imported', { id: 'a', la: 100, cwd: '/work/old/app' }),
    s('app', 'not-imported', { id: 'b', la: 300, cwd: '/work/new/app' }),
    s('app', 'not-imported', { id: 'c', la: 200, cwd: '/work/mid/app' }),
    s('tie', 'not-imported', { id: 'd', la: 50, cwd: '/first/tie' }),
    s('tie', 'not-imported', { id: 'e', la: 50, cwd: '/second/tie' }),
    s('bare', 'not-imported', { id: 'f', ca: 10 }),
  ])
  assert.deepEqual(opts, [
    { key: 'app', latest: 300, path: '/work/new/app' },
    { key: 'tie', latest: 50, path: '/second/tie' },
    { key: 'bare', latest: 10, path: '' },
  ])
})

test('buildWorkspaceOptions：时间并列按键名升序；非数组输入给空列表', () => {
  const opts = buildWorkspaceOptions([s('b', 'x', { la: 5 }), s('a', 'x', { la: 5 })])
  assert.deepEqual(opts.map((o) => o.key), ['a', 'b'])
  assert.deepEqual(buildWorkspaceOptions(null), [])
})

test('lib/client.js 原样内联本模块，面板里不再另存副本', () => {
  const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const module = readFileSync(new URL('../lib/panel-filter.mjs', import.meta.url), 'utf8')
  assert.ok(bundle.includes(inlineModule('lib/panel-filter.mjs', module)),
    'lib/client.js 应原样内联 lib/panel-filter.mjs（改了模块后重跑 npm run build:client）')
  for (const name of ['workspaceKey', 'filterByWorkspace', 'buildWorkspaceOptions']) {
    assert.equal(bundle.split('function ' + name + '(').length - 1, 1, name + ' 在 bundle 里应恰好一份实现')
    assert.equal(bundle.includes('const ' + name + ' ='), false, name + ' 不应再有片段内的同名副本')
  }
  assert.equal(bundle.split('const NO_WORKSPACE_KEY =').length - 1, 1, 'NO_WORKSPACE_KEY 只声明一次')
})
