// lib/convert/codex.mjs — Codex / ChatGPT CLI rollout JSONL → DSH 会话（纯函数）

import {
  SESSION_FORMAT_VERSION,
  IMAGE_PLACEHOLDER,
  applyBudgetTrim,
  imageBlockFromSource,
  mintSessionId,
  parseJsonlLines,
  parseTime,
  synthesizeSession,
} from './core.mjs'
// 注入识别前缀表与发现层共用唯一真相源（'# AGENTS.md' 等前缀由此统一）
import { isInjectedTopic } from './inject.mjs'

// 标题归一统一规则：去首尾空白、折叠内部空白；超 80 字符截断加省略号；
// 空白返回空串。core.mjs 属禁改面，各源按文件内联同款（改规则需同步 5 处）。
const TITLE_MAX_LEN = 80
const TITLE_ELLIPSIS = '…'
function normalizeTitle(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return ''
  return t.length <= TITLE_MAX_LEN ? t : t.slice(0, TITLE_MAX_LEN - TITLE_ELLIPSIS.length) + TITLE_ELLIPSIS
}

// Codex 子代理 rollout 判定：session_meta.payload 带 thread_source='subagent'（权威标记）
// 或 source.subagent（spawned thread，含 thread_spawn.parent_thread_id，issue #17 复现形态）
// 时是子代理线程，不应成为独立 DSH 会话。返回命中标记名供 skipReason 诊断，未命中 null。
// 注意不据此跳过 fork 会话：forked_from_id / parent_thread_id 标记「从某会话 fork 出的
// 新主会话」，仍是可独立继续的用户会话，导入应保留。
function codexSubagentMarker(payload) {
  if (!payload || typeof payload !== 'object') return null
  if (payload.thread_source === 'subagent') return 'thread_source=subagent'
  const src = payload.source
  if (src && typeof src === 'object' && src.subagent) return 'source.subagent'
  return null
}

