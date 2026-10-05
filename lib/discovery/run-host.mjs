// lib/discovery/run-host.mjs — 单次发现内的 host 记忆化（目录列举 / stat / cursor slug 解码）
//
// 无 format 的目录探测会让全部来源的扫描器各自遍历同一棵树（dsh 与 dsh4 共用默认根也各走一遍），
// cursor 的扫描与书签命中补丁会对同一 slug 反复跑贪心回溯解码（逐段 stat）。一次 discoverSessions
// 内把这些只读查询按键记忆化（缓存 Promise：并发同键只发一次，失败也按同一结果复用）；跨次调用
// 不复用——两次发现之间磁盘可能变化，新鲜度由 TTL 缓存与书签负责。返回值在扫描器之间共享，
// 调用方只读不改。其余 host 方法经原型链原样透传。

function memoize(fn) {
  const cache = new Map()
  return (key) => {
    if (!cache.has(key)) cache.set(key, fn(key))
    return cache.get(key)
  }
}

export function createRunHost(host) {
  const run = Object.create(host)
  run.readDir = memoize((path) => host.readDir(path))
  run.stat = memoize((path) => host.stat(path))
  if (typeof host.resolveCursorSlug === 'function') {
    run.resolveCursorSlug = memoize((slug) => host.resolveCursorSlug(slug))
  }
  return run
}
