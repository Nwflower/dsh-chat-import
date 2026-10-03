// import-stats.test.mjs — 导入会话的耗时统计原料（逐步时间戳）与 token 用量映射测试
//
// 宿主 dsh-session-stats / token-meter 是对事件日志的纯 fold：
//   模型耗时 = step/start.time → assistant/message.time；工具耗时 = tool/call → tool/result；
//   token 桶 = assistant/message.data.usage（input/output/cacheRead/cacheWrite/reasoning）。
// 本文件验证：各源转录里**真实存在**的逐记录时间戳与 provider 回报用量被如实透传进事件
//（不伪造：源没有的字段不产生键）；首 token 延迟/输出速度不可导（stream 恒为 []）。
// 夹具全部合成。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { synthesizeSession, SESSION_FORMAT_VERSION } from '../lib/convert/core.mjs'
import { convertClaudeJsonl } from '../lib/convert/claude.mjs'
import { convertOpencodeJson } from '../lib/convert/opencode.mjs'
import { convertCodexJsonl } from '../lib/convert/codex.mjs'
import { convertKimiWire } from '../lib/convert/kimi.mjs'
import { convertQoderJsonl } from '../lib/convert/qoder.mjs'
import { convertQwenJsonl } from '../lib/convert/qwen.mjs'
import { convertOpenclawJson } from '../lib/convert/openclaw.mjs'
import { convertWorkbuddyJsonl } from '../lib/convert/workbuddy.mjs'
import { convertHermesJson } from '../lib/convert/hermes.mjs'
import { convertGooseJson } from '../lib/convert/goose.mjs'
import { convertCrushJson } from '../lib/convert/crush.mjs'
import { convertClineJson } from '../lib/convert/cline.mjs'
import { convertZcodeJson } from '../lib/convert/zcode.mjs'
import { convertChatgptJson } from '../lib/convert/chatgpt.mjs'
import { convertReasonixJsonl } from '../lib/convert/reasonix.mjs'
import { convertAntigravityJsonl } from '../lib/convert/antigravity.mjs'

const META = { version: SESSION_FORMAT_VERSION, id: 'import-stats', createdAt: 1000 }

// 常用断言：第 n 个某类事件
function at(events, type, n = 0) {
  const list = events.filter((e) => e.type === type)
  assert.ok(list.length > n, type + ' 至少 ' + (n + 1) + ' 条')
  return list[n]
}
// 事件时间单调不倒退（历史时钟纪律）
function assertMonotonic(events) {
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].time >= events[i - 1].time,
      '事件时间不倒退：seq ' + events[i - 1].seq + '→' + events[i].seq)
  }
}
const jsonl = (recs) => recs.map((r) => JSON.stringify(r)).join('\n')

// 合成时间戳（毫秒）
const T1 = 1767224645000 // 2026-01-01T03:04:05Z 附近
const T2 = T1 + 5000
const T3 = T1 + 11000
const T4 = T1 + 19000
const T5 = T1 + 26000
const ISO1 = new Date(T1).toISOString()
const ISO2 = new Date(T2).toISOString()
const ISO3 = new Date(T3).toISOString()
const ISO4 = new Date(T4).toISOString()
const ISO5 = new Date(T5).toISOString()

// ── synthesizeSession：usage 守卫 ────────────────────────────────────────

function synWithUsage(usage) {
  return synthesizeSession({
    meta: META,
    turns: [{
      prompt: '问', time: T1,
      steps: [{ content: [{ type: 'text', text: '答' }], toolCalls: [], toolResults: [], time: T2, usage }],
    }],
    provider: 'test', model: 'm', skipped: 0, records: 1,
  })
}

test('usage：合法桶写入 assistant/message.data.usage；stream 恒为 []（不虚构流）', () => {
  const out = synWithUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, reasoningTokens: 5 })
  const msg = at(out.events, 'assistant/message')
  assert.deepEqual(msg.data.usage, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, reasoningTokens: 5 })
  assert.deepEqual(msg.data.stream, [])
  assert.equal(msg.time, T2)
})

test('usage：input/output 缺失或非整数 → 整份丢弃（不污染宿主 token-meter 算术）', () => {
  for (const bad of [
    { outputTokens: 20 },
    { inputTokens: 100 },
    { inputTokens: 1.5, outputTokens: 20 },
    { inputTokens: -1, outputTokens: 20 },
    { inputTokens: '100', outputTokens: 20 },
  ]) {
    const out = synWithUsage(bad)
    assert.equal(at(out.events, 'assistant/message').data.usage, undefined, JSON.stringify(bad))
  }
})

