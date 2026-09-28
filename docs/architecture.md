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

- **背景**：25 种来源的解析逻辑是 bug 重灾区，必须可以脱离宿主独立测试。
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

- **背景**：AI 辅助开发使代码增长快于人工维护速度；当前热点：`lib/discovery.mjs`（约 2390 行）、`lib/tools.mjs`（约 1660 行）、`lib/import-variants.mjs`（约 900 行）。（`lib/client.js` 曾以 2131 行触发停止线，已按 D7 拆分为 `src/client/` 分片。）
- **决定**：治理方向不是「按行数强拆」，而是：
  - `discovery.mjs` 按**来源族**拆（每种来源的发现逻辑内聚，与 D3 的来源流水线对齐）；
  - `tools.mjs` 按**工具分组**拆（import / export / purge 各自的工具定义与 handler 同文件）；
  - 拆分提案由体量停止线（AGENTS.md）或定期架构巡检触发，一次只拆一个文件，拆完门禁全绿再下一个。
- **代价**：拆分期间 import 路径变动，需要全量测试护航（现有覆盖率护栏足够）。
- **重审条件**：无；这是进行中的方向而非禁令。

---

## D7. 浏览器侧 bundle 例外于零构建：src/client/ 分片 + 组装脚本（2026-09 定）

- **背景**：`lib/client.js`（侧面板 UI）长到 2131 行，触发体量停止线。但 DSH 的客户端模块加载器没有相对 require、也没有资源 URL——浏览器侧产物**必须**是单个自包含文件，「分文件但不构建」在平台上不存在。两条出路：全套 TS 工具链（dsh-better-sidebar 式）或分片+逐字拼接（dsh-claude-style 式）。前者违反 D1 且重审条件不成立（不对外发 TS 类型契约、不需要支持旧 Node），工具链成本对一个陈述式 UI bundle 不成比例。
- **决定**：源码按职责拆到 `src/client/`（11 片：i18n / prefs / sources / widgets / styles / utils / settings / tabs / discovery / footer / entry），`scripts/build-client.mjs` 逐字拼回 `lib/client.js`（沿用 dsh-claude-style 已验证的同平台路线）。片段契约：禁 import/export（共享 factory 作用域，顺序即声明顺序）、4 空格基准缩进、LF 行尾；构建内置 vm 语法门禁，`npm run build` 含 `--check` 新鲜度校验（产物与源漂移即失败）。同时把根目录发布入口收进子目录：`index.mjs`/`index.d.ts` → `lib/`，`convert.mjs`/`export.mjs` shim → `lib/convert/index.mjs` / `lib/export/index.mjs`（`exports["./export.mjs"]` 子路径契约不变），ROADMAP/CONTRIBUTING → `docs/`。
- **代价**：双层真相源——改面板必须改 `src/client/` 再组装，直接改 `lib/client.js` 会被 --check 拦下；eslint 对片段关闭 no-undef/no-unused-vars（跨片引用所致），由构建的整体语法门禁兜底。首拆以「产物逐字节一致」为验收，行为零变化。
- **重审条件**：DSH 客户端加载器支持相对 require / 资源 URL 之时（届时可回到纯 ESM 直发，拆掉的只是组装脚本）。

---

## D8. 会话格式 V3/V4 双形状：读侧形状无关，写侧按宿主版本分流（2026-09 定）

