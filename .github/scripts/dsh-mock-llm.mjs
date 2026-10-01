// .github/scripts/dsh-mock-llm.mjs — CI smoke 用的离线 mock LLM。
// 由 ci.yml 的 smoke job 后台启动；无真实凭据、无外网依赖、结果确定。
//
// 同时覆盖两代 dsh 的 wire，缺哪个都会让 smoke 恒红：
//   * Messages API（dsh-llm-deepseek ≥ 0.1.7 的当前 wire）：POST {base}/v1/messages，
//     SSE 事件序列 message_start → content_block_start/delta/stop → message_delta →
//     message_stop；路径与事件形状照抄宿主 messages-api / translate 的契约
//     （baseURL 末尾不是 /v1 时自动补 /v1）。
//   * OpenAI 兼容（更早的适配器）：POST /chat/completions，chat.completion.chunk 流。
// 只留 OpenAI 一路会让适配器切到 Messages 后的 smoke 报 404
//（"DeepSeek Messages request failed (404)"）。
import { createServer } from 'node:http'

const PORT = 8790
const MODEL = 'deepseek-v4-flash'

const sse = (payload) => `data: ${JSON.stringify(payload)}\n\n`

/** OpenAI 兼容分片（旧适配器）。 */
const openAiChunk = (id, delta, finish, usage) => {
  const chunk = { id, object: 'chat.completion.chunk', created: 1700000000, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish ?? null }] }
  if (usage) chunk.usage = usage
  return sse(chunk)
}

/** Anthropic Messages 事件（当前适配器；形状见 dsh-llm-deepseek 的 tests/mock-server）。 */
const messagesEvents = () => [
  { type: 'message_start', message: { id: 'msg_smoke', model: MODEL, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'smoke ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
]

const json = (res, body) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))

const stream = (res, frames) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  for (const frame of frames) res.write(frame)
  res.end()
}

createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  // ci.yml 的就绪探针（顺带兼容旧适配器的模型列表请求）
  if (req.method === 'GET' && (path === '/models' || path === '/v1/models')) {
    json(res, { object: 'list', data: [{ id: MODEL }] })
    return
  }
  req.resume() // mock 不读请求体，丢弃即可
  req.on('end', () => {
    if (req.method !== 'POST') {
      res.writeHead(404).end('not found')
      return
    }
    // Messages API：baseURL 补 /v1 后的主路径（/anthropic/v1/messages 也认，便于显式配根）
    if (path === '/v1/messages' || path === '/anthropic/v1/messages') {
      stream(res, messagesEvents().map(sse))
      return
    }
    if (path === '/chat/completions' || path === '/v1/chat/completions') {
      stream(res, [
        openAiChunk('chatcmpl-smoke', { role: 'assistant', content: 'smoke ok' }, null),
        openAiChunk('chatcmpl-smoke', {}, 'stop', { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }),
        'data: [DONE]\n\n',
      ])
      return
    }
    res.writeHead(404).end('not found')
  })
}).listen(PORT, '127.0.0.1')
