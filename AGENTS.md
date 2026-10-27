# AGENTS.md

`dsh-chat-import` 是 DeepSeek Harness（DSH）插件：把 32 种来源格式（含 DSH 自身的会话日志）的聊天记录导入为可继续的 DSH 会话，支持反向导出。

## 原则

- 本仓库只做插件，不修改 DSH 引擎、apiproxy 或官方 UI 包。
- 宿主侧零构建，纯 ESM，`lib/` 就是发布产物。唯一的例外是浏览器侧的 bundle `lib/client.js`：它由 `src/client/` 的分片组装而成，外加白名单内联的 `lib/` 纯模块，组装器是 `scripts/build-client.mjs`。之所以要组装，是因为 DSH 客户端加载器没有相对 require，产物必须是一个单文件（见 `docs/architecture.md` D7）。
- 同口径逻辑只留一份，来源清单由一张表派生（`docs/architecture.md` D21）：写新代码之前先找共用件，不要复制相邻来源的实现。
- 根目录只放发布到 GitHub / npm 的文件；本地工程文件收进 `dev/`，不提交。
- 公开文档（README 双语、docs、CHANGELOG、ROADMAP）不出现 REQ、issue 号一类内部编号。
- 结构性改动之前先读 `docs/architecture.md`（架构决策与权衡），不要违背已记录的决策。确实需要推翻某条决策时，先在该文档里说明旧决策为什么不再成立。
- 冲突时按这个顺序取舍：用户当次的指令 > 仓库代码现状 > 本文件 > `docs/`。被当次指令推翻的约定要不要回填进文档，由用户决定，AI 不现场猜。

## 体量停止线（机械触发，不靠判断）

- `lib/` 下任何手工维护的源文件超过 1000 行（convert / export 纯函数层放宽到 800 行）：停止往里加新功能，先写一份拆分提案等用户确认；提案批准之前，该文件只修 bug。拆分方向见 `docs/architecture.md` D6。`lib/client.js` 是生成产物，不受这条限制，同样的界线作用在 `src/client/` 的各个分片上。
- 同一个来源的解析或发现逻辑出现第 3 处副本时，同样停下来提案，不写第 4 处。
- `test/*.test.mjs` 单个文件超过 1200 行：同第一条，先拆再往里加用例。`test/_support/` 与 `test/fixtures/` 不受这条限制。测试面另有一项机械检查（`npm run check:tests`）：每个来源格式至少有一个测试锚点。
- 这几条停止线给执行模型用，触发即停，不必先判断「是否值得」。

## 命令

```sh
npm test               # node --test 跑 test/*.test.mjs
npm run lint           # eslint
npm run coverage       # 覆盖率护栏：line >= 75%
npm run check:coverage # 覆盖率结构：逐文件下限 + 逐目录均值下限（只看全局数字会盖住单文件的空洞）
npm run check:linux    # 跨平台路径纪律静态检查
npm run check:leaks    # 敏感信息泄漏扫描
npm run check:links    # 文档相对链接检查
npm run check:tests    # 测试面纪律：每个来源有测试锚点 + 单测文件停止线
npm run release:notes -- --version x.y.z   # 校验并预览该版本的发布说明（release workflow 用的是同一份）
npm run build:client   # 由 src/client/ 的分片组装 lib/client.js（改过面板必须重跑）
npm run build          # 发布面自检：client bundle 是否最新、files 是否完整、入口可达的模块是否都在 files 里、语法、lockfile
```

## 仓库布局

