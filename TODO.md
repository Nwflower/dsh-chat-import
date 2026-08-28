# TODO — dsh-chat-import fork 草稿

> 本仓库是 [Nwflower/dsh-chat-import](https://github.com/Nwflower/dsh-chat-import) 的 AI 草稿 fork，
> 改动成熟后合回上游正式 PR（协作原则见 AGENTS.md / b2 笔记）。本文件记录分支上的
> 进行中工作与后续计划。

## feat/qwen-source 分支（2026-08-28）

### 已完成

- [x] **千问办公（Qwen Work CN）源适配器**——第 19 个导入源：
  - `lib/convert/qwen.mjs`：转写 → DSH 会话。humanInput.text 权威提问、跳过
    `<system` 注入块、workspace-directories 提取真实项目目录、runtime-config 取模型、
    tool_result 按 tool_use_id 挂回、fileStem 防撞 id（与 claude.mjs 同款纪律）
  - `lib/discovery.mjs`：scanQwen + 路径自拒（`~/.qwenworkcn/projects/`）+
    双 slug 副本按 sessionId 去重留最新
  - 注册面：FORMATS / defaultRoots / SCANNERS / fileFormatsForPath / IMPORT_SOURCES /
    IMPORT_SPECS(CHAT_FORMATS) / SOURCE_FORMAT / TOOL_FORMAT / SOURCE_NAMES /
    SOURCE_LABEL_BY_KEY / convert.mjs / index.d.ts
  - 测试：`test/qwen.test.mjs`（5 用例）+ discovery 发现/去重/自拒用例
  - **真实验证**：本机 71 jsonl → 65/65 会话全部发现并转换成功（0 无标题、
    0 丢工具结果），项目分布与 ai_session_scan.py 盘点器完全一致
- [x] **导入面板下拉框改造**：来源/工作区两个原生 `<select>` 换成自定义
  `SearchableSelect`（可搜索过滤、当前项 ✓ 高亮、键盘 ↑↓/Enter/Esc、点击外部关闭、
  明暗主题自适应）；来源列表加产品名展示标签（如「千问 (Qwen)」）

### 待办（下一段）

- [ ] 在 DSH 里实际走一遍面板导入千问会话，确认会话续聊（resume）可用
- [ ] 千问「纯聊天」会话（无授权目录）在面板的分组名显示优化（当前无 workspace 归桶）
- [ ] attachment 事件（图片粘贴引用）目前跳过不导入——评估是否值得转为文本占位
- [ ] 上游正式 PR（对照 b2 笔记流程：fork 草稿 → Nwflower/dsh-chat-import PR）
- [ ] 若上游收编，同步更新 README/README.zh-CN 的支持来源清单（18 → 19）
