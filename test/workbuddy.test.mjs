// workbuddy.test.mjs — WorkBuddy 源转换核心单元测试 + import_chat 集成测试（假宿主见 _support/fake-host.mjs；自包含合成数据，不掺真实 transcript）
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { convertWorkbuddyJsonl } from '../lib/convert/workbuddy.mjs'
import { SESSION_FORMAT_VERSION } from '../lib/convert/core.mjs'
import { apply } from '../lib/index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { hostAbs } from './_support/host-path.mjs'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { clearScanCache } from '../lib/discovery.mjs'
import { assertToolPairing } from './_support/session-invariants.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'

// 集成用例隔离：每个用例独立 DSH_HOME（registry 落盘在 $DSH_HOME/dsh-chat-import），
// 进程内共享的扫描缓存每用例清空。
beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
})

function wb(recs) {
  return recs.map((r) => JSON.stringify(r)).join('\n')
}

const SID = '0016c4c9-2098-4372-ac81-86cdf5d3fb07'
const CWD = 'H:/CodexProjects/my-project'
const TS = 1787131157250

function userRec(innerText) {
  return {
    id: 'u-' + Math.random().toString(36).slice(2), timestamp: TS, type: 'message', role: 'user',
    content: [{ type: 'input_text', text: innerText }], sessionId: SID, cwd: CWD,
  }
}
function assistantRec(content) {
  return {
    id: 'a-' + Math.random().toString(36).slice(2), timestamp: TS, type: 'message', role: 'assistant',
    content: Array.isArray(content) ? content : [{ type: 'output_text', text: content }],
    sessionId: SID, cwd: CWD,
  }
}
function reasoningRec(text) {
  return {
    id: 'r-' + Math.random().toString(36).slice(2), timestamp: TS, type: 'reasoning',
    rawContent: [{ type: 'reasoning_text', text }], sessionId: SID, cwd: CWD,
  }
}
function callRec(callId, name, args = '{}', extra = {}) {
  return {
    id: 'c-' + Math.random().toString(36).slice(2), timestamp: TS, type: 'function_call',
    callId, name, arguments: args, status: 'completed', sessionId: SID, cwd: CWD, ...extra,
  }
}
function resultRec(callId, text) {
  return {
    id: 'x-' + Math.random().toString(36).slice(2), timestamp: TS, type: 'function_call_result',
    callId, name: 'Bash', status: 'completed', output: { type: 'text', text }, sessionId: SID, cwd: CWD,
  }
}

test('简单 user/assistant 轮次（user_query 提取）→ 1 轮、cwd/createdAt 落 meta', () => {
  const raw = wb([
    userRec('<system-reminder>\n...注入...\n</system-reminder>\n<user_query>帮我看看这个项目</user_query>'),
    assistantRec('好的，我先读一下结构。'),
  ])
  const out = convertWorkbuddyJsonl(raw, { sourcePath: 'C:/Users/u/.workbuddy/projects/p/' + SID + '.jsonl' })
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.id, 'import-' + SID)
  assert.equal(out.meta.sourceId, SID)
  assert.equal(out.meta.cwd, CWD)
  assert.equal(out.meta.createdAt, TS)
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].prompt, '帮我看看这个项目')
  assert.equal(out.messages, 2) // user + assistant（环境变更声明不计）
  assert.equal(out.toolCalls, 0)
  assert.equal(out.skipped, 0)
})

