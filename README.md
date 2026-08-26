<div align="center">

<img src="./assets/dci-promo.png" alt="DSH Chat Import" width="100%" />

# DSH Chat Import

**A DeepSeek Harness plugin that imports conversation history from 17+ AI coding tools, so you can continue right where you left off.**

> **All sessions, continued in DSH.**

[![English](https://img.shields.io/badge/lang-English-blue.svg)](README.md) [![简体中文](https://img.shields.io/badge/lang-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red.svg)](README.zh-CN.md)

[![version](https://img.shields.io/npm/v/dsh-chat-import?style=flat&label=version&color=4D6BFE)](https://www.npmjs.com/package/dsh-chat-import)
[![downloads](https://img.shields.io/npm/dm/dsh-chat-import?style=flat&label=downloads&color=4D6BFE)](https://www.npmjs.com/package/dsh-chat-import)
[![GitHub stars](https://img.shields.io/github/stars/Nwflower/dsh-chat-import?style=flat&label=%E2%98%85&color=08C)](https://github.com/Nwflower/dsh-chat-import)
[![license](https://img.shields.io/badge/license-MIT-2EA44F?style=flat)](LICENSE)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![dsh.so install](https://www.dsh.so/badge/install/dsh-chat-import.svg)](https://www.dsh.so/artifact/dsh-chat-import/)

</div>

## Intro

`DSH Chat Import` imports conversation history with full context from other agents, turning it into a seamlessly resumable DeepSeek Harness session.

Import from: Claude Code, Codex, ChatGPT, Cursor, Gemini, Reasonix, opencode, MiMo Code, ZCode, Grok Build, OpenClaw, Pi Coding Agent, Hermes, Kimi CLI / Kimi Code, Qoder CLI, WorkBuddy and DSH session logs.

Export back to: Claude Code, Codex, Kimi Code.

## Install

```bash
dsh plugin --profile web add dsh-chat-import                    # npm package
dsh plugin --profile web add -w link:/path/to/dsh-chat-import   # local checkout (symlink)
```

## Usage

1. **Import** — pick the conversations to import from the "Import sessions" panel in the bottom-right of the GUI and import with one click, or have your agent call the context tool:

```
import_chat({ format: "claude", path: "~/.claude/projects" })
import_chat({ format: "chatgpt", path: "~/Downloads/chatgpt-export/conversations.json" })
import_chat({ format: "local-jsonl", path: "D:\downloads\session.jsonl" })
```

2. **Resume** — refresh the session list, open the imported session, and keep chatting from where the source left off.

3. **Sync (optional)** — the panel's "Sync" tab offers bidirectional incremental sync, off by default. Sub-agent conversations are filtered out by default in both directions.

Full tool / command usage (parameters, examples, edge cases) lives in **[docs/USAGE.md](docs/USAGE.md)**.

## Features

| Capability | Entry points | Description |
| --- | --- | --- |
| Batch import | `import_chat` (18 formats) · `scan_discover` · sidebar panel | Import 17+ sources with one tool; each conversation becomes its own session |
| Full-fidelity resume | Imported sessions | Tool calls & results, reasoning, titles, models and timestamps carry over |
| Export back | `export_chat` (`format: claude` / `codex` / `kimi`) | Serialize DSH sessions back to Claude / Codex / Kimi |
| Bidirectional sync | panel "Sync" tab | Incremental sync in both directions (external ↔ DSH), off by default |

## Docs

| Document | Description |
| --- | --- |
| [Usage Reference](docs/USAGE.md) | Full parameters, examples and edge cases for every tool / command |
| [Interchange protocol](docs/INTERCHANGE.md) | Interchange v1 protocol and bundle format |
| [Changelog](CHANGELOG.md) | Version history |
| [Roadmap](ROADMAP.md) | Shipped / planned |
| [Contributing](CONTRIBUTING.md) | Development setup, commit rules, security & privacy |

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=Nwflower/dsh-chat-import&type=date&legend=top-left&sealed_token=sAq09Z4DmwD843pzhg7azZtfXs8zW_Xij3fvCo3Ns1BGAgNeP_Zl1xU9YiUacS74_EzDXKHFpW3Bfj13ClcEMRzAhh4mVrl4a20ijURAGU_Oz6RROQYDYw)](https://www.star-history.com/?type=date&repos=Nwflower%2Fdsh-chat-import)
