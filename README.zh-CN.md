<div align="center">

<img src="./assets/dci-promo.png" alt="DSH Chat Import 宣传图" width="100%" />

# DSH Chat Import

**基于 DeepSeek Harness 构建的会话导入插件，一键导入外部 Agents 的聊天历史并在 DeepSeek Harness 中继续对话。**

> **所有会话，尽续于此。**

[![English](https://img.shields.io/badge/lang-English-blue.svg)](README.md) [![简体中文](https://img.shields.io/badge/lang-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red.svg)](README.zh-CN.md)

[![version](https://img.shields.io/npm/v/dsh-chat-import?style=flat&label=version&color=4D6BFE)](https://www.npmjs.com/package/dsh-chat-import)
[![downloads](https://img.shields.io/npm/dm/dsh-chat-import?style=flat&label=downloads&color=4D6BFE)](https://www.npmjs.com/package/dsh-chat-import)
[![GitHub stars](https://img.shields.io/github/stars/Nwflower/dsh-chat-import?style=flat&label=%E2%98%85&color=08C)](https://github.com/Nwflower/dsh-chat-import)
[![GitCode](https://img.shields.io/badge/GitCode-%E9%95%9C%E5%83%8F-4D6BFE?style=flat)](https://gitcode.com/Nwflower/dsh-chat-import)
[![license](https://img.shields.io/badge/license-MIT-2EA44F?style=flat)](LICENSE)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![dsh.so install](https://www.dsh.so/badge/install/dsh-chat-import.svg)](https://www.dsh.so/artifact/dsh-chat-import/)

</div>


## 简介

`DSH Chat Import` 从其他Agents导入含完整上下文的聊天历史，成为无缝继续的 DeepSeek Harness 会话。

现已覆盖20种Agents的导入：Claude Code、Codex、ChatGPT、Cursor、Gemini、Reasonix、opencode、MiMo Code、ZCode、Grok Build、OpenClaw、Pi Coding Agent、Hermes、Kimi CLI / Kimi Code、Kilo Code、Qoder CLI、WorkBuddy、千问办公（Qwen Work CN）与 DSH 会话日志；

下述工具的反向导入：Claude Code、Codex、Kimi Code。


## 支持的 Agents

|  |  |  |  |  |
| --- | --- | --- | --- | --- |
| [![Claude Code](./assets/agents/claude.svg)<br>**Claude Code**](https://github.com/anthropics/claude-code) | [![Codex](./assets/agents/codex.svg)<br>**Codex**](https://github.com/openai/codex) | [![ChatGPT](./assets/agents/chatgpt.svg)<br>**ChatGPT**](https://chatgpt.com) | [![Cursor](./assets/agents/cursor.svg)<br>**Cursor**](https://cursor.com) | [![Gemini](./assets/agents/gemini.svg)<br>**Gemini CLI**](https://github.com/google-gemini/gemini-cli) |
| [![Reasonix](./assets/agents/reasonix.svg)<br>**Reasonix**](https://github.com/esengine/DeepSeek-Reasonix) | [![OpenCode](./assets/agents/opencode.svg)<br>**OpenCode**](https://github.com/anomalyco/opencode) | [![MiMo Code](./assets/agents/mimocode.svg)<br>**MiMo Code**](https://github.com/XiaomiMiMo/MiMo-Code) | [![Kilo Code](./assets/agents/kilocode.svg)<br>**Kilo Code**](https://github.com/Kilo-Org/kilocode) | [![ZCode](./assets/agents/zcode.svg)<br>**ZCode**](https://z.ai) |
| [![Grok Build](./assets/agents/grokbuild.svg)<br>**Grok Build**](https://github.com/xai-org/grok-build) | [![OpenClaw](./assets/agents/openclaw.svg)<br>**OpenClaw**](https://github.com/openclaw/openclaw) | [![Pi Coding Agent](./assets/agents/pi.svg)<br>**Pi Coding Agent**](https://github.com/badlogic/pi-mono) | [![Hermes](./assets/agents/hermes.svg)<br>**Hermes**](https://github.com/NousResearch/hermes-agent) | [![Kimi CLI](./assets/agents/kimi.svg)<br>**Kimi CLI**](https://github.com/MoonshotAI/kimi-cli) |
| [![Qoder CLI](./assets/agents/qoder.svg)<br>**Qoder CLI**](https://github.com/qoderAI/qoder-cli) | [![WorkBuddy](./assets/agents/workbuddy.svg)<br>**WorkBuddy**](https://github.com/gabotechs/workbuddy) | [![千问办公](./assets/agents/qwen.svg)<br>**千问办公**](https://github.com/QwenLM/qwen-code) | [![DSH](./assets/agents/dsh.svg)<br>**DSH**](https://github.com/deepseek-ai/deepseek-harness) |  |


## 安装

```bash
dsh plugin --profile web add dsh-chat-import                    # npm 包
dsh plugin --profile web add -w link:/path/to/dsh-chat-import   # 本地源码（符号链接）
```

## 使用

1. **导入** — 在GUI界面右下角的导入会话面板选择你想导入的会话并一键导入。或让你的Agent调用上下文工具进行导入：

```
import_chat({ format: "claude", path: "~/.claude/projects" })
import_chat({ format: "chatgpt", path: "~/Downloads/chatgpt-export/conversations.json" })
import_chat({ format: "local-jsonl", path: "D:\downloads\session.jsonl" })
```

Reasonix 目录导入只会折叠同时满足“严格语义前缀”和明确 `parent_id` 谱系证明的恢复祖先。无法证明或真实分叉的文件继续独立保留；`lineageMode: "physical"` 可恢复每个 JSONL 一条会话。

2. **续聊** — 刷新会话列表，打开导入的会话，从源记录停下的地方继续对话。

3. **同步（可选）** — 面板「同步」页提供双向增量同步，默认关闭。子代理对话默认双向过滤。

4. **工具注入档位（可选）** — 设置页「会话导入」分区可调 `injectTools` 三档：**精简**（默认，只常驻 `import_chat` 入口工具，低频管理型工具不占上下文）、**全量**（注入全部 13 个工具）、**关闭**（Agent 不可见，仅 GUI 面板可转换）。工具描述已按「选择时最小化」瘦身，行为细节由执行结果与错误文本按需携带。

完整工具 / 命令用法（参数、示例、边界行为）见 **[docs/USAGE.zh-CN.md](docs/USAGE.zh-CN.md)**。

## 配套工具：配置迁移

只想迁移**配置**（技能、hooks、全局设置等）而不需要会话历史？[dsh-movein](https://github.com/sjh9714/dsh-movein) 负责配置迁移，与本插件分工互补--本插件只管会话历史，两边可按需单独使用。其[首次迁移指南](https://github.com/sjh9714/dsh-movein/blob/main/docs/first-migration.zh.md)提供「先预演、后应用、逐步验证」的分步流程。

> 两个工具的组合流程尚未联合验证，互链不构成互相背书；请分别检查来源、目标、重复导入与撤回边界。

本插件的 `import_agents` 是轻量的资产搬移（把 pi/opencode/Claude/Codex 的 agent、prompt、skill 落盘为 DSH skills）；需要 hooks、权限规则、settings 等完整配置迁移时，请使用 dsh-movein。

## 功能一览

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 批量导入 | `import_chat`（20 种格式）· `scan_discover` · 侧边栏面板 | 19+ 来源一键导入，每段对话成为独立会话 |
| 导入历史与撤回 | 侧边栏面板「历史」页 | 展示 `imports.json` 记录；一键删除本插件创建的会话（需确认） |
| 全保真续聊 | 导入即 DSH 会话 | 工具调用/结果、思考、标题、模型、时间戳原样保留 |
| 反向导出 | `export_chat`（`format: claude` / `codex` / `kimi`） | DSH 会话序列化回 Claude / Codex / Kimi |
| 双向同步 | 面板「同步」页 | 外部 ↔ DSH 双向增量同步，默认关闭 |

> 「全保真」的既定例外：源转录里**失败重发的 ghost step**（一轮工具调用没等到结果而中止、紧随的下一步用同一 callId 原样重发）会在导入时去重——保留重发步、丢弃失败步。重复 callId 的 `tool/call` 会让 DSH 会话折叠器在「同一 id 第二次 start」处硬异常、吞掉其后整段轨迹。丢弃计数见转换返回值 `droppedRetrySteps`。

## 文档

| 文档 | 说明 |
| --- | --- |
| [使用详解](docs/USAGE.zh-CN.md) | 每个工具 / 命令的完整参数、示例与边界行为 |
| [互转协议](docs/INTERCHANGE.md) | Interchange v1 协议与 bundle 格式 |
| [更新日志](CHANGELOG.md) | 版本历史（英文） |
| [路线图](ROADMAP.md) | 已实现 / 规划 |
| [贡献指南](CONTRIBUTING.md) | 开发环境、提交规范、安全与隐私 |

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=Nwflower/dsh-chat-import&type=date&legend=top-left&sealed_token=sAq09Z4DmwD843pzhg7azZtfXs8zW_Xij3fvCo3Ns1BGAgNeP_Zl1xU9YiUacS74_EzDXKHFpW3Bfj13ClcEMRzAhh4mVrl4a20ijURAGU_Oz6RROQYDYw)](https://www.star-history.com/?type=date&repos=Nwflower%2Fdsh-chat-import)
