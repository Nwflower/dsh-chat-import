// lib/sources/opencode.mjs — opencode SQLite 历史库读取与导入编排（拆分自 index.mjs）
//
// opencode 的 transcript 不经 JSONL/JSON：直接只读 SQLite 库（默认
// ~/.local/share/opencode/opencode.db）。readOpencodeDb 按**存储世代**分派：
//   V1（opencode 1.x）：session / message / part 三表；
//   V2（opencode 2.x）：session_v2 / session_message 两表——同一个 opencode.db，V1 三表
//                       只是 V1→V2 迁移的来源、迁移后旧行仍在库里，所以必须二选一，
//                       两边都读会让同一会话被导入两次。
// 两代产出同一形状的中间会话 JSON（尊重 compaction，可选 fullHistory）；
// importOpencodeFile 把 DB 内每个会话独立落盘（sessionIds 过滤、DB 指纹短路径、逐会话
// append），恒返回批量形态；importOpencodeDirectory 在目录里定位 opencode.db（无递归）
// 后走单库导入。
//
// 纯机械拆分（零行为变化）：runDecision / markTrimmedSource 是 claude/chatgpt 等路径
// 共用的共享函数（lib/import-core.mjs / lib/budget.mjs，非 opencode 专属），由
// lib/tools.mjs 注册工具时经 options 注入（importOpencodeFile /
// importOpencodeDirectory 的最后一个参数）。
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { convertOpencodeJson } from '../convert/index.mjs'
import { loadImports, unwrapRecord, listPersistedIds, archivedSessionIds, argsFingerprint, decideMulti, sqliteWalSig } from '../imports.mjs'
import { finalizeConvertedSession } from '../import-core.mjs'

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
    // 世代分派：V2 库（opencode 2.x）走 session_v2/session_message；两者都没有 → 大声报错
    // （不静默返回空列表，否则面板会显示「没有会话」而不是「库不认识」）。
    const generation = opencodeSchemaGeneration(db)
    if (generation === 'v2') return readOpencodeV2(db, options)
    if (generation !== 'v1') throw new Error('opencode 库既无 session 也无 session_v2 表：' + dbPath)
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
      // 尊重 opencode 的对话压缩（compaction）：压缩**不切日志**——全量消息照常进会话，
      // 压缩边界（compaction part 的 tail_start_id + 摘要消息的正文）交给转换器发射 DSH 原生
      // 压缩检查点（模型只看得到最后一次压缩的摘要 + 保留窗口，见 lib/convert/events.mjs）。
      // fullHistory 为 true 时不发检查点（模型看到全量）。
      const compactions = []
      if (!options.fullHistory) {
        let pendingTailStart = null
        for (const m of msgs) {
          for (const p of m.parts) {
            if (p && p.type === 'compaction' && typeof p.tail_start_id === 'string') pendingTailStart = p.tail_start_id
          }
          if (m.isSummary) {
            const text = m.parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n').trim()
            // summaryMessageId：正文进检查点的那条消息 → 转换器不再把它当对话内容（避免重复）
            if (text && pendingTailStart) compactions.push({ tailStartId: pendingTailStart, summary: text, summaryMessageId: m.id })
          }
        }
      }
      const session = {
        id: row.id,
        title: row.title,
        directory: row.directory,
        createdAt: row.time_created,
        model: parseOpencodeSessionModel(row.model),
        // 兼容字段：最后一次压缩的摘要（预览/发现层沿用）
        summary: compactions.length > 0 ? compactions[compactions.length - 1].summary : undefined,
        ...(compactions.length > 0 ? { compactions } : {}),
        // isSummary 保留在消息里：转换器据此跳过摘要消息（正文进检查点）
        messages: msgs,
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

// ── OpenCode V2（opencode 2.x）──────────────────────────────────────────────
//
// V2 沿用同一个 opencode.db，但会话落在 session_v2、转录落在 session_message：
//   session_v2      —— 会话行（title/directory/model(JSON)/parent_id/time_created/…）
//   session_message —— 转录：一行一条消息，(session_id, seq) 唯一、按 seq 升序；
//                      data 是 JSON，type ∈ user/assistant/compaction/synthetic/
//                      system/skill/shell/idle/agent-switched/model-switched/
//                      location-switched（@opencode/schema session-message）。
// 消息形状（实测 opencode 2.0.21）：
//   user        { text, files?[{data(base64),mime,name?}], agents?, skills? }
//   assistant   { model:{id,providerID}, content:[ text | reasoning |
//                 tool{ id, name, state:{ status, input, content:[text|file], error? } } ] }
//   compaction  { status:'completed'|'running'|'failed', reason, summary, recent }
//   synthetic/system/skill { text }（模型可见的注入文本）
//   shell       { command, status, exit, output }（无样本，按文本保留）
//
// 压缩边界口径 = V2 自己的模型上下文口径（packages/core/src/session/history.ts）：模型只
// 看得到 seq >= 最近一条 completed compaction 的行。因此那条 compaction 行就是边界，正文取
// summary + recent（V2 模型两段都看，见 session/compaction.ts 的 <summary>/<recent-context>），
// 边界之前的轮进日志但不进模型上下文。非 completed 的 compaction 行（running/failed）不是
// 模型可见的边界，正文当普通内容保留，绝不静默丢。
//
// 与 V1 的差异只在读取层：产出形状完全一致，转换器（lib/convert/opencode.mjs）无世代分支。

/** 库属于哪一代：'v2'（session_v2）/ 'v1'（session）/ null（两者都没有）。 */
export function opencodeSchemaGeneration(db) {
  const names = new Set(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_v2', 'session')",
  ).all().map((r) => r.name))
  if (names.has('session_v2')) return 'v2'
  if (names.has('session')) return 'v1'
  return null
}

