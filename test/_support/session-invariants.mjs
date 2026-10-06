// test/_support/session-invariants.mjs — 合成事件日志的结构不变量断言（测试共用件）
//
// 每个来源的转换器测试都要验同一批「DSH 会话日志该怎么长」的事实：调用与结果配对、
// surface 投影顺序合法（wire 规则）。此前这段在 13 个测试文件里各抄一份，已经漂移出
// 四种文本（crush/zed 少了「数量」二字、openclaw 用字符串拼接、qwen 多绕一次 Map）——
// 口径只留这里一份（AGENTS.md「同口径逻辑只留一份」）。
import assert from 'node:assert/strict'

/**
 * seq 从 0 连续（宿主日志的硬要求：seq 即数组下标，跳号 / 重复会让会话读不出来）。
 * 此前 6 个测试文件各写一遍 `events.forEach((e, i) => assert.equal(e.seq, i))`。
 */
export function assertSeqContinuity(events) {
  events.forEach((e, i) => assert.equal(e.seq, i, `第 ${i} 个事件的 seq 应为 ${i}（实际 ${e.seq}）`))
}

/**
 * 每个 tool/call 都有对应的 tool/result，且结果的 sourceEventSeqs 指向该调用的 seq
 *（synthesizeSession 的兜底配对保证，见 lib/convert/events.mjs）。
 */
export function assertToolPairing(events) {
  const calls = events.filter((e) => e.type === 'tool/call')
  const results = events.filter((e) => e.type === 'tool/result')
  assert.equal(results.length, calls.length, `tool/call(${calls.length}) 与 tool/result(${results.length}) 数量一致`)
  const resultByCall = new Map(results.map((r) => [r.data.message.content[0].toolCallId, r]))
  for (const c of calls) {
    const r = resultByCall.get(c.data.callId)
    assert.ok(r, `tool/result 存在 for call ${c.data.callId}`)
    assert.deepEqual(r.sourceEventSeqs, [c.seq], `call ${c.data.callId} 的 result 指向其 seq`)
  }
}

// 投影 LLM 消息序列：DSH 的 deriveMessages 按事件顺序扁平投影 surface 事件
//（user/message / assistant/message / tool/result），不做重排——事件顺序即
// wire 消息顺序。返回 [{role:'user'} | {role:'assistant', toolCallIds} | {role:'tool', toolCallId}]
// 序列。本模块私有：三个来源的测试此前各抄一份，但除顺序不变量外无人消费。
function projectSurfaceMessages(events) {
  return events
    .filter((e) => e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result')
    .map((e) => {
      if (e.type === 'user/message') return { role: 'user' }
      if (e.type === 'assistant/message') {
        return {
          role: 'assistant',
          toolCallIds: e.data.message.content.filter((c) => c.type === 'tool-call').map((c) => c.id),
        }
      }
      return { role: 'tool', toolCallId: e.data.message.content[0].toolCallId }
    })
}

/**
 * 消息投影顺序合法（wire 规则）：带 tool-call 块的 assistant 消息之后、到下一个
 * assistant / user 消息之前，其全部 toolCallId 必须已有对应 tool 消息——不允许
 *「带 tool_calls 的 assistant 后紧跟另一条 assistant 而中间无 tool 消息」，
 * 也不允许无对应 tool-call 的孤儿 tool 消息。返回投影序列供精确断言。
 */
export function assertMessageOrderLegal(events) {
  const msgs = projectSurfaceMessages(events)
  let open = []
  for (const m of msgs) {
    if (m.role === 'assistant') {
      assert.equal(open.length, 0, `assistant 前有未配对的 tool_calls（残留 ${open.join(',')}）`)
      open = [...m.toolCallIds]
    } else if (m.role === 'tool') {
      const i = open.indexOf(m.toolCallId)
      assert.ok(i !== -1, `tool 消息 ${m.toolCallId} 前没有对应的 tool-call`)
      open.splice(i, 1)
    } else {
      assert.equal(open.length, 0, `user 消息前有未配对的 tool_calls（残留 ${open.join(',')}）`)
    }
  }
  assert.equal(open.length, 0, `末尾残留未配对的 tool_calls（${open.join(',')}）`)
  return msgs
}
