// lib/index.mjs — dsh-chat-import 插件入口（薄组合层，package.json main 指向本文件）
//
// 外部聊天记录（各来源与存储契约见 lib/discovery.mjs 的 FORMATS 与 lib/convert/*.mjs）→ DSH 会话
// 导入器 + DSH → Claude Code JSONL 反向导出。消费 host 的 sessionPersistence / fs /
// tools / workspaceRegistry 服务（webServer 可选，经 ctx.inject 延迟挂载）。
//
// 实现按职责拆在本目录下（各模块都消费 ctx，非纯函数；lib/convert/* 与 lib/export/*
// 保持零 DSH 依赖纯函数不变）：
//   lib/budget.mjs           上下文预算解析链（参数 > env > 动态模型窗口 > 静态默认）
//   lib/import-core.mjs     共享导入编排：importTranscript（状态机）/ importDirectory /
//                           runDecision（落盘，agents.create + preset scope）/
//                           归组（cwdHint 权威映射）/ 投影预热 / 标准 dry-run 预览
//   lib/import-variants.mjs 特殊形态来源编排：chatgpt / grokbuild / hermes / kimi
//                           （含各自的 dry-run 预览）
//   lib/sources/<src>.mjs   按来源的 host 面适配器：SQLite 读取 + 导入编排 + dry-run 预览
//   lib/toolkit.mjs         import_chat 分发器工厂（分组 spec）+ IMPORT_SPECS
//   lib/export-tool.mjs     export_chat 三合一执行体（exportClaudeSession / exportCodexSession /
//                           exportKimiSession）+ export_bundle 执行体
//   lib/restore.mjs          restore_bundle（指纹校验 + 跨机器归组回退）
//   lib/verify.mjs           verify_session（只读结构校验 + repair 提示）
//   lib/handoff.mjs          交接摘要纯函数（不可信静态历史 → 交接摘要）
//   lib/resume-command.mjs   /resume-claude /resume-codex 命令面
//   lib/retract.mjs          导入识别 / 撤回（list_imported_sessions / retract_import）
//   lib/skill.mjs            转换指南注册为运行时 skill（skills 可选服务，缺席跳过）
//   lib/discovery-host.mjs   scan_discover 的 host 适配（fs + SQLite 摘要）
//   lib/panel.mjs            面板路由（POST /api-import/sessions + /api-import/import）
//   lib/tools.mjs           12 个工具的注册（import_chat 分发器 = 19 个导入源 +
//                           import_agents + doctor + import_mcp + import_settings +
//                           export_chat（claude/codex/kimi 三合一）+ bundle×2 +
//                           识别/撤回 + 发现 + verify）
//
// 本文件只做组装：registerTools 注册工具；webServer 是可选且晚挂载的 host 服务，
// 面板路由经 ctx.inject(['webServer']) 延迟注册（headless / 无 Web 的 profile 不挂载
// 路由但照常 apply，12 个工具与 CLI 会话不受影响）。

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
// webServer 不进 inject：它是可选 host 服务（headless / 无 Web 的 profile 不挂载），
// 硬依赖会让整个插件在 headless 下无法激活（曾把它加进 inject，破坏了
// CI headless 冒烟与 CLI 会话的导入工具）。面板路由在 apply 内经 ctx.inject 可选注册。
const inject = ['sessionPersistence', 'fs', 'tools']

// config 是宿主解析后的条目配置：0.1.7 下 volatile 字段是带 .get() 的实时引用（宿主在
// 设置写入时原地更新），registerImportPrefs 据此读初值——apply 期 fiber 还是 state 1，
// settings.describe() 会跳过本条目，只能从 config 读。
function apply(ctx, config) {
  // imports registry 目录：$DSH_HOME/dsh-chat-import（$DSH_HOME 缺省 ~/.dsh）
  const registryDir = resolveRegistryDir()
  // registerTools 先构建工具定义（makeImportChatTool 同时把 IMPORT_SPECS 落进
  // lib/toolkit.mjs，面板/命令依赖它），再默认全量注入并返回 reconcile——settings
  // 就绪 / injectTools 变化时由 registerImportPrefs 驱动按档位对账（'off' 不注入省
  // 上下文、'minimal' 仅注入 import_chat 入口、'full' 全量；GUI 面板任何档位都可转换）。
  const reconcileTools = registerTools(ctx, registryDir)
  // 面板路由：webServer 是可选 host 服务且晚挂载——web 组合的服务插件在
  // import-claude apply 之后才发布它，apply 时 ctx.get('webServer') 仍为空（实测
  // 重启后 /api-import/* 一律 405）。用 ctx.inject(['webServer'], …) 在服务可用时
  // 再注册路由（dsh 各包处理晚挂载依赖的标准姿势）：headless / CI 冒烟（无
  // webServer）时回调永不执行，12 个导入工具照常可用，apply 不因缺服务失败。
  ctx.inject(['webServer'], (webCtx) => {
    registerPanelRoutes(ctx, webCtx.webServer, registryDir)
  })
  // interchange 转换指南注册为运行时 skill（dsh-chat-import-convert）：skills 同是
  // 可选服务（旧宿主 / headless 可能没有），服务可用时注册，缺席不影响导入主流程。
  ctx.inject(['skills'], (skillCtx) => {
    registerConvertSkill(ctx, skillCtx.skills)
  })
  // /import、/import-all 命令面：commands 同样可选（headless / CLI 会话
  // 可能不挂载），服务可用时注册（不阻塞插件激活）。
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
  // 导入偏好设置命名空间（chat-import）：「导入系统提示词作为上下文注入」开关（默认开）
  // 与工具注入档位 injectTools（'off' | 'minimal' | 'full'，默认 'minimal'；历史 boolean
  // 由 normalizeInjectTools 归一）。ctx.settings 可选，缺席时注册空转；读取见
  // buildImportExecutor（lib/toolkit.mjs）。injectTools 变化经 reconcileTools 按档位
  // 注销/重注册工具（见上方 registerTools 注释）。
  registerImportPrefs(ctx, reconcileTools, config)
}

// Config：0.1.7 起设置命名空间来自 profile 条目 id、schema 来自该条目的 Config，
// 必须由插件入口导出（loader 据此把本条目登记为可配置）。0.1.5 无此模型，导出无害。
export { apply, inject, name, Config, readOpencodeDb, readZcodeDb, exportClaudeSession }
