# 架构决策记录

本文件记录本仓库**为什么**是现在这个样子：每条决策写背景、决定、代价，以及什么情况下允许重审。
操作手册看 README / docs，硬性规则看 AGENTS.md；本文件只管「权衡」。

执行约束：

- 任何重构/拆分方案若与本文件已记录的决策冲突，必须先修改对应条目、说明旧决策为何失效，再动手。禁止静默推翻。
- 新决策追加在文末，编号递增，不删旧条目；被推翻的条目改为「已废弃 + 指向新决策」。

---

## D1. 零构建，纯 ESM，根目录即发布面

- **背景**：插件逻辑是文本解析与宿主服务调用，没有需要编译期处理的东西；构建步骤只会增加发版事故面。
- **决定**：`index.mjs` / `lib/` 即发布产物，源码即产物；根目录只放发布文件，本地工程文件收进 `dev/` 不入库。
- **代价**：没有类型检查与转译，靠 eslint + node --test + 覆盖率护栏（line >= 75%）兜底。
- **重审条件**：需要 TypeScript 类型契约对外发布、或需要支持旧 Node 之时。
- **例外**：浏览器侧 bundle（lib/client.js）不适用本条，见 D7——宿主侧仍严格零构建。

## D2. 会话日志 append-only 契约

- **背景**：导入的会话要成为「可继续的 DSH 会话」，就必须遵守宿主 sessionPersistence 的存储契约；改写历史会破坏外部工具的续写假设。
- **决定**：只 `create` + `append`，不改写历史；`seq` 从 0 连续；surface 事件带 `surfaceOp: 'append'`。
- **代价**：纠错成本高（错了只能追加更正或 force 另建副本），所以转换层必须在写入前把输入清洗干净。
- **重审条件**：宿主存储契约本身变更时。

## D3. 纯函数转换层与 host 面严格分层

- **背景**：27 种来源的解析逻辑是 bug 重灾区，必须可以脱离宿主独立测试。
- **决定**：`lib/convert/*` 与 `lib/export/*` 是纯函数层：不读磁盘、不 import 宿主服务，文件头写清存储契约；host 面（发现、IO、宿主服务调用）在 `lib/*.mjs`，其中按来源命名的适配器（SQLite 读取、来源专属编排）收在 `lib/sources/<src>.mjs`，与 `lib/convert/<src>.mjs` 镜像（2026-09 由 `lib/<src>.mjs` 平移收拢，纯路径变更）。新增来源的流水线固定为 AGENTS.md「新增一个来源」六步。
- **代价**：同一来源有时要拆成 convert/<src>.mjs + lib/<src>.mjs 两个文件；层间数据形状要显式约定。
- **重审条件**：无（这是测试能力的根基）。

## D4. 失败要大声，幂等是底线

- **背景**：导入器面对的是别人的数据，畸形行、编码问题、疑似 secrets 是常态；静默吞掉会让用户以为导入成功。
- **决定**：畸形行、疑似 secrets、降级项全部计数/上报；重复导入同一源时必须有确定答案而不是「看情况」（重导语义自 0.20.0 起由 D13 细化：未变跳过 / 未续聊续写 / 已续聊另建副本，`force: true` 恒另建副本）。
- **代价**：上报通道（计数、警告列表）贯穿所有转换器签名，有点啰嗦——这是故意的。
- **重审条件**：无。

## D5. 数据库源自适应，不假设 schema

- **背景**：外部工具（SQLite 存储的来源）版本间 schema 会漂移。
- **决定**：`node:sqlite` 只读打开；列用 `PRAGMA table_info` 自适应；读不到返回 `null` 而不是抛。
- **代价**：转换器要处理「列缺失」的降级路径，测试要用真实临时库造夹具。
- **重审条件**：无。

## D6. 已知体量热点与治理方向（2026-09 定）

- **背景**：AI 辅助开发使代码增长快于人工维护速度。热点曾是 `lib/discovery.mjs`（2629 行）、`lib/tools.mjs`（1663 行）、`lib/import-core.mjs`（1053 行）——三者都越过了停止线却仍在加功能。（`lib/client.js` 曾以 2131 行触发停止线，已按 D7 拆分为 `src/client/` 分片；`lib/import-variants.mjs` 曾以 1029 行触发停止线，SQLite 库类来源的 dry-run 预览已按来源迁入 `lib/sources/<src>.mjs`。）
- **执行情况（2026-10）**：三处热点均已按下述方向拆完，`lib/` 下最大的手维护文件回到 1000 行以内：
  - `lib/discovery.mjs` → 薄门面 + `lib/discovery/`：来源描述符表 `registry.mjs`（FORMATS / 默认根 / 扫描器 / 单文件判格式全部由描述符派生）、驱动 `discover.mjs`、书签缓存 `scan-cache.mjs`、遍历与状态标注件，以及按来源族的扫描器模块（`claude` / `jsonl` / `gemini` / `sqlite` / `cline` / `session-dirs` / `documents` / `dsh`）。
  - `lib/tools.mjs` → 薄门面（`registerTools` + 档位对账）+ `lib/tools/`：导入 spec 表、参数派生、输出 schema 片段、结果文案、管理 / 导出 / 会话 / 扫描四组工具。
  - `lib/import-core.mjs` → 共享状态机拆出 `lib/import-state.mjs`（已知记录 + 源未变短路径）、`lib/import-batch.mjs`（文件收集 + 批量计数）、`lib/host-session.mjs`（宿主会话读写适配）。
- **决定**：治理方向不是「按行数强拆」，而是：
  - `discovery.mjs` 按**来源族**拆（每种来源的发现逻辑内聚，与 D3 的来源流水线对齐）；
  - `tools.mjs` 按**工具分组**拆（import / export / purge 各自的工具定义与 handler 同文件）；
  - `import-variants.mjs` 只留 chatgpt / grokbuild / hermes / kimi 这类「源形态特殊」的编排与预览；有 `lib/sources/<src>.mjs` 的来源，其预览与导入编排同住该文件，不回流 `import-variants.mjs`；
  - 拆分提案由体量停止线（AGENTS.md）或定期架构巡检触发，一次只拆一个文件，拆完门禁全绿再下一个。
- **代价**：拆分期间 import 路径变动，需要全量测试护航（现有覆盖率护栏足够）。
- **重审条件**：无；这是进行中的方向而非禁令。

---

## D7. 浏览器侧 bundle 例外于零构建：src/client/ 分片 + 组装脚本（2026-09 定）

