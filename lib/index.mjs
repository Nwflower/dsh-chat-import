// lib/index.mjs — dsh-chat-import 插件入口（薄组合层，package.json main 指向本文件）
//
// 外部聊天记录（各来源与存储契约见 lib/discovery.mjs 的 FORMATS 与 lib/convert/*.mjs）→ DSH 会话
// 导入器 + DSH → 外部格式反向导出。消费 host 的 sessionPersistence / fs / tools /
// workspaceRegistry 服务（webServer / commands / skills / settings 可选，经 ctx.inject 延迟挂载）。
//
// 实现按职责拆在本目录下（各模块都消费 ctx，非纯函数；lib/convert/* 与 lib/export/*
// 保持零 DSH 依赖纯函数不变）：
//   lib/tools.mjs            工具注册门面 + injectTools 档位对账；工具定义按分组在 lib/tools/
//   lib/toolkit.mjs          import_chat 分发器 + 工具 / 面板 / 命令共用的导入分发（IMPORT_SPECS）
//   lib/tools/import-sources.mjs  来源 spec 表（每个来源一项：转换器 / 编排 / 派生 / 指纹键）
//   lib/budget.mjs           上下文预算解析链（参数 > env > 动态模型窗口 > 静态默认）
//   lib/import-core.mjs      共享导入编排：importTranscript（状态机）/ importDirectory /
//                            runDecision（落盘，agents.create + preset scope）/
//                            归组（cwdHint 权威映射）/ 投影预热 / 标准 dry-run 预览
//   lib/import-variants.mjs  特殊形态来源编排：chatgpt / grokbuild / hermes / kimi（含预览）
//   lib/sources/<src>.mjs    按来源的 host 面适配器：SQLite 读取 + 导入编排 + dry-run 预览
//   lib/export-tool.mjs      export_chat 执行体（claude / codex / kimi / opencode）+ export_bundle
//   lib/restore.mjs          restore_bundle（指纹校验 + 跨机器归组回退）
//   lib/verify.mjs           verify_session（只读结构校验 + repair 提示）
//   lib/retract.mjs          导入识别 / 撤回（list_imported_sessions / retract_import）
//   lib/discovery-host.mjs   scan_discover 的 host 适配（fs + SQLite 摘要）
//   lib/panel.mjs            面板路由（POST /api-import/*）
//   lib/command.mjs          /import、/import-all 等命令面
//   lib/handoff.mjs / lib/resume-command.mjs   /resume-claude /resume-codex 交接摘要续聊
//   lib/skill.mjs            转换指南注册为运行时 skill
//
// 本文件只做组装：registerTools 注册工具；可选服务缺席（headless / 无 Web 的 profile / CLI
// 会话）时对应的面板路由、命令、skill 不挂载，插件照常 apply、工具照常可用。

import { resolveRegistryDir } from './imports.mjs'
import { registerTools } from './tools.mjs'
import { registerPanelRoutes } from './panel.mjs'
import { registerImportCommand } from './command.mjs'
import { registerResumeCommands } from './resume-command.mjs'
import { registerIgnoreWatch } from './ignore-watch.mjs'
import { registerIgnoreCommand } from './ignore-command.mjs'
import { registerSessionHint } from './prompt-hint.mjs'
import { registerContextBridge } from './context-bridge.mjs'
import { registerImportPrefs, Config } from './import-prefs.mjs'
import { registerConvertSkill } from './skill.mjs'
import { exportClaudeSession } from './export-tool.mjs'
import { readOpencodeDb } from './sources/opencode.mjs'
import { readZcodeDb } from './sources/zcode.mjs'

const name = 'import-claude'
// 硬依赖只有这三项：webServer / skills / commands / settings 都是可选服务（headless / 无 Web
// 的 profile 不挂载），放进 inject 会让插件在 CI headless 冒烟与 CLI 会话里整体无法激活，
// 连导入工具都用不了。可选服务一律在 apply 内经 ctx.inject 按需注册。
const inject = ['sessionPersistence', 'fs', 'tools']

