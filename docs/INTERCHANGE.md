# Interchange v1 — dsh-chat-import 会话交换协议

> 机器实现见 `lib/convert/interchange.mjs`（`DEGRADATION_RULES` / `summarizeDegradations` / `exportDegradations`）

> 本协议定义导入/导出共用的 turns IR 与便携 bundle 格式。

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
      "prompt": "用户提问",              // 提问的文本投影（标题、空轮判定用它）
      "promptBlocks": [                 // 可选：提问带图时的完整内容块（缺省 = 单个 text 块）
        { "type": "text", "text": "看这张截图" },
        { "type": "image", "data": "<base64>", "mediaType": "image/png", "name": "shot.png" }
      ],
      "steps": [
        {
          "model": "claude-opus-4-7",   // 可选：该步自己的模型（中途换模型时逐步骤记名）
          "content": [
            { "type": "text", "text": "助手正文" },
            { "type": "reasoning", "text": "推理" },
            { "type": "tool-call", "id": "call-1", "name": "read", "arguments": "{\"path\":\"a\"}" },
            { "type": "image", "data": "<base64>", "mediaType": "image/jpeg" }
          ],
          "toolCalls": [
            { "id": "call-1", "name": "read", "arguments": "{\"path\":\"a\"}" }
          ],
          "toolResults": [
            { "toolCallId": "call-1", "content": [{ "type": "text", "text": "…" }], "isError": false }
          ],
          "time": 1767224650000,        // 可选：该步助手消息的源时间戳（毫秒）
          "usage": { "inputTokens": 100, "outputTokens": 20, "cacheReadTokens": 30 }  // 可选：provider 回报用量
        }
      ],
      "aborted": false,                 // 可选：该轮被中断
      "compaction": { "summary": "…", "provider": "claude-code", "model": "…" },  // 可选：本轮之前有源侧压缩
      "shadowed": false                 // 可选：该轮已被后续压缩遮蔽（log-only）
    }
  ]
}
```

- `content` 块类型与 DSH 会话事件同构：`text` / `reasoning` / `image` / `tool-call` / `tool-result`
  （`tool-result` 块出现在 `toolResults[].content` 内，或作为消息 content 块）。
- 回合模型：一条用户提问 = 一个 `turn`；一条助手消息（含其工具调用与结果）= 一个 `step`。
- `turns[i].time` / `steps[j].time` / `toolResults[k].time`（可选，毫秒）：源转录的逐记录
  时间戳，是宿主耗时统计的原料（模型耗时 = step.start→assistant/message，工具耗时 =
  tool/call→tool/result）；事件时间只前进不倒退，全缺时取会话创建时间（这些耗时即为 0）。
  首 token 延迟与输出速度**任何源都不可导**：外部转录没有流块时间戳，`stream` 恒为 `[]`。
- `steps[j].usage`（可选）：provider 回报的 token 用量（DSH TokenUsage 形状），写入
  `assistant/message.data.usage` 供宿主 token 统计折叠；input/output 不是非负整数时整份丢弃。
- 配对不变量：每个 `toolCalls[].id` 必须有对应 `toolResults[].toolCallId`（缺失时
  `synthesizeSession` 兜底补发空结果——`sourceEventSeqs` 关联仍成立）。
- 图片块有两种状态：**待落地** `{ type:'image', data:<base64>, mediaType, name? }`（转换层
  从源转录拿到字节时产出）与**已是引用** `{ type:'image', attachment:{ attachmentId, … } }`
  （DSH 源回灌 / 导出再导入时带过来）。落盘前 `lib/attachments.mjs` 经宿主 `ctx.attachments`
  把待落地块存成不可变对象、替换为引用；**base64 永不进会话日志**（宿主的 `ImageBlock`
  只认引用）。宿主没有该服务 / 类型不收（第一版只收 PNG/JPEG/WebP/GIF）/ 超限 / 源只给引用
  （如 Kimi 的 `blobref:`）时，该块降级为 `[image]` 文本并计入 `imagesDegraded`。**目标代次
  低于 4 时**（面板「导入到 → DSH（V3）」或续写一条 V3 会话）也一律降级——附件引用是当前
  世代的概念，旧宿主读不出引用来；宁可占位，也不产出旧宿主打不开的日志。
- 该 IR 是**进程内契约**（无版本号、不落盘）：改它需同步各转换器与 `synthesizeSession`。
  对外可交换的格式是 §4 的便携 bundle（有 `version` 与双层指纹）。

## 2. 各源能力矩阵

描述「源格式能记录什么」；缺能力 = 该源固有的有损项，不是插件缺陷。

| 源 | toolResults | reasoning | images | cwd | branches | attachments | compacted | timestamps | usage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | ✅ | ✅ | ✅（提问 / 助手 / 工具结果内的 base64 截图） | ✅ | — | ✅ | — | ✅（逐行） | ✅（含 cache 读写桶） |
| codex | ✅ | ✅（summary 可读；密文不可读） | ✅（`input_image` 的 data URL） | ✅ | — | ✅ | — | ✅（行信封） | — |
| chatgpt | ✅（无结构化参数） | — | — | — | ✅（mapping DAG） | ✅ | — | ✅（`create_time`） | — |
| cursor | —（导入器补空结果） | — | — | — | — | — | — | — | — |
| gemini | ✅ | ✅ | — | ✅ | — | — | — | — | — |
| reasonix | ✅ | ✅ | — | ✅ | — | — | — | ✅（v2 行 `createdAt`） | ✅（v2 行 `usage`，守卫映射） |
| opencode | ✅ | ✅ | ✅（带内联字节的 file part） | ✅ | — | ✅ | ✅ | ✅（消息级） | ✅（V1 `message.data.tokens`；kilocode / mimocode 同） |
| teleagent | ✅ | ✅ | — | ✅ | — | ✅ | ✅（样本 compaction 无 tail_start_id → 不裁剪，全量导入） | — | — |
| zcode | ✅ | ✅ | ✅（带内联字节的 file part） | ✅ | — | — | ✅ | ✅（消息级） | — |
| grokbuild | ✅ | ✅（summary 明文可读；encrypted_content 密文不可读） | ✅（`images[]` 的 data URL） | ✅ | — | ✅ | ✅（compaction_meta 交接摘要进原生检查点） | —（逐行无时间戳） | — |
| openclaw | ✅ | — | — | ✅ | — | — | — | ✅（逐行） | — |
| hermes | ✅ | ✅ | — | ✅ | — | — | — | ✅（逐消息 `ts`） | — |
| pi | ✅ | ✅ | ✅（带字节的 image 块） | ✅ | ✅（树形） | — | ✅ | — | — |
| kimi | ✅ | ✅ | —（只有自有 blob 存储的 `blobref:` 引用，插件取不到字节 → 占位 + 计数） | ✅ | — | — | — | ✅（逐行） | — |
| workbuddy | ✅ | ✅ | — | ✅ | — | — | — | ✅（逐行） | — |
| continue | ✅ | ✅ | — | ✅ | — | — | ✅（history 不裁剪，摘要挂 reasoning 块） | —（history 项无时间戳） | — |
| cline | ✅ | ✅ | — | ✅ | — | — | ✅（compaction 侧车不改写主转写） | ✅（仅 assistant 的 `ts`） | — |
| goose | ✅ | ✅ | — | ✅ | — | — | — | ✅（逐消息） | — |
| zed | ✅ | ✅ | —（`item.Image` 无内联字节 → 占位 + 计数） | ✅ | — | — | ✅（Compaction 摘要挂 reasoning 块） | —（线程级才有时间） | — |
| crush | ✅ | ✅ | — | ✅ | — | — | ✅（自动摘要消息挂 reasoning 块） | ✅（`created_at` / `finished_at`） | — |
| trae | ✅ | — | — | ✅ | — | — | — | ✅（逐消息） | — |
| dsh | ✅ | ✅ | ✅（原生附件引用原样带过，不重复存） | ✅ | — | ✅ | — | ✅（原生事件时间原样透传） | ✅（原生 usage 原样透传） |

「—」= 该源固有缺能力（不是插件缺陷）；`images` 列的 ✅ 指该源能提供图片字节、导入后由
宿主附件服务持久化（能否落成取决于宿主是否提供 `ctx.attachments`，见 §3 的 `attachment-skipped`）。
`timestamps` 列的 ✅ 指逐记录时间戳会透传进会话事件时间（宿主据此刻出真实的逐步模型耗时与
工具耗时）；`usage` 列的 ✅ 指 provider 回报的 token 用量写入 `assistant/message.data.usage`
（宿主 token 统计可见）。首 token 延迟与输出速度任何源都标不出：外部转录没有流块时间戳，
不伪造（见 §1 的 IR 说明）。

## 3. 降级规则表

目标格式缺能力时「失败要大声」：降级必须显式报告（导出/互转结果附 `degradations`
字段），不能静默。策略三态：`lossless`（无损）/ `text-fallback`（降级文本块）/
`skip-placeholder`（跳过 + 占位）。

| id | 能力缺口 | 策略 | 触发条件 |
| --- | --- | --- | --- |
| `tool-result-missing` | toolResults | skip-placeholder | 目标格式不记录工具结果（Cursor）→ 导入器兜底补发空结果 |
| `tool-result-text-fallback` | toolResults | text-fallback | 源格式工具消息无结构化参数（ChatGPT 网页导出）→ 按文本挂最近一步 |
| `reasoning-encrypted` | reasoning | skip-placeholder | 推理内容不可见（Codex 密文 `encrypted_content`，可读的 summary 仍照常导入）→ 密文部分无内容可导入 |
| `cwd-missing` | cwd | text-fallback | 无工作目录（ChatGPT / Grok Build）→ 落入专用导入工作区（见 architecture D16） |
| `branch-collapsed` | branches | text-fallback | 目标会话无分支概念 → 分支会话只导主线程 |
| `attachment-skipped` | attachments | skip-placeholder | 图片拿不到字节（宿主无 `ctx.attachments`、类型不收、超上限、源只有引用如 Kimi 的 `blobref:`）→ 该块以 `[image]` 文本占位并计入 `imagesDegraded`（导出方向读不回字节时同样计此项） |
| `compacted-unavailable` | compacted | text-fallback | 无压缩摘要 → 超长会话由预算三层保护被动截断 |
| `injection-skipped` | — | skip-placeholder | 非人类注入消息（system-reminder 等）不进入会话 → 跳过并计数 |
| `orphan-tool-result` | toolResults | skip-placeholder | 源日志无对应 tool/call 的工具结果（中途开始的 transcript）→ 丢弃并计数 |
| `usage-unknown` | — | text-fallback | 目标格式要求用量计数（opencode 的 `cost` / `tokens` 是解码必填）而事件没有 provider 回报 usage → 写 0 并显式报告（事件带 usage 时如实回填，不计此项） |

## 4. 便携 bundle

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
`convertDshJsonl` 导入为可继续 DSH 会话。跨机器：A 机导出 → B 机（无原路径）
还原 0 skipped；`originalCwd` 不可达时回退到 bundle 文件所在目录归组，
结果报告 `cwdAvailable: false` + `groupedTo`（不静默）。
