// lib/discovery/common.mjs — 发现层共用的纯函数：路径切分、JSONL 头解析、标题/时间提取与条目构造
//
// 只依赖 convert 层的纯函数（注入识别 / 标题归一），不做任何 I/O；各来源族扫描器
// （lib/discovery/<族>.mjs）共用这一份口径，条目 schema 由 makeEntry 统一。

import { isInjectedTopic } from '../convert/inject.mjs'
import { normalizeTitle } from '../convert/util.mjs'

export const HEAD_MAX_BYTES = 256 * 1024

// 发现期只读转录的头 / 尾两段，不整读：头部给会话元数据与首问，尾部给后追加的记录（改名、
// 最新用量 → 上下文 token 数）。
export const TAIL_MAX_BYTES = 64 * 1024

function pathSegments(p) {
  return String(p ?? '').split(/[\\/]/).filter((s) => s.length > 0)
}

// 统一为 '/' 分隔（布局正则只写一种分隔符）。
export function slashPath(p) {
  return String(p ?? '').replace(/\\/g, '/')
}

export function basenameOf(p) {
  const s = pathSegments(p)
  return s[s.length - 1] ?? ''
}

// 取父目录：标签回退（项目名）与 kimiWorkDir 自底向上找 kimi.json 都用它；host 侧
// stat/readText 会归一分隔符，故此处归一后拼接安全（与 import-variants 的 parentOf 同语义）。
export function dirnameOf(p) {
  const s = pathSegments(p)
  s.pop()
  return s.join('/')
}

// 同目录伴生文件路径：保留原分隔符（host 给的同目录子项路径必须原样可查）。
export function siblingPath(filePath, suffixName) {
  const m = String(filePath).match(/[\\/][^\\/]+$/)
  return m ? filePath.slice(0, m.index + 1) + suffixName : filePath
}

// JSONL 头解析：畸形/截断行跳过（发现阶段只取元数据，不整读、不做行级明细）。
export function parseJsonlHead(head) {
  const recs = []
  for (const line of String(head ?? '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    try { recs.push(JSON.parse(t)) } catch { /* 截断尾行/畸形行跳过 */ }
  }
  return recs
}

// 注入判定委托 convert/inject.mjs 的唯一真相源（前缀表与语义见该模块文件头，含 Grok 的
// <user_info> 环境块）；这里是发现层沿用的导出名。
export function isInjectedTitle(text) {
  return isInjectedTopic(text)
}

// content → 纯文本（发现层「首问作标题」的口径）：string 原样；block 数组取各 block 的 text
// 字段（tool_result 不算用户提问，跳过）——input_text/output_text 块自带 text，无需按类型分支；
// {text} 对象取 text。与 lib/convert/util.mjs 的 contentText 语义不同（那边不排除
// tool_result、不跳过纯空白块、不收单个 {text} 对象），各来源的标题提取都依赖这里的口径，故不共用。
export function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'tool_result') continue
      if (typeof block.text === 'string' && block.text.trim()) parts.push(block.text)
    }
    return parts.join('\n')
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text
  return ''
}

// 首条真实 user 文本（注入过滤；不归一，供 Cursor 时间戳解析）。
export function firstUserRawText(recs, extract) {
  for (const rec of recs) {
    const text = extract(rec)
    const t = String(text ?? '').trim()
    if (!t || isInjectedTitle(t)) continue
    return t
  }
  return null
}

// 首条真实 user 文本（注入过滤 + 归一）；无 → null。
export function firstUserTitle(recs, extract) {
  const raw = firstUserRawText(recs, extract)
  return raw ? normalizeTitle(raw) : null
}

// 时间戳 → 毫秒：数字 >1e12 为毫秒原样、否则秒（截断到整秒）×1000；RFC3339 字符串解析；拿不到
// undefined（对齐 cc-switch parse_timestamp_to_ms）。与转换层 parseTimeMs（lib/convert/core.mjs）
// 的秒 / 毫秒分界不同（那边是 1e11，且毫秒取整、拿不到返回 null）：[1e11, 1e12] 之间的数字
// 这里按秒、那边按毫秒，换用会改变这段数值的解读，故暂不共用。
export function parseTimeValue(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : Math.trunc(v) * 1000
  if (typeof v === 'string' && v) {
    const n = Date.parse(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

export function firstString(recs, pick) {
  for (const r of recs) {
    const v = pick(r)
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

export function firstNumber(recs, pick) {
  for (const r of recs) {
    const v = pick(r)
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

// 项目名：记录内 cwd/directory basename 优先，否则布局正则回退。
export function projectFromRecord(cwd, layoutFallback) {
  const base = cwd ? basenameOf(cwd) : ''
  return base || layoutFallback() || null
}

// 结构化条目（未知字段统一 null，保证 schema 稳定）。
// cwd = 会话记录里的完整工作区路径（git 状态等按目录解析的增强信息用；无记录为 null，
// 发现层 fallback 到源文件目录）。
export function makeEntry({ format, sessionId, title, project, createdAt, lastActiveAt, contextTokens, sourcePath, cwd }) {
  const intOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null)
  return {
    format,
    sessionId,
    title: title || null,
    project: project || null,
    createdAt: intOrNull(createdAt),
    lastActiveAt: intOrNull(lastActiveAt),
    contextTokens: intOrNull(contextTokens),
    sourcePath,
    cwd: cwd || null,
    importStatus: null, // discoverSessions 统一填充（本模块不做 registry I/O）
  }
}

// 单文件书签指纹（mtime + size）。
export function fileFingerprint(st) {
  return { mtimeMs: st.mtimeMs, sizeBytes: st.size }
}

// 多文件源的复合书签指纹：主文件 + 伴生文件（缺失的伴生文件记空）。mtimeMs 为 'a|b|…' 复合串、
// sizeBytes 求和——任一文件出现 / 消失 / 变化都会失效。串的拼法进入持久化书签签名
//（scan-cache.json），改拼法等于让既有书签整体失效。
export function compositeFingerprint(primary, ...companions) {
  return {
    mtimeMs: primary.mtimeMs + companions.map((c) => '|' + (c ? c.mtimeMs : '')).join(''),
    sizeBytes: companions.reduce((sum, c) => sum + (c ? c.size : 0), primary.size),
  }
}

// 逐条产出（面板流式扫描底座）：emit 缺省时纯收集（既有全部调用零变化）；给定
// emit 时按与 out 收集数组一致的顺序逐条转发，调用方边扫边渲染、不必等全量。
// async：emit 可能做异步状态标注（git 分支），await 让事件循环逐条让出——
// 扫描期间宿主 Web 服务不被同步 fs 冻住。
export async function emitEach(emit, entries) {
  if (!emit || !entries || entries.length === 0) return
  for (const e of entries) await emit(e)
}