- **背景**：`lib/client.js`（侧面板 UI）长到 2131 行，触发体量停止线。但 DSH 的客户端模块加载器没有相对 require、也没有资源 URL——浏览器侧产物**必须**是单个自包含文件，「分文件但不构建」在平台上不存在。两条出路：全套 TS 工具链（dsh-better-sidebar 式）或分片+逐字拼接（dsh-claude-style 式）。前者违反 D1 且重审条件不成立（不对外发 TS 类型契约、不需要支持旧 Node），工具链成本对一个陈述式 UI bundle 不成比例。
- **决定**：源码按职责拆到 `src/client/`（片段清单以 `scripts/build-client.mjs` 的 `FRAGMENTS` 为准），`scripts/build-client.mjs` 逐字拼回 `lib/client.js`（沿用 dsh-claude-style 已验证的同平台路线）。宿主侧与面板共用的纯函数（`lib/panel-filter.mjs`、`lib/footer-layout.mjs`）不在片段里另抄一份：组装脚本按白名单把它们内联进 bundle（去掉 `export` 关键字、按 4 空格基准缩进，拒绝 import / `export default` / 多行模板串），测试测的就是发布的那份。片段契约：禁 import/export（共享 factory 作用域，顺序即声明顺序）、4 空格基准缩进、LF 行尾；构建内置 vm 语法门禁，`npm run build` 含 `--check` 新鲜度校验（产物与源漂移即失败）。同时把根目录发布入口收进子目录：`index.mjs`/`index.d.ts` → `lib/`，`convert.mjs`/`export.mjs` shim → `lib/convert/index.mjs` / `lib/export/index.mjs`（`exports["./export.mjs"]` 子路径契约不变），ROADMAP/CONTRIBUTING → `docs/`。
- **代价**：双层真相源——改面板必须改 `src/client/` 再组装，直接改 `lib/client.js` 会被 --check 拦下（CI 单独跑一步 `build-client.mjs --check`）；片段跨片引用，eslint 按组装脚本生成的跨片全局名单逐片段启用 no-undef（vm 语法门禁只管能否解析，管不到未定义引用）。首拆以「产物逐字节一致」为验收，行为零变化。
- **重审条件**：DSH 客户端加载器支持相对 require / 资源 URL 之时（届时可回到纯 ESM 直发，拆掉的只是组装脚本）。

---

## D8. 会话格式 V3/V4 双形状：读侧形状无关，写侧按宿主版本分流（2026-09 定）

- **背景**：DSH 会话格式 V4 把工具结果从「`role: 'user'` 里包一个 `tool-result` 块」提升为顶层 `role: 'tool'` 消息。实测两个方向都会被拒：V4 形状写进已装的 V3 宿主，核心 Session 要求存在且仅存在一个与 `source.callId` 匹配的 `tool-result` 包装；V3 形状写进 V4 原生准入，报「requires a tool-role message」；`user/message` 里再带 `tool-result` 包装属 V4 退休语法。两种形状互斥，插件不可能只发一种。
- **决定**：读侧形状无关——`toolResultOf(ev)` 是唯一的工具结果读取入口（反向导出、校验、Markdown 渲染都走它），不关心事件来自哪个版本；写侧只在一个边界分流——`prepareHostEvents(events, sessionId, version, hostVersion)` 依次过 `shapeToolResults` / `shapeMessageSources` / `shapeReplaceOps`。目标代次 `version` 由宿主 `sessionPersistence` 能力位（`formatVersion`/`currentVersion`）探测，探不到取已持久化 header 的最大版本，再兜底 3；`hostVersion` 是宿主**原生**代次（`hostNativeFormatVersion`），只用于两处与文件代次无关的 V4 改名（source 生产者 kind、替换标记拼写），省略时回退 `version` 便于纯函数测试。双向幂等：已是目标形状的事件原样通过。
- **代价**：两种形状都要测试覆盖（`test/format-version.test.mjs` 锁双向转换、幂等与畸形输入直通）；V4 的其余变更也必须在写 V4 时跟上——`source.kind='plugin'` 被 V4 退役（迁移器改写为 `plugin:<name>`，读路径直接拒绝 `plugin`），导入自产的上下文注入与 system head 因此由 `shapeMessageSources` 同步改写，且逐条照抄宿主 `dsh-session-format-v3-to-v4` 的 `producerKind()`（`RENAMED_PRODUCERS` + 同名生产者表 + system 角色特例）——压缩检查点的生产者 kind 是 `compact-checkpoint`（宿主 `isCompactCheckpointSource` 只认它；压缩 invariant、会话引用投影、trajectory 折叠都吃它），只发 `plugin:compact` 会让检查点在宿主眼里退化成普通 user 消息。`prepareHostMeta` 按白名单重建 header；surface 事件恒带 `surfaceOp`，替换端点拼写（`{start,end}` ↔ `{startSeq,endSeq}`）由 `shapeReplaceOps` 按宿主 **runtime** 世代（`dsh-session` ≤0.1.x 只认前者，≥0.2.0 只认后者，与 header 代次无关）双向归一。
- **重审条件**：宿主广告 3/4 之外的版本；或 V4 其余变更成为强制项（届时需要一次面更宽的迁移，而不只是工具结果形状）。

## D9. 导入会话自带空 system head：surface 首事件必须是 system/message（2026-09 定）

- **背景**：宿主 v3→v4 迁移器把 surface 的第一个 `system/message` 记为 protected head，之后每一步宿主的系统提示词都以它为替换锚点；若 surface 里已有别的 surface 事件而 head 尚未建立，迁移 fail-closed 拒载整份日志（`system/message requires a protected first surface head`）——导入会话此前从 `user/message` 起，宿主续聊写自己的系统提示词时就中招，由它 seed 出来的续聊会话同样打不开（原生会话因为创建时就写了 head 不受影响）。
- **决定**：`synthesizeSession` 在首个 `step/start` 之后、任何其它 surface 事件之前写一条 `system/message`（`surfaceOp: 'append'`、`content: []`、`source.plugin = 'chat-import'`）——位置与内容都对齐宿主自己的 v2→v3 迁移器（它同样在第一个 step/start 处插一条空 head）。空内容只占住 surface 第 0 个节点，真正的系统提示词由宿主在下一步替换或归一化，导入不虚构提示词。
- **代价**：导入会话多一条事件（`storedEvents` 基线 +1）；首轮没有 step 时补一个只装 head 的空 step；`SESSION_EVENT_TYPES` / surface 集合加入 `system/message`、`developer/message`，`verify_session` 新增 `system-head-missing` 点名存量旧形状（head 必须是 surface 首事件，旧日志只能 force 重导，无法原地补写）。
- **重审条件**：宿主迁移器改为「缺 head 时自行插入」（v2→v3 就是这种语义）——那时本插桩可退化为可选。


---

## D10. 设置页双版兼容：0.1.7 按条目 id / 0.1.5 自持命名空间（2026-09 定）

- **背景**：DSH 0.1.7 删除了 `settings.register()`——命名空间改为 profile 条目 id、schema 改为插件导出的 `Config`；0.1.5 及更早则是插件按名字注册。插件以软链 / 本地 link 装进 profile 时，`@deepseek-ai/schemastery` 也未必从其自身 require 锚点解析得到；0.1.7 的 loader 还把条目 id 报成 `<kind>:<id>`，而设置服务按裸 id 建索引（带前缀写会 409 `settings-conflict`）。
- **决定**：`lib/import-prefs.mjs` 按宿主能力探测绑定，一套代码跑两版：`describe()` 名单含本插件**裸条目 id** → `forms`（0.1.7，按条目 id 走 describe / update，并 `settings.configure({ auto: false })` 声明自带面板）；只有 `register` / `get` → `legacy`（0.1.5，自持命名空间 `chat-import`）；两者皆无 → `none`（读默认、写不持久化）。`entryIdOf()` 剥离 `<kind>:` 前缀并回退 patch 声明的 `import-claude`；schemastery 解析锚点指向**运行中的 harness bin**，并对 `.volatile()` 做能力探测；插件入口导出 `Config`。
- **决定（客户端席位）**：设置界面按同一世代分流——`ctx.get('configForms')` 在场（0.1.7+）→ 注册 `plugins.bundle.config`（键 = 包名 `dsh-chat-import`，渲染在「设置 → 插件」的插件页）并用 `configForms.get(条目 id)` 逐字段读写；缺席 → 保留 `settings.section` 整页与 `/api-import/prefs` fenced 路由。两处互斥注册（`configForms` 存在即否决整页），避免同一设置在两处各长一份。
- **代价**：两套设置模型都要测试覆盖；`.volatile()` 探测与软链锚点是宿主实现细节，宿主换版需重审（完整踩坑与自检见 [SETTINGS-MIGRATION.zh-CN.md](SETTINGS-MIGRATION.zh-CN.md)）。
- **重审条件**：宿主 0.1.7+ 成为唯一支持面时，删掉 legacy 路径与探测，只留 `Config` + 条目 id。

