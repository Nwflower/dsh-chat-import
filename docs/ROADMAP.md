# Roadmap

> 当前只保留未完成 / 计划 / 明确不做的事项；已实现的历史由 git 与 CHANGELOG 承载。

## 进行中 / 观察项

- 提升 Windows 测试稳定性：偶发 `EPERM: rename`、临时目录竞争、`rm` 语义相关用例。
- 补充 Kimi `context.apply_compaction` 压缩语义文档（只保留最后一次压缩之后的模型视角）。
- 持续观察外部生态与官方能力变化，避免重复实现。
- opencode V2（`opencode2 session import`）的反向导出契约未验证：目前 `export_chat({ format: 'opencode' })` 仍写 V1 `opencode import` 能吃的 JSON（见 architecture.md D19）。
- opencode V2 尚无真实样本的路径：`shell` 消息、原生 `providerContext` 压缩窗口、fork（`fork_session_id`/`fork_boundary`）、revert 删除消息——拿到样本后按 D19 补口径与测试。

## 明确不做

- 不提供 Agent 自助删除导入会话的入口：删除是低频需求，常驻工具描述会挤占上下文；面板「历史」页已提供带确认的批量删除。
