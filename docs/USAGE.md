# Usage Reference

> Full per-tool / per-command usage moved out of the README. See the README "Usage" section for a quick start.

## 🛠 Usage

> **First-migration step flow** (aligned with the [dsh-movein first-migration guide](https://github.com/sjh9714/dsh-movein/blob/main/docs/first-migration.zh.md), Chinese; that tool handles config, this plugin handles conversation history - use either standalone as needed):
> ① **Preview** - `scan_discover()` or the sidebar panel to inspect importable sessions and status badges; or pass `preview: true` to any `import_*` for a zero-side-effect dry run.
> ② **Import** - drop `preview` and import for real; verify the per-session `status` by source / workspace (duplicate-import behavior under "Incremental re-import" below).
> ③ **Health check & retract** - `doctor()` read-only check; `retract_import` to remove the registry record, or the panel History tab to delete plugin-created sessions (with confirmation).

> **Note:** imports persist to disk immediately. When the target generation equals the host's native generation (the panel's default), the new sessions appear in the session list immediately with no refresh; only an explicitly chosen non-native generation (e.g. producing a V3 log on a V4 host) is not the host's current in-memory shape and appears after a page refresh.

**Import — a single file or a directory.** Every `import_*` tool takes a `path`; directories are scanned recursively and each file / conversation becomes its own session:

```
import_claude({ path: "C:\Users\<you>\.claude\projects\<slug>\<sessionId>.jsonl" })
import_codex({ path: "C:\Users\<you>\.codex\sessions\2026\05\18\rollout-2026-05-18T21-14-16-xxxx.jsonl" })
import_chatgpt({ path: "C:\Users\<you>\Downloads\chatgpt-export\conversations.json" })
import_opencode({ path: "C:\Users\<you>\.local\share\opencode\opencode.db" })
import_kilocode({ path: "C:\Users\<you>\.local\share\kilo\kilo.db" })
import_teleagent({ path: "C:\Users\<you>\.local\share\TeleAgent\users\<account>\teleagent.db" })
import_trae({ path: "C:\Users\<you>\AppData\Roaming\Trae\User\workspaceStorage" })
import_vibe({ path: "C:\Users\<you>\.vibe\logs\session" })
import_local_jsonl({ path: "D:\downloads\session.jsonl" })
```

`import_local_jsonl({ path })` accepts any local `.jsonl` session file (or directory): it auto-detects `dsh` / `claude` / `codex` / `cursor` / `reasonix` / `pi` / `openclaw` / `hermes` / `vibe`, and the `format` parameter forces one parser when detection is wrong:

```
import_local_jsonl({ path: "D:\downloads\session.jsonl" })
import_local_jsonl({ path: "D:\downloads\unknown.jsonl", format: "claude" })
```

`import_chatgpt` / `import_opencode` / `import_kilocode` / `import_teleagent` / `import_trae` / `import_zcode` / `import_hermes` always return a batch result — one file / database holds all conversations, so each conversation becomes its own session in a single call. `import_opencode` recognises opencode's **two storage generations** and dispatches automatically: V1 (`session`/`message`/`part`) and V2 (opencode 2.x's `session_v2`/`session_message`) — both share the same `opencode.db`, where the V1 tables are only the V1→V2 migration source and survive it. Only the matched generation is read, so a session is never imported twice; a database with neither generation fails loudly instead of looking like "no sessions". `import_teleagent` also accepts the `users/` multi-account directory (it enumerates `<account>/teleagent.db` per account) or the `TeleAgent/` data root directly. `import_trae` accepts a Trae `User` root, `workspaceStorage`, `globalStorage`, or a direct `state.vscdb` path.

<details>
<summary><b>Import parameters & behaviors</b></summary>

