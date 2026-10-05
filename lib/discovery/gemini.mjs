// lib/discovery/gemini.mjs — ~/.gemini 族的发现：gemini（Gemini CLI 会话 JSON）与 antigravity
//
// 两者共用 ~/.gemini 前缀但存储形态不同：gemini 是 history/<slot>/chats/session-*.json 整文件
// JSON；antigravity 是每会话一目录（conversations/ 命中记录 + brain/ 明文转录 + annotations/ 标题）。

import { join } from 'node:path'
import { normalizeTitle } from '../convert/util.mjs'
import {
  HEAD_MAX_BYTES, basenameOf, slashPath, parseJsonlHead, firstUserTitle, parseTimeValue,
  projectFromRecord, makeEntry, emitEach,
} from './common.mjs'
import { walkFiles } from './walk.mjs'
import { probeSource } from './scan-cache.mjs'

// gemini：~/.gemini/history/<slot>/chats/session-*.json（顶层
// { sessionId, startTime, directories, messages: [{ type, content, ... }] }）。
export async function scanGemini(host, target, bm, emit) {
  const files = []
  await walkFiles(host, target, files, (name) => /^session-.+\.json$/i.test(name))
  const out = []
  for (const file of files) {
    const st = await host.stat(file.path)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    const entries = await probeSource(bm, 'gemini', file.path, fp, async () => {
      const raw = await host.readText(file.path)
      if (raw === null || raw === '') return []
      let chat
      try { chat = JSON.parse(raw) } catch { return [] }
      if (!chat || typeof chat !== 'object' || !Array.isArray(chat.messages)) return []
      const stem = basenameOf(file.name).replace(/\.json$/i, '')
      const sessionId = typeof chat.sessionId === 'string' && chat.sessionId ? chat.sessionId : stem
      const title = firstUserTitle(chat.messages, (m) => (m && m.type === 'user' ? geminiPartsText(m.content) : ''))
      const dir = Array.isArray(chat.directories) && chat.directories.length > 0 ? chat.directories[0] : undefined
      return [makeEntry({
        format: 'gemini', sessionId, title,
        project: projectFromRecord(dir, () => geminiLayoutProject(file.path)),
        createdAt: parseTimeValue(chat.startTime), lastActiveAt: st.mtimeMs, sourcePath: file.path, cwd: dir,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

function geminiPartsText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : ''))
    .join('\n')
}

// antigravity：~/.gemini/(antigravity|antigravity-cli|antigravity-ide)/ 的
// 每会话一目录布局（Antigravity 是 Gemini CLI 的后续产品，共用 ~/.gemini 前缀但
// 存储形态不同，故独立成源；根名随产品版本分化，三根共用同一内层布局）：
//   conversations/<id>.db | <id>.pb                   命中记录（.db=SQLite、.pb=
//                                                       protobuf，正文都不读）
//   brain/<id>/.system_generated/logs/transcript.jsonl 明文逐行 JSON（发现与导入都读它）
//   annotations/<id>.pbtxt                             标题（protobuf 文本格式）
// 条目按 conversations/*.db + *.pb 枚举（会话即该文件；新旧格式可能同名并存，按 id
// 去重），sourcePath 指向 transcript.jsonl——它才是导入输入；缺 transcript 的会话
// 无正文可导，不产出条目。
export async function scanAntigravity(host, target, bm, emit) {
  const convDir = join(target, 'conversations')
  const brainDir = join(target, 'brain')
  const annoDir = join(target, 'annotations')
  const files = []
  await walkFiles(host, convDir, files, (name) => /\.(db|pb)$/i.test(name))
  const seen = new Set()
  const out = []
  for (const file of files) {
    const id = basenameOf(file.name).replace(/\.(db|pb)$/i, '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    const transcriptPath = join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl')
    const st = await host.stat(transcriptPath)
    if (!st) continue
    const fp = { mtimeMs: st.mtimeMs, sizeBytes: st.size }
    const entries = await probeSource(bm, 'antigravity', transcriptPath, fp, async () => {
      // 只读头部抽元数据（大转录不整读）：标题取首条 USER_INPUT，cwd 按 tool_calls 频次。
      const head = await host.readHead(transcriptPath, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const recs = parseJsonlHead(head)
      if (recs.length === 0) return []
      let title = ''
      const cwdCounts = new Map()
      for (const rec of recs) {
        if (!rec || typeof rec !== 'object') continue
        if (!title && rec.type === 'USER_INPUT') {
          title = antigravityPromptTitle(rec.content)
        }
        if (Array.isArray(rec.tool_calls)) {
          for (const tc of rec.tool_calls) {
            const v = antigravityUnquote(tc && tc.args && tc.args.Cwd)
            if (typeof v === 'string' && v.startsWith('/')) cwdCounts.set(v, (cwdCounts.get(v) || 0) + 1)
          }
        }
      }
      let cwd = null
      let best = 0
      for (const [v, n] of cwdCounts) if (n > best) { cwd = v; best = n }
      // 标题权威来源是 annotations/<id>.pbtxt（重命名后同步）；缺失回退首问。
      const annoRaw = await host.readText(join(annoDir, id + '.pbtxt'))
      const annoTitle = antigravityAnnotationTitle(annoRaw)
      if (annoTitle) title = annoTitle
      return [makeEntry({
        format: 'antigravity',
        sessionId: id,
        title,
        project: antigravityLayoutProject(transcriptPath),
        createdAt: parseTimeValue(recs[0] && recs[0].created_at),
        lastActiveAt: st.mtimeMs,
        sourcePath: transcriptPath,
        cwd,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

// ── antigravity 头部解析辅助（发现层不依赖 convert 层，按同款规则内联）──────
// Antigravity 把提问包在 <USER_REQUEST> 里，另带 <ADDITIONAL_METADATA> 脚手架 → 剥壳。
function antigravityUnwrapUserRequest(text) {
  let s = String(text ?? '')
  const m = s.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i)
  if (m) s = m[1]
  s = s.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
  s = s.replace(/<\/?USER_REQUEST>/gi, '')
  return s.trim()
}

// USER_INPUT 记录 → 标题候选（复用统一标题归一，超 80 字符截断加省略号）。
function antigravityPromptTitle(content) {
  return normalizeTitle(antigravityUnwrapUserRequest(content))
}

// annotations/<id>.pbtxt 是 protobuf 文本格式（title:"…"）；只取标题字段。
function antigravityAnnotationTitle(raw) {
  const m = String(raw ?? '').match(/title\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (!m) return ''
  try {
    return normalizeTitle(JSON.parse(`"${m[1]}"`))
  } catch {
    return normalizeTitle(m[1])
  }
}

// Antigravity 把 shell 风格参数存成带引号字符串（"55"）→ 还原字面值。
function antigravityUnquote(value) {
  if (typeof value !== 'string') return value
  const s = value.trim()
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s)
    } catch {
      return s.slice(1, -1)
    }
  }
  return value
}

// 项目名布局：~/.gemini/history/<slot>/chats/… → slot。
export function geminiLayoutProject(sourcePath) {
  const m = slashPath(sourcePath).match(/\/history\/([^/]+)\/chats\//)
  return m ? m[1] : null
}

// ~/.gemini/(antigravity|antigravity-cli|antigravity-ide)/brain/<id>/
// .system_generated/logs/transcript.jsonl：无项目分目录概念（每会话一个 id
// 目录）→ 固定源标签，工作区由 cwd 归组。
export function antigravityLayoutProject(sourcePath) {
  return /\/brain\/[^/]+\//.test(slashPath(sourcePath)) ? 'antigravity' : null
}
