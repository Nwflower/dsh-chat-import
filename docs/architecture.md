# 架构决策记录

这份文件记录本仓库**为什么**是现在这个样子。每条决策写四样东西：背景、决定、代价，以及什么情况下允许重审。操作手册看 README 和 `docs/`，硬性规则看 `AGENTS.md`；这里只谈权衡。

执行上还有两条约束：

- 任何重构或拆分方案，如果与这里已记录的决策冲突，必须先修改对应条目、说明旧决策为什么失效，然后才能动手。不允许静默推翻。
- 新决策追加在文末，编号递增，旧条目不删。被推翻的条目改成「已废弃」，并指向新决策。

---

## D1. 零构建，纯 ESM，根目录即发布面

- **背景**：这个插件的逻辑就是文本解析加调用宿主服务，没有需要在编译期处理的东西。多一道构建，只会多一处发版事故的来源。
- **决定**：`index.mjs` 与 `lib/` 就是发布产物，源码即产物。根目录只放发布文件，本地工程文件收进 `dev/`，不入库。
- **代价**：没有类型检查，也没有转译，只能靠 eslint、`node --test` 和覆盖率护栏（line ≥ 75%）兜底。
- **重审条件**：需要对外发布 TypeScript 类型契约，或者需要支持旧版 Node 时。
- **例外**：浏览器侧的 bundle（`lib/client.js`）不适用本条，见 D7。宿主侧仍然严格零构建。

## D2. 会话日志 append-only 契约

- **背景**：导入的会话要能成为「可继续的 DSH 会话」，就必须遵守宿主 `sessionPersistence` 的存储契约。改写历史会破坏外部工具对续写的假设。
- **决定**：只做 `create` 和 `append`，不改写历史；`seq` 从 0 连续；surface 事件带 `surfaceOp: 'append'`。
- **代价**：纠错成本高——写错了只能追加一条更正，或者用 force 另建副本。所以转换层必须在写入之前把输入清洗干净。
- **重审条件**：宿主本身的存储契约变更时。

## D3. 纯函数转换层与 host 面严格分层

- **背景**：来源有三十一种（含 DSH 自己的两代会话日志），这些解析逻辑是 bug 的重灾区，必须能脱离宿主单独测试。
- **决定**：`lib/convert/*` 与 `lib/export/*` 是纯函数层：不读磁盘，不 import 宿主服务，文件头写清存储契约。host 面（发现、IO、调用宿主服务）放在 `lib/*.mjs`。其中按来源命名的适配器——SQLite 读取、来源专属编排——收在 `lib/sources/<src>.mjs`，与 `lib/convert/<src>.mjs` 一一对应（2026-09 从 `lib/<src>.mjs` 平移过来，只是换了路径）。新增来源固定走 `AGENTS.md` 里的「新增一个来源」六步。
- **代价**：同一个来源有时要拆成 `convert/<src>.mjs` 和 `lib/<src>.mjs` 两个文件，层与层之间的数据形状也得显式约定。
- **重审条件**：无。这是测试能力的根基。

## D4. 失败要大声，幂等是底线

- **背景**：导入器面对的是别人的数据，畸形行、编码问题、疑似 secrets 都是常态。静默吞掉，用户就会以为导入成功了。
- **决定**：畸形行、疑似 secrets、降级项全部计数并上报。重复导入同一个源时，必须给出确定的答案，不能「看情况」。重导语义从 0.20.0 起由 D13 细化：源没变就跳过，没被续聊就续写，已被续聊就另建副本，`force: true` 恒另建副本。
- **代价**：计数与警告列表这条上报通道会贯穿所有转换器的签名，写起来有点啰嗦。这是故意的。
- **重审条件**：无。

## D5. 数据库源自适应，不假设 schema

- **背景**：用 SQLite 存储的那些来源，schema 会随版本漂移。
- **决定**：用 `node:sqlite` 只读打开；列信息用 `PRAGMA table_info` 自适应；读不到就返回 `null`，不抛异常。
- **代价**：转换器要处理「某列缺失」的降级路径，测试也得用真实的临时库造夹具。
- **重审条件**：无。

## D6. 已知体量热点与治理方向（2026-09 定）

- **背景**：AI 辅助开发让代码增长得比人工维护快。曾经的热点是 `lib/discovery.mjs`（2629 行）、`lib/tools.mjs`（1663 行）和 `lib/import-core.mjs`（1053 行）：这三个文件都越过了停止线，却还在往里加功能。（`lib/client.js` 曾以 2131 行触发停止线，已按 D7 拆成 `src/client/` 的分片；`lib/import-variants.mjs` 曾以 1029 行触发停止线，SQLite 库类来源的 dry-run 预览已迁到各自的 `lib/sources/<src>.mjs`。）
- **执行情况（2026-10）**：三处热点都按下面的方向拆完了，`lib/` 下最大的手工维护文件回到了 1000 行以内：
  - `lib/discovery.mjs` 变成薄门面加 `lib/discovery/`：来源描述符表 `registry.mjs`（FORMATS、默认根、扫描器、单文件判格式全部由描述符派生）、驱动 `discover.mjs`、书签缓存 `scan-cache.mjs`、遍历与状态标注件，以及按来源族划分的扫描器模块（`claude` / `jsonl` / `gemini` / `sqlite` / `cline` / `session-dirs` / `documents` / `dsh`）。
  - `lib/tools.mjs` 变成薄门面（`registerTools` 加档位对账），加上 `lib/tools/`：导入 spec 表、参数派生、输出 schema 片段、结果文案，以及管理、导出、会话、扫描四组工具。
  - `lib/import-core.mjs` 把共享状态机拆出 `lib/import-state.mjs`（已知记录加源未变短路径）、`lib/import-batch.mjs`（文件收集加批量计数）、`lib/host-session.mjs`（宿主会话读写适配）。
    - 后面又续拆了一刀（2026-10）：宿主 `sessionPersistence` 的两套形状适配（列会话、读事件、写会话、归档集、实测日志长度）从 `lib/imports.mjs` 收进了 `lib/host-session.mjs`。那个文件本来的职责就是「按宿主契约怎么写」，此前反倒是它要从 registry 模块取 `listPersistedHeaders` 和 `writeSession`。`imports.mjs` 现在只转出这些名字，既有消费者零改动，行数从 932 降到 803。会话骨架（轮队列、待落压缩检查点、遮蔽）也从 13 个转换器收进了 `lib/convert/ir.mjs` 的 `createTurns()`。
- **决定**：治理方向不是「按行数硬拆」，而是：
  - `discovery.mjs` 按**来源族**拆。同一个来源的发现逻辑内聚在一处，与 D3 的来源流水线对齐。
  - `tools.mjs` 按**工具分组**拆。import、export、purge 各自的工具定义与 handler 放在同一个文件里。
  - `import-variants.mjs` 只留 chatgpt、grokbuild、hermes、kimi 这类「源形态特殊」的编排与预览。已经有 `lib/sources/<src>.mjs` 的来源，预览与导入编排就住在那份文件里，不回流到 `import-variants.mjs`。
  - 拆分提案由体量停止线（见 AGENTS.md）或定期架构巡检触发。一次只拆一个文件，拆完门禁全绿再动下一个。
- **代价**：拆分期间 import 路径会变动，需要全量测试护航。现有的覆盖率护栏够用。
- **重审条件**：无。这是进行中的方向，不是禁令。

---

## D7. 浏览器侧 bundle 例外于零构建：src/client/ 分片 + 组装脚本（2026-09 定）

- **背景**：`lib/client.js` 是侧面板的 UI，曾经长到 2131 行，触发了体量停止线。但 DSH 的客户端模块加载器既没有相对 require，也没有资源 URL，浏览器侧的产物**必须**是一个自包含的单文件。「分成多个文件但不构建」在这个平台上做不到。出路有两条：上全套 TypeScript 工具链（dsh-better-sidebar 的做法），或者分片加逐字拼接（dsh-claude-style 的做法）。前者违反 D1，而且它的重审条件也不成立（不对外发 TypeScript 类型契约、不需要支持旧 Node）；对一个陈述式的 UI bundle 来说，工具链的代价与收益不成比例。
- **决定**：源码按职责拆到 `src/client/`，片段清单以 `scripts/build-client.mjs` 的 `FRAGMENTS` 为准，再由构建脚本逐字拼回 `lib/client.js`，沿用 dsh-claude-style 已经验证过的同平台路线。宿主侧与面板共用的纯函数（`lib/panel-filter.mjs`、`lib/highlight.mjs`、`lib/footer-layout.mjs`）不在片段里另抄一份：组装脚本按白名单把它们内联进 bundle——去掉 `export` 关键字、按 4 空格基准缩进，并拒绝 import、`export default` 和多行模板串——所以测试测的就是发布的那一份。片段本身的契约是：禁 import / export（各片共享同一个 factory 作用域，顺序就是声明顺序）、4 空格基准缩进、LF 行尾。构建内置了 vm 语法门禁，`npm run build` 带 `--check` 做新鲜度校验，产物与源漂移即失败。同一轮还把根目录的发布入口收进了子目录：`index.mjs` / `index.d.ts` 移到 `lib/`，`convert.mjs` / `export.mjs` 两个 shim 移到 `lib/convert/index.mjs` 与 `lib/export/index.mjs`（`exports["./export.mjs"]` 的子路径契约不变），ROADMAP 与 CONTRIBUTING 移到 `docs/`。
- **代价**：真相有了两层。改面板必须改 `src/client/` 再重新组装；直接改 `lib/client.js` 会被 `--check` 拦下（CI 单独跑一步 `build-client.mjs --check`）。片段之间会互相引用，所以 eslint 按组装脚本生成的跨片全局名单、逐片段启用 no-undef——vm 语法门禁只管能不能解析，管不到未定义的引用。首次拆分以「产物逐字节一致」为验收标准，行为零变化。
- **重审条件**：DSH 客户端加载器开始支持相对 require 或资源 URL 时。那时可以回到纯 ESM 直发，拆掉的只是组装脚本。

