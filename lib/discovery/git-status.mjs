// lib/discovery/git-status.mjs — 会话条目的 git 分支探测（纯 JS 解析 .git/HEAD，不调用 git）

import { dirname, join, resolve } from 'node:path'
import { readFile as fread, stat as fstat } from 'node:fs/promises'

// ── git 状态─────────────────────────────────────────────────────
// 会话条目的 git 分支/dirty：探针目录 = 条目 cwd（记录内完整路径）或源文件目录。
// 纯 JS 解析 .git/HEAD 拿分支名（向上找 .git 目录或 .git 文件，兼容 worktree）；
// 非仓库 / 权限失败一律 null（静默缺省）。gitDirty 因无法在不调用 git 命令的
// 前提下可靠判断，降级为 null（安全扫描将 child_process 判为 critical，路线 A
// 已移除所有 execFileSync）。结果按探针目录缓存（一次扫描内复用，Promise 记忆化
// 支持并发去重）；只在 discoverSessions 后处理里计算——不入 TTL/书签缓存（分支是
// 扫描时刻的瞬时状态，缓存会过期）。async（fs/promises）：扫描在宿主事件循环上
// 跑，同步 stat/readFile 会在后台扫描期间冻住整个 Web 服务（面板轮询/其它请求）。
export async function gitStatusOf(probe, cache) {
  if (typeof probe !== 'string' || !probe.trim() || cache.has(probe)) {
    return cache.get(probe) || { gitBranch: null, gitDirty: null }
  }
  const p = computeGitStatus(probe).catch(() => ({ gitBranch: null, gitDirty: null }))
  cache.set(probe, p)
  return p
}

async function findGitDir(probe) {
  let dir = resolve(probe)
  for (;;) {
    const dotGit = join(dir, '.git')
    try {
      const st = await fstat(dotGit)
      if (st.isDirectory()) return dotGit
      if (st.isFile()) {
        // worktree/submodule：.git 是指向真实 git 目录的 gitdir: 文件
        const content = (await fread(dotGit, 'utf8')).trim()
        const m = /^gitdir:\s*(.+)$/.exec(content)
        if (m) return m[1].trim()
      }
    } catch {
      // 继续向上找
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

async function computeGitStatus(probe) {
  const gitDir = await findGitDir(probe)
  if (!gitDir) return { gitBranch: null, gitDirty: null }
  try {
    const head = (await fread(join(gitDir, 'HEAD'), 'utf8')).trim()
    const m = /^ref:\s+refs\/heads\/(.+)$/.exec(head)
    const branch = m ? m[1] : head.slice(0, 7) // detached HEAD：短 hash 近似
    return { gitBranch: branch || null, gitDirty: null }
  } catch {
    return { gitBranch: null, gitDirty: null }
  }
}
