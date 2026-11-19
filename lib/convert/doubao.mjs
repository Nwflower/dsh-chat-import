// lib/convert/doubao.mjs — 豆包桌面版（Doubao Desktop）会话 → DSH 会话（纯函数）
//
// 存储：Chromium IndexedDB = `%LOCALAPPDATA%\Doubao\User Data\<profile>\IndexedDB\
// chrome_doubao-chat_0.indexeddb.leveldb`（LevelDB 目录）。读取在
// `lib/sources/doubao.mjs`（host 面），本文件只做「已解码的 JS 值 → turns IR」的纯变换。
//
// ── 数据形状（实测 SamanthaDoubao/2.31.4）────────────────────────────────────────
//
// 会话列表：对象存储里 `{ uid, schema, data }` 的记录，`schema` 以 `conversation-list-data-`
// 开头，`data.conversations[]` 每项是一个会话的元数据（`conversation_id` / `name` /
// `create_time` / `update_time` / `message_index` …）。**命名有多个变体**
// （overall-v2 / non-project-v2 / non-device-v1 / project-v4 / device-group-v1），
// 同一会话会同时出现在几份里且字段有出入 → 按 conversation_id 合并、取最完整的那份。
//
// 对话正文：对象存储里 `{ state: { mainTaskDataMap }, version }` 的记录，主键固定
// `default-chat-im-protocol-store`。`mainTaskDataMap[taskId]` 是一次「提问→回答」任务：
//   requestQuery.syncTask.client_meta.conversation_id   会话 id
//   requestQuery.syncTask.messages[].content_block[]     用户提问（block_type 10000 = 文本）
//   requestQuery.syncTask.option.create_time_ms          提问时间
//   receivedMessages[id].extra.content_blocks_v2[]       回答（同一 block_type 10000）
//   receivedMessages[id].extra.create_time               回答时间
//
// ── 为什么要读「历史版本」───────────────────────────────────────────────────────
// 豆包把**流式生成状态**整条写在这个固定主键上：每个增量都是一次整条重写，回答正文在
// 快照之间单调增长；生成结束或页面刷新后再写一条**清空任务表**的快照。于是：
//   * 当前值 = 最后一次清空 → 只读当前值会得到空会话（实测就是 0 轮）；
//   * 全部历史版本 = 每次流式增量的快照 → 按 taskId 取**最长**的那版才是完整回答。
// 同一个 taskId 的几十个快照因此必须合并，不能当成几十个回合。
//
// 反面契约（有意的取舍）：只导**本地确实有正文**的会话。会话列表里能列出几十上百个
// 会话，但豆包的历史正文留在服务端，本地只为「最近在客户端里打开过」的会话保留快照。
// 没有正文的会话不进导入结果——不伪造空会话，也不拿标题凑一个只有一问的空壳。
//
// 块类型：`block_type = 10000` 是文本（`content.text_block.text`）。其它类型
// （图片、卡片、工具调用等）在本地快照里没有可读正文，计入 `skippedBlocks`，
// 不转成占位文本——宁可少一块，也不要往会话里塞 `[image]` 一类伪造内容。

import { SESSION_FORMAT_VERSION, finishSession, mintSessionId, parseTimeMs } from './core.mjs'
import { normalizeTitle, skipResult } from './util.mjs'
import { createTurns, dropDuplicateCalls } from './ir.mjs'

/** 消息正文的块类型：本地快照里唯一带可读文本的块。 */
export const DOUBAO_TEXT_BLOCK = 10000

/** 协议存储主键（流式状态所在的那条记录）。 */
export const DOUBAO_PROTOCOL_KEY = 'default-chat-im-protocol-store'

/** 会话列表记录的 schema 前缀。 */
export const DOUBAO_LIST_SCHEMA_PREFIX = 'conversation-list-data-'