---

## D8. 会话格式 V3/V4 双形状：读侧形状无关，写侧按宿主版本分流（2026-09 定）

- **背景**：DSH 会话格式 V4 把工具结果从「在 `role: 'user'` 里包一个 `tool-result` 块」提升为顶层的 `role: 'tool'` 消息。实测下来，两个方向都会被拒：V4 形状写进已经装好的 V3 宿主，核心 Session 要求存在且仅存在一个与 `source.callId` 匹配的 `tool-result` 包装；V3 形状写进 V4 的原生准入，报「requires a tool-role message」；而在 `user/message` 里再带 `tool-result` 包装，本身已经是 V4 的退休语法。两种形状互斥，插件不可能只发一种。
- **决定**：读侧不看形状。`toolResultOf(ev)` 是读取工具结果的唯一入口，反向导出、校验、Markdown 渲染都走它，不关心事件来自哪个版本。写侧只在一个边界分流：`prepareHostEvents(events, sessionId, version, hostVersion)` 依次过 `shapeToolResults`、`shapeMessageSources`、`shapeReplaceOps`。目标代次 `version` 由宿主 `sessionPersistence` 的能力位（`formatVersion` / `currentVersion`）探测；探不到就取已持久化 header 的最大版本，再兜底为 3。`hostVersion` 是宿主的**原生**代次（`hostNativeFormatVersion`），只用于两处与文件代次无关的 V4 改名（source 生产者 kind、替换标记拼写），省略时回退到 `version`，方便纯函数测试。双向幂等：已经是目标形状的事件原样通过。
- **代价**：两种形状都要有测试覆盖（`test/format-version.test.mjs` 锁住双向转换、幂等和畸形输入直通）。写 V4 时，V4 的其他变更也得跟上：
  - `source.kind='plugin'` 被 V4 退役了（迁移器会改写为 `plugin:<name>`，读路径直接拒绝 `plugin`）。导入自产的上下文注入与 system head 因此由 `shapeMessageSources` 同步改写，并且逐条照抄宿主 `dsh-session-format-v3-to-v4` 的 `producerKind()`（`RENAMED_PRODUCERS`、同名生产者表，加上 system 角色的特例）。
  - 压缩检查点的生产者 kind 是 `compact-checkpoint`。宿主 `isCompactCheckpointSource` 只认这个值，压缩 invariant、会话引用投影、trajectory 折叠也都吃它；只发 `plugin:compact` 的话，检查点在宿主眼里会退化成一条普通的 user 消息。
  - `prepareHostMeta` 按白名单重建 header。
  - surface 事件恒带 `surfaceOp`。替换端点的两种拼法（`{start,end}` 与 `{startSeq,endSeq}`）由 `shapeReplaceOps` 按宿主 **runtime** 世代双向归一：`dsh-session` ≤0.1.x 只认前者，≥0.2.0 只认后者，与 header 代次无关。
- **重审条件**：宿主开始广告 3/4 之外的版本；或者 V4 的其余变更成为强制项。后者到时需要一次面更宽的迁移，而不只是改工具结果的形状。

## D9. 导入会话自带空 system head：surface 首事件必须是 system/message（2026-09 定）

- **背景**：宿主 v3→v4 的迁移器把 surface 上的第一个 `system/message` 记为 protected head，此后每一步写系统提示词都以它为替换锚点。如果 surface 里已经有别的 surface 事件、而 head 还没建立，迁移器会 fail-closed 拒载整份日志（`system/message requires a protected first surface head`）。导入会话此前从 `user/message` 开始，宿主续聊、要写自己的系统提示词时就撞上这条规则；由它 seed 出来的续聊会话同样打不开。原生会话不受影响，因为它创建时就写了 head。
- **决定**：`synthesizeSession` 在首个 `step/start` 之后、任何其他 surface 事件之前写一条 `system/message`，带 `surfaceOp: 'append'`、`content: []`、`source.plugin = 'chat-import'`。位置和内容都对齐宿主自己的 v2→v3 迁移器——它同样在第一个 step/start 处插一条空 head。空内容只占住 surface 的第 0 个节点，真正的系统提示词由宿主在下一步替换或归一化，导入这边不虚构提示词。
- **代价**：导入会话多出一条事件（`storedEvents` 基线因此加 1）。首轮没有 step 时，补一个只装 head 的空 step。`SESSION_EVENT_TYPES` 和 surface 集合要加入 `system/message` 与 `developer/message`。`verify_session` 新增 `system-head-missing` 来点名存量旧形状——head 必须是 surface 的首事件，旧日志只能 force 重导，没法原地补写。
- **重审条件**：宿主迁移器改成「缺 head 时自己插入」（v2→v3 就是这种语义）时，这段插桩可以退化为可选。


---

## D10. 设置页双版兼容：0.1.7 按条目 id / 0.1.5 自持命名空间（2026-09 定）

- **背景**：DSH 0.1.7 删掉了 `settings.register()`。命名空间改成了 profile 条目 id，schema 改成了插件导出的 `Config`；0.1.5 及更早则是插件按名字注册。插件以软链或本地 link 装进 profile 时，`@deepseek-ai/schemastery` 未必能从它自己的 require 锚点解析到。0.1.7 的 loader 还把条目 id 报成 `<kind>:<id>`，而设置服务是按裸 id 建索引的——带前缀写会得到 409 `settings-conflict`。
- **决定**：`lib/import-prefs.mjs` 按宿主能力探测来绑定，一套代码跑两版。`describe()` 的名单里有本插件的**裸条目 id**，就走 `forms`（0.1.7 的路径：按条目 id 走 describe / update，并调 `settings.configure({ auto: false })` 声明自带面板）。只有 `register` / `get`，就走 `legacy`（0.1.5 的路径：自持命名空间 `chat-import`）。两者都没有就是 `none`：读默认值，写入不持久化。`entryIdOf()` 负责剥掉 `<kind>:` 前缀，剥完为空时回退到 patch 里声明的 `import-claude`。schemastery 的解析锚点指向**运行中的 harness bin**，`.volatile()` 也做能力探测。插件入口导出 `Config`。
- **决定（客户端席位）**：设置界面按同一个世代分流。`ctx.get('configForms')` 在场（0.1.7+）时，注册 `plugins.bundle.config`（键是包名 `dsh-chat-import`，渲染在「设置 → 插件」的插件页），并用 `configForms.get(条目 id)` 逐字段读写。缺席时保留 `settings.section` 整页和 `/api-import/prefs` 这条 fenced 路由。两处是互斥注册的：只要 `configForms` 存在，整页就被否决，避免同一项设置在两个地方各长一份。
- **代价**：两套设置模型都要测试覆盖。`.volatile()` 探测和软链锚点都是宿主实现细节，宿主换版就得重审。完整的踩坑记录与自检方法见 [SETTINGS-MIGRATION.zh-CN.md](SETTINGS-MIGRATION.zh-CN.md)。
- **重审条件**：0.1.7 及以后成为唯一的支持面时，删掉 legacy 路径和探测，只留 `Config` 加条目 id。

## D11. 上下文压缩导入为原生压缩事件，不切窗口（2026-09 定）

- **背景**：来源工具的上下文压缩（Claude Code 的 `compact_boundary` 加 `isCompactSummary` user 记录、Codex 的 `compacted` 信封、Pi 的 `compaction` 条目、opencode 的 `compaction` part 加摘要消息）意味着「模型只看到摘要 + 压缩点之后的对话」，而压缩前的记录仍然留在源转录里。之前的两种做法都不好：
  - 不处理：全量历史灌进上下文，超预算时预算裁剪会把中间若干轮真的删掉。本机一份 6579 条记录、压缩过 10 次的 Codex rollout 约 8411412 tokens，被裁掉 5 轮、796 条消息、741 次工具调用。
  - 切窗口：只导压缩点之后的记录，压缩前的历史在导入时就**永久消失**，既不能回溯，也不能导出回源。这与宿主「日志是记录、投影才是上下文」的模型相反。
