# 使用详解

> 从 README 迁出的完整工具/命令用法。快速上手见 README「使用」一节。

## 🛠 使用

> **注意**：导入会即时落盘，但 DSH 的会话列表不会自动刷新——导入后请刷新页面（或会话列表）才能看到新会话。

**导入——单个文件或目录。** 每个 `import_*` 工具都接受 `path`；目录递归扫描，每个文件 / 每段对话成为独立会话：

```
import_claude({ path: "C:\Users\<you>\.claude\projects\<slug>\<sessionId>.jsonl" })
import_codex({ path: "C:\Users\<you>\.codex\sessions\2026\05\18\rollout-2026-05-18T21-14-16-xxxx.jsonl" })
import_chatgpt({ path: "C:\Users\<you>\Downloads\chatgpt-export\conversations.json" })
import_opencode({ path: "C:\Users\<you>\.local\share\opencode\opencode.db" })
import_local_jsonl({ path: "D:\downloads\session.jsonl" })
```

`import_local_jsonl({ path })` 接受任意本地 `.jsonl` 会话文件（或目录）：自动识别 `dsh` / `claude` / `codex` / `cursor` / `reasonix` / `pi` / `openclaw` / `hermes`，识别不准时可用 `format` 参数强制指定：

```
import_local_jsonl({ path: "D:\downloads\session.jsonl" })
import_local_jsonl({ path: "D:\downloads\unknown.jsonl", format: "claude" })
```

`import_chatgpt` / `import_opencode` / `import_zcode` / `import_hermes` 恒返回批量结果——一个文件 / 数据库包含全部会话，一次调用即可让每段对话成为独立会话。

<details>
<summary><b>导入参数与行为</b></summary>

- `preview: true`（别名 `dryRun: true`）— **只读**运行：照常解析 / 读取 / 转换，但**零副作用**、不落盘。去掉该参数再调一次即正式导入。
- `force: true` — 即使已导入，也以新 id（`import-<sessionId>-<n>`）另存一份**完整副本**；旧会话绝不修改。
- `sessionId`（可选）— 覆盖目标 DSH 会话 id（默认 `import-<源sessionId>`）。
- `import_chatgpt({ branch: 'all' })` — 把对话 DAG 的**每条 root→leaf 分支**还原为独立会话（主线程仍是最后 child 链；分支会话带后缀源 id 与分支标记标题）。导出里的工具消息还原为真正的 `tool/call` + `tool/result`（结构化 JSON 参数、FIFO 配对），不再是纯文本。
- `import_claude({ compacted: true })` — 只导长会话的**最后一次压缩摘要 + 尾部**（摘要作前置 `reasoning` 块；标题取 summary 记录）。无 summary 记录时该参数不生效。
- `import_hermes({ lineage: 'tail' })` — 只导**叶子链尾**（不是任何其它会话父会话的会话）；压缩分叉父会话跳过并标注。
- **已归档会话可重新导入** — DSH 的归档会把会话从侧边栏隐藏，但保留在持久化里（及其 id）——面板与 `scan_discover` 现在把已归档目标标记为 **已归档 / Archived** 并提供重新导入按钮。再次导入以新 id（`import-<sessionId>-<n>`，与 `force` 同一铸键）另存完整副本，不触碰已归档会话；多会话源（chatgpt / opencode / zcode / hermes 库）内逐会话同样适用。
- **增量续写（重导）** — 重导同一源路径绝不改写已导入历史：未变文件跳过（`already-imported`，不重读）；增长文件只把**新增轮次** append 进同一会话（`appended`）；截断文件检测并上报（`sourceShrunk`）——需要完整新副本时用 `force: true`：