- **背景**：DSH 会话格式 V4 把工具结果从「`role: 'user'` 里包一个 `tool-result` 块」提升为顶层 `role: 'tool'` 消息。实测两个方向都会被拒：V4 形状写进已装的 V3 宿主，核心 Session 要求存在且仅存在一个与 `source.callId` 匹配的 `tool-result` 包装；V3 形状写进 V4 原生准入，报「requires a tool-role message」；`user/message` 里再带 `tool-result` 包装属 V4 退休语法。两种形状互斥，插件不可能只发一种。
- **决定**：读侧形状无关——`toolResultOf(ev)` 是唯一的工具结果读取入口（反向导出、校验、Markdown 渲染都走它），不关心事件来自哪个版本；写侧只在一个边界分流——`prepareHostEvents(events, sessionId, version)` 末尾调 `shapeToolResults`，版本由宿主 `sessionPersistence` 能力位（`formatVersion`/`currentVersion`）探测，探不到取已持久化 header 的最大版本，再兜底 3。双向幂等：已是目标形状的事件原样通过。
- **代价**：两种形状都要测试覆盖（`test/format-version.test.mjs` 锁双向转换、幂等与畸形输入直通）；V4 的其余变更也必须在写 V4 时跟上——`source.kind='plugin'` 被 V4 退役（迁移器改写为 `plugin:<name>`，读路径直接拒绝 `plugin`），导入自产的上下文注入与 system head 因此由 `shapeMessageSources` 同步改写；header 白名单与 `surfaceOp` 早已对齐（`prepareHostMeta` / surface 事件恒带 `surfaceOp`）。
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
- **决定**：压缩导入为**宿主原生的压缩事务**，日志照常保全量历史。IR 加两个可选字段：`turns[i].compaction = { summary, provider, model }`（该轮**之前**有一次压缩）与 `turns[i].shadowed = true`（该轮已被后续压缩遮蔽，log-only）。`synthesizeSession` 在边界轮的 `turn/start` 之前发射 `compaction/start → compaction/summary → 带 surfaceOp:{op:'replace'} 的检查点 user/message → compaction/end`（独立事务，`turn: null`；`sourceEventSeqs` 覆盖全部被遮蔽的 surface 节点；checkpoint 标记 `{kind:'plugin',plugin:'compact',compactionId}` 照抄 `dsh-compaction` 的契约字面量——纯函数层不 import 宿主包）。protected head 与环境变更声明**不进**遮蔽范围（遮蔽范围是连续区间，故声明必须排在所有会话节点之前）。一次会话压缩多次就发多个链式检查点。预算裁剪只在检查点之后的「有效段」上工作：受遮蔽轮不估算、不裁剪、不丢弃。`fullHistory: true` 时不发检查点（模型看全量）并进参数指纹。
- **决定（各源边界口径，2026-09 补）**：边界一律取「源侧模型仍看得见的内容起点」，按各源自己的事实定：Claude 的 `isCompactSummary` / 旧 `summary` 记录（轮之间）、Codex 的 `compacted` 信封（常在轮中间 → 跨界轮一分为二）、Pi 的 `retainedTail` / `firstKeptEntryId`、opencode 的 `tail_start_id`、Kimi 的 `context.apply_compaction`（截点含 turn/step，跨截点轮一分为二；旧格式 wire 无摘要 → 保持切窗口并上报 `compactionSummaryMissing`）、Zed 的 `Compaction` 消息（语义是「用摘要替换整段历史」）、Crush 的 `is_summary_message`、Continue 的 `conversationSummary`（边界在承载它的 item **之后**）、zcode 的 `compactBoundary.keptMessageCount`（缺它就退回摘要 reasoning 块，不猜）、Cline 的 `<id>.compaction.json`（`source_message_count` 条 canonical 消息被折叠）。**兜底**：边界之前没有可遮蔽节点时宿主不变式（`shadowedSeqs` 非空）不允许发检查点，合成层把摘要退回该轮首步的 reasoning 块（无步骤则补空步骤承载），摘要正文永不丢、绝不虚构。
- **决定（DSH → DSH 往返，2026-09 补）**：`convertDshJsonl` 的 `DURABLE` 白名单含三类压缩事件，透传时**不**把检查点的 `surfaceOp:{op:'replace'}` 改写成 `append`，并把替换范围端点、`shadowedSeqs`/`shadowedRange`、`sourceEventSeqs` 用同一套映射重排（两遍映射口径一致）；V4 的 `source.kind='plugin:compact'` 读回来归一成 V3 的 `{kind:'plugin',plugin:'compact'}`（写 V4 时由 `shapeMessageSources` 再改写）。源日志畸形到端点无处映射时退回 `append`（摘要仍可见），残留括号由 `verify_session` 的 `compaction-*` 检查点名。
- **代价**：日志体积等于源转录（几十 MB 级），投影缓存与全量读取的代价随之而来；`compaction/summary` 的 `provider`/`model` 是**来源工具的**事实（Codex 写 `codex`、Claude 写 `claude-code`、Pi 写 `pi-coding-agent`、Kimi/Zed/Crush/Continue/zcode/Cline 各写自己的标签、opencode 系写 `provider` 标签），不是宿主模型的；导出方向暂不重建源工具的压缩记录（检查点消息按「插件注入」计入 `skippedInjections`，不静默）。
- **被推翻的旧决策**：无（此前压缩处理只在各源转换器里「切窗口」或「摘要作 reasoning 块」，从未写进本文档）。**重审条件**：宿主压缩事件契约（事件名 / `shadowedSeqs` 语义 / 检查点标记）变更，或 `deriveMessages` 不再折叠 replace 检查点时。