- `lib/index.mjs` 是插件入口（`package.json` 的 main），只做组装。
- `lib/convert/*` 与 `lib/export/*` 是纯函数层，不读盘、不 import 宿主模块，有测试守护。共用件在 `convert/util.mjs`、`convert/ir.mjs`、`convert/core.mjs` 与 `export/common.mjs`。设计同源的来源共用一个转换引擎，各自只留差异描述（pi 与 omp 共用 `convert/pi-family.mjs`，见 D21）。`convert/index.mjs` 只转出经它导入的名字；`export/index.mjs` 是公开子路径 `./export.mjs`。
- `lib/sources/*` 是按来源命名的 host 面适配器，与 `lib/convert/<src>.mjs` 一一对应；SQLite 读取统一经 `sources/sqlite.mjs`。
- 导入编排分布在几处：`lib/import-core.mjs` 是单会话源与多会话源共用的状态机，`lib/import-state.mjs` 管已知记录与「源未变」短路径，`lib/import-batch.mjs` 管文件收集与批量计数，`lib/import-variants.mjs` 管 chatgpt / grokbuild / hermes / kimi 等特殊形态；registry 在 `lib/imports.mjs`。
- `lib/discovery.mjs` 是门面，实现放在 `lib/discovery/`：`registry.mjs` 是来源描述符表，其余是按来源族划分的扫描器模块。
- `lib/tools.mjs` 是门面，负责注册与档位对账，工具定义都在 `lib/tools/`。`import_chat` 的分发器与来源表在 `lib/toolkit.mjs`。工具 schema 只放一次调用需要的东西，长文说明在 `docs/IMPORT-GUIDE.md`，由运行时 skill `dsh-chat-import-usage` 按需加载。
- `lib/client.js` 是浏览器面板的 bundle，属生成产物，不要手改。源在 `src/client/`，组装器是 `scripts/build-client.mjs`。
- `bin/dsh-chat-import.mjs` 是独立 CLI。
- `docs/` 放面向最终用户的文档（含 ROADMAP、CONTRIBUTING）。`test/` 放测试与合成 fixtures，假宿主这类测试共用件在 `test/_support/`，不要在测试文件里另写一份。
- `dev/`、`node_modules/`、`.dsh-file-claim/` 不入库。

## 核心约定

- 只消费 host 的公开服务：`sessionPersistence`、`fs`、`tools`、`workspaceRegistry` 是必需的，`webServer`、`commands`、`skills`、`sessionProjectionCache` 是可选。可选服务一律用 `ctx.get(name)` 机会式读取、不进 `inject`，服务缺席时插件照常工作（列表标题提示就是这种做法，见 `docs/architecture.md` D23）。
- 会话日志 append-only：只 `create` + `append`，不改写历史；`seq` 从 0 连续；surface 事件带 `surfaceOp: 'append'`。
- 失败要大声：畸形行、疑似 secrets、降级项都要计数并上报，不静默吞掉。
- 重导语义见 `docs/architecture.md` D13：源未变就跳过，连读都不读；源增长且 DSH 侧会话没被续聊 → 增量续写；已被续聊 → 另铸一份副本，旧会话收进 `record.copies`，绝不追加进用户的对话。`force: true` 恒另建副本。
- 测试描述行为，不为「这样做是对的」背书；fixtures 全部合成，不掺真实 transcript。
- 跨平台路径：mock 树的查找要归一分隔符；断言 `node:path` 的结果时，用同口径函数现算，不写死盘符。
- 注释写契约与上下文，不叙述控制流；空 `catch` 必须说明吞掉了什么。
- README 双语、docs、测试与行为变更必须同步。

## 新增一个来源

