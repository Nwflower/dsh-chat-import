# dsh-chat-import「AI 无谓添加与删除残留」痕迹审计

状态：completed（盘点 + 分级评估，未落地修改——本文件为评估产物；含 description 泄漏审计
§1.9 与代码注释专项审计 §1.10 两轮补查）
适用范围：`D:\Build\dsh-chat-import` 当前 main（`2c77b26` 及之前）
更新日期：2026-08-26
参照文档：`D:\Build\gov_agent\docs\govagent-unnecessary-code-audit.md`（同一审计方法，
现象定义与 GitHub 工具检索结论直接复用，见 §2）

---

## 0. 背景

用户要求对本仓库执行与 GovAgent 仓库同款的「AI 无谓添加与删除残留」审计。核心问题仍是：

> 让 AI 做番茄炒蛋，它擅自加东坡肉；被指出后移除，但移除留下痕迹——「番茄炒蛋（无东坡肉）」
> 标题、注释里解释「为什么本道菜不需要东坡肉」。

与 GovAgent 的差异要先说清：**本仓库几乎不存在 GovAgent 那种「删除 = 立规 + 解释性安葬」的
痕迹**。它的问题方向相反——**「新增后文档没跟上」**（drift）：格式数从 13 → 17、工具从
18 个 import_* 收敛为 1 个 import_chat 分发器、新增 5 个非导入工具后，散落各处的数字与类型面
没有同步。这是同一种「AI 随手加戏」的另一半症状：改动落地了，但它的「元数据痕迹」
（注释里的计数、d.ts 的类型面、AGENTS.md 的布局表、ROADMAP 的能力表）停留在旧状态。

---

## 1. 仓库内痕迹盘点（证据清单）

### 1.1 文档漂移：代码里长着「旧版本的数字」（最普遍）

格式数在迭代中从 13 涨到 17（+mimocode/qoder/workbuddy/dsh），但多处注释仍写旧数字：

| 位置 | 现值 | 实际 | 性质 |
| --- | --- | --- | --- |
| `lib/discovery.mjs:1` | 「13 种格式统一 discover」 | `FORMATS` 数组 17 项 | 头注释过时 |
| `lib/convert/core.mjs:4-6` | 「现共 13 种：claude/…/kimi」 | convert 源实际 18+（缺 qoder/workbuddy/mimocode/dsh/local-jsonl） | 枚举清单过时 |
| `lib/panel.mjs:26` | 「客户端来源 id（claude-code 等 15 个）」 | `SOURCE_FORMAT` 实际 17 键 | 头注释过时 |
| `ROADMAP.md:16` | 「14 源 + 本地 JSONL（15 工具）」 | 17 源 + local-jsonl = 18 格式、15 工具 | 能力表过时 |

结论：这是「新增后未同步」的痕迹，不是「删除后未清除」。但同样误导维护者——读到
「13 种」会误判 m/mimocode 等 4 个源不在发现范围内。

### 1.2 类型面漂移：index.d.ts 与注册 schema 脱节

`index.d.ts` 头部声明「15 个工具」（L4、L32），但 `ToolSurface` 接口（L37-50）只声明
**12 个**，缺三个已注册工具：

- `doctor`（`lib/doctor.mjs`，REQ 健康检查）
- `import_mcp`（`lib/mcp.mjs`，Claude/Codex MCP 镜像）
- `import_settings`（`lib/settings.mjs`，Claude/Codex 配置建议）

另有：`ScanFormat` 类型（L500-503）枚举 16 项，**缺 `'mimocode'`**（PR #15 加源时只改了
`ChatFormat` 与 `discovery.FORMATS`，漏了 `ScanFormat`）。TS 调用方按 `scan_discover(format:
'mimocode')` 会报类型错，而运行时接受。

结论：类型面是「对外契约」的一部分（README 之外的第二张脸），它与 `lib/tools.mjs`
注册的 schema 漂移是真实缺陷——不是死代码，但属于「元数据没跟着代码走」。

### 1.3 AGENTS.md 布局表过时：缺 14 个模块

仓库根 `AGENTS.md` 的「仓库布局」列了约 21 个 `lib/` 顶层模块，但实际 `lib/` 顶层已有
33 个 `.mjs` + `client.js`（`convert/`、`export/` 子目录另有 25 个）。缺列的有（按重要度）：

