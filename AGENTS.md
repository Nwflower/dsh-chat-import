# AGENTS.md

`dsh-chat-import` 是 DeepSeek Harness（DSH） 的插件。

它将多个Agent工具的外部聊天记录**全保真**导入为**可继续**的 DSH 会话。

DSH 的哲学是 **everything is a plugin**——本仓库只做插件，不碰引擎。

改代码前先读 `README.md`（对外契约）与 `test/`（现有行为）。

## 仓库布局

根目录只放发布到 GitHub / npm 的文件；本地工程文件一律收进 `dev/`（gitignore，永不提交）。

```
index.mjs        插件入口
index.d.ts       类型面，覆盖 13 个工具的参数/返回；
tsconfig.json    TS 工具链最小配置（仅 include index.d.ts；零构建、不进 npm 包）
lib/             导入/同步驱动（按职责拆分，均消费 ctx、非纯函数）：tools.mjs（13 个工具的注册主文件）、
                 imports.mjs（幂等 registry）、backfill.mjs（sync_to_claude 写回）、
                 discovery.mjs（17 格式统一发现 + 30s TTL / 持久化书签）、discovery-host.mjs（scan_discover host 适配）、
                 budget.mjs（REQ-37 预算解析链）、import-core.mjs（共享导入编排：importTranscript
                 状态机 / importDirectory / runDecision 落盘 / 归组 / 标准预览）、import-variants.mjs
                 （chatgpt / grokbuild / hermes / kimi 编排 + opencode / zcode 等 dry-run 预览）、import-prefs.mjs
                 （导入偏好设置）、toolkit.mjs（import_chat 分发器工厂：18 种格式收敛为单工具 + IMPORT_SPECS 登记）、
                 export-tool.mjs（export_chat 三合一执行体：Claude/Codex/Kimi）、restore.mjs（REQ-56/62 restore_bundle 执行体）、
                 verify.mjs（REQ-23 verify_session 执行体）、retract.mjs（REQ-33 识别/撤回）、
                 agents.mjs（REQ-59/61/64 import_agents 执行体）、mcp.mjs（REQ-68 import_mcp 执行体）、
                 settings.mjs（REQ-71 import_settings 执行体）、doctor.mjs（REQ-66 doctor 执行体）、
                 cwd-map.mjs（REQ-39 cwd 权威映射）、handoff.mjs（REQ-30 交接摘要纯函数层）、
                 resume-command.mjs（REQ-30 /resume-claude / /resume-codex 命令面）、
                 markdown.mjs（REQ-67 独立 Markdown 导出，纯函数）、mimocode.mjs / dsh.mjs（源编排）、
                 panel.mjs（REQ-41 面板路由）、sync-config.mjs / sync-loop.mjs / sync-panel.mjs
                 （双向增量：入站巡检 + DSH→Claude/Codex/Grok 写出 + 控制台路由）、
                 client.js（Browser 侧 bundle，REQ-41：sidebar.footer.action
                 槽 → 按工作区分组的面板 + 单选/多选导入；文案注册到 "chat-import" ns 经
                 @deepseek-ai/dsh-client-locale 随 web 语言切换，缺失时降级内置 zh）、command.mjs
                 （REQ-42 /import 命令面：commands 可选服务延迟注册，复用 importDiscoveryItem）、
                 prompt-hint.mjs（REQ-53 迁移提示：agent/session-start 注入 scoped PromptContext，
                 per-project 记忆 + env 开关）、context-bridge.mjs（REQ-28 上下文桥接：Claude 的
                 memory/CLAUDE.md/skills 桥进 scoped systemPrompt/skills，默认关 env 开关）、opencode.mjs / zcode.mjs / hermes.mjs
                 （SQLite 读取，node:sqlite）、convert/（转换核心按源拆分）、export/（反向序列化按目标
                 格式拆分：claude.mjs / codex.mjs / grokbuild.mjs / kimi.mjs / bundle.mjs）
convert.mjs      转换核心 re-export shim（已按源拆到 lib/convert/{core,claude,codex,chatgpt,cursor,gemini,reasonix,opencode,zcode,grokbuild,openclaw,hermes,pi,kimi,qoder,workbuddy,dsh,local-jsonl}.mjs，纯函数、零 DSH 依赖、可独立单测）
export.mjs       反向导出序列化器 re-export shim（实体在 lib/export/claude.mjs——DSH 会话日志 → Claude
                 Code JSONL，纯函数、零 DSH 依赖；`exports["./export.mjs"]` 子路径契约保持不变）
cordis.patch.yml bundle 声明（insert import-claude）
.github/         GitHub Actions CI（npm test，不进 npm 包）；scripts/build-check.mjs 作零构建包的
                 scripts.build/prepack 发布面自检（files 完整性 + node --check 语法 + lockfile 版本）
package.json     npm 包元数据；files 白名单 = 发布内容；dsh.client 声明 Browser 侧注入
README.md        对外契约（英文，GitHub/npm 默认）；README.zh-CN.md 中文版——行为变更必须同步两版
CHANGELOG.md     变更日志（进 npm 包）
LICENSE          MIT
assets/          LOGO（import.svg，README 双语顶部引用，进 npm 包）
test/            convert 单测 + export 单测 + index mock 集成 + zcode 自包含（进 GitHub，不进 npm 包）
dev/             ❌ 本地工程面（gitignore，永不提交）：bin/（脚本：session.mjs 多会话认领 CLI、verify-*、totp）、hooks/（pre-push）、research/（竞品/方向调研）、HANDOFF.md、REQUIREMENTS.md、GROWTH.md、RELEASING.md、ORCHESTRATOR-PROMPT.md、TESTER-PROMPT.md、gh-pat.txt（凭据勿提交）；多会话协调靠 dsh-file-claim 插件
```