- **决定**：压缩导入为**宿主原生的压缩事务**，日志照常保全量历史。IR 增加两个可选字段：`turns[i].compaction = { summary, provider, model, time? }` 表示这一轮**之前**有过一次压缩，`turns[i].shadowed = true` 表示这一轮已经被后续压缩遮蔽、只留在日志里（log-only）。另有一组可选的源时间戳（毫秒）：`turns[i].time`、`steps[j].time`、`toolResults[k].time`、`compaction.time`。事件的 `time` 取最近一个已知的源时间，且不倒退；来源没有时间戳时保持 `meta.createdAt`——此前会话列表的最后活动时间恒等于创建时间。
  
  `synthesizeSession` 会在边界轮的 `turn/start` 之前发射一个独立事务：`compaction/start` → `compaction/summary` → 带 `surfaceOp:{op:'replace'}` 的检查点 `user/message` → `compaction/end`。事务的 `turn` 为 `null`，`sourceEventSeqs` 覆盖全部被遮蔽的 surface 节点。检查点标记 `{kind:'plugin',plugin:'compact',compactionId}` 照抄 `dsh-compaction` 的契约字面量：纯函数层不 import 宿主包，写 V4 时再由 `shapeMessageSources` 按宿主的 `producerKind()` 改写成 `{kind:'compact-checkpoint',compactionId}`。
  
  protected head 与环境变更声明**不进**遮蔽范围。因为遮蔽范围是一个连续区间，那条声明必须排在所有会话节点之前。一次会话压缩多次，就发多个链式检查点。预算裁剪只在检查点之后的「有效段」上工作：受遮蔽的轮不估算、不裁剪、也不丢弃。`fullHistory: true` 时不发检查点（模型看到全量），该开关进参数指纹。
- **决定（各源边界口径，2026-09 补）**：边界统一取「源侧模型还看得见的内容起点」，按各源自己的事实来定：
  - Claude：`isCompactSummary` 或旧格式的 `summary` 记录，边界落在轮之间。
  - Codex：`compacted` 信封，常在轮中间，于是跨界那一轮一分为二。
  - Pi：`retainedTail` 或 `firstKeptEntryId`。
  - opencode：`tail_start_id`。
  - Kimi：`context.apply_compaction`。截点包含 turn 和 step，跨截点的那一轮一分为二；旧格式 wire 没有摘要，就保持切窗口，并上报 `compactionSummaryMissing`。
  - Zed：`Compaction` 消息，语义是「用摘要替换整段历史」。
  - Crush：`is_summary_message`。
  - Continue：`conversationSummary`，边界在承载它的 item **之后**。
  - zcode：`compactBoundary.keptMessageCount`。缺这个字段就退回摘要 reasoning 块，不去猜。
  - Cline：`<id>.compaction.json` 里被折叠的 `source_message_count` 条 canonical 消息。
  
  **兜底**：如果边界之前没有可遮蔽的节点，宿主的不变式（`shadowedSeqs` 非空）就不允许发检查点。这时合成层把摘要退回该轮首步的 reasoning 块，没有步骤就补一个空步骤来承载。摘要正文永不丢，也绝不虚构。
- **决定（DSH → DSH 往返，2026-09 补）**：`convertDshJsonl` 的 `DURABLE` 白名单包含三类压缩事件。透传时**不**把检查点的 `surfaceOp:{op:'replace'}` 改写成 `append`，并用同一套映射重排替换范围端点、`shadowedSeqs` / `shadowedRange` 和 `sourceEventSeqs`（两遍映射口径一致）。V4 的检查点 source（`{kind:'compact-checkpoint'}`，以及旧插件写歪的 `'plugin:compact'`）读回来时归一成 V3 的 `{kind:'plugin',plugin:'compact'}`，写 V4 时再由 `shapeMessageSources` 改写一次。替换端点的两种拼写都认，重排时保持源日志的原拼写；写目标会话时由 `shapeReplaceOps` 按宿主世代归一，这样跨世代回灌也不丢压缩语义。源日志畸形、端点无处映射时退回 `append`，摘要仍然可见，残留的括号由 `verify_session` 的 `compaction-*` 检查点名。
- **代价**：日志体积等于源转录，是几十 MB 级，投影缓存与全量读取的代价随之而来。`compaction/summary` 里的 `provider` 和 `model` 记的是**来源工具**的事实——Codex 写 `codex`，Claude 写 `claude-code`，Pi 写 `pi-coding-agent`，Kimi、Zed、Crush、Continue、Cline 各写自己的标签，opencode 系写 `provider` 标签——不是宿主模型的。导出方向暂时不重建源工具的压缩记录：检查点消息按「插件注入」计入 `skippedInjections`，不会静默吞掉。
- **被推翻的旧决策**：无。此前压缩处理只在各源转换器里「切窗口」或「把摘要作 reasoning 块」，从未写进本文档。
- **重审条件**：宿主的压缩事件契约（事件名、`shadowedSeqs` 语义、检查点标记）变更；或者 `deriveMessages` 不再折叠 replace 检查点。

---

## D12. 去掉双向增量同步：只保留导入与导出（2026-09 定）

- **背景**：双向同步（0.11 与 0.12 引入，由 `lib/sync-loop.mjs`、`sync-config.mjs`、`sync-panel.mjs`、`backfill.mjs`、`sync_to_claude` 工具和设置页的「双向同步」分区组成）让插件长出了第二张脸。入站按间隔巡检外部数据根并续写；出站在外部工具的转录文件里**追加或改写**（三闸守卫、CAS、预检回滚、水印）。

  它需要的配置（`sync.json`、`outbound.json`）、界面（同步页加设置分区）、工具与测试，体量接近导入本身的一半。而它改的是**别的工具**的数据文件：这个权限面与「把聊天记录读进来」的风险等级不同，出问题的代价也不对称——导入错了只是一份副本，写回错了动的是用户的源转录。实际使用中，它的价值集中在「我还在源工具里继续聊」这一种情形，而这条需求用「重新导入」就能覆盖（导入侧另有 D13 收口）。用户的心智里，重复导入一个对话是要一份新的副本，而不是让插件悄悄改写已有会话。
- **决定**：把同步整个删掉，包括 `lib/sync-loop.mjs`、`lib/sync-config.mjs`、`lib/sync-panel.mjs`、`lib/backfill.mjs`、`sync_to_claude` 工具、`/api-import/sync` 路由、设置页的同步分区与 `sync.*` i18n 键、`test/sync.test.mjs` 以及 index 里的对应用例。

  反向导出保留。`export_chat` 只写**新文件**（新 uuid 加 `createIfAbsent`），绝不碰源文件。随之失效的死代码一并删除：`lib/export/claude.mjs` 的 `tailClaudeEvents`、`serializeClaudeJsonlTail`、`verifyClaudeJsonl`，`serializeCodexJsonlTail`，以及整个 `lib/export/grokbuild.mjs`——它们只服务写回。`lib/export/index.mjs`（也就是 `exports["./export.mjs"]` 子路径）相应收窄了导出名。工具面从 13 个变成 12 个。

  registry 里已有的 `writeback` 字段与 `exports` 映射不再有消费者，历史数据原地留着，当作惰性残留，不静默删用户数据。
- **代价**：原先靠写回把 DSH 里的续聊同步回 Claude Code、Codex、Grok 的用户失去了这个能力。`export_chat` 仍能导出成新文件，但不会再追加回源。`$DSH_HOME/dsh-chat-import/sync.json` 与 `outbound.json` 成了惰性残留文件。`./export.mjs` 子路径的公开导出名变少，这是 0.20.0 的破坏性变更，CHANGELOG 里点名了。
- **重审条件**：写回需求如果重现，应该做成**独立插件**——自带配置、面板和定时器，并自己承担「改写外部工具文件」的风险——而不是把这个能力塞回导入器。本条不因为「用户想要同步」就撤销。

---

## D13. 重导语义：未被续聊才续写，续聊过就另铸副本（2026-09 定）

- **背景**：删掉同步（D12）之后，「重复导入同一个源」必须有确定的答案。此前 D4 的规则是「目标会话已存在就跳过，源增长时增量续写」，这两种情形都会出问题：
  - 源文件增长时，如果把**新增轮次追加进已有会话**，而用户已经在那条会话里聊过天，导入的内容就混进了他自己的对话（时序上还插在他提问之前），事后没法拆开。
  - 源没变时静默跳过，又让「我就是想再导一份」的用户没有出口。
  
  用户对「再导一次」的直觉是**想要一份新的**。但完全放弃增量导入，`/import-all` 和面板批量导入这类批量入口每次运行都会把历史源复制一遍——`/import-all` 完全依赖导入侧的幂等闸（见 `lib/command.mjs`）。
- **决定**：D4 的「幂等」保留，但判据从「记录存在」换成「**这条 DSH 会话还是不是我上次写完的样子**」。registry 记录新增 `storedEvents`，它是我们落盘后**实测**的 DSH 日志长度，不是转换口径的 `events` 计数：create 或 replace 之后读回一次，append 时按 `fromSeq + 尾部事件数` 直接推算，不额外读盘。源增长时按实测长度分流：
  - **等于**基线：纯镜像，续写尾部（`appended`），增量导入的行为不变。
  - **大于**基线：用户在 DSH 里续聊过，**另铸副本**（新 id，结果带 `reimported.reason: 'continued-in-dsh'`），旧会话原样不动。
  - **小于**基线：日志被外部截短，不写入，跳过并报 `storedShrunk`。
  - **无基线**（0.20.0 之前的记录）：判断不了，保守地另铸一次副本，落盘后回填基线（`reason: 'baseline-missing'`）。
  
  读不到日志长度（后端不可用）时，既不追加也不复制，跳过并报 `appendedSkipped`。`force: true` 或显式改 `sessionId` 仍旧恒另铸副本（`reason: 'forced'` / `'session-id-changed'`）。

  **另铸副本时，旧会话进 `record.copies`**。撤回、清理、体检、`/attach-workspaces` 和面板历史都经 `lib/imports.mjs` 的 `registryEntries` 统一展开——此前有 8 处各自展开 registry，加 copies 必漏改，所以一并收口。删除单条副本只摘这一条；删除主记录时把最新副本提升为主记录，会话还在，账也还在。
