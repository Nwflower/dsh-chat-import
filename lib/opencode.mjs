// lib/opencode.mjs — opencode SQLite 历史库读取与导入编排（REQ-08 拆分自 index.mjs）
//
// opencode 的 transcript 不经 JSONL/JSON：直接只读 SQLite 库（默认
// ~/.local/share/opencode/opencode.db）。readOpencodeDb 抽取 session/message/part
// 三表为中间会话 JSON 数组（尊重 compaction，可选 fullHistory）；importOpencodeFile
// 把 DB 内每个会话独立落盘（sessionIds 过滤、DB 指纹短路径、逐会话 append），恒返回
// 批量形态；importOpencodeDirectory 在目录里定位 opencode.db（无递归）后走单库导入。
//
// 纯机械拆分（零行为变化）：runDecision / markTrimmedSource 是 claude/chatgpt 等路径
// 共用的共享函数（lib/import-core.mjs / lib/budget.mjs，非 opencode 专属），由
// lib/tools.mjs 注册工具时经 options 注入（importOpencodeFile /
// importOpencodeDirectory 的最后一个参数）。
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { convertOpencodeJson } from '../convert.mjs'
import { loadImports, unwrapRecord, listPersistedIds, archivedSessionIds, argsFingerprint, decideMulti } from './imports.mjs'

// opencode 历史库（SQLite）→ 中间会话 JSON 数组。
// 只读打开 opencode.db，查 session/message/part 三表（data 是 JSON 文本）；
// message 按 (time_created, id) 升序、part 同。session.model 是 JSON 字符串
// （{id, providerID, variant}），解析取 id 作为会话级模型回退。
// 默认尊重 opencode 的对话压缩（compaction）：只保留最后一次压缩的摘要（summary）
// 与 tail_start_id 之后的尾巴，被压掉的前段历史折叠成摘要；options.fullHistory
// 为 true 时跳过压缩、返回全量。读不到 DB（路径不存在 / 非 SQLite）时抛错，失败大声。
export function readOpencodeDb(dbPath, options = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    // mimocode（opencode fork）的 session 表没有 model 列：按表结构探测决定是否
    // SELECT model，兼容两种 schema（opencode 有 model 列、mimocode 无）。
    const sessionCols = new Set(db.prepare('PRAGMA table_info(session)').all().map((c) => c.name))
    const sessionSelect = sessionCols.has('model')
      ? 'SELECT id, title, directory, time_created, model FROM session ORDER BY time_created, id'
      : 'SELECT id, title, directory, time_created FROM session ORDER BY time_created, id'
    const sessions = []
    const sessionRows = db.prepare(sessionSelect).all()
    for (const row of sessionRows) {
      const messages = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(row.id)
      const partsByMessage = new Map()
      for (const p of db.prepare('SELECT message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created, id').all(row.id)) {
        if (!partsByMessage.has(p.message_id)) partsByMessage.set(p.message_id, [])
        partsByMessage.get(p.message_id).push(JSON.parse(p.data))
      }
      const msgs = messages.map((m) => {
        const data = JSON.parse(m.data)
        const path = data.path && typeof data.path === 'object' ? data.path : {}
        return {
          id: m.id,
          role: data.role,
          createdAt: m.time_created,
          cwd: typeof path.cwd === 'string' ? path.cwd : undefined,
          // mimocode 后台任务会话（checkpoint-writer / dream / distill）经 agent 识别，
          // 供 isMimocodeBackgroundSession 过滤（opencode 路径忽略该字段）。
          agent: typeof data.agent === 'string' ? data.agent : undefined,
          model: typeof data.modelID === 'string' ? data.modelID
            : data.model && typeof data.model === 'object' && typeof data.model.modelID === 'string' ? data.model.modelID
              : undefined,
          parts: partsByMessage.get(m.id) || [],
          isSummary: data.mode === 'compaction' || data.summary === true,
        }
      })
      // 尊重 opencode 的对话压缩（compaction）：默认只保留「最后一次压缩摘要 + 尾巴」，
      // 把被压掉的前段历史折叠成摘要，避免 resume 把全量历史灌进上下文；
      // fullHistory 为 true 时跳过压缩、导入全量。
      let summary
      let exportMsgs = msgs
      if (!options.fullHistory) {
        let lastTailStart = null
        let lastSummaryText = null
        for (const m of msgs) {
          for (const p of m.parts) {
            if (p && p.type === 'compaction' && typeof p.tail_start_id === 'string') lastTailStart = p.tail_start_id
          }
          if (m.isSummary) {
            const text = m.parts.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n').trim()
            if (text) lastSummaryText = text
          }
        }
        if (lastTailStart) {
          const tailIdx = msgs.findIndex((m) => m.id === lastTailStart)
          if (tailIdx >= 0) {
            exportMsgs = msgs.slice(tailIdx).filter((m) => !m.isSummary)
            summary = lastSummaryText || undefined
          }
        }
      }
      const session = {
        id: row.id,
        title: row.title,
        directory: row.directory,
        createdAt: row.time_created,
        model: parseOpencodeSessionModel(row.model),
        summary,
        messages: exportMsgs.map(({ isSummary, ...rest }) => rest),
      }
      // options.filter（剔除谓词——返回 true 的会话不进入结果集）：opencode 默认不过滤；
      // mimocode 经 lib/mimocode.mjs 传入 isMimocodeBackgroundSession 剔除后台任务会话。
      // 导入/预览/发现共用 readOpencodeDb，一处过滤全覆盖。
      if (typeof options.filter === 'function' && options.filter(session)) continue
      sessions.push(session)
    }
    return sessions
  } finally {
    db.close()
  }
}

