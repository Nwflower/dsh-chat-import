// lib/imports.mjs — REQ-24 增量续写：imports registry（源文件路径 → 导入记录）
//
// registry 落盘在 `$DSH_HOME/dsh-chat-import/imports.json`
// （`$DSH_HOME = env.DSH_HOME || ~/.dsh`）。格式：
//   { version: 1, imports: { <源文件绝对路径>: record } }
// record = { kind:'single'|'multi', dshId, turns, events, sizeBytes, mtimeMs?,
//            version, args, budget?, importedAt }；multi 用 conversations / sessions 子表
// 逐会话记录 { dshId, turns, events }。budget 为 REQ-37 上下文预算（token 数），
// 预算变化（index 层解析口径不同）→ budgetChanged 跳过并报告（同 argsChanged）。
//
// 幂等键 = 源文件路径（多个源文件可共享同一源 sessionId，按 sessionId 去重会静默
// 丢历史）。用 node:fs/promises 原子写（temp + fsync + rename，复刻
// dsh-storage-json 的 writeAtomic）——不用 ctx.fs（沙箱会拒 ~/.dsh 写入）。
// 损坏/缺失容错：返回空 registry + warn。进程内 promise 链串行化写，避免并发覆盖。
//
// 上游缺口（REQ-33）：sessionPersistence.remove(id) / fs.removeFile 未提供——
// 「撤回」只能移除 registry 记录 + 引导手动删工件（locate 报路径），绝不删会话。
//
// decideSingle / decideMulti 是单文件 / 多会话源的状态机核心：给定 registry 记录 +
// 本次转换结果 + stat + 参数，返回带 __action 的执行决策（执行在 lib/import-core.mjs
// 的 runDecision：create / append / rememberImport / 工作区挂接）。append 的 seq
// 游标以 sessionPersistence.inspect(id).events.length 为准（用户在 DSH 续聊后
// registry 的 events 过期）。
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tailSessionEvents } from '../convert.mjs'

export const REGISTRY_VERSION = 1

// 进程内写串行链：所有 registry 写依次执行，杜绝并发覆盖；单次失败不阻塞后续写
let writeChain = Promise.resolve()

/** registry 目录：`$DSH_HOME/dsh-chat-import`（`$DSH_HOME` 缺省 `~/.dsh`）。 */
export function resolveRegistryDir(env = process.env) {
  const base = env.DSH_HOME || join(homedir(), '.dsh')
  return join(base, 'dsh-chat-import')
}

