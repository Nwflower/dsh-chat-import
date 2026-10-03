// lib/convert/index.mjs — 外部聊天记录 → DSH 会话事件（纯函数，无宿主依赖）re-export shim
//（原根目录 convert.mjs，2026-09 随根目录清理迁入本层）
//
// 转换层按源拆在本目录下（core.mjs 共享核心 + 每源一个文件）。
// 本文件只做 re-export，保持既有 public export 名与相对顺序不变。
// 各源格式的 `convertXxx(raw, args)`
// 把原始 transcript 文本解析成统一的回合中间结构，再交给共享的 synthesizeSession
// 合成 DSH 事件日志，保证所有来源的事件纪律一致（来源清单见 lib/discovery.mjs 的
// FORMATS，每源的实现与存储契约写在各自的 lib/convert/<source>.mjs 头部）。

export {
  SESSION_FORMAT_VERSION,
  parseTime,
  mintSessionId,
  mapContentBlock,
  shapeToolResults,
  toolResultOf,
  tailSessionEvents,
  estimateTokens,
  TEXT_BLOCK_CHAR_LIMIT,
  TOOL_RESULT_CHAR_LIMIT,
  cropContentBlocks,
  trimTurns,
  applyBudgetTrim,
  validateSessionEvents,
  isEnvInjectionEvent,
  ENV_INJECTION_EVENT_ID_SUFFIX,
} from './core.mjs'

// 注入内容识别与信封剥离（全源共用唯一真相源，见 inject.mjs 文件头）
export {
  INJECT_MARKERS,
  isInjectedTopic,
  stripPastedWrapper,
  stripUserQueryWrapper,
} from './inject.mjs'

// 图片块构造（来源侧字节 → IR image 块；纯函数，零宿主依赖）
export {
  IMAGE_MEDIA_TYPES,
  MAX_IMAGE_BASE64_CHARS,
  IMAGE_PLACEHOLDER,
  normalizeImageMediaType,
  sniffImageMediaType,
  imageDisplayName,
  imageBlockFromBase64,
  imageBlockFromDataUrl,
  imageBlockFromBytes,
  imageBlockFromSource,
  isImageBlock,
} from './image.mjs'

// 降级规则与导出降级清单
export {
  DEGRADATION_RULES,
  summarizeDegradations,
  exportDegradations,
} from './interchange.mjs'

export {
  convertClaudeJsonl,
} from './claude.mjs'

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

export {
  convertChatgptJson,
} from './chatgpt.mjs'

export {
  convertCursorJsonl,
} from './cursor.mjs'

export {
  convertGeminiJson,
} from './gemini.mjs'

export {
  convertAntigravityJsonl,
  indexTaskMessages,
  parseAnnotationTitle,
  unwrapUserRequest,
} from './antigravity.mjs'

export {
  reasonixStemTime,
  convertReasonixJsonl,
} from './reasonix.mjs'

export {
  convertPiJsonl,
} from './pi.mjs'

export {
  convertOpencodeJson,
} from './opencode.mjs'

export {
  convertMimocodeJson,
} from './mimocode.mjs'

export {
  convertTeleagentJson,
} from './teleagent.mjs'

export {
  convertTraeJson,
} from './trae.mjs'

export {
  convertKilocodeJson,
} from './kilocode.mjs'

export {
  convertZcodeJson,
} from './zcode.mjs'

export {
  convertGrokbuildJson,
} from './grokbuild.mjs'

export {
  convertOpenclawJson,
} from './openclaw.mjs'

export {
  convertHermesJson,
} from './hermes.mjs'

export {
  convertKimiWire,
} from './kimi.mjs'

export {
  convertQoderJsonl,
} from './qoder.mjs'

export {
  convertWorkbuddyJsonl,
} from './workbuddy.mjs'

export {
  convertQwenJsonl,
} from './qwen.mjs'

export {
  convertContinueJson,
  readContinueIndex,
} from './continue.mjs'

export {
  convertClineJson,
  clineMessagesPath,
  clineLegacyApiHistoryPath,
  clineLegacyTaskHistoryPath,
  clineLegacyUiMessagesPath,
  parseClineLegacyTaskHistory,
  readClineManifest,
} from './cline.mjs'

export {
  convertGooseJson,
  gooseDataDir,
  gooseSessionsDir,
  gooseDefaultDbPath,
} from './goose.mjs'

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

export {
  convertDshJsonl,
} from './dsh.mjs'

export {
  convertLocalJsonl,
  LOCAL_JSONL_FORMATS,
} from './local-jsonl.mjs'
