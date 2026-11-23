// lib/sources/teleagent.mjs — TeleAgent SQLite 历史库读取与导入编排（opencode 派生专属）
//
// TeleAgent（星辰超级智能体，中电信 TeleAI 桌面客户端）的会话库是 opencode 同构的
// SQLite 三表（session/message/part，用户实测 .schema），落点为 XDG 风格
// 的多账户目录：~/.local/share/TeleAgent/users/<账户ID>/teleagent.db（多账户按账户
// 分目录、各一个库；Windows 上同样走 ~/.local/share）。读取/导入/编排完全复用
// lib/sources/opencode.mjs 的通用实现，本文件只收 TeleAgent 专属差异：
//   - 库文件名 teleagent.db（目录模式定位）
//   - 默认根是 users/ 目录（多账户）→ 发现层枚举账户目录，逐个 DB 进扫描
//   - provider 标签 teleagent（lib/convert/teleagent.mjs）
//   - session 表无 model 列的 schema 由 readOpencodeDb 按 PRAGMA 探测自动兼容
//     （与 mimocode 同形态）
//
// 保持「每源一个编排文件」的仓库惯例（对照 lib/sources/mimocode.mjs / lib/sources/zcode.mjs），
// opencode 编排文件不含任何 TeleAgent 专属分支。

import { join } from 'node:path'
import { importOpencodeFile, previewOpencodeFile, resolveDbInDirectory, readOpencodeDb } from './opencode.mjs'
import { beginRegistryBatch, endRegistryBatch, listPersistedIds } from '../imports.mjs'
import { createBatchTally, tallyBatch, batchSummary, failedItem } from '../import-batch.mjs'
import {
  convertTeleagentJson,
  teleagentDataDir,
  teleagentUsersDir,
  teleagentDbPath,
  TELEAGENT_DB_NAME,
  TELEAGENT_USERS_DIR,
} from '../convert/index.mjs'

// 路径解析与常量住在 lib/convert/teleagent.mjs（纯函数，发现层 defaultRoots 与导入层共用
// 同一份）；re-export 保持本文件的既有导出面（测试 / 调用方经这里取）。
export {
  teleagentDataDir,
  teleagentUsersDir,
  teleagentDbPath,
  TELEAGENT_DB_NAME,
  TELEAGENT_USERS_DIR,
}

// TeleAgent 历史库（SQLite）→ 中间会话 JSON 数组：复用 opencode 读取器，全量导入
//（不剔除任何会话；报告者样本里未观察到后台任务会话，如后续出现再按 mimocode 的
// filter 模式补）。fullHistory 语义与 opencode 一致。
export function readTeleagentDb(dbPath, options = {}) {
  return readOpencodeDb(dbPath, { fullHistory: options.fullHistory === true })
}

// TeleAgent 在 opencode 编排上的差异参数（导入与预览共用）：convertTeleagentJson 让 provider
// 标签为 teleagent（来源标题钉「TeleAgent · 话题」）。
const TELEAGENT_OPTIONS = { convert: convertTeleagentJson, sourceLabel: 'teleagent', importFormat: 'teleagent' }

// TeleAgent 单库导入：复用 opencode 编排（importOpencodeFile），恒返回批量形态。
export async function importTeleagentFile(ctx, target, args, options = {}) {
  return importOpencodeFile(ctx, target, args, { ...options, ...TELEAGENT_OPTIONS })
}

async function statFile(ctx, path) {
  try {
    const target = await ctx.fs.resolve(path)
    const st = await ctx.fs.stat(target)
    return st && st.type === 'file' ? target : null
  } catch {
    // 候选路径不存在或无权限：按缺失处理，交给调用方决定回退或报错
    return null
  }
}

