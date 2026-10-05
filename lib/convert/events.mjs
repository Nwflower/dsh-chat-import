// lib/convert/events.mjs — 回合中间结构（IR）→ 平衡的 DSH 会话事件日志。
//
// 合成时要同时满足宿主的三组硬不变量：
//   * seq 从 0 连续；surface 事件带 surfaceOp:'append'；
//   * 工具生命周期：调用必须在被广告的同一 step 内闭合、每个调用恰好一条结果；
//   * surface 首事件是 system head（v3→v4 迁移的 protected head），环境变更声明紧随其后。
// tool/result 用 sourceEventSeqs 关联其 tool/call。
// turns: [{ prompt, promptBlocks?, steps: [{ content, toolCalls, toolResults }] }]
//
// 用户侧内容块（turns[i].promptBlocks，可选）：源记录的提问里带图片时（用户贴截图提问），
// prompt 只保留其文本投影（标题、空 prompt 判定、去重都用它），完整内容块放这里，合成时
// 优先用它。缺省时按 [{ type:'text', text: prompt }] 合成（既有行为）。
//
// 原生上下文压缩（可选 IR 字段，宿主 @deepseek-ai/dsh-compaction 的事件契约）：
//   turns[i].compaction = { summary, provider, model }  —— 该轮**之前**存在一次上下文压缩
//     （源转录里的压缩边界）。合成时在 turn/start 之前发射一次原生压缩事务，把此前的
//     全部会话 surface 节点（protected head 与环境变更声明除外）作为被遮蔽范围：
//       compaction/start { compactionId, turn: null }
//       compaction/summary { summary, shadowedRange, shadowedSeqs, shadowedTokenCount, provider, model }
//       user/message { surfaceOp: { op:'replace', start, end }, sourceEventSeqs: shadowedSeqs,
//                      source: { kind:'plugin', plugin:'compact', compactionId }, content: 摘要 }
//       compaction/end { compactionId, turn: null }
//     raw 日志保留被遮蔽的原始事件（replay 确定性），模型的投影则由 deriveMessages 折叠成
//     「摘要检查点 + 检查点之后的节点」——与源工具压缩后的真实上下文一致。检查点所属轮的
//     prompt 为空时不再补发 user/message（检查点本身就是这一轮的 user 侧消息）。
//     只有边界而没有可遮蔽节点（前段没有会话节点）时不发射事务——宿主不变式要求
//     shadowedSeqs 非空。
//   turns[i].time / steps[j].time / toolResults[k].time / compaction.time（可选，毫秒）：
//     源记录时间戳。事件 time 取最近一个已知时间且不倒退；全缺时为 meta.createdAt。
//     逐项时间戳决定宿主统计投影（dsh-session-stats）能否折出真实耗时：step.start→
//     assistant/message 是模型耗时，tool/call→tool/result 是工具耗时；全缺时这些耗时为 0。
//   steps[j].usage（可选）：源转录携带的 provider 回报 token 用量，DSH TokenUsage 形状
//     { inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }。
//     写入 assistant/message.data.usage，供宿主 token-meter / 统计投影折叠；input/output
//     不是非负安全整数时整份丢弃（宿主投影对它做算术，NaN 会污染总计），可选桶单项校验。
//     首 token 延迟/输出速度不可导：外部转录没有流块时间戳，stream 恒为 []，不伪造。
//   turns[i].shadowed = true —— 该轮已被后续压缩遮蔽（log-only）：预算裁剪跳过它
//     （见 trim.mjs），事件照常发射（它正是被遮蔽范围的内容）。
// systemPrompt: 可选——开关开启（importSystemPrompt）时各源提取的原始系统提示词。
// 无论开关与否，都会把「环境变更声明」作为「上下文注入」user/message（source.kind=
// 'plugin'，plugin='chat-import'）注入会话最前；开关开启时声明后附原始系统提示词。
// 正文按 dsh 惯例包 <system-reminder> 信封（见 contextInjectionText）。声明告知模型：
// 迁移到 DSH 后工具/权限/指令以 DSH 当前会话为准，避免沿用源工具系统提示词里的旧
// 工具名/旧命令（这些在 DSH 里不可用/不同）。
//
// 注入位（issue #66）：首个 turn 的**首个 step/start 之后**，即
//   turn/start → step/start → 声明 → 该轮真实提问
// 声明仍是模型可见顺序里的第一条消息（语义与「钉在首个 turn 之前」等价），但日志
// 里不再有任何 surface 事件早于第一个 step/start。宿主格式迁移（v2→v3）在第一个
// step/start 处插入 system head，而 emitSystem 要求已打开 step，迁移器对「首个
// step/start 之前的 surface 事件」fail-closed 拒绝（"format v2 surface before first
// step cannot acquire a system head without changing chronology"）——0.18.3 及以前
// 写出的日志正是这个形状，在需要迁移的旧格式 DSH 上打不开。首轮没有任何 step
//（只有提问、没有回复）时无 step/start 可锚，声明不注入（与无轮次时不注入一致）。
import { estimateTokens, estimateTurnTokens } from './trim.mjs'
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from './inject.mjs'