## D11. 上下文压缩导入为原生压缩事件，不切窗口（2026-09 定）

- **背景**：来源工具的上下文压缩（Claude Code 的 `compact_boundary` + `isCompactSummary` user 记录、Codex 的 `compacted` 信封、Pi 的 `compaction` 条目、opencode 的 `compaction` part + 摘要消息）意味着「模型只看到摘要 + 压缩点之后的对话」，而压缩前的记录仍留在源转录里。此前的两种做法都不好：不处理 → 全量历史灌进上下文，超预算时预算裁剪会把中间若干轮真删掉（本机一份 6579 条记录、压缩 10 次的 Codex rollout 约 8411412 tokens，被裁 5 轮 / 796 条消息 / 741 次工具调用）；「切窗口」→ 只导压缩点之后的记录，压缩前的历史在导入时就**永久消失**（既不能回溯，也不能导出回源），与「日志是记录、投影才是上下文」的宿主模型相反。
- **决定**：压缩导入为**宿主原生的压缩事务**，日志照常保全量历史。IR 加两个可选字段：`turns[i].compaction = { summary, provider, model, time? }`（该轮**之前**有一次压缩）与 `turns[i].shadowed = true`（该轮已被后续压缩遮蔽，log-only）；另有可选源时间戳 `turns[i].time` / `steps[j].time` / `toolResults[k].time` / `compaction.time`（毫秒），事件 `time` 取最近一个已知源时间且不倒退，来源没有时间戳时保持 `meta.createdAt`（会话列表的最后活动时间此前恒等于创建时间）。`synthesizeSession` 在边界轮的 `turn/start` 之前发射 `compaction/start → compaction/summary → 带 surfaceOp:{op:'replace'} 的检查点 user/message → compaction/end`（独立事务，`turn: null`；`sourceEventSeqs` 覆盖全部被遮蔽的 surface 节点；checkpoint 标记 `{kind:'plugin',plugin:'compact',compactionId}` 照抄 `dsh-compaction` 的契约字面量——纯函数层不 import 宿主包，写 V4 时由 `shapeMessageSources` 按宿主 `producerKind()` 改写成 `{kind:'compact-checkpoint',compactionId}`）。protected head 与环境变更声明**不进**遮蔽范围（遮蔽范围是连续区间，故声明必须排在所有会话节点之前）。一次会话压缩多次就发多个链式检查点。预算裁剪只在检查点之后的「有效段」上工作：受遮蔽轮不估算、不裁剪、不丢弃。`fullHistory: true` 时不发检查点（模型看全量）并进参数指纹。
- **决定（各源边界口径，2026-09 补）**：边界一律取「源侧模型仍看得见的内容起点」，按各源自己的事实定：Claude 的 `isCompactSummary` / 旧 `summary` 记录（轮之间）、Codex 的 `compacted` 信封（常在轮中间 → 跨界轮一分为二）、Pi 的 `retainedTail` / `firstKeptEntryId`、opencode 的 `tail_start_id`、Kimi 的 `context.apply_compaction`（截点含 turn/step，跨截点轮一分为二；旧格式 wire 无摘要 → 保持切窗口并上报 `compactionSummaryMissing`）、Zed 的 `Compaction` 消息（语义是「用摘要替换整段历史」）、Crush 的 `is_summary_message`、Continue 的 `conversationSummary`（边界在承载它的 item **之后**）、zcode 的 `compactBoundary.keptMessageCount`（缺它就退回摘要 reasoning 块，不猜）、Cline 的 `<id>.compaction.json`（`source_message_count` 条 canonical 消息被折叠）。**兜底**：边界之前没有可遮蔽节点时宿主不变式（`shadowedSeqs` 非空）不允许发检查点，合成层把摘要退回该轮首步的 reasoning 块（无步骤则补空步骤承载），摘要正文永不丢、绝不虚构。
- **决定（DSH → DSH 往返，2026-09 补）**：`convertDshJsonl` 的 `DURABLE` 白名单含三类压缩事件，透传时**不**把检查点的 `surfaceOp:{op:'replace'}` 改写成 `append`，并把替换范围端点、`shadowedSeqs`/`shadowedRange`、`sourceEventSeqs` 用同一套映射重排（两遍映射口径一致）；V4 的检查点 source（`{kind:'compact-checkpoint'}`，以及旧插件写歪的 `'plugin:compact'`）读回来归一成 V3 的 `{kind:'plugin',plugin:'compact'}`（写 V4 时由 `shapeMessageSources` 再改写）；替换端点的两种拼写都识别，重排时保持源日志的拼写（写目标会话时由 `shapeReplaceOps` 按宿主世代归一，跨世代回灌不丢压缩语义）。源日志畸形到端点无处映射时退回 `append`（摘要仍可见），残留括号由 `verify_session` 的 `compaction-*` 检查点名。
- **代价**：日志体积等于源转录（几十 MB 级），投影缓存与全量读取的代价随之而来；`compaction/summary` 的 `provider`/`model` 是**来源工具的**事实（Codex 写 `codex`、Claude 写 `claude-code`、Pi 写 `pi-coding-agent`、Kimi/Zed/Crush/Continue/zcode/Cline 各写自己的标签、opencode 系写 `provider` 标签），不是宿主模型的；导出方向暂不重建源工具的压缩记录（检查点消息按「插件注入」计入 `skippedInjections`，不静默）。
- **被推翻的旧决策**：无（此前压缩处理只在各源转换器里「切窗口」或「摘要作 reasoning 块」，从未写进本文档）。**重审条件**：宿主压缩事件契约（事件名 / `shadowedSeqs` 语义 / 检查点标记）变更，或 `deriveMessages` 不再折叠 replace 检查点时。

---

## D12. 去掉双向增量同步：只保留导入与导出（2026-09 定）

