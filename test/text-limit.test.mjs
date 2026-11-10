// text-limit.test.mjs — 整读文本前的 V8 单字符串上限保护；用放大的 stat 夹具，不分配巨型字符串。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { constants } from 'node:buffer'
import { importTranscript, previewTranscript, previewDirectory, assertTextReadLimit } from '../lib/import-core.mjs'
import { previewFileTarget, importFileTarget } from '../lib/file-import.mjs'
import { importCodexChain, importCodexFile, previewCodexFile } from '../lib/sources/codex.mjs'
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

test('上限检查允许边界值与未知大小，只拒绝明确超限的文件', () => {
  assert.doesNotThrow(() => assertTextReadLimit({ type: 'file', size: LIMIT }, path))
  assert.doesNotThrow(() => assertTextReadLimit({ type: 'file', size: Number.NaN }, path))
  assert.doesNotThrow(() => assertTextReadLimit(undefined, path))
  assert.throws(() => assertTextReadLimit({ type: 'file', size: LIMIT + 1 }, path), assertFriendlyLimit)
})

const codexPath = 'D:/demo/rollout-2026-11-07T01-02-03-12345678-1234-1234-1234-123456789abc.jsonl'

function codexCtx(sizes) {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  const paths = Object.keys(sizes)
  const host = makeCtx(Object.fromEntries(paths.map((p) => [p, '{"type":"user"}\n'])), { real: false })
  const stat = host.ctx.fs.stat
  host.ctx.fs.stat = async (candidate) => {
    const base = await stat(candidate)
    return Object.hasOwn(sizes, candidate.targetKey) ? { ...base, type: 'file', size: sizes[candidate.targetKey] } : base
  }
  return host
}

test('Codex 单页链在读取前拒绝超限 rollout', async () => {
  const { ctx, reads } = codexCtx({ [codexPath]: LIMIT + 1 })
  await assert.rejects(importCodexChain(ctx, [{ path: codexPath, name: codexPath.split('/').pop() }], {}, {
    registryDir: process.env.DSH_HOME,
  }), assertFriendlyLimit)
  assert.equal(reads.count, 0)
})

test('Codex 多页各自合规但 join 后超限时，在任何读取前拒绝', async () => {
  const second = codexPath.replace('.jsonl', '_87654321-4321-4321-4321-cba987654321.jsonl')
  const { ctx, reads } = codexCtx({ [codexPath]: LIMIT, [second]: 1 })
  await assert.rejects(importCodexChain(ctx, [
    { path: codexPath, name: codexPath.split('/').pop() },
    { path: second, name: second.split('/').pop() },
  ], {}, { registryDir: process.env.DSH_HOME }), assertFriendlyLimit)
  assert.equal(reads.count, 0, '逐页检查之后还必须检查换行分隔符在内的总预算')
})

test('Codex 无 UUID 文件的单文件预览 fallback 也先检查大小', async () => {
  const { ctx, reads } = oversizedCtx()
  await assert.rejects(previewCodexFile(ctx, target, {}), assertFriendlyLimit)
  assert.equal(reads.count, 0)
})

test('Codex 无 streamText 的读头回退不会先整读超限文件', async () => {
  const { ctx, reads } = codexCtx({ [codexPath]: LIMIT + 1 })
  await assert.rejects(importCodexFile(ctx, { targetKey: codexPath, displayPath: codexPath }, {}, {
    registryDir: process.env.DSH_HOME,
  }), assertFriendlyLimit)
  assert.equal(reads.count, 0)
})
