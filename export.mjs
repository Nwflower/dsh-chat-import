// export.mjs — 反向导出序列化器 re-export shim（纯函数，零 DSH 依赖）
//
// 原单文件实现已拆分到 lib/export/ 下（按目标格式：claude.mjs — Claude Code JSONL）。
// 本文件只做 re-export，保持 export.mjs 的既有 public export 名与相对顺序不变；
// index.mjs / lib/ / test/ 等既有 import 路径与 package.json `exports["./export.mjs"]`
// 子路径契约均无需改动。
export {
  slugifyClaudeCwd,
  serializeClaudeJsonl,
  tailClaudeEvents,
  serializeClaudeJsonlTail,
  verifyClaudeJsonl,
} from './lib/export/claude.mjs'

// REQ-56/62 interchange bundle（备份/便携格式，纯函数）
export {
  BUNDLE_NAMESPACE,
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  sessionLogToJsonl,
  serializeBundle,
  verifyBundle,
} from './lib/export/bundle.mjs'

// REQ-23 矩阵化互转（DSH → Codex rollout / DSH → Kimi wire，纯函数）
export {
  serializeCodexRecords,
  serializeCodexJsonl,
  serializeCodexJsonlTail,
  verifyCodexJsonl,
} from './lib/export/codex.mjs'

export {
  serializeKimiRecords,
  serializeKimiWire,
  verifyKimiWire,
} from './lib/export/kimi.mjs'
