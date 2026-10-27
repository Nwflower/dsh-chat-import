# import_chat guide — formats, parameters, re-import rules

Long-form reference for the `import_chat` tool. The tool schema stays deliberately small: it
carries the format enum, the required `path`, and one line per parameter — enough to make the
call. This guide carries the rest (where each source keeps its data, what each parameter
actually changes, how re-import behaves), and is loaded only when an import is being prepared.

Registered as the host runtime skill **`dsh-chat-import-usage`**. The `import_chat` schema names
it; the same content is this file in the package (`docs/`), so an agent without the skills
service can still read it.

## Which format, and where its data lives

`path` accepts a transcript file, a session directory, or a whole data root. A single file or
database → one session; a directory → batch. Root shapes:

| format | path shape |
| --- | --- |
| `claude` | Claude Code JSONL (~/.claude/projects) |
| `codex` | Codex / ChatGPT CLI rollout JSONL (~/.codex) |
| `chatgpt` | ChatGPT web export conversations.json (one file, all sessions) |
| `cursor` | Cursor agent transcript JSONL (~/.cursor/projects) |
| `gemini` | Gemini CLI session JSON (~/.gemini/history) |
| `antigravity` | Antigravity session transcript (~/.gemini/antigravity / antigravity-cli) |
| `reasonix` | Reasonix session JSONL (~/.reasonix/sessions) |
| `opencode` | opencode db opencode.db — V1 or V2 schema (~/.local/share/opencode) |
| `mimocode` | mimocode db mimocode.db (~/.local/share/mimocode) |
| `kilocode` | Kilo Code db kilo.db (~/.local/share/kilo) |
| `teleagent` | TeleAgent db teleagent.db (TeleAgent/users/<account>) |
| `zcode` | z.ai zcode db.sqlite (~/.zcode/cli/db) or zcode://<sessionId> |
| `grokbuild` | Grok Build session directory (summary.json + chat_history.jsonl) |
| `openclaw` | OpenClaw session JSONL (~/.openclaw/agents) |
| `hermes` | Hermes db state.db (~/.hermes) |
| `pi` | Pi session JSONL (~/.pi/agent/sessions) |
| `omp` | oh-my-pi session JSONL (~/.omp/agent/sessions) |
| `kimi` | Kimi CLI / Kimi Code session directory (wire.jsonl + state.json) |
| `qoder` | Qoder CLI session JSONL (~/.qoder/projects / ~/.qoder-cn/projects) |
| `workbuddy` | WorkBuddy session JSONL (~/.workbuddy/projects) |
| `qwen` | Qwen Work CN (千问办公) session JSONL (~/.qwenworkcn/projects) |
| `trae` | Trae Work state.vscdb (Trae/User/workspaceStorage or globalStorage) |
| `doubao` | Doubao Desktop chat IndexedDB (<User Data>/<profile>/IndexedDB/chrome_doubao-chat_0.indexeddb.leveldb) |
| `vibe` | Mistral Vibe CLI session directory (~/.vibe/logs/session) |
| `continue` | Continue session JSON (~/.continue/sessions) |
| `copilot-vscode` | GitHub Copilot VS Code session JSON (<User>/workspaceStorage/<hash>/chatSessions) |
| `copilot-cli` | GitHub Copilot CLI session events.jsonl (~/.copilot/session-state/<id>) |
| `cline` | Cline session messages.json (~/.cline/data/sessions) |
| `goose` | Goose session db sessions.db (~/.local/share/goose/sessions) |
| `zed` | Zed agent thread db threads.db (<data_dir>/threads) |
| `crush` | Crush session db crush.db (<project>/.crush) |
| `dsh` | DSH V0-V3 session logs session[.vN].jsonl[.zstd] ($DSH_HOME/sessions) |
| `dsh4` | DSH V4+ session logs session.v4.jsonl[.zstd] ($DSH_HOME/sessions) |
| `local-jsonl` | Any local session file/dir — .jsonl/.jsonl.zstd/.json/.dshbundle.json; three-level auto-detect, parseFormat forces a parser |

`local-jsonl` is not a source of its own: it is the fallback entry for a file no source claimed.
It auto-detects `dsh` / `claude` / `codex` / `cursor` / `reasonix` / `pi` / `openclaw` / `hermes`
/ `qoder` / `vibe` / `copilot-vscode` / `copilot-cli` / `generic` (content marker > path hint >
parser trial) and `parseFormat` forces one parser when detection is wrong.

`doubao` reads the Chromium IndexedDB store of Doubao Desktop. Its conversation list is server-side,
so the local store only holds bodies for conversations the client has recently opened — sessions
without a locally cached body are not listed and cannot be imported (nothing is fabricated).

Prefer discovery over guessing paths: the `scan_discover` tool lists what is importable under
each source's default roots (optionally filtered by `path` / `format` / `query`), and the Import
Sessions panel shows the same list. An import that names the wrong root fails with the expected
root in the message — nothing is written.

## Parameters

Every parameter is declared in the tool schema; this is what each one does.

### Shared

