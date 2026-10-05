// lib/sources/zcode.mjs — zcode（z.ai 官方 CLI）SQLite 历史库读取与导入编排
//
// zcode 会话存于 ~/.zcode/cli/db/db.sqlite（SQLite 权威索引）+ 旧版 transcript.jsonl
// 回退。readZcodeDb 只读抽取 session/message/part 三表为中间会话 JSON 数组（对齐
// readOpencodeDb 形态）：message / part 无 sequence 列，按 (time_created, id) 升序
// 重建消息流；只取主会话（parent_id IS NULL 或 ''）；compaction part
// （type === 'compaction'）的 data.summary.body 是 zcode 压缩出的上下文摘要，还原为
// 会话级 summary（消息级 data.summary.body 兜底），压缩正文不进入对话。
// readZcodeTranscript 在 db 不可用时回退读旧格式 transcript.jsonl（取最后一个
// model_request 的 payload.messages，工具结果回填到对应 tool part 的 state.output，
// 与 db 形态对齐、同一转换器消费）。importZcodeFile 把 db 内每个会话独立落盘
// （zcode://<id> 伪路径 / sessionIds 过滤、DB 指纹短路径、逐会话 append），恒返回
// 批量形态；importZcodeDirectory 在目录里定位 db.sqlite（无递归）后走单库导入。
// 多会话源的共享编排（registry 短路径 / 逐会话转换 / 决策落盘 / 预览）在
// lib/import-core.mjs，本文件只给出 zcode 的读取器、目标解析与转换参数。
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { convertZcodeJson } from '../convert/index.mjs'
import { withReadOnlyDb, hasTable, resolveDbInDirectory } from './sqlite.mjs'
import { sessionSelection } from '../import-state.mjs'
import { importMultiSource, convertSessionItems, previewSessionSet, selectionSet } from '../import-core.mjs'

// zcode 默认数据库路径：~/.zcode/cli/db/db.sqlite。
export function zcodeDefaultDbPath(home = homedir()) {
  return join(home, '.zcode', 'cli', 'db', 'db.sqlite')
}

// zcode 库 → 会话级摘要（发现层用）：只查 session 表 + 每会话 MAX(message.time_created)，
// 不读 message/part 正文（compaction 摘要与正文还原只在导入路径 readZcodeDb 做）。
// createdAt 取 session.time_updated（与全量读取器一致）；lastActiveAt 取最近一条消息的
// time_created，无消息回退 session.time_updated——保持发现层「最近活跃」排序语义。
export function readZcodeDbSummaries(dbPath) {
  return withReadOnlyDb(dbPath, (db) => {
    // 缺 message 表（极简/降级形态）时不做「最近消息」聚合，lastActiveAt 回落 session 行时间
    const hasMessage = hasTable(db, 'message')
    const rows = db.prepare(
      'SELECT s.id, s.title, s.directory, s.time_updated AS updatedAt' +
      (hasMessage ? ', (SELECT MAX(m.time_created) FROM message m WHERE m.session_id = s.id) AS lastMsg' : '') +
      " FROM session s WHERE s.parent_id IS NULL OR s.parent_id = '' " +
      'ORDER BY s.time_updated, s.id'
    ).all()
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      directory: row.directory,
      createdAt: row.updatedAt,
      lastActiveAt: row.lastMsg ?? row.updatedAt,
    }))
  })
}

