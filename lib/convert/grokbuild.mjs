// lib/convert/grokbuild.mjs — Grok Build 会话（summary.json + chat_history.jsonl）→ DSH 会话（纯函数）
//
// 存储契约（chat_format_version: 1）：~/.grok/sessions/<encodeURIComponent(cwd)>/<session_id>/
//（及 ~/.grok/archived_sessions/），每会话一个目录，含 summary.json 与 chat_history.jsonl。
// 目录扫描归 discovery 层，本模块只做纯转换：convertGrokbuildJson(summaryJsonText, chatHistoryText, args)。
// summary.json：{ info:{id,cwd}, session_summary, generated_title, created_at, updated_at,
// last_active_at, current_model_id } → meta（id/cwd/createdAt）、标题（generated_title >
// session_summary）与会话级模型兜底（current_model_id）。
//
// chat_history.jsonl：每行一个 { type, ... } 对象，**不带逐行 timestamp**（时间只在 summary）。
// v0 兼容：行无 type 有 role 时按 role 走同一管线（kind = type ?? role）。
//   system        content: string（系统提示词）→ 默认 filtered++；importSystemPrompt 时收 systemPrompt
//   user          content: [{type:'text',text}]，可选 prompt_index / synthetic_reason /
//                 prior_turn_interrupt。synthetic_reason 非空且 ≠'human' 的行是 harness 产物
//                 （system_reminder 注入 / compaction_meta），不开轮也不作标题；compaction_meta
//                 的交接摘要行例外——它是压缩边界，发射原生压缩检查点（见下）
//   reasoning     { id, status, summary:[{type:'summary_text',text}], encrypted_content }。
//                 encrypted_content 是密文（永不读取、永不落日志）；summary[].text 是明文，
//                 缓冲后前置到下一个 assistant 步骤（模型先想再答，不应虚增一个步骤）
//   assistant     content: string（可空，工具轮常为空）；tool_calls:[{id,name,arguments}]，
//                 arguments 是 JSON 字符串（原样保留）→ 每个调用一个 tool-call 块，同时进
//                 step.content 与 step.toolCalls；另有 model_id / model_fingerprint /
//                 reasoning_effort，model_id → step.model（单步模型）
//   tool_result   { tool_call_id, content: string }，可选 images:[{type:'image',url:'data:…'}]
//                 （updates.jsonl 变体是 {type:'image',data:<base64>}，无媒体类型，按魔数嗅探）；
//                 有内联字节的图产出 IR image 块（宿主层经 ctx.attachments 落成附件）
//                 → 按 tool_call_id 挂回 call 所在 step（跨 step / 跨轮晚到也归位）；拿不到
//                 字节的图在结果 content 末尾追加一个 '[image]' 占位并计入 imagesDegraded
//   backend_tool_call  { kind:{ tool_type:'web_search', action } } → 只计 backendToolCalls，
//                 不映射：后端工具的结果不在转录里，映射成 tool/call 会破坏「每个调用恰好
//                 一条结果」的配对不变量
//   其它 type     → filtered++（schema 漂移不静默吞）
// 典型序列：user → reasoning → assistant(tool_calls) → tool_result × N → …
//
// 上下文压缩（compaction_meta 的交接摘要行，形如 'This session is being continued from a
// previous conversation…'）导入为 **DSH 原生压缩检查点**（docs/architecture.md D11）：摘要之
// 前已开的轮标 shadowed（log-only，正文照常留在日志里），检查点挂到下一个开启的轮；边界后
// 无轮时用空 prompt 轮承载。fullHistory:true 时不发检查点，该行按普通 user 记录导入（模型看
// 全量）。compaction_meta 的环境块（<user_info> 开头）永远按注入处理，不作压缩边界。
//
// 兼容层：Claude 风格 block 形态（user/assistant 的 content 为 block 数组、type:'tool' 记录、
// tool_result 块的 tool_use_id）全部保留，保证 export/grokbuild.mjs 写出的记录可再读回。