- **`tools.mjs`**（15 个工具注册的主文件，全仓库最大的模块，布局表里根本没提）
- `restore.mjs` / `verify.mjs`（REQ-56/62、REQ-23 工具执行体）
- `agents.mjs` / `mcp.mjs` / `settings.mjs` / `doctor.mjs`（REQ-59/61、import_mcp、import_settings、doctor）
- `cwd-map.mjs` / `handoff.mjs` / `resume-command.mjs`（REQ-39 full、REQ-30 交接续聊）
- `markdown.mjs` / `import-prefs.mjs` / `mimocode.mjs` / `dsh.mjs`
- `export/` 只列了 `claude.mjs / codex.mjs / grokbuild.mjs`，缺 **`kimi.mjs` / `bundle.mjs`**

另有一处 `files` 白名单描述过时：AGENTS.md 写「`docs/INTERCHANGE.md`」，实际 `package.json`
的 `files` 是 **`docs/*.md`**（现含 `USAGE.md`、`USAGE.zh-CN.md`）且多了一项 **`bin`**
（`bin/dsh-chat-import.mjs` CLI 已进 npm 包）。

结论：布局表是「给下一个 Agent 的地图」，地图缺了主路（tools.mjs）和四分之一的路口，
新 Agent 按它导航会迷路。这与 GovAgent 的「AGENTS.md 特例措辞」问题同构——都是规则资产
与现状脱节，只是本仓库是「漏写」而非「写错」。

### 1.4「路线 A」删除残留：child_process 移除的注释墓碑

`65721cd security: 移除 child_process（路线A）` 把系统 zstd 二进制调用换成 fzstd 纯 JS。
删除后留下的痕迹：

- `lib/dsh.mjs:3`「fzstd（MIT、零依赖纯 JS）解压——不依赖系统 zstd 二进制，也避免 child_process」
- `lib/discovery.mjs:1440-1441`「安全扫描将 child_process 判为 critical，路线 A 已移除所有 execFileSync」
- `test/dsh.test.mjs:88`、`test/discovery.test.mjs:710` 同款说明

问题：**「路线 A」这个标签是悬空的**——没有任何文档记录「路线 B」是什么（是保留 child_process？
还是其它解压方案？）。注释解释了「为什么不用 X」，却没有记录「当时还有哪些备选、为什么选 A」，
属于半截子的「无东坡肉」注释。CHANGELOG 记录了决策，但代码注释里的「路线 A」对后来者
是个无法解析的引喻。

### 1.5 死 re-export 别名：tailCodexEvents / tailGrokbuildEvents

`lib/export/claude.mjs` 的 `tailClaudeEvents` 有真实消费者（sync-loop / backfill），但同形的
两个别名**零消费者**：

- `lib/export/codex.mjs:179` `export { tailClaudeEvents as tailCodexEvents }`
- `lib/export/grokbuild.mjs:148` `export { tailClaudeEvents as tailGrokbuildEvents }`
- `export.mjs:31` 把 `tailCodexEvents` 公开 re-export（`tailGrokbuildEvents` 连 shim 都没进）

全仓库 grep：无测试、无调用方。它们是为「矩阵化互转对称性」而生的占位别名——Codex/Grok
写回走的是 `serializeCodexJsonlTail` / `serializeGrokbuildJsonlTail`，从未用到这两个 alias。
属「为对称而对称」的无谓导出。

### 1.6 同名双函数 slugifyClaudeCwd（有意但危险）

两个同名不同语义的函数：

- `lib/cwd-map.mjs:27` `slugifyClaudeCwd`：匹配用编码，`[^\p{L}\p{N}]→'-'`，**保留 CJK**
- `lib/export/claude.mjs:26` `slugifyClaudeCwd`：输出目录名用，严格 ASCII（CJK → '-'）

`cwd-map.mjs:24-26` 已注释说明二者不同。这不是死代码，但同名的两个纯函数散在两个模块里，
未来任一改动都容易改错对象；且 `export.mjs` 公开导出的是后者，`cwd-map` 版本只在内部用，
命名空间上无隔离。属「可读性债」，非「无谓添加」。

### 1.7 IMPORT_OUTPUT_SCHEMA 重复：single/batch 两份同构 schema

