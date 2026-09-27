// lib/convert/claude.mjs — Claude Code transcript JSONL → DSH 会话（纯函数）
//
// 存储契约（DSH 事件日志，见 core.mjs / events.mjs）：
//   turn          = 一条「真实提问」的 user 记录（type:'user'，content 为字符串或文本块数组）；
//   每条 assistant 记录 = 该轮的一步（step）；tool_result 按 tool_use_id 归位到 call 所在 step；
//   压缩边界（isCompactSummary / 旧 summary 记录）= 该轮之前的一次原生压缩检查点。
//
// isMeta 记录的存储契约（Claude Code 把宿主的非提问内容写成 isMeta:true 的 user 记录——
// 上下文回执、后台命令输出、图片占位、skill 正文、压缩续接提示等；实测 107 份主转录里
// 1832 条非工具结果提问中 174 条是 isMeta，超一半出现在一轮中间）：
//   * isMeta === true 的 user 记录**永不开新轮、不参与标题**（不是人类提问）；
//   * 但内容**不丢弃**：文本缓冲进 pendingMeta，在下一个 assistant 步骤开启时**前置**
//     到该步 content 开头（{type:'text',text} 块，保持源转录时间顺序的忠实）；
//   * wire 安全：meta 搭在 assistant 的 content 块**内部**，不产生独立消息，因此不会
//     插进 tool_calls 与其 tool 消息之间（配对不变量在 events.mjs 合成时按 step 闭合，
//     content 里多一个 text 块不影响任何 tool/call → tool/result 的对应与顺序）；
//   * isMeta 记录的 content 数组含 tool_result 块：结果照常按 tool_use_id 走 callSteps
//     配对，同一记录里的其余文本仍进 pendingMeta；
//   * 会话结束时的残余 pendingMeta：当前轮有步骤则追加到最后一步 content 末尾，无步骤
//     则丢弃（绝不为了承载它补一个空 prompt 假轮）；
//   * 任何真实提问之前的 isMeta 同样只缓冲，不产生空 prompt 假轮；
//   * 计数进返回字段 metaMessages（失败要大声：识别到的 isMeta 记录数）。
//
// step.model：assistant 步骤开启时写该记录 message.model（非空才写），会话级 model
// 仍取第一条 model 记录作兜底（events.mjs 里 step.model || 会话级 model）。

import {
  SESSION_FORMAT_VERSION,
  applyBudgetTrim,
  mapContentBlock,
  mintSessionId,
  parseJsonlLines,
  parseTime,
  synthesizeSession,
} from './core.mjs'
// 注入前缀表与信封剥离的唯一真相源（详见 inject.mjs 文件头）；本文件不再内联副本。
import { isInjectedTopic, stripPastedWrapper } from './inject.mjs'

// 标题归一统一规则：去首尾空白、折叠内部空白；超 80 字符截断加省略号；
// 空白返回空串。core.mjs 属禁改面，各源按文件内联同款（改规则需逐源同步，
// 现共 9 处内联：claude/codex/cursor/gemini/reasonix/grokbuild/hermes/openclaw/kimi）。
const TITLE_MAX_LEN = 80
const TITLE_ELLIPSIS = '…'
function normalizeTitle(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return ''
  return t.length <= TITLE_MAX_LEN ? t : t.slice(0, TITLE_MAX_LEN - TITLE_ELLIPSIS.length) + TITLE_ELLIPSIS
}

// 首问兜底话题：首个非注入提问。全是注入 → ''（sourced-title 落「未命名 · 日期」），
// 绝不把注入块当标题。
function firstTopicPrompt(turns) {
  for (const t of turns) {
    const p = typeof (t && t.prompt) === 'string' ? t.prompt.trim() : ''
    if (!p || isInjectedTopic(p)) continue
    return stripPastedWrapper(p) || p
  }
  return ''
}