/** V2 库（只读已打开）→ 中间会话 JSON 数组；形状与 V1 读取器一致。 */
export function readOpencodeV2(db, options = {}) {
  const sessions = []
  const rows = db.prepare(
    'SELECT id, title, directory, time_created, model FROM session_v2 ORDER BY time_created, id',
  ).all()
  for (const row of rows) {
    const messages = []
    const compactions = []
    let unfinishedCompactions = 0
    for (const t of db.prepare('SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq').all(row.id)) {
      // 畸形 data 直接抛（失败要大声）：与 V1 路径的 JSON.parse 口径一致，不静默丢会话。
      const data = JSON.parse(t.data)
      const base = { id: t.id, createdAt: t.time_created }
      if (t.type === 'user') {
        messages.push({ ...base, role: 'user', parts: v2UserParts(data) })
      } else if (t.type === 'assistant') {
        const model = data.model && typeof data.model === 'object' && typeof data.model.id === 'string' ? data.model.id : undefined
        messages.push({ ...base, role: 'assistant', parts: v2AssistantParts(data), ...(model ? { modelID: model } : {}) })
      } else if (t.type === 'compaction') {
        const body = [data.summary, data.recent].filter((s) => typeof s === 'string' && s.trim()).join('\n\n').trim()
        if (data.status !== 'completed') {
          // running/failed：不是模型可见的边界 → 正文按普通内容保留（计数留在会话对象上，
          // 不进导入结果：正文没丢，就没有降级项要报）
          unfinishedCompactions += 1
          if (body) messages.push({ ...base, role: 'user', parts: [{ type: 'text', text: body, synthetic: true }] })
          continue
        }
        // 边界行：自身不作对话内容（正文由检查点承载），isSummary/summaryMessageId 让转换器
        // 认出这条消息的正文已进检查点（同 V1 的摘要消息口径）。
        messages.push({ ...base, role: 'user', parts: [], isSummary: true })
        compactions.push({
          tailStartId: t.id,
          summary: typeof data.summary === 'string' ? data.summary : '',
          recent: typeof data.recent === 'string' ? data.recent : '',
          summaryMessageId: t.id,
        })
      } else if (t.type === 'synthetic' || t.type === 'system' || t.type === 'skill') {
        // 注入文本（V2 迁移补写的工具改名通知、合成续跑提示、技能正文）：当用户文本保留
        if (typeof data.text === 'string' && data.text.trim()) {
          messages.push({ ...base, role: 'user', parts: [{ type: 'text', text: data.text, synthetic: true }] })
        }
      } else if (t.type === 'shell') {
        const text = v2ShellText(data)
        if (text) messages.push({ ...base, role: 'user', parts: [{ type: 'text', text, synthetic: true }] })
      }
      // idle / agent-switched / model-switched / location-switched：无正文的结构性标记，跳过
    }
    // 子会话（parent_id 非空）与 V1 口径一致地照常导入，不在读取层过滤
    const session = {
      id: row.id,
      title: row.title,
      directory: row.directory,
      createdAt: row.time_created,
      model: parseOpencodeSessionModel(row.model),
      ...(compactions.length > 0
        ? { compactions, summary: compactions[compactions.length - 1].summary }
        : {}),
      ...(unfinishedCompactions > 0 ? { unfinishedCompactions } : {}),
      messages,
    }
    // options.filter（剔除谓词，返回 true 的会话不进结果集）：与 V1 路径同款注入点
    if (typeof options.filter === 'function' && options.filter(session)) continue
    sessions.push(session)
  }
  return sessions
}

