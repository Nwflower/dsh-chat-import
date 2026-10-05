// lib/imports.mjs — 增量续写：imports registry（源文件路径 → 导入记录）
//
// registry 落盘在 `$DSH_HOME/dsh-chat-import/imports.json`
// （`$DSH_HOME = env.DSH_HOME || ~/.dsh`）。格式：
//   { version: 1, imports: { <源文件绝对路径>: record } }
// record = { kind:'single'|'multi', dshId, turns, events, storedEvents?, copies?,
//            sizeBytes, mtimeMs?, version, args, budget?, importedAt }；multi 用
//            conversations / sessions 子表逐会话记录 { dshId, turns, events, ... }。
//    - `storedEvents` = 我们上次落盘后**实测**的 DSH 日志长度（不是转换口径的 events）：
//      重导时用它判定「DSH 侧会话是否被用户续聊过」（见 decideItem 的重导语义）。
//    - `copies` = 被后续重导取代的历史副本 [{ dshId, turns, events, storedEvents?,
//      importedAt }]：重导另铸副本时不丢账，撤回/清理/体检/挂载仍能枚举到。
// budget 为上下文预算（token 数，调用方解析后传入）：预算变化 → budgetChanged 跳过并
// 报告（同 argsChanged；判定见 lib/import-state.mjs）。
//
// 幂等键 = 源文件路径（多个源文件可共享同一源 sessionId，按 sessionId 去重会静默
// 丢历史）。用 node:fs/promises 原子写（temp + fsync + rename，复刻
// dsh-storage-json 的 writeAtomic）——不用 ctx.fs（沙箱会拒 ~/.dsh 写入）。
// 损坏/缺失容错：返回空 registry + warn。进程内 promise 链串行化写，避免并发覆盖。
//
// 上游缺口：sessionPersistence.remove(id) / fs.removeFile 未提供——
// 「撤回」只能移除 registry 记录 + 引导手动删工件（locate 报路径），绝不删会话。
//
// decideSingle / decideMulti 是单文件 / 多会话源的状态机核心：给定 registry 记录 +
// 本次转换结果 + stat + 参数，返回带 __action 的执行决策（执行在 lib/import-core.mjs
// 的 runDecision：create / append / rememberImport / 工作区挂接）。append 的 seq
// 游标以实测的 DSH 日志长度为准（用户在 DSH 续聊后 registry 的 events 过期）。
// 会话的导入归属以 registry 为权威：会话日志里不写 session/imported 标记（宿主事件
// 词汇表 fail-closed），旧日志里残留的标记只作兜底证据。
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import { writeAtomic } from './atomic-write.mjs'
import { tailSessionEvents } from './convert/index.mjs'
import { currentIgnores, ignoreDecisionFor, loadIgnores } from './ignore.mjs'
import { createBatchTally, tallyItem, batchSummary } from './import-batch.mjs'

export const REGISTRY_VERSION = 1

// 进程内写串行链：所有 registry 写依次执行，杜绝并发覆盖；单次失败不阻塞后续写
let writeChain = Promise.resolve()