// 失败重发 step 清洗（ghost retry 去重）：源转录里一轮工具调用没等到结果而中止时，
// Claude Code 会在紧随的下一步用同一个 tool_use id 原样重发（content 逐字节相同，
// 真实样本 39/39 验证）。两条都保留会让 DSH 日志出现重复 callId 的 tool/call 事件，
// 而会话折叠器对同一 id 只允许一次 start（“received more than one start Match”
// 硬异常），首个重复处之后的整段轨迹都会被吞掉。合成事件前做一次保守清洗，
// 规则（相邻两步、全部满足才删前一步）：
//   1) s1.content 全部是 tool-call 块（无 text/reasoning 产物）；
//   2) s1 没有挂任何 toolResults（结果从未到达 = 这一步确实失败）；
//   3) s1 的每个 callId 都在 s2 原样重发（同名同参）。
// 结果本就按 callId 配对到重发步（callSteps 覆盖写），丢弃前一步不丢任何内容。
// 已知边界：同一步内的重复 callId、非相邻步的重发（真实样本均为 0）不处理，保持原样。
function dropDeadRetrySteps(turns) {
  let dropped = 0
  for (const t of turns) {
    const steps = t.steps
    for (let i = 0; i < steps.length - 1; ) {
      const s1 = steps[i]
      const s2 = steps[i + 1]
      if (
        s1.content.length > 0 &&
        s1.content.every((b) => b.type === 'tool-call') &&
        s1.toolCalls.length > 0 &&
        s1.toolResults.length === 0 &&
        s1.toolCalls.every((c) =>
          s2.toolCalls.some((r) => r.id === c.id && r.name === c.name && r.arguments === c.arguments)
        )
      ) {
        steps.splice(i, 1)
        dropped++
        // 不 i++：删除后新的 steps[i] 仍可能与后一步构成链式重试
      } else {
        i++
      }
    }
  }
  return dropped
}

