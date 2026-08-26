# Usage Reference

> Full per-tool / per-command usage moved out of the README. See the README "Usage" section for a quick start.

## 🛠 Usage

> **Note:** imports persist to disk immediately, but the DSH session list does not auto-refresh — refresh the page (or the session list) after importing to see the new sessions.

**Import — a single file or a directory.** Every `import_*` tool takes a `path`; directories are scanned recursively and each file / conversation becomes its own session:

```
import_claude({ path: "C:\Users\<you>\.claude\projects\<slug>\<sessionId>.jsonl" })
import_codex({ path: "C:\Users\<you>\.codex\sessions\2026\05\18\rollout-2026-05-18T21-14-16-xxxx.jsonl" })
import_chatgpt({ path: "C:\Users\<you>\Downloads\chatgpt-export\conversations.json" })
import_opencode({ path: "C:\Users\<you>\.local\share\opencode\opencode.db" })
import_local_jsonl({ path: "D:\downloads\session.jsonl" })
```

`import_local_jsonl({ path })` accepts any local `.jsonl` session file (or directory): it auto-detects `dsh` / `claude` / `codex` / `cursor` / `reasonix` / `pi` / `openclaw` / `hermes`, and the `format` parameter forces one parser when detection is wrong:

```
import_local_jsonl({ path: "D:\downloads\session.jsonl" })
import_local_jsonl({ path: "D:\downloads\unknown.jsonl", format: "claude" })
```

`import_chatgpt` / `import_opencode` / `import_zcode` / `import_hermes` always return a batch result — one file / database holds all conversations, so each conversation becomes its own session in a single call.

<details>
<summary><b>Import parameters & behaviors</b></summary>