// config 是宿主解析后的条目配置：条目模型（DSH 0.1.7+）下 volatile 字段是带 .get() 的实时引用
//（宿主在设置写入时原地更新），registerImportPrefs 据此读初值——apply 期 fiber 还是 state 1，
// settings.describe() 会跳过本条目，只能从 config 读。
function apply(ctx, config) {
  // imports registry 目录：$DSH_HOME/dsh-chat-import（$DSH_HOME 缺省 ~/.dsh）
  const registryDir = resolveRegistryDir()
  // registerTools 先构建工具定义（makeImportChatTool 同时把 IMPORT_SPECS 落进
  // lib/toolkit.mjs，面板/命令依赖它），再默认全量注入并返回 reconcile——settings
  // 就绪 / injectTools 变化时由 registerImportPrefs 驱动按档位对账（'off' 不注入省
  // 上下文、'minimal' 仅注入 import_chat 入口、'full' 全量；GUI 面板任何档位都可转换）。
  const reconcileTools = registerTools(ctx, registryDir)
  // 面板路由：webServer 是可选且晚挂载的 host 服务——web 组合的服务插件在本插件 apply 之后
  // 才发布它，apply 时 ctx.get('webServer') 为空。ctx.inject(['webServer'], …) 在服务可用时
  // 再注册路由（dsh 各包处理晚挂载依赖的标准姿势）：headless / CI 冒烟时回调永不执行，
  // 工具照常可用，apply 不因缺服务失败。
  ctx.inject(['webServer'], (webCtx) => {
    registerPanelRoutes(ctx, webCtx.webServer, registryDir)
  })
  // interchange 转换指南注册为运行时 skill（dsh-chat-import-convert）：skills 同是
  // 可选服务，服务可用时注册，缺席不影响导入主流程。
  ctx.inject(['skills'], (skillCtx) => {
    registerConvertSkill(ctx, skillCtx.skills)
  })
  // /import、/import-all 等命令面：commands 同样可选，服务可用时注册（不阻塞插件激活）。
  registerImportCommand(ctx, registryDir)
  // /resume-claude /resume-codex 交接摘要续聊：同 commands 可选服务，延迟注册
  //（选择 = 最近 / id: / 标题关键词，多匹配列候选不猜测；摘要排除 system/thinking）。
  registerResumeCommands(ctx, registryDir)
  // 自动忽略：归档 → 打墓碑（取消归档解除），删工作区 → 其下导入会话打墓碑 +
  // 工作区忽略记录（新会话/取消归档时恢复）；重扫与 /import-all 统一跳过。
  registerIgnoreWatch(ctx, registryDir)
  // 忽略表命令面：/ignores 查看，/ignore、/unignore 手动增删。
  registerIgnoreCommand(ctx, registryDir)
  // 新会话开始迁移提示：监听 agent/session-start（host 核心事件，非可选服务），
  // cwd 有可导入/已导入历史时注入提示（per-project 记忆 + env 开关）。
  registerSessionHint(ctx, registryDir)
  // 上下文桥接（默认关闭，env DSH_IMPORT_CONTEXT_BRIDGE=1 开启）：Claude 的
  // memory / CLAUDE.md / skills 桥进 agent 的 scoped systemPrompt / skills 注册。
  registerContextBridge(ctx)
  // 导入偏好设置：「导入系统提示词作为上下文注入」开关（默认开）、工具注入档位 injectTools
  //（'off' | 'minimal' | 'full'，默认 'minimal'；boolean 由 normalizeInjectTools 归一）与侧栏
  // 入口开关。settings 可选，缺席时读默认；injectTools 变化经 reconcileTools 按档位
  // 注销/重注册工具。
  registerImportPrefs(ctx, reconcileTools, config)
}

// Config：条目模型下设置命名空间来自 profile 条目 id、schema 来自该条目的 Config，必须由插件
// 入口导出（loader 据此把本条目登记为可配置）。命名空间注册模型不读它，导出无害。
export { apply, inject, name, Config, readOpencodeDb, readZcodeDb, exportClaudeSession }