- `package.json` 的 `files` 白名单就是 npm 发布面：`index.mjs`、`index.d.ts`、`convert.mjs`、`export.mjs`、`lib/*.mjs`、`lib/*.js`、`lib/convert`、`lib/export`、`cordis.patch.yml`、`bin`（`bin/dsh-chat-import.mjs` CLI）、`README.md`、`README.zh-CN.md`、`docs/*.md`（含 INTERCHANGE / USAGE 双语）、`CONTRIBUTING.md`、`ROADMAP.md`、`CHANGELOG.md`、`assets/import.svg`、`LICENSE`。`lib/*.mjs` 通配自动覆盖 lib/ 下全部新模块（新增文件无需改 `files`，`.github/scripts/build-check.mjs` 按 npm 同款 glob 语义展开校验）。
- **永不提交**：`dev/`、`node_modules/`、`.prev-session*.jsonl`、`.dsh-file-claim/`（插件运行时目录）、真实用户 transcript（含敏感内容）、任何凭据/密钥。

## 命令

```sh
npm test        # node --test 跑 test/*.test.mjs（convert 单测 + export 单测 + index mock 集成 + zcode 自包含）
npm run check:linux   # 跨平台路径纪律静态检查（.github/scripts/check-linux-compat.mjs，CI 同款护栏）
npm run build   # 零构建包的「build」：发布面自检（files 完整性 + node --check 语法 + lockfile 版本，prepack 自动跑）
```

无构建步骤：纯 ESM，`index.mjs` / `convert.mjs` / `export.mjs` / `lib/` 即发布产物（`lib/client.js` 是手写 CJS bundle，亦无构建；`npm run build` 是发布面自检而非编译）。DSH 手工验证：`dsh plugin --profile web add -w link:<本仓库路径>` 后重启 dsh，在会话里调 `import_chat`（`format` 选 18 种来源之一）/ `scan_discover` / `export_chat`（`format: claude` / `codex` / `kimi`）/ `sync_to_claude` / `list_imported_sessions` / `retract_import`；Browser 侧验证：dsh web 侧边栏底部「导入会话」按钮 → 面板按工作区分组浏览 + 单选/多选导入。

## 提交纪律（保持仓库干净）

- **conventional commit 前缀**：`feat:` / `fix:` / `refactor:` / `chore:` / `docs:` / `test:`，中文描述，沿用现有历史风格（如 `feat: batch import (#7) — directory scan, per-file sessions, summary`）。
- **一个逻辑变更一个 commit**：不混改（重构不带新功能，修 bug 不带 docs），不提交 WIP / 中间态。
- **提交前必过**：
  1. `npm test` 全绿；
  2. `npm run check:linux` 全绿（跨平台路径纪律护栏，见质量约定）；
  3. `git status` 无杂物（`dev/`、`node_modules/`、快照不得出现在待提交里）；
  4. `git diff --cached --check` 无空白错误。
