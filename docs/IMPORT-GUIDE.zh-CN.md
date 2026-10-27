# import_chat 指南 —— 来源格式表、参数语义与重导规则

这是 `import_chat` 工具的长文说明。工具 schema 刻意留得很小：只有 format 枚举、必填的
`path`，以及每个参数一行说明，够发起调用就行。其余内容都写在这里——每个来源的数据放在哪、
每个参数实际改变什么、重导会怎样——只在真的要导入时才加载。

它已注册为宿主的运行时 skill **`dsh-chat-import-usage`**：`import_chat` 的 schema 里点名它。
同一份内容也是包里的这个文件（`docs/`），所以没有 skills 服务的 Agent 仍然读得到。

## 用哪个 format，数据在哪

`path` 可以给转录文件、会话目录，也可以给整个数据根：单个文件或数据库导入成一个会话，
目录则批量导入。各来源的根形状如下，第二列与代码里的来源表逐字一致，由门禁对账：

| format | path 形状 |
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

`local-jsonl` 本身不是来源，而是没有来源认领这个文件时的兜底入口。它会自动识别 `dsh` /
`claude` / `codex` / `cursor` / `reasonix` / `pi` / `openclaw` / `hermes` / `qoder` / `vibe` /
`copilot-vscode` / `copilot-cli` / `generic`，判据依次是内容标记、路径提示、解析器试跑；识别
错了就用 `parseFormat` 强制指定。

`doubao` 读的是豆包桌面版的 Chromium IndexedDB。它的会话列表在服务端，本地只为「客户端最近
打开过」的会话保留正文，所以没有本地正文的会话不会被列出、也无法导入（不会凭空伪造会话）。

路径优先用发现结果，不要猜：`scan_discover` 会列出各来源默认根下可导入的会话，可以用
`path` / `format` / `query` 过滤；面板「导入会话」看到的是同一份列表。根给错了会直接报错
并点名期望的根，不会写出半成品。

## 参数

每个参数都在工具 schema 里声明过，这里说明它实际改变什么。

### 公共

- `path`（必填）—— 来源的转录、数据库、会话目录或数据根，形状按 format 查上表。
- `force` —— 即使已经导入过，也另存一份完整副本（`import-<src>-<n>`）。
- `budget` —— 三层裁剪使用的上下文预算，单位是 token。默认 550k，取值顺序是：参数 > 环境变量 `DSH_IMPORT_CONTEXT_BUDGET` > 模型窗口。
- `storeImages` —— 默认 `true`，来源里的图片会落成宿主附件（`ctx.attachments`），在 DSH 里长期可用。设为 `false` 时只保留 `[image]` 文本占位；环境变量 `DSH_IMPORT_STORE_IMAGES=0` 效果相同。
- `preview` —— 设为 `true` 时零副作用预演：什么都不写，只返回将要导入的清单。
- `dryRun` —— `preview` 的别名。
- `sessionId` —— 单文件导入时指定目标 DSH 会话 id，默认是 `import-<来源 id>`。
- `recursive` —— 目录模式下是否递归子目录，默认 `true`。
- `expectedHash` —— 期望的源 SHA-256（小写十六进制）。不匹配时直接报错，什么都不写。
- `restamp` —— 设为 `true` 时把导入的时间戳平移到当下，相对间隔保留；默认保留源时间。
- `workspaceMode` —— 工作区分组方式：`auto` | `per-project` | `dedicated`，其中 `dedicated` 会把全部导入放进同一个工作区。
- `workspaceDir` —— `workspaceMode=dedicated` 时使用的工作区目录。
- `cwdRemap` —— 跨机器迁移时重写源 cwd 前缀，例如 `[{from:"D:/work",to:"/home/me/work"}]`。最长前缀优先；只对新导入生效，已经导入过的来源会被跳过，要重来请用 `force`。

### 来源专属

