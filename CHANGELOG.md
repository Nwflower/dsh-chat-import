# Changelog

All notable changes to `dsh-chat-import` are documented here, newest first.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Every entry maps to commits in the repository history
(`git log --oneline --no-decorate`); the 0.1.0 boundary is anchored to the first
npm publish timestamp (cross-checked with `npm view dsh-chat-import time`).
Release dates are the npm publish timestamps in Asia/Shanghai (UTC+8).

## [0.8.2] - 2026-08-29

### Added

- **千问办公（qwen）导入支持（PR #30，xianrui69 贡献）** — 第 19 个导入来源：`import_chat`
  新增 `qwen` 格式、`scan_discover` / 导入面板 / `/import` 全链路接线。千问办公每个会话
  一个转写 `~/.qwenworkcn/projects/<slug>/<session-uuid>.jsonl`，明文 JSON Lines、事件
  词汇与 Claude Code transcript 同构（text / thinking / tool_use / tool_result 块、
  uuid/parentUuid、timestamp、gitBranch）。千问特有差异逐项处理：人类真实原话取
  `user.humanInput.text`（`message.content` 的 text 块被 `<system-reminder>` 等系统上
  下文包裹，`<system` 开头的块跳过）；`workspace-directories` 里非 `.qwenworkcn` 的目录
  才是用户真实项目文件夹（slug 目录名是存储层混写、禁作项目，会话 cwd/项目取自它）；
  `runtime-config` 提供模型；同会话双 slug 副本由发现层按 sessionId 去重留最新；路径签
  名自拒（非 `~/.qwenworkcn/projects` 布局直接返回空）。转换与 claude 转换器同款纪律
  （一条 assistant = 一步，`tool_result` 按 `tool_use_id` 挂回声明 step）。README 双语
  与 `import_chat` 格式计数同步 18 → 19。

- **导入面板来源 / 工作区下拉改可搜索（PR #30）** — 来源与工作区下拉换自定义可搜索
  combobox：输入即过滤、选中项 ✓ 高亮、键盘上下 / 回车导航，明暗主题跟随侧边栏；来源
  列表项附产品名标签。取代原生 `select`（选项多时无法检索）。

- **导入面板「刷新已导入」** — 按当前来源 + 工作区 + 搜索条件，对已导入会话重新转换并
  覆盖（`replace:true`，同 session id，不新建副本）；确认框显示条数。

- **统一导入标题「来源 · 话题」** — 全源导入后钉住 `session/title`（如 `Cursor · 首问`）；
  话题未知时为 `来源 · 未命名 · 日期`，不再回退为工作区目录名。

### Fixed

- **Cursor 导入会话无法打开** — 同一步多个 `tool_use` 不再生成重复 `callId`（如
  `cursor-1-1`），避免 DSH 历史加载报 `more than one start Match`；用户正文剥离
  `<timestamp>` / `<user_query>` 扫描包裹。

- **导入撤回 / 刷新已导入在会话工件被占用时中止并保留 registry** — `rm` 后目录仍存在
  （文件被占用 / 权限拒绝）视为删除失败并抛错：撤回中止后不清 registry、刷新中止后不重导，
  防止留下插件再也管不到的幽灵会话。`locate` 定位缺失时改为走扫描兜底，防陈旧定位漏删
  真实工件。

- **导入面板下拉按 Esc 收起不再连带关闭整个面板** — 可搜索下拉的 document 级 Escape
  处理补 `stopPropagation`：面板的 Esc 关闭监听挂在 window 上，同一事件先 document 后
  window 两个监听都会触发（原生 select 弹层吞按键，故旧版无此问题）。

- **侧栏底部「导入会话」按钮在 wide 模式独占整行，把同槽其它插件入口挤出侧栏被裁（#31）** — 非浮动
  行内样式按槽容器 flex 布局三分派：row 容器（默认 footer 行）改 `flex: 1 1 auto + width: auto +
  min-width: 0`，与同槽其它入口（如 dsh-web-all 的「检查更新 / 远程访问」）共享一行，仅本插件一个
  入口时 `flex-grow` 仍撑满整行、视觉不变；column 容器（usage-stats 强制纵排，#25）与 wrap 容器
  （tokenledger 注入 flex-wrap）保持 `flex: 0 0 auto + width: 100%` 不回归；rail 态恒为 36×36 圆
  钮。探测函数 `footerWraps` 扩为 `footerLayout`（一次读取 `flex-wrap` + `flex-direction`）。

## [0.8.1] - 2026-08-28

### Added

- **导入面板工作区下拉筛选** — 来源旁新增「工作区」下拉，选项来自当前扫描结果的真实目录名（含「无工作区」桶）；与搜索 AND 组合，全选/搬空计数随筛选变化。
- **导入面板「搬空当前筛选」** — 仅导入当前来源 + 工作区 + 搜索条件下的未导入会话（确认框提示条数）；全局「搬空全部」保留。
- **导入面板扫描提示** — 刷新/首扫显示耗时预期与进度（缓存命中几秒、首次全量可能较慢）；主要控件补充 title 说明。
- **导入面板分页大小可选 50 / 100 / 500** — 底部分页条新增「每页」下拉，翻页仍为零重扫客户端切片。
- **导入面板「搬空全部」** — 扫描完成后一键导入当前结果中全部未导入会话（跨页，非仅当前页）。
- **导入面板「历史」页** — 读取 `~/.dsh/dsh-chat-import/imports.json` 展平展示来源路径、会话 ID、导入时间与轮次/事件计数。
- **导入历史一键删除** — 支持单条或全部撤回：删除本插件创建的 DSH 会话工件、解挂工作区、清理空壳工作区（`agent-transcripts/<uuid>` / dedicated 专用目录），并从 registry 移除记录；操作前需确认。

### Changed

- **导入会话面板改为后台扫描 + 逐条流式加载** — 面板数据源 `POST /api-import/sessions`
  新增流式模式（body 带 `after` 游标）：发现按「来源|关键词|路径|epoch」键后台
  singleflight 扫描（epoch 由客户端每次刷新 / 导入后自增 → 新扫描键强制重扫），
  `discoverSessions` 新增可选 `onEntry` 逐条产出钩子（importStatus / git 状态标注与
  查询过滤移到产出路径，缺省行为零变化）；客户端按 ~250ms 轮询游标增量，会话按发现
  顺序**逐条插入列表**——首屏不再被全量扫描阻塞，换页 / 翻页不再触发重扫（旧契约
  offset/limit 分页路由保留兼容）。jsonl 型来源（claude/codex/cursor/gemini/…）逐会话
  产出；SQLite 型来源（opencode/mimocode/zcode/hermes/chatgpt）仍整库一批。

- **导入面板无 cwd 分组显示为「无工作区」** — 替代原「(未分组)」，对齐 Cursor empty-window / 数字 id 等场景。

- **导入会话面板工作区分组改按活跃度排序** — 分组从「工作区名首字母升序」改为「组内
  最新会话的最后编辑时间降序」：最近活跃的工作区置顶（时间并列按工作区名升序稳定），
  组内会话保持最后编辑时间降序，未分组桶仍钉在最后。

- **双向同步控制台迁入设置页「会话导入」分区** — 同步状态与启停并入「会话导入」设置
  分区（横线分隔，控件风格对齐设置页），导入面板移除独立同步页签；`/api-import/sync`
  路由与巡检行为不变。

### Fixed

- **Cursor 导入面板按真实工作区分组** — Cursor `projects/<slug>` 将路径分隔符与 `.` 均编码为
  `-`（如 `Funion.Client-develop` → `Funion-Client-develop`）。扫描与导入现经
  `workspace.json` / `workspaceRegistry` 正向匹配 + 磁盘贪心解码还原真实 `cwd`，面板分组
  显示人类可读目录名（保留点号）；`empty-window`、纯数字项目 id 等无仓库 slug 不再误建
  异类工作区。导入 `agent-transcripts/<uuid>` 布局时 `meta.cwd` 指向解码后的项目根，而非
  UUID 父目录。首条 user 文本中的 `<timestamp>…</timestamp>` 解析为 `createdAt` /
  `lastActiveAt`（无则回退文件 mtime），修复面板「时间未知」。**scan-cache 书签命中时**
  对旧 cursor 条目做读时补丁（slug 解码 + 时间戳补全）并写回，无需 bump 版本或重读 jsonl。

- **侧边栏「导入会话」按钮注册改用 `slots.inject` 等待槽声明就绪** — 裸
  `ctx.slots.register("sidebar.footer.action", …)` 要求该槽在 apply 期已被 ui-sidebar
  声明；DSH Desktop 增强模式下桌面 shell 的声明时序不保证先于本插件，注册当场抛错使
  客户端 fiber 失败、渲染器 boot 判失败（白屏失败页，仅增强模式复现）。改用
  `slots.inject("sidebar.footer.action", …)` 挂起等待声明就绪（官方 ui-cordis 与
  dsh-community-market 同款写法），注册不再依赖激活顺序。设置页分区的 settingsScope
  解析同步挪进 `slots.inject` 回调内（apply 期该可选服务尚未就绪）。

- **`ctx.inject(['settings'])` 注册偏好命名空间不再把 `settings.register` 的 owner scope
  作为回调返回值** — cordis 的 effect 契约只接受函数/可空/thenable/可迭代，普通对象会抛
  `TypeError: Invalid effect` 并使整个插件 apply 失败：桌面宿主中 settings 服务就绪早、
  回调同步执行即触发，表现为 DSH Desktop 启动崩溃（web/headless 下 settings 缺席或晚到、
  回调不执行所以不受影响）。register 内部已自行把命名空间生命周期挂到插件 fiber，回调
  空返回即可；`test/index.test.mjs` 的 `makeCtx.inject` 同步补上同款 effect 校验，同类
  回归会在单测中直接暴露。

- **设置页「导入系统提示词」开关改走插件自有 fenced 路由（`/api-import/prefs`）** —
  DSH 配置客户端（settingsScope）只能读写 api-proxy 暴露白名单内的命名空间，插件自有
  `chat-import` 不在其列：此前开关读不到值、写入被拒（点不动、不持久化）。现客户端
  经面板 fenced 路由进程内读写设置 seam（`describe` / `update`，`expectedRevision`
  冲突保护），settings 服务缺席时回退默认、开关照常渲染；宿主侧命名空间注册改
  `ctx.inject(['settings'])` 惰性挂载（对齐 dsh-better-sidebar 的 `settingsGet` /
  `settingsUpdate` 模式）。

- **设置页「会话导入」分区迁移到正确的宿主 Hook（`settings.section` 左导航页）** —
  此前注册在 `settings.plugins.tab`（「插件」分区内部的子 TAB），不符合该插槽语义
  （它是分区内页面，不是插件设置入口），部分宿主版本下点不开。现改为注册
  `settings.section`（设置页左侧导航的「每功能一页」，`agent-presets` 等官方插件
  同款做法），「导入系统提示词」开关作为独立的「会话导入」设置页呈现。