- **代价**：
  - registry 记录多了两个字段（`storedEvents` / `copies`），每次 create 多一次日志读回（append 路径不需要）。
  - 一次导入可能产出多条会话。这是用户显式重导的必然结果。
  - `reimported` 取代了原先只服务 force 的 `forceImported`，输出 schema 与类型面同步改名。
  - 基线是「我们写完时的长度」。所以宿主如果在 create 之后自行追加事件（迁移、归一化），它就会被判成「已续聊」，代价是**多建一份副本**。这个方向偏保守，而且结果里点名了原因。
- **重审条件**：宿主提供「会话自上次写入后是否被改动」的一等信号（revision 或写入者标记）时，改用该信号替代日志长度比对。

## D14. 图片以宿主附件落地：IR 只带字节，日志只留引用（2026-09 定）

- **背景**：0.20.0 及以前，所有来源的图片都降级成 `[image]` 文本占位，理由是宿主的会话日志不该装 base64。对本机真实数据做了一次普查，看看这个代价有多大：claude 的 43 个会话文件里有 590 张图，kimi 258 张，grokbuild 101 张，codex 42 张。而 DSH **原生就存图片**：141 份原生日志里有 144 个 `image` 块，形态是 `{type:'image', attachment:{attachmentId:'sha256:…', mediaType, width, height, bytes, name}}`，字节由 `ctx.attachments` 持有（`@deepseek-ai/dsh-attachment` 的 `AttachmentStore`，内容寻址）。

  另外，宿主 `@deepseek-ai/dsh-llm` 的 `ContentBlockMap` 恰好就是 `text` / `reasoning` / `image` / `tool-call` / `tool-result`，而 `image` 是我们 IR 唯一没对齐的块类型。普查还查出三处**静默丢弃**：claude 与 codex 用户提问里的图片（只取 text 块拼 prompt，图片连计数都没有）、助手消息里的图片、Kimi 工具结果里的 `image_url`（`mapToolOutput` 只取 text 和 think）。
- **决定**：
  1. **IR 增加两种状态的 `image` 块**：待落地的 `{type:'image', data:<base64>, mediaType, name?}`（转换层拿到字节时产出），以及已经是引用的 `{type:'image', attachment:{…}}`（DSH 源回灌或导出再导入时出现）。用户提问带图时，完整的块列表放 `turns[i].promptBlocks`；`prompt` 仍是文本投影，标题、空轮判定和去重都用它。
  2. **字节只在边界存在**。`lib/attachments.mjs` 在 `runDecision` 的每条写盘路径（create、replace、append、multi 全部）上，就地把待落地块经 `ctx.attachments.saveImage` 落成不可变对象并替换为引用，**base64 永不写进会话日志**（宿主的 `ImageBlock` 只认引用）。已经是引用的块原样保留，靠内容寻址，不重复存。导出方向对称：`resolveImagesForExport` 经 `readImage` 把引用读回 base64，供 Claude 和 Codex 的序列化器写进目标格式。
  3. **失败要大声**。出现下列情况时，该块降级为 `[image]` 文本并计入公开结果的 `imagesDegraded`，落成附件的张数则计入 `images`：
     - 服务缺席（附件服务是可选服务）
     - 类型不收（第一版只收 PNG / JPEG / WebP / GIF）
     - 超出上限（单会话 500 张，超出的部分降级）
     - 载荷畸形
     - 源只给了引用（Kimi 的 `blobref:`，它的 `file/index.json` 不映射这个 hash）
     
     导出侧读不回字节，同样计入 `attachment-skipped` 降级。
  4. **可以关掉**。`storeImages: false`（或 `DSH_IMPORT_STORE_IMAGES=0`）时不做落地，只留占位。图片是唯一会把宿主持久存储撑大的导入面——本机抽样 40 个 claude 会话就有 43MB 图片字节——得给用户一个开关。
  5. **目标代次小于 4 时一律降级**。附件引用是当前世代（V4）宿主的概念，V3 落点（面板「导入到 → DSH（V3）」）或续写一条 V3 会话时，旧宿主读不懂引用，所以此时图片（含已经是引用的块）全部降级为 `[image]` 占位并计数。判据只取**权威来源**：面板显式覆盖的代次，或目标会话 header 自己的代次。不取「推断出来的宿主代次」，因为宿主没有版本信号时，推断值会退化成转换层默认的 3；若据此降级，全新宿主上的图片会被全部降级。
- **代价**：
  - 导入可能写入大量附件字节。本机抽样是 297 张、43MB，只算 claude 的 40 个会话。
  - 宿主附件服务第一版没有 GC，失败路径可能留下不可达的内容寻址对象（该包已声明这是允许的形态）。
  - **删除或撤回导入会话不会回收附件字节**。`AttachmentStore` 只有 `saveImage`、`readImage`、`validateImage`，没有删除接口。所以清理一个含图会话只会删掉日志和 registry 条目，图片对象留在附件存储里；`lib/purge.mjs` 与 `lib/retract.mjs` 因此不碰附件。
  - `skippedBlocks` 与导出降级的 `attachment-skipped` 现在同时涵盖「未知块」和「读不回字节的图片」。
  - V3 落点没有图片。Kimi 与 Zed 的图片仍然只能占位，因为字节在各自的 blob 存储里，插件解析不到。这是**源侧**限制，不是 IR 的限制。
- **重审条件**：宿主附件服务支持通用文件（不限于图片）、提供按引用感知的 GC、或暴露批量落地上限时，重新评估开关的默认值与上限。Kimi 若公开 blob 索引（hash 到文件的映射），就可以把该源从占位改为落地。

## D15. Claude 富结果 sidecar 按需并入为文本（2026-09 定）

- **背景**：Claude Code 会在 `tool_result` 记录旁边另写一份 `toolUseResult`，这是模型看不到的结构化产物。本机 4001 条样本的键频次如下：
  - `stdout`、`stderr`、`interrupted`、`isImage` 各约 2096 条
  - `filePath`、`originalFile`、`structuredPatch`、`userModified` 各 1260 条
  - `oldString`、`newString`、`replaceAll` 各 1115 条
  - `contentNotInModelContext` 648 条，`filenames` 与 `numFiles` 各 150 条，`bashEditDiff` 147 条
  - 另有 `durationMs`、`persistedOutputPath`、`questions` 与 `answers`、`gitOperation` 等
  
  此前只导入模型可见的 `tool_result.content`，这些 sidecar 全丢了。其中有信息量的主要是两类：`structuredPatch`（编辑到底改了什么）和 `questions` 与 `answers`（交互问答）。
