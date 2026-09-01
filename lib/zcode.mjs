// lib/zcode.mjs — zcode（z.ai 官方 CLI）SQLite 历史库读取与导入编排（REQ-38）
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
//
// runDecision / markTrimmedSource 是 claude/chatgpt 等路径共用的共享函数
// （lib/import-core.mjs / lib/budget.mjs，非 zcode 专属），由 lib/tools.mjs 注册工具
// 时经 options 注入（与 importOpencodeFile 同款，见 lib/opencode.mjs 文件头）。
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { convertZcodeJson } from '../convert.mjs'
import { loadImports, unwrapRecord, listPersistedIds, archivedSessionIds, argsFingerprint, decideMulti } from './imports.mjs'

// zcode 默认数据库路径：~/.zcode/cli/db/db.sqlite。
export function zcodeDefaultDbPath(home = homedir()) {
  return join(home, '.zcode', 'cli', 'db', 'db.sqlite')
}

// zcode 历史库（SQLite）→ 中间会话 JSON 数组。
// 只读打开 db.sqlite，查 session/message/part 三表（data 是 JSON 文本）；主会话
// 过滤（parent_id IS NULL 或 ''）；message / part 无 sequence 列，按
// (time_created, id) 升序重建消息流。compaction part 的 data.summary.body 抽到
// 会话级 summary（最后一条压缩记录胜出），压缩正文不进入对话。
export function readZcodeDb(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const sessions = []
    const sessionRows = db.prepare(
      "SELECT id, title, directory, time_updated FROM session WHERE parent_id IS NULL OR parent_id = '' ORDER BY time_updated, id"
    ).all()
    for (const row of sessionRows) {
      const messages = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(row.id)
      const msgs = []
      let summary
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
        for (const p of db.prepare('SELECT id, time_created, data FROM part WHERE message_id = ? ORDER BY time_created, id').all(m.id)) {
          let part
          try {
            part = JSON.parse(p.data)
          } catch {
            // 个别 part data 非 JSON（脏数据）→ 跳过该 part
            continue
          }
          if (part && part.type === 'compaction') {
            // 压缩摘要还原为会话级 summary（最后一条压缩记录胜出）；正文不进入对话
            const body = part.summary && typeof part.summary.body === 'string' ? part.summary.body : undefined
            if (body && body.trim()) summary = body.trim()
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
        systemPrompt,
        messages: msgs,
      })
    }
    return sessions
  } finally {
    db.close()
  }
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

