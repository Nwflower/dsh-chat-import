// panel-filter.test.mjs — 导入面板工作区筛选纯函数
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_WORKSPACE_KEY,
  workspaceKey,
  filterByWorkspace,
  buildWorkspaceOptions,
  importableSessions,
  refreshableSessions,
} from '../lib/panel-filter.mjs'

const s = (project, status, extra = {}) => ({
  format: 'cursor',
  sessionId: extra.id || project || 'x',
  sourcePath: '/p',
  project: project || null,
  importStatus: status,
  lastActiveAt: extra.la ?? 0,
  createdAt: extra.ca ?? 0,
})

test('workspaceKey：有 project 用 basename，无则归入无工作区', () => {
  assert.equal(workspaceKey(s('Funion.Client-develop', 'not-imported')), 'Funion.Client-develop')
  assert.equal(workspaceKey(s(null, 'not-imported')), NO_WORKSPACE_KEY)
})

test('filterByWorkspace：空串为全部，否则只保留匹配工作区', () => {
  const items = [s('Desktop', 'not-imported'), s('Funion.Client-develop', 'not-imported'), s(null, 'not-imported')]
  assert.equal(filterByWorkspace(items, '').length, 3)
  assert.equal(filterByWorkspace(items, 'Desktop').length, 1)
  assert.equal(filterByWorkspace(items, NO_WORKSPACE_KEY).length, 1)
})

test('buildWorkspaceOptions：按最新活跃降序，无工作区钉最后', () => {
  const items = [
    s(null, 'not-imported', { la: 100 }),
    s('Desktop', 'not-imported', { la: 300 }),
    s('Funion.Client-develop', 'not-imported', { la: 200 }),
  ]
  const opts = buildWorkspaceOptions(items)
  assert.deepEqual(opts.map((o) => o.key), ['Desktop', 'Funion.Client-develop', NO_WORKSPACE_KEY])
})

test('importableSessions：仅未导入/未归档，且受工作区筛选约束', () => {
  const items = [
    s('Desktop', 'not-imported'),
    s('Desktop', 'imported'),
    s('Funion.Client-develop', 'not-imported'),
    s(null, 'archived'),
  ]
  assert.equal(importableSessions(items, '').length, 2)
  assert.equal(importableSessions(items, 'Desktop').length, 1)
  assert.equal(importableSessions(items, 'Funion.Client-develop')[0].project, 'Funion.Client-develop')
})

test('refreshableSessions：仅已导入，且受工作区筛选约束', () => {
  const items = [
    s('Desktop', 'imported'),
    s('Desktop', 'not-imported'),
    s('Funion.Client-develop', 'imported'),
  ]
  assert.equal(refreshableSessions(items, '').length, 2)
  assert.equal(refreshableSessions(items, 'Desktop').length, 1)
})
