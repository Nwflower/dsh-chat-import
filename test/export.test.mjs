// export.test.mjs — export.mjs 纯函数单测（零 DSH 依赖）：DSH 会话事件 → Claude Code JSONL。
// 合成事件直接构造（禁止真实 transcript）；uuid 注入确定性序列断言链式关系。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serializeClaudeJsonl, slugifyClaudeCwd, serializeClaudeJsonlTail, tailClaudeEvents, verifyClaudeJsonl } from '../lib/export/index.mjs'

const T = 1786000000000 // 固定毫秒时间戳
const ISO = new Date(T).toISOString()
const SESSION_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

// 确定性 uuid 工厂：按调用序号生成 v4 格式 uuid（链式断言依赖序号）。
function uuidSeq() {
  let n = 0
  return () => '00000000-0000-4000-8000-' + String(++n).padStart(12, '0')
}

// 合成 DSH 事件（形状对齐真实会话日志：surface 事件带 surfaceOp:'append'）。
function ev(type, seq, data, extra = {}) {
  return { type, seq, time: T, data, ...extra }
}

function userMsg(seq, text, opts = {}) {
  const data = {
    id: opts.id ?? 'u' + seq,
    role: 'user',
    content: opts.blocks ?? [{ type: 'text', text }],
    source: { kind: opts.kind ?? 'user' },
  }
  if (opts.promptId) data.promptId = opts.promptId
  return ev('user/message', seq, data, { surfaceOp: 'append' })
}

function asstMsg(seq, turn, step, blocks, opts = {}) {
  const msg = { role: 'assistant', content: blocks }
  if (opts.model) msg.source = { kind: 'model', provider: 'claude-code', model: opts.model }
  return ev('assistant/message', seq, { turn, step, message: msg }, { surfaceOp: 'append' })
}

function toolCall(seq, turn, step, callId, name = 'Bash', args = '{}') {
  return ev('tool/call', seq, { turn, step, callId, name, arguments: args })
}

function toolResult(seq, callId, content, opts = {}) {
  const block = { type: 'tool-result', toolCallId: callId, content: opts.blocks ?? [{ type: 'text', text: content }] }
  if (opts.isError) block.isError = true
  return ev('tool/result', seq, {
    turn: opts.turn ?? 1,
    step: opts.step ?? 1,
    message: { id: 'tr' + seq, role: 'user', content: [block], source: { kind: 'tool', callId } },
  }, { surfaceOp: 'append' })
}

function titleEv(seq, title) {
  return ev('session/title', seq, { title, messageSeqs: [], source: { kind: 'user' } })
}

// 序列化输入骨架：events 可按用例覆盖。
function input(events, overrides = {}) {
  return {
    meta: { version: 0, id: 'import-sess', createdAt: T, cwd: 'D:\\demo\\proj' },
    events,
    sessionUuid: SESSION_UUID,
    cwd: 'D:\\demo\\proj',
    ...overrides,
  }
}

// 解析输出 JSONL 并断言文件布局约束：每行一个记录、恰好一个结尾换行。
function parseLines(jsonl) {
  assert.equal(jsonl.endsWith('\n'), true, '文件以恰好一个换行结尾')
  const body = jsonl.slice(0, -1)
  assert.ok(!body.includes('\n\n'), '无空行（每行恰一个记录）')
  return body.split('\n').map((l) => JSON.parse(l))
}