/** V2 库（只读已打开）→ 会话级摘要（发现层用）：只查 session_v2 + 每会话最近转录时间。 */
export function readOpencodeV2Summaries(db, options = {}) {
  const where = typeof options.where === 'string' && options.where.trim() ? ' WHERE ' + options.where : ''
  const hasMessage = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'session_message'").get().n > 0
  const rows = db.prepare(
    'SELECT s.id, s.title, s.directory, s.time_created AS createdAt' +
    (hasMessage ? ', (SELECT MAX(m.time_created) FROM session_message m WHERE m.session_id = s.id) AS lastActiveAt' : '') +
    ' FROM session_v2 s' + where + ' ORDER BY s.time_created, s.id',
  ).all()
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    directory: row.directory,
    createdAt: row.createdAt,
    lastActiveAt: row.lastActiveAt ?? row.createdAt,
  }))
}

/** V2 user 消息 → 中间 JSON 的 parts（文本 + 附件；附件拿不到字节时降级为占位文本）。 */
function v2UserParts(data) {
  const parts = []
  if (typeof data.text === 'string' && data.text.trim()) parts.push({ type: 'text', text: data.text })
  for (const f of Array.isArray(data.files) ? data.files : []) {
    if (!f || typeof f !== 'object') continue
    if (typeof f.data === 'string' && f.data && typeof f.mime === 'string') {
      // 与 V1 file part 同形（mime + base64 data + filename）→ 图片走既有附件落地/降级路径
      parts.push({ type: 'file', mime: f.mime, data: f.data, ...(typeof f.name === 'string' ? { filename: f.name } : {}) })
    } else {
      parts.push({ type: 'text', text: '[attachment: ' + (f.name || f.mime || 'unknown') + ']' })
    }
  }
  return parts
}

/** V2 assistant 消息的 content[] → 中间 JSON 的 parts（text / reasoning / tool）。 */
function v2AssistantParts(data) {
  const parts = []
  for (const c of Array.isArray(data.content) ? data.content : []) {
    if (!c || typeof c !== 'object') continue
    if (c.type === 'text' && typeof c.text === 'string') parts.push({ type: 'text', text: c.text })
    else if (c.type === 'reasoning' && typeof c.text === 'string') parts.push({ type: 'reasoning', text: c.text })
    else if (c.type === 'tool') parts.push(v2ToolPart(c))
  }
  return parts
}

/** V2 tool content 项 → 中间 JSON 的 tool part（state.output 取 content 文本，error 状态带错误正文）。 */
function v2ToolPart(c) {
  const state = c.state && typeof c.state === 'object' ? c.state : {}
  // streaming 状态下 input 是未完成的 JSON 字符串：能解析就解析，不能就放进 partial
  // （交给转换器 JSON.stringify，不出现双重编码的引号堆）
  let input = state.input
  if (typeof input === 'string') {
    try { input = JSON.parse(input) } catch { input = input ? { partial: input } : {} }
  }
  const output = Array.isArray(state.content)
    ? state.content
        .map((x) => (x && x.type === 'text' && typeof x.text === 'string'
          ? x.text
          : '[file: ' + ((x && (x.name || x.uri)) || 'unknown') + ']'))
        .join('\n')
    : ''
  return {
    type: 'tool',
    ...(typeof c.id === 'string' && c.id ? { callID: c.id } : {}),
    tool: typeof c.name === 'string' ? c.name : undefined,
    state: {
      status: typeof state.status === 'string' ? state.status : 'unknown',
      input,
      output: output || (state.error && typeof state.error.message === 'string' ? state.error.message : ''),
      ...(state.metadata ? { metadata: state.metadata } : {}),
    },
  }
}