// Codex / ChatGPT CLI rollout JSONL → 统一的回合中间结构。
//
// 行 envelope：{ timestamp, type, payload }。只消费 response_item（模型产物）与
// session_meta / turn_context（元数据）；event_msg 的 user_message / agent_message
// 是 response_item 的重复（schema 笔记明确警告会重复计数），一律忽略。
// 用户消息里的 harness 注入（以 `<` 开头的环境块/系统提醒，以及 inject.mjs 注入前缀表
// 命中的 '# AGENTS.md instructions' 等）不是人类输入：既不开轮也不作标题——前缀表与发现
// 层面板同源（discovery.mjs 的 isInjectedTitle），两层口径一致。importSystemPrompt 开启时
// '# AGENTS.md' 前缀块转入 systemPrompt（与 developer 分支同款拼接），其余注入块无论开关
// 一律丢弃。
//
// 上下文压缩（`compacted` 信封）导入为 **DSH 原生压缩检查点**：Codex 把前一个窗口折叠成
// 一段交接摘要（payload.message，与 payload.replacement_history 末项逐字相同）后继续写同一
// 个 rollout，压缩前的记录仍留在文件里。全量记录照常进 DSH 日志，并在边界处发射一次原生
// compaction 事务（摘要作检查点；见 lib/convert/events.mjs），模型的投影因此只看到「摘要 +
// 压缩点之后的对话」，与 Codex 压缩后的真实上下文一致。fullHistory:true 时不发检查点（模型
// 看到全量）。compress 常落在一轮工具执行中间，故跨边界的那一轮就地一分为二：边界前的部分
// 标 shadowed（log-only），边界后的部分挂检查点。
export function convertCodexJsonl(raw, args = {}) {
  // 逐行解析带行号明细（畸形行计数不设限，明细封顶 200）+ secrets 位置
  const { recs, skipped, skippedLines, secrets } = parseJsonlLines(raw)
  // custom_tool_call 的 JS 参数未能转标准 JSON、原样保留的个数（诊断计数）
  let droppedMalformedArgs = 0
  // 工具输出块数组里的未知块类型个数（schema 漂移诊断，失败要大声）
  let droppedMalformedOutputs = 0
  // 拿不到字节、以 [image] 文本占位导入的图片张数（能落成宿主附件的不计这里）
  let imagesDegraded = 0

  let sourceId = null
  let cwd = null
  let createdAt = null
  let model = null
  // 步骤开启时刻生效的模型：每条 turn_context 都覆盖（Codex 可在会话中途换模型），
  // 新开的步骤带上它 → 前后步骤各带各的 step.model（events.mjs 以 step.model 优先）。
  let currentModel = null
  // 开关开启时收集 developer（系统提示词/系统注入）文本，作为上下文注入保留
  let systemPrompt = null
  // 子代理 rollout 标记（thread_source='subagent' / source.subagent），命中则跳过不建会话
  let subagent = null
  // 标题话题：全量记录里的第一条人类提问（压缩只影响正文投影，不影响标题——标题是会话级
  // 属性，与发现层面板取首问的口径一致）
  let titleTopic = null
  // 待落到「下一个开启的轮」上的压缩检查点（摘要来自 compacted 信封的 payload.message）
  let pendingCompaction = null

  // callId → 它所属的 step（跨行配对 function_call_output）
  const callSteps = new Map()

  const turns = []
  let cur = null
  let lastStep = null
  // Codex 的 reasoning 记录出现在它所属的 assistant 步骤之前（模型先想再答）。直接为其
  // openStep() 会把一个概念步骤拆成两步，虚增 steps/messages；故先缓冲，等该步骤真正由
  // assistant 消息或工具调用开启时再前置落盘。与 pi 把 thinking 块挂在既有步骤上同义。
  let pendingReasoning = []

  // 新开一个「用户提问」回合；带待落检查点时挂到新轮上（该轮成为压缩边界之后的可见段）。
  const openTurn = (prompt) => {
    cur = { prompt, steps: [] }
    if (pendingCompaction) {
      cur.compaction = pendingCompaction
      pendingCompaction = null
    }
    turns.push(cur)
    lastStep = null
    pendingReasoning = []
  }

  // 追加一步 assistant 产物（文本 / 工具调用）；没有当前回合时忽略。
  const openStep = () => {
    const step = { content: [], toolCalls: [], toolResults: [] }
    // 步骤级模型取本步骤开启时刻的 currentModel（换模型前开的旧步骤保留旧模型）；
    // 源没有 turn_context 模型时不写，由合成层回退会话级 model
    if (currentModel) step.model = currentModel
    if (pendingReasoning.length) {
      step.content.push(...pendingReasoning)
      pendingReasoning = []
    }
    cur.steps.push(step)
    lastStep = step
    return step
  }

  // 压缩边界：把此刻已开/已收的轮全部标为 log-only（它们都在边界之前），并记下检查点。
  // 只有带摘要正文的信封才算边界——只有边界标记而没有摘要时不做任何标记，等于「无压缩」。
  const markCompaction = (text) => {
    for (const t of turns) t.shadowed = true
    cur = null
    lastStep = null
    pendingReasoning = []
    pendingCompaction = { summary: text, provider: 'codex', model: model || undefined }
  }

  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]
    const env = rec && rec.type
    const payload = rec && rec.payload
    if (env === 'session_meta' && payload) {
      if (!sourceId && typeof payload.id === 'string') sourceId = payload.id
      if (!cwd && typeof payload.cwd === 'string') cwd = payload.cwd
      if (createdAt === null) createdAt = parseTime(payload.timestamp ?? rec.timestamp)
      if (!subagent) subagent = codexSubagentMarker(payload)
      continue
    }
    if (env === 'turn_context' && payload) {
      // 会话级 model 只认第一条（兜底）；currentModel 每条都更新（模型可中途切换）
      if (typeof payload.model === 'string' && payload.model) {
        if (!model) model = payload.model
        currentModel = payload.model
      }
      continue
    }
    // 压缩边界记录本身不进对话（摘要进检查点；被折叠的正文仍照常留在日志里）
    if (env === 'compacted') {
      const text = args.fullHistory === true || !payload || typeof payload.message !== 'string'
        ? ''
        : payload.message.trim()
      if (text) markCompaction(text)
      continue
    }
    if (env === 'event_msg' && payload && payload.type === 'turn_aborted') {
      // 回合被中断（实测 40/40 条 reason 恒为 'interrupted'，不区分用户/hook/销毁）。
      // 如实标到当前回合，由 synthesizeSession 映射为 turn/end 的 aborted。
      if (cur) cur.aborted = true
      continue
    }
    if (env !== 'response_item' || !payload) continue

    // 压缩点之后的产物若还没有开轮（边界落在轮中间、后半段以 assistant/工具记录起头），
    // 用空 prompt 轮承载——检查点本身就是这一轮的 user 侧消息（synthesizeSession 对带
    // 检查点的空 prompt 轮不再补发 user/message）。记录从中途开始的普通 rollout 保持
    // 既有口径（无回合的产物丢弃）。
    if (pendingCompaction && !cur) openTurn('')

    if (payload.type === 'message') {
      if (payload.role === 'user') {
        // 过滤 harness 注入，剩余文本合并为用户提问
        const prompt = codexUserPrompt(payload.content)
        // 被过滤掉的 '# AGENTS.md' 前缀块不丢：开关开启时收进 systemPrompt（拼接口径
        // 对齐 developer 分支），关闭时与其它注入块一样丢弃
        if (args.importSystemPrompt === true) {
          const agentsMd = codexAgentsMdText(payload.content)
          if (agentsMd) systemPrompt = systemPrompt ? systemPrompt + '\n\n' + agentsMd : agentsMd
        }
        if (prompt) {
          if (titleTopic === null) titleTopic = prompt
          openTurn(prompt)
          // 用户贴图提问：图片进 promptBlocks（合成时优先于纯文本 prompt）
          const userImages = codexUserImageBlocks(payload.content)
          if (userImages.length > 0 && cur) cur.promptBlocks = [{ type: 'text', text: prompt }, ...userImages]
        }
      } else if (payload.role === 'assistant' && cur) {
        const step = openStep()
        for (const block of payload.content) {
          if (block && block.type === 'output_text' && typeof block.text === 'string') {
            step.content.push({ type: 'text', text: block.text })
          } else if (block && (block.type === 'input_image' || block.type === 'output_image' || block.type === 'image_url' || block.type === 'image')) {
            // 助手消息里的图片：有字节就落 image 块，否则占位 + 计数（不再静默丢弃）
            const img = imageBlockFromSource(block)
            if (img) step.content.push(img)
            else { imagesDegraded++; step.content.push({ type: 'text', text: IMAGE_PLACEHOLDER }) }
          }
        }
      } else if (payload.role === 'developer' && args.importSystemPrompt === true) {
        // developer（系统提示词）：默认忽略；开关开启时按上下文注入保留
        const text = codexMessageText(payload.content)
        if (text) systemPrompt = systemPrompt ? systemPrompt + '\n\n' + text : text
      }
      // developer（系统注入）默认忽略
    } else if ((payload.type === 'function_call' || payload.type === 'custom_tool_call') && cur) {
      // 挂到最近的 assistant 步骤（一步 = assistant 消息 + 其工具调用）；没有则新开一步
      const step = lastStep || openStep()
      const callId = payload.call_id
      let argumentsText
      if (payload.type === 'function_call') {
        argumentsText = typeof payload.arguments === 'string' ? payload.arguments : JSON.stringify(payload.arguments ?? {})
      } else {
        // custom_tool_call（如 apply_patch）：input 是自由格式；2026+ 新版是 JS 代码
        // （tools.exec_command({...}) 等调用形态）——识别并转标准 JSON，失败原样保留
        const res = codexCustomToolArguments(payload.input)
        argumentsText = res.arguments
        if (res.fallback) droppedMalformedArgs++
      }
      const mapped = {
        id: callId,
        name: payload.name || 'unknown',
        arguments: argumentsText,
      }
      // assistant 消息内容必须携带 tool-call block：wire 适配器的 tool_calls 只从
      // assistant 消息的 content 块派生（dsh-llm-deepseek serializeAssistant），
      // 只挂 step.toolCalls 会让 tool/result 成为无前置 tool_calls 的孤儿 tool 消息
      step.content.push({ type: 'tool-call', ...mapped })
      step.toolCalls.push(mapped)
      if (callId) callSteps.set(callId, step)
    } else if ((payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') && cur) {
      const callId = payload.call_id
      const step = callSteps.get(callId) || lastStep || openStep()
      // output 三种形态（本机实测 1045 个：纯字符串 77、块数组 968=92.6%）：
      //   1. 纯字符串，或 {"output":"...","metadata":{...}} JSON 字符串信封 → 取正文
      //   2. 块数组（[{type:'input_text',text},...]，shell/exec 输出；input_image 只计数
      //      占位，base64 不进日志）→ 逐块映射，文本块拼接为单文本块
      //   3. {"output":[...]} 信封对象 → 同 2
      // 其余形态 JSON.stringify 保底并计数（schema 漂移不静默吞）。
      let blocks = null
      let text
      const out = payload.output
      if (typeof out === 'string') {
        let parsed = null
        try { parsed = JSON.parse(out) } catch (_) { /* 纯文本 */ }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.output)) {
          blocks = parsed.output
        } else {
          text = parsed && typeof parsed === 'object' && typeof parsed.output === 'string'
            ? parsed.output
            : out
        }
      } else if (Array.isArray(out)) {
        blocks = out
      } else if (out && typeof out === 'object' && Array.isArray(out.output)) {
        blocks = out.output
      } else if (out && typeof out === 'object' && typeof out.output === 'string') {
        text = out.output
      } else {
        text = typeof out === 'string' ? out : JSON.stringify(out ?? '')
      }
      let content
      if (blocks !== null) {
        const parts = []
        const imageBlocks = []
        let imagesDegradedHere = 0
        for (const b of blocks) {
          if (!b || typeof b !== 'object') continue
          if ((b.type === 'input_text' || b.type === 'output_text') && typeof b.text === 'string') {
            parts.push(b.text)
          } else if (b.type === 'input_image' || b.type === 'image_url' || b.type === 'image') {
            // 有内联字节（data URL）→ IR image 块（宿主层落成附件）；拿不到字节才占位 + 计数
            const img = imageBlockFromSource(b)
            if (img) imageBlocks.push(img)
            else { imagesDegradedHere++; imagesDegraded++ }
          } else {
            // 未知块类型计数（schema 漂移不静默吞）
            droppedMalformedOutputs++
          }
        }
        content = []
        if (parts.length) content.push({ type: 'text', text: parts.join('\n') })
        content.push(...imageBlocks)
        for (let i = 0; i < imagesDegradedHere; i++) content.push({ type: 'text', text: IMAGE_PLACEHOLDER })
      } else {
        content = [{ type: 'text', text }]
      }
      step.toolResults.push({
        toolCallId: callId,
        content,
        isError: false,
      })
    } else if (payload.type === 'reasoning' && cur) {
      // reasoning 的可读部分是 summary 块；encrypted_content 是不透明密文
      // （实测占 reasoning 的 85.2%），既不读也不搬。
      const text = codexReasoningText(payload)
      if (text) pendingReasoning.push({ type: 'reasoning', text })
    }
    // 其余事件忽略
  }

  // 收尾：末尾的 reasoning 没等到后续 assistant 步骤（如回合被中断）时落到最后一步；
  // 整个回合尚无任何步骤则补一步，避免可读内容被丢掉。
  if (pendingReasoning.length && cur) {
    const step = lastStep || openStep()
    step.content.push(...pendingReasoning)
    pendingReasoning = []
  }

  // 压缩摘要不再作 reasoning 块：它由原生压缩检查点承载（见 events.mjs 的事务合成）。
  // 待落检查点若一直没等到新轮（会话正好停在压缩点），用空 prompt 轮兜住——否则检查点
  // 无处发射，日志会「有边界无检查点」。
  if (pendingCompaction) {
    cur = { prompt: '', steps: [], compaction: pendingCompaction }
    pendingCompaction = null
    turns.push(cur)
  }

  // 子代理 rollout（thread_source='subagent' / source.subagent）不是独立会话：跳过并给
  // 原因（对齐 claude/qoder 的「辅助 transcript 跳过」语义），避免目录模式导入出碎片会话。
  if (subagent) {
    return {
      meta: null, events: [], turns: [], title: null, messages: 0, toolCalls: 0,
      skipped: 0, records: recs.length, droppedMalformedArgs: 0,
      skippedLines: [], secrets: [],
      skipReason: 'Codex subagent rollout (' + subagent + '); only the main session rollout becomes a session',
    }
  }

  const sessionId = args.sessionId || mintSessionId(sourceId)
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: createdAt ?? Date.now() }
  if (sourceId) meta.sourceId = sourceId
  if (cwd) meta.cwd = cwd

  // 标题兜底：Codex 无显式标题源（无 ai-title/custom-title）→ 首问兜底。压缩只切正文，
  // 标题仍取全量记录里的第一条提问（会话级属性，与发现层面板取首问同口径）。
  // 只回填 out.title，不钉 session/title 事件（DSH 自动回退首条 user 文本，见 claude.mjs）。
  const finalTitle = normalizeTitle(titleTopic || (turns.length > 0 ? turns[0].prompt : ''))
  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, args.budget)
  const syn = synthesizeSession({ meta, turns: seedTurns, title: undefined, provider: 'codex', model, skipped, records: recs.length, skippedLines, secrets, imported: { sourcePath: args.sourcePath }, systemPrompt })
  return {
    ...syn,
    title: finalTitle,
    droppedMalformedArgs,
    // 工具输出块数组中的未知块类型个数（>0 才占键；失败要大声）
    ...(droppedMalformedOutputs > 0 ? { droppedMalformedOutputs } : {}),
    // 图片降级数（>0 才占键）：拿不到字节、以 [image] 文本占位导入的图片张数
    ...(imagesDegraded > 0 ? { imagesDegraded } : {}),
    // compacted/skipReason 由合成层的事实决定：syn.compactions 是实际发射的检查点数
    ...(syn.compactions ? { compacted: true } : {}),
    ...(trimmed ? { trimmed } : {}),
  }
}

