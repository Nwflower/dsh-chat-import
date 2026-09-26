// lib/convert/trim.mjs — 会话预算裁剪（turns IR → 预算内 turns IR）。
// 三层保护：单块上限（TEXT_BLOCK_CHAR_LIMIT / TOOL_RESULT_CHAR_LIMIT）→ 轮裁剪（trimTurns，
// 保留首尾锚点 + 摘要块）→ 工具结果整体裁剪（applyBudgetTrim 后的 markTrimmedSource 由 host 面调用）。
// 纯函数层：不读磁盘、不 import 宿主服务。
// 文本 → token 估算（折算系数约 2.0）：CJK 1 token/字、ASCII 1 token/4 字符。
// CJK 覆盖主平面/扩展 A/B/兼容、CJK 标点与全角形式；其余字符按 ASCII 折算。
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let cjk = 0
  let ascii = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if ((cp >= 0x3400 && cp <= 0x4dbf)
      || (cp >= 0x4e00 && cp <= 0x9fff)
      || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0x3000 && cp <= 0x303f)
      || (cp >= 0xff00 && cp <= 0xffef)
      || (cp >= 0x20000 && cp <= 0x2a6df)) {
      cjk++
    } else {
      ascii++
    }
  }
  return cjk + Math.ceil(ascii / 4)
}

// 第一层裁剪上限：单条文本 / 单条工具结果的最大字符数。
export const TEXT_BLOCK_CHAR_LIMIT = 16000
export const TOOL_RESULT_CHAR_LIMIT = 40000
const CROP_MARKER = '\n…（已裁剪）…\n'

// 单条文本裁剪：超限时保留头 75% + 尾 25%（合计 ≤ 上限），中间以裁剪标记衔接。
function cropText(text, limit) {
  if (text.length <= limit) return { text, cropped: false }
  const room = Math.max(1, limit - CROP_MARKER.length)
  const head = Math.floor(room * 0.75)
  const tail = room - head
  return { text: text.slice(0, head) + CROP_MARKER + text.slice(-tail), cropped: true }
}

// 裁剪一组 content block：text/reasoning 按 textLimit、tool-result 内部块按
// toolResultLimit（工具结果通常单块，近似单条结果上限）。返回 { blocks, cropped }。
export function cropContentBlocks(blocks, { textLimit = TEXT_BLOCK_CHAR_LIMIT, toolResultLimit = TOOL_RESULT_CHAR_LIMIT } = {}) {
  if (!Array.isArray(blocks)) return { blocks: [], cropped: 0 }
  let cropped = 0
  const out = blocks.map((b) => {
    if (!b || typeof b !== 'object') return b
    if ((b.type === 'text' || b.type === 'reasoning') && typeof b.text === 'string') {
      const r = cropText(b.text, textLimit)
      if (!r.cropped) return b
      cropped++
      return { ...b, text: r.text }
    }
    if (b.type === 'tool-result' && Array.isArray(b.content)) {
      const inner = cropContentBlocks(b.content, { textLimit: toolResultLimit, toolResultLimit })
      if (inner.cropped === 0) return b
      cropped += inner.cropped
      return { ...b, content: inner.blocks }
    }
    return b
  })
  return { blocks: out, cropped }
}

// content block 数组 → token 估算（text/reasoning 按正文、tool-call 按 arguments、
// tool-result 递归内部块；与投影到模型的消息内容口径一致）。
function estimateBlocks(blocks) {
  let total = 0
  for (const b of blocks || []) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' || b.type === 'reasoning') total += estimateTokens(b.text)
    else if (b.type === 'tool-call') total += estimateTokens(b.arguments)
    else if (b.type === 'tool-result' && Array.isArray(b.content)) total += estimateBlocks(b.content)
  }
  return total
}

// turns IR → token 估算：prompt + 每步 content + 工具结果 content。
// 单轮估算导出给合成层用：原生压缩检查点的 shadowedTokenCount 要如实报出被遮蔽内容的
// 估算值（宿主 compaction/summary 的字段语义），口径必须与预算判断一致。
export function estimateTurnTokens(turn) {
  if (!turn || typeof turn !== 'object') return 0
  let total = estimateTokens(turn.prompt)
  for (const s of turn.steps || []) {
    total += estimateBlocks(s.content)
    for (const tr of s.toolResults || []) total += estimateBlocks(tr.content)
  }
  return total
}

function estimateTurns(turns) {
  let total = 0
  for (const t of turns || []) total += estimateTurnTokens(t)
  return total
}