// 逐行解析 JSONL：直连人类提问（type==='user' 且 content 为字符串或纯文本块数组——
// 新版 Claude Code 对直接提问也写数组格式）开新轮；每条 assistant 消息 = 一步。
// Claude 源格式把多条连续 assistant（各带 tool_use）与后置的 tool_result 分开
// （assistant[callA] assistant[callB] user[resultA] user[resultB]）；
// tool_result 按 tool_use_id 挂到 call 所属 step（而非最近一步），保证投影出的 LLM
// 消息里每条 tool 消息紧邻其 tool_calls 的 assistant（wire 规则：中间不能插 assistant）。
export function convertClaudeJsonl(raw, args = {}) {
  // 逐行解析带行号明细（畸形行计数不设限，明细封顶 200）+ secrets 位置
  let { recs, skipped, skippedLines, secrets } = parseJsonlLines(raw)

  let sourceId = null
  let title = null          // ai-title：生成标题，取首个
  let customTitle = null    // 旧格式 summary 记录：summary / title 字段即标题，后到者胜
  let renamedTitle = null   // custom-title 记录：/rename 自定义标题，后到者胜
  let cwd = null
  let cwdHint = null
  let createdAt = null
  let model = null

  // 标题载体必须在这里（compacted 切片**之前**）一次扫完：/rename 的 custom-title 与
  // ai-title 都可能落在最后一次压缩边界之前，切片后再扫只剩尾部，标题会退化成尾部首问。
  // 载体与权威度见末尾「标题选取」注释。
  for (const rec of recs) {
    if (!rec || typeof rec !== 'object') continue
    if (rec.type === 'custom-title' && typeof rec.customTitle === 'string' && rec.customTitle.trim()) renamedTitle = rec.customTitle
    if (rec.type === 'summary') {
      const v = (typeof rec.summary === 'string' && rec.summary.trim()) ? rec.summary
        : (typeof rec.title === 'string' && rec.title.trim()) ? rec.title
        : null
      if (v !== null) customTitle = v
    }
    if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string' && !title) title = rec.aiTitle
  }

  // 上下文压缩导入为 **DSH 原生压缩检查点**（见 lib/convert/events.mjs）。压缩载体两代，
  // 每一代都是一次边界——一次会话可以压缩多次，逐次发射检查点：
  //   现代 2.x：user 记录且 isCompactSummary:true（摘要正文就在 message.content 里）；
  //   旧格式 2.0.x：type:'summary' 记录（summary 文本）。
  // 全量记录照常进日志（压缩只影响模型投影：检查点 + 检查点之后的节点），`fullHistory: true`
  // 时不发检查点。`compacted: true` 是历史参数，现在与默认行为一致（保留为兼容别名）。
  // 只有边界、没有摘要正文时不做任何标记，等于「无压缩」。
  let pendingCompaction = null

  const turns = []
  let cur = null
  // callId → 它所属的 step：Claude 的 tool_result 全部后置（在连续 assistant 之后
  // 到达），必须按 callId 挂回 call 所在 step；挂最近一步会让投影出的消息里带
  // tool_calls 的 assistant 后面紧跟另一条 assistant，违反 wire 规则
  const callSteps = new Map()
  // 丢弃的孤儿 tool_result 计数（transcript 里没有对应 tool_use）
  let droppedToolResults = 0
  // 无法解析成提问的 user 消息计数（content 既非字符串也非数组，issue #21）：
  // 0 轮 + 有丢弃时显式标注「内容丢失」，绝不静默
  let droppedUserPrompts = 0
  // permission 类记录（工具授权提示）只计数，不进入对话
  let permissionCount = 0
  // isMeta 记录计数（失败要大声）：识别到的 isMeta user 记录数量，即本轮导入从「假轮」
  // 里救回的消息数；内容去向见文件头 isMeta 契约
  let metaMessages = 0
  // isMeta 文本缓冲：非提问的宿主内容按时间顺序攒在这里，下一个 assistant 步骤开启时
  // 前置到该步 content 开头——meta 不单独成消息，就不会插进 tool_calls 与 tool 消息之间
  let pendingMeta = null

  for (const rec of recs) {
    if (rec && typeof rec.sessionId === 'string' && !sourceId) sourceId = rec.sessionId
    if (rec && typeof rec.cwd === 'string' && !cwd) cwd = rec.cwd
    if (rec && typeof rec.timestamp === 'string' && createdAt === null) createdAt = parseTime(rec.timestamp)
    if (rec && rec.type === 'ai-title' && typeof rec.aiTitle === 'string' && !title) title = rec.aiTitle
    if (rec && rec.type === 'permission') { permissionCount++ }
    const recModel = rec ? (rec.message?.model ?? rec.model) : undefined
    if (typeof recModel === 'string' && !model) model = recModel

    // 压缩边界（现代载体）：isCompactSummary 的 user 记录不是人类提问，而是压缩摘要——
    // 摘要进检查点，此前的轮全部标 log-only（它们的正文照常留在日志里）。fullHistory 时
    // 不发检查点：这条记录按普通 user 记录导入（= 改动前的既有行为，摘要正文不丢）。
    if (rec && rec.type === 'user' && rec.isCompactSummary === true && args.fullHistory !== true) {
      const text = typeof rec.message?.content === 'string'
        ? rec.message.content.trim()
        : Array.isArray(rec.message?.content)
          ? rec.message.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
          : ''
      if (text) {
        for (const t of turns) t.shadowed = true
        cur = null
        pendingCompaction = { summary: text, provider: 'claude-code', model: model || undefined }
      }
      continue
    }
    // 压缩边界（旧格式 2.0.x 载体）：summary 记录。它同时是标题载体（上面的预扫描已取）。
    if (rec && rec.type === 'summary') {
      if (args.fullHistory !== true) {
        const text = (typeof rec.summary === 'string' && rec.summary.trim()) ? rec.summary.trim()
          : (typeof rec.title === 'string' && rec.title.trim()) ? rec.title.trim()
            : ''
        if (text) {
          for (const t of turns) t.shadowed = true
          cur = null
          pendingCompaction = { summary: text, provider: 'claude-code', model: model || undefined }
        }
      }
      continue
    }

    if (rec && rec.type === 'user' && rec.message) {
      const content = rec.message.content
      const blocks = Array.isArray(content) ? content : null
      const hasToolResult = blocks !== null && blocks.some((b) => b && b.type === 'tool_result')
      // isMeta：宿主写进转录的非提问内容（上下文回执、后台命令输出、图片占位、skill
      // 正文、压缩续接提示等）。**不开新轮**（此前对任何非 tool_result 消息直接开轮，
      // 实测 174 条 isMeta 提问里超一半落在一轮中间 → 假轮把整段对话切碎），也不参与
      // 标题。内容不丢：文本进 pendingMeta，由下一个 assistant 步骤前置到 content 开头；
      // 数组里同带的 tool_result 块照常走下面的 callSteps 配对（结果不能丢）。
      if (rec.isMeta === true) {
        metaMessages++
        const metaText = typeof content === 'string'
          ? content
          : blocks !== null
            ? blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
            : ''
        if (metaText) pendingMeta = pendingMeta === null ? metaText : pendingMeta + '\n' + metaText
        if (blocks === null || !hasToolResult) continue
        // 落到下面的 tool_result 分支：只配对结果，不开轮
      }
      if (blocks !== null && hasToolResult) {
        // 工具结果：按 tool_use_id 挂到 call 所属 step。Claude 的 tool_result 在所有
        // assistant（各带 tool_use）之后到达；挂最近一步会让带 tool_calls 的 assistant
        // 后面紧跟另一条 assistant，投影出的 LLM 消息违反 wire 规则。查不到对应调用
        // （如 transcript 从中途开始）的孤儿结果直接丢弃并计数：挂 lastStep 会投影出
        // 无 call 的孤儿 tool 消息，同样被模型 API 拒绝。
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
      } else if (rec.isMeta === true) {
        // meta 记录兜住：内容已在上面收进 pendingMeta。**不开轮**——content 形态再怪
        // （缺 message.content / 对象 / 数字等）也不得在这里产生空 prompt 假轮
        continue
      } else if (typeof content === 'string' || blocks !== null) {
        // 直连人类提问 → 新轮。新版 Claude Code 对直接提问也写数组格式 content
        //（content:[{type:'text',...}]），此前这类消息落入 tool_result 分支被静默
        // 丢弃、整段对话 0 轮导入（issue #21）：纯文本块数组按文本拼接作为 prompt；
        // 含 tool_result 块的数组走上方工具结果分支，绝不在此开新轮。
        const prompt = typeof content === 'string'
          ? content
          : blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('\n')
        cur = { prompt, steps: [] }
        if (pendingCompaction) {
          cur.compaction = pendingCompaction
          pendingCompaction = null
        }
        turns.push(cur)
      } else {
        // content 既非字符串也非数组（缺失 / 对象 / 数字等）：无法解析为提问
        droppedUserPrompts++
      }
    } else if (rec && rec.type === 'assistant' && cur) {
      // 一条 assistant 消息 = 一步
      const step = { content: [], toolCalls: [], toolResults: [] }
      // step.model：该步自己的 message.model（非空才写）。中途换模型（/model 切换）
      // 时各步各自记名，events.mjs 以 step.model 优先、会话级 model 兜底
      if (typeof rec.message?.model === 'string' && rec.message.model) step.model = rec.message.model
      // 上一个 meta 缓冲前置到本步 content 开头（时间顺序忠实：meta 在源转录里出现于
      // 本 assistant 之前）。插入点是 content 头部而非消息之间，tool_calls 与 tool 消息
      // 的相对顺序不受影响
      if (pendingMeta !== null) {
        step.content.push({ type: 'text', text: pendingMeta })
        pendingMeta = null
      }
      if (Array.isArray(rec.message?.content)) {
        for (const block of rec.message.content) {
          const mapped = mapContentBlock(block)
          if (!mapped) continue
          if (mapped.type === 'tool-call') {
            step.content.push(mapped)   // 助手内容里的 tool-call block
            step.toolCalls.push(mapped) // 同时作为 tool/call 事件
          } else {
            step.content.push(mapped)   // text / reasoning block
          }
        }
      } else if (typeof rec.message?.content === 'string') {
        step.content.push({ type: 'text', text: rec.message.content })
      }
      cur.steps.push(step)
      for (const tc of step.toolCalls) callSteps.set(tc.id, step)
    }
  }

  // 同一步内多个结果按 call 顺序对齐：Claude 的 tool_result 块可能乱序返回
  // （并行工具），按该 step 的 toolCalls 顺序稳定排序，保证投影出的 tool 消息
  // 与 assistant 的 tool_calls 一一对应、顺序一致。
  const droppedRetrySteps = dropDeadRetrySteps(turns)
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

  // 只有主 transcript（文件名 = <sessionId>.jsonl）是独立会话。Claude Code 项目目录里
  // `<sessionId>/subagents/**` 的辅助 transcript（agent-*.jsonl 等）记录携带父 sessionId，
  // 若按它建会话会与主 transcript 撞 id：先扫描到的文件占会话、主内容被幂等跳过而丢失。
  // 文件名与记录 sessionId 不一致的一律跳过并给原因（单文件/目录模式一致）。
  const fileStem = typeof args.fileStem === 'string' ? args.fileStem : null
  if (fileStem && sourceId && fileStem !== sourceId) {
    return {
      meta: null, events: [], turns: [], title: null, messages: 0, toolCalls: 0,
      skipped: 0, records: recs.length, droppedToolResults: 0,
      skippedLines: [], secrets: [], permissionCount: 0, metaMessages: 0,
      droppedUserPrompts: 0,
      skipReason: 'auxiliary transcript (file "' + fileStem + '" does not match sessionId "' + sourceId + '"); only the main <sessionId>.jsonl becomes a session',
    }
  }

  const sessionId = args.sessionId || mintSessionId(sourceId)
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: createdAt ?? Date.now() }
  if (sourceId) meta.sourceId = sourceId
  // 转录无 cwd 记录时输出 cwdHint（会话目录名 = Claude 项目 slug，含 '--'
  // 分隔标记才提示），index 层经 ~/.claude.json 权威映射 / slug 解码回填 meta.cwd
  if (!cwd && typeof args.sourcePath === 'string' && args.sourcePath.includes('--')) {
    const dirSegs = String(args.sourcePath).replace(/[\\/]+$/, '').split(/[\\/]/)
    const slugDir = dirSegs[dirSegs.length - 2] || ''
    if (slugDir.includes('--')) cwdHint = slugDir
  }
  if (cwd) meta.cwd = cwd

  // 会话结束时的残余 meta：当前轮还有步骤就追加到最后一步 content 末尾（不建新步、
  // 不建新轮）；没有步骤承载则丢弃——绝不为了装一条 meta 补空 prompt 假轮。
  if (pendingMeta !== null) {
    const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null
    if (lastTurn && lastTurn.steps.length > 0) {
      lastTurn.steps[lastTurn.steps.length - 1].content.push({ type: 'text', text: pendingMeta })
    }
    pendingMeta = null
  }

  // 待落检查点若没等到新轮（会话正好停在压缩点）：用空 prompt 轮兜住，否则边界无处发射。
  if (pendingCompaction) {
    cur = { prompt: '', steps: [], compaction: pendingCompaction }
    pendingCompaction = null
    turns.push(cur)
  }

  // 标题选取（载体已在全量记录上扫完）——权威度三代，实测本机 178 份真实转录 / 152,795 行：
  //   1) custom-title.customTitle —— 用户 /rename 的自定义标题（现代 2.x，2668 条）。
  //      **后到者胜**：重命名与分叉都在尾部追加新记录，最近一次 = 当前标题
  //      （实测 25 个带自定义标题的会话里，2 个有多个不同值）。
  //   2) summary.summary / summary.title —— 2.0.x 旧格式的首行记录，summary 字段即
  //      生成标题（旧格式里没有 custom-title/ai-title，三代不会同时出现）。
  //   3) ai-title.aiTitle —— 生成标题（4115 条），**取首个**：ai-title 会逐轮改写，
  //      实测 62 个带 ai-title 的会话里 3 个尾部被 worktree 名覆盖，首个才是会话标题。
  // 显式标题（归一后非空）钉 session/title 事件；纯首问兜底只回填 out.title——DSH 对
  // 无标题事件会话自动回退首条 user 文本（core.mjs「钉住，避免自动回退标题覆盖」），
  // 钉住结果相同且不改变既有事件契约。
  const explicitTitle = renamedTitle || customTitle || (title && title.trim() ? title : null)
  const finalTitle = normalizeTitle(explicitTitle || firstTopicPrompt(turns))
  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, args.budget)
  const syn = synthesizeSession({ meta, turns: seedTurns, title: explicitTitle ? finalTitle : undefined, provider: 'claude-code', model, skipped, records: recs.length, skippedLines, secrets, permissionCount, imported: { sourcePath: args.sourcePath } })
  // issue #21：有无法解析的 user 消息且零轮 → 显式标注「0 轮 / 内容丢失」，
  // 让导入层按 skipped 报告（而非静默空会话 / 静默成功）
  const zeroTurnLoss = turns.length === 0 && droppedUserPrompts > 0
  return {
    ...syn,
    title: finalTitle,
    droppedToolResults,
    droppedRetrySteps,
    droppedUserPrompts,
    // isMeta 记录数（>0 才占键）：本文件识别并救回的非提问 user 记录数，>0 即说明
    // 该转录里有宿主注入内容（不再被误当提问开轮）
    ...(metaMessages > 0 ? { metaMessages } : {}),
    ...(zeroTurnLoss ? { skipReason: '0 轮导入：' + droppedUserPrompts + ' 条 user 消息内容无法解析（content 非字符串/数组），对话内容丢失' } : {}),
    ...(cwdHint ? { cwdHint } : {}),
    // compacted 由合成层的事实决定：syn.compactions 是实际发射的原生检查点数
    ...(syn.compactions ? { compacted: true } : {}),
    ...(trimmed ? { trimmed } : {}),
  }
}
