// lib/workspace-group.mjs — 导入会话的工作区归组（host 面：消费 ctx.fs / ctx.workspaceRegistry）
//
// 宿主契约（@deepseek-ai/dsh-workspace attachSession）：会话只能挂进 **cwd 与之相等** 的
// 工作区——它读会话 header，cwd 缺失 / 不可解析 / 不是目录 / realpath 后与 workspace.path
// 不等，一律抛错拒绝；workspace.sessionIds 的 getter 也只返回 sessionPath(id) === record.path
// 的 id。而客户端侧栏按 workspace.sessionIds 分组，没被计入的会话全部落进「未分组」
// （dsh-client-ui-workspace 的 ungroupedMemberIds = list.ids 减去各工作区的 sessionIds）。
//
// 两条硬约束，本模块的全部行为都由它们推出：
//   1. 归组必须在**创建会话之前**决定：目标工作区路径要写进 header.cwd，创建之后再 attach；
//   2. 事后给 cwd 不匹配的工作区 attach 在宿主上必然失败。旧实现「cwd 不可用时回退源文件
//      目录」正踩这条：源目录被建成一个**空工作区**，会话仍留在「未分组」，失败又只写
//      console.error（本机 $DSH_HOME/logs 为空，用户完全看不到），于是「导入了但列表里
//      找不到」。见 docs/architecture.md D16。
//
// 目标选择（options.workspaceMode，默认 auto）：
//   auto        cwd 命中已有工作区 → 沿用；cwd 是本地存在的目录（非主目录）→ 在 cwd 建
//               工作区（会话落在真实项目下，与原生会话同区）；否则（主目录 / 本机不存在 /
//               建不出来）→ 专用导入工作区并改写 cwd
//   per-project 同 auto，但最后一级**不改写 cwd**：宁可「未分组」也不伪造 cwd
//   dedicated   一律专用导入工作区（workspaceDir / dir 可覆盖目录）
//
// 归组是尽力而为：放弃或 attach 失败都带 reason 回给调用方如实上报，绝不阻断导入、绝不
// 静默吞掉（失败要大声）。
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isHomePath } from './cwd-map.mjs'
import { currentIgnores, findWorkspaceIgnore, sourceIgnoreKey } from './ignore.mjs'

/** workspaceMode 的合法取值（面板 / 工具 / 命令三处共用同一枚举）。 */
export const WORKSPACE_MODES = ['auto', 'dedicated', 'per-project']

/** 未识别值一律按 auto（工具 schema 已限定枚举，这里的兜底服务于命令与直接调用）。 */
export function normalizeWorkspaceMode(value) {
  return WORKSPACE_MODES.includes(value) ? value : 'auto'
}

/** 默认专用导入工作区目录：$DSH_HOME/dsh-chat-import-workspace。 */
export function defaultDedicatedWorkspaceDir(env = process.env) {
  const base = env.DSH_HOME || join(homedir(), '.dsh')
  return join(base, 'dsh-chat-import-workspace')
}

function messageOf(err) {
  return String((err && err.message) || err)
}

// 被删工作区的墓碑（ignore-watch 在 workspaces 表 deleted 时写下）：只有「当时就在这个
// 工作区里的源」才继续拦住，新源照常放行——与 ignore.mjs ignoreDecisionFor 同一口径，
// 否则用户删过一次专用工作区就再也归不了组。
function workspaceIgnoreReason(dir, sourcePath, options) {
  const entry = findWorkspaceIgnore(currentIgnores(), dir)
  if (!entry) return null
  const known = Array.isArray(entry.sessionKeys) ? entry.sessionKeys : []
  const key = sourceIgnoreKey(sourcePath, options.subTable, options.subKey)
  return known.includes(key) ? 'workspace-ignored' : null
}

/** 找到或建出目标工作区；返回 { path, workspace, created } 或 { path:null, reason }。 */
async function ensureWorkspacePlan(wr, dir, { mode, sourcePath, options, createDir = false }) {
  const blocked = workspaceIgnoreReason(dir, sourcePath, options)
  if (blocked) return { path: null, mode, reason: blocked, target: dir }
  let ws = null
  try {
    ws = await wr.resolveByPath(dir)
  } catch {
    // resolve 抛错按「未命中」继续：create 会给出真正的原因，避免在这里吞掉细节
    ws = null
  }
  let created = false
  if (!ws) {
    // 会话 cwd 一律不代建目录：宿主 create 只接受已存在的目录（realpath + isDirectory
    // 校验），而按 transcript 的一面之词在磁盘上造目录是危险的（跨机器路径尤其）。
    // 只有专用导入工作区（本插件自己的目录）才 mkdir -p。
    if (createDir) {
      try {
        await mkdir(dir, { recursive: true })
      } catch (err) {
        return { path: null, mode, reason: 'mkdir-failed: ' + messageOf(err), target: dir }
      }
    }
    try {
      ws = await wr.create(dir)
    } catch (err) {
      return { path: null, mode, reason: 'create-failed: ' + messageOf(err), target: dir }
    }
    if (!ws || typeof ws.path !== 'string' || ws.path === '') {
      return { path: null, mode, reason: 'create-unavailable', target: dir }
    }
    created = true
  }
  return { path: ws.path, mode, workspace: ws, created, target: dir }
}

