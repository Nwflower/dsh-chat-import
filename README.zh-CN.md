<div align="center">

# 📥 DSH Chat Import

**便捷导入十余种外部 Agent 聊天历史，在 DeepSeek Harness 中继续对话，还可导出或写回 Claude Code、Codex、Kimi 等。**

[![English](https://img.shields.io/badge/lang-English-blue.svg)](README.md) [![简体中文](https://img.shields.io/badge/lang-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red.svg)](README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/dsh-chat-import?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/dsh-chat-import)
[![npm downloads](https://img.shields.io/npm/dm/dsh-chat-import?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/dsh-chat-import)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![Node.js >= 22.13](https://img.shields.io/badge/Node.js-%3E%3D22.13-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](package.json)
[![CI](https://img.shields.io/github/actions/workflow/status/Nwflower/dsh-chat-import/ci.yml?style=for-the-badge&logo=githubactions&logoColor=white)](https://github.com/Nwflower/dsh-chat-import/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/Nwflower/dsh-chat-import?style=for-the-badge&logo=github&logoColor=white)](https://github.com/Nwflower/dsh-chat-import)
[![已收录于 Awesome DeepSeek Harness](https://img.shields.io/badge/%E5%B7%B2%E6%94%B6%E5%BD%95%E4%BA%8E-Awesome_DeepSeek_Harness-6A5ACD?style=for-the-badge&logo=awesome&logoColor=white)](https://github.com/0xsline/awesome-deepseek-harness)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![dsh.so security](https://www.dsh.so/badges/dsh-chat-import-shield.svg)](https://www.dsh.so/artifact/dsh-chat-import/)
[![已收录于 Awesome DSH Plugins](https://img.shields.io/badge/%E5%B7%B2%E6%94%B6%E5%BD%95%E4%BA%8E-Awesome_DSH_Plugins-6A5ACD?style=for-the-badge&logo=awesome&logoColor=white)](https://github.com/Dominic789654/awesome-deepseek-harness)

[💡 简介](#-简介) · [🚀 安装](#-安装) · [✨ 功能一览](#-功能一览) · [🗂 支持的来源](#-支持的来源) · [🛠 使用](#-使用) · [🔑 关键行为](#-关键行为) · [📚 文档](#-文档) · [⭐ Star History](#-star-history) · [🤝 贡献](#-贡献)

</div>

> **一个插件，十余种来源** —— 全保真导入 DeepSeek Harness，无缝续聊，反向可互转 / 备份 / 交接。

<div align="center">

<img src="./assets/wb.png" alt="WorkBuddy" width="600" />

**更新日志（英文）：** [CHANGELOG.md](CHANGELOG.md) · **路线图：** [ROADMAP.md](ROADMAP.md) · **互转协议：** [docs/INTERCHANGE.md](docs/INTERCHANGE.md)

</div>

---

## 💡 简介

`dsh-chat-import` 从 **Claude Code、Codex、ChatGPT、Cursor、Gemini、Reasonix、opencode、MiMo Code、ZCode、Grok Build、OpenClaw、Pi Coding Agent、Hermes、Kimi CLI / Kimi Code、Qoder CLI、WorkBuddy 与 DSH 会话日志** 导入聊天历史，将工具调用、思考过程一并导入，成为无缝继续的 DeepSeek Harness 会话。源文件只读读取（绝不改写），不碰 DSH 引擎；每次导入都成为一条全新会话，并按源 `cwd` 归入对应工作区。

同样支持导出和同步：`export_claude` 把 DSH 会话序列化回 Claude Code JSONL，Claude Code 可用 `--resume` 加载续聊；`sync_to_claude` 再把会话新增轮次增量写回 Claude Code 文件——带守卫、绝不静默覆盖；同一矩阵延伸到 **Codex rollout**（`export_codex`）与 **Kimi wire**（`export_kimi`），外加带 SHA-256 指纹与跨机器还原的**便携 interchange bundle**（`export_bundle` / `restore_bundle`）。

需要 **Node.js ≥ 22.13**，面向 **dsh 0.1.x**（实测 `0.1.0-rc.6` / `0.1.0-rc.7`）。

---

## 🚀 安装

```bash
dsh plugin --profile web add dsh-chat-import                    # npm 包
dsh plugin --profile web add -w link:/path/to/dsh-chat-import   # 本地源码（符号链接）
```

安装后：

1. **导入** — 在任意 DSH 会话里调用单一 `import_chat` 工具，用 `format` 选择来源：

```
import_chat({ format: "claude", path: "~/.claude/projects" })
import_chat({ format: "chatgpt", path: "~/Downloads/chatgpt-export/conversations.json" })
import_chat({ format: "local-jsonl", path: "D:\downloads\session.jsonl" })
```

2. **续聊** — 刷新会话列表，打开导入的会话，从源记录停下的地方继续对话。
3. **发现与批量** — `scan_discover()` 先只读预览；侧边栏「导入会话」面板按工作区浏览、多选导入；`/import-all` 一键批量。
4. **同步（可选）** — 面板「同步」页提供双向增量同步（外部 → DSH、DSH → 外部），默认关闭。子代理对话默认双向过滤；`excludeDirs` 排除列表可按方向跳过指定工作区目录。

> 卸载：从 profile 的 bundles 移除 `import-claude` insert 行并重启 dsh；已导入会话保留，插件绝不自动删。

---

## ✨ 功能一览

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 批量导入 17+ 源 | `import_chat`（18 种格式）· `scan_discover` · 侧边栏面板 · `/import` | 单个文件、目录或整个数据库，每段对话成为独立会话 |
| 全保真续聊 | 导入即 DSH 会话 | 工具调用/结果、思考、标题、模型、时间戳原样保留，按源 `cwd` 归组工作区 |
| 矩阵导出 | `export_claude` / `export_codex` / `export_kimi` | DSH 会话序列化回 Claude / Codex / Kimi 格式，有损项逐条报告 |
| 便携备份 | `export_bundle` / `restore_bundle` | SHA-256 双指纹的 interchange bundle，可跨机器还原 |
| 增量写回 | `sync_to_claude` | 新增完整轮次追加回 Claude Code 文件，带守卫绝不覆盖 |
| 双向同步 | 面板「同步」页 | Claude / Codex / Grok 双向增量同步；子代理对话默认过滤；`excludeDirs` 按目录排除 |
| Agent 资产迁移 | `import_agents` | pi / opencode / Claude / Codex 的 agent、prompt、skill、指令转成 DSH skills |
| MCP 镜像计划 | `import_mcp` / `/mcp-status` | 读取 Claude / Codex MCP server，生成可审阅的 DSH MCP client YAML 片段 |
| 配置翻译建议 | `import_settings` / `/settings-suggest` | Claude settings / Codex config 转 DSH 迁移建议（只读） |
| 交接摘要 | `/resume-claude` / `/resume-codex` | 外部 transcript 当不可信历史，生成交接摘要注入当前会话 |
| 只读审计 / 体检 | `verify_session` / `doctor` / CLI `dsh-chat-import doctor` | 结构审计与迁移健康检查 |
| 幂等与保护 | `import_chat`（全部来源） | `expectedHash` / `restamp` / 上下文预算保护；未变跳过、增长只追加 |
| 预设模式 + 系统提示词 | 设置页「插件」分区 TAB | 导入会话补录默认预设模式；可选「导入系统提示词」作为上下文注入（默认关） |

---

## 🗂 支持的来源

全部 18 种来源走**同一个工具**：把来源名作为 `format` 参数传给 `import_chat`，例如 `import_chat({ format: "codex", path: "…" })`。

| 来源 | 存储位置 | `format` 值 |
| --- | --- | --- |
| **Claude Code** | `~/.claude/projects/<slug>/<sessionId>.jsonl` | `claude` |
| **Claude-3p**（新端） | `%LOCALAPPDATA%\Claude-3p\claude-code-sessions`（元数据经 `cliSessionId` 反查 jsonl） | `claude` |
| **Codex / ChatGPT CLI** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `codex` |
| **ChatGPT**（网页导出） | 导出压缩包（任意路径）——`conversations.json` | `chatgpt` |
| **Cursor** | `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` | `cursor` |
| **Gemini CLI** | `~/.gemini/history/<slot>/chats/session-*.json` | `gemini` |
| **Reasonix**（CLI + 桌面版） | `~/.reasonix/sessions/desktop-*.jsonl` · `%APPDATA%\reasonix\projects\<slug>\sessions\*.jsonl` | `reasonix` |
| **opencode** | `~/.local/share/opencode/opencode.db` | `opencode` |
| **MiMo Code**（opencode fork） | `~/.local/share/mimocode/mimocode.db` | `mimocode` |
| **ZCode**（z.ai CLI） | `~/.zcode/cli/db/db.sqlite` | `zcode` |
| **Grok Build** | `~/.grok/sessions/<project>/<session_id>/` | `grokbuild` |
| **OpenClaw** | `~/.openclaw/agents/<agent>/sessions/*.jsonl` | `openclaw` |
| **Pi Coding Agent** | `~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl` | `pi` |
| **Hermes** | `~/.hermes/`（Windows `%LOCALAPPDATA%\hermes`） | `hermes` |
| **Kimi CLI / Kimi Code** | `~/.kimi/sessions/<workdir-md5>/<sessionId>/wire.jsonl` · `~/.kimi-code/sessions/<workspaceId>/<sessionId>/agents/main/wire.jsonl` | `kimi` |
| **Qoder CLI** | `~/.qoder/projects/<encoded-project>/<sessionId>.jsonl`（子代理在 `<sessionId>/subagents/*.jsonl`） | `qoder` |
| **WorkBuddy**（腾讯 AI 编码应用） | `~/.workbuddy/projects/<project-hash>/<session-uuid>.jsonl` | `workbuddy` |
| **DSH 会话日志** | `~/.dsh/sessions/<encoded-workspace>/<sessionId>/session.jsonl(.zstd)` | `dsh` |
| **任意本地 JSONL** | 任意 `.jsonl` 文件 / 目录（自动识别格式） | `local-jsonl` |

每次导入都保留源实际记录的内容；源格式无法保留的部分，会在导入报告里显式标注。各来源的格式细节与边界行为见 [使用详解](docs/USAGE.zh-CN.md)。

---

## 🛠 使用

所有导入走同一个 **`import_chat`** 工具 —— `format` 选择来源（见上方表格）—— `path` 语义共用：单文件导单会话，目录递归扫描批量导入。常用参数：`preview`（零副作用预览）、`force`（另存完整新副本）、`sessionId`（覆盖目标 id）、`expectedHash`（SHA-256 强校验）、`restamp`（时间戳平移）、`workspaceMode` / `workspaceDir`（归组控制）。来源特有参数（`compacted` / `branch` / `sessionIds` / `fullHistory` / `lineage` / `parseFormat`）只对相应 `format` 生效。

```
import_chat({ format: "claude", path: "C:\Users\<you>\.claude\projects\<slug>\<sessionId>.jsonl" })
import_chat({ format: "opencode", path: "C:\Users\<you>\.local\share\opencode\opencode.db" })
import_chat({ format: "workbuddy", path: "C:\Users\<you>\.workbuddy\projects" })
import_chat({ format: "local-jsonl", path: "D:\downloads\session.jsonl", parseFormat: "claude" })
```

`format: "chatgpt"` / `"opencode"` / `"zcode"` / `"hermes"` 恒返回批量结果——一个文件 / 数据库包含全部会话，一次调用即可让每段对话成为独立会话。

完整工具 / 命令用法（参数、示例、边界行为）见 **[docs/USAGE.zh-CN.md](docs/USAGE.zh-CN.md)**。

---

## 🔑 关键行为

- **只读导入** — 源转录与数据库绝不改写；导入的 DSH 历史 append-only。
- **幂等 + 增量** — 未变源不重读直接跳过；增长只追加新增轮次；截断检测并上报。
- **自动归组** — 按源 `cwd` 归入工作区（权威映射 → slug 解码 → 主目录沙箱防护；本机路径不存在时回退源文件目录）。
- **预设模式** — 导入会话经 `agents.create` 挂默认 preset scope，并把默认 preset id 写回 `SessionHeader.agentPreset`，UI 上照常显示「预设模式」chip（与正常会话一致）。
- **环境变更声明（总是注入）** — 每个导入会话都在首个回合前钉一条「上下文注入」折叠行，声明「已迁移到 DSH，工具 / 权限 / 执行指令以当前会话为准」，防止继续会话时模型沿用源环境的旧工具名 / 旧命令。
- **系统提示词（可选，默认关）** — 设置页「插件」分区里的「会话导入」TAB 提供「导入系统提示词」开关；开启后把源 transcript 的 `system` / `developer` 提示词附在环境变更声明之后（同样折叠为「上下文注入」）。Claude Code 的转录不落 system prompt，此开关对 Claude 源无效果。
- **失败要大声** — 畸形行、疑似敏感信息、格式无法保留的部分、导出有损项，全部显式上报；每次落盘会话自动结构自检。
- **沙箱** — 读取工作区外的源文件或写工作区外的导出目标，需要会话沙箱放行该路径。

---

## 📚 文档

| 文档 | 说明 |
| --- | --- |
| [使用详解](docs/USAGE.zh-CN.md) | 每个工具 / 命令的完整参数、示例与边界行为 |
| [互转协议](docs/INTERCHANGE.md) | Interchange v1 协议与 bundle 格式 |
| [更新日志](CHANGELOG.md) | 版本历史（英文） |
| [路线图](ROADMAP.md) | 已实现 / 规划 |
| [贡献指南](CONTRIBUTING.md) | 开发环境、提交规范、安全与隐私 |

---

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Nwflower/dsh-chat-import&type=Date)](https://star-history.com/#Nwflower/dsh-chat-import&Date)

---

## 🤝 贡献

欢迎贡献——fork 本仓库，新建 `feature/<name>` 分支，提交 PR。完整指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。

- **测试：** `npm test` · **跨平台护栏：** `npm run check:linux`
- 仓库规范见 [AGENTS.md](AGENTS.md)：conventional commit（中文）、双语 README 必须保持同步、插件只消费公开 dsh host 服务、多会话并发走文件认领协议。

---

## 📄 许可证

MIT — 见 [LICENSE](LICENSE)。