test('usage：可选桶单项坏只丢该项', () => {
  const out = synWithUsage({ inputTokens: 10, outputTokens: 5, cacheReadTokens: -3, cacheWriteTokens: 1.2, reasoningTokens: 2 })
  assert.deepEqual(at(out.events, 'assistant/message').data.usage, { inputTokens: 10, outputTokens: 5, reasoningTokens: 2 })
})

// ── Claude Code：usage 映射（原有逐步时间戳行为顺带锁定） ────────────────

test('claude：message.usage → DSH usage 桶（cache_creation→Write、cache_read→Read）；逐行时间戳不变', () => {
  const out = convertClaudeJsonl(jsonl([
    { type: 'user', timestamp: ISO1, message: { role: 'user', content: '看看这个项目' } },
    {
      type: 'assistant', timestamp: ISO2,
      message: {
        role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: '好的。' }],
        usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 },
      },
    },
  ]), {})
  const msg = at(out.events, 'assistant/message')
  assert.equal(msg.time, T2)
  assert.deepEqual(msg.data.usage, { inputTokens: 100, outputTokens: 20, cacheWriteTokens: 30, cacheReadTokens: 40 })
  assert.equal(at(out.events, 'turn/start').time, T1)
  assertMonotonic(out.events)
})

test('claude：流式拆行合并组取最后一行的 usage（最完整）；无 usage 行不产生键', () => {
  const msgId = 'msg_01'
  const out = convertClaudeJsonl(jsonl([
    { type: 'user', timestamp: ISO1, message: { role: 'user', content: '写段代码' } },
    {
      type: 'assistant', timestamp: ISO2,
      message: { id: msgId, role: 'assistant', content: [{ type: 'text', text: '前半' }], usage: { input_tokens: 10, output_tokens: 5 } },
    },
    {
      type: 'assistant', timestamp: ISO3,
      message: { id: msgId, role: 'assistant', content: [{ type: 'text', text: '后半' }], usage: { input_tokens: 10, output_tokens: 20 } },
    },
    { type: 'user', timestamp: ISO4, message: { role: 'user', content: '继续' } },
    { type: 'assistant', timestamp: ISO5, message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } },
  ]), {})
  const msgs = out.events.filter((e) => e.type === 'assistant/message')
  assert.equal(msgs.length, 2)
  assert.deepEqual(msgs[0].data.usage, { inputTokens: 10, outputTokens: 20 })
  assert.equal(msgs[1].data.usage, undefined)
})

// ── opencode：消息级 createdAt + tokens ──────────────────────────────────

test('opencode：消息 createdAt → 轮/步时间；tokens → usage（含 reasoning/cache）', () => {
  const out = convertOpencodeJson(JSON.stringify({
    id: 'ses_1', title: 't', directory: '/p', createdAt: T1, model: 'm1',
    messages: [
      { id: 'u1', role: 'user', createdAt: T1, parts: [{ type: 'text', text: '查一下' }] },
      {
        id: 'a1', role: 'assistant', createdAt: T2,
        tokens: { input: 50, output: 10, reasoning: 4, cache: { read: 6, write: 7 } },
        parts: [{ type: 'text', text: '好' }],
      },
    ],
  }), {})
  assert.equal(at(out.events, 'turn/start').time, T1)
  const msg = at(out.events, 'assistant/message')
  assert.equal(msg.time, T2)
  assert.deepEqual(msg.data.usage, { inputTokens: 50, outputTokens: 10, reasoningTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 7 })
  assertMonotonic(out.events)
})

test('opencode：tokens 形状垃圾 → 无 usage 键；无 tokens 不产生键', () => {
  const out = convertOpencodeJson(JSON.stringify({
    id: 'ses_2', createdAt: T1,
    messages: [
      { id: 'u1', role: 'user', createdAt: T1, parts: [{ type: 'text', text: '问' }] },
      { id: 'a1', role: 'assistant', createdAt: T2, tokens: { input: 'x', output: 3 }, parts: [{ type: 'text', text: '答' }] },
      { id: 'a2', role: 'assistant', createdAt: T3, parts: [{ type: 'text', text: '答2' }] },
    ],
  }), {})
  const msgs = out.events.filter((e) => e.type === 'assistant/message')
  assert.equal(msgs[0].data.usage, undefined)
  assert.equal(msgs[1].data.usage, undefined)
})

// ── codex：行信封 timestamp ─────────────────────────────────────────────