// 三层保护总入口。返回 { turns, trimmed }：turns 为裁剪后的新结构（输入不改动），
// trimmed 为裁剪上报计数（budget / 前后估算 / L1 裁剪块数 / L2 丢弃轮与消息 /
// L3 超半丢弃 / 摘要标记）。预算内会话只走 L1（单条超限内容裁剪），不截断。
//
// 受遮蔽前缀（turn.shadowed）：带原生压缩检查点的会话里，检查点之前的日志段是 log-only
// ——它在 DSH 的 surface 里被检查点替换，永远不进模型上下文。它们**不参与估算、不被裁剪、
// 不被丢弃**（裁剪它们既没有收益，还会破坏检查点的 shadowedSeqs 溯源）。层三因此只在
// 检查点之后的「有效段」上工作；上报的 originalTokens/estimatedTokens 也是有效段口径。
export function trimTurns(turns, budget, { anchorUserTexts = 3, summaryAllowance = 512 } = {}) {
  const all = turns || []
  let logOnlyEnd = 0
  while (logOnlyEnd < all.length && all[logOnlyEnd] && all[logOnlyEnd].shadowed === true) logOnlyEnd++
  const logOnly = all.slice(0, logOnlyEnd)
  const src = all.slice(logOnlyEnd)
  const originalTokens = estimateTurns(src)
  const trimmed = {
    budget,
    originalTokens,
    estimatedTokens: 0,
    croppedBlocks: 0,
    droppedTurns: 0,
    droppedMessages: 0,
    droppedToolCalls: 0,
    droppedToolResults: 0,
    droppedOversized: 0,
    summaryInserted: false,
  }
  if (src.length === 0) {
    trimmed.estimatedTokens = 0
    return { turns: logOnly, trimmed }
  }

  // L1：克隆 + 单条内容裁剪（text/reasoning ≤16K 字符、工具结果 ≤40K 字符）
  let croppedBlocks = 0
  const l1 = src.map((t) => ({
    // 保留 prompt/steps 之外的回合级字段（如 codex 的 aborted）：预算裁剪在生产路径上
    // 恒被调用（resolveImportBudget 恒返回数字），漏掉它会把「中断的回合」静默说成正常完成
    ...t,
    prompt: t.prompt,
    steps: (t.steps || []).map((s) => {
      const cc = cropContentBlocks(s.content)
      let stepCropped = cc.cropped
      let toolResults = s.toolResults || []
      if (toolResults.length > 0) {
        toolResults = toolResults.map((tr) => {
          const inner = cropContentBlocks(tr.content, { textLimit: TOOL_RESULT_CHAR_LIMIT, toolResultLimit: TOOL_RESULT_CHAR_LIMIT })
          stepCropped += inner.cropped
          if (inner.cropped === 0) return tr
          return { ...tr, content: inner.blocks }
        })
      }
      croppedBlocks += stepCropped
      return { ...s, content: cc.blocks, toolResults }
    }),
  }))
  trimmed.croppedBlocks = croppedBlocks

  const l1Estimate = estimateTurns(l1)
  if (l1Estimate <= budget) {
    trimmed.estimatedTokens = l1Estimate
    return { turns: [...logOnly, ...l1], trimmed }
  }

  // L2：消息预算截断——保留开头锚点（最早 3 轮，含其 assistant 消息与工具调用）+ 压缩摘要 + 尾部消息。
  // 尾部从末尾往回贪心，在「锚点 + 摘要预留」的剩余预算内尽量多留；锚点本身超
  // 预算（病态小预算）时从尾部收缩锚点，保证至少留 1 轮可续聊。
  const anchorCount = Math.min(anchorUserTexts, l1.length)
  let anchor = l1.slice(0, anchorCount)
  const rest = l1.slice(anchorCount)
  let anchorTokens = estimateTurns(anchor)
  while (anchor.length > 1 && anchorTokens + summaryAllowance > budget) {
    anchor = anchor.slice(0, -1)
    anchorTokens = estimateTurns(anchor)
  }
  const tail = []
  let tailTokens = 0
  for (let i = rest.length - 1; i >= 0; i--) {
    const add = estimateTurns([rest[i]])
    if (anchorTokens + summaryAllowance + tailTokens + add > budget) break
    tail.unshift(rest[i])
    tailTokens += add
  }
  // 锚点收缩从锚点尾部丢掉的轮次（l1[anchor.length, anchorCount)）并入 middle：
  // rest 为空（整段 ≤ 锚点轮数）时这些轮曾直接消失且不计 dropped*，导致
  // applyBudgetTrim engaged 全零 → trimmed 静默为 null。并入后走同一计数循环，
  // droppedTurns / droppedMessages / droppedToolCalls / droppedToolResults 如实反映；
  // 收缩守卫 anchor.length > 1 仍保证至少留 1 轮可续聊。
  const middle = [...l1.slice(anchor.length, anchorCount), ...rest.slice(0, rest.length - tail.length)]

  for (const t of middle) {
    trimmed.droppedTurns++
    let resultCount = 0
    for (const s of t.steps) {
      trimmed.droppedToolCalls += s.toolCalls.length
      trimmed.droppedToolResults += s.toolResults.length
      resultCount += s.toolResults.length
    }
    trimmed.droppedMessages += 1 + t.steps.length + resultCount
  }

  // 压缩摘要：作为 reasoning 块前置到首个保留尾部轮的 assistant 步骤（opencode
  // compaction 同款模式），不新增空 user 轮次；尾部为空时挂到锚点末轮。
  const kept = [...anchor, ...tail]
  if (trimmed.droppedTurns > 0 && kept.length > 0) {
    const attach = tail.length > 0 ? tail[0] : anchor[anchor.length - 1]
    const summaryText = '…[导入预算裁剪] 原对话约 ' + originalTokens
      + ' tokens，超出上下文预算 ' + budget + ' tokens。为保持可续聊，已保留开头锚点'
      + '与最近对话，裁剪中间 ' + trimmed.droppedTurns + ' 轮（' + trimmed.droppedMessages
      + ' 条消息、' + trimmed.droppedToolCalls + ' 次工具调用）。完整历史见源文件。'
    if (attach.steps.length > 0) {
      attach.steps[0].content.unshift({ type: 'reasoning', text: summaryText })
    } else {
      attach.steps.push({ content: [{ type: 'reasoning', text: summaryText }], toolCalls: [], toolResults: [] })
    }
    trimmed.summaryInserted = true
  }

  // L3：单条兜底——裁剪后单条消息仍超预算一半 → 直接丢弃（宁缺毋滥）。首轮
  // prompt 永不丢弃（保证至少一条可续聊的用户消息）；超大的 step 连同其工具调用
  // 一起丢（配对保持完整），超大的工具结果丢后由 synthesizeSession 补空结果。
  const halfBudget = budget / 2
  const kept2 = []
  for (let i = 0; i < kept.length; i++) {
    const t = kept[i]
    if (i > 0 && estimateTokens(t.prompt) > halfBudget) {
      trimmed.droppedTurns++
      let resultCount = 0
      for (const s of t.steps) {
        trimmed.droppedToolCalls += s.toolCalls.length
        trimmed.droppedToolResults += s.toolResults.length
        resultCount += s.toolResults.length
      }
      trimmed.droppedMessages += 1 + t.steps.length + resultCount
      trimmed.droppedOversized++
      continue
    }
    const steps = []
    for (const s of t.steps) {
      if (estimateBlocks(s.content) > halfBudget) {
        trimmed.droppedMessages++
        trimmed.droppedToolCalls += s.toolCalls.length
        trimmed.droppedToolResults += s.toolResults.length
        trimmed.droppedOversized++
        continue
      }
      const toolResults = []
      for (const tr of s.toolResults) {
        if (estimateBlocks(tr.content) > halfBudget) {
          trimmed.droppedMessages++
          trimmed.droppedToolResults++
          trimmed.droppedOversized++
          continue
        }
        toolResults.push(tr)
      }
      steps.push({ ...s, toolResults })
    }
    kept2.push({ ...t, steps })
  }

  trimmed.estimatedTokens = estimateTurns(kept2)
  return { turns: [...logOnly, ...kept2], trimmed }
}