// 解析 session.model 的 JSON 字符串（{id, providerID, variant}）为模型 id；非法时 undefined。
function parseOpencodeSessionModel(raw) {
  if (typeof raw !== 'string') return undefined
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.id === 'string' && parsed.id) return parsed.id
      if (typeof parsed.modelID === 'string' && parsed.modelID) return parsed.modelID
    }
    return undefined
  } catch {
    // 非 JSON（个别脏数据）→ 无会话级模型，回退链继续走消息级
    return undefined
  }
}

// opencode 单库导入：DB 内每个会话独立落盘（可 sessionIds 过滤），恒返回批量形态。
// REQ-24：DB 级 version/size 短路径检测；fullHistory 入 args 指纹（变了 → args-changed）；
// 逐会话判增 append / compaction 使轮次变少 → sourceShrunk。
// sourcePath 为 opencode.db 路径（目录模式定位后同样落到 db 文件）。
// runDecision / markTrimmedSource 由 index.mjs 注入（其他导入路径共用，见文件头）。
export async function importOpencodeFile(ctx, target, args, { registryDir, persisted, runDecision, markTrimmedSource, filter, convert = convertOpencodeJson } = {}) {
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  const archivedIds = archivedSessionIds(ctx)
  const path = target.displayPath || ctx.fs.processPath(target)
  const stat = await ctx.fs.stat(target)
  const registry = await loadImports(registryDir)
  let known = unwrapRecord(registry.imports[path])
  if (known && known.kind !== 'multi') known = null
  const fingerprint = argsFingerprint(args, ['fullHistory'])

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

  const sessions = readOpencodeDb(path, { fullHistory: args.fullHistory === true, filter })
  const wanted = Array.isArray(args.sessionIds) && args.sessionIds.length > 0 ? new Set(args.sessionIds) : null
  const items = []
  const preSkipped = []
  for (const s of sessions) {
    if (wanted && !wanted.has(s.id)) continue
    const out = markTrimmedSource(convert(JSON.stringify(s), { ...args, sourcePath: path }), args)
    if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
      preSkipped.push({ path, status: 'skipped', reason: 'no user turns (session ' + s.id + ')' })
      continue
    }
    items.push({ key: s.id, converted: out })
  }
  const decision = await decideMulti(ctx, { known, items, stat, args, fingerprint, persisted: persistedSet, sourcePath: path, subTable: 'sessions', budget: args.budget, archivedIds, importFormat: 'opencode' })
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

// opencode 目录导入：目录里定位 opencode.db（无递归），再走单库导入；缺 DB 时抛错。
// 库文件名经 options.dbName 参数化（默认 opencode.db），mimocode fork 场景由
// lib/mimocode.mjs 的 importMimocodeDirectory 传入 mimocode.db 与后台会话过滤；
// options.filter 透传给 readOpencodeDb（剔除谓词，见 readOpencodeDb）。
export async function importOpencodeDirectory(ctx, dirTarget, args, { registryDir, persisted, runDecision, markTrimmedSource, dbName = 'opencode.db', filter } = {}) {
  const dirPath = dirTarget.displayPath || ctx.fs.processPath(dirTarget)
  const dbPath = join(dirPath, dbName)
  const dbTarget = await ctx.fs.resolve(dbPath)
  return importOpencodeFile(ctx, dbTarget, args, { registryDir, persisted, runDecision, markTrimmedSource, filter })
}
