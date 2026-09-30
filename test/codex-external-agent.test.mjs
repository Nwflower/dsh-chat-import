// codex-external-agent.test.mjs — Codex Desktop「外部 agent 会话导入」展平信封的还原契约。
// 夹具全合成，无真实 transcript。
//
// 锁定的契约（lib/convert/codex.mjs 的 splitExternalAgentEnvelopes / externalAgentArguments）：
//   * Codex Desktop 的 session import 把 foreign 工具调用展平成 assistant 正文里的文本信封
//     （[external_agent_tool_call: <Name>]…[/external_agent_tool_call] 与
//      [external_agent_tool_result[: error]]…[/external_agent_tool_result]），信封与正文可
//     混排在同一个 output_text 块里、一块可含多个信封 —— 直接当正文导入会被 markdown 渲染
//     （python 命令里的 `# 注释` 行会变成巨型标题），故按段切分并还原成 tool-call/tool-result。
//   * 还原不虚构：载荷键名与内容照抄信封（Codex 把 file_path 写成 file、丢掉 Edit/Write 正文，
//     本层不补）；结果不带 call_id，按「最早未配对调用」FIFO 配对。
//   * 降级要大声：未闭合信封 / 认不出的载荷 / 未知结果标记 → 留在正文 + malformed 计数；
//     找不到调用的结果 → 原样保留正文 + orphanResults 计数。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertCodexJsonl, splitExternalAgentEnvelopes, externalAgentArguments } from '../lib/convert/index.mjs'