test('codex：行 timestamp → 轮/步/工具结果时间（工具耗时 = 结果 − 调用）', () => {
  const out = convertCodexJsonl(jsonl([
    // session_meta 提供 createdAt 锚点（历史时钟起点；缺它 meta.createdAt 落到 Date.now()，
    // 比所有历史时间戳都大 → advance 拒绝倒退，逐步时间全被钉在「现在」）
    { timestamp: ISO1, type: 'session_meta', payload: { id: 'cx1', cwd: '/p', timestamp: ISO1 } },
    { timestamp: ISO1, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '跑一下测试' }] } },
    { timestamp: ISO2, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好' }] } },
    { timestamp: ISO3, type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"cmd":"npm test"}' } },
    { timestamp: ISO4, type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' } },
  ]), {})
  assert.equal(at(out.events, 'turn/start').time, T1)
  const msg = at(out.events, 'assistant/message')
  assert.equal(msg.time, T2)
  const call = at(out.events, 'tool/call')
  const result = at(out.events, 'tool/result')
  assert.equal(result.time, T4)
  assert.ok(result.time > call.time, '工具耗时为正（' + (result.time - call.time) + 'ms）')
  assertMonotonic(out.events)
})

// ── kimi（新 wire）：turn.prompt / loop_event 行时间 ─────────────────────

test('kimi：turn.prompt/step.begin/tool.result 行时间 → 轮/步/结果时间', () => {
  const out = convertKimiWire(jsonl([
    { type: 'turn.prompt', time: T1, input: '查日志' },
    { type: 'context.append_loop_event', time: T2, event: { type: 'step.begin' } },
    { type: 'context.append_loop_event', time: T3, event: { type: 'content.part', part: { type: 'text', text: '看一下' } } },
    { type: 'context.append_loop_event', time: T4, event: { type: 'tool.call', toolCallId: 'k1', name: 'bash', args: { cmd: 'tail log' } } },
    { type: 'context.append_loop_event', time: T5, event: { type: 'tool.result', toolCallId: 'k1', result: { output: 'ok' } } },
  ]), {})
  assert.equal(at(out.events, 'turn/start').time, T1)
  assert.equal(at(out.events, 'assistant/message').time, T2)
  assert.equal(at(out.events, 'tool/result').time, T5)
  assertMonotonic(out.events)
})

// ── qoder / qwen / openclaw / workbuddy：逐行 timestamp ──────────────────

test('qoder：行 timestamp → 轮/步/结果时间', () => {
  const out = convertQoderJsonl(jsonl([
    { type: 'user', sessionId: 'q1', timestamp: ISO1, message: { role: 'user', content: '读 README' } },
    { type: 'assistant', sessionId: 'q1', timestamp: ISO2, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'README.md' } }] } },
    { type: 'user', sessionId: 'q1', timestamp: ISO3, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '# 标题' }] }] } },
  ]), {})
  assert.equal(at(out.events, 'turn/start').time, T1)
  assert.equal(at(out.events, 'assistant/message').time, T2)
  assert.equal(at(out.events, 'tool/result').time, T3)
  assertMonotonic(out.events)
})

test('qwen：行 timestamp → 轮/步/结果时间', () => {
  const out = convertQwenJsonl(jsonl([
    { type: 'user', sessionId: 'w1', timestamp: ISO1, message: { role: 'user', content: '查一下' } },
    { type: 'assistant', sessionId: 'w1', timestamp: ISO2, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'grep', input: { p: 'x' } }] } },
    { type: 'user', sessionId: 'w1', timestamp: ISO3, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'hit' }] }] } },
  ]), {})
  assert.equal(at(out.events, 'turn/start').time, T1)
  assert.equal(at(out.events, 'assistant/message').time, T2)
  assert.equal(at(out.events, 'tool/result').time, T3)
  assertMonotonic(out.events)
})

test('openclaw：行 timestamp → 轮/步/结果时间', () => {
  const out = convertOpenclawJson([
    '{"type":"session","id":"oc1","cwd":"/p","timestamp":"' + ISO1 + '"}',
    '{"type":"message","message":{"role":"user","content":"搜索 x"},"timestamp":"' + ISO1 + '"}',
    '{"type":"message","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"search","input":{}}]},"timestamp":"' + ISO2 + '"}',
    '{"type":"message","message":{"role":"toolResult","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"1 个结果"}]}]},"timestamp":"' + ISO3 + '"}',
  ].join('\n'), {})
  assert.equal(at(out.events, 'assistant/message').time, T2)
  assert.equal(at(out.events, 'tool/result').time, T3)
  assertMonotonic(out.events)
})