// 时间口径：豆包多处混用「秒（数字或数字字符串）」「毫秒」「带小数的秒」，统一交给
// parseTimeMs（< 1e11 按秒）；字符串优先按数字解析，解析不动才交给 Date.parse。
function doubaoTime(value) {
  if (typeof value === 'number') return parseTimeMs(value)
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return parseTimeMs(numeric)
    return parseTimeMs(value)
  }
  return null
}

/** 从一条 `content_blocks_v2` / `content_block` 数组里抽文本块。 */
function textOfBlocks(blocks, stats) {
  const out = []
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== 'object') continue
    if (block.block_type !== DOUBAO_TEXT_BLOCK) {
      stats.skippedBlocks++
      continue
    }
    const text = block.content && block.content.text_block && block.content.text_block.text
    if (typeof text === 'string' && text) out.push(text)
    else stats.emptyBlocks++
  }
  return out.join('\n')
}

/**
 * 一条 `mainTaskDataMap` 任务 → `{ conversationId, taskId, prompt, reply, promptTime, replyTime }`。
 * 读不出会话 id / 提问 / 回答任意一项就返回 null（调用方计数跳过）。
 */
export function normalizeDoubaoTask(taskId, task, stats) {
  if (!task || typeof task !== 'object') return null
  const sync = task.requestQuery && task.requestQuery.syncTask
  const meta = sync && sync.client_meta
  // 豆包 2.37+ 把 client_meta.conversation_id 写成空串，会话 id 只在每条 received
  // 消息的 extra.conversation_id 上（同一 task 的全部消息归属同一会话，任取一条非空）。
  const conversationId =
    (meta && typeof meta.conversation_id === 'string' && meta.conversation_id) ||
    Object.values(task.receivedMessages ?? {})
      .map((r) => r && r.extra && r.extra.conversation_id)
      .find((id) => typeof id === 'string' && id) ||
    null
  if (!conversationId) return null
  const prompt = textOfBlocks(
    (Array.isArray(sync.messages) ? sync.messages : []).flatMap((m) => (m && Array.isArray(m.content_block) ? m.content_block : [])),
    stats,
  )
  const replies = []
  let replyTime = null
  for (const id of Object.keys(task.receivedMessages ?? {})) {
    const received = task.receivedMessages[id]
    const extra = received && received.extra
    if (!extra) continue
    const text = textOfBlocks(extra.content_blocks_v2, stats)
    if (text) replies.push(text)
    if (replyTime === null) replyTime = doubaoTime(extra.create_time)
  }
  const reply = replies.join('\n')
  if (!prompt && !reply) return null
  const option = sync && sync.option
  return {
    conversationId,
    taskId: typeof taskId === 'string' ? taskId : String(taskId),
    prompt,
    reply,
    promptTime: doubaoTime(option && option.create_time_ms) ?? doubaoTime(task.createTime),
    replyTime,
  }
}

/**
 * 把同一 taskId 的多个流式快照合并成一条完整回合。
 *
 * 快照之间只有「回答更长」这一个方向的变化（追加式流式），所以按 taskId 各取最长的
 * 提问/回答。同一 taskId 在历史上被重发（用户点了重答）会出现不同内容 → 取最长的那份，
 * 并把差异计入 `restarted`（不静默）。
 * @returns {{turns: Array<object>, restarted: number}}
 */
export function collectDoubaoTasks(records, stats) {
  const best = new Map()
  let restarted = 0
  for (const record of records) {
    // record.versions 是同一条主键写过的全部值（按写入顺序）；单版本记录只有 value
    const snapshots = Array.isArray(record && record.versions) ? record.versions : [record && record.value]
    for (const snapshot of snapshots) {
      const tasks = snapshot && snapshot.state && snapshot.state.mainTaskDataMap
      if (!tasks || typeof tasks !== 'object') continue
      for (const [taskId, task] of Object.entries(tasks)) {
        const normalized = normalizeDoubaoTask(taskId, task, stats)
        if (!normalized) continue
        const key = normalized.taskId
        const prev = best.get(key)
        if (!prev) {
          best.set(key, normalized)
          continue
        }
        if (normalized.reply.length > prev.reply.length) {
          // 同一 taskId 出现更长的回答：同一轮的重答/续写，用新的完整版本
          if (prev.reply && normalized.reply && !normalized.reply.startsWith(prev.reply)) restarted++
          best.set(key, { ...normalized, prompt: normalized.prompt || prev.prompt })
        } else if (normalized.prompt && !prev.prompt) {
          prev.prompt = normalized.prompt
        }
      }
    }
  }
  return { turns: [...best.values()], restarted }
}