1. 在 `lib/convert/<src>.mjs` 写纯转换器，文件头写清存储契约；不读磁盘，也不 import 宿主服务。标题、时间、正文抽取、跳过结果、调用与结果的整理都用共用件（`convert/util.mjs`、`convert/ir.mjs`，以及 `core.mjs` 的 `finishSession`），不要在来源文件里另写一份。新来源若与已有来源同源（同一套条目分类、同一种消息角色命名），把差异写成 profile 复用那个引擎，不复制它的实现。
2. 只有别处需要经 `lib/convert/index.mjs` 导入的名字，才在那里转出；其余直接从定义模块导入。
3. 数据库源还要加 `lib/sources/<src>.mjs`（host 面）：经 `sources/sqlite.mjs` 只读打开、列自适应，读不到就返回 `null`。导入走 `import-core.mjs` 的 `importMultiSource`，短路径、WAL、选择性补导都由它统一处理；dry-run 预览也放在这个文件里，不进 `lib/import-variants.mjs`。
4. 登记，每处一行：`lib/toolkit.mjs` 的 `CHAT_FORMATS`（`/import` 的别名、`import_chat` 的格式枚举、`docs/IMPORT-GUIDE.md` 的来源表都由它派生或与之对账，指南那张表要同步加一行）；`lib/tools/import-sources.mjs` 的导入 spec（一库多会话的来源标 `multiSession`）；`lib/discovery/<来源族>.mjs` 里写描述符，并在 `lib/discovery/registry.mjs` 登记；`lib/sourced-title.mjs` 的来源标签；`src/client/sources.js`；`lib/index.d.ts` 的 `ChatFormat` 与 `ScanFormat`；README 图标墙与 `assets/agents/` 下的标。该来源在 @lobehub/icons 里有官方品牌标时，跑 `node scripts/gen-logos.mjs` 补进 `src/client/logos.js`（生成物，勿手改）；没有官方标时照 Crush、TeleAgent 的做法画一张中性的缩写卡，不伪造品牌标。
5. 补测试：转换器单测、发现层单测、工具层集成测试（假宿主用 `test/_support/`）；SQLite 源用真实临时库造夹具。
6. 门禁全绿：`npm test` / `lint` / `check:linux` / `check:links` / `build`。

## Git 与发布

- 用 conventional commit 前缀，一个逻辑变更一个 commit，不提交 WIP。
- 提交前必须过 `npm test`、`npm run check:linux`、`npm run lint`，工作树不留下杂物。
- 发布流程：更新 CHANGELOG → `npm version patch|minor` 并同步 lockfile → `git push --follow-tags`。推送 tag 后，`.github/workflows/release.yml` 会跑门禁，以 trusted publishing（不存 token）带 provenance 执行 `npm publish`，再用同一个版本节建或更新 GitHub Release。本地不执行 `npm publish` / `gh release`。tag 必须等于 `package.json` 的版本，且指向 `main` 上的提交。发布说明由 `scripts/release-notes.mjs` 从 CHANGELOG 的对应版本节切出，本地可以用 `npm run release:notes -- --version x.y.z --check` 预检。手动 `workflow_dispatch` 只校验，不发布。
- 发布说明就是 CHANGELOG 对应版本节本身，`release-notes.mjs` 不另写一份。
- CHANGELOG 版式（与 dsh 上游发布说明同规范，0.19.0 起）：
  - 版本节写作 `## [x.y.z] - YYYY-MM-DD`，最新的放在最上面；只有无法逐版追溯的旧区间才合并成跨版本条目。
  - 每节双语同页。先写一行语言切换 `[中文](#cn-x.y.z) | [English](#en-x.y.z)`，再写两个锚点：
    `<h3 id="cn-x.y.z">新增功能</h3>` 放中文，`<h3 id="en-x.y.z">New Features</h3>` 放英文。
    锚点 id 必须带版本号，否则同一页上多节会撞名。
  - 分组固定四类，顺序不变。中文用 `### 体验优化` / `### 问题修复` / `### 其他变更`，英文用
    `### Improvements` / `### Bug Fixes` / `### Chores`。没有内容的分组整组省略。
  - 节尾写 `**Full Changelog**: [v上次...v本次](compare 链接)`。
  - 内容口径：一条写清一个**可验证的行为或契约**，不写实现流水账。对外契约的变化（工具名、
    输出 schema、是否支持某个来源）必须在条目里点名；性能、规模类改动要带本机实测数字；
    面向用户的行为变更要与 README、docs 同步。
  - 不写内部编号，不写套话，也不写交代版式本身的说明文字——版式规范写在这里，不进版本节。