test('reasoning 先于 assistant 到达 → 同一 step 内 reasoning + text（不拆步）', () => {
  const raw = wb([
    userRec('<user_query>解释一下这段代码</user_query>'),
    reasoningRec('先看结构再作答'),
    assistantRec('这是入口文件。'),
  ])
  const out = convertWorkbuddyJsonl(raw, { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.turns.length, 1)
  const steps = out.turns[0].steps
  assert.equal(steps.length, 1)
  assert.deepEqual(steps[0].content.map((b) => b.type), ['reasoning', 'text'])
  assert.equal(steps[0].content[0].text, '先看结构再作答')
  // 事件层 step/start 与 step/end 平衡
  const starts = out.events.filter((e) => e.type === 'step/start').length
  const ends = out.events.filter((e) => e.type === 'step/end').length
  assert.equal(starts, ends)
  assert.equal(starts, 1)
})

test('function_call + function_call_result 按 callId 配对', () => {
  const raw = wb([
    userRec('<user_query>跑一下测试</user_query>'),
    assistantRec('我用命令跑。'),
    callRec('call_1', 'Bash', JSON.stringify({ command: 'npm test' })),
    resultRec('call_1', 'ok 42 passed'),
  ])
  const out = convertWorkbuddyJsonl(raw, { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.toolCalls, 1)
  assertToolPairing(out.events)
  const result = out.events.find((e) => e.type === 'tool/result')
  assert.equal(result.data.message.content[0].content[0].text, 'ok 42 passed')
  // assistant 消息内容携带 tool-call 块（wire 适配器从 content 派生 tool_calls）
  const am = out.events.find((e) => e.type === 'assistant/message')
  assert.ok(am.data.message.content.some((b) => b.type === 'tool-call' && b.name === 'Bash'))
})

test('孤儿 function_call_result（无匹配调用且无当前步）丢弃', () => {
  const raw = wb([
    resultRec('call_missing', '幽灵结果'),
  ])
  const out = convertWorkbuddyJsonl(raw, { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.toolCalls, 0)
  assert.equal(out.turns.length, 0)
  assert.equal(out.skipped, 0)
  assert.equal(out.droppedOrphanResults, 1)
})

test('中途孤儿 function_call_result（有当前步但无匹配调用）丢弃并计数，不误挂 lastStep', () => {
  // 正常 call/result 配对之后来一条无匹配 function_call 的孤儿结果：此前会经
  // `|| lastStep` 误挂到最近一步，产出无 tool/call 的孤儿 tool/result 事件
  //（恢复会话时模型 API 拒绝）——现一律丢弃
  const raw = wb([
    userRec('<user_query>跑一下测试</user_query>'),
    assistantRec('我用命令跑。'),
    callRec('call_1', 'Bash', JSON.stringify({ command: 'npm test' })),
    resultRec('call_1', 'ok 42 passed'),
    resultRec('call_ghost', '孤儿结果'),
  ])
  const out = convertWorkbuddyJsonl(raw, { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.toolCalls, 1)
  assert.equal(out.droppedOrphanResults, 1)
  assertToolPairing(out.events)
  // 日志里没有无 call 的孤儿 tool/result
  const resultIds = out.events.filter((e) => e.type === 'tool/result')
    .map((e) => e.data.message.content[0].toolCallId)
  assert.deepEqual(resultIds, ['call_1'])
})

test('打断/草稿 function_call（isPartialAborted/discard）跳过，不补空结果', () => {
  const raw = wb([
    userRec('<user_query>hi</user_query>'),
    callRec('call_bad', 'Bash', '{}', { providerData: { isPartialAborted: true, discard: true } }),
  ])
  const out = convertWorkbuddyJsonl(raw, { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.toolCalls, 0)
  assertToolPairing(out.events)
})

test('多轮对话：每条 user 提问开新轮', () => {
  const raw = wb([
    userRec('<user_query>第一问</user_query>'),
    assistantRec('一答'),
    userRec('<user_query>第二问</user_query>'),
    assistantRec('二答'),
  ])
  const out = convertWorkbuddyJsonl(raw, { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.turns.length, 2)
  assert.equal(out.messages, 4)
  assert.equal(out.title, '第一问')
})

test('畸形 JSONL 行 → skipped 计数 + skippedLines 明细（不上报内容）', () => {
  // 手动拼 raw：中间插入一行真正非法的 JSON（wb() 会把它 stringify 成合法串，故不走它）
  const raw = [
    JSON.stringify(userRec('<user_query>正常提问</user_query>')),
    '{ 这不是 JSON',
    JSON.stringify(assistantRec('部分回答')),
  ].join('\n')
  const out = convertWorkbuddyJsonl(raw, { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.skipped, 1)
  assert.equal(out.skippedLines.length, 1)
  assert.equal(out.skippedLines[0].line, 2)
  assert.ok(!String(out.skippedLines[0].error).includes('这不是 JSON'))
  assert.equal(out.turns.length, 1)
})

test('事件内无 sessionId → 以文件名 workbuddyId（session-uuid stem）作稳定源 id', () => {
  // 首条 user 记录故意不带 sessionId，验证转换器全程兜底
  const out = convertWorkbuddyJsonl(wb([
    { id: 'u', timestamp: TS, type: 'message', role: 'user', content: [{ type: 'input_text', text: '<user_query>问</user_query>' }], cwd: CWD },
    assistantRec('答'),
  ]), { workbuddyId: SID, sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.meta.id, 'import-' + SID)
  assert.equal(out.meta.sourceId, SID)
})

test('无用户提问（空/纯注入）→ 无可导入内容', () => {
  const raw = wb([
    userRec('<system-reminder>\n纯注入，无 user_query\n</system-reminder>'),
  ])
  const out = convertWorkbuddyJsonl(raw, { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.turns.length, 0)
  assert.equal(out.events.filter((e) => e.type === 'user/message').length, 0)
})

test('导入归属外置 registry：日志无标记，环境变更声明在首个 step/start 之后（issue #34 / #66）', () => {
  const raw = wb([
    userRec('<user_query>hi</user_query>'),
    assistantRec('yo'),
  ])
  const out = convertWorkbuddyJsonl(raw, { sourcePath: 'C:/Users/u/.workbuddy/projects/p/' + SID + '.jsonl' })
  assert.ok(out.events.every((e) => e.type !== 'session/imported'))
  // 首个 step/start 之后依次是 system head（宿主 v3→v4 迁移要求 surface 首事件是它）
  // 与环境变更声明（issue #66：声明不再早于首个 step/start，宿主 v2→v3 迁移对该形状 fail-closed）
  assert.deepEqual(out.events.slice(0, 4).map((e) => e.type), ['turn/start', 'step/start', 'system/message', 'user/message'])
  assert.equal(out.events[2].data.message.role, 'system')
  assert.equal(out.events[2].data.message.source.kind, 'plugin')
  assert.equal(out.events[3].data.source.kind, 'plugin')
})

test('file-history-snapshot 等运行期事件忽略', () => {
  const raw = wb([
    { id: 's', timestamp: TS, type: 'file-history-snapshot', isSnapshotUpdate: false, snapshot: { messageId: 'x', trackedFileBackups: {} }, cwd: CWD },
    userRec('<user_query>hi</user_query>'),
    assistantRec('yo'),
  ])
  const out = convertWorkbuddyJsonl(raw, { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.skipped, 0)
  assert.equal(out.messages, 2)
})
// ===== 失败重发 step 清洗（ghost retry dedupe，claude.test 同款规则）=====
// 一轮 function_call 没等到结果而中止时，源会在紧随的下一步用同一 callId 原样重发；
// 两条都保留会产生重复 callId 的 tool/call，DSH 会话折叠器对同一 id 只允许一次
// start（硬异常）。转换器在合成事件前丢弃失败重发的整步。

test('失败重发 step 清洗：同一 callId 下一步原样重发 → 丢弃 ghost 步', () => {
  const raw = wb([
    userRec('<user_query>跑一下</user_query>'),
    callRec('call_G', 'Bash', '{"command":"ls"}'),
    assistantRec([]), // 空 assistant 消息开新步（重发前有记录分隔）
    callRec('call_G', 'Bash', '{"command":"ls"}'),
    resultRec('call_G', 'ok'),
  ])
  const out = convertWorkbuddyJsonl(raw, { sourcePath: '/p/' + SID + '.jsonl' })
  const calls = out.events.filter((e) => e.type === 'tool/call')
  assert.equal(calls.length, 1)
  assert.equal(out.droppedRetrySteps, 1)
  assertToolPairing(out.events)
})

test('失败重发 step 清洗：无重发（正常流程）不误删', () => {
  const raw = wb([
    userRec('<user_query>跑一下</user_query>'),
    callRec('call_OK', 'Bash', '{"command":"ls"}'),
    resultRec('call_OK', 'ok'),
  ])
  const out = convertWorkbuddyJsonl(raw, { sourcePath: '/p/' + SID + '.jsonl' })
  const calls = out.events.filter((e) => e.type === 'tool/call')
  assert.equal(calls.length, 1)
  assert.equal(out.droppedRetrySteps, 0)
  assertToolPairing(out.events)
})

// ---- import_workbuddy 集成 ----

// 合成 WorkBuddy transcript（事件词汇对齐 lib/convert/workbuddy.mjs）。
const WB_SID = 'wb-sess-0001'
const WB_CWD = hostAbs('D:/demo/workbuddy-proj')
const WB_TS = 1787131157250
function wbUser(text) {
  return { id: 'u', timestamp: WB_TS, type: 'message', role: 'user', content: [{ type: 'input_text', text: '<user_query>' + text + '</user_query>' }], sessionId: WB_SID, cwd: WB_CWD }
}
function wbAssistant(text) {
  return { id: 'a', timestamp: WB_TS + 1, type: 'message', role: 'assistant', content: [{ type: 'output_text', text }], sessionId: WB_SID, cwd: WB_CWD }
}
function wbReas(text) {
  return { id: 'r', timestamp: WB_TS + 2, type: 'reasoning', rawContent: [{ type: 'reasoning_text', text }], sessionId: WB_SID, cwd: WB_CWD }
}
function wbCall(callId, name, args) {
  return { id: 'c', timestamp: WB_TS + 3, type: 'function_call', callId, name, arguments: JSON.stringify(args), status: 'completed', sessionId: WB_SID, cwd: WB_CWD }
}
function wbResult(callId, text) {
  return { id: 'x', timestamp: WB_TS + 4, type: 'function_call_result', callId, name: 'Bash', status: 'completed', output: { type: 'text', text }, sessionId: WB_SID, cwd: WB_CWD }
}
function wbTranscript(recs) {
  return recs.map((r) => JSON.stringify(r)).join('\n')
}

test('import_workbuddy 单文件导入：落盘、归组、返回值符合 schema', async () => {
  const src = 'D:\\demo\\workbuddy\\' + WB_SID + '.jsonl'
  const { ctx, persistence, attached } = makeCtx({ [src]: wbTranscript([
    wbUser('帮我看看这个项目'),
    wbReas('先读结构再答'),
    wbAssistant('好的，我先读一下结构。'),
  ]) })
  apply(ctx)
  const def = chatDef(ctx, 'workbuddy')
  const value = await def.execute({ path: src })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-' + WB_SID)
  assert.equal(value.turns, 1)
  assert.equal(value.messages, 2) // user + assistant（环境变更声明不计）
  assert.equal(value.toolCalls, 0)
  assert.equal(value.alreadyImported, false)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get('import-' + WB_SID)
  assert.ok(saved)
  assert.equal(saved.meta.cwd, WB_CWD)
  assert.equal(saved.meta.sourceId, undefined)
  // 宿主 header 白名单不含 sourceId（写入路径按 released-v2 schema 严格校验，
  // 白名单外字段会让整次创建被拒）：源 id 只服务 registry 与导出协议，不落 header
  assert.equal(saved.events.at(-1).type, 'session/title')
  assert.match(saved.events.at(-1).data.title, /^WorkBuddy · /)
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assertEnvelopeHygiene(saved.events)
  assert.equal(attached.length, 1)
  assert.equal(attached[0].id, 'import-' + WB_SID)
})

test('import_workbuddy 工具历史：tool/result 带 sourceEventSeqs 且 output 落盘', async () => {
  const src = 'D:\\demo\\workbuddy\\' + WB_SID + '.jsonl'
  const { ctx, persistence } = makeCtx({ [src]: wbTranscript([
    wbUser('跑一下测试'),
    wbReas('用命令跑'),
    wbAssistant('我用命令跑。'),
    wbCall('call_1', 'Bash', { command: 'npm test' }),
    wbResult('call_1', 'ok 42 passed'),
  ]) })
  apply(ctx)
  const def = chatDef(ctx, 'workbuddy')
  const value = await def.execute({ path: src })
  assert.equal(value.mode, 'single')
  assert.equal(value.toolCalls, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get(value.sessionId)
  const result = saved.events.find((e) => e.type === 'tool/result')
  assert.ok(result)
  assert.deepEqual(result.sourceEventSeqs, [saved.events.find((e) => e.type === 'tool/call').seq])
  assert.equal(result.data.message.content[0].content[0].text, 'ok 42 passed')
})

test('import_workbuddy 幂等：重复导入同一文件已存在则跳过', async () => {
  const src = 'D:\\demo\\workbuddy\\' + WB_SID + '.jsonl'
  const { ctx, persistence } = makeCtx({ [src]: wbTranscript([
    wbUser('第一问'),
    wbAssistant('一答'),
  ]) })
  apply(ctx)
  const def = chatDef(ctx, 'workbuddy')
  const first = await def.execute({ path: src })
  const second = await def.execute({ path: src })
  assert.equal(first.alreadyImported, false)
  assert.equal(second.alreadyImported, true)
  assert.equal(persistence.sessions.size, 1)
})
