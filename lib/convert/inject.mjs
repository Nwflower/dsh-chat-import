// lib/convert/inject.mjs — 注入内容识别与信封剥离（纯函数，全源共用）
//
// 背景：外部 Agent 工具的宿主/CLI 会把非人类内容写进转录——环境块
//（<environment_context> / <user_info>）、系统提醒（<system-reminder>）、斜杠命令
// 日志（<local-command-*>）、AGENTS.md 注入（# AGENTS.md instructions）、粘贴信封
//（<pasted_content>）、Grok 的提问包装（<user_query>）。这些都不是会话话题：
// 不开轮、不作标题。
// 此前注入前缀表有 2 处内联副本（discovery.mjs 的 isInjectedTitle、convert/claude.mjs
// 的 isInjectedTopic）；codex/grokbuild 的注入识别是第 3 处使用点，触发 AGENTS.md
// 体量停止线，故抽本模块作为唯一真相源（2026-09，经用户确认的拆分提案）。
// 消费方：convert/claude.mjs、convert/codex.mjs、convert/grokbuild.mjs、
// lib/discovery.mjs；对外经 lib/convert/index.mjs re-export。

// 注入前缀表（trim 后首行命中即视为注入；大小写不敏感；空文本也视为注入）。
// 每条都有真实数据依据：斜杠命令日志与环境注入块是宿主写进转录的产物（实测整场只有
// 本地命令的会话，首问兜底曾把 <local-command-caveat> 整段当成标题；另有会话的首个
// 「真实提问」是斜杠命令输出回灌 <local-command-stdout>）；<user_info> 是 Grok Build
// 的环境注入块（OS / Shell / Workspace / 日期 / rules，不带 synthetic_reason）。
// 注意 <user_query> 不在表中——它是提问包装，要剥信封留正文（stripUserQueryWrapper），
// 不是整条判注入。
export const INJECT_MARKERS = [
  '<environment_context>', '<system-reminder>', '<user_instructions>',
  '<local-command-caveat>', '<local-command-stdout>', '<command-name>', '<permissions>',
  '# AGENTS.md', '# Files mentioned', 'The user is asking about',
  '# Context from my IDE setup:',
  '<user_info>',
]

// 注入判定：空文本视为注入（调用方跳过，不产生空标题/空轮）。
export function isInjectedTopic(text) {
  const t = String(text ?? '').trim()
  if (!t) return true
  const lower = t.toLowerCase()
  return INJECT_MARKERS.some((m) => lower.startsWith(m.toLowerCase()))
}

// 粘贴信封剥离：<pasted_content id="…">正文</pasted_content id="…"> 是宿主给「粘贴进来
// 的正文」加的信封（实测三种真实形态：信封在开头、信封在提问之后、以及只有开标签没有
// 闭标签）。信封本身不是话题，剥掉标签留正文；剥完为空则原样返回。
export function stripPastedWrapper(text) {
  const t = String(text ?? '').trim()
  if (!t.includes('<pasted_content')) return t
  const cleaned = t.replace(/<\/?pasted_content(?:\s[^>]*)?>/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned || t
}

// Grok 提问包装剥离：真实提问被包成 <user_query>\n…\n</user_query>，中断与插话场景
// 再加一层叙述信封（「The user interrupted the previous turn:…Make sure to…」、
// 「The user sent a message while you were working:…」）。叙述行是 harness 产物，只有
// <user_query> 里的正文是人类提问：提取全部 <user_query> 正文（多个拼接；闭标签缺失
// 取到文本末尾；正文为空返回 ''，由调用方按空提问处理）。不含 <user_query> 时原样返回。
export function stripUserQueryWrapper(text) {
  const t = String(text ?? '').trim()
  if (!t.includes('<user_query>')) return t
  const parts = []
  const re = /<user_query>([\s\S]*?)(?:<\/user_query>|$)/g
  let m
  while ((m = re.exec(t)) !== null) {
    const inner = m[1].trim()
    if (inner) parts.push(inner)
  }
  return parts.join('\n')
}
