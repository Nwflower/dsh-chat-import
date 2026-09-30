// lib/verify.mjs — verify_session：已导入会话只读结构校验+ repair 提示
//
// 只读：sessionPersistence.list + readFrom，绝不 load/prepare、绝不改写。校验维度：
//   1. 事件结构（复用 validateSessionEvents：seq 连续 / 类型白名单 / surfaceOp /
//      sourceEventSeqs 指向 tool/call）；
//   2. 回合平衡（turn/start == turn/end、step/start == step/end）；
//   3. 工具配对（每个 tool/call 有 tool/result、每个 tool/result 有对应调用），以及
//      V4 迁移风险（调用须有 assistant/message 内容块广告、结果须闭合在调用所在 step
//      内、每个调用恰好一条结果——dsh v3→v4 迁移器对这三条 fail-closed，违者整份拒载）。
// 问题逐条定位（kind + seq + message，封顶 20 条）；repairHints 按 kind 给出修复
// 建议（重导 / 闭合半开轮 / 源转录边界说明），失败大声不静默。

import { validateSessionEvents, toolResultOf, hasExternalAgentEnvelope } from './convert/index.mjs'
import { listPersistedHeaders, readSessionEvents, canReadSessionEvents } from './imports.mjs'

// kind → repair 提示（静态映射；无匹配 kind 的提示省略）。
const REPAIR_HINTS = {
  'seq-gap': 'seq 缺口：正常导入不会产生；建议 force:true 重导修复',
  'duplicate-seq': 'seq 重复：正常导入不会产生；建议 force:true 重导修复',
  'missing-seq': '事件缺 seq：正常导入不会产生；建议 force:true 重导修复',
  'unknown-type': '未知事件类型：白名单外事件不进入导入会话；若已出现建议 force:true 重导',
  'missing-surface-op': 'surface 事件缺 surfaceOp：建议 force:true 重导修复',
  // issue #66：环境变更声明曾写在首个 step/start 之前，宿主 v2→v3 迁移 fail-closed
  // 拒载这类旧格式工件（读路径也随之读不到）。写入侧已修，存量会话只能重导。
  'surface-before-first-step': 'surface 事件早于首个 step/start：旧版本导入的日志需要格式迁移时会被宿主拒载；用 force:true 重导（或面板「刷新已导入」）按新注入位重写',
  'source-event-seqs-not-call': 'sourceEventSeqs 指向非 tool/call：正常导入不会产生；建议 force:true 重导',
  'turn-unbalanced': 'turn/start 与 turn/end 不配对：中断会话的半开尾轮属正常形态，闭合后才能续聊',
  'step-unbalanced': 'step/start 与 step/end 不配对：中断会话的半开尾步属正常形态',
  'call-without-result': '有 tool/call 无 tool/result：导入器兜底补发空结果；若仍出现建议 force:true 重导',
  'orphan-tool-result': 'tool/result 无对应 tool/call：源转录中途开始（前段调用不在日志内），属源边界；宿主升 V4 后迁移 fail-closed 拒载，建议 force:true 重导',
  'unadvertised-tool-call': 'tool/call 无 assistant/message 内容块广告：宿主升 V4 后迁移 fail-closed 拒载，建议 force:true 重导',
  'cross-step-result': 'tool/result 闭合在调用所在 step 之外（异步工具跨 step 记录）：宿主 V4 要求 step 闭合前配平全部调用，迁移 fail-closed 拒载，建议 force:true 重导',
  'duplicate-tool-result': '同一 tool/call 有多条 tool/result：宿主要求恰好一条，迁移 fail-closed 拒载，建议 force:true 重导',
  'not-array': 'events 不是数组：会话日志结构异常，建议检查持久化',
  'malformed': '事件条目不是对象：会话日志损坏，建议检查持久化',
  // issue #62：带小数的源时间戳（ChatGPT 官方导出的 create_time 是带小数的 Unix 秒）
  // 曾被换算成浮点毫秒，事件 time 不是安全整数 → 宿主整份拒收（"time must be a safe
  // integer"）。这类会话用 force:true 重导即可得到整数化时间戳。
  'non-integer-time': '事件 time 不是安全整数毫秒：宿主会拒收整份会话（"time must be a safe integer"）；用 force:true 重导以整数化时间戳',
  // 存量旧形状（同 D9 的 system-head-missing 手法）：旧版转换器把 Codex Desktop「外部 agent
  // 会话导入」的展平工具信封当正文导入，工具调用至今是散文。日志 append-only，只能重导；
  // 源未变时普通重导会被幂等闸跳过，必须显式 force。
  'flattened-tool-envelope': '正文里残留 Codex 外部导入的展平工具信封（工具调用未还原为 tool/call）：旧版本导入的存量形状；源未变时普通重导会被幂等闸跳过，用 force:true 重导即可还原为工具消息',
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

  // 工具配对（call/result 一一对应）+ V4 迁移风险。dsh v3→v4 迁移器对工具生命周期
  // fail-closed：tool/call 必须有 assistant/message 内容块广告、结果必须闭合在调用的
  // step 内（step/end 清空未闭合调用）、每个调用恰好一条结果。旧版导入器产物里这三类
  // 形状真实存在，宿主升 V4 时整份拒载——这里提前报出；append-only 不改写既有日志，
  // 修复路径只有 force:true 重导。
  const callEvents = new Map()
  for (const ev of list) {
    if (ev && ev.type === 'tool/call' && ev.data && typeof ev.data.callId === 'string' && !callEvents.has(ev.data.callId)) {
      callEvents.set(ev.data.callId, ev)
    }
  }
  const advertised = new Set()
  for (const ev of list) {
    if (!ev || ev.type !== 'assistant/message') continue
    const content = ev.data && ev.data.message && Array.isArray(ev.data.message.content) ? ev.data.message.content : []
    for (const block of content) {
      if (block && block.type === 'tool-call' && typeof block.id === 'string') advertised.add(block.id)
    }
  }
  const resultsByCall = new Map()
  for (const ev of list) {
    // 形状无关访问器：V3（wrapper）与 V4（一级 tool 消息）都要认，否则宿主升到 V4 后
    // 这里会把有结果的调用误判成 call-without-result，同时整批结果变成孤儿
    const result = toolResultOf(ev)
    if (!result) continue
    if (!resultsByCall.has(result.callId)) resultsByCall.set(result.callId, [])
    resultsByCall.get(result.callId).push(ev)
  }
  const callWithoutResult = [...callEvents.keys()].filter((id) => !resultsByCall.has(id))
  if (callWithoutResult.length > 0) {
    problems.push({ kind: 'call-without-result', seq: null, message: callWithoutResult.length + ' 个 tool/call 无对应 tool/result' })
  }
  const orphanResults = [...resultsByCall.keys()].filter((id) => !callEvents.has(id))
  if (orphanResults.length > 0) {
    problems.push({ kind: 'orphan-tool-result', seq: null, message: orphanResults.length + ' 个 tool/result 无对应 tool/call（源转录中途开始）' })
  }
  const unadvertisedCalls = [...callEvents.keys()].filter((id) => !advertised.has(id))
  if (unadvertisedCalls.length > 0) {
    problems.push({ kind: 'unadvertised-tool-call', seq: null, message: unadvertisedCalls.length + ' 个 tool/call 无 assistant/message 内容块广告' })
  }
  const duplicateCalls = [...resultsByCall.values()].filter((events) => events.length > 1)
  if (duplicateCalls.length > 0) {
    problems.push({ kind: 'duplicate-tool-result', seq: null, message: duplicateCalls.length + ' 个 tool/call 有多条 tool/result' })
  }
  const crossStepResults = []
  for (const [callId, resultEvents] of resultsByCall) {
    const call = callEvents.get(callId)
    if (!call) continue
    for (const ev of resultEvents) {
      // 只核 append 结果且双方都带整数 turn/step 的情形：surface 改写结果（非 append）
      // 不参与配对；缺坐标时无从比对，交由宿主迁移器判定
      if (ev.surfaceOp !== 'append') continue
      if (![call.data.turn, call.data.step, ev.data.turn, ev.data.step].every(Number.isInteger)) continue
      if (call.data.turn !== ev.data.turn || call.data.step !== ev.data.step) { crossStepResults.push(callId); break }
    }
  }
  if (crossStepResults.length > 0) {
    problems.push({ kind: 'cross-step-result', seq: null, message: crossStepResults.length + ' 个 tool/result 闭合在调用所在 step 之外' })
  }

  // 时间戳必须是安全整数毫秒：宿主的 header/事件校验会因浮点 time 整份拒收会话
  //（issue #62 Bug 3）。这里前置报出来——verify_session 是用户的诊断入口，比宿主的
  //「create failed」更容易定位到源时间戳。
  const badTimes = list.filter((e) => e && !Number.isSafeInteger(e.time))
  if (badTimes.length > 0) {
    problems.push({
      kind: 'non-integer-time',
      seq: typeof badTimes[0].seq === 'number' ? badTimes[0].seq : null,
      message: badTimes.length + ' 个事件的 time 不是安全整数（首个 seq ' + String(badTimes[0].seq) + '，值 ' + String(badTimes[0].time) + '）',
    })
  }

  // 存量旧形状点名（同 D9 的 system-head-missing 手法）：0.24.0 之前的转换器把 Codex
  // Desktop「外部 agent 会话导入」的展平工具信封当正文导入，工具调用至今留在正文里
  // （见 docs/architecture.md D18）。写入侧已修，但日志 append-only——存量会话只能重导。
  const flattenedSeqs = []
  for (const ev of list) {
    if (!ev || ev.type !== 'assistant/message') continue
    const content = ev.data && ev.data.message && Array.isArray(ev.data.message.content) ? ev.data.message.content : []
    if (content.some((b) => b && b.type === 'text' && typeof b.text === 'string' && hasExternalAgentEnvelope(b.text))) {
      flattenedSeqs.push(ev.seq)
    }
  }
  if (flattenedSeqs.length > 0) {
    problems.push({
      kind: 'flattened-tool-envelope',
      seq: typeof flattenedSeqs[0] === 'number' ? flattenedSeqs[0] : null,
      message: flattenedSeqs.length + ' 条 assistant/message 的正文里残留展平工具信封（工具调用未还原，首个 seq ' + String(flattenedSeqs[0]) + '）',
    })
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