- **决定**：宿主的 `ToolResultBlock` 只有 `{ toolCallId, content, isError }`，没有结构化 sidecar 的槽位。DSH 自己的工具就是把结构化信息**渲染成文本**存进 content 的——真实日志里 tool-result 的正文就是 `{"exitCode":0,"stdout":…}` 这类 JSON。所以按需把 sidecar 渲染成文本块，**追加在可见结果之后**：
  - `structuredPatch` 与 `bashEditDiff` 渲染成统一 diff 文本，用 ` ```diff ` 围栏
  - `questions` 与 `answers` 渲染成问答对
  - 其余标量渲染成一行 `<tool-use-result>{…}</tool-use-result>`
  
  体积大的键（`originalFile`、`content`、`stdout`、`stderr`）、以及「值已经在可见文本里出现过」的项，一律跳过；单个值超过 2000 字符也跳过。绝不把整份文件搬进日志。
- **开关与指纹**：`includeToolUseResult: true`，默认关闭。理由是样本里 1260 条带原文补丁、1115 条带 old / new 字符串，全量并入会明显撑大日志，而多数会话并不需要。这个开关与 `fullHistory` 一样列进 claude 的参数指纹——换值就得重导，否则短路径会按旧参数跳过。结果里的 `toolUseResultsMerged` 上报合并了多少条。
- **代价**：开启后日志体积随编辑次数增长，每条补丁几十到几百字符。`originalFile` 这类整份快照仍然不导入，这与「只导模型可见内容」的口径一致：`tool_result.content` 里的片段已经够还原语义。
- **重审条件**：宿主为工具结果提供结构化元数据的槽位时，改为写结构化字段，而不是渲染文本；或者按需把 `originalFile` 也纳入，那需要一个新的体积开关。

## D16. 归组必须先定目标工作区：attach 只接受 cwd 与工作区路径相等（2026-09 定）

- **背景**：有用户报告「从 Claude 导入的对话，重启也不出现在对话列表里」。实际情况是导入成功了，但会话掉进了侧栏最底部的「未分组」。根因是宿主的挂接契约与我们「先导入、事后回退」的设计相冲突：
  1. `@deepseek-ai/dsh-workspace` 的 `attachSession` 会读会话 header，要求 `realpath(header.cwd) === workspace.path`，否则抛 `its cwd resolves to '…'`。`workspace.sessionIds` 的 getter 也只返回通过了这个检查的 id。
  2. 客户端（`dsh-client-ui-workspace`）用 `ungroupedMemberIds = list.ids − ⋃workspace.sessionIds`。没被计入的会话因此全部落进「未分组」。
  3. 旧实现先在 create 时落下源 cwd，事后才 `attachToWorkspace`。cwd 候选命不中时，就**回退到源文件目录**并 `create()` 一个工作区。源目录确实被建出来了，但 `attachSession` 必然被宿主拒绝，而这个异常只写进 `console.error`（本机 `$DSH_HOME/logs` 是空的，用户完全看不到）。净效果是**多出一个空工作区，会话仍在「未分组」**。
  
  本机实测：同一批三条导入里，两条 cwd 为主目录的会话各留下一个空工作区（`…\.claude\projects\C--Users-Nwflower`、`…\.codex\sessions\2026\09\07`，创建时间与导入时间相差 16–22ms）。第三条 cwd 命中了已有工作区，照常归组。
- **决定**：
  1. 归组前置。`lib/workspace-group.mjs` 在 **create 之前**规划目标工作区，并把目标路径写进会话 header 的 cwd；create 之后再 `attachSession`。同一个 plan 也用于 replace，以及 multi 的每条 create。
  2. 目标怎么选（`workspaceMode`，默认 `auto`）：cwd 命中已有工作区就沿用；cwd 不是主目录、又能建成工作区，就地建（会话落在真实项目下，与原生会话同区）；否则落到专用导入工作区 `$DSH_HOME/dsh-chat-import-workspace`（`mkdir -p` 后建，cwd 随之改写）。`per-project` 同上，但**不改写 cwd**——宁可「未分组」，也不伪造 cwd。`dedicated` 一律落专用工作区。主目录 cwd 始终不建工作区，因为沙箱 ACL 会拒绝 home 里的 temp / pwsh，这类会话走专用工作区。
  3. 绝不按 transcript 的一面之词建目录。cwd 是不是可用目录，交给宿主的 `create` 判定（`realpath` 加 `isDirectory`）；插件只为自己拥有的专用导入工作区 `mkdir -p`。跨机器的 transcript 因此自然落到专用工作区，既不会在源盘上造目录，也不会把源 transcript 目录当工作区。
  4. 失败要大声。归组结果进公开结果：`workspace`、`workspaceMode`、`workspaceCreated`（新建了工作区，这是用户可见的副作用），以及 `ungrouped` 与 `ungroupedReason`（会话已导入，但停在「未分组」）。`/attach-workspaces` 改为按**会话自己的 cwd** 重新规划，不再回退源目录。header 是 append-only，事后改不了 cwd，所以落不了组的会话如实报告，并提示用 `force` 重导一份。
  5. 附带修掉两处静默。`restore_bundle` 原先自己算 `groupedTo`（声称「回退归组到 bundle 目录」），现在改为照抄真实落点。空工作区清理原先调 `ws.remove()` / `wr.remove()`，而现在的宿主只有 `workspaceRegistry.delete(id)`，等于根本没清理；改为 `delete(id)`，并扩展到旧实现误建的源目录工作区。面板「导入历史」加了「清理空工作区」按钮，只删成员为 0 的工作区登记，目录与会话日志保留。
- **代价**：会话 header 的 cwd 可能不再是源 cwd（源 cwd 不可用时，会改写成落点工作区）。这样做是为了「导入的会话一定能被看到」：工具会在落点目录里执行，而不是一个本机根本不存在的源路径。`workspaceMode` 的三个取值因此有了实质差别——此前 `auto` 与 `per-project` 是同义的。
- **重审条件**：宿主允许一条会话同时属于多个工作区，或者允许在挂接时改写 header 的 cwd（提供 relocate API）时，可以回到「保持源 cwd 加显式分组」的组合。宿主暴露 workspace 事件或 GC 时，空工作区清理可以做成自动的，而不是一个按钮。

## D17. 客户端只消费注入服务的例外：官方 UI primitives 的 Toast（2026-09 定）

- **背景**：导入落点以前只写在面板的结果栏里，也就是面板内的一行文本。批量导入时，用户可能已经切走 tab 或收起右栏，于是「导进去了，但不知道导到哪」。这和 D16 修的那个困惑是同一个来源。

  DSH 有官方 Toast：`@deepseek-ai/dsh-client-ui-primitives` 的 `Toast`，一个顶部居中的临时横幅。owner 给它 `holdMs` 和 `onDone`，组件 key 一变就重开一条。宿主自己的插件就是这么用的：`dsh-client-ui-plugin-manager` 在自己的 client bundle 里 `require("@deepseek-ai/dsh-client-ui-primitives")`，再把 toast 经 `ctx.slots.inject("shell.overlay", …)` 注册成 `plugin-manager.refresh-toast`。
- **决定**：
  1. 新增 `src/client/toast.js` 分片。`ToastHost` 经 `ctx.slots.inject("shell.overlay")` 注册，id 用 `chat-import.landing-toast`，与宿主 toast 同槽。导入成功后弹「导入完成 → <落点>（本次新建该工作区）；另有 N 个未归组」；转投（非 DSH 目标）弹写出的文件路径。落点信息全部取自 D16 的公开结果字段（`workspace`、`workspaceCreated`、`ungrouped`），面板不另算。
  2. 这是「客户端只消费注入的 slots / locale / react」的**唯一例外**，而且必须可降级。`require` 包在 `try/catch` 里，拿不到（或者拿到的组件里没有 `Toast`）就渲染一条同位置、同 `holdMs` 的自绘横幅。插件声明支持 dsh ≥ 0.1.5-rc.1，不能因为一句提示就在旧宿主上把整个面板搞挂。这个 require 走 bundle factory 已有的 `require` 通道（`react` 本来就是这么拿的），不引入模块语法，分片仍然禁 import / export。
  3. 触发面只覆盖面板发起的导入（`/api-import/import` 的响应里带落点）。工具与 `/import` 命令的落点写在工具结果文本里（`detailsNote` 的「新建工作区 …」「未归组 …」），不改动它们。
  4. 面板里那条自绘黄条（跳过提示加「忽略警告」按钮）也并进同一条 Toast。官方 `Toast` 支持 `actions`（`[{ label, onClick }]`，宿主自己的「已归档，可撤销」toast 就是这么用的），于是「已跳过 N 条未变化 / 无法安全续写的对话」加「重新导入为新会话」就变成一个带按钮的顶部横幅，`holdMs` 取 15s，给点击留时间。面板里不再有底部浮层。
  
     **取舍**：黄条原本是常驻到用户处理的，Toast 是临时的——15s 之后淡出，动作就点不了了。面板结果栏仍会照旧报「跳过 N」，重选那一行再导入也会再次弹出同一条提示，所以这条信息不会丢。但「看到就得当场决定」的紧迫感，确实比常驻横幅弱。
- **代价**：客户端多了一条对宿主包名的硬编码字符串。版本漂移只能靠 `try/catch` 兜底，不是编译期发现。Toast 的 props（`text`、`actions`、`holdMs`、`onDone`、组件 key 重开）是 0.2.0-rc.1 的现状，上游若改名，我们会静默退到自绘横幅：有兜底、不报错，但风格会不一致（自绘横幅同样会画出动作按钮，所以「跳过 → force 重导」不会因为缺包而消失）。另外，带动作的提示是临时的（15s），不如原来的常驻黄条耐等。
- **重审条件**：宿主把「提示 / 通知」做成客户端服务（比如 `ctx.get('notices')`）时，改走服务；或者官方给第三方插件提供了 toast 出口，就删掉自绘兜底与包名硬编码。

---

## D18. Codex 侧「外部 agent 会话导入」的展平信封按段还原（2026-09 定）

- **背景**：Codex Desktop 的「导入外部 agent 会话」（`~/.codex/external_agent_session_imports.json`）会把外部 transcript 写成 Codex rollout，本机这 45 条全部来自 Claude Code。但来自外部的工具调用**没有** `function_call` 或 `custom_tool_call` 记录：调用与结果被展平成 assistant 正文里的文本信封，即 `[external_agent_tool_call: <Name>]…[/external_agent_tool_call]` 和 `[external_agent_tool_result[: error]]…[/external_agent_tool_result]`，信封还可以和正文混排在同一个 `output_text` 块里。

  本机普查的结果是：14477 块独占整块，776 块与正文混排，102 块含多个信封，信封只在 assistant 一侧出现。用户从 Codex 侧再导入这类 rollout 时，工具调用全变成散文：python 命令里的 `# 注释` 行被 markdown 渲染成巨型标题，130 多次 Edit 和普通发言分不开。这不是转换器漏了解析——源文件里确实没有结构化调用——而是在这里「忠实导入」等价于「丢掉结构」。
