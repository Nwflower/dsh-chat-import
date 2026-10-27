import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply } from '../lib/index.mjs'
import { discoverSessions, clearScanCache } from '../lib/discovery.mjs'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'
import { memoryHost, withDirs } from './_support/discovery-host.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { copilotCliConversation, copilotCliEvent, copilotCliJsonl, COPILOT_CLI_TIME as TS, COPILOT_CLI_SESSION } from './_support/copilot-cli.mjs'

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('copilot-cli-home-')
  clearScanCache()
})

const CWD = process.platform === 'win32' ? 'D:/copilot-cli' : '/home/copilot-cli'
const ROOT = join(CWD, '.copilot', 'session-state')
const SESSION_DIR = join(ROOT, COPILOT_CLI_SESSION)
const PATH = join(SESSION_DIR, 'events.jsonl')

function setup(events = copilotCliConversation()) {
  const tree = {
    [CWD]: 'dir', [ROOT]: 'dir', [SESSION_DIR]: 'dir',
    [PATH]: copilotCliJsonl(events),
  }
  const result = makeCtx(tree)
  apply(result.ctx)
  return { ...result, tree, def: chatDef(result.ctx, 'copilot-cli') }
}

test('Copilot CLI public preview shows the conversation and writes no session', async () => {
  const { def, persistence } = setup()
  const value = await def.execute({ path: PATH, preview: true })
  assert.equal(value.mode, 'single')
  assert.equal(value.preview, true)
  assert.equal(value.turns, 2)
  assert.equal(value.toolCalls, 1)
  assert.equal(persistence.sessions.size, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

for (const version of [3, 4]) {
  test('Copilot CLI public import preserves identity, workspace, source times and valid V' + version + ' envelopes', async () => {
    const { def, ctx, persistence, attached } = setup()
    ctx.sessionPersistence.formatVersion = version
    const value = await def.execute({ path: PATH })
    assert.equal(value.mode, 'single')
    assert.equal(value.turns, 2)
    assert.equal(value.toolCalls, 1)
    assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
    const saved = persistence.sessions.get(value.sessionId)
    assert.equal(saved.meta.createdAt, TS)
    assert.equal(saved.meta.cwd, '/home/example/project')
    assert.equal(saved.meta.version, version)
    assertEnvelopeHygiene(saved.events)
    assert.equal(attached.length, 1)
    const again = await def.execute({ path: PATH })
    assert.equal(again.alreadyImported, true)
    assert.equal(persistence.sessions.size, 1)
  })
}

test('Copilot CLI source growth appends to an untouched imported session', async () => {
  const { def, ctx, persistence } = setup()
  const first = await def.execute({ path: PATH })
  const grown = copilotCliConversation()
  grown.splice(9, 0,
    copilotCliEvent('e-user3', 'e-asst3', 7500, 'user.message', { content: 'Another question', messageId: 'm6', turnId: 't3' }),
    copilotCliEvent('e-asst4', 'e-user3', 8000, 'assistant.message', { messageId: 'm7', originatingMessageId: 'm6', content: 'Another answer', turnId: 't3' }),
  )
  await ctx.fs.writeText(await ctx.fs.resolve(PATH), copilotCliJsonl(grown))
  const second = await def.execute({ path: PATH })
  assert.equal(second.status, 'appended')
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(second.appendedTurns, 1)
  assert.equal(persistence.sessions.size, 1)
  assertEnvelopeHygiene(persistence.sessions.get(first.sessionId).events)
})

test('Copilot CLI directory import collects event streams and ignores sidecars', async () => {
  const { def, ctx, persistence, tree } = setup()
  const second = join(ROOT, '22222222-2222-3333-4444-555555555555', 'events.jsonl')
  const conversation = copilotCliConversation().map((e) => e.id === 'e-start'
    ? { ...e, data: { ...e.data, sessionId: '22222222-2222-3333-4444-555555555555' } } : e)
  tree[join(ROOT, '22222222-2222-3333-4444-555555555555')] = 'dir'
  await ctx.fs.writeText(await ctx.fs.resolve(second), copilotCliJsonl(conversation))
  await ctx.fs.writeText(await ctx.fs.resolve(join(ROOT, '22222222-2222-3333-4444-555555555555', 'workspace.yaml')), 'cwd: /elsewhere\n')
  const value = await def.execute({ path: ROOT })
  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.equal(value.skipped, 0)
  assert.equal(persistence.sessions.size, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('Copilot CLI missing-data counts reach the public schema and render', async () => {
  const events = copilotCliConversation()
  const complete = events.find((e) => e.type === 'tool.execution_complete')
  delete complete.data.result
  const { def } = setup(events)
  const value = await def.execute({ path: PATH })
  assert.equal(value.missingToolOutputs, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  const rendered = JSON.stringify(def.output.render({ format: 'copilot-cli' }, value))
  assert.match(rendered, /源未保存工具结果/)
})

test('Copilot CLI compaction import writes a native checkpoint and fullHistory keeps the surface', async () => {
  const events = copilotCliConversation()
  events.splice(7, 0, copilotCliEvent('e-compact', 'e-hook', 4800, 'session.compaction_complete', {
    summaryContent: 'Earlier we inspected the example.', checkpointNumber: 1,
  }))
  const { def, persistence } = setup(events)
  const value = await def.execute({ path: PATH })
  const saved = persistence.sessions.get(value.sessionId)
  assert.ok(saved.events.some((e) => e.type === 'compaction/summary'))
  assertEnvelopeHygiene(saved.events)
  const { def: def2, persistence: persistence2 } = setup(events)
  const full = await def2.execute({ path: PATH, fullHistory: true })
  const fullSaved = persistence2.sessions.get(full.sessionId)
  assert.ok(!fullSaved.events.some((e) => e.type.startsWith('compaction/')))
  assertEnvelopeHygiene(fullSaved.events)
})

for (const sep of ['/', '\\']) {
  test('Copilot CLI discovery reads session metadata with ' + sep + ' paths', async () => {
    const root = ['home', 'example', '.copilot', 'session-state'].join(sep)
    const file = root + sep + ['abc-123', 'events.jsonl'].join(sep)
    const files = withDirs(root, new Map([
      [file, { type: 'file', text: copilotCliJsonl(copilotCliConversation()), mtimeMs: TS + 900 }],
      [root + sep + 'abc-123' + sep + 'workspace.yaml', { type: 'file', text: 'cwd: /nowhere\n' }],
      [root + sep + 'abc-123' + sep + 'checkpoints' + sep + '1.json', { type: 'file', text: '{}' }],
      [root + sep + 'unrelated.jsonl', { type: 'file', text: '{"type":"session.info"}' }],
    ]))
    const result = await discoverSessions({ path: root, format: 'copilot-cli', host: memoryHost(files), imports: {} })
    assert.equal(result.total, 1)
    const entry = result.sessions[0]
    assert.equal(entry.sessionId, COPILOT_CLI_SESSION)
    assert.equal(entry.title, 'Inspect the example')
    assert.equal(entry.cwd, '/home/example/project')
    assert.equal(entry.project, 'project')
    assert.equal(entry.createdAt, TS)
    assert.equal(entry.lastActiveAt, TS + 900)
    assert.equal(entry.sourcePath, file)
    const direct = await discoverSessions({ path: file, host: memoryHost(files), imports: {} })
    assert.equal(direct.total, 1)
    assert.equal(direct.sessions[0].format, 'copilot-cli')
  })
}

test('Copilot CLI discovery ignores foreign and broken streams', async () => {
  const root = '/home/example/.copilot/session-state'
  const files = withDirs(root, new Map([
    [root + '/broken/events.jsonl', { type: 'file', text: '{' }],
    [root + '/empty/events.jsonl', { type: 'file', text: '' }],
    [root + '/foreign/events.jsonl', { type: 'file', text: copilotCliJsonl([copilotCliEvent('e1', null, 0, 'session.info', {})]) }],
  ]))
  const host = memoryHost(files)
  assert.equal((await discoverSessions({ path: root, format: 'copilot-cli', host, imports: {} })).total, 0)
  assert.equal((await discoverSessions({ path: root + '/absent', format: 'copilot-cli', host, imports: {} })).total, 0)
})

test('Copilot CLI single-file import outside session-state works via explicit format', async () => {
  const { def, ctx, persistence } = setup()
  const copied = join(CWD, 'exported.jsonl')
  await ctx.fs.writeText(await ctx.fs.resolve(copied), copilotCliJsonl(copilotCliConversation()))
  const value = await def.execute({ path: copied })
  assert.equal(value.mode, 'single')
  assert.equal(value.turns, 2)
  assert.equal(persistence.sessions.size, 1)
})

test('Copilot CLI degradation counters reach the public result and render', async () => {
  const events = copilotCliConversation()
  events.push(copilotCliEvent('e-unknown', 'e-end', 8000, 'brand.new.event', {}))
  const { def } = setup(events)
  const value = await def.execute({ path: PATH })
  // 未知事件类型与未导入附件都必须在工具结果里可见（失败要大声）
  assert.equal(value.unknownEvents, 1)
  assert.equal(value.droppedAttachments, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  const rendered = JSON.stringify(def.output.render({ format: 'copilot-cli' }, value))
  assert.match(rendered, /未知事件/)
  assert.match(rendered, /未导入附件/)
})

test('Copilot CLI discovery normalizes long multi-line prompts into the source title', async () => {
  const root = '/home/example/.copilot/session-state'
  const file = root + '/abc-long/events.jsonl'
  const events = copilotCliConversation()
  events.find((e) => e.type === 'user.message').data.content = 'Line one\n' + 'x'.repeat(240)
  const files = withDirs(root, new Map([[file, { type: 'file', text: copilotCliJsonl(events), mtimeMs: TS }]]))
  const result = await discoverSessions({ path: root, format: 'copilot-cli', host: memoryHost(files), imports: {} })
  assert.equal(result.total, 1)
  assert.ok(result.sessions[0].title.length <= 80, 'title 与导入侧同口径（≤80 字符）')
  assert.ok(!result.sessions[0].title.includes('\n'))
})
