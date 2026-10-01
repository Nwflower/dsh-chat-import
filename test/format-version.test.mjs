// test/format-version.test.mjs — 工具结果跨格式版本形状（V3 wrapper ↔ V4 一级 tool 消息）
//
// 背景：宿主对 tool/result 的 message 形状是**互斥**校验的——
//   V3（≤0.1.5-rc.2，dsh-session/lib/index.js:950-955）：content 必须恰好一个
//     {type:'tool-result'} wrapper，且 wrapper.toolCallId 与 source.callId 一致；
//   V4（≥0.1.7-alpha.1，core/session/src/index.ts:380）：message.toolCallId 必须与
//     source.callId 一致，且 content 里**禁止**再出现 wrapper。
// 因此产出必须跟随宿主版本；这里锁住两种形状的双向归一、幂等性，以及写盘前的版本分流。
import test from 'node:test'
import assert from 'node:assert/strict'
import { shapeToolResults, toolResultOf } from '../lib/convert/index.mjs'
import { prepareHostEvents } from '../lib/import-core.mjs'

/** V3 形状的 tool/result（本插件 0.19.0 及更早的产出）。 */
function v3Event() {
  return {
    type: 'tool/result', seq: 7, time: 1700000000000, surfaceOp: 'append',
    data: {
      message: {
        id: 'import:s1:t1:1:call-1',
        role: 'user',
        source: { kind: 'tool', callId: 'call-1' },
        content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] }],
      },
    },
  }
}

/** V4 形状的 tool/result（一级 tool 消息，无 wrapper）。 */
function v4Event() {
  return {
    type: 'tool/result', seq: 7, time: 1700000000000, surfaceOp: 'append',
    data: {
      message: {
        id: 'import:s1:t1:1:call-1',
        role: 'tool',
        source: { kind: 'tool', callId: 'call-1' },
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'ok' }],
      },
    },
  }
}

const msgOf = (list) => list[0].data.message

test('shapeToolResults：V3 输入 → V4 宿主形状（去 wrapper、role=tool、一级 toolCallId）', () => {
  const [ev] = shapeToolResults([v3Event()], 4)
  const m = msgOf([ev])
  assert.equal(m.role, 'tool')
  assert.equal(m.toolCallId, 'call-1')
  assert.deepEqual(m.content, [{ type: 'text', text: 'ok' }], '内容从 wrapper 里提升到 message.content')
  assert.equal(m.source.kind, 'tool')
  assert.equal(m.source.callId, 'call-1')
  assert.ok(!m.content.some((b) => b.type === 'tool-result'), 'V4 禁止 wrapper')
})

test('shapeToolResults：V4 输入 → V3 宿主形状（折回 wrapper、role=user、去掉一级字段）', () => {
  const [ev] = shapeToolResults([v4Event()], 3)
  const m = msgOf([ev])
  assert.equal(m.role, 'user')
  assert.equal(m.toolCallId, undefined, 'V3 不接受一级 toolCallId')
  assert.equal(m.content.length, 1)
  assert.equal(m.content[0].type, 'tool-result')
  assert.equal(m.content[0].toolCallId, 'call-1')
  assert.deepEqual(m.content[0].content, [{ type: 'text', text: 'ok' }])
  assert.equal(m.source.callId, 'call-1', '两侧 callId 必须一致（V3 核心会话校验）')
})

test('shapeToolResults：isError 在两个版本都保留（V4 放 message、V3 放 wrapper）', () => {
  const v3err = v3Event()
  v3err.data.message.content[0].isError = true
  assert.equal(msgOf(shapeToolResults([v3err], 4)).isError, true)
  const v4err = v4Event()
  v4err.data.message.isError = true
  const back = msgOf(shapeToolResults([v4err], 3))
  assert.equal(back.isError, undefined, 'V3 形状不把 isError 留在一级字段')
  assert.equal(back.content[0].isError, true)
})