/**
 * 规划一次导入的归组目标（创建会话前调用；调用方据此改写 meta.cwd）。
 * @param {object} ctx host ctx（fs / workspaceRegistry）
 * @param {{cwd?: string}} meta 会话 meta（只读 cwd，不改写）
 * @param {string} sourcePath 源文件路径（仅用于忽略墓碑键）
 * @param {{workspaceMode?: string, workspaceDir?: string, dir?: string, subTable?: string, subKey?: string}} options
 * @returns {Promise<{path: string|null, mode: string, reason?: string, workspace?: object, created?: boolean, fallbackFrom?: string}>}
 */
export async function planWorkspaceGroup(ctx, meta, sourcePath, options = {}) {
  const mode = normalizeWorkspaceMode(options.workspaceMode)
  const wr = ctx && typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null
  if (!wr || typeof wr.resolveByPath !== 'function' || typeof wr.create !== 'function') {
    return { path: null, mode, reason: 'no-registry' }
  }
  const dir = typeof options.workspaceDir === 'string' && options.workspaceDir
    ? options.workspaceDir
    : (typeof options.dir === 'string' && options.dir ? options.dir : defaultDedicatedWorkspaceDir())
  const cwd = meta && typeof meta.cwd === 'string' && meta.cwd ? meta.cwd : ''
  const dedicated = { mode: 'dedicated', sourcePath, options, createDir: true }

  if (mode === 'dedicated') return ensureWorkspacePlan(wr, dir, dedicated)

  // ① cwd 已是某个工作区：沿用（仍按 ws.path 归一——宿主按 realpath 逐字比对 header.cwd）
  if (cwd) {
    let existing = null
    try {
      existing = await wr.resolveByPath(cwd)
    } catch {
      existing = null
    }
    if (existing && typeof existing.path === 'string' && existing.path) {
      return { path: existing.path, mode: 'workspace', workspace: existing, created: false }
    }
  }

  // ② 拿 cwd 当工作区（本机存在该目录时宿主才接受；主目录例外——主目录工作区会让沙箱
  //    ACL 拒绝 temp/pwsh）：会话落在真实项目下，与原生会话同区
  let dropReason = cwd ? 'cwd-unusable' : 'no-cwd'
  if (cwd && isHomePath(cwd)) {
    dropReason = 'cwd-is-home'
  } else if (cwd) {
    const plan = await ensureWorkspacePlan(wr, cwd, { mode: 'project', sourcePath, options })
    if (plan.path) return plan
    // 宿主拒绝（目录不存在 / 不是目录 / 被忽略）→ 记下原因，交给专用工作区兜底
    dropReason = plan.reason
  }

  // ③ per-project：不改写 cwd，宁可未分组
  if (mode === 'per-project') return { path: null, mode, reason: dropReason }

  // ④ 专用导入工作区（改写 cwd，保证「导入的会话一定能被看到」）
  const fallback = await ensureWorkspacePlan(wr, dir, dedicated)
  if (!fallback.path) return { path: null, mode, reason: fallback.reason || dropReason, target: fallback.target }
  return { ...fallback, fallbackFrom: dropReason }
}

/**
 * 创建会话之后按 plan 挂接。attach 被宿主拒绝时回 { ok:false, reason }（调用方如实上报）。
 */
export async function attachPlannedWorkspace(ctx, plan, sessionId) {
  if (!plan || !plan.path) return { ok: false, reason: (plan && plan.reason) || 'no-target' }
  const wr = ctx && typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null
  if (!wr) return { ok: false, reason: 'no-registry' }
  try {
    const ws = plan.workspace && typeof plan.workspace.attachSession === 'function'
      ? plan.workspace
      : await wr.resolveByPath(plan.path)
    if (!ws || typeof ws.attachSession !== 'function') return { ok: false, reason: 'workspace-unavailable', path: plan.path }
    await ws.attachSession(sessionId)
    return { ok: true, path: plan.path, mode: plan.mode, created: plan.created === true }
  } catch (err) {
    return { ok: false, reason: 'attach-failed: ' + messageOf(err), path: plan.path }
  }
}