- **决定**：新增 `lib/convert/codex-external-agent.mjs`，它属于纯函数层；单独成文件是因为 `codex.mjs` 已经接近体量停止线（见 AGENTS.md）。它提供 `splitExternalAgentEnvelopes` 与 `externalAgentArguments`，由 `codex.mjs` 的 assistant 分支调用：在 assistant 正文里按**行扫描**切段（不能要求「整块就是信封」），再把信封还原成 IR 的 `tool-call` / `tool-result`。具体规则：
  - 载荷是 `input: <JSON>` 时，原样作为 arguments；是 `key: value` 行时（值可跨行），逐键组成对象。
  - 结果按「最早的未配对调用」FIFO 配对，因为信封不带 call_id；`: error` 标记还原成 `isError`。
  - **不虚构**：载荷的键名与内容照抄信封。Codex 自己把 `file_path` 写成 `file`，并且丢掉了 Edit / Write 的正文，这一层不补，也不猜。
  
  降级按 D4 处理：未闭合的信封、认不出的载荷、未知的结果标记，都留在正文里并计入 `malformed`；找不到调用的结果原样保留正文，计入 `orphanResults`。还原数量进公开结果的 `externalAgent: { calls, results, orphanResults, malformed }`，经 `attachConversionDetails` 与工具 schema 透出。存量的旧形状由 `verify_session` 新增的 `flattened-tool-envelope` 点名，手法同 D9 的 `system-head-missing`。**不设开关**：还原的是源侧本来就有的结构，不增加体积，误判面也几乎为零（信封头按整行锚定），所以默认始终开启。
- **代价**：
  - 转换器多了一层启发式解析，约 120 行代码加注释，也为「信封形态漂移」留了含糊地带：载荷认不出时，arguments 退化成一个 `{"input": <原文>}`（内容不丢，结构会歪）；未闭合的信封保留为正文（仍会被 markdown 渲染，但计数可见）。
  - 含信封的文本块会被切成多个文本块，正文段两侧的空白会被 trim；不含信封的块走快路径，字节不变。
  - 还原后 step 数会减少：只承载结果信封的消息不再凭空开一步，结果归并到调用的那一步。
- **重审条件**：Codex Desktop 换用别的展平格式，或改为写真正的 `function_call` 时，重新评估这个解析器。宿主收不到这类来源，或者上游补回了 Edit / Write 正文时，可以删掉相应的兜底与文档告诫。

---

## D19. opencode 双存储世代：按表分派读取，绝不两边都读（2026-10 定）

- **背景**：opencode 2.x（npm 包 `@opencode/cli`，命令仍然是 `opencode` 或 `opencode2`）**沿用 V1 的 `opencode.db`**，但把会话搬进了 `session_v2`，把转录搬进了 `session_message`。V1 的 `session`、`message`、`part` 三张表，只作为 V1→V2 迁移的来源存在。

  本机实测（opencode 2.0.21，对 V1 的库跑一次 `session list`）：迁移之后 `session` 4 行、`session_v2` 4 行、`message` 51 行、`session_message` 51 行，**旧行仍然留在库里**。所以只读 V1 三表，V2 原生的会话就会凭空消失；两边都读，同一个会话又会被导入两次。
- **决定**：`readOpencodeDb` 与 `readOpencodeDbSummaries` 先查 `sqlite_master` 探测世代。有 `session_v2` 就是 V2，读 `session_v2` 加 `session_message`，按 `seq` 升序；否则有 `session` 就是 V1。两者都没有就大声报错——不返回空列表，否则面板显示的是「没有会话」，而不是「这个库不认识」。

  两代产出**同一形状**的中间 JSON，转换器 `lib/convert/opencode.mjs` 不按世代分支。导入编排、DB 指纹短路径、`sessionIds` 过滤、registry 子表，全部复用同一套。压缩边界取「最近一条 `status='completed'` 的 compaction 行」：这正是 V2 自己的模型上下文口径，`session_message.seq` 大于等于该行的行才是模型可见内容。该行之前的轮照常进日志，但不进模型上下文。
- **代价**：
  - V2 的压缩正文分成 `summary` 和 `recent` 两个字段，V2 的模型两段都看（见 `session/compaction.ts` 的 `<summary>` 与 `<recent-context>`）。检查点正文因此是两段之和。这比 V1「摘要 + 保留窗口仍以轮呈现」要粗，保留窗口变成了纯文本，换来的是与源侧投影逐字一致。
  - 非 `completed` 的 compaction 行（running、failed）不是模型可见的边界，正文按普通内容保留，绝不静默丢弃。
  - V2 原生的工具名（`shell`、`subagent`、`patch`，以及用 `path` 取代 `filePath`）按「未知名原样保留」处理，不新造 DSH 侧的对照。迁移之后的历史行里仍然是 V1 的名字，所以两套都得能读。
- **重审条件**：opencode 再换存储世代（出现第三种表名或库）时，按同一套分派再加一项。V2 如果开始删除 V1 三表，这条决策不用改，分派已经覆盖了。反向导出（`export_chat({ format: 'opencode' })`）目前仍写 V1 `opencode import` 能读的 JSON；V2 的 `session import` 契约验证通过之前不改。

---

## D20. 从文件导入：三级探测 + generic 文档 + 上传通道（2026-10 定）

- **背景**：发现列表只覆盖内置来源，而「手上有一个文件」是最常见的入口形态：网页版导出（无官方格式）、自写脚本产物、长尾工具的原生存储——以及「我下载了一个导出文件，却无处可导」这类报告。此前的文件路径只有 `import_chat({ format: "local-jsonl" })`：只收 `.jsonl`、失败只给一句「未识别」（死胡同：既不说支持什么，也不给出路）、面板完全没有文件入口；远程部署（浏览器只有 `File` 对象、拿不到路径）更是无路可走。
- **决定**：
  1. **三级探测**（`lib/convert/local-jsonl.mjs`）：
     - 显式 `format` 优先，直接覆盖后面的判断。
     - 没有就找**内容标记**：`"interchange":"dsh-chat-import"` 走 generic，`"bundle"` 是便携包、转给 `restore_bundle`。只扫前 64KB。
     - 再没有，就按路径特征给候选排序，逐个试跑。
     
     结果带 `detectedFormat`、`detectedBy` 和 `failures`。`failures` 记的是**每个**候选格式的失败原因，全量记录，不只记第一条。
  2. **generic 文档成为一等导入格式**（`lib/convert/generic.mjs`，契约见 `INTERCHANGE.md` §5）：INTERCHANGE §1 的 turns 文档带上版本与内容标记即可导入。长尾来源和 skill 路线都落在这里——写一份 JSON 比内置一个转换器便宜，也不必让 LLM 手写 DSH 事件日志（seq、surfaceOp、protected head、V3/V4 形状，任何一项不合，整份日志都会被宿主拒载）。**不选 DSH 会话日志当撰写格式**，因为它是存储格式，不是给人写的格式。

     校验按 D4 大声计数：未知块、图片降级、畸形轮步、孤儿结果、非法 usage、0 轮的 skipReason。**工具结果的落点收敛到 `step.toolResults`**：写在 step `content` 里的 `tool-result` 块按 `toolCallId` 派生进结果列表（显式列表优先，与 `tool-call` 块的派生对称）；写在 `promptBlocks` 或结果内层的无处安放，丢弃并计入 `skippedBlocks`。原因是宿主 V4 的 codec 一见到解释性 content 里的 `tool-result` 包装就拒载整份日志（`"released tool-result wrapper"`），正文里不能残留结果块。
  3. **上传通道**（`lib/upload.mjs` 加三条路由）：init、chunk、complete 三步，按 (sha256, size) 幂等。刷新或断线后从已收字节续传，同一个文件不会重传；整文件指纹校验通过，才产出可导入的路径。配额是单文件 256MiB、暂存总量 2GiB；未完成的上传 24 小时回收；文件名做 sanitize，落点固定在 `$DSH_HOME/dsh-chat-import/uploads/<uuid>/`。暂存件导入后**保留**（D13 的重导语义以它为源键），没有被 registry 引用的件由维护入口清理。
  4. **一个编排，三个入口**：`lib/file-import.mjs` 同时服务面板的 `/api-import/file`、`/import auto <path>` 和 `local-jsonl` 工具面（`parseFormat` 增补了 `generic`）。预览复用 import-core 的 preview 家族，没有新增状态机；目录批量复用 `importDirectory`；vibe 形态的目录（`messages.jsonl` 加 `meta.json`）交给该来源自己的 `vibeDeriveArgs` 补 meta，不重写第二份映射。
  5. **交互按「不跟宿主抢手势」定形**（2026-10 收口）。面板**不注册拖放**：把会话文件拖到 DSH 窗口，会被宿主当成「给当前对话加附件」，抢过来只会让用户困惑。给文件有两个入口：系统文件框（点「选择…」打开隐藏的 `<input type=\"file\" multiple>`，走上通道）和**路径回车**。
  
     路径是目录时，**显式弹窗问「是否搜索子文件夹」**：先按当前层扫一遍（`recursive:false`），用户选了「包含子文件夹」才重扫。目录树可能很大，不做无谓的下钻。弹窗用**宿主内置预设样式的 Modal 与 Button**（`@deepseek-ai/dsh-client-ui-primitives`，与落点 Toast 走同一条 require 通道和同一条降级策略），不引入 Electron 原生对话框，也不自造一套视觉。
     
     原先的 `/api-import/browse`（目录选择器加自绘清单）随「浏览…」按钮一起删掉了。它唯一的消费者就是那个按钮。