- **面板后台扫描不再阻塞宿主 Web 服务事件循环** — 后台扫描跑在宿主进程上，此前
  `gitStatusOf`（`statSync` / `readFileSync` 逐目录上探 .git）与 `scanDsh` 的 zstd
  `readFileSync` 会在扫描期间同步占住事件循环，周期性冻住面板轮询与其它 UI 请求
  （表现为整个界面卡顿）。现全部改为 `fs/promises` 异步（含逐条产出 await 让出）：
  扫描期间事件循环持续可用。客户端轮询同步加渲染守卫——空轮询不再触发 setStream
  重渲染。SQLite 型整库读取器（opencode/mimocode/zcode/hermes/chatgpt）仍为同步
  实现，属已知局限。

## [0.8.0] - 2026-08-26

### Added

- **WorkBuddy（腾讯 AI 编码应用）导入支持** — 新增 `import_workbuddy` 工具与
  `workbuddy` 格式。WorkBuddy 每个会话一个 transcript
  `~/.workbuddy/projects/<project-hash>/<session-uuid>.jsonl`，逐行事件 JSON：
  `message`（user 提问从 `<user_query>` 提取、assistant 文本）、`reasoning`、成对
  `function_call` / `function_call_result`（按 `callId` 配对，孤儿/打断草稿丢弃）、
  运行期 `file-history-snapshot` 跳过。`scan_discover` 默认扫
  `~/.workbuddy/projects`，标题取首条真实提问（注入过滤），cwd 取记录内值；
  `FORMATS` / `/import` 来源名 / 面板 / `index.d.ts` 全链路接线。

### Changed

- **审计清理（docs/unnecessary-code-audit.md A 级 + B 级部分）** — 同步元数据漂移：
  三处过时计数注释（`discovery.mjs`「13 种」→「17 种」、`convert/core.mjs` 源枚举
  「13」→「18」、`panel.mjs`「15 个」→「18 个」）；`index.d.ts` `ToolSurface` 补
  `doctor` / `import_mcp` / `import_settings` 三接口（此前声明 10 个、实际注册 13 个）、
  `ScanFormat` 补 `'mimocode'`（此前 16 项、FORMATS 17 项）；`AGENTS.md` 布局表补
  tools.mjs / restore.mjs / verify.mjs / agents.mjs / mcp.mjs / settings.mjs /
  doctor.mjs / cwd-map.mjs / handoff.mjs / resume-command.mjs / markdown.mjs /
  import-prefs.mjs / mimocode.mjs / dsh.mjs 与 export/ 的 kimi.mjs / bundle.mjs，
  `files` 白名单描述改 `docs/*.md` + `bin`，质量约定 host 面模块白名单补全
  （import-prefs 等）；`ROADMAP.md` 来源数「14 源 + 本地 JSONL（15 工具）」→
  「17 源 + 本地 JSONL（13 工具）」、REQ-09 工具名 → `makeImportChatTool`。
  删除零消费者死 re-export `tailCodexEvents` / `tailGrokbuildEvents`
  （lib/export/codex.mjs / grokbuild.mjs + export.mjs shim，审计 §1.5）。

- **`export_claude` / `export_codex` / `export_kimi` 三合一为 `export_chat({ format, ... })`
  （注册工具 15 → 13）** — 三个反向导出工具参数面完全相同（sessionId / path /
  outputDir / dryRun），收敛为单一分发器，`format` 为 3 值 enum（claude / codex / kimi）。
  执行体（exportClaudeSession / exportCodexSession / exportKimiSession）与输出 schema
  契约不变：claude 分支保留 cwd / mapping / slug / title，codex/kimi 分支保留
  toolCalls / toolResults；`sync_to_claude` 的 `target:'copy'` 语义不变（写回
  `export_chat format=claude` 导出的副本）。每请求工具 schema 再降：export 面从
  3 份重复参数/描述合并为 1 份。

- **全部 13 个工具 description 英文化并重写（对齐宿主 DSH 英文工具面 + 官方
  function-calling 最佳实践）** — 宿主 system prompt 与 20 个内置工具均为英文，
  本插件此前是中文孤岛；现按 [Anthropic tool-use 建议](https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/tool-use-concepts.md)
  为每个工具级描述补充「何时调用」触发条件，并**移除 description 中的开发侧注解**
  （REQ-NN 编号 / issue 编号 / 同类生态插件对标）——
  这些对模型与最终用户都是零信息量噪声。修正 `scan_discover` 描述过时计数
  「15 种」→「17 种」并补全枚举（mimocode / workbuddy）。参数与 format enum 描述
  同步英文化；工具描述是产品文案（模型上下文 + 用户可见），内部需求编号只留在
  代码注释与 CHANGELOG。

- **18 个 `import_*` 聊天导入工具收敛为单一 `import_chat` 分发器（注册工具
  32 → 15）** — 会话工具面从每来源一个工具（`import_claude` / `import_codex` /
  `import_chatgpt` / `import_cursor` / `import_gemini` / `import_reasonix` /
  `import_opencode` / `import_mimocode` / `import_zcode` / `import_grokbuild` /
  `import_openclaw` / `import_hermes` / `import_pi` / `import_kimi` /
  `import_qoder` / `import_workbuddy` / `import_dsh` / `import_local_jsonl`）
  改为一个 `import_chat({ format, path })`，`format` 为 18 值 enum 选择来源。
  参数/输出 schema/幂等/`session/imported` 标记/归组语义逐源不变；`IMPORT_SPECS`
  登记由分发器工厂维护，导入面板与 `/import` 命令零影响。每请求工具 schema 中
  import 部分从 34,059 字符降到 3,996 字符（省 ≈88%），全部工具每请求合计
  从 44,835 降到 14,796 字符（省 ≈67%，约 20,026 token/请求）——
  低使用率工具不再逐一占用模型上下文。行为差异：
  `import_local_jsonl` 的 `format` 参数改名 `parseFormat`（避免与分发器 `format`
  撞名）；18 份长工具描述合并为 format enum 描述（解析细节不再进模型，属有意的
  token 权衡）。

### Fixed

- **sidebar.footer.action 按钮在 `flex-direction: column` 容器下撑满 footer 高度
  （issue #25）** — 与 @ychris12138/dsh-usage-stats 0.2.10（把 footer 容器强制改
  为纵排）同装时，行内分支的 `flex: 0 0 100%` 沿主轴（高度）解析，按钮撑满整个
  footer、与同槽用量/设置按钮重叠。现改 `flex: 0 0 auto` + `width: 100%`：row /
  column / wrap 三种容器下都只占全宽、高度随内容。

- **sidebar.footer.action 按钮 rail（折叠侧边栏）态对齐同列图标按钮（issue #25）** —
  rail 态与设置/用量等图标按钮同列：固定 36×36、justify-content 居中、圆角 50%
  圆形、单图标无内边距；照旧使用侧边栏同一 CSS 变量，悬停/明暗主题表现不变。

- **`/doctor` 等命令的 `input.hint` 补全，修复插件加载失败自动回滚（PR #24）** —
  `/doctor`、`/mcp-status`、`/settings-suggest`、`/import-reset` 的 `input.hint`
  为空字符串，被宿主 `dsh-commands` 的 `normalizeDefinition` 硬抛
  「input hint must not be empty」；该错误发生在插件 apply 阶段，被插件加载器
  判为 entry 加载失败 → DSH 启动校验失败 → 自动回滚，从 npm / GitHub main
  安装的版本无法生效。四处 hint 补全为「无需参数」，并新增回归测试断言所有
  带 input 的命令 hint 非空。

- **WorkBuddy 中途孤儿 function_call_result 误挂 lastStep（PR #23 审查发现）** —
  孤儿结果（无匹配 `function_call`：转录从中途开始 / 调用被过滤，但存在当前步）
  此前经 `|| lastStep` 误挂到最近一步，产出**无对应 `tool/call` 的孤儿
  `tool/result` 事件**——恢复会话时模型 API 拒绝（与 claude 转换器同款纪律：
  孤儿结果一律丢弃，绝不挂 lastStep）。现只按 `callId` 配对，孤儿结果丢弃并计入
  `droppedOrphanResults`。

- **Claude Code 数组格式 user 消息导入 0 轮（issue #21）** — 新版 Claude Code 对直接
  提问也写数组格式 `content`（`content:[{type:'text',...}]`），此前这类消息落入
  tool_result 分支被静默丢弃：全数组提问的转录导入成 0 轮空会话、混合转录（字符串 +
  数组提问）丢提问且无任何提示。现把无 `tool_result` 块的数组 user 消息视为直连提问
  开新轮（text 块按换行拼接为 prompt）；含 `tool_result` 块的数组继续走工具结果分支。
  无法解析的 user content 计入 `droppedUserPrompts`，0 轮 + 有丢弃时显式标注
  `skipReason`「0 轮导入…内容丢失」，绝不静默成功。

- **retract_import 后宿主残留幽灵会话，同源重导被 already exists 拒绝（issue #22）** —
  DSH 宿主内存会话索引无 delete/forget 面：撤回并手动删除工件后，会话 id 仍占内存
  索引（GUI 列表可见、重启才消失），同源重导抛 `session "<id>" already exists in
  this backend`（或幂等跳过），只能换新 id 或重启服务器。现两层自愈：决策层识别
  「list 仍暴露但日志不可读」的幽灵条目，自动另铸后缀新 id（`import-<id>-1`）完整
  重导并报告 `staleGhost: { previous, current }`；落盘层 create 撞 already exists
  时同样另铸新 id 重试一次，registry 记录 / 批量结果同步到新 id。`retract_import`
  的 `manualDelete` 引导补充「彻底消失需重启 dsh」说明。

## [0.7.0] - 2026-08-23

### Added

