<div align="center">

# 📥 DSH Chat Import

**Import 17+ external agent conversation histories into DeepSeek Harness as full-fidelity, resumable sessions — and export / sync back to Claude Code, Codex, Kimi, or a portable interchange bundle.**

[![English](https://img.shields.io/badge/lang-English-blue.svg)](#) [![简体中文](https://img.shields.io/badge/lang-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red.svg)](README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/dsh-chat-import?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/dsh-chat-import)
[![npm downloads](https://img.shields.io/npm/dm/dsh-chat-import?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/dsh-chat-import)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![Node.js >= 22.13](https://img.shields.io/badge/Node.js-%3E%3D22.13-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](package.json)
[![CI](https://img.shields.io/github/actions/workflow/status/Nwflower/dsh-chat-import/ci.yml?style=for-the-badge&logo=githubactions&logoColor=white)](https://github.com/Nwflower/dsh-chat-import/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/Nwflower/dsh-chat-import?style=for-the-badge&logo=github&logoColor=white)](https://github.com/Nwflower/dsh-chat-import)
[![Listed in Awesome DeepSeek Harness](https://img.shields.io/badge/Listed_in-Awesome_DeepSeek_Harness-6A5ACD?style=for-the-badge&logo=awesome&logoColor=white)](https://github.com/0xsline/awesome-deepseek-harness)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![dsh.so security](https://www.dsh.so/badges/dsh-chat-import-shield.svg)](https://www.dsh.so/artifact/dsh-chat-import/)
[![Listed in Awesome DSH Plugins](https://img.shields.io/badge/Listed_in-Awesome_DSH_Plugins-6A5ACD?style=for-the-badge&logo=awesome&logoColor=white)](https://github.com/Dominic789654/awesome-deepseek-harness)

[💡 Intro](#-intro) · [🚀 Install](#-install) · [✨ Features](#-features) · [🗂 Supported sources](#-supported-sources) · [🛠 Usage](#-usage) · [🔑 Key behaviors](#-key-behaviors) · [📚 Docs](#-docs) · [⭐ Star History](#-star-history) · [🤝 Contributing](#-contributing)

</div>

> **17+ agent sources, one plugin** — full-fidelity import into DeepSeek Harness, seamless resume, matrix interop / backup / handoff on the way out.

<div align="center">

<img src="./assets/wb.png" alt="WorkBuddy" width="600" />

**Changelog:** [CHANGELOG.md](CHANGELOG.md) · **Roadmap:** [ROADMAP.md](ROADMAP.md) · **Interchange protocol:** [docs/INTERCHANGE.md](docs/INTERCHANGE.md)

</div>

---

## 💡 Intro

`dsh-chat-import` imports conversation histories from **Claude Code, Codex, ChatGPT, Cursor, Gemini, Reasonix, opencode, MiMo Code, ZCode, Grok Build, OpenClaw, Pi Coding Agent, Hermes, Kimi CLI / Kimi Code, Qoder CLI, WorkBuddy and DSH session logs** — tool calls, reasoning and all — as **full-fidelity, resumable DeepSeek Harness sessions**. Source files are read **read-only** (never rewritten), the DSH engine is never touched, and every import becomes a fresh session grouped into the workspace of its source `cwd`.

The reverse direction is covered too: `export_claude` serializes a DSH session back into a Claude Code JSONL transcript that Claude Code can load with `--resume` (read-only — your DSH log is never modified), `sync_to_claude` incrementally appends a session's new turns back to a Claude Code file — guarded, never silently overwriting — and the same matrix extends to **Codex rollouts** (`export_codex`) and **Kimi wire files** (`export_kimi`), plus a **portable interchange bundle** (`export_bundle` / `restore_bundle`) with SHA-256 fingerprints and cross-machine restore.

Requires **Node.js ≥ 22.13**, targets **dsh 0.1.x** (tested on `0.1.0-rc.6` / `0.1.0-rc.7`).

---

## 🚀 Install

```bash
dsh plugin --profile web add dsh-chat-import                    # npm package
dsh plugin --profile web add -w link:/path/to/dsh-chat-import   # local checkout (symlink)
```

Then:

1. **Import** — call any `import_*` tool in a DSH session:

```
import_claude({ path: "~/.claude/projects" })
import_chatgpt({ path: "~/Downloads/chatgpt-export/conversations.json" })
import_local_jsonl({ path: "D:\downloads\session.jsonl" })
```

2. **Resume** — refresh the session list, open the imported session, and keep chatting from where the source left off.
3. **Discover & batch** — `scan_discover()` previews read-only; the sidebar "Import sessions" panel browses by workspace and supports multi-select import; `/import-all` batch-imports everything.
4. **Sync (optional)** — the panel's "Sync" tab offers bidirectional incremental sync (external → DSH, DSH → external), default off. Sub-agent conversations are filtered out by default in both directions, and `excludeDirs` deny-lists let you skip specific workspace directories per direction.

> Uninstall: remove the `import-claude` insert line from your profile's bundles and restart dsh; imported sessions stay untouched and the plugin never auto-deletes.

---

## ✨ Features

| Capability | Entry points | Description |
| --- | --- | --- |
| Batch import from 17+ sources | `import_*` (18 tools) · `scan_discover` · sidebar panel · `/import` | A file, a directory or a whole database — each conversation becomes its own session |
| Full-fidelity resume | Imported sessions | Tool calls & results, reasoning, titles, models and timestamps carry over; sessions group into the source `cwd` workspace |
| Matrix export | `export_claude` / `export_codex` / `export_kimi` | Serialize DSH sessions back to Claude / Codex / Kimi formats; every lossy item is reported |
| Portable backup | `export_bundle` / `restore_bundle` | Interchange bundle with dual SHA-256 fingerprints, restorable across machines |
| Incremental write-back | `sync_to_claude` | Appends new complete turns back to a Claude Code file — guarded, never overwriting |
| Bidirectional sync | panel "Sync" tab | Incremental inbound/outbound sync across Claude / Codex / Grok; sub-agent conversations filtered by default; per-directory `excludeDirs` deny-list |
| Agent asset migration | `import_agents` | Converts pi / opencode / Claude / Codex agents, prompts, skills, instructions into persistent DSH skills |
| MCP mirror plan | `import_mcp` / `/mcp-status` | Reads Claude / Codex MCP servers and generates a reviewable DSH MCP client YAML snippet |
| Settings translation | `import_settings` / `/settings-suggest` | Turns Claude settings / Codex config into DSH migration suggestions (read-only) |
| Handoff summaries | `/resume-claude` / `/resume-codex` | Treats external transcripts as untrusted history and injects a handoff summary into the current session |
| Read-only audit / checkup | `verify_session` / `doctor` / CLI `dsh-chat-import doctor` | Structural audit and migration health check |
| Idempotency & protection | All import tools | `expectedHash` / `restamp` / context-budget protection; unchanged sources skip, grown sources append |
| Preset mode + system prompt | Settings tab in the Plugins section | Imported sessions record the default preset; optional "import system prompt" as a context injection (off by default) |

---

## 🗂 Supported sources

| Source | Storage location | Import tool |
| --- | --- | --- |
| **Claude Code** | `~/.claude/projects/<slug>/<sessionId>.jsonl` | `import_claude` |
| **Claude-3p** (new client) | `%LOCALAPPDATA%\Claude-3p\claude-code-sessions` (metadata → JSONL via `cliSessionId`) | `import_claude` |
| **Codex / ChatGPT CLI** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `import_codex` |
| **ChatGPT** (web export) | anywhere you saved the export — `conversations.json` | `import_chatgpt` |
| **Cursor** | `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` | `import_cursor` |
| **Gemini CLI** | `~/.gemini/history/<slot>/chats/session-*.json` | `import_gemini` |
| **Reasonix** (CLI + desktop) | `~/.reasonix/sessions/desktop-*.jsonl` · `%APPDATA%\reasonix\projects\<slug>\sessions\*.jsonl` | `import_reasonix` |
| **opencode** | `~/.local/share/opencode/opencode.db` | `import_opencode` |
| **MiMo Code** (opencode fork) | `~/.local/share/mimocode/mimocode.db` | `import_mimocode` |
| **ZCode** (z.ai CLI) | `~/.zcode/cli/db/db.sqlite` | `import_zcode` |
| **Grok Build** | `~/.grok/sessions/<project>/<session_id>/` | `import_grokbuild` |
| **OpenClaw** | `~/.openclaw/agents/<agent>/sessions/*.jsonl` | `import_openclaw` |
| **Pi Coding Agent** | `~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl` | `import_pi` |
| **Hermes** | `~/.hermes/` (Windows `%LOCALAPPDATA%\hermes`) | `import_hermes` |
| **Kimi CLI / Kimi Code** | `~/.kimi/sessions/<workdir-md5>/<sessionId>/wire.jsonl` · `~/.kimi-code/sessions/<workspaceId>/<sessionId>/agents/main/wire.jsonl` | `import_kimi` |
| **Qoder CLI** | `~/.qoder/projects/<encoded-project>/<sessionId>.jsonl` (subagents in `<sessionId>/subagents/*.jsonl`) | `import_qoder` |
| **WorkBuddy** (Tencent AI coding app) | `~/.workbuddy/projects/<project-hash>/<session-uuid>.jsonl` | `import_workbuddy` |
| **DSH session logs** | `~/.dsh/sessions/<encoded-workspace>/<sessionId>/session.jsonl(.zstd)` | `import_dsh` |
| **Any local JSONL** | any `.jsonl` file / directory (auto-detected) | `import_local_jsonl` |

Each import preserves what the source actually records; anything a format cannot preserve is explicitly flagged in the import report. Per-format details and edge cases live in [Usage Reference](docs/USAGE.md).

---

## 🛠 Usage

All `import_*` tools share the same `path` semantics: a single file becomes one session, a directory is scanned recursively for batch import. Common options: `preview` (zero side effects), `force` (new full copy), `sessionId` (override target id), `expectedHash` (SHA-256 verification), `restamp` (shift timestamps to now), `workspaceMode` / `workspaceDir` (grouping control).

```
import_claude({ path: "C:\Users\<you>\.claude\projects\<slug>\<sessionId>.jsonl" })
import_opencode({ path: "C:\Users\<you>\.local\share\opencode\opencode.db" })
import_workbuddy({ path: "C:\Users\<you>\.workbuddy\projects" })
import_local_jsonl({ path: "D:\downloads\session.jsonl", format: "claude" })
```

`import_chatgpt` / `import_opencode` / `import_zcode` / `import_hermes` always return batch results — one file / database contains every session, and each conversation becomes its own session in a single call.

Full per-tool / per-command usage lives in **[docs/USAGE.md](docs/USAGE.md)**.

---

## 🔑 Key behaviors

- **Read-only import** — source transcripts and databases are never rewritten; imported DSH history is append-only.
- **Idempotent + incremental** — unchanged sources skip without re-reading; grown sources append only new turns; shrinking is detected and reported.
- **Auto workspace grouping** — sessions land in the workspace of their source `cwd` (authoritative mapping → slug decode → home-directory sandbox guard; falls back to the source file's directory when the path does not exist locally).
- **Preset mode** — imported sessions mount the default preset scope via `agents.create` and write the default preset id back to `SessionHeader.agentPreset`, so the UI shows the preset-mode chip exactly like a normal session.
- **Environment-change note (always on)** — every imported session pins a "context injection" collapsed row before the first turn declaring that it has migrated to DSH and that tools / permissions / instructions now follow the current DSH session, so a continued session does not reuse the source environment's old tool names or commands.
- **System prompt (optional, off by default)** — the "Import system prompt" setting (a tab in the settings Plugins section) appends the source transcript's `system` / `developer` prompt after the environment-change note (also collapsed as a "context injection"). Claude Code transcripts do not persist a system prompt, so the toggle is a no-op for that source.
- **Fail loudly** — malformed lines, suspected secrets, format limitations and export degradations are all reported; every persisted session gets a structural self-check.
- **Sandbox** — reading sources or writing exports outside the workspace requires the session sandbox to allow that path.

---

## 📚 Docs

| Document | Description |
| --- | --- |
| [Usage Reference](docs/USAGE.md) | Full parameters, examples and edge cases for every tool / command |
| [Interchange protocol](docs/INTERCHANGE.md) | Interchange v1 protocol and bundle format |
| [Changelog](CHANGELOG.md) | Version history |
| [Roadmap](ROADMAP.md) | Shipped / planned |
| [Contributing](CONTRIBUTING.md) | Development setup, commit rules, security & privacy |

---

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=Nwflower/dsh-chat-import&type=date&legend=top-left&sealed_token=sAq09Z4DmwD843pzhg7azZtfXs8zW_Xij3fvCo3Ns1BGAgNeP_Zl1xU9YiUacS74_EzDXKHFpW3Bfj13ClcEMRzAhh4mVrl4a20ijURAGU_Oz6RROQYDYw)](https://www.star-history.com/?type=date&repos=Nwflower%2Fdsh-chat-import)

---

## 🤝 Contributing

Contributions welcome — fork the repo, create a `feature/<name>` branch, and open a PR. Full guide: [CONTRIBUTING.md](CONTRIBUTING.md).

- **Tests:** `npm test` · **Cross-platform guard:** `npm run check:linux`
- Repo conventions: [AGENTS.md](AGENTS.md) — conventional commits, bilingual READMEs must stay in sync, plugin consumes public dsh host services only, multi-session file-claim protocol.

---

## 📄 License

MIT — see [LICENSE](LICENSE).