- **背景**：双向同步（0.11/0.12 引入，`lib/sync-loop.mjs` + `sync-config.mjs` + `sync-panel.mjs` + `backfill.mjs` + `sync_to_claude` 工具 + 设置页「双向同步」分区）给插件装了第二张脸：入站按间隔巡检外部数据根并续写，出站在外部工具的转录文件里**追加/改写**（三闸守卫、CAS、预检回滚、水印）。它需要的配置（`sync.json` / `outbound.json`）、界面（同步页 + 设置分区）、工具与测试，体量接近导入本身的一半；而它改变的是**别的工具的**数据文件——这个权限面与「把聊天记录读进来」的风险等级不同，出问题的代价也不对称（导入错了是副本，写回错了是用户的源转录）。实际使用中它的价值集中在「我还在源工具里继续聊」这一种情形，而这条需求由「重新导入」即可覆盖（导入侧另有 D13 收口）。用户心智里重复导入一个对话 = 想要一份新的副本，而不是让插件悄悄改写已有会话。
- **决定**：整个删除同步功能——`lib/sync-loop.mjs`、`lib/sync-config.mjs`、`lib/sync-panel.mjs`、`lib/backfill.mjs`、`sync_to_claude` 工具、`/api-import/sync` 路由、设置页同步分区与 `sync.*` i18n 键、`test/sync.test.mjs` 与 index 里的对应用例。反向导出保留（`export_chat` 只写**新文件**：新 uuid + `createIfAbsent`，绝不碰源文件）。随之失效的死代码一并删除：`lib/export/claude.mjs` 的 `tailClaudeEvents` / `serializeClaudeJsonlTail` / `verifyClaudeJsonl`、`serializeCodexJsonlTail`、`lib/export/grokbuild.mjs` 整文件（它们只服务写回）；`lib/export/index.mjs`（`exports["./export.mjs"]` 子路径）相应收窄导出名。工具面 13 → 12。registry 里既有的 `writeback` 字段与 `exports` 映射不再有消费者，历史数据留原地作惰性残留（不静默删用户数据）。
- **代价**：原先用写回把 DSH 续聊同步回 Claude Code / Codex / Grok 的用户失去该能力（`export_chat` 仍可导出成新文件，但不会再追加回源）；`$DSH_HOME/dsh-chat-import/sync.json`、`outbound.json` 成为惰性残留文件；`./export.mjs` 子路径的公开导出名减少（0.20.0 破坏性变更，CHANGELOG 点名）。
- **重审条件**：若写回需求重现，应做成**独立插件**（自带配置、面板与定时器，并自主承担「改写外部工具文件」的风险），而不是把这个能力塞回导入器；本条不因「用户想要同步」而撤销。

---

## D13. 重导语义：未被续聊才续写，续聊过就另铸副本（2026-09 定）

- **背景**：删掉同步（D12）之后，「重复导入同一个源」必须给出确定答案。此前的规则是「目标会话已存在即跳过，源增长时增量续写」（D4 原文），两种情形都会伤人：源文件增长时把**新增轮次追加进已有会话**，如果用户已经在那条会话里聊过天，导入的内容就混进了他自己的对话（时序上还插在他提问之前），事后无法拆开；而未变时静默跳过又让「我就是想再导一份」的用户没有出口。用户对「再导一次」的直觉是**想要一份新的**，但完全放弃增量导入会让 `/import-all`、面板批量导入这类批量入口每次运行都复制一遍历史源（`/import-all` 完全依赖导入侧的幂等闸，见 lib/command.mjs）。
- **决定**：D4 的「幂等」保留，但把判据从「记录存在」换成「**这条 DSH 会话还是不是我上次写完的样子**」。registry 记录新增 `storedEvents`（我们落盘后**实测**的 DSH 日志长度，不是转换口径的 `events` 计数；create/replace 后读回一次，append 时按 `fromSeq + 尾部事件数` 直接推进，不额外读盘）。源增长时按实测长度分流：
  - **等于**基线 → 纯镜像，续写尾部（`appended`，增量导入不变）；
  - **大于**基线 → 用户在 DSH 里续聊过 → **另铸副本**（新 id，结果带 `reimported.reason: 'continued-in-dsh'`），旧会话原样不动；
  - **小于**基线 → 日志被外部截短 → 不写，跳过并报 `storedShrunk`；
  - **无基线**（0.20.0 之前的记录）→ 不可判定 → 保守另铸副本一次并在落盘后回填基线（`reason: 'baseline-missing'`）。
  读不到日志长度（后端不可用）时既不追加也不复制，跳过并报 `appendedSkipped`。`force: true` / 显式 `sessionId` 变更仍恒另铸副本（`reason: 'forced'` / `'session-id-changed'`）。**另铸副本时旧会话进 `record.copies`**：撤回 / 清理 / 体检 / `/attach-workspaces` / 面板历史都经 `lib/imports.mjs` 的 `registryEntries` 统一展开（此前 8 处各自展开 registry，加 copies 必漏改，故一并收口）；删除单条副本只摘该条，删除主记录时把最新副本提升为主记录（会话还在，账也还在）。
- **代价**：registry 记录多两个字段（`storedEvents` / `copies`），每次 create 多一次日志读回（append 路径不需要）；一次导入可能产出多条会话（用户显式重导的必然结果）；`reimported` 取代了原先只服务于 force 的 `forceImported` 字段（输出 schema 与类型面同步改名）。基线是「我们写完时的长度」，所以宿主若在 create 后自行追加事件（迁移 / 归一化）会把它判成「已续聊」，代价是**多建一份副本**——偏保守的方向，且结果里点名了原因。
- **重审条件**：宿主提供「会话自上次写入后是否被改动」的一等信号（revision / 写入者标记）时，改用该信号替代日志长度比对。

## D14. 图片以宿主附件落地：IR 只带字节，日志只留引用（2026-09 定）

- **背景**：0.20.0 及以前，所有来源的图片都降级成 `[image]` 文本占位（宿主的会话日志不该装 base64）。对本机真实数据的普查说明了代价：claude 43 个会话文件里 590 张图、kimi 258 张、grokbuild 101 张、codex 42 张；而 DSH **原生就存图片**——141 份原生日志里有 144 个 `image` 块，形态是 `{type:'image', attachment:{attachmentId:'sha256:…', mediaType, width, height, bytes, name}}`，字节由 `ctx.attachments`（`@deepseek-ai/dsh-attachment` 的 `AttachmentStore`，内容寻址）持有。宿主 `@deepseek-ai/dsh-llm` 的 `ContentBlockMap` 恰好就是 `text / reasoning / image / tool-call / tool-result`——`image` 是我们的 IR 唯一没对齐的块类型。此外普查还查出三处**静默丢弃**：claude/codex 用户提问里的图片（只取 text 块拼 prompt，图片连计数都没有）、助手消息里的图片、Kimi 工具结果里的 `image_url`（`mapToolOutput` 只取 text/think）。
- **决定**：
  1. **IR 增加两种状态的 `image` 块**：待落地 `{type:'image', data:<base64>, mediaType, name?}`（转换层拿到字节时产出）与已是引用 `{type:'image', attachment:{…}}`（DSH 源回灌 / 导出再导入）。用户提问带图时，完整块列表放 `turns[i].promptBlocks`（`prompt` 仍是文本投影，标题/空轮判定/去重都用它）。
  2. **字节只在边界存在**：`lib/attachments.mjs` 在 `runDecision` 的每条写盘路径（create / replace / append / multi 全部）就地把待落地块经 `ctx.attachments.saveImage` 落成不可变对象、替换为引用；**base64 永不写进会话日志**（宿主的 `ImageBlock` 只认引用）。已是引用的块原样保留，不重复存（内容寻址）。导出方向对称：`resolveImagesForExport` 经 `readImage` 把引用读回 base64，供 Claude / Codex 序列化器写进目标格式。
  3. **失败要大声**：服务缺席（可选服务）/ 类型不收（第一版只收 PNG/JPEG/WebP/GIF）/ 超限（单会话 500 张，超出部分降级）/ 载荷畸形 / 源只有引用（Kimi 的 `blobref:`，其 `file/index.json` 不映射该 hash）→ 该块降级为 `[image]` 文本并计入公开结果的 `imagesDegraded`；落成附件的张数计入 `images`。导出侧读不回字节同样计入 `attachment-skipped` 降级。
  4. **可关**：`storeImages: false`（或 `DSH_IMPORT_STORE_IMAGES=0`）时不做落地、只留占位——图片是唯一会把宿主持久存储撑大的导入面（本机抽样 40 个 claude 会话就有 43MB 图片字节），需要给用户一个开关。
  5. **目标代次 < 4 时一律降级**：附件引用是当前世代（V4）宿主的概念，V3 落点（面板「导入到 → DSH（V3）」）或续写一条 V3 会话时，旧宿主读不出引用——此时图片（含已是引用的块）全部降级为 `[image]` 占位并计数。判据只取**权威来源**（面板显式覆盖的代次 / 目标会话 header 自己的代次），不取「推断出来的宿主代次」：宿主没有版本信号时推断值会退化成转换层默认的 3，若据此降级，会在全新宿主上把图片全部降级。
