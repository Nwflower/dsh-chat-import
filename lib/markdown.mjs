// lib/markdown.mjs — 独立 Markdown 导出（纯函数，零 DSH 依赖）
//
// 把 DSH 会话日志（session.jsonl 的 JSON 行）渲染为人类可读 Markdown：
// 会话头、标题、user/assistant 文本、thinking、工具调用与结果。
// 供 `bin/dsh-chat-import.mjs export-md` 使用；也可被其它工具复用。
//
// 工具结果用 convert 层的形状无关访问器读取（V3 wrapper / V4 一级 tool 消息都能认）：
// 会话可能是任一格式版本，按单一形状渲染会让另一版本的会话丢掉结果内容。
import { toolResultOf } from './convert/index.mjs'

/** 把 content block 数组（或纯字符串）转成 Markdown 文本。纯函数。 */
export function blocksToMarkdown(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') {
      parts.push(String(block.text ?? ''))
    } else if (block.type === 'thinking') {
      parts.push(`> 💭 ${String(block.thinking ?? block.text ?? '')}`)
    } else if (block.type === 'tool_use') {
      parts.push(`\`🔧 ${block.name}(${String(block.input ? JSON.stringify(block.input) : '')})\``)
    } else if (block.type === 'tool-result') {
      parts.push(`📦 Tool result: ${blocksToMarkdown(block.content)}`)
    } else if (block.type === 'image') {
      // 图片在会话日志里是附件引用（无内联字节）：Markdown 侧只标注引用与展示名，
      // 字节由附件服务按 attachmentId 提供（export-md 是离线只读通道，不读附件存储）。
      const ref = block.attachment && typeof block.attachment === 'object' ? block.attachment : null
      const name = (ref && typeof ref.name === 'string' && ref.name)
        || (typeof block.name === 'string' && block.name)
        || 'image'
      const id = ref && typeof ref.attachmentId === 'string' ? ref.attachmentId : (typeof block.data === 'string' ? 'inline' : '')
      parts.push(id ? `🖼 [${name}](${id})` : `🖼 [${name}]`)
    } else if (block.text !== undefined) {
      parts.push(String(block.text))
    }
  }
  return parts.join('\n\n')
}

/**
 * 把 DSH 会话 JSONL 文本渲染为 Markdown。
 * @param {string} text session.jsonl 文本
 * @returns {string} Markdown
 */
export function sessionJsonlToMarkdown(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  const records = []
  for (const line of lines) {
    try {
      records.push(JSON.parse(line))
    } catch {
      // 畸形行跳过；导出时可保留计数（此处保持简单）
    }
  }
  const session = records.find((r) => r && r.type === 'session' && r.id)
  const titleRecord = [...records].reverse().find((r) => r && r.type === 'session/title' && r.data && typeof r.data.title === 'string')
  const out = []
  out.push(`# ${titleRecord ? titleRecord.data.title : (session ? session.id : 'DSH Session')}`)
  out.push('')
  if (session) {
    out.push(`- **Session**: \`${session.id}\``)
    if (session.cwd) out.push(`- **Cwd**: \`${session.cwd}\``)
    if (session.createdAt !== undefined) out.push(`- **Created**: ${new Date(Number(session.createdAt) || session.createdAt).toISOString()}`)
    out.push('')
  }
  for (const rec of records) {
    if (!rec || typeof rec.type !== 'string') continue
    if (rec.type === 'user/message') {
      const data = rec.data || {}
      out.push('## User')
      out.push('')
      out.push(blocksToMarkdown(data.content))
      out.push('')
    } else if (rec.type === 'assistant/message') {
      const data = rec.data || {}
      const msg = data.message || {}
      out.push('## Assistant')
      out.push('')
      out.push(blocksToMarkdown(msg.content))
      out.push('')
    } else if (rec.type === 'tool/call') {
      const d = rec.data || {}
      out.push(`> 🔧 Tool call: \`${d.name}(${d.arguments ?? ''})\``)
      out.push('')
    } else if (rec.type === 'tool/result') {
      // 形状无关：V3 的结果在 content[0]（{type:'tool-result'} wrapper）里，V4 直接放在
      // message.content 上。按 wrapper 渲染会让 V4 会话丢掉「Tool result」标记与包装。
      const result = toolResultOf(rec)
      const content = result ? result.blocks : (rec.data && rec.data.message || {}).content
      out.push(`> 📦 Tool result: ${blocksToMarkdown(content)}`)
      out.push('')
    } else if (rec.type === 'session/title' || rec.type === 'session' || rec.type === 'turn/start' || rec.type === 'turn/end' || rec.type === 'step/start' || rec.type === 'step/end') {
      // 不渲染结构性事件
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}