`lib/toolkit.mjs:364-651` 的 `IMPORT_OUTPUT_SCHEMA` 把「单文件模式」与「目录批量模式」写成
两个几乎相同的 `oneOf` 分支——`trimmed` / `forceImported` / `staleGhost` / `validation` /
`skippedLines` / `secrets` 等子 schema 各复制一遍（合计约 280 行）。注释自证：

> 宿主 ToolSchema 只投影 name/description/parameters——output 不进模型请求，
> 但保留结构契约（与旧 18 个工具一致，validateJsonSchemaValue 测试依赖）。

即：这段 schema **既不进模型上下文，也不进任何运行时分支**，只为一个测试存在，还复制了两份。
它是全仓库最接近「无谓添加」的一处——可以把公共字段抽成引用消除重复，或只保留一个
「宽松 object」占位。

### 1.8 vendored 参考树 dev/kimi-cli-ref/

`dev/`（gitignore）下有一整棵 `kimi-cli-ref/`——Kimi CLI 上游仓库的参考副本（100+ 文件，
含 .agents/skills、docs 双语、AGENTS.md）。性质同 GovAgent 的 `gov_agent_old` 归档区：不进
npm 包、不参与构建，是 `import_kimi` / `export_kimi` 的格式侦察材料。属「该有的参考资产」，
唯一提醒是它体量大且无 README 说明「这是哪个 commit 的 Kimi CLI、何时拉取、为何保留」——
归档区缺 provenance，重来一次无法复现。

### 1.9 内部需求编号泄漏进用户可见工具描述（最值得警惕）

`REQ-NN` 是本仓库 ROADMAP.md 的内部需求编号，本质是**开发侧注释**。但它们被直接写进了
`lib/tools.mjs` 与 `lib/resume-command.mjs` 的 `description:` 字符串——这是**用户可见 +
模型可见**的文本：宿主 ToolSchema 会把 description 投影进每轮模型请求，GUI 也会把它展示
给最终用户。「（REQ-56）」这类编号对最终用户是零信息量的噪声，纯粹是开发痕迹混进上线面。

完整清单（以下全部是 `description:` 字符串，不是代码注释）：

| 工具 / 命令 | 位置 | 泄漏文本 |
| --- | --- | --- |
| export_bundle | `tools.mjs:741/743` | 「通用 interchange bundle（REQ-56）」「landingHint，REQ-62」 |
| restore_bundle | `tools.mjs:805/808` | 「（REQ-56/62）」「跨机器（REQ-62）」「REQ-39-lite」 |
| export_codex / export_kimi | `tools.mjs:949` | 「降级逐条报告（REQ-21）」 |
| verify_session | `tools.mjs:999` | 「结构（REQ-23）」 |
| sync_to_claude | `tools.mjs:1070` | 「反向同步（REQ-36）」 |
| list_imported_sessions | `tools.mjs:1191` | 「（REQ-33）」 |
| retract_import | `tools.mjs:1234/1239` | 「（只读引导，REQ-33）」「issue #22」 |
| scan_discover | `tools.mjs:1281` | 「15 种外部聊天记录格式」（实为 17），枚举漏 mimocode / workbuddy |
| /resume-claude / /resume-codex | `resume-command.mjs:22` | 「（REQ-30，对标 dsh-resume-plugin）」 |
| /doctor | `command.mjs:271` | 「对标 dsh-movein doctor」 |

三类泄漏：

1. **REQ-NN 编号**（9 处）：内部需求 id，用户无法解析，纯开发痕迹。
2. **GitHub issue 编号**（1 处）：`retract_import` 描述里的「issue #22」是开发上下文。
3. **竞品对标**（3 处）：「对标 dsh-resume-plugin」「对标 dsh-movein doctor」把竞品调研结论写进命令描述。

附带一处**描述语言不统一**：`doctor`（`tools.mjs:478` 英文）与 `import_mcp`（`tools.mjs:537` 英文）
的工具 description 是英文，其余 13 个工具是中文——工具面双语混用，非 bug 但观感不齐。

外加一处**过时计数也落在用户可见描述里**：`scan_discover` 写「15 种外部聊天记录格式」且枚举
只列 15 个名字（漏 mimocode、workbuddy），但 `format` 参数的 enum（`FORMATS`，17 项）实际接受
它们——用户读到「支持 15 种」，实际能传 17 种。这是 §1.1 文档漂移的**用户可见**版本，危害更大。

