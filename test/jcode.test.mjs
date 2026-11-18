// jcode.test.mjs — jcode 源转换核心单元测试 + import_chat 集成 + 发现层
// 自包含合成数据；假宿主见 _support/fake-host.mjs。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { SESSION_FORMAT_VERSION } from '../lib/convert/core.mjs'
import { convertJcodeJson } from '../lib/convert/jcode.mjs'
import { apply } from '../lib/index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { clearScanCache, discoverSessions } from '../lib/discovery.mjs'
import { memoryHost, FAKE_HOME as HOME, j } from './_support/discovery-host.mjs'
import { assertMessageOrderLegal, assertSeqContinuity, assertToolPairing } from './_support/session-invariants.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
})

// 1x1 PNG（合法宿主图片类型的最小载荷）。
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function jcodeSession(overrides = {}) {
  return {
    id: 'session_fox_1781700000000_abc123',
    parent_id: null,
    title: null,
    short_name: 'fox',
    created_at: '2026-06-01T10:00:00.000000000Z',
    updated_at: '2026-06-01T10:05:00.000000000Z',
    working_dir: '/home/dev/proj',
    provider_key: 'deepseek',
    model: 'deepseek-v4.1-flash',
    messages: [],
    ...overrides,
  }
}

function msg(role, content, extra = {}) {
  return { role, content, timestamp: extra.timestamp ?? '2026-06-01T10:01:00.000000000Z', ...extra }
}

const BASIC_SESSION = jcodeSession({
  messages: [
    msg('user', [{ type: 'text', text: '<system-reminder>\n# Session Context\nDate: 2026-06-01' }], {
      display_role: 'system', timestamp: '2026-06-01T10:00:00.000000000Z',
    }),
    msg('user', [{ type: 'text', text: '帮我修一下构建' }], { timestamp: '2026-06-01T10:01:00.000000000Z' }),
    msg('assistant', [
      { type: 'text', text: '我看下' },
      { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'pnpm build' } },
    ], { timestamp: '2026-06-01T10:02:00.000000000Z', token_usage: { input_tokens: 100, output_tokens: 20 } }),
    msg('user', [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }], {
      timestamp: '2026-06-01T10:03:00.000000000Z',
    }),
    msg('assistant', [{ type: 'text', text: '修好了' }], { timestamp: '2026-06-01T10:04:00.000000000Z' }),
  ],
})

test('convertJcodeJson：system-reminder 跳过、user/assistant/tool 平衡合成、标题用 short_name', () => {
  const raw = JSON.stringify(BASIC_SESSION)
  const out = convertJcodeJson(raw, { sourcePath: '/home/dev/.jcode/sessions/session_fox_1781700000000_abc123.json' })
  const t0 = Date.parse('2026-06-01T10:00:00.000Z')

  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.id, 'import-session_fox_1781700000000_abc123')
  assert.equal(out.meta.cwd, '/home/dev/proj')
  assert.equal(out.meta.createdAt, t0)
  assert.equal(out.turns.length, 1)
  assert.equal(out.skippedInjections, 1)
  assert.equal(out.title, 'fox')

  // 模型可见的 user 消息：真实提问一条（另有合成层注入的环境声明，source.kind=plugin）
  assert.equal(out.events.filter((e) => e.type === 'user/message' && e.data.source && e.data.source.kind === 'user').length, 1)
  const assistant = out.events.find((e) => e.type === 'assistant/message')
  assert.equal(assistant.data.message.content.some((b) => b.type === 'tool-call' && b.name === 'bash'), true)
  const call = assistant.data.message.content.find((b) => b.type === 'tool-call')
  assert.equal(call.arguments, '{"command":"pnpm build"}')
  assert.equal(assistant.data.usage.inputTokens, 100)
  assert.equal(assistant.data.usage.outputTokens, 20)

  assertSeqContinuity(out.events)
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
  assertEnvelopeHygiene(out.events)
})

test('convertJcodeJson：孤儿的 tool_result 丢弃并计数（不伪造调用）', () => {
  const out = convertJcodeJson(JSON.stringify(jcodeSession({
    messages: [
      msg('user', [{ type: 'text', text: '你好' }]),
      msg('assistant', [{ type: 'tool_use', id: 'call_9', name: 'read', input: {} }], { timestamp: '2026-06-01T10:02:00.000000000Z' }),
      msg('user', [{ type: 'tool_result', tool_use_id: 'call_9', content: 'r1' }], { timestamp: '2026-06-01T10:03:00.000000000Z' }),
      msg('user', [{ type: 'tool_result', tool_use_id: 'never_declared', content: 'orphan' }], { timestamp: '2026-06-01T10:04:00.000000000Z' }),
    ],
  })))
  assert.equal(out.droppedToolResults, 1)
  assertToolPairing(out.events)
})