- **行为变更同 commit 更新 README 与测试**：README 是对外契约，测试描述现有行为；改行为必须连测试一起改，并在 commit 信息里说明为什么。
- 提交信息说明「为什么」而非复述代码；指向关联 issue/PR 编号。
- push 前自查：`git log --oneline` 每一条都是一个完整、可读的逻辑单元；工作树干净。
- 重写已推送历史时只用 `--force-with-lease`，远程有变动立即中止——本仓库是单人直推 `main`，尽量不重写。

## 多会话并发开发（并行 Agent 协调）

同一台机器可能并行开多个 Agent 会话操作**同一个工作目录**。会话间靠 **dsh-file-claim 插件**（DSH 系统工具，非本仓库代码）协调文件占用，避免互相覆盖、避免共享文档（HANDOFF / GROWTH）被并发改写。

| 时机 | 动作 |
| --- | --- |
| 动手改文件之前 | `claim_files({ paths: [...] })` 认领独占路径（他人活跃占用 → 拒绝） |
| 改完 | `release_files({ paths: [...] })`（或 `release_files({ all: true })`）释放认领 |
| 占用冲突时 | `who_claims({ paths: [...] })` / `claim_status()` 看谁在用；等对方 `release_files`，或对方 **stale**（心跳过期）后 `claim_files({ paths, force: true })` 接管 |
| **想改的文件被活跃会话占用，又不愿干等** | `pending_write({ path, content })` 把「改好的新内容」写进**待合并区**（自动记录写入时 git HEAD base），不阻塞任何会话 |
| 对方 release 之后 | `pending_apply({ path })` 做三路合并（current × base × pending）落盘——**无冲突自动落盘并清除条目，有冲突写入冲突标记、保留条目**（手动解决后 `pending_drop` 清理） |
| push 之前 | `git pull --rebase origin main` |

规则：

1. **先 claim 再动手**：要改的文件必须先认领到自己名下；他人活跃认领的文件不得修改。`dev/HANDOFF.md`、`dev/GROWTH.md` 等共享文档同样要 claim。
2. **最小认领粒度**：只认领本次要碰的文件/目录；目录认领覆盖其下所有路径。
3. **stale 接管**：`force: true` 只能接管 stale 会话的认领，永远抢不了活跃会话的文件；被接管者丢的只是认领记录，文件内容不受影响。
4. **push 前 `git pull --rebase origin main`**：小步提交（一个逻辑变更一个 commit）可把 rebase 冲突降到最低。本协议覆盖同一工作目录的并行会话；跨机器并行靠 git 纪律，registry 不跨机器同步。
5. **pending 待合并区（简单会话的异步写作）**：`pending_write` 存「改好的新内容」+ 写入时 git HEAD 版本（base）；`pending_apply` 做三路合并（current × base × pending），无冲突自动落盘并清除条目，有冲突写入冲突标记、保留条目；`base` 缺失时拒绝盲合。`apply` 要求路径无活跃占用（防止与在改会话打架）。`pending_show` / `pending_drop` 查看 / 丢弃条目。

## DSH 插件约束

- **只消费 host 公开服务**：`sessionPersistence`（create + append 落盘；list + readFrom 供 `export_chat` / `sync_to_claude` 只读）、`fs`、`tools`、`webServer`（REQ-41 面板 JSON 路由）、`workspaceRegistry`；`agentDefaultModel` / `llm`（REQ-37 预算自适应）可选，经 `ctx.get` 读取、缺失或抛错即回退。opencode / zcode / hermes 用 `node:sqlite`（`DatabaseSync`，host 面）。不发布服务 → 无需 isolate realm。**有 Browser 侧**（REQ-41 已定案选 Browser 入口：`lib/client.js` 手写 CJS bundle 注册到 `sidebar.footer.action` 槽，`package.json` 声明 `dsh.client` + peer `react` / `@deepseek-ai/dsh-client-locale`，`files` 含 `lib/client.js`；面板只消费 host JSON 路由，不 import DSH host 模块）。
- **插件，不是引擎改动**：新行为走公开扩展点（工具注册）；绝不修改 DSH 引擎 / apiproxy / 官方 UI 包。
- **会话日志 append-only、deep-frozen**：只 `create` + `append`，绝不改写历史事件。
- **模型可见 ⟺ 落盘**：进入模型上下文的任何内容必须能从会话日志重建；新模型可见输入必须对应会话事件。
- **事件纪律**：`seq` 从 0 连续；surface 事件（`user/message` / `assistant/message` / `tool/result`）必须带 `surfaceOp: 'append'`；`tool/result` 用 `sourceEventSeqs` 关联其 `tool/call`；`SessionHeader` version 保持 `0`，只做结构性变更才 bump。
- **幂等**：目标会话已存在时跳过（`sessionPersistence.list()` 判重），不重复写入。
- **归组**：`workspaceRegistry.resolveByPath(cwd)` → `workspace.attachSession(id)`，否则会话显示「未分组」。
- **失败要大声**：畸形 JSONL 行计数上报（`skipped`），绝不静默吞掉；读取工作区外的 transcript 需会话沙箱允许。