结论：这是本仓库「开发性 / 注释性语句混入上线项目」最集中、最该先修的一处——15 个工具里
**8 个**的描述携带 REQ-NN / issue 编号，另 1 个（scan_discover）携带过时计数，2 个 `/resume`
命令带竞品对标；模型每轮都要为这些零信息量 token 买单，用户看到的是开发笔记而非产品说明。

### 1.10 代码注释专项审计：REQ 编号体系漂移 +「禁改面」注释掩盖重复

代码注释里写 REQ 编号**本身是对的**（这是 REQ 编号的正确落点，与 §1.9 的 description 泄漏相反）。
但审计发现两个注释侧的问题：注释引用的**编号体系已经漂移**，以及一类**用解释性注释掩盖代码重复**
的「无东坡肉」变体。

**A. REQ 编号体系漂移：公开 ROADMAP 冻结在 63，代码注释已引用到 74**

- `ROADMAP.md`（随 npm 包发布）结尾声明「全部 63 项 ✅（v0.5.0）无未完成需求」。
- 但 `lib/*.mjs` 注释引用到 **REQ-64 ～ REQ-74 共 11 项**：`agents.mjs`→REQ-64、`command.mjs`→
  REQ-65/66/68/71/74、`doctor.mjs`→REQ-66、`markdown.mjs`→REQ-67、`mcp.mjs`→REQ-68、
  `settings.mjs`→REQ-71、`import-core.mjs`→REQ-70/72、`convert/opencode.mjs`→REQ-74。
- 这 11 项的权威定义在 `dev/REQUIREMENTS.md`（**gitignored，不入库、不进 npm 包**）——于是
  **发布出去的 `lib/*.mjs` 注释满是「REQ-66」「REQ-74」编号，但包内的 ROADMAP.md 只到 63 查不到
  定义**；CHANGELOG.md 有零散条目却无编号索引。
- ROADMAP 的「无未完成需求」还失实：`dev/REQUIREMENTS.md` 里 REQ-67/69/72/73/74 仍是 ◐/☐。

**B. REQ-74 编号过载：一个编号塞 5 个无关功能**

- `dev/REQUIREMENTS.md` 把 REQ-74 定义为「全局 CLAUDE.md / memoryScope / opencode 工具名映射 /
  面板进度与取消 / 缓存重置」——**5 个互不相关的功能共用一个编号**。
- 后果：CHANGELOG 里「REQ-74 part」出现 3 次指向 3 个不同功能；代码注释里 REQ-74 同时出现在
  `command.mjs`（缓存重置）与 `convert/opencode.mjs`（工具名映射）两个无关场景。REQ-70 类似
  （workspaceMode 与 `/attach-workspaces dedicated` 分标 "REQ-70 part" / "REQ-70"）。
- 说明 REQ 体系在 63 之后失去了「一个编号 = 一个可验收需求」的纪律，被当杂货篮复用。

**C.「core.mjs 属禁改面」注释掩盖 `normalizeTitle` 的 9 处内联重复**

- REQ-27 标题归一规则（去空白 + 折叠 + 80 字符截断）被**内联复制在约 9 个 convert 源**
  （claude/codex/cursor/gemini/reasonix/grokbuild/openclaw/qoder/kimi），每个文件头都写
  「core.mjs 属禁改面，各源按文件内联同款（改规则需同步 N 处）」。
- 但这注释**与现状矛盾**：core.mjs 正是共享纯函数模块（`SESSION_FORMAT_VERSION` / `mapContentBlock`
  / `mintSessionId` 等 7 个共享函数都从它 import），`normalizeTitle` 本该收进 core.mjs；
  「禁改面」是个过时说法——它解释「为什么这里有重复」，正确答案却是把重复收敛掉，而不是写注释说明它。
- 更糟的是「同步 N 处」的计数**各自不一致**：claude 写「现共 9 处内联」，codex/cursor/gemini/
  grokbuild/openclaw/reasonix 写「同步 5 处」，qoder 写「逐源同步」，kimi 写「同步多处」——
  同一事实写成了 4 个不同数字，且 claude 的 9 源清单还漏了 qoder、多列了 hermes。
- `lib/discovery.mjs:309` 还有一份**独立的 `normalizeTitle` 导出**（第 10 份拷贝），与 convert 内联版
  同规则不同位置——DRY 违反被分散的注释层层掩盖。

