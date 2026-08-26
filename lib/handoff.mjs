// lib/handoff.mjs — 交接摘要续聊（REQ-30，对标 dsh-resume-plugin）纯函数层
//
// 把外部 transcript（Claude Code JSONL / Codex rollout JSONL）当**不可信静态历史**，
// 提炼交接摘要（目标 + 最后请求、相关文件/产物、已完成/未完成、精确停止点、最安全
// 下一步），供 /resume-claude /resume-codex 注入当前会话继续工作。
// 安全模型（对标同类生态插件）：不执行/不复述 system/developer/reasoning（thinking 块）、
// 旧工具输出视为过期证据需复核、歧义引用列候选不猜测——本模块只产出**摘要文本**，
// 不执行任何命令。纯函数、零 DSH 依赖；选择逻辑（最近 / id / 关键词）在
// lib/resume-command.mjs（host 面）。

// 逐行解析 JSONL（畸形行跳过计数，不整读失败——发现层同款容错）。
function parseLines(raw) {
  const recs = []
  let skipped = 0
  for (const line of String(raw ?? '').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      recs.push(JSON.parse(t))
    } catch {
      skipped++
    }
  }
  return { recs, skipped }
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
  }
  return ''
}

function truncate(text, max = 160) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return ''
  return t.length <= max ? t : t.slice(0, max - 1) + '…'
}

// 从记录里收集工具调用涉及的文件路径（最近 steps，只取字符串路径，不执行）。
// Claude 形态：assistant 消息 content 里 tool_use 块（b.input）；Codex 形态：
// response_item.payload.arguments JSON 字符串。
function collectFiles(recs, limit = 6) {
  const files = []
  const seen = new Set()
  const push = (p) => {
    if (typeof p !== 'string' || !p.trim() || p.startsWith('{{')) return
    if (seen.has(p)) return
    seen.add(p)
    files.push(p)
  }
  const fromInput = (input) => {
    if (!input || typeof input !== 'object') return
    push(input.file_path)
    push(input.path)
    push(input.file)
    if (typeof input.glob_pattern === 'string') push(input.glob_pattern)
  }
  for (const rec of recs) {
    if (!rec || typeof rec !== 'object') continue
    if (rec.type === 'assistant' && rec.message && Array.isArray(rec.message.content)) {
      for (const b of rec.message.content) {
        if (b && b.type === 'tool_use' && b.input && typeof b.input === 'object') fromInput(b.input)
      }
    }
    // Codex 形态：response_item.payload.arguments 里 JSON 字符串含路径
    if (rec.type === 'response_item' && rec.payload && typeof rec.payload.arguments === 'string') {
      try {
        fromInput(JSON.parse(rec.payload.arguments))
      } catch {
        // 非 JSON 参数（普通文本）：跳过
      }
    }
  }
  return files.slice(-limit)
}

// Claude Code JSONL → 交接摘要（排除 system/thinking：只读 user/assistant 文本与
// tool_use 名称，不解析 thinking 块内容）。
export function summarizeClaudeJsonl(raw, { sessionId = null } = {}) {
  const { recs, skipped } = parseLines(raw)
  const users = []
  const assistants = []
  const toolUses = []
  let title = null
  let lastTs = null
  let lastType = null
  for (const rec of recs) {
    if (!rec || typeof rec !== 'object') continue
    if (typeof rec.timestamp === 'string') lastTs = rec.timestamp
    lastType = rec.type
    if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string' && !title) title = rec.aiTitle
    if (rec.type === 'user' && rec.message && typeof rec.message.content === 'string') {
      users.push(rec.message.content)
    } else if (rec.type === 'assistant' && rec.message && Array.isArray(rec.message.content)) {
      const text = textOf(rec.message.content)
      if (text) assistants.push(text)
      for (const b of rec.message.content) {
        if (b && b.type === 'tool_use' && typeof b.name === 'string') toolUses.push(b.name)
      }
    }
    // summary 记录（custom-title 载体）与 permission 等跳过（不进入摘要）
  }
  const lastUser = users[users.length - 1] || ''
  const lastAssistant = assistants[assistants.length - 1] || ''
  const files = collectFiles(recs)
  const lastTool = toolUses[toolUses.length - 1] || null
  const summary = [
    '# 交接摘要（Claude Code 会话' + (sessionId ? ' ' + sessionId : '') + '）',
    title ? '- 会话标题：' + truncate(title, 120) : null,
    lastUser ? '- 最后用户请求：' + truncate(lastUser) : null,
    lastAssistant ? '- 最近回复：' + truncate(lastAssistant) : null,
    lastTool ? '- 最近工具调用：' + lastTool : null,
    files.length ? '- 涉及文件/产物：' + files.slice(0, 5).join('、') : null,
    lastTs ? '- 精确停止点：' + lastType + ' @ ' + lastTs : null,
    '- 最安全下一步：接续最后请求继续（旧工具输出视为过期证据，需复核后再用）',
    skipped > 0 ? '（解析跳过 ' + skipped + ' 行畸形记录）' : null,
  ].filter(Boolean).join('\n')
  return { summary, title, lastUserPrompt: lastUser, files, lastTool, skipped }
}

// Codex rollout JSONL → 交接摘要（response_item 消息 + function_call/function_call_output）。
export function summarizeCodexJsonl(raw, { sessionId = null } = {}) {
  const { recs, skipped } = parseLines(raw)
  const users = []
  const assistants = []
  const calls = []
  let lastTs = null
  let lastType = null
  for (const rec of recs) {
    if (!rec || typeof rec !== 'object') continue
    if (typeof rec.timestamp === 'string') lastTs = rec.timestamp
    lastType = rec.type
    const p = rec.payload && typeof rec.payload === 'object' ? rec.payload : null
    if (!p) continue
    if (p.type === 'message' && p.role === 'user') {
      const text = Array.isArray(p.content)
        ? p.content.filter((b) => b && b.type === 'input_text' && typeof b.text === 'string').map((b) => b.text).join('\n')
        : ''
      if (text) users.push(text)
    } else if (p.type === 'message' && p.role === 'assistant') {
      const text = Array.isArray(p.content)
        ? p.content.filter((b) => b && (b.type === 'output_text' || b.type === 'output_text_delta') && typeof b.text === 'string').map((b) => b.text).join('\n')
        : ''
      if (text) assistants.push(text)
    } else if (p.type === 'function_call') {
      calls.push(p.name || 'unknown')
    }
  }
  const lastUser = users[users.length - 1] || ''
  const lastAssistant = assistants[assistants.length - 1] || ''
  const files = collectFiles(recs)
  const lastTool = calls[calls.length - 1] || null
  const summary = [
    '# 交接摘要（Codex 会话' + (sessionId ? ' ' + sessionId : '') + '）',
    lastUser ? '- 最后用户请求：' + truncate(lastUser) : null,
    lastAssistant ? '- 最近回复：' + truncate(lastAssistant) : null,
    lastTool ? '- 最近工具调用：' + lastTool : null,
    files.length ? '- 涉及文件/产物：' + files.slice(0, 5).join('、') : null,
    lastTs ? '- 精确停止点：' + lastType + ' @ ' + lastTs : null,
    '- 最安全下一步：接续最后请求继续（旧工具输出视为过期证据，需复核后再用）',
    skipped > 0 ? '（解析跳过 ' + skipped + ' 行畸形记录）' : null,
  ].filter(Boolean).join('\n')
  return { summary, title: null, lastUserPrompt: lastUser, files, lastTool, skipped }
}
