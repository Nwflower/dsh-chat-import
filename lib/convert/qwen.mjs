// lib/convert/qwen.mjs — 千问办公（Qwen Work CN）会话转写 JSONL → DSH 会话（纯函数）
//
// 千问每个会话一个转写（~/.qwenworkcn/projects/<slug>/<session-uuid>.jsonl），明文
// JSON Lines，事件词汇与 Claude Code transcript 同构：user/assistant 记录带
// message.content 块（text / thinking / tool_use / tool_result）、uuid/parentUuid、
// cwd、timestamp、gitBranch。千问特有差异（2026-08-28 全量实扫取证，44 slug /
// 70 jsonl）：
//   user            人类真实原话在 `humanInput.text` 字段（message.content 的 text 块
//                   被注入 <system-reminder> 等系统上下文包裹，提取时跳过 <system 开头
//                   的块）；无 humanInput 的 user 记录多为 tool_result 载体
//   workspace-directories（通常首行）`directories[]` 是授权目录清单：第 0 个是千问
//                   临时工作区（.qwenworkcn 下），非 .qwenworkcn 的那个才是用户选的
//                   项目文件夹 → 作为会话 cwd/项目；slug 目录名只是存储混写，禁作项目
//   runtime-config  { model, reasoningEffort, contextWindow, generation } 运行期配置
//   active-leaf / last-prompt / file-history-snapshot / attachment  运行期元数据，跳过
//   双副本          同一会话会同时落在 `-sessions-<hash>-mnt` 与 workspace slug 两个
//                   slug 下（sessionId 相同），发现层（discovery.mjs scanQwen）按
//                   sessionId 去重留最新；转换器只负责单文件
// 转换策略与 lib/convert/claude.mjs 同款（一条 assistant = 一步；tool_result 按
// tool_use_id 挂回 call 所属 step；同 step 多结果按 call 顺序对齐），千问差异部分
// 集中在「user 记录开新轮的判定」与「cwd/模型来源」。

import {
  SESSION_FORMAT_VERSION,
  applyBudgetTrim,
  mapContentBlock,
  mintSessionId,
  parseJsonlLines,
  parseTime,
  synthesizeSession,
} from './core.mjs'

// REQ-27 标题归一统一规则：去首尾空白、折叠内部空白；超 80 字符截断加省略号。
// core.mjs 属禁改面，各源按文件内联同款。
const TITLE_MAX_LEN = 80
const TITLE_ELLIPSIS = '…'
function normalizeTitle(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return ''
  return t.length <= TITLE_MAX_LEN ? t : t.slice(0, TITLE_MAX_LEN - TITLE_ELLIPSIS.length) + TITLE_ELLIPSIS
}

// 千问 cwd 的权威判定：workspace-directories 里第一个非 .qwenworkcn 目录是用户选的
// 项目文件夹；全是 .qwenworkcn（纯聊天）时返回 null（发现层归「无项目」桶）。
export function realWorkspaceDir(directories) {
  if (!Array.isArray(directories)) return null
  for (const d of directories) {
    if (typeof d === 'string' && d && !/[\\/]\.qwenworkcn([\\/]|$)/i.test(d)) return d
  }
  return null
}

