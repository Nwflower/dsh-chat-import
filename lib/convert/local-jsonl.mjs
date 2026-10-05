// lib/convert/local-jsonl.mjs — 本地会话文件的格式自动识别入口（纯函数）。
//
// 三级探测（顺序即优先级，命中即不再往下试）：
//   1. **显式覆盖**：args.format 指定解析器（工具 parseFormat / 面板格式下拉 / 命令）——
//      直接跑该转换器，识别不准时用户说了算；
//   2. **内容标记**：interchange 文档（generic）与 .dshbundle 便携包标记，按契约出现在
//      文档顶部（只扫前 64KB）。命中 generic 就只跑 generic 转换器（标记权威，不再猜）；
//      命中 bundle 不在这里转换——返回 { bundle: true }，调用方转交 restore_bundle；
//   3. **候选试跑**：路径特征足够明确时只试对应格式（报 path-hint），否则按全量候选逐个
//      转换器试到第一个产出 meta 且含轮次/事件的结果。vibe 等目录源由 host 面按目录收集后逐个文件走
//      本入口。
//
// 结果附 detectedFormat（命中格式）与 detectedBy（override / marker / path-hint / content），
// 未命中时附 failures：**每个**候选格式的失败原因（全量，不再是只记第一条）——面板「从
// 文件导入」把它摊开给用户看，并给出「强制格式重试 / 用 generic 格式 / 报告此格式」三个
// 出口（D4 失败要大声：识别失败不能是死胡同）。
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
import { convertGenericJson, sniffInterchangeMarker } from './generic.mjs'
import { sanitizeParseError } from './core.mjs'
import { skipResult } from './util.mjs'

const LOCAL_JSONL_FORMATS = ['dsh', 'claude', 'codex', 'cursor', 'reasonix', 'pi', 'openclaw', 'hermes', 'qoder', 'vibe', 'generic']

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
  generic: convertGenericJson,
}

// 路径特征 → 候选格式。返回单元素数组 = 该路径足够特征，只试这一种（识别来源报
// path-hint，试不出会话即失败，不再换格式猜）；返回全长列表 = 只能靠内容试跑。
function pathPriority(sourcePath) {
  const lower = String(sourcePath || '').toLowerCase()
  if (/[\\/]session\.jsonl(\.zstd)?$/.test(lower)) return ['dsh']
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

function hasContent(out) {
  return !!(out && out.meta
    && ((Array.isArray(out.turns) && out.turns.length > 0)
      || (Array.isArray(out.events) && out.events.length > 0)))
}

// 失败原因（面板/工具原样展示给用户，写清「为什么这个格式不行」）。
function failureReason(out) {
  if (!out) return '无结果'
  if (typeof out.skipReason === 'string' && out.skipReason) return out.skipReason
  if (!out.meta) return '无会话元数据（不是该格式）'
  return '0 轮（没有可导入的对话）'
}

function runConverter(format, raw, args) {
  return CONVERTERS[format](raw, { ...args, sourcePath: args.sourcePath })
}

export function convertLocalJsonl(raw, args = {}) {
  // 1. 显式覆盖
  const requested = typeof args.format === 'string' && args.format !== 'auto' && CONVERTERS[args.format]
    ? args.format : null
  if (requested) {
    const out = runConverter(requested, raw, args)
    if (hasContent(out)) return { ...out, detectedFormat: requested, detectedBy: 'override' }
    const failures = [{ format: requested, reason: failureReason(out) }]
    return {
      ...(out || skipResult()),
      detectedFormat: null, detectedBy: 'override', failures,
      skipReason: out && out.skipReason ? out.skipReason : '指定的格式 ' + requested + '：' + failureReason(out),
    }
  }

  // 2. 内容标记（标记权威：命中 generic 只跑 generic，版本不符也大声报错而不是换格式猜）
  const marker = sniffInterchangeMarker(typeof raw === 'string' ? raw : '')
  if (marker === 'bundle') {
    return skipResult('interchange 便携包（.dshbundle）：请用 restore_bundle 还原，不走普通导入', {
      bundle: true, detectedFormat: null, detectedBy: 'marker',
    })
  }
  if (marker === 'generic') {
    const out = runConverter('generic', raw, args)
    if (hasContent(out)) return { ...out, detectedFormat: 'generic', detectedBy: 'marker' }
    return {
      ...(out || skipResult()),
      detectedFormat: null, detectedBy: 'marker',
      failures: [{ format: 'generic', reason: failureReason(out) }],
    }
  }

  // 3. 候选试跑
  const order = [...new Set(pathPriority(args.sourcePath))]
  const failures = []
  let firstFailure = null
  for (const format of order) {
    let out = null
    try {
      out = runConverter(format, raw, args)
    } catch (err) {
      failures.push({ format, reason: '解析抛错：' + sanitizeParseError(err) })
      continue
    }
    if (hasContent(out)) {
      return {
        ...out,
        detectedFormat: format,
        detectedBy: order.length === 1 ? 'path-hint' : 'content',
      }
    }
    failures.push({ format, reason: failureReason(out) })
    if (!firstFailure) firstFailure = out
  }
  const base = firstFailure || skipResult('unrecognized local transcript')
  return {
    ...base,
    detectedFormat: null, detectedBy: null, failures,
    ...(base.skipReason ? {} : { skipReason: '未能识别该文件的格式' }),
  }
}