- `preview: true` (alias `dryRun: true`) — run the import **read-only**: resolve, read and convert exactly like a real import, but persist nothing (zero side effects). Drop the flag and call again to actually import.
- `force: true` — create a **fresh full copy** under a new id (`import-<sessionId>-<n>`) even when the source was already imported; the old session is never modified.
- `sessionId` (optional) — override the target DSH session id (default `import-<source sessionId>`).
- `import_chatgpt({ branch: 'all' })` — restore **every root→leaf branch** of the conversation DAG as its own session (the main thread stays the last-child chain; branch sessions carry a suffixed source id and a branch-marked title). Tool messages in the export are restored as real `tool/call` + `tool/result` (structured JSON arguments, FIFO pairing) instead of plain text.
- `import_claude({ compacted: true })` — import only the **last compression summary + tail** of a long session (summary restored as a leading `reasoning` block; title from the summary record). Without a summary record the flag has no effect.
- `import_hermes({ lineage: 'tail' })` — import only **leaf chain tails** (sessions that are not any other session's parent); compaction-fork parent sessions are skipped and annotated.
- **Archived sessions are re-importable** — DSH's archive hides a session from the sidebar but keeps it (and its id) in persistence, so the panel and `scan_discover` now report an archived target as **已归档 / Archived** with a re-import button. Importing again creates a fresh copy under a new id (`import-<sessionId>-<n>`, same minting as `force`) without touching the archived session; the same applies per-session inside multi-session sources (chatgpt / opencode / zcode / hermes DBs).
- **Incremental re-import** — re-importing the same source never rewrites imported history. Unchanged files are skipped (`already-imported`) without re-reading; grown files append only their **new turns** to the same session (`appended`); truncated files are detected and reported (`sourceShrunk`) — use `force: true` for a complete fresh copy:

```
import_claude({ path: "C:\Users\<you>\.claude\projects\<slug>\<sessionId>.jsonl" })
// unchanged → "already-imported" · grew → "appended" (new turns only)
```

</details>

Every import result reports its `status` and any anomalies — malformed lines, suspected secrets, per-source drops — nothing is silently swallowed.

### import_agents — convert pi/opencode/Claude/Codex agents, prompts, skills & config into DSH skills

`import_agents` converts custom agents, mode prompts, skills, instructions and config references from **pi** (`~/.pi/agent/{agents,prompts}/*.md`), **opencode** (`~/.config/opencode/{agents,skill}/*.md`), **Claude** (`~/.claude/memory/<group>/*.md`, `~/.claude/skills/<skill>/SKILL.md`, or an explicit project-root `CLAUDE.md` via `claudeProjectRoot`) and **Codex** (`~/.codex/skills/<skill>/SKILL.md`, `~/.codex/instructions.md`, `~/.codex/AGENTS.md`, `~/.codex/config.toml`) into **persistent DSH skill assets** — `$DSH_AGENTS_HOME/skills/<name>/SKILL.md` (`$DSH_AGENTS_HOME` defaults to `~/.agents`), so they become discoverable skills in any session. This complements the runtime-only Claude bridge (`context-bridge`, off by default): that one injects Claude memory/CLAUDE.md/skills transiently; this one persists them (plus pi/opencode/Codex assets).

By default it **dry-runs** (returns the write/complete/skip plan with zero side effects); pass `apply: true` to actually write:

```
import_agents()                    // dry-run: plan only
import_agents({ apply: true })     // write $DSH_AGENTS_HOME/skills/<name>/SKILL.md
import_agents({ codexRoot: "~/.codex", apply: true })  // include Codex assets explicitly
```

Semantics: same-name conflicts across sources get a `-<source>` suffix (e.g. `-pi` / `-opencode` / `-codex`); identical content is skipped (idempotent); sources already carrying `kind: dsh`/`kind: skill` frontmatter are not re-imported; a bundle directory that lacks `SKILL.md` is completed in place (preserving existing `scripts/` etc.); nested YAML (e.g. `permission:`) is preserved.

### scan_discover — read-only session discovery

`scan_discover` scans the known data roots of all 17 formats (including the Reasonix desktop app and Claude-3p roots on Windows) and returns a structured session index (title, project, cwd, path, import status, and git branch/dirty when the source directory is a git repo) so you can preview before a batch import. Zero side effects:

```
scan_discover()
scan_discover({ path: "~/.codex/sessions", format: "codex", query: "import" })
```

### list_imported_sessions & retract_import — identify & retract

`list_imported_sessions()` enumerates every DSH session this plugin has imported; `retract_import({ sessionId })` (or `sourcePath`) removes its registry record and returns manual-deletion guidance. **Identification and guided manual deletion only — nothing is ever deleted**:

```
list_imported_sessions()
retract_import({ sessionId: "import-019f5f27-…" })
```

> **Ghost sessions after retract (#22)** — the DSH host has no delete/forget API: after `retract_import` and manual artifact deletion, the session id may still occupy the host's in-memory index (it stays visible in the session list until dsh restarts, and re-importing the same source used to fail with `session "…" already exists in this backend`). This is now self-healed: re-import detects the stale entry (still listed but log unreadable, or `create` rejecting the id) and **automatically mints a suffixed new session id** (`import-<id>-1`) with a clear `staleGhost: { previous, current }` report instead of failing; `retract_import`'s `manualDelete` guidance also notes that the ghost only fully disappears after a dsh restart.

### export_chat — DSH → Claude / Codex / Kimi (matrix export)

`export_chat({ format: "claude", sessionId })` serializes an existing DSH session (imported or native) into a Claude Code JSONL transcript, ready for `--resume`. It is written to `<outputDir>/<slug>/<uuid>.jsonl` (default `~/.claude/projects`), with a fresh UUID v4 file name — an existing file is never overwritten. `format: "codex"` and `format: "kimi"` write Codex rollout JSONL and Kimi `wire.jsonl` respectively (default `~/.dsh/exports`, or `path: …` to pick a target) — completing the DSH↔Claude↔Codex↔Kimi matrix (the import edges already exist). Every export lists its **lossy items** in a `degradations` field (orphan tool results, skipped injections, skipped attachments) — nothing is silently dropped:

```
export_chat({ format: "claude", sessionId: "import-019f5f27-…" })
export_chat({ format: "codex", sessionId: "…", dryRun: true })
export_chat({ format: "kimi", sessionId: "…", outputDir: "D:\backup\kimi" })
```

### export_bundle / restore_bundle — portable interchange bundle

`export_bundle({ sessionId })` writes a **`.dshbundle.json`** — an event-level lossless interchange bundle (protocol: [docs/INTERCHANGE.md](docs/INTERCHANGE.md)) with double SHA-256 fingerprints (session-level + file-level) and machine-independent landing info (`originalCwd` + `landingHint`). `restore_bundle({ path })` verifies the fingerprints (corruption is reported loudly, never restored silently), then imports the session through the same idempotent state machine — repeat restores skip, `force: true` makes a copy, directory mode restores every `.dshbundle.json`:

```
export_bundle({ sessionId: "import-019f5f27-…" })                    // → ~/.dsh/exports/<id>.dshbundle.json
restore_bundle({ path: "D:\backup\sess.dshbundle.json" })            // machine A → machine B
restore_bundle({ path: "D:\backup\bundle-dir", preview: true })      // dry-run
```

**Cross-machine (REQ-62):** export on machine A, copy the bundle, restore on machine B. When the original `cwd` does not exist there, the session falls back to the bundle file's directory (REQ-39-lite grouping) and the result reports `cwdAvailable: false` / `groupedTo` / `restoreNote` — never silent.

### verify_session — read-only structural audit

`verify_session({ sessionId })` runs a read-only structural check on any DSH session: seq continuity, event-type whitelist, `surfaceOp` on surface events, `sourceEventSeqs` pointing at real `tool/call`s, turn/step balance, and tool-call↔result pairing. Problems are located one-by-one (kind + seq + message), and per-kind `repairHints` tell you what to do (re-import with `force`, close a half-open turn, or accept a mid-transcript source boundary):

```
verify_session({ sessionId: "import-019f5f27-…" })
```

### doctor — read-only migration health check

`doctor()` runs a read-only health check after migration: imports registry readability, whether every imported session still exists in `sessionPersistence`, whether `import_agents` skills were persisted, and whether `workspaceRegistry` is available. It never writes, imports, syncs, or deletes anything:

```
doctor()
```

It returns `{ ok, checks, issues, totals }` — useful after a large batch import or before/after moving DSH data between machines.

### standalone CLI — export-md / doctor

The npm package also ships a small standalone CLI (no DSH host required):

```
npx dsh-chat-import export-md ~/.dsh/sessions/<workspace>/<session>/session.jsonl
npx dsh-chat-import export-md <session-dir> --out session.md
npx dsh-chat-import doctor
```

`export-md` renders a DSH session log as readable Markdown (session header, title, user/assistant text, thinking, tool calls and results). `doctor` reads `$DSH_HOME/dsh-chat-import/imports.json` and the local `sessions` tree for a lightweight health summary.

### import_mcp — MCP mirror plan

`import_mcp` reads MCP servers from **Claude** (`~/.claude.json` / `.mcp.json`) and **Codex** (`~/.codex/config.toml`) and generates a reviewable **DSH MCP client YAML snippet**. By default it dry-runs; `apply: true` writes the snippet to `$DSH_HOME/dsh-chat-import/mcp-mirror.cordis.yml` (or `outPath`) — it never edits your profile automatically:

```
import_mcp()                                  // dry-run: list servers + YAML snippet
import_mcp({ apply: true })                   // write generated snippet
/mcp-status                                   // list discovered servers
```

### import_settings — settings/config translation suggestions

`import_settings` reads **Claude `~/.claude/settings.json`** and **Codex `~/.codex/config.toml`** and returns migration suggestions for DSH: model binding, permission rules, hooks, environment variables, and model provider. It is read-only and never applies anything:

```
import_settings()                             // list suggestions
/settings-suggest                             // same via slash command
```

### sync_to_claude — incremental write-back

`sync_to_claude({ sessionId })` appends a session's **new complete turns** back to its Claude Code file — `target: "source"` by default (the import source) or `"copy"` (the last `export_chat` `format: "claude"` copy). Guards report an externally modified or shrunken file instead of overwriting it; `force: true` re-anchors past external edits (the overridden guard is still reported):

```
sync_to_claude({ sessionId: "import-019f5f27-…" })
sync_to_claude({ sessionId: "…", target: "copy", dryRun: true })
```

### Browser panel — discover & import from the sidebar

The dsh web sidebar shows an **导入会话** button in its footer, styled to match the sidebar's **设置** entry and carrying the plugin logo as its icon (a `sidebar.footer.action` slot entry: while the official Cordis plugin badge occupies the whole footer row the button renders as a fixed overlay just above the footer so it can never be squeezed out; when the badge is hidden or absent it sits in the footer row itself, right above 设置). It opens a panel listing discovered sessions **grouped by workspace folder** (each source's `cwd`/project when available, otherwise an "(未分组)" bucket), with a source filter — "全部来源" scans every format's default data root, a single source restricts the view — and a per-session import-status badge (已导入 / 部分 / 未导入). A search box filters by title / workspace / path, and the list is **paginated** (50 per page) with selections kept across pages for bulk operations. The panel closes on `Escape`.

Each row supports **single import**, and the checkboxes enable **multi-select import** ("导入所选 (N)"): the panel calls the same host import pipeline as the `import_*` tools, so idempotent skip / incremental append / `force` / context-budget semantics are identical, and the list refreshes with the new statuses after importing. A multi-session source (e.g. `conversations.json`, an opencode/zcode/hermes DB) is imported whole — opencode/zcode restrict to the selected `sessionId`s.

> The data comes from the same read-only discovery as `scan_discover` (30s TTL cache + persistent mtime bookmarks); the panel itself never writes anything except the imports you trigger.

### `/import` slash command & `/resume-*` handoff

The plugin also registers a **`/import <source> <path>`** slash command (available where the dsh `commands` service is mounted): type it directly in a session to import without a model round-trip — the same pipeline and the same idempotent / incremental / `force` / context-budget semantics as the `import_*` tools. `<source>` accepts the short name (`claude`, `codex`, …), the client source id (`claude-code`), or the full tool name (`import_claude`); `<path>` is a transcript file or a session directory / data root (single-file import vs. directory batch as usual).

**`/import-all [source] [path]`** scans the default data roots (or one source / explicit path) and imports every not-yet-imported session in one shot — same pipeline, idempotent skip / incremental append, archived sessions skipped, failures reported individually.

**`/attach-workspaces`** re-attaches already-imported sessions to their cwd-matched workspaces from the imports registry — useful for fixing early imports that landed in “未分组” or whose workspace attach previously failed. It is idempotent and safe to re-run. Options: `--mode auto|dedicated|per-project` and `--dir <path>` (for `dedicated`).

**`/doctor`** runs the same read-only health check as the `doctor` tool and prints a concise report.

**`/mcp-status`** lists MCP servers discovered from Claude/Codex configs (read-only); use `import_mcp` to generate a DSH MCP client snippet.

**`/settings-suggest`** lists Claude/Codex config translation suggestions (read-only); use `import_settings` for the structured tool output.

**`/import-reset`** clears the scan cache (in-memory TTL + persistent `scan-cache.json`) when discovery results look stale; imported sessions are untouched.

**`/resume-claude [id:<sessionId> | keyword]`** and **`/resume-codex`** generate a **handoff summary** from an external transcript (goal + last request, involved files/artifacts, last tool call, exact stop point, safest next step) and inject it into the current session so you can continue the work in DSH — treating the transcript as untrusted static history (no system/developer/thinking content is reproduced; old tool output is flagged as stale evidence). Leave the argument empty for the most recent session, use `id:<sessionId>` for an exact one, or a title keyword — **multiple matches list candidates without guessing**:

```
/resume-claude id:282095ab-1111-4222-8333-444455556666
/resume-codex 修复登录
```

### Session-start context enhancements

Two optional hooks run when a DSH session starts (the host `agent/session-start` event), both agent-scoped and never touching your transcripts:

- **Migration hint (default on)** — when the session's workspace has discoverable external history (already-imported or importable), a one-line `PromptContext` is injected telling the model how to continue (`/import <source> <path>` or the sidebar panel). Per-project memory shows the hint only once per workspace; set `DSH_IMPORT_SESSION_HINT=0` to disable.
- **Claude context bridge (default off)** — set `DSH_IMPORT_CONTEXT_BRIDGE=1` to bridge Claude Code context assets into the session: `~/.claude/memory/*.md` (grouped `feedback` > `project` > `reference` > `user`, 8 KiB cap, re-read via mtime cache), the project-root `CLAUDE.md` **and global `~/.claude/CLAUDE.md`**, and `~/.claude/skills/*/SKILL.md` (registered as `claude-<name>` skills on this agent only).