// reasoning 记录的可读部分：实测 content 恒为 null，可读文本在 summary 的
// [{type:'summary_text', text}] 块数组里；encrypted_content 是不透明密文，此函数不碰它。
function codexReasoningText(payload) {
  const parts = []
  if (Array.isArray(payload.summary)) {
    for (const block of payload.summary) {
      if (block && typeof block.text === 'string' && block.text.trim()) parts.push(block.text.trim())
    }
  }
  return parts.join('\n').trim()
}

// Codex 消息 content → 纯文本（字符串原样；数组逐块取 input_text/output_text）。
// developer / user 消息共用（user 分支过滤 < 开头 harness 注入后走同一提取）。
function codexMessageText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && (block.type === 'input_text' || block.type === 'output_text') && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

// Codex 把仓库指令（AGENTS.md）贴在 user 消息里，正文以 '# AGENTS.md instructions for
// <path>' 开头——该前缀同时登记在 inject.mjs 的 INJECT_MARKERS（发现层面板据此不取它作
// 标题），本文件据此把它从提问里过滤掉，两层口径同源。
const AGENTS_MD_PREFIX = '# agents.md'

// 被过滤的 AGENTS.md 指令块 → systemPrompt 正文（只有 importSystemPrompt 开启时调用）。
// 块类型与 trim 口径和 codexUserPrompt 一致（同一块不会既进提问又进 systemPrompt）；
// 多条按 developer 分支同款以空行拼接。
function codexAgentsMdText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || block.type !== 'input_text' || typeof block.text !== 'string') continue
    const t = block.text.trim()
    if (t.toLowerCase().startsWith(AGENTS_MD_PREFIX)) parts.push(t)
  }
  return parts.join('\n\n').trim()
}

