# AGENTS.md

`dsh-chat-import` 是 DeepSeek Harness（DSH）插件：把 18 种外部 Agent 工具的聊天记录
**全保真**导入为**可继续**的 DSH 会话，支持反向导出（Claude / Codex / Kimi）与双向增量同步。

## 背景

- DeepSeek Harness：开源 agent harness（GitHub `deepseek-ai/deepseek-harness`，npm `@deepseek-ai/dsh`）。
  插件参考文档：https://deepseek-harness.github.io/deepseek-harness/en/reference/ ；示例插件见 GitHub topic `dsh-plugin`。
- DSH 哲学是 **everything is a plugin**——本仓库只做插件，不碰引擎。
- 改代码前先读 `README.md`（对外契约）与 `test/`（现有行为）。

## 命令

```sh
npm test               # node --test 跑 test/*.test.mjs
npm run lint           # eslint（CI 同款）
npm run coverage       # 覆盖率护栏：line ≥ 75%（CI 同款）
npm run check:linux    # 跨平台路径纪律静态检查（CI 同款）
npm run check:leaks    # 敏感信息泄漏扫描
npm run build          # 发布面自检：files 完整性 + 语法 + lockfile（prepack 自动跑）
```

零构建：纯 ESM，`index.mjs` / `lib/` 即发布产物；`lib/client.js` 是手写 CJS Browser bundle，也无构建。
手工验证：`dsh plugin --profile web add -w link:<本仓库路径>` 重启 dsh 后——会话内调
`import_chat` / `scan_discover` / `export_chat` / `sync_to_claude` / `restore_bundle` 等工具；
dsh web 侧边栏「导入会话」面板与设置页「会话导入」分区。

## 仓库布局

- 根目录只放发布到 GitHub / npm 的文件；本地工程文件一律收进 `dev/`（gitignore，永不提交）。
- `package.json` 的 `files` 白名单即 npm 发布面；`lib/*.mjs` 通配自动覆盖 lib/ 新模块，新增文件无需改 `files`。
- 分层：`lib/convert/*` 与 `lib/export/*`（含根 shim `convert.mjs` / `export.mjs`）是零依赖纯函数层，可独立单测；
  其余 `lib/*.mjs` 消费 ctx（host 面）；`index.mjs` 为入口，`lib/tools.mjs` 注册全部工具，
  `lib/client.js` 为 Browser 侧面板与设置分区，`bin/dsh-chat-import.mjs` 为 CLI。
- **永不提交**：`dev/`、`node_modules/`、`.prev-session*.jsonl`、`.dsh-file-claim/`、真实用户 transcript、任何凭据/密钥。

## 编码

- 最小变更；复用现有工具函数与生命周期。
- 只消费 host 公开服务（`sessionPersistence` / `fs` / `tools` / `webServer` / `workspaceRegistry`；
  `agentDefaultModel` / `llm` 可选，经 `ctx.get` 读取、缺失或抛错即回退）；新行为走公开扩展点，
  绝不修改 DSH 引擎 / apiproxy / 官方 UI 包。
- 会话日志 append-only、deep-frozen：只 `create` + `append`，绝不改写历史；`seq` 从 0 连续，
  surface 事件带 `surfaceOp: 'append'`，`tool/result` 用 `sourceEventSeqs` 关联其 `tool/call`。
- 幂等：目标会话已存在即跳过（`sessionPersistence.list()` 判重）；归组经
  `workspaceRegistry.resolveByPath(cwd)` → `workspace.attachSession(id)`。
- 失败要大声：畸形 JSONL 行计数上报（`skipped`），绝不静默吞掉。
- 文件以恰好一个换行结尾；注释写契约与上下文，不叙述控制流；空 `catch` 必须说明吞掉什么且 `try` 只包一条语句。
- 测试描述行为而非背书正确性；fixtures 用合成数据，永不掺真实 transcript。
- **跨平台路径纪律**（CI 在 Linux 跑测试）：mock 树查找必须做分隔符归一；断言比较 `node:path`
  运算结果时期望值用同口径函数计算，不写死 `'X:\…'` 字面量；新增导入测试优先用真实临时目录（`mkdtemp`）。

## 文档与 I18n

- `README.md`（英文）与 `README.zh-CN.md`（中文）是对外契约：行为变更必须同 commit 同步两版，并连测试一起改。
- `docs/` 只放面向最终用户的文档（USAGE / INTERCHANGE 双语）。
- Browser 侧文案注册到 `chat-import` ns 经 `@deepseek-ai/dsh-client-locale` 随 web 语言切换，
  缺失降级内置 zh；新增/改 UI 文案要覆盖全部支持语言，不留废弃 key。

## Git

- conventional commit 前缀（`feat:` / `fix:` / `refactor:` / `chore:` / `docs:` / `test:`）+ 中文描述；
  一个逻辑变更一个 commit，不混改、不提交 WIP。
- 提交信息说明「为什么」而非复述代码；指向关联 issue/PR 编号。
- 提交前必过：`npm test` / `npm run check:linux` / `npm run lint` 全绿，`git status` 无杂物，
  `git diff --cached --check` 无空白错误。
- 重写已推送历史只用 `--force-with-lease`；单人直推 `main`，尽量不重写。
- 交付产物（commit / PR / 工具 description / 用户可见文案）只描述最终采用的状态：
  REQ-NN、issue 编号、同类插件对标只进代码注释，绝不进用户可见文本。

## 发布

- 版本 X.Y.Z；`npm version patch|minor` 后须同步 lockfile（`npm install --package-lock-only`），CI 会 diff 检查。
- 发布前更新 `CHANGELOG.md`；`prepublishOnly` 自动跑 `npm test` + 工作树干净检查 + `npm pack --dry-run`。
- `npm publish --otp=<2FA 码>` 手动发布；无 CI 自动发布流。

本文件规则保持自包含，改完须与仓库现状一致。
