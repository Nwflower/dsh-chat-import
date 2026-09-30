// lib/convert/codex-external-agent.mjs — Codex Desktop「外部 agent 会话导入」展平信封的还原（纯函数）。
//
// 存储契约：Codex Desktop 的「导入外部 agent 会话」（~/.codex/external_agent_session_imports.json）
// 把 foreign transcript（本机实测 45 条全部来自 Claude Code）写成 Codex rollout 时，foreign
// 工具调用**没有** function_call / custom_tool_call 记录——调用与结果被展平成 assistant 正文
// 里的文本信封，放进同一个 output_text 块（当正文导入会被 markdown 渲染：实测 python 命令里
// 的 `# 注释` 行变成巨型标题、130+ 次 Edit 全变成散文），故在本层还原成 IR 的 tool-call /
// tool-result 块——还原的是源侧本来就有的结构：
//   [external_agent_tool_call: <Name>]\n<payload>\n[/external_agent_tool_call]
//   [external_agent_tool_result[: <marker>]]\n<正文>\n[/external_agent_tool_result]
//
// 形态普查（本机 45 条 rollout / 18036 条 assistant 消息，2026-09）：
//   * 7690 个 call、7689 个 result；`<marker>` 实测只有 `error` 一种（638 条）→ isError；
//   * 14477 个块信封独占整块，776 个块与正文混排，102 个块含多个信封 → 必须逐行扫描、
//     按段切分，不能要求「整块即信封」；
//   * 信封**只在 assistant 侧**出现（user 侧 0 条），故 user 分支不处理；
//   * 信封不带 call_id，也不保证与结果一一对应 → 结果按「最早未配对调用」FIFO 配对。
//
// 契约：
//   * 还原不虚构：载荷键名与内容照抄信封（Codex 自己把 file_path 写成 file，并丢掉 Edit/Write
//     的正文——本层无法补回，也不补）；
//   * 未闭合的信封、认不出的载荷、未知的结果标记都留在正文里并计入 malformed（失败要大声）；
//   * 找不到调用的结果保留原文信封作正文并计入 orphanResults（绝不静默丢内容）；
//   * 返回 { segments, malformed }：segments 为按出现顺序切出的段（kind: text | call | result），
//     无信封时原样返回一个 text 段（不改一个字节）。
//
// 本模块只做纯转换：不读磁盘、不 import 宿主服务，与 lib/convert/codex.mjs 同层；单独成文件
// 是因为 codex.mjs 已接近体量停止线（AGENTS.md）。
const EXT_CALL_HEAD = /^\[external_agent_tool_call:\s*([^\]]*?)\s*\]$/
const EXT_CALL_TAIL = '[/external_agent_tool_call]'
const EXT_RESULT_HEAD = /^\[external_agent_tool_result(?::\s*([^\]]*?))?\s*\]$/
const EXT_RESULT_TAIL = '[/external_agent_tool_result]'

export function splitExternalAgentEnvelopes(text) {
  const src = String(text ?? '')
  // 快路径：不含信封标记的块原样返回（字节不变，绝大多数块走这里）
  if (!src.includes('[external_agent_tool_')) return { segments: [{ kind: 'text', text: src }], malformed: 0 }
  const lines = src.split('\n')
  const strip = (l) => (l.endsWith('\r') ? l.slice(0, -1) : l)
  const segments = []
  let malformed = 0
  let buf = []
  const flush = () => {
    const t = buf.join('\n').trim()
    if (t) segments.push({ kind: 'text', text: t })
    buf = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = strip(lines[i])
    const head = line.trim()
    const call = EXT_CALL_HEAD.exec(head)
    const result = call ? null : EXT_RESULT_HEAD.exec(head)
    if (!call && !result) { buf.push(line); continue }
    const tail = call ? EXT_CALL_TAIL : EXT_RESULT_TAIL
    let end = -1
    for (let j = i + 1; j < lines.length; j++) {
      if (strip(lines[j]).trim() === tail) { end = j; break }
    }
    if (end === -1) {
      // 未闭合：整段按正文保留（内容不丢），计数（schema 漂移要大声）
      malformed += 1
      buf.push(line)
      continue
    }
    const body = lines.slice(i + 1, end).map(strip).join('\n')
    const raw = [head, body, tail].join('\n')
    if (call) {
      const name = String(call[1] ?? '').trim()
      if (!name) {
        malformed += 1
        buf.push(raw)
      } else {
        flush()
        segments.push({ kind: 'call', name, payload: body, raw })
      }
    } else {
      const marker = result[1] === undefined ? '' : String(result[1]).trim()
      if (marker && marker.toLowerCase() !== 'error') malformed += 1
      flush()
      segments.push({ kind: 'result', text: body, isError: marker.toLowerCase() === 'error', raw })
    }
    i = end
  }
  flush()
  return { segments, malformed }
}

// 正文里是否残留展平信封（供 verify_session 点名存量旧形状：0.24.0 之前的转换器把这类
// 信封当正文导入，日志 append-only、重导前一直是散文，见 docs/architecture.md D18）。
// 行首锚定：正文里引用/讨论该标记的句子不误报。
export function hasExternalAgentEnvelope(text) {
  return /^\[external_agent_tool_(?:call|result)\b/m.test(String(text ?? ''))
}

// 信封载荷 → 工具 arguments（JSON 文本）。三种形态（本机 45 条 rollout 全覆盖）：
//   1. `input: {…}`（Codex 照抄外部 tool_use 的 input，单行或多行 JSON）→ 原样作为 arguments；
//   2. `key: value` 行（Bash 的 description+command、Read/Edit/Write 的 file）→ 逐键组对象，
//      值可跨行（`command` 里的多行脚本），下一个 key 行起新键；
//   3. 认不出的载荷 → `{"input": <原文>}` 并回报 malformed（绝不静默丢载荷）。
export function externalAgentArguments(payload) {
  const text = String(payload ?? '')
  const trimmed = text.trim()
  if (!trimmed) return { arguments: '{}', malformed: false }
  const lines = trimmed.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  const inputLine = /^input:\s*([\s\S]*)$/.exec(lines[0])
  if (inputLine) {
    const candidate = [inputLine[1], ...lines.slice(1)].join('\n').trim()
    if (jsonObjectTextOrNull(candidate)) return { arguments: candidate, malformed: false }
  }
  const pairs = externalAgentKeyValuePairs(lines)
  if (pairs !== null) return { arguments: JSON.stringify(pairs), malformed: false }
  return { arguments: JSON.stringify({ input: text }), malformed: true }
}

// 载荷文本是否是 JSON 对象/数组（是则原样可用作 arguments；标量与畸形串不算）。
function jsonObjectTextOrNull(text) {
  try {
    const v = JSON.parse(text)
    return v !== null && typeof v === 'object' ? text : null
  } catch {
    return null
  }
}

// `key: value` 行 → 对象。首行不是 key 行时返回 null（交给调用方走兜底）。
// key 限定为标识符 + 冒号（后可跟空格或行尾）：Windows 路径行（`D:\…`）不会误判成 key。
const EXT_KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]([\s\S]*))?$/
function externalAgentKeyValuePairs(lines) {
  const out = {}
  let key = null
  let value = []
  const commit = () => {
    if (key !== null) out[key] = value.join('\n').replace(/\n+$/, '')
  }
  for (const line of lines) {
    const m = EXT_KEY_LINE.exec(line)
    if (m) {
      commit()
      key = m[1]
      value = [m[2] === undefined ? '' : m[2]]
      continue
    }
    if (key === null) return null
    value.push(line)
  }
  commit()
  return key === null ? null : out
}

