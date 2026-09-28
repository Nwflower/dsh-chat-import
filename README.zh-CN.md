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


## 支持数据源

<table>
  <tr>
    <td align="center" width="20%"><a href="https://github.com/anthropics/claude-code"><img src="./assets/agents/claude.svg" width="56" height="56" alt="Claude Code" /><br /><b>Claude Code</b></a></td>
    <td align="center" width="20%"><a href="https://github.com/openai/codex"><img src="./assets/agents/codex.svg" width="56" height="56" alt="Codex" /><br /><b>Codex</b></a></td>
    <td align="center" width="20%"><a href="https://github.com/google-gemini/gemini-cli"><img src="./assets/agents/gemini.svg" width="56" height="56" alt="Gemini CLI" /><br /><b>Gemini CLI</b></a></td>
    <td align="center" width="20%"><a href="https://github.com/aaif-goose/goose"><img src="./assets/agents/goose.svg" width="56" height="56" alt="Goose" /><br /><b>Goose</b></a></td>
    <td align="center" width="20%"><a href="https://github.com/charmbracelet/crush"><img src="./assets/agents/crush.svg" width="56" height="56" alt="Crush" /><br /><b>Crush</b></a></td>
  </tr>
  <tr>
    <td align="center" width="20%"><a href="https://github.com/qoderAI/qoder-cli"><img src="./assets/agents/qoder.svg" width="56" height="56" alt="Qoder CLI" /><br /><b>Qoder CLI</b></a></td>
    <td align="center" width="20%"><a href="https://github.com/MoonshotAI/kimi-cli"><img src="./assets/agents/kimi.svg" width="56" height="56" alt="Kimi CLI" /><br /><b>Kimi CLI</b></a></td>
    <td align="center" width="20%"><a href="https://github.com/MoonshotAI/kimi-code"><img src="./assets/agents/kimi.svg" width="56" height="56" alt="Kimi Code" /><br /><b>Kimi Code</b></a></td>
    <td align="center" width="20%"><a href="https://github.com/esengine/DeepSeek-Reasonix"><img src="./assets/agents/reasonix.svg" width="56" height="56" alt="Reasonix" /><br /><b>Reasonix</b></a></td>
    <td align="center" width="20%"><a href="https://github.com/anomalyco/opencode"><img src="./assets/agents/opencode.svg" width="56" height="56" alt="OpenCode" /><br /><b>OpenCode</b></a></td>
  </tr>
  <tr>
    <td align="center" width="20%"><a href="https://github.com/XiaomiMiMo/MiMo-Code"><img src="./assets/agents/mimocode.svg" width="56" height="56" alt="MiMo Code" /><br /><b>MiMo Code</b></a></td>
    <td align="center" width="20%"><a href="https://z.ai"><img src="./assets/agents/zcode.svg" width="56" height="56" alt="ZCode" /><br /><b>ZCode</b></a></td>
    <td align="center" width="20%"><a href="https://github.com/xai-org/grok-build"><img src="./assets/agents/grokbuild.svg" width="56" height="56" alt="Grok Build" /><br /><b>Grok Build</b></a></td>
    <td align="center" width="20%"><a href="https://github.com/openclaw/openclaw"><img src="./assets/agents/openclaw.svg" width="56" height="56" alt="OpenClaw" /><br /><b>OpenClaw</b></a></td>
    <td align="center" width="20%"><a href="https://github.com/Kilo-Org/kilocode"><img src="./assets/agents/kilocode.svg" width="56" height="56" alt="Kilo Code" /><br /><b>Kilo Code</b></a></td>
  </tr>
  <tr>
    <td align="center" width="20%"><a href="https://github.com/badlogic/pi-mono"><img src="./assets/agents/pi.svg" width="56" height="56" alt="Pi Coding Agent" /><br /><b>Pi Coding Agent</b></a></td>
    <td align="center" width="20%"><a href="https://github.com/NousResearch/hermes-agent"><img src="./assets/agents/hermes.svg" width="56" height="56" alt="Hermes" /><br /><b>Hermes</b></a></td>
    <td align="center" width="20%"><a href="https://cursor.com"><img src="./assets/agents/cursor.svg" width="56" height="56" alt="Cursor" /><br /><b>Cursor</b></a></td>
    <td align="center" width="20%"><a href="https://github.com/cline/cline"><img src="./assets/agents/cline.svg" width="56" height="56" alt="Cline" /><br /><b>Cline</b></a></td>
    <td align="center" width="20%"><a href="https://github.com/continuedev/continue"><img src="./assets/agents/continue.svg" width="56" height="56" alt="Continue" /><br /><b>Continue</b></a></td>
  </tr>
  <tr>
    <td align="center" width="20%"><a href="https://github.com/zed-industries/zed"><img src="./assets/agents/zed.svg" width="56" height="56" alt="Zed" /><br /><b>Zed</b></a></td>
    <td align="center" width="20%"><a href="https://antigravity.google"><img src="./assets/agents/antigravity.svg" width="56" height="56" alt="Antigravity" /><br /><b>Antigravity</b></a></td>
    <td align="center" width="20%"><a href="https://chatgpt.com"><img src="./assets/agents/chatgpt.svg" width="56" height="56" alt="ChatGPT" /><br /><b>ChatGPT</b></a></td>
    <td align="center" width="20%"><a href="https://github.com/gabotechs/workbuddy"><img src="./assets/agents/workbuddy.svg" width="56" height="56" alt="WorkBuddy" /><br /><b>WorkBuddy</b></a></td>
    <td align="center" width="20%"><a href="https://github.com/QwenLM/qwen-code"><img src="./assets/agents/qwen.svg" width="56" height="56" alt="Qwen" /><br /><b>Qwen</b></a></td>
  </tr>
  <tr>
    <td align="center" width="20%"><a href="https://github.com/deepseek-ai/deepseek-harness"><img src="./assets/agents/dsh.svg" width="56" height="56" alt="DSH" /><br /><b>DSH</b></a></td>
    <td align="center" width="20%"><a href="https://www.teleai.com.cn/product/super-agent"><img src="./assets/agents/teleagent.svg" width="56" height="56" alt="TeleAgent" /><br /><b>TeleAgent</b></a></td>
    <td align="center" width="20%"><a href="#使用"><img src="./assets/agents/local-jsonl.svg" width="56" height="56" alt="本地 JSONL" /><br /><b>本地 JSONL</b></a></td>
    <td align="center" width="20%"></td>
    <td align="center" width="20%"></td>
  </tr>