/**
 * 会话列表记录 → `conversation_id → { id, title, createdAt, updatedAt }`。
 * 同一会话在多个 schema 变体里重复出现，按字段齐全度合并（标题非空优先、时间取最早创建
 * 与最晚更新）。
 */
export function collectDoubaoConversations(records) {
  const conversations = new Map()
  for (const record of records) {
    const value = record && record.value
    if (!value || typeof value !== 'object') continue
    if (typeof value.schema !== 'string' || !value.schema.startsWith(DOUBAO_LIST_SCHEMA_PREFIX)) continue
    const list = value.data && Array.isArray(value.data.conversations) ? value.data.conversations : []
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const id = typeof item.conversation_id === 'string' && item.conversation_id ? item.conversation_id : null
      if (!id) continue
      const title = typeof item.name === 'string' ? item.name.trim() : ''
      const createdAt = doubaoTime(item.create_time)
      const updatedAt = doubaoTime(item.update_time)
      const prev = conversations.get(id)
      if (!prev) {
        conversations.set(id, { id, title, createdAt, updatedAt })
        continue
      }
      // 各 schema 变体的字段只有一部分，逐字段取「有值的那份」
      if (!prev.title && title) prev.title = title
      if (prev.createdAt === null && createdAt !== null) prev.createdAt = createdAt
      else if (createdAt !== null && prev.createdAt !== null && createdAt < prev.createdAt) prev.createdAt = createdAt
      if (updatedAt !== null && (prev.updatedAt === null || updatedAt > prev.updatedAt)) prev.updatedAt = updatedAt
    }
  }
  return conversations
}

/**
 * 豆包本地库 → 中间会话数组（导入 / 预览 / 发现共用同一次解析）。
 *
 * 一个「会话」= 一条 conversations 列表条目；正文来自所有 taskId 快照合并后的回合。
 * **只有拿到至少一条有正文的回合时**该会话才进结果（见文件头的反面契约）。
 * @param {{records: Array<object>}} db readIndexedDb 的产物
 * @returns {{sessions: Array<object>, stats: object}}
 */
export function extractDoubaoSessions(db) {
  const stats = { skippedBlocks: 0, emptyBlocks: 0, restarted: 0, emptyConversations: 0, orphanConversations: 0 }
  const records = Array.isArray(db && db.records) ? db.records : []
  const conversations = collectDoubaoConversations(records)
  // 豆包 2.35+ 给协议存储主键加了账户前缀（`im-sdk:user:<uid>:<key>`）；裸键是旧版形态。
  // endsWith 带冒号锚定，避免把恰好共享这段后缀的无关键误收进来。
  const protocolRecords = records.filter(
    (r) => r && (r.key === DOUBAO_PROTOCOL_KEY || String(r.key ?? '').endsWith(':' + DOUBAO_PROTOCOL_KEY)),
  )
  const { turns, restarted } = collectDoubaoTasks(protocolRecords, stats)
  stats.restarted = restarted

  const byConversation = new Map()
  for (const turn of turns) {
    const list = byConversation.get(turn.conversationId) ?? []
    list.push(turn)
    byConversation.set(turn.conversationId, list)
  }

  const sessions = []
  for (const [conversationId, list] of byConversation) {
    // 有正文的回合才成会话：一问一答、或者至少一端有文本
    const usable = list.filter((t) => t.prompt || t.reply)
    if (usable.length === 0) {
      stats.emptyConversations++
      continue
    }
    // 按提问时间排序；缺时间的排到末尾（保持稳定）
    usable.sort((a, b) => (a.promptTime ?? a.replyTime ?? Number.MAX_SAFE_INTEGER)
      - (b.promptTime ?? b.replyTime ?? Number.MAX_SAFE_INTEGER))
    const meta = conversations.get(conversationId)
    if (!meta) stats.orphanConversations++
    const times = usable.flatMap((t) => [t.promptTime, t.replyTime]).filter((t) => t !== null && t !== undefined)
    sessions.push({
      id: conversationId,
      title: meta && meta.title ? meta.title : '',
      createdAt: meta && meta.createdAt !== null ? meta.createdAt : (times.length ? Math.min(...times) : null),
      updatedAt: meta && meta.updatedAt !== null ? meta.updatedAt : (times.length ? Math.max(...times) : null),
      turns: usable,
    })
  }
  sessions.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
  return { sessions, stats }
}