- **代价**：
  - 探测要跑多个转换器，而失败路径比成功路径更贵，所以内容标记与路径特征都放在了试跑之前。
  - `convertLocalJsonl` 的结果多了三个键，工具、命令、面板三处都要透出。
  - 上传是唯一新增的「无盘来源」数据面，配额与暂存生命周期因此成了长期维护项。
  - generic 是第二份要跟着 IR 演进的契约，靠能力矩阵与同一个 `synthesizeSession` 收敛。
  - 路径输入意味着目录要先扫一层再问，多一次轻量扫描，换来的是不用「默默递归几十万个文件」。
  - 识别失败后的出路只剩「复制摘要，交给 Agent 按 Skill 转换」。用户手上要是有明确的解析器目标，得走工具面的 `import_chat` 的 `parseFormat`。
- **重审条件**：宿主自身的拖放或附件交互改为不吞文件（或者提供「拖到导入面板」的排他区域）时，重新评估拖放入口。宿主提供文件（不限于目录）选择服务时，「选择…」改走该服务。出现被广泛采用的会话交换标准时，评估把 generic 换成该标准，或映射到该标准。

---

## D21. 同口径逻辑只留一份，来源清单由一张表派生（2026-10 定）

- **背景**：来源是一个个加进来的，加法是复制最近的那个来源再改。一次全量评审数出了这些副本：
  - 标题归一 22 份，其中 19 份逐字相同，注释还写着「需同步 5 处」
  - 源未变短路径 6 份，只有 2 份查了 WAL
  - 批量计数 7 份，SQLite 只读打开 13 处，测试假宿主 15 份
  - 来源清单在发现层有 5 张平行的表，命令别名表与 `index.d.ts` 又各自手写一份
  
  这些副本已经漂移出真 bug：fork 目录导入退回了 opencode 标签，`/import kilocode` 报未知来源，默认扫描看不到 V4 日志，`storeImages:false` 对一半来源无效，`imagesDegraded` 被重复计数。旧注释里那句「core.mjs 属禁改面，各源按文件内联」就是这些副本的由头，早已不成立。
- **决定**：
  1. **每类共用口径各有一个家**。
     - 转换层：`lib/convert/util.mjs`（标题、时间、正文抽取、跳过结果）、`lib/convert/ir.mjs`（调用与结果整理）、`core.mjs` 的 `finishSession`。
     - 导出层：`lib/export/common.mjs`。
     - host 面：`lib/sources/sqlite.mjs`（只读打开、列自适应）、`lib/import-state.mjs`（已知记录加源未变短路径，含 WAL 与选择性补导守卫）、`lib/import-batch.mjs`（文件收集加批量计数）、`lib/atomic-write.mjs`。
     - 测试：`test/_support/`。
     
     来源如果确实有不同语义，就**参数化**共用件，不复制。设计同源的来源共用一个转换引擎、各自只留差异描述（pi 与 omp 共用 `lib/convert/pi-family.mjs`）。
  2. **清单派生，不手写**。发现层每个来源一个描述符（`lib/discovery/registry.mjs`），FORMATS、默认根、扫描器、单文件判格式都由它派生。`import_chat` 的格式表（`lib/toolkit.mjs` 的 `CHAT_FORMATS`）派生 `/import` 的别名，也是 `docs/IMPORT-GUIDE.md` 来源表的对账对象。导入 spec 里的 `multiSession` 标记派生面板与工具 `sessionIds` 的适用范围。`index.d.ts` 的格式联合类型由一致性测试对照运行时清单。
  3. **边界由测试与门禁守住，不靠自觉**。转换层与导出层的 import 边界有测试（越界即失败，见 D3）。`build-check` 会从发布入口沿模块图走一遍，可达模块不在 `files` 白名单就失败——新子目录忘登记时，`lib/tools/` 与 `lib/discovery/` 曾经差点没发出去。
- **代价**：模块变多，追一个调用要多跳一层。改一个共用件会同时影响所有来源——这正是目的，回归由各来源的测试兜住。
- **重审条件**：无。新增来源仍走 AGENTS.md 的「新增一个来源」，其中「第 3 处副本即停」的停止线照旧有效。

---

## D22. 客户端样式表自己带归属标记，不替宿主收走别人的（2026-10 定）

- **背景**：宿主的客户端模块系统（`@deepseek-ai/dsh-client-modules` 的 `claimStyles` 与 `removeOwnedStyles`）按 `data-plugin` 属性给 `<style>` 记账。**任何**前端模块物化时，都会把文档里所有 `style:not([data-plugin])` 认领到正在物化的那个包名下（扫描发生在工厂返回之后）；等这个包按新 revision 替换入口时，再按这个名字整批删除（删除发生在重新 import 之前）。官方前端包与 `dsh-claude-style` 都是建标签时就写 `data-plugin="<包名>"` 和唯一的 `data-plugin-css`。

  本插件的设置导航遮罩样式表在 `src/client/footer.js`，是 `src/` 里唯一自己建的 `<style>`。它此前没有标记，于是两个方向都会出事：
  - **自己那张**会被下一个物化的包收走。此后它记在别人账上，别人的重载就会把它删掉。
  - **别人的无标记样式表**会在本插件物化时被认领到 `dsh-chat-import` 名下，本插件重建触发重载时连带被删。2026-10-05 实测就删过 dsh-meme 的两张样式表，表情包界面整份失去样式，只能刷新恢复。
- **决定**：
  1. `ensureSettingsNavStyle()` 建标签时写 `data-plugin="dsh-chat-import"`（它等于 `package.json` 的 name，也等于 `lib/client.js` 的模块 entry 名，三者必须同一个值），以及自己的 `data-plugin-css="dsh-chat-import/settings-nav.css"`。既有元素——旧版本留下的无标记元素、上一次 apply 建的那张——按自己的 `data-plugin-css` 或 id 认回来并补上标记，不新建第二张。元素本身不移除：本插件重载时由宿主按包名删掉，紧随其后的 `apply()`（`entry.js` 的 `ctx.effect`）会重建它，不留空窗。
  2. `parkForeignSheets()` 把「没打标签、又不是自己那张」的 `<style>` 改写成 `dsh-chat-import/foreign-sheet`。这个值不等于任何包名，于是本插件物化时不会认领它们，本插件重载时也不会连带删掉它们。两个时机缺一不可：模块作用域那一次要赶在本插件自己的 `claimStyles` 之前（宿主在工厂返回之后才扫描，这是唯一的窗口）；另外还要一个常驻的 `<head>` 观察者，管本插件之后才出现的那些。
  3. 契约由 `test/panel-style-ownership.test.mjs` 守住。测试把宿主那两条记账照抄成替身，断言四件事：标记等于包名、也等于 entry 名；本插件那张不被 `style:not([data-plugin])` 命中；宿主按包名删除后重建的那张仍带标记；外来无标记样式表不被认领，本插件重载后它仍在文档里。
- **代价**：被挪走的样式表此后不再被任何包的记账收走。一个指望宿主替它收走自己那张的插件，会因此留下一份旧副本（本插件只动无标记的那些，宿主官方包自建时就有标记，不受影响）。局限是：在本插件第一次查看文档之前就已经被别人收走的那几张，这条修法够不到。`src/client/` 里如果再出现第二个自建的 `<style>`，必须照第 1 条写标记。
- **重审条件**：宿主给客户端插件提供样式注入出口（比如 `ctx.styles`）时，删掉自建标签和挪走逻辑。宿主改为按元素引用（而不是属性）记账时，本条整体作废。

---

## D23. 列表标题提示：大 DSH 日志的标题取自宿主持久投影缓存（2026-10 定）

- **背景**：发现层为了不整读几十 MB 的 `.zstd` 日志，对压缩后超过 `DSH_ZSTD_SCAN_MAX_BYTES`（256KB）的 DSH 会话只用布局目录名兜底构造条目。结果是标题恒为空，`project` 落到布局名（`--D-Build-x--`），同一个工作区在面板里被劈成「x」和「--D-Build-x--」两组，按标题也搜不到。

  本机实测（2026-10-06）：`dsh4` 来源 265 条里有 214 条没有标题。其中 127 条正是这批大日志，另外 81 条是宿主建了却没聊过的空会话，6 条是子代理会话。而宿主 GUI 的侧栏对这些会话照常显示标题——宿主早就把标题折叠成了 `session_projcache` 域的检查点行，自己的会话列表读的就是它（`cachedSnapshot(header) ?? cachedPredecessorTitle(header)`）。