test('shapeToolResults：幂等（同一目标版本重复归一结果稳定）', () => {
  for (const version of [3, 4]) {
    const once = shapeToolResults([v3Event()], version)
    const twice = shapeToolResults(once, version)
    assert.deepEqual(twice, once, 'version=' + version + ' 重复调用必须稳定')
    const fromV4 = shapeToolResults(shapeToolResults([v4Event()], version), version)
    assert.deepEqual(fromV4, once, 'version=' + version + ' 两种输入收敛到同一形状')
  }
})

test('shapeToolResults：无法关联 callId 的畸形节点原样返回（不静默吞、不伪造 id）', () => {
  const broken = { type: 'tool/result', seq: 3, time: 1, data: { message: { id: 'm', role: 'user', content: [] } } }
  const [out] = shapeToolResults([broken], 4)
  assert.deepEqual(out, broken, '缺少 callId 时不做任何改写（交由校验层报错）')
})

test('shapeToolResults：非 tool/result 事件与非数组输入原样通过', () => {
  const other = { type: 'user/message', seq: 1, time: 1, data: { content: [] } }
  assert.deepEqual(shapeToolResults([other], 4), [other])
  assert.deepEqual(shapeToolResults(null, 4), [])
})

// 读侧：导出层（codex/kimi/opencode/grokbuild/claude）与 verify_session 都用这个访问器
// 读取**宿主里已存在**的会话事件——宿主升到 V4 后事件是一级 tool 消息，仍按 wrapper 找会
// 静默丢工具结果 / 误报孤儿。这里锁住两种形状都能读出同一组事实。
test('toolResultOf：V3 与 V4 两种形状读出同一组事实（导出/诊断读侧不受宿主版本影响）', () => {
  const fromV3 = toolResultOf(v3Event())
  const fromV4 = toolResultOf(v4Event())
  const want = { callId: 'call-1', blocks: [{ type: 'text', text: 'ok' }], isError: false }
  assert.deepEqual(fromV3, want, 'V3 wrapper 输入')
  assert.deepEqual(fromV4, want, 'V4 一级 tool 消息输入')
})

test('toolResultOf：isError 与畸形输入的处理', () => {
  const v4err = v4Event()
  v4err.data.message.isError = true
  assert.equal(toolResultOf(v4err).isError, true)
  const v3err = v3Event()
  v3err.data.message.content[0].isError = true
  assert.equal(toolResultOf(v3err).isError, true)
  // 非 tool/result、缺 callId、content 非数组 → null（调用方各自计数上报）
  assert.equal(toolResultOf({ type: 'user/message', seq: 1, data: {} }), null)
  assert.equal(toolResultOf({ type: 'tool/result', seq: 1, data: { message: { content: [] } } }), null)
  assert.equal(toolResultOf({ type: 'tool/result', seq: 1, data: { message: { toolCallId: 'c', content: 'nope' } } }), null)
  assert.equal(toolResultOf(null), null)
})

test('prepareHostEvents：按目标宿主版本分流（默认版本=转换层默认，显式 4 时出 V4 形状）', () => {
  const v3Out = prepareHostEvents([v3Event()], 's1', 3)
  assert.equal(msgOf(v3Out).role, 'user')
  assert.equal(msgOf(v3Out).content[0].type, 'tool-result')
  const v4Out = prepareHostEvents([v3Event()], 's1', 4)
  assert.equal(msgOf(v4Out).role, 'tool')
  assert.equal(msgOf(v4Out).toolCallId, 'call-1')
  // 默认参数走 SESSION_FORMAT_VERSION（转换层默认），不传 version 时行为与旧版一致
  const def = prepareHostEvents([v3Event()], 's1')
  assert.equal(msgOf(def).role, 'user')
})

// ---- V4 的 source.kind 形状（宿主 V4 退役了 'plugin'）----
// 宿主迁移器把 V3 的 {kind:'plugin', plugin:'X'} 改写成生产者自有 kind（kind:'plugin:X'，
// system-prompt 生产者另有 'system-prompt' 映射），读路径对 V4 日志直接拒绝 'plugin'
// （"format v4 message requires a producer-owned source kind"）。导入自产的上下文注入与
// system head 都用 kind='plugin'，写 V4 必须同步改写，否则宿主读不回自己刚写下的日志。

