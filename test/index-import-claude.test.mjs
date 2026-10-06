// index-import-claude.test.mjs — Claude 集成（标准来源入口）
// 单文件与目录批量落盘、标题（custom-title）、幂等、工具历史、辅助 transcript 跳过。
// 由 test/index.test.mjs 按横幅分组拆出（纯移动：用例与断言未改）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { resolveRegistryDir, loadImports } from '../lib/imports.mjs'
import { hostAbs } from './_support/host-path.mjs'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { clearScanCache } from '../lib/discovery.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'
import { loadHostFixture as load } from './_support/fixtures.mjs'

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
})

test('单文件导入：落盘、归组、返回值符合 schema', async () => {
  const simple = load('sess-simple-001.jsonl')
  const { ctx, persistence, attached } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple })
  apply(ctx)
  const def = ctx.tools.register.calls ?? chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-sess-simple-001')
  assert.equal(value.turns, 1)
  assert.equal(value.messages, 2)
  assert.equal(value.toolCalls, 0)
  assert.equal(value.alreadyImported, false)

  // 输出 schema 校验通过（含 turns 为 integer 而非数组）
  const violations = validateJsonSchemaValue(def.output.schema, value)
  assert.deepEqual(violations, [])

  // 落盘：meta + 平衡事件（归属外置 registry，日志无标记——issue #34）
  const saved = persistence.sessions.get('import-sess-simple-001')
  assert.ok(saved)
  assert.equal(saved.meta.cwd, hostAbs('D:/demo/proj'))
  assert.equal(saved.events.at(-1).type, 'session/title')
  assert.match(saved.events.at(-1).data.title, /^Claude · /)
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assertEnvelopeHygiene(saved.events)

  // 归组
  assert.equal(attached.length, 1)
  assert.equal(attached[0].id, 'import-sess-simple-001')
})

test('单文件导入：Claude custom-title（/rename）成为「Claude · 自定义标题」', async () => {
  const file = 'D:\\demo\\proj\\sess-rename-001.jsonl'
  const raw = [
    JSON.stringify({ sessionId: 'sess-rename-001', type: 'user', cwd: hostAbs('D:/demo/proj'), message: { role: 'user', content: '第一个问题' } }),
    JSON.stringify({ sessionId: 'sess-rename-001', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '回答' }] } }),
    JSON.stringify({ sessionId: 'sess-rename-001', type: 'ai-title', aiTitle: 'AI 生成的标题' }),
    JSON.stringify({ sessionId: 'sess-rename-001', type: 'custom-title', customTitle: '我自己起的标题' }),
  ].join('\n')
  const { ctx, persistence } = makeCtx({ [file]: raw })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: file })
  assert.equal(value.sessionId, 'import-sess-rename-001')
  // 自定义标题（而非 ai-title / 首问）落成落盘会话的标题事件——DSH 列表显示的就是它
  const saved = persistence.sessions.get('import-sess-rename-001')
  assert.ok(saved)
  assert.equal(saved.events.at(-1).type, 'session/title')
  assert.equal(saved.events.at(-1).data.title, 'Claude · 我自己起的标题')
  // dry-run 预览同源（转换层标题）
  const preview = await def.execute({ path: file, preview: true })
  assert.equal(preview.title, '我自己起的标题')
})

test('幂等：重复导入同一文件返回 alreadyImported 且不重复落盘', async () => {
  const simple = load('sess-simple-001.jsonl')
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const first = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(first.alreadyImported, false)
  assert.equal(second.alreadyImported, true)
  assert.equal(persistence.sessions.size, 1)
})

test('REQ-55 归档重导：目标会话归档后重导建后缀新副本，归档会话保留、记录指向新副本', async () => {
  const simple = load('sess-simple-001.jsonl')
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\proj\\sess-simple-001.jsonl': simple })
  apply(ctx)
  const def = chatDef(ctx, 'claude')

  const first = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(first.sessionId, 'import-sess-simple-001')

  // 归档目标会话（DSH UI 的归档 = workspaceRegistry 全局归档集；会话仍在持久化里）
  const wr = ctx.get('workspaceRegistry')
  await wr.archiveSession('import-sess-simple-001')

  // 重导：不再视为已导入——建后缀新副本（import-<id>-1），旧归档会话原样保留
  const second = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(second.status, 'imported')
  assert.equal(second.alreadyImported, false)
  assert.equal(second.sessionId, 'import-sess-simple-001-1')
  assert.equal(persistence.sessions.size, 2)
  assert.ok(persistence.sessions.has('import-sess-simple-001'))
  assert.ok(persistence.sessions.has('import-sess-simple-001-1'))

  // registry 记录指向新副本（原归档会话不再被记录追踪）
  const registry = (await loadImports(resolveRegistryDir())).imports
  assert.equal(registry['D:\\demo\\proj\\sess-simple-001.jsonl'].dshId, 'import-sess-simple-001-1')

  // 新副本再导入 → 幂等 already-imported（不重复建副本）
  const third = await def.execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(third.alreadyImported, true)
  assert.equal(third.sessionId, 'import-sess-simple-001-1')
  assert.equal(persistence.sessions.size, 2)
})