- **决定**：
  1. **多消费一个可选的 host 服务**：`ctx.sessionProjectionCache`。它被宿主运行期的 API catalog 收录、能力图里记为核心服务，与我们已经在用的 `ctx.tools`、`ctx.workspaceRegistry` 同层；官方的 `session-reference` 也是用 `ctx.get` 机会式读同一个服务。我们同样只用 `ctx.get(name)`、不进 `inject`：服务缺席或读失败，就退化为「没有提示」，发现层照旧工作，失败只留一行警告。AGENTS.md 的服务清单同步更新。
  2. **提示只补空，来源标题永远优先**。`lib/discovery/discover.mjs` 的 `withHints` 只对「来源自己没取到标题」的条目叠加 `title`、`cwd → project` 和 `createdAt`，而且叠加在 query 过滤之前，所以面板按标题搜索能命中。流式与全量两条产出路径用同一口径。提供器在 host 面（`lib/session-hints.mjs`），纯函数层不认识提示的来源。身份凭证是 `sessionPersistence.list()` 的 header，读法与宿主自己的列表逐字同序（`cachedSnapshot(header, ['title']) ?? cachedPredecessorTitle(header)`）；header 不在列表里就不查缓存。
  3. **提示不写进扫描书签**。它在书签命中之后才叠加，所以缓存行更新后即时可见，不需要 bump `SCAN_CACHE_VERSION`。三处 host 面调用点（面板路由、`scan_discover`、会话启动提示）与 `persistedIds` 共用同一趟 `list()`，零额外 I/O。
- **代价**：
  - 依赖一个可选挂载的服务。部署里没挂 `session-projection-cache` 时标题仍然为空，这是接受的降级，不是错误。
  - 缓存行可能落后于日志（写回是节流的）。这由「只补不覆盖」承担：来源已经读到的标题（包括改名）一律优先。
  - 提示补出的 `cwd` 会让 git 分支探针多跑几个目录，同一次扫描内做了记忆化。
  - 本机实测：`dsh4` 的无标题条目从 214 条降到 87 条；`dsh-claude-style` 由 63 和 43 两组并回 106 一组。
- **重审条件**：宿主把标题并入 `sessionPersistence.list()` 的 header（或提供列表级的标题面）时，这一层整体删除。宿主移除或改名 `sessionProjectionCache` 时，退回「大 `.zstd` 没有标题」；届时再评估按头部窗口流式解压——只解前 256KB 压缩字节。本机实测，127 个日志全部能取到会话头，125 个能取到标题，代价约 70ms 一个文件。

---

## D24. 对外暴露 `chatImport` Host Service，批量入口只留一份编排（2026-10 定）

- **背景**：第三方插件想复用「发现 → 导入 → 批量导入 → 交接摘要」这条链，只能自己拼——工具面要求走模型轮次，命令面只给文本返回值，面板则要发 HTTP。为此新增了 `lib/chat-import-service.mjs`，把已有的编排包成服务注册进 host（`ctx.provide('chatImport', …)`），方法有 `scanDiscover`、`importPath`、`importAll`、`resumeSummary`：单会话结果保留 `sessionId`，批量结果带逐条 `results` 和扫描的 `warnings`。

  服务的第一版把批量循环写成了**第二份**，也就是 `/import-all` 命令里那份的副本。两份立刻出现可观测的漂移：命令面不支持 `force`，不返回逐条结果，还把扫描的 `warnings` 整个丢掉了（某个来源扫描抛错时，读出来就是「扫描 0 个会话」）。
- **决定**：
  1. **服务是发布面，不是新实现**。四个方法一律转投已有的编排：`buildImportExecutor` 与 `importDiscoveryItem`（`lib/toolkit.mjs`）、`runScanDiscover`（`lib/discovery-host.mjs`）、`summarizeClaudeJsonl` 与 `summarizeCodexJsonl`（`lib/handoff.mjs`）。服务自己不含解析、落盘或计数口径。
  2. **批量编排导出成具名函数 `runChatImportAll(ctx, registryDir, input, signal)`**（在同一个文件里）。`/import-all` 命令与服务方法都调它，命令只负责解析参数和渲染 `formatAllImport` 的文案。**命令不读 `ctx.get('chatImport')`**：服务注册依赖 host 提供 `ctx.provide`，host 没有时服务就不注册；而命令面必须在任何 host 上都能用。共用实现放在模块里，两件事同时满足，也不会留下「服务缺席时另走一份实现」的分支。
  3. **对外方法的签名就是契约**。`lib/index.d.ts` 声明 `ChatImportService`，以及 `ImportAllParams`、`ImportAllResult`、`ResumeSummaryParams`、`ResumeSummaryResult`。`resumeSummary` 只收 `claude` 与 `codex`——其他来源没有交接摘要语义，而且它**不创建、不打开**新会话。`ctx.provide` 缺失（老 host）时不注册、不抛错，插件照常激活。
  4. **命令面不得吞掉服务面已有的信息**。`formatAllImport` 会把扫描失败逐个来源点名，逐条失败列前 5 条并折出省略行。一条也没扫到时，返回 `error` 而不是 `success` 文案。
- **代价**：
  - `lib/command.mjs` 多了一条对 `lib/chat-import-service.mjs` 的导入。两者都是 host 面模块，不违反 D3 的纯层边界。
  - 服务是长期对外的 ABI。`ImportAllResult` 的字段名一改就会影响第三方调用方，所以只能加字段，不能改名。
  - `/import-all` 的 `--force` 多了一条「必须带 path」的约束，因为不限定范围的全量重导，会给每个已导入会话都铸一份副本。
- **重审条件**：宿主提供官方的插件间服务注册或发现机制（取代直接 `ctx.provide`）时，注册那一步改走该机制。服务方法的返回结构如果要收进宿主的类型体系，以那份声明为准，并删掉本仓库的手写类型。

---

## D25. 面板行工具的动作面：只认当前扫描的行，删源限定根扫描且只进回收站（2026-10 定）

- **背景**：面板的会话行加了四个动作——预览、正文搜索、隐藏、删除源文件，外加把行拖到侧栏工作区完成导入。前三个是读或可撤销操作，删源是唯一**不可逆**的动作（文件离开原位）。第一版只有一个门禁：「这条路径出现在某个扫描结果里」；而 `/api-import/sessions` 允许请求体带 `path` 指定任意扫描根，于是「任意目录 → 扫描 → 删除」连成一条链，`..` 都不需要（`fs.resolve` 已把路径规范化）。同类问题还有一文件多会话的来源（`conversations.json`、sqlite 库）：按 `sessionId` 请求时路径相同就命中，删掉的其实是整份文件。另一处数据损失是「隐藏」覆盖写入忽略表：归档 / 撤回墓碑被换成可撤销的 `hidden`，撤销之后墓碑整个消失。
- **决定**：
  1. **行工具只接受当前扫描里的行**。hide / unhide / delete-source 都经 `scannedRows()` 回查扫描缓冲，请求体里的路径不是凭据；`sessionId` 严格相等，多会话源缺 `sessionId` 直接不命中并计入 `unknown`。
  2. **删源只对「根驱动」扫描成立**。扫描状态记下该扫描是否由请求体的 `path` 覆盖创建：面板客户端从不传 `path`（只发 source / query / epoch / after），所以真实 UI 里的行都可删；用显式 `path` 扫出来的行允许预览、搜索、隐藏与导入，删除回 `refused`。这条把链路断在破坏性动作上，又不削减扫描本身的能力。
  3. **删源按「这个文件承载几条会话」判定，不只看格式标记**。同一 `sourcePath` 在本次扫描里产出多于一条会话就拒绝——`multiSession` 是来源描述，不是安全边界。
  4. **删源只进回收站，DSH 侧副本保留**。Windows 走 `Microsoft.VisualBasic.FileIO.FileSystem` 的 `SendToRecycleBin`（路径经环境变量传给 PowerShell，不进脚本文本）；其余平台 `rename` 到 `<registryDir>/trash/<时间戳>/`。失败如实回 `status:'failed'`，不静默。
  5. **隐藏是忽略表的第四种 reason，可撤销，且不覆盖既有墓碑**。`archived` / `retracted` / `workspace-deleted` 表示「不再重导」，`hidden` 只是面板收起。写入时同键已有其它 reason 就跳过（回 `skipped` 计数），Undo 只删 `reason:'hidden'` 的条目；多会话源只认 `#sessions:<id>` 子键，不回落整源键，否则隐藏一条会带走同库其它会话。
  6. **拖放只认工作区 id，路径永不从请求体取**。侧栏工作区行用 `data-row-key="workspace:<id>"` 定位（class 名被宿主构建哈希过，不可依赖），`id` 交给 `workspaceRegistry` 解析；拖放数据里的 `sourcePath` 只用于在当前列表里回查。落点用 `workspaceMode: 'dedicated'` + `workspaceDir` 钉在该工作区，副本用 `restamp: 'end'`（最后一个事件落在现在）排到该工作区最上面；这三个参数进参数指纹，换工作区重拖不会被「源未变」静默吞掉。
- **代价**：
  - 显式 `path` 扫描出来的行没有删除入口。要清这类文件，用户仍在文件管理器里删；面板不提供更宽的口子。
  - 隐藏与归档共用一张忽略表，语义只靠 `reason` 区分；`/ignores` 的输出要多认一种 reason，文档必须写清「可撤销」与「不可逆」的差别。
  - 删源依赖平台能力：Windows 需要 `powershell.exe`，其余平台只是把文件挪进插件自己的 trash 目录（不删除，所以仍占空间）。
- **重审条件**：宿主提供带鉴权的面板接口，或提供官方的「移入回收站」服务时，第 2 条可放宽到「用户显式选中的根」，第 4 条改走宿主服务。若将来 UI 真要支持自定义根扫描并允许删源，扫描请求必须携带独立的能力凭据，而不是复用 `path`。