// user 消息 → 提问文本：过滤 harness 注入（以 '<' 开头的块，以及 inject.mjs 注入前缀表
// 命中的块）后合并。标题话题与回合开启共用同一提取口径（压缩窗口之前的记录只用来取
// 标题）——过滤修好后 titleTopic 与开轮自动一致，全注入消息不留空轮。
function codexUserPrompt(content) {
  const parts = []
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block && block.type === 'input_text' && typeof block.text === 'string' &&
        !block.text.startsWith('<') && !isInjectedTopic(block.text)
      ) {
        parts.push(block.text)
      }
    }
  }
  return parts.join('\n').trim()
}

// user 消息里的图片块 → IR image 块（用户贴图提问；拿不到字节的返回 null）。
// 与 codexUserPrompt 的过滤口径一致：注入块与 harness 前缀之外的图片才算用户内容。
export function codexUserImageBlocks(content) {
  const out = []
  if (!Array.isArray(content)) return out
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type !== 'input_image' && block.type !== 'image_url' && block.type !== 'image') continue
    const img = imageBlockFromSource(block)
    if (img) out.push(img)
  }
  return out
}

// Codex `custom_tool_call` 的 input 是 JS 代码字符串（2026+ 新版，如
// `tools.exec_command({cmd: "...", workdir: "..."})`、直接对象字面量或箭头/括号包裹的
// 调用表达式）。直接 JSON.stringify 当 arguments 传模型会让模型学到错误的调用格式
// （JS/XML 混合）。识别 JS 调用形态 → 提取最外层对象字面量 → 最小转换器转标准 JSON；
// 提取/转换任一失败回退原样（不抛异常、不产生垃圾输出）。返回 { arguments, fallback }：
// fallback=true 表示「识别为 JS 形态但未能转换、原样保留」（供调用方计数
// droppedMalformedArgs）；apply_patch 这类自由文本不算，因为根本没进入转换流程。
export function codexCustomToolArguments(input) {
  if (typeof input !== 'string') return { arguments: JSON.stringify(input ?? {}), fallback: false }
  const text = input.trim()
  if (!text || !codexJsArgsShape(text)) return { arguments: JSON.stringify(input), fallback: false }
  const start = findObjectStart(text)
  if (start === -1) return { arguments: JSON.stringify(input), fallback: true }
  const end = findMatchingBrace(text, start)
  if (end === -1) return { arguments: JSON.stringify(input), fallback: true }
  const json = jsObjectLiteralToJson(text.slice(start, end + 1))
  if (json === null) return { arguments: JSON.stringify(input), fallback: true }
  return { arguments: json, fallback: false }
}

