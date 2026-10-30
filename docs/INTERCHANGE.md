# Interchange v1 —— dsh-chat-import 会话交换协议

> 机器实现见 `lib/convert/interchange.mjs`，里面有 `DEGRADATION_RULES`、`summarizeDegradations` 和 `exportDegradations`。

> **手上有一份未识别的对话记录，想把它转成本协议？** 本文是给维护者看的规范。真正动手转换请读
> [转换指南（给 Agent 的 Skill 指令）](INTERCHANGE-GUIDE.zh-CN.md) 或
> [Conversion Guide（英文）](INTERCHANGE-GUIDE.md)——最小示例、字段表和自检清单都在那里。

> 本协议定义导入与导出共用的 turns IR，以及便携 bundle 的格式。

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

- `content` 的块类型与 DSH 会话事件同构：`text`、`reasoning`、`image`、`tool-call`、`tool-result`。
  工具结果该落在 `toolResults[]`。写在 step `content` 里的 `tool-result` 块，会按 `toolCallId`
  派生进 `step.toolResults`（显式列表优先，与 `tool-call` 块的派生对称）；写在 `promptBlocks`
  或结果内层 `content` 里的结果块无处安放，会被丢弃并计入 `skippedBlocks`。**工具结果不允许
  留在 assistant 或 user 消息的 content 里**：宿主 V4 codec 一见到 `tool-result` 包装就拒载整份
  日志（"released tool-result wrapper"），不过校验层会先用 `retired-tool-result-wrapper` 点名。
- 回合模型：一条用户提问就是一个 `turn`，一条助手消息（连同它的工具调用与结果）就是一个 `step`。
- `turns[i].time`、`steps[j].time`、`toolResults[k].time`（可选，毫秒）是源转录里的逐记录时间戳，
  也是宿主耗时统计的原料：模型耗时从 step.start 算到 assistant/message，工具耗时从 tool/call
  算到 tool/result。事件时间只前进不倒退；三个都缺时取会话创建时间，这些耗时也就都是 0。
  首 token 延迟与输出速度**任何源都导不出来**：外部转录没有流块时间戳，`stream` 恒为 `[]`。
- `steps[j].usage`（可选）是 provider 回报的 token 用量，形状同 DSH TokenUsage。它写进
  `assistant/message.data.usage`，供宿主折叠 token 统计；input 或 output 不是非负整数时，整份 usage 丢弃。
- 配对不变量：每个 `toolCalls[].id` 都要有对应的 `toolResults[].toolCallId`。缺结果时
  `synthesizeSession` 会兜底补发一条空结果，`sourceEventSeqs` 的关联仍然成立。
- 图片块有两种状态。**待落地**的是 `{ type:'image', data:<base64>, mediaType, name? }`，转换层
  从源转录拿到字节时产出；**已是引用**的是 `{ type:'image', attachment:{ attachmentId, … } }`，
  DSH 源回灌或导出再导入时带过来。落盘前，`lib/attachments.mjs` 经宿主 `ctx.attachments` 把待落地
  块存成不可变对象并替换为引用，**base64 永不进会话日志**（宿主的 `ImageBlock` 只认引用）。

  下列情况该块降级为 `[image]` 文本，并计入 `imagesDegraded`：宿主没有这个服务；类型不收
  （第一版只收 PNG / JPEG / WebP / GIF）；超出上限；源只给了引用，比如 Kimi 的 `blobref:`。
  **目标代次低于 4 时**（面板「导入到 → DSH（V3）」，或续写一条 V3 会话）也一律降级：附件引用
  是当前世代才有的概念，旧宿主读不出来。宁可占位，也不产出旧宿主打不开的日志。
- 这个 IR 是**进程内契约**：没有版本号，也不落盘。改它要同步各转换器与 `synthesizeSession`。
  对外可交换的格式是 §4 的便携 bundle，它有 `version` 和双层指纹。

## 2. 各源能力矩阵

这张表描述的是「源格式能记录什么」。缺某一项能力，是源本身固有的有损，不是插件的缺陷。

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
| copilot-vscode | ✅（仅源文件保存的结果；缺失计数） | ✅ | — | ✅（workingDirectory / workspace.json） | — | — | — | ✅ | ✅（每个 request 的 token 合计） |
| cline | ✅ | ✅ | — | ✅ | — | — | ✅（compaction 侧车不改写主转写） | ✅（仅 assistant 的 `ts`） | — |
| goose | ✅ | ✅ | — | ✅ | — | — | — | ✅（逐消息） | — |
| zed | ✅ | ✅ | —（`item.Image` 无内联字节 → 占位 + 计数） | ✅ | — | — | ✅（Compaction 摘要挂 reasoning 块） | —（线程级才有时间） | — |
| crush | ✅ | ✅ | — | ✅ | — | — | ✅（自动摘要消息挂 reasoning 块） | ✅（`created_at` / `finished_at`） | — |
| trae | ✅ | — | — | ✅ | — | — | — | ✅（逐消息） | — |
| vibe | ✅ | ✅ | ✅（内联 base64 图片块） | ✅ | — | ✅ | ✅（context_boundary compaction 原生检查点） | — | — |
| codearts | ✅ | ✅ | — | ✅ | — | — | — | ✅（逐消息） | ✅（prompt / completion / reasoning / cached 四桶） |
| dsh | ✅ | ✅ | ✅（原生附件引用原样带过，不重复存） | ✅ | — | ✅ | — | ✅（原生事件时间原样透传） | ✅（原生 usage 原样透传） |

