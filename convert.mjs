// convert.mjs — 外部聊天记录 → DSH 会话事件（纯函数，无宿主依赖）re-export shim
//
// 原单文件实现已按源拆到 lib/convert/ 下（core.mjs 共享核心 + 每源一个文件）。
// 本文件只做 re-export，保持 convert.mjs 的既有 public export 名与相对顺序不变，
// index.mjs / lib/ / test/ 等既有 import 路径无需改动。各源格式的 `convertXxx(raw, args)`
// 把原始 transcript 文本解析成统一的回合中间结构，再交给共享的 synthesizeSession
// 合成 DSH 事件日志，保证所有源（Claude Code / Codex-ChatGPT / ChatGPT / Cursor /
// Gemini / Reasonix / Pi Coding Agent / opencode / zcode / grokbuild / openclaw /
// hermes）事件纪律一致。

export {
  SESSION_FORMAT_VERSION,
  parseTime,
  mintSessionId,
  mapContentBlock,
  tailSessionEvents,
  estimateTokens,
  TEXT_BLOCK_CHAR_LIMIT,
  TOOL_RESULT_CHAR_LIMIT,
  cropContentBlocks,
  trimTurns,
  applyBudgetTrim,
  validateSessionEvents,
} from './lib/convert/core.mjs'

// REQ-18 interchange v1 协议（IR 显式化 + 能力矩阵 + REQ-21 降级规则）
export {
  INTERCHANGE_VERSION,
  INTERCHANGE_NAMESPACE,
  INTERCHANGE_SCHEMA,
  validateInterchange,
  serializeInterchange,
  SOURCE_CAPABILITIES,
  DEGRADATION_RULES,
  summarizeDegradations,
  exportDegradations,
} from './lib/convert/interchange.mjs'

export {
  convertClaudeJsonl,
} from './lib/convert/claude.mjs'

export {
  convertCodexJsonl,
  codexCustomToolArguments,
  jsObjectLiteralToJson,
} from './lib/convert/codex.mjs'

export {
  convertChatgptJson,
} from './lib/convert/chatgpt.mjs'

export {
  convertCursorJsonl,
} from './lib/convert/cursor.mjs'

export {
  convertGeminiJson,
} from './lib/convert/gemini.mjs'

export {
  reasonixStemTime,
  convertReasonixJsonl,
} from './lib/convert/reasonix.mjs'

export {
  convertPiJsonl,
} from './lib/convert/pi.mjs'

export {
  convertOpencodeJson,
} from './lib/convert/opencode.mjs'

export {
  convertMimocodeJson,
} from './lib/convert/mimocode.mjs'

export {
  convertZcodeJson,
} from './lib/convert/zcode.mjs'

export {
  convertGrokbuildJson,
} from './lib/convert/grokbuild.mjs'

export {
  convertOpenclawJson,
} from './lib/convert/openclaw.mjs'

export {
  convertHermesJson,
} from './lib/convert/hermes.mjs'

export {
  convertKimiWire,
} from './lib/convert/kimi.mjs'

export {
  convertQoderJsonl,
} from './lib/convert/qoder.mjs'

export {
  convertWorkbuddyJsonl,
} from './lib/convert/workbuddy.mjs'

export {
  convertQwenJsonl,
  realWorkspaceDir,
} from './lib/convert/qwen.mjs'

export {
  convertDshJsonl,
} from './lib/convert/dsh.mjs'

export {
  convertLocalJsonl,
  LOCAL_JSONL_FORMATS,
} from './lib/convert/local-jsonl.mjs'