// 识别 Codex custom_tool_call 的 JS 调用形态：直接对象字面量 {…}、括号包裹表达式
// （IIFE / 箭头函数 / Promise.all）、name(…) / tools.name(…) 调用，以及带赋值/返回
// 前缀的调用片段（const r = await tools.exec_command({…}) 等）。
function codexJsArgsShape(text) {
  return /^\{/.test(text)
    || /^\(/.test(text)
    || /^(?:return\s+|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*)?(?:await\s+)?(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\s*\(/.test(text)
}

// 定位 input 中第一个不在字符串/模板字面量里的 '{'（提取调用参数的对象字面量起点）。
function findObjectStart(text) {
  for (let i = 0; i < text.length;) {
    const ch = text[i]
    if (ch === '"' || ch === "'") { i = skipJsString(text, i); continue }
    if (ch === '`') { i = skipJsTemplate(text, i); continue }
    if (ch === '{') return i
    i++
  }
  return -1
}

// 从 start（text[start] === '{'）找到匹配的 '}'（嵌套花括号 / 字符串 / 模板 aware）。
function findMatchingBrace(text, start) {
  let depth = 0
  for (let i = start; i < text.length;) {
    const ch = text[i]
    if (ch === '"' || ch === "'") { i = skipJsString(text, i); continue }
    if (ch === '`') { i = skipJsTemplate(text, i); continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

// 跳过单/双引号字符串（含反斜杠转义）；返回越过闭合引号的下标。未闭合时扫到末尾。
function skipJsString(text, start) {
  const quote = text[start]
  for (let i = start + 1; i < text.length;) {
    const ch = text[i]
    if (ch === '\\') { i += 2; continue }
    i++
    if (ch === quote) return i
  }
  return text.length
}

// 跳过模板字面量（含 ${…} 插值：插值内按 JS 代码扫描，可嵌套字符串/模板/花括号）；
// 返回越过闭合反引号的下标。未闭合时扫到末尾。
function skipJsTemplate(text, start) {
  for (let i = start + 1; i < text.length;) {
    const ch = text[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === '$' && text[i + 1] === '{') {
      let depth = 1
      i += 2
      while (i < text.length && depth > 0) {
        const c = text[i]
        if (c === '"' || c === "'") { i = skipJsString(text, i); continue }
        if (c === '`') { i = skipJsTemplate(text, i); continue }
        if (c === '{') { depth++; i++; continue }
        if (c === '}') { depth--; i++; if (depth === 0) break }
        i++
      }
      continue
    }
    i++
    if (ch === '`') return i
  }
  return text.length
}

// 最小 JS 对象字面量 → JSON 文本（零依赖、无 eval；递归下降）。
// 支持：字符串键/值（单/双引号 + 常用转义）、无引号标识符键、数字、true/false/null、
// 数组、嵌套对象。不支持（返回 null）：函数/方法调用、变量引用、注释、尾逗号、
// 模板字符串值、十六进制数字等——调用方回退原样。
export function jsObjectLiteralToJson(src) {
  let i = 0
  const err = () => { throw new SyntaxError('unsupported JS object literal at ' + i) }
  const skipWs = () => { while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r')) i++ }
  const parseString = () => {
    const quote = src[i]
    i++
    let out = ''
    while (i < src.length) {
      const ch = src[i]
      if (ch === quote) { i++; return out }
      if (ch !== '\\') { out += ch; i++; continue }
      i++
      const e = src[i]
      switch (e) {
        case 'n': out += '\n'; i++; break
        case 't': out += '\t'; i++; break
        case 'r': out += '\r'; i++; break
        case 'b': out += '\b'; i++; break
        case 'f': out += '\f'; i++; break
        case 'v': out += '\v'; i++; break
        case '0': out += '\0'; i++; break
        case 'u': {
          i++
          if (src[i] === '{') {
            // \u{…}：1–6 位十六进制码点
            let hex = ''
            i++
            while (i < src.length && /[0-9a-fA-F]/.test(src[i])) { hex += src[i]; i++ }
            if (src[i] !== '}' || hex.length === 0 || hex.length > 6) err()
            const cp = parseInt(hex, 16)
            if (cp > 0x10ffff) err()
            out += String.fromCodePoint(cp)
            i++
          } else {
            const hex = src.slice(i, i + 4)
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) err()
            out += String.fromCharCode(parseInt(hex, 16))
            i += 4
          }
          break
        }
        case 'x': {
          i++
          const hex = src.slice(i, i + 2)
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) err()
          out += String.fromCharCode(parseInt(hex, 16))
          i += 2
          break
        }
        default:
          // 身份转义（\\ \' \" 与未知转义按 JS 语义取原字符）
          out += e
          i++
      }
    }
    err() // 未闭合字符串
  }
  const parseIdentifier = () => {
    const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i))
    if (!m) err()
    i += m[0].length
    return m[0]
  }
  const parseNumber = () => {
    const m = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))
    if (!m) err()
    const n = Number(m[0])
    if (!Number.isFinite(n)) err()
    i += m[0].length
    return n
  }
  const parseValue = () => {
    skipWs()
    if (i >= src.length) err()
    const ch = src[i]
    if (ch === '{') return parseObject()
    if (ch === '[') return parseArray()
    if (ch === '"' || ch === "'") return parseString()
    if (ch === '-' || ch === '.' || (ch >= '0' && ch <= '9')) return parseNumber()
    if (src.startsWith('true', i) && !/[A-Za-z0-9_$]/.test(src[i + 4] || '')) { i += 4; return true }
    if (src.startsWith('false', i) && !/[A-Za-z0-9_$]/.test(src[i + 5] || '')) { i += 5; return false }
    if (src.startsWith('null', i) && !/[A-Za-z0-9_$]/.test(src[i + 4] || '')) { i += 4; return null }
    err()
  }
  const parseArray = () => {
    i++ // '['
    const arr = []
    skipWs()
    if (src[i] === ']') { i++; return arr }
    for (;;) {
      arr.push(parseValue())
      skipWs()
      if (src[i] === ',') { i++; continue }
      if (src[i] === ']') { i++; return arr }
      err()
    }
  }
  const parseObject = () => {
    i++ // '{'
    const obj = {}
    skipWs()
    if (src[i] === '}') { i++; return obj }
    for (;;) {
      skipWs()
      const key = src[i] === '"' || src[i] === "'" ? parseString() : parseIdentifier()
      skipWs()
      if (src[i] !== ':') err()
      i++
      obj[key] = parseValue()
      skipWs()
      if (src[i] === ',') { i++; continue }
      if (src[i] === '}') { i++; return obj }
      err()
    }
  }
  const parseTop = () => {
    skipWs()
    const value = parseValue()
    skipWs()
    if (i !== src.length) err()
    return JSON.stringify(value)
  }
  try {
    return parseTop()
  } catch {
    // 解析器不支持的结构（函数/表达式/注释/尾逗号/模板字符串值等）→ null，调用方回退原样
    return null
  }
}
