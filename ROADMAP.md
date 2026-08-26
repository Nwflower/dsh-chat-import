# Roadmap

> dsh-chat-import 的需求总览与路线图。状态标记：✅ 已完成 · ◐ 部分完成 · ☐ 未完成。
> 实现细节与历史见 [CHANGELOG.md](CHANGELOG.md) 与 git 历史。

## 生态收录

`dsh-chat-import` 已收录于：[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) · [AdamPlatin123/awesome-dsh-plugins](https://github.com/AdamPlatin123/awesome-dsh-plugins)（PR #4 已 merged，行尾 ✅）· [0xsline/awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness) · [Dominic789654/awesome-deepseek-harness](https://github.com/Dominic789654/awesome-deepseek-harness) · [Alex-Yanggg/awesome-DSH-plugin](https://github.com/Alex-Yanggg/awesome-DSH-plugin) · [Zhiyuan-Fan/Awesome-DeepSeek-Harness-Plugins](https://github.com/Zhiyuan-Fan/Awesome-DeepSeek-Harness-Plugins) · [bruc3van/awesome-dsh-plugin](https://github.com/bruc3van/awesome-dsh-plugin) · [kejixiaoliang/awesome-dsh-plugins](https://github.com/kejixiaoliang/awesome-dsh-plugins) · [dshbase.com 插件目录](https://dshbase.com/plugins/dsh-chat-import/) · [awesome-dsh-plugin.com 兼容性徽章](https://awesome-dsh-plugin.com) · npm registry。

自动收录渠道（打 `dsh-plugin` topic 即收录）：ZASENJC/dsh-plugins-store、YELEBAI/dsh-plugin-marketplace、bradeGithub/DSH-Plugins-Marketplace 等。

## 能力对照（DSH 生态会话导入工具）

| 能力 | dsh-chat-import | 生态内其他 |
| --- | --- | --- |
| 来源数 | 17 源 + 本地 JSONL（13 工具） | 单源 ~ 4 源 |
| 全保真（tool/result + thinking + sourceEventSeqs） | ✅ | 部分 |
| 增量续写（append 新轮次） | ✅ | 部分（复制式） |
| 上下文预算保护 | ✅ | — |
| 反向导出（DSH → Claude Code JSONL） | ✅ | — |
| 矩阵化互转（DSH ↔ Claude ↔ Codex ↔ Kimi） | ✅ | — |
| 便携 bundle 备份/跨机器还原（指纹校验） | ✅ | 部分（codex-claude-transfer） |
| 降级显式报告（degradations） | ✅ | — |
| 只读结构校验 + repair 提示（verify_session） | ✅ | — |
| 交接摘要续聊（/resume-claude /resume-codex） | ✅ | 部分（dsh-resume-plugin） |
| 反向同步（增量写回，带守卫） | ✅ | — |
| agents / skills 落盘资产（`import_agents`） | ✅ | 部分 |
| Browser 面板 + `/import` / `/import-all` 命令 | ✅ | 部分 |
| 会话开始迁移提示 + 上下文桥接 | ✅ | 部分 |
| cwd 权威映射（`.claude.json` / slug 贪心解码）+ 沙箱防护 | ✅ | 部分 |

生态内同类工具：[dsh-claude-move](https://github.com/PerryLink/dsh-claude-move)（Claude 会话+资产 copy，REQ-61 跟进点）· [dsh-plugin-cc](https://github.com/cpj-dev/dsh-plugin-cc)（DSH↔Claude 控制面桥）· [dsh-movein](https://github.com/sjh9714/dsh-movein)（Claude 配置迁移，README 指向我们补会话——互补）· [dsh-plugin-session-import](https://github.com/huguangyu666/dsh-plugin-session-import) · [dsh-import-agents](https://github.com/Chang-Tong/dsh-import-agents) · [opencode-dsh-importer](https://github.com/wang-xudong/opencode-dsh-importer) · [dsh-resume-plugin](https://github.com/Demogorgon314/dsh-resume-plugin) · [dsh-session-import](https://github.com/kinyokun/dsh-session-import) · [dsh-plugin-codex-import](https://github.com/Gordonynh/dsh-plugin-codex-import)。

## 需求总览

| ID | 优先级 | 标题 | 状态 |
| --- | --- | --- | --- |
| REQ-01 | P0 | 重生成干净 lockfile + CI 改 `npm ci` + 防漂移检查 | ✅ |
| REQ-02 | P0 | 收口版本漂移：bump 0.2.0 发布（含 Reasonix/opencode） | ✅ |
| REQ-03 | P1 | 标签纪律：统一 `npm version` bump + tag 流程 | ✅ |
| REQ-04 | P1 | 引入 CHANGELOG | ✅ |
| REQ-05 | P1 | CI 增加 headless 真实加载冒烟 | ✅ |
| REQ-06 | P1 | CI 检查双语 README 同步 | ✅ |
| REQ-07 | P1 | peer 版本策略与兼容矩阵 | ✅ |
| REQ-08 | P2 | `index.mjs` 按职责拆分 | ✅ |
| REQ-09 | P2 | `makeImportChatTool` 参数收敛（18 源 → 单分发器） | ✅ c56a4bf + 2c77b26 |
| REQ-10 | P2 | 引入 eslint + CI 检查 | ✅ |
| REQ-11 | P2 | 修正 dev 文档过时信息 | ✅ |
| REQ-12 | P3 | package.json 元数据补齐 + engines 精确化 | ✅ |
| REQ-13 | P3 | CI 覆盖报告（line ≥ 75% 护栏） | ✅ |
| REQ-14 | P1 | 多源：Kimi CLI 适配（`import_kimi`，第 13 源） | ✅ |
| REQ-15 | P1 | 多源：ZCode 格式侦察 | ✅ 并入 REQ-38 |
| REQ-16 | P1 | 互转：反向导出 MVP — DSH → Claude Code JSONL（`export_claude`） | ✅ |
| REQ-17 | P1 | 保真度：导入 dry-run 预览 | ✅ |
| REQ-18 | P2 | 互转：IR 协议化（interchange v1 schema + 文档） | ✅ 5fe466a |
| REQ-19 | P2 | 保真度：ChatGPT 分支还原 + tool 参数结构化 | ✅ ce90209 |
| REQ-20 | P2 | 保真度：Cursor tool_result / opencode patch diff 复查 | ✅ 边界确认 |
| REQ-21 | P2 | 互转：保真度降级策略显式化 | ✅ acef196 |
| REQ-22 | P3 | 保真度：Reasonix V2 WAL 合并 + Claude compacted 摘要选项 | ✅ 508ef2d |
| REQ-23 | P3 | 互转：矩阵化互转 + repair 校验工具 | ✅ 1f0d9e6 |
| REQ-24 | P0 | 增量续写（重导 append 新轮次 + 源路径幂等键 + force 副本 + sourceShrunk） | ✅ |
| REQ-25 | P1 | 自动发现 + 扫描缓存（scan_discover） | ✅ |
| REQ-26 | P1 | 畸形行行号 + secrets 位置上报 + permission 计数 | ✅ |
| REQ-27 | P1 | 标题兜底（custom-title > ai-title > 首问） | ✅ |
| REQ-28 | P2 | memory / skills / CLAUDE.md 上下文桥接（默认关闭） | ✅ |
| REQ-29 | P2 | /import-all 批量命令（Web 面板 REQ-41、/import REQ-42 已落地） | ✅ c53bc4c |
| REQ-30 | P2 | 交接摘要续聊（/resume-claude /resume-codex） | ✅ cee6153 |
| REQ-31 | P3 | 同类生态插件 / 官方能力监控（周期性） | ✅ |
| REQ-32 | P1 | 内部标记：`session/imported` 事件 | ✅ |
| REQ-33 | P2 | 导入识别 / 撤回（`list_imported_sessions` + 引导手动删） | ✅ |
| REQ-34 | P2 | UI 分组：host-only Web 面板 | ✅ 由 REQ-41 Browser 面板取代 |
| REQ-35 | P2 | 卸载语义（自动撤 Hook、绝不删会话；手动清理引导） | ✅ |
| REQ-36 | P1 | 反向同步：双向同步桥 B 第一步（`sync_to_claude` 增量写回） | ✅ 真实 `claude --resume` 验证待补 |
| REQ-37 | P1 | 超长会话三层保护 + 预算自适应 | ✅ |
| REQ-38 | P1 | ZCode 源适配 | ✅ |
| REQ-39 | P2 | cwd 权威映射 + 沙箱防护 | ✅ 165f7ca（lite 5fab50a + full 同链） |
| REQ-40 | P2 | 发现索引补充（标题/项目/消息数 + 扫描缓存 + 搜索） | ✅ |
| REQ-41 | P2 | Browser 侧侧边栏入口（导入面板） | ✅ |
| REQ-42 | P2 | `/import <tool> <path>` 命令面 | ✅ |
| REQ-43 | P2 | 导入会话工具完整可用（agentPresets.mount + 默认模型绑定） | ✅ 6a518ed |
| REQ-44 | P2 | codex `custom_tool_call` JS 参数转标准 JSON | ✅ |
| REQ-45 | P3 | 源覆盖面：Reasonix 桌面版 + Claude-3p 新端 | ✅ 4e2f193 |
| REQ-46 | P1 | 新源：Grok Build 适配（第 9 源） | ✅ |
| REQ-47 | P1 | 新源：OpenClaw 适配（第 10 源） | ✅ |
| REQ-48 | P1 | 新源：Hermes 适配（第 11 源） | ✅ |
| REQ-49 | P1 | 缺陷：trimTurns L2 锚点收缩静默丢轮 | ✅ |
| REQ-50 | P2 | Hermes-agent（NousResearch）变体 tool_calls / reasoning 独立列 | ✅ |
| REQ-51 | P3 | Hermes 会话 lineage（parent_session_id 压缩分叉） | ✅ 85d85de |
| REQ-52 | P2 | Codex 官方 App Server API 路线侦察 | ✅ 维持 rollout |
| REQ-53 | P2 | 新会话开始迁移提示（per-project 记忆） | ✅ |
| REQ-54 | P2 | 源文件变更自动增量续写 + 面板 Sync 入口 + watch 懒检查 | ✅ |
| REQ-55 | P1 | 缺陷：导入会话归档后可重新导入 | ✅ |
| REQ-56 | P2 | DSH 会话通用导出/备份（interchange bundle + 指纹 + 还原） | ✅ 6ec5818 |
| REQ-57 | P3 | 导入结果结构校验 | ✅ |
| REQ-58 | P3 | scan_discover 索引补 git 分支/dirty | ✅ |
| REQ-59 | P2 | 外部 agent/mode prompt 落盘转换为 DSH skills 资产（`import_agents`） | ✅ |
| REQ-60 | P1 | 发布规范持续达标（plugin_check 全项：types/cordis peer/tsconfig/build 脚本） | ✅ v0.4.0 |
| REQ-61 | P2 | Claude 资产持久化导入（memory / CLAUDE.md / skills → DSH 资产，扩展 import_agents） | ✅ |
| REQ-62 | P2 | 便携 bundle 跨机器移动用例（对标 codex-claude-transfer） | ✅ 6ec5818 |
| REQ-63 | P3 | 仓库社区健康（CONTRIBUTING + issue/PR 模板） | ✅ |

**全部 63 项 ✅**（v0.5.0，2026-08-16 收口）——无未完成需求。
