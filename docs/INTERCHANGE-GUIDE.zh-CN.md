# Interchange 转换指南（给 Agent 的 Skill 指令）

> 读者：要把一份「未识别」的对话记录转换成 dsh-chat-import 可导入格式的 Agent（或脚本作者）。
> 本文自包含——完成转换不需要读其它文档。协议完整规范（各源能力矩阵 / 降级规则表 / 便携 bundle）
> 见 [INTERCHANGE.md](INTERCHANGE.md)，本文只讲「怎么把任意格式转进来」。
> English version: [INTERCHANGE-GUIDE.md](INTERCHANGE-GUIDE.md)

## 你的任务

源文件是某个工具的对话导出，插件的全部解析器都不认识它。你要把它转换成一份
**interchange v1 会话文档**（一个 JSON 文件），写入新文件，交还给用户重新导入。

## 产出要求（硬性）

1. **严格 JSON**：`JSON.parse` 必须能过——无注释、无尾逗号、UTF-8 编码。
2. 顶层对象必须含 `"interchange": "dsh-chat-import"` 且 `"version": 1`；
   这对标记是探测的第一级判据，**必须出现在文件前 64KB 内**（放在文档最顶部即可）。
3. `turns` 至少包含 1 个有效轮次。空轮（无 `prompt`、无 `steps`、无 `compaction`）
   会被丢弃计数；全部轮次被丢弃 = 整个文件拒绝导入。
4. **不虚构内容**：源文件里没有的（工具结果、时间戳、token 用量）宁可缺省，不要编造。
5. **写新文件，不改源文件**。建议命名 `<源文件名>.interchange.json`。
6. 时间戳一律用**毫秒**（Unix epoch ms）。

## 最小合法文档

```json
{
  "interchange": "dsh-chat-import",
  "version": 1,
  "meta": { "id": "my-tool-session-1", "createdAt": 1710000000000 },
  "turns": [
    {
      "prompt": "你好",
      "steps": [
        { "content": [{ "type": "text", "text": "你好！有什么可以帮你？" }] }
      ]
    }
  ]
}
```

## 字段表

### 顶层

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `interchange` | ✅ | 恒为 `"dsh-chat-import"`（内容标记） |
| `version` | ✅ | 恒为 `1`；其它值整体拒绝并点名版本 |
| `meta.id` / `meta.sourceId` | 建议 | 会话 id 的 slug 来源（最终 id 由插件铸成 `import-<slug>`） |
| `meta.createdAt` | 建议 | 毫秒；缺失时取导入时刻 |
| `meta.cwd` | 可选 | 工作目录；缺失时落入专用导入工作区 |
| `title` | 可选 | 会话标题；缺省取首轮 `prompt`（折叠空白、80 字符截断） |
| `provider` | 可选 | 来源名（缺省 `generic`），显示在会话元信息里 |
| `model` | 可选 | 源模型名 |
| `turns` | ✅ | 轮次数组 |

### turn（轮）：一条用户提问 + 其后的助手消息

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `prompt` | 条件必填 | 提问文本。`prompt` / `steps` / `compaction` 三者至少其一，否则整轮丢弃 |
| `promptBlocks` | 可选 | 提问带图时的完整内容块（缺省 = 单个 text 块） |
| `steps` | 条件必填 | 步骤数组（见下） |
| `time` | 可选 | 该轮提问时间（毫秒） |
| `aborted` | 可选 | `true` 表示该轮被中断 |
| `compaction` | 可选 | `{ "summary": "…", "provider"?, "model"?, "time"? }`——本轮之前发生过上下文压缩 |
| `shadowed` | 可选 | 该轮已被后续压缩遮蔽 |

### step（步）：一条助手消息（含它的工具调用与结果）

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `content` | 建议 | 内容块数组（类型见下） |
| `toolCalls` | 可选 | `[{ "id", "name", "arguments" }]`；`arguments` 字符串或对象皆可（对象会被序列化） |
| `toolResults` | 可选 | `[{ "toolCallId", "content": [...], "isError"?, "time"? }]` |
| `time` | 可选 | 该步助手消息时间（毫秒） |
| `model` | 可选 | 该步自己的模型（中途换模型时逐步骤记名） |
| `usage` | 可选 | `{ "inputTokens", "outputTokens", "cacheReadTokens"?, "cacheWriteTokens"?, "reasoningTokens"? }`，全部非负整数 |

**内容块类型**：`text`（`{ "type": "text", "text" }`）、`reasoning`（同形）、
`image`（见下）、`tool-call`（`{ "type": "tool-call", "id", "name", "arguments" }`）、
`tool-result`（`{ "type": "tool-result", "toolCallId", "content": [...], "isError"? }`）。
未知块类型会被丢弃并计入 `skippedBlocks`。

**配对不变量**：每个 `toolResults[].toolCallId` 必须能在某一步的 `toolCalls` 里找到
对应 `id`——找不到的结果会被**丢弃并计入 `droppedToolResults`**。反过来，有调用没结果
不要紧（插件会兜底补空结果），但源里有结果就一定要配对写上。工具调用既可以写在
`content` 里（`tool-call` 块），也可以写在显式 `toolCalls` 列表里，两者等价、按 id 去重。

