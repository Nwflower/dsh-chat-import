// lib/export/index.mjs — 反向导出序列化器 re-export shim（纯函数，零 DSH 依赖）
//
// 公开包出口：package.json `exports["./export.mjs"]` 指向本文件，导出名即对外契约。
// 导出层按目标格式拆在本目录下（claude.mjs — Claude Code JSONL 等，共用件在 common.mjs）；
// 本文件只做 re-export。
export {
  slugifyClaudeCwd,
  serializeClaudeJsonl,
} from './claude.mjs'

// interchange bundle（备份/便携格式，纯函数）
export {
  BUNDLE_NAMESPACE,
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  sessionLogToJsonl,
  serializeBundle,
  verifyBundle,
} from './bundle.mjs'

// 矩阵化互转（DSH → Codex rollout / DSH → Kimi wire，纯函数）
export {
  serializeCodexRecords,
  serializeCodexJsonl,
  verifyCodexJsonl,
} from './codex.mjs'

export {
  serializeKimiRecords,
  serializeKimiWire,
  verifyKimiWire,
} from './kimi.mjs'

// 反向导出：DSH 会话 → opencode `import <file>` JSON（纯函数）
export {
  buildOpencodeImportDoc,
  serializeOpencodeJson,
  verifyOpencodeImportJson,
} from './opencode.mjs'
