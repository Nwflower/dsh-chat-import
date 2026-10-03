# Changelog

All notable changes to `dsh-chat-import` are documented here, newest first.

## [Unreleased]

[中文](#cn-unreleased) | [English](#en-unreleased)

<h3 id="cn-unreleased">新增功能</h3>

- **从文件导入**：面板导入页新增「从文件导入」区，任意本地文件或目录都能进导入管线——拖放 / 文件选择（浏览器只有 `File` 对象时分片上传到暂存）、本机路径直读、「浏览…」（宿主有原生目录选择器时弹系统对话框，否则在面板内列目录）。阶段固定为**识别 → 只读预览 → 导入**：预览卡片给出识别格式与判据、标题、轮 / 消息 / 工具调用计数、cwd、时间与降级计数；目录展开为可勾选条目，「导入所选」逐条导入。命令面同步为 `/import auto <路径>`（`local-jsonl` 同义），工具面 `import_chat({ format: "local-jsonl" })` 的 dry-run 结果现在带 `detectedFormat` / `detectedBy` / `failures`。
- **三级探测与失败出路**：显式格式 > 内容标记（interchange 文档 / `.dshbundle` 便携包，只扫文件头）> 路径特征排序后逐格式试跑。识别失败不再是一句「未识别」——预览里摊开**每个候选格式的失败原因**，并给三个出口：换格式重试、复制失败摘要、或把文件转成 interchange v1 文档后重新导入。识别不出或 0 轮的文件禁用导入，绝不产出侧栏看不见的空壳会话。
- **interchange v1 文档成为一等导入格式**（`parseFormat: "generic"`，契约见 docs/INTERCHANGE.md §5）：带 `"interchange": "dsh-chat-import"` 与 `version: 1` 的 turns 文档可直接导入，是长尾工具与脚本产出的落点。版本不符整体拒绝；未知内容块、拿不到字节的图片、畸形轮步、孤儿工具结果、非法用量全部计数上报。`.dshbundle.json` 在文件导入里被识别为备份包并转 `restore_bundle`（双层指纹校验），不会被当成普通转录。
- **上传通道**：`POST /api-import/upload/init|chunk|complete` 三步，按 (sha256, size) 幂等——刷新或断线后从已收字节续传，同一文件重复上传零重传；整文件指纹校验通过才产出可导入路径。配额单文件 256MiB、暂存 2GiB、未完成 24 小时回收；文件名 sanitize 且落点固定在 `$DSH_HOME/dsh-chat-import/uploads/`。导入后的暂存件保留（重导语义以它为源键），维护路由可清理未被 registry 引用的件。
- **路径浏览消费宿主能力**：`POST /api-import/browse` 优先使用宿主的 `ctx.directoryPicker`（native 系统对话框 / browse 清单），服务缺席时退回 `ctx.fs.listDir` 自绘清单，旧宿主上浏览能力不消失。

<h3 id="en-unreleased">New Features</h3>

- **Import from file**: the import tab gains an "Import from file" area — any local file or directory can enter the import pipeline by drag & drop / file picker (chunked upload into staging when the browser only holds a `File` object), a directly typed local path, or **Browse…** (a native OS dialog when the host provides one, otherwise an in-panel directory listing). The flow is fixed: **detect → read-only preview → import**. The preview card shows the detected format and criterion, title, turn / message / tool-call counts, cwd, timestamps and degradation counts; a directory expands into checkable entries and "Import selected" imports them one by one. The command surface mirrors it as `/import auto <path>` (`local-jsonl` is the same), and the tool surface's dry-run now returns `detectedFormat` / `detectedBy` / `failures` for `import_chat({ format: "local-jsonl" })`.
- **Three-level detection with a way out**: explicit format > content marker (interchange document / `.dshbundle` backup, sniffed from the file head only) > path hints ordering the parsers that are then tried one by one. A failed detection is no longer a single "unrecognized" line — the preview lists **every candidate parser's reason for failing** and offers three exits: retry with a forced format, copy the failure summary, or convert the file into an interchange v1 document and import that. Files with no detection or 0 turns disable the import button; a blank session that never shows up in the sidebar is never produced.
- **The interchange v1 document is now a first-class import format** (`parseFormat: "generic"`, contract in docs/INTERCHANGE.md §5): a turns document carrying `"interchange": "dsh-chat-import"` and `version: 1` imports directly, which is the landing spot for long-tail tools and scripted conversions. A mismatched version is rejected wholesale; unknown content blocks, images without usable bytes, malformed turns or steps, orphan tool results and invalid usage are all counted and reported. A `.dshbundle.json` is recognised as a backup archive during file import and routed to `restore_bundle` (two-layer fingerprint check) instead of being treated as a plain transcript.
- **Upload channel**: `POST /api-import/upload/init|chunk|complete` — idempotent per (sha256, size), so a refresh or a dropped connection resumes from the received byte count and re-uploading the same file transfers nothing; a path only becomes importable after the whole-file fingerprint checks out. Limits: 256 MiB per file, 2 GiB of staging, incomplete uploads reclaimed after 24 hours; names are sanitized and staging stays under `$DSH_HOME/dsh-chat-import/uploads/`. Imported staging files are kept (the re-import semantics key on them) and a maintenance route removes the ones no registry entry references.
- **Path browsing consumes host capability**: `POST /api-import/browse` prefers the host's `ctx.directoryPicker` (native OS dialog / browse listing) and falls back to a self-drawn `ctx.fs.listDir` listing when the service is absent, so browsing does not disappear on older hosts.

## [0.24.0] - 2026-10-03

[中文](#cn-0.24.0) | [English](#en-0.24.0)

<h3 id="cn-0.24.0">新增功能</h3>

- **新增 Trae Work 会话导入**：新来源 `trae`（`import_trae` / `import_chat({ format: 'trae' })`、面板来源列表、`scan_discover`）。只读打开 Trae 的 VS Code 风格 `state.vscdb`，从 `ItemTable` 的已知会话键（主键 `memento/icube-ai-agent-storage`，另有旧版/变体回退键）提取会话并按会话 id 去重；用户与助手消息成为可继续的 DSH 会话，智能体的计划步骤（思考 / 工具 / 参数 / 结果）落成可读文本，只有工具行的会话不产生空回合。`path` 接受 Trae 的 `User` 根、`workspaceStorage`、`globalStorage` 或单个 `state.vscdb`；默认发现根覆盖 Trae / Trae CN / TRAE SOLO / TRAE SOLO CN 在 Windows、macOS、Linux 上的 `User` 目录。目录模式只展开这两种已知布局、不递归扫描用户目录：从没开过 Trae 对话的工作区库静默跳过，整个目录都没有会话时明确报错，有会话条目却一条都认不出的库计为失败（疑似存储格式变化）。重导沿用一库多会话的增量语义。

<h3 id="cn-0.24.0">其他变更</h3>

- SQLite 库类来源（opencode / mimocode / teleagent / kilocode / zcode / goose / zed / crush / trae）的 dry-run 预览与各自的导入编排同住 `lib/sources/<src>.mjs`，行为不变。
- `test/panel-toast.test.mjs` 读入面板 bundle 后先归一 CRLF：Windows 上 `core.autocrlf=true` 检出时该用例此前恒失败，连带 pre-push 钩子拦下推送。

<h3 id="en-0.24.0">New Features</h3>

- **Trae Work session import**: new source `trae` (`import_trae` / `import_chat({ format: 'trae' })`, the panel source list, and `scan_discover`). Trae's VS Code-style `state.vscdb` is opened read-only; sessions are taken from known `ItemTable` keys (primary `memento/icube-ai-agent-storage`, plus fallback keys for older and variant builds) and de-duplicated by session id. User and assistant messages become a resumable DSH session, the agent's plan steps (thought / tool / arguments / result) are rendered as readable text, and tool-only sessions produce no empty turns. `path` accepts a Trae `User` root, `workspaceStorage`, `globalStorage`, or a single `state.vscdb`; default discovery covers the `User` directories of Trae / Trae CN / TRAE SOLO / TRAE SOLO CN on Windows, macOS and Linux. Directory mode expands only those two known layouts and never walks the user's files: workspace databases that never held a Trae chat are skipped silently, a directory with no sessions at all fails loudly, and a database whose session entries cannot be recognised counts as a failure (a likely storage-format change). Re-imports follow the usual per-database incremental semantics.

<h3 id="en-0.24.0">Chores</h3>

- Dry-run previews for the SQLite-backed sources (opencode / mimocode / teleagent / kilocode / zcode / goose / zed / crush / trae) now live next to their import orchestration in `lib/sources/<src>.mjs`; behavior is unchanged.
- `test/panel-toast.test.mjs` normalizes CRLF after reading the panel bundle: on Windows with `core.autocrlf=true` the case always failed and blocked the pre-push hook.

**Full Changelog**: [v0.23.2...v0.24.0](https://github.com/Nwflower/dsh-chat-import/compare/v0.23.2...v0.24.0)

## [0.23.2] - 2026-10-01

[中文](#cn-0.23.2) | [English](#en-0.23.2)

<h3 id="cn-0.23.2">新增功能</h3>

- **新增 opencode 2.x 的会话导入**：`import_opencode` / `import_chat({ format: 'opencode' })` 现在同时覆盖 opencode 的两个存储世代——V1（`session`/`message`/`part`）与 V2（opencode 2.x 的 `session_v2`/`session_message`，与 V1 共用同一个 `opencode.db`）。读取层按库里的表自动分派：两代产出同一种中间结构，导入、预览与面板发现全部复用；同一会话不会被导入两次，两代都没有的库明确报错，而不是显示成「没有会话」。V2 的压缩边界取最近一条 `completed` 的 `compaction` 行（与源工具自己仍让模型看见的内容起点一致），检查点正文为 `summary` + `recent`；未完成的压缩正文按普通内容保留，不丢。实测（本机 opencode 2.0.21 迁移后的库）：4 个会话在 V1/V2 两侧读出的会话数、消息数与工具调用数一致，压缩会话正确产出 1 个原生压缩检查点。

<h3 id="en-0.23.2">New Features</h3>

- **opencode 2.x session import**: `import_opencode` / `import_chat({ format: 'opencode' })` now cover both of opencode's storage generations — V1 (`session`/`message`/`part`) and V2 (opencode 2.x's `session_v2`/`session_message`, which shares the same `opencode.db`). The reader dispatches on the tables present; both generations produce the same intermediate shape, so import, preview and panel discovery are shared. A session is never imported twice, and a database with neither generation fails loudly instead of looking like "no sessions". V2's compaction boundary is the latest `completed` `compaction` row — the same point the source tool itself keeps visible to the model — with the checkpoint body taken from `summary` + `recent`; unfinished compactions keep their text as ordinary content. Measured on a migrated opencode 2.0.21 database: the same four sessions read from both generations agree on session, message and tool-call counts, and the compacted session produces exactly one native compaction checkpoint.

**Full Changelog**: [v0.23.1...v0.23.2](https://github.com/Nwflower/dsh-chat-import/compare/v0.23.1...v0.23.2)

## [0.23.1] - 2026-10-01

[中文](#cn-0.23.1) | [English](#en-0.23.1)

<h3 id="cn-0.23.1">问题修复</h3>

- **Claude Code 自动压缩后的续跑内容不再丢失**：源工具压缩后会直接接着做原任务、之后可能再没有人类提问，而转换器在压缩摘要处把「当前轮」置空，紧跟其后的 assistant 记录因无轮可挂被整段丢弃——实测一份 18499 行、压缩 6 次的转录丢掉 **2632 / 5962 条** assistant 记录（最后一次压缩后约 2.5 小时的工作全部消失）。现在这些记录归入一个空 prompt 的压缩边界轮，检查点就是该轮的 user 侧消息，与会话正好停在压缩点时的既有处理一致。
- **会话事件时间改为源记录时间戳**：事件 `time` 取最近一个已知的源时间且不倒退（来源没有时间戳时保持 `meta.createdAt` 不变），轮、步、工具结果与压缩检查点的时间都经 IR 传递。此前全部事件都等于 `meta.createdAt`，会话列表的「最后活动时间」因此一直停在创建时间。
- **带上下文压缩的会话能在 0.2.x 宿主上打开**：替换标记的拼写属于**宿主 runtime 世代**、与目标 header 代次无关——`dsh-session` ≥ 0.2.0 的 runtime 与 V3/V4 两代 released codec 都只认 `{ op:'replace', startSeq, endSeq }`，≤ 0.1.x 只认 `{ start, end }`。此前一律写旧拼写，V4 宿主以 `replacement start must be a non-negative safe integer` 拒载整份日志；现在按宿主原生代次双向归一（V4 源日志回灌旧宿主会改回旧拼写），面板显式选 V3 落点同样跟随宿主代次。
- **V4 压缩检查点改用宿主的生产者 kind `compact-checkpoint`**：`shapeMessageSources` 逐条对齐宿主 `producerKind()`（改名表 + 同名生产者表 + system 角色特例）。此前写成 `plugin:compact`，宿主虽能载入，但 `isCompactCheckpointSource` 认不出这是压缩检查点——会话引用投影会直接丢掉摘要，trajectory 视图也不把它折叠成压缩节点。
- **`verify_session` 不再对自己刚导入的 V4 压缩会话误报**：`compaction-checkpoint-source` / `compaction-checkpoint-op` 两项此前只认 V3 形状（`{kind:'plugin',plugin:'compact'}` + `{op,start,end}`），读回 V4 日志（生产者 kind + `startSeq/endSeq`）必然报错；现在 source 与替换端点都按 V3/V4 双形状校验，口径与 `toolResultOf` 一致。
- **DSH → DSH 重导不再把压缩检查点退化成追加**：`convertDshJsonl` 的替换范围重映射只读 `surfaceOp.start/end`，V4 源日志的 `startSeq/endSeq` 找不到端点 → 退化成 `append`（摘要变成普通 user 消息、模型看到全量历史）。现在两种拼写都识别，重排时保持源拼写。

<h3 id="cn-0.23.1">其他变更</h3>

- 本版是 0.22.2 之后第一个发布到 npm 的版本：0.23.0 只在仓库里归版、没有单独发布，它的改动随本版一起到达，内容见下方 0.23.0 节。
- CI：headless 冒烟的 mock LLM 补上 `dsh-llm-deepseek` ≥ 0.1.7 的 Messages wire（`POST {base}/v1/messages` 的 SSE 事件流，事件形状照抄宿主自己的 `tests/mock-server`）——此前只有 OpenAI 兼容的 `/chat/completions`，冒烟自适配器换代起恒红（`DeepSeek Messages request failed (404)`）；`package-lock.json` 里 `@deepseek-ai/dsh-tools` 的 peer 范围与 `package.json` 同步，锁文件漂移护栏恢复绿。

<h3 id="en-0.23.1">Bug Fixes</h3>

- **Claude Code auto-compaction no longer drops the work that continues after it**: after compacting, the source tool keeps working on the same task and may never ask another question, while the converter cleared the "current turn" at the summary record — every assistant record that followed had no turn to attach to and was dropped wholesale. Measured on one 18,499-line transcript with 6 compactions: **2,632 of 5,962** assistant records lost, including roughly 2.5 hours of work after the last compaction. They now form a zero-prompt compaction-boundary turn whose checkpoint is that turn's user-side message, matching the existing handling when a session stops exactly at the boundary.
- **Event times now come from the source records**: an event's `time` follows the latest known source timestamp and never goes backwards (a source without timestamps keeps `meta.createdAt`). Turn, step, tool-result and compaction times are carried through the IR. Every event used to carry `meta.createdAt`, so a session list's "last activity" was stuck at its creation time.
- **Sessions with context compaction open on 0.2.x hosts**: the replacement marker's spelling belongs to the **host runtime generation**, not the target header generation — the `dsh-session` ≥ 0.2.0 runtime and both released V3/V4 codecs accept only `{ op:'replace', startSeq, endSeq }`, while ≤ 0.1.x accepts only `{ start, end }`. Writing the old spelling made a V4 host reject the whole log with `replacement start must be a non-negative safe integer`; the plugin now normalizes in both directions from the host's native generation (a V4 source log written back to an old host gets the old spelling), and an explicit V3 landing follows the host generation too.
- **V4 compaction checkpoints use the host's producer kind `compact-checkpoint`**: `shapeMessageSources` now mirrors the host's `producerKind()` (rename table, same-name table, and the role-sensitive system-prompt case). The old `plugin:compact` was loadable but `isCompactCheckpointSource` did not recognise it, so session-reference projections dropped the summary and the trajectory view did not fold the checkpoint.
- **`verify_session` no longer false-alarms on the plugin's own freshly imported V4 sessions**: `compaction-checkpoint-source` / `compaction-checkpoint-op` only accepted the V3 shapes (`{kind:'plugin',plugin:'compact'}` plus `{op,start,end}`), so a V4 log (producer kind plus `startSeq/endSeq`) always reported a problem; source and replacement endpoints are now read in either shape, the same policy as `toolResultOf`.
- **DSH → DSH re-imports no longer degrade a compaction checkpoint to an append**: `convertDshJsonl`'s replacement-range remap read only `surfaceOp.start/end`, so a V4 source log's `startSeq/endSeq` had no endpoints to map and fell back to `append` (the summary became a plain user message and the model saw the full history). Both spellings are recognised now, and the source spelling is preserved through the remap.

<h3 id="en-0.23.1">Chores</h3>

- This is the first release on npm since 0.22.2: 0.23.0 was versioned in the repository but never published on its own, so its changes arrive with this release — see the 0.23.0 section below.
- CI: the headless smoke's mock LLM now serves the Messages wire of `dsh-llm-deepseek` ≥ 0.1.7 (`POST {base}/v1/messages` SSE, event shapes copied from the host's own `tests/mock-server`); it previously had only the OpenAI-compatible `/chat/completions`, so the smoke had been red since the adapter moved (`DeepSeek Messages request failed (404)`). `package-lock.json` now matches `package.json` for the `@deepseek-ai/dsh-tools` peer range, restoring the lockfile-drift guard.

**Full Changelog**: [v0.22.2...v0.23.1](https://github.com/Nwflower/dsh-chat-import/compare/v0.22.2...v0.23.1)

## [0.23.0] - 2026-09-28

[中文](#cn-0.23.0) | [English](#en-0.23.0)

<h3 id="cn-0.23.0">新增功能</h3>

- 面板「导入历史」新增「**清理空工作区**」按钮（`POST /api-import/workspaces/cleanup`）：移除本插件建过、已无成员的导入工作区登记，幂等；对应用户在侧栏里点不动的空分组。
- **导入完成弹落点提示**：面板发起的导入成功后，用官方 Toast（`shell.overlay`，顶部居中，约 6 秒）报出「导入完成 → <工作区路径>（本次新建该工作区）；另有 N 个未归组」；转投弹写出文件路径。切走 tab / 收起右栏也不会漏掉落点。**面板内原先那条底部黄条（跳过提示 + 「忽略警告」）也并入同一条 Toast**：官方 `Toast` 支持 `actions`，于是变成「已跳过 N 个…」+「重新导入为新会话」按钮（= force 另铸新会话，带动作的横幅停留 15 秒）。宿主没有官方 `Toast` 组件的旧版本上自动退化为同位置、同样带动作按钮的自绘横幅（`require` 包在 `try/catch` 里，见 docs/architecture.md D17）。
- `/attach-workspaces` 改为按**会话自己的 cwd** 重新规划归组，不再回退源目录；cwd 不可用的会话如实报告未归组（header 是 append-only、事后改不了 cwd，要换落点用 `force: true` 重导）。
- **Codex Desktop「导入外部 agent 会话」的 rollout：展平的工具调用还原为真正的工具消息**。Codex Desktop 把外部 agent（实测 Claude Code）的 transcript 写成 rollout 时，工具调用**没有** `function_call` 记录，而是展平成 assistant 正文里的文本信封（`[external_agent_tool_call: Bash]…[/external_agent_tool_call]`、`[external_agent_tool_result[: error]]…`，信封可与正文混排在同一个文本块里）。这类 rollout 此前导入后工具调用全是散文——python 命令里的 `# 注释` 行被 markdown 渲染成巨型标题、Edit 与普通发言无法区分；现在按行扫描切段并还原为 `tool/call` + `tool/result`（结果按出现顺序 FIFO 配对、`: error` 还原为 `isError`）。**还原不虚构**：载荷键名与内容照抄信封——Codex 自己把 `file_path` 写成 `file`、并丢掉 Edit/Write 的正文，本插件不补；未闭合信封 / 认不出的载荷留在正文并计入 `malformed`，找不到调用的结果保留原文并计入 `orphanResults`。导入结果新增 `externalAgent: { calls, results, orphanResults, malformed }`（工具渲染同步）；存量旧形状由 `verify_session` 新增的 `flattened-tool-envelope` 点名（源未变时普通重导会被幂等闸跳过，需 `force: true`）。

<h3 id="cn-0.23.0">问题修复</h3>

- **修「导入成功但对话列表里找不到」**：宿主只接受「会话 cwd 与工作区路径相等」的挂接（`@deepseek-ai/dsh-workspace` 的 `attachSession` 读 header 校验，不匹配即抛错），而插件原先在创建会话之后才归组、失败时回退到**源 transcript 目录**——那条路在宿主上必然被拒，于是每次都在侧栏留下一个**空工作区**、会话仍停在最底部的「未分组」，异常还只写进 `console.error`（本机 `$DSH_HOME/logs` 为空，用户看不到）。现在归组**前置到创建之前**：目标工作区路径先写进 header cwd，创建后再挂接。本机实测同一批三条导入中，两条 cwd = 主目录的会话各留一个空工作区（创建时间与导入时间差 16–22ms），第三条 cwd 命中已有工作区的照常归组——现已一致。
- **落点不再按 transcript 的一面之词造目录**：cwd 是否是可用目录交给宿主 `create` 判定（realpath + isDirectory），插件只为自己拥有的专用导入工作区 `mkdir -p`。cwd 不在本机（跨机器导入）/ 拿不到（含主目录，沙箱 ACL 不允许）时落到专用导入工作区 `$DSH_HOME/dsh-chat-import-workspace` 并改写 cwd，会话因此一定能被看到；源 transcript 目录不再被建成工作区。
- **`workspaceMode` 三态真正生效**：`auto`（默认，按上述规则）/ `per-project`（不改写 cwd，宁可「未分组」也不伪造 cwd）/ `dedicated`（一律落专用工作区，`workspaceDir` 可覆盖目录）。此前 `dedicated` 与源目录回退在宿主上都是失效路径。
- **归组结果进公开结果**：新增 `workspace` / `workspaceMode` / `workspaceCreated`（侧栏多出的分组）与 `ungrouped` + `ungroupedReason`（会话已导入但停在「未分组」）；面板摘要、批量汇总、工具渲染与结果 schema 同步。
- **`restore_bundle` 不再谎报落点**：原先自己算出 `groupedTo` 并声称「回退归组到 bundle 目录」，现改为照抄真实落点；`restoreNote` 给出原 cwd、落点或未归组原因。
- **空工作区清理真正生效**：宿主现只有 `workspaceRegistry.delete(id)`（实体无 `remove`），旧写法恒不命中；改为 `delete(id)` 并覆盖旧实现为源 transcript 目录误建的空工作区，且只删**成员为 0** 的工作区登记（目录与会话日志保留）。

<h3 id="en-0.23.0">New Features</h3>

- The panel's History tab gains a **Clean empty workspaces** button (`POST /api-import/workspaces/cleanup`): it removes import-workspace registrations this plugin created that have no members, and is idempotent — the empty groups in the sidebar that cannot be clicked away.
- **A landing toast now appears when an import finishes**: after a panel-triggered import the official Toast (`shell.overlay`, top-center, ~6 s) reports "Import done → &lt;workspace path&gt; (workspace created); N left ungrouped"; transfers toast the written file path. Switching tabs or collapsing the right sidebar no longer hides where it landed. **The panel's old bottom banner (skip notice + "ignore warning") moved into the same toast**: the official `Toast` accepts `actions`, so it is now "Skipped N …" plus a **Re-import as a new session** button (`force`, minting a new session) on a 15-second hold. On host versions without the official `Toast` component the plugin degrades to a self-drawn banner in the same place, action button included (the `require` is wrapped in `try/catch`; see docs/architecture.md D17).
- `/attach-workspaces` now re-plans grouping from **each session's own cwd** instead of falling back to the source directory; sessions whose cwd is unusable are honestly reported as ungrouped (the header is append-only, so its cwd cannot be changed after the fact — re-import with `force: true` to get a copy under a new landing point).
- **Codex Desktop "import an external agent session" rollouts: flattened tool calls are restored as real tool messages.** When Codex Desktop writes a foreign agent transcript (in practice Claude Code) into a rollout, the tool calls carry **no** `function_call` records — they are flattened into text envelopes inside assistant body text (`[external_agent_tool_call: Bash]…[/external_agent_tool_call]`, `[external_agent_tool_result[: error]]…`, sometimes mixed with prose in the same text block). Such rollouts used to import as pure prose: a `#` comment line inside a python command rendered as a giant markdown heading, and an Edit was indistinguishable from chatter. The converter now scans line by line, splits by segment and restores `tool/call` + `tool/result` (results pair FIFO by order of appearance; `: error` becomes `isError`). **Restoration invents nothing**: payload keys and content are copied from the envelope — Codex itself renamed `file_path` to `file` and dropped the Edit/Write bodies, and the plugin does not fabricate them; unclosed envelopes and unrecognised payloads stay in the body and count as `malformed`, results with no call are kept verbatim and counted as `orphanResults`. The import result gains `externalAgent: { calls, results, orphanResults, malformed }` (wired into tool rendering), and `verify_session` names the stale shape via its new `flattened-tool-envelope` check (an unchanged source is skipped by the idempotence gate, so re-import with `force: true`).

<h3 id="en-0.23.0">Bug Fixes</h3>

- **Fixed "the import succeeded but the conversation is not in the list"**: the host only accepts an attach whose session cwd equals the workspace path (`attachSession` in `@deepseek-ai/dsh-workspace` validates the stored header and throws on a mismatch), while the plugin used to group *after* creating the session and fell back to the **source transcript directory** on failure — a path the host always rejects. The net effect was a fresh **empty workspace** per import plus a session stuck at the very bottom under "Ungrouped", with the exception only reaching `console.error` (this machine's `$DSH_HOME/logs` is empty, so nothing was visible). Grouping now happens **before creation**: the target workspace path is written into the header cwd first, and the session is attached after it exists. Measured on this machine: of three imports in one batch, the two whose cwd was the home directory each left an empty workspace behind (created 16–22 ms after the import), while the third, whose cwd matched an existing workspace, grouped correctly — all three now behave the same.
- **No more directories invented from a transcript's word**: whether a cwd is a usable directory is decided by the host's own `create` (realpath + isDirectory); the plugin only `mkdir -p`s the dedicated import workspace it owns. A cwd that is absent locally (cross-machine import) or unavailable (including the home directory, which the sandbox ACL refuses) lands in the dedicated import workspace `$DSH_HOME/dsh-chat-import-workspace` with the cwd rewritten, so the session is always findable; source transcript directories are no longer turned into workspaces.
- **`workspaceMode` now really has three behaviours**: `auto` (default, rules above) / `per-project` (never rewrite cwd — "Ungrouped" is preferred over a fabricated cwd) / `dedicated` (always the dedicated workspace, `workspaceDir` overrides it). Previously both `dedicated` and the source-directory fallback were dead paths on the host.
- **The grouping outcome is part of the public result**: `workspace` / `workspaceMode` / `workspaceCreated` (the group that appeared in the sidebar) and `ungrouped` + `ungroupedReason` (imported but sitting under "Ungrouped"), wired through the panel summary, batch totals, tool rendering and output schemas.
- **`restore_bundle` no longer reports a landing point that never happened**: it used to derive `groupedTo` itself and claim a fallback "grouped to the bundle directory"; it now reports the real landing point, with `restoreNote` naming the original cwd plus the landing point or the reason it stayed ungrouped.
- **Empty-workspace cleanup actually works**: the host now only exposes `workspaceRegistry.delete(id)` (entities have no `remove`), so the old call never matched; it now deletes by id and also covers the empty workspaces older versions created for source transcript directories — and only workspaces with **zero members** (directories and session logs are kept).

**Full Changelog**: [v0.22.2...v0.23.0](https://github.com/Nwflower/dsh-chat-import/compare/v0.22.2...v0.23.0)

## [0.22.2] - 2026-09-28

[中文](#cn-0.22.2) | [English](#en-0.22.2)

<h3 id="cn-0.22.2">其他变更</h3>

- 本版是 0.19.7 之后第一个发布到 npm 的版本：0.20.0、0.21.0、0.22.0、0.22.1 只在仓库里归版、没有单独发布，它们的改动都随本版一起到达，内容见下方各节。
- README 的导入面板截图换成 DSH Claude Style 的 DeepSeek 配色，工作区与会话均为示例数据；「使用」一节注明用 DSH Claude Style 主题时，「导入会话」按钮收在左下角的账号菜单里。

<h3 id="en-0.22.2">Chores</h3>

- This is the first release on npm since 0.19.7: 0.20.0, 0.21.0, 0.22.0 and 0.22.1 were versioned in the repository but never published on their own, so all of their changes arrive with this release — see the sections below.
- The README's import panel screenshots now use the DeepSeek palette of DSH Claude Style, with sample workspaces and sessions; the Usage section notes that under the DSH Claude Style theme the "Import sessions" button sits in the account menu at the bottom left.

**Full Changelog**: [v0.22.1...v0.22.2](https://github.com/Nwflower/dsh-chat-import/compare/v0.22.1...v0.22.2)

## [0.22.1] - 2026-09-28

[中文](#cn-0.22.1) | [English](#en-0.22.1)

<h3 id="cn-0.22.1">问题修复</h3>

- **与 DSH 0.2.0-rc.1 兼容**：`peerDependencies` 里 `@deepseek-ai/dsh-tools` 原先写死 `^0.1.0-rc.6`（等价于 `<0.2.0`），而宿主按「每个 `@deepseek-ai/dsh*` peer 范围都要匹配运行时版本」的规则检查（见 dsh-app-boot 文档），于是插件在 DSH 0.2.0-rc.1 上被标为不兼容、拒绝导入。范围放宽为 `>=0.1.0-rc.6 <0.3.0`：0.1.x 与 0.2.x 两条 rc 线都覆盖，0.3 起仍会被拦下（未验证的 API 代次不静默放行）。
- 已验证新版宿主 API 面：从宿主 `app.asar` 读取 `@deepseek-ai/dsh-tools@0.2.0-rc.1`，我们仅有的两处依赖（`defineTool` 与 `TOOL_RUNTIME_SCHEDULER`）都在——`TOOL_RUNTIME_SCHEDULER` 仍是 `Symbol('@deepseek-ai/dsh-tools.scheduler')`，`defineTool` 与 0.1.0-rc.8 逐行同构（参数、选项名、校验一致）。加载时的 ABI 守卫报错文案同步改为新范围。

<h3 id="en-0.22.1">Bug Fixes</h3>

- **Compatible with DSH 0.2.0-rc.1**: the `peerDependencies` range for `@deepseek-ai/dsh-tools` was pinned to `^0.1.0-rc.6` (i.e. `<0.2.0`), while the host enforces that every `@deepseek-ai/dsh*` peer range matches its runtime version (see the dsh-app-boot docs) — so the plugin was flagged incompatible on DSH 0.2.0-rc.1 and refused import. The range is now `>=0.1.0-rc.6 <0.3.0`, covering both the 0.1.x and 0.2.x rc lines while still rejecting 0.3+ (unverified API generations are not silently allowed through).
- Verified the new host API surface by reading `@deepseek-ai/dsh-tools@0.2.0-rc.1` out of the host's `app.asar`: both of our only two imports are present — `TOOL_RUNTIME_SCHEDULER` is still `Symbol('@deepseek-ai/dsh-tools.scheduler')`, and `defineTool` is line-for-line identical to 0.1.0-rc.8 (same parameters, option names and validation). The load-time ABI guard message now names the new range.

**Full Changelog**: [v0.22.0...v0.22.1](https://github.com/Nwflower/dsh-chat-import/compare/v0.22.0...v0.22.1)

## [0.22.0] - 2026-09-28

[中文](#cn-0.22.0) | [English](#en-0.22.0)

<h3 id="cn-0.22.0">新增功能</h3>

- **Claude 富结果 sidecar 可选并入**：`import_claude({ includeToolUseResult: true })` 把模型看不到的 `toolUseResult` 渲染成文本追加在工具结果之后——编辑补丁（`structuredPatch` / `bashEditDiff`）→ diff 文本，交互问答（`questions` / `answers`）→ 问答对，其余标量（退出码、耗时、持久化输出路径等）→ 一行紧凑 JSON。默认关（本机 4001 条样本里 1260 条带原文补丁、1115 条带 old/new 字符串，全量并入会明显撑大日志）；体积键（`originalFile` / `content` / `stdout` / `stderr`）与可见正文里已有的内容不重复搬，单值超 2000 字符跳过。开关进参数指纹（换值须 `force` 重导），结果里 `toolUseResultsMerged` 上报实际并入条数。

<h3 id="cn-0.22.0">问题修复</h3>

- **V3 落点不再写出旧宿主读不出的图片块**：附件引用是当前世代（V4）宿主的概念，此前只要宿主提供附件服务就一律落地，「导入到 → DSH（V3）」或续写一条 V3 会话时会产出 V3 宿主打不开的图片块。现在目标代次低于 4 时图片（含已是引用的块）一律降级为 `[image]` 占位并计入 `imagesDegraded`；目标代次只取权威来源（显式覆盖的代次 / 目标会话 header 自己的代次），不用「推断出来的宿主代次」——宿主没有版本信号时推断值会退化成转换层默认的 3。
- **转投（导入到 Claude Code / Codex / Kimi / opencode）的图片口径**：目标能承载图片（Claude / Codex）时按常规路径落附件、导出时读回字节写进目标格式，并在结果里用 `attachmentsOrphaned` 点名「中间会话已撤回、这些字节留在附件存储里无法回收」的张数；目标导不出图片（Kimi 的 wire 只认自有 blob、opencode 的 file part 另需外部文件）时不再落字节，免得白白留下无法回收的数据。
- **导出解引用的能力判定修正**：原本用 `attachmentService()`（要求 `saveImage`）判断能否读附件，而读面只需要 `readImage`——「只能读」的宿主面会被误判成读不了，把有字节的图片降级为占位。改为直接调 `readAttachmentBytes`。
- **面板补上图片计数显示**：`lib/panel.mjs` 已把 `images` / `imagesDegraded` 传回客户端，但客户端结果行不读它们（空载荷）；现补两档文案（中英）。
- **校验器新增 `inline-image-data` 检查**：`validateSessionEvents` 此前不看内容块，「图片块带内联 data（落地步骤被绕过）」这类回归没有任何守卫能发现；现在递归进 tool-result 内层 content（V3 wrapper / V4 一级形状都覆盖）点名。
- **dsh 源同一 turn 多条带图 user/message 时 `promptBlocks` 被覆盖**：改为累积（文本仍取第一条，IR 语义不变）。dsh 源的事件是原样透传，落盘产物不受影响，这是 IR 层（预算估算 / 再合成）的正确性修复。

<h3 id="cn-0.22.0">其他变更</h3>

- 清理 grokbuild 早返回分支里语义已废的 `images: 0` 死字段；`docs/architecture.md` 新增 D15（富结果 sidecar）并补齐 D14 的「V3 目标」「附件不可回收」两条代价；USAGE 双语补「转投与图片」与 `includeToolUseResult` 说明。

<h3 id="en-0.22.0">New Features</h3>

- **Optional Claude tool-result sidecar import**: `import_claude({ includeToolUseResult: true })` renders the model-invisible `toolUseResult` into text appended after the tool result — edit patches (`structuredPatch` / `bashEditDiff`) become diff text, interactive questions/answers become Q&A pairs, and the remaining scalars (exit codes, durations, persisted output paths, …) become one compact JSON line. Off by default (among 4001 sampled records, 1260 carry a source patch and 1115 carry old/new strings; importing all of it grows the log noticeably); bulk keys (`originalFile` / `content` / `stdout` / `stderr`) and anything already present in the visible body are never duplicated, and single values longer than 2000 characters are skipped. The flag is part of the argument fingerprint (changing it requires `force`), and the result reports `toolUseResultsMerged`.

<h3 id="en-0.22.0">Bug Fixes</h3>

- **V3 targets no longer receive image blocks the old host cannot read**: attachment refs are a current-generation (V4) host concept, so previously any host offering the attachment service got them stored — "import to DSH (V3)" or appending to a V3 session produced image blocks a V3 host cannot read. Below generation 4, images (including already-referenced blocks) now degrade to `[image]` placeholders counted in `imagesDegraded`; the target generation is taken only from authoritative sources (an explicit override or the target session's own header) and never from an inferred host version — without a version signal that inference collapses to the converter default of 3.
- **Transfer images (import to Claude Code / Codex / Kimi / opencode)**: when the target can carry images (Claude / Codex) they are stored through the normal path and read back into the target format, with `attachmentsOrphaned` reporting how many bytes the retracted intermediate session leaves behind in the attachment store; when the target cannot express images at all (Kimi's wire only accepts its own blob refs, opencode's file parts need external files) nothing is stored, avoiding data that can never be reclaimed.
- **Export dereference capability check fixed**: it used `attachmentService()` (which requires `saveImage`) to decide whether it could read attachments, while the read path only needs `readImage` — a read-only host surface was misjudged as unable to read, degrading images that had bytes to placeholders. It now calls `readAttachmentBytes` directly.
- **The panel shows the image counters**: `lib/panel.mjs` already returned `images` / `imagesDegraded`, but the client result line ignored them (dead payload); two new labels (zh + en) render them now.
- **New `inline-image-data` validator check**: `validateSessionEvents` never inspected content blocks, so a regression where image blocks keep their inline `data` (the landing step bypassed) had no guard; it now walks tool-result inner content (both the V3 wrapper and the V4 flat shape) and names it.
- **dsh source: `promptBlocks` was overwritten when one turn carried several image-bearing `user/message` records**: they now accumulate (the text still comes from the first, unchanged IR semantics). Since dsh events pass through verbatim, the written product is unaffected — this fixes IR-level correctness (budget estimation and re-synthesis).

<h3 id="en-0.22.0">Chores</h3>

- Removed the dead `images: 0` field from grokbuild's early-return branch; `docs/architecture.md` gained D15 (tool-result sidecar) and D14 now records the V3-target and non-reclaimable-attachment costs; USAGE documents "Transfer and images" plus `includeToolUseResult` in both languages.

**Full Changelog**: [v0.21.0...v0.22.0](https://github.com/Nwflower/dsh-chat-import/compare/v0.21.0...v0.22.0)

## [0.21.0] - 2026-09-28

[中文](#cn-0.21.0) | [English](#en-0.21.0)

<h3 id="cn-0.21.0">新增功能</h3>

- **图片导入为宿主附件，不再一律降级成 `[image]` 文本**：中间结构新增 `image` 块（与宿主 `ContentBlockMap` 的 `text/reasoning/image/tool-call/tool-result` 对齐），落盘前经宿主附件服务（`ctx.attachments`）把字节存成不可变对象，会话日志里只留 `attachmentId` 引用——**base64 永不进日志**。本机真实数据实测：抽样 40 个 Claude 会话落成 297 张（43MB），Codex 25 张，grokbuild 33 张。已是附件引用的会话（`dsh`/`dsh4` 源、导出再导入）原样带过，不重复存。结果新增 `images`（落成附件张数）与 `imagesDegraded`（仍以占位导入的张数）；`storeImages: false` 或环境变量 `DSH_IMPORT_STORE_IMAGES=0` 可只留占位、不写附件存储（单会话上限 500 张，超出部分降级并计数）。
- **反向导出把图片写回目标格式**：`export_claude` 产出 Claude 的 `{type:'image', source:{type:'base64',…}}`，`export_codex` 产出 `{type:'input_image', image_url:'data:…'}`；读不回字节的块以 `[image]` 占位导出并计入 `degradations` 的 `attachment-skipped`。`export-md` 在 Markdown 里标注附件引用与展示名。
- 转换层新增 `lib/convert/image.mjs`（图片来源 → IR 图片块：媒体类型归一、data URL 解析、魔数嗅探、上限保护）与宿主层 `lib/attachments.mjs`（落地 / 解引用 / 读回），`docs/INTERCHANGE.md` 的中间结构一节补齐 `image` / `promptBlocks` / `model` / `aborted` / `compaction` / `shadowed` 字段与两种图片块状态。

<h3 id="cn-0.21.0">问题修复</h3>

- **用户提问里的图片不再静默丢弃**：Claude / Codex / Pi 的提问消息此前只取 `text` 块拼 prompt，同一条消息里的图片连计数都没有（本机 Claude 样本里就有「两张截图 + 一句话」的提问）——现在图片进 `turns[i].promptBlocks`，合成的 `user/message` 同时带文本与图片块。
- **助手消息里的图片与 Kimi 工具结果里的媒体不再静默丢弃**：Claude 助手消息的 `image` 块、Codex 助手消息的图片、Kimi `ToolResult.return_value.output` 里的 `image_url`（`blobref:` 引用，插件取不到字节）此前直接跳过，现在有字节的落成附件、取不到字节的以占位导入并计入 `imagesDegraded`。
- 图片字节不再被复制进日志文本：源转录正文里本来含 base64 文本（如工具结果的 2KB 预览）时，那是源内容；导入产出的图片块只走附件引用，落盘前统一替换并校验。

<h3 id="cn-0.21.0">其他变更</h3>

- `eslint.config.mjs` 声明 `Buffer` 为只读全局（Node 全局此前未登记，新增的 base64 编解码代码因此报 `no-undef`）。
- 导出降级的 `attachment-skipped` 计数口径扩展为「未知块类型 + 读不回字节的图片」（`lib/convert/interchange.mjs` 新增 `unavailableImages` 汇入口）。

<h3 id="en-0.21.0">New Features</h3>

- **Images are imported as host attachments instead of collapsing to `[image]` text**: the intermediate structure gained an `image` block (matching the host's `ContentBlockMap`: `text/reasoning/image/tool-call/tool-result`), and before writing, the host attachment service (`ctx.attachments`) stores the bytes as immutable objects while the session log keeps only an `attachmentId` reference — **base64 never reaches the log**. Measured on this machine's real data: 40 sampled Claude sessions yield 297 stored images (43MB), Codex 25, grokbuild 33. Sessions that already carry attachment refs (`dsh`/`dsh4` sources, re-imported exports) pass through unchanged and are never stored twice. Results gained `images` (blocks stored as attachments) and `imagesDegraded` (blocks still imported as placeholders); `storeImages: false` or `DSH_IMPORT_STORE_IMAGES=0` keeps placeholders only and writes nothing to the attachment store (500 images per session, the excess degrades and is counted).
- **Reverse export writes images back into the target format**: `export_claude` emits Claude's `{type:'image', source:{type:'base64',…}}`, `export_codex` emits `{type:'input_image', image_url:'data:…'}`; blocks whose bytes cannot be read are exported as `[image]` placeholders and counted under `attachment-skipped` in `degradations`. `export-md` marks the attachment reference and display name in Markdown.
- The converter layer gained `lib/convert/image.mjs` (image source → IR image block: media-type normalization, data-URL parsing, magic-byte sniffing, size guard) and the host layer `lib/attachments.mjs` (materialize / dereference / read back); the exchange-format docs now spell out `image` / `promptBlocks` / `model` / `aborted` / `compaction` / `shadowed` and both image-block states.

<h3 id="en-0.21.0">Bug Fixes</h3>

- **Images inside user prompts are no longer dropped silently**: Claude / Codex / Pi prompt messages used to keep only `text` blocks when building the prompt, without even counting the images in the same message (one sampled Claude session opens with two screenshots plus one sentence) — images now go into `turns[i].promptBlocks` and the synthesized `user/message` carries both text and image blocks.
- **Images in assistant messages and media in Kimi tool results are no longer dropped silently**: Claude assistant `image` blocks, Codex assistant images and Kimi's `image_url` entries inside `ToolResult.return_value.output` (a `blobref:` reference the plugin cannot resolve) used to be skipped outright; blocks with bytes now become attachments, and blocks without bytes are imported as placeholders counted in `imagesDegraded`.
- Image bytes are no longer copied into log text: when a source transcript itself contains base64 text (such as a 2KB tool-output preview) that stays source content, while image blocks produced by the import only ever reach the log as attachment references, substituted and verified before writing.

<h3 id="en-0.21.0">Chores</h3>

- `eslint.config.mjs` declares `Buffer` as a read-only global (the Node global was not registered, so the new base64 code flagged `no-undef`).
- The export degradation counter `attachment-skipped` now covers "unknown block types plus images whose bytes cannot be read" (new `unavailableImages` input in `lib/convert/interchange.mjs`).

**Full Changelog**: [v0.20.0...v0.21.0](https://github.com/Nwflower/dsh-chat-import/compare/v0.20.0...v0.21.0)

## [0.20.0] - 2026-09-27

[中文](#cn-0.20.0) | [English](#en-0.20.0)

<h3 id="cn-0.20.0">体验优化</h3>

- **移除双向增量同步，只保留导入与导出**：删掉 `sync_to_claude` 工具、面板「同步」页与 `/api-import/sync` 路由、设置页的同步分区、`sync.json` / `outbound.json` 配置与定时巡检，工具面 13 → 12。反向导出不受影响（`export_chat` 只写新文件，从不改写源转录）。`$DSH_HOME/dsh-chat-import/` 下历史的 `sync.json` / `outbound.json` 以及 imports registry 里的 `writeback` / `exports` 字段成为惰性残留，不再被读取，也不静默删除用户数据。
- **重导语义重做**：不再「记录存在即跳过、源增长一律续写」，改为按「这条 DSH 会话还是不是我上次写完的样子」分流——源未变 → 跳过（不重读）；源增长且未在 DSH 续聊 → 只把新增轮次追加进同一会话（`appended`）；源增长但已在 DSH 续聊 → **另铸新副本**（`reimported.reason: "continued-in-dsh"`），旧会话一字不改；DSH 侧日志比基线短（被外部截短）→ 不写、跳过并报 `storedShrunk`；0.20.0 之前的记录没有基线 → 不可判定，保守另建一次副本并在落盘后回填基线。读不到 DSH 日志长度时既不追加也不复制（跳过并报 `appendedSkipped`）。`force: true` 与显式 `sessionId` 变更仍恒另铸副本。
- **重导产生的副本不再丢账**：另铸副本时旧会话收进 registry 的 `record.copies`，`list_imported_sessions`、`retract_import`、`/attach-workspaces`、清理与 `doctor` 都能枚举到它；删除单条副本只摘掉该条，删除主记录时把最新副本提升为主记录（会话还在，账也还在）。
- 面板与命令：已导入行的按钮与 tooltip 改为重导语义（未导入则新建会话、已续聊则另建副本），跳过 Toast 的动作从「忽略警告」改为「重新导入为新会话」，批量结果摘要单列「重导为新会话 N 个」；工具栏移除「仅选未导入 / 仅选已导入」两个跨页勾选按钮——重导语义下前者的作用与「全选 + 逐行导入」重叠，后者批量重导只会整批空转（源未变）或产出副本（已续聊），按钮名也不描述实际动作；批量拉取新增轮次仍可用 `/import-all`。

<h3 id="cn-0.20.0">问题修复</h3>

- 修复 **重导时把导入轮次追加进用户已续聊的会话**：源文件增长后重导会把新增轮次 append 进那条会话，位置落在用户自己的提问之前，事后无法拆开；而「我就想再导一份」的用户在未变文件上又只有静默跳过一条路。现在已续聊即另铸副本，用户那条会话保持原样；想显式要新副本时随时可用 `force: true`。

<h3 id="cn-0.20.0">其他变更</h3>

- 删除随写回失效的导出层死代码：`tailClaudeEvents` / `serializeClaudeJsonlTail` / `verifyClaudeJsonl` / `serializeCodexJsonlTail` 与 `lib/export/grokbuild.mjs` 整个文件；`./export.mjs` 子路径不再导出这些名字（破坏性契约变化）。
- registry 的展开口径收口到 `lib/imports.mjs` 的 `registryEntries` / `recordEntries`：撤回 / 清理 / 体检 / 工作区挂载 / 面板历史原先各自展开一份（同一逻辑 8 处副本），加副本记账必漏改。
- 输出字段 `forceImported` 更名为 `reimported`（带 `reason`：`continued-in-dsh` / `baseline-missing` / `forced` / `session-id-changed`），新增 `storedShrunk` 与批量 `reimported` 计数；`import_chat` 与 `restore_bundle` 的输出 schema、`lib/index.d.ts` 类型面同步。

<h3 id="en-0.20.0">Improvements</h3>

- **Removed two-way incremental sync; import and export only**: the `sync_to_claude` tool, the panel's Sync page and the `/api-import/sync` route, the sync section in Settings, the `sync.json` / `outbound.json` config and the interval watcher are gone (tool surface 13 → 12). Reverse export is unaffected (`export_chat` only ever writes new files and never rewrites source transcripts). Existing `sync.json` / `outbound.json` files under `$DSH_HOME/dsh-chat-import/` and the registry's `writeback` / `exports` fields become inert leftovers — nothing reads them, and user data is never deleted silently.
- **Re-import policy reworked**: no longer "skip when a record exists, always append when the source grew", but "is this DSH session still exactly what the import wrote?" — unchanged source → skipped (no re-read); source grew and the DSH session was not touched → only the new turns are appended (`appended`); source grew but you already chatted in that DSH session → a **new copy** is created (`reimported.reason: "continued-in-dsh"`) and the old session is left byte-identical; the DSH log is shorter than the baseline (externally truncated) → nothing is written, skipped and reported as `storedShrunk`; records written before 0.20.0 have no baseline → undecidable, so one conservative copy is made and the baseline is backfilled afterwards. When the DSH log length cannot be read at all, neither append nor copy happens (skipped as `appendedSkipped`). `force: true` and an explicit `sessionId` change still always mint a copy.
- **Copies produced by re-imports are no longer lost from the books**: the superseded session lands in the registry's `record.copies`, so `list_imported_sessions`, `retract_import`, `/attach-workspaces`, purge and `doctor` all still enumerate it; deleting a single copy only drops that entry, and deleting the main record promotes the newest copy to main (the session stays, and so does the bookkeeping).
- Panel and commands: the imported row's button and tooltip now describe the re-import policy (new session when unimported, new copy when you already chatted), the skip toast's action is "Re-import as a new session" instead of "Ignore warning", and the batch summary reports "N re-imported as new" separately; the toolbar drops the two cross-page "Select unimported" / "Select imported" buttons — under the re-import policy the former overlaps "select all plus the unimported rows", while the latter only no-ops in bulk (nothing changed) or mints copies for sessions you already chatted in, and its label never described the action; pulling new turns in bulk is still available through `/import-all`.

<h3 id="en-0.20.0">Bug Fixes</h3>

- Fix **re-importing appending imported turns into a session you had already chatted in**: when the source file grew, the new turns were appended to that session, landing *before* your own question and impossible to untangle afterwards; meanwhile a user who simply wanted a second copy only had a silent skip on an unchanged file. A continued session now gets a fresh copy while the session you used stays untouched, and `force: true` remains the explicit way to ask for a copy.

<h3 id="en-0.20.0">Chores</h3>

- Removed the export-layer dead code left behind by the write-back: `tailClaudeEvents` / `serializeClaudeJsonlTail` / `verifyClaudeJsonl` / `serializeCodexJsonlTail` and the whole `lib/export/grokbuild.mjs`; the `./export.mjs` subpath no longer exports those names (breaking contract change).
- Registry flattening is now centralized in `lib/imports.mjs` (`registryEntries` / `recordEntries`): retract / purge / doctor / workspace attach / panel history each used to expand the registry themselves (8 copies of the same logic), which copy tracking would inevitably have missed.
- The `forceImported` result field is renamed to `reimported` (with `reason`: `continued-in-dsh` / `baseline-missing` / `forced` / `session-id-changed`), and `storedShrunk` plus a batch `reimported` counter are added; the `import_chat` and `restore_bundle` output schemas and the `lib/index.d.ts` type surface follow.

**Full Changelog**: [v0.19.7...v0.20.0](https://github.com/Nwflower/dsh-chat-import/compare/v0.19.7...v0.20.0)

## [0.19.7] - 2026-09-27

[中文](#cn-0.19.7) | [English](#en-0.19.7)

<h3 id="cn-0.19.7">新增功能</h3>

- 新增 **导入结果透出转换层保真 / 降级计数**：`import_chat` 的返回值与渲染正文现在带上 `metaMessages`（isMeta 记录数）、`images`（以 `[image]` 占位导入的图片数）、`backendToolCalls`（Grok Build 后端工具调用数）、`droppedToolResultBlocks`（无法映射的结果块数）、`droppedMalformedOutputs`（Codex 工具输出里的未知块类型数）、`droppedMalformedArgs`（Codex 未能转成标准 JSON 的 `custom_tool_call` 参数数）——六个字段均为可选、>0 才占键，输出 schema（单文件与批量条目）、`SingleImportResult` / `BatchItemResult` 类型同步登记。渲染正文按「失败要大声」逐条列出（如「图片占位 294 张」「无法映射的结果块 1 个」），此前这些计数只停在转换器返回值、工具结果里看不到。

<h3 id="cn-0.19.7">问题修复</h3>

- 修复 **`import_claude` 把绝大多数工具结果导成空**：`tool_result.content` 实测 29494/33254 = **88.7% 是纯字符串**（shell 输出等），转换器此前只映射块数组，字符串内容全部落成空结果（本机 180 份转录实测 **24449 条空结果**）。现在三形态都落地：字符串 → 单文本块；数组逐块映射，其中 `image` 块以 `[image]` 占位并计入新字段 `images`（实测 294 张，base64 永不进日志）；缺失 → 空数组交由合成层兜底。未知块类型计数进新字段 `droppedToolResultBlocks`（不静默）。旧新对比：空结果 24449 → 1（仅剩的 1 条是 `tool_reference` 未知块，已计数上报）。
- 修复 **`import_claude` 把一次响应拆成多个步骤**：Claude Code 按流式增量把一次 API 响应写成多条 assistant 记录（同一 `message.id`，thinking / text / tool_use 各占一行），转换器此前每行各成一步，正文与工具调用被切碎。现在同 id 且中间只隔元数据记录（`mode` / `last-prompt` / `ai-title` 等运行期旁路）的行并回同一步，content 块按到达顺序落在同一步内；间隔里出现 user / assistant 会话记录立即断开——同 id 跨会话记录重复出现实测 1868 对，属另一次真实消息，粘连会跨轮错并。旧新对比：本机 180 份转录步骤数 **56814 → 26858**（合并掉 29956 个碎片步），一次响应只投影一条 `assistant/message`。
- 修复 **`import_codex` 把工具输出导成 JSON 转义串**：`function_call_output.output` 实测 968/1045 = **92.6% 是块数组**（`[{type:'input_text',text…}]`，偶含 `input_image`），转换器此前整体 `JSON.stringify`，导入后是一串转义 JSON、可读性全无。现在块数组逐块映射：文本块拼接为可读文本、`input_image` 以 `[image]` 占位（实测 25 张，data URL / base64 永不进日志）、未知块类型计数进新字段 `droppedMalformedOutputs`；`{"output":[…]}` 信封（字符串或对象）同样处理，纯字符串形态行为不变。旧新对比：转义串结果 **876 → 0**。

<h3 id="en-0.19.7">New Features</h3>

- Add **fidelity / degradation counters to import results**: `import_chat` results and rendered text now carry `metaMessages` (isMeta records), `images` (images imported as `[image]` placeholders), `backendToolCalls` (Grok Build backend tool calls), `droppedToolResultBlocks` (tool-result blocks that could not be mapped), `droppedMalformedOutputs` (unknown Codex tool-output block types) and `droppedMalformedArgs` (Codex `custom_tool_call` arguments that could not be converted to standard JSON). All six are optional and only present when > 0, and are registered in the output schema (single result and batch item) plus the `SingleImportResult` / `BatchItemResult` types. The rendered text lists them ("图片占位 294 张", "无法映射的结果块 1 个", …) so they are loud in the tool result instead of stopping at the converter's return value.

<h3 id="en-0.19.7">Bug Fixes</h3>

- Fix **`import_claude` importing the vast majority of tool results as empty**: 29494 of 33254 (88.7%) `tool_result.content` values in real local transcripts are plain strings (shell output and friends), while the converter only mapped block arrays — every string result landed as an empty result (24449 empty results measured across 180 local transcripts). All three shapes now land: a string becomes a single text block; an array maps block by block, with `image` blocks becoming `[image]` placeholders counted in the new `images` field (294 measured; base64 never enters the log); a missing value stays an empty array for the synthesizer to pad. Unknown block types are counted in the new `droppedToolResultBlocks` field instead of being swallowed. Old vs new on identical data: empty results 24449 → 1 (the remaining one is a `tool_reference` unknown block, counted loudly).
- Fix **`import_claude` splitting one response into multiple steps**: Claude Code writes a single API response as several `assistant` records during streaming (one line each for thinking / text / tool_use, all sharing one `message.id`), and the converter used to turn every line into its own step, shredding the response text and its tool calls. Records with the same id separated only by metadata records (`mode` / `last-prompt` / `ai-title` and other runtime side channels) now merge back into one step with content blocks in arrival order; a `user` or `assistant` conversation record between them still breaks the group — the same id repeating across conversation records (1868 pairs measured) is a genuinely different message, and fusing those would merge separate turns. Old vs new on identical data: 56814 steps → **26858** across 180 local transcripts (29956 fragment steps merged away), one `assistant/message` per response.
- Fix **`import_codex` importing tool output as escaped JSON**: 968 of 1045 (92.6%) `function_call_output.output` values are block arrays (`[{type:'input_text',text…}]`, occasionally with `input_image`), which the converter used to `JSON.stringify` wholesale, so the imported result was unreadable escape soup. Block arrays are now mapped block by block: text blocks join into readable text, `input_image` becomes an `[image]` placeholder (25 measured; data URLs / base64 never enter the log), and unknown block types are counted in the new `droppedMalformedOutputs` field; `{"output":[…]}` envelopes (string or object) get the same treatment, and plain-string outputs behave exactly as before. Old vs new on identical data: escaped-JSON results 876 → 0.

**Full Changelog**: [v0.19.6...v0.19.7](https://github.com/Nwflower/dsh-chat-import/compare/v0.19.6...v0.19.7)

## [0.19.6] - 2026-09-26

[中文](#cn-0.19.6) | [English](#en-0.19.6)

<h3 id="cn-0.19.6">问题修复</h3>

- 修复 **`import_grokbuild` 在真实 `chat_format_version: 1` 转录上丢失几乎全部工具活动**：旧实现把 `tool_result` / `reasoning` / `backend_tool_call` 整类丢弃、assistant 行只读 content 块不读顶层 `tool_calls`——本机 6 个真实会话实测 **473 次工具调用无一进日志**。重写后按真实格式逐类落地：顶层 `tool_calls` 逐项进步骤（实测 473/473 调用与结果全配对，跨 step 晚到的结果按 `tool_call_id` 归位）；`reasoning` 行的明文摘要前置到下一 assistant 步骤（`encrypted_content` 密文永不读取）；`tool_result` 图片以 `[image]` 占位并新增计数字段 `images`（实测 33 张，base64 不进日志）；`backend_tool_call` 只计数（新字段 `backendToolCalls`，实测 1 次）不映射——其结果不在转录里，映射会破坏配对不变量；`synthetic_reason` 注入行（system_reminder / `<user_info>` 环境块）不再被当提问开轮（只含注入的会话正确导入为 0 轮）；`compaction_meta` 交接摘要导入为原生压缩检查点（provider 标签 `grok-build`），`prior_turn_interrupt: 'mid_turn_abort'` 把上一轮标 aborted；逐行 `model_id` 落到 `step.model`，会话级取 `current_model_id` 兜底。发现层同口径修标题兜底（跳过 synthetic 行、剥 `<user_query>` 信封），并新增 `GROK_HOME` 环境变量覆盖默认 `~/.grok` 根。
- 修复 **`import_claude` 把 `isMeta` 记录当提问开轮**：Claude Code 把上下文回执、后台命令输出、图片占位、skill 正文、压缩续接提示等写成 `isMeta: true` 的 user 记录，此前一律开成新轮——本机 179 份转录实测 **198 条**，超一半落在一轮中间把对话切碎成假轮。现在 `isMeta` 记录永不开轮、不参与标题；文本按时间顺序前置到下一个 assistant 步骤 content 开头（搭在 content 块内部、不产生独立消息，不破坏 tool_calls 与 tool 消息的配对），会话末尾残余追加到最后一步，识别数计入新返回字段 `metaMessages`（实测 198/198 与独立统计一致）。
- 修复 **`import_codex` 把 AGENTS.md 注入当首问**：首条 user 消息为 `[# AGENTS.md instructions for …, <environment_context>…]` 的 rollout 此前产出 0 步假轮、标题退化为 `# AGENTS.md instructions for D:\…`（本机 11 份实测全部中招）。现在注入块走公共注入前缀表过滤（与发现层面板同一真相源），全注入消息不开轮、标题取首个真实提问；`importSystemPrompt` 开启时 `# AGENTS.md` 块收进 systemPrompt。
- 修复 **claude / codex / grokbuild 三源的步骤模型归属只记会话第一条**：会话中途换模型后所有步骤仍记成旧模型。现在每条 assistant 步骤带自己的 `step.model`（claude 取 `message.model`、codex 逐条 `turn_context` 更新、grokbuild 取 `model_id`），会话级仍取第一条兜底。

<h3 id="en-0.19.6">Bug Fixes</h3>

- Fix **`import_grokbuild` dropping nearly all tool activity on real `chat_format_version: 1` transcripts**: the old converter discarded `tool_result` / `reasoning` / `backend_tool_call` records wholesale and read only content blocks of assistant lines, never the top-level `tool_calls` — across 6 real local sessions, **all 473 tool calls were missing from the log**. The rewrite maps each record kind faithfully: top-level `tool_calls` become steps (473/473 calls paired with results, late arrivals re-attached by `tool_call_id`); plaintext `reasoning` summaries lead the next assistant step (`encrypted_content` is never read); `tool_result` images become `[image]` placeholders with a new `images` counter (33 measured locally; base64 never enters the log); `backend_tool_call` is only counted (new `backendToolCalls` field, 1 measured) — its results are not in the transcript, so mapping them would break the pairing invariant; `synthetic_reason` injection lines (system reminders / `<user_info>` environment blocks) no longer open turns (injection-only sessions correctly import as 0 turns); `compaction_meta` hand-off summaries import as native compaction checkpoints (provider tag `grok-build`); `prior_turn_interrupt: 'mid_turn_abort'` marks the previous turn aborted; per-line `model_id` lands on `step.model` with `current_model_id` as the session-level fallback. The discovery layer applies the same title fallback (skips synthetic lines, strips `<user_query>` envelopes), and a new `GROK_HOME` environment variable overrides the default `~/.grok` root.
- Fix **`import_claude` opening a turn for every `isMeta` record**: Claude Code writes context receipts, background command output, image placeholders, skill bodies and post-compaction continuation prompts as `isMeta: true` user records, which used to each open a new turn — **198 such records across 179 local transcripts**, more than half landing mid-turn and shredding the conversation into fake turns. `isMeta` records now never open a turn and never become the title; their text is prepended, in arrival order, to the next assistant step's content (inside the content blocks — no standalone message, so tool_calls/tool pairing is undisturbed), leftovers at end of session append to the last step, and the recognized count is reported in the new `metaMessages` field (198/198 matching an independent count locally).
- Fix **`import_codex` treating AGENTS.md injection as the first prompt**: rollouts whose first user message is `[# AGENTS.md instructions for …, <environment_context>…]` used to produce a 0-step fake turn and a title degenerating to `# AGENTS.md instructions for D:\…` (all 11 affected local rollouts). Injection blocks are now filtered through the shared injection prefix table (same source of truth as the discovery panel), an all-injection message opens no turn and the title falls to the first real prompt; with `importSystemPrompt` on, the `# AGENTS.md` block is kept in systemPrompt.
- Fix **claude / codex / grokbuild attributing every step to the session's first model**: after a mid-session model switch all steps still carried the old model. Each assistant step now carries its own `step.model` (claude reads `message.model`, codex tracks every `turn_context`, grokbuild reads `model_id`); the session-level model remains the first record as fallback.

**Full Changelog**: [v0.19.5...v0.19.6](https://github.com/Nwflower/dsh-chat-import/compare/v0.19.5...v0.19.6)

## [0.19.5] - 2026-09-26

[中文](#cn-0.19.5) | [English](#en-0.19.5)

<h3 id="cn-0.19.5">问题修复</h3>

- 修复 **`import_zed` / `import_crush` / `import_continue` / `import_zcode` 的压缩摘要只作 `reasoning` 块、模型上下文与源不一致**：这四源此前把压缩摘要前置成 reasoning 块，却仍把压缩前的全量历史留在模型视角里——源侧（Zed「用摘要替换整段历史」、Crush `summary_message_id`、Continue `conversationSummary`、zcode `compactBoundary` 的保留窗口）早就把那些内容压掉了，于是导入后的会话比源胖一大截，超预算还会被预算裁剪吃掉中间（reported 的 Codex 同类问题）。现在四源默认都发 **DSH 原生压缩检查点**：日志照常保全量历史，边界处发射原生 `compaction/*` 事务（摘要进检查点、其前的轮 log-only），模型视角 = 摘要 + 压缩点之后的内容。边界口径按各源事实：Zed 是 `Compaction` 消息的位置；Crush 是 `is_summary_message` 消息；Continue 是带 `conversationSummary` 的 item 之后；zcode 是 `compactBoundary.keptMessageCount` 划出的保留窗口起点（无 `compactBoundary` 时不猜，退回摘要 reasoning 块）。压缩点之前没有可遮蔽内容时发不出检查点（宿主不变式要求 `shadowedSeqs` 非空），摘要由合成层退回 reasoning 块承载，不丢正文。`fullHistory: true` 时不发检查点、摘要回到既有 reasoning 形态，四源都已进参数指纹（换值重导走 args-changed）。

- 修复 **Cline 的压缩侧车从未被读取、DSH 会话重导丢检查点**：Cline 的 `<sessionId>.compaction.json`（SessionCompactionState）此前既不在收集范围内也不被解析，压缩后的会话导入后模型看到的是全量历史（源侧早已折叠）；读进来后按 `source_message_count` 把被折叠的 canonical 消息标 log-only、摘要进原生检查点，`fullHistory: true` 时不发检查点。同一提交修掉两处相关缺口：**重导 DSH 会话**（`format: 'dsh' | 'dsh4'`）此前 `DURABLE` 白名单不含 `compaction/*`、还会把检查点的替换写成追加，压缩过的 DSH 会话重导一次就丢检查点、摘要退化成普通 user 消息——现在三类压缩事件原样保留、替换范围与 `shadowedSeqs` 与 `sourceEventSeqs` 一起重映射（V3/V4 的 `plugin:compact` 生产者标记双向归一，源日志畸形时退回 append 并由 `verify_session` 的 compaction-* 检查点名）；以及 `import_claude({ fullHistory: true })` 会把 `isCompactSummary` 摘要记录整条丢掉（改动前它是按普通 user 记录导入的）——现在 fullHistory 下摘要记录照常可见。

<h3 id="en-0.19.5">Bug Fixes</h3>

- Fix **`import_kimi` still windowing the conversation at a compaction point**: Kimi's compaction markers (modern `context.apply_compaction`, legacy `CompactionBegin/End` pairs) used to be handled by *windowing* — the turns before the cut, plus the steps already built in the straddling turn, were deleted from the imported session, so the pre-compaction history was gone for good (neither replayable nor exportable back to the source). The modern carrier carries a summary, so it is now imported as a **native DSH compaction checkpoint**: the full history stays in the log, one native `compaction/*` transaction is emitted at the cut (the summary becomes the checkpoint), and the straddling turn is **split in two** (the earlier part is log-only, the later part becomes the boundary turn). The model sees the summary plus everything after the cut, matching the source; several compactions produce several chained checkpoints. The legacy wire carries only a marker pair with the summary written to `context.jsonl` (never into the wire) → there is no summary to restore, so that case keeps the window slice and now reports `compactionSummaryMissing: true` explicitly instead of inventing summary text. `fullHistory: true` emits no checkpoints (the model sees everything) and feeds the args fingerprint (changing it re-imports via args-changed).
- Fix **`import_zed` / `import_crush` / `import_continue` / `import_zcode` keeping the compacted-away history in the model's context** (their summary was only a leading `reasoning` block): the source tools already dropped that content (Zed "replaces the full history with the summary", Crush's `summary_message_id`, Continue's `conversationSummary`, zcode's `compactBoundary` retention window), so the imported session was much fatter than the source and could still have its middle eaten by budget trimming after import (the same defect class as the Codex report). All four now emit **native DSH compaction checkpoints** by default: the log keeps the full history, the boundary emits a native `compaction/*` transaction (summary into the checkpoint, earlier turns log-only), and the model sees the summary plus everything after the boundary. The boundary follows each source's own facts: Zed's `Compaction` message position, Crush's `is_summary_message`, Continue's item carrying `conversationSummary` (boundary after it), and zcode's retained-window start (`compactBoundary.keptMessageCount`; without a `compactBoundary` the converter does not guess and keeps the reasoning block). When nothing before the boundary can be shadowed, no checkpoint can be emitted (the host invariant requires non-empty `shadowedSeqs`), so the synthesizer falls back to carrying the summary as a reasoning block rather than losing it. `fullHistory: true` emits no checkpoints and restores the previous reasoning-block form; all four sources feed it into the args fingerprint (changing it re-imports via args-changed).

- Fix **Cline's compaction sidecar never being read, and DSH session re-imports losing their checkpoints**: `<sessionId>.compaction.json` (the SessionCompactionState) was neither collected nor parsed, so a compacted Cline session imported with the full history visible even though the source had already folded it away; the sidecar is now read and `source_message_count` marks the folded canonical messages log-only with the summary becoming a native checkpoint (`fullHistory: true` emits none). The same commit closes two related gaps: **re-importing a DSH session** (`format: 'dsh' | 'dsh4'`) used to drop every compaction event (`DURABLE` did not list `compaction/*`) and to rewrite the checkpoint's replacement as an append, so one round-trip lost the checkpoints and turned the summary into a plain user message — all three compaction events are now preserved with the replacement range, `shadowedSeqs` and `sourceEventSeqs` remapped together (the V3/V4 `plugin:compact` producer marker is normalized in both directions, a malformed source log falls back to append and gets named by `verify_session`'s compaction-* checks); and `import_claude({ fullHistory: true })` dropped the `isCompactSummary` record entirely (it used to be imported as a plain user record) — the summary record is visible again in fullHistory mode.

**Full Changelog**: [v0.19.4...v0.19.5](https://github.com/Nwflower/dsh-chat-import/compare/v0.19.4...v0.19.5)

## [0.19.4] - 2026-09-26

[中文](#cn-0.19.4) | [English](#en-0.19.4)

<h3 id="cn-0.19.4">新增功能</h3>

- 新增 **上下文压缩导入为 DSH 原生压缩事件**：来源工具的压缩（Claude Code 的 `compact_boundary` + `isCompactSummary` user 记录与旧格式 `summary` 记录、Codex 的 `compacted` 信封、Pi 的 `compaction` 条目、opencode 的 `compaction` part + 摘要消息）此前是「切窗口」——只导压缩点之后的对话，压缩前的历史在导入时就消失了；现在改为**日志保全量历史**，并在每个压缩边界发射一次宿主原生的压缩事务（`compaction/start` → `compaction/summary` → 带 `surfaceOp:{op:'replace'}` 与 `source:{kind:'plugin',plugin:'compact'}` 的检查点 `user/message` → `compaction/end`，被遮蔽的 surface 节点全部进 `sourceEventSeqs` 溯源）。模型的投影因此是「摘要检查点 + 压缩点之后的对话」，与源工具压缩后的真实上下文一致；一次会话压缩多次就发多个链式检查点。导入结果带 `compacted: true` 与 `compactions: <N>`（检查点数），`fullHistory: true` 时不发检查点（模型看到全量历史）并已进参数指纹（换值重导走 args-changed）。摘要正文取不到时**不发检查点**（不做任何标记），绝不静默丢掉前半段。实测（本机真实转录）：Codex 一份 6579 条记录、压缩 10 次的 rollout 此前约 **8411412 tokens**、超 366000 预算被裁掉中间 5 轮（796 条消息、741 次工具调用），现在导入为 19 轮 / 867 条消息 / 794 次工具调用 / 10 个检查点、**零裁剪**；Claude 压缩过的转录（抽检 1 / 1 / 4 次压缩三份）与 Pi、opencode 的合成夹具同样零违规通过宿主 `foldSurface` 与 `dsh-compaction` 不变式。配套：受遮蔽轮**不计预算、不裁剪、不丢弃**（预算只作用于检查点之后的有效段），`verify_session` 新增压缩事务契约校验（括号配对、遮蔽范围与 `shadowedSeqs` 一致、检查点标记与括号 id 一致、溯源不缺被遮蔽节点）。
### 问题修复

- 修复 **`import_claude({ compacted: true })` 在现代转录上从不生效**：该参数只认 2.0.x 旧格式的 `type:"summary"` 记录，而现代 2.x 的压缩载体是 `system/compact_boundary` + 紧随的 `isCompactSummary` user 记录（**摘要正文就在这条 user 记录里**）——本机 105 份主转录里 17 份压缩过，实测 `summary` 记录 0 条、`isCompactSummary` 44 条，于是这个开关静默退化成全量导入。现在两代载体都认（同一会话压缩多次就发多个检查点，见上条），`compacted: true` 保留为兼容别名（默认行为即尊重压缩）。连带修掉一个会随它暴露的缺陷：标题载体（`custom-title` / `ai-title`）落在压缩边界之前时会被切片丢掉，压缩导入的标题会退化成尾部首问——实测 17 份压缩转录**全部**是这个情形，故标题载体改为在全量记录上先扫。
- 修复 **`export_chat({ format: 'claude' })` 把标题写成 `ai-title`（生成标题载体）**：Claude Code 把 `custom-title` 当用户自定义标题、把 `ai-title` 当它随对话自动生成改写的记录——导出成 `ai-title` 等于把 DSH 标题标成「生成标题」，在那边的会话里续聊后可能被它自己生成的新标题覆盖。现在写 `custom-title`（位置不变：首个 user 记录之后），与 `/rename` 的形态一致（实测本机 24 份被重命名过的真实转录正是「只有 custom-title、没有 ai-title」）。导出→导入往返标题逐字保持。
- 修复**粘贴信封 `pasted_content` 进了标题**：`<pasted_content id="…">正文</pasted_content>` 是宿主给「粘贴进来的正文」加的信封，此前整串标记被当成话题（如 `Claude · <pasted_content id="1b70"> …`）。现在标题路径（转换层首问兜底 + 发现层面板标题）剥掉信封只取正文；信封里没有正文时照旧用原文。
- 修复 **Claude 转录的标题归因错误——`/rename` 的自定义标题被丢弃、注入块被当成标题**：转换层与发现层此前只认 2.0.x 旧格式的 `summary` 记录与 `ai-title`，**不认现代 2.x 的 `custom-title` 记录**（`/rename` 写入的自定义标题，本机 2668 条），于是被重命名过的会话导入后标题退回首问原文（常常是 `<system-reminder>` / `<pasted_content>` 注入块）。现在两处都按权威度取载体：`custom-title`（后到者胜 = 最近一次重命名）> 旧格式 `summary` > `ai-title`（取首个：实测 62 份带 ai-title 的转录里 3 份尾部被 worktree 名覆盖）> 首个**非注入**提问；Claude 的发现层额外用尾部读补扫（实测 25 份 custom-title 全部落在文件最后 64KB 内、62 份 ai-title 里 9 份只能从尾部看到），`<local-command-stdout>`（斜杠命令输出回灌）并入注入前缀表。整场只有本地命令的会话落「Claude · 未命名 · 日期」而非注入块，转换层显式给出的空标题也不再被 `pinSourcedSessionTitle` 回退成原始首问。本机实测（104 份有回合的主转录）：26 份标题被纠正；24 份带自定义标题的会话修复前只有 1 份与 Claude Code 自身标题一致，修复后 24/24 一致（超 80 字符按统一规则截断）。`/resume-claude` 的交接摘要标题同源修正。
- 修复**已归档并删除的会话在导入面板显示「同步」而非「导入」**：`resolveImportStatus` 只看 imports registry 记录与归档集，不看宿主里该会话是否还在——会话被删除后 registry 记录仍在、归档集也已清掉，于是被判成「已导入」→ 面板显示「同步」，可会话没了无从同步、也无法重新导入。现在把宿主持久化会话 id 集合（`persistedIds`，发现层本就传入）一并交给状态判定：记录指向的会话**已不在宿主** → `not-imported`（显示「导入」，重导走 `decideItem` 的 `staleRegistry` 重建路径）；**已删除优先于已归档**（归档后又被删除同样是 `not-imported`）。本机实测：96 条「registry 有记录、磁盘上没有会话」的条目从 `imported` 纠正为 `not-imported`。
- 修复 **0.1.7 上设置页不可用**：0.1.7 把插件设置从 `settings.section`（设置页「每功能一页」）搬到「设置 → 插件」的插件页（`plugins.bundle.config` 槽，键 = 包名），值走客户端服务 `configForms`（命名空间 = profile 条目 id，控制器带值 + 写队列 + revision 栅栏）。插件此前只注册旧席位、只走自建 fenced 路由，于是新宿主上设置页看不到、改不动。现在按宿主世代分流（对齐 dsh-claude-style）：`configForms` 在场 → 注册 `plugins.bundle.config`（键 `dsh-chat-import`）并逐字段 `set()` 读写；缺席 → 保留 `settings.section` 整页与 `/api-import/prefs` 路由。两处席位互斥注册，避免同一设置在两处各长一份。（补充：浏览器 boot 给插件条目的是**随机 id**，所以命名空间从 configForms 已服务的名单里挑，挑不到才用 patch 声明的 `import-claude`；官方表单没 ready 或被拒时回落 fenced 路由——这正是「选项显示但存不进去」的修复。）

<h3 id="en-0.19.4">New Features</h3>

- New: **context compaction is imported as native DSH compaction events**. A source tool's compaction (Claude Code's `compact_boundary` + `isCompactSummary` user record and legacy `summary` records, Codex's `compacted` envelopes, Pi's `compaction` entries, opencode's `compaction` parts plus summary message) used to be handled by *windowing* — only the conversation after the compaction point was imported, so the pre-compaction history vanished at import time. The log now keeps the **full history** and one host-native compaction transaction is emitted per boundary (`compaction/start` → `compaction/summary` → the checkpoint `user/message` carrying `surfaceOp:{op:'replace'}` and `source:{kind:'plugin',plugin:'compact'}` → `compaction/end`, with every shadowed surface node listed in `sourceEventSeqs` for provenance). The model therefore sees "summary checkpoint + everything after the boundary", matching the source tool's real post-compaction context; several compactions produce several chained checkpoints. The result carries `compacted: true` and `compactions: <N>` (checkpoint count); `fullHistory: true` emits no checkpoints (the model sees everything) and feeds the args fingerprint (changing it re-imports via args-changed). No summary text → no checkpoint (nothing is marked, the earlier half is never dropped silently). Measured on real transcripts here: a 6579-record Codex rollout compacted 10 times used to measure roughly **8411412 tokens** and have 5 turns (796 messages, 741 tool calls) trimmed away against a 366000 budget — it now imports as 19 turns / 867 messages / 794 tool calls / 10 checkpoints with **no trimming at all**; three sampled compacted Claude transcripts (1 / 1 / 4 compactions) plus the Pi and opencode fixtures pass the host `foldSurface` and `dsh-compaction` invariants with zero violations. Supporting changes: shadowed turns are **not counted, not cropped and not dropped** by budget trimming (the budget only applies to the segment after the checkpoint), and `verify_session` gained a compaction-transaction contract check (bracket pairing, shadow range matching `shadowedSeqs`, checkpoint marker matching the bracket id, provenance covering every shadowed node).
### Bug Fixes

- Fix **`import_claude({ compacted: true })` never taking effect on modern transcripts**: the flag only knew the 2.0.x `type:"summary"` record, while the modern 2.x carrier is `system/compact_boundary` plus the `isCompactSummary` user record that follows it (**the summary text lives in that user record**) — 17 of the 105 main transcripts on this machine were compacted, with 0 `summary` records and 44 `isCompactSummary` records, so the flag silently degraded to a full import. Both carrier generations are now recognized (several compactions emit several checkpoints, see above) and `compacted: true` is kept as a compatible alias (respecting compaction is the default now). This also fixes a defect it would have exposed: title carriers (`custom-title` / `ai-title`) sitting before the compaction boundary were removed by the slice, degrading the title to a tail prompt — all 17 compacted transcripts measured are in exactly that shape, so title carriers are now scanned over the full record set.
- Fix **`export_chat({ format: 'claude' })` writing the title as `ai-title` (the generated-title carrier)**: Claude Code treats `custom-title` as the user's own title and `ai-title` as a record it generates and rewrites as the conversation evolves — exporting as `ai-title` labels the DSH title "generated" and it can be overwritten by a fresh generated title after continuing there. The export now writes `custom-title` (same position: right after the first user record), matching what `/rename` produces (all 24 renamed transcripts measured on this machine carry custom-title and no ai-title). Export → import round-trips the title verbatim.
- Fix **the pasted-content envelope leaking into titles**: `<pasted_content id="…">text</pasted_content>` is the envelope the host wraps pasted text in, and the whole markup used to become the topic (e.g. `Claude · <pasted_content id="1b70"> …`). Title paths (the converter's first-prompt fallback and the discovery layer's panel title) now strip the envelope and keep the text; when the envelope is empty the original text is kept.
- Fix **misattributed Claude transcript titles — `/rename` custom titles dropped, injection blocks used as titles**: the converter and the discovery layer only knew the 2.0.x `summary` record and `ai-title`, and ignored the modern 2.x `custom-title` record (the title written by `/rename`, 2668 of them on this machine), so renamed sessions imported with the first prompt as their title — often a `<system-reminder>` / `<pasted_content>` injection block. Both layers now pick carriers by authority: `custom-title` (last one wins = the most recent rename) > legacy `summary` > `ai-title` (first one wins: in 3 of the 62 transcripts carrying ai-title the tail had been overwritten with a worktree name) > the first **non-injected** prompt; Claude discovery additionally scans the file tail (all 25 custom-title records measured sit in the last 64 KB, and 9 of 62 ai-title records are only visible from the tail), and `<local-command-stdout>` (slash-command output fed back in) joined the injection prefix list. A session holding nothing but local commands now lands on "Claude · 未命名 · date" instead of an injection block, and an explicit empty title from the converter is no longer reverted to the raw first prompt by `pinSourcedSessionTitle`. Measured on this machine (104 main transcripts with turns): 26 titles corrected; of the 24 sessions with a custom title only 1 matched Claude Code's own title before, and 24/24 match now (longer than 80 characters is truncated by the shared rule). `/resume-claude` handoff summaries read the same carriers.
- Fix **archived-then-deleted sessions showing as "Sync" instead of "Import" in the import panel**: `resolveImportStatus` looked only at the imports registry record and the archive set, never at whether the session still exists in the host — after a delete the registry record remained while the archive set was already cleared, so the row was judged "imported" and showed **Sync**, even though a deleted session cannot be synced and could not be re-imported. The host's persisted session id set (`persistedIds`, already passed into discovery) now feeds the status: a record whose session is **no longer in the host** → `not-imported` (the panel shows **Import**, and a re-import takes `decideItem`'s `staleRegistry` rebuild path); **deleted takes precedence over archived** (archived-then-deleted is `not-imported` too). Measured on this machine: 96 entries with "a registry record but no session on disk" were corrected from `imported` to `not-imported`.
- Fix **the settings page being unusable on 0.1.7**: 0.1.7 moved plugin settings from `settings.section` (the Settings page's "one page per feature") to the plugin page under "Settings → Plugins" (the `plugins.bundle.config` slot, keyed by package name), with values served through the client `configForms` service (namespace = profile entry id; the controller carries the value, a write queue and a revision fence). The plugin only registered the old seat and only used its own fenced route, so on the new host the settings were neither visible nor writable. It now splits by host generation (matching dsh-claude-style): with `configForms` present it registers `plugins.bundle.config` (key `dsh-chat-import`) and reads/writes field-by-field through `set()`; without it the `settings.section` full page and the `/api-import/prefs` route are kept. The two seats register exclusively, so one setting never grows a copy in two places. (Note: the browser boot assigns plugin entries a generated id, so the namespace is picked from the namespaces `configForms` already serves, falling back to the patch-declared `import-claude`; when the official form is not ready or refuses, the fenced route takes over — that is the fix for "options show but cannot be saved".)

**Full Changelog**: [v0.19.3...v0.19.4](https://github.com/Nwflower/dsh-chat-import/compare/v0.19.3...v0.19.4)

## [0.19.3] - 2026-09-22

[中文](#cn-0.19.3) | [English](#en-0.19.3)

<h3 id="cn-0.19.3">问题修复</h3>

- 修复 **0.1.7 上设置绑定被过早缓存为 `none`、面板读不到值**（0.19.2 的真机回归）：cordis 在 `apply` 期把 fiber 置为 state 1，`settings.describe()` 会跳过本条目，于是绑定解析成 `none` 并被缓存——apply 结束后即便条目已进名单，所有读取仍停在 `none`（实测面板 `available:false`，而同一响应里的 `probe.namespaceState` 已是 `configured:import-claude`）。现在 `none` 不再缓存（后续读取重新解析），且 `injectTools` 初值改从插件自己的 `config`（volatile 实时引用）读，变更通知同时订阅 `loader/volatile-update`（本 fiber 精确）与 `settings/document-updated`。

<h3 id="en-0.19.3">Bug Fixes</h3>

- Fix **the settings binding being cached as `none` too early on 0.1.7, leaving the panel unable to read values** (a real-host regression in 0.19.2): cordis puts the fiber in state 1 during `apply`, so `settings.describe()` skips the entry and the binding resolves to `none` — which was then cached, so every later read stayed `none` even after the entry appeared (measured: the panel returned `available:false` while the same response's `probe.namespaceState` was already `configured:import-claude`). `none` is no longer cached (later reads re-resolve), the initial `injectTools` value now comes from the plugin's own `config` (a live volatile ref), and change notifications subscribe to both `loader/volatile-update` (exact for this fiber) and `settings/document-updated`.

**Full Changelog**: [v0.19.2...v0.19.3](https://github.com/Nwflower/dsh-chat-import/compare/v0.19.2...v0.19.3)

## [0.19.2] - 2026-09-22

[中文](#cn-0.19.2) | [English](#en-0.19.2)

<h3 id="cn-0.19.2">新增功能</h3>

- 导入面板的设置偏好响应（`/api-import/prefs`）新增只读 **`probe` 自检块**：宿主设置服务的关键事实（`hasSettings` / `hasDescribe` / `hasRegister`、命名空间名单、`namespaceState`）一次看全，供 0.1.5 / 0.1.7 设置模型差异排障。
- 新增 [docs/SETTINGS-MIGRATION.md](docs/SETTINGS-MIGRATION.md)（[中文](docs/SETTINGS-MIGRATION.zh-CN.md)）：DSH 0.1.5 → 0.1.7 设置页迁移说明，含实测报错原文，可直接转发给其他插件作者。

### 问题修复

- 修复 **0.1.7 宿主上导入偏好设置整体失效**：0.1.7 删除了 `settings.register()`（命名空间改为 profile 条目 id、schema 改为插件导出的 `Config`），插件此前仍走旧注册路径，注册直接抛错。现在一套代码兼容两版：宿主设置服务有 `describe()` 且名单含本插件的**裸条目 id** → 按条目 id 读写（0.1.7）；只有 `register` / `get` → 自持命名空间 `chat-import`（0.1.5）；两者皆无 → 读默认、写不持久化（`available:false`）。
- 修复**设置命名空间带种类前缀导致每次保存都 409 `settings-conflict`**：0.1.7 的 loader 把 `ctx.fiber.entry.id` 报成 `<kind>:<id>`，而设置服务按裸 id 建索引；现在剥离前缀（拿不到时回退 patch 声明的 `import-claude`）。
- 修复**插件以软链 / 本地 link 安装时 `@deepseek-ai/schemastery` 解析不到**：解析锚点改为运行中的 harness bin，再退回普通解析；并对 `.volatile()` 做能力探测——旧宿主（无 volatile）不再在模块加载期抛错报废整个插件。
- 插件入口导出 `Config`（三个字段标 `volatile`）并声明 `settings.configure({ auto: false })`（本插件自带面板，不生成宿主自动页）；`package.json` 增补 `icon`（相对路径、包内、约 1 KB、带彩度，适配宿主 `<img>` 渲染拿不到 `currentColor`）。

<h3 id="en-0.19.2">New Features</h3>

- The import panel's settings response (`/api-import/prefs`) gained a read-only **`probe` self-check block**: the host settings service's key facts (`hasSettings` / `hasDescribe` / `hasRegister`, the namespace list, `namespaceState`) in one response, for diagnosing the 0.1.5 / 0.1.7 settings-model difference.
- New [docs/SETTINGS-MIGRATION.md](docs/SETTINGS-MIGRATION.md) ([中文](docs/SETTINGS-MIGRATION.zh-CN.md)): a DSH 0.1.5 → 0.1.7 settings-page migration guide with the verbatim measured errors, ready to forward to other plugin authors.

### Bug Fixes

- Fix **import preferences being entirely broken on a 0.1.7 host**: 0.1.7 removed `settings.register()` (the namespace became the profile entry id and the schema the plugin's exported `Config`), while the plugin still took the old registration path and threw on registration. One codebase now supports both: when the host settings service has `describe()` and its list contains the plugin's **bare entry id** → read/write by entry id (0.1.7); only `register` / `get` → the plugin-owned namespace `chat-import` (0.1.5); neither → defaults are read and writes are not persisted (`available:false`).
- Fix **every save returning 409 `settings-conflict` because the namespace carried a kind prefix**: the 0.1.7 loader reports `ctx.fiber.entry.id` as `<kind>:<id>`, while the settings service indexes by the bare id; the prefix is now stripped (falling back to the patch-declared `import-claude`).
- Fix **`@deepseek-ai/schemastery` not resolving when the plugin is installed as a symlink / local link**: the resolution anchor is now the running harness bin, with ordinary resolution as a fallback; `.volatile()` is capability-probed, so an older host (no volatile) no longer throws at module load and takes the whole plugin down.
- The plugin entry now exports `Config` (all three fields marked `volatile`) and declares `settings.configure({ auto: false })` (this plugin ships its own panel, so no host auto page is generated); `package.json` gained `icon` (relative path, inside the package, ~1 KB, coloured, since the host renders it as `<img>` and never provides `currentColor`).

**Full Changelog**: [v0.19.1...v0.19.2](https://github.com/Nwflower/dsh-chat-import/compare/v0.19.1...v0.19.2)

## [0.19.1] - 2026-09-22

[中文](#cn-0.19.1) | [English](#en-0.19.1)

<h3 id="cn-0.19.1">新增功能</h3>

- 会话读写按**宿主会话格式代次**分流：写入 V3 宿主时工具结果是 `role: 'user'` 内的 `tool-result` 包装，写入 V4 宿主时是顶层 `role: 'tool'` 消息；读取侧（反向导出、校验、Markdown 渲染）统一走同一个工具结果入口，两种形状都能读。已装 V3 宿主的行为与产物不变。
- `verify_session` 新增三类 **V4 迁移风险**检查：`unadvertised-tool-call`（调用无 assistant 内容块广告）、`cross-step-result`（结果闭合在调用所在 step 之外）、`duplicate-tool-result`（同一调用多条结果）。这三类日志在宿主升 V4 时会整份拒载，现在可在升级前用 `force: true` 重导修复。
- 新增**忽略（墓碑）表**：归档会话、撤回 / 删除导入、删除工作区都会自动把对应源登记为忽略，重扫、`/import-all` 与自动同步不再把它带回来；取消归档自动解除。新增命令 **`/ignores`**（查看）、**`/ignore <sessionId|sourcePath>`**、**`/unignore <sessionId|sourcePath|all>`**；`force: true` 仍可越权导入一次（不解除墓碑）。忽略表落盘 `$DSH_HOME/dsh-chat-import/ignores.json`，文件损坏按空表降级，不阻塞导入。
- DSH 来源与「导入到」目标各拆成 **V3 / V4 两项**：来源「DSH V3 会话格式」（日志 v0–v3）与「DSH V4 会话格式」（v4+）共用 `$DSH_HOME/sessions`、按日志文件名代次分流；目标「DSH（V3 会话格式）」「DSH（V4 会话格式）」的**默认项按探测到的宿主版本自动选中**。选定代次后 `header.version` 与事件形状一起产出，因此在 V4 宿主上能真写出一条 `session.v3.jsonl.zstd`。面板 API 的 `format` 与 `import_chat` 的 `format` 因此新增 `dsh4`。
- 来源与目标**都是 DSH 且代次不同**时，面板底部多一个反色的「**导入所选并归档旧会话 (N)**」按钮：按目标代次导入所选，导入成功后把对应的**源会话**在宿主里归档（宿主没有归档 API 时如实回报）。DSH 来源现在也列出导入产物目录（`import-<id>`），因此「把已导入的会话迁移到另一代次」这条路走得通。

### 体验优化

- 导入面板的来源下拉与会话行改用**官方品牌标**（商标归各自权利人）：18 个取自 @lobehub/icons（MIT），Reasonix / Continue / Zed 取自各自 GitHub 仓库，ChatGPT / MimoCode 用 lobehub 的 OpenAI / XiaomiMiMo 标。mark 按实测 ink 包围盒归一化后放进 16px 槽位、字标字面高统一——整列图标一样大、文字都从同一列起；手绘标只剩 3 份（WorkBuddy / TeleAgent / Crush）。
- 多选入口从「点行首来源标」改为「**点整行任意处**」：行首 22px 方图只作来源标识与选中态指示，行内导入 / 同步按钮仍只导入、不勾选。
- 来源列表把 **DSH 两项置顶**（紧随「全部来源」），排在 25 个外部来源之前。
- 幂等跳过不再静默：出现 `already-imported` 条目时面板浮出 Toast「已跳过 N 个可能已导入的对话」，点强调色动作「**忽略警告**」即以 `force: true` 重导这批（另铸新会话）。
- 导入后重扫不再闪空（旧列表留屏，新扫描首批到达时整批替换）；单条导入直接本地补状态、不触发重扫；列表按 `itemKey` 去重，同一会话不会再出现成对的两行、共享 hover。
- 「导入所选并归档旧会话」在窄面板下改用短标签（不再折行），完整标题留在悬停提示里；底部操作区恒贴底。

### 问题修复

- 修复 **0.19.0 引入的 DSH 会话正文丢失**：0.19.0 把 `.zstd` 解码改成 `node:zlib` 原生 zstd，但它**只解第一帧、其余静默丢弃**（截断帧也不报错）——宿主按「一条事件一次 flush」写日志，磁盘上的 `session.vN.jsonl.zstd` 是多帧拼接（本机实测一条 6.5MB 压缩 / 33MB 明文日志有 1962 帧），于是解出来只剩 `{"type":"session",…}` 一行 → 转换 0 轮 → 整份导入按 `skipped` 收场。现改回 `fzstd` 多帧解码（且对截断 / 畸形载荷抛错）；代价是同步解码，本机实测 129KB / 492KB 明文 30ms、6.8MB / 33MB 1.8s。
- 修复**面板 / `/import` / `/import-all` 导入 DSH 来源时「只归档旧会话、不建新会话」**：导入编排漏传转换器的读取钩子，`.zstd` 正文被当二进制读出；现在与工具层同口径透传 `readDshText`。归档也改为**只在导入成功后执行**（归档不可逆、宿主无取消归档面），未归档条数经响应 `archiveSkipped` 如实显示。
- 修复**面板导入后要刷新页面才看得到新会话**：默认目标等于宿主原生代次时，导入此前走只落盘、不进内存会话表的直写路径；现在改走宿主公开的 `agents.create`，新会话即时进列表且与正常会话一样可续聊。
- 修复 **V4 宿主读不回导入日志**：V4 退役 `source.kind = 'plugin'`，导入自产的上下文注入与 system head 写 V4 时按宿主规则改写为生产者自有 kind（`system-prompt` / `plugin:<name>`），V3 保持原样。实测通过宿主自己的 `assertReleasedV4Relationships` / `assertReleasedV4Header` / `assertV4RowAdmission`（13 行 0 失败）。
- 修复 **V3 导入的会话在 V4 宿主上打不开**（`system/message requires a protected first surface head`）：现在在首个 `step/start` 之后写一条空 `system/message` head，位置与形状对齐宿主自己的 v2→v3 迁移器。`verify_session` 新增 `system-head-missing` 点名 0.19.0 之前导入的存量会话，`force: true` 重导即可修复（head 必须是 surface 首事件，旧日志无法原地补写）。
- 导入会话的工具结果统一**闭合在调用所在 step 内**；无广告调用的**孤儿结果**与同一调用的**重复结果**丢弃并计数（`orphanToolResults` / `duplicateToolResults`，零值不占键）。此前这两类日志续聊被模型 API 拒绝，宿主升 V4 也会 fail-closed 拒载。
- 修复 **DSH 来源永远为空**：发现层此前把宿主已有会话一律隐藏，而 DSH 来源的条目本来就是宿主自己的会话日志；现对 DSH 来源不再隐藏。
- 修复 Antigravity 源的 **Windows 绝对工作目录被丢弃**（`C:\…` / `C:/…` 此前不算绝对路径），导入后不再因 header 缺 cwd 而挂载工作区失败。
- 修复**面板「DSH V4 会话格式」报「未知来源」**（面板的来源映射表漏了 `dsh4`）。
- 修复**重导时 registry 指向的会话已不存在**被静默跳过：现在点名 `staleRegistry` 并照常重建，幽灵记录不再静默。
- 修复**读 DSH 源日志时把本插件注入的环境变更声明当成提问 / 标题**（V3 与 V4 两种 source 形状都识别）。
- 修复**宿主没挂 settings 服务时插件 apply 失败**：导入偏好退回默认值，不再在 `settings.register` 上抛错。
- 修复深色主题下导入面板的**弹层透出背后列表**：下拉弹层与页码网格补上宿主菜单的背景模糊与官方投影，sticky 分组头与历史确认框改用不透明底色。

### 其他变更

- 宿主广告**未知的更高会话格式版本（V5+）**时，写盘前大声告警一次（仍按已知最高版本产出）：形状分支是「一版一支」，不假设 `>= 4` 都同形。
- **撤回 / 删除后重导不再自动发生**：`retract_import` 与清理（purge）现在写入永久墓碑，重导同一源返回 `ignored`；恢复用 `/unignore`。归档会话不再另铸后缀副本，归档即写 `archived` 墓碑（取消归档解除）。
- `lib/convert/core.mjs` 按提案拆分（958 → 186 行，回到停止线以内）：校验、形状契约、预算裁剪、事件合成分别拆到 `validate.mjs` / `shape.mjs` / `trim.mjs` / `events.mjs`，对既有 `from './core.mjs'` 引用零影响。

<h3 id="en-0.19.1">New Features</h3>

- Session reads and writes are split by the **host session format generation**: on a V3 host tool results are written as a `tool-result` wrapper inside a `role: 'user'` message, on V4 as a top-level `role: 'tool'` message; the read side (reverse export, verification, Markdown rendering) goes through one tool-result entry point and understands both shapes. An installed V3 host keeps producing exactly what it did before.
- `verify_session` gained three **V4 migration risk** checks — `unadvertised-tool-call` (a call with no advertising assistant content block), `cross-step-result` (a result closed outside its call's step) and `duplicate-tool-result` (more than one result for the same call). A V4 host refuses such logs wholesale; they can now be fixed with a `force: true` re-import before the upgrade.
- **Ignore (tombstone) table**: archiving a session, retracting/purging an import, or removing a workspace now auto-registers the affected sources as ignored, so rescans, `/import-all` and the automatic sync skip them; unarchiving clears the archive tombstone. New commands **`/ignores`**, **`/ignore <sessionId|sourcePath>`** and **`/unignore <sessionId|sourcePath|all>`**; `force: true` still imports once despite a tombstone without clearing it. The table lives at `$DSH_HOME/dsh-chat-import/ignores.json`; a damaged file degrades to an empty table without blocking imports.
- DSH is split into **V3 / V4 entries** on both the source and the "Import to" side: the sources "DSH V3 session format" (logs v0–v3) and "DSH V4 session format" (v4+) share `$DSH_HOME/sessions` and are separated by the generation in the log filename; the targets "DSH (V3 session format)" / "DSH (V4 session format)" **default to the detected host version**. The chosen generation drives both `header.version` and the event shape, so a V4 host can genuinely write a `session.v3.jsonl.zstd`. The panel API's `format` and `import_chat`'s `format` therefore gained `dsh4`.
- When **both the source and the target are DSH and their generations differ**, the bottom bar grows an inverted **"Import selected and archive old sessions (N)"** button: the selected sessions are imported in the target generation and each matching **source session** is archived in the host once its import succeeded (reported honestly when the host exposes no archive API). DSH sources now also list their import-product directories (`import-<id>`), so "migrate an already-imported session to the other generation" works.

### Improvements

- Source brand marks are now the **official** ones (trademarks belong to their owners): 18 from the @lobehub/icons static SVG package (MIT), Reasonix / Continue / Zed from their own GitHub repositories, ChatGPT / MimoCode from lobehub's OpenAI / XiaomiMiMo marks. Each mark's ink box is normalised into a 16px slot and every wordmark shares one cap height, so the column is one size and all text starts at the same x; only three hand-drawn marks remain (WorkBuddy / TeleAgent / Crush).
- Multi-select moved from the leading source mark to **the whole row**: the 22px square only names the source and shows selection state, and the per-row import / sync button still imports without toggling.
- The source list **pins the two DSH entries** right after "All sources", ahead of the 25 external sources.
- Idempotent skips are no longer silent: when `already-imported` entries appear the panel shows a toast "Skipped N possibly-already-imported conversation(s)" with an accent **"Ignore warning"** action that re-imports them with `force: true` (minting new sessions).
- Re-scanning after an import no longer flashes empty (the old list stays until the first batch of the new scan replaces it); a single import patches its row locally instead of triggering a rescan; the list de-duplicates by `itemKey`, so one session can no longer appear as a paired pair of rows sharing a hover.
- "Import selected and archive old sessions" falls back to a short label on a narrow panel (no more wrapping), with the full title in the tooltip; the bottom action bar always stays pinned to the bottom.

### Bug Fixes

- Fix the **DSH conversation body loss introduced in 0.19.0**: 0.19.0 switched `.zstd` decoding to `node:zlib`'s native zstd, which **decodes only the first frame and silently drops the rest** (not even a truncated frame errors). The host writes one frame per flushed event, so a `session.vN.jsonl.zstd` on disk is multi-frame (measured here: a 6.5 MB compressed / 33 MB plaintext log has 1962 frames) and only the `{"type":"session",…}` line survived — zero turns, so the whole import was reported `skipped`. Decoding is back on `fzstd` (multi-frame, and it throws on truncated/malformed payloads); the trade-off is synchronous decoding, measured here at 30 ms for 129 KB / 492 KB plaintext and 1.8 s for 6.8 MB / 33 MB.
- Fix **panel / `/import` / `/import-all` imports of DSH sources archiving the old sessions without creating new ones**: the import orchestration dropped the converter's read hook, so the `.zstd` bytes were read as binary text; it is now forwarded exactly as the tool layer does. Archiving also now happens **only after a successful import** (archiving is irreversible and the host has no unarchive API), and the number left unarchived is reported as `archiveSkipped`.
- Fix **imported sessions requiring a page refresh to appear**: when the default target equals the host's native generation the import used to write directly through a path that only lands bytes on disk and never enters the in-memory session table; it now goes through the host's public `agents.create`, so the new session appears immediately and stays continuable like a native one.
- Fix **V4 hosts refusing to read back imported logs**: V4 retires `source.kind = 'plugin'`, so the import's own context injection and system head are rewritten on the V4 write path to producer-owned kinds (`system-prompt` / `plugin:<name>`), while V3 is untouched. Verified against the host's own `assertReleasedV4Relationships` / `assertReleasedV4Header` / `assertV4RowAdmission` (13 rows, 0 failures).
- Fix **V3-imported sessions that a V4 host refuses to open** (`system/message requires a protected first surface head`): imports now write an empty `system/message` head right after the first `step/start`, matching the host's own v2→v3 migrator. `verify_session` gained a `system-head-missing` check that names sessions imported before 0.19.0; a `force: true` re-import fixes them (the head must be the first surface event, so an existing log cannot be repaired in place).
- Tool results are now closed **inside the step of their call**; **orphan results** (a transcript starting mid-conversation) and **duplicate results** for the same call are dropped and counted (`orphanToolResults` / `duplicateToolResults`, zero values take no key). Such logs used to be refused by the model API on continuation and fail-closed by the host's V4 migration.
- Fix **DSH sources being permanently empty**: discovery used to hide every session the host already had, but DSH sources *are* the host's own session logs; they are no longer hidden.
- Fix Antigravity's **Windows absolute working directory being dropped** (`C:\…` / `C:/…` were not treated as absolute), which made the workspace attach fail after import for lack of a header `cwd`.
- Fix the panel reporting **"unknown source" for "DSH V4 session format"** (the panel's source map was missing `dsh4`).
- Fix a re-import being silently skipped when **the registry's session no longer exists**: it is now reported as `staleRegistry` and rebuilt, so ghost records are no longer silent.
- Fix **reading a DSH source log mistaking the plugin's own environment-change note for a prompt / title** (recognised in both V3 and V4 source shapes).
- Fix the **plugin failing to apply when the host has no settings service**: import preferences fall back to their defaults instead of throwing in `settings.register`.
- Fix the import panel's dropdown **leaking the list behind it** in dark theme: the dropdown and page grid now carry the host menu's blur and official elevation, and the sticky group header / history dialog use an opaque surface.

### Chores

- When the host advertises an **unknown, newer session format version (V5+)**, the write path warns loudly once and emits the highest known shape: the shape branches are one-per-version and it does not assume everything from 4 on is the same.
- **Re-import after retract/delete no longer happens automatically**: `retract_import` and purge now write permanent tombstones and re-importing the same source reports `ignored`; use `/unignore` to lift. Archived sessions are no longer re-importable as a suffixed copy — archiving writes an `archived` tombstone (cleared by unarchiving).
- `lib/convert/core.mjs` was split as proposed (958 → 186 lines, back under the stop line): validation, shape contracts, budget trimming and event synthesis moved to `validate.mjs` / `shape.mjs` / `trim.mjs` / `events.mjs` with zero impact on existing `from './core.mjs'` imports.

**Full Changelog**: [v0.19.0...v0.19.1](https://github.com/Nwflower/dsh-chat-import/compare/v0.19.0...v0.19.1)

## [0.19.0] - 2026-09-21

[中文](#cn-0.19.0) | [English](#en-0.19.0)

<h3 id="cn-0.19.0">新增功能</h3>

- 会话发现支持「全部来源」流式加载：扫描结果按发现顺序逐条推入列表，首屏不再等全量扫描结束；扫描完成后一次性重排为最近活跃倒序。
- 导入面板新增**筛选：路径**（原工作区筛选，标签化）与**筛选：时间**（24 小时 / 7 天 / 30 天 / 不筛选，按最后活跃或创建时间过滤）。
- 分页档位改为 **500 / 2000 / 全部**（默认 500）：「全部」即不分页，10 万行实测 DOM 恒为 19 行 / 351 节点、悬停与勾选 0.6ms。
- 页码改成「第 x / y 页」控件，点开在底栏上方弹出**页码网格**（点数字直接跳页，页多时网格自滚动并停在当前页附近）。

### 体验优化

- 会话列表改为**窗口化渲染**：行高 28px + 行距 1px 与组头 34px 都是固定值，可见区间纯算术得出，只挂载可视区上下各一屏，其余用等高占位块撑住（滚动高度与 sticky 组头行为不变）。
- 会话行抽成 memo 组件、回调走 ref 转存、派生数据全部 `useMemo`：悬停或勾选一次只重建受影响的那一行；大档位下两处「每次渲染 O(n)」开销收敛，10 万行时一次悬停从 8ms 降到 0.6ms。
- 会话列表改成一行式，与皮肤的工作区列表同一套口径（行高 / 圆角 / 标题字号与配色一致）：行首来源工具标既是来源标识也是多选勾选位，右侧相对时间；上下文 / 分支 / 导入状态收进悬停提示，单条导入按钮悬停时才出现在时间位置。
- 扫描状态与分页条合并成列表下方一条：扫描中显示「已发现 N 个」，完成后显示页码与总数；总数不足一档时连「每页」选择器一起隐藏。
- 工具栏动作按钮的折叠判据改为「动作按钮组实测可用宽度」而不是面板宽度：用隐藏探针量出文字形态所需宽度再比对，文字形态不再折行（挤不下走省略号兜底）。
- 列表窗口化的上下余量从「±10 行」提高到「±一屏」，快滚不再露白。
- **发现层不再为消息条数整读**（面板已不展示该字段）：SQLite 源（opencode 系 / zcode / hermes）改走会话摘要读取器，只查 session 表加每会话一条「最近消息时间」聚合，不再逐会话读出 message/part 正文并逐 cell 解析——本机 zcode 单次同步阻塞 185ms → 1ms，正是面板卡顿的来源之一。
- DSH 会话的 `.zstd` 正文改走 **node:zlib 原生异步 zstd 解码**（libuv 线程池，Node < 22.15 自动回退 fzstd）：本机 60 个会话实测同步阻塞 3.8s → 异步 0.2s，事件循环不再被顶住。
- 发现层尾部读取（claude / kimi 的 context token）改为 chunks 数组滚动窗口：原实现每块都对整条尾串全量复制，大 transcript 的尾部读取开销主要在这块 memcpy。
- 本机实测（含 26 种来源、约 1.35 GB 数据）：冷扫描 5002ms → 1438ms，事件循环最大漂移 104ms → 0ms，书签命中重扫 375ms → 150ms。

### 问题修复

- 修复窄面板下工具栏按钮被压扁、文字折行的问题（折叠判据改用实测宽度，见上）。
- 修复快滚列表时偶发露白：窗口化余量由固定 10 行改为按视口高度计算。

### 其他变更

- 客户端 bundle 构建脚本改为**原子写** `lib/client.js`（同目录临时文件 + rename）：宿主按 stat 轮询该文件、一变就重新加载并按内容哈希发版（带一年 immutable 缓存），直接覆写会留出「读到半截 bundle」的窗口。另加 `--out=<path>` 供测量/实验构建写到 `lib/` 之外。
- `scan_discover` 输出条目与 schema 去掉 `messageCount`（面板已不展示；SQLite 摘要读取器同步不再产出该字段）。
- README 增补通过 GUI 导入的界面预览（亮 / 暗各一张），并新增 `screenshots.json` 商店截图清单。
- `package.json` 的 `files` 增补 `docs/*.png`，让 npm 页面上的 README 也能显示预览图。

<h3 id="en-0.19.0">New Features</h3>

- Streaming discovery for "All sources": scan results are appended in discovery order so the first screen no longer waits for the full scan; once the scan finishes the list is re-sorted by most-recent activity.
- Add **Filter: path** (the former workspace filter, now label-style) and **Filter: time** (24 hours / 7 days / 30 days / any time, by last activity or creation) to the import panel.
- Page sizes are now **500 / 2000 / All** (500 by default): "All" drops pagination — with 100k rows the DOM stays at 19 rows / 351 nodes, with 0.6ms hover and selection.
- The page number becomes a "Page x / y" control that opens a **page grid** above the status bar for one-click jumps; the grid scrolls on its own when there are many pages.

### Improvements

- The session list is now **windowed**: fixed row (28px + 1px gap) and group-header (34px) heights make the visible range pure arithmetic, so only the rows within one screen above and below the viewport are mounted and the rest are held by equal-height spacers (scroll height and sticky group headers unchanged).
- Session rows became memo components with ref-stashed callbacks and fully memoised derived data: a hover or a checkbox toggle rebuilds only the affected row; the two per-render O(n) costs on large tiers were removed, cutting a hover from 8ms to 0.6ms at 100k rows.
- Session rows became single-line and now follow the same metrics as the skin's workspace list (matching height, radius, title size and colours): the leading source mark is both the source label and the multi-select checkbox, the relative time sits on the right, and context / branch / import status moved into the hover tooltip, with the per-row import button appearing in the timestamp's place on hover.
- Scan progress and pagination merged into one status line under the list: it reports "N found" while scanning and page / total once done; below one full page the per-page selector is hidden too.
- Toolbar action buttons now collapse based on the **measured width available to the button group** instead of the panel width: a hidden probe measures the width the text form needs, so labels no longer wrap (they fall back to an ellipsis when truly out of room).
- The windowing overscan grew from "±10 rows" to "±one screen", so fast scrolling no longer flashes blank rows.
- **Discovery no longer reads whole SQLite transcripts just to count messages** (the panel no longer shows that field): opencode-family / zcode / hermes sources now use per-session summary readers that only query the session table plus one "latest message time" aggregate, instead of loading every message and part and parsing each cell — on this machine zcode's single blocking read dropped from 185ms to 1ms, one of the causes of panel jank.
- DSH `.zstd` session bodies now decode through **node:zlib's native async zstd** (libuv thread pool, with an automatic fzstd fallback on Node < 22.15): measured on this machine, 60 sessions went from 3.8s of synchronous blocking to 0.2s of async work, so the event loop is no longer stalled.
- Tail reads in discovery (claude / kimi context tokens) now use a chunk-array rolling window: the previous implementation copied the entire accumulated tail on every chunk, and that memcpy was the bulk of the cost on large transcripts.
- Measured on this machine (26 sources, ~1.35 GB of data): cold scan 5002ms → 1438ms, worst event-loop drift 104ms → 0ms, bookmark-hit rescan 375ms → 150ms.

### Bug Fixes

- Fix toolbar buttons being squeezed and their labels wrapping on a narrow panel (the collapse rule now uses a measured width, see above).
- Fix occasional blank rows while fast-scrolling: the windowing overscan is now computed from the viewport height instead of a fixed 10 rows.

### Chores

- The client bundle build script now writes `lib/client.js` **atomically** (same-directory temp file + rename): the host polls that file by stat, reloads whenever it changes and publishes by content hash with a one-year immutable cache, so a plain overwrite leaves a window where a half-written bundle is read. Added `--out=<path>` so measurement / experiment builds land outside `lib/`.
- `scan_discover` entries and schema no longer carry `messageCount` (the panel does not show it, and the SQLite summary readers stop producing it).
- README now includes GUI-import previews (one light, one dark) plus a `screenshots.json` store manifest.
- `package.json` `files` now includes `docs/*.png` so the previews also render on the npm page.

**Full Changelog**: [v0.18.5...v0.19.0](https://github.com/Nwflower/dsh-chat-import/compare/v0.18.5...v0.19.0)

## [0.18.5] - 2026-09-21

- 面板选择区改为一行读完「从 全部来源 导入到 DSH 会话环境」：来源与落点合到同一行、「从」与「导入到」当连接词，工作区另起一行；触发器只留文本（去掉下三角与品牌标，品牌 SVG 标只在下拉弹层行里显示），弹层统一对着这一行定位（行宽 = 弹层宽，窄面板也不会溢出）。
- 工作区下拉里在文件夹名之后用更淡的小字画出绝对路径（宽度不够先截断路径：主标签不参与收缩，文件夹名保持完整，只有它自己超过行宽时才截断；全文留在 title；搜索也匹配路径）；整份选项都没有品牌标时不再保留行首 16px 图标槽位，工作区列表的文字左移贴边。
- 下拉弹层高度改为自适应窗口：列表上限按「视口底部 − 弹层顶端」实测（原来写死 260px），来源列表一屏从 8 行提到近 20 行，短列表仍随内容收缩。
- 选择区只留一行；工作区筛选移到工具栏末位（与动作按钮分组，窄面板下不降级成图标），选择区上下高度提到与其他两层一致（三行统一 8px 12px 内边距）；工具栏去掉「已选 N」（底部主按钮「导入所选 (N)」已经承担）；三个下拉的边框改为与工具栏按钮同款（1px border-l2 + 8px 圆角），内边距收窄。
- 导入面板下拉控件按模型选择器式二级弹层重绘：触发器去掉输入框外观，hover / 展开时浮出一层背景矩形；弹层改为紧凑行（30px 行高、6px 行圆角、行首品牌标、当前项末尾 ✓），搜索框与列表之间加一条分隔线。来源 / 导入到 / 工作区三个下拉统一。
- 导入面板改版：导入按钮移到面板底缘（列表与分页之下），滚动时始终可见；来源 / 导入到 / 工作区三行之间不再画分隔线，三行合并为一组。
- 修复 Antigravity 导入崩溃（`The "path" argument must be of type string …`）：工具层旁读 annotation / 任务回执改为宿主 fs 目标对象契约（先 `resolve` 再 `readText`/`listDir`），单文件与批量导入不再全灭。
- Antigravity 发现迁移到新版存储根 `~/.gemini/antigravity`，旧 CLI 根 `~/.gemini/antigravity-cli` 与 IDE 根 `~/.gemini/antigravity-ide` 继续并扫；`.db`/`.pb` 会话文件按会话 id 去重发现。
- Antigravity 目录批量只收集 canonical `transcript.jsonl`，不再把 `transcript_full.jsonl` 等伴生日志当作独立会话。

## [0.18.4] - 2026-09-20

- 环境变更提示改到首个 `step/start` 之后：旧格式（v0–v2）导入会话不再因宿主 v2→v3 格式迁移被拒载（surface 事件早于首个 step 的形状会被迁移器 fail-closed 拒绝）。
- `verify_session` 新增 `surface-before-first-step` 检查与重导提示：存量旧格式会话被点名，不再等宿主迁移时才暴露。
- 增量续写不再重复注入环境变更提示。
- Kimi Code 缺少 `state.json` 时保留工作区归属。
- 失效旧版 scan-cache，修复 Grok Build 工作区名仍显示 %XX。
- 导入面板图标选中态遮罩按强调色明度选黑/白。

## [0.18.3] - 2026-09-18

- 接入官方原生右侧栏，移除旧版右侧栏与自绘 ShellPanel 回落链。
- 修复 SQLite WAL 盲区与 DB 指纹短路径。
- 修复 `warmProjection` 宿主三参契约调用。
- 用 npm 10 重新生成 lockfile，修复 CI `npm ci` 依赖树漂移。
- Grok Build 工作区列不再显示 %XX 编码乱码。
- 去 AI 化清理：删除未消费层、统一文档计数、移除内部编号。

## [0.18.2] - 2026-09-17

- 修复 ChatGPT 官方导出静默丢弃：兼容缺失 children、占位 root、浮点时间戳。
- `verify_session` 增加非整数时间检查。

## [0.18.1] - 2026-09-17

- 新增 TeleAgent 来源。
- 数据库类批量来源的会话标题统一为「来源 · 话题」。

## [0.18.0] - 2026-09-17

- 面板新增「导入到」下拉：直投 Claude Code / Codex / Kimi Code / opencode。
- 新增 opencode 反向导出。

## [0.17.3] - 2026-09-17

- 修复 Codex 分页链扫描按 thread 过滤。
- 支持 Kimi 新版 `state.json` 的 `workDir` 字段。
- 清理/重导支持带下划线会话 ID。

## [0.17.1] - 2026-09-16

- 修复 Codex 分页 rollout 按 thread 成链导入。

## [0.17.0] - 2026-09-15

- 新增 Crush 来源。

## [0.16.0] - 2026-09-15

- 新增 Zed Agent 来源。

## [0.15.0] - 2026-09-15

- 新增 Goose 来源。

## [0.14.0] - 2026-09-15

- 新增 Cline 来源。

## [0.13.0] - 2026-09-15

- 新增 Continue 来源。

## [0.12.x] - 2026-09-15

- 继续完善来源支持、面板与同步能力；详细历史见 git。

## [0.11.x] - 2026-09-07 ~ 2026-09-15

- 继续新增来源、面板、导出与同步能力；详细历史见 git。

## [0.10.x] - 2026-09-06 ~ 2026-09-07

- 持续完善导入、发现与导出能力；详细历史见 git。

## [0.9.x] - 2026-09-04 ~ 2026-09-06

- 继续完善工具面与文档；详细历史见 git。

## [0.8.x] - 2026-08-26 ~ 2026-09-01

- 新增增量续写、扫描缓存、标题兜底、上下文桥接等能力；详细历史见 git。

## [0.7.x] - 2026-08-23

- 继续完善导入能力与工程基建；详细历史见 git。

## [0.6.x] - 2026-08-17 ~ 2026-08-19

- 继续完善来源支持与互转能力；详细历史见 git。

## [0.5.x] - 2026-08-16

- 继续完善导入与发布流程；详细历史见 git。

## [0.4.0] - 2026-08-16

- 发布规范达标，完善插件元数据与工程配置。

## [0.3.x] - 2026-08-14

- 完善仓库社区健康与工程规范。

## [0.2.0] - 2026-08-14

- 收口版本漂移，补齐 Reasonix/opencode 等能力。

## [0.1.x] - 2026-08-13 ~ 2026-08-14

- 首个发布版本，支持早期外部 Agent 会话导入。