// 上下文注入的正文：环境变更声明 +（开关开启时）原始系统提示词，整体按 dsh 的注入惯例
// 包进 <system-reminder> 信封（OPEN / 正文 / CLOSE 逐行拼接，与引擎 agent-instructions 的
// 提示词形态同构；正文里的字面 </system-reminder> 转义为 <\/system-reminder>，防止源提示词
// 提前闭合信封）。声明放最前、用英文——信封是模型可见框架，英文跨源格式稳定。
function contextInjectionText(provider, systemPrompt) {
  const src = String(systemPrompt ?? '').trim()
  const label = typeof provider === 'string' && provider ? provider : 'unknown'
  let body = 'Environment change notice: this session was migrated from ' + label
    + ' to DeepSeek Harness (DSH). The current runtime environment, available tool'
    + ' list, permissions, and execution instructions are all governed by the current'
    + ' DSH session; do not reuse tool names, commands, or environment conventions'
    + ' from the source environment.'
  if (src) {
    body += '\n\n--- Original system prompt (for reference only) ---\n' + src
  }
  return [SYSTEM_REMINDER_OPEN, body.replaceAll(SYSTEM_REMINDER_CLOSE, '<\\/system-reminder>'), SYSTEM_REMINDER_CLOSE].join('\n')
}

