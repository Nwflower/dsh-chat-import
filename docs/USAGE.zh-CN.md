# 使用详解

> 从 README 迁出的完整工具/命令用法。快速上手见 README「使用」一节。

## 🛠 使用

> **首次迁移分步流程**（与 [dsh-movein 首次迁移指南](https://github.com/sjh9714/dsh-movein/blob/main/docs/first-migration.zh.md) 的叙事对齐；其管配置，本插件管会话历史，可按需只用其一）：
> ① **预览** - `scan_discover()` 或侧边栏面板查看可导入会话与导入状态徽标；或任一 `import_*` 传 `preview: true` 零副作用试跑。
> ② **导入** - 去掉 `preview` 正式导入，按来源 / 工作区核对逐会话 `status`（重复导入行为见下文「重导同一源」）。
> ③ **体检与撤回** - `doctor()` 只读体检；`retract_import` 撤回 registry 记录，或面板「历史」页删除本插件创建的会话（需确认）。

> **注意**：导入会即时落盘。当目标代次等于宿主原生代次（面板「导入到」的默认项）时，新会话会即时出现在会话列表，无需刷新；只有显式选择非原生代次（如在 V4 宿主上产出 V3 日志）时，该代次不是宿主当前的内存形状，需刷新页面后才可见。

**导入——单个文件或目录。** 每个 `import_*` 工具都接受 `path`；目录递归扫描，每个文件 / 每段对话成为独立会话：

```
import_claude({ path: "C:\Users\<you>\.claude\projects\<slug>\<sessionId>.jsonl" })
import_codex({ path: "C:\Users\<you>\.codex\sessions\2026\05\18\rollout-2026-05-18T21-14-16-xxxx.jsonl" })
import_chatgpt({ path: "C:\Users\<you>\Downloads\chatgpt-export\conversations.json" })
import_opencode({ path: "C:\Users\<you>\.local\share\opencode\opencode.db" })
import_kilocode({ path: "C:\Users\<you>\.local\share\kilo\kilo.db" })
import_teleagent({ path: "C:\Users\<you>\.local\share\TeleAgent\users\<account>\teleagent.db" })
import_local_jsonl({ path: "D:\downloads\session.jsonl" })
```

`import_local_jsonl({ path })` 接受任意本地 `.jsonl` 会话文件（或目录）：自动识别 `dsh` / `claude` / `codex` / `cursor` / `reasonix` / `pi` / `openclaw` / `hermes`，识别不准时可用 `format` 参数强制指定：

```
import_local_jsonl({ path: "D:\downloads\session.jsonl" })
import_local_jsonl({ path: "D:\downloads\unknown.jsonl", format: "claude" })
```

`import_chatgpt` / `import_opencode` / `import_kilocode` / `import_teleagent` / `import_zcode` / `import_hermes` 恒返回批量结果——一个文件 / 数据库包含全部会话，一次调用即可让每段对话成为独立会话。`import_teleagent` 也接受 `users/` 多账户目录（逐账户枚举 `<账户>/teleagent.db`）或 `TeleAgent/` 数据根。

<details>
<summary><b>导入参数与行为</b></summary>

- `preview: true`（别名 `dryRun: true`）— **只读**运行：照常解析 / 读取 / 转换，但**零副作用**、不落盘。去掉该参数再调一次即正式导入。
- **图片落成宿主附件** — 源转录里的图片不再只留 `[image]` 文本占位：转换层把图片字节放进中间结构，落盘前经宿主附件服务（`ctx.attachments`）存成不可变对象，会话日志里只留 `attachmentId` 引用（**base64 永不进日志**）。结果里 `images: <N>` 是落成附件的张数；`imagesDegraded: <M>` 是拿不到字节、仍以 `[image]` 占位导入的张数（宿主没有附件服务 / 类型不收（只收 PNG/JPEG/WebP/GIF）/ 单会话超过 500 张 / 源只给了引用如 Kimi 的 `blobref:`）。导出方向对称：`export_claude` / `export_codex` 会把引用读回 base64 写进目标格式，读不回时计入 `degradations` 的 `attachment-skipped`。`storeImages: false`（或环境变量 `DSH_IMPORT_STORE_IMAGES=0`）可只留占位、不写附件存储——图片是唯一会明显增大宿主持久存储的导入面。
- `force: true` — 即使已导入，也以新 id（`import-<sessionId>-<n>`）另存一份**完整副本**；旧会话绝不修改（重导语义的完整说明见下文「重导同一源」）。
- `sessionId`（可选）— 覆盖目标 DSH 会话 id（默认 `import-<源sessionId>`）。
- `import_chatgpt({ branch: 'all' })` — 把对话 DAG 的**每条 root→leaf 分支**还原为独立会话（主线程仍是最后 child 链；分支会话带后缀源 id 与分支标记标题）。导出里的工具消息还原为真正的 `tool/call` + `tool/result`（结构化 JSON 参数、FIFO 配对），不再是纯文本。
- **上下文压缩 → DSH 原生压缩事件** — 源码工具的上下文压缩（Claude Code 的 `compact_boundary` / `isCompactSummary` user 记录与旧格式 `summary` 记录、Codex 的 `compacted` 信封、Pi 的 `compaction` 条目、opencode 的 `compaction` part + 摘要消息、Kimi 的 `context.apply_compaction`、Zed 的 `Compaction` 消息、Crush 的 `is_summary_message`、Continue 的 `conversationSummary`、zcode 的 `compaction` part + `compactBoundary`、Cline 的 `<id>.compaction.json` 压缩侧车、Grok Build 的 `compaction_meta` 交接摘要）导入为 **DSH 原生压缩检查点**：日志照常保留**全量历史**（可回溯、可导出），同时在压缩边界发射一次原生 `compaction/start → compaction/summary → 检查点 user/message → compaction/end` 事务。模型的投影因此是「摘要检查点 + 压缩点之后的对话」，与源工具压缩后的真实上下文一致，压缩前的对话不再进模型上下文、也不会被预算裁剪吃掉（受遮蔽轮不计预算、不裁剪、不丢弃）。一次会话压缩多次就发多个检查点（链式遮蔽）。导入结果带 `compacted: true` 与 `compactions: <N>`（检查点数）。**重导 DSH 会话时也原样保留**源日志里的压缩事务（`import_chat({ format: 'dsh' | 'dsh4' })` 往返不丢检查点，V3/V4 的 `plugin:compact` 生产者标记双向归一）。压缩点之前没有可遮蔽内容（或源只有边界、没有摘要正文：Kimi 旧格式 wire）时发不出检查点——摘要退回既有形态（reasoning 块／可见文本）或按切窗口处理，并显式上报 `compactionSummaryMissing: true`，绝不虚构摘要。`fullHistory: true` 时不发检查点（模型看到全量历史）——该开关进参数指纹，换值须重导。
- `import_claude({ compacted: true })` — 历史参数（兼容别名）：Claude 的压缩导入自本版本起**默认即为原生压缩检查点**，无需该参数。
- `import_codex({ fullHistory: true })` — Codex rollout 的上下文压缩默认导入为原生压缩检查点（`compacted` 信封的交接摘要进检查点，跨压缩点那一轮一分为二：边界前 log-only、边界后可见）；`fullHistory: true` 导全量、不发检查点。Codex 子代理 rollout 不是独立会话，始终跳过并给出原因。
- `import_hermes({ lineage: 'tail' })` — 只导**叶子链尾**（不是任何其它会话父会话的会话）；压缩分叉父会话跳过并标注。
- `import_chat({ format: 'reasonix', path: '<sessions 目录>' })` — 目录导入默认使用 `lineageMode: 'canonical'`。只有现代 sidecar 把两个文件归入同一逻辑话题、无歧义的 `parent_id` 链明确证明祖先关系，而且祖先的完整语义消息序列是更长后代的真前缀时，才折叠恢复祖先。畸形输入、带 WAL 的检查点、完全相同副本、谱系链缺失及真实分叉叶全部保留。此模式不会替 Reasonix catalog 选择唯一活动叶；真实分支继续独立存在。`lineageMode: 'physical'` 可恢复每个 JSONL 一条会话。
- **归档 / 删除 / 删工作区 → 自动忽略（不再重导）** — 归档会话写入忽略墓碑，取消归档自动解除。撤回 / 删除（retract / 清理）写入**永久**墓碑，重扫与 `/import-all` 一律跳过它。DSH 的归档仍保留会话与 id，但被忽略的源不再被当作「可重导」。删工作区会忽略**删除时**其名下已导入的会话，并登记工作区忽略——该工作区出现**新会话**或其中会话**取消归档**时自动恢复工作区（更早的墓碑保留）。查看与解除：`/ignores`、`/unignore <sessionId|sourcePath|all>`；`force: true` 可显式越权导入一次（不解除墓碑）。
- **重导同一源** — 绝不改写已导入历史，按「DSH 侧这条会话还是不是导入时写下的样子」分三种情形：
  - 源文件未变 → 跳过（`already-imported`，不重读）；
  - 源文件增长，且你**没有**在 DSH 里聊过这条会话 → 只把**新增轮次** append 进同一会话（`appended`）；
  - 源文件增长，但你**已经**在 DSH 里聊过它 → 另建一份**新副本**（`reimported.reason: 'continued-in-dsh'`），不往你自己的对话里追加；两条会话都保留。截断的文件检测并上报后跳过（`sourceShrunk` / `storedShrunk`）；基线字段出现之前的旧记录保守另建一次副本（`reason: 'baseline-missing'`）。`force: true` 恒以新 id 另存完整副本。

```
import_claude({ path: "C:\Users\<you>\.claude\projects\<slug>\<sessionId>.jsonl" })
// 未变化 → "already-imported" · 增长且未续聊 → "appended"（只追加新轮次）
// 增长且你已在 DSH 续聊 → 新建副本，原会话一字不改
```

</details>

每次导入结果都会上报 `status` 与任何异常——畸形行、疑似敏感信息、逐源丢弃——绝不静默吞掉。

### import_agents — 把 pi/opencode/Claude/Codex 的 agent、prompt、skill、指令与配置参考转换为 DSH skills

`import_agents` 把 **pi**（`~/.pi/agent/{agents,prompts}/*.md`）、**opencode**（`~/.config/opencode/{agents,skill}/*.md`）、**Claude**（`~/.claude/memory/<group>/*.md`、`~/.claude/skills/<skill>/SKILL.md`，或经 `claudeProjectRoot` 显式指定的项目根 `CLAUDE.md`）与 **Codex**（`~/.codex/skills/<skill>/SKILL.md`、`~/.codex/instructions.md`、`~/.codex/AGENTS.md`、`~/.codex/config.toml`）的自定义 agent、mode prompt、skill、指令与配置参考转换为**持久化 DSH skill 资产**——`$DSH_AGENTS_HOME/skills/<name>/SKILL.md`（`$DSH_AGENTS_HOME` 缺省 `~/.agents`），成为任意会话里可发现的技能。这与运行时只读的 Claude 桥（`context-bridge`，默认关）互补：后者把 Claude 的 memory/CLAUDE.md/skills 临时注入；本工具把 pi/opencode/Claude/Codex 资产持久落盘。

默认 **dry-run**（只返回 write/complete/skip 规划清单，零副作用）；传 `apply: true` 才真正写盘：

```
import_agents()                    // dry-run：仅规划
import_agents({ apply: true })     // 写入 $DSH_AGENTS_HOME/skills/<name>/SKILL.md
import_agents({ codexRoot: "~/.codex", apply: true })  // 显式包含 Codex 资产
```

语义：跨源同名冲突加 `-<source>` 后缀消歧（如 `-pi` / `-opencode` / `-codex`）；内容相同幂等跳过；已带 `kind: dsh`/`kind: skill` frontmatter 的源不重复导入；bundle 目录缺 `SKILL.md` 时原地补全（保留既有 `scripts/` 等）；嵌套 YAML（如 `permission:`）原样保留。

定位说明：`import_agents` 只做轻量资产落盘，不覆盖 hooks、权限规则或 settings 等完整配置迁移--后者见 [dsh-movein](https://github.com/sjh9714/dsh-movein)（与本插件分工互补，组合流程未联合验证）。

### scan_discover — 只读会话发现

`scan_discover` 扫描全部已支持格式的已知数据根（包括 Cline 新版 sessions 与 VS Code globalStorage 旧版任务，以及 Windows 上的 Reasonix 桌面版与 Claude-3p 根），返回结构化会话索引（标题、项目、cwd、路径、导入状态，源目录为 git 仓库时附分支/dirty），供批导入前预览。VS Code 使用非标准 globalStorage 路径时可设置 `CLINE_LEGACY_GLOBAL_STORAGE_DIR`；Grok Build 的默认根 `~/.grok` 可用 `GROK_HOME` 覆盖。零副作用：

```
scan_discover()
scan_discover({ path: "~/.codex/sessions", format: "codex", query: "import" })
```

### list_imported_sessions & retract_import — 识别与撤回

`list_imported_sessions()` 枚举本插件已导入的全部 DSH 会话；`retract_import({ sessionId })`（或 `sourcePath`）移除其 registry 记录并返回手动删除引导。**只识别 + 引导手动删，绝不执行任何删除**：

```
list_imported_sessions()
retract_import({ sessionId: "import-019f5f27-…" })
```

> **撤回后的幽灵会话** — DSH 宿主没有 delete/forget 面：`retract_import` 并手动删除工件后，会话 id 仍可能占据宿主内存索引（会话列表里可见、直到重启 dsh 才消失），同源重导此前会报 `session "…" already exists in this backend`。现已自愈：重导检测到陈旧条目（list 仍暴露但日志不可读，或 create 拒绝该 id）时**自动另铸后缀新 id**（`import-<id>-1`）完整重导并报告 `staleGhost: { previous, current }`，不再失败；`retract_import` 的 `manualDelete` 引导也注明幽灵会话需重启 dsh 才彻底消失。

### export_chat — DSH → Claude / Codex / Kimi / opencode（矩阵导出）

`export_chat({ format: "claude", sessionId })` 把现有 DSH 会话（导入的或原生的）序列化为 Claude Code JSONL transcript，可直接 `--resume`。文件写到 `<outputDir>/<slug>/<uuid>.jsonl`（默认 `~/.claude/projects`），文件名是全新 UUID v4——绝不覆盖已有文件。`format: "codex"` / `format: "kimi"` 分别写 Codex rollout JSONL 与 Kimi `wire.jsonl`；`format: "opencode"` 写 `opencode import <文件>` 能吃下的 JSON 文档（会话 info + messages + parts，id 前缀 `ses` / `msg` / `prt` 是 opencode 解码器的硬要求）。后三者默认写 `~/.dsh/exports`，或用 `path: …` 指定目标——补齐 DSH↔Claude↔Codex↔Kimi↔opencode 矩阵（导入边已存在）。每次导出在 `degradations` 字段里逐条列出**有损项**（孤儿工具结果 / 注入跳过 / 附件跳过，opencode 另有 `usage-unknown`：它要求 `cost`/`tokens` 而 DSH 会话日志没有用量计数，故写 0 并上报）——绝不静默丢弃：

```
export_chat({ format: "claude", sessionId: "import-019f5f27-…" })
export_chat({ format: "codex", sessionId: "…", dryRun: true })
export_chat({ format: "kimi", sessionId: "…", outputDir: "D:\backup\kimi" })
export_chat({ format: "opencode", sessionId: "…" })   // → ~/.dsh/exports/<id>.opencode.json，随后：opencode import <文件>
```

### export_bundle / restore_bundle — 便携 interchange bundle

`export_bundle({ sessionId })` 写出 **`.dshbundle.json`**——事件级无损的 interchange bundle（协议见 [docs/INTERCHANGE.md](INTERCHANGE.md)），带双重 SHA-256 指纹（会话级 + 文件级）与机器无关的落点信息（`originalCwd` + `landingHint`）。`restore_bundle({ path })` 先校验指纹（损坏大声报告、绝不静默还原），再经同一幂等状态机导入——重复还原跳过、`force: true` 另存副本、目录模式逐个还原 `.dshbundle.json`：

```
export_bundle({ sessionId: "import-019f5f27-…" })                    // → ~/.dsh/exports/<id>.dshbundle.json
restore_bundle({ path: "D:\backup\sess.dshbundle.json" })            // A 机导出 → B 机还原
restore_bundle({ path: "D:\backup\bundle-dir", preview: true })      // dry-run
```

**跨机器：** A 机导出 → 拷贝 bundle → B 机还原。原 `cwd` 在 B 机不可达时，会话回退归到 bundle 文件所在目录，结果报告 `cwdAvailable: false` / `groupedTo` / `restoreNote`——绝不静默。

### verify_session — 只读结构审计

`verify_session({ sessionId })` 对任意 DSH 会话做只读结构校验：seq 连续、事件类型白名单、surface 事件带 `surfaceOp`、`sourceEventSeqs` 指向真实 `tool/call`、surface 事件不早于首个 `step/start`、turn/step 平衡、工具调用↔结果配对。问题逐条定位（kind + seq + message），并按 kind 给出 `repairHints`（`force` 重导 / 闭合半开轮 / 源转录中途开始的边界说明）：

```
verify_session({ sessionId: "import-019f5f27-…" })
```

> 环境变更提示注入在首个 `step/start` 之后（`turn/start → step/start → 提示 → 该轮提问`）。它仍是模型看到的第一条消息，但日志里没有任何 surface 事件早于第一个 step——旧格式（v0–v2）日志若把提示写在首个 step 之前，宿主做 v2→v3 格式迁移时会 fail-closed 拒载（`surface before first step cannot acquire a system head`），会话打不开、导出/校验也读不到。`verify_session` 会以 `surface-before-first-step` 点名这类存量会话，用 `force: true` 重导（或面板「刷新已导入」）即可按新注入位重写。
>
> 导入会话的日志以一条**空 `system/message` head** 开头（第一个 `step/start` 之后、任何其它 surface 事件之前）。宿主的 v3→v4 迁移要求 surface 的第一个事件是 `system/message`（protected head），否则宿主续聊写自己的系统提示词时整份日志被拒载（`system/message requires a protected first surface head`），由它 seed 出来的续聊会话同样打不开。`verify_session` 会以 `system-head-missing` 点名这类存量会话（0.20.0 之前导入的），用 `force: true` 重导即可拿到带 head 的新会话——head 必须是 surface 首事件，旧日志无法原地补写。

### doctor — 只读迁移健康检查

`doctor()` 做一次只读迁移后体检：imports registry 是否可读、每个已导入会话是否仍存在于 `sessionPersistence`、`import_agents` 的 skills 是否落盘、`workspaceRegistry` 是否可用，以及宿主会话目录里是否残留着宿主已读不出的 `import-*` 目录（它们仍占用会话 id，重导只能另建带后缀的副本）。绝不写文件、不导入、不同步、不删除：

```
doctor()
```

返回 `{ ok, checks, issues, totals }`——适合大批量导入后，或 DSH 数据跨机器搬运前后使用。

### 独立 CLI — export-md / doctor

npm 包还附带一个小的独立 CLI（无需启动 DSH）：

```
npx dsh-chat-import export-md ~/.dsh/sessions/<workspace>/<session>/session.jsonl
npx dsh-chat-import export-md <会话目录> --out session.md
npx dsh-chat-import doctor
```

`export-md` 把 DSH 会话日志渲染为可读 Markdown（会话头、标题、user/assistant 文本、thinking、工具调用与结果）。会话根随宿主的 `DSH_HOME` 走（桌面端为 `%APPDATA%\dsh-desktop\harness`；未设置时为 `~/.dsh`，如独立 CLI 场景）。`doctor` 读取 `$DSH_HOME/dsh-chat-import/imports.json` 与本地 `sessions` 树，做轻量健康汇总。

### import_mcp — MCP 镜像计划

`import_mcp` 从 **Claude**（`~/.claude.json` / `.mcp.json`）与 **Codex**（`~/.codex/config.toml`）读取 MCP server，并生成可人工审阅的 **DSH MCP client YAML 片段**。默认 dry-run；`apply: true` 把片段写到 `$DSH_HOME/dsh-chat-import/mcp-mirror.cordis.yml`（或 `outPath`）——绝不自动改 profile：

```
import_mcp()                                  // dry-run：列出 server + YAML 片段
import_mcp({ apply: true })                   // 写盘生成片段
/mcp-status                                   // 列出发现的 server
```

### import_settings — settings/config 翻译建议

`import_settings` 读取 **Claude `~/.claude/settings.json`** 与 **Codex `~/.codex/config.toml`**，返回迁移到 DSH 的建议：模型绑定、权限规则、hooks、环境变量、模型 provider。只读，绝不自动应用：

```
import_settings()                             // 列出建议
/settings-suggest                             // 斜杠命令同款
```

### 浏览器面板 — 侧边栏发现与导入

dsh web 的左侧栏底部有唯一一个「导入会话」入口：**导入会话**按钮（样式对齐「设置」入口、图标用插件 logo；`sidebar.footer.action` 槽条目，与同槽其它条目共享那条 footer 行。同槽出现整宽条目——插件徽标、费用卡之类——时整行改为换行堆叠，各条目各占一整行；只是与更窄的入口抢同一行、放不下文字时，入口缩成 36×36 圆钮，文字保留在 tooltip / aria-label 里。两种情况下都不会被截断或遮挡）。插件**要求 dsh ≥ 0.1.5-rc.1**（`peerDependencies` 已抬门槛）：导入窗口**停靠进官方原生右侧栏**——插件在右侧栏注册「导入会话」tab 类型（guide 页有带图标 / 标题 / 一行描述的胶囊），点按钮即通过 `sidebarRight.openTab('chat-import')` 打开该 tab、中间的对话区保留。无回落链：没有官方右侧栏的老版本不再受客户端支持。窗口内**按工作区文件夹分组**列出发现的会话（各来源记录里的 `cwd`/项目名，缺省归入「(未分组)」），支持来源过滤——「全部来源」扫描全部格式的默认数据根，单选来源则只看该格式——每行只显示来源工具标、标题与相对时间（上下文 / 分支 / 导入状态收进悬停提示）；**点这一行的任意处即勾选**（键盘聚焦后用 Enter / 空格），行首工具标只作来源标识与选中态指示（选中时叠遮罩与勾），不再需要瞄准 22px 的方图；行内导入按钮是唯一例外，点它只执行导入、不会连带勾选；单条导入按钮默认隐藏，悬停（或键盘聚焦）该行时出现在时间的位置。搜索框按标题 / 工作区 / 路径过滤，列表**分页**展示（每页 500 / 2000 / **全部** 可选，默认 500；列表只挂载可视区那十几行，档位大小不影响渲染开销；选「全部」即不分页），跨页选择保留便于批量操作。扫描进度与分页信息合并在列表下方同一条状态栏：扫描中显示「已发现 N 个」，完成后显示页码与总数。

每行支持**单选导入**，复选框支持**多选导入**（「导入所选 (N)」）：面板调用与 `import_*` 工具完全相同的 host 导入管线，重导语义（未变跳过 / 未续聊续写 / 已续聊新建副本）/ force / 上下文预算语义完全一致；导入后自动刷新列表展示最新状态。多会话源（如 `conversations.json`、opencode/zcode/hermes 库）整源导入——opencode/zcode 只导所选 `sessionId`。

面板顶部一行读作「**从** <来源> **导入到** <落点>」：左边选来源、右边选落点（品牌标只在下拉弹层里显示，触发器只留文本；来源行直接画该工具的官方品牌锁标——品牌标 + 字标，取自 @lobehub/icons，没有官方标的来源退回白卡标 + 文本）。搜索框按标题 / 工作区 / 路径过滤；工具栏末位是**两个筛选按钮**——「筛选：路径」（按工作区目录过滤，下拉带检索与路径副标题）与「筛选：时间」（24 小时 / 7 天 / 30 天 / 不筛选，四项短菜单不带检索框），两者都保持文字、窄面板下整体换行；已选条数只在底部主按钮「导入所选 (N)」上显示。列表下方是同一条状态栏：翻页只留左右图标（不套框），页码是「第 x / y 页」控件——点开在栏上方弹出**页码网格**，点数字直接跳页；只有一页（总数不足一档，默认档为 500）时整组不显示；总数不足 500 时连「每页」选择器一起隐藏，只剩总数。右侧是每页 500 / 2000 / 全部。

| 选择 | 行为 |
| --- | --- |
| **DSH（V3 会话格式）** | 建一条可继续的 DSH 会话，会话日志按 **V3 代次**落盘（`session.v3.jsonl.zstd`）；header 的 `version` 与事件形状一起按 V3 产出，所以 V4 宿主上也能真写出 V3 日志。 |
| **DSH（V4 会话格式）** | 同上，按 **V4 代次**落盘。**默认项跟随探测到的宿主版本**（V4 宿主默认选它）。 |
| Claude Code | 转换后写进 `~/.claude/projects/<slug>/<uuid>.jsonl`；Claude Code 直接读该目录（`claude --resume` 打开）。 |
| Codex / Kimi Code | 分别写成 Codex rollout JSONL / Kimi `wire.jsonl` 落到 `~/.dsh/exports/`，由你放进对应工具的 sessions 目录。 |
| opencode | 写成 opencode JSON 落到 `~/.dsh/exports/`，随后用 `opencode import <文件>` 导入。 |

来源与落点**都是 DSH 且代次不同**（V3 ↔ V4）时，底部会多出一个主按钮「**导入所选并归档旧会话 (N)**」：所选会话按目标代次导入，**导入成功**后把对应的**源会话**在宿主里归档（迁移的收尾）。归档是不可逆的隐藏动作（宿主没有取消归档面），所以**只有导入成功的条目才归档**——跳过 / 失败的条目原样保留，面板会点名「N 个旧会话未归档」。

非 DSH 目标是**转投而不是导入**：插件用同一套转换器读源会话，序列化成目标工具自己的格式（即 `export_chat` 用的那些序列化器），以 `createIfAbsent` 落盘（绝不覆盖）。为这次转换而临时建立的 DSH 会话会在**导出成功后立刻撤回**，DSH 侧不留副本；但如果会话在你选择转投之前就已存在（already-imported / appended），**绝不删除**——只导出，并在结果里标为保留。撤回失败（会话在运行、工件被占用）会把原因写进结果而不是吞掉。结果行显示落盘路径与该工具的下一步操作，条目级失败与常规 `degradations` 清单照常列出。

> 数据来自与 `scan_discover` 同一套只读发现（30s TTL 缓存 + 持久化 mtime 书签）；面板除你主动触发的导入外零写入。

### `/import` 斜杠命令与 `/resume-*` 交接

插件还注册了一个 **`/import <source> <path>`** 斜杠命令（在挂载了 dsh `commands` 服务的环境下可用）：直接在会话里输入即可导入，不占模型轮次——与 `import_*` 工具同一管线、同一重导 / force / 上下文预算语义。`<source>` 接受短名（`claude`、`codex`…）、客户端来源 id（`claude-code`）或工具全名（`import_claude`）；`<path>` 为 transcript 文件或会话目录 / 数据根（单文件导入 / 目录批量照常判定）。

**`/import-all [source] [path]`** 一键扫描默认数据根（或单一来源 / 显式路径）并批量导入所有未导入会话——同一管线：未变跳过、未续聊续写、已续聊另建副本，归档与已忽略源跳过，失败逐条上报。

**`/ignores`** 列出忽略表（归档 / 删除 / 删工作区自动登记）；**`/ignore <sessionId|sourcePath>`** 手动忽略一个源；**`/unignore <sessionId|sourcePath|all>`** 解除忽略（`all` 清空）。被忽略的源在重扫与 `/import-all` 中一律跳过；`force: true` 可越权导入一次（不解除墓碑）。

**`/attach-workspaces`** 按 imports registry 把已导入会话重新挂到 cwd 匹配的工作区——适合修复早期落在「未分组」或之前 workspace 挂载失败的导入；幂等，可重复执行。参数：`--mode auto|dedicated|per-project` 与 `--dir <path>`（dedicated 用）。

**`/doctor`** 运行与 `doctor` 工具相同的只读健康检查，并输出简洁报告。

**`/mcp-status`** 只读列出从 Claude/Codex 配置中发现的 MCP server；需要生成 DSH MCP client 片段时使用 `import_mcp`。

**`/settings-suggest`** 只读列出 Claude/Codex 配置翻译建议；需要结构化工具输出时使用 `import_settings`。

**`/import-reset`** 清空扫描缓存（进程内 TTL + 持久化 `scan-cache.json`），适合发现结果疑似过期时强制重扫；已导入会话不受影响。

**`/resume-claude [id:<会话id> | 关键词]`** 与 **`/resume-codex`** 从外部 transcript 生成**交接摘要**（目标 + 最后请求、涉及文件/产物、最近工具调用、精确停止点、最安全下一步）并注入当前会话，让你在 DSH 里接着干——把 transcript 当**不可信静态历史**（不复述 system/developer/thinking；旧工具输出视为过期证据需复核）。留空取最近会话，`id:<会话id>` 精确指定，或用标题关键词——**多匹配列候选不猜测**：

```
/resume-claude id:282095ab-1111-4222-8333-444455556666
/resume-codex 修复登录
```

### 会话启动上下文增强

两个可选钩子在 DSH 会话启动时运行（host `agent/session-start` 事件），均为 agent 级作用域、绝不触碰你的 transcript：

- **迁移提示（默认开）**——当会话工作区存在可发现的（已导入或可导入）外部聊天历史时，注入一行 `PromptContext`，告诉模型如何继续（`/import <source> <path>` 命令或侧边栏面板）。per-project 记忆保证同一工作区只提示一次；设 `DSH_IMPORT_SESSION_HINT=0` 关闭。
- **Claude 上下文桥接（默认关）**——设 `DSH_IMPORT_CONTEXT_BRIDGE=1` 把 Claude Code 的上下文资产桥进会话：`~/.claude/memory/*.md`（按 `feedback` > `project` > `reference` > `user` 分组、8 KiB 上限、mtime 缓存重读）、项目根 `CLAUDE.md` **与全局 `~/.claude/CLAUDE.md`**、以及 `~/.claude/skills/*/SKILL.md`（注册为该 agent 独有的 `claude-<name>` 技能）。

### 设置页（会话导入）

设置页「会话导入」分区提供两个开关，经面板 fenced 路由读写（与 settingsScope 白名单无关）：

- **导入系统提示词（默认开）**——把源会话的 system / developer 提示词作为「上下文注入」保留；关闭后仅保留环境变更声明。
- **将本插件工具显式注入对话上下文（默认开）**——关闭后不再向对话内的 Agent 注入本插件的 12 个工具（可节省约 5k 上下文）；导入、导出、发现与撤回等仍可通过 GUI「导入会话」面板与斜杠命令完成。
