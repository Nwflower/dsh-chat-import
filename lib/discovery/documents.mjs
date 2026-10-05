// lib/discovery/documents.mjs — 整文件 JSON 文档族的发现：continue（每会话一个 JSON + sessions.json
// 索引）与 chatgpt（官方导出的 conversations.json，一文件多会话，无默认根）

import { join } from 'node:path'
import { readContinueIndex } from '../convert/continue.mjs'
import { normalizeTitle } from '../convert/util.mjs'
import { HEAD_MAX_BYTES, basenameOf, parseTimeValue, projectFromRecord, makeEntry, emitEach } from './common.mjs'
import { walkFiles } from './walk.mjs'
import { probeSource } from './scan-cache.mjs'

// chatgpt：无自动根；path 显式指向 conversations.json（或含它的目录）时解析
//（顶层 JSON 数组，每会话 { id, title, create_time, mapping }）。整文件多会话 →
// 书签按文件存全部 entries。
async function scanChatgpt(host, target, { bm, emit }) {
  const st = await host.stat(target)
  if (!st) return []
  let file = target
  if (st.type === 'directory') {
    const candidate = join(target, 'conversations.json')
    const cst = await host.stat(candidate)
    if (!cst || cst.type !== 'file') return []
    file = candidate
  } else if (!/\.json$/i.test(target)) {
    return []
  }
  const fst = await host.stat(file)
  if (!fst) return []
  const fp = { mtimeMs: fst.mtimeMs, sizeBytes: fst.size }
  const entries = await probeSource(bm, 'chatgpt', file, fp, async () => {
    const raw = await host.readText(file)
    if (raw === null || raw === '') return []
    let list
    try { list = JSON.parse(raw) } catch { return [] }
    if (!Array.isArray(list)) return []
    const out = []
    for (const conv of list) {
      if (!conv || typeof conv !== 'object' || typeof conv.id !== 'string') continue
      const mapping = conv.mapping && typeof conv.mapping === 'object' ? conv.mapping : {}
      let lastTs
      for (const node of Object.values(mapping)) {
        if (!node || typeof node !== 'object' || !node.message || typeof node.message !== 'object') continue
        const t = parseTimeValue(node.message.create_time)
        if (t !== undefined && (lastTs === undefined || t > lastTs)) lastTs = t
      }
      out.push(makeEntry({
        format: 'chatgpt', sessionId: conv.id,
        title: typeof conv.title === 'string' && conv.title.trim() ? normalizeTitle(conv.title) : null,
        project: null,
        createdAt: parseTimeValue(conv.create_time), lastActiveAt: lastTs, sourcePath: file,
      }))
    }
    return out
  })
  await emitEach(emit, entries)
  return entries
}

// continue：<global>/sessions/<sessionId>.json（global = $CONTINUE_GLOBAL_DIR || ~/.continue，
// VS Code / JetBrains / CLI 三端共用）。同目录 sessions.json 是索引数组，只有它带
// dateCreated（会话文件本身没有时间戳）→ 索引命中时只做头部签名校验，不整读会话文件。
// 会话文件含 contextItems（内嵌所引用文件全文）可能很大，整读仅发生在索引未覆盖时。
// 项目取记录内 workspaceDirectory（目录是全局单一层，没有按项目分层的布局可解析）。
async function scanContinue(host, target, { bm, emit }) {
  const files = []
  await walkFiles(host, target, files, (name) => /\.json$/i.test(name))
  // 索引优先：一次读入 sessionId → { title, createdAt, cwd }
  let index = new Map()
  for (const file of files) {
    if (basenameOf(file.name).toLowerCase() !== 'sessions.json') continue
    const raw = await host.readText(file.path)
    if (raw === null || raw === '') continue
    index = readContinueIndex(raw)
    break
  }
  const out = []
  for (const file of files) {
    if (basenameOf(file.name).toLowerCase() === 'sessions.json') continue
    const stem = basenameOf(file.name).replace(/\.json$/i, '')
    const st = await host.stat(file.path)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    const known = index.get(stem) || null
    const entries = await probeSource(bm, 'continue', file.path, fp, async () => {
      // 结构签名：Continue 会话对象以 sessionId + history 开头（JetBrains 会留下 `{}`
      // 空文件、目录里也可能混入索引 → 只认两者都在的文件）。
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '' || !/"sessionId"\s*:/.test(head) || !/"history"\s*:/.test(head)) return []
      let createdAt = known ? known.createdAt : undefined
      let cwd = known ? known.cwd : null
      let title = known ? known.title : ''
      let sessionId = stem
      if (!known) {
        // 索引未覆盖（手工删改、写入中断）→ 整读该会话取元数据
        const raw = await host.readText(file.path)
        if (raw === null || raw === '') return []
        let session
        try { session = JSON.parse(raw) } catch { return [] }
        if (!session || typeof session !== 'object' || !Array.isArray(session.history)) return []
        sessionId = typeof session.sessionId === 'string' && session.sessionId ? session.sessionId : stem
        title = typeof session.title === 'string' ? session.title : ''
        cwd = typeof session.workspaceDirectory === 'string' && session.workspaceDirectory
          ? session.workspaceDirectory
          : null
      }
      return [makeEntry({
        format: 'continue', sessionId,
        // 默认标题（'New Session'）不是用户起的名字 → 交给首问兜底
        title: normalizeTitle(title === 'New Session' ? '' : title),
        project: projectFromRecord(cwd, () => null),
        createdAt: createdAt ?? undefined, lastActiveAt: st.mtimeMs,
        sourcePath: file.path, cwd,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// ── 来源描述符（注册与顺序见 ./registry.mjs；字段契约见该文件头）──────────────────

export const continueSource = {
  format: 'continue',
  // 全局单一会话目录（VS Code / JetBrains / CLI 三端共用）；与 Continue core 同序：
  // $CONTINUE_GLOBAL_DIR 优先、否则 ~/.continue
  roots: (home, env) => (env.CONTINUE_GLOBAL_DIR
    ? join(env.CONTINUE_GLOBAL_DIR, 'sessions')
    : join(home, '.continue', 'sessions')),
  scan: scanContinue,
  // 会话文件是单个 JSON 对象且路径特征唯一 → 独占，不落到 gemini/chatgpt 探测
  matchFile: (lower) => (lower.endsWith('.json') && /(^|[\\/])\.continue[\\/]sessions[\\/]/.test(lower) ? 'only' : false),
}

export const chatgptSource = {
  format: 'chatgpt',
  // 官方导出无固定落点：只在显式 path 时发现
  roots: () => null,
  scan: scanChatgpt,
  fileFallback: ['json'],
}