**D. 竞品对标注释：位置正确，不算问题**

`lib/*.mjs` 里大量「对标 dsh-import-agents / dsh-movein / dsh-resume-plugin / cc-switch」注释
（如 `agents.mjs:20`「对标竞品 dsh-import-agents lib/agents.mjs，源码逐行核实」、`discovery.mjs:75`
「cc-switch session_roots 同款」）——这些**在注释里是对的位置**，记录了「为什么这么做」的调研出处，
与 §1.9 里「对标」写进 description 的泄漏正相反，保留。

### 1.11 影响评估（与 GovAgent 对照）

| 视角 | GovAgent 表现 | 本仓库表现 |
| --- | --- | --- |
| 治理化 | 删除→永久禁令（AGENTS.md / project-organization） | 无永久禁令；反向：AGENTS.md 布局表漏写 14 模块 |
| 代码化 | 死代码 + i18n 键 + CSS 随 bundle 交付 | 死 alias（tailCodex/Grok）+ 重复 schema + 过时计数注释 |
| 工具化 | prompt_leak 审计 + purgePromptLeak | 无（尚未被「无东坡肉」反噬到要造工具） |
| **用户可见面** | 提示词原文泄漏进交付正文（e999140） | **REQ-NN / issue 编号 / 竞品对标写进工具 description（§1.9）** |

公允声明：本仓库的「移除」（child_process 删除、18 工具收敛为 import_chat）都是**真实合理的
工程决策**，且删除得相对干净（child_process 无残留调用、18 个旧工具无残留注册）。问题集中在
**「新增/收敛」这半边的元数据同步**，而非「移除」这半边的墓碑化。但 §1.9 是唯一的例外——
它与 GovAgent 的「无东坡肉注释被端上桌」完全同构：**开发侧注解（REQ 编号）直接进入了
产品侧文案（工具 description）**，只是本仓库是「编号泄漏」而非「规则原文泄漏」。

---

## 2. GitHub 同类现象与工具（结论复用）

现象命名（AI slop / over-engineering / scope creep / unnecessary abstraction）与工具链
（AIDiffGuard、aislop、comment-checker、surgical-dev、OverReach、pytector、prompt-shield）在
GovAgent 审计 §2 已完整检索并附链接，**与本仓库无关、可直接复用**，此处不重复罗列。

对本仓库有增量价值的两点：

1. **本仓库已有一个现成的「drift 检测」抓手**：`npm run check:linux`（跨平台路径纪律）与
   `npm run build`（发布面自检：files 完整性 + `node --check` + lockfile 版本）。可以把
   「格式数 / 工具数 / 类型面」的一致性也做成一个确定性断言（见 §3.5），思路与 aislop 的
   dead-code / narrative-comment 规则同源，但零新依赖。
2. **`eslint.config.mjs` 已启用 `no-unused-vars`**，但 `tailCodexEvents` / `tailGrokbuildEvents`
   这类「导出未消费」不会被抓（它们是被 `export.mjs` re-export 的「公开面」，ESLint 不跨文件
   判死）。需 `aislop` 的 dead-code 规则或手写一个「export 消费度」小脚本才能覆盖。

---

## 3. 清理评估（分级）

### 3.1 A 级：立即可做、纯文档/低风险（推荐全做）

