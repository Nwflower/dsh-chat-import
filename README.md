<div align="center">

<img src="./assets/dci-promo.png" alt="DSH Chat Import" width="100%" />

# DSH Chat Import

**A session import plugin built on DeepSeek Harness: import conversation history from other agents with one click, then keep talking in DeepSeek Harness.**

> **All sessions, continued in DSH.**

[![English](https://img.shields.io/badge/lang-English-blue.svg)](README.md) [![简体中文](https://img.shields.io/badge/lang-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red.svg)](README.zh-CN.md)

[![version](https://img.shields.io/npm/v/dsh-chat-import?style=flat&label=version&color=4D6BFE)](https://www.npmjs.com/package/dsh-chat-import)
[![downloads](https://img.shields.io/npm/dm/dsh-chat-import?style=flat&label=downloads&color=4D6BFE)](https://www.npmjs.com/package/dsh-chat-import)
[![GitHub stars](https://img.shields.io/github/stars/Nwflower/dsh-chat-import?style=flat&label=%E2%98%85&color=08C)](https://github.com/Nwflower/dsh-chat-import)
[![GitCode](https://img.shields.io/badge/GitCode-mirror-4D6BFE?style=flat)](https://gitcode.com/Nwflower/dsh-chat-import)
[![license](https://img.shields.io/badge/license-MIT-2EA44F?style=flat)](LICENSE)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![dsh.so install](https://www.dsh.so/badge/install/dsh-chat-import.svg)](https://www.dsh.so/artifact/dsh-chat-import/)

</div>


## Supported Data Sources

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
    <td align="center" width="20%"><a href="https://github.com/can1357/oh-my-pi"><img src="./assets/agents/omp.svg" width="56" height="56" alt="oh-my-pi" /><br /><b>oh-my-pi</b></a></td>
    <td align="center" width="20%"><a href="https://github.com/NousResearch/hermes-agent"><img src="./assets/agents/hermes.svg" width="56" height="56" alt="Hermes" /><br /><b>Hermes</b></a></td>
    <td align="center" width="20%"><a href="https://cursor.com"><img src="./assets/agents/cursor.svg" width="56" height="56" alt="Cursor" /><br /><b>Cursor</b></a></td>
    <td align="center" width="20%"><a href="https://github.com/cline/cline"><img src="./assets/agents/cline.svg" width="56" height="56" alt="Cline" /><br /><b>Cline</b></a></td>
  </tr>
  <tr>
    <td align="center" width="20%"><a href="https://github.com/continuedev/continue"><img src="./assets/agents/continue.svg" width="56" height="56" alt="Continue" /><br /><b>Continue</b></a></td>
    <td align="center" width="20%"><a href="https://github.com/zed-industries/zed"><img src="./assets/agents/zed.svg" width="56" height="56" alt="Zed" /><br /><b>Zed</b></a></td>
    <td align="center" width="20%"><a href="https://antigravity.google"><img src="./assets/agents/antigravity.svg" width="56" height="56" alt="Antigravity" /><br /><b>Antigravity</b></a></td>
    <td align="center" width="20%"><a href="https://chatgpt.com"><img src="./assets/agents/chatgpt.svg" width="56" height="56" alt="ChatGPT" /><br /><b>ChatGPT</b></a></td>
    <td align="center" width="20%"><a href="https://github.com/gabotechs/workbuddy"><img src="./assets/agents/workbuddy.svg" width="56" height="56" alt="WorkBuddy" /><br /><b>WorkBuddy</b></a></td>
  </tr>
  <tr>
    <td align="center" width="20%"><a href="https://github.com/QwenLM/qwen-code"><img src="./assets/agents/qwen.svg" width="56" height="56" alt="Qwen" /><br /><b>Qwen</b></a></td>
    <td align="center" width="20%"><a href="https://github.com/deepseek-ai/deepseek-harness"><img src="./assets/agents/dsh.svg" width="56" height="56" alt="DSH" /><br /><b>DSH</b></a></td>
    <td align="center" width="20%"><a href="https://www.teleai.com.cn/product/super-agent"><img src="./assets/agents/teleagent.svg" width="56" height="56" alt="TeleAgent" /><br /><b>TeleAgent</b></a></td>
    <td align="center" width="20%"><a href="https://www.trae.ai/"><img src="./assets/agents/trae.svg" width="56" height="56" alt="Trae Work" /><br /><b>Trae Work</b></a></td>
    <td align="center" width="20%"><a href="https://www.doubao.com/download/desktop"><img src="./assets/agents/doubao.svg" width="56" height="56" alt="Doubao" /><br /><b>Doubao</b></a></td>
    <td align="center" width="20%"><a href="https://github.com/mistralai/mistral-vibe"><img src="./assets/agents/vibe.svg" width="56" height="56" alt="Mistral Vibe" /><br /><b>Mistral Vibe</b></a></td>
  </tr>
  <tr>
    <td align="center" width="20%"><a href="#usage"><img src="./assets/agents/local-jsonl.svg" width="56" height="56" alt="Local JSONL" /><br /><b>Local JSONL</b></a></td>
    <td align="center" width="20%"><a href="https://github.com/microsoft/vscode"><img src="./assets/agents/copilot.svg" width="56" height="56" alt="Copilot VS Code" /><br /><b>Copilot VS Code</b></a></td>
    <td align="center" width="20%"><a href="https://github.com/github/copilot-cli"><img src="./assets/agents/copilot.svg" width="56" height="56" alt="Copilot CLI" /><br /><b>Copilot CLI</b></a></td>
  </tr>
</table>

## Install

> Requires dsh 0.1.5-rc.1 or newer. Verified on the 0.1.x line and on 0.2.0-rc.1; dsh-tools must satisfy `>=0.1.0-rc.6 <0.3.0`.

1. Install from a terminal

```bash
dsh plugin --profile web add dsh-chat-import                    # npm package
```

2. Or install from the [Plugin Marketplace](https://github.com/dsh-market/dsh-market)

## Usage

1. Import conversations from the GUI

  Click the **Import sessions** button at the bottom of the left sidebar to open the import window. With the DSH Claude Style theme, that button lives in the account menu at the bottom left. Pick the conversations you want and import them in one click.

  Rows carry their own tools: **double-click** a row to preview the conversation (a read-only dry-run — plugin injections skipped, tool calls folded into one line), switch the search box to **In content** to search message bodies instead of titles, **hide** a row reversibly, move a single-session source file to the Recycle Bin, or **drag the row onto a workspace** in the left sidebar to import it there with its timestamps shifted so it sorts to the top. The exact rules are in [docs/USAGE.md](docs/USAGE.md).

  If the file came from somewhere else — a web-app export, a script you wrote, a tool this plugin does not list — use **Import from file** at the top of the same window. Type a local path and press Enter, or press **Choose…** to pick files. When the path is a directory, it asks whether to search subfolders. Check the preview, then import. If detection fails, it lists why each candidate parser gave up and points you at the skill that converts the format.

  <table>
    <tr>
      <td align="center" width="50%"><img src="./docs/panel-light.png" alt="Import panel — light" /></td>
      <td align="center" width="50%"><img src="./docs/panel-dark.png" alt="Import panel — dark" /></td>
    </tr>
  </table>

  > These screenshots also use the DeepSeek palette from [DSH Claude Style](https://github.com/Nwflower/dsh-claude-style), another theme plugin by the same author. It recreates the look and feel of Claude Code Desktop inside DSH and ships two palettes, one for Claude and one for DeepSeek. If the default theme is not quite your taste, give it a try. The workspaces and sessions in the screenshots are sample data.

2. Import through an agent's tool call

```
# Example call formats
import_chat({ format: "claude", path: "~/.claude/projects" })
import_chat({ format: "chatgpt", path: "~/Downloads/chatgpt-export/conversations.json" })
import_chat({ format: "local-jsonl", path: "D:\downloads\session.jsonl" })
```

## Configuration

To accommodate TUI users, the tools this plugin provides start out injected into context. In Settings you can switch them to **not injected**, or to a partial injection, which saves a fair number of tokens.

Full tool and command usage is in **[docs/USAGE.md](docs/USAGE.md)**.

Third-party plugins can call `scanDiscover()`, `importPath()`, `importAll()`, and `resumeSummary()` on the optional `chatImport` host service. These reuse the same discovery, import, batch-import, and handoff-summary pipelines as the built-in tools and commands. A single-session import result includes `sessionId`. When the service is absent, callers should degrade gracefully.

## Features

| Capability | Entry Point | Description |
| --- | --- | --- |
| Import | Sidebar panel, "Import" tab | Import conversations from other agents, keeping reasoning, tool call results, and system prompts (optional) |
| Import from file | Panel "Import from file" / `/import auto <path>` | Any local file or directory: three-level detection (explicit format > content marker > parser trial), preview first, an optional search-subfolders prompt for directories, and, when every parser fails, a ready-to-send agent task brief plus a registered `dsh-chat-import-convert` skill |
| Retract Import | Sidebar panel, "History" tab | Review import history and delete sessions this plugin created |
| Export | Context tool | Serialize DSH sessions back into other agents' formats |
| Ignore | Automatic, plus `/ignores` | Archiving, deleting, or removing a workspace registers the source, so rescans skip it; `/ignore` and `/unignore` manage the table |

Codex discovery prefers the session title saved in `session_index.jsonl` (`thread_name`), so a rename made in Codex still shows up. Only when no indexed title exists does it fall back to the first real user prompt, extracted the same way import does it, with injected page context excluded. The title index is streamed line by line, and the last valid title record wins for each session.

For activity time, Codex discovery takes the latest valid timestamp found within bounded head and tail windows of the transcript and combines the results across rollout pages. File modification time is the fallback when the transcript carries no timestamp at all, so activity times still come back when the host file service does not expose modification times. A timestamp inside a truncated record can be missed.

Claude Code fork sessions (from the newer desktop session menu and from `--fork-session`) are discovered and imported too. A fork transcript opens with a verbatim copy of the parent's records and appends its own from the fork point, so the main-transcript test looks at **both ends** of the file: if the file name's stem appears at either end, the file owns that session. Session identity is the **last** `sessionId` in the transcript. Before this rule, such files were classified as subagent auxiliary transcripts and skipped wholesale. The copied prefix, which is the parent's history, stays in the log, because a fork's context really does contain it; the parent and the fork therefore overlap by one stretch of history.

On Windows, Hermes discovery scans `%LOCALAPPDATA%\hermes` and `~/.hermes`, falling back to `~/AppData/Local/hermes` when `LOCALAPPDATA` is unset. On macOS and Linux it scans `~/.hermes`.

## Docs

| Document | Description |
| --- | --- |
| [Usage Reference](docs/USAGE.md) | Complete parameters, examples, and edge cases for every tool and command |
| [Interchange Protocol](docs/INTERCHANGE.md) | Interchange v1 protocol and bundle format |
| [Conversion Guide](docs/INTERCHANGE-GUIDE.md) | Agent-facing skill instructions: convert any transcript into an importable interchange v1 document |
| [Import Guide](docs/IMPORT-GUIDE.md) | Agent-facing skill instructions: the format table, parameter reference, and re-import rules for `import_chat` |
| [Settings Migration](docs/SETTINGS-MIGRATION.md) | DSH 0.1.5 → 0.1.7 plugin settings-page migration (measured errors, compatibility recipe) |
| [Changelog](CHANGELOG.md) | Version history |
| [Roadmap](docs/ROADMAP.md) | Not yet done, planned, and explicitly out of scope |
| [Contributing](docs/CONTRIBUTING.md) | Development setup, commit rules, security and privacy |

## Related Links

> Need to migrate **configuration** (skills, hooks, global settings) rather than conversation history? Try [dsh-movein](https://github.com/sjh9714/dsh-movein).

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=Nwflower/dsh-chat-import&type=date&legend=top-left&sealed_token=sAq09Z4DmwD843pzhg7azZtfXs8zW_Xij3fvCo3Ns1BGAgNeP_Zl1xU9YiUacS74_EzDXKHFpW3Bfj13ClcEMRzAhh4mVrl4a20ijURAGU_Oz6RROQYDYw)](https://www.star-history.com/?type=date&repos=Nwflower%2Fdsh-chat-import)
