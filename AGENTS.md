# AGENTS.md

`dsh-chat-import` 是 DeepSeek Harness（DSH）插件：把 29 种来源格式（含 DSH 自身的会话日志）的聊天记录导入为可继续的 DSH 会话，支持反向导出。

## 原则

- 本仓库只做插件，不修改 DSH 引擎、apiproxy 或官方 UI 包。
- 宿主侧零构建，纯 ESM；`lib/` 即发布产物。唯一例外：浏览器侧 bundle `lib/client.js` 由 `src/client/` 分片（外加白名单内联的 `lib/` 纯模块）经 `scripts/build-client.mjs` 组装（DSH 客户端加载器无相对 require，产物必须单文件；见 `docs/architecture.md` D7）。
- 同口径逻辑只留一份，来源清单由一张表派生（`docs/architecture.md` D21）：写新代码前先找共用件，不复制相邻来源的实现。
- 根目录只放发布到 GitHub / npm 的文件；本地工程文件收进 `dev/`，不提交。
- 公开文档（README 双语、docs、CHANGELOG、ROADMAP）不出现 REQ/issue 等内部编号。
- 结构性改动前先读 `docs/architecture.md`（架构决策与权衡），不违背已记录的决策；确需推翻时先在该文档说明旧决策为何失效。
- 冲突优先级：用户当次指令 > 仓库代码现状 > 本文件 > docs/。被当次指令推翻的约定，由用户决定是否回填进文档，AI 不现场猜。

## 体量停止线（机械触发，不靠判断）

- `lib/` 下任一手维护源文件超过 1000 行（convert/export 纯函数层放宽到 800 行）：停止往里加新功能，先输出拆分提案等用户确认；提案未批准前该文件只做 bugfix。拆分方向见 `docs/architecture.md` D6。`lib/client.js` 是生成产物不受此限，同一条线改作用在 `src/client/` 各片段上。
- 同一来源的解析/发现逻辑出现第 3 处副本时：同样停下来提案，不写第 4 处。
- 这两条是给执行模型的硬停止线，触发即停，不需要先判断「是否值得」。

## 命令

```sh
npm test               # node --test 跑 test/*.test.mjs
npm run lint           # eslint
npm run coverage       # 覆盖率护栏：line >= 75%
npm run check:linux    # 跨平台路径纪律静态检查
npm run check:leaks    # 敏感信息泄漏扫描
npm run check:links    # 文档相对链接检查
npm run build:client   # 由 src/client/ 分片组装 lib/client.js（改面板后必跑）
npm run build          # 发布面自检：client bundle 新鲜度 + files 完整性 + 入口可达模块全部在 files 内 + 语法 + lockfile
```

## 仓库布局

- `lib/index.mjs` 插件入口（package.json main），只做组装。
- `lib/convert/*` 与 `lib/export/*` 是纯函数层（不读盘、不 import 宿主模块，有测试守护）：共用件在 `convert/util.mjs`、`convert/ir.mjs`、`convert/core.mjs`、`export/common.mjs`；`convert/index.mjs` 只转出经它导入的名字，`export/index.mjs` 是公开子路径 `./export.mjs`。
- `lib/sources/*` 是按来源命名的 host 面适配器（与 `lib/convert/<src>.mjs` 镜像），SQLite 读取统一经 `sources/sqlite.mjs`。
- 导入编排：`lib/import-core.mjs`（单 / 多会话源共享状态机）+ `lib/import-state.mjs`（已知记录、源未变短路径）+ `lib/import-batch.mjs`（文件收集、批量计数）+ `lib/import-variants.mjs`（chatgpt / grokbuild / hermes / kimi 等特殊形态）；registry 在 `lib/imports.mjs`。
- `lib/discovery.mjs` 是门面，实现在 `lib/discovery/`：`registry.mjs` 来源描述符表 + 按来源族的扫描器模块。
- `lib/tools.mjs` 是门面（注册 + 档位对账），工具定义在 `lib/tools/`；`import_chat` 分发器与格式表在 `lib/toolkit.mjs`。
- `lib/client.js` 浏览器面板 bundle（生成产物，勿手改）；源在 `src/client/`，组装器 `scripts/build-client.mjs`。
- `bin/dsh-chat-import.mjs` 独立 CLI。
- `docs/` 面向最终用户的文档（含 ROADMAP、CONTRIBUTING）；`test/` 测试和合成 fixtures，假宿主等测试共用件在 `test/_support/`（不在测试文件里另写一份）。
- `dev/`、`node_modules/`、`.dsh-file-claim/` 不入库。

## 核心约定

