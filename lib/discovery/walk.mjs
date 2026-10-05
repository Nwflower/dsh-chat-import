// lib/discovery/walk.mjs — 发现层的目录遍历（经注入 host，跳过依赖/构建目录并限深）

import { basenameOf } from './common.mjs'

// 递归遍历不进入的目录名：聊天记录从不在这些目录下；node_modules / .git 等在
// pnpm 符号链接结构下会引发组合爆炸或无意义遍历，单次扫描实际永不结束（issue #16）。
export const WALK_SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.venv', 'venv',
  'dist', 'build', '.next', '.turbo', '.cache', 'target', 'out',
  '.idea', '.vscode', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.DS_Store',
])

// 深度兜底：合法聊天记录根不超过 5 层（如 .codex/sessions/YYYY/MM/DD/file），
// 12 层覆盖任意合理布局，同时切断病态深递归 / 循环符号链接（issue #16）。
export const WALK_MAX_DEPTH = 12

// 递归收集匹配文件（目录缺失/不可读 → 空，发现阶段静默跳过该根）。
// 跳过 node_modules 等目录 + 限深，避免 pnpm 符号链接结构下组合爆炸（issue #16）。
// 目标本身是文件时（显式给出某个会话日志/转录路径）按其文件名匹配：目录形态的扫描器
// （dsh / claude / codex…）此前对单文件目标恒返回空，fileFormatsForPath 判出来的格式
// 因此形同虚设（`discoverSessions({ path: '<某个 session.jsonl>' })` 恒 0 条）。
export async function walkFiles(host, target, out, match, depth = 0) {
  if (depth > WALK_MAX_DEPTH) return
  const entries = await host.readDir(target)
  if (!entries || entries.length === 0) {
    // 读不到目录项：目标可能是文件，也可能是缺失的根（stat 拿不到 → 静默跳过）
    const st = await host.stat(target)
    const name = basenameOf(target)
    if (st && st.type === 'file' && match(name)) out.push({ name, type: 'file', path: target })
    return
  }
  for (const e of entries) {
    if (e.type === 'directory') {
      if (WALK_SKIP_DIRS.has(e.name)) continue
      await walkFiles(host, e.path, out, match, depth + 1)
    } else if (e.type === 'file' && match(e.name)) {
      out.push(e)
    }
  }
}