</table>

## 安装

> 插件依赖 dsh 0.1.5-rc.1 及以上版本 —— 已在 0.1.x 与 0.2.0-rc.1 上验证（dsh-tools 需满足 `>=0.1.0-rc.6 <0.3.0`）

1. 通过终端安装

```bash
dsh plugin --profile web add dsh-chat-import                    # npm 包
```

2. 通过[插件市场](https://github.com/dsh-market/dsh-market)安装

## 使用

1. 通过GUI导入会话
  从左侧栏底部的「导入会话」按钮打开导入窗口，选择你想导入的会话并一键导入。

  <table>
    <tr>
      <td align="center" width="50%"><img src="./docs/panel-light.png" alt="导入会话面板 —— 亮色" /></td>
      <td align="center" width="50%"><img src="./docs/panel-dark.png" alt="导入会话面板 —— 暗色" /></td>
    </tr>
  </table>

  > 截图界面同时使用了作者的另外一个主题插件 [DSH Claude Style](https://github.com/Nwflower/dsh-claude-style) ：在DSH内复刻 Claude Code Desktop 的视觉和交互体验。如果你对默认主题不太习惯，不妨来尝试一下。

2. 通过Agent调用工具进行导入

```
# 参考调用格式
import_chat({ format: "claude", path: "~/.claude/projects" })
import_chat({ format: "chatgpt", path: "~/Downloads/chatgpt-export/conversations.json" })
import_chat({ format: "local-jsonl", path: "D:\downloads\session.jsonl" })
```

## 配置

为了兼容TUI用户，插件提供的工具会始终注入上下文，您可以在设置页配置导入工具**不注入上下文**、或部分注入上下文，这会节省大量token。

完整工具 / 命令用法见 **[docs/USAGE.zh-CN.md](docs/USAGE.zh-CN.md)**。

## 功能一览

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 导入 | 侧边栏面板「导入」页 | 从其他Agents导入对话，保留推理过程、工具调用结果和系统提示词（可选） |
| 撤回导入 | 侧边栏面板「历史」页 | 展示导入记录，一键删除本插件创建的会话。 |
| 导出 | 上下文工具 | DSH 会话序列化回外部Agents |
| 忽略 | 自动 + `/ignores` 命令 | 归档 / 删除 / 删工作区自动登记源，重扫跳过；`/ignore`、`/unignore` 管理忽略表 |

## 文档

| 文档 | 说明 |
| --- | --- |
| [使用详解](docs/USAGE.zh-CN.md) | 每个工具 / 命令的完整参数、示例与边界行为 |
| [互转协议](docs/INTERCHANGE.md) | Interchange v1 协议与 bundle 格式 |
| [设置页迁移](docs/SETTINGS-MIGRATION.zh-CN.md) | DSH 0.1.5 → 0.1.7 插件设置页迁移（实测报错、兼容写法） |
| [更新日志](CHANGELOG.md) | 版本历史（英文） |
| [路线图](docs/ROADMAP.md) | 已实现 / 规划 |
| [贡献指南](docs/CONTRIBUTING.md) | 开发环境、提交规范、安全与隐私 |

## 友链

> 只想迁移**配置**（技能、hooks、全局设置等）而不需要会话历史？推荐使用[dsh-movein](https://github.com/sjh9714/dsh-movein)

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=Nwflower/dsh-chat-import&type=date&legend=top-left&sealed_token=sAq09Z4DmwD843pzhg7azZtfXs8zW_Xij3fvCo3Ns1BGAgNeP_Zl1xU9YiUacS74_EzDXKHFpW3Bfj13ClcEMRzAhh4mVrl4a20ijURAGU_Oz6RROQYDYw)](https://www.star-history.com/?type=date&repos=Nwflower%2Fdsh-chat-import)