**图片块**：带字节 `{ "type": "image", "data": "<base64>", "mediaType": "image/png", "name"? }`
（mediaType 收 PNG/JPEG/WebP/GIF）。源里只有图片 URL 或本地路径时，读得到字节就转 base64；
**拿不到字节就整块省略，不要伪造 `data`**——非法图片会降级为 `[image]` 占位文本并计入
`imagesDegraded`。

## 完整示例（工具调用 + 图片 + usage + compaction）

```json
{
  "interchange": "dsh-chat-import",
  "version": 1,
  "meta": { "id": "tool-x-2026-10-03", "createdAt": 1759478400000, "cwd": "C:\\work" },
  "title": "修复登录页样式",
  "provider": "tool-x",
  "model": "tool-x-pro",
  "turns": [
    {
      "prompt": "看这张截图，登录按钮偏了",
      "promptBlocks": [
        { "type": "text", "text": "看这张截图，登录按钮偏了" },
        { "type": "image", "data": "<base64>", "mediaType": "image/png", "name": "shot.png" }
      ],
      "time": 1759478400000,
      "steps": [
        {
          "content": [
            { "type": "reasoning", "text": "先看样式文件" },
            { "type": "text", "text": "我来检查登录页样式。" },
            { "type": "tool-call", "id": "call-1", "name": "read", "arguments": "{\"path\":\"login.css\"}" }
          ],
          "toolCalls": [
            { "id": "call-1", "name": "read", "arguments": "{\"path\":\"login.css\"}" }
          ],
          "toolResults": [
            { "toolCallId": "call-1", "content": [{ "type": "text", "text": ".login-btn { margin: 0 }" }], "isError": false }
          ],
          "time": 1759478405000,
          "usage": { "inputTokens": 1200, "outputTokens": 180 }
        }
      ]
    },
    {
      "prompt": "改成居中",
      "compaction": { "summary": "前文压缩：用户在调登录页样式", "provider": "tool-x" },
      "steps": [
        { "content": [{ "type": "text", "text": "已改为 margin: 0 auto。" }] }
      ]
    }
  ]
}
```

## 转换步骤

1. 读源文件，识别每条消息的角色（用户 / 助手 / 工具）与顺序。
2. 一条用户提问开一个 `turn`（`prompt`）；其后直到下一条用户提问之前的助手消息，
   按顺序成为该轮的 `steps`。
3. 助手消息里的工具调用与工具结果按 id 配对，放进**同一步**的 `toolCalls` / `toolResults`。
4. 时间戳统一转毫秒；usage 数字取非负整数（不是整数就整条 `usage` 省略）。
5. 写出 JSON 文件，过一遍下面的自检清单。
6. 把新文件路径交给用户，提示重新预览并导入。

## 自检清单（交付前逐项过）

- [ ] `JSON.parse` 能通过（无注释、无尾逗号）
- [ ] `"interchange": "dsh-chat-import"` 与 `"version": 1` 在文件最顶部
- [ ] 每个 `toolResults[].toolCallId` 都有配对的 `toolCalls[].id`
- [ ] 没有空轮（每轮至少有 prompt / steps / compaction 之一）
- [ ] `usage` 的 `inputTokens` / `outputTokens` 是非负整数
- [ ] 所有时间戳是毫秒
- [ ] 没有虚构源文件里不存在的内容

## 导入与验证

- **面板**：「从文件导入」粘贴新文件路径回车 → 只读预览。成功标志：
  识别显示 `generic · 文件标记`，轮 / 消息 / 工具调用计数与源一致，降级计数
  （畸形轮步 / 跳过块 / 丢弃工具结果 / 用量缺失 / 图片）全为 0 或可逐条解释。
  确认后点「导入」。
- **命令**：`/import auto <路径>`（`local-jsonl` 同义）。
- **工具**：`import_chat({ format: "local-jsonl", path })`（先 dry-run 预览再正式导入）。

如果预览显示「所有对话格式解析器全部解析失败」，展开失败清单看 `generic` 那行的原因——
它直接指出文档哪里不合法（不是合法 JSON / 版本不符 / 没有可导入的轮次）。

## 常见错误 → 后果

| 错误 | 后果 |
| --- | --- |
| JSON 带注释 / 尾逗号 | 整体拒绝：「文档不是合法 JSON」 |
| 标记不在前 64KB | 探测不到，按未知格式处理 |
| `version` 不是 `1` | 整体拒绝并点名版本 |
| toolResult 无配对调用 | 该结果丢弃，计 `droppedToolResults` |
| `usage` 含非整数 | 该条 usage 丢弃，计 `usageDropped` |
| 空轮 | 丢弃，计 `malformedTurns`；全空则拒绝导入 |
| 图片无合法 `data` | 降级为 `[image]` 文本，计 `imagesDegraded` |
| 未知内容块类型 | 丢弃，计 `skippedBlocks` |