test('convertJcodeJson：空会话与只有 system-reminder 的会话不产出轮次（skipResult）', () => {
  const empty = convertJcodeJson(JSON.stringify(jcodeSession({ messages: [] })))
  assert.equal(empty.meta, null)
  assert.match(empty.skipReason, /no user turn/)
  const reminderOnly = convertJcodeJson(JSON.stringify(jcodeSession({
    messages: [msg('user', [{ type: 'text', text: '<system-reminder>ctx' }], { display_role: 'system' })],
  })))
  assert.equal(reminderOnly.meta, null)
  assert.equal(reminderOnly.skippedInjections, 1)
})

test('convertJcodeJson：标题优先级 title > short_name；displayName 覆盖', () => {
  const titled = convertJcodeJson(JSON.stringify(jcodeSession({
    title: '重构登录模块',
    messages: [msg('user', [{ type: 'text', text: 'hi' }])],
  })))
  assert.equal(titled.title, '重构登录模块')
  const overridden = convertJcodeJson(JSON.stringify(jcodeSession({
    title: '原标题',
    short_name: 'fox',
    messages: [msg('user', [{ type: 'text', text: 'hi' }])],
  })), { displayName: '显式标题' })
  assert.equal(overridden.title, '显式标题')
})

test('convertJcodeJson：贴图提问把图片放进 promptBlocks（待宿主附件落库）', () => {
  const out = convertJcodeJson(JSON.stringify(jcodeSession({
    messages: [msg('user', [
      { type: 'text', text: '看图' },
      { type: 'image', media_type: 'image/png', data: PNG_1PX },
    ])],
  })))
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].prompt, '看图')
  assert.equal(out.turns[0].promptBlocks.some((b) => b.type === 'image' && b.data === PNG_1PX), true)
})

test('import_jcode 单文件：转换、落盘、标题钉住、归组、schema 校验、幂等', async () => {
  const file = '/home/dev/.jcode/sessions/session_fox_1781700000000_abc123.json'
  const tree = { [file]: JSON.stringify(BASIC_SESSION) }
  const { ctx, persistence, attached } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'jcode')
  const value = await def.execute({ path: file })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-session_fox_1781700000000_abc123')
  assert.equal(value.turns, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get('import-session_fox_1781700000000_abc123')
  assert.ok(saved)
  assert.equal(saved.meta.cwd, '/home/dev/proj')
  assert.equal(saved.events.at(-1).type, 'session/title')
  assert.equal(saved.events.at(-1).data.title, 'jcode · fox')
  assert.equal(attached.length, 1)
  assert.equal(attached[0].id, 'import-session_fox_1781700000000_abc123')

  const second = await def.execute({ path: file })
  assert.equal(second.alreadyImported, true)
  assert.equal(persistence.sessions.size, 1)
})

test('import_jcode 目录批量：递归收集 session_*.json，coord.json 等运行文件忽略', async () => {
  const dir = '/home/dev/.jcode/sessions'
  const series = (id, short, text) => JSON.stringify(jcodeSession({
    id,
    short_name: short,
    messages: [msg('user', [{ type: 'text', text }])],
  }))
  const tree = {
    [dir]: 'dir',
    [join(dir, 'session_a_1781700000000_aaaaaaaa.json')]: series('session_a_1781700000000_aaaaaaaa', 'a', '问题一'),
    [join(dir, 'session_b_1781700001000_bbbbbbbb.json')]: series('session_b_1781700001000_bbbbbbbb', 'b', '问题二'),
    [join(dir, 'coord.json')]: '{}',
    [join(dir, 'session_a_1781700000000_aaaaaaaa.json.bak')]: '{}',
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'jcode')
  const value = await def.execute({ path: dir })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.equal(value.failed, 0)
  assert.deepEqual([...persistence.sessions.keys()].sort(), [
    'import-session_a_1781700000000_aaaaaaaa',
    'import-session_b_1781700001000_bbbbbbbb',
  ])
})

test('发现层：~/.jcode/sessions 的 session_*.json 被识别（标题 short_name、项目 cwd）', async () => {
  const root = join(HOME, '.jcode', 'sessions')
  const files = new Map([
    [root, { type: 'dir' }],
    [join(root, 'session_fox_1781700000000_abc123.json'), { type: 'file', text: j(jcodeSession({
      id: 'sess-fox',
      short_name: 'fox',
      messages: [msg('user', [{ type: 'text', text: '问题' }])],
    })) }],
    [join(root, 'session_bat_1781700001000_abcdef.json'), { type: 'file', text: j(jcodeSession({
      id: 'sess-bat',
      title: '带标题的会话',
      short_name: 'bat',
      messages: [msg('user', [{ type: 'text', text: '问题二' }])],
    })) }],
    [join(root, 'coord.json'), { type: 'file', text: '{}' }],
  ])
  const host = memoryHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'jcode', host, imports: {} })
  assert.equal(total, 2)
  const fox = sessions.find((s) => s.sessionId === 'sess-fox')
  assert.equal(fox.format, 'jcode')
  assert.equal(fox.title, 'fox')
  assert.equal(fox.project, 'proj')
  assert.equal(fox.cwd, '/home/dev/proj')
  assert.ok(fox.createdAt > 0)
  const bat = sessions.find((s) => s.sessionId === 'sess-bat')
  assert.equal(bat.title, '带标题的会话')
})
