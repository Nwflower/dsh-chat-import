// sidebar-compat.test.mjs — dsh-better-sidebar 版本兼容纯函数
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { supportsPathlessTabOpen, importTabSeed } from '../lib/sidebar-compat.mjs'

test('supportsPathlessTabOpen：>= 0.19 为真（seed.path 已变成工作区资源地址）', () => {
  assert.equal(supportsPathlessTabOpen('0.19.0'), true)
  assert.equal(supportsPathlessTabOpen('0.19.1'), true)
  assert.equal(supportsPathlessTabOpen('0.20.0'), true)
  assert.equal(supportsPathlessTabOpen('v0.19.1'), true)
  assert.equal(supportsPathlessTabOpen('1.0.0'), true)
})

test('supportsPathlessTabOpen：< 0.19 为假（只有带 path / url 才自动展开面板）', () => {
  assert.equal(supportsPathlessTabOpen('0.18.1'), false)
  assert.equal(supportsPathlessTabOpen('v0.18.1'), false)
  assert.equal(supportsPathlessTabOpen('0.12.0'), false)
  assert.equal(supportsPathlessTabOpen('0.0.1'), false)
})

test('supportsPathlessTabOpen：版本缺失 / 非语义化按支持处理（默认落在不报错的一侧）', () => {
  for (const version of [undefined, null, '', 'latest', '0.19', 42, {}]) {
    assert.equal(supportsPathlessTabOpen(version), true, String(version))
  }
})

test('importTabSeed：按服务版本给出 openTab 的 seed', () => {
  assert.deepEqual(importTabSeed('chat-import', '0.19.1'), { type: 'chat-import' })
  assert.deepEqual(importTabSeed('chat-import', '0.18.1'), { type: 'chat-import', path: 'chat-import' })
  assert.deepEqual(importTabSeed('chat-import', undefined), { type: 'chat-import' })
})