const T0 = '2026-09-25T01:00:00.000Z'
const metaLine = (id) => JSON.stringify({ timestamp: T0, type: 'session_meta', payload: { id, timestamp: T0, cwd: 'D:\\demo\\proj' } })
const userLine = (text) => JSON.stringify({ timestamp: T0, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
const asstLine = (text) => JSON.stringify({ timestamp: T0, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })
const session = (id, ...blocks) => [metaLine(id), userLine('看看这个'), ...blocks.map(asstLine)].join('\n')

const callEnv = (name, payload) => `[external_agent_tool_call: ${name}]\n${payload}\n[/external_agent_tool_call]`
const resultEnv = (text, marker) => `[external_agent_tool_result${marker ? ': ' + marker : ''}]\n${text}\n[/external_agent_tool_result]`

const blocksOf = (out) => out.events.filter((e) => e.type === 'assistant/message').map((e) => e.data.message.content)
const callsOf = (out) => out.events.filter((e) => e.type === 'tool/call')
const resultsOf = (out) => out.events.filter((e) => e.type === 'tool/result')

// ── 1. 信封 → tool-call / tool-result 块（不再是正文） ──
test('codex 外部导入信封：调用与结果还原为 tool-call / tool-result，且不再留在正文里', () => {
  const out = convertCodexJsonl(session('codex-ext-1',
    callEnv('Bash', 'description: 看一眼\ncommand: ls -la'),
    resultEnv('total 0'),
  ), { sessionId: 'codex-ext-1' })

  const calls = callsOf(out)
  const results = resultsOf(out)
  assert.equal(calls.length, 1)
  assert.equal(results.length, 1)
  assert.equal(calls[0].data.name, 'Bash')
  assert.deepEqual(JSON.parse(calls[0].data.arguments), { description: '看一眼', command: 'ls -la' })
  // 结果正文照抄信封内容
  assert.deepEqual(results[0].data.message.content[0].content, [{ type: 'text', text: 'total 0' }])
  assert.equal(results[0].data.message.content[0].toolCallId, calls[0].data.callId)
  // 正文里不留信封标记
  const text = blocksOf(out).flat().filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  assert.equal(text.includes('external_agent_tool'), false)
  assert.deepEqual(out.externalAgent, { calls: 1, results: 1, orphanResults: 0, malformed: 0 })
})

// ── 2. 混排：同一文本块里的正文 + 信封按段切分（实测 776 块如此） ──
test('codex 外部导入信封：正文与信封混排在同一块时按段切分，正文保持为文本块', () => {
  const out = convertCodexJsonl(session('codex-ext-2',
    '先说结论。\n\n' + callEnv('Read', 'file: D:\\proj\\a.sql'),
    '重复一遍：\n' + resultEnv('SELECT 1') + '\n收尾。',
  ), { sessionId: 'codex-ext-2' })

  const blocks = blocksOf(out).flat()
  assert.deepEqual(blocks.map((b) => b.type), ['text', 'tool-call', 'text', 'text'])
  assert.equal(blocks[0].text, '先说结论。')
  // 结果块之后的正文留在同一 step 的文本块里
  assert.deepEqual(blocks.slice(2).map((b) => b.text), ['重复一遍：', '收尾。'])
  assert.equal(callsOf(out).length, 1)
  assert.equal(resultsOf(out).length, 1)
})

// ── 3. 一块多个信封 ──
test('codex 外部导入信封：一个文本块含多个信封时全部还原（实测 102 块如此）', () => {
  const out = convertCodexJsonl(session('codex-ext-3',
    [callEnv('Read', 'file: a.sql'), callEnv('Bash', 'command: echo 1')].join('\n\n'),
    [resultEnv('a 的内容'), resultEnv('1')].join('\n\n'),
  ), { sessionId: 'codex-ext-3' })

  assert.deepEqual(callsOf(out).map((e) => e.data.name), ['Read', 'Bash'])
  // FIFO 配对：第一条结果归第一个调用
  const results = resultsOf(out)
  assert.equal(results.length, 2)
  assert.equal(results[0].data.message.content[0].toolCallId, callsOf(out)[0].data.callId)
  assert.equal(results[1].data.message.content[0].toolCallId, callsOf(out)[1].data.callId)
  assert.deepEqual(JSON.parse(callsOf(out)[1].data.arguments), { command: 'echo 1' })
})

// ── 4. `input: {json}` 载荷原样作 arguments ──
test('codex 外部导入信封：input:{JSON} 载荷原样作为 arguments（不重组）', () => {
  const json = '{"pattern":"TRAIT_X|TRAIT_Y","path":"D:\\\\p\\\\a.sql","-n":true}'
  const out = convertCodexJsonl(session('codex-ext-4', callEnv('Grep', 'input: ' + json)), { sessionId: 'codex-ext-4' })
  assert.equal(callsOf(out)[0].data.arguments, json)
  assert.equal(out.externalAgent.malformed, 0)
})

test('codex 外部导入信封：多行 input JSON 同样识别', () => {
  const out = convertCodexJsonl(session('codex-ext-5', callEnv('mcp__db__query', 'input: {\n  "sql": "SELECT 1"\n}')), { sessionId: 'codex-ext-5' })
  assert.deepEqual(JSON.parse(callsOf(out)[0].data.arguments), { sql: 'SELECT 1' })
})

// ── 5. key: value 载荷：多行值、Windows 路径不误判为 key ──
test('codex 外部导入信封：key:value 载荷逐键组对象，多行 command 不断键、Windows 路径不误判', () => {
  const out = convertCodexJsonl(session('codex-ext-6', callEnv('Bash',
    'description: 建库\ncommand: cd "D:\\a\\b"\npython - <<\'EOF\'\nimport sqlite3\n# C: 不是 key\nEOF',
  )), { sessionId: 'codex-ext-6' })
  assert.deepEqual(JSON.parse(callsOf(out)[0].data.arguments), {
    description: '建库',
    command: 'cd "D:\\a\\b"\npython - <<\'EOF\'\nimport sqlite3\n# C: 不是 key\nEOF',
  })
  assert.equal(out.externalAgent.malformed, 0)
})

// ── 6. 结果标记 error → isError ──
test('codex 外部导入信封：result 的 error 标记 → isError:true（唯一实测标记）', () => {
  const out = convertCodexJsonl(session('codex-ext-7',
    callEnv('Bash', 'command: false'),
    resultEnv('command failed', 'error'),
  ), { sessionId: 'codex-ext-7' })
  assert.equal(resultsOf(out)[0].data.message.content[0].isError, true)
  assert.equal(out.externalAgent.malformed, 0)
})

// ── 7. 降级：未闭合信封 / 未知标记 / 认不出的载荷 → 正文 + malformed ──
test('codex 外部导入信封：未闭合信封留在正文并计入 malformed（内容不丢）', () => {
  const out = convertCodexJsonl(session('codex-ext-8',
    '[external_agent_tool_call: Bash]\ncommand: ls',
  ), { sessionId: 'codex-ext-8' })

  assert.equal(callsOf(out).length, 0)
  assert.equal(out.externalAgent.calls, 0)
  assert.equal(out.externalAgent.malformed, 1)
  const text = blocksOf(out).flat().map((b) => b.text).join('\n')
  assert.equal(text.includes('[external_agent_tool_call: Bash]'), true)
})

test('codex 外部导入信封：未知结果标记 / 认不出的载荷 → 仍还原但计入 malformed', () => {
  const out = convertCodexJsonl(session('codex-ext-9',
    callEnv('Bash', '这不是 key:value 也不是 input JSON'),
    resultEnv('ok', 'weird'),
  ), { sessionId: 'codex-ext-9' })

  assert.equal(callsOf(out).length, 1)
  assert.deepEqual(JSON.parse(callsOf(out)[0].data.arguments), { input: '这不是 key:value 也不是 input JSON' })
  assert.equal(out.externalAgent.malformed, 2)
})

// ── 8. 降级：找不到调用的结果保留原文作正文并计数 ──
test('codex 外部导入信封：无对应调用的结果保留原文信封作正文，计入 orphanResults', () => {
  const out = convertCodexJsonl(session('codex-ext-10', resultEnv('孤零零的结果')), { sessionId: 'codex-ext-10' })

  assert.equal(resultsOf(out).length, 0)
  assert.equal(out.externalAgent.orphanResults, 1)
  const text = blocksOf(out).flat().map((b) => b.text).join('\n')
  assert.equal(text.includes('孤零零的结果'), true)
  assert.equal(text.includes('[/external_agent_tool_result]'), true)
})

// ── 9. 无信封的块行为不变（回归保护）＋ 空块不再凭空开一步 ──
test('codex 外部导入信封：普通文本块与工具生命周期不受影响，无信封时不占 externalAgent 键', () => {
  const out = convertCodexJsonl(session('codex-ext-11', '就是一段普通正文\n\n带空行'), { sessionId: 'codex-ext-11' })
  assert.equal(out.externalAgent, undefined)
  assert.deepEqual(blocksOf(out).flat(), [{ type: 'text', text: '就是一段普通正文\n\n带空行' }])
})

// ── 10. 事件层不变量：工具生命周期在同一步内闭合、每个调用恰一条结果 ──
test('codex 外部导入信封：还原后的工具生命周期满足宿主不变量（同 step 闭合 / 一调用一结果）', () => {
  const out = convertCodexJsonl(session('codex-ext-12',
    callEnv('Bash', 'command: a'),
    callEnv('Bash', 'command: b'),
    resultEnv('a 的输出'),
    resultEnv('b 的输出'),
  ), { sessionId: 'codex-ext-12' })

  const stepOf = new Map()
  for (const e of out.events) {
    if (e.type === 'step/start') stepOf.set(e.data.step, e.data.turn)
    if (e.type === 'tool/call') assert.equal(stepOf.has(e.data.step), true)
  }
  const callIds = callsOf(out).map((e) => e.data.callId)
  const resultIds = resultsOf(out).map((e) => e.data.message.content[0].toolCallId)
  assert.deepEqual(resultIds, callIds)
  assert.equal(new Set(callIds).size, callIds.length)
})

// ── 11. 纯函数：切分与载荷解析 ──
test('splitExternalAgentEnvelopes：无信封时按字节原样返回单段', () => {
  const src = '原样\n\n带缩进  '
  const { segments, malformed } = splitExternalAgentEnvelopes(src)
  assert.deepEqual(segments, [{ kind: 'text', text: src }])
  assert.equal(malformed, 0)
})

test('externalAgentArguments：空载荷 → {}；标量 input → 走 key:value 兜底', () => {
  assert.deepEqual(externalAgentArguments(''), { arguments: '{}', malformed: false })
  assert.deepEqual(externalAgentArguments('   '), { arguments: '{}', malformed: false })
  assert.deepEqual(externalAgentArguments('input: 42'), { arguments: '{"input":"42"}', malformed: false })
})