| 项 | 动作 | 验证 |
| --- | --- | --- |
| 过时计数注释（1.1） | `discovery.mjs:1`「13 种」→「17 种」；`core.mjs:4`「13 种」→「18 种」；`panel.mjs:26`「15 个」→「17 个」 | grep 无残留旧数字 |
| `ROADMAP.md:16` | 「14 源 + 本地 JSONL」→「17 源 + 本地 JSONL」 | 与 `discovery.FORMATS` 数一致 |
| `ROADMAP.md:46` | `makeImportTool` → `makeImportChatTool`（2c77b26 已改名） | 与 `lib/toolkit.mjs` 一致 |
| `ROADMAP.md` 编号缺口（§1.10A） | 从 `dev/REQUIREMENTS.md` 回填 REQ-64～74 到 ROADMAP，删除「全部 63 项 ✅ 无未完成」失实声明，标注 REQ-67/69/72/73/74 的 ◐/☐ 状态 | 代码注释引用的每个 REQ-NN 都能在 ROADMAP 查到 |
| `index.d.ts` ToolSurface | 补 `doctor` / `import_mcp` / `import_settings` 三接口 | 12 → 15，与 header「15 工具」对齐 |
| `index.d.ts` ScanFormat | 补 `'mimocode'` | 16 → 17，与 `ChatFormat` / `FORMATS` 对齐 |
| `AGENTS.md` 布局表 | 补 `tools.mjs` / `restore.mjs` / `verify.mjs` / `agents.mjs` / `mcp.mjs` / `settings.mjs` / `doctor.mjs` / `cwd-map.mjs` / `handoff.mjs` / `resume-command.mjs` / `markdown.mjs` / `import-prefs.mjs` / `mimocode.mjs` / `dsh.mjs`；`export/` 补 `kimi.mjs` / `bundle.mjs`；`files` 白名单描述改 `docs/*.md` + 补 `bin` | 与 `lib/` 实际文件、`package.json` 一致 |
| **工具/命令 description 去 REQ-NN（§1.9）** | 从 8 个工具描述 + 2 个 /resume 命令描述里删掉 `（REQ-NN）`/`issue #22`/`对标 dsh-resume-plugin` 等开发侧注解；`scan_discover` 的「15 种」改「17 种」并补枚举 mimocode/workbuddy | `grep "REQ-" lib/*.mjs` 只命中代码注释、零命中 description 字符串 |

### 3.2 B 级：需先决策（建议，但每项要一个理由）

| 项 | 选项 | 说明 |
| --- | --- | --- |
| `tailCodexEvents` / `tailGrokbuildEvents`（1.5） | 删，或补测试后保留 | 零消费者。删最干净（「从未出现过」）；若未来要做 Codex/Grok 增量 tail 写回再补。倾向删 |
| `IMPORT_OUTPUT_SCHEMA` 重复（1.7） | 抽公共子 schema，或降为宽松 object | 抽引用消除 280 行重复是正确方向，但改动会触碰 `validateJsonSchemaValue` 测试；降为宽松 object 风险更低（该 schema 不进模型、不进运行时） |
| `slugifyClaudeCwd` 同名（1.6） | 重命名其一（如 `slugifyCwdForMatch` vs `slugifyCwdAscii`） | 纯内部改名 + 同步 import 与测试，低风险 |
| `normalizeTitle` 9 处内联（§1.10C） | 收敛进 `lib/convert/core.mjs`，删除各源内联副本 + 「core.mjs 属禁改面」误导注释；discovery.mjs 的独立版另行评估 | 碰 9 个源 + 测试，中风险；但消除一类「解释性注释掩盖重复」 |

### 3.3 C 级：不建议动（治理/历史价值 > 清理收益）

- 「路线 A」注释（1.4）：这是安全修复的合规记录，保留；**唯一建议**是把「路线 A」这个
  悬空标签改成中性描述（如「security 扫描判 child_process 为 critical」），或补一句
  「路线 B = 保留系统 zstd 二进制（被否）」，让引喻可解析。
- `dev/kimi-cli-ref/`（1.8）：参考资产，保留；建议加一行 provenance（来源 commit / 拉取日期 /
  用途），零风险。
- `readOpencodeDb` / `readZcodeDb` / `exportClaudeSession` 三个 index.mjs 公开导出：test hook +
  子路径契约，保留（CHANGELOG 已声明「不变」）。

### 3.4 优先级与风险矩阵

| 优先级 | 项 | 风险 | 收益 |
| --- | --- | --- | --- |
| P0 | **description 去 REQ-NN（§1.9）** | 低（纯字符串删除） | 模型每轮省 token、用户看到产品说明而非开发笔记 |
| P0 | A 级全部（文档/类型面同步） | 低（纯文档 + d.ts） | 地图不失真、TS 调用方不踩 mimocode 类型坑 |
| P1 | B 级删死 alias（1.5） | 低 | 消除「对称占位」误导 |
| P1 | 引入 §3.5 的 drift 断言 | 低（零依赖脚本） | 从源头压住「新增后没同步」 |
| P2 | B 级 schema 去重 / slugify 改名 | 中（碰测试） | 可读性债下降 |

### 3.5 建议引入的自动化（drift 断言，非新工具）

本仓库的病灶是「计数/清单/类型面的元数据漂移」，不是「死代码」。最对症的防回归不是接入
aislop，而是加一个**零依赖的确定性断言脚本**（放在 `dev/bin/`，与现有 `verify-*` 并列，
不进 CI 强制，提交前按需跑）：

