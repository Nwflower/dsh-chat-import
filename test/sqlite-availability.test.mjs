// test/sqlite-availability.test.mjs — node:sqlite 缺席时的行为契约
//
// 单独成文件：node --test 每个测试文件一个进程，这里需要模块级 DatabaseSync 缓存
// 尚未被真实加载填充的干净状态（同文件内先跑过 SQLite 用例后，mock 就不再生效）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('node:sqlite 缺席：openReadOnly 大声报错，readOptionalDb 不吞成「无此库」', async (t) => {
  t.mock.method(process, 'getBuiltinModule', () => undefined)
  const { openReadOnly, readOptionalDb } = await import('../lib/sources/sqlite.mjs')
  assert.throws(() => openReadOnly('x.db'), (err) => {
    assert.equal(err.code, 'DSH_SQLITE_UNAVAILABLE')
    return true
  })
  assert.throws(() => readOptionalDb('x.db', () => null), (err) => {
    assert.equal(err.code, 'DSH_SQLITE_UNAVAILABLE')
    return true
  })
})
