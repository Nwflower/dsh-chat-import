// lib/convert/ir.mjs — 回合中间结构（turns IR）的共用整理步骤（纯函数，原地改写 turns）
//
// 各来源把源记录还原成 turns IR（形状见 events.mjs 文件头）之后、交给合成之前按需套用；
// 规则只写在这里，来源只决定用不用。

// 同一步内的工具结果按该步 toolCalls 的声明顺序稳定排序（并行工具的结果常乱序到达）；
// 不属于本步调用的结果排在末尾、彼此保持原序。只整理 IR 的顺序——事件合成按调用顺序
// 逐个按 callId 取结果，不依赖这里。
export function alignStepResults(turns) {
  for (const t of turns) {
    for (const s of t.steps) {
      if (s.toolResults.length < 2 || s.toolCalls.length === 0) continue
      const order = new Map(s.toolCalls.map((c, i) => [c.id, i]))
      const rank = (r) => order.get(r.toolCallId) ?? s.toolCalls.length
      s.toolResults.sort((a, b) => rank(a) - rank(b))
    }
  }
}

// 同一 callId 的 tool-call 在会话里重复出现时只保留首次（结果仍按 callId 配对），后续
// 重复的 tool-call 块整块丢弃，返回丢弃数；step.toolCalls 按 content 里留下的 tool-call
// 块重建。DSH 会话折叠器对同一 callId 的第二次 start 会硬异常，并吞掉其后整段轨迹——
// 宁可少一条重复调用，也不能让整段对话读不出来。
export function dropDuplicateCalls(turns) {
  const seen = new Set()
  let dropped = 0
  for (const t of turns) {
    for (const s of t.steps) {
      const keptCalls = []
      const keptContent = []
      for (const block of s.content) {
        if (block.type === 'tool-call') {
          if (seen.has(block.id)) { dropped++; continue }
          seen.add(block.id)
          keptCalls.push(block)
        }
        keptContent.push(block)
      }
      s.content = keptContent
      s.toolCalls = keptCalls
    }
  }
  return dropped
}

// 失败重发 step 清洗（ghost retry 去重），返回丢弃的步数。一轮工具调用没等到结果而中止
// 时，源（Claude Code、WorkBuddy）会在紧随的下一步用同一个 callId 原样重发；两条都保留
// 会让日志出现重复 callId 的 tool/call（折叠器硬异常，见 dropDuplicateCalls）。相邻两步
// 全部满足才删前一步：
//   1) s1.content 全部是 tool-call 块（无 text/reasoning 产物）；
//   2) s1 没有挂任何 toolResults（结果从未到达 = 这一步确实失败）；
//   3) s1 的每个 callId 都在 s2 原样重发（同名同参）。
// 结果本就按 callId 配对到重发步，丢弃前一步不丢任何内容。同一步内的重复 callId、
// 非相邻步的重发不在本规则内，保持原样。
export function dropDeadRetrySteps(turns) {
  let dropped = 0
  for (const t of turns) {
    const steps = t.steps
    for (let i = 0; i < steps.length - 1; ) {
      const s1 = steps[i]
      const s2 = steps[i + 1]
      if (
        s1.content.length > 0 &&
        s1.content.every((b) => b.type === 'tool-call') &&
        s1.toolCalls.length > 0 &&
        s1.toolResults.length === 0 &&
        s1.toolCalls.every((c) =>
          s2.toolCalls.some((r) => r.id === c.id && r.name === c.name && r.arguments === c.arguments)
        )
      ) {
        steps.splice(i, 1)
        dropped++
        // 不前进：删除后新的 steps[i] 仍可能与后一步构成链式重试
      } else {
        i++
      }
    }
  }
  return dropped
}