// 原子写：同目录 temp + fsync + rename（rename 在 Windows 上经
// MoveFileExW(MOVEFILE_REPLACE_EXISTING) 原子替换）。
async function writeAtomic(filePath, data) {
  const tmp = join(dirname(filePath), '.' + randomUUID() + '.tmp')
  try {
    const handle = await open(tmp, 'wx')
    try {
      await handle.writeFile(data, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, filePath)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

// 直接读盘（调用方须已处于写串行链内）：缺失返回空 registry，损坏告警后按空处理。
// 同时维护进程内快照 lastRegistrySnapshot：导入决策链（decideItem）没有 registryDir
// 上下文，sessionOwnerPath 的 dshId 反查借用同流程内必然先行发生的本次读取结果。
let lastRegistrySnapshot = { imports: {} }

async function readRegistry(registryDir) {
  try {
    const parsed = JSON.parse(await readFile(join(registryDir, 'imports.json'), 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && parsed.imports && typeof parsed.imports === 'object') {
      lastRegistrySnapshot = parsed
      return parsed
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.warn('[dsh-chat-import] imports registry 损坏，按空 registry 处理：' + String((err && err.message) || err))
    }
  }
  const empty = { version: REGISTRY_VERSION, imports: {} }
  lastRegistrySnapshot = empty
  return empty
}

/** dshId → 导入归属 sourcePath 反查（single + multi 子表，REQ-32）。0.8.3 起日志
 * 不再写 session/imported 标记（issue #34，宿主 fail-closed 词汇表），归属判定
 * 以 registry 为权威；查不到返回 null。 */
export function findSourcePathByDshId(imports, dshId) {
  for (const [sourcePath, raw] of Object.entries(imports || {})) {
    const record = unwrapRecord(raw)
    if (!record || typeof record !== 'object') continue
    if (record.kind === 'multi') {
      for (const table of ['conversations', 'sessions']) {
        const subs = record[table] && typeof record[table] === 'object' ? record[table] : {}
        if (Object.values(subs).some((s) => s && typeof s.dshId === 'string' && s.dshId === dshId)) {
          return sourcePath
        }
      }
    } else if (record.dshId === dshId) {
      return sourcePath
    }
  }
  return null
}

async function writeRegistry(registryDir, data) {
  await mkdir(registryDir, { recursive: true })
  await writeAtomic(join(registryDir, 'imports.json'), JSON.stringify(data, null, 2) + '\n')
}

/** 读取 registry；等待未决写完成后读，保证读到最新落盘。 */
export async function loadImports(registryDir) {
  await writeChain.catch(() => {})
  return readRegistry(registryDir)
}

/** 整体覆盖写（串行入链）。 */
export function saveImports(registryDir, data) {
  const run = writeChain.then(() => writeRegistry(registryDir, data))
  writeChain = run.catch(() => {})
  return run
}

/** 更新单个源路径的导入记录（串行入链：读 → 改 → 写）。 */
export function rememberImport(registryDir, key, record) {
  if (typeof key !== 'string' || key.length === 0) return Promise.resolve()
  const run = writeChain.then(async () => {
    const data = await readRegistry(registryDir)
    data.imports[key] = record
    await writeRegistry(registryDir, data)
  })
  writeChain = run.catch(() => {})
  return run
}

/** 移除单个源路径的导入记录（串行入链：读 → 删 → 写）。键不存在幂等返回
 *（不写盘）。「撤回」只移除 registry 记录，不删会话/工件（REQ-33：平台无
 * sessionPersistence.remove / fs.removeFile，删除只能引导手动做）。 */
export function removeImport(registryDir, key) {
  if (typeof key !== 'string' || key.length === 0) return Promise.resolve()
  const run = writeChain.then(async () => {
    const data = await readRegistry(registryDir)
    if (!Object.prototype.hasOwnProperty.call(data.imports, key)) return
    delete data.imports[key]
    await writeRegistry(registryDir, data)
  })
  writeChain = run.catch(() => {})
  return run
}

/** 兼容旧格式（纯字符串 dshId）的导入记录读取。 */
export function unwrapRecord(entry) {
  if (typeof entry === 'string') return { kind: 'single', dshId: entry }
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) return entry
  return null
}

/** 强制重导入的新会话 id：`<baseId>-<n>`，n 取现有后缀最大值 +1（force / 撞 id 避让）。 */
export function mintForceSessionId(persisted, baseId) {
  const prefix = baseId + '-'
  let max = 0
  for (const id of persisted) {
    if (id.startsWith(prefix)) {
      const n = Number(id.slice(prefix.length))
      if (Number.isInteger(n) && n > max) max = n
    }
  }
  return prefix + (max + 1)
}

/** 已持久化会话 id 快照（就地可增，供批量内避让）。 */
export async function listPersistedIds(ctx) {
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof sp.list !== 'function') return new Set()
  try {
    return new Set((await sp.list()).map((h) => h.id))
  } catch {
    return new Set()
  }
}

/** 已归档会话 id 集合（workspaceRegistry 的全局归档集；服务缺席 / 不可读 → 空集）。
 * 归档只把会话隐藏出分组界面，会话仍在 sessionPersistence 中且占用原 id——导入层
 * 据此把「记录目标已归档」视作可重导：建后缀新副本（mintForceSessionId），
 * 归档会话原样保留（平台无取消归档面，重导即新建可见副本）。 */
export function archivedSessionIds(ctx) {
  try {
    const wr = ctx.get('workspaceRegistry')
    const ids = wr && typeof wr.archivedSessionIds !== 'undefined' ? wr.archivedSessionIds : null
    return new Set(Array.isArray(ids) ? ids : [])
  } catch {
    // workspaceRegistry 未初始化 / 不可读：按无归档处理（保守回退，状态显示已导入）
    return new Set()
  }
}

/** 已存储日志事件数：inspect(id).events.length 是权威续写游标（用户在 DSH 续聊后
 * registry 的 events 会过期）；inspect 不可用 / 读不到返回 null → 调用方保守跳过。 */
export async function storedEventCount(ctx, dshId) {
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof sp.inspect !== 'function') return null
  try {
    const info = await sp.inspect(dshId)
    return Array.isArray(info && info.events) ? info.events.length : null
  } catch {
    return null
  }
}

/** 现有会话的导入归属路径（REQ-32）：imports registry 反查优先（0.8.3 起日志不再写
 * session/imported 标记，issue #34），旧日志标记兜底（registry 快照未含的边缘态）。
 * readable 区分「日志可读」与「日志读不到」（后者是 retract 后工件被删的幽灵会话
 * 信号，issue #22）：
 *   { owner: sourcePath|null, readable: true|false|null }
 * readable=null 表示 sessionPersistence.inspect 不可用（调用方保守按可读处理）。 */
async function sessionOwnerPath(ctx, dshId) {
  const sp = ctx.get('sessionPersistence')
  let owner = findSourcePathByDshId(lastRegistrySnapshot.imports, dshId)
  if (!sp || typeof sp.inspect !== 'function') return { owner: owner ?? null, readable: null }
  try {
    const info = await sp.inspect(dshId)
    const first = Array.isArray(info && info.events) ? info.events[0] : undefined
    if (!owner && first && first.type === 'session/imported' && first.data && typeof first.data.sourcePath === 'string') {
      owner = first.data.sourcePath
    }
    return { owner: owner ?? null, readable: true }
  } catch {
    // 读不到日志（工件已删 / 后端瞬断）：归属以 registry 反查为准，按不可读处理
    return { owner: owner ?? null, readable: false }
  }
}

/** args 指纹：只纳入会影响转换产物的参数（如 opencode 的 fullHistory）；按 key
 * 稳定排序序列化，值变化 → 指纹变化 → args-changed 跳过。 */
export function argsFingerprint(args = {}, keys = []) {
  const picked = keys
    .filter((k) => args[k] !== undefined)
    .map((k) => [k, args[k]])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return JSON.stringify(picked)
}

/** 显式 sessionId 是否与记录的目标 id 构成「变更」：id 不同且不是避让后缀
 * （目标 id 曾因撞 id 被后缀避让为 <sessionId>-<n> 时视为同一会话，不重复建副本）。 */
export function isSessionIdChange(args, targetId) {
  return typeof args.sessionId === 'string'
    && args.sessionId !== targetId
    && !targetId.startsWith(args.sessionId + '-')
}

// ── 单条目状态机核心（single 源的整文件 = 一条；multi 源的每个会话 = 一条）────
//
// known 为 null 时：首次导入 / legacy 回填 / 目标 id 被其它源占用（后缀避让）。
// 已知记录时：force 或显式 sessionId 变更 → 新 id 完整副本；轮数增长 → append 尾部；
// 轮数相等 → 事件变化 = changedInPlace 跳过（append-only 不能改写已落盘轮次）；
// 轮数减少 → sourceShrunk 跳过报告。
//
// 返回：{ ...公开字段, __action:'create'|'append', __meta, __events,
//        __targetId, __tailEvents, __itemRecord }——__ 前缀为执行载荷，runDecision
// 剥离；跳过类返回（sourceShrunk / changedInPlace / backfilled / 幂等跳过）不产出
// __action 字段。
async function decideItem(ctx, { known, converted, args, persisted, sourcePath, archivedIds, importFormat }) {
  const archived = archivedIds instanceof Set ? archivedIds : new Set()
  const { meta, events, turns } = converted
  const base = {
    sessionId: meta.id,
    turns: turns.length,
    messages: converted.messages,
    toolCalls: converted.toolCalls,
    skipped: converted.skipped,
    alreadyImported: false,
    // REQ-37：裁剪上报随结果透出（budget/估算/裁剪计数，index 层已并入 source）
    ...(converted.trimmed ? { trimmed: converted.trimmed } : {}),
    // REQ-22：Reasonix WAL 合并 / Claude compacted 摘要导入报告透出
    ...(converted.walMerged ? { walMerged: true, ...(typeof converted.walRecords === 'number' ? { walRecords: converted.walRecords } : {}) } : {}),
    ...(converted.compacted ? { compacted: true } : {}),
  }
  // itemRecord 的 format = 来源格式（'claude' / 'chatgpt' / …）：0.8.3 起日志不再写
// session/imported 标记（issue #34），sync-loop 出站写回的 originFormat 判定改由
// registry 记录承载（旧记录无 format 字段，出站走旧日志标记兜底）。
const itemRecord = (dshId, t, ev, format) => ({ dshId, turns: t, events: ev, ...(format ? { format } : {}) })

  // 记录指向的会话已不存在（被删 / DSH_HOME 迁移）或被归档（隐藏但仍占 id）
  // → 视作无记录重导：归档会话保留，重导走下方「无记录」分支建后缀新副本
  if (known && (!persisted.has(known.dshId) || archived.has(known.dshId))) known = null

  // 已知记录且为可续写形态（有 dshId + turns）时走增量状态机；缺 turns 的
  // legacy/残缺记录（unwrapRecord 解出的旧 string 记录只有 dshId）被挡在此守卫外，
  // 落进下方「无记录」分支做 legacy 回填。
  if (known && typeof known.dshId === 'string' && typeof known.turns === 'number') {
    const targetId = known.dshId
    // replace：同 id 删工件后全量重导（面板「刷新已导入」）；不新建副本。
    if (args.replace === true) {
      return {
        ...base,
        sessionId: targetId,
        status: 'replaced',
        __action: 'replace',
        __meta: { ...meta, id: targetId },
        __events: events,
        __itemRecord: itemRecord(targetId, turns.length, events.length, importFormat),
      }
    }
    // 显式 sessionId 变更（或源 sessionId 变更）→ 副本语义；「targetId 由避让产生
    // 且显式 id 是其前缀」视为同一会话（曾撞 id 被后缀避让），不重复建副本
    const explicitChanged = isSessionIdChange(args, targetId)
    if (explicitChanged || args.force === true) {
      const baseId = explicitChanged ? args.sessionId : targetId
      const newId = persisted.has(baseId) ? mintForceSessionId(persisted, baseId) : baseId
      return {
        ...base,
        sessionId: newId,
        status: 'imported',
        __action: 'create',
        __meta: { ...meta, id: newId },
        __events: events,
        __itemRecord: itemRecord(newId, turns.length, events.length, importFormat),
        forceImported: { previous: targetId, current: newId },
      }
    }

    if (turns.length > known.turns) {
      const fromSeq = await storedEventCount(ctx, targetId)
      if (fromSeq === null) {
        // 无法确定已存日志长度：保守跳过续写（绝不冒险 append 错误 seq），记录不动
        return { ...base, sessionId: targetId, status: 'already-imported', alreadyImported: true, appendedSkipped: 'stored-length-unknown' }
      }
      const tail = tailSessionEvents(converted, { fromTurn: known.turns + 1, fromSeq })
      if (tail.events.length === 0) {
        // 轮数增加但没有可截取事件（理论不可达）：保守跳过
        return { ...base, sessionId: targetId, status: 'already-imported', alreadyImported: true }
      }
      return {
        ...base,
        sessionId: targetId,
        status: 'appended',
        __action: 'append',
        __targetId: targetId,
        __tailEvents: tail.events,
        // registry.events 保持转换口径计数（= 已知 + 本次尾），供下次「轮数相等时
        // 事件数比对」用；DSH 侧实际长度另以 inspect 为准（见模块头）。
        __itemRecord: itemRecord(targetId, turns.length, known.events + tail.events.length, importFormat),
        appendedTurns: turns.length - known.turns,
        appendedEvents: tail.events.length,
        ...(tail.droppedBoundaryResults > 0 ? { droppedBoundaryResults: tail.droppedBoundaryResults } : {}),
      }
    }

    // 轮数减少 → sourceShrunk 跳过报告（先于 eventsChanged 判定：轮数变少必然事件也变）
    if (turns.length < known.turns) {
      return {
        ...base,
        sessionId: targetId,
        status: 'already-imported',
        alreadyImported: true,
        sourceShrunk: true,
        __itemRecord: itemRecord(targetId, known.turns, known.events, importFormat),
      }
    }
    // 轮数相等：事件数也相等 = 内容未变（文件变了但转换结果一致，如新增畸形行）；
    // 事件数不同 = 既有轮次内变化，append-only 无法改写 → changedInPlace 跳过
    const eventsChanged = typeof known.events !== 'number' || events.length !== known.events
    if (eventsChanged) {
      return {
        ...base,
        sessionId: targetId,
        status: 'already-imported',
        alreadyImported: true,
        changedInPlace: true,
        __itemRecord: itemRecord(targetId, known.turns, typeof known.events === 'number' ? known.events : events.length, importFormat),
      }
    }
    return {
      ...base,
      sessionId: targetId,
      status: 'already-imported',
      alreadyImported: true,
      __itemRecord: itemRecord(targetId, known.turns, known.events, importFormat),
    }
  }

  // ── 无记录 / legacy（known 缺 turns 被上方守卫挡下）────────────────────────
  if (persisted.has(meta.id)) {
    const { owner, readable } = await sessionOwnerPath(ctx, meta.id)
    if (readable === false && !archived.has(meta.id)) {
      // 幽灵会话（issue #22）：id 仍占宿主内存索引（list 可见）但日志已读不到——
      // retract_import 后按引导手动删除工件目录的典型状态。视作陈旧条目，另铸
      // 后缀新 id 完整重导并明确报告 staleGhost（而不是抛 confusing 的
      // already exists / 幂等跳过）；幽灵原 id 留给宿主重启后自行消失。
      //（ghost 判定只看日志可读性：registry 反查的 owner 与工件是否存在无关。）
      const newId = mintForceSessionId(persisted, meta.id)
      return {
        ...base,
        sessionId: newId,
        status: 'imported',
        __action: 'create',
        __meta: { ...meta, id: newId },
        __events: events,
        __itemRecord: itemRecord(newId, turns.length, events.length, importFormat),
        staleGhost: { previous: meta.id, current: newId },
      }
    }
    if (!archived.has(meta.id) && (owner === null || owner === sourcePath)) {
      // 本文件旧版本导入的会话（标记 sourcePath 一致），或无标记的旧会话
      //（日志可读）：legacy 回填基线，幂等跳过、不重复落盘。局限：旧导入后、
      // registry 出现前的增长无法追溯（基线取当前转换），需要完整副本时用
      // force:true。
      return {
        ...base,
        status: 'already-imported',
        alreadyImported: true,
        backfilled: true,
        __itemRecord: itemRecord(meta.id, turns.length, events.length, importFormat),
      }
    }
    // 目标 id 由其它源文件导入（两路径共享同一源 sessionId），或目标会话已被归档
    //（仍占用 id、隐藏于分组界面）→ 后缀避让建新副本，双方历史都保留，绝不静默
    // 丢弃后导入文件的内容
    const newId = mintForceSessionId(persisted, meta.id)
    return {
      ...base,
      sessionId: newId,
      status: 'imported',
      __action: 'create',
      __meta: { ...meta, id: newId },
      __events: events,
      __itemRecord: itemRecord(newId, turns.length, events.length, importFormat),
    }
  }

  // 真首次导入
  return {
    ...base,
    status: 'imported',
    __action: 'create',
    __meta: meta,
    __events: events,
    __itemRecord: itemRecord(meta.id, turns.length, events.length, importFormat),
  }
}

/** 单会话源（claude/codex/cursor/gemini/reasonix）的完整决策：known 为 registry 记录
 * （null 表示无记录），converted 为 convertXxx 输出，stat 为本次 fs.stat（供记录指纹）。
 * budget 为 REQ-37 上下文预算（token 数）：落进记录供 budgetChanged 比对。archivedIds
 * 为已归档会话 id 集合（缺省从 ctx 读 workspaceRegistry；归档目标视作可重导）。 */
export async function decideSingle(ctx, { known, converted, stat, args, fingerprint, persisted, sourcePath, budget, archivedIds, importFormat }) {
  const decision = await decideItem(ctx, {
    known, converted, args, fingerprint, persisted, sourcePath,
    archivedIds: archivedIds ?? archivedSessionIds(ctx),
    importFormat,
  })
  if (decision.__itemRecord) {
    decision.__record = {
      kind: 'single',
      ...decision.__itemRecord,
      budget,
      sizeBytes: stat && typeof stat.size === 'number' ? stat.size : undefined,
      mtimeMs: stat && typeof stat.mtimeMs === 'number' ? stat.mtimeMs : undefined,
      version: stat && typeof stat.version === 'string' ? stat.version : undefined,
      args: fingerprint,
      importedAt: Date.now(),
    }
  }
  return decision
}

/** 多会话源（chatgpt/opencode）的逐文件决策：known 为 kind:'multi' 父记录（可 null），
 * items = [{ key, converted }]（key 为源会话 id），subTable 为子表名
 * （'conversations' / 'sessions'）。逐会话走 decideItem，汇总 results 与父记录。
 * budget 为 REQ-37 上下文预算（token 数）：落进父记录供 budgetChanged 比对。 */
export async function decideMulti(ctx, { known, items, stat, args, fingerprint, persisted, sourcePath, subTable, budget, archivedIds, importFormat }) {
  const archived = archivedIds ?? archivedSessionIds(ctx)
  const knownSubs = known && known[subTable] && typeof known[subTable] === 'object' ? known[subTable] : {}
  const results = []
  const creates = []
  const replaces = []
  const appends = []
  let imported = 0
  let alreadyImported = 0
  let appended = 0
  let skipped = 0
  let failed = 0
  const newSubs = {}
  for (const item of items) {
    const sub = knownSubs[item.key] || null
    let decision
    try {
      // 多会话源不消费单会话 sessionId 覆盖（chatgpt 忽略、opencode 无该参数）
      decision = await decideItem(ctx, {
        known: sub,
        converted: item.converted,
        args: { ...args, sessionId: undefined },
        fingerprint,
        persisted,
        sourcePath,
        archivedIds: archived,
        importFormat,
      })
    } catch (err) {
      failed++
      results.push({ path: sourcePath, status: 'failed', sessionId: 'import-' + item.key, error: String((err && err.message) || err) })
      continue
    }
    if (decision.__itemRecord) newSubs[item.key] = decision.__itemRecord
    // key + subTable 供 runDecision 在 create 撞 already-exists 另铸新 id 时同步父记录
    //（子表条目 / results 条目，issue #22）
    if (decision.__action === 'create') creates.push({ key: item.key, subTable, meta: decision.__meta, events: decision.__events })
    else if (decision.__action === 'replace') replaces.push({ key: item.key, subTable, targetId: decision.sessionId, meta: decision.__meta, events: decision.__events })
    else if (decision.__action === 'append') appends.push({ targetId: decision.__targetId, events: decision.__tailEvents })
    if (decision.status === 'imported') imported++
    else if (decision.status === 'replaced') imported++
    else if (decision.status === 'appended') appended++
    else if (decision.status === 'already-imported') alreadyImported++
    else skipped++
    const { __action, __meta, __events, __itemRecord, __targetId, __tailEvents, ...pub } = decision
    results.push({ path: sourcePath, ...pub })
  }
  const parentRecord = {
    kind: 'multi',
    [subTable]: newSubs,
    budget,
    sizeBytes: stat && typeof stat.size === 'number' ? stat.size : undefined,
    mtimeMs: stat && typeof stat.mtimeMs === 'number' ? stat.mtimeMs : undefined,
    version: stat && typeof stat.version === 'string' ? stat.version : undefined,
    args: fingerprint,
    importedAt: Date.now(),
  }
  return {
    __action: 'multi',
    __creates: creates,
    __replaces: replaces,
    __appends: appends,
    __record: parentRecord,
    total: items.length,
    imported,
    alreadyImported,
    appended,
    skipped,
    failed,
    results,
  }
}