// zcode 单库导入：DB 内每个会话独立落盘（zcode://<id> 伪路径 / sessionIds 过滤），
// 恒返回批量形态。REQ-24：DB 级 version/size 短路径检测；逐会话判增 append /
// compaction 使轮次变少 → sourceShrunk。sourcePath 为 db.sqlite 路径（目录模式定位
// 后同样落到 db 文件；zcode:// 伪路径以原始字符串为幂等键，fs.resolve 会归一化掉
// '://' 前缀，不能当键）。runDecision / markTrimmedSource 由 index.mjs 注入。
export async function importZcodeFile(ctx, target, args, { registryDir, persisted, runDecision, markTrimmedSource } = {}) {
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  const archivedIds = archivedSessionIds(ctx)
  const rawPath = typeof args.path === 'string' ? args.path : ''
  const isPseudo = rawPath.startsWith('zcode://')
  const path = isPseudo ? rawPath : (target.displayPath || ctx.fs.processPath(target))
  const stat = await ctx.fs.stat(target)
  const registry = await loadImports(registryDir)
  let known = unwrapRecord(registry.imports[path])
  if (known && known.kind !== 'multi') known = null
  const fingerprint = argsFingerprint(args, [])

  // S3 短路径（不重读 SQLite）。仅当记录里所有会话仍存在且未被归档时短路径才成立
  // （会话被删 / DSH_HOME 迁移 / 被归档 → 走全量重导）
  if (known && (!known.sessions || typeof known.sessions !== 'object')) known = null
  if (known && args.force !== true) {
    const subs = Object.values(known.sessions)
    const allPersisted = subs.length > 0 && subs.every((sub) => persistedSet.has(sub.dshId) && !archivedIds.has(sub.dshId))
    if (allPersisted) {
      const skipResults = () => Object.entries(known.sessions).map(([, sub]) => ({
        path, status: 'already-imported', sessionId: sub.dshId, turns: sub.turns, messages: 0, toolCalls: 0, skipped: 0,
      }))
      if (typeof known.args === 'string' && fingerprint !== known.args) {
        const results = skipResults().map((r) => ({ ...r, argsChanged: true }))
        return { total: results.length, imported: 0, alreadyImported: results.length, appended: 0, skipped: 0, failed: 0, results }
      }
      // REQ-37：预算变化 → 跳过并上报 budgetChanged（同 argsChanged 语义）
      if (typeof known.budget === 'number' && known.budget !== args.budget) {
        const results = skipResults().map((r) => ({ ...r, budgetChanged: true }))
        return { total: results.length, imported: 0, alreadyImported: results.length, appended: 0, skipped: 0, failed: 0, results }
      }
      if (stat && stat.version === known.version && stat.size === known.sizeBytes) {
        const count = Object.keys(known.sessions).length
        return { total: count, imported: 0, alreadyImported: count, appended: 0, skipped: 0, failed: 0, results: skipResults() }
      }
    }
  }

  // 目标会话：zcode://<id> 伪路径 → 默认库按 id 过滤（deriveArgs 已传 zcodeId，
  // 此处兜底从原始 args.path 再取一次——fs.resolve 归一化后 displayPath 不保留前缀）
  const zcodeId = typeof args.zcodeId === 'string' && args.zcodeId
    ? args.zcodeId
    : isPseudo ? rawPath.slice('zcode://'.length) : undefined
  const sessions = readZcodeTarget(isPseudo ? zcodeDefaultDbPath() : path)
  const wanted = zcodeId ? new Set([zcodeId])
    : (Array.isArray(args.sessionIds) && args.sessionIds.length > 0 ? new Set(args.sessionIds) : null)
  const items = []
  const preSkipped = []
  if (zcodeId && !sessions.some((s) => s.id === zcodeId)) {
    preSkipped.push({ path, status: 'skipped', reason: 'zcode 会话不存在: ' + zcodeId })
  }
  for (const s of sessions) {
    if (wanted && !wanted.has(s.id)) continue
    const out = markTrimmedSource(convertZcodeJson(JSON.stringify(s), { ...args, sourcePath: path }), args)
    if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
      preSkipped.push({ path, status: 'skipped', reason: 'no user turns (session ' + s.id + ')' })
      continue
    }
    items.push({ key: s.id, converted: out })
  }
  const decision = await decideMulti(ctx, { known, items, stat, args, fingerprint, persisted: persistedSet, sourcePath: path, subTable: 'sessions', budget: args.budget, archivedIds, importFormat: 'zcode' })
  const missing = known && known.sessions ? Object.keys(known.sessions).filter((k) => !sessions.some((s) => s.id === k)) : []
  const result = await runDecision(ctx, decision, registryDir, path, persistedSet, { workspaceMode: args.workspaceMode, workspaceDir: args.workspaceDir })
  return {
    ...result,
    total: sessions.length,
    skipped: result.skipped + preSkipped.length,
    results: [...preSkipped, ...result.results],
    ...(missing.length ? { missingFromSource: missing } : {}),
  }
}

// zcode 目录导入：目录里定位 db.sqlite（无递归），再走单库导入；缺 DB 时抛错。
export async function importZcodeDirectory(ctx, dirTarget, args, { registryDir, persisted, runDecision, markTrimmedSource } = {}) {
  const dirPath = dirTarget.displayPath || ctx.fs.processPath(dirTarget)
  const dbPath = join(dirPath, 'db.sqlite')
  const dbTarget = await ctx.fs.resolve(dbPath)
  return importZcodeFile(ctx, dbTarget, args, { registryDir, persisted, runDecision, markTrimmedSource })
}

// 目标解析：.jsonl 后缀 → 旧格式 transcript 回退；其余按 db.sqlite 读。
function readZcodeTarget(path) {
  if (typeof path === 'string' && /\.jsonl$/i.test(path)) {
    return readZcodeTranscript(path)
  }
  return readZcodeDb(path)
}

// zcode 系统提示词 content → 纯文本（字符串原样；数组取 text 块拼接；其余空串）。
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

// 旧格式工具结果文本：字符串原样；块数组取 text 拼接；对象序列化；缺失空串。
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