test('workbuddy：function_call/result 行时间 → 步/结果时间', () => {
  const out = convertWorkbuddyJsonl(jsonl([
    { type: 'message', timestamp: T1, role: 'user', content: [{ type: 'input_text', text: '跑个命令' }], sessionId: 'wb1', cwd: '/p' },
    { type: 'function_call', timestamp: T2, callId: 'c1', name: 'bash', arguments: '{}', sessionId: 'wb1' },
    { type: 'function_call_result', timestamp: T3, callId: 'c1', status: 'completed', output: 'ok' },
  ]), {})
  assert.equal(at(out.events, 'turn/start').time, T1)
  assert.equal(at(out.events, 'assistant/message').time, T2)
  assert.equal(at(out.events, 'tool/result').time, T3)
  assertMonotonic(out.events)
})

// ── hermes / goose / crush / cline / zcode ───────────────────────────────

test('hermes：消息 ts → 轮/步/结果时间', () => {
  const out = convertHermesJson(jsonl([
    { type: 'message', timestamp: ISO1, message: { role: 'user', content: '查一下' } },
    { type: 'message', timestamp: ISO2, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'grep', input: {} }] } },
    { type: 'message', timestamp: ISO3, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'hit' }] }] } },
  ]), {})
  assert.equal(at(out.events, 'turn/start').time, T1)
  assert.equal(at(out.events, 'assistant/message').time, T2)
  assert.equal(at(out.events, 'tool/result').time, T3)
  assertMonotonic(out.events)
})

test('goose：createdTimestamp（毫秒）→ 轮/步/结果时间', () => {
  const session = JSON.stringify({
    id: 'g1', name: 't', workingDir: '/p', sessionType: 'user',
    createdAt: T1, updatedAt: T5, messages: [
      { role: 'user', createdTimestamp: T1, content: [{ type: 'text', text: '查一下' }] },
      { role: 'assistant', createdTimestamp: T2, content: [{ type: 'toolRequest', id: 'r1', tool_call: { status: 'success', value: { name: 'grep', arguments: {} } } }] },
      { role: 'user', createdTimestamp: T3, content: [{ type: 'toolResponse', id: 'r1', tool_result: { status: 'success', value: 'hit' } }] },
    ],
  })
  const out = convertGooseJson(session, { createdAt: T1 })
  assert.equal(at(out.events, 'turn/start').time, T1)
  assert.equal(at(out.events, 'assistant/message').time, T2)
  assert.equal(at(out.events, 'tool/result').time, T3)
  assertMonotonic(out.events)
})

test('crush：assistant 用 finished_at（回复完成时刻）作步时间；结果用消息 created_at', () => {
  const S1 = 1768000101, S2 = 1768000105, S3 = 1768000111, S4 = 1768000120 // Unix 秒
  const session = JSON.stringify({
    id: 'cr1', title: 't', createdAt: S1 * 1000, updatedAt: S4 * 1000, messages: [
      { id: 'u1', role: 'user', parts: [{ type: 'text', data: { text: '查一下' } }], createdAt: S1, finishedAt: null, isSummaryMessage: 0 },
      {
        id: 'a1', role: 'assistant', parts: [
          { type: 'tool_call', data: { id: 'c1', name: 'grep', input: '{}' } },
        ], createdAt: S2, finishedAt: S3, isSummaryMessage: 0,
      },
      {
        id: 't1', role: 'tool', parts: [
          { type: 'tool_result', data: { tool_call_id: 'c1', name: 'grep', content: 'hit', is_error: false } },
        ], createdAt: S4, finishedAt: null, isSummaryMessage: 0,
      },
    ],
  })
  const out = convertCrushJson(session, { createdAt: S1 * 1000, crushId: 'cr1' })
  assert.equal(at(out.events, 'turn/start').time, S1 * 1000)
  assert.equal(at(out.events, 'assistant/message').time, S3 * 1000, 'finished_at 优先')
  assert.equal(at(out.events, 'tool/result').time, S4 * 1000)
  assertMonotonic(out.events)
})

test('cline：assistant 消息 ts → 步时间；user 消息无 ts（格式契约）不造轮时间', () => {
  const session = JSON.stringify({
    version: 1, updated_at: ISO5, agent: 'lead', sessionId: 'cl1', messages: [
      { role: 'user', content: [{ type: 'text', text: '查一下' }] },
      { role: 'assistant', ts: T2, content: [{ type: 'text', text: '好' }] },
    ],
  })
  const out = convertClineJson(session, { createdAt: T1, clineId: 'cl1' })
  assert.equal(at(out.events, 'assistant/message').time, T2)
  assertMonotonic(out.events)
})