- `path` (required) — source transcript, database, session directory or data root. Shape per format (table above).
- `force` — import as a fresh copy (`import-<src>-<n>`) even when the source was already imported.
- `budget` — context budget in tokens for the three-layer crop. Default 550k; resolution order is parameter > env `DSH_IMPORT_CONTEXT_BUDGET` > the model's window.
- `storeImages` — default `true`: images in the source become host attachments (`ctx.attachments`) so they survive in DSH. `false` keeps `[image]` text placeholders only; env `DSH_IMPORT_STORE_IMAGES=0` does the same.
- `preview` — `true` dry-runs: zero writes, returns only the would-import list.
- `dryRun` — alias of `preview`.
- `sessionId` — target DSH session id for single-file imports; default `import-<source id>`.
- `recursive` — recurse into subdirectories in directory mode (default `true`).
- `expectedHash` — expected SHA-256 (lowercase hex) of the source; a mismatch fails loudly and writes nothing.
- `restamp` — `true` shifts imported timestamps to now, keeping relative gaps; default keeps source times.
- `workspaceMode` — workspace grouping: `auto` | `per-project` | `dedicated` (all imports into one workspace).
- `workspaceDir` — workspace directory when `workspaceMode=dedicated`.
- `cwdRemap` — rewrite source cwd prefixes for cross-machine migration, e.g. `[{from:"D:/work",to:"/home/me/work"}]`. Longest prefix wins; applies to new imports only (already-imported sources are skipped — use `force` for a fresh copy).

### Source-specific

- `compacted` (claude, legacy alias) — importing the compaction summary is the default behavior now (native compaction checkpoints); the alias only exists for older callers.
- `branch` (chatgpt) — `main` (default) imports the main thread only; `all` writes one session per branch path.
- `sessionIds` (multi-session sources: chatgpt / opencode / mimocode / kilocode / teleagent / zcode / trae / doubao / goose / zed / crush) — import only these source session ids.
- `fullHistory` (compaction-aware sources) — `true` imports the full history without native compaction checkpoints; default `false` respects compaction, so the model sees the summary checkpoint plus what follows.
- `includeToolUseResult` (claude) — also import the structured `toolUseResult` sidecar (edit diffs via `structuredPatch` / `bashEditDiff`, questions/answers, exit codes and other scalar metadata) as text appended to each tool result. Default `false`; it grows large transcripts noticeably, and the flag is part of the argument fingerprint (changing it requires `force`).
- `lineage` (hermes) — `tail` imports only lineage leaf sessions.
- `lineageMode` (reasonix) — `canonical` (default) collapses proven recovery ancestors; `physical` writes one session per JSONL.
- `parseFormat` (local-jsonl) — force a parser instead of auto-detecting; `generic` reads an interchange v1 document.

## Re-import rules

Importing the same source twice is idempotent by design:

- **Source unchanged** → skipped without re-reading it (the registry keeps a content fingerprint).
- **Source grew, DSH session untouched** → the new turns are appended to the existing session.
- **Source grew, DSH session already chatted in** → a new copy is minted instead; the old session is recorded in `record.copies` and never appended to. Your own conversation is never rewritten.
- **`force: true`** → always a fresh copy.

Session logs are append-only: imports only `create` + `append`, never rewrite history.

## Copilot VS Code

`copilot-vscode` accepts a `workspaceStorage` root, a `chatSessions` directory, or a
single version 3 session JSON file. Default discovery covers Code, Code -
Insiders and VSCodium; set `COPILOT_VSCODE_STORAGE_DIR` for portable user data.
The title, source times, prose, reasoning and stored tool input/results are
preserved. The adjacent `workspace.json` supplies a single folder workspace.
VS Code does not save every tool's original parameters or output. Import
results report `missingToolInputs` and `missingToolOutputs`; unsupported result
blocks contribute to `droppedToolResultBlocks`.

## Copilot CLI

`copilot-cli` reads the per-session event stream at
`~/.copilot/session-state/<session-id>/events.jsonl`; the path accepts the
`session-state` root, a single session directory or one `events.jsonl` file.
Set `COPILOT_HOME` when the `.copilot` root was moved. The stream replays user
prompts, assistant prose and reasoning, and tool calls paired with their
execution results by `toolCallId`. `session.compaction_complete` becomes a
native DSH compaction checkpoint (earlier turns stay in the log as log-only);
`fullHistory: true` keeps the full surface instead. Titles have no explicit
source, so the first user prompt is used. The event format is not under an
upstream stability contract: unknown event types, dropped attachments and
unpaired tool events are counted (`metaMessages`, `unknownEvents`,
`droppedAttachments`, `unannouncedToolCalls`, `orphanResults`), while unreadable
lines and suspected secrets are reported (`skippedLines`, `secrets`) — none of
them fails the whole session.

## Related

- [USAGE.md](USAGE.md) — user documentation for the whole plugin (tools, panel, commands, settings).
- [INTERCHANGE.md](INTERCHANGE.md) — the interchange v1 document format.
- [architecture.md](architecture.md) — design decisions behind the import pipeline.