test('简单问答：mode/permission-mode 头 + user/assistant 记录 + end_turn + 布局约束', () => {
  const events = [userMsg(0, '你好'), asstMsg(1, 1, 1, [{ type: 'text', text: '你好！' }])]
  const out = serializeClaudeJsonl(input(events), { uuid: uuidSeq() })
  const lines = parseLines(out.jsonl)

  assert.equal(out.recordCount, 4)
  assert.equal(out.toolCalls, 0)
  assert.equal(out.toolResults, 0)
  assert.equal(out.droppedToolResults, 0)
  assert.equal(out.skippedInjections, 0)
  assert.equal(out.skippedBlocks, 0)
  assert.equal(out.title, undefined)

  // 头两行：mode + permission-mode（恰好 3 字段）
  assert.deepEqual(lines[0], { type: 'mode', mode: 'normal', sessionId: SESSION_UUID })
  assert.deepEqual(lines[1], { type: 'permission-mode', permissionMode: 'default', sessionId: SESSION_UUID })

  const user = lines[2]
  assert.equal(user.type, 'user')
  assert.equal(user.parentUuid, null) // 首个 user 是链头
  assert.equal(user.uuid, '00000000-0000-4000-8000-000000000001')
  assert.equal(user.timestamp, ISO)
  assert.equal(user.message.content, '你好') // 单 text 块 → 字符串
  assert.equal(user.permissionMode, 'default')
  assert.deepEqual(user.origin, { kind: 'human' })
  assert.equal(user.promptSource, 'typed')
  assert.equal(user.userType, 'external')
  assert.equal(user.entrypoint, 'cli')
  assert.equal(user.cwd, 'D:\\demo\\proj')
  assert.equal(user.sessionId, SESSION_UUID)

  const asst = lines[3]
  assert.equal(asst.type, 'assistant')
  assert.equal(asst.parentUuid, user.uuid)
  assert.equal(asst.uuid, '00000000-0000-4000-8000-000000000002')
  assert.equal(asst.timestamp, ISO)
  assert.equal(asst.message.type, 'message')
  assert.match(asst.message.id, /^msg_[0-9a-f]{24}$/)
  assert.equal(asst.message.role, 'assistant')
  assert.deepEqual(asst.message.content, [{ type: 'text', text: '你好！' }])
  assert.equal(asst.message.stop_reason, 'end_turn')
})

