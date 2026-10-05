// lib/convert/index.mjs — 转换层对 host 面的 re-export 出口（纯函数，无宿主依赖）
//
// 转换层按源拆在本目录下：每个来源一个 `<source>.mjs`（convertXxx(raw, args) 把原始
// transcript 解析成统一的回合中间结构，文件头写清存储契约），共用件在 core / events /
// trim / shape / validate / image / inject / util / ir。本文件只 re-export host 面（lib/*.mjs、
// lib/sources/*）与测试实际经由这里取用的名字；来源清单见 lib/discovery.mjs 的 FORMATS。
// 不是公开包出口——公开面只有 lib/export/index.mjs。

export {
  SESSION_FORMAT_VERSION,
  parseTime,
  parseTimeMs,
  mintSessionId,
  tailSessionEvents,
} from './core.mjs'

// 会话事件的形状契约（读侧形状无关 / 写侧按宿主版本分流）与结构校验
export { shapeToolResults, toolResultOf, isEnvInjectionEvent } from './shape.mjs'
export { validateSessionEvents } from './validate.mjs'

// 预算裁剪
export {
  estimateTokens,
  TEXT_BLOCK_CHAR_LIMIT,
  TOOL_RESULT_CHAR_LIMIT,
  cropContentBlocks,
  trimTurns,
  applyBudgetTrim,
} from './trim.mjs'

// 降级规则与导出降级清单
export {
  DEGRADATION_RULES,
  summarizeDegradations,
  exportDegradations,
} from './interchange.mjs'

export { convertClaudeJsonl } from './claude.mjs'

export {
  convertCodexJsonl,
  codexCustomToolArguments,
  jsObjectLiteralToJson,
} from './codex.mjs'

// Codex Desktop「外部 agent 会话导入」的展平信封还原（纯函数，单独成文件见该文件头）
export {
  splitExternalAgentEnvelopes,
  externalAgentArguments,
  hasExternalAgentEnvelope,
} from './codex-external-agent.mjs'

export { convertChatgptJson } from './chatgpt.mjs'
export { convertCursorJsonl } from './cursor.mjs'
export { convertGeminiJson } from './gemini.mjs'

export {
  convertAntigravityJsonl,
  indexTaskMessages,
  parseAnnotationTitle,
} from './antigravity.mjs'

export {
  reasonixStemTime,
  convertReasonixJsonl,
} from './reasonix.mjs'

export { convertPiJsonl } from './pi.mjs'
export { convertOpencodeJson } from './opencode.mjs'
export { convertMimocodeJson } from './mimocode.mjs'
export { convertTeleagentJson } from './teleagent.mjs'
export { convertTraeJson } from './trae.mjs'
export { convertKilocodeJson } from './kilocode.mjs'
export { convertZcodeJson } from './zcode.mjs'
export { convertGrokbuildJson } from './grokbuild.mjs'
export { convertOpenclawJson } from './openclaw.mjs'
export { convertHermesJson } from './hermes.mjs'
export { convertKimiWire } from './kimi.mjs'
export { convertQoderJsonl } from './qoder.mjs'
export { convertWorkbuddyJsonl } from './workbuddy.mjs'
export { convertQwenJsonl } from './qwen.mjs'

export {
  convertContinueJson,
  readContinueIndex,
} from './continue.mjs'

export { convertClineJson } from './cline.mjs'
export { convertGooseJson } from './goose.mjs'

export {
  convertZedJson,
  zedDataDir,
  zedThreadsDir,
  zedThreadsDbPath,
  zedFolderPaths,
} from './zed.mjs'

export {
  convertCrushJson,
  crushUserDataDir,
  crushRegistryPath,
  crushProjectDbPath,
  parseCrushProjects,
} from './crush.mjs'

export { convertVibeJson } from './vibe.mjs'
export { convertDshJsonl } from './dsh.mjs'
export { convertLocalJsonl } from './local-jsonl.mjs'
export { sniffInterchangeMarker } from './generic.mjs'