test('zcode：消息 createdAt → 轮/步时间', () => {
  const out = convertZcodeJson(JSON.stringify({
    id: 'z1', title: 't', directory: '/p', createdAt: T1, messages: [
      { id: 'u1', role: 'user', createdAt: T1, parts: [{ type: 'text', text: '查一下' }] },
      { id: 'a1', role: 'assistant', createdAt: T2, parts: [{ type: 'text', text: '好' }] },
    ],
  }), {})
  assert.equal(at(out.events, 'turn/start').time, T1)
  assert.equal(at(out.events, 'assistant/message').time, T2)
  assertMonotonic(out.events)
})

// ── chatgpt / antigravity ──────────────────────────────────────────────

test('chatgpt：消息 create_time（浮点秒，取整）→ 轮/步/结果时间', () => {
  const S = 1767583930.285031 // 官方导出的浮点秒形态
  const conv = {
    id: 'conv-stat', title: 't', create_time: S,
    mapping: {
      root: { id: 'root', message: null, parent: null },
      n1: { id: 'n1', parent: 'root', message: { author: { role: 'user' }, create_time: S, content: { parts: ['查一下'] } } },
      n2: { id: 'n2', parent: 'n1', message: { author: { role: 'assistant' }, create_time: S + 5, content: { parts: ['好'] } } },
    },
  }
  // convertChatgptJson 吃官方导出（会话数组），逐会话结果在 conversations 里
  const out = convertChatgptJson(JSON.stringify([conv]), {}).conversations[0]
  const ms = Math.round(S * 1000)
  assert.equal(at(out.events, 'turn/start').time, ms)
  assert.equal(at(out.events, 'assistant/message').time, ms + 5000)
  assertMonotonic(out.events)
})

test('antigravity：逐记录 created_at → 轮/步/结果时间', () => {
  const out = convertAntigravityJsonl([
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: ISO1, content: '<USER_REQUEST>\n查一下\n</USER_REQUEST>' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: ISO2, content: '好', tool_calls: [{ name: 'bash', args: {} }] }),
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: ISO3, content: 'Task done: ok' }),
  ].join('\n') + '\n', { antigravityId: 'ag-stat' })
  assert.equal(at(out.events, 'turn/start').time, T1)
  assert.equal(at(out.events, 'assistant/message').time, T2)
  assert.equal(at(out.events, 'tool/result').time, T3)
  assertMonotonic(out.events)
})

test('reasonix：行级 createdAt → 步/结果时间；usage（snake_case）守卫映射', () => {
  const out = convertReasonixJsonl(jsonl([
    { role: 'user', content: '查一下', createdAt: T1 },
    {
      role: 'assistant', content: '好', createdAt: T2,
      usage: { input_tokens: 40, output_tokens: 8, cache_read_tokens: 5, reasoning_tokens: 2 },
      tool_calls: [{ id: 'r1', name: 'grep', arguments: '{}' }],
    },
    { role: 'tool', tool_call_id: 'r1', name: 'grep', content: 'hit', createdAt: T3 },
  ]), { reasonixId: 'desktop-202601010304-1' })
  assert.equal(at(out.events, 'turn/start').time, T1)
  const msg = at(out.events, 'assistant/message')
  assert.equal(msg.time, T2)
  assert.deepEqual(msg.data.usage, { inputTokens: 40, outputTokens: 8, cacheReadTokens: 5, reasoningTokens: 2 })
  assert.equal(at(out.events, 'tool/result').time, T3)
  assertMonotonic(out.events)
})

// ── 畸形时间戳：不把「现在」混进历史时钟 ────────────────────────────────

test('畸形/缺失时间戳 → 该记录不占时间键（时钟取最近已知值，不倒退、不跳现在）', () => {
  const out = convertQoderJsonl(jsonl([
    { type: 'user', sessionId: 'q2', timestamp: ISO1, message: { role: 'user', content: '第一问' } },
    { type: 'assistant', sessionId: 'q2', timestamp: 'not-a-date', message: { role: 'assistant', content: [{ type: 'text', text: '答一' }] } },
    { type: 'user', sessionId: 'q2', timestamp: ISO3, message: { role: 'user', content: '第二问' } },
    { type: 'assistant', sessionId: 'q2', message: { role: 'assistant', content: [{ type: 'text', text: '答二' }] } },
  ]), {})
  const msgs = out.events.filter((e) => e.type === 'assistant/message')
  assert.equal(msgs[0].time, T1, '畸形时间戳 → 停在上一个已知时间')
  assert.equal(msgs[1].time, T3)
  assertMonotonic(out.events)
})