- `preview: true` (alias `dryRun: true`) — run the import **read-only**: resolve, read and convert exactly like a real import, but persist nothing (zero side effects). Drop the flag and call again to actually import.
- **Images become host attachments** — images in the source no longer collapse to `[image]` text placeholders: the converter keeps the bytes in the intermediate structure, and before writing, the host attachment service (`ctx.attachments`) stores them as immutable objects while the session log keeps only an `attachmentId` reference (**base64 never reaches the log**). The result reports `images: <N>` (blocks stored as attachments) and `imagesDegraded: <M>` (blocks that had no bytes and stayed `[image]` placeholders: no attachment service on the host, unsupported media type (PNG/JPEG/WebP/GIF only), more than 500 images in one session, a source that only ships a reference such as Kimi's `blobref:`, or **a V3-generation target**). The export direction is symmetric: `export_claude` / `export_codex` read the bytes back into the target format and count `attachment-skipped` in `degradations` when they cannot. `storeImages: false` (or `DSH_IMPORT_STORE_IMAGES=0`) keeps placeholders only and writes nothing to the attachment store — images are the one import surface that can visibly grow host storage. **Deleting or retracting an imported session does not reclaim those image bytes**: the attachment service has no delete/GC API yet, so the objects stay in the store.
- **Durations and token usage import faithfully** — per-record timestamps in the source become session event times, so host statistics fold real per-step model time and tool time (model time = step start → assistant message, tool time = call → result; sessions whose source has no per-record timestamps simply show 0, nothing is fabricated). Provider-reported token usage (Claude Code's `message.usage`, opencode / kilocode / mimocode's `message.data.tokens`, Reasonix v2 row-level `usage`) is written to `assistant/message.data.usage` for the host token meter; a record whose input/output is not a non-negative integer is dropped whole so statistics are never poisoned. Per-source support is the `timestamps` / `usage` columns of the capability matrix in [INTERCHANGE.md](INTERCHANGE.md). **Time-to-first-token and output speed cannot be imported from any source**: external transcripts only store completed messages, never stream-chunk times (`stream` stays `[]`). The opencode export direction is symmetric: events carrying usage fill `tokens` with real numbers, otherwise 0 is written and counted as `usage-unknown`.
- `force: true` — create a **fresh full copy** under a new id (`import-<sessionId>-<n>`) even when the source was already imported; the old session is never modified (the full re-import policy is under "Re-importing the same source" below).
- `sessionId` (optional) — override the target DSH session id (default `import-<source sessionId>`).
- `import_chatgpt({ branch: 'all' })` — restore **every root→leaf branch** of the conversation DAG as its own session (the main thread stays the last-child chain; branch sessions carry a suffixed source id and a branch-marked title). Tool messages in the export are restored as real `tool/call` + `tool/result` (structured JSON arguments, FIFO pairing) instead of plain text.
- **Context compaction → native DSH compaction events** — a source tool's compaction (Claude Code's `compact_boundary` / `isCompactSummary` user record and legacy `summary` records, Codex's `compacted` envelopes, Pi's `compaction` entries, opencode's `compaction` parts plus summary message (V2: the `compaction` row, checkpoint body = `summary` + `recent`), Kimi's `context.apply_compaction`, Zed's `Compaction` message, Crush's `is_summary_message`, Continue's `conversationSummary`, zcode's `compaction` part with `compactBoundary`, Cline's `<id>.compaction.json` sidecar, Grok Build's `compaction_meta` hand-off summary, Mistral Vibe's `context_boundary = "compaction"`) is imported as a **native DSH compaction checkpoint**: the log keeps the **full history** (replayable, exportable) while one native `compaction/start → compaction/summary → checkpoint user/message → compaction/end` transaction is emitted per boundary. The model therefore sees "summary checkpoint + everything after the boundary", matching the source tool's real post-compaction context; the compacted-away conversation never reaches the model and is never eaten by budget trimming (shadowed turns are not counted, not cropped, not dropped). Several compactions produce several chained checkpoints. The result carries `compacted: true` and `compactions: <N>` (checkpoint count). **Re-importing a DSH session preserves the compaction transactions in its log** (`import_chat({ format: 'dsh' | 'dsh4' })` round-trips without losing checkpoints, normalizing the V3/V4 `plugin:compact` producer marker in both directions). When there is nothing shadowable before the boundary, or the source carries only a marker without summary text (Kimi's legacy wire), no checkpoint can be emitted — the summary falls back to its previous form (a reasoning block / visible text) or the case keeps the old window slice, and `compactionSummaryMissing: true` reports it explicitly instead of inventing summary text. `fullHistory: true` emits no checkpoints (the model sees everything); that flag is part of the args fingerprint, so changing it requires a re-import.
- `import_claude({ compacted: true })` — legacy flag kept as a compatible alias: Claude compaction is imported as native checkpoints **by default** as of this version, so the flag is no longer needed.
- `import_claude({ includeToolUseResult: true })` — additionally imports Claude's **structured tool result sidecar** (`toolUseResult`): edit patches (`structuredPatch` / `bashEditDiff`) become diff text, interactive questions/answers become Q&A pairs, and the remaining scalars (exit codes, durations, persisted output paths, …) become one compact JSON line — all appended after that tool result. Off by default (importing all of it grows the log noticeably); the flag is part of the argument fingerprint, so changing it requires `force`. The result reports `toolUseResultsMerged`, and whole-file snapshots (`originalFile`) plus anything already present in the visible body are never duplicated.
- `import_codex({ fullHistory: true })` — Codex compaction is imported as native checkpoints by default (the `compacted` envelope's hand-off summary becomes the checkpoint; the turn straddling the boundary is split into a log-only part and a visible part). `fullHistory: true` imports everything without checkpoints. Codex subagent rollouts are never standalone sessions and are always skipped with a reason.
- **Codex Desktop "import an external agent session" rollouts: flattened tool calls are restored as real tool messages** — when Codex Desktop's session import writes a foreign agent transcript (in practice Claude Code) into a rollout, the tool calls carry **no** `function_call` records: they are flattened into text envelopes inside assistant body text (`[external_agent_tool_call: Bash]…[/external_agent_tool_call]`, `[external_agent_tool_result]…[/external_agent_tool_result]`, sometimes mixed with prose in the same text block). Such rollouts previously imported as pure prose (a `#` comment line inside a python command rendered as a giant markdown heading; an Edit was indistinguishable from chatter). The converter now splits them by segment and restores `tool/call` + `tool/result` (results pair FIFO by order of appearance; the `: error` marker becomes `isError`). **Restoration invents nothing**: payload keys and content are copied from the envelope — Codex itself renamed `file_path` to `file` and **dropped** the Edit / Write bodies (only the file path survives), and the plugin does not fabricate them. The result reports `externalAgent: { calls, results, orphanResults, malformed }`; `orphanResults` (results with no call, kept verbatim as text) and `malformed` (unclosed envelope / unrecognised payload) are degradations. For an Edit's `old_string` / `new_string`, import the **original Claude Code transcript**, not this derived rollout.
- `import_hermes({ lineage: 'tail' })` — import only **leaf chain tails** (sessions that are not any other session's parent); compaction-fork parent sessions are skipped and annotated.
- `import_chat({ format: 'reasonix', path: '<sessions directory>' })` — directory imports default to `lineageMode: 'canonical'`. A recovery ancestor is collapsed only when modern sidecar metadata places both files in the same logical topic, an unambiguous `parent_id` chain proves ancestry, and its complete semantic message sequence is a proper prefix of a longer descendant. Malformed inputs, WAL-backed checkpoints, exact duplicates, missing lineage links, and divergent leaves are retained. This does not choose one active leaf from Reasonix's catalog; genuine branches remain separate. Use `lineageMode: 'physical'` for one session per JSONL.
- **Archive / delete / workspace-removal → auto-ignored (no re-import)** — Archiving a session writes an ignore tombstone; unarchiving clears it. Retract/purge writes a **permanent** tombstone, so rescans and `/import-all` skip that source. DSH's archive still keeps the session and its id, but an ignored source is no longer treated as re-importable. Removing a workspace ignores the imported sessions it held at that moment and records a workspace ignore — a **new session** in that workspace, or unarchiving one of its sessions, restores the workspace (earlier tombstones stay). Inspect and lift with `/ignores` and `/unignore <sessionId|sourcePath|all>`; `force: true` imports once despite a tombstone without clearing it.
- **Re-importing the same source** — imported history is never rewritten. Three cases, by whether the DSH session is still exactly what the import wrote:
  - the file is unchanged → skipped (`already-imported`) without re-reading;
  - the file grew **and** you have not chatted in the DSH session → only its **new turns** are appended (`appended`);
  - the file grew **but** you did chat in that DSH session → a **new copy** is created (`reimported.reason: 'continued-in-dsh'`) instead of appending into your conversation; both sessions are kept. Truncated files are reported and skipped (`sourceShrunk` / `storedShrunk`), and records written before the baseline existed get one conservative copy (`reason: 'baseline-missing'`). `force: true` always makes a fresh full copy under a new id.

```
import_claude({ path: "C:\Users\<you>\.claude\projects\<slug>\<sessionId>.jsonl" })
// unchanged → "already-imported" · grew + untouched → "appended" (new turns only)
// grew + you chatted in DSH → new copy, old session untouched
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

Scope note: `import_agents` is a lightweight asset mover only - it does not cover hooks, permission rules or settings; for full config migration see [dsh-movein](https://github.com/sjh9714/dsh-movein) (complementary to this plugin; the combined flow is not jointly validated).

### scan_discover — read-only session discovery

`scan_discover` scans the known data roots of every supported format (including Cline's modern sessions and legacy VS Code globalStorage tasks, the Reasonix desktop app and Claude-3p roots on Windows) and returns a structured session index (title, project, cwd, path, import status, and git branch/dirty when the source directory is a git repo) so you can preview before a batch import. Set `CLINE_LEGACY_GLOBAL_STORAGE_DIR` when VS Code uses a non-standard globalStorage location, and `GROK_HOME` to override Grok Build's default `~/.grok` root. Zero side effects:

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

> **Ghost sessions after retract ** — the DSH host has no delete/forget API: after `retract_import` and manual artifact deletion, the session id may still occupy the host's in-memory index (it stays visible in the session list until dsh restarts, and re-importing the same source used to fail with `session "…" already exists in this backend`). This is now self-healed: re-import detects the stale entry (still listed but log unreadable, or `create` rejecting the id) and **automatically mints a suffixed new session id** (`import-<id>-1`) with a clear `staleGhost: { previous, current }` report instead of failing; `retract_import`'s `manualDelete` guidance also notes that the ghost only fully disappears after a dsh restart.

### export_chat — DSH → Claude / Codex / Kimi / opencode (matrix export)

`export_chat({ format: "claude", sessionId })` serializes an existing DSH session (imported or native) into a Claude Code JSONL transcript, ready for `--resume`. It is written to `<outputDir>/<slug>/<uuid>.jsonl` (default `~/.claude/projects`), with a fresh UUID v4 file name — an existing file is never overwritten. `format: "codex"` / `format: "kimi"` write Codex rollout JSONL / Kimi `wire.jsonl`; `format: "opencode"` writes the JSON document that `opencode import <file>` accepts (session info + messages + parts, ids prefixed `ses` / `msg` / `prt` as opencode's decoder requires). Those three default to `~/.dsh/exports`, or `path: …` to pick a target — completing the DSH↔Claude↔Codex↔Kimi↔opencode matrix (the import edges already exist). Every export lists its **lossy items** in a `degradations` field (orphan tool results, skipped injections, skipped attachments, and for opencode the `usage-unknown` item: opencode requires `cost`/`tokens` while DSH session logs carry no usage counters, so zeros are written and reported) — nothing is silently dropped:

```
export_chat({ format: "claude", sessionId: "import-019f5f27-…" })
export_chat({ format: "codex", sessionId: "…", dryRun: true })
export_chat({ format: "kimi", sessionId: "…", outputDir: "D:\backup\kimi" })
export_chat({ format: "opencode", sessionId: "…" })   // → ~/.dsh/exports/<id>.opencode.json, then: opencode import <file>
```

### export_bundle / restore_bundle — portable interchange bundle

`export_bundle({ sessionId })` writes a **`.dshbundle.json`** — an event-level lossless interchange bundle (protocol: [docs/INTERCHANGE.md](INTERCHANGE.md)) with double SHA-256 fingerprints (session-level + file-level) and machine-independent landing info (`originalCwd` + `landingHint`). `restore_bundle({ path })` verifies the fingerprints (corruption is reported loudly, never restored silently), then imports the session through the same idempotent state machine — repeat restores skip, `force: true` makes a copy, directory mode restores every `.dshbundle.json`:

```
export_bundle({ sessionId: "import-019f5f27-…" })                    // → ~/.dsh/exports/<id>.dshbundle.json
restore_bundle({ path: "D:\backup\sess.dshbundle.json" })            // machine A → machine B
restore_bundle({ path: "D:\backup\bundle-dir", preview: true })      // dry-run
```

**Cross-machine:** export on machine A, copy the bundle, restore on machine B. When the original `cwd` does not exist there, the session falls back to the bundle file's directory (bundle-file directory grouping) and the result reports `cwdAvailable: false` / `groupedTo` / `restoreNote` — never silent.

### verify_session — read-only structural audit

`verify_session({ sessionId })` runs a read-only structural check on any DSH session: seq continuity, event-type whitelist, `surfaceOp` on surface events, `sourceEventSeqs` pointing at real `tool/call`s, turn/step balance, and tool-call↔result pairing. Problems are located one-by-one (kind + seq + message), and per-kind `repairHints` tell you what to do (re-import with `force`, close a half-open turn, or accept a mid-transcript source boundary):

```
verify_session({ sessionId: "import-019f5f27-…" })
```

> An imported log starts with an **empty `system/message` head** — right after the first `step/start`, before any other surface event. The host's v3→v4 migration requires the first surface event to be a `system/message` (the *protected head*); without it, the host's own system message on the next turn makes the migrator refuse the whole log (`system/message requires a protected first surface head`), and sessions seeded from it fail the same way. The environment-change note is injected after the first `step/start` (`turn/start → step/start → head → note → the turn's prompt`); a legacy log that puts a surface event before the first step is refused by the host's v2→v3 migration (`surface before first step cannot acquire a system head`). `verify_session` names both shapes — `system-head-missing` and `surface-before-first-step` — and a `force: true` re-import rewrites them; the head must be the first surface event, so an existing log cannot be repaired in place.

### doctor — read-only migration health check

`doctor()` runs a read-only health check after migration: imports registry readability, whether every imported session still exists in `sessionPersistence`, whether `import_agents` skills were persisted, whether `workspaceRegistry` is available, and whether the sessions tree holds stray `import-*` directories the host can no longer read back (they still occupy a session id, so re-import can only create a suffixed copy). It never writes, imports, syncs, or deletes anything:

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

`export-md` renders a DSH session log as readable Markdown (session header, title, user/assistant text, thinking, tool calls and results). The sessions root follows the host's `DSH_HOME` (`%APPDATA%\dsh-desktop\harness` for the desktop app; `~/.dsh` when unset, e.g. the standalone CLI). `doctor` reads `$DSH_HOME/dsh-chat-import/imports.json` and the local `sessions` tree for a lightweight health summary.

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

### Browser panel — discover & import from the sidebar

The dsh web UI opens the import window from one entry in the left sidebar: the **导入会话** footer button, styled to match the sidebar's **设置** entry and carrying the plugin logo as its icon (a `sidebar.footer.action` slot entry sitting in the same footer row as whatever else registers there. When a same-slot entry is a full-width one — a plugin badge, a cost card — the row switches to wrapping so each entry takes a full-width row of its own; when only narrower entries compete for the row and the label no longer fits, the button shrinks to a 36×36 icon button with the label kept in its tooltip / `aria-label`. It is never truncated or overlapped either way). The plugin requires **dsh ≥ 0.1.5-rc.1** (raised in `peerDependencies`): the window **docks into the official right sidebar** — the plugin registers an **导入会话** tab type there (a guide page capsule with icon / title / one-line description), and the footer button opens the same tab (`sidebarRight.openTab('chat-import')`), so the conversation stays visible in the middle. There is no fallback chain: older harnesses (no official right sidebar) are no longer supported on the client. The window lists discovered sessions **grouped by workspace folder** (each source's `cwd`/project when available, otherwise an "(未分组)" bucket), with a source filter — "全部来源" scans every format's default data root, a single source restricts the view — and each row shows only the source tool mark, its title and a relative timestamp (context tokens / branch / import status live in the hover tooltip). **Clicking anywhere on the row toggles selection** (Enter / Space once the row has keyboard focus); the leading mark only names the source and shows selection state (a tinted overlay plus a check when selected), so you no longer have to aim at a 22px square. The per-row import button is the one exception: it imports without also toggling the row. The per-row import button stays hidden until you hover (or keyboard-focus) the row, where it replaces the timestamp. A search box filters by title / workspace / path, and the list is **paginated** (500 / 2000 / **All** rows per page, 500 by default; only the rows inside the viewport are mounted, so the tier size costs nothing, and "All" simply drops pagination), with selections kept across pages for bulk operations. Scan progress and pagination share one status line under the list: it reports the running count while scanning and the page/total once done. with selections kept across pages for bulk operations.

Each row supports **single import**, and the checkboxes enable **multi-select import** ("导入所选 (N)"): the panel calls the same host import pipeline as the `import_*` tools, so the re-import policy (skip when unchanged / append when untouched / new copy when you already chatted in the DSH session) / `force` / context-budget semantics are identical, and the list refreshes with the new statuses after importing. A multi-session source (e.g. `conversations.json`, an opencode/zcode/hermes DB) is imported whole — opencode/zcode restrict to the selected `sessionId`s.

The top row reads **From <source> Import to <target>**: the left dropdown picks the source, the right one picks where the conversation lands (brand marks appear inside the popover only — the trigger is plain text; source rows draw that tool's official lockup, mark plus wordmark, from @lobehub/icons, and sources without one fall back to the white-card mark plus text). The search box filters by title / workspace / path, and the toolbar ends with **two filter controls** — **Filter: path** (workspace directory, with a searchable dropdown whose rows carry the absolute path) and **Filter: time** (24 hours / 7 days / 30 days / any time; a four-item menu with no search box). Both stay textual and simply wrap on a narrow panel; the selected count shows only on the primary button ("Import selected (N)"). Under the list, one status bar carries the scan progress and the paging controls: prev/next are bare icons, the page number is a "Page x / y" control that opens a **page grid** above the bar for one-click jumps, and the whole group is hidden when there is only one page (fewer rows than the tier — 500 by default); below 500 rows the per-page selector is hidden too, leaving just the total. The right-hand selector offers 500 / 2000 / All per page.

| Choice | What happens |
| --- | --- |
| **DSH (V3 session format)** | Creates a resumable DSH session whose log is written as a **V3 generation** (`session.v3.jsonl.zstd`): the header's `version` and the event shape are produced together, so a V4 host genuinely writes a V3 log. |
| **DSH (V4 session format)** | Same, written as a **V4 generation**. The **default follows the detected host version** (a V4 host selects this one). |
| Claude Code | The transcript is converted and written into `~/.claude/projects/<slug>/<uuid>.jsonl`; Claude Code reads that directory directly (`claude --resume`). |
| Codex / Kimi Code | Written as a Codex rollout JSONL / Kimi `wire.jsonl` under `~/.dsh/exports/` for you to move into that tool's sessions directory. |
| opencode | Written as opencode JSON under `~/.dsh/exports/`, to be imported with `opencode import <file>`. |

When **both the source and the target are DSH and the generations differ** (V3 ↔ V4), the bottom bar grows a second primary button — **"Import selected and archive old sessions (N)"**: the selected sessions are imported in the target generation, and each matching **source session** is archived in the host once its import succeeded (the finishing touch of a migration). Archiving is an irreversible hide (the host exposes no unarchive API), so **only entries whose import succeeded are archived** — skipped / failed ones stay exactly as they were, and the panel names the count ("N old session(s) left unarchived").

Non-DSH targets **transfer instead of importing**: the plugin runs the source through the same converters, serializes the result into the target's own format (the same serializers `export_chat` uses), and writes it with `createIfAbsent` (never overwriting). The intermediate DSH session created for that conversion is **retracted right after the export succeeds**, so no copy is left behind in DSH; a session that already existed before (already-imported / appended) is never deleted — it is exported and reported as kept. If retraction fails (session running, artifact locked) the reason is reported in the result instead of being swallowed. The result line shows the written path plus the next step for that tool, and per-item failures plus the usual `degradations` list.

> **Transfer and images**: when the target tool can carry images (Claude Code / Codex), the images are first stored through the normal path into the intermediate session's attachment store and read back into the target format during export — but that session is then retracted, and the host attachment service has no delete API, so those image bytes **stay in the store and cannot be reclaimed**. The result reports that count as `attachmentsOrphaned: <N>`. When the target cannot express images at all (Kimi's wire only accepts its own blob refs, opencode's file parts need external files), the plugin **does not store** them (images degrade to placeholders and are counted), avoiding data that can never be reclaimed.

> The data comes from the same read-only discovery as `scan_discover` (30s TTL cache + persistent mtime bookmarks); the panel itself never writes anything except the imports you trigger.

> **Where an imported session lands** (see docs/architecture.md D16): the host only accepts an attach whose session cwd equals the workspace path, so the plugin decides the landing point *before* creating the session — a cwd that already is a workspace is reused; a cwd that is a local directory gets a workspace created for it (the session sits next to native sessions, and that new group appears in the sidebar); a cwd that is absent locally or unavailable (including the home directory, which the sandbox ACL refuses) lands in the **dedicated import workspace** `$DSH_HOME/dsh-chat-import-workspace` (the session cwd is rewritten to it). `workspaceMode` accepts `auto` (default, the rules above) / `per-project` (never rewrite cwd; “Ungrouped” is preferred) / `dedicated` (always the dedicated workspace, `workspaceDir` overrides the directory). The outcome is always reported in the import result: `workspace` / `workspaceCreated` (the group that appeared in the sidebar) and `ungrouped` + `ungroupedReason` (the session was imported but sits at the very bottom of the sidebar under “Ungrouped” — scroll to the end of the list if you cannot find it). Empty workspaces that older versions created for source transcript directories can be removed with the **Clean empty workspaces** button on the History tab (it only removes registrations with zero members; directories and session logs are kept).

> **A landing toast appears when an import finishes** (the official `shell.overlay` Toast: top-center, auto-dismissed after about six seconds): "Import done → <workspace path> (workspace created); N left ungrouped". The panel's result bar still carries the full counts — this one exists so that you know **where it landed** even after switching tabs or collapsing the right sidebar; transfers (importing into something other than DSH) toast the written file path instead. **Sessions skipped by the idempotency check are reported by the same toast**: "Skipped N conversation(s) that are unchanged or cannot be appended safely" plus a **Re-import as a new session** button (i.e. `force`, minting a new session; actionable toasts hold for 15 seconds). The panel's old in-panel bottom banner is gone — it is this toast now. On host versions without the official `Toast` component the plugin falls back to a self-drawn banner in the same place, action button included (see docs/architecture.md D17).

### Import from file — any local file and the long tail

The discovery list covers the built-in sources only. When the file in hand comes from somewhere else (a web-app export, your own script, an unsupported tool's storage), use **Import from file**:

- **Panel**: the collapsible "Import from file" area at the top of the import tab. Three equivalent ways in — drop files / directories onto the dashed zone (or click it to pick files; when the browser only holds `File` objects the chunked **upload channel** stages them under `$DSH_HOME/dsh-chat-import/uploads/`), type a local path (the desktop host reads it directly, no size limit), or press **Browse…** (a native OS dialog when the host provides one, otherwise an in-panel directory listing).
- **Command**: `/import auto <path>` (`local-jsonl` is the same); the tool surface is `import_chat({ format: "local-jsonl", path })`, with `parseFormat` to force a parser.

**Detection (three levels)**: explicit `format` > **content marker** (interchange document / `.dshbundle` backup, sniffed from the file head only) > path hints ordering the parsers that are then tried one by one. The winning format and the criterion (`detectedFormat` / `detectedBy`) are shown in the preview.

**Preview first**: choosing a path runs a read-only preview (zero side effects) — detected format, title, turn / message / tool-call counts, cwd, timestamps and degradation counts. A directory expands into a checkable list of entries (recognised ones checked by default); "Import selected" imports them one by one.

**A failed detection is not a dead end**: the preview card lists **every candidate parser and its reason for failing**, plus three exits — retry with a forced format, copy the failure summary, or convert the file into an [interchange v1 document](INTERCHANGE.md#5-generic-文档作为导入格式) (the `"interchange": "dsh-chat-import"` marker, which any tool or script can produce) and import that. A file with 0 turns or no recognisable format disables the import button — a blank, unopenable session is never produced.

**Portable bundles**: a `.dshbundle.json` is recognised as a backup and imported through `restore_bundle` (two-layer fingerprint check, restored as a continuable session) instead of being treated as a plain transcript.

**Upload staging**: chunked uploads are idempotent per (sha256, size) — a page refresh or a dropped connection resumes from the received byte count, and re-uploading the same file transfers nothing. A file only becomes importable after the whole-file fingerprint checks out. Limits: 256 MiB per file, 2 GiB of staging, incomplete uploads reclaimed after 24 hours. Imported staging files are **kept** (the re-import semantics key on them); unreferenced ones can be removed from the panel's staging-cleanup action.

### `/import` slash command & `/resume-*` handoff

The plugin also registers a **`/import <source> <path>`** slash command (available where the dsh `commands` service is mounted): type it directly in a session to import without a model round-trip — the same pipeline and the same idempotent / incremental / `force` / context-budget semantics as the `import_*` tools. `<source>` accepts the short name (`claude`, `codex`, …), the client source id (`claude-code`), or the full tool name (`import_claude`); `<path>` is a transcript file or a session directory / data root (single-file import vs. directory batch as usual).

**`/import-all [source] [path]`** scans the default data roots (or one source / explicit path) and imports every not-yet-imported session in one shot — same pipeline: skip when unchanged, append when untouched, new copy when you already chatted in the DSH session; archived and ignored sources skipped, failures reported individually.

**`/ignores`** lists the ignore table (auto-populated by archiving, deleting, and workspace removal); **`/ignore <sessionId|sourcePath>`** ignores one source manually; **`/unignore <sessionId|sourcePath|all>`** lifts entries (`all` clears the table). Ignored sources are skipped by rescans, `/import-all`, and the automatic sync; `force: true` imports once despite a tombstone without clearing it.

**`/attach-workspaces`** re-attaches already-imported sessions to workspaces from the imports registry — useful for fixing early imports that landed in “未分组” / “Ungrouped”. It is idempotent and safe to re-run. Grouping is decided by **each session header's own cwd** (the host only accepts an attach whose cwd equals the workspace path): a cwd that already is a workspace attaches directly; a cwd that is a local directory gets a workspace created for it first; a cwd that is not on this machine (cross-machine import) or otherwise unusable is **reported as ungrouped** — a written session's cwd cannot be rewritten, so use `force: true` to re-import a copy that groups under the new landing point. Options: `--mode auto|dedicated|per-project` and `--dir <path>` (for `dedicated`).

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

### Settings page (Session Import)

The Settings → Session Import section exposes two toggles, read/written through the panel's fenced route (independent of the settingsScope allowlist):

- **Import system prompt (default on)** — keep the source session's system/developer prompt as a "context injection"; turn it off to keep only the environment-change note.
- **Explicitly inject this plugin's tools into the conversation context (default on)** — turn it off to stop providing this plugin's 12 tools to the agent in-conversation (saving about 5k of context); importing, exporting, discovery, retraction, and two-way sync remain available through the "Import Sessions" panel and slash commands.