/** registry 目录：`$DSH_HOME/dsh-chat-import`（`$DSH_HOME` 缺省 `~/.dsh`）。 */
export function resolveRegistryDir(env = process.env) {
  const base = env.DSH_HOME || join(homedir(), '.dsh')
  return join(base, 'dsh-chat-import')
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

/** dshId → 源身份反查（含子表 subKey）：忽略墓碑（归档/删工作区）需要精确定位
 * `路径#子表:子会话`，只回路径不够。查不到返回 null。 */
export function findSourceEntryByDshId(imports, dshId) {
  for (const entry of registryEntries(imports)) {
    if (entry.dshId === dshId) return { sourcePath: entry.sourcePath, subTable: entry.subTable, subKey: entry.subKey }
  }
  return null
}

/** dshId → 导入归属 sourcePath 反查（single + multi 子表 + 历史副本）；查不到返回 null。 */
export function findSourcePathByDshId(imports, dshId) {
  for (const entry of registryEntries(imports)) {
    if (entry.dshId === dshId) return entry.sourcePath
  }
  return null
}

// ── 记录 → 会话条目（单一枚举口径）────────────────────────────────────────────
// 一条源记录可能关联多个 DSH 会话：multi 源的每个子会话一条；single / multi 子项在
// 「重导另铸副本」后，历史副本收在该项的 copies 里。撤回 / 清理 / 体检 / 工作区挂载 /
// 面板历史全部走这一份展开逻辑（新增记录形态只改这里，各消费方不再各自展开）。
export function recordEntries(record) {
  const out = []
  if (!record || typeof record !== 'object') return out
  const pushCopies = (owner, subTable, subKey) => {
    const copies = Array.isArray(owner.copies) ? owner.copies : []
    for (const c of copies) {
      if (c && typeof c.dshId === 'string') {
        out.push({
          dshId: c.dshId, subTable, subKey, copy: true,
          turns: c.turns, events: c.events, importedAt: c.importedAt,
        })
      }
    }
  }
  if (record.kind === 'multi') {
    for (const table of ['conversations', 'sessions']) {
      const subs = record[table] && typeof record[table] === 'object' ? record[table] : {}
      for (const [subKey, sub] of Object.entries(subs)) {
        if (!sub || typeof sub.dshId !== 'string') continue
        out.push({ dshId: sub.dshId, subTable: table, subKey, copy: false, turns: sub.turns, events: sub.events, importedAt: record.importedAt })
        pushCopies(sub, table, subKey)
      }
    }
    return out
  }
  if (typeof record.dshId === 'string') {
    out.push({ dshId: record.dshId, copy: false, turns: record.turns, events: record.events, importedAt: record.importedAt })
    pushCopies(record, undefined, undefined)
  }
  return out
}

/** registry → 全部会话条目（带 sourcePath），撤回/清理/体检/挂载的统一枚举入口。 */
export function registryEntries(imports) {
  const out = []
  for (const [sourcePath, raw] of Object.entries(imports || {})) {
    for (const entry of recordEntries(unwrapRecord(raw))) out.push({ sourcePath, ...entry })
  }
  return out
}

/** 记录关联的全部 DSH 会话 id（当前 + 历史副本）。 */
export function recordSessionIds(record) {
  return recordEntries(record).map((e) => e.dshId)
}

/** 重导另铸副本时把被取代的会话收进 copies（append-only：历史会话永不丢账）。 */
export function supersededEntry(record, extra = {}) {
  const copies = Array.isArray(record && record.copies) ? record.copies.slice() : []
  if (record && typeof record.dshId === 'string') {
    copies.push({
      dshId: record.dshId,
      ...(typeof record.turns === 'number' ? { turns: record.turns } : {}),
      ...(typeof record.events === 'number' ? { events: record.events } : {}),
      ...(typeof record.storedEvents === 'number' ? { storedEvents: record.storedEvents } : {}),
      ...(typeof record.importedAt === 'number' ? { importedAt: record.importedAt } : {}),
      ...extra,
    })
  }
  return copies
}

async function writeRegistry(registryDir, data) {
  await mkdir(registryDir, { recursive: true })
  await writeAtomic(join(registryDir, 'imports.json'), JSON.stringify(data, null, 2) + '\n')
}

/** 读取 registry；等待未决写完成后读，保证读到最新落盘。顺带刷新忽略表快照
 *（ignore.mjs 的进程内快照供 decide* 同步读取，导入入口一处读取全覆盖）。 */
export async function loadImports(registryDir) {
  await writeChain.catch(() => {})
  // 批处理通道内：imports.json 首次读盘建快照、之后复用（省去每文件一次全量
  // JSON.parse），并把批内已 remember 的 key 以内存值投影出来——同路径多会话的
  // 序贯导入（先导 A 再导 B，B 的 decideSingle 要看到 A 的记录才能判续写）与批前
  // 行为一致。ignore 表不进快照：runDecision 批中会 forgetWorkspaceIgnore 写它，
  // 每次照常刷新，与批前「每文件重读 ignore」的新鲜度一致。
  const ch = batchChannelTop(registryDir)
  if (ch) {
    if (!ch.snapshot) ch.snapshot = await readRegistry(registryDir)
    const imports = { ...ch.snapshot.imports }
    for (const [key, record] of ch.pending) {
      // null = 批内已删除（removeImport）：投影里也不出现（快照里的旧记录一并隐去）
      if (record === null) delete imports[key]
      else imports[key] = record
    }
    await loadIgnores(registryDir)
    return { ...ch.snapshot, imports }
  }
  const data = await readRegistry(registryDir)
  await loadIgnores(registryDir)
  return data
}

// ── 批量导入的 registry 写合并（栈式批处理通道）────────────────────────
// 批量入口（importDirectory / 面板多选 / /import-all …）循环前 begin、finally end：
// 批内每个文件的 rememberImport 只记内存 pending，end 一次链上「重读新鲜 registry +
// 合并 pending keys + 单次原子写」。逐文件读-改-写（全量 parse + 全量 stringify +
// fsync）累计 O(N²)，批量入口必须走这条通道。
// 并发/嵌套安全：
//   * 通道是**栈**：批量入口可能嵌套（面板多选里混着目录来源，importDirectory 在
//     外层通道内再 begin 内层），begin 压栈、end 弹栈——内层 end 只提交内层 pending，
//     外层 pending 原样保留，绝不丢记录；
//   * end 合并前**重读**盘上最新 registry，只覆盖 pending 里的 key——批期间其它入口
//     经旧路径写入的其它 key 不受影响（旧路径的写也排在同一条 writeChain 上）；
//   * rememberImport 匹配的是栈顶**同 registryDir** 的通道；并发第二个批（不同异步
//     调用交错）各自 begin，同目录时共享栈顶——退化为后写覆盖 pending（同 key 最后
//     写者胜，与旧路径 read-modify-write 的最终写一致），不同目录互不影响。
// 批内不感知 removeImport / saveImports（撤回与整表覆盖不在导入批内发生）。
const batchChannels = []

function batchChannelTop(registryDir) {
  for (let i = batchChannels.length - 1; i >= 0; i--) {
    if (batchChannels[i].registryDir === String(registryDir)) return batchChannels[i]
  }
  return null
}

/** 开启批处理通道：本目录的 rememberImport 只进内存 pending，endRegistryBatch 统一提交。 */
export function beginRegistryBatch(registryDir) {
  batchChannels.push({ registryDir: String(registryDir), pending: new Map(), snapshot: null })
}

/** 提交栈顶批处理通道：链上重读新鲜 registry、合并 pending keys、单次原子写。
 * pending 为空（全跳过 / 批内无落盘）时不写盘。 */
export async function endRegistryBatch() {
  const ch = batchChannels.pop()
  if (!ch || ch.pending.size === 0) return
  // 嵌套同目录批：内层 keys 并入外层通道快照（若外层已建快照），外层后续的
  // loadImports 投影才能看到内层已提交的记录——否则外层批后半段会把内层刚导入的
  // 文件当成「无记录」重复导入。外层快照未建时无需合并（首次 loadImports 自会重读
  // 盘上已含内层提交的 registry）。
  const outer = batchChannels.length > 0 ? batchChannels[batchChannels.length - 1] : null
  if (outer && outer.registryDir === ch.registryDir && outer.snapshot && ch.snapshot) {
    for (const [key, record] of ch.pending) outer.snapshot.imports[key] = record
  }
  const run = writeChain.then(async () => {
    const data = await readRegistry(ch.registryDir)
    for (const [key, record] of ch.pending) {
      // null = 批内删除（转投的撤回链在批内 remove）：合并时执行删除，绝不把撤回的
      // 记录写回去（否则 registry 留下悬空记录，历史/重导语义都被污染）
      if (record === null) delete data.imports[key]
      else data.imports[key] = record
    }
    lastRegistrySnapshot = data
    await writeRegistry(ch.registryDir, data)
  })
  writeChain = run.catch(() => {})
  return run
}

/** 整体覆盖写（串行入链）。 */
export function saveImports(registryDir, data) {
  const run = writeChain.then(() => writeRegistry(registryDir, data))
  writeChain = run.catch(() => {})
  return run
}

/** 更新单个源路径的导入记录（串行入链：读 → 改 → 写）。批处理通道内只记内存
 * pending（endRegistryBatch 一次提交），批内不写盘——每文件一次 fsync 全量写是
 * 批量导入的 O(N²) 开销来源。 */
export function rememberImport(registryDir, key, record) {
  if (typeof key !== 'string' || key.length === 0) return Promise.resolve()
  const ch = batchChannelTop(registryDir)
  if (ch) {
    ch.pending.set(key, record)
    // lastRegistrySnapshot 同步投影：sessionOwnerPath 的 dshId 反查（decideItem 的
    // 「目标 id 由其它源文件导入」避让分支）在批内也要看到批内记录——旧路径经
    // readRegistry 隐式刷新快照，批内不写盘就会让同源两文件的序贯导入在第二个上
    // 退化为 legacy 回填跳过（owner=null），而不是避让另铸副本。
    if (lastRegistrySnapshot && lastRegistrySnapshot.imports) {
      if (record === null) delete lastRegistrySnapshot.imports[key]
      else lastRegistrySnapshot.imports[key] = record
    }
    return Promise.resolve()
  }
  const run = writeChain.then(async () => {
    const data = await readRegistry(registryDir)
    data.imports[key] = record
    await writeRegistry(registryDir, data)
  })
  writeChain = run.catch(() => {})
  return run
}

/**
 * 串行读-改-写单条记录：在写串行链内读取最新落盘的记录，fn(record) 返回新记录（写回）、
 * null（删除该键）或 undefined（不变、不写盘）；record 为该键当前的记录（不存在为
 * undefined），可就地修改后返回。链外先读、链内再整表覆盖写会吞掉期间其它入口写入的
 * 记录（丢更新），需要按现状改写记录的调用方（删除会话后修剪记录）一律走这里。
 * 批处理通道内对投影记录调用 fn，结果进 pending（同 rememberImport / removeImport）。
 */
export async function updateImport(registryDir, key, fn) {
  if (typeof key !== 'string' || key.length === 0) return
  const ch = batchChannelTop(registryDir)
  if (ch) {
    if (!ch.snapshot) {
      await writeChain.catch(() => {})
      ch.snapshot = await readRegistry(registryDir)
    }
    const projected = ch.pending.has(key) ? ch.pending.get(key) : ch.snapshot.imports[key]
    // 投影记录与快照共享对象：交给 fn 一份深拷贝，fn 就地修改不会污染快照
    const next = fn(projected === null || projected === undefined ? undefined : JSON.parse(JSON.stringify(projected)))
    if (next === undefined) return
    ch.pending.set(key, next)
    if (lastRegistrySnapshot && lastRegistrySnapshot.imports) {
      if (next === null) delete lastRegistrySnapshot.imports[key]
      else lastRegistrySnapshot.imports[key] = next
    }
    return
  }
  const run = writeChain.then(async () => {
    const data = await readRegistry(registryDir)
    const has = Object.prototype.hasOwnProperty.call(data.imports, key)
    const next = fn(has ? data.imports[key] : undefined)
    if (next === undefined || (next === null && !has)) return
    if (next === null) delete data.imports[key]
    else data.imports[key] = next
    await writeRegistry(registryDir, data)
  })
  writeChain = run.catch(() => {})
  return run
}

/** 移除单个源路径的导入记录（串行入链：读 → 删 → 写）。键不存在幂等返回
 *（不写盘）。「撤回」只移除 registry 记录，不删会话/工件（平台无
 * sessionPersistence.remove / fs.removeFile，删除只能引导手动做）。
 * 批处理通道内只记内存 pending（null = 删除），endRegistryBatch 合并时执行删除——
 * 否则批内撤回后批末合并会把记录写回去（转投的导入+撤回在同一批内，悬空记录会
 * 污染历史/重导语义）。 */
export function removeImport(registryDir, key) {
  if (typeof key !== 'string' || key.length === 0) return Promise.resolve()
  const ch = batchChannelTop(registryDir)
  if (ch) {
    ch.pending.set(key, null)
    return Promise.resolve()
  }
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

// ── 宿主持久化 API 适配 ──────────────────────────────────────────────────────
// sessionPersistence 有两套形状，插件用到的三个面各不相同：
//   句柄式（当前宿主）：list() → [{ header, revision, sizeBytes }]；读走 open(id, 'read')
//                      → handle.read(offset, length) → { events }；create(header) 返回写
//                      句柄，续写走 handle.append(events)；
//   直写式（旧宿主）  ：list() → header 数组；readFrom(id, fromSeq) / inspect(id) 读事件；
//                      create(header) 无返回值，续写走 append(id, events)。
// 只在本层认两套形状，其余模块继续用「列会话 / 读事件 / 建会话」的语义。

/** list() 的一个元素 → 会话 header（新旧两种形状都认）。 */
export function persistedHeaderOf(entry) {
  if (!entry || typeof entry !== 'object') return undefined
  return entry.header && typeof entry.header === 'object' ? entry.header : entry
}

/** 列出宿主里的会话 header（list 不可用 / 读盘失败 → 空数组）。 */
export async function listPersistedHeaders(ctx) {
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof sp.list !== 'function') return []
  try {
    const entries = await sp.list()
    return (Array.isArray(entries) ? entries : []).map(persistedHeaderOf).filter(Boolean)
  } catch {
    return []
  }
}

/** 持久化服务是否提供「读事件」面（新旧任一形态）。 */
export function canReadSessionEvents(sp) {
  return !!sp && (typeof sp.readFrom === 'function' || typeof sp.open === 'function')
}

/** 读会话「元数据 + 事件」（fromSeq 起），新旧宿主统一形态。读不到 / 服务不可用 →
 * null，调用方保守处理。新宿主没有 readFrom，用 open(id,'read') 的写句柄：meta 取
 * handle.header，事件取 handle.read()。读句柄关闭失败不影响已读到的事件，只上报。 */
export async function readSessionRecord(ctx, id, fromSeq = 0) {
  const sp = ctx.get('sessionPersistence')
  if (!sp) return null
  if (typeof sp.readFrom === 'function') {
    try {
      const out = await sp.readFrom(id, fromSeq)
      return out && Array.isArray(out.events) ? { meta: out.meta, events: out.events } : null
    } catch {
      return null
    }
  }
  if (typeof sp.open !== 'function') return null
  let handle
  try {
    handle = await sp.open(id, 'read')
    const out = await handle.read(fromSeq, Number.MAX_SAFE_INTEGER)
    return out && Array.isArray(out.events) ? { meta: handle.header, events: out.events } : null
  } catch {
    return null
  } finally {
    if (handle && typeof handle.close === 'function') {
      try {
        await handle.close()
      } catch (err) {
        // 释放读句柄失败不影响已读到的事件，但也不静默：宿主租约可能滞留
        console.error('会话读句柄关闭失败（' + id + '）: ' + String((err && err.message) || err))
      }
    }
  }
}

/** 读会话事件（fromSeq 起）；语义同 {@link readSessionRecord}，只取事件面。 */
export async function readSessionEvents(ctx, id, fromSeq = 0) {
  const record = await readSessionRecord(ctx, id, fromSeq)
  return record === null ? null : record.events
}

/** 写入一个新会话（create + 落事件），兼容新旧两套写入 API：
 * 新宿主 create(header) 返回写句柄，事件经 handle.append(events) 落盘、flush 建持久化
 * 屏障，最后关句柄释放写租约；旧宿主 create(header) 无返回值，续写走 append(id, events)。 */
export async function writeSession(ctx, header, events) {
  const sp = ctx.get('sessionPersistence')
  if (!sp || typeof sp.create !== 'function') throw new Error('sessionPersistence 不可用（缺少 create）')
  const handle = await sp.create(header)
  if (handle && typeof handle.append === 'function') {
    try {
      await handle.append(events)
      if (typeof handle.flush === 'function') await handle.flush()
    } finally {
      if (typeof handle.close === 'function') {
        try {
          await handle.close()
        } catch (err) {
          // 数据已 flush；关句柄失败只影响写租约释放，上报而不改判导入结果
          console.error('会话写句柄关闭失败（' + header.id + '）: ' + String((err && err.message) || err))
        }
      }
    }
    return
  }
  if (typeof sp.append === 'function') {
    await sp.append(header.id, events)
    return
  }
  throw new Error('sessionPersistence 写入面不可用（create 未返回写句柄，且没有 append(id, events)）')
}

/** 已持久化会话 id 快照（就地可增，供批量内避让）。 */
export async function listPersistedIds(ctx) {
  const headers = await listPersistedHeaders(ctx)
  return new Set(headers.map((h) => h && h.id).filter((id) => typeof id === 'string' && id))
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

/** 已存储日志事件数：宿主日志的实际长度是权威续写游标（用户在 DSH 续聊后
 * registry 的 events 会过期）；读不到返回 null → 调用方保守跳过续写。 */
export async function storedEventCount(ctx, dshId) {
  const events = await readSessionEvents(ctx, dshId, 0)
  return events === null ? null : events.length
}

/** 现有会话的导入归属路径：imports registry 反查优先，旧日志里残留的 session/imported
 * 标记兜底（registry 快照未含的边缘态）。readable 区分「日志可读」与「日志读不到」
 *（后者是撤回后工件被删、宿主内存索引仍残留 id 的幽灵会话信号）：
 *   { owner: sourcePath|null, readable: true|false|null }
 * readable=null 表示 sessionPersistence.inspect 不可用（调用方保守按可读处理）。 */
async function sessionOwnerPath(ctx, dshId) {
  const sp = ctx.get('sessionPersistence')
  let owner = findSourcePathByDshId(lastRegistrySnapshot.imports, dshId)
  if (!canReadSessionEvents(sp)) return { owner: owner ?? null, readable: null }
  const events = await readSessionEvents(ctx, dshId, 0)
  if (events === null) {
    // 读不到日志（工件已删 / 后端瞬断）：归属以 registry 反查为准，按不可读处理
    return { owner: owner ?? null, readable: false }
  }
  const first = events[0]
  if (!owner && first && first.type === 'session/imported' && first.data && typeof first.data.sourcePath === 'string') {
    owner = first.data.sourcePath
  }
  return { owner: owner ?? null, readable: true }
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
 * （目标 id 是撞 id 后的后缀避让形态 <sessionId>-<n> 时视为同一会话，不重复建副本）。 */
export function isSessionIdChange(args, targetId) {
  return typeof args.sessionId === 'string'
    && args.sessionId !== targetId
    && !targetId.startsWith(args.sessionId + '-')
}

// ── 单条目状态机核心（single 源的整文件 = 一条；multi 源的每个会话 = 一条）────
//
// known 为 null 时：首次导入 / legacy 回填 / 目标 id 被其它源占用（后缀避让）。
// 已知记录时（重导语义，docs/architecture.md D13）：force 或显式 sessionId 变更 →
// 新 id 完整副本；轮数增长且 DSH 侧**未续聊**（实测日志长度 == storedEvents）→
// append 尾部；轮数增长但已被续聊 / 无基线 → 新 id 副本（把旧会话收进 copies）；
// 轮数增长但日志被截短 → storedShrunk 跳过；轮数相等 → 事件变化 = changedInPlace
// 跳过（append-only 不能改写已落盘轮次）；轮数减少 → sourceShrunk 跳过报告。
//
// 返回：{ ...公开字段, __action:'create'|'append'|'replace', __meta, __events,
//        __targetId, __tailEvents, __itemRecord }——__ 前缀为执行载荷，runDecision
// 剥离；跳过类返回（sourceShrunk / storedShrunk / changedInPlace / backfilled /
// 幂等跳过）不产出 __action 字段。
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
    // 裁剪上报随结果透出（budget/估算/裁剪计数；预算来源由 markTrimmedSource 并入 source）
    ...(converted.trimmed ? { trimmed: converted.trimmed } : {}),
    // Reasonix WAL 合并 / 压缩导入报告透出（compacted = 日志里有原生压缩检查点，
    // compactions = 检查点数量）
    ...(converted.walMerged ? { walMerged: true, ...(typeof converted.walRecords === 'number' ? { walRecords: converted.walRecords } : {}) } : {}),
    ...(converted.compacted ? { compacted: true } : {}),
    ...(typeof converted.compactions === 'number' ? { compactions: converted.compactions } : {}),
    // 源压缩只有边界、没有摘要正文（Kimi 旧格式 wire）→ 退化为切窗口，显式点名前段已丢
    ...(converted.compactionSummaryMissing ? { compactionSummaryMissing: true } : {}),
  }
  // itemRecord 的 format = 来源格式（'claude' / 'chatgpt' / …）：来源归属由 registry 记录
  // 承载（会话日志不写导入标记；缺 format 的记录按未知来源处理）。extra 承载
  // storedEvents / copies（重导语义，见模块头与 decideItem 增长分支）。
  const itemRecord = (dshId, t, ev, format, extra = {}) => ({
    dshId,
    turns: t,
    events: ev,
    ...(format ? { format } : {}),
    ...extra,
  })

  // 记录指向的会话已不存在（被删 / DSH_HOME 迁移 / 日志被手工清理）或被归档（隐藏但仍占
  // id）→ 视作无记录重导：不能按 already-imported 跳过，走下方「无记录」分支重建（归档会话
  // 保留，建后缀新副本）。单会话源的记录在 loadKnownRecord（lib/import-state.mjs）已按同一
  // 口径过滤；多会话源的子会话记录由 decideMulti 原样传入，在这里过滤。日志缺失时在条目里
  // 点名 staleRegistry（失败要大声：避免「registry 说有、宿主里没有」被静默重建）；输出
  // schema 见 lib/tools/schema.mjs。
  if (known && (!persisted.has(known.dshId) || archived.has(known.dshId))) {
    if (!persisted.has(known.dshId) && typeof known.dshId === 'string') {
      base.staleRegistry = { previous: known.dshId, reason: 'session-log-missing' }
    }
    known = null
  }

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
        __itemRecord: itemRecord(targetId, turns.length, events.length, importFormat, { copies: known.copies }),
      }
    }
    // 显式 sessionId 变更（或源 sessionId 变更）→ 副本语义；「targetId 由避让产生
    // 且显式 id 是其前缀」视为同一会话（撞 id 后的后缀避让），不重复建副本
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
        __itemRecord: itemRecord(newId, turns.length, events.length, importFormat, { copies: supersededEntry(known) }),
        reimported: { previous: targetId, current: newId, reason: explicitChanged ? 'session-id-changed' : 'forced' },
      }
    }

    // 源增长：先判「DSH 侧这条会话还是不是我们上次写完的样子」——storedEvents 是上次
    // 落盘后实测的日志长度（缺该字段的记录 = 无基线）：
    //   相等 → 纯镜像，续写尾部（既有的增量导入）；
    //   大于 → 用户已在 DSH 里续聊过，再往里追加导入轮次会污染他自己的对话 → 另铸副本；
    //   小于 → 日志被外部截短（迁移 / 手工清理）→ 不写，跳过并上报；
    //   无基线 → 不可判定 → 保守另铸副本一次并在落盘后回填基线。
    // 用户心智：重复导入一个对话 = 要一份新的副本，而不是让插件改写已有会话。
    if (turns.length > known.turns) {
      const fromSeq = await storedEventCount(ctx, targetId)
      if (fromSeq === null) {
        // 连日志长度都读不到（后端不可用）：绝不冒险 append 错误 seq，也不复制会话
        return { ...base, sessionId: targetId, status: 'already-imported', alreadyImported: true, appendedSkipped: 'stored-length-unknown' }
      }
      const baseline = typeof known.storedEvents === 'number' ? known.storedEvents : null
      if (baseline === null || fromSeq > baseline) {
        const reason = baseline === null ? 'baseline-missing' : 'continued-in-dsh'
        const newId = persisted.has(meta.id) ? mintForceSessionId(persisted, meta.id) : meta.id
        return {
          ...base,
          sessionId: newId,
          status: 'imported',
          __action: 'create',
          __meta: { ...meta, id: newId },
          __events: events,
          __itemRecord: itemRecord(newId, turns.length, events.length, importFormat, { copies: supersededEntry(known) }),
          reimported: { previous: targetId, current: newId, reason },
        }
      }
      if (fromSeq < baseline) {
        return { ...base, sessionId: targetId, status: 'already-imported', alreadyImported: true, storedShrunk: true }
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
        // 事件数比对」用；storedEvents 是追加后的实测长度（fromSeq 是追加前的实测值，
        // 宿主按我们给的 seq 连续追加，故直接相加，不再多读一次日志）。
        __itemRecord: itemRecord(targetId, turns.length, known.events + tail.events.length, importFormat, {
          copies: known.copies,
          storedEvents: fromSeq + tail.events.length,
        }),
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
      // 幽灵会话：id 仍占宿主内存索引（list 可见）但日志已读不到——
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
 * budget 为 上下文预算（token 数）：落进记录供 budgetChanged 比对。archivedIds
 * 为已归档会话 id 集合（缺省从 ctx 读 workspaceRegistry；归档目标视作可重导）。 */
export async function decideSingle(ctx, { known, converted, stat, args, fingerprint, persisted, sourcePath, budget, archivedIds, importFormat }) {
  // 忽略墓碑：命中即跳过，registry 记录原地保留（解除后可继续增量）。
  // force 是显式越权导入（用户主动重导），不解除墓碑（解除走 /unignore）。
  let restoreWorkspace
  if (args.force !== true) {
    const verdict = ignoreDecisionFor({
      ignores: currentIgnores(),
      sourcePath,
      cwd: converted && converted.meta && typeof converted.meta.cwd === 'string' ? converted.meta.cwd : undefined,
    })
    if (verdict.skipped) {
      return {
        sessionId: converted && converted.meta ? converted.meta.id : undefined,
        status: 'ignored',
        // 结构化原因码（archived / retracted / workspace-deleted）与合并串并存：面板 / 工具层
        // 据此点名「被什么挡住」并给出出路，不再只报一句「跳过」把墓碑藏进计数里。
        reason: verdict.reason,
        skipReason: 'ignored:' + verdict.reason,
        turns: converted && Array.isArray(converted.turns) ? converted.turns.length : 0,
        messages: converted ? converted.messages : 0,
        toolCalls: converted ? converted.toolCalls : 0,
        skipped: converted ? converted.skipped : 0,
        alreadyImported: false,
      }
    }
    if (verdict.restoreWorkspace) restoreWorkspace = verdict.restoreWorkspace
  }
  const decision = await decideItem(ctx, {
    known, converted, args, fingerprint, persisted, sourcePath,
    archivedIds: archivedIds ?? archivedSessionIds(ctx),
    importFormat,
  })
  if (restoreWorkspace) decision.__restoreWorkspaces = [restoreWorkspace]
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
 * budget 为 上下文预算（token 数）：落进父记录供 budgetChanged 比对。 */
export async function decideMulti(ctx, { known, items, stat, args, fingerprint, persisted, sourcePath, subTable, budget, archivedIds, importFormat }) {
  const archived = archivedIds ?? archivedSessionIds(ctx)
  const knownSubs = known && known[subTable] && typeof known[subTable] === 'object' ? known[subTable] : {}
  const results = []
  const creates = []
  const replaces = []
  const appends = []
  const tally = createBatchTally()
  // 显式选择只覆盖源的一部分：更新所选会话时保留父记录中的其他已知子会话。
  // 否则先选 A 再选 B 会让 A 从 imports.json 消失，历史/撤回无法定位。
  const selective = (Array.isArray(args.sessionIds) && args.sessionIds.length > 0)
    || (typeof args.zcodeId === 'string' && args.zcodeId !== '')
  const newSubs = selective ? { ...knownSubs } : {}
  // 忽略墓碑命中的子会话（归档 / 删工作区 / 撤回）：跳过并保留其已知记录，
  // 避免父记录整段子表被本次结果覆盖时丢账；工作区恢复信号回报给 runDecision。
  const restores = new Set()
  for (const item of items) {
    const sub = knownSubs[item.key] || null
    if (args.force !== true) {
      const verdict = ignoreDecisionFor({
        ignores: currentIgnores(),
        sourcePath,
        subTable,
        subKey: item.key,
        cwd: item.converted && item.converted.meta && typeof item.converted.meta.cwd === 'string' ? item.converted.meta.cwd : undefined,
      })
      if (verdict.skipped) {
        if (sub) newSubs[item.key] = sub
        const ignored = {
          path: sourcePath,
          status: 'ignored',
          sessionId: sub && typeof sub.dshId === 'string' ? sub.dshId : 'import-' + item.key,
          reason: verdict.reason,
        }
        tallyItem(tally, ignored)
        results.push(ignored)
        continue
      }
      if (verdict.restoreWorkspace) restores.add(verdict.restoreWorkspace)
    }
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
      const failedEntry = { path: sourcePath, status: 'failed', sessionId: 'import-' + item.key, error: String((err && err.message) || err) }
      tallyItem(tally, failedEntry)
      results.push(failedEntry)
      continue
    }
    if (decision.__itemRecord) newSubs[item.key] = decision.__itemRecord
    // key + subTable 供 runDecision 在 create 撞 already-exists 另铸新 id 时同步父记录
    //（子表条目 / results 条目）
    if (decision.__action === 'create') creates.push({ key: item.key, subTable, meta: decision.__meta, events: decision.__events })
    else if (decision.__action === 'replace') replaces.push({ key: item.key, subTable, targetId: decision.sessionId, meta: decision.__meta, events: decision.__events })
    else if (decision.__action === 'append') appends.push({ targetId: decision.__targetId, events: decision.__tailEvents })
    tallyItem(tally, decision)
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
    // WAL 边车签名（见 sqliteWalSig）：「源未变」短路径除主文件指纹外还要求它一致，
    // 否则 WAL 未 checkpoint 的新会话会被误判 already-imported 漏导
    ...(stat && typeof stat.walSig === 'string' ? { walSig: stat.walSig } : {}),
    args: fingerprint,
    importedAt: Date.now(),
  }
  return {
    __action: 'multi',
    __creates: creates,
    __replaces: replaces,
    __appends: appends,
    __record: parentRecord,
    ...(restores.size > 0 ? { __restoreWorkspaces: [...restores] } : {}),
    ...batchSummary(tally, items.length, results),
  }
}

// SQLite 库的 WAL 边车签名（「源未变」短路径的指纹补充）：WAL 模式下新写入只落 <db>-wal，
// 主文件在 checkpoint 前 mtime/size 不变——只比主文件会把库内容已变误判为未变
//（新会话永远不会被增量导入）。取 -wal 的 size + mtimeMs（缺 mtimeMs 的 stat 实现回
// 退 version）；文件缺失返回 ''（与存在时的任何签名都不同）。stat 抛错按缺失处理。
export async function sqliteWalSig(ctx, path) {
  try {
    const target = await ctx.fs.resolve(path + '-wal')
    const st = target ? await ctx.fs.stat(target) : null
    if (!st || st.type !== 'file') return ''
    return String(st.size ?? '') + ':' + String(st.mtimeMs ?? st.version ?? '')
  } catch {
    return ''
  }
}