// 枚举多账户目录下的全部 teleagent.db（对齐 discovery/sqlite.mjs 的 scanTeleagent）：
//   1) 账户目录（内含 teleagent.db）→ 返回单库目标，保持单库直导的大声报错语义；
//   2) users/ 目录 → 枚举直接子目录 <users>/<account>/teleagent.db；
//   3) TeleAgent/ 数据根 → 下钻一层 users/ 后枚举账户子目录；
//   4) 均未命中 → 返回 null，由调用方回退 resolveDbInDirectory 触发标准 CANTOPEN 报错。
async function resolveTeleagentDirTargets(ctx, dirTarget) {
  const dirPath = dirTarget.displayPath || ctx.fs.processPath(dirTarget)
  const direct = await statFile(ctx, join(dirPath, TELEAGENT_DB_NAME))
  if (direct) return { single: direct, accounts: null }
  const base = dirPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
  const usersDir = base.toLowerCase() === TELEAGENT_USERS_DIR.toLowerCase()
    ? dirPath
    : join(dirPath, TELEAGENT_USERS_DIR)
  let entries = null
  try {
    entries = await ctx.fs.listDir(await ctx.fs.resolve(usersDir))
  } catch {
    // 非多账户目录（无 users/ 子目录或不可读）→ 交由回退路径按缺库报错
    return null
  }
  const accounts = []
  for (const entry of entries) {
    if (entry.type !== 'directory') continue
    const accPath = (entry.target && (entry.target.displayPath || entry.target.targetKey)) || join(usersDir, entry.name)
    const dbTarget = await statFile(ctx, join(accPath, TELEAGENT_DB_NAME))
    if (dbTarget) accounts.push(dbTarget)
  }
  return accounts.length > 0 ? { single: null, accounts } : null
}

// TeleAgent 目录导入：支持单账户目录、users/ 目录与 TeleAgent/ 数据根。
// 多账户目录逐账户导入并汇总结果；单账户库损坏/读失败只记入 failed 并隔离跳过，不拖垮其余账户。
export async function importTeleagentDirectory(ctx, dirTarget, args, options = {}) {
  const resolved = await resolveTeleagentDirTargets(ctx, dirTarget)
  if (!resolved) {
    return importTeleagentFile(ctx, await resolveDbInDirectory(ctx, dirTarget, TELEAGENT_DB_NAME), args, options)
  }
  if (resolved.single) return importTeleagentFile(ctx, resolved.single, args, options)
  const persisted = options.persisted ?? await listPersistedIds(ctx)
  const results = []
  const tally = createBatchTally()
  let total = 0
  beginRegistryBatch(options.registryDir)
  try {
    for (const dbTarget of resolved.accounts) {
      const dbPath = dbTarget.displayPath || ctx.fs.processPath(dbTarget)
      try {
        const result = await importTeleagentFile(ctx, dbTarget, args, { ...options, persisted })
        total += typeof result.total === 'number' ? result.total : 0
        tallyBatch(tally, result)
        results.push(...(result.results || []))
      } catch (error) {
        tally.failed++
        results.push(failedItem(dbPath, error))
      }
    }
  } finally {
    await endRegistryBatch()
  }
  return batchSummary(tally, total, results)
}

// ── dry-run 预览（与正式导入同源的只读重演：绕开 registry / decideMulti / 落盘，零副作用）──

// teleagent 预览：opencode 预览编排 + 同一组差异参数（无 model 列 schema 由读取器兼容）。
export async function previewTeleagentFile(ctx, target, args) {
  return previewOpencodeFile(ctx, target, args, TELEAGENT_OPTIONS)
}

export async function previewTeleagentDirectory(ctx, dirTarget, args) {
  const resolved = await resolveTeleagentDirTargets(ctx, dirTarget)
  if (!resolved) {
    return previewTeleagentFile(ctx, await resolveDbInDirectory(ctx, dirTarget, TELEAGENT_DB_NAME), args)
  }
  if (resolved.single) return previewTeleagentFile(ctx, resolved.single, args)
  const results = []
  let total = 0
  for (const dbTarget of resolved.accounts) {
    const dbPath = dbTarget.displayPath || ctx.fs.processPath(dbTarget)
    try {
      const preview = await previewTeleagentFile(ctx, dbTarget, args)
      total += preview.total
      results.push(...preview.results)
    } catch (error) {
      results.push(failedItem(dbPath, error))
    }
  }
  return { total, results }
}