- `compacted`（claude，历史别名）—— 现在导入压缩摘要本来就是默认行为（原生 compaction 检查点），这个别名只为旧调用方保留。
- `branch`（chatgpt）—— `main`（默认）只导入主线程；`all` 按分支路径各写一个会话。
- `sessionIds`（一库多会话的来源：chatgpt / opencode / mimocode / kilocode / teleagent / zcode / trae / doubao / goose / zed / crush）—— 只导入这些源会话 id。
- `fullHistory`（支持压缩的来源）—— 设为 `true` 时导入全量历史，不写原生 compaction 检查点；默认 `false` 尊重压缩，模型看到的是「摘要检查点 + 其后的内容」。
- `includeToolUseResult`（claude）—— 把结构化的 `toolUseResult` 附属件也附到每条工具结果后面，包括经 `structuredPatch` / `bashEditDiff` 得到的编辑 diff、问答，以及退出码这类标量元数据。默认 `false`。它会让转录明显变大，而且这个参数属于参数指纹的一部分，改了要重导（`force`）。
- `lineage`（hermes）—— `tail` 表示只导入 lineage 的叶子会话。
- `lineageMode`（reasonix）—— `canonical`（默认）折叠已证实的恢复祖先；`physical` 每个 JSONL 导入一个会话。
- `parseFormat`（local-jsonl）—— 跳过自动识别，强制指定解析器；`generic` 表示读 interchange v1 文档。

## 重导规则

同一个来源导入两次是幂等的：

- **源没变** —— 直接跳过，连读都不读（registry 里存着内容指纹）。
- **源增长了，DSH 侧会话没被续聊** —— 新轮次增量续写到已有会话。
- **源增长了，DSH 侧会话已被续聊** —— 另铸一份副本，旧会话收进 `record.copies`，绝不追加进你的对话。
- **`force: true`** —— 恒另建副本。

会话日志是 append-only 的：导入只做 `create` + `append`，不改写历史。

## Copilot VS Code

`copilot-vscode` 接受 `workspaceStorage` 根、`chatSessions` 目录或单个 version 3
会话 JSON 文件。默认发现覆盖 Code、Code - Insiders 和 VSCodium；便携安装可用
`COPILOT_VSCODE_STORAGE_DIR` 指向工作区存储目录。
导入保留标题、源时间、正文、推理及已保存的工具输入和结果，相邻 `workspace.json`
提供单文件夹工作区。VS Code 并非总会保存工具原始参数和结果，缺失数量通过
`missingToolInputs` 和 `missingToolOutputs` 上报；无法导入的结果块计入
`droppedToolResultBlocks`。

## Copilot CLI

`copilot-cli` 读取 `~/.copilot/session-state/<session-id>/events.jsonl` 的逐会话
事件流；path 接受 `session-state` 根、单个会话目录或单个 `events.jsonl` 文件。
`.copilot` 根被迁移过时用 `COPILOT_HOME` 指向。事件流还原用户提问、助手正文与
推理，以及按 `toolCallId` 与执行结果配对的工具调用。`session.compaction_complete`
写为 DSH 原生压缩检查点（边界之前的轮留在日志里、标记 log-only）；
`fullHistory: true` 保留全量投影。标题没有显式来源，按首条人类提问兜底。
事件格式上游没有稳定承诺：未知事件类型、未导入的附件、没配上声明的工具事件都计数上报
（`metaMessages`、`unknownEvents`、`droppedAttachments`、`unannouncedToolCalls`、
`orphanResults`），不可读行与疑似 secrets 另报（`skippedLines`、`secrets`），都不会让整份
会话失败。

## 相关

- [USAGE.zh-CN.md](USAGE.zh-CN.md) —— 整个插件的用户文档（工具、面板、命令、设置）。
- [INTERCHANGE.md](INTERCHANGE.md) —— interchange v1 文档格式。
- [architecture.md](architecture.md) —— 导入流水线背后的设计决策。