- **双向同步按工作区排除（`excludeDirs`，issue #19）** — 同步配置新增
  `inbound.excludeDirs` / `outbound.excludeDirs` 排除目录列表（绝对路径，归一
  `\`→`/` 并去尾斜杠），入站按会话 `cwd`（缺失回退源文件目录）前缀匹配、出站按
  DSH 会话 `cwd` 前缀匹配，命中目录及其子目录的会话不参与同步；面板「同步」页
  入站/出站各加一个排除目录输入框（逗号/换行分隔）。默认空列表、行为不变。

### Changed

- **子代理对话默认双向过滤（issue #19）** — 入站发现层默认跳过子代理 transcript：
  Codex 子代理 rollout（`session_meta.payload.thread_source='subagent'` /
  `source.subagent`，此前只在导入转换层跳过、仍出现在 `scan_discover` 与入站
  `scanned` 计数）与 Reasonix 子代理会话（`subagent-*`，此前被当作独立会话导入）
  现在在发现层与转换层统一跳过并给 `skipReason`；出站同步默认不写回 DSH 子代理
  会话（`SessionHeader.origin='subagent'` 或 `delegationDepth>0`），单独计入
  `subagentSkipped` 保持可见。Claude `agent-*`、Qoder/Kimi `subagents/` 等既有
  过滤不变。

- **导入会话总是注入环境变更声明** — 此前「迁移到 DSH，工具 / 权限 / 执行指令以
  当前会话为准」的免责声明只在开启「导入系统提示词」开关时随源提示词一并注入；
  默认关时继续会话会缺少该声明，模型可能沿用源环境的旧工具名 / 旧命令（如 Claude
  的 `Bash` / `Read`、Codex 的 `shell`），导致工具调用失败。现把环境变更声明与
  源系统提示词解耦：**每个导入会话**都在首个回合前钉一条「上下文注入」折叠行声明
  环境已迁移；`importSystemPrompt` 开关只决定是否附上源 `system` / `developer`
  提示词正文。声明不计入「消息数」（`messages` 只统计真实 source 消息），导出
  `export_claude` 时按 `source.kind='plugin'` 跳过不串写回 Claude。

### Fixed

- **设置页「导入系统提示词」开关打不开** — Browser 侧 `settings.plugins.tab` 槽由
  `ui-settings-plugins` 声明，而它依赖的 `settingsScope`（又依赖 `connection` /
  `remote`）与 `locale` 都是晚挂载服务；本插件客户端此前只 `inject: ["slots"]`，
  `apply` 期 `ctx.get('settingsScope')` 拿到 `undefined`，整段 TAB 注册被跳过——
  设置页里根本没有「会话导入」TAB，开关自然打不开。现把 `locale` 声明进客户端
  `inject`（面板 i18n 同步修复），并在 `slots.inject("settings.plugins.tab")` 回调内
  resolve `settingsScope`（槽声明时该服务已就绪），TAB 正常注册、开关可读写。

- **`doctor` 等四个工具补 `output.render`（issue #20）** — 宿主 `@deepseek-ai/dsh-tools`
  更新后 `defineTool()` 恒暴露 `output.render(args, value)`（内部调用捕获的
  `userRender`），未提供 `render` 的工具渲染输出即抛 `userRender is not a function`。
  `doctor` / `import_agents` / `import_mcp` / `import_settings` 四个直接 `defineTool`
  注册、此前漏写 `render` 的工具现补上人类可读文本渲染（`doctor` 报 checks/issues、
  其余报预览/落盘/计划摘要），工具恢复可用。

- **`verify_session` 结构校验对齐原生 DSH 会话语义（issue #20 附注）** — 校验此前
  按「导入会话」语义过严，对原生 DSH 会话产生三类误报：① 事件类型白名单只列 10 种
  durable 事件，把 `permission/preset`、`sandbox/mode`、`assistant/chunk`、
  `request/header`、`approval/policy`、`agent/inbox/spliced` 等运行时/状态事件误报
  `unknown-type`；② `sourceEventSeqs` 一律要求指向 `tool/call`，但原生会话
  `assistant/message` 可引用 `assistant/chunk`（消息重建）；③ `surfaceOp` 只认
  `'append'`，但 compaction 的 `{ op: 'replace' }` 是合法形态。现改为：白名单对齐
  宿主 `KNOWN_SESSION_EVENT_TYPES`（0.1.1-rc.2，48 种）+ 自产 `session/imported` 标记；
  `sourceEventSeqs` 指向校验只作用于 `tool/result`；`surfaceOp` 仅判缺失。导入保留
  的 durable 类型仍由 `convert/dsh.mjs` 的 `DURABLE` 集合独立控制。

## [0.6.2] - 2026-08-19

### Added

- **MiMo Code source (`import_mimocode`)** — MiMo Code (XiaomiMiMo/MiMo-Code,
  an opencode fork) stores sessions in a SQLite database at
  `~/.local/share/mimocode/mimocode.db`. Its `session`/`message`/`part` schema
  mirrors opencode except the `session` table has no `model` column, so
  `readOpencodeDb` now probes `PRAGMA table_info(session)` and adapts the
  `SELECT`. Import/preview/discovery reuse the opencode pipeline; mimocode
  specifics live in `lib/mimocode.mjs` / `lib/convert/mimocode.mjs`
  (provider label). MiMo's memory-consolidation background sessions
  (`checkpoint-writer` / `AutoDream` / `AutoDistill`, identified by title
  prefix + `message.data.agent`) are filtered out by default. Contributed by
  @bobowsh in #15.
- **Preset mode for imported sessions** — session creation now resolves the
  default agent preset id and writes it to `SessionHeader.agentPreset` (and
  passes it to `agentPresets.mount`), so imported sessions show the same
  "preset mode" chip as normal sessions instead of an empty one; `resolve()`
  failure (no roster / no default) keeps the previous tool-visible behavior
  without recording a preset.
- **Optional "import system prompt" setting (default off)** — a new
  "Session Import" tab in the settings Plugins section toggles importing the
  source transcript's `system` / `developer` prompt as a "context injection"
  (`user/message` with `source.kind='plugin'`, `plugin='chat-import'`),
  prefixed with a note that the environment changed and tools / permissions /
  instructions now follow DSH. Wired for the sources that store one (Codex,
  ChatGPT, Grok Build, Hermes, ZCode); Claude Code transcripts do not persist
  a system prompt, so the toggle is a no-op there. The `chat-import` settings
  namespace is registered host-side via `ctx.settings`
  (`@deepseek-ai/schemastery` peer) and read during import, degrading to off
  when the settings service is absent.

### Fixed

- **Session-start scan no longer recurses into `node_modules` (#16)** — the
  migration hint triggered on `agent/session-start` called `discoverSessions`
  with `path: cwd`, whose recursive walkers (`walkFiles` /
  `walkGrokbuildSessions` / `walkKimiSessions`) had no directory blacklist,
  no depth limit, and no concurrent dedup. Under pnpm's symlinked
  `node_modules` the walk descended into the `.pnpm` store via hundreds of
  alias paths and never terminated — every session pinned ~1 CPU core
  permanently (2 sessions ≈ 270%, 4 cores saturated). All three walkers now
  skip `node_modules` / `.git` / `.venv` / `dist` / `build` / `.next` /
  `.turbo` / `.cache` / `target` / `out` / `.idea` / `.vscode` /
  `__pycache__` etc. (`WALK_SKIP_DIRS`) and cap depth at 12
  (`WALK_MAX_DEPTH`, legitimate chat roots are ≤5 levels). `discoverSessions`
  additionally dedups concurrent same-key scans via an in-flight Promise map
  (`inflightScans`) so multiple sessions starting at once share one scan
  instead of stacking. The existing 30s TTL cache and persistent
  mtime/size bookmarks are unchanged; `DSH_IMPORT_SESSION_HINT=0` remains
  the emergency off switch.

## [0.6.1] - 2026-08-18

### Fixed

- **YAML-escaped skill descriptions (issue #13)** — `skillFrontmatter` now
  single-quotes the `description` value (escaping `'` as `''`), so skills whose
  descriptions contain `: ` (e.g. `Deploy: production helper`) no longer
  produce invalid YAML plain scalars that made DSH silently drop the SKILL.md.