---

## D12. 去掉双向增量同步：只保留导入与导出（2026-09 定）

- **背景**：双向同步（0.11/0.12 引入，`lib/sync-loop.mjs` + `sync-config.mjs` + `sync-panel.mjs` + `backfill.mjs` + `sync_to_claude` 工具 + 设置页「双向同步」分区）给插件装了第二张脸：入站按间隔巡检外部数据根并续写，出站在外部工具的转录文件里**追加/改写**（三闸守卫、CAS、预检回滚、水印）。它需要的配置（`sync.json` / `outbound.json`）、界面（同步页 + 设置分区）、工具与测试，体量接近导入本身的一半；而它改变的是**别的工具的**数据文件——这个权限面与「把聊天记录读进来」的风险等级不同，出问题的代价也不对称（导入错了是副本，写回错了是用户的源转录）。实际使用中它的价值集中在「我还在源工具里继续聊」这一种情形，而这条需求由「重新导入」即可覆盖（导入侧另有 D13 收口）。用户心智里重复导入一个对话 = 想要一份新的副本，而不是让插件悄悄改写已有会话。
- **决定**：整个删除同步功能——`lib/sync-loop.mjs`、`lib/sync-config.mjs`、`lib/sync-panel.mjs`、`lib/backfill.mjs`、`sync_to_claude` 工具、`/api-import/sync` 路由、设置页同步分区与 `sync.*` i18n 键、`test/sync.test.mjs` 与 index 里的 REQ-36 用例。反向导出保留（`export_chat` 只写**新文件**：新 uuid + `createIfAbsent`，绝不碰源文件）。随之失效的死代码一并删除：`lib/export/claude.mjs` 的 `tailClaudeEvents` / `serializeClaudeJsonlTail` / `verifyClaudeJsonl`、`serializeCodexJsonlTail`、`lib/export/grokbuild.mjs` 整文件（它们只服务写回）；`lib/export/index.mjs`（`exports["./export.mjs"]` 子路径）相应收窄导出名。工具面 13 → 12。registry 里既有的 `writeback` 字段与 `exports` 映射不再有消费者，历史数据留原地作惰性残留（不静默删用户数据）。
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
- **代价**：导入可能写入大量附件字节（本机抽样：297 张 / 43MB，只算 claude 的 40 个会话）；宿主附件服务 v1 无 GC，失败路径可能留下不可达的内容寻址对象（该包已声明这是允许形态）；`skippedBlocks` 与导出降级的 `attachment-skipped` 现在同时涵盖「未知块」与「读不回字节的图片」。Kimi / Zed 的图片仍只能占位（字节在各自的 blob 存储里，插件无法解析）——这是**源侧**限制，不是 IR 限制。
- **重审条件**：宿主附件服务支持通用文件（非图片）/ 提供按引用感知的 GC / 暴露批量落地上限时，重新评估开关默认值与上限；Kimi 若公开 blob 索引（hash → 文件）则可把该源从占位改为落地。
