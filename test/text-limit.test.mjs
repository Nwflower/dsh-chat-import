// text-limit.test.mjs — 整读文本前的 V8 单字符串上限保护；用放大的 stat 夹具，不分配巨型字符串。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { constants } from 'node:buffer'
import { importTranscript, previewTranscript, previewDirectory } from '../lib/import-core.mjs'
import { previewFileTarget, importFileTarget } from '../lib/file-import.mjs'
import { makeCtx } from './_support/fake-host.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'

const LIMIT = constants.MAX_STRING_LENGTH
const path = 'D:/demo/oversized.jsonl'
const target = { targetKey: path, displayPath: path }
const emptyConversion = () => ({ meta: null, events: [], turns: [], messages: 0, toolCalls: 0 })

function oversizedCtx() {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  const host = makeCtx({ [path]: '{"type":"user"}\n' }, { real: false })
  const stat = host.ctx.fs.stat
  host.ctx.fs.stat = async (candidate) => {
    const base = await stat(candidate)
    return candidate.targetKey === path && base?.type === 'file' ? { ...base, size: LIMIT + 1 } : base
  }
  return host
}

function assertFriendlyLimit(error) {
  assert.match(error.message, /文件过大/)
  assert.match(error.message, /512 MiB/)
  assert.ok(!error.message.includes('Cannot create a string longer than'))
  return true
}

test('正式导入在整读前拒绝超过 V8 单字符串上限的文件', async () => {
  const { ctx, reads } = oversizedCtx()
  await assert.rejects(
    importTranscript(ctx, target, {}, emptyConversion, { registryDir: process.env.DSH_HOME }),
    assertFriendlyLimit,
  )
  assert.equal(reads.count, 0, '不得尝试把超限文件读成一个字符串')
})

test('单文件预览与正式导入共用同一个友好上限错误', async () => {
  const { ctx, reads } = oversizedCtx()
  await assert.rejects(previewTranscript(ctx, target, {}, emptyConversion), assertFriendlyLimit)
  assert.equal(reads.count, 0)
})

test('目录预览的每个超限条目也跳过整读并报告失败', async () => {
  const { ctx, reads } = oversizedCtx()
  const out = await previewDirectory(ctx, { targetKey: 'D:/demo', displayPath: 'D:/demo' }, {}, {
    convert: emptyConversion,
    collect: async (_ctx, _dir, files) => files.push(target),
  })
  assert.equal(out.results.length, 1)
  assert.equal(out.results[0].status, 'failed')
  assert.match(out.results[0].error, /文件过大/)
  assert.equal(reads.count, 0)
})

test('面板从文件预览同样在上限处停止，不泄露 V8 内部错误', async () => {
  const { ctx, reads } = oversizedCtx()
  const out = await previewFileTarget(ctx, { path })
  assert.equal(out.ok, true)
  assert.equal(out.status, 'failed')
  assert.match(out.error, /文件过大/)
  assert.equal(reads.count, 0)
})

test('从文件导入的 bundle 判型读头之前也执行上限检查', async () => {
  const jsonPath = 'D:/demo/oversized.json'
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  const host = makeCtx({ [jsonPath]: '{}' }, { real: false })
  host.ctx.fs.stat = async () => ({ type: 'file', size: LIMIT + 1, version: 'oversized' })
  await assert.rejects(importFileTarget(host.ctx, { path: jsonPath }), assertFriendlyLimit)
  assert.equal(host.reads.count, 0)
})
