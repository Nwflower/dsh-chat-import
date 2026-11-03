// lib/convert/codebuddy.mjs — CodeBuddy Code（腾讯云代码助手 CLI）会话 JSONL → DSH 会话（纯函数）
//
// 存储（从 @tencent-ai/codebuddy-code v2.179.3 的会话存储实现归纳）：
//   默认根：~/.codebuddy/projects
//   布局：projects/<projectKey>/<sessionId>.jsonl
//     projectKey   = compressWorkspacePathName(cwd)：把路径里的 / \ : 换成 -，折叠连续 -，
//                    去掉首尾 -；超过 255 字节则截断到 180 字节再加 '-' + djb2Base36(全串)
//     <sessionId>.jsonl        会话正文，一行一条事件（append-only）
//     <sessionId>.meta.json    会话元数据侧车（title / cwd 等，正文尾部也有 session-meta 行）
//     <parentSessionId>/subagents/agent-*.jsonl   子代理会话
//
// 事件词汇是 OpenAI Agents SDK 的条目 + 本产品的扩展字段（sessionId / parentId /
// logicalParentId / timestamp / cwd），与 WorkBuddy Desktop 同源，共用引擎在
// ./buddy-family.mjs；本文件只留 CodeBuddy 的差异：
//   * user 提问不包壳（SDK 的 user() 直出），真人提问由 isMeta / startsNewUserRequest /
//     skipRun / agent 等标记区分（见 userPromptOf）；
//   * 有显式标题条目 custom-title / ai-title；
//   * message.content 可以是字符串（SDK 形态）或 input_text / output_text / input_image 块数组；
//   * 模型名与 token 用量在 providerData.model / usage / rawUsage；
//   * 另有 topic / summary / goal-result / goal-progress / turn-metrics / credit-usage /
//     model-usage / context-usage / request-recovery / acp-terminal-state / resend-fork-notice
//     等运行期条目，一律不进正文（计数上报 droppedMetaItems）。

import { convertBuddyJsonl } from './buddy-family.mjs'

/** 内容块 → DSH 块。input_text / output_text / text 取 text 字段；input_image 是运行期
 *  图片引用（本地路径或 data URI，导入后无意义），跳过（不虚构文本）。 */
function mapBlock(block) {
  if (!block || typeof block !== 'object') return null
  if ((block.type === 'output_text' || block.type === 'input_text' || block.type === 'text')
    && typeof block.text === 'string' && block.text.length > 0) {
    return { type: 'text', text: block.text }
  }
  return null
}

/**
 * user message → 真人提问。CodeBuddy 的 user 条目大多是框架注入（system-reminder、
 * 通知、排队 steer、compact 续跑、子代理内部消息），只有真人输入才开轮。判据只用结构化
 * 标记，不看内容正则——内容兜底会把用户粘贴的 `<system-reminder>` 误判成注入。
 *
 * 注入判据（任一成立即不算真人提问）：
 *   isMeta               不作为普通用户输入展示的元消息
 *   skipRun              不触发模型运行的占位（中断提示 / 技能禁用说明等）
 *   startsNewUserRequest === false   延续当前 request 的内部续跑（错误恢复 / "continue"）
 *   agent === COMPACT    compact 子代理的内部用户消息
 *   isAdditionalData     附带的上下文 / 附加数据
 */
export function codebuddyUserPrompt(rec) {
  if (rec.isMeta === true) return ''
  if (rec.skipRun === true) return ''
  if (rec.startsNewUserRequest === false) return ''
  if (rec.isAdditionalData === true) return ''
  const agent = typeof rec.agent === 'string' ? rec.agent : ''
  if (agent && agent.toUpperCase() === 'COMPACT') return ''
  const content = rec.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const texts = []
  for (const b of content) {
    if (b && (b.type === 'input_text' || b.type === 'output_text' || b.type === 'text')
      && typeof b.text === 'string' && b.text) texts.push(b.text)
  }
  return texts.join('\n').trim()
}

/** 模型名：消息级 providerData.model 优先，退回 requestModelId（function_call 上用）。 */
function modelOf(rec) {
  const pd = rec.providerData
  if (!pd || typeof pd !== 'object') return null
  if (typeof pd.model === 'string' && pd.model) return pd.model
  if (typeof pd.requestModelId === 'string' && pd.requestModelId) return pd.requestModelId
  return null
}

