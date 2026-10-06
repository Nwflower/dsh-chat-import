// chatgpt-shape.test.mjs — ChatGPT 导出的形状假设（issue #62，四个 P0/P1 症状）
//
// 报告者给的是**真实官方导出**的三种形态差异：
//   S（slim）：所有 node 都没有 `children` 字段；root 是 `message: null` 占位节点；
//              create_time 是带小数的 Unix 秒（1767583930.285031）。
// 本文件把这三种形态各钉一条用例，外加「预览 schema 必须合法」这条由 Bug 3 引发的症状。
// 夹具全部合成（不掺真实 transcript），形状按报告者实测描述构造。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.mjs'
import { convertChatgptJson } from '../lib/convert/index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { makeCtx } from './_support/fake-host.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
})

// Unix 秒（带小数）—— 官方导出的 create_time 形态
const SEC = 1767583930.285031

// 单会话：占位 root → 1 轮 user/assistant 对话；可选补 children、可选带工具消息
function conversation({ id = 'conv-1', withChildren = false, extraTurns = 0 } = {}) {
  const mapping = {
    root: { id: 'root', message: null, parent: null },
  }
  const link = (parent, child) => {
    if (withChildren) {
      if (!mapping[parent].children) mapping[parent].children = []
      mapping[parent].children.push(child)
    }
  }
  mapping.n1 = { id: 'n1', parent: 'root', message: { author: { role: 'user' }, create_time: SEC, content: { parts: ['帮我看看这个构建失败'] } } }
  link('root', 'n1')
  mapping.n2 = { id: 'n2', parent: 'n1', message: { author: { role: 'assistant' }, create_time: SEC + 1.5, content: { parts: ['是缺依赖。'] } } }
  link('n1', 'n2')
  // 额外轮次（用于分支用例）：n2 之后分叉出两条
  if (extraTurns > 0) {
    mapping.n3 = { id: 'n3', parent: 'n2', message: { author: { role: 'user' }, create_time: SEC + 2, content: { parts: ['那怎么修'] } } }
    link('n2', 'n3')
    mapping.n4 = { id: 'n4', parent: 'n3', message: { author: { role: 'assistant' }, create_time: SEC + 3, content: { parts: ['先装依赖。'] } } }
    link('n3', 'n4')
    mapping.n5 = { id: 'n5', parent: 'n3', message: { author: { role: 'assistant' }, create_time: SEC + 4, content: { parts: ['或者升级 lockfile。'] } } }
    link('n3', 'n5')
  }
  return { id, title: '构建失败排查', create_time: SEC, mapping }
}

const exportOf = (convs) => JSON.stringify(convs)

const everyTimeSafe = (out) => {
  const times = [out.meta.createdAt, ...out.events.map((e) => e.time)]
  return times.filter((t) => !Number.isSafeInteger(t))
}

// ── Bug 1：slim 导出（无 children）下的图遍历 ─────────────────────────────

test('Bug 1：slim 导出（全库无 children 字段）仍能沿 parent 还原主线程', () => {
  const out = convertChatgptJson(exportOf([conversation({ withChildren: false })]), { sourcePath: 'conversations.json' })
  assert.equal(out.records, 1)
  assert.equal(out.conversations.length, 1, 'slim 导出不该被丢弃')
  const conv = out.conversations[0]
  assert.equal(conv.turns.length, 1)
  assert.equal(conv.turns[0].prompt, '帮我看看这个构建失败')
  assert.deepEqual(conv.turns[0].steps.map((s) => s.content[0].text), ['是缺依赖。'])
})

test('Bug 1：branch=all 在 slim 导出下同样枚举出两条分支', () => {
  const out = convertChatgptJson(exportOf([conversation({ withChildren: false, extraTurns: 1 })]), { sourcePath: 'conversations.json', branch: 'all' })
  assert.equal(out.conversations.length, 2, '两条叶子路径 → 两个会话')
  const prompts = out.conversations.map((c) => c.turns.map((t) => t.prompt).join('|'))
  assert.deepEqual(prompts.sort(), ['帮我看看这个构建失败|那怎么修', '帮我看看这个构建失败|那怎么修'].sort())
  const lastTexts = out.conversations.map((c) => c.turns.at(-1).steps.at(-1).content[0].text).sort()
  assert.deepEqual(lastTexts, ['先装依赖。', '或者升级 lockfile。'])
})

test('Bug 1：声明了 children 的导出仍按声明走（还原不覆盖既有字段）', () => {
  const out = convertChatgptJson(exportOf([conversation({ withChildren: true })]), { sourcePath: 'conversations.json' })
  assert.equal(out.conversations.length, 1)
  assert.equal(out.conversations[0].turns[0].prompt, '帮我看看这个构建失败')
})

// ── Bug 2：占位 root（message: null）────────────────────────────────────

test('Bug 2：占位 root（message: null）+ 完整 children 的**标准**导出不再被整体丢弃', () => {
  const out = convertChatgptJson(exportOf([conversation({ withChildren: true })]), { sourcePath: 'conversations.json' })
  assert.equal(out.skipped, 0, '占位 root 不是跳过理由')
  assert.equal(out.conversations.length, 1)
})