// zcode 历史库（SQLite）→ 中间会话 JSON 数组。
// 只读打开 db.sqlite，查 session/message/part 三表（data 是 JSON 文本）；主会话
// 过滤（parent_id IS NULL 或 ''）；message / part 无 sequence 列，按
// (time_created, id) 升序重建消息流。compaction part 的 data.summary.body 抽到
// 会话级 summary（最后一条压缩记录胜出），压缩正文不进入对话。
export function readZcodeDb(dbPath) {
  return withReadOnlyDb(dbPath, (db) => {
    const sessions = []
    const sessionRows = db.prepare(
      "SELECT id, title, directory, time_updated FROM session WHERE parent_id IS NULL OR parent_id = '' ORDER BY time_updated, id"
    ).all()
    // 逐会话 / 逐消息的查询整库各 prepare 一次（大库里消息数上万，逐条 prepare 是读库热点）；
    // 无会话时不 prepare（极简库可能缺 message/part 表，空库照旧返回空数组）
    if (sessionRows.length === 0) return sessions
    const messagesOf = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id')
    const partsOf = db.prepare('SELECT id, time_created, data FROM part WHERE message_id = ? ORDER BY time_created, id')
    for (const row of sessionRows) {
      const messages = messagesOf.all(row.id)
      const msgs = []
      let summary
      // 压缩边界（compaction part 的 compactBoundary）：{ summary, keptMessageCount,
      // summarizedMessageCount, carrierMessageId }，转换器据此发射原生压缩检查点
      //（保留窗口起点 = 边界；缺 compactBoundary 时转换器退回摘要 reasoning 块）。
      let compaction
      let systemPrompt
      for (const m of messages) {
        let data
        try {
          data = JSON.parse(m.data)
        } catch {
          // 个别消息 data 非 JSON（脏数据）→ 跳过该消息，不静默吞畸形
          continue
        }
        if (data.role === 'system') {
          // 系统提示词：默认不进对话；开关开启时作为上下文注入保留（收集到 systemPrompt）
          const text = zcodeContentText(data.content)
          if (text) systemPrompt = systemPrompt ? systemPrompt + '\n\n' + text : text
          continue
        }
        if (data.role !== 'user' && data.role !== 'assistant') continue
        // 摘要兜底：摘要挂在消息级 data.summary.body（compaction part 无 summary 时）。
        // 摘要消息是压缩标记（正文只是引导语），整条不进入对话，与 compaction part 同语义。
        if (data.summary && typeof data.summary.body === 'string' && data.summary.body.trim()) {
          if (!summary) summary = data.summary.body.trim()
          continue
        }
        const parts = []
        for (const p of partsOf.all(m.id)) {
          let part
          try {
            part = JSON.parse(p.data)
          } catch {
            // 个别 part data 非 JSON（脏数据）→ 跳过该 part
            continue
          }
          if (part && part.type === 'compaction') {
            // 压缩摘要还原为会话级 summary（最后一条压缩记录胜出）；正文不进入对话。
            // compactBoundary 的 keptMessageCount 一并带上：它是「边界之前保留几条消息」的
            // 事实，转换器用它定位原生压缩检查点的位置。
            const body = part.summary && typeof part.summary.body === 'string' ? part.summary.body : undefined
            if (body && body.trim()) {
              summary = body.trim()
              const cb = part.compactBoundary && typeof part.compactBoundary === 'object' ? part.compactBoundary : {}
              compaction = {
                summary: body.trim(),
                carrierMessageId: m.id,
                ...(Number.isInteger(cb.keptMessageCount) ? { keptMessageCount: cb.keptMessageCount } : {}),
                ...(Number.isInteger(cb.summarizedMessageCount) ? { summarizedMessageCount: cb.summarizedMessageCount } : {}),
              }
            }
            continue
          }
          parts.push(part)
        }
        msgs.push({
          id: m.id,
          role: data.role,
          createdAt: m.time_created,
          model: typeof data.modelID === 'string' ? data.modelID : undefined,
          parts,
        })
      }
      sessions.push({
        id: row.id,
        title: row.title,
        directory: row.directory,
        createdAt: row.time_updated,
        summary,
        ...(compaction ? { compaction } : {}),
        systemPrompt,
        messages: msgs,
      })
    }
    return sessions
  })
}