export function convertQwenJsonl(raw, args = {}) {
  // REQ-26：逐行解析带行号明细 + secrets 位置
  let { recs, skipped, skippedLines, secrets } = parseJsonlLines(raw)

  let sourceId = null
  let cwd = null
  let createdAt = null
  let model = null

  const turns = []
  let cur = null
  // callId → 它所属的 step：tool_result 后置到达，按 callId 挂回 call 所在 step
  //（与 claude.mjs 同款：挂最近一步会让带 tool_calls 的 assistant 后紧跟另一条
  // assistant，投影出的 LLM 消息违反 wire 规则）
  const callSteps = new Map()
  let droppedToolResults = 0
  let droppedUserPrompts = 0
  // 注入型 user 记录（去掉 <system 包裹块后无人类文本且非 tool_result）：千问的
  // awareness/环境上下文载体，正常现象，单独计数不标丢失
  let skippedSystemUsers = 0

  for (const rec of recs) {
    if (rec && typeof rec.sessionId === 'string' && !sourceId) sourceId = rec.sessionId
    if (rec && typeof rec.timestamp === 'string' && createdAt === null) createdAt = parseTime(rec.timestamp)
    // runtime-config：{ model, ... }（模型名不在 assistant message 里）
    if (rec && rec.type === 'runtime-config' && typeof rec.model === 'string' && !model) model = rec.model
    // workspace-directories：用户选的真实项目文件夹（首行权威，后到者不覆盖）
    if (rec && rec.type === 'workspace-directories') {
      const real = realWorkspaceDir(rec.directories)
      if (real && !cwd) cwd = real
    }

    if (rec && rec.type === 'user' && rec.message) {
      const content = rec.message.content
      const blocks = Array.isArray(content) ? content : null
      const hasToolResult = blocks !== null && blocks.some((b) => b && b.type === 'tool_result')
      if (blocks !== null && hasToolResult) {
        // 工具结果：按 tool_use_id 挂到 call 所属 step（同 claude.mjs）
        for (const block of blocks) {
          if (block && block.type === 'tool_result') {
            const step = callSteps.get(block.tool_use_id)
            if (!step) { droppedToolResults++; continue }
            const inner = (Array.isArray(block.content) ? block.content : [])
              .map(mapContentBlock)
              .filter(Boolean)
            step.toolResults.push({
              toolCallId: block.tool_use_id,
              content: inner,
              isError: block.is_error === true,
            })
          }
        }
      } else {
        // 人类提问判定：humanInput.text 权威（千问真实原话）；缺失时回退 content
        // text 块拼接，但跳过 <system 开头的注入块（system-reminder/环境上下文）。
        // humanInput 存在时也以它为准——content 里常混注入块，拼接会污染提问。
        let prompt = null
        const hi = rec.humanInput
        if (hi && typeof hi === 'object' && typeof hi.text === 'string' && hi.text.trim()) {
          prompt = hi.text
        } else if (typeof content === 'string') {
          prompt = /^<system/.test(content.trim()) ? null : content
        } else if (blocks !== null) {
          const texts = blocks
            .filter((b) => b && b.type === 'text' && typeof b.text === 'string'
              && b.text.trim() && !/^<system/.test(b.text.trim()))
            .map((b) => b.text)
          if (texts.length > 0) prompt = texts.join('\n')
        }
        if (prompt !== null && prompt.trim()) {
          cur = { prompt, steps: [] }
          turns.push(cur)
        } else if (blocks !== null || typeof content === 'string') {
          skippedSystemUsers++
        } else {
          droppedUserPrompts++
        }
      }
    } else if (rec && rec.type === 'assistant' && cur) {
      // 一条 assistant 消息 = 一步（text / thinking / tool_use 同 Claude 词汇）
      const step = { content: [], toolCalls: [], toolResults: [] }
      if (Array.isArray(rec.message?.content)) {
        for (const block of rec.message.content) {
          const mapped = mapContentBlock(block)
          if (!mapped) continue
          if (mapped.type === 'tool-call') {
            step.content.push(mapped)
            step.toolCalls.push(mapped)
          } else {
            step.content.push(mapped)
          }
        }
      } else if (typeof rec.message?.content === 'string') {
        step.content.push({ type: 'text', text: rec.message.content })
      }
      cur.steps.push(step)
      for (const tc of step.toolCalls) callSteps.set(tc.id, step)
    }
  }

  // 同一步内多个结果按 call 顺序对齐（并行工具乱序返回，同 claude.mjs）
  for (const t of turns) {
    for (const s of t.steps) {
      if (s.toolResults.length < 2 || s.toolCalls.length === 0) continue
      const order = new Map(s.toolCalls.map((c, i) => [c.id, i]))
      s.toolResults.sort((a, b) => {
        const ia = order.get(a.toolCallId)
        const ib = order.get(b.toolCallId)
        return (ia === undefined ? s.toolCalls.length : ia) - (ib === undefined ? s.toolCalls.length : ib)
      })
    }
  }

  // 主 transcript 判定：千问转写文件名 = <session-uuid>.jsonl 且记录 sessionId 与之一致；
  // 不一致的是异 slug 副本/辅助转写，跳过（与 claude.mjs 同款防撞 id）
  const fileStem = typeof args.fileStem === 'string' ? args.fileStem : null
  if (fileStem && sourceId && fileStem !== sourceId) {
    return {
      meta: null, events: [], turns: [], title: null, messages: 0, toolCalls: 0,
      skipped: 0, records: recs.length, droppedToolResults: 0,
      skippedLines: [], secrets: [], permissionCount: 0,
      droppedUserPrompts: 0, skippedSystemUsers: 0,
      skipReason: 'auxiliary transcript (file "' + fileStem + '" does not match sessionId "' + sourceId + '"); only the main <sessionId>.jsonl becomes a session',
    }
  }

  const sessionId = args.sessionId || mintSessionId(sourceId)
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: createdAt ?? Date.now() }
  if (sourceId) meta.sourceId = sourceId
  // cwd = workspace-directories 里的真实项目文件夹（记录内 cwd 是千问临时工作区，
  // 不能当项目；无授权目录的纯聊天会话不落 meta.cwd）
  if (cwd) meta.cwd = cwd

  // REQ-27 标题选取：千问本地无 UI 短标题（不在本地数据中），首问即最近似物。
  // 标题 = 首轮提问兜底（humanInput 已作 prompt，语义吻合）。
  const finalTitle = normalizeTitle(turns.length > 0 ? turns[0].prompt : '')
  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, args.budget)
  const syn = synthesizeSession({ meta, turns: seedTurns, provider: 'qwen-work', model, skipped, records: recs.length, skippedLines, secrets, imported: { sourcePath: args.sourcePath } })
  const zeroTurnLoss = turns.length === 0 && droppedUserPrompts > 0
  return {
    ...syn,
    title: finalTitle,
    droppedToolResults,
    droppedUserPrompts,
    skippedSystemUsers,
    ...(zeroTurnLoss ? { skipReason: '0 轮导入：' + droppedUserPrompts + ' 条 user 消息内容无法解析（content 非字符串/数组），对话内容丢失' } : {}),
    ...(trimmed ? { trimmed } : {}),
  }
}
