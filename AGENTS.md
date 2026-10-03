# AGENTS.md

`dsh-chat-import` 是 DeepSeek Harness（DSH）插件：把 26 种外部 Agent 工具的聊天记录导入为可继续的 DSH 会话，支持反向导出。

## 原则

- 本仓库只做插件，不修改 DSH 引擎、apiproxy 或官方 UI 包。
- 宿主侧零构建，纯 ESM；`lib/` 即发布产物。唯一例外：浏览器侧 bundle `lib/client.js` 由 `src/client/` 分片经 `scripts/build-client.mjs` 组装（DSH 客户端加载器无相对 require，产物必须单文件；见 `docs/architecture.md` D7）。
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
npm run build          # 发布面自检：client bundle 新鲜度 + files 完整性 + 语法 + lockfile
```

## 仓库布局

- `lib/index.mjs` 插件入口（package.json main），只做组装。
- `lib/` 发布代码，`lib/convert/*` 与 `lib/export/*` 是纯函数层（各自 `index.mjs` 是 re-export shim）；`lib/sources/*` 是按来源命名的 host 面适配器（与 `lib/convert/<src>.mjs` 镜像）。
- `lib/client.js` 浏览器面板 bundle（生成产物，勿手改）；源在 `src/client/`，组装器 `scripts/build-client.mjs`。
- `bin/dsh-chat-import.mjs` 独立 CLI。
- `docs/` 面向最终用户的文档（含 ROADMAP、CONTRIBUTING）；`test/` 测试和合成 fixtures。
- `dev/`、`node_modules/`、`.dsh-file-claim/` 不入库。

## 核心约定

- 只消费 host 公开服务（`sessionPersistence` / `fs` / `tools` / `workspaceRegistry`，可选 `webServer` / `commands`）。
- 会话日志 append-only：只 `create` + `append`，不改写历史；`seq` 从 0 连续；surface 事件带 `surfaceOp: 'append'`。
- 失败要大声：畸形行、疑似 secrets、降级项都要计数/上报，不静默吞掉。
- 重导语义（docs/architecture.md D13）：源未变即跳过（不重读）；源增长且 DSH 侧会话未被续聊 → 增量续写；已被续聊 → 另铸副本（旧会话收进 record.copies，绝不追加进用户的对话）。`force: true` 恒另建副本。
- 测试描述行为而非背书正确性；fixtures 全部合成，不掺真实 transcript。
- 跨平台路径：mock 树查找做分隔符归一；断言 `node:path` 结果时用同口径函数计算，不写死盘符。
- 注释写契约和上下文，不叙述控制流；空 `catch` 必须说明吞掉了什么。
- README 双语、docs、测试与行为变更必须同步。

## 新增一个来源

1. `lib/convert/<src>.mjs`：纯转换器，文件头写清存储契约；不读磁盘、不 import 宿主服务。
2. `lib/convert/index.mjs`：re-export 该转换器及发现层需要的纯函数。
3. 数据库源额外加 `lib/sources/<src>.mjs`（host 面）：`node:sqlite` 只读打开，列用 `PRAGMA table_info` 自适应；读不到返回 `null`。该来源的导入编排与 dry-run 预览也放在这里，不进 `lib/import-variants.mjs`。
4. 登记发现层、工具层、面板层、来源标签、资源与文档；该来源在 @lobehub/icons 里有官方品牌标时，跑 `node scripts/gen-logos.mjs` 补进 `src/client/logos.js`（生成物，勿手改）。
5. 补测试：转换器单测、发现层单测、工具层集成测试；SQLite 源用真实临时库造夹具。
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