- **代价**：导入可能写入大量附件字节（本机抽样：297 张 / 43MB，只算 claude 的 40 个会话）；宿主附件服务 v1 无 GC，失败路径可能留下不可达的内容寻址对象（该包已声明这是允许形态）；**删除/撤回导入会话不会回收附件字节**——`AttachmentStore` 只有 `saveImage` / `readImage` / `validateImage`，没有删除面，所以清理一个含图会话只删日志与 registry 条目，图片对象留在附件存储里（`lib/purge.mjs` / `lib/retract.mjs` 因此不碰附件）；`skippedBlocks` 与导出降级的 `attachment-skipped` 现在同时涵盖「未知块」与「读不回字节的图片」；V3 落点没有图片。Kimi / Zed 的图片仍只能占位（字节在各自的 blob 存储里，插件无法解析）——这是**源侧**限制，不是 IR 限制。
- **重审条件**：宿主附件服务支持通用文件（非图片）/ 提供按引用感知的 GC / 暴露批量落地上限时，重新评估开关默认值与上限；Kimi 若公开 blob 索引（hash → 文件）则可把该源从占位改为落地。

## D15. Claude 富结果 sidecar 按需并入为文本（2026-09 定）

- **背景**：Claude Code 在 `tool_result` 记录旁另写一份 `toolUseResult`——模型看不到的结构化产物。本机 4001 条样本的键频次：`stdout`/`stderr`/`interrupted`/`isImage` 各约 2096、`filePath`/`originalFile`/`structuredPatch`/`userModified` 各 1260、`oldString`/`newString`/`replaceAll` 各 1115、`contentNotInModelContext` 648、`filenames`/`numFiles` 150、`bashEditDiff` 147，另有 `durationMs` / `persistedOutputPath` / `questions`/`answers` / `gitOperation` 等。此前只导入模型可见的 `tool_result.content`，这些 sidecar 全丢——其中 `structuredPatch`（编辑到底改了什么）与 `questions`/`answers`（交互问答）是真正有信息量的。
- **决定**：宿主 `ToolResultBlock` 只有 `{ toolCallId, content, isError }`，没有结构化 sidecar 槽位；DSH 自己的工具就是把结构化信息**渲染成文本**存进 content 的（真实日志里 tool-result 的正文就是 `{"exitCode":0,"stdout":…}` 这类 JSON）。所以按需把 sidecar 渲染成文本块**追加在可见结果之后**：`structuredPatch` / `bashEditDiff` → 统一 diff 文本（` ```diff ` 围栏）、`questions`/`answers` → 问答对、其余标量 → 一行 `<tool-use-result>{…}</tool-use-result>`。体积键（`originalFile` / `content` / `stdout` / `stderr`）与「值已在可见文本里出现」的项一律跳过，单值超过 2000 字符也跳过——绝不把整份文件搬进日志。
- **开关与指纹**：`includeToolUseResult: true`（默认关：本机样本里 1260 条带原文补丁、1115 条带 old/new 字符串，全量并入会明显撑大日志，而多数会话并不需要）。它与 `fullHistory` 同列进 claude 的参数指纹（换值须重导，否则短路径会按旧参数跳过）。结果里 `toolUseResultsMerged` 上报合并条数。
- **代价**：开启后日志体积随编辑次数增长（每条补丁几十到几百字符）；`originalFile` 这类整份快照仍不导入（与「模型可见内容」口径一致，用 `tool_result.content` 里的片段已足够还原语义）。
- **重审条件**：宿主为工具结果提供结构化元数据槽位时，改为写结构化字段而不是渲染文本；或按需把 `originalFile` 也纳入（需要新的体积开关）。

## D16. 归组必须先定目标工作区：attach 只接受 cwd 与工作区路径相等（2026-09 定）

- **背景**：用户报「从 Claude 导入的对话，重启也不出现在对话列表里」。实际是导入成功了，但会话掉进侧栏最底部的「未分组」。根因是宿主的挂接契约与我们的事后回退设计相冲突：
  1. `@deepseek-ai/dsh-workspace` 的 `attachSession` 读会话 header，要求 `realpath(header.cwd) === workspace.path`，否则抛 `its cwd resolves to '…'`；`workspace.sessionIds` 的 getter 也只返回通过该检查的 id；
  2. 客户端（`dsh-client-ui-workspace`）的 `ungroupedMemberIds = list.ids − ⋃workspace.sessionIds`，所以没被计入的会话全部落进「未分组」；
  3. 旧实现先在 create 时落下源 cwd，事后才 `attachToWorkspace`：cwd 候选命中不了就**回退源文件目录**并 `create()` 一个工作区。源目录被建出来了、`attachSession` 却必然被宿主拒绝，异常只写 `console.error`（本机 `$DSH_HOME/logs` 为空，用户完全看不到）→ 净效果是**多出一个空工作区 + 会话仍在「未分组」**。本机实测：同一批三条导入里，两条 cwd = 主目录的会话各留下一个空工作区（`…\.claude\projects\C--Users-Nwflower`、`…\.codex\sessions\2026\09\07`，创建时间与导入时间差 16–22ms），第三条 cwd 命中已有工作区的照常归组。
- **决定**：
  1. 归组前置：`lib/workspace-group.mjs` 在 **create 之前**规划目标工作区，并把目标路径写进会话 header 的 cwd；create 之后再 `attachSession`。同一个 plan 也用于 replace 与 multi 的每条 create。
  2. 目标选择（`workspaceMode`，默认 `auto`）：cwd 命中已有工作区 → 沿用；cwd（非主目录）能建成工作区 → 就地建（会话落在真实项目下，与原生会话同区）；否则 → 专用导入工作区 `$DSH_HOME/dsh-chat-import-workspace`（`mkdir -p` 后建，cwd 随之改写）。`per-project` = 同上但**不改写 cwd**（宁可「未分组」也不伪造 cwd）；`dedicated` = 一律落专用工作区。主目录 cwd 始终不建工作区（沙箱 ACL 会拒绝 home 里的 temp/pwsh），走专用工作区。
  3. 绝不按 transcript 的一面之词建目录：cwd 是否是可用目录交给宿主 `create` 判定（`realpath + isDirectory`），插件只为自己拥有的专用导入工作区 `mkdir -p`。跨机器 transcript 的 cwd 因此自然落到专用工作区，而不是在源盘上造目录、也不是把源 transcript 目录当工作区。
  4. 失败要大声：归组结果进公开结果——`workspace` / `workspaceMode` / `workspaceCreated`（新建了工作区这个用户可见副作用）与 `ungrouped` + `ungroupedReason`（会话已导入、停在「未分组」）。`/attach-workspaces` 改为按**会话自己的 cwd** 重新规划，不再回退源目录；header 是 append-only、事后改不了 cwd，所以落不了组的会话如实报告并提示用 `force` 重导一份。
  5. 附带修掉两处静默：`restore_bundle` 原先自己算 `groupedTo`（声称「回退归组到 bundle 目录」），现改为照抄真实落点；空工作区清理原先调 `ws.remove()/wr.remove()`（现宿主只有 `workspaceRegistry.delete(id)`，等于不清理），改为 `delete(id)` 并扩展到旧实现误建的源目录工作区，面板「导入历史」加了「清理空工作区」按钮（只删成员为 0 的工作区登记，目录与会话日志保留）。
- **代价**：会话 header 的 cwd 可能不再是源 cwd（源 cwd 不可用时改写成落点工作区）——这是为了让「导入的会话一定能被看到」；工具会在落点目录里执行，而不是一个本机不存在的源路径。`workspaceMode` 三态因此有了实质差别（此前 `auto` 与 `per-project` 同义）。
- **重审条件**：宿主允许会话同时属于多个工作区、或允许挂接时改写 header cwd（提供 relocate API）时，可以回到「保持源 cwd + 显式分组」的组合；宿主暴露 workspace 事件/GC 时，可把空工作区清理做成自动而非按钮。

## D17. 客户端只消费注入服务的例外：官方 UI primitives 的 Toast（2026-09 定）

- **背景**：导入落点以前只写在面板结果栏里（一行面板内文本），而批量导入时用户可能已经切走 tab 或收起右栏，于是「导进去了但不知道导到哪」——与 D16 修的那个困惑同源。DSH 有官方 Toast：`@deepseek-ai/dsh-client-ui-primitives` 的 `Toast`（顶部居中临时横幅，owner 给 `holdMs`/`onDone`，组件 key 变化即重开一条）。宿主自己的插件就是这么用的——`dsh-client-ui-plugin-manager` 在自己的 client bundle 里 `require("@deepseek-ai/dsh-client-ui-primitives")`，并把 toast 经 `ctx.slots.inject("shell.overlay", …)` 注册成 `plugin-manager.refresh-toast`。
- **决定**：
  1. 新增 `src/client/toast.js` 分片：`ToastHost` 经 `ctx.slots.inject("shell.overlay")` 注册（id `chat-import.landing-toast`，与宿主 toast 同槽）。导入成功后弹「导入完成 → <落点>（本次新建该工作区）；另有 N 个未归组」；转投（非 DSH 目标）弹写出文件路径。落点信息全部取自 D16 的公开结果字段（`workspace` / `workspaceCreated` / `ungrouped`），面板不另算。
  2. **这是「客户端只消费注入的 slots / locale / react」的唯一例外**，且必须可降级：`require` 包在 `try/catch` 里，拿不到（或没有 `Toast`）就渲染同位置、同 `holdMs` 的自绘横幅。插件声明支持 dsh ≥ 0.1.5-rc.1，不能因为一句提示在旧宿主上把整个面板搞挂。该 require 走 bundle factory 已有的 `require` 通道（`react` 本来就是这么拿的），不引入模块语法（分片仍禁 import/export）。
  3. 触发面只覆盖面板发起的导入（`/api-import/import` 响应里带落点）；工具与 `/import` 命令的落点写在工具结果文本里（`detailsNote` 的「新建工作区 …」「未归组 …」），不改动它们。
  4. **面板内那条自绘黄条（跳过提示 + 「忽略警告」按钮）也并入同一条 Toast**：官方 `Toast` 支持 `actions`（`[{ label, onClick }]`，宿主自己的「已归档，可撤销」toast 就是这么用的），于是「已跳过 N 条未变化 / 无法安全续写的对话」+「重新导入为新会话」变成一个带按钮的顶部横幅，`holdMs` 取 15s（给点击留时间），面板里不再有底部浮层。**取舍**：黄条原本是常驻到用户处理的，Toast 是临时的（15s 后淡出，动作不能再点）——面板结果栏仍照旧报「跳过 N」，重选该行再导入会再次弹出同一条提示，所以这条信息不会丢，但「看到就必须当场决定」的紧迫感比常驻横幅弱。
- **代价**：客户端多了一条对宿主包名的硬编码字符串（版本漂移只能靠 try/catch 兜底，不是编译期发现）；Toast 的 props（`text`/`actions`/`holdMs`/`onDone`/组件 key 重开）是 0.2.0-rc.1 的现状，上游若改名我们会静默退到自绘横幅——有兜底、不报错，但风格会不一致（自绘横幅同样画出动作按钮，所以「跳过 → force 重导」不会因为缺包而消失）。带动作的提示是临时的（15s），不如原来的常驻黄条耐等。
- **重审条件**：宿主把「提示 / 通知」做成客户端服务（`ctx.get('notices')` 之类）时改走服务；或官方给第三方插件提供 toast 出口，则删掉自绘兜底与包名硬编码。

---

## D18. Codex 侧「外部 agent 会话导入」的展平信封按段还原（2026-09 定）

- **背景**：Codex Desktop 的「导入外部 agent 会话」（`~/.codex/external_agent_session_imports.json`）把外部 transcript（本机 45 条全部来自 Claude Code）写成 Codex rollout，但 foreign 工具调用**没有** `function_call`/`custom_tool_call` 记录——调用与结果被展平成 assistant 正文里的文本信封（`[external_agent_tool_call: <Name>]…[/external_agent_tool_call]` 与 `[external_agent_tool_result[: error]]…[/external_agent_tool_result]`），且信封可与正文混排在同一个 `output_text` 块里（本机普查：14477 块独占整块、776 块与正文混排、102 块含多个信封，信封只在 assistant 侧出现）。用户从 Codex 侧再导入这类 rollout 时，工具调用全变散文：python 命令里的 `# 注释` 行被 markdown 渲染成巨型标题、130+ 次 Edit 与普通发言无法区分。这不是转换器的解析漏项（源文件里确实没有结构化调用），但「忠实导入」在这里等价于「丢结构」。
- **决定**：新增 `lib/convert/codex-external-agent.mjs`（纯函数层；单独成文件是因为 `codex.mjs` 已接近体量停止线，见 AGENTS.md）提供 `splitExternalAgentEnvelopes` / `externalAgentArguments`，由 `codex.mjs` 的 assistant 分支调用：在 assistant 正文按**行扫描**切段（不能要求「整块即信封」），把信封还原成 IR 的 `tool-call` / `tool-result`：载荷 `input: <JSON>` 原样作 arguments，`key: value` 行（值可跨行）逐键组对象；结果按「最早未配对调用」FIFO 配对（信封不带 call_id），`: error` 标记还原为 `isError`。**不虚构**：载荷键名与内容照抄信封——Codex 自己把 `file_path` 写成 `file`、并丢掉 Edit/Write 的正文，本层不补也不猜。降级走 D4：未闭合信封 / 认不出的载荷 / 未知结果标记留在正文并计入 `malformed`，找不到调用的结果原样保留正文并计入 `orphanResults`，还原数进公开结果的 `externalAgent: { calls, results, orphanResults, malformed }`（经 `attachConversionDetails` 与工具 schema 透出）；存量旧形状由 `verify_session` 新增的 `flattened-tool-envelope` 点名（同 D9 的 `system-head-missing` 手法）。**不设开关**：还原的是源侧本来的结构、不增体积、几乎无误判面（整行锚定的信封头），默认恒开。
- **代价**：转换器多一层启发式解析（约 120 行 + 注释），并为「信封形态漂移」留了含糊地带——载荷认不出时 arguments 退化为 `{"input": <原文>}`（内容不丢、结构会歪），未闭合的信封保留为正文（仍会被 markdown 渲染，但计数可见）；含信封的文本块会被切成多个文本块（正文段两侧空白被 trim），无信封的块走快路径、字节不变。还原后的 step 数减少（只承载结果信封的消息不再凭空开一步，结果归并到调用的那一步）。
- **重审条件**：Codex Desktop 换用别的展平格式（或改为写真正的 `function_call`）时，重估解析器；宿主收不到这类来源、或上游补回 Edit/Write 正文时，可删掉相应兜底与文档告诫。