「—」表示该源本来就没有这项能力，不是插件的缺陷。下面按列解释 ✅ 的具体含义：

- `images` 列的 ✅：该源能提供图片字节，导入后由宿主附件服务持久化。能不能真的落成，取决于宿主是否提供 `ctx.attachments`，见 §3 的 `attachment-skipped`。
- `timestamps` 列的 ✅：逐记录时间戳会透传成会话事件时间，宿主据此折出真实的逐步模型耗时与工具耗时。
- `usage` 列的 ✅：provider 回报的 token 用量会写进 `assistant/message.data.usage`，宿主的 token 统计能看到。

首 token 延迟与输出速度，任何源都标不出来：外部转录没有流块时间戳，插件不伪造（见 §1 的 IR 说明）。

## 3. 降级规则表

目标格式缺某项能力时，按「失败要大声」处理：降级必须显式报告，导出与互转的结果里都带 `degradations` 字段，不能静默。策略有三种：`lossless`（无损）、`text-fallback`（降级为文本块）、`skip-placeholder`（跳过并占位）。

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

还原分三步：`restore_bundle` 先校验文件级指纹（用来发现损坏），再校验会话级指纹，最后经
`convertDshJsonl` 导入成可继续的 DSH 会话。

跨机器用法：A 机导出，把 bundle 拷到 B 机，在 B 机还原，0 skipped。如果 `originalCwd` 在 B 机
不可达，会话会退回到 bundle 文件所在目录归组，结果里报告 `cwdAvailable: false` 和 `groupedTo`，
不静默处理。

## 5. generic 文档作为导入格式

把 §1 的 turns 文档加上内容标记，它就是一个**可导入的文件**。面板「从文件导入」会自动命中；
也可以用 `/import auto <path>`，或者 `import_chat({ format: "local-jsonl" })`：

```jsonc
{
  "interchange": "dsh-chat-import",   // 内容标记：探测层第一级判据
  "version": 1,                        // 只认 1；其它值整体拒绝并点名版本
  "meta": { "id": "…", "createdAt": 1710000000000, "cwd": "C:\\work", "sourceId": "…" },
  "title": "会话标题（可选）",
  "provider": "source-tool（可选，缺省 generic）",
  "model": "…（可选）",
  "turns": [ /* 与 §1 同构 */ ]
}
```

- **探测**：文件导入的第一级判据就是内容标记。`"interchange"` 命中本格式，`"bundle"`（§4 的便携包）转给 `restore_bundle`。按契约，标记出现在文档顶部，而探测只扫前 64KB。一旦命中，就以标记为准，不再逐个格式去猜。
- **校验与降级**：按 D4「失败要大声」，绝不静默。下列情况全部计数，并随结果透出：未知内容块类型；拿不到合法载荷的图片（降级为 `[image]` 文本并计入 `imagesDegraded`）；畸形的轮与步；没有对应调用的工具结果；input / output 不是非负整数的 `usage`。0 轮的文档会给一个 `skipReason`，导入端据此拒绝，不产出没有对话的空壳会话。
- **会话 id**：一律由插件铸造，格式是 `import-<slug>`，slug 优先取 `meta.sourceId`，其次取 `meta.id`。文档只提供 slug 的来源；命名约定与副本命名（`import-<id>-<n>`）都不由来源决定。工具面可以用 `sessionId` 显式覆盖。
- **字段能力**：`turns[i].time`、`steps[j].time`、`toolResults[k].time`、`steps[j].usage`、`turns[i].compaction` 与 `shadowed`、`promptBlocks`，都与各源转换器产出的 IR 同构。§2 的能力矩阵与 §3 的降级规则逐条适用。
- **用途**：长尾来源的落点。任意外部工具的转录，只要写成这份文档，就能按普通文件导入，不必为每个来源内置转换器（识别失败时的三个出口之一就是它）。它是**导入侧**的契约；导出与备份方向仍然走 §4 的便携包，那个是事件级无损的。