- **MCP mirror plan hardening (issue #14)** — `renderMcpPlan` now single-quotes
  env values (no more broken YAML from `: ` / `#`, and no silent secret
  inlining), generates unique component ids as `mcp-mirror-<source>-<name>`
  with a numeric suffix for collisions, and adds file-header notes telling users
  to verify `dsh-mcp-client` is installed and to replace copied env secrets with
  `${VAR}` references before merging.
- **YAML-parse frontmatter scalars (issue #13 follow-up)** — `parseFrontmatter`
  now understands quoted scalars (`'...'` / `"..."`) and block scalars (`|` /
  `>`), so a source SKILL.md whose `description` uses quotes or a folded block no
  longer carries the quote characters or block markers into the migrated value.
  Test vectors borrowed from sjh9714/dsh-movein's skill-vanish shape list (MIT).

## [0.6.0] - 2026-08-17

### Added

- **Codex asset migration (REQ-64)** — `import_agents` now also collects
  `~/.codex/skills/<skill>/SKILL.md`, `~/.codex/instructions.md`,
  `~/.codex/AGENTS.md`, and `~/.codex/config.toml` into persistent DSH skill
  assets, with `codexRoot` override support.
- **`/attach-workspaces` (REQ-65)** — a new slash command that re-attaches
  already-imported sessions to cwd-matched workspaces from the imports
  registry, fixing early imports that landed in “未分组”.
- **`doctor` / `/doctor` (REQ-66)** — a read-only migration health check that
  verifies imports registry readability, imported session existence,
  `import_agents` skills persistence, and workspace registry availability.
- **Standalone CLI + Markdown export (REQ-67)** — the package now ships a
  `dsh-chat-import` bin with `export-md` (DSH session log → Markdown) and a
  lightweight `doctor`, usable without starting DSH.
- **MCP mirror plan (REQ-68)** — `import_mcp` reads Claude/Codex MCP servers
  and generates a reviewable DSH MCP client YAML snippet (dry-run by default;
  `apply` writes only to a generated file, never editing the profile).
  `/mcp-status` lists discovered servers.
- **opencode tool name mapping (REQ-74 part)** — opencode tool names such as
  `websearch`, `webfetch`, `question`, `todowrite`, and `task` are mapped to
  DSH standard names during import.
- **Global `~/.claude/CLAUDE.md` bridge (REQ-74 part)** — the optional Claude
  context bridge now also injects the global Claude Code `CLAUDE.md` in
  addition to the project-root one.
- **Settings/config translation suggestions (REQ-71)** — `import_settings`
  and `/settings-suggest` read Claude `settings.json` and Codex `config.toml`
  and return DSH migration suggestions (model, permissions, hooks, env,
  provider). Read-only, never auto-applied.
- **`/import-reset` (REQ-74 part)** — clears the in-memory scan cache and the
  persistent `scan-cache.json` bookmarks without touching imported sessions.
- **`/attach-workspaces --mode dedicated` (REQ-70 part)** — supports grouping
  all imported sessions into a single dedicated workspace via `--mode dedicated
  --dir <path>`.
- **`expectedHash` source verification (REQ-72 part)** — all import tools now
  accept an optional `expectedHash` (SHA-256 hex) and fail loudly before
  persisting if the source file does not match.
- **`restamp` timestamps (REQ-72 part)** — all import tools now accept
  `restamp: true` to shift session timestamps to now while preserving relative
  intervals.
- **Import-time workspaceMode (REQ-70)** — all import tools now accept
  `workspaceMode: auto|dedicated|per-project` and `workspaceDir`; `dedicated`
  groups imported sessions into a single workspace at import time.
- **Qoder CLI (`~/.qoder/projects`) import support** — new `import_qoder` tool
  and `qoder` format. Qoder CLI stores per-session transcripts as Claude-style
  JSONL (`~/.qoder/projects/<encoded-project>/<sessionId>.jsonl`, subagents in
  `<sessionId>/subagents/*.jsonl`). The importer preserves text / thinking
  (→ reasoning) / `tool_use` / `tool_result` blocks (paired by `tool_use_id`
  with in-order fallback), the `ai-title` > `last-prompt` > first-user title
  chain, record `cwd`, model and timestamps. Subagent transcripts are skipped
  (only the main `<sessionId>.jsonl` becomes a session). `scan_discover` picks
  up `~/.qoder/projects` by default, and `import_local_jsonl` auto-detects
  Qoder files by their path layout.
- **Kimi Code standalone (`~/.kimi-code`) import support** — `import_kimi`
  previously only understood the old Kimi CLI layout
  (`~/.kimi/sessions/<md5>/<sessionId>/wire.jsonl`) and old wire format
  (`TurnBegin` / `TextPart` / …). It now also discovers and imports the new
  Kimi Code layout
  (`~/.kimi-code/sessions/<workspaceId>/<sessionId>/agents/main/wire.jsonl`)
  and its wire events (`turn.prompt` / `context.append_loop_event` / …), with
  `state.json` providing `cwd` and title metadata. `scan_discover` includes
  `~/.kimi-code/sessions` by default and both layouts remain under the
  `kimi` format / `import_kimi` tool.

### Security

- **Removed `node:child_process` (dsh.so code-exec critical)** — the DSH
  session reader (`import_dsh`) and `scan_discover` previously shelled out to
  the system `zstd` binary and to `git` for branch/dirty detection, which
  static security scanning flags as high-risk code execution. `session.jsonl.zstd`
  decompression now uses `fzstd` (MIT, zero-dependency pure JS), and git branch
  detection now parses `.git/HEAD` directly. As a consequence `scan_discover`'s
  `gitDirty` field is downgraded to always `null` (it cannot be computed
  reliably without invoking git); `gitBranch` keeps working for standard and
  worktree checkouts.

## [0.5.1] - 2026-08-16

First patch release — fixes both findings from [issue #10](https://github.com/Nwflower/dsh-chat-import/issues/10)
(reported by dsh-plugin-healthcheck on 0.4.0):

### Fixed

- **`files` whitelist uses glob patterns instead of fixed filenames** — the
  npm publish list now declares `lib/*.mjs` + `lib/*.js` + the `lib/convert` /
  `lib/export` directories instead of enumerating every `lib/*.mjs` entry, so
  future modules are picked up automatically and the package can never silently
  miss a file. `.github/scripts/build-check.mjs` (the `scripts.build` /
  `prepack` publish-surface self-check) now expands the single-level `*` globs
  with npm-equivalent semantics — which also surfaced and fixed a latent bug
  where `readdirSync` was used but never imported (directory entries made the
  checker crash instead of validating).
- **`peerDependencies.cordis` renamed to `@deepseek-ai/cordis ^4.0.1`** — the
  DSH host runtime actually provides the patched fork
  `@deepseek-ai/cordis` (declared by `@deepseek-ai/dsh` itself); the upstream
  `cordis` package name cannot resolve from a plugin install directory
  (`dep-unresolvable`). The peer now names the real host package the plugin
  runs under.

## [0.5.0] - 2026-08-16

Fourth minor release — completes the interchange / interop track and the
remaining P2/P3 requirements (REQ-09/18/19/21/22/23/30/39/43/45/51/56/62):
interchange v1 protocol + degradation reporting, bundle backup & cross-machine
restore, four-way matrix interop, `/resume-claude` / `/resume-codex` handoff,
ChatGPT branch restore, Reasonix WAL merge + Claude compacted import, cwd
authoritative mapping + home-dir sandbox guard, imported sessions joining the
default preset scope, Reasonix desktop / Claude-3p discovery, Hermes lineage
filtering, and the `makeImportTool` parameter-grouping refactor. 484 test
cases green.

### Added

- **Interchange v1 protocol (REQ-18)** — the internal turns IR is now an
  explicit, versioned, machine-checkable neutral interchange format: JSON
  Schema (`INTERCHANGE_SCHEMA`), `validateInterchange` / `serializeInterchange`
  pure functions, a per-source capability matrix (`SOURCE_CAPABILITIES`, all 14
  sources) and the protocol spec at `docs/INTERCHANGE.md`. It is the shared
  middle layer for source→target adapters, the bundle backup format (REQ-56)
  and the interop matrix (REQ-23).
- **Fidelity degradation policy (REQ-21)** — a documented degradation-rule
  table (`DEGRADATION_RULES`, strategies: lossless / text-fallback /
  skip-placeholder) drives an explicit `degradations` field on every export
  result (`export_claude` / `export_codex` / `export_kimi` / `export_bundle`):
  orphan tool results, skipped injections and skipped attachments are listed
  one-by-one instead of being silently dropped ("fail loudly").
- **Interchange bundle backup / restore (REQ-56)** — new `export_bundle` /
  `restore_bundle` tools: a DSH session is serialized to a `.dshbundle.json`
  (event-level lossless log + double SHA-256 fingerprints — session-level and
  file-level), tamper/corruption is detected loudly on restore, and restore
  reuses the `import_dsh` state machine (idempotent key = bundle path,
  `force` copies). Restore supports directory mode and dry-run preview.
- **Portable bundle across machines (REQ-62)** — the bundle carries
  machine-independent landing info (`originalCwd` + `landingHint`); when the
  original cwd is unreachable on the target machine, restore falls back to the
  REQ-39-lite grouping (bundle file's directory) and reports
  `cwdAvailable: false` / `groupedTo` / `restoreNote` (never silent) — the
  A-machine-export → B-machine-restore flow is a first-class use case
  (benchmarked against codex-claude-transfer).
- **Four-way matrix interop + validation (REQ-23)** — new `export_codex` and
  `export_kimi` tools complete the DSH↔Claude↔Codex↔Kimi matrix out-edges (the
  import edges already existed); new pure serializers `lib/export/codex.mjs`
  (skipped-block counting for honest degradation reports) and
  `lib/export/kimi.mjs` (TurnBegin/StepBegin/TextPart/ThinkPart/ToolCall/
  ToolResult/TurnEnd wire events) with `verifyCodexJsonl` / `verifyKimiWire`
  format pre-checks; new `verify_session` tool — read-only structural
  validation (seq continuity / event-type whitelist / surfaceOp /
  sourceEventSeqs / turn & step balance / tool-call-result pairing) with
  per-kind `repairHints`.
- **Handoff summary resume — `/resume-claude` / `/resume-codex` (REQ-30)** —
  treats external transcripts as untrusted static history and generates a
  handoff summary (goal + last request, involved files/artifacts, last tool
  call, exact stop point, safest next step) injected into the current session;
  selection by most recent / `id:<sessionId>` / title keyword (multiple
  matches list candidates without guessing); summaries never include
  system/developer/thinking content.
- **ChatGPT branch restore + structured tool arguments (REQ-19)** —
  `import_chatgpt` gains `branch: 'main' | 'all'`: `all` enumerates every
  root→leaf path as its own session (placeholder nodes are traversed, the main
  thread is the last-child chain; branch sessions carry a suffixed sourceId and
  a branch-marked title). Assistant JSON parts shaped
  `{tool_name, tool_call_id, args}` now restore as real `tool/call` +
  `tool/result` (arguments kept as JSON strings, FIFO pairing, `sourceEventSeqs`
  linkage) instead of degrading to text blocks.
- **Reasonix V2 WAL merge + Claude compacted import (REQ-22)** —
  `import_reasonix` automatically merges the `<stem>.events.jsonl` WAL with the
  checkpoint (a `{type:'replace', messages:[…]}` event is the authoritative
  snapshot, appended rows win; `walMerged` / `walRecords` reported).
  `import_claude` gains `compacted: true` — imports only the last compression
  summary + tail (summary restored as a leading `reasoning` block, title from
  the summary record).
- **cwd authoritative mapping + sandbox protection (REQ-39 full)** — new
  `lib/cwd-map.mjs`: Claude `~/.claude.json` `projects` keys resolve the
  project slug to the real path (exact / basename / underscore variants,
  CJK-preserving slug encoding) with an ASCII slug-decode fallback, triggered
  only when a transcript lacks a cwd (`cwdHint` hook — no per-file
  `~/.claude.json` reads); Reasonix project slugs decode greedily against disk
  existence (whole remainder → single segment → merge ≤3 segments, tolerant of
  `-` in directory names); home-dir candidates are always skipped from
  workspace attachment (dsh sandbox ACL would reject them), falling back to the
  source directory.
- **Imported sessions fully tool-enabled (REQ-43)** — session creation prefers
  `ctx.agents.create` with a `setup` hook that mounts the default preset scope
  (`agentPresets.mount`, so read/edit/glob/grep-style tools are visible and
  tool calls are standard JSON) and binds the default model
  (`provider`/`model`/`maxTokens` from `agentDefaultModel` + `llm`, so
  auto-compaction can engage); agents service absent/failing falls back to the
  plain `sessionPersistence` path without breaking imports.
- **Source coverage — Reasonix desktop + Claude-3p (REQ-45)** — discovery
  scans the Windows `%APPDATA%\reasonix` desktop layout
  (`projects/<slug>/sessions/*.jsonl` with directory-level `.titles.json`
  authoritative titles, sidecar files excluded) and `%LOCALAPPDATA%\Claude-3p\
  claude-code-sessions` metadata (resolving `cliSessionId` to the matching
  `~/.claude/projects` JSONL with a first-line sessionId check; metadata-only
  fallback when no JSONL exists). Import reuses the existing converters;
  desktop transcripts get `.titles.json` titles and greedy slug-decoded cwd.
- **Hermes session lineage (REQ-51)** — `readHermesDb` exposes
  `parent_session_id` (compaction fork links); `import_hermes` gains
  `lineage: 'tail'` to import only leaf chain tails (parent sessions explicitly
  skipped and annotated), and empty-parent skips are annotated with their
  lineage reason.

### Changed

- **`makeImportTool` parameter convergence (REQ-09)** — the factory spec is
  grouped into `io` / `derive` / `label` / `schema` / `registry` sub-objects
  (identity fields stay flat); all 15 import-tool call sites and the panel's
  `IMPORT_SPECS` consumer were updated to the grouped shape. Pure refactor —
  zero behavior change, 440 tests green at the commit.
- **Tool count 21 → 26** — `export_codex`, `export_kimi`, `export_bundle`,
  `restore_bundle` and `verify_session` join the registration; `index.d.ts`
  `ToolSurface` and `package.json` `files` (new `lib/restore.mjs`,
  `lib/verify.mjs`, `lib/handoff.mjs`, `lib/resume-command.mjs`,
  `lib/cwd-map.mjs`, `lib/export/bundle.mjs`, `lib/export/kimi.mjs`,
  `docs/INTERCHANGE.md`) stay in sync.
- **Idempotent import contract unchanged** — bundle restore, compacted imports
  and branch imports all flow through the same registry / short-path /
  append / force state machine as every other source.

### Fixed

- **`tool/result` degradation honesty in Codex exports** — the Codex serializer
  now counts skipped non-text blocks (`skippedBlocks`) instead of silently
  dropping them, feeding the REQ-21 degradation report.

## [0.4.0] - 2026-08-16

### Added

- **Packaging compliance — `plugin_check` clean (issue #8)** — the v0.3.1
  verdict (`missing-main-or-types` / `no-tsconfig` / `missing-peer` /
  `no-build-script`) is addressed with honest zero-build artifacts: a
  hand-written `index.d.ts` type surface (declared via `types` and the
  `exports["."].types` condition; `ToolSurface` types all 21 registered
  tools' parameters / results, aligned to the `makeImportTool` schemas),
  `peerDependencies.cordis` (`^4.0.0`), a minimal `tsconfig.json`, and
  `scripts.build` / `scripts.prepack` running `.github/scripts/
  build-check.mjs` — a publish-surface self-check (files whitelist
  completeness + `node --check` syntax over every shipped `.mjs`/`.js` +
  lockfile root version match) that aborts the publish on any failure.
- **Star History chart on the bilingual READMEs** — a dedicated `⭐ Star
  History` section embeds the `api.star-history.com` chart
  (linked to the interactive page), making the 35★-in-two-days growth
  curve visible at a glance.

- **Two-way incremental sync control panel** — sidebar panel gains a Sync tab
  (`GET/POST /api-import/sync`). Optional inbound watch (Claude / Codex / Grok
  new or grown sessions → DSH append) and outbound writeback (DSH complete
  turns → Claude source file, or Codex / Grok copies). Both directions default
  **off**; a timer starts only after the user enables a switch. Outbound
  copies for native DSH sessions are tracked in `outbound.json` so inbound
  scans skip them (no echo loop).

- **`import_agents` (REQ-59, 14th tool)** — converts custom agents / mode
  prompts / skills from **pi** (`~/.pi/agent/{agents,prompts}/*.md`) and
  **opencode** (`~/.config/opencode/{agents,skill}/*.md`) into persistent DSH
  skill assets (`$DSH_AGENTS_HOME/skills/<name>/SKILL.md`, default
  `~/.agents`). Dry-run by default (plan only, zero side effects); `apply:
  true` writes. Same-name conflicts get a `-pi`/`-opencode` suffix, identical
  content is skipped, `kind: dsh|skill` sources are not re-imported, bundle
  dirs lacking `SKILL.md` are completed in place, and nested YAML is preserved.
  Complements the runtime-only Claude bridge (`context-bridge`, REQ-28).
- **Local JSONL session-file import (auto-detect)** — new
  `import_local_jsonl` tool accepts any local `.jsonl` file or directory and
  auto-detects the transcript structure across `dsh` / `claude` / `codex` /
  `cursor` / `reasonix` / `pi` / `openclaw` / `hermes` (path hints order the
  candidates; the first converter that yields a session wins), with an
  optional `format` parameter to force one parser. Directory mode imports
  every `.jsonl` as its own session through the same idempotent/incremental
  state machine.
- **DSH session-log source (14th import source)** — new `import_dsh` tool
  imports DeepSeek Harness' own session logs (`session.jsonl` and
  `session.jsonl.zstd`, default root `~/.dsh/sessions`), decompressing zstd
  logs with the system `zstd` binary and keeping the durable
  turn/step/user/assistant/tool events while streaming chunks and runtime
  state events are dropped. `scan_discover`, the sidebar panel source filter
  (`dsh`), `/import dsh <path>` and `format: 'dsh'` cover the new source too.
- **Kimi CLI source (REQ-14, 13th import source)** — new `import_kimi` tool
  imports Moonshot AI's open-source terminal agent sessions from
  `~/.kimi/sessions/<workdir-md5>/<sessionId>/wire.jsonl` (single session
  directory or a whole `sessions/` tree), mapping the wire event stream —
  `TurnBegin` / `SteerInput` user inputs, `TextPart` / `ThinkPart` content
  (streamed chunks merged), `ToolCall` / `ToolResult` tool calls & results
  (paired with `sourceEventSeqs`), status/control events filtered, and
  `SubagentEvent` sub-agent mirrors skipped & counted — onto the shared turns
  IR. Titles come from `state.json` `custom_title` (authoritative) with the
  first user text as fallback; `cwd` resolves via `~/.kimi/kimi.json`
  (workdir → md5 directory name); idempotent skip / incremental append /
  context-budget trim are identical to the other 12 sources. `scan_discover`,
  the sidebar panel filter and `format: 'kimi'` cover the new source too.
  `npm test` — 367 cases.

- **Import panel follows the DSH web language (zh / en)** — every panel string
  (trigger title/label, panel title, source filter, search, select-all,
  pagination, import-status labels, per-item buttons and result summaries) moved
  from hardcoded Chinese into a `chat-import` dictionary registered with
  `@deepseek-ai/dsh-client-locale` (`LocaleRuntime.register`), switching live
  with the web UI's language via `subscribe`. Missing `locale` service degrades
  to the built-in zh dictionary (previous behavior). The bilingual README
  tagline is corrected to 12 sources.

### Fixed

- **Archived imported sessions can be re-imported (REQ-55)** — previously the
  import status was derived purely from the imports registry, so after
  archiving an imported DSH session (hidden from the sidebar; the session and
  its id remain in persistence) the panel and `scan_discover` still reported
  it as `imported` and a re-import was skipped as already-imported. Both layers
  now consult the workspace registry's global archive set
  (`workspaceRegistry.archivedSessionIds`):
  - discovery reports such sessions as a new **`archived`** status (已归档 /
    Archived badge) and the panel shows the **导入** button instead of the
    sync-only row, so the source is re-importable;
  - re-importing an archived target creates a fresh copy under a suffixed id
    (`import-<sessionId>-<n>`, same minting as `force`), leaving the archived
    session untouched, for single-file sources (all 13) and per-session inside
    multi-session sources (chatgpt / opencode / zcode / hermes db); the
    registry record points at the new copy. `scan_discover`'s `importStatus`
    enum and summary include `archived`.
  `npm test` — 385 cases.

## [0.3.1] - 2026-08-14

### Added

- **Browser-side session discovery & import panel (REQ-41)** — the dsh web
  sidebar gains an **导入会话** entry (a `sidebar.footer.action` list slot; the
  client is a hand-written CJS bundle `lib/client.js` declared via `dsh.client`
  in `package.json`). Stage 1 added the read-only discovery panel — a source
  filter + session list backed by the new host route `POST /api-import/sessions`
  (the same discovery as `scan_discover`: 30s TTL cache + persistent mtime
  bookmarks, zero side effects). Stage 2 adds **workspace-folder grouping**
  (sessions grouped by each source's `cwd`/project, "(未分组)" bucket),
  **single import** and **multi-select import** (checkbox + "导入所选 (N)") via
  the new host route `POST /api-import/import`, which reuses the exact
  `import_*` tool pipeline — idempotent skip / incremental append / `force` /
  context-budget semantics are identical, multi-session sources
  (`conversations.json`, opencode/zcode/hermes DBs) import whole-source
  (opencode/zcode restrict to the selected `sessionId`s), and the list refreshes
  with the new statuses after importing. The `pi` source joins the panel filter,
  and the `source` filter may be omitted to scan all formats at once. Stage 3
  adds **search** (by title / workspace / path, server-side filtered) and
  **pagination** (50 per page, `offset`/`limit` + `total` from
  `/api-import/sessions`), with selections kept across pages for bulk imports.

### Changed

- **Export serializer split into `lib/export/`** — the reverse-export
  serializer (DSH session events → Claude Code JSONL) moved from the root
  `export.mjs` into `lib/export/claude.mjs`, mirroring how `convert.mjs` keeps
  its implementation in `lib/convert/`. The root `export.mjs` is now a
  re-export shim, so the `exports["./export.mjs"]` subpath contract and every
  existing `import` stay intact; `lib/export/` is reserved per target format
  (future REQ-23 interchange targets).

- **Cross-platform path discipline guard — `npm run check:linux`** — CI's
  `npm test` (ubuntu / node 22) used to stay red while the suite passed on
  Windows: tests build synthetic trees with backslash paths while the code's
  `join()` produces mixed separators under posix, so bare mock `tree[key]`
  lookups missed on Linux, and assertions compared `node:path` results against
  hardcoded `X:\…` literals. The new static guard (`.github/scripts/
  check-linux-compat.mjs`, run in CI after lint) fails on those two
  anti-patterns; all mock `stat`/`readText`/`listDir` lookups now normalize
  separators (three-way `norm` + `lookup`, uniform across `index`/`req26`/
  `req33`/`zcode` test mocks). Also documented in `AGENTS.md` (命令 /
  提交纪律 / 质量约定) and available as a local pre-push hook
  (`git config core.hooksPath dev/hooks`).
- **Sidebar trigger restyled to match the Settings entry, with the plugin logo
  as its icon** — the floating **导入会话** trigger (fixed overlay so the
  full-width Cordis badge can never squeeze it out) now uses the same visual
  language as the sidebar's **设置** button: transparent background, 12px
  radius, 16px icon + 14px label, subtle hover; the text glyph was replaced by
  an inline render of `assets/import.svg` (currentColor, so it follows the
  light/dark theme). Dimensions and typography are matched pixel-for-pixel with
  the Settings entry (full-width 264×34, 22px line height, `6px 2px 6px 10px`
  padding, 8px gap, and the same CSS variables for label color / hover
  background). Placement is now **conditional on the Cordis badge**: the button
  only floats above the footer while the official badge occupies the footer
  row; when the badge is hidden or absent it drops into the footer row itself
  (right above 设置), detected via `[data-cordis-badge]` visibility watched by a
  `MutationObserver`.
- **`index.mjs` split by responsibility into `lib/` host modules** — the plugin
  entry shrank from ~2500 lines to a 54-line composition that only assembles the
  pieces; every moved line is byte-identical (pure refactor, zero
  behavior change, verified by the full mock-integration suite). New layout:
  `lib/budget.mjs` (REQ-37 context-budget chain), `lib/import-core.mjs` (shared
  import orchestration: `importTranscript` state machine / `importDirectory` /
  `runDecision` / workspace attach / projection warm-up / standard previews),
  `lib/import-variants.mjs` (special-shaped sources: chatgpt / grokbuild /
  hermes orchestration + opencode / zcode dry-run previews), `lib/toolkit.mjs`
  (`makeImportTool` factory + `IMPORT_SPECS`), `lib/export-tool.mjs`
  (`export_claude` body), `lib/retract.mjs` (REQ-33 identify / retract),
  `lib/discovery-host.mjs` (REQ-25/40 `scan_discover` host adapter),
  `lib/panel.mjs` (REQ-41 panel routes), `lib/tools.mjs` (all 17 tool
  registrations). `package.json` `files` whitelist and `AGENTS.md` layout /
  DSH-dependency rules updated to match; the `index.mjs` public export surface
  (`apply` / `inject` / `name` / `readOpencodeDb` / `readZcodeDb` /
  `exportClaudeSession`) is unchanged.

### Fixed

- **Import panel: session list now scrolls; workspace groups collapse on click**
  — the session list lost its scroll container in the Stage-3 rewrite (groups
  were rendered straight into the fixed panel, so long lists overflowed past
  the viewport with no way to scroll; `clientH` vs `scrollH` mismatch). The
  list is a proper `flex:1; overflow-y:auto` container again, and the
  workspace-folder group headers (`▾`) now toggle collapse/expand on click.
- **Imported sessions stay findable when the transcript `cwd` does not exist
  locally (REQ-39-lite)** — `workspaceRegistry` only owns workspaces for
  directories that exist (`fs.realpath`); transcripts migrated from another
  machine carry cwds that do not exist here, so every such import silently
  landed in the collapsed "未分组" group and looked like "nothing was
  imported". `attachToWorkspace` now falls back to the **source file's
  directory** (the source directory itself when the source is a directory) as
  the workspace when the `cwd` cannot be resolved — e.g. a `conversations.json`
  without a cwd is grouped under its export directory. Opened sessions always
  render their messages (verified); this fixes their visibility in the sidebar.
- **Import panel reports actionable errors instead of a raw `Failed to execute
  'json'…Unexpected end of JSON input`** — the panel's `fetch` now reads the
  response as text and parses defensively: an empty / non-JSON response (e.g.
  the host route not being registered because the dsh process predates the
  `webServer`-optional fix) shows a clear hint ("路由可能未注册，请重启 dsh 后
  重试") instead of surfacing the browser's `Response.json()` exception.
- **Import-panel trigger no longer covered by other footer entries (REQ-41)** —
  `sidebar.footer.action` is a 256px flex row; the official Cordis plugin badge
  is a `flex: none; width: 256px` entry that occupies the whole row, squeezing
  any sibling entry out of the container where the sidebar's `overflow: hidden`
  clips it and the main content column covers it. The **导入会话** trigger is
  now rendered as a fixed-position floating pill above the sidebar footer
  (z-index above page content), so it stays visible and clickable regardless of
  other footer occupants (icon-only in rail mode). The panel also closes on
  `Escape` — its full-screen overlay previously had no keyboard escape and
  blocked the whole page while open.
- **`webServer` demoted from hard `inject` to an optional service** — REQ-41 had
  added `webServer` to the plugin's `inject` list, which made the whole plugin
  (all 12 import tools included) fail to activate in any dsh profile without a
  web server (headless CLI sessions, the CI headless smoke job). The
  `/api-import/*` panel routes are now registered through
  `ctx.inject(['webServer'], …)` — a callback Cordis starts once the service is
  available — so routes appear in web profiles (including when the web-server
  service mounts *after* this plugin's `apply`, which a plain `ctx.get` at apply
  time misses) while headless profiles never run the callback and the import
  tools stay available. Also regenerated `package-lock.json` so the REQ-41 peer
  dependencies (`@deepseek-ai/dsh-client-locale`, `react`) are recorded and
  `npm ci` stops failing with EUSAGE.
- **Tool registration fails loudly on a stale `@deepseek-ai/dsh-tools` copy** —
  the plugin now declares a named import of `TOOL_RUNTIME_SCHEDULER` (which only
  exists since `^0.1.0-rc.6`) and checks at registration time that it is the
  expected symbol. Resolving the old `dsh-tools@0.0.1-rc.1` ABI (which only
  exports `TOOL_REGISTRY_SCHEDULER`) now fails the module load / plugin
  activation immediately with a clear message, instead of silently registering
  tools against the old ABI and crashing the host agent-loop later
  (`Cannot read properties of undefined (reading 'prepare')`).

## [0.3.0] - 2026-08-14

Third minor release — shipped 2026-08-14 with four new import sources (Grok
Build, OpenClaw, Hermes, Pi Coding Agent — the 9th–12th), automatic session
discovery with persistent scan bookmarks, import identification / retraction,
zero-side-effect import preview, and the reverse export + incremental
write-back bridge (`export_claude` / `sync_to_claude`). Release tag `v0.3.0`
pending publish.

### Added

- **Imported-session listing + retract guidance — `list_imported_sessions` /
  `retract_import`** (REQ-33) — a new read-only pair of tools: `list_imported_sessions`
  enumerates every DSH session imported by this plugin (the `session/imported`
  marker at `seq 0` is the authoritative signal; the imports-registry `dshId` set
  is the fallback when a session log cannot be read — sessions without a marker
  never appear), returning `sessionId` / `title` (when an explicit title exists) /
  `sourcePath` / `artifactPath` (`sessionPersistence.locate`) / `importedAt`;
  `retract_import` (`sessionId` or `sourcePath`, one of the two) removes the
  imports-registry record and returns the manual-delete artifact guidance
  (`manualDelete`) — nothing is ever deleted, because the platform has no delete
  surface (`sessionPersistence.remove` / `fs.removeFile` do not exist). The marker
  stays in the log, so re-retracting the same session is idempotent
  (`wasRegistered: false` on a repeat call); delete the artifact manually first,
  then a re-import creates a genuinely fresh full copy.
- **Persistent scan bookmarks — `scan_discover`** (REQ-40) — `scan_discover`
  now persists mtime/size bookmarks to `scan-cache.json` under
  `$DSH_HOME/dsh-chat-import/` (the same directory as the imports registry),
  partitioned per format as `<sourcePath> → { mtimeMs, sizeBytes, entries }`:
  unchanged files are not re-scanned across process restarts, on top of the
  in-process 30s TTL cache. Writes are atomic (temp + fsync + rename); a
  corrupted or missing cache falls back to a full scan with a warning and never
  affects results.
- **Automatic session discovery — `scan_discover`** (REQ-25) — a new
  read-only tool that scans the known data roots of all **12 source
  formats** (Claude / Codex / ChatGPT CLI / Cursor / Gemini / Reasonix /
  opencode / ZCode / Grok Build / OpenClaw / Pi Coding Agent / Hermes,
  plus ChatGPT web exports) and returns a structured session index
  (`format` / `sessionId` / `title` / `project` / `createdAt` /
  `lastActiveAt` / `messageCount` / `sourcePath` / `importStatus`) for
  previewing before a batch import. Optional `path` (scan root or single
  file), `format` (restrict one format) and `query` (title / project /
  path substring filter) parameters; zero side effects (no `create` /
  `append`, no registry writes, no workspace attach); injection-filtered
  title extraction and an in-process **30s TTL scan cache** (a same-key
  re-scan within 30s hits the cache without re-reading source files).
- **Malformed-line line numbers + secret locations + permission counts**
  (REQ-26) — import reports now carry `skippedLines` (malformed-record
  details `{ line, error }`, line numbers from 1 — count unlimited,
  detail list capped at 200), `secrets` (suspected-secret locations
  `{ line, kind }` — position only, content is never output) and
  `permissionCount` (Claude-source permission records, counted only),
  alongside the existing `skipped` count.
- **Zero-side-effect import preview — `preview` / `dryRun`** (REQ-17) —
  every `import_*` tool accepts `preview: true` (alias `dryRun: true`):
  the source is resolved / read / converted exactly like a real import
  but nothing is persisted (no `create` / `append`, no registry read or
  write, no workspace attach). It returns the same `mode` / `total` /
  `results` skeleton with a `preview: true` marker and no write-state
  fields; each entry carries the would-be session's title / `cwd` /
  creation time / scale (turns / messages / tool calls) and skip details.
- **Grok Build source import** (`import_grokbuild`) (REQ-46) — the 9th import
  source: reads `~/.grok/sessions/<project>/<session_id>/` session
  directories (archived ones under `~/.grok/archived_sessions/`), each holding
  `summary.json` (`info.id` / `info.cwd`, `generated_title`,
  `session_summary`, timestamps) + `chat_history.jsonl` (`user` /
  `assistant` / `tool` / `system` / `reasoning` records with string or
  Claude-style block `content`). `reasoning` (encrypted internal state) and
  `system` (harness injection) records are filtered and counted; `tool_use` /
  `tool_result` pair by `tool_use_id` back to the declaring step (cross-step
  async results included), orphan results dropped and counted; titles resolve
  `generated_title` > `session_summary` (pinned) with a first-question
  fallback; `provider='grokbuild'`. A single session directory imports as one
  session, a `sessions` / `archived_sessions` root scans recursively (batch).
- **OpenClaw source import** (`import_openclaw`) (REQ-47) — the 10th import
  source: reads `~/.openclaw/agents/<agent>/sessions/*.jsonl` (one session
  per file) with `{type:"session", id, cwd, timestamp}` metadata lines and
  `{type:"message", message:{role, content}}` messages; the `toolResult`
  role pairs results back to their `tool_use` (by `tool_use_id`, or the most
  recent unresolved call for plain-text results), `[message_id: …]` gateway
  suffixes are stripped, and results in one step are ordered to match the
  step's calls; a sibling `sessions.json` index supplies the `displayName`
  used as the pinned title (fallback: first user text, then the `cwd`
  basename); `provider='openclaw'`.
- **Hermes source import** (`import_hermes`) (REQ-48) — the 11th import
  source: reads `~/.hermes/` (Windows `%LOCALAPPDATA%\hermes`) history —
  `state.db` (SQLite `sessions` + `messages` tables, the authority index;
  column variants `cwd`/`directory`, `started_at`/`created_at`,
  `ended_at`/`updated_at`, messages ordered by time) is read first, with a
  `sessions/*.jsonl` fallback (flat `{role, content, ts}` or nested
  `{type:"session"|"message", message, timestamp}`) when the DB is
  unavailable. `thinking` → `reasoning`, `tool_use` / `tool_result` pair by
  `tool_use_id` back to the declaring step; `provider='hermes'`. A
  `state.db` always returns the batch shape (one DB holds all sessions); a
  lone `.jsonl` imports as a single session.
- **ZCode source import** (`import_zcode`) (REQ-38) — the 8th import source:
  reads the z.ai official CLI's `~/.zcode/cli/db/db.sqlite` (SQLite authority
  index) read-only via `node:sqlite`; the `message` / `part` rows carry no
  `sequence` column, so the message stream is rebuilt by
  `ORDER BY time_created, id`, and only main sessions (`parent_id IS NULL`)
  are imported. `compaction` parts restore their compressed summary
  (`data.summary.body`) as a leading `reasoning` block (the compaction body
  itself never enters the conversation), tool parts emit `tool/call` +
  `tool/result` in pairs (`state.output` inline), `<system-reminder>`
  injections are filtered, and `provider='zcode'`. When the DB is unavailable
  the import falls back to the legacy `transcript.jsonl` (last `model_request`
  messages, tool results back-filled into the tool part's `state.output`).
  One DB holds all sessions, so the tool always returns the batch shape
  (`zcode://<id>` pseudo-path / `sessionIds` filtering, DB-level
  fingerprinting, per-session append / `sourceShrunk`).
- **Title fallback** `custom-title > ai-title > first question` (REQ-27) —
  every source now resolves its session title by priority: `custom-title` >
  `ai-title` (Claude) / the source-recorded title (ChatGPT, opencode, ZCode,
  Reasonix meta summary) > the first user prompt as a fallback; titles are
  normalized (trim, collapse inner whitespace) and truncated at 80 characters
  (an ellipsis is appended on overflow). Explicit titles are still pinned with
  a `session/title` event; a pure first-question fallback only fills the title
  field without writing an event (DSH auto-falls back to the first user text
  for untitled sessions), and blank titles never emit a title event.
- **Codex `custom_tool_call` JS arguments → standard JSON** (REQ-44) — 2026+
  Codex writes `custom_tool_call.input` as JS code (e.g.
  `tools.exec_command({cmd: "...", workdir: "..."})`); the importer now
  recognizes the object-literal call shape and converts it to standard JSON
  arguments so the model never learns a JS/XML hybrid call format.
  Unconvertible shapes (`apply_patch`, `ALL_TOOLS` dynamic calls) degrade to a
  descriptive note text instead of passing JS code through as `arguments`;
  conversion failures are counted (`droppedMalformedArgs`) and never break the
  message stream.
- **Pi Coding Agent import — `import_pi`** — the 12th import source:
  imports Pi Coding Agent session
  JSONL (`~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl`) as
  resumable DSH sessions: header `id`/`timestamp`/`cwd` → session id / creation
  time / workspace grouping, the tree structure rebuilt along the **active
  branch only** (last entry → root walk via `id`/`parentId`; v1 linear files
  chain in file order), `toolCall`/`toolResult` paired by `toolCallId` (orphan
  results dropped and counted), `thinking` → `reasoning`, and
  `bashExecution` / `custom` / `branchSummary` / `compactionSummary` injected
  messages mapped with Pi’s own `convertToLlm` wording onto the adjacent
  assistant step. Context compaction is respected by default (last summary +
  `retainedTail` / legacy `firstKeptEntryId` range + tail) with an optional
  `fullHistory: true` (part of the import-args fingerprint → `argsChanged` on
  a value switch), `session_info` name → title, `model_change` / per-message
  model → session / step model. Single-file and recursive-directory modes,
  idempotent re-import, incremental append and budget trimming reuse the
  shared import machinery. `scan_discover` gains the `pi` format (root
  `~/.pi/agent/sessions`, header `version` as the format signature,
  `session_info` name → title).
- **Pi converter unit + integration coverage** — synthetic fixtures
  (`pi-simple` / `pi-tool` / `pi-branch` / `pi-compaction` / `pi-v1`) covering
  turn balance, tool pairing, active-branch walk, branch-summary reasoning,
  compaction default vs `fullHistory`, v1 linear fallback and malformed-input
  skipping; `import_pi` integration tests cover persist + workspace attach,
  directory batch import, idempotency and the `fullHistory` args fingerprint.

- **Incremental re-import** (REQ-24) — re-importing the same source path no
  longer just skips: a grown source file appends only its **new turns** to the
  same DSH session (contiguous `seq` continued from the authoritative stored
  log, source turn numbering, no duplicated `session/imported` marker or
  title), an unchanged file is skipped on a stat-level short path without
  re-reading it, a truncated file is detected and reported (`sourceShrunk`),
  in-place growth inside existing turns reports `changedInPlace`, and
  `force: true` creates a fresh full copy under `import-<sessionId>-<n>` while
  the old session stays untouched.
- **Source-path idempotency registry** — new `lib/imports.mjs` persists
  `$DSH_HOME/dsh-chat-import/imports.json` (source absolute path → import
  record, `{ kind, dshId, turns, events, sizeBytes, version, args, importedAt }`)
  with atomic temp+fsync+rename writes via `node:fs/promises` (never `ctx.fs`),
  in-process serialized writes, and missing/corrupted-file tolerance. Two
  different source paths sharing one session id now both import (suffix
  avoidance) instead of one silently shadowing the other; sessions imported
  before the registry existed are detected via the `session/imported` marker
  and back-filled (`backfilled`).
- **Projection-cache warm-up on import** (external PR #1) — after a session is
  created, its projection cache is cold-read and written back so the sidebar
  shows the real title / model metadata immediately instead of the `cwd`
  directory name until the session is opened; a warm-up failure never affects
  the import result.
- **eslint flat config + CI lint** (REQ-10) — `eslint.config.mjs` added
  (dev-only, not shipped), `npm run lint` wired into CI, and existing
  violations fixed in the same commit.
- **`tailSessionEvents`** — pure event-level tail extraction in `convert.mjs`
  (slice by `turn/start` boundaries, renumber `seq` from `fromSeq`, remap
  in-tail `sourceEventSeqs`, keep out-of-tail references with a
  `droppedBoundaryResults` count, strip `session/title` by default).
- **Multi-session sources go incremental** — ChatGPT (`kind:'multi'` +
  `conversations` sub-records: per-conversation append / new / removed
  `missingFromSource`, `force` = full new copies) and opencode (`kind:'multi'` +
  `sessions` sub-records: DB-level version/size fingerprinting, compaction
  shrinking turns → `sourceShrunk`, `fullHistory` in the args fingerprint →
  `argsChanged`).
- **Shared `force: boolean` parameter** on all twelve import tools, and extended
  return shapes: single-mode `status` (`imported` / `already-imported` /
  `appended` / `skipped`) plus optional `appendedTurns`, `appendedEvents`,
  `appendedSkipped`, `sourceShrunk`, `changedInPlace`, `argsChanged`,
  `backfilled`, `forceImported` and `droppedBoundaryResults`; batch mode gains
  an `appended` counter, `appended` result status and `missingFromSource`.
- **Reverse export — `export_claude`** (REQ-16) — serializes an existing DSH
  session (imported or native, read-only via `sessionPersistence.list` +
  `readFrom`, never `load`/`prepare`, never rewritten) into a Claude Code
  JSONL transcript at `<outputDir>/<slug>/<uuid>.jsonl` (fresh UUID v4 file
  name plus a `createIfAbsent` write guard so an existing file is never
  overwritten; `dryRun` support). The pure serializer lives in the new
  `export.mjs` (zero DSH deps, injectable uuid for deterministic tests):
  user / assistant / `tool_result` records in `seq` order, tool results
  chained to the declaring assistant (`parentUuid` /
  `sourceToolAssistantUUID`, parallel results fan out to the same assistant),
  `thinking` from `reasoning` (empty `signature`), `ai-title` from the session
  title, trailing empty `tool_result` for interrupted calls, orphan results
  dropped and counted (`droppedToolResults`), non-human injections skipped and
  counted (`skippedInjections`), non-text blocks skipped and counted
  (`skippedBlocks`). The tool return carries a `mapping` shape
  (sourceSessionId → new UUID, file path, record counts) reserved for the
  reverse-sync registry (REQ-24/36); for imported sessions the mapping is now
  persisted into the registry (`record.exports`), which anchors the REQ-36
  `target: "copy"` write-back.
- **Reverse sync — incremental write-back `sync_to_claude`** (REQ-36) — the
  first step of the bidirectional sync bridge: appends a DSH session's **new
  complete turns** back to a Claude Code JSONL file (the import source with
  `target: "source"`, or the last `export_claude` copy with `target: "copy"`)
  so the file keeps being resumable. The pure core lives in the new
  `lib/backfill.mjs` (zero DSH deps, ctx-injected `fs` /
  `sessionPersistence`): the serializer is a shared-core variant
  (`serializeClaudeJsonlTail` — no mode / permission-mode / ai-title header,
  first record chained to the previous watermark's `prevUuid`,
  cross-watermark delayed tool results counted as orphans) fed by
  `tailClaudeEvents` (only turns closed by `turn/end`; half-open in-progress
  turns are dropped and reported as `incompleteFinalTurn`). The first sync
  baselines the watermark from the target file itself; afterwards three pure
  guards (`evaluateWritebackGuards`) plus a stored-log check refuse to
  overwrite: `sourceShrunk`, `source-modified-externally`, `tail-mismatch`,
  `write-version-mismatch` (CAS `replaceIfVersion`), `storedShrunk`,
  `source-missing` — `force: true` skips the guards and re-anchors the bridge
  to the file's current state. A `verifyClaudeJsonl` format pre-check rolls a
  bad write back and never advances the watermark. The registry record gains
  `writeback` (`{ sessionUuid, filePath, lastWrittenSeq, lastWrittenTurn,
  prevUuid, lastSize, lastVersion, writtenAt }`) with `turns` re-converted so
  a later re-import stays idempotent (no duplicate append). Multi-session
  sources and native sessions are rejected; `dryRun` computes everything
  without writing.
- **Oversized-session protection** (REQ-37) — three-layer guard for very long
  imports (without it an over-limit session fails with a 400 on resume when the
  model has no provider config and auto-compaction cannot engage): L1 crops
  individual content blocks (text / reasoning ≤ 16K chars, tool results ≤ 40K
  chars, keeping the head 75% + tail with a crop marker); L2 truncates turns to
  the resolved context budget (keeps the earliest 3 user texts as an anchor,
  prepends a compression summary as a `reasoning` block, keeps the tail
  greedily within the remaining budget); L3 drops any single message still over
  half the budget after cropping — the first turn's prompt is never dropped,
  oversized steps go with their tool calls, oversized tool results are replaced
  by empty ones — so a resumable conversation always survives. Sessions within
  budget are left intact except for L1 single-block cropping. The pure core
  lives in `convert.mjs` (`estimateTokens` — CJK 1 token/char, ASCII 1
  token/4 chars — plus `cropContentBlocks`, `trimTurns`, `applyBudgetTrim`) and
  is wired into all twelve sources before `synthesizeSession`; trimming reports
  `trimmed: null` when nothing was actually cut.
- **Adaptive import budget + explicit trim reporting** (REQ-37) —
  `resolveImportBudget` in `index.mjs` resolves the per-import context budget as
  tool parameter `budget` > env `DSH_IMPORT_CONTEXT_BUDGET` > dynamic model
  window (`agentDefaultModel.currentSelection()` + `llm.resolveModelInfo`
  minus the output cap and `max(25%, 40K)`) > static 550K default, silently
  falling back when any link is unavailable. Import reports gain a `trimmed`
  counter (budget, source, original / estimated tokens, cropped blocks, dropped
  turns / messages / tool calls / tool results, oversized drops, summary
  marker), and the imports registry records the budget so a budget change skips
  with `budgetChanged` (same semantics as `argsChanged`; `force: true`
  rebuilds).

### Changed

- Idempotency contract updated (bilingual README): "already imported → skip"
  becomes "already imported → skip if unchanged, incrementally append new
  turns if grown" — re-importing a live session now follows the source file.
- Append discipline: appended events keep `surfaceOp: 'append'`, never re-attach
  workspaces, and never re-emit the import marker or session title.
- **Conversion core split per source** (REQ-08) — `convert.mjs` became a
  re-export shim over `lib/convert/*.mjs` (a shared `core` plus one converter
  per source; pure functions, zero DSH deps), and opencode SQLite reading moved
  into `lib/opencode.mjs`. No tool names, schemas or return shapes changed; the
  npm `files` whitelist was extended for the new modules.
- **README slimmed to a user-facing document** — technical / engineering detail
  moved to the local, never-published `dev/REQUIREMENTS.md`; the tagline and
  badge area reworked for the 11-source line-up.

### Fixed

- **`trimTurns` L2 anchor shrink silently dropped turns** (REQ-49) — when
  the whole turn list was within the 3-anchor minimum and the budget was
  so small that even the anchor plus summary allowance exceeded it, turns
  shrunk off the anchor tail vanished without being counted, so `trimmed`
  could report `null` despite real loss (violating "fail loudly"). Turns
  dropped by anchor shrink are now counted into `trimmed`
  (`droppedTurns` / `droppedMessages` / `droppedToolCalls` /
  `droppedToolResults`) so the report reflects the real loss; at least
  one resumable turn is still guaranteed.

## [0.2.0] - 2026-08-14

Second minor release — shipped 2026-08-14 with two new import sources
(Reasonix, opencode), engineering guardrails (clean lockfile and CI checks,
package metadata) and P0 fixes that keep imported sessions resumable. Tagged
`v0.2.0` (`ae01548`).

### Added

- **Reasonix session import** (`import_reasonix`) — OpenAI-style JSONL sessions
  with v1/v2 `tool_calls`, sibling meta-file for `cwd` and a pinned title, and a
  filename-embedded creation-time fallback ([b50b1cd](https://github.com/Nwflower/dsh-chat-import/commit/b50b1cd)).
- **opencode session import** (`import_opencode`) — reads the SQLite
  `session`/`message`/`part` tables with inline tool results, respects opencode
  conversation compaction by default, supports `sessionIds` and `fullHistory`
  ([02a87a2](https://github.com/Nwflower/dsh-chat-import/commit/02a87a2)).
- **`package-lock.json` for reproducible CI installs**, with the npm cache
  re-enabled in CI ([651f202](https://github.com/Nwflower/dsh-chat-import/commit/651f202), [67f7c2b](https://github.com/Nwflower/dsh-chat-import/commit/67f7c2b));
  later regenerated clean, with CI moved to `npm ci` and a lockfile-drift check
  added ([0389307](https://github.com/Nwflower/dsh-chat-import/commit/0389307)).
- **Awesome-list badges** on the bilingual READMEs ([1f1e7ce](https://github.com/Nwflower/dsh-chat-import/commit/1f1e7ce), [e1d3faa](https://github.com/Nwflower/dsh-chat-import/commit/e1d3faa)).
- **CHANGELOG itself** — 0.1.0 / 0.1.1 / 0.2.0 sections following Keep a
  Changelog, shipped in the npm package ([f9a1918](https://github.com/Nwflower/dsh-chat-import/commit/f9a1918)).
- **Bilingual README structure sync check in CI** — heading hierarchy and
  anchor keys compared between `README.md` and `README.zh-CN.md`
  ([a12480d](https://github.com/Nwflower/dsh-chat-import/commit/a12480d)).
- **Headless real-load smoke job in CI** — boots the plugin with a mock LLM to
  verify it activates outside the live harness ([0e8bdd7](https://github.com/Nwflower/dsh-chat-import/commit/0e8bdd7)).

### Changed

- **README rewritten (bilingual)** around quick start, features and a 7-source
  overview table; test count corrected 68 → 79 ([585cece](https://github.com/Nwflower/dsh-chat-import/commit/585cece)).
- Reasonix import documented in the bilingual READMEs ([0aded42](https://github.com/Nwflower/dsh-chat-import/commit/0aded42)).
- Multi-session protocol documents the pending-merge area ([c691324](https://github.com/Nwflower/dsh-chat-import/commit/c691324)).
- Peer dependency policy relaxed to `^0.1.0-rc.6` so the plugin installs
  alongside newer DSH releases ([117e7a1](https://github.com/Nwflower/dsh-chat-import/commit/117e7a1)).
- `package.json` metadata completed and `engines` pinned to `>=22.13`, with the
  lockfile's engines entry synced to match ([7162957](https://github.com/Nwflower/dsh-chat-import/commit/7162957), [41ad12a](https://github.com/Nwflower/dsh-chat-import/commit/41ad12a)).

### Fixed

- **Imported sessions stay resumable when a `tool/call` has no matching
  result** (P0) — model APIs reject an assistant message whose `tool_calls`
  never get a corresponding tool message, so a synthetic empty `tool/result` is
  appended to keep continuation working ([1d9a8e5](https://github.com/Nwflower/dsh-chat-import/commit/1d9a8e5)).
- **Imported message order follows the wire rules** (P0) — `tool/result` is
  attached to the step owning its `tool/call`, and Codex imports gain the
  missing tool-call block, so the projected order no longer violates the
  assistant-`tool_calls`-then-tool-message contract and sessions stay resumable
  ([d13f790](https://github.com/Nwflower/dsh-chat-import/commit/d13f790)).
- **Claude directory imports only recognize the main transcript** — subagent /
  workflow fragments are skipped so they can never shadow or collide with the
  main conversation ([77de7cd](https://github.com/Nwflower/dsh-chat-import/commit/77de7cd)).
- **`tool/result` links its `tool/call` across steps** — `sourceEventSeqs` now
  points at the originating call even when the result lands in a later step
  ([f33824d](https://github.com/Nwflower/dsh-chat-import/commit/f33824d)).
- **Reasonix creation-time falls back to the filename timestamp** when neither
  the transcript nor the meta file carries one ([bf8b05e](https://github.com/Nwflower/dsh-chat-import/commit/bf8b05e)).
- **opencode directory import joins paths portably** instead of hard-coding a
  separator ([72238ba](https://github.com/Nwflower/dsh-chat-import/commit/72238ba)).

## [0.1.1] - 2026-08-14

First patch release — shipped the batch-import error-detail fix together with
the Cursor and Gemini sources, the bilingual README and the project LOGO.
Tagged `v0.1.1` (`586a5f9`).

### Added

- **Cursor agent transcript import** (`import_cursor`) — strips the
  `<user_query>` wrapper on the first user message, filters `[REDACTED]`
  sentinels, maps `tool_use` blocks to `tool/call` (no result in the transcript)
  ([73571f6](https://github.com/Nwflower/dsh-chat-import/commit/73571f6)).
- **Gemini CLI session import** (`import_gemini`) — user/gemini/info message
  types, `thoughts` → reasoning, inline tool calls and results
  ([20c3f17](https://github.com/Nwflower/dsh-chat-import/commit/20c3f17), [0a1aea7](https://github.com/Nwflower/dsh-chat-import/commit/0a1aea7)).
- **Bilingual README** (`README.md` + `README.zh-CN.md` with a language
  switcher), with the Chinese edition shipped in the npm package
  ([6a880cb](https://github.com/Nwflower/dsh-chat-import/commit/6a880cb), [795bf83](https://github.com/Nwflower/dsh-chat-import/commit/795bf83)).
- **Project LOGO** (`assets/import.svg`) wired into the READMEs and the npm
  publish surface ([c696178](https://github.com/Nwflower/dsh-chat-import/commit/c696178), [586a5f9](https://github.com/Nwflower/dsh-chat-import/commit/586a5f9)).
- **`npm pack --dry-run` as a publish-surface regression guard** in CI
  ([7422e48](https://github.com/Nwflower/dsh-chat-import/commit/7422e48)).

### Changed

- README first-screen: badge row, tagline and a compatibility matrix for the
  then-four sources ([572222c](https://github.com/Nwflower/dsh-chat-import/commit/572222c)).
- CI npm cache dropped (no lockfile yet at the time) ([ad9ce48](https://github.com/Nwflower/dsh-chat-import/commit/ad9ce48));
  `.gitignore` extended for editor/system noise ([243fbb2](https://github.com/Nwflower/dsh-chat-import/commit/243fbb2)).

### Fixed

- **Batch import reports per-file error detail** — the completion summary now
  lists up to five failed/skipped paths with their reasons instead of aggregate
  counts only (the reason for this release; [fb657a2](https://github.com/Nwflower/dsh-chat-import/commit/fb657a2)).

## [0.1.0] - 2026-08-13

Initial release — the plugin's first npm publish (untagged). Imports Claude
Code, Codex / ChatGPT CLI and ChatGPT web-export histories as full-fidelity,
resumable DSH sessions.

### Added

- **Claude Code JSONL import** (`import_claude`) — full-fidelity tool history
  (real `tool/call` + `tool/result` pairs with `sourceEventSeqs` linkage),
  multi-step assistant messages and thinking blocks; `ai-title` becomes the
  session title ([e791dbe](https://github.com/Nwflower/dsh-chat-import/commit/e791dbe), [775d675](https://github.com/Nwflower/dsh-chat-import/commit/775d675), [fe619d7](https://github.com/Nwflower/dsh-chat-import/commit/fe619d7)).
- **Codex / ChatGPT CLI rollout import** (`import_codex`) — `session_meta` /
  `turn_context` header, `response_item` messages, function / custom tool calls
  paired by `call_id`; harness-injection blocks and encrypted reasoning skipped
  ([681ff08](https://github.com/Nwflower/dsh-chat-import/commit/681ff08)).
- **ChatGPT web export import** (`import_chatgpt`) — `conversations.json` as a
  batch, main thread rebuilt from the `mapping` DAG, placeholder / system nodes
  skipped ([adbc8fd](https://github.com/Nwflower/dsh-chat-import/commit/adbc8fd)).
- **Batch import** — recursive directory scan, one session per file, per-file
  summary ([d39c509](https://github.com/Nwflower/dsh-chat-import/commit/d39c509)).
- **Idempotent import** — re-importing skips sessions that already exist
  ([abb930d](https://github.com/Nwflower/dsh-chat-import/commit/abb930d)).
- **Skipped-malformed reporting** — malformed records are counted and reported,
  never silently dropped ([a8a5fc4](https://github.com/Nwflower/dsh-chat-import/commit/a8a5fc4)).
- **Pure conversion core** (`convert.mjs`) split from the host-facing entry
  ([73396c8](https://github.com/Nwflower/dsh-chat-import/commit/73396c8)).

### Changed

- Project scaffolding for npm / GitHub: publish metadata, MIT license, peer
  dependency, publish-surface split, CI workflow, AGENTS.md and the
  multi-session protocol ([8de15e0](https://github.com/Nwflower/dsh-chat-import/commit/8de15e0), [4ff8390](https://github.com/Nwflower/dsh-chat-import/commit/4ff8390), [69702de](https://github.com/Nwflower/dsh-chat-import/commit/69702de), [1f0fddd](https://github.com/Nwflower/dsh-chat-import/commit/1f0fddd), [e7b1acd](https://github.com/Nwflower/dsh-chat-import/commit/e7b1acd), [8d485d2](https://github.com/Nwflower/dsh-chat-import/commit/8d485d2), [f6bfb65](https://github.com/Nwflower/dsh-chat-import/commit/f6bfb65)).
- Line endings normalized to LF via `.gitattributes` / `.editorconfig` to
  prevent cross-machine churn ([912c28d](https://github.com/Nwflower/dsh-chat-import/commit/912c28d)).
