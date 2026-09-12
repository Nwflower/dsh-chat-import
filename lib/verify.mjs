// lib/verify.mjs — verify_session：已导入会话只读结构校验（REQ-23）+ repair 提示
//
// 只读：sessionPersistence.list + readFrom，绝不 load/prepare、绝不改写。校验维度：
//   1. 事件结构（复用 validateSessionEvents：seq 连续 / 类型白名单 / surfaceOp /
//      sourceEventSeqs 指向 tool/call）；
//   2. 回合平衡（turn/start == turn/end、step/start == step/end）；
//   3. 工具配对（每个 tool/call 有 tool/result、每个 tool/result 有对应调用）。
// 问题逐条定位（kind + seq + message，封顶 20 条）；repairHints 按 kind 给出修复
// 建议（重导 / 闭合半开轮 / 源转录边界说明），失败大声不静默。

import { validateSessionEvents } from '../convert.mjs'
import { listPersistedHeaders, readSessionEvents, canReadSessionEvents } from './imports.mjs'

// kind → repair 提示（静态映射；无匹配 kind 的提示省略）。
const REPAIR_HINTS = {
  'seq-gap': 'seq 缺口：正常导入不会产生；建议 force:true 重导修复',
  'duplicate-seq': 'seq 重复：正常导入不会产生；建议 force:true 重导修复',
  'missing-seq': '事件缺 seq：正常导入不会产生；建议 force:true 重导修复',
  'unknown-type': '未知事件类型：白名单外事件不进入导入会话；若已出现建议 force:true 重导',
  'missing-surface-op': 'surface 事件缺 surfaceOp：建议 force:true 重导修复',
  'source-event-seqs-not-call': 'sourceEventSeqs 指向非 tool/call：正常导入不会产生；建议 force:true 重导',
  'turn-unbalanced': 'turn/start 与 turn/end 不配对：中断会话的半开尾轮属正常形态，闭合后才能续聊',
  'step-unbalanced': 'step/start 与 step/end 不配对：中断会话的半开尾步属正常形态',
  'call-without-result': '有 tool/call 无 tool/result：导入器兜底补发空结果；若仍出现建议 force:true 重导',
  'orphan-tool-result': 'tool/result 无对应 tool/call：源转录中途开始（前段调用不在日志内），属源边界',
  'not-array': 'events 不是数组：会话日志结构异常，建议检查持久化',
  'malformed': '事件条目不是对象：会话日志损坏，建议检查持久化',
}

export async function verifySession(ctx, args) {
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof sp.list !== 'function' || !canReadSessionEvents(sp)) {
    throw new Error('sessionPersistence 不可用（需要 list + 读事件面）')
  }
  const headers = await listPersistedHeaders(ctx)
  const header = headers.find((h) => h.id === args.sessionId)
  if (!header) throw new Error('会话不存在: ' + args.sessionId)
  const events = await readSessionEvents(ctx, args.sessionId, 0)
  const list = Array.isArray(events) ? events : []
  const problems = []

  const base = validateSessionEvents(list)
  problems.push(...base.problems)

  // 回合/步骤平衡
  const count = (type) => list.filter((e) => e && e.type === type).length
  const turnStarts = count('turn/start')
  const turnEnds = count('turn/end')
  if (turnStarts !== turnEnds) {
    problems.push({ kind: 'turn-unbalanced', seq: null, message: 'turn/start ' + turnStarts + ' vs turn/end ' + turnEnds + '（半开尾轮 = 中断会话）' })
  }
  const stepStarts = count('step/start')
  const stepEnds = count('step/end')
  if (stepStarts !== stepEnds) {
    problems.push({ kind: 'step-unbalanced', seq: null, message: 'step/start ' + stepStarts + ' vs step/end ' + stepEnds })
  }

  // 工具配对（call/result 一一对应）
  const callIds = new Set()
  for (const ev of list) {
    if (ev && ev.type === 'tool/call' && ev.data && typeof ev.data.callId === 'string') callIds.add(ev.data.callId)
  }
  const resulted = new Set()
  for (const ev of list) {
    if (ev && ev.type === 'tool/result' && ev.data && ev.data.message && Array.isArray(ev.data.message.content)) {
      for (const b of ev.data.message.content) {
        if (b && b.type === 'tool-result' && typeof b.toolCallId === 'string') resulted.add(b.toolCallId)
      }
    }
  }
  const callWithoutResult = [...callIds].filter((id) => !resulted.has(id))
  if (callWithoutResult.length > 0) {
    problems.push({ kind: 'call-without-result', seq: null, message: callWithoutResult.length + ' 个 tool/call 无对应 tool/result' })
  }
  const orphanResults = [...resulted].filter((id) => !callIds.has(id))
  if (orphanResults.length > 0) {
    problems.push({ kind: 'orphan-tool-result', seq: null, message: orphanResults.length + ' 个 tool/result 无对应 tool/call（源转录中途开始）' })
  }

  const problemKinds = new Set(problems.map((p) => p.kind))
  const repairHints = Object.entries(REPAIR_HINTS)
    .filter(([kind]) => problemKinds.has(kind))
    .map(([kind, hint]) => ({ kind, hint }))

  return {
    mode: 'single',
    sessionId: args.sessionId,
    ok: problems.length === 0,
    eventCount: list.length,
    turns: turnStarts,
    problems: problems.slice(0, 20),
    repairHints,
    ...(header.title ? { title: header.title } : {}),
  }
}