/**
 * 一个豆包会话（`extractDoubaoSessions` 的产物之一）→ DSH 会话。
 *
 * 回合构造：一个 taskId = 一次提问 + 一次回答。回答放在**提问那一轮的 step** 里（豆包没有
 * 工具调用，一次生成就是一步），不额外开轮——否则会话里会出现「空提问轮」。
 */
export function convertDoubaoSession(session, args = {}) {
  if (!session || typeof session !== 'object' || !Array.isArray(session.turns)) {
    return skipResult('not a Doubao session (no turns)', { skipped: 1 })
  }
  const sourceId = typeof session.id === 'string' && session.id ? session.id : null
  if (!sourceId) return skipResult('Doubao session without conversation id', { skipped: 1 })

  const queue = createTurns()
  const turns = queue.turns
  let messages = 0
  for (const turn of session.turns) {
    const prompt = typeof turn.prompt === 'string' ? turn.prompt : ''
    const reply = typeof turn.reply === 'string' ? turn.reply : ''
    const promptTime = turn.promptTime ?? turn.replyTime ?? null
    if (!prompt && !reply) continue
    const irTurn = queue.open(prompt, promptTime)
    if (reply) {
      const step = { content: [{ type: 'text', text: reply }], toolCalls: [], toolResults: [] }
      const replyTime = turn.replyTime ?? turn.promptTime ?? null
      if (replyTime !== null) step.time = replyTime
      irTurn.steps.push(step)
      messages += 2
    } else {
      messages += 1
    }
  }
  dropDuplicateCalls(turns)

  if (turns.length === 0) {
    return skipResult('Doubao session has no readable content (' + sourceId + ')', { skipped: 1 })
  }

  const sessionId = args.sessionId || mintSessionId(sourceId)
  const createdAt = session.createdAt ?? session.updatedAt ?? (turns[0].time ?? Date.now())
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt }
  meta.sourceId = sourceId
  if (typeof args.cwd === 'string' && args.cwd) meta.cwd = args.cwd

  const explicit = typeof session.title === 'string' ? session.title.trim() : ''
  const finalTitle = normalizeTitle(explicit || turns[0].prompt)
  return finishSession(turns, args.budget, {
    meta,
    title: explicit ? finalTitle : undefined,
    provider: 'doubao',
    model: null,
    skipped: 0,
    records: session.turns.length,
  }, { title: finalTitle, messages })
}

/**
 * 全部会话 → 逐个转换（导入编排用）。没有正文的会话不进结果。
 * @returns {{items: Array<{session: object, converted: object}>, stats: object}}
 */
export function convertDoubaoDb(db, args = {}) {
  const { sessions, stats } = extractDoubaoSessions(db)
  const items = []
  for (const session of sessions) {
    const converted = convertDoubaoSession(session, args)
    if (converted && converted.skipped === 1) {
      stats.emptyConversations++
      continue
    }
    items.push({ session, converted })
  }
  return { sessions, items, stats }
}
