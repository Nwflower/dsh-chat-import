// index.mjs — dsh-chat-import 插件入口（薄组合层）
//
// 外部聊天记录（Claude Code / Codex-ChatGPT / ChatGPT / Cursor / Gemini / Reasonix /
// Pi Coding Agent / opencode / zcode / grokbuild / openclaw / hermes / kimi / qoder / workbuddy）→ DSH 会话
// 导入器 + DSH → Claude Code JSONL 反向导出。消费 host 的 sessionPersistence / fs /
// tools / workspaceRegistry 服务（webServer 可选，经 ctx.inject 延迟挂载）。
//
// 原单文件实现已按职责拆到 lib/ 下（各模块都消费 ctx，非纯函数；lib/convert/* 保持
// 零 DSH 依赖纯函数不变）：
//   lib/budget.mjs          REQ-37 上下文预算解析链（参数 > env > 动态模型窗口 > 静态默认）
//   lib/import-core.mjs     共享导入编排：importTranscript（REQ-24 状态机）/ importDirectory /
//                           runDecision（落盘，REQ-43 agents.create + preset scope）/
//                           归组（REQ-39 cwdHint 权威映射）/ 投影预热 / 标准 dry-run 预览
//   lib/import-variants.mjs 特殊形态来源编排：chatgpt / grokbuild / hermes / kimi +
//                           opencode / zcode / hermes / grokbuild / chatgpt 的 dry-run 预览
//   lib/toolkit.mjs         import_chat 分发器工厂（REQ-09 分组 spec）+ IMPORT_SPECS
//   lib/export-tool.mjs     export_claude / export_codex / export_kimi（REQ-23）/
//                           export_bundle（REQ-56）执行体
//   lib/restore.mjs         REQ-56/62 restore_bundle（指纹校验 + 跨机器归组回退）
//   lib/verify.mjs          REQ-23 verify_session（只读结构校验 + repair 提示）
//   lib/handoff.mjs         REQ-30 交接摘要纯函数（不可信静态历史 → 交接摘要）
//   lib/resume-command.mjs  REQ-30 /resume-claude /resume-codex 命令面
//   lib/retract.mjs         REQ-33 导入识别 / 撤回（list_imported_sessions / retract_import）
//   lib/discovery-host.mjs  REQ-25/40 scan_discover 的 host 适配（fs + SQLite 摘要）
//   lib/panel.mjs           REQ-41 面板路由（POST /api-import/sessions + /api-import/import）
//   lib/tools.mjs           15 个工具的注册（import_chat 分发器 = 18 个导入源 +
//                           import_agents + doctor + import_mcp + import_settings +
//                           export×3 + bundle×2 + sync + 识别/撤回 + 发现 + verify）
//
// 本文件只做组装：registerTools 注册工具；webServer 是可选且晚挂载的 host 服务，
// 面板路由经 ctx.inject(['webServer']) 延迟注册（headless / 无 Web 的 profile 不挂载
// 路由但照常 apply，16 个导入工具与 CLI 会话不受影响）。

import { resolveRegistryDir } from './lib/imports.mjs'
import { registerTools } from './lib/tools.mjs'
import { registerPanelRoutes } from './lib/panel.mjs'
import { registerSyncRoutes } from './lib/sync-panel.mjs'
import { registerSyncLoop } from './lib/sync-loop.mjs'
import { registerImportCommand } from './lib/command.mjs'
import { registerResumeCommands } from './lib/resume-command.mjs'
import { registerSessionHint } from './lib/prompt-hint.mjs'
import { registerContextBridge } from './lib/context-bridge.mjs'
import { registerImportPrefs } from './lib/import-prefs.mjs'
import { exportClaudeSession } from './lib/export-tool.mjs'
import { readOpencodeDb } from './lib/opencode.mjs'
import { readZcodeDb } from './lib/zcode.mjs'

const name = 'import-claude'
// webServer 不进 inject：它是可选 host 服务（headless / 无 Web 的 profile 不挂载），
// 硬依赖会让整个插件在 headless 下无法激活（REQ-41 曾把它加进 inject，破坏了
// CI headless 冒烟与 CLI 会话的导入工具）。面板路由在 apply 内经 ctx.inject 可选注册。
const inject = ['sessionPersistence', 'fs', 'tools']

function apply(ctx) {
  // REQ-24 imports registry 目录：$DSH_HOME/dsh-chat-import（$DSH_HOME 缺省 ~/.dsh）
  const registryDir = resolveRegistryDir()
  registerTools(ctx, registryDir)
  // REQ-41 面板路由：webServer 是可选 host 服务且晚挂载——web 组合的服务插件在
  // import-claude apply 之后才发布它，apply 时 ctx.get('webServer') 仍为空（实测
  // 重启后 /api-import/* 一律 405）。用 ctx.inject(['webServer'], …) 在服务可用时
  // 再注册路由（dsh 各包处理晚挂载依赖的标准姿势）：headless / CI 冒烟（无
  // webServer）时回调永不执行，12 个导入工具照常可用，apply 不因缺服务失败。
  ctx.inject(['webServer'], (webCtx) => {
    registerPanelRoutes(ctx, webCtx.webServer, registryDir)
    registerSyncRoutes(ctx, webCtx.webServer, registryDir)
  })
  // 双向增量默认同步关闭；打开控制面板开关后才启定时器。
  registerSyncLoop(ctx, registryDir)
  // REQ-42/29 /import、/import-all 命令面：commands 同样可选（headless / CLI 会话
  // 可能不挂载），服务可用时注册（不阻塞插件激活）。
  registerImportCommand(ctx, registryDir)
  // REQ-30 /resume-claude /resume-codex 交接摘要续聊：同 commands 可选服务，延迟注册
  //（选择 = 最近 / id: / 标题关键词，多匹配列候选不猜测；摘要排除 system/thinking）。
  registerResumeCommands(ctx, registryDir)
  // REQ-53 新会话开始迁移提示：监听 agent/session-start（host 核心事件，非可选服务），
  // cwd 有可导入/已导入历史时注入提示（per-project 记忆 + env 开关）。
  registerSessionHint(ctx, registryDir)
  // REQ-28 上下文桥接（默认关闭，env DSH_IMPORT_CONTEXT_BRIDGE=1 开启）：Claude 的
  // memory / CLAUDE.md / skills 桥进 agent 的 scoped systemPrompt / skills 注册。
  registerContextBridge(ctx)
  // 导入偏好设置命名空间（chat-import）：「导入系统提示词作为上下文注入」开关（默认关）。
  // ctx.settings 可选，缺席时注册空转；读取见 buildImportExecutor（lib/toolkit.mjs）。
  registerImportPrefs(ctx)
}

export { apply, inject, name, readOpencodeDb, readZcodeDb, exportClaudeSession }