test('工具会话：thinking→signature:""、tool_use、tool_result 配对 + sourceToolAssistantUUID + is_error', () => {
  const events = [
    userMsg(0, '列目录'),
    asstMsg(1, 1, 1, [
      { type: 'reasoning', text: '思考中' },
      { type: 'text', text: '执行 ls' },
      { type: 'tool-call', id: 'toolu_01', name: 'Bash', arguments: '{"command":"ls -la"}' },
    ], { model: 'claude-sonnet-4-5' }),
    toolCall(2, 1, 1, 'toolu_01', 'Bash', '{"command":"ls -la"}'),
    toolResult(3, 'toolu_01', 'README.md\nsrc\n', { isError: true }),
    asstMsg(4, 1, 2, [{ type: 'text', text: '完成' }]),
  ]
  const out = serializeClaudeJsonl(input(events), { uuid: uuidSeq() })
  const lines = parseLines(out.jsonl)
  assert.equal(out.recordCount, 6)
  assert.equal(out.toolCalls, 1)
  assert.equal(out.toolResults, 1)

  const asst1 = lines[3]
  assert.equal(asst1.message.model, 'claude-sonnet-4-5')
  assert.deepEqual(asst1.message.content.find((b) => b.type === 'thinking'),
    { type: 'thinking', thinking: '思考中', signature: '' })
  assert.deepEqual(asst1.message.content.find((b) => b.type === 'tool_use'),
    { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls -la' } })
  assert.equal(asst1.message.stop_reason, 'tool_use') // 含 tool-call → tool_use

  const tr = lines[4]
  assert.equal(tr.type, 'user')
  assert.equal(tr.parentUuid, asst1.uuid) // 声明 assistant 的 uuid
  assert.equal(tr.sourceToolAssistantUUID, asst1.uuid)
  assert.deepEqual(tr.message.content, [{
    type: 'tool_result', tool_use_id: 'toolu_01', content: 'README.md\nsrc\n', is_error: true,
  }])

  const asst2 = lines[5]
  assert.equal(asst2.parentUuid, tr.uuid) // 链回 tool_result
  assert.equal(asst2.message.stop_reason, 'end_turn')
})

test('并行多 result 扇出：parentUuid 都指向声明它们的同一个 assistant', () => {
  const events = [
    userMsg(0, '并行调用'),
    asstMsg(1, 1, 1, [
      { type: 'tool-call', id: 'callA', name: 'Bash', arguments: '{"command":"a"}' },
      { type: 'tool-call', id: 'callB', name: 'Bash', arguments: '{"command":"b"}' },
    ]),
    toolCall(2, 1, 1, 'callA', 'Bash', '{"command":"a"}'),
    toolCall(3, 1, 1, 'callB', 'Bash', '{"command":"b"}'),
    toolResult(4, 'callB', 'B 的结果'), // 乱序返回
    toolResult(5, 'callA', 'A 的结果'),
    asstMsg(6, 1, 2, [{ type: 'text', text: '合并' }]),
  ]
  const out = serializeClaudeJsonl(input(events), { uuid: uuidSeq() })
  const lines = parseLines(out.jsonl)
  assert.equal(out.toolResults, 2)
  const asst = lines[3]
  const trB = lines[4]
  const trA = lines[5]
  assert.equal(trB.message.content[0].tool_use_id, 'callB')
  assert.equal(trA.message.content[0].tool_use_id, 'callA')
  assert.equal(trB.parentUuid, asst.uuid)
  assert.equal(trA.parentUuid, asst.uuid) // 扇出：两个 result 都指向同一 assistant
  assert.equal(trB.sourceToolAssistantUUID, asst.uuid)
  assert.equal(trA.sourceToolAssistantUUID, asst.uuid)
})

test('跨 step 延迟结果：parentUuid 指向声明调用（step1）的 assistant，而非结果所在 step', () => {
  const events = [
    userMsg(0, '异步工具'),
    asstMsg(1, 1, 1, [{ type: 'tool-call', id: 'callX', name: 'Bash', arguments: '{}' }]),
    toolCall(2, 1, 1, 'callX', 'Bash', '{}'),
    ev('step/end', 3, { turn: 1, step: 1 }),
    ev('step/start', 4, { turn: 1, step: 2 }),
    asstMsg(5, 1, 2, [{ type: 'text', text: '继续' }]),
    toolResult(6, 'callX', '迟到的结果', { step: 2 }), // 结果在 step2 之后才到达
  ]
  const out = serializeClaudeJsonl(input(events), { uuid: uuidSeq() })
  const lines = parseLines(out.jsonl)
  assert.equal(out.toolResults, 1)
  const asst1 = lines[3]
  const asst2 = lines[4]
  const tr = lines[5]
  assert.notEqual(asst1.uuid, asst2.uuid)
  assert.equal(tr.parentUuid, asst1.uuid) // 声明方（step1），不是结果所在 step
  assert.equal(tr.sourceToolAssistantUUID, asst1.uuid)
})

test('有 call 无 result（中断会话）：文件末尾补发空 tool_result（content:[]）', () => {
  const events = [
    userMsg(0, '提问'),
    asstMsg(1, 1, 1, [{ type: 'tool-call', id: 'callZ', name: 'Bash', arguments: '{}' }]),
    toolCall(2, 1, 1, 'callZ', 'Bash', '{}'),
    // 会话在此中断：无 tool/result
  ]
  const out = serializeClaudeJsonl(input(events), { uuid: uuidSeq() })
  const lines = parseLines(out.jsonl)
  assert.equal(out.recordCount, 5) // mode + permission-mode + user + assistant + 补发 result
  assert.equal(out.toolCalls, 1)
  assert.equal(out.toolResults, 1)
  const last = lines[4]
  assert.equal(last.type, 'user')
  assert.equal(last.message.content[0].type, 'tool_result')
  assert.equal(last.message.content[0].tool_use_id, 'callZ')
  assert.deepEqual(last.message.content[0].content, [])
  assert.equal(last.parentUuid, lines[3].uuid) // 指向声明 assistant
  assert.equal(last.sourceToolAssistantUUID, lines[3].uuid)
  assert.equal(last.timestamp, ISO) // 用最后一条事件的时间戳
})

test('孤儿 tool/result（无对应 tool/call）：丢弃并计数，不产生 tool_result 记录', () => {
  const events = [
    userMsg(0, '提问'),
    asstMsg(1, 1, 1, [{ type: 'text', text: '回答' }]),
    toolResult(2, 'call-orphan', '无调用的结果'),
  ]
  const out = serializeClaudeJsonl(input(events), { uuid: uuidSeq() })
  assert.equal(out.droppedToolResults, 1)
  assert.equal(out.toolResults, 0)
  assert.equal(out.recordCount, 4)
  const lines = parseLines(out.jsonl)
  assert.ok(!lines.some((l) => l.message && Array.isArray(l.message.content)
    && l.message.content[0] && l.message.content[0].type === 'tool_result'))
})

test('空会话（无 surface 事件）抛错「无可导出内容」', () => {
  assert.throws(() => serializeClaudeJsonl(input([])), /无可导出内容/)
  // 只有注入（source.kind≠user）也视为空
  assert.throws(() => serializeClaudeJsonl(input([userMsg(0, 'injection', { kind: 'system' })])), /无可导出内容/)
  // 只有 turn/start 等框架事件也视为空
  assert.throws(() => serializeClaudeJsonl(input([ev('turn/start', 0, { turn: 1 })])), /无可导出内容/)
})

test('注入跳过：source.kind≠user 的 user/message 计数 skippedInjections 且不落记录', () => {
  const events = [
    userMsg(0, '系统注入', { kind: 'system' }),
    userMsg(1, '真实提问'),
    asstMsg(2, 1, 1, [{ type: 'text', text: '回答' }]),
  ]
  const out = serializeClaudeJsonl(input(events), { uuid: uuidSeq() })
  assert.equal(out.skippedInjections, 1)
  assert.equal(out.recordCount, 4) // 注入不落记录
  const lines = parseLines(out.jsonl)
  assert.equal(lines[2].message.content, '真实提问')
  assert.equal(lines[2].parentUuid, null) // 首个真实 user 成为链头
})

test('非映射事件（turn/start、session/imported、todo/write 等）一律跳过且不计数', () => {
  const events = [
    ev('session/imported', 0, { tool: 'claude-code', sourceId: 'x', sourcePath: 'p', importedAt: T }),
    ev('turn/start', 1, { turn: 1 }),
    ev('step/start', 2, { turn: 1, step: 1 }),
    userMsg(3, 'hi'),
    asstMsg(4, 1, 1, [{ type: 'text', text: 'ok' }]),
    ev('todo/write', 5, { items: [] }),
    ev('step/end', 6, { turn: 1, step: 1 }),
    ev('turn/end', 7, { turn: 1, reason: { kind: 'completed' } }),
  ]
  const out = serializeClaudeJsonl(input(events), { uuid: uuidSeq() })
  assert.equal(out.recordCount, 4)
  assert.equal(out.skippedInjections, 0)
  assert.equal(out.skippedBlocks, 0)
  assert.equal(out.toolCalls, 0)
})

test('user 多块：多 text → 数组；图片块降级跳过并计数', () => {
  const events = [
    userMsg(0, '', { blocks: [
      { type: 'text', text: '第一段' },
      { type: 'text', text: '第二段' },
      { type: 'image', imageUrl: 'data:image/png;base64,x' },
    ] }),
    asstMsg(1, 1, 1, [{ type: 'text', text: 'ok' }]),
  ]
  const out = serializeClaudeJsonl(input(events), { uuid: uuidSeq() })
  assert.equal(out.skippedBlocks, 1)
  const lines = parseLines(out.jsonl)
  assert.deepEqual(lines[2].message.content, ['第一段', '第二段'])
})

test('assistant 图片块降级跳过并计数', () => {
  const events = [
    userMsg(0, '看图'),
    asstMsg(1, 1, 1, [
      { type: 'text', text: '看到了' },
      { type: 'image', imageUrl: 'data:image/png;base64,y' },
    ]),
  ]
  const out = serializeClaudeJsonl(input(events), { uuid: uuidSeq() })
  assert.equal(out.skippedBlocks, 1)
  const lines = parseLines(out.jsonl)
  assert.deepEqual(lines[3].message.content, [{ type: 'text', text: '看到了' }])
})

test('session/title → custom-title：放首个 user 后、assistant 前；无 uuid/parentUuid', () => {
  const events = [
    titleEv(0, '项目问题讨论'),
    userMsg(1, '提问'),
    asstMsg(2, 1, 1, [{ type: 'text', text: '回答' }]),
  ]
  const out = serializeClaudeJsonl(input(events), { uuid: uuidSeq() })
  assert.equal(out.title, '项目问题讨论')
  assert.equal(out.recordCount, 5)
  const lines = parseLines(out.jsonl)
  assert.equal(lines[2].type, 'user')
  assert.deepEqual(lines[3], { type: 'custom-title', customTitle: '项目问题讨论', sessionId: SESSION_UUID })
  assert.equal(Object.hasOwn(lines[3], 'uuid'), false)
  assert.equal(Object.hasOwn(lines[3], 'parentUuid'), false)
  const asst = lines[4]
  assert.equal(asst.parentUuid, lines[2].uuid) // 链越过 custom-title
})

test('title 入参优先于 session/title 事件', () => {
  const events = [titleEv(0, '事件标题'), userMsg(1, 'hi'), asstMsg(2, 1, 1, [{ type: 'text', text: 'ok' }])]
  const out = serializeClaudeJsonl(input(events, { title: '入参标题' }), { uuid: uuidSeq() })
  const lines = parseLines(out.jsonl)
  assert.equal(out.title, '入参标题')
  assert.equal(lines[3].customTitle, '入参标题')
})

test('timestamp 断言：event.time → ISO8601；promptId/version/gitBranch 透传', () => {
  const events = [userMsg(0, 'hi', { promptId: 'prompt-abc' }), asstMsg(1, 1, 1, [{ type: 'text', text: 'ok' }])]
  const out = serializeClaudeJsonl(input(events, { version: '2.1.220', gitBranch: 'HEAD' }), { uuid: uuidSeq() })
  const lines = parseLines(out.jsonl)
  const user = lines[2]
  assert.equal(user.timestamp, ISO)
  assert.equal(user.promptId, 'prompt-abc')
  assert.equal(user.version, '2.1.220')
  assert.equal(user.gitBranch, 'HEAD')
  assert.equal(lines[3].timestamp, ISO)
})

test('tool_use input：arguments 解析失败回退 {}', () => {
  const events = [
    userMsg(0, 'hi'),
    asstMsg(1, 1, 1, [{ type: 'tool-call', id: 'callX', name: 'Bash', arguments: 'not-json{' }]),
    toolCall(2, 1, 1, 'callX', 'Bash', 'not-json{'),
    toolResult(3, 'callX', '结果'),
  ]
  const out = serializeClaudeJsonl(input(events), { uuid: uuidSeq() })
  const lines = parseLines(out.jsonl)
  const toolUse = lines[3].message.content.find((b) => b.type === 'tool_use')
  assert.deepEqual(toolUse.input, {})
})

test('uuid：默认 randomUUID（v4 格式）；注入序列时逐记录确定', () => {
  // 注入确定性
  const out = serializeClaudeJsonl(input([userMsg(0, 'hi'), asstMsg(1, 1, 1, [{ type: 'text', text: 'ok' }])]), { uuid: uuidSeq() })
  const lines = parseLines(out.jsonl)
  assert.equal(lines[2].uuid, '00000000-0000-4000-8000-000000000001')
  assert.equal(lines[3].uuid, '00000000-0000-4000-8000-000000000002')
  assert.equal(lines[3].parentUuid, lines[2].uuid)

  // 默认：uuid v4
  const out2 = serializeClaudeJsonl(input([userMsg(0, 'hi'), asstMsg(1, 1, 1, [{ type: 'text', text: 'ok' }])]))
  const lines2 = parseLines(out2.jsonl)
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  assert.match(lines2[2].uuid, re)
  assert.match(lines2[3].uuid, re)
})

test('slugifyClaudeCwd：非字母数字替换为 -、不合并连续 -', () => {
  assert.equal(slugifyClaudeCwd('D:\\Build'), 'D--Build')
  assert.equal(slugifyClaudeCwd("Meier's"), 'Meier-s')
  assert.equal(slugifyClaudeCwd('D:\\项目\\'), 'D-----') // 5 个连续 '-'
  assert.equal(slugifyClaudeCwd('a b.c'), 'a-b-c')
  assert.equal(slugifyClaudeCwd(''), '')
  assert.equal(slugifyClaudeCwd(12345), '12345')
})

test('tool_result 多块内容：空 → []；多 text → 数组', () => {
  // 空内容
  const events1 = [
    userMsg(0, 'hi'),
    asstMsg(1, 1, 1, [{ type: 'tool-call', id: 'c1', name: 'Bash', arguments: '{}' }]),
    toolCall(2, 1, 1, 'c1'),
    toolResult(3, 'c1', '', { blocks: [] }),
  ]
  const out1 = serializeClaudeJsonl(input(events1), { uuid: uuidSeq() })
  assert.deepEqual(parseLines(out1.jsonl)[4].message.content[0].content, [])

  // 多 text
  const events2 = [
    userMsg(0, 'hi'),
    asstMsg(1, 1, 1, [{ type: 'tool-call', id: 'c2', name: 'Bash', arguments: '{}' }]),
    toolCall(2, 1, 1, 'c2'),
    toolResult(3, 'c2', '', { blocks: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }),
  ]
  const out2 = serializeClaudeJsonl(input(events2), { uuid: uuidSeq() })
  assert.deepEqual(parseLines(out2.jsonl)[4].message.content[0].content, ['a', 'b'])
})

// ---- REQ-36 增量写回：尾部截取 / 尾部序列化 / 格式预检 ----

test('tailClaudeEvents：fromSeq 过滤、完整轮保留、半开尾轮整轮丢弃', () => {
  const evs = [
    ev('turn/start', 0, { turn: 1 }),
    userMsg(1, '问题1'),
    asstMsg(2, 1, 1, [{ type: 'text', text: '回答1' }]),
    ev('turn/end', 3, { turn: 1, reason: { kind: 'completed' } }),
    ev('turn/start', 4, { turn: 2 }),
    userMsg(5, '问题2'),
    asstMsg(6, 2, 1, [{ type: 'text', text: '回答2' }]),
    // turn 2 无 turn/end → 半开
  ]
  const t = tailClaudeEvents(evs, { fromSeq: 0 })
  assert.equal(t.droppedIncompleteTurn, true)
  assert.equal(t.firstTurn, 1)
  assert.equal(t.events.length, 4) // 只保留闭合的 turn 1
  assert.deepEqual(t.events.map((e) => e.type), ['turn/start', 'user/message', 'assistant/message', 'turn/end'])

  // fromSeq 过滤：水印之后的剩余全是半开尾轮 → 空
  const t2 = tailClaudeEvents(evs, { fromSeq: 4 })
  assert.equal(t2.droppedIncompleteTurn, true)
  assert.equal(t2.events.length, 0)
  assert.equal(t2.firstTurn, null)
})

test('tailClaudeEvents：全半开 → 空；无 turn 包裹的续写事件保留', () => {
  const half = [ev('turn/start', 0, { turn: 1 }), userMsg(1, '问题1')]
  const t = tailClaudeEvents(half, { fromSeq: 0 })
  assert.equal(t.droppedIncompleteTurn, true)
  assert.deepEqual(t.events, [])

  // 无 turn 包裹的裸 surface 事件（DSH 续写轮）不当作半开，原样保留
  const bare = [userMsg(0, '续写'), asstMsg(1, 1, 1, [{ type: 'text', text: 'ok' }])]
  const t2 = tailClaudeEvents(bare, { fromSeq: 0 })
  assert.equal(t2.droppedIncompleteTurn, false)
  assert.equal(t2.events.length, 2)
  assert.equal(t2.firstTurn, null)
})

test('serializeClaudeJsonlTail：无 mode/permission-mode/custom-title 头、首条 parentUuid=prevUuid、链连续、lastUuid', () => {
  const events = [userMsg(0, '续问'), asstMsg(1, 2, 1, [{ type: 'text', text: '续答' }])]
  const out = serializeClaudeJsonlTail({ meta: {}, events, sessionUuid: SESSION_UUID, cwd: 'D:\\demo\\proj', prevUuid: 'prev-000' }, { uuid: uuidSeq() })
  const lines = parseLines(out.jsonl)
  assert.equal(out.recordCount, 2)
  assert.equal(lines[0].type, 'user')
  assert.equal(lines[0].parentUuid, 'prev-000') // 接续上一水印链尾
  assert.equal(lines[1].type, 'assistant')
  assert.equal(lines[1].parentUuid, lines[0].uuid) // 链连续
  assert.equal(out.lastUuid, lines[1].uuid)
  assert.ok(!out.jsonl.includes('"type":"mode"'))
  assert.ok(!out.jsonl.includes('permission-mode'))
  assert.ok(!out.jsonl.includes('custom-title'))
  // 记录 sessionId 与目标文件一致
  assert.equal(lines[0].sessionId, SESSION_UUID)
  assert.equal(lines[1].sessionId, SESSION_UUID)
})

test('serializeClaudeJsonlTail：空尾部（无 surface 事件）抛「无可导出内容」', () => {
  assert.throws(() => serializeClaudeJsonlTail({ meta: {}, events: [], sessionUuid: SESSION_UUID, cwd: 'D:\\demo\\proj', prevUuid: null }, { uuid: uuidSeq() }), /无可导出内容/)
  // 只有框架事件也算空
  assert.throws(() => serializeClaudeJsonlTail({ meta: {}, events: [ev('turn/start', 0, { turn: 1 })], sessionUuid: SESSION_UUID, cwd: 'D:\\demo\\proj', prevUuid: null }, { uuid: uuidSeq() }), /无可导出内容/)
})

test('serializeClaudeJsonlTail：跨水印延迟 tool/result → 孤儿丢弃计数（调用声明在前段、结果在尾部）', () => {
  // 调用声明在水印之前（不在尾部事件里），结果落在尾部 → 查不到声明方 → 孤儿
  const events = [
    userMsg(0, '续问'),
    asstMsg(1, 2, 1, [{ type: 'text', text: '继续' }]),
    toolResult(2, 'call-prev', '迟到的结果', { turn: 2, step: 2 }),
  ]
  const out = serializeClaudeJsonlTail({ meta: {}, events, sessionUuid: SESSION_UUID, cwd: 'D:\\demo\\proj', prevUuid: 'prev-000' }, { uuid: uuidSeq() })
  assert.equal(out.droppedToolResults, 1)
  assert.equal(out.toolResults, 0)
  assert.equal(out.recordCount, 2) // user + assistant，孤儿 result 不落记录
  assert.ok(!out.jsonl.includes('tool_result'))
})

test('verifyClaudeJsonl：合法全量文件 → ok + recordCount + lastUuid', () => {
  const jsonl = serializeClaudeJsonl(input([userMsg(0, 'hi'), asstMsg(1, 1, 1, [{ type: 'text', text: 'ok' }])]), { uuid: uuidSeq() }).jsonl
  const v = verifyClaudeJsonl(jsonl)
  assert.equal(v.ok, true)
  assert.equal(v.recordCount, 4)
  assert.equal(v.lastUuid, '00000000-0000-4000-8000-000000000002')
})

test('verifyClaudeJsonl：畸形行 / 首行非 mode / 缺尾换行 / 空行 / parentUuid 悬空 / 末行缺 uuid', () => {
  // 畸形行
  let v = verifyClaudeJsonl('{not json}\n')
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => e.line === 1 && /JSON/.test(e.error)))

  // 首行非 mode（缺 sessionId 的 mode 也算违规）
  const user = JSON.stringify({ type: 'user', parentUuid: null, uuid: 'u-1', sessionId: 's' })
  v = verifyClaudeJsonl(user + '\n')
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => /mode/.test(e.error)))
  v = verifyClaudeJsonl(JSON.stringify({ type: 'mode', mode: 'normal' }) + '\n')
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => /sessionId/.test(e.error)))

  // 缺结尾换行
  v = verifyClaudeJsonl(user)
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => /换行/.test(e.error)))

  // 空行
  v = verifyClaudeJsonl(user + '\n\n')
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => /空行/.test(e.error)))

  // parentUuid 悬空
  const dangling = [
    JSON.stringify({ type: 'mode', mode: 'normal', sessionId: 's' }),
    JSON.stringify({ type: 'user', parentUuid: null, uuid: 'u-1', sessionId: 's' }),
    JSON.stringify({ type: 'assistant', parentUuid: 'no-such', uuid: 'a-1', sessionId: 's' }),
  ].join('\n') + '\n'
  v = verifyClaudeJsonl(dangling)
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => /悬空/.test(e.error)))

  // 末行缺 uuid
  const nouuid = [
    JSON.stringify({ type: 'mode', mode: 'normal', sessionId: 's' }),
    JSON.stringify({ type: 'user', parentUuid: null, uuid: 'u-1', sessionId: 's' }),
    JSON.stringify({ type: 'assistant', parentUuid: 'u-1', sessionId: 's' }),
  ].join('\n') + '\n'
  v = verifyClaudeJsonl(nouuid)
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => /uuid/.test(e.error)))
})