- 解析 `lib/discovery.mjs` 的 `FORMATS`、`lib/toolkit.mjs` 的 `CHAT_FORMATS`、`index.d.ts`
  的 `ChatFormat` / `ScanFormat`、`lib/tools.mjs` 的注册名列表；
- 断言：`FORMATS` ⊂ `ScanFormat` ⊂ `ChatFormat`（mimocode 这类漏写会立即红）；
  工具注册名 == `ToolSurface` 声明名（doctor/import_mcp/import_settings 这类漏写会立即红）；
  「格式数 / 工具数」与各头注释声明的数字一致。

与 GovAgent 的 `scripts/check-diff-scope.mjs` 同哲学：**脚本而非插件、零依赖、提交前自检**。

---

## 4. 后续开发指导

1. **加格式/加工具时同步四处**：`discovery.FORMATS`、`toolkit.CHAT_FORMATS`、
   `index.d.ts`（`ChatFormat` + `ScanFormat` + `ToolSurface`）、`AGENTS.md` 布局表。
   这四处是同一事实的四份拷贝，漏一处就是下次审计的 §1.1/1.2。
2. **删除 = 从未出现**：删导出/别名/选项时，连同其 re-export（`convert.mjs` / `export.mjs`
   shim）与 d.ts 声明一起删，不留「对称占位」（对照 1.5 的反例）。
3. **「为什么不用 X」写进 CHANGELOG/决策文档，不进代码注释**：代码注释只写「这是什么」；
   需要记录备选方案时写全（路线 A/B 各自代价），不留「路线 A」这种无法解析的悬空引喻。
4. **头注释里的计数要么不写、要么与机器可读清单一致**：宁可写「见 FORMATS」也不写一个
   会过时的具体数字。
5. **REQ-NN / issue 编号 / 竞品对标只进代码注释，绝不进 `description:` 或 render 文本**：
   工具 description 是产品文案（模型上下文 + 用户可见），内部需求编号放 ROADMAP / 代码
   注释；要说明「为什么做」写 CHANGELOG，要说明「对标谁」写 ROADMAP 生态表。

---

## 5. 结论

1. 本仓库**没有** GovAgent 那种「删除 → 永久禁令 / 解释性墓碑 / prompt_leak 工具化」的
   深层痕迹；child_process 移除与 18 工具收敛都删得相对干净。
2. 真正的病灶是**反方向的元数据漂移**：格式 13→17、工具 18→1 分发器、新增 5 个非导入工具
   之后，注释里的计数（§1.1）、index.d.ts 的类型面（§1.2）、AGENTS.md 布局表（§1.3）、
   ROADMAP 能力表（§1.1）停在旧状态；外加两处小型的「无谓添加」——死 alias（§1.5）与
   重复 schema（§1.7）。
3. **最值得警惕的是 §1.9**：内部需求编号（REQ-NN）、GitHub issue 编号、竞品对标这些
   开发侧注解被直接写进了工具/命令的 `description:` 字符串——这是产品侧文案（模型上下文 +
   用户可见），与 GovAgent 的「无东坡肉注释被端上桌」完全同构，15 个工具里 8 个中招。
4. **注释侧（§1.10）是 §1.9 的镜像问题**：注释写 REQ 编号本身没错，但编号体系漂移了——
   公开 ROADMAP 冻结在 63、代码注释引用到 74、定义藏在 gitignored 的 dev/REQUIREMENTS.md、
   REQ-74 一个编号塞 5 个无关功能；另有「core.mjs 属禁改面」注释掩盖 normalizeTitle 的 9 处
   内联重复、且「同步 N 处」计数自相矛盾（5/9/逐源/多处）。
5. 清理按序：**先修 §1.9（去 REQ-NN，纯字符串删除零风险）**，再 A 级（文档/类型面同步 +
   ROADMAP 回填 REQ-64～74）、B 级删死 alias + normalizeTitle 收敛进 core.mjs + 可选 schema
   去重；建议加一个零依赖的 drift 断言脚本把「四处拷贝同步」变成机器可判（§3.5）。
6. 后续按 §4 执行——让「加一个源 = 同步四处」和「REQ 只进注释、不进 description」成为
   肌肉记忆，比任何工具都便宜。