const pluginEnvEvent = () => ({
  type: 'user/message', seq: 0, time: 1, surfaceOp: 'append',
  data: { id: 'import:x:env', role: 'user', content: [{ type: 'text', text: 'note' }], source: { kind: 'plugin', plugin: 'chat-import' } },
})
const pluginHeadEvent = () => ({
  type: 'system/message', seq: 1, time: 1, surfaceOp: 'append',
  data: { turn: 1, step: 1, message: { id: 'import:x:sys', role: 'system', content: [], source: { kind: 'plugin', plugin: 'chat-import' } } },
})

test('V4 源形状：kind="plugin" 改写为生产者自有 kind；V3 保持原样', () => {
  const v4 = prepareHostEvents([pluginEnvEvent(), pluginHeadEvent()], 'import-x', 4)
  assert.deepEqual(v4[0].data.source, { kind: 'plugin:chat-import' })
  assert.deepEqual(v4[1].data.message.source, { kind: 'plugin:chat-import' })
  const v3 = prepareHostEvents([pluginEnvEvent(), pluginHeadEvent()], 'import-x', 3)
  assert.deepEqual(v3[0].data.source, { kind: 'plugin', plugin: 'chat-import' })
  assert.deepEqual(v3[1].data.message.source, { kind: 'plugin', plugin: 'chat-import' })
})

test('V4 源形状：宿主 system-prompt 生产者在 system 角色上映射为 "system-prompt"', () => {
  const ev = pluginHeadEvent()
  ev.data.message.source = { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }
  const v4 = prepareHostEvents([ev], 'import-x', 4)
  assert.deepEqual(v4[0].data.message.source, { kind: 'system-prompt' })
})

test('V4 源形状：非 plugin 的 kind 原样保留（幂等）', () => {
  const ev = pluginEnvEvent()
  ev.data.source = { kind: 'user' }
  assert.deepEqual(prepareHostEvents([ev], 'import-x', 4)[0].data.source, { kind: 'user' })
  assert.deepEqual(prepareHostEvents(prepareHostEvents([ev], 'import-x', 4), 'import-x', 4)[0].data.source, { kind: 'user' })
})

test('未知的更高版本（V5）不静默：按已知最高版本产出并大声告警一次', () => {
  const warnings = []
  const original = console.error
  console.error = (...args) => warnings.push(args.join(' '))
  try {
    const out = prepareHostEvents([pluginEnvEvent(), pluginHeadEvent()], 'import-x', 5)
    // 形状仍按已知最高版本（V4）：plugin → plugin:<name>
    assert.deepEqual(out[0].data.source, { kind: 'plugin:chat-import' })
    assert.equal(warnings.filter((w) => w.includes('会话格式版本 5 未知')).length, 1, '应恰好告警一次')
    prepareHostEvents([pluginEnvEvent()], 'import-x', 5)
    assert.equal(warnings.filter((w) => w.includes('会话格式版本 5 未知')).length, 1, '同一版本不重复告警')
  } finally {
    console.error = original
  }
})

test('V4 源形状：system head 的宿主生产者映射为 kind="system-prompt"', () => {
  const ev = pluginHeadEvent()
  ev.data.message.source = { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }
  const v4 = prepareHostEvents([ev], 'import-x', 4)
  assert.deepEqual(v4[0].data.message.source, { kind: 'system-prompt' })
})

test('V4 替换标记：compaction 检查点的 {op,start,end} 改名为 {op,startSeq,endSeq}；V3 保持原样', () => {
  const checkpoint = () => ({
    type: 'user/message', seq: 9, time: 1, surfaceOp: { op: 'replace', start: 2, end: 7 }, sourceEventSeqs: [2, 5, 7],
    data: { id: 'ck', role: 'user', content: [{ type: 'text', text: 'summary' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'c1' } },
  })
  const [v4] = prepareHostEvents([checkpoint()], 's1', 4)
  assert.deepEqual(v4.surfaceOp, { op: 'replace', startSeq: 2, endSeq: 7 })
  assert.deepEqual(v4.sourceEventSeqs, [2, 5, 7])
  const [v3] = prepareHostEvents([checkpoint()], 's1', 3)
  assert.deepEqual(v3.surfaceOp, { op: 'replace', start: 2, end: 7 })
})