---

## D19. opencode 双存储世代：按表分派读取，绝不两边都读（2026-10 定）

- **背景**：opencode 2.x（npm `@opencode/cli`，命令仍是 `opencode` / `opencode2`）**沿用 V1 的 `opencode.db`**，但把会话搬到 `session_v2`、转录搬到 `session_message`；V1 的 `session`/`message`/`part` 只是 V1→V2 迁移的来源。实测（本机 opencode 2.0.21 对 V1 库跑一次 `session list`）：迁移后 `session` 4 行、`session_v2` 4 行、`message` 51 行、`session_message` 51 行——**旧行仍在库里**。只读 V1 三表会让 V2 原生会话凭空消失；两边都读会把同一会话导入两次。
- **决定**：`readOpencodeDb` / `readOpencodeDbSummaries` 先按 `sqlite_master` 探测世代：有 `session_v2` → V2（`session_v2` + `session_message`，按 `seq` 升序），否则有 `session` → V1，两者都没有 → 大声报错（不返回空列表，否则面板显示的是「没有会话」而不是「库不认识」）。两代产出**同一形状**的中间 JSON，转换器 `lib/convert/opencode.mjs` 无世代分支；导入编排、DB 指纹短路径、`sessionIds` 过滤、registry 子表全部复用。压缩边界取「最近一条 `status='completed'` 的 compaction 行」——这正是 V2 自己的模型上下文口径（`session_message.seq >=` 该行的行才是模型可见内容），该行之前的轮进日志但不进模型上下文。
- **代价**：V2 的压缩正文分 `summary` 与 `recent` 两个字段（V2 模型两段都看，见 `session/compaction.ts` 的 `<summary>` / `<recent-context>`），检查点正文因此是两段之和：比 V1 的「摘要 + 保留窗口仍以轮呈现」更粗（保留窗口变成文本），换来的是与源侧投影逐字一致。非 `completed` 的 compaction 行（running/failed）不是模型可见边界，正文按普通内容保留、绝不静默丢。V2 原生工具名（`shell`/`subagent`/`patch`、`path` 取代 `filePath`）按「未知名原样保留」处理，不新造 DSH 侧对照（迁移后的历史行里仍是 V1 名，两套都要能读）。
- **重审条件**：opencode 再换存储世代（第三种表名/库）时按同一分派扩一项；V2 若开始删除 V1 三表，本决策无需改动（分派已覆盖）。反向导出（`export_chat({ format: 'opencode' })`）目前仍写 V1 `opencode import` 能吃的 JSON，V2 的 `session import` 契约未验证前不改。