test('Bug 2：没有 message 的会话（空壳）仍按跳过计数，不产出空会话', () => {
  const empty = { id: 'empty', title: 'empty', create_time: SEC, mapping: {} }
  const onlyPlaceholder = { id: 'ph', title: 'ph', create_time: SEC, mapping: { root: { id: 'root', message: null, parent: null } } }
  const out = convertChatgptJson(exportOf([empty, onlyPlaceholder]), { sourcePath: 'conversations.json' })
  assert.equal(out.conversations.length, 0)
  assert.equal(out.skipped, 2)
})

// ── Bug 3：带小数的 Unix 秒 → 事件时间必须是安全整数 ──────────────────────

test('Bug 3：带小数的 create_time 被四舍五入成安全整数（事件 time 与 meta.createdAt）', () => {
  const out = convertChatgptJson(exportOf([conversation({ withChildren: false })]), { sourcePath: 'conversations.json' })
  const conv = out.conversations[0]
  assert.equal(conv.meta.createdAt, Math.round(SEC * 1000))
  assert.equal(Number.isSafeInteger(conv.meta.createdAt), true)
  assert.deepEqual(everyTimeSafe(conv), [], '所有事件 time 都是安全整数')
  assert.ok(conv.events.length >= 3)
})

test('Bug 3：毫秒形态的浮点时间戳同样取整（不因 >= 1e11 分支漏掉）', () => {
  const conv = conversation({ withChildren: true })
  conv.create_time = SEC * 1000 + 0.75 // 已是毫秒、但带小数
  const out = convertChatgptJson(exportOf([conv]), { sourcePath: 'conversations.json' })
  assert.equal(Number.isSafeInteger(out.conversations[0].meta.createdAt), true)
  assert.deepEqual(everyTimeSafe(out.conversations[0]), [])
})

// ── Bug 4：dry-run 预览必须合法（报告者看到的是 oneOf matched 0）───────────

test('Bug 4：conversations.json 的 dry-run 预览输出符合声明的 output schema（且真导入成功）', async () => {
  const file = 'D:\\demo\\chatgpt\\conversations.json'
  const tree = { [file]: exportOf([conversation({ withChildren: false }), conversation({ id: 'conv-2', withChildren: true })]) }
  const { ctx, persistence, registered } = makeCtx(tree, { real: false, fsOptions: { readOnly: true } }) // 纯内存树、只读：预览与导入都不写 fs
  apply(ctx)
  const tool = registered.find((d) => d.name === 'import_chat')
  assert.ok(tool, 'import_chat 已注册')
  const exec = (args) => tool.execute({ format: 'chatgpt', ...args })

  const preview = await exec({ path: file, preview: true })
  assert.equal(preview.mode, 'batch')
  assert.equal(preview.preview, true)
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, preview), [], '预览输出必须通过声明的 schema')

  const real = await exec({ path: file })
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, real), [])
  assert.equal(real.imported, 2)
  assert.equal(persistence.sessions.size, 2)
  for (const s of persistence.sessions.values()) {
    assert.equal(Number.isSafeInteger(s.meta.createdAt), true)
  }
})

// ── 护栏：verify_session 前置报出「非整数 time」（宿主会整份拒收的那类会话）──

test('护栏：verify_session 把浮点 time 报成 non-integer-time（宿主拒收的同因）', async () => {
  const { verifySession } = await import('../lib/verify.mjs')
  const MS = Math.round(SEC * 1000) // 整数毫秒基准（SEC*1000 本身是浮点）
  const events = [
    { type: 'turn/start', seq: 0, time: MS, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: MS + 0.031, data: { id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
    { type: 'turn/end', seq: 2, time: MS, data: { turn: 1 } },
  ]
  const ctx = {
    get: (s) => (s === 'sessionPersistence' ? {
      async list() { return [{ id: 'import-bad', version: 3, createdAt: MS }] },
      async readFrom() { return { meta: { id: 'import-bad' }, events } },
    } : undefined),
  }
  const out = await verifySession(ctx, { sessionId: 'import-bad' })
  assert.equal(out.ok, false)
  const p = out.problems.find((x) => x.kind === 'non-integer-time')
  assert.ok(p, '浮点 time 必须被报出')
  assert.equal(p.seq, 1)
  assert.match(p.message, /不是安全整数/)
  assert.ok(out.repairHints.some((h) => h.kind === 'non-integer-time'))

  // 整数 time 的同构会话 → 无该问题
  const clean = events.map((e) => ({ ...e, time: Math.round(e.time) }))
  const ctx2 = {
    get: (s) => (s === 'sessionPersistence' ? {
      async list() { return [{ id: 'import-ok', version: 3, createdAt: Math.round(SEC * 1000) }] },
      async readFrom() { return { meta: { id: 'import-ok' }, events: clean } },
    } : undefined),
  }
  const okOut = await verifySession(ctx2, { sessionId: 'import-ok' })
  assert.equal(okOut.problems.some((x) => x.kind === 'non-integer-time'), false)
})
