// lib/discovery/claude.mjs — Claude 同构 JSONL 族的发现：claude（含 Claude-3p 新端元数据）、
// qoder、workbuddy、qwen（千问办公）
//
// 这几种来源的转录都是「每会话一个 .jsonl、记录带 sessionId/cwd/timestamp」的 Claude 形态，
// 纯内容难以区分——qoder / workbuddy / qwen 靠目录布局（路径签名）自拒，claude 靠
// 「文件名 stem == 记录 sessionId」区分主转录与辅助转录。

import { join } from 'node:path'
import { homedir } from 'node:os'
import { realWorkspaceDir } from '../convert/qwen.mjs'
import { stripPastedWrapper } from '../convert/inject.mjs'
import { normalizeTitle } from '../convert/util.mjs'
import {
  HEAD_MAX_BYTES, TAIL_MAX_BYTES, basenameOf, slashPath, parseJsonlHead, contentText, firstUserRawText,
  firstUserTitle, parseTimeValue, firstString, firstNumber, projectFromRecord, makeEntry, emitEach,
} from './common.mjs'
import { walkFiles } from './walk.mjs'
import { probeSource } from './scan-cache.mjs'

// Claude 尾部 → 最后一条 assistant 的 input_tokens（无则 null）。
function claudeContextTokens(tailText) {
  let last = null
  for (const line of String(tailText ?? '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    let r
    try { r = JSON.parse(t) } catch { continue }
    const u = r && r.message && r.message.usage
    if (u && typeof u.input_tokens === 'number' && Number.isFinite(u.input_tokens)) last = u.input_tokens
  }
  return last
}

// Claude 标题载体（权威度，对齐 convert/claude.mjs 与 Claude Code 自身的选法）：
// custom-title（/rename 自定义标题）> ai-title（生成标题）> 首个非注入 user 文本。
// 列表只读头+尾两段（HEAD_MAX_BYTES / TAIL_MAX_BYTES），两段各有一半载体落在外面，
// 所以两侧都要扫（实测 105 份主转录：25 份 custom-title 全部落在最后 64KB 内，62 份
// ai-title 里 53 份首个在头部、另 9 份只能从尾部看到）。custom-title 后到者胜（重命名
// 追加在尾部）；ai-title 取首个（逐轮改写，尾部可能被 worktree 名覆盖）。
function claudeTitle(headRecs, tailRecs) {
  const lastCustom = (list) => {
    let v = null
    for (const r of list) {
      if (r && r.type === 'custom-title' && typeof r.customTitle === 'string' && r.customTitle.trim()) v = r.customTitle
    }
    return v
  }
  const custom = lastCustom(tailRecs) || lastCustom(headRecs)
  if (custom) return normalizeTitle(custom)
  const ai = firstString([...headRecs, ...tailRecs], (r) =>
    r && r.type === 'ai-title' && typeof r.aiTitle === 'string' && r.aiTitle.trim() ? r.aiTitle : undefined
  )
  if (ai) return normalizeTitle(ai)
  const raw = firstUserRawText(headRecs, (r) =>
    r && r.type === 'user' && r.message && r.message.role === 'user' ? contentText(r.message.content) : ''
  )
  return raw ? normalizeTitle(stripPastedWrapper(raw)) : null
}

// claude：~/.claude/projects/<slug>/<sessionId>.jsonl，只取主 transcript
//（fileStem == sessionId；agent-* 子代理/辅助 transcript 跳过）。
// 目标为 Claude-3p 新端根（claude-code-sessions）时走 scanClaude3p。
async function scanClaude(host, target, { bm, emit }) {
  if (/claude-code-sessions/i.test(String(target))) return scanClaude3p(host, target, { bm, emit })
  const files = []
  await walkFiles(host, target, files, (name) => /\.jsonl$/i.test(name))
  const out = []
  for (const file of files) {
    const stem = basenameOf(file.name).replace(/\.jsonl$/i, '')
    if (stem.startsWith('agent-')) continue
    const st = await host.stat(file.path)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    const entries = await probeSource(bm, 'claude', file.path, fp, async () => {
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      const sessionId = firstString(recs, (r) => r && r.sessionId)
      if (!sessionId || sessionId !== stem) return []
      const cwd = firstString(recs, (r) => r && r.cwd)
      const createdAt = firstNumber(recs, (r) => (r && r.timestamp !== undefined ? parseTimeValue(r.timestamp) : undefined))
      // 头/尾两段一次读齐：标题载体与上下文 token 都从这两段取（小文件头即全文，
      // 尾部与头同源，不额外多读一次）
      const tail = st.size <= HEAD_MAX_BYTES ? head : await host.readTail(file.path, TAIL_MAX_BYTES)
      const title = claudeTitle(recs, parseJsonlHead(tail))
      const contextTokens = claudeContextTokens(tail)
      return [makeEntry({
        format: 'claude', sessionId, title,
        project: projectFromRecord(cwd, () => claudeLayoutProject(file.path)),
        createdAt, lastActiveAt: st.mtimeMs, contextTokens, sourcePath: file.path, cwd,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// Claude-3p 新端：claude-code-sessions/<account>/<org>/local_<id>.json 元数据
// （sessionId/cliSessionId/cwd/title/lastActivityAt）。cliSessionId → 反查
// ~/.claude/projects/<slug>/*.jsonl（文件名 stem + 首行 sessionId 校验，#63904 同款）；
// 命中 → 合并进 claude 会话（标题/cwd/lastActivityAt 取元数据，sourcePath = jsonl，
// 幂等同 cliSessionId）；未命中 → 降级为元数据会话（sourcePath = 元数据 json，
// 转写缺失的降级元数据会话——导入侧对该 json 无内容会 skipped，属边界文档化）。
async function scanClaude3p(host, target, { bm, emit }) {
  const files = []
  await walkFiles(host, target, files, (name) => /\.json$/i.test(name))
  const out = []
  for (const file of files) {
    const st = await host.stat(file.path)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    const entries = await probeSource(bm, 'claude', file.path, fp, async () => {
      const raw = await host.readText(file.path)
      if (raw === null || raw === '') return []
      let meta
      try {
        meta = JSON.parse(raw)
      } catch {
        return []
      }
      if (!meta || typeof meta !== 'object') return []
      const sessionId = typeof meta.sessionId === 'string' && meta.sessionId
        ? meta.sessionId
        : basenameOf(file.name).replace(/\.json$/i, '')
      const cliId = typeof meta.cliSessionId === 'string' && meta.cliSessionId ? meta.cliSessionId : null
      const cwd = typeof meta.cwd === 'string' && meta.cwd ? meta.cwd : null
      const title = typeof meta.title === 'string' && meta.title.trim() ? normalizeTitle(meta.title) : null
      const lastActiveAt = parseTimeValue(meta.lastActivityAt)
      const createdAt = parseTimeValue(meta.createdAt)
      if (cliId) {
        const jsonlPath = await findJsonlBySessionId(host, cliId, join(homedir(), '.claude', 'projects'))
        if (jsonlPath) {
          return [makeEntry({
            format: 'claude', sessionId: cliId, title,
            project: cwd ? basenameOf(cwd) : claudeLayoutProject(jsonlPath),
            createdAt, lastActiveAt, sourcePath: jsonlPath, cwd,
          })]
        }
      }
      return [makeEntry({
        format: 'claude', sessionId, title,
        project: cwd ? basenameOf(cwd) : null,
        createdAt, lastActiveAt, sourcePath: file.path, cwd,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// cliSessionId → ~/.claude/projects/<slug>/<cliSessionId>.jsonl（文件名精确匹配 +
// 首行 sessionId 校验）；找不到返回 null（调用方降级元数据会话）。
async function findJsonlBySessionId(host, cliSessionId, projectsRoot) {
  const files = []
  await walkFiles(host, projectsRoot, files, (name) => name === cliSessionId + '.jsonl')
  for (const file of files) {
    const head = await host.readHead(file.path, 4096)
    if (parseJsonlHead(head).some((r) => r && r.sessionId === cliSessionId)) return file.path
  }
  return null
}

// qoder：~/.qoder/projects/<encoded-project>/<sessionId>.jsonl。结构同 Claude（type
// user/assistant + content block），子代理 transcript（<sessionId>/subagents/*.jsonl）
// 跳过；标题 ai-title > last-prompt > 首问；cwd 取记录内 cwd。
async function scanQoder(host, target, { bm, emit }) {
  // 路径签名自拒：Qoder JSONL 与 Claude 结构高度一致，纯内容无法区分，只能靠
  // 目录布局（~/.qoder/projects/）区分——非 qoder 根直接返回空，避免误扫 claude 等。
  if (!/\.qoder[\\/]projects([\\/]|$)/i.test(String(target))) return []
  const files = []
  await walkFiles(host, target, files, (name) => /\.jsonl$/i.test(name))
  const out = []
  for (const file of files) {
    if (/\bsubagents[\\/]/.test(file.path)) continue
    const stem = basenameOf(file.name).replace(/\.jsonl$/i, '')
    const st = await host.stat(file.path)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    const entries = await probeSource(bm, 'qoder', file.path, fp, async () => {
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      const sessionId = firstString(recs, (r) => r && r.sessionId)
      if (!sessionId || sessionId !== stem) return []
      const cwd = firstString(recs, (r) => r && r.cwd)
      const createdAt = firstNumber(recs, (r) => (r && r.timestamp !== undefined ? parseTimeValue(r.timestamp) : undefined))
      const aiTitle = firstString(recs, (r) => (r && r.type === 'ai-title' ? r.aiTitle : undefined))
      const lastPrompt = firstString(recs, (r) => (r && r.type === 'last-prompt' ? r.lastPrompt : undefined))
      const title = normalizeTitle(aiTitle || lastPrompt)
        || firstUserTitle(recs, (r) => (r && r.type === 'user' && r.message && r.message.role === 'user' ? contentText(r.message.content) : ''))
      return [makeEntry({
        format: 'qoder', sessionId, title,
        project: projectFromRecord(cwd, () => qoderLayoutProject(file.path)),
        createdAt, lastActiveAt: st.mtimeMs, sourcePath: file.path, cwd,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// workbuddy：~/.workbuddy/projects/<project-hash>/<session-uuid>.jsonl。逐行事件 JSON
//（message / reasoning / function_call / function_call_result / file-history-snapshot）；
// 标题 = <user_query> 提取的首条真实提问（注入过滤）；cwd 取记录内 cwd。
function workbuddyUserQuery(recs) {
  for (const r of recs) {
    if (!r || typeof r !== 'object') continue
    if (r.type === 'message' && r.role === 'user' && Array.isArray(r.content)) {
      const joined = contentText(r.content)
      const m = /<user_query>([\s\S]*?)<\/user_query>/.exec(joined)
      const text = m && m[1] && m[1].trim()
        ? m[1].trim()
        : joined.replace(/<system-reminder[\s\S]*?<\/system-reminder>/gi, '')
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      if (text) return text
    }
  }
  return ''
}

async function scanWorkbuddy(host, target, { bm, emit }) {
  // 路径签名自拒：WorkBuddy 事件 JSON 与其它 JSONL 均不同，但用目录布局
  //（~/.workbuddy/projects/）区分最稳——非 workbuddy 根直接返回空。
  if (!/\.workbuddy[\\/]projects([\\/]|$)/i.test(String(target))) return []
  const files = []
  await walkFiles(host, target, files, (name) => /\.jsonl$/i.test(name))
  const out = []
  for (const file of files) {
    const stem = basenameOf(file.name).replace(/\.jsonl$/i, '')
    const st = await host.stat(file.path)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    const entries = await probeSource(bm, 'workbuddy', file.path, fp, async () => {
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      const sessionId = firstString(recs, (r) => r && r.sessionId) || stem
      if (!sessionId) return []
      const cwd = firstString(recs, (r) => r && r.cwd)
      const createdAt = firstNumber(recs, (r) => (r && r.timestamp !== undefined ? parseTimeValue(r.timestamp) : undefined))
      const title = normalizeTitle(workbuddyUserQuery(recs))
      return [makeEntry({
        format: 'workbuddy', sessionId, title,
        project: projectFromRecord(cwd, () => workbuddyLayoutProject(file.path)),
        createdAt, lastActiveAt: st.mtimeMs, sourcePath: file.path, cwd,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// qwen（千问办公）：~/.qwenworkcn/projects/<slug>/<session-uuid>.jsonl。转写明文、
// 事件词汇与 Claude 同构（convert/qwen.mjs）。标题 = 首问（humanInput.text 权威，
// 回退 text 块并跳过 <system 注入块）；项目 = 首行 workspace-directories 里非
// .qwenworkcn 的真实工作文件夹（slug 目录名是存储层混写，禁作项目；记录内 cwd 是
// 千问临时工作区，同禁）。同会话双 slug 副本（-sessions-<hash>-mnt 与 workspace
// slug 并存）按 sessionId 去重留 mtime 最新的副本。
function qwenUserQuery(recs) {
  for (const r of recs) {
    if (!r || typeof r !== 'object' || r.type !== 'user' || !r.message) continue
    const hi = r.humanInput
    if (hi && typeof hi === 'object' && typeof hi.text === 'string' && hi.text.trim()) return hi.text
    const blocks = Array.isArray(r.message.content) ? r.message.content : null
    if (blocks !== null) {
      const texts = blocks
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string'
          && b.text.trim() && !/^<system/.test(b.text.trim()))
        .map((b) => b.text)
      if (texts.length > 0) return texts.join('\n')
    } else if (typeof r.message.content === 'string' && r.message.content.trim()
      && !/^<system/.test(r.message.content.trim())) {
      return r.message.content
    }
  }
  return ''
}

async function scanQwen(host, target, { bm, emit }) {
  // 路径签名自拒：只认 ~/.qwenworkcn/projects/ 布局——非千问根直接返回空。
  if (!/\.qwenworkcn[\\/]projects([\\/]|$)/i.test(String(target))) return []
  const files = []
  await walkFiles(host, target, files, (name) => /\.jsonl$/i.test(name))
  const bySession = new Map()
  for (const file of files) {
    const stem = basenameOf(file.name).replace(/\.jsonl$/i, '')
    const st = await host.stat(file.path)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    const entries = await probeSource(bm, 'qwen', file.path, fp, async () => {
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      const sessionId = firstString(recs, (r) => r && r.sessionId) || stem
      // 文件名 ≠ 记录 sessionId 的是辅助/异构转写，不建会话（双 slug 副本两者一致）
      if (!sessionId || sessionId !== stem) return []
      const wsDir = firstString(recs, (r) => (r && r.type === 'workspace-directories'
        ? realWorkspaceDir(r.directories)
        : undefined))
      const createdAt = firstNumber(recs, (r) => (r && r.timestamp !== undefined ? parseTimeValue(r.timestamp) : undefined))
      const title = normalizeTitle(qwenUserQuery(recs))
      return [makeEntry({
        format: 'qwen', sessionId, title,
        project: wsDir ? basenameOf(wsDir) : null,
        createdAt, lastActiveAt: st.mtimeMs, sourcePath: file.path, cwd: wsDir,
      })]
    })
    for (const e of entries) {
      const prev = bySession.get(e.sessionId)
      if (!prev || (e.lastActiveAt ?? 0) > (prev.lastActiveAt ?? 0)) bySession.set(e.sessionId, e)
    }
  }
  const out = [...bySession.values()]
  for (const e of out) await emitEach(emit, [e])
  return out
}

// 项目名布局：~/.claude/projects/<slug>/<sessionId>.jsonl → slug。
function claudeLayoutProject(sourcePath) {
  const m = slashPath(sourcePath).match(/\/projects\/([^/]+)\/[^/]+\.jsonl$/i)
  return m ? m[1] : null
}

// ~/.qoder/projects/<encoded-project>/<sessionId>.jsonl（项目目录名 = cwd 的
// '/'→'-' 编码，best-effort 解码后取 basename 作项目名；记录内 cwd 优先）。
function qoderLayoutProject(sourcePath) {
  const m = slashPath(sourcePath).match(/\/projects\/([^/]+)\/[^/]+\.jsonl$/i)
  if (!m) return null
  const decoded = m[1].replace(/-/g, '/')
  return decoded.split('/').filter(Boolean).pop() || m[1]
}

// ~/.workbuddy/projects/<project-hash>/<session-uuid>.jsonl。project-hash 是
// cwd 的哈希（不可逆），只能作标签；记录内 cwd 由 projectFromRecord 优先。
function workbuddyLayoutProject(sourcePath) {
  const m = slashPath(sourcePath).match(/\/\.workbuddy\/projects\/([^/]+)\/[^/]+\.jsonl$/i)
  return m ? m[1] : null
}

// ── 来源描述符（注册与顺序见 ./registry.mjs；字段契约见该文件头）──────────────────

const isJsonl = (lower) => lower.endsWith('.jsonl')

export const claudeSource = {
  format: 'claude',
  // Claude-3p 新端（Windows LOCALAPPDATA）元数据根与 ~/.claude/projects 并列
  roots: (home, env) => {
    const projects = join(home, '.claude', 'projects')
    return env.LOCALAPPDATA ? [projects, join(env.LOCALAPPDATA, 'Claude-3p', 'claude-code-sessions')] : projects
  },
  scan: scanClaude,
  layoutProject: claudeLayoutProject,
  matchFile: (lower) => isJsonl(lower) && /\.claude[\\/]/.test(lower),
  fileFallback: ['jsonl'],
}

export const qoderSource = {
  format: 'qoder',
  roots: (home) => join(home, '.qoder', 'projects'),
  scan: scanQoder,
  layoutProject: qoderLayoutProject,
  matchFile: (lower) => isJsonl(lower) && /\.qoder[\\/]projects[\\/]/.test(lower),
}

export const workbuddySource = {
  format: 'workbuddy',
  roots: (home) => join(home, '.workbuddy', 'projects'),
  scan: scanWorkbuddy,
  layoutProject: workbuddyLayoutProject,
  matchFile: (lower) => isJsonl(lower) && /\.workbuddy[\\/]projects[\\/]/.test(lower),
}

export const qwenSource = {
  format: 'qwen',
  roots: (home) => join(home, '.qwenworkcn', 'projects'),
  scan: scanQwen,
  matchFile: (lower) => isJsonl(lower) && /\.qwenworkcn[\\/]projects[\\/]/.test(lower),
}