---

## D20. 从文件导入：三级探测 + generic 文档 + 上传通道（2026-10 定）

- **背景**：发现列表只覆盖内置来源，而「手上有一个文件」是最常见的入口形态：网页版导出（无官方格式）、自写脚本产物、长尾工具的原生存储——以及「我下载了一个导出文件，却无处可导」这类报告。此前的文件路径只有 `import_chat({ format: "local-jsonl" })`：只收 `.jsonl`、失败只给一句「未识别」（死胡同：既不说支持什么，也不给出路）、面板完全没有文件入口；远程部署（浏览器只有 `File` 对象、拿不到路径）更是无路可走。
- **决定**：
  1. **三级探测**（`lib/convert/local-jsonl.mjs`）：显式 `format` 覆盖 > **内容标记**（`"interchange":"dsh-chat-import"` → generic；`"bundle"` → 便携包转 `restore_bundle`；只扫前 64KB）> 路径特征排序候选后逐个试跑。结果带 `detectedFormat` / `detectedBy` / `failures`（**每个**候选格式的失败原因，全量而非只记第一条）。
  2. **generic 文档成为一等导入格式**（`lib/convert/generic.mjs`，契约见 INTERCHANGE.md §5）：INTERCHANGE §1 的 turns 文档带版本与内容标记即可导入。这是长尾来源与 skill 路线的落点——写一份 JSON 比内置一个转换器便宜，也不必让 LLM 手写 DSH 事件日志（seq / surfaceOp / protected head / V3-V4 形状任一不合就整份被宿主拒载）。**不选 DSH 会话日志当撰写格式**：它是存储格式，不是 authoring 格式。校验按 D4 大声计数（未知块 / 图片降级 / 畸形轮步 / 孤儿结果 / 非法 usage / 0 轮 skipReason）。**工具结果的落点收敛到 `step.toolResults`**：写在 step `content` 里的 `tool-result` 块按 `toolCallId` 派生进结果列表（显式列表优先，与 `tool-call` 块的派生对称），写在 `promptBlocks` 或结果内层的无处安放、丢弃并计入 `skippedBlocks`——宿主 V4 codec 见到解释性 content 里的 `tool-result` 包装即拒载整份日志（`"released tool-result wrapper"`），正文里不能残留结果块。
  3. **上传通道**（`lib/upload.mjs` + 三条路由）：init / chunk / complete 三步，按 (sha256, size) 幂等（刷新或断线从已收字节续传，同一文件零重传），整文件指纹校验通过才产出可导入路径；配额单文件 256MiB / 暂存 2GiB、未完成 24h 回收、文件名 sanitize 且落点固定在 `$DSH_HOME/dsh-chat-import/uploads/<uuid>/`。暂存件导入后**保留**（D13 的重导语义以它为源键），未被 registry 引用的件由维护入口清理。
  4. **一个编排、三个入口**：`lib/file-import.mjs` 同时服务面板 `/api-import/file`、`/import auto <path>` 与 `local-jsonl` 工具面（`parseFormat` 增补 `generic`）；预览复用 import-core 的 preview 家族，零新状态机；目录批量复用 `importDirectory`，vibe 形态目录（`messages.jsonl` + `meta.json`）经该来源自己的 `vibeDeriveArgs` 补 meta（不重写第二份映射）。
  5. **交互按「不跟宿主抢手势」定形**（2026-10 收口）：面板**不注册拖放**——把会话文件拖到 DSH 窗口会被宿主当成「给当前对话加附件」，抢过来只会让用户困惑；给文件的入口是系统文件框（「选择…」→ 隐藏 `<input type=\"file\" multiple>` → 上传通道）与**路径回车**两种。路径是目录时**显式弹窗问「是否搜索子文件夹」**：先按当前层扫一遍（`recursive:false`），用户选「包含子文件夹」才重扫（目录树可能很大，不做无谓下钻）。弹窗用**宿主内置预设样式的 Modal / Button**（`@deepseek-ai/dsh-client-ui-primitives`，与落点 Toast 同一条 require 通道 + 同一条降级策略），不引入 Electron 原生对话框，也不自造一套视觉。原先的 `/api-import/browse`（目录选择器 / 自绘清单）随「浏览…」按钮一并删除——它的唯一消费者就是那个按钮。