import {
  SESSION_FORMAT_VERSION,
  IMAGE_PLACEHOLDER,
  applyBudgetTrim,
  imageBlockFromSource,
  mapContentBlock,
  mintSessionId,
  parseJsonlLines,
  parseTime,
  synthesizeSession,
} from './core.mjs'
import { isInjectedTopic, stripUserQueryWrapper } from './inject.mjs'

// 标题归一统一规则：去首尾空白、折叠内部空白；超 80 字符截断加省略号；
// 空白返回空串。core.mjs 属禁改面，各源按文件内联同款（改规则需同步 5 处）。
const TITLE_MAX_LEN = 80
const TITLE_ELLIPSIS = '…'
function normalizeTitle(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return ''
  return t.length <= TITLE_MAX_LEN ? t : t.slice(0, TITLE_MAX_LEN - TITLE_ELLIPSIS.length) + TITLE_ELLIPSIS
}

// summary 时间字段回退链：created_at → updated_at → last_active_at；全部缺失返回 null
//（由调用方回退导入时刻，避免把导入时刻当会话创建时间）。parseTime 对缺失值会回退
// Date.now()，无法区分「缺失」与「合法」，故在此先滤掉空值。
function firstValidTime(...values) {
  for (const v of values) {
    if (v === undefined || v === null || v === '') continue
    return parseTime(v)
  }
  return null
}

// 记录 content → { texts, blocks, toolResults }。string → 单文本块；数组 → 逐块分类
//（text/input_text/output_text 记入 texts 且保留在 blocks 供映射，thinking/tool_use 只进
// blocks，tool_result 单独抽出）；未知/结构性块（summary_text 等）进 blocks 由映射过滤。
function parseGrokContent(content) {
  const out = { texts: [], blocks: [], toolResults: [] }
  const raw = typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : (Array.isArray(content) ? content : [])
  for (const block of raw) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'tool_result') { out.toolResults.push(block); continue }
    if ((block.type === 'text' || block.type === 'input_text' || block.type === 'output_text')
      && typeof block.text === 'string') {
      out.texts.push(block.text)
    }
    out.blocks.push(block)
  }
  return out
}

// block → DSH content 块。Claude 原生类型（text/thinking/tool_use）走 core 的
// mapContentBlock；input_text/output_text（Gemini/Codex 风格）归一到 text；其余返回 null。
function mapGrokBlock(block) {
  const mapped = mapContentBlock(block)
  if (mapped) return mapped
  if ((block.type === 'input_text' || block.type === 'output_text') && typeof block.text === 'string') {
    return { type: 'text', text: block.text }
  }
  return null
}

// tool_result 的内容 → DSH content 块：数组按 mapContentBlock 逐块映射（Claude 风格
// 嵌套块）；纯字符串 → 单文本块；其余空数组（不虚构文本，缺结果时由 synthesizeSession
// 补空 result）。
function mapToolResultContent(content) {
  if (Array.isArray(content)) return content.map(mapContentBlock).filter(Boolean)
  if (typeof content === 'string' && content !== '') return [{ type: 'text', text: content }]
  return []
}

// reasoning 记录的可读正文：summary[] 里 summary_text 的 text 是明文；encrypted_content
// 是不透明密文（实测占 reasoning 绝大多数字节），既不读也不搬。兼容旧形状——content 块数组
// 里的 summary_text 块同样取用（Claude 风格 block 形态）。
function grokReasoningText(rec) {
  const parts = []
  const take = (block) => {
    if (block && typeof block.text === 'string' && block.text.trim()) parts.push(block.text.trim())
  }
  if (Array.isArray(rec.summary)) {
    for (const block of rec.summary) {
      if (block && typeof block === 'object' && block.type === 'summary_text') take(block)
    }
  }
  if (parts.length === 0 && Array.isArray(rec.content)) {
    for (const block of rec.content) {
      if (block && block.type === 'summary_text') take(block)
    }
  }
  return parts.join('\n').trim()
}

