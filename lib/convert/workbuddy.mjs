// lib/convert/workbuddy.mjs — WorkBuddy（腾讯 AI 编程应用）会话 JSONL → DSH 会话（纯函数）
//
// 存储：~/.workbuddy/projects/<project-hash>/<session-uuid>.jsonl（逐行事件 JSON）。
// 事件词汇与 CodeBuddy Code CLI 同源（message / reasoning / function_call /
// function_call_result / file-history-snapshot），共用引擎在 ./buddy-family.mjs；本文件只留
// WorkBuddy 的差异：user 提问包在 <user_query>…</user_query> 里、没有显式标题条目、
// 结果正文在 output / providerData.toolResult 里。

import { normalizeTitle } from './util.mjs'
import { contentText } from './util.mjs'
import { stripSystemReminders } from './inject.mjs'
import { convertBuddyJsonl } from './buddy-family.mjs'

// 从 WorkBuddy 注入的 user content（块数组）里提取人类真实提问——导入的提问与发现层
// （lib/discovery/claude.mjs）的面板标题共用这一份口径。
// 优先取 <user_query>…</user_query> 包住的正文；缺失时剥掉 <system-reminder>…</system-reminder>
// 大块，其余标签**替换为空格**（标签两侧常是不同块的文字，直接删会把相邻两段粘成一个词）
// 后折叠空白。始终去首尾空白；非数组 content 没有可提取的提问，得 ''。
export function extractWorkbuddyUserQuery(content) {
  const joined = Array.isArray(content) ? contentText(content, { types: null }) : ''
  // 1) 权威：<user_query> 包住的正文（含多行到闭合标签）
  const m = /<user_query>([\s\S]*?)<\/user_query>/.exec(joined)
  if (m && m[1] && m[1].trim()) return m[1].trim()
  // 2) 回退：剥掉 system-reminder 整块后去标签取纯文本
  return stripSystemReminders(joined).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

// WorkBuddy message content block → DSH 文本块。
// output_text / input_text / text 经 text 字段 → { type:'text' }；image_blob_ref 是
// 运行期图片引用（本地路径，导入后无意义），跳过（不虚构文本）。
function mapTextBlock(block) {
  if (!block || typeof block !== 'object') return null
  if ((block.type === 'output_text' || block.type === 'input_text' || block.type === 'text')
    && typeof block.text === 'string' && block.text.length > 0) {
    return { type: 'text', text: block.text }
  }
  return null
}

// WorkBuddy function_call_result → 纯文本结果。
// output 常见形态：{ type:'text', text }；providerData.toolResult 还带 title/content；
// 纯字符串原样；object 取 .text / .content / .output；取不到返回 null（不虚构）。
function workbuddyResultText(rec) {
  const pdTool = rec.providerData && rec.providerData.toolResult
  const candidates = [rec.output, pdTool]
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c
    if (c && typeof c === 'object') {
      if (typeof c.text === 'string' && c.text) return c.text
      if (typeof c.content === 'string' && c.content) return c.content
      if (typeof c.output === 'string' && c.output) return c.output
    }
  }
  if (typeof rec.output === 'string' && rec.output) return rec.output
  return null
}

// WorkBuddy profile：无显式标题条目、提问包 <user_query>、模型在 providerData.model。
const WORKBUDDY_PROFILE = {
  provider: 'workbuddy',
  idArg: 'workbuddyId',
  // WorkBuddy 没有显式标题条目，历来把「首问」当标题写进结果（既有行为，勿改）
  pinFallbackTitle: true,
  userPrompt: (rec) => extractWorkbuddyUserQuery(rec.content),
  mapBlock: mapTextBlock,
  modelOf: (rec) => (rec.providerData && typeof rec.providerData.model === 'string' && rec.providerData.model) || null,
  // 打断 / 丢弃的草稿调用（isPartialAborted / discard）无结果、不保留
  skipCall: (rec) => Boolean(rec.providerData && (rec.providerData.isPartialAborted || rec.providerData.discard)),
  reasoningText: (rec) => {
    const texts = []
    for (const block of rec.rawContent || []) {
      if (block && block.type === 'reasoning_text' && typeof block.text === 'string' && block.text) {
        texts.push(block.text)
      }
    }
    return texts.length > 0 ? texts.join('\n') : null
  },
  resultText: workbuddyResultText,
}

/** WorkBuddy 会话 JSONL → 统一的回合中间结构 + DSH 事件日志。 */
export function convertWorkbuddyJsonl(raw, args = {}) {
  return convertBuddyJsonl(raw, args, WORKBUDDY_PROFILE)
}

export { normalizeTitle }