- **代价**：探测要跑多个转换器（失败路径比成功路径更贵，故内容标记与路径特征都前置于试跑）；`convertLocalJsonl` 的结果多了三个键，工具 / 命令 / 面板三处都要透出；上传是唯一新增的「无盘来源」数据面，配额与暂存生命周期因此成为长期维护项；generic 是一份要跟着 IR 演进的第二契约（靠能力矩阵与同一个 `synthesizeSession` 收敛）；路径输入意味着目录要先扫一层再问（多一次轻量扫描，换掉「默默递归几十万文件」的风险）；识别失败的出路只剩「复制摘要 + 交给 Agent 按 Skill 转换」，用户手上有明确解析器目标时需要走工具面（`import_chat` 的 `parseFormat`）。
- **重审条件**：宿主自身的拖放/附件交互改为不吞文件（或提供「拖到导入面板」的排他区域）时，可重新评估拖放入口；宿主提供文件（非目录）选择服务时，「选择…」改走该服务；出现被广泛采用的会话交换标准时，评估把 generic 换成或映射到该标准。

---

## D21. 同口径逻辑只留一份，来源清单由一张表派生（2026-10 定）

- **背景**：来源一个个加进来，靠的是复制最近的那个来源再改。一次全量评审数出：标题归一 22 份（19 份逐字相同，注释还写着「需同步 5 处」）、源未变短路径 6 份（只有 2 份查 WAL）、批量计数 7 份、SQLite 只读打开 13 处、测试假宿主 15 份；来源清单在发现层有 5 张平行表、命令别名表与 `index.d.ts` 各自手写。副本已经漂移出真 bug：fork 目录导入退回 opencode 标签、`/import kilocode` 报未知来源、默认扫描看不到 V4 日志、`storeImages:false` 对一半来源无效、`imagesDegraded` 被重复计数。旧注释里的「core.mjs 属禁改面，各源按文件内联」是这些副本的由头，早已不成立。
- **决定**：
  1. **共用口径各有一个家**：转换层 `lib/convert/util.mjs`（标题 / 时间 / 正文抽取 / 跳过结果）、`lib/convert/ir.mjs`（调用与结果整理）、`core.mjs` 的 `finishSession`；导出层 `lib/export/common.mjs`；host 面 `lib/sources/sqlite.mjs`（只读打开 / 列自适应）、`lib/import-state.mjs`（已知记录 + 源未变短路径，含 WAL 与选择性补导守卫）、`lib/import-batch.mjs`（文件收集 + 批量计数）、`lib/atomic-write.mjs`；测试 `test/_support/`。来源确有不同语义时**参数化**共用件，不复制。
  2. **清单派生，不手写**：发现层每个来源一个描述符（`lib/discovery/registry.mjs`），FORMATS / 默认根 / 扫描器 / 单文件判格式由它派生；`import_chat` 的格式表（`lib/toolkit.mjs` 的 `CHAT_FORMATS`）派生 `/import` 别名；导入 spec 的 `multiSession` 标记派生面板与工具的 `sessionIds` 适用范围；`index.d.ts` 的格式联合类型由一致性测试对照运行时清单。
  3. **边界由测试与门禁守住，不靠自觉**：转换 / 导出层的 import 边界有测试（越界即失败，D3）；`build-check` 从发布入口沿模块图走一遍，可达模块不在 `files` 白名单即失败（新子目录忘登记曾让 `lib/tools/`、`lib/discovery/` 差点漏发）。
- **代价**：模块数变多、跳转多一层；改一个共用件会同时影响所有来源——这正是目的，回归由各来源的测试兜住。
- **重审条件**：无；新增来源仍走 AGENTS.md「新增一个来源」，其中「第 3 处副本即停」的停止线照旧有效。

---

## D22. 客户端样式表自己带归属标记，不替宿主收走别人的（2026-10 定）

- **背景**：宿主的客户端模块系统（`@deepseek-ai/dsh-client-modules` 的 `claimStyles` / `removeOwnedStyles`）按 `data-plugin` 属性给 `<style>` 记账：**任何**前端模块物化时，把文档里所有 `style:not([data-plugin])` 认领到正在物化的包名下（扫描就在工厂返回之后），并在该包按新 revision 替换入口时按这个名字整批删除（删除发生在重新 import 之前）。官方前端包与 `dsh-claude-style` 都是建标签时就写 `data-plugin="<包名>"` 与唯一的 `data-plugin-css`。本插件的设置导航遮罩样式表（`src/client/footer.js`，`src/` 里唯一自己建的 `<style>`）此前没有标记，两个方向都会出事：**自己那张**会被下一个物化的包收走（此后它记在别人账上，别人的重载会删掉它）；**别人的无标记样式表**会在本插件物化时被认领到 `dsh-chat-import` 名下，本插件重建触发重载时被连带删除（实测损失：2026-10-05 把 dsh-meme 的两张样式表删了，表情包界面整份失去样式，只能刷新恢复）。
- **决定**：
  1. `ensureSettingsNavStyle()` 建标签时写 `data-plugin="dsh-chat-import"`（= `package.json` 的 name = `lib/client.js` 的模块 entry 名，三者必须同一个值）与自己的 `data-plugin-css="dsh-chat-import/settings-nav.css"`；既有元素（旧版本留下的无标记元素、上一次 apply 建的那张）按自己的 `data-plugin-css` 或 id 认回并补标记，不新建第二张。元素本身不移除：本插件重载时由宿主按包名删掉，紧随其后的 `apply()`（`entry.js` 的 `ctx.effect`）重建，不留空窗。
  2. `parkForeignSheets()` 把「未打标签、又不是自己那张」的 `<style>` 改写成 `dsh-chat-import/foreign-sheet`——一个不等于任何包名的值，于是本插件的物化不去认领它们、本插件的重载也不会连带删掉它们。两个时机缺一不可：模块作用域那一次赶在本插件自己的 `claimStyles` 之前（宿主在工厂返回之后才扫描，这是唯一的窗口），外加一个常驻的 `<head>` 观察者管本插件之后才出现的那些。
  3. 契约由 `test/panel-style-ownership.test.mjs` 守住：把宿主那两条记账照抄成测试替身，断言「标记 = 包名 = entry 名」「不被 `style:not([data-plugin])` 命中」「宿主按包名删除后重建的那张仍带标记」「外来无标记样式表不被认领、本插件重载后仍在文档里」。
- **代价**：被挪走的样式表此后不再被任何包的记账收走——一个指望宿主替它收走自己那张的插件会因此留下一份旧副本（本插件只动无标记的那些，宿主的官方包自建时就带标记，不受影响）。局限：在本插件第一次查看文档之前就已经被别人收走的那几张，这条修法够不到。`src/client/` 里再出现第二个自己建的 `<style>` 时，必须照第 1 条写标记。
- **重审条件**：宿主给客户端插件提供样式注入出口（`ctx.styles` 之类）时，删掉自建标签与挪走逻辑；宿主改为按元素引用（而非属性）记账时，本条整体作废。