/**
 * token 用量 → DSH usage。CodeBuddy 的 providerData.usage / rawUsage 两处都可能有，
 * 且键名同时存在 snake_case 与 camelCase 两代（SDK 的 Usage 是 camelCase，落盘的
 * rawUsage 常是 snake_case）。四桶口径与其它来源一致：input / output / cacheRead /
 * reasoning；任一必填桶不合法就整份丢弃（宿主投影会对它做算术）。
 */
export function codebuddyUsage(rec) {
  const pd = rec.providerData
  if (!pd || typeof pd !== 'object') return undefined
  const u = pd.usage || pd.rawUsage
  if (!u || typeof u !== 'object') return undefined
  const pick = (...keys) => {
    for (const k of keys) {
      const v = u[k]
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.trunc(v)
    }
    return null
  }
  const inputTokens = pick('input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens')
  const outputTokens = pick('output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens')
  if (inputTokens === null || outputTokens === null) return undefined
  const usage = { inputTokens, outputTokens }
  const cacheReadTokens = pick('cache_read_input_tokens', 'cacheReadInputTokens', 'cache_tokens', 'cacheTokens', 'prompt_cache_hit_tokens')
  if (cacheReadTokens !== null) usage.cacheReadTokens = cacheReadTokens
  const reasoningTokens = pick('reasoning_tokens', 'reasoningTokens', 'completion_thinking_tokens', 'completionThinkingTokens')
  if (reasoningTokens !== null) usage.reasoningTokens = reasoningTokens
  return usage
}

/** 显式标题条目：custom-title / ai-title。 */
function titleOf(rec) {
  if (rec.type === 'custom-title' && typeof rec.customTitle === 'string' && rec.customTitle.trim()) {
    return rec.customTitle.trim()
  }
  if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string' && rec.aiTitle.trim()) {
    return rec.aiTitle.trim()
  }
  return null
}

/** function_call_result → 纯文本。output 常见 { type:'text', text }；纯字符串原样；
 *  对象取 .text / .content / .output；数组取各元素 text。取不到返回 null（不虚构）。 */
function resultText(rec) {
  const out = rec.output
  if (typeof out === 'string' && out) return out
  if (Array.isArray(out)) {
    const texts = []
    for (const b of out) {
      if (b && typeof b === 'object' && typeof b.text === 'string' && b.text) texts.push(b.text)
      else if (typeof b === 'string' && b) texts.push(b)
    }
    return texts.length > 0 ? texts.join('\n') : null
  }
  if (out && typeof out === 'object') {
    if (typeof out.text === 'string' && out.text) return out.text
    if (typeof out.content === 'string' && out.content) return out.content
    if (typeof out.output === 'string' && out.output) return out.output
  }
  return null
}

/** 结果是否算失败：status 明说 incomplete，或 output 里带 MCP/JSON 错误信号。 */
function resultIsError(rec) {
  if (rec.status && rec.status !== 'completed') return true
  const out = rec.output
  if (out && typeof out === 'object' && out.isError === true) return true
  return false
}

/** reasoning 条目 → 正文。SDK 的 ReasoningItem 正文在 content（数组或字符串）。 */
function reasoningText(rec) {
  const c = rec.content
  if (typeof c === 'string' && c.trim()) return c.trim()
  if (!Array.isArray(c)) return null
  const texts = []
  for (const b of c) {
    if (!b || typeof b !== 'object') continue
    if (typeof b.text === 'string' && b.text) texts.push(b.text)
  }
  return texts.length > 0 ? texts.join('\n') : null
}

const CODEBUDDY_PROFILE = {
  provider: 'codebuddy',
  idArg: 'codebuddyId',
  // 无 custom-title / ai-title 时把「首条真人提问」写进结果（与 WorkBuddy 同口径）
  pinFallbackTitle: true,
  userPrompt: codebuddyUserPrompt,
  mapBlock,
  modelOf,
  usageOf: codebuddyUsage,
  reasoningText,
  resultText,
  resultIsError,
  titleOf,
  // 草稿 / 被丢弃的调用不落盘（与 WorkBuddy 同口径）
  skipCall: (rec) => Boolean(rec.providerData && (rec.providerData.isPartialAborted || rec.providerData.discard)),
}

/** CodeBuddy Code 会话 JSONL → DSH 会话。 */
export function convertCodebuddyJsonl(raw, args = {}) {
  return convertBuddyJsonl(raw, args, CODEBUDDY_PROFILE)
}