// 旧版 transcript.jsonl（db 不可用回退）→ 中间会话 JSON 数组（单会话）。
// 旧格式：逐行 JSON 记录，取最后一个 model_request 的 payload.messages（OpenAI
// 风格 user/assistant/tool 消息）。工具结果（role=tool 消息 / user content 块内
// tool_result）回填到对应 tool part 的 state.output，保持 tool/call + tool/result
// 成对；同目录 <stem>.metadata.json 的 cwd 作为会话目录。会话 id 取所在目录名
//（旧布局一个会话一个 transcript 目录），幂等键仍以源文件路径为准。
export function readZcodeTranscript(filePath) {
  let cwd
  const metaPath = String(filePath).replace(/transcript\.jsonl$/i, 'metadata.json')
  if (metaPath !== filePath && existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
      if (meta && typeof meta.cwd === 'string' && meta.cwd) cwd = meta.cwd
    } catch {
      // metadata.json 缺失/损坏不致命：仍按 transcript 导入，仅无 cwd
    }
  }

  let lastMessages = []
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      // 畸形行跳过（旧格式不做行级上报，仅跳过）
      continue
    }
    if (record && record.type === 'model_request' && Array.isArray(record.payload && record.payload.messages)) {
      lastMessages = record.payload.messages
    }
  }

  const messages = []
  const pendingTools = new Map() // callId → tool part（结果回填目标）
  let systemPrompt
  for (const msg of lastMessages) {
    if (!msg || typeof msg !== 'object') continue
    const role = msg.role
    if (role === 'system') {
      const text = zcodeContentText(msg.content)
      if (text) systemPrompt = systemPrompt ? systemPrompt + '\n\n' + text : text
      continue
    }
    if (role === 'tool') {
      // 工具结果：回填到对应 tool part 的 state.output（孤儿结果丢弃）
      const callId = msg.tool_call_id
      if (typeof callId === 'string' && pendingTools.has(callId)) {
        const entry = pendingTools.get(callId)
        entry.state.output = transcriptOutputText(msg.content)
        if (msg.is_error === true || msg.status === 'error' || msg.status === 'failed') entry.state.status = 'error'
        pendingTools.delete(callId)
      }
      continue
    }
    if (role !== 'user' && role !== 'assistant') continue
    const parts = []
    const content = msg.content
    if (typeof content === 'string') {
      if (content) parts.push({ type: 'text', text: content })
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        if (block.type === 'tool_result' || block.type === 'tool-result') {
          // Claude 风格内容块工具结果：同样回填 pending tool part
          const callId = block.tool_call_id ?? block.toolCallId
          if (typeof callId === 'string' && pendingTools.has(callId)) {
            const entry = pendingTools.get(callId)
            entry.state.output = transcriptOutputText(block.content ?? block.output ?? '')
            if (block.is_error === true) entry.state.status = 'error'
            pendingTools.delete(callId)
          }
          continue
        }
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          parts.push({ type: 'text', text: block.text })
        } else if (block.type === 'image') {
          parts.push({ type: 'file', filename: 'image' })
        }
      }
    }
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (!tc || typeof tc !== 'object') continue
        const callId = String(tc.id || 't-' + parts.length)
        const fn = tc.function && typeof tc.function === 'object' ? tc.function : {}
        const part = {
          type: 'tool',
          tool: typeof fn.name === 'string' && fn.name ? fn.name : 'tool',
          callID: callId,
          state: { input: transcriptToolInput(fn.arguments) },
        }
        parts.push(part)
        pendingTools.set(callId, part)
      }
    }
    messages.push({
      id: undefined,
      role,
      createdAt: undefined,
      model: typeof msg.model === 'string' ? msg.model : undefined,
      parts,
    })
  }

  const id = basename(dirname(filePath)) || basename(filePath)
  return [{
    id,
    title: undefined,
    directory: cwd,
    createdAt: undefined,
    summary: undefined,
    systemPrompt,
    messages,
  }]
}

// zcode 导入目标：幂等键 path（zcode://<id> 伪路径以原始字符串为键——fs.resolve 会归一化
// 掉 '://' 前缀，不能当键）、按 id 选定的会话（args.zcodeId 优先，伪路径兜底；deriveArgs 已传
// zcodeId，这里从原始 args.path 再取一次）、实际读取的库路径（伪路径 → 默认库）。
function zcodeTarget(ctx, target, args) {
  const rawPath = typeof args.path === 'string' ? args.path : ''
  const isPseudo = rawPath.startsWith('zcode://')
  const path = isPseudo ? rawPath : (target.displayPath || ctx.fs.processPath(target))
  const zcodeId = typeof args.zcodeId === 'string' && args.zcodeId
    ? args.zcodeId
    : isPseudo ? rawPath.slice('zcode://'.length) : undefined
  return { path, zcodeId, readPath: isPseudo ? zcodeDefaultDbPath() : path }
}

// 读取目标：.jsonl 后缀 → 旧格式 transcript 回退；其余按 db.sqlite 读。
function readZcodeTarget(path) {
  if (typeof path === 'string' && /\.jsonl$/i.test(path)) {
    return readZcodeTranscript(path)
  }
  return readZcodeDb(path)
}

