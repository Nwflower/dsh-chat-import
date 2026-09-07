<div align="center">

<img src="./assets/dci-promo.png" alt="DSH Chat Import" width="100%" />

# DSH Chat Import

**A DeepSeek Harness plugin that imports conversation history from 18+ AI coding tools, so you can continue right where you left off.**

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

## Intro

`DSH Chat Import` imports conversation history with full context from other agents, turning it into a seamlessly resumable DeepSeek Harness session.

Now covers import from 20 agents: Claude Code, Codex, ChatGPT, Cursor, Gemini, Reasonix, opencode, MiMo Code, ZCode, Grok Build, OpenClaw, Pi Coding Agent, Hermes, Kimi CLI / Kimi Code, Kilo Code, Qoder CLI, WorkBuddy, Qwen Work CN (千问办公) and DSH session logs.

Export back to: Claude Code, Codex, Kimi Code.

## Supported Agents

|  |  |  |  |  |
| --- | --- | --- | --- | --- |
| [![Claude Code](./assets/agents/claude.svg)<br>**Claude Code**](https://github.com/anthropics/claude-code) | [![Codex](./assets/agents/codex.svg)<br>**Codex**](https://github.com/openai/codex) | [![ChatGPT](./assets/agents/chatgpt.svg)<br>**ChatGPT**](https://chatgpt.com) | [![Cursor](./assets/agents/cursor.svg)<br>**Cursor**](https://cursor.com) | [![Gemini](./assets/agents/gemini.svg)<br>**Gemini CLI**](https://github.com/google-gemini/gemini-cli) |
| [![Reasonix](./assets/agents/reasonix.svg)<br>**Reasonix**](https://github.com/esengine/DeepSeek-Reasonix) | [![OpenCode](./assets/agents/opencode.svg)<br>**OpenCode**](https://github.com/anomalyco/opencode) | [![MiMo Code](./assets/agents/mimocode.svg)<br>**MiMo Code**](https://github.com/XiaomiMiMo/MiMo-Code) | [![Kilo Code](./assets/agents/kilocode.svg)<br>**Kilo Code**](https://github.com/Kilo-Org/kilocode) | [![ZCode](./assets/agents/zcode.svg)<br>**ZCode**](https://z.ai) |
| [![Grok Build](./assets/agents/grokbuild.svg)<br>**Grok Build**](https://github.com/xai-org/grok-build) | [![OpenClaw](./assets/agents/openclaw.svg)<br>**OpenClaw**](https://github.com/openclaw/openclaw) | [![Pi Coding Agent](./assets/agents/pi.svg)<br>**Pi Coding Agent**](https://github.com/badlogic/pi-mono) | [![Hermes](./assets/agents/hermes.svg)<br>**Hermes**](https://github.com/NousResearch/hermes-agent) | [![Kimi CLI](./assets/agents/kimi.svg)<br>**Kimi CLI**](https://github.com/MoonshotAI/kimi-cli) |
| [![Qoder CLI](./assets/agents/qoder.svg)<br>**Qoder CLI**](https://github.com/qoderAI/qoder-cli) | [![WorkBuddy](./assets/agents/workbuddy.svg)<br>**WorkBuddy**](https://github.com/gabotechs/workbuddy) | [![Qwen Work CN](./assets/agents/qwen.svg)<br>**Qwen Work CN**](https://github.com/QwenLM/qwen-code) | [![DSH](./assets/agents/dsh.svg)<br>**DSH**](https://github.com/deepseek-ai/deepseek-harness) |  |

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

Reasonix directory imports conservatively collapse only recovery ancestors proven by both a strict semantic prefix and an explicit `parent_id` lineage. Ambiguous or divergent files remain separate; use `lineageMode: "physical"` for one session per JSONL.

2. **Resume** — refresh the session list, open the imported session, and keep chatting from where the source left off.

3. **Sync (optional)** — the panel's "Sync" tab offers bidirectional incremental sync, off by default. Sub-agent conversations are filtered out by default in both directions.

Full tool / command usage (parameters, examples, edge cases) lives in **[docs/USAGE.md](docs/USAGE.md)**.

## Companion tool: config migration

Only need to migrate **configuration** (skills, hooks, global settings) rather than conversation history? [dsh-movein](https://github.com/sjh9714/dsh-movein) handles config migration and complements this plugin -- DSH Chat Import only handles conversation history, and each tool works standalone. Its first-migration guide ([中文](https://github.com/sjh9714/dsh-movein/blob/main/docs/first-migration.zh.md)) walks through a preview-first, apply-second, verify-each-step flow.

> The combined flow of the two tools has not been jointly validated, and cross-linking is not a mutual endorsement; check sources, targets, duplicate-import and retraction boundaries for each tool separately.

This plugin's `import_agents` is a lightweight asset mover (it persists pi/opencode/Claude/Codex agents, prompts and skills as DSH skills); for full config migration (hooks, permission rules, settings), use dsh-movein.

## Features

| Capability | Entry points | Description |
| --- | --- | --- |
| Batch import | `import_chat` (20 formats) · `scan_discover` · sidebar panel | Import 19+ sources with one tool; each conversation becomes its own session |
| Import history & purge | sidebar panel **History** tab | View `imports.json` records; remove plugin-created sessions (with confirmation) |
| Full-fidelity resume | Imported sessions | Tool calls & results, reasoning, titles, models and timestamps carry over |
| Export back | `export_chat` (`format: claude` / `codex` / `kimi`) | Serialize DSH sessions back to Claude / Codex / Kimi |
| Bidirectional sync | panel "Sync" tab | Incremental sync in both directions (external ↔ DSH), off by default |

> One documented exception to full fidelity: **failed ghost retry steps**. When a tool call never received its result and the very next step re-emits the same call id verbatim, the dead step is dropped at import — the result already pairs with the re-emitted call. Duplicate call ids in the imported log would hard-fail DSH's conversation folding (a second `start` for the same id), swallowing the whole trajectory after the first duplicate. See the `droppedRetrySteps` counter on the converter result.

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