/** V2 shell 消息 → 可见文本（无样本来源的保守兜底：命令 + 状态 + 输出）。 */
function v2ShellText(data) {
  const command = typeof data.command === 'string' ? data.command : ''
  const output = typeof data.output === 'string' ? data.output : ''
  const status = typeof data.status === 'string' ? data.status : ''
  return ['[shell' + (status ? ':' + status : '') + '] ' + command, output].filter((s) => s && s.trim()).join('\n').trim()
}

// opencode 库 → 会话级摘要（发现层用）：只查 session 表 + 每会话 MAX(message.time_created)，
// 不读 message/part 正文。会话面板不再展示消息条数，发现期没有理由把整个库逐 cell
// JSON.parse（大库扫描的同步块来源）。lastActiveAt 取最近一条消息的 time_created，保持
// 「最近活跃」排序语义与旧摘要一致；无消息回退会话行时间。options.where 是给 fork
// （mimocode/kilocode）的会话级保留谓词——只由本仓库代码拼装，不接受用户输入。
export function readOpencodeDbSummaries(dbPath, options = {}) {
  const where = typeof options.where === 'string' && options.where.trim() ? ' WHERE ' + options.where : ''
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    // 世代分派（同 readOpencodeDb）：V2 摘要走 session_v2，不读 V1 表。
    if (opencodeSchemaGeneration(db) === 'v2') return readOpencodeV2Summaries(db, options)
    // 缺 message 表（极简/降级形态）时不做「最近消息」聚合，lastActiveAt 回落会话行时间
    const hasMessage = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='message'").get().n > 0
    const rows = db.prepare(
      'SELECT s.id, s.title, s.directory, s.time_created AS createdAt' +
      (hasMessage ? ', (SELECT MAX(m.time_created) FROM message m WHERE m.session_id = s.id) AS lastActiveAt' : '') +
      ' FROM session s' + where + ' ORDER BY s.time_created, s.id'
    ).all()
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      directory: row.directory,
      createdAt: row.createdAt,
      lastActiveAt: row.lastActiveAt ?? row.createdAt,
    }))
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
// DB 级 version/size 短路径检测；fullHistory 入 args 指纹（变了 → args-changed）；
// 逐会话判增 append / compaction 使轮次变少 → sourceShrunk。
// sourcePath 为 opencode.db 路径（目录模式定位后同样落到 db 文件）。
// runDecision / markTrimmedSource 由 index.mjs 注入（其他导入路径共用，见文件头）。
export async function importOpencodeFile(ctx, target, args, { registryDir, persisted, runDecision, markTrimmedSource, filter, convert = convertOpencodeJson, readDb = readOpencodeDb, sourceLabel = 'opencode', importFormat = 'opencode' } = {}) {
  const persistedSet = persisted ?? await listPersistedIds(ctx)
  const archivedIds = archivedSessionIds(ctx)
  const path = target.displayPath || ctx.fs.processPath(target)
  const stat = await ctx.fs.stat(target)
  const registry = await loadImports(registryDir)
  let known = unwrapRecord(registry.imports[path])
  if (known && known.kind !== 'multi') known = null
  const fingerprint = argsFingerprint(args, ['fullHistory'])
  // WAL 边车签名：主文件 stat 不变不代表库内容不变（WAL 未 checkpoint）→ 并入
  // S3 短路径判定与父记录（decideMulti 落盘 walSig 供下次比对）
  const walSig = await sqliteWalSig(ctx, path)

  // S3 短路径（不重读 SQLite）。仅当记录里所有会话仍存在且未被归档时短路径才成立
  // （会话被删 / DSH_HOME 迁移 / 被归档 → 走全量重导）
  if (known && (!known.sessions || typeof known.sessions !== 'object')) known = null
  if (known && args.force !== true) {
    // 选择性导入守卫：args.sessionIds 指定的会话不在已知子表中时短路径不成立
    // ——否则面板勾选「部分」会话重导会被 DB 指纹短路径判为 already-imported 漏导。
    const guardIds = Array.isArray(args.sessionIds) && args.sessionIds.length > 0 ? args.sessionIds : null
    const selectionCovered = !guardIds || guardIds.every((id) => known.sessions[id] && typeof known.sessions[id] === 'object')
    const subs = Object.values(known.sessions)
    const allPersisted = subs.length > 0 && subs.every((sub) => persistedSet.has(sub.dshId) && !archivedIds.has(sub.dshId))
    if (allPersisted && selectionCovered) {
      const skipResults = () => Object.entries(known.sessions).map(([, sub]) => ({
        path, status: 'already-imported', sessionId: sub.dshId, turns: sub.turns, messages: 0, toolCalls: 0, skipped: 0,
      }))
      if (typeof known.args === 'string' && fingerprint !== known.args) {
        const results = skipResults().map((r) => ({ ...r, argsChanged: true }))
        return { total: results.length, imported: 0, alreadyImported: results.length, appended: 0, skipped: 0, failed: 0, results }
      }
      // 预算变化 → 跳过并上报 budgetChanged（同 argsChanged 语义）
      if (typeof known.budget === 'number' && known.budget !== args.budget) {
        const results = skipResults().map((r) => ({ ...r, budgetChanged: true }))
        return { total: results.length, imported: 0, alreadyImported: results.length, appended: 0, skipped: 0, failed: 0, results }
      }
      if (stat && stat.version === known.version && stat.size === known.sizeBytes && known.walSig === walSig) {
        const count = Object.keys(known.sessions).length
        return { total: count, imported: 0, alreadyImported: count, appended: 0, skipped: 0, failed: 0, results: skipResults() }
      }
    }
  }

  const sessions = readDb(path, { fullHistory: args.fullHistory === true, filter })
  const wanted = Array.isArray(args.sessionIds) && args.sessionIds.length > 0 ? new Set(args.sessionIds) : null
  const items = []
  const preSkipped = []
  for (const s of sessions) {
    if (wanted && !wanted.has(s.id)) continue
    // finalizeConvertedSession 统一钉「来源 · 话题」标题（DB 批量来源此前不钉，
    // UI 会回退成工作区目录名）+ cwd 重映射口径对齐其他源；markTrimmedSource 仍是注入的
    // 预算裁剪步骤（与 claude/chatgpt 路径共用）。
    const out = finalizeConvertedSession(
      markTrimmedSource(convert(JSON.stringify(s), { ...args, sourcePath: path }), args),
      args,
      sourceLabel,
    )
    if (!out.meta || (out.turns.length === 0 && out.events.length === 0)) {
      preSkipped.push({ path, status: 'skipped', reason: 'no user turns (session ' + s.id + ')' })
      continue
    }
    items.push({ key: s.id, converted: out })
  }
  const decision = await decideMulti(ctx, { known, items, stat: stat ? { ...stat, walSig } : stat, args, fingerprint, persisted: persistedSet, sourcePath: path, subTable: 'sessions', budget: args.budget, archivedIds, importFormat })
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
export async function importOpencodeDirectory(ctx, dirTarget, args, { registryDir, persisted, runDecision, markTrimmedSource, dbName = 'opencode.db', filter, readDb = readOpencodeDb, convert = convertOpencodeJson } = {}) {
  const dirPath = dirTarget.displayPath || ctx.fs.processPath(dirTarget)
  const dbPath = join(dirPath, dbName)
  const dbTarget = await ctx.fs.resolve(dbPath)
  return importOpencodeFile(ctx, dbTarget, args, { registryDir, persisted, runDecision, markTrimmedSource, filter, readDb, convert })
}