export function synthesizeSession({ meta, turns, title, provider, model, skipped, records, skippedLines = [], secrets = [], permissionCount = 0, systemPrompt }) {
  const events = []
  let seq = 0
  let turn = 0
  let clock = meta.createdAt
  const advance = (time) => {
    if (Number.isSafeInteger(time) && time > clock) clock = time
  }
  const push = (type, data, surface, sourceEventSeqs) => {
    const ev = { type, seq: seq++, time: clock, data }
    if (surface === true) ev.surfaceOp = 'append'
    else if (surface) ev.surfaceOp = surface // 压缩检查点：surfaceOp = { op:'replace', start, end }
    if (sourceEventSeqs) ev.sourceEventSeqs = sourceEventSeqs
    events.push(ev)
    return ev
  }
  // 当前 surface 上的会话节点（user/assistant/tool 结果），按 surface 顺序。原生压缩事务
  // 的 shadowedSeqs 就是它：替换会把整段折叠成一个检查点，之后的 surface 只剩检查点本身，
  // 所以发射检查点后重置为 [检查点 seq]。protected head 与环境变更声明**不进这个列表**
  // （检查点不该遮蔽它们：head 是宿主迁移锚点，声明是本次迁移的环境说明）。
  let surfaceNodes = []
  let compactionCount = 0
  // 已被遮蔽内容的估算 token 数（累计到下一次检查点发射为止），供 compaction/summary 的
  // shadowedTokenCount 使用（宿主该字段的语义 = 被遮蔽内容的估算值）。
  let shadowedTokens = 0

  // 会话 surface 节点（进 surfaceNodes，供压缩事务遮蔽）。
  const pushConversation = (type, data, sourceEventSeqs) => {
    const ev = push(type, data, true, sourceEventSeqs)
    surfaceNodes.push(ev.seq)
    return ev
  }

  // 原生压缩事务（宿主 @deepseek-ai/dsh-compaction 的事件契约，README「Surface contract」）：
  // 把当前 surface 上的全部会话节点折叠成一个摘要检查点。turn: null = 独立事务（发生在两轮
  // 之间，与宿主 /compact 的原生形态一致），因此不能跨 turn 边界——调用点固定在 turn/start
  // 之前。没有可遮蔽节点或没有摘要正文时不发射（宿主不变式要求 shadowedSeqs 非空）。
  const pushCompactionCheckpoint = (c) => {
    const summary = String((c && c.summary) || '').trim()
    if (!summary || surfaceNodes.length === 0) return false
    compactionCount += 1
    advance(c.time)
    const compactionId = 'import:' + meta.id + ':c' + compactionCount
    const start = surfaceNodes[0]
    const end = surfaceNodes[surfaceNodes.length - 1]
    const shadowedSeqs = [...surfaceNodes]
    push('compaction/start', { compactionId, turn: null })
    push('compaction/summary', {
      compactionId,
      summary: [{ type: 'text', text: summary }],
      shadowedRange: { start, end },
      shadowedSeqs,
      shadowedTokenCount: shadowedTokens,
      provider: String((c && c.provider) || provider || 'unknown'),
      model: String((c && c.model) || model || mname || 'unknown'),
      rawOutput: [{ type: 'text', text: summary }],
    })
    const ck = push('user/message', {
      id: 'import:' + meta.id + ':ck' + compactionCount,
      role: 'user',
      content: [{ type: 'text', text: summary }],
      // 宿主 isCompactCheckpointSource 认的就是这个字面量标记（dsh-compaction/checkpoint
      // 的 COMPACT_CHECKPOINT_MARKER）。纯函数层不 import 宿主包，故照抄契约值。
      source: { kind: 'plugin', plugin: 'compact', compactionId },
    }, { op: 'replace', start, end }, shadowedSeqs)
    push('compaction/end', { compactionId, turn: null })
    surfaceNodes = [ck.seq]
    shadowedTokens = estimateTokens(summary)
    return true
  }

  const mname = model || provider

  // 会话级配对预扫描。DSH 的消息投影不重排（事件顺序即 wire 顺序），宿主 v3→v4
  // 迁移器对工具生命周期同样 fail-closed：调用必须在**被广告的同一 step 内**闭合
  //（step/end 时未闭合调用即拒载）、每个调用恰好一条结果、结果必须有广告。而源记录
  // 的异步结果可能晚于调用若干 step / 若干轮才到达，孤儿结果（转录中途开始）与重复
  // 结果也会出现，所以先按 callId 全程归位，再合成：
  //   - 真实结果统一发射在**调用的 step**（紧随其 tool/call）；跨 step/跨轮到达的
  //     异步结果提前到调用旁——调用所在 step 从此必然闭合，wire 顺序合法，配对语义
  //     不变（callId 关联保持，sourceEventSeqs 指向其 tool/call）；
  //   - 无广告调用的孤儿结果、同一调用的第 2+ 条结果：丢弃并计数（失败大声），
  //     计数经 attachConversionDetails / batchItem 上报，与 interchange 管线的
  //     orphan-tool-result 丢弃策略同口径。
  const callById = new Map()
  const resultByCallId = new Map()
  let duplicateToolResults = 0
  for (const t of turns) {
    for (const s of t.steps) {
      for (const tc of s.toolCalls) if (!callById.has(tc.id)) callById.set(tc.id, tc)
      for (const tr of s.toolResults) {
        if (resultByCallId.has(tr.toolCallId)) { duplicateToolResults++; continue }
        resultByCallId.set(tr.toolCallId, tr)
      }
    }
  }
  let orphanToolResults = 0
  for (const callId of [...resultByCallId.keys()]) {
    if (!callById.has(callId)) { orphanToolResults++; resultByCallId.delete(callId) }
  }

  // 导入归属只落 imports registry（sourcePath → dshId 反查即得），不写
  // 日志事件：dsh ≥ 0.1.2-alpha 的读取路径 fail-closed（KNOWN_SESSION_EVENT_TYPES
  // 白名单 + envelope 键白名单），宿主词汇表外的自产标记事件会让整份日志被拒载
  //（issue #34）。导入标记读取按 registry 优先、旧日志标记兜底。

  // 环境变更声明（总是注入）：作为「上下文注入」的 user/message 放在首个 turn 的
  // 首个 step/start 之后（注入位见函数头注释，issue #66）。source.kind='plugin' 让
  // UI 折叠显示为「上下文注入 · chat-import」；正文前置环境变更声明（模型看到的是
  // 迁移后的新环境，旧工具名/命令不再适用）。开关开启时各源把原始系统提示词收集进
  // systemPrompt，由 contextInjectionText 附在声明之后。只注入一次：惰性发射器在
  // 第一个 step/start 处消费后置位；首轮无 step 时无 step/start 可锚，不注入。
  // 系统提示词 head（宿主 v3→v4 迁移的硬不变量，issue：导入会话在 V4 宿主上打不开）：
  // surface 的第一个事件必须是 system/message，它是「protected head」——此后每一步宿主
  // 写自己的 system/message 都以它为替换锚点。宿主自己的会话在首个 step/start 处就写这
  // 一条（v2→v3 迁移器同样在第一个 step/start 处插一条空 head），导入会话此前不写，
  // surface 从 user/message 起，于是宿主续聊写 system/message 时被迁移器 fail-closed：
  //   "system/message requires a protected first surface head"
  //（导入会话本身、以及由它 seed 出来的续聊会话都会中招；原生会话因为有 head 不受影响。）
  // 内容留空（content: []）——与宿主自己合成的 head 同口径：head 只占住 surface 第 0 个
  // 节点，真正的系统提示词由宿主在下一步替换或归一化，导入不该虚构一份提示词。
  // 位置与宿主一致：第一个 step/start 之后、任何 surface 事件之前。
  let headPushed = false
  // 本轮提问的 user/message。用户侧内容块：源提问带图时用 promptBlocks（text + image），
  // 否则退回纯文本投影。压缩边界轮的空 prompt 不发：检查点本身就是这一轮的 user 侧消息
  //（Codex 在轮中间压缩，跨边界那一轮的提问属于被遮蔽范围，不能重复发一次）。
  const pushPrompt = (t) => {
    if (t.compaction && !String(t.prompt ?? '').trim()) return
    pushConversation('user/message', {
      id: 'import:' + meta.id + ':u' + turn,
      role: 'user',
      content: Array.isArray(t.promptBlocks) && t.promptBlocks.length > 0
        ? t.promptBlocks
        : [{ type: 'text', text: t.prompt }],
      source: { kind: 'user' },
    })
  }
  const pushSystemHead = (turn, step) => {
    headPushed = true
    push('system/message', {
      turn,
      step,
      message: {
        id: 'import:' + meta.id + ':sys',
        role: 'system',
        content: [],
        // 宿主 agents.create 的 seed 校验要求 system/message 来自 system-prompt 生产者
        // （"seed system/message at index 2 message must have system-prompt source"）；
        // 这里用宿主自己的 V3 形状（plugin=@deepseek-ai/dsh-system-prompt），写 V4 时由
        // shapeMessageSources 按宿主规则改写成 kind:'system-prompt'。
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
      },
    }, true)
  }

  let envInjected = false
  const pushEnvInjection = () => {
    envInjected = true
    push('user/message', {
      id: 'import:' + meta.id + ':env',
      role: 'user',
      content: [{ type: 'text', text: contextInjectionText(provider, systemPrompt) }],
      source: { kind: 'plugin', plugin: 'chat-import' },
    }, true)
  }

  for (const t of turns) {
    // 受遮蔽轮（log-only）的内容计入下一次检查点的 shadowedTokenCount
    if (t.shadowed === true) shadowedTokens += estimateTurnTokens(t)
    // 本轮之前有一次压缩：先发射原生压缩事务（独立事务，必须在 turn/start 之前）
    let turnSteps = t.steps
    if (t.compaction && !pushCompactionCheckpoint(t.compaction)) {
      // 边界之前没有可遮蔽的会话节点（会话在压缩点之前没有内容）：宿主不变式要求
      // shadowedSeqs 非空 → 发不出检查点。摘要不能丢：退回既有形态——该轮首步前置
      // reasoning 块（该轮没有步骤时补一个空步骤承载，与各源既有兜底同款）。
      const fallback = String(t.compaction.summary || '').trim()
      if (fallback) {
        if (turnSteps.length === 0) turnSteps = [{ content: [], toolCalls: [], toolResults: [] }]
        turnSteps[0].content.unshift({ type: 'reasoning', text: fallback })
      }
    }
    turn += 1
    advance(t.time)
    push('turn/start', { turn })
    if (turnSteps.length === 0) {
      // 只有提问、没有回复的轮次。首个 turn 就没有 step 时 head 没有可锚的 step：为它补
      // 一个只装 head 的 step（空 step 合法——step/end 只对未闭合的工具调用 fail-closed）
      if (!headPushed) {
        push('step/start', { turn, step: 1 })
        pushSystemHead(turn, 1)
        // 环境变更声明也在这里补：它必须排在**所有会话节点之前**（下面压缩事务的遮蔽范围
        // 是连续区间，声明若夹在中间就只能一起被遮蔽，模型会丢掉迁移说明）。
        if (!envInjected) pushEnvInjection()
        push('step/end', { turn, step: 1 })
      }
      pushPrompt(t)
    } else {
      for (let i = 0; i < turnSteps.length; i++) {
        const stepNum = i + 1
        const step = turnSteps[i]
        push('step/start', { turn, step: stepNum })
        if (!headPushed) pushSystemHead(turn, stepNum)
        if (!envInjected) pushEnvInjection()
        if (i === 0) pushPrompt(t)
        advance(step.time)
        const usage = sanitizeUsage(step.usage)
        pushConversation('assistant/message', {
          turn,
          step: stepNum,
          // 宿主 dsh >= 0.1.5 的 assertAssistantSettlementShape 要求 assistant/message
          // 除 turn/step 外还携带 stream 数组；导入会话没有 provider 流记录，空数组
          // 既是类型正确的 settlement，也不虚构不存在的流。
          stream: [],
          // 源转录携带的 provider 回报用量（Claude/opencode 等）；守卫见文件头 IR 契约
          ...(usage ? { usage } : {}),
          message: {
            id: 'import:' + meta.id + ':a' + turn + ':' + stepNum,
            role: 'assistant',
            content: step.content,
            // 源记录单条消息模型时（opencode）以 step.model 优先，否则回退会话级 model
            source: { kind: 'model', provider, model: step.model || mname },
          },
        })
        const callSeqs = []
        for (const tc of step.toolCalls) {
          const ev = push('tool/call', {
            turn,
            step: stepNum,
            callId: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          })
          callSeqs.push(ev.seq)
        }
        // 配对不变量：每个 tool/call 在其广告的同一 step 内闭合——真实结果（预扫描
        // 已按调用归位）优先，全程无结果的调用（Cursor 无 tool_result、Claude/Codex/
        // Reasonix/Gemini 中断）补发空 result；content 用空数组：不虚构文本，wire
        // 适配器会把空内容归一为 "(no output)"（dsh-llm-deepseek / dsh-llm-pi-ai 的
        // serialize 均 `|| "(no output)"`）。不闭合则 resume 时模型 API 拒绝
        // （assistant 带 tool_calls 但缺 tool 消息），V4 迁移也在 step/end 拒载。
        for (let ci = 0; ci < step.toolCalls.length; ci++) {
          const tc = step.toolCalls[ci]
          const tr = resultByCallId.get(tc.id)
          advance(tr?.time)
          pushConversation('tool/result', {
            turn,
            step: stepNum,
            message: {
              id: 'import:' + meta.id + ':t' + turn + ':' + stepNum + ':' + tc.id,
              role: 'user',
              content: [{
                type: 'tool-result',
                toolCallId: tc.id,
                content: tr ? tr.content : [],
                ...(tr && tr.isError ? { isError: true } : {}),
              }],
              source: { kind: 'tool', callId: tc.id },
            },
          }, [callSeqs[ci]])
        }
        push('step/end', { turn, step: stepNum })
      }
    }
    // 源记录标注该回合被中断时如实反映。Codex 的 turn_aborted.reason 恒为粗粒度
    // 'interrupted'，不区分用户 / hook / 销毁，故用宿主为「导入且原始粗粒度记录未携带
    // 原因」预留的 legacy 原因（TurnEndCancelCause 的注释正是这个场景）。
    push('turn/end', {
      turn,
      reason: t.aborted ? { kind: 'aborted', reason: { kind: 'legacy' } } : { kind: 'completed' },
    })
  }

  // 标题：ai-title → session/title 事件（钉住，避免自动回退标题覆盖）。
  const normalizedTitle = (title || '').trim()
  if (normalizedTitle.length > 0) {
    push('session/title', { title: normalizedTitle, messageSeqs: [], source: { kind: 'user' } })
  }

  return {
    meta,
    events,
    turns,
    title,
    // 「消息数」只统计真实 source 消息：上下文注入（环境变更声明 / 源系统提示词，
    // source.kind='plugin'）是折叠行，不计入——避免「已导入 Y 条消息」被 +1 虚增。
    messages: events.filter((e) =>
      (e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result')
      && !(e.data && e.data.source && e.data.source.kind === 'plugin')).length,
    toolCalls: events.filter((e) => e.type === 'tool/call').length,
    skipped,
    records,
    // 上报透传：畸形行明细（封顶由 parseJsonlLines 保证）、疑似 secrets
    // 位置清单（只含 line+kind，绝不含内容）、permission 计数（Claude 源，0 不占键）
    skippedLines,
    secrets,
    ...(permissionCount > 0 ? { permissionCount } : {}),
    ...(orphanToolResults > 0 ? { orphanToolResults } : {}),
    ...(duplicateToolResults > 0 ? { duplicateToolResults } : {}),
    // 原生压缩检查点数量（>0 才占键）：调用方据此上报「日志保留全量、模型只见压缩后的上下文」
    ...(compactionCount > 0 ? { compactions: compactionCount } : {}),
  }
}

// 用量守卫：input/output 必须是非负安全整数，缺/坏整份丢弃（宿主 token-meter 对它做
// 算术，NaN/浮点会污染会话总计）；可选桶（cacheRead/cacheWrite/reasoning）单项校验，
// 坏项只丢该项。totalTokens 由宿主按桶自算，不从源转录透传（各源口径不一）。
export function sanitizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const ok = (v) => Number.isSafeInteger(v) && v >= 0
  if (!ok(usage.inputTokens) || !ok(usage.outputTokens)) return undefined
  const out = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
  if (ok(usage.cacheReadTokens)) out.cacheReadTokens = usage.cacheReadTokens
  if (ok(usage.cacheWriteTokens)) out.cacheWriteTokens = usage.cacheWriteTokens
  if (ok(usage.reasoningTokens)) out.reasoningTokens = usage.reasoningTokens
  return out
}