- 只消费 host 公开服务（`sessionPersistence` / `fs` / `tools` / `workspaceRegistry`，可选 `webServer` / `commands` / `skills`）。
- 会话日志 append-only：只 `create` + `append`，不改写历史；`seq` 从 0 连续；surface 事件带 `surfaceOp: 'append'`。
- 失败要大声：畸形行、疑似 secrets、降级项都要计数/上报，不静默吞掉。
- 重导语义（docs/architecture.md D13）：源未变即跳过（不重读）；源增长且 DSH 侧会话未被续聊 → 增量续写；已被续聊 → 另铸副本（旧会话收进 record.copies，绝不追加进用户的对话）。`force: true` 恒另建副本。
- 测试描述行为而非背书正确性；fixtures 全部合成，不掺真实 transcript。
- 跨平台路径：mock 树查找做分隔符归一；断言 `node:path` 结果时用同口径函数计算，不写死盘符。
- 注释写契约和上下文，不叙述控制流；空 `catch` 必须说明吞掉了什么。
- README 双语、docs、测试与行为变更必须同步。

## 新增一个来源

1. `lib/convert/<src>.mjs`：纯转换器，文件头写清存储契约；不读磁盘、不 import 宿主服务。标题 / 时间 / 正文抽取 / 跳过结果 / 调用与结果整理用共用件（`convert/util.mjs`、`convert/ir.mjs`、`core.mjs` 的 `finishSession`），不在来源文件里另写。
2. 别处需要经 `lib/convert/index.mjs` 导入的名字才在那里转出；其余直接从定义模块导入。
3. 数据库源额外加 `lib/sources/<src>.mjs`（host 面）：经 `sources/sqlite.mjs` 只读打开、列自适应；读不到返回 `null`。导入走 `import-core.mjs` 的 `importMultiSource`（短路径 / WAL / 选择性补导由它统一处理），dry-run 预览也放在这个文件，不进 `lib/import-variants.mjs`。
4. 登记（每处一行）：`lib/toolkit.mjs` 的 `CHAT_FORMATS`（`/import` 别名与 `index.d.ts` 一致性测试据此派生 / 校验）、`lib/tools/import-sources.mjs` 的导入 spec（一库多会话源标 `multiSession`）、`lib/discovery/<来源族>.mjs` 的描述符并在 `lib/discovery/registry.mjs` 登记、`lib/sourced-title.mjs` 的来源标签、`src/client/sources.js`、`lib/index.d.ts` 的格式联合类型，以及资源与文档；该来源在 @lobehub/icons 里有官方品牌标时，跑 `node scripts/gen-logos.mjs` 补进 `src/client/logos.js`（生成物，勿手改）。
5. 补测试：转换器单测、发现层单测、工具层集成测试（假宿主用 `test/_support/`）；SQLite 源用真实临时库造夹具。
6. 门禁全绿：`npm test` / `lint` / `check:linux` / `check:links` / `build`。

## Git 与发布

- 使用 conventional commit 前缀，一个逻辑变更一个 commit，不提交 WIP。
- 提交前必过：`npm test` / `npm run check:linux` / `npm run lint`，工作树无杂物。
- 发布流程：更新 CHANGELOG → `npm version patch|minor` 并同步 lockfile → 打 tag → `npm publish` → GitHub Release。
- 发布说明取自 CHANGELOG 对应版本节。
- CHANGELOG 版式（与 dsh 上游发布说明同规范，0.19.0 起）：
  - 版本节：`## [x.y.z] - YYYY-MM-DD`（最新在最上）；跨版本合并只用于无法逐版追溯的旧区间。
  - 每节双语同页：先 `[中文](#cn-x.y.z) | [English](#en-x.y.z)` 语言切换行，再
    `<h3 id="cn-x.y.z">新增功能</h3>`（中文）与 `<h3 id="en-x.y.z">New Features</h3>`（英文）
    两个锚点——锚点 id 必须带版本号，避免同页多节同名冲突。
  - 分组固定四类，顺序不变；中文 `### 体验优化` / `### 问题修复` / `### 其他变更`，
    英文 `### Improvements` / `### Bug Fixes` / `### Chores`；没有内容的分组整组省略。
  - 节尾：`**Full Changelog**: [v上次...v本次](compare 链接)`。
  - 内容口径：一条一个**可验证的行为或契约**，不写实现流水账；对外契约变化（工具名、
    输出 schema、来源支持与否）必须显式点名；性能/规模类改动带本机实测数字；面向用户的
    行为变更与 README/docs 同步。
  - 不写内部编号、不写「AI 化」套话与自述性说明文字（版式说明写在规范里，不写在版本节里）。