// 统一裁剪入口（convertXxx 接线用）：budget 缺省/非正数 → 原样返回（trimmed=null，
// 不产生上报）；保护未实际生效（无任何裁剪/截断/丢弃）时同样返回 null，避免噪音。
export function applyBudgetTrim(turns, budget) {
  if (budget === undefined || budget === null) return { turns: turns || [], trimmed: null }
  const b = Number(budget)
  if (!Number.isFinite(b) || b <= 0) return { turns: turns || [], trimmed: null }
  const { turns: out, trimmed } = trimTurns(turns, b)
  const engaged = trimmed.croppedBlocks > 0 || trimmed.droppedTurns > 0 || trimmed.droppedMessages > 0
    || trimmed.droppedToolCalls > 0 || trimmed.droppedToolResults > 0 || trimmed.droppedOversized > 0
    || trimmed.summaryInserted
  return { turns: out, trimmed: engaged ? trimmed : null }
}

// ── 畸形行行号明细 + secrets 位置上报（共享纯函数）───────────────────
// 逐行 JSONL 转换器（claude/codex/cursor/reasonix/openclaw/grokbuild/hermes/kimi）
// 共用 parseJsonlLines：行号从 1 起；skipped 计数不设限，skippedLines 明细封顶
// SKIPPED_LINES_CAP（200）条；secrets 每行至多一条（首个命中 kind）。整文件转换器
// 无行概念，只回 skippedLines: []（如实，不虚构行号）。

