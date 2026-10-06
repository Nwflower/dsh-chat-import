// test/restore-schema.test.mjs — restore_bundle 的返回值恒符合它自己的输出 schema
//
// 还原复用导入状态机（lib/restore.mjs → import-state 的「源未变」短路径 + decideSingle +
// runDecision），所以状态机能产出的决策层字段（参数 / 预算变化跳过、图片落地计数、增量续写、
// 原生压缩检查点……）都会出现在还原结果里；输出 schema 是 additionalProperties:false 的，
// 少声明一个，宿主就会把一次成功的还原判成「返回值不合 schema」。这里逐个把这些分支跑出来，
// 用工具自己的 schema 校验。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { convertClaudeJsonl } from '../lib/convert/claude.mjs'
import { serializeBundle } from '../lib/export/index.mjs'
import { makeExportTools } from '../lib/tools/export-tools.mjs'
import { loadImports, rememberImport } from '../lib/imports.mjs'
import { makeCtx } from './_support/fake-host.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'

let registryDir

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-restore-')
  registryDir = join(process.env.DSH_HOME, 'dsh-chat-import')
  mkdirSync(registryDir, { recursive: true })
})

// 共享假宿主：树为空，fs 全部回退真实磁盘（bundle 文件）；不给 attachments 服务（图片降级为占位）
function makeHost() {
  const { ctx } = makeCtx({}, { real: true })
  const restore = makeExportTools(ctx, registryDir).find((d) => d.name === 'restore_bundle')
  return { restore }
}

const SID = 'sess-restore-schema'
const user = (text, extra = {}) => ({ sessionId: SID, type: 'user', cwd: tmpdir(), message: { role: 'user', content: text }, ...extra })
const asst = (text) => ({ sessionId: SID, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })

// Claude 转录 → DSH 事件 → bundle 文件（mutate 可在序列化前改事件）
function writeBundle(path, records, mutate) {
  const conv = convertClaudeJsonl(records.map((r) => JSON.stringify(r)).join('\n'), { fileStem: SID })
  if (mutate) mutate(conv.events)
  writeFileSync(path, JSON.stringify(serializeBundle({ meta: conv.meta, events: conv.events, sourceSessionId: SID })))
  return path
}

function bundlePath() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-restore-bundle-')), SID + '.dshbundle.json')
}

// 给第一条 user/message 追加一个图片块
const withImage = (block) => (events) => {
  const ev = events.find((e) => e.type === 'user/message')
  ev.data.content = [...ev.data.content, block]
}

function assertValid(restore, value) {
  assert.deepEqual(validateJsonSchemaValue(restore.output.schema, value), [], JSON.stringify(value))
}

test('预算变化跳过：budgetChanged 在 schema 内', async () => {
  const { restore } = makeHost()
  const path = writeBundle(bundlePath(), [user('问题'), asst('回答')])
  assertValid(restore, await restore.execute({ path, budget: 100000 }))
  const again = await restore.execute({ path, budget: 200000 })
  assert.equal(again.budgetChanged, true)
  assertValid(restore, again)
})

test('参数指纹变化跳过：argsChanged 在 schema 内', async () => {
  const { restore } = makeHost()
  const path = writeBundle(bundlePath(), [user('问题'), asst('回答')])
  assert.equal((await restore.execute({ path })).status, 'imported')
  // registry 里的记录是按另一组参数指纹写下的（例如旧版本的记录）
  const record = (await loadImports(registryDir)).imports[path]
  await rememberImport(registryDir, path, { ...record, args: JSON.stringify([['legacy', true]]) })
  const again = await restore.execute({ path })
  assert.equal(again.argsChanged, true)
  assertValid(restore, again)
})

test('图片：已是附件引用的块计入 images', async () => {
  const { restore } = makeHost()
  const ref = { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', width: 1, height: 1, bytes: 68, name: 'shot.png' }
  const path = writeBundle(bundlePath(), [user('看图'), asst('看到了')], withImage({ type: 'image', attachment: ref }))
  const value = await restore.execute({ path })
  assert.equal(value.images, 1)
  assertValid(restore, value)
})

test('图片：宿主没有附件服务时降级为占位并计入 imagesDegraded', async (t) => {
  t.mock.method(console, 'error', () => {})
  const { restore } = makeHost()
  const path = writeBundle(bundlePath(), [user('看图'), asst('看到了')], withImage({ type: 'image', data: 'iVBORw0KGgo=', mediaType: 'image/png' }))
  const value = await restore.execute({ path })
  assert.equal(value.imagesDegraded, 1)
  assertValid(restore, value)
})

test('bundle 增长且会话未被续聊：增量续写的 appendedTurns / appendedEvents 在 schema 内', async () => {
  const { restore } = makeHost()
  const path = bundlePath()
  writeBundle(path, [user('问题1'), asst('回答1')])
  assert.equal((await restore.execute({ path })).status, 'imported')
  writeBundle(path, [user('问题1'), asst('回答1'), user('问题2'), asst('回答2')])
  const value = await restore.execute({ path })
  assert.equal(value.status, 'appended')
  assert.equal(value.appendedTurns, 1)
  assert.ok(value.appendedEvents > 0)
  assertValid(restore, value)
})

test('预览：结果带会话 cwd，仍在 schema 内', async () => {
  const { restore } = makeHost()
  const path = writeBundle(bundlePath(), [user('问题'), asst('回答')])
  const preview = await restore.execute({ path, preview: true })
  assert.equal(preview.preview, true)
  assert.equal(preview.cwd, tmpdir())
  assertValid(restore, preview)
})

test('会话没有 cwd 的 bundle：originalCwd / landingHint 不占键（不以 null 透出），还原与预览都在 schema 内', async () => {
  const { restore } = makeHost()
  const bare = (text) => ({ sessionId: SID, type: 'user', message: { role: 'user', content: text } })
  const path = writeBundle(bundlePath(), [bare('问题'), asst('回答')])
  const preview = await restore.execute({ path, preview: true })
  assert.equal('originalCwd' in preview, false)
  assert.equal('landingHint' in preview, false)
  assertValid(restore, preview)
  const value = await restore.execute({ path })
  assert.equal(value.status, 'imported')
  assert.equal('originalCwd' in value, false)
  assert.equal(value.cwdAvailable, false)
  assertValid(restore, value)
})

test('带原生压缩检查点的会话：compacted / compactions 在 schema 内', async () => {
  const { restore } = makeHost()
  const summary = 'This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. 要点'
  const path = writeBundle(bundlePath(), [
    user('问题1'), asst('回答1'),
    { sessionId: SID, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' },
    user(summary, { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    user('问题2'), asst('回答2'),
  ])
  const value = await restore.execute({ path })
  assert.equal(value.compacted, true)
  assert.equal(value.compactions, 1)
  assertValid(restore, value)
})

test('畸形 bundle 的解析错误不外泄文档片段（V8 报错内嵌原文，统一走 sanitizeParseError）', async () => {
  const { restore } = makeHost()
  const path = bundlePath()
  // secret 放在文档开头：未净化的 V8 报错（Unexpected token 'a', "api_key=sk"…）会把片段带进错误消息
  writeFileSync(path, 'api_key=sk-secret-1234567890abcdef 不是合法 JSON')
  await assert.rejects(restore.execute({ path }), (err) => {
    assert.match(String(err.message), /bundle 解析失败/)
    assert.ok(!String(err.message).includes('api_key'), '错误消息不得回显 bundle 内容片段: ' + err.message)
    return true
  })
})