## 质量约定

- 文件以**恰好一个**换行结尾；空 `catch` 必须说明吞掉什么且 `try` 只包一条语句；不注释代码里显而易见的事实。
- 保持 `lib/convert/*` 与 `lib/export/*`（含根 shim `convert.mjs` / `export.mjs`）零依赖纯函数：任何 DSH 依赖只允许出现在 `index.mjs` 与 `lib/{tools,command,imports,backfill,opencode,mimocode,zcode,hermes,dsh,discovery,discovery-host,budget,import-core,import-variants,import-prefs,toolkit,export-tool,restore,verify,agents,mcp,settings,doctor,cwd-map,retract,resume-command,prompt-hint,context-bridge,panel,sync-config,sync-loop,sync-panel}.mjs`（即所有消费 ctx 的 host 面模块；`handoff.mjs` / `markdown.mjs` 是零依赖纯函数层，不进白名单）。
- 测试描述行为而非背书正确性；fixtures 用合成数据，永不掺真实 transcript。
- **跨平台路径纪律（防 CI 红，`npm run check:linux` 护栏）**：CI 在 Linux 跑 `npm test`，测试里的反斜杠合成路径经代码 `node:path` 运算在 posix 下行为不同（`join()` 产混合分隔符、`dirname('D:\…')` 返 `'.'`）。规则：mock 树查找（`stat`/`readText`/`listDir` 读树）必须做分隔符归一（复用 `index.test.mjs` makeCtx 的 `norm` + `lookup` 三态命中）；断言若比较 `node:path` 运算结果，期望值用同口径函数计算，绝不写死 `'X:\…'` 字面量；新增导入测试优先用真实临时目录（`mkdtemp`）。
- 不写行内文档废话：注释写契约与上下文，不叙述控制流。

## No Negative Echo（交付产物不残留被否方案）

生成最终产物及其包装（标题、文件名、正文、注释、标签、commit、PR、交付说明、工具
description）时，只描述**最终采用的状态**，假设读者没看过本次会话。

- 会话里的否决、中间尝试和措辞纠正，只当作控制信息，不让它们成为最终产物的命名或叙述中心。
- 对每个交付面分别判断：不知道本次会话的读者需要这条信息吗？省略会不会导致不准确、不安全、
  误导或兼容性信息缺失？它是不是任务开始前已提交/用户确认状态里的真实变化，且当前交付面需要解释它？
- 「不要提 X」不是让你写「无 X」；标题、文件名、开篇和标签应从正向目标重新生成，不要逐词修改被否文案。
- 保留真实的基线变化、已执行的外部操作，以及必要的技术名、诊断、测试、快照和审计历史。
- 不要把与本任务无关的改动写进本次 commit、PR 或交付说明；对比、引用、审计和迁移说明只在确实需要时保留。
- 写完通读全部用户可见内容及其包装（含文件名、元数据、hook 改写），内容变化后重新检查；
  不要另加「已清理」「无残留」这类自我声明。
- **具体到本仓库**：REQ-NN / GitHub issue 编号 / 竞品对标（「对标 dsh-xxx」）只进代码注释，
  绝不进 `description:` 或 render 文本——它们是开发侧注解，用户无法解析，属零信息噪声。

来源：[no-negative-echo](https://github.com/LB623/no-negative-echo)（Agent Skills，MIT）。
与本仓库「提交纪律」互补：提交纪律管「一个逻辑变更一个 commit」，本条管「commit/description 不夹带被否方案」。

## 编辑本文件

规则保持自包含；改完须与仓库现状一致（目录、命令、约束过时了要同步更新）。