test('单文件导入工具历史：tool/result 带 sourceEventSeqs', async () => {
  const { ctx } = makeCtx({ 'D:\\demo\\proj\\sess-tool-001.jsonl': load('sess-tool-001.jsonl') })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj\\sess-tool-001.jsonl' })
  assert.equal(value.mode, 'single')
  assert.equal(value.toolCalls, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('目录批量导入：扫描 .jsonl、逐文件独立会话、跳过非 transcript、汇总符合 schema', async () => {
  const tree = {
    'D:\\demo\\proj': 'dir',
    'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl'),
    'D:\\demo\\proj\\sess-tool-001.jsonl': load('sess-tool-001.jsonl'),
    'D:\\demo\\proj\\notes.txt': 'not a transcript',
    'D:\\demo\\proj\\sub': 'dir',
    'D:\\demo\\proj\\sub\\sess-title-001.jsonl': load('sess-title-001.jsonl'),
  }
  const { ctx, persistence, attached } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 3) // a/b/c 三个 .jsonl（notes.txt 被过滤）
  assert.equal(value.imported, 3)
  assert.equal(value.alreadyImported, 0)
  assert.equal(value.failed, 0)
  assert.equal(value.results.length, 3)
  const ids = value.results.map((r) => r.sessionId).sort()
  assert.deepEqual(ids, ['import-sess-simple-001', 'import-sess-title-001', 'import-sess-tool-001'])

  // 每个会话独立落盘 + 归组
  assert.equal(persistence.sessions.size, 3)
  assert.equal(attached.length, 3)

  // 逐文件的归属在 imports registry（目录模式每个文件一个源路径）；日志无标记（issue #34）
  assertEnvelopeHygiene(persistence.sessions.get('import-sess-simple-001').events)
  assertEnvelopeHygiene(persistence.sessions.get('import-sess-tool-001').events)
  assertEnvelopeHygiene(persistence.sessions.get('import-sess-title-001').events)

  // 输出 schema 校验
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('目录批量导入：递归参数（false 时不进子目录）', async () => {
  const tree = {
    'D:\\demo\\proj': 'dir',
    'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl'),
    'D:\\demo\\proj\\sub': 'dir',
    'D:\\demo\\proj\\sub\\sess-title-001.jsonl': load('sess-title-001.jsonl'),
  }
  const { ctx } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj', recursive: false })
  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 1) // 只扫顶层 sess-simple-001.jsonl
  assert.deepEqual(value.results.map((r) => r.sessionId), ['import-sess-simple-001'])
})

test('目录批量导入：已存在会话计入 alreadyImported', async () => {
  const tree = {
    'D:\\demo\\proj': 'dir',
    'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl'),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  await def.execute({ path: 'D:\\demo\\proj' })
  const second = await def.execute({ path: 'D:\\demo\\proj' })
  assert.equal(second.mode, 'batch')
  assert.equal(second.imported, 0)
  assert.equal(second.alreadyImported, 1)
  assert.equal(persistence.sessions.size, 1)
})

test('批量导入：空文件/无内容文件计入 skipped 而非 failed', async () => {
  const tree = {
    'D:\\demo\\proj': 'dir',
    'D:\\demo\\proj\\empty.jsonl': '',
  }
  const { ctx } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj' })
  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 1)
  assert.equal(value.skipped, 1)
  assert.equal(value.results[0].status, 'skipped')
})

test('目录批量导入：subagent 辅助 transcript 跳过，主 transcript 完整导入', async () => {
  // Claude Code 项目目录：<sessionId>.jsonl 主 transcript + <sessionId>/subagents/agent-*.jsonl
  // 辅助 transcript（记录携带父 sessionId）。辅助文件不得建会话（否则与主 transcript 撞 id、
  // 先扫描者胜导致主内容丢失），只导入主 transcript。
  const tree = {
    'D:\\demo\\proj': 'dir',
    'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl'),
    'D:\\demo\\proj\\sess-simple-001': 'dir',
    'D:\\demo\\proj\\sess-simple-001\\subagents': 'dir',
    'D:\\demo\\proj\\sess-simple-001\\subagents\\agent-abc123.jsonl': load('sess-simple-001.jsonl'),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 1)
  assert.equal(value.skipped, 1)
  assert.equal(value.failed, 0)
  const skipped = value.results.find((r) => r.status === 'skipped')
  assert.ok(skipped)
  assert.ok(skipped.reason.includes('auxiliary'))
  assert.ok(skipped.path.includes('agent-abc123.jsonl'))
  // 只有主 transcript 落盘，且内容完整（user + assistant 各 1）
  assert.equal(persistence.sessions.size, 1)
  const saved = persistence.sessions.get('import-sess-simple-001')
  assert.ok(saved)
  assert.equal(saved.events.filter((e) => e.type === 'user/message' && e.data.source.kind === 'user').length, 1)
  assert.equal(saved.events.filter((e) => e.type === 'assistant/message').length, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('单文件导入辅助 transcript：跳过并返回 skipReason', async () => {
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\proj\\agent-abc123.jsonl': load('sess-simple-001.jsonl') })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: 'D:\\demo\\proj\\agent-abc123.jsonl' })
  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'none')
  assert.equal(value.turns, 0)
  assert.equal(value.skipped, 1)
  assert.ok(value.skipReason.includes('auxiliary'))
  assert.equal(persistence.sessions.size, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})
