// lib/convert/cherrystudio.mjs — Cherry Studio 的 Claude 形态转录导入
//
// Cherry Studio 把 Claude Code 会话写进自己 app data 的 .claude/projects 下，
// 记录形状与 Claude Code 同构，可直接复用 convertClaudeJsonl。唯一差异：流式
// 输出期间同一条 assistant 回复会随流追加多次（新 uuid、同一 requestId /
// message.id、文本逐次变长）。原样导入会把一条回复拆成 3–4 条前缀消息。
// 这里先按调用键折叠、保留内容最长的快照，再交给 Claude 转换器。

import { parseJsonlLines } from './core.mjs'
import { convertClaudeJsonl } from './claude.mjs'

// 一组快照的内容长度：只数 message.content 里的文本/思考块，不把 usage 等
// 元数据算进去（快照增长的是正文）。
function snapshotWeight(rec) {
  const content = rec?.message?.content
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (typeof block.text === 'string') n += block.text.length
    else if (typeof block.thinking === 'string') n += block.thinking.length
    else if (block.type === 'tool_use' && typeof block.input === 'object') {
      try { n += JSON.stringify(block.input).length } catch { /* 循环引用按 0 */ }
    }
  }
  return n
}

// deja 的 cherrySnapshotKey 口径：requestId 优先，否则 message.id。
// uuid 每次快照都变，不能当键。
function snapshotKey(rec) {
  if (!rec || typeof rec !== 'object') return ''
  if (typeof rec.requestId === 'string' && rec.requestId) return 'req:' + rec.requestId
  const id = rec.message?.id
  if (typeof id === 'string' && id) return 'msg:' + id
  return ''
}

/** 折叠流式快照，返回可交给 convertClaudeJsonl 的 JSONL 文本。 */
export function collapseCherryStudioSnapshots(raw) {
  const { recs } = parseJsonlLines(raw)
  const best = new Map() // key -> 该组最优记录在原数组的下标
  const weights = new Map() // key -> 最优记录的正文长度
  for (let i = 0; i < recs.length; i += 1) {
    const key = snapshotKey(recs[i])
    if (!key) continue
    const w = snapshotWeight(recs[i])
    if (!best.has(key) || w > weights.get(key)) {
      best.set(key, i)
      weights.set(key, w)
    }
  }
  const keep = new Set(best.values())
  const lines = []
  for (let i = 0; i < recs.length; i += 1) {
    const rec = recs[i]
    if (!rec || typeof rec !== 'object') continue
    const key = snapshotKey(rec)
    // 有键但非组内最优 = 流式前缀快照，丢弃；无键的记录（queue-operation /
    // attachment / last-prompt / mode 等）原样保留，Claude 转换器已按元数据忽略。
    if (key && !keep.has(i)) continue
    lines.push(JSON.stringify(rec))
  }
  return lines.join('\n') + (lines.length ? '\n' : '')
}

/** Cherry Studio 转录 → DSH 会话事件。 */
export function convertCherrystudioJsonl(raw, args = {}) {
  return convertClaudeJsonl(collapseCherryStudioSnapshots(raw), args)
}