const zcodeMissing = (zcodeId) => 'zcode 会话不存在: ' + zcodeId

// zcode 单库导入：DB 内每个会话独立落盘（zcode://<id> 伪路径 / sessionIds 过滤），恒返回
// 批量形态。「源未变」短路径看库指纹 + WAL 边车签名 + 选择守卫（按 id 选择性重导时新选中的
// 会话不在子表里 → 不跳过）；逐会话判增 append / compaction 使轮次变少 → sourceShrunk。
// options 里的其它键不消费。
export async function importZcodeFile(ctx, target, args, { registryDir, persisted, fingerprintKeys = [] } = {}) {
  const { path, zcodeId, readPath } = zcodeTarget(ctx, target, args)
  const selection = zcodeId ? [zcodeId] : sessionSelection(args)
  return importMultiSource(ctx, target, args, {
    sourcePath: path, registryDir, persisted, fingerprintKeys, sqlite: true, selection, importFormat: 'zcode',
    load: async () => {
      const sessions = readZcodeTarget(readPath)
      const converted = await convertSessionItems(ctx, sessions, {
        path, args, wanted: selectionSet(selection), sourceLabel: 'zcode',
        convertOne: (s) => convertZcodeJson(JSON.stringify(s), { ...args, sourcePath: path }),
      })
      // 指定的会话不在库里：显式上报（不静默导出一个空批）
      if (zcodeId && !sessions.some((s) => s.id === zcodeId)) {
        converted.preSkipped.unshift({ path, status: 'skipped', reason: zcodeMissing(zcodeId) })
      }
      return converted
    },
  })
}

// zcode 目录导入：目录里定位 db.sqlite（无递归），再走单库导入；缺 DB 时抛错。
export async function importZcodeDirectory(ctx, dirTarget, args, options = {}) {
  return importZcodeFile(ctx, await resolveDbInDirectory(ctx, dirTarget, 'db.sqlite'), args, options)
}

// zcode 系统提示词 content → 纯文本（字符串原样；数组取 text 块拼接；其余空串）。数组里还可能
// 直接是字符串项、结果要 trim——lib/convert/util.mjs 的 contentText 只收对象块，故不共用。
function zcodeContentText(content) {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content.map((b) => {
      if (typeof b === 'string') return b
      if (b && typeof b === 'object' && typeof b.text === 'string') return b.text
      return ''
    }).join('\n').trim()
  }
  return ''
}

// 旧格式工具结果文本：字符串原样；块数组取 text 拼接（字符串项原样）；对象序列化；缺失空串。
// 对象整体序列化、字符串项保留是工具结果特有的口径，contentText 不覆盖。
function transcriptOutputText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((b) => {
      if (typeof b === 'string') return b
      if (b && typeof b === 'object' && typeof b.text === 'string') return b.text
      return ''
    }).join('\n')
  }
  if (content === undefined || content === null) return ''
  return JSON.stringify(content)
}

// 旧格式工具参数：对象原样；JSON 字符串解析；非 JSON 字符串原样保留
//（转换器 JSON.stringify(state.input) 时不会丢信息）。
function transcriptToolInput(raw) {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'string') return raw
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

// ── dry-run 预览（与正式导入同源的只读重演：绕开 registry / decideMulti / 落盘，零副作用）──

// zcode 预览：db.sqlite / transcript.jsonl 回退 / zcode://<id> 伪路径，与 importZcodeFile
// 同一套目标解析与选择。
export async function previewZcodeFile(ctx, target, args) {
  const { path, zcodeId, readPath } = zcodeTarget(ctx, target, args)
  const sessions = readZcodeTarget(readPath)
  const results = previewSessionSet(sessions, {
    path, args, wanted: selectionSet(zcodeId ? [zcodeId] : sessionSelection(args)),
    convertOne: (s) => convertZcodeJson(JSON.stringify(s), { ...args, sourcePath: path }),
  })
  if (zcodeId && !sessions.some((s) => s.id === zcodeId)) {
    results.unshift({ path, skipped: 1, skipReason: zcodeMissing(zcodeId) })
  }
  return { total: sessions.length, results }
}

export async function previewZcodeDirectory(ctx, dirTarget, args) {
  return previewZcodeFile(ctx, await resolveDbInDirectory(ctx, dirTarget, 'db.sqlite'), args)
}
