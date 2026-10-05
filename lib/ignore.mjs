// lib/ignore.mjs — 忽略（墓碑）表：让已删除 / 已归档 / 被删工作区的源不再被重导。
//
// 落盘 `$DSH_HOME/dsh-chat-import/ignores.json`（与 imports.json 同目录）：
//   { version: 1,
//     sources:    { "<sourcePath>" | "<sourcePath>#<subTable>:<subKey>":
//                   { reason, dshId?, subTable?, subKey?, cwd?, at } },
//     workspaces: { "<规范化 cwd>": { at, sessionKeys: [...] } } }
//
// reason 语义（决定谁能解除）：
//   'archived'          会话被 DSH 归档 → 取消归档时自动解除（ignore-watch）
//   'retracted'         用户显式撤回/删除（retract / purge）→ 永久，只能 /unignore
//   'workspace-deleted' 工作区被删 → 该工作区出现新会话或取消归档时随工作区一起恢复
//
// 判定规则（decideSingle / decideMulti 经 currentIgnores() 同步读取）：
//   1. 源路径本身或 `路径#子表:子会话` 命中 sources → 跳过（force 可越权导入，不解除墓碑）
//   2. cwd 命中 workspaces：
//      - 该源的 key 在 sessionKeys（删工作区时已存在的会话）→ 跳过
//      - 不在 → 视为「工作区出现新会话」：不跳过，并在决策里回报 restoreWorkspace
//        （runDecision 落盘时解除该工作区记录；旧会话的 'workspace-deleted' 墓碑保留）
//
// 与 imports.mjs 的关系：本模块不反向 import imports.mjs（避免环）；loadImports()
// 顺带刷新本模块的进程内快照 lastIgnoreSnapshot，导入决策链无需另传上下文。
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import { writeAtomic } from './atomic-write.mjs'

export const IGNORE_VERSION = 1
export const IGNORE_REASONS = Object.freeze(['archived', 'retracted', 'workspace-deleted'])

/** 忽略表文件路径。 */
export function resolveIgnoreFile(registryDir) {
  return join(registryDir, 'ignores.json')
}

/** 单源忽略键：无子会话 = 源路径；多会话源 = `路径#子表:子会话`。 */
export function sourceIgnoreKey(sourcePath, subTable, subKey) {
  if (typeof subKey !== 'string' || subKey === '') return sourcePath
  return sourcePath + '#' + (subTable || 'sessions') + ':' + subKey
}

