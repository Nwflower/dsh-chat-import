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
| Batch import from 17+ sources | `import_chat` (18 formats) · `scan_discover` · sidebar panel · `/import` | A file, a directory or a whole database — each conversation becomes its own session |
| Full-fidelity resume | Imported sessions | Tool calls & results, reasoning, titles, models and timestamps carry over; sessions group into the source `cwd` workspace |
| Matrix export | `export_chat` (`format: claude` / `codex` / `kimi`) | Serialize DSH sessions back to Claude / Codex / Kimi formats; every lossy item is reported |
| Portable backup | `export_bundle` / `restore_bundle` | Interchange bundle with dual SHA-256 fingerprints, restorable across machines |
| Incremental write-back | `sync_to_claude` | Appends new complete turns back to a Claude Code file — guarded, never overwriting |
| Bidirectional sync | panel "Sync" tab | Incremental inbound/outbound sync across Claude / Codex / Grok; sub-agent conversations filtered by default; per-directory `excludeDirs` deny-list |
| Agent asset migration | `import_agents` | Converts pi / opencode / Claude / Codex agents, prompts, skills, instructions into persistent DSH skills |
| MCP mirror plan | `import_mcp` / `/mcp-status` | Reads Claude / Codex MCP servers and generates a reviewable DSH MCP client YAML snippet |
| Settings translation | `import_settings` / `/settings-suggest` | Turns Claude settings / Codex config into DSH migration suggestions (read-only) |
| Handoff summaries | `/resume-claude` / `/resume-codex` | Treats external transcripts as untrusted history and injects a handoff summary into the current session |
| Read-only audit / checkup | `verify_session` / `doctor` / CLI `dsh-chat-import doctor` | Structural audit and migration health check |
| Idempotency & protection | `import_chat` (all sources) | `expectedHash` / `restamp` / context-budget protection; unchanged sources skip, grown sources append |
| Preset mode + system prompt | Settings tab in the Plugins section | Imported sessions record the default preset; optional "import system prompt" as a context injection (off by default) |

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