```
import_claude({ path: "C:\Users\<you>\.claude\projects\<slug>\<sessionId>.jsonl" })
// 未变化 → "already-imported" · 增长 → "appended"（只追加新轮次）
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

### scan_discover — 只读会话发现

`scan_discover` 扫描全部 17 种格式的已知数据根（Windows 上含 Reasonix 桌面版与 Claude-3p 根），返回结构化会话索引（标题、项目、cwd、路径、导入状态，源目录为 git 仓库时附分支/dirty），供批导入前预览。零副作用：

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

> **撤回后的幽灵会话（#22）** — DSH 宿主没有 delete/forget 面：`retract_import` 并手动删除工件后，会话 id 仍可能占据宿主内存索引（会话列表里可见、直到重启 dsh 才消失），同源重导此前会报 `session "…" already exists in this backend`。现已自愈：重导检测到陈旧条目（list 仍暴露但日志不可读，或 create 拒绝该 id）时**自动另铸后缀新 id**（`import-<id>-1`）完整重导并报告 `staleGhost: { previous, current }`，不再失败；`retract_import` 的 `manualDelete` 引导也注明幽灵会话需重启 dsh 才彻底消失。

### export_chat — DSH → Claude / Codex / Kimi（矩阵导出）

`export_chat({ format: "claude", sessionId })` 把现有 DSH 会话（导入的或原生的）序列化为 Claude Code JSONL transcript，可直接 `--resume`。文件写到 `<outputDir>/<slug>/<uuid>.jsonl`（默认 `~/.claude/projects`），文件名是全新 UUID v4——绝不覆盖已有文件。`format: "codex"` 与 `format: "kimi"` 分别写 Codex rollout JSONL 与 Kimi `wire.jsonl`（默认 `~/.dsh/exports`，或用 `path: …` 指定目标）——补齐 DSH↔Claude↔Codex↔Kimi 矩阵（导入边已存在）。每次导出在 `degradations` 字段里逐条列出**有损项**（孤儿工具结果 / 注入跳过 / 附件跳过）——绝不静默丢弃：

```
export_chat({ format: "claude", sessionId: "import-019f5f27-…" })
export_chat({ format: "codex", sessionId: "…", dryRun: true })
export_chat({ format: "kimi", sessionId: "…", outputDir: "D:\backup\kimi" })
```

### export_bundle / restore_bundle — 便携 interchange bundle

`export_bundle({ sessionId })` 写出 **`.dshbundle.json`**——事件级无损的 interchange bundle（协议见 [docs/INTERCHANGE.md](docs/INTERCHANGE.md)），带双重 SHA-256 指纹（会话级 + 文件级）与机器无关的落点信息（`originalCwd` + `landingHint`）。`restore_bundle({ path })` 先校验指纹（损坏大声报告、绝不静默还原），再经同一幂等状态机导入——重复还原跳过、`force: true` 另存副本、目录模式逐个还原 `.dshbundle.json`：

```
export_bundle({ sessionId: "import-019f5f27-…" })                    // → ~/.dsh/exports/<id>.dshbundle.json
restore_bundle({ path: "D:\backup\sess.dshbundle.json" })            // A 机导出 → B 机还原
restore_bundle({ path: "D:\backup\bundle-dir", preview: true })      // dry-run
```

**跨机器（REQ-62）：** A 机导出 → 拷贝 bundle → B 机还原。原 `cwd` 在 B 机不可达时，会话回退归到 bundle 文件所在目录（REQ-39-lite 归组），结果报告 `cwdAvailable: false` / `groupedTo` / `restoreNote`——绝不静默。

### verify_session — 只读结构审计

`verify_session({ sessionId })` 对任意 DSH 会话做只读结构校验：seq 连续、事件类型白名单、surface 事件带 `surfaceOp`、`sourceEventSeqs` 指向真实 `tool/call`、turn/step 平衡、工具调用↔结果配对。问题逐条定位（kind + seq + message），并按 kind 给出 `repairHints`（`force` 重导 / 闭合半开轮 / 源转录中途开始的边界说明）：

```
verify_session({ sessionId: "import-019f5f27-…" })
```

### doctor — 只读迁移健康检查

`doctor()` 做一次只读迁移后体检：imports registry 是否可读、每个已导入会话是否仍存在于 `sessionPersistence`、`import_agents` 的 skills 是否落盘、`workspaceRegistry` 是否可用。绝不写文件、不导入、不同步、不删除：

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

`export-md` 把 DSH 会话日志渲染为可读 Markdown（会话头、标题、user/assistant 文本、thinking、工具调用与结果）。`doctor` 读取 `$DSH_HOME/dsh-chat-import/imports.json` 与本地 `sessions` 树，做轻量健康汇总。

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

### sync_to_claude — 增量写回

`sync_to_claude({ sessionId })` 把会话的**新增完整轮次**追加回其 Claude Code 文件——`target: "source"`（默认，写回导入源文件）或 `"copy"`（最近一次 `export_chat` `format: "claude"` 副本）。文件被外部修改或缩小时一律上报、绝不覆盖；`force: true` 越过外部修改重锚定（被覆盖的守卫仍会上报）：

```
sync_to_claude({ sessionId: "import-019f5f27-…" })
sync_to_claude({ sessionId: "…", target: "copy", dryRun: true })
```

### 浏览器面板 — 侧边栏发现与导入

dsh web 侧边栏底部上方有一个「导入会话」浮动胶囊（`sidebar.footer.action` 槽条目以 fixed 浮层渲染，同槽其它条目——如官方 Cordis 徽标占满整个 footer 行——不会把它挤出或挡住）。打开的面板**按工作区文件夹分组**列出发现的会话（各来源记录里的 `cwd`/项目名，缺省归入「(未分组)」），支持来源过滤——「全部来源」扫描全部格式的默认数据根，单选来源则只看该格式——并带逐会话导入状态徽标（已导入 / 部分 / 未导入）。搜索框按标题 / 工作区 / 路径过滤，列表**分页**展示（每页 50 条），跨页选择保留便于批量操作。面板支持 `Esc` 关闭。

每行支持**单选导入**，复选框支持**多选导入**（「导入所选 (N)」）：面板调用与 `import_*` 工具完全相同的 host 导入管线，幂等跳过 / 增量续写 / force / 上下文预算语义完全一致；导入后自动刷新列表展示最新状态。多会话源（如 `conversations.json`、opencode/zcode/hermes 库）整源导入——opencode/zcode 只导所选 `sessionId`。

> 数据来自与 `scan_discover` 同一套只读发现（30s TTL 缓存 + 持久化 mtime 书签）；面板除你主动触发的导入外零写入。

### `/import` 斜杠命令与 `/resume-*` 交接

插件还注册了一个 **`/import <source> <path>`** 斜杠命令（在挂载了 dsh `commands` 服务的环境下可用）：直接在会话里输入即可导入，不占模型轮次——与 `import_*` 工具同一管线、同一幂等 / 增量 / force / 上下文预算语义。`<source>` 接受短名（`claude`、`codex`…）、客户端来源 id（`claude-code`）或工具全名（`import_claude`）；`<path>` 为 transcript 文件或会话目录 / 数据根（单文件导入 / 目录批量照常判定）。

**`/import-all [source] [path]`** 一键扫描默认数据根（或单一来源 / 显式路径）并批量导入所有未导入会话——同一管线，幂等跳过 / 增量续写，归档会话跳过，失败逐条上报。

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
