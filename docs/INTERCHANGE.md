# Interchange v1 — dsh-chat-import 会话交换协议

> 机器可读实现见 `lib/convert/interchange.mjs`（`INTERCHANGE_SCHEMA` / `validateInterchange` /
> `SOURCE_CAPABILITIES` / `DEGRADATION_RULES` / `summarizeDegradations`）。
> 本协议是 REQ-18 的落盘结论：把导入/导出两侧共用的 turns IR 显式化为中立交换格式，
> 供源↔目标双向适配器与便携 bundle（REQ-56/62）复用。

## 1. 文档结构（v1）

```jsonc
{
  "interchange": "dsh-chat-import",
  "version": 1,
  "meta": {
    "id": "import-<sourceId 或会话 id>",
    "createdAt": 1710000000000,        // 毫秒
    "cwd": "C:\\work",                 // 机器相关路径；缺失（ChatGPT 等）则无键
    "sourceId": "<源会话 id>"           // 各源显式写入，不从 import- 前缀反解
  },
  "title": "会话标题（可选）",
  "provider": "claude-code",            // 源标识（同 imports registry 记录的 format/来源标签）
  "model": "claude-opus-4-7",           // 源模型（可选）
  "turns": [
    {
      "prompt": "用户提问",
      "steps": [
        {
          "content": [
            { "type": "text", "text": "助手正文" },
            { "type": "reasoning", "text": "推理" },
            { "type": "tool-call", "id": "call-1", "name": "read", "arguments": "{\"path\":\"a\"}" }
          ],
          "toolCalls": [
            { "id": "call-1", "name": "read", "arguments": "{\"path\":\"a\"}" }
          ],
          "toolResults": [
            { "toolCallId": "call-1", "content": [{ "type": "text", "text": "…" }], "isError": false }
          ]
        }
      ]
    }
  ]
}
```

- `content` 块类型与 DSH 会话事件同构：`text` / `reasoning` / `tool-call` / `tool-result`
  （`tool-result` 块出现在 `toolResults[].content` 内，或作为消息 content 块）。
- 回合模型：一条用户提问 = 一个 `turn`；一条助手消息（含其工具调用与结果）= 一个 `step`。
- 配对不变量：每个 `toolCalls[].id` 必须有对应 `toolResults[].toolCallId`（缺失时
  `synthesizeSession` 兜底补发空结果——`sourceEventSeqs` 关联仍成立）。
- 序列化：`serializeInterchange(converted)` 从转换输出产出文档；校验：
  `validateInterchange(doc)` 返回 `{ ok, problems }`（problems 封顶 20 条）。

## 2. 各源能力矩阵

描述「源格式能记录什么」；缺能力 = 该源固有的有损项，不是插件缺陷。

| 源 | toolResults | reasoning | cwd | branches | attachments | compacted |
| --- | --- | --- | --- | --- | --- | --- |
| claude | ✅ | ✅ | ✅ | — | ✅ | — |
| codex | ✅ | 加密不可见 | ✅ | — | ✅ | — |
| chatgpt | ✅（无结构化参数） | — | — | ✅（mapping DAG） | ✅ | — |
| cursor | —（导入器补空结果） | — | — | — | — | — |
| gemini | ✅ | ✅ | ✅ | — | — | — |
| reasonix | ✅ | ✅ | ✅ | — | — | — |
| opencode | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| zcode | ✅ | ✅ | ✅ | — | — | ✅ |
| grokbuild | ✅ | ✅ | — | — | — | — |
| openclaw | ✅ | — | ✅ | — | — | — |
| hermes | ✅ | ✅ | ✅ | — | — | — |
| pi | ✅ | ✅ | ✅ | ✅（树形） | — | ✅ |
| kimi | ✅ | ✅ | ✅ | — | — | — |
| workbuddy | ✅ | ✅ | ✅ | — | — | — |
| dsh | ✅ | ✅ | ✅ | — | ✅ | — |

## 3. 降级规则表（REQ-21）

目标格式缺能力时「失败要大声」：降级必须显式报告（导出/互转结果附 `degradations`
字段），不能静默。策略三态：`lossless`（无损）/ `text-fallback`（降级文本块）/
`skip-placeholder`（跳过 + 占位）。

| id | 能力缺口 | 策略 | 触发条件 |
| --- | --- | --- | --- |
| `tool-result-missing` | toolResults | skip-placeholder | 目标格式不记录工具结果（Cursor）→ 导入器兜底补发空结果 |
| `tool-result-text-fallback` | toolResults | text-fallback | 源格式工具消息无结构化参数（ChatGPT 网页导出）→ 按文本挂最近一步 |
| `reasoning-encrypted` | reasoning | skip-placeholder | 推理内容不可见（Codex 加密）→ 无内容可导入 |
| `cwd-missing` | cwd | text-fallback | 无工作目录（ChatGPT / Grok Build）→ 回退源目录归组 |
| `branch-collapsed` | branches | text-fallback | 目标会话无分支概念 → 分支会话只导主线程 |
| `attachment-skipped` | attachments | skip-placeholder | 非文本内容块无法表达 → 跳过并计数 |
| `compacted-unavailable` | compacted | text-fallback | 无压缩摘要 → 超长会话由预算三层保护被动截断 |
| `injection-skipped` | — | skip-placeholder | 非人类注入消息（system-reminder 等）不进入会话 → 跳过并计数 |
| `orphan-tool-result` | toolResults | skip-placeholder | 源日志无对应 tool/call 的工具结果（中途开始的 transcript）→ 丢弃并计数 |

## 4. 便携 bundle（REQ-56/62）

`export_bundle` 产出 `.dshbundle.json`，是 interchange v1 的备份编码（事件级无损）：

```jsonc
{
  "bundle": "dsh-chat-import",
  "format": "interchange-v1",
  "version": 1,
  "exportedAt": 1710000000000,
  "sourceSessionId": "<DSH 会话 id>",
  "title": "…",
  "originalCwd": "C:\\work",      // 机器相关：A 机原路径（跨机器时 B 机不可达）
  "landingHint": "work",          // 建议落点（originalCwd basename）
  "log": "{…session 头…}\n{…事件行…}",   // 原始会话日志（无损，经 convertDshJsonl 还原）
  "sha256": {
    "session": "<hex>",           // sha256(log) 会话级指纹
    "bundle": "<hex>"             // sha256(除 sha256.bundle 外全部字段规范化 JSON) 文件级指纹
  }
}
```

还原：`restore_bundle` 校验文件级指纹（损坏检测）→ 校验会话级指纹 → 经
`convertDshJsonl` 导入为可继续 DSH 会话。跨机器（REQ-62）：A 机导出 → B 机（无原路径）
还原 0 skipped；`originalCwd` 不可达时按 REQ-39-lite 回退到 bundle 文件所在目录归组，
结果报告 `cwdAvailable: false` + `groupedTo`（不静默）。