/** cwd 归一化（分隔符统一 + 小写；工作区路径在 Windows 上大小写不敏感）。 */
export function normalizeCwd(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return ''
  return cwd.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** 空忽略表。 */
export function emptyIgnores() {
  return { version: IGNORE_VERSION, sources: {}, workspaces: {} }
}

// 进程内快照：loadImports() 刷新；decide* 同步读取（与 imports.mjs 的
// lastRegistrySnapshot 同一模式，避免给每个调用点加参数）。
let lastIgnoreSnapshot = emptyIgnores()

// 写串行链：与 imports.mjs 一样按读-改-写串行，绝不并发覆盖。
let writeChain = Promise.resolve()


async function readIgnores(registryDir) {
  try {
    const parsed = JSON.parse(await readFile(resolveIgnoreFile(registryDir), 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const data = {
        version: IGNORE_VERSION,
        sources: parsed.sources && typeof parsed.sources === 'object' && !Array.isArray(parsed.sources) ? parsed.sources : {},
        workspaces: parsed.workspaces && typeof parsed.workspaces === 'object' && !Array.isArray(parsed.workspaces) ? parsed.workspaces : {},
      }
      lastIgnoreSnapshot = data
      return data
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      // 损坏按空表处理：墓碑丢失只影响「不再重导」的便利性，绝不阻塞导入主流程
      console.warn('[dsh-chat-import] ignores registry 损坏，按空表处理：' + String((err && err.message) || err))
    }
  }
  lastIgnoreSnapshot = emptyIgnores()
  return lastIgnoreSnapshot
}

/** 读取忽略表并刷新进程内快照；等待未决写完成后读，保证读到最新落盘。 */
export async function loadIgnores(registryDir) {
  await writeChain.catch(() => {})
  return readIgnores(registryDir)
}

/** 决策链同步读取的快照（最后一次 loadIgnores 的结果）。 */
export function currentIgnores() {
  return lastIgnoreSnapshot
}

function mutate(registryDir, fn) {
  const run = writeChain.then(async () => {
    const data = await readIgnores(registryDir)
    const changed = await fn(data)
    if (changed !== false) {
      await mkdir(registryDir, { recursive: true })
      await writeAtomic(resolveIgnoreFile(registryDir), JSON.stringify(data, null, 2) + '\n')
      lastIgnoreSnapshot = data
    }
  })
  writeChain = run.catch(() => {})
  return run
}

/** 写入/覆盖一条源忽略（键已存在则覆盖 reason 与时间）。 */
export function rememberIgnore(registryDir, entry) {
  if (!entry || typeof entry.key !== 'string' || entry.key === '') return Promise.resolve()
  return mutate(registryDir, (data) => {
    data.sources[entry.key] = {
      reason: IGNORE_REASONS.includes(entry.reason) ? entry.reason : 'retracted',
      at: typeof entry.at === 'number' ? entry.at : Date.now(),
      ...(entry.dshId ? { dshId: entry.dshId } : {}),
      ...(entry.subTable ? { subTable: entry.subTable } : {}),
      ...(entry.subKey ? { subKey: entry.subKey } : {}),
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
    }
    return true
  })
}

/** 移除一条源忽略（键不存在幂等返回，不写盘）。 */
export function forgetIgnore(registryDir, key) {
  if (typeof key !== 'string' || key === '') return Promise.resolve()
  return mutate(registryDir, (data) => {
    if (!Object.prototype.hasOwnProperty.call(data.sources, key)) return false
    delete data.sources[key]
    return true
  })
}

/** 按 dshId 移除所有源忽略（取消归档的对称操作）。 */
export function forgetIgnoreByDshId(registryDir, dshId) {
  if (typeof dshId !== 'string' || dshId === '') return Promise.resolve()
  return mutate(registryDir, (data) => {
    let changed = false
    for (const [key, entry] of Object.entries(data.sources)) {
      if (entry && entry.dshId === dshId) {
        delete data.sources[key]
        changed = true
      }
    }
    return changed
  })
}

/** 记录一个被删工作区：路径 + 删除时已存在的源键集合（新键出现 = 工作区恢复信号）。 */
export function rememberWorkspaceIgnore(registryDir, cwd, sessionKeys = []) {
  const norm = normalizeCwd(cwd)
  if (norm === '') return Promise.resolve()
  return mutate(registryDir, (data) => {
    const known = new Set(Array.isArray(sessionKeys) ? sessionKeys : [])
    data.workspaces[norm] = { at: Date.now(), sessionKeys: [...known] }
    return true
  })
}

/** 解除一个工作区忽略（新会话出现 / 取消归档时的工作区恢复），返回被解除的路径。 */
export function forgetWorkspaceIgnore(registryDir, cwd) {
  const norm = normalizeCwd(cwd)
  if (norm === '') return Promise.resolve(false)
  return mutate(registryDir, (data) => {
    if (!Object.prototype.hasOwnProperty.call(data.workspaces, norm)) return false
    delete data.workspaces[norm]
    return true
  })
}

/** 一条源忽略是否命中给定作用域（先整源键、后子会话键）。 */
export function findIgnore(ignores, sourcePath, subTable, subKey) {
  if (!ignores || typeof ignores !== 'object') return undefined
  const sources = ignores.sources && typeof ignores.sources === 'object' ? ignores.sources : {}
  if (Object.prototype.hasOwnProperty.call(sources, sourcePath)) return sources[sourcePath]
  const scoped = sourceIgnoreKey(sourcePath, subTable, subKey)
  if (scoped !== sourcePath && Object.prototype.hasOwnProperty.call(sources, scoped)) return sources[scoped]
  return undefined
}

/** 给定 cwd 的工作区忽略记录。 */
export function findWorkspaceIgnore(ignores, cwd) {
  const norm = normalizeCwd(cwd)
  if (norm === '' || !ignores || typeof ignores !== 'object') return undefined
  const workspaces = ignores.workspaces && typeof ignores.workspaces === 'object' ? ignores.workspaces : {}
  return Object.prototype.hasOwnProperty.call(workspaces, norm) ? workspaces[norm] : undefined
}

/**
 * 判定一条导入源是否被忽略。
 * @returns {{ skipped: true, reason: string, key: string } | { skipped: false, restoreWorkspace?: string }}
 */
export function ignoreDecisionFor({ ignores, sourcePath, subTable, subKey, cwd }) {
  const entry = findIgnore(ignores, sourcePath, subTable, subKey)
  if (entry) return { skipped: true, reason: typeof entry.reason === 'string' ? entry.reason : 'retracted', key: sourceIgnoreKey(sourcePath, subTable, subKey) }
  const workspace = findWorkspaceIgnore(ignores, cwd)
  if (workspace) {
    const key = sourceIgnoreKey(sourcePath, subTable, subKey)
    const known = Array.isArray(workspace.sessionKeys) ? workspace.sessionKeys : []
    if (known.includes(key)) return { skipped: true, reason: 'workspace-deleted', key }
    // 工作区删除后出现的新会话：放行并把「恢复工作区」回报给调用方
    return { skipped: false, restoreWorkspace: normalizeCwd(cwd) }
  }
  return { skipped: false }
}

/** 列出全部忽略（命令面显示用）。 */
export function listIgnores(ignores) {
  const out = []
  for (const [key, entry] of Object.entries(ignores?.sources || {})) {
    out.push({ kind: 'source', key, ...entry })
  }
  for (const [cwd, entry] of Object.entries(ignores?.workspaces || {})) {
    out.push({ kind: 'workspace', key: cwd, ...entry })
  }
  return out
}

// 供 ignore-watch 复用（避免各模块各写一份 homedir 解析）
export function defaultRegistryDir(env = process.env) {
  const base = env.DSH_HOME || join(homedir(), '.dsh')
  return join(base, 'dsh-chat-import')
}
