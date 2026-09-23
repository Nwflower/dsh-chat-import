# Changelog

All notable changes to `dsh-chat-import` are documented here, newest first.

## [Unreleased]

[中文](#cn-unreleased) | [English](#en-unreleased)

<h3 id="cn-unreleased">问题修复</h3>

- 修复**已归档并删除的会话在导入面板显示「同步」而非「导入」**：`resolveImportStatus` 只看 imports registry 记录与归档集，不看宿主里该会话是否还在——会话被删除后 registry 记录仍在、归档集也已清掉，于是被判成「已导入」→ 面板显示「同步」，可会话没了无从同步、也无法重新导入。现在把宿主持久化会话 id 集合（`persistedIds`，发现层本就传入）一并交给状态判定：记录指向的会话**已不在宿主** → `not-imported`（显示「导入」，重导走 `decideItem` 的 `staleRegistry` 重建路径）；**已删除优先于已归档**（归档后又被删除同样是 `not-imported`）。本机实测：96 条「registry 有记录、磁盘上没有会话」的条目从 `imported` 纠正为 `not-imported`。
- 修复 **0.1.7 上设置页不可用**：0.1.7 把插件设置从 `settings.section`（设置页「每功能一页」）搬到「设置 → 插件」的插件页（`plugins.bundle.config` 槽，键 = 包名），值走客户端服务 `configForms`（命名空间 = profile 条目 id，控制器带值 + 写队列 + revision 栅栏）。插件此前只注册旧席位、只走自建 fenced 路由，于是新宿主上设置页看不到、改不动。现在按宿主世代分流（对齐 dsh-claude-style）：`configForms` 在场 → 注册 `plugins.bundle.config`（键 `dsh-chat-import`）并逐字段 `set()` 读写；缺席 → 保留 `settings.section` 整页与 `/api-import/prefs` 路由。两处席位互斥注册，避免同一设置在两处各长一份。（补充：浏览器 boot 给插件条目的是**随机 id**，所以命名空间从 configForms 已服务的名单里挑，挑不到才用 patch 声明的 `import-claude`；官方表单没 ready 或被拒时回落 fenced 路由——这正是「选项显示但存不进去」的修复。）

<h3 id="en-unreleased">Bug Fixes</h3>

- Fix **archived-then-deleted sessions showing as "Sync" instead of "Import" in the import panel**: `resolveImportStatus` looked only at the imports registry record and the archive set, never at whether the session still exists in the host — after a delete the registry record remained while the archive set was already cleared, so the row was judged "imported" and showed **Sync**, even though a deleted session cannot be synced and could not be re-imported. The host's persisted session id set (`persistedIds`, already passed into discovery) now feeds the status: a record whose session is **no longer in the host** → `not-imported` (the panel shows **Import**, and a re-import takes `decideItem`'s `staleRegistry` rebuild path); **deleted takes precedence over archived** (archived-then-deleted is `not-imported` too). Measured on this machine: 96 entries with "a registry record but no session on disk" were corrected from `imported` to `not-imported`.
- Fix **the settings page being unusable on 0.1.7**: 0.1.7 moved plugin settings from `settings.section` (the Settings page's "one page per feature") to the plugin page under "Settings → Plugins" (the `plugins.bundle.config` slot, keyed by package name), with values served through the client `configForms` service (namespace = profile entry id; the controller carries the value, a write queue and a revision fence). The plugin only registered the old seat and only used its own fenced route, so on the new host the settings were neither visible nor writable. It now splits by host generation (matching dsh-claude-style): with `configForms` present it registers `plugins.bundle.config` (key `dsh-chat-import`) and reads/writes field-by-field through `set()`; without it the `settings.section` full page and the `/api-import/prefs` route are kept. The two seats register exclusively, so one setting never grows a copy in two places. (Note: the browser boot assigns plugin entries a generated id, so the namespace is picked from the namespaces `configForms` already serves, falling back to the patch-declared `import-claude`; when the official form is not ready or refuses, the fenced route takes over — that is the fix for "options show but cannot be saved".)

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