export function convertGrokbuildJson(summaryJsonText, chatHistoryText, args = {}) {
  let summary = null
  try {
    summary = JSON.parse(summaryJsonText)
  } catch {
    return emptySkip('malformed summary.json')
  }
  if (!summary || typeof summary !== 'object') return emptySkip('malformed summary.json')
  const info = summary.info && typeof summary.info === 'object' ? summary.info : {}

  // 逐行解析带行号明细（畸形行计数不设限，明细封顶 200）+ secrets 位置
  const { recs, skipped, skippedLines, secrets } = parseJsonlLines(chatHistoryText ?? '')

  const sourceId = typeof info.id === 'string' && info.id ? info.id : null
  const cwd = typeof info.cwd === 'string' && info.cwd ? info.cwd : null
  const createdAt = firstValidTime(summary.created_at, summary.updated_at, summary.last_active_at) ?? Date.now()

  // 标题：generated_title > session_summary（显式标题钉 session/title 事件，首问只回填 out.title）
  const generatedTitle = typeof summary.generated_title === 'string' ? summary.generated_title.trim() : ''
  const sessionSummary = typeof summary.session_summary === 'string' ? summary.session_summary.trim() : ''
  const explicitTitle = generatedTitle || sessionSummary || null

  // 会话级模型兜底（summary.current_model_id）：转录里没带 model_id 的 assistant 步骤与压缩
  // 检查点都用它；两者都缺时由合成层回退 provider 名。
  const summaryModel = typeof summary.current_model_id === 'string' && summary.current_model_id.trim()
    ? summary.current_model_id.trim()
    : null
  // 压缩边界处的「当前模型」：最近一条 assistant 的 model_id 优先（它才是跑压缩的模型），
  // 边界之前还没出现 assistant 时用会话级兜底。
  let currentModel = summaryModel

  const turns = []
  let cur = null
  let lastStep = null
  // callId → 所属 step（会话级）：结果记录可能晚于后续 assistant 到达，按 callId 挂回
  // call 所在 step，保证投影出的 tool 消息紧邻其 tool_calls 的 assistant（wire 规则）
  const callSteps = new Map()
  // 会话级「未覆盖」调用（按到达顺序）：缺 id 的结果记录的唯一候选兜底
  const openCallIds = []
  // 丢弃的孤儿 tool/result 计数（转录里没有对应调用或归属歧义）
  let droppedToolResults = 0
  // 注入行与未知 type 的过滤计数（reasoning 不计——它的明文进对话）
  let filtered = 0
  // 开关开启时收集 system（系统提示词）文本，作为上下文注入保留
  let systemPrompt = null
  // 图片降级计数（拿不到字节的图以 [image] 文本占位；能落成宿主附件的不计这里）
  let imagesDegraded = 0
  // backend_tool_call 计数（后端工具结果不在转录里，只上报不映射）
  let backendToolCalls = 0
  // 首个真实提问（剥包装、非注入）：显式标题缺失时的标题兜底；不因压缩切窗而改变
  let titleTopic = null
  // 待落到「下一个开启的轮」上的压缩检查点（摘要来自 compaction_meta 交接摘要行）
  let pendingCompaction = null
  // reasoning 缓冲：真实格式在 assistant 前紧邻一行 reasoning，直接开步会把一个概念步骤
  // 拆成两步、虚增 steps/messages，故等该步骤由 assistant 真正开启时再前置
  let pendingReasoning = []

  // 新开一个「用户提问」回合；带待落检查点时挂到新轮上（该轮成为压缩边界之后的可见段）
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

  // 开启一个 assistant 步骤（文本 / 工具调用）；缓冲的 reasoning 前置到该步开头
  const openStep = () => {
    const step = { content: [], toolCalls: [], toolResults: [] }
    if (pendingReasoning.length) {
      step.content.push(...pendingReasoning)
      pendingReasoning = []
    }
    cur.steps.push(step)
    lastStep = step
    return step
  }

  // 压缩边界：此刻已开的轮全部在边界之前 → 标 shadowed（log-only），下一个轮挂检查点
  const markCompaction = (text) => {
    for (const t of turns) t.shadowed = true
    cur = null
    lastStep = null
    pendingReasoning = []
    pendingCompaction = { summary: text, provider: 'grok-build', model: currentModel || undefined }
  }

  // 结果内容 + 图片块。图片有内联字节（`{type:'image',url:'data:…'}` 或 `{type:'image',data}`
  // 的 base64）时产出 IR image 块，由宿主层落成附件；拿不到字节才降级 [image] 文本（不静默丢弃）。
  const buildResult = (rawContent, rawImages) => {
    const imageBlocks = []
    let degraded = 0
    if (Array.isArray(rawImages)) {
      for (const raw of rawImages) {
        if (!raw || typeof raw !== 'object') { degraded++; continue }
        const img = imageBlockFromSource(raw)
        if (img) imageBlocks.push(img)
        else degraded++
      }
    }
    return { content: mapToolResultContent(rawContent), imageBlocks, degraded }
  }

  const attachResult = (toolCallId, result, isError) => {
    const step = callSteps.get(toolCallId)
    if (!step) { droppedToolResults++; return }
    const content = result.content.slice()
    content.push(...result.imageBlocks)
    for (let i = 0; i < result.degraded; i++) content.push({ type: 'text', text: IMAGE_PLACEHOLDER })
    step.toolResults.push({ toolCallId, content, isError: isError === true })
    imagesDegraded += result.degraded
    const i = openCallIds.indexOf(toolCallId)
    if (i !== -1) openCallIds.splice(i, 1)
  }

  // 真实格式的 tool_result 行：顶层 tool_call_id 优先，缺 id 时兜底唯一未覆盖调用（多候选不冒险错配）
  const attachResultRecord = (rec) => {
    const result = buildResult(rec.content, rec.images)
    const id = typeof rec.tool_call_id === 'string' && rec.tool_call_id ? rec.tool_call_id : null
    if (id) attachResult(id, result, rec.is_error)
    else if (openCallIds.length === 1) attachResult(openCallIds[0], result, rec.is_error)
    else droppedToolResults++
  }

  // Claude 风格 tool_result 块（user/tool 记录里的嵌套块）
  const attachToolResultBlock = (block) => {
    const result = buildResult(block.content, block.images)
    const id = block.tool_use_id
    if (typeof id === 'string' && id) attachResult(id, result, block.is_error)
    else if (openCallIds.length === 1) attachResult(openCallIds[0], result, block.is_error)
    else droppedToolResults++
  }

  for (const rec of recs) {
    if (!rec || typeof rec !== 'object') continue
    // v0 兼容：行无 type 有 role 时按 role 走同一管线
    const kind = rec.type ?? rec.role

    if (kind === 'system') {
      if (args.importSystemPrompt === true) {
        const text = parseGrokContent(rec.content).texts.join('\n').trim()
        if (text) systemPrompt = systemPrompt ? systemPrompt + '\n\n' + text : text
      }
      filtered++
      continue
    }

    // reasoning：明文 summary 缓冲后前置到下一个 assistant 步骤（见 pendingReasoning），
    // 不再计 filtered——它是模型产物的可读部分，不是被丢弃的记录
    if (kind === 'reasoning') {
      const text = grokReasoningText(rec)
      if (text) pendingReasoning.push({ type: 'reasoning', text })
      continue
    }

    // 后端工具（web_search 等）：结果不在转录里，只计数不映射（见文件头契约）
    if (kind === 'backend_tool_call') { backendToolCalls++; continue }

    if (kind === 'tool_result') { attachResultRecord(rec); continue }

    if (kind === 'user') {
      const pc = parseGrokContent(rec.content)
      // Claude 风格：user 记录里的 tool_result 块是结果消息，配对、不开新轮
      if (pc.toolResults.length > 0) {
        for (const tr of pc.toolResults) attachToolResultBlock(tr)
        continue
      }
      const raw = pc.texts.join('\n').trim()
      const reason = typeof rec.synthetic_reason === 'string' && rec.synthetic_reason
        ? rec.synthetic_reason
        : null
      if (reason && reason !== 'human') {
        // compaction_meta 的交接摘要是压缩边界（原生检查点）；其余 harness 注入不开轮。
        // 注入判定用剥包装后的正文：compaction_meta 的 <user_info> 环境块永远按注入。
        if (reason === 'compaction_meta' && !isInjectedTopic(stripUserQueryWrapper(raw))) {
          const text = stripUserQueryWrapper(raw)
          if (args.fullHistory === true) {
            // 全量历史口径：不发检查点，该行按普通 user 记录导入（模型看得到压缩前内容）
            openTurn(text)
          } else {
            markCompaction(text)
          }
          continue
        }
        filtered++
        continue
      }
      if (rec.prior_turn_interrupt === 'mid_turn_abort' && cur) {
        // 上一轮被中断：如实标到该轮，由合成层映射为 turn/end 的 aborted（对齐 codex turn_aborted）
        cur.aborted = true
      }
      // 中断/插话场景只有 <user_query> 里的是人类提问（叙述信封是 harness 产物）；剥完为空
      // 或命中注入前缀就不开轮、不作标题
      const prompt = stripUserQueryWrapper(raw)
      if (isInjectedTopic(prompt)) { filtered++; continue }
      if (prompt) {
        if (titleTopic === null) titleTopic = prompt
        openTurn(prompt)
      }
      continue
    }

    if (kind === 'assistant') {
      // 压缩点之后的产物若还没开轮（边界落在轮中间、后半段以 assistant 起头），用空 prompt
      // 轮承载——检查点本身就是这一轮的 user 侧消息（codex markCompaction/openTurn('') 模式）
      if (pendingCompaction && !cur) openTurn('')
      // 无当前轮（转录中途开始的产物）忽略——与既有口径一致
      if (!cur) continue
      const step = openStep()
      const pc = parseGrokContent(rec.content)
      for (const block of pc.blocks) {
        const mapped = mapGrokBlock(block)
        if (!mapped) continue
        // 空文本块（真实格式 content:'' 的工具轮）不占位
        if (mapped.type === 'text' && !mapped.text) continue
        if (mapped.type === 'tool-call') {
          step.content.push(mapped)
          step.toolCalls.push(mapped)
          callSteps.set(mapped.id, step)
          openCallIds.push(mapped.id)
        } else {
          step.content.push(mapped)
        }
      }
      // 真实格式：工具调用在顶层 tool_calls（content 只是文本）；arguments 是 JSON 字符串，
      // 原样保留（不解析再序列化，避免丢失源格式）
      if (Array.isArray(rec.tool_calls)) {
        for (const tc of rec.tool_calls) {
          if (!tc || typeof tc !== 'object') continue
          const mapped = {
            type: 'tool-call',
            id: tc.id,
            name: typeof tc.name === 'string' && tc.name ? tc.name : 'unknown',
            arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
          }
          step.content.push(mapped)
          step.toolCalls.push(mapped)
          callSteps.set(mapped.id, step)
          openCallIds.push(mapped.id)
        }
      }
      if (typeof rec.model_id === 'string' && rec.model_id) {
        step.model = rec.model_id
        currentModel = rec.model_id
      }
      // assistant 记录里的 tool_result 块（防御）同样配对
      for (const tr of pc.toolResults) attachToolResultBlock(tr)
      continue
    }

    // Claude 风格 tool 记录（export/grokbuild.mjs 写出的形状）：块/纯文本/top-level id
    if (kind === 'tool') {
      const pc = parseGrokContent(rec.content)
      if (pc.toolResults.length > 0) {
        for (const tr of pc.toolResults) attachToolResultBlock(tr)
        continue
      }
      // 纯文本 tool 记录：顶层 tool_use_id 优先，其次唯一未覆盖调用；否则孤儿丢弃
      const result = buildResult(pc.texts.join('\n'), rec.images)
      const recId = typeof rec.tool_use_id === 'string' && rec.tool_use_id ? rec.tool_use_id : null
      if (recId) attachResult(recId, result, rec.is_error)
      else if (openCallIds.length === 1) attachResult(openCallIds[0], result, rec.is_error)
      else droppedToolResults++
      continue
    }

    // 未知 type（含 schema 漂移）不静默吞：计 filtered 上报
    filtered++
  }

  // 收尾：末尾的 reasoning 没等到后续 assistant 步骤（如轮被中断）时落到最后一步；
  // 整个轮尚无任何步骤则补一步，避免可读内容被丢掉（codex pendingReasoning 同款）
  if (pendingReasoning.length && cur) {
    const step = lastStep || openStep()
    step.content.push(...pendingReasoning)
    pendingReasoning = []
  }

  // 待落检查点没等到新轮（会话正好停在压缩点）：空 prompt 轮兜住，否则边界无处发射。
  // 注意此处不再设 titleTopic：压缩摘要是 harness 交接文本，不是人类提问（显式标题缺失时
  // 标题仍会经 turns[0].prompt 兜底，口径与既有实现一致）。
  if (pendingCompaction) openTurn('')

  const sessionId = args.sessionId || mintSessionId(sourceId)
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt }
  if (sourceId) meta.sourceId = sourceId
  if (cwd) meta.cwd = cwd

  // 标题：显式（generated_title > session_summary）钉事件；首问兜底只回填 out.title。
  // 无可导入内容（turns=0）时不钉 title 事件——Grok 的 summary 几乎总带 generated_title，
  // 空 chat_history 也满足显式标题；若照常钉事件，index 层的空会话跳过判定
  //（turns===0 && events===0）会失效，落盘只有一条 title 的空会话。
  const finalTitle = normalizeTitle(explicitTitle || titleTopic || (turns.length > 0 ? turns[0].prompt : ''))
  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, args.budget)
  const syn = synthesizeSession({
    meta,
    turns: seedTurns,
    title: turns.length > 0 && explicitTitle ? finalTitle : undefined,
    provider: 'grokbuild',
    // 会话级模型兜底：summary.current_model_id（源记录每步 model_id 时由 step.model 覆盖）
    model: summaryModel || undefined,
    skipped,
    records: recs.length,
    skippedLines,
    secrets,
    imported: { sourcePath: args.sourcePath },
    systemPrompt,
  })
  return {
    ...syn,
    title: finalTitle,
    filtered,
    droppedToolResults,
    // 图片降级数（>0 才占键）
    ...(imagesDegraded > 0 ? { imagesDegraded } : {}),
    backendToolCalls,
    ...(trimmed ? { trimmed } : {}),
    // compacted 由合成层的事实决定：syn.compactions 是实际发射的原生检查点数
    ...(syn.compactions ? { compacted: true } : {}),
  }
}

// summary.json 无法解析时的空结果形态（对齐 claude 辅助 transcript 的 skipReason 返回）。
function emptySkip(reason) {
  return {
    meta: null,
    events: [],
    turns: [],
    title: undefined,
    messages: 0,
    toolCalls: 0,
    skipped: 0,
    records: 0,
    filtered: 0,
    droppedToolResults: 0,
    images: 0,
    backendToolCalls: 0,
    skippedLines: [],
    secrets: [],
    skipReason: reason,
  }
}
