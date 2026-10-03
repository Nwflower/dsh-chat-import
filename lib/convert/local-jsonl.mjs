// lib/convert/local-jsonl.mjs — 本地 JSONL 会话文件的格式自动识别入口。
// 输入路径可为任意 .jsonl；按路径特征排序候选后逐个尝试各源转换器，
// 取第一个能产出 meta 且含轮次/事件的转换结果。`format` 入参可跳过探测。
import { convertDshJsonl } from './dsh.mjs'
import { convertClaudeJsonl } from './claude.mjs'
import { convertCodexJsonl } from './codex.mjs'
import { convertCursorJsonl } from './cursor.mjs'
import { convertReasonixJsonl } from './reasonix.mjs'
import { convertPiJsonl } from './pi.mjs'
import { convertOpenclawJson } from './openclaw.mjs'
import { convertHermesJson } from './hermes.mjs'
import { convertQoderJsonl } from './qoder.mjs'
import { convertVibeJson } from './vibe.mjs'

export const LOCAL_JSONL_FORMATS = ['dsh', 'claude', 'codex', 'cursor', 'reasonix', 'pi', 'openclaw', 'hermes', 'qoder', 'vibe']

const CONVERTERS = {
  dsh: convertDshJsonl,
  claude: convertClaudeJsonl,
  codex: convertCodexJsonl,
  cursor: convertCursorJsonl,
  reasonix: convertReasonixJsonl,
  pi: convertPiJsonl,
  openclaw: convertOpenclawJson,
  hermes: convertHermesJson,
  qoder: convertQoderJsonl,
  vibe: convertVibeJson,
}

// 路径特征只用于调整候选顺序，最终仍以转换结果能否产出会话为准。
function pathPriority(sourcePath) {
  const lower = String(sourcePath || '').toLowerCase()
  if (/\/session\.jsonl$/.test(lower)) return ['dsh']
  if (/\bagent-transcripts\b/.test(lower)) return ['cursor']
  if (/(^|[\\/])rollout-/.test(lower)) return ['codex']
  if (/(^|[\\/])(desktop|subagent)-/.test(lower)) return ['reasonix']
  if (/\.pi[\\/]agent[\\/]sessions[\\/]/.test(lower)) return ['pi']
  if (/\bagents\b.*\bsessions\b/.test(lower)) return ['openclaw']
  if (/\.hermes[\\/]/.test(lower)) return ['hermes']
  if (/\.claude[\\/]/.test(lower)) return ['claude']
  if (/\.qoder[\\/]projects[\\/]/.test(lower)) return ['qoder']
  if (/(\.vibe[\\/]logs[\\/]session|messages\.jsonl$)/.test(lower)) return ['vibe']
  return LOCAL_JSONL_FORMATS
}

function orderedFormats(args) {
  const requested = typeof args.format === 'string' && CONVERTERS[args.format] ? [args.format] : []
  return [...new Set([...requested, ...pathPriority(args.sourcePath)])]
}

export function convertLocalJsonl(raw, args = {}) {
  let firstFailure = null
  for (const format of orderedFormats(args)) {
    try {
      const out = CONVERTERS[format](raw, { ...args, sourcePath: args.sourcePath })
      const hasContent = out && out.meta
        && ((Array.isArray(out.turns) && out.turns.length > 0)
          || (Array.isArray(out.events) && out.events.length > 0))
      if (hasContent) {
        out.detectedFormat = format
        return out
      }
      if (!firstFailure) firstFailure = out
    } catch (err) {
      if (!firstFailure) {
        firstFailure = { error: err && err.message ? err.message : String(err), meta: null, events: [], turns: [], messages: 0, toolCalls: 0, skipped: 0 }
      }
    }
  }
  if (firstFailure) return firstFailure
  return {
    meta: null,
    events: [],
    turns: [],
    messages: 0,
    toolCalls: 0,
    skipped: 0,
    skipReason: 'unrecognized local JSONL transcript',
  }
}
