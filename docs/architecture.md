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

- **背景**：导入的会话要成为「可继续的 DSH 会话」，就必须遵守宿主 sessionPersistence 的存储契约；改写历史会破坏增量同步与外部工具的续写假设。
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
- **决定**：畸形行、疑似 secrets、降级项全部计数/上报；目标会话已存在即跳过，源增长时增量续写，`force: true` 才另建副本。
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
  - `tools.mjs` 按**工具分组**拆（import / export / sync / purge 各自的工具定义与 handler 同文件）；
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
- **代价**：导入会话多一条事件（`writeback.lastWrittenSeq` +1）；首轮没有 step 时补一个只装 head 的空 step；`SESSION_EVENT_TYPES` / surface 集合加入 `system/message`、`developer/message`，`verify_session` 新增 `system-head-missing` 点名存量旧形状（head 必须是 surface 首事件，旧日志只能 force 重导，无法原地补写）。
- **重审条件**：宿主迁移器改为「缺 head 时自行插入」（v2→v3 就是这种语义）——那时本插桩可退化为可选。


---

## D10. 设置页双版兼容：0.1.7 按条目 id / 0.1.5 自持命名空间（2026-09 定）

- **背景**：DSH 0.1.7 删除了 `settings.register()`——命名空间改为 profile 条目 id、schema 改为插件导出的 `Config`；0.1.5 及更早则是插件按名字注册。插件以软链 / 本地 link 装进 profile 时，`@deepseek-ai/schemastery` 也未必从其自身 require 锚点解析得到；0.1.7 的 loader 还把条目 id 报成 `<kind>:<id>`，而设置服务按裸 id 建索引（带前缀写会 409 `settings-conflict`）。
- **决定**：`lib/import-prefs.mjs` 按宿主能力探测绑定，一套代码跑两版：`describe()` 名单含本插件**裸条目 id** → `forms`（0.1.7，按条目 id 走 describe / update，并 `settings.configure({ auto: false })` 声明自带面板）；只有 `register` / `get` → `legacy`（0.1.5，自持命名空间 `chat-import`）；两者皆无 → `none`（读默认、写不持久化）。`entryIdOf()` 剥离 `<kind>:` 前缀并回退 patch 声明的 `import-claude`；schemastery 解析锚点指向**运行中的 harness bin**，并对 `.volatile()` 做能力探测；插件入口导出 `Config`。
- **决定（客户端席位）**：设置界面按同一世代分流——`ctx.get('configForms')` 在场（0.1.7+）→ 注册 `plugins.bundle.config`（键 = 包名 `dsh-chat-import`，渲染在「设置 → 插件」的插件页）并用 `configForms.get(条目 id)` 逐字段读写；缺席 → 保留 `settings.section` 整页与 `/api-import/prefs` fenced 路由。两处互斥注册（`configForms` 存在即否决整页），避免同一设置在两处各长一份。
- **代价**：两套设置模型都要测试覆盖；`.volatile()` 探测与软链锚点是宿主实现细节，宿主换版需重审（完整踩坑与自检见 [SETTINGS-MIGRATION.zh-CN.md](SETTINGS-MIGRATION.zh-CN.md)）。
- **重审条件**：宿主 0.1.7+ 成为唯一支持面时，删掉 legacy 路径与探测，只留 `Config` + 条目 id。
