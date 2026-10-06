// convert-shared.test.mjs — 转换层共享件（事件合成 / 校验 / 预算 / 互转约定）
// synthesizeSession、validateSessionEvents、tailSessionEvents、trim/budget、util、注入信封、层边界、settlement。
// 由 test/convert.test.mjs 按主题拆出（纯移动：用例与断言未改）。
import { test } from 'node:test'
import { codexCompactedRollout } from './_support/codex-compacted.mjs'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { convertClaudeJsonl, convertCodexJsonl, convertCursorJsonl, convertGeminiJson, convertReasonixJsonl, convertPiJsonl, convertOpencodeJson, convertQoderJsonl, mintSessionId, parseTime, parseTimeMs, tailSessionEvents, estimateTokens, cropContentBlocks, trimTurns, applyBudgetTrim, TEXT_BLOCK_CHAR_LIMIT, TOOL_RESULT_CHAR_LIMIT, validateSessionEvents, isEnvInjectionEvent } from '../lib/convert/index.mjs'
import { synthesizeSession } from '../lib/convert/core.mjs'
import { contentText } from '../lib/convert/util.mjs'
import { assertToolPairing, assertMessageOrderLegal } from './_support/session-invariants.mjs'
import { loadFixture } from './_support/fixtures.mjs'
const load = loadFixture

function threeTurnClaude() {
  return [
    '{"sessionId":"sess-incr-001","type":"user","message":{"role":"user","content":"第一个问题"}}',
    '{"sessionId":"sess-incr-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"第一个回答"}]}}',
    '{"sessionId":"sess-incr-001","type":"user","message":{"role":"user","content":"第二个问题"}}',
    '{"sessionId":"sess-incr-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"好"},{"type":"tool_use","id":"toolu_01","name":"Read","input":{"file":"a.txt"}}]}}',
    '{"sessionId":"sess-incr-001","type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":[{"type":"text","text":"A 内容"}]}]}}',
    '{"sessionId":"sess-incr-001","type":"user","message":{"role":"user","content":"第三个问题"}}',
    '{"sessionId":"sess-incr-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"第三个回答"}]}}',
    '{"sessionId":"sess-incr-001","type":"ai-title","aiTitle":"三回合会话"}',
  ].join('\n')
}

function textTurns(n, perTurnChars = 100) {
  const turns = []
  for (let i = 0; i < n; i++) {
    turns.push({
      prompt: '问题' + '字'.repeat(perTurnChars - 2) + i,
      steps: [{ content: [{ type: 'text', text: '回答' + '字'.repeat(perTurnChars - 2) + i }], toolCalls: [], toolResults: [] }],
    })
  }
  return turns
}

const ev = (seq, type, extra = {}) => ({ type, seq, time: 1, data: {}, ...extra })

test('turns=0 时不写 session/imported 标记（无可导入内容）', () => {
  // 有记录但无用户回合（纯 info 通知）：不产生空会话，也不加标记
  const info = convertGeminiJson(JSON.stringify({
    sessionId: 'gemini-info-only',
    startTime: '2026-04-17T18:09:18.567Z',
    messages: [{ id: 'i1', type: 'info', content: 'notice' }],
  }), { sourcePath: 'D:\\demo\\gemini\\info.json' })
  assert.equal(info.turns.length, 0)
  assert.equal(info.events.length, 0)
  assert.equal(info.events.some((e) => e.type === 'session/imported'), false)
  // 空输入同理（Claude）
  const empty = convertClaudeJsonl('', { sourcePath: 'D:\\demo\\proj\\empty.jsonl' })
  assert.equal(empty.turns.length, 0)
  assert.equal(empty.events.length, 0)
})

test('mintSessionId: 清理非法字符并截断', () => {
  assert.equal(mintSessionId('abc_123-def'), 'import-abc_123-def')
  // 全非法字符时回退为时间戳（仍是合法 id）
  assert.match(mintSessionId('中文/路径\\特殊:字符'), /^import-\d+$/)
  const long = mintSessionId('x'.repeat(200))
  assert.ok(long.length <= 8 + 64)
})

test('parseTime: 解析 ISO 时间戳', () => {
  const t = parseTime('2026-08-01T10:00:00.000Z')
  assert.equal(typeof t, 'number')
  assert.ok(t > 0)
  // 缺时间戳回退到当前时间：两次 Date.now() 之间可能跨毫秒，给窗口而不是等值比较
  const before = Date.now()
  const fallback = parseTime(undefined)
  assert.ok(fallback >= before && fallback - before < 1000)
})

test('纯函数层（lib/convert、lib/export）只 import 本层模块与无 IO 的 node 内建', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')
  const allowed = (layer, spec) => /^\.\/[\w-]+\.mjs$/.test(spec)
    || (layer === 'export' && /^\.\.\/convert\/[\w-]+\.mjs$/.test(spec))
    || spec === 'node:path' || spec === 'node:crypto'
  const offenders = []
  for (const layer of ['convert', 'export']) {
    for (const name of readdirSync(join(root, layer))) {
      if (!name.endsWith('.mjs')) continue
      const src = readFileSync(join(root, layer, name), 'utf8')
      for (const m of src.matchAll(/^(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]/gm)) {
        if (!allowed(layer, m[1])) offenders.push(layer + '/' + name + ' → ' + m[1])
      }
    }
  }
  assert.deepEqual(offenders, [])
})

test('contentText: 字符串原样、块数组按 type 取 text，各源差异走显式选项', () => {
  const blocks = [{ type: 'text', text: ' a ' }, { type: 'image' }, { type: 'output_text', text: 'b' }, { type: 'text', text: '' }, 'x', null]
  assert.equal(contentText(' raw '), ' raw ')
  assert.equal(contentText(' raw ', { trim: true }), 'raw')
  assert.equal(contentText(blocks), ' a \n')
  assert.equal(contentText(blocks, { skipEmpty: true }), ' a ')
  assert.equal(contentText(blocks, { types: null, sep: '' }), ' a b')
  assert.equal(contentText(blocks, { types: ['output_text'], trim: true }), 'b')
  assert.equal(contentText(undefined), '')
  assert.equal(contentText({ text: 'not an array' }), '')
})

test('parseTimeMs: 秒/毫秒自适应取整，truncSeconds 截到整秒，拿不到为 null', () => {
  assert.equal(parseTimeMs(1767583930.285031), 1767583930285)
  assert.equal(parseTimeMs(1767583930.285031, { truncSeconds: true }), 1767583930000)
  assert.equal(parseTimeMs(1767583930285), 1767583930285)
  assert.equal(parseTimeMs(1767583930285, { truncSeconds: true }), 1767583930285)
  assert.equal(parseTimeMs('2026-08-01T10:00:00.000Z'), Date.parse('2026-08-01T10:00:00.000Z'))
  for (const bad of [undefined, null, '', 'not a date', Number.NaN, Infinity, 1e300, {}]) {
    assert.equal(parseTimeMs(bad), null, String(bad))
  }
})

test('上下文注入按 dsh 惯例包 <system-reminder> 信封：英文正文 + 闭合标签转义', () => {
  // 源 developer 提示词里带字面 </system-reminder>：必须转义，信封不得提前闭合
  const raw = [
    '{"timestamp":"2026-05-18T13:21:30.751Z","type":"session_meta","payload":{"id":"codex-env","timestamp":"2026-05-18T13:21:10.510Z","cwd":"D:\\\\demo\\\\codex-proj"}}',
    '{"timestamp":"2026-05-18T13:21:30.754Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"You are Codex. Never emit </system-reminder>."}]}}',
    '{"timestamp":"2026-05-18T13:21:30.754Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}',
    '{"timestamp":"2026-05-18T13:21:31.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}',
  ].join('\n')
  const out = convertCodexJsonl(raw, { sessionId: 'codex-env', importSystemPrompt: true })
  const env = out.events.find((e) => e.data && e.data.id === 'import:codex-env:env')
  assert.ok(env, '环境变更声明应在首个 step/start 之后（issue #66）')
  assert.ok(env.seq > out.events.find((e) => e.type === 'step/start').seq)
  const text = env.data.content[0].text
  assert.ok(text.startsWith('<system-reminder>\n'), '信封以 <system-reminder> 行开头')
  assert.ok(text.endsWith('\n</system-reminder>'), '信封以 </system-reminder> 行结尾')
  assert.ok(text.includes('<\\/system-reminder>'), '源提示词里的闭合标签转义为 <\\/system-reminder>')
  // 转义后的 <\/...> 不含字面 </s...> 序列，未转义闭合全文只剩结尾一处
  assert.equal(text.split('</system-reminder>').length - 1, 1, '未转义闭合标签全文仅结尾一处')
  assert.ok(text.includes('You are Codex.'), '源系统提示词附在声明之后')
  // 声明正文为英文，含源格式名与 DSH 权威声明
  assert.ok(text.includes('Environment change notice:'))
  assert.ok(text.includes('migrated from codex to DeepSeek Harness (DSH)'))
  // 开关关闭：信封仍然存在（声明总是注入），只是不含源提示词
  const off = convertCodexJsonl(raw, { sessionId: 'codex-env' })
  const offText = off.events.find((e) => e.data && e.data.id === 'import:codex-env:env').data.content[0].text
  assert.ok(offText.startsWith('<system-reminder>\n') && offText.endsWith('\n</system-reminder>'))
  assert.ok(!offText.includes('You are Codex.'))
})

test('tailSessionEvents: 按 turn 切片、seq 从 fromSeq 连续重编号、续号用源编号', () => {
  const out = convertClaudeJsonl(threeTurnClaude(), { sourcePath: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  assert.equal(out.turns.length, 3)
  const fromSeq = 40 // 模拟已存日志长度
  const tail = tailSessionEvents(out, { fromTurn: 2, fromSeq })
  assert.equal(tail.firstTurn, 2)
  assert.equal(tail.droppedBoundaryResults, 0)
  // 尾部不含 session/imported 标记与 session/title（续写不重复写标记/标题）
  assert.ok(!tail.events.some((e) => e.type === 'session/imported'))
  assert.ok(!tail.events.some((e) => e.type === 'session/title'))
  // seq 从 fromSeq 连续
  tail.events.forEach((e, i) => assert.equal(e.seq, fromSeq + i))
  // 第一个事件是 turn2 的 turn/start；turn 续号用源编号（2、3）
  assert.equal(tail.events[0].type, 'turn/start')
  assert.equal(tail.events[0].data.turn, 2)
  const starts = tail.events.filter((e) => e.type === 'turn/start').map((e) => e.data.turn)
  assert.deepEqual(starts, [2, 3])
  // 尾部以 turn/end 收尾（平衡）；surfaceOp 保留
  assert.equal(tail.events.at(-1).type, 'turn/end')
  const surface = tail.events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message')
  assert.ok(surface.length > 0)
  for (const e of surface) assert.equal(e.surfaceOp, 'append')
  // 尾部事件集合 = 完整转换里 turn2 起的事件（session/title 被剥离）
  const headSeq = out.events.find((e) => e.type === 'turn/start' && e.data.turn === 2).seq
  const fromTurn2 = out.events.filter((e) => e.seq >= headSeq && e.type !== 'session/title')
  assert.equal(tail.events.length, fromTurn2.length)
  for (const [i, e] of fromTurn2.entries()) {
    assert.equal(tail.events[i].type, e.type)
    assert.deepEqual(tail.events[i].data, e.data)
  }
})

test('tailSessionEvents: 尾内 tool/result 的 sourceEventSeqs 重映射到新 seq', () => {
  const out = convertClaudeJsonl(threeTurnClaude(), { sourcePath: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  const tail = tailSessionEvents(out, { fromTurn: 2, fromSeq: 100 })
  const call = tail.events.find((e) => e.type === 'tool/call')
  const result = tail.events.find((e) => e.type === 'tool/result')
  assert.ok(call)
  assert.ok(result)
  assert.equal(call.data.callId, 'toolu_01')
  // 重映射后 result 指向尾内 call 的新 seq
  assert.deepEqual(result.sourceEventSeqs, [call.seq])
  // 尾部事件不引用旧 seq（全部落在 [fromSeq, fromSeq+len) 内）
  for (const e of tail.events) {
    if (Array.isArray(e.sourceEventSeqs)) {
      for (const s of e.sourceEventSeqs) assert.ok(s >= 100)
    }
  }
})

test('tailSessionEvents: 续写尾部不重复注入环境变更声明（issue #66）', () => {
  const out = convertClaudeJsonl(threeTurnClaude(), { sourcePath: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  const env = out.events.find(isEnvInjectionEvent)
  assert.ok(env, '完整转换含一条环境变更声明')
  // 声明位于首个 step/start 之后（写入位契约）
  const firstStep = out.events.find((e) => e.type === 'step/start')
  assert.ok(env.seq > firstStep.seq)
  // 尾部（含首轮切片的极端情形）不携带声明：前段已有一条，续写不得在对话中间再插一条
  for (const fromTurn of [1, 2, 3]) {
    const tail = tailSessionEvents(out, { fromTurn, fromSeq: 50 })
    assert.ok(!tail.events.some(isEnvInjectionEvent), 'fromTurn=' + fromTurn + ' 的尾部不得含声明')
  }
  // 声明是 plugin 注入：不计入真实消息数（既有口径不变）——3 问 + 4 条 assistant
  assert.equal(out.messages, 7)
})

test('tailSessionEvents: dropSessionEvents=false 保留 session/title（标题 last-wins 无害）', () => {
  const out = convertClaudeJsonl(threeTurnClaude(), { sourcePath: 'D:\\demo\\proj\\sess-incr-001.jsonl' })
  const tail = tailSessionEvents(out, { fromTurn: 3, fromSeq: 200, dropSessionEvents: false })
  const titleEv = tail.events.find((e) => e.type === 'session/title')
  assert.ok(titleEv)
  assert.equal(titleEv.data.title, '三回合会话')
  assert.equal(titleEv.seq, tail.events.at(-1).seq) // title 钉在尾部末尾
  // 默认剥离
  const stripped = tailSessionEvents(out, { fromTurn: 3, fromSeq: 200 })
  assert.ok(!stripped.events.some((e) => e.type === 'session/title'))
})

test('tailSessionEvents: 指向尾外的 sourceEventSeqs 原样保留并计 droppedBoundaryResults', () => {
  // 合成一个跨界场景：turn2 的 tool/result 引用 turn1 的 tool/call（跨轮异步结果）。
  // 手工构造 converted 事件：turn1 含 call（seq 5），turn2 含 result（sourceEventSeqs=[5]）。
  const ev = (type, seq, data, extra) => ({ type, seq, data, ...extra })
  const converted = {
    events: [
      ev(0, {}),
      ev('turn/start', 1, { turn: 1 }),
      ev('user/message', 2, {}, { surfaceOp: 'append' }),
      ev('assistant/message', 3, {}, { surfaceOp: 'append' }),
      ev('tool/call', 4, { callId: 'toolu_x' }),
      ev('turn/end', 5, { turn: 1 }),
      ev('turn/start', 6, { turn: 2 }),
      ev('user/message', 7, {}, { surfaceOp: 'append' }),
      ev('tool/result', 8, { toolCallId: 'toolu_x' }, { surfaceOp: 'append', sourceEventSeqs: [4] }),
      ev('turn/end', 9, { turn: 2 }),
    ],
    turns: [{}, {}],
  }
  const tail = tailSessionEvents(converted, { fromTurn: 2, fromSeq: 50 })
  assert.equal(tail.droppedBoundaryResults, 1)
  const result = tail.events.find((e) => e.type === 'tool/result')
  // 指向尾外的引用原样保留（前段 seq 未变，旧值仍指向真实调用）
  assert.deepEqual(result.sourceEventSeqs, [4])
  assert.deepEqual(tail.events.map((e) => e.seq), [50, 51, 52, 53])
})

test('estimateTokens: CJK 1 token/字、ASCII 1 token/4 字符', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('汉字测试'), 4)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcdefgh'), 2)
  assert.equal(estimateTokens('a'.repeat(5)), 2) // ceil(5/4)
  assert.equal(estimateTokens('汉a'), 2) // 1 + ceil(1/4)
  assert.equal(estimateTokens('，。'), 2) // CJK 标点按 CJK 计
  assert.equal(estimateTokens(null), 0)
  assert.equal(estimateTokens(undefined), 0)
  assert.equal(estimateTokens(123), 0) // 非字符串按 0
})

test('cropContentBlocks: 超限文本保留头 75% + 尾、未超限原样、tool-result 内部块按结果上限', () => {
  const long = 'A'.repeat(100) + 'B'.repeat(20000)
  const r1 = cropContentBlocks([{ type: 'text', text: long }])
  assert.equal(r1.cropped, 1)
  const out1 = r1.blocks[0].text
  assert.ok(out1.length <= TEXT_BLOCK_CHAR_LIMIT)
  assert.ok(out1.startsWith('A'.repeat(100))) // 头保留
  assert.ok(out1.endsWith('B'.repeat(100))) // 尾保留
  assert.ok(out1.includes('…（已裁剪）…'))

  const short = { type: 'text', text: 'short' }
  const r2 = cropContentBlocks([short])
  assert.equal(r2.cropped, 0)
  assert.deepEqual(r2.blocks, [short])

  // reasoning 同样按文本上限裁剪
  const reasoning = { type: 'reasoning', text: 'R'.repeat(TOOL_RESULT_CHAR_LIMIT + 10) }
  const r3 = cropContentBlocks([reasoning], { textLimit: TOOL_RESULT_CHAR_LIMIT })
  assert.equal(r3.cropped, 1)
  assert.ok(r3.blocks[0].text.length <= TOOL_RESULT_CHAR_LIMIT)

  // tool-result 内部块按工具结果上限（默认 40K）裁剪
  const toolResult = { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'T'.repeat(TOOL_RESULT_CHAR_LIMIT + 10) }] }
  const r4 = cropContentBlocks([toolResult])
  assert.equal(r4.cropped, 1)
  assert.ok(r4.blocks[0].content[0].text.length <= TOOL_RESULT_CHAR_LIMIT)

  // savedTokens = 被裁内容的估算 token 减少量（增量修正 trim 的 L1 估算，免去二次全量走查）：
  // 未裁剪时为 0；裁剪后等于 原文估算 − 裁后估算（口径与 estimateTokens 一致）。
  assert.deepEqual(cropContentBlocks([short]), { blocks: [short], cropped: 0, savedTokens: 0 })
  const r5 = cropContentBlocks([{ type: 'text', text: long }])
  assert.equal(r5.cropped, 1)
  assert.equal(r5.savedTokens, estimateTokens(long) - estimateTokens(r5.blocks[0].text))
  assert.ok(r5.savedTokens > 0)

  // 非数组安全
  assert.deepEqual(cropContentBlocks(undefined), { blocks: [], cropped: 0, savedTokens: 0 })
})

test('trimTurns: 预算内会话原样保留（无截断、无摘要）', () => {
  const turns = textTurns(2, 10)
  const { turns: out, trimmed } = trimTurns(turns, 100000)
  assert.equal(out.length, 2)
  assert.equal(trimmed.droppedTurns, 0)
  assert.equal(trimmed.droppedMessages, 0)
  assert.equal(trimmed.summaryInserted, false)
  assert.equal(trimmed.estimatedTokens, trimmed.originalTokens)
  assert.equal(out[0].prompt, turns[0].prompt) // 未裁剪
})

test('trimTurns: 超长会话保留开头锚点 3 条 user 文本 + 摘要 + 尾部，总估算 ≤ 预算', () => {
  const turns = textTurns(40, 100) // ~40×200 = 8000 tokens > 3×2000
  const { turns: out, trimmed } = trimTurns(turns, 2000)
  assert.ok(trimmed.droppedTurns > 0)
  assert.equal(trimmed.droppedTurns, 40 - out.length)
  assert.ok(trimmed.summaryInserted)
  assert.ok(trimmed.estimatedTokens <= 2000)
  assert.ok(trimmed.originalTokens > 3 * 2000)
  // 开头锚点：前 3 轮原样保留（prompt 未动）
  assert.equal(out[0].prompt, turns[0].prompt)
  assert.equal(out[1].prompt, turns[1].prompt)
  assert.equal(out[2].prompt, turns[2].prompt)
  // 尾部保留：最后一轮在尾部
  assert.equal(out.at(-1).prompt, turns[39].prompt)
  // 摘要作为 reasoning 块前置到首个保留尾部轮
  const firstTail = out[3]
  assert.equal(firstTail.steps[0].content[0].type, 'reasoning')
  assert.ok(firstTail.steps[0].content[0].text.includes('导入预算裁剪'))
  // 输入未被修改（纯函数）
  assert.equal(turns.length, 40)
  assert.equal(turns[0].prompt, '问题' + '字'.repeat(98) + '0')
})

test('trimTurns: 单条巨 assistant 消息（> 预算一半）在锚点内被第三层丢弃', () => {
  // 锚点第一轮含 3000-token 的巨消息：L2 保留锚点（病态小预算下收缩到 1 轮），
  // L3 把超半的整条 assistant 消息丢弃，只留 prompt（宁缺毋滥）。
  const turns = [
    { prompt: '锚点', steps: [{ content: [{ type: 'text', text: '字'.repeat(3000) }], toolCalls: [], toolResults: [] }] },
    ...textTurns(30, 10),
  ]
  const { turns: out, trimmed } = trimTurns(turns, 2000)
  assert.ok(trimmed.droppedOversized > 0)
  // 首轮仍在（prompt 保留），巨 step 被丢弃（宁缺毋滥，不超限）
  assert.equal(out[0].prompt, '锚点')
  assert.equal(out[0].steps.length, 0)
  assert.ok(trimmed.estimatedTokens <= 2000)
  assert.ok(trimmed.droppedMessages >= 1)
})

test('trimTurns: 单条巨工具结果（> 预算一半）被丢弃而非超限', () => {
  const turns = [
    {
      prompt: '锚点一',
      steps: [{
        content: [{ type: 'text', text: '回答一' }],
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }],
        toolResults: [{ toolCallId: 'c1', content: [{ type: 'text', text: '字'.repeat(40000) }] }],
      }],
    },
    ...textTurns(30, 10),
  ]
  const { turns: out, trimmed } = trimTurns(turns, 2000)
  assert.ok(trimmed.droppedOversized > 0)
  // 首轮仍在（锚点），但其巨工具结果被丢弃（调用保留 → synthesizeSession 补空结果）
  assert.equal(out[0].prompt, '锚点一')
  assert.equal(out[0].steps[0].toolResults.length, 0)
  assert.equal(out[0].steps[0].toolCalls.length, 1)
  assert.ok(trimmed.estimatedTokens <= 2000)
})

test('trimTurns: 整段 ≤ 锚点轮数 + 极小预算 → 锚点收缩丢轮计入 trimmed（REQ-49）', () => {
  // 3 轮 ≤ 锚点 3 条 user 文本（rest 为空），预算小到「锚点 + 摘要预留」仍超预算 →
  // 锚点从尾部收缩到 1 轮；被收缩的 2 轮必须计入 dropped*，不得静默消失。
  const turns = textTurns(3, 100) // 每轮 ~202 tokens，3 轮 ~606 > 400 预算
  const { turns: out, trimmed } = trimTurns(turns, 400)
  assert.equal(trimmed.droppedTurns, 2)
  assert.equal(trimmed.droppedMessages, 4) // 2 轮 × (1 prompt + 1 step)
  assert.equal(trimmed.droppedToolCalls, 0)
  assert.equal(trimmed.droppedToolResults, 0)
  assert.equal(out.length, 1) // 收缩守卫：至少留 1 轮可续聊
  assert.equal(out[0].prompt, turns[0].prompt)
  assert.ok(trimmed.summaryInserted)
  assert.ok(trimmed.estimatedTokens <= 400)
})

test('applyBudgetTrim: 整段 ≤ 锚点轮数 + 极小预算 → trimmed 非 null（REQ-49）', () => {
  const turns = textTurns(3, 100)
  const r = applyBudgetTrim(turns, 400)
  assert.ok(r.trimmed) // engaged 不再全零 → 报告如实反映丢轮
  assert.equal(r.trimmed.droppedTurns, 2)
  assert.equal(r.turns.length, 1)
  assert.equal(r.turns[0].prompt, turns[0].prompt)
})

test('trimTurns: 锚点收缩丢轮的工具调用/结果计入 droppedToolCalls/Results（REQ-49）', () => {
  const turns = [
    { prompt: 'q0', steps: [{ content: [{ type: 'text', text: 'a0' }], toolCalls: [], toolResults: [] }] },
    // 放大 toolResult 使预算可放宽到 300：避免预算过小触发 L3 摘要丢弃，计数只反映 L2 锚点收缩
    { prompt: 'q1', steps: [{ content: [{ type: 'text', text: 'a1' }], toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }], toolResults: [{ toolCallId: 'c1', content: [{ type: 'text', text: 'r1' + '字'.repeat(300) }] }] }] },
    { prompt: 'q2', steps: [{ content: [{ type: 'text', text: 'a2' }], toolCalls: [{ id: 'c2', name: 'read', arguments: '{}' }, { id: 'c3', name: 'grep', arguments: '{}' }], toolResults: [{ toolCallId: 'c2', content: [{ type: 'text', text: 'r2' + '字'.repeat(300) }] }, { toolCallId: 'c3', content: [{ type: 'text', text: 'r3' + '字'.repeat(300) }] }] }] },
  ]
  // 总估算 ≈ 2+303+604 = 909 > 300 → 进 L2；锚点 3 轮 + 512 恒超 → 收缩到 1 轮，丢 t1/t2
  const { turns: out, trimmed } = trimTurns(turns, 300)
  assert.equal(trimmed.droppedTurns, 2)
  assert.equal(trimmed.droppedToolCalls, 3) // 1 + 2
  assert.equal(trimmed.droppedToolResults, 3) // 1 + 2
  assert.equal(trimmed.droppedMessages, 7) // (1+1+1) + (1+1+2)
  assert.equal(trimmed.droppedOversized, 0) // 计数只来自 L2，无 L3 干扰
  assert.equal(out.length, 1)
  assert.equal(out[0].prompt, 'q0')
  assert.ok(trimmed.summaryInserted)
})

test('applyBudgetTrim: 无预算 / 非法预算 → 原样返回且无 trimmed 上报', () => {
  const turns = textTurns(5, 10)
  for (const budget of [undefined, null, 0, -1, 'abc', NaN]) {
    const r = applyBudgetTrim(turns, budget)
    assert.equal(r.trimmed, null)
    assert.equal(r.turns.length, 5)
    assert.equal(r.turns[0].prompt, turns[0].prompt)
  }
  // 字符串预算被 Number 归一（与 index 层 parseBudgetValue 口径一致）
  const str = applyBudgetTrim(textTurns(40, 100), '1000')
  assert.ok(str.trimmed)
  // 合法预算 + 保护未实际生效（预算内）→ 无上报
  const r2 = applyBudgetTrim(textTurns(2, 10), 100000)
  assert.equal(r2.trimmed, null)
})

test('validateSessionEvents：合法会话 0 告警', () => {
  const events = [
    ev(0, 'session/imported', { ignorable: true }),
    ev(1, 'turn/start'),
    ev(2, 'user/message', { surfaceOp: 'append' }),
    ev(3, 'assistant/message', { surfaceOp: 'append' }),
    ev(4, 'tool/call'),
    ev(5, 'tool/result', { surfaceOp: 'append', sourceEventSeqs: [4] }),
    ev(6, 'step/end'),
    ev(7, 'turn/end'),
  ]
  const r = validateSessionEvents(events)
  assert.equal(r.ok, true)
  assert.deepEqual(r.problems, [])
})

test('validateSessionEvents：断 seq / 重复 seq / 缺 seq 均被报告', () => {
  const gap = validateSessionEvents([
    ev(0, 'turn/start'), ev(1, 'user/message', { surfaceOp: 'append' }), ev(3, 'assistant/message', { surfaceOp: 'append' }),
  ])
  assert.equal(gap.ok, false)
  assert.ok(gap.problems.some((p) => p.kind === 'seq-gap' && p.seq === 3))

  const dup = validateSessionEvents([ev(0, 'turn/start'), ev(0, 'turn/start')])
  assert.ok(dup.problems.some((p) => p.kind === 'duplicate-seq'))

  const missing = validateSessionEvents([ev(0, 'turn/start'), { type: 'turn/end', data: {} }])
  assert.ok(missing.problems.some((p) => p.kind === 'missing-seq'))
})

test('validateSessionEvents：图片块带内联 data（未落成附件）被点名', () => {
  const ref = { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
  const okRefs = validateSessionEvents([
    ev(0, 'turn/start'),
    ev(1, 'user/message', { surfaceOp: 'append', data: { content: [{ type: 'image', attachment: ref }] } }),
  ])
  assert.ok(!okRefs.problems.some((p) => p.kind === 'inline-image-data'), 'attachment 引用形态合法')

  const leaked = validateSessionEvents([
    ev(0, 'turn/start'),
    ev(1, 'user/message', { surfaceOp: 'append', data: { content: [{ type: 'image', data: 'aGVsbG8=', mediaType: 'image/png' }] } }),
  ])
  assert.equal(leaked.ok, false)
  assert.ok(leaked.problems.some((p) => p.kind === 'inline-image-data' && p.seq === 1))

  // tool-result 内层 content（V3 wrapper / V4 一级 content）里的图片块同样要被抓到
  const nested = validateSessionEvents([
    ev(0, 'turn/start'),
    ev(1, 'tool/result', {
      surfaceOp: 'append',
      data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'image', data: 'AAAA', mediaType: 'image/png' }] }] } },
    }),
  ])
  assert.ok(nested.problems.some((p) => p.kind === 'inline-image-data'))
})

test('validateSessionEvents：解释性 content 里的 tool-result 包装被点名（宿主 V4 退休语法，issue #77）', () => {
  const wrapper = { type: 'tool-result', toolCallId: 'c1', content: [] }
  const assistant = validateSessionEvents([
    ev(0, 'turn/start'),
    ev(1, 'assistant/message', { surfaceOp: 'append', data: { message: { id: 'a1', role: 'assistant', content: [wrapper] } } }),
  ])
  assert.equal(assistant.ok, false)
  const hit = assistant.problems.find((p) => p.kind === 'retired-tool-result-wrapper')
  assert.ok(hit && hit.seq === 1)
  assert.match(hit.message, /message\.content/)

  const user = validateSessionEvents([
    ev(0, 'turn/start'),
    ev(1, 'user/message', { surfaceOp: 'append', data: { content: [wrapper] } }),
  ])
  assert.ok(user.problems.some((p) => p.kind === 'retired-tool-result-wrapper' && p.seq === 1))

  // V3 形状的 tool/result 事件本身就带这个包装（写侧由 shapeToolResults 分流）：不误报
  const v3 = validateSessionEvents([
    ev(0, 'turn/start'),
    ev(1, 'tool/result', { surfaceOp: 'append', data: { message: { role: 'user', content: [wrapper], source: { kind: 'tool', callId: 'c1' } } } }),
  ])
  assert.ok(!v3.problems.some((p) => p.kind === 'retired-tool-result-wrapper'))
})

test('validateSessionEvents：未知类型 / surface 缺 surfaceOp / sourceEventSeqs 指向非 call', () => {
  const unknown = validateSessionEvents([ev(0, 'bogus/event')])
  assert.ok(unknown.problems.some((p) => p.kind === 'unknown-type'))

  const noSurface = validateSessionEvents([ev(0, 'user/message')])
  assert.ok(noSurface.problems.some((p) => p.kind === 'missing-surface-op'))

  const badRef = validateSessionEvents([
    ev(0, 'user/message', { surfaceOp: 'append' }),
    ev(1, 'tool/result', { surfaceOp: 'append', sourceEventSeqs: [0] }),
  ])
  assert.ok(badRef.problems.some((p) => p.kind === 'source-event-seqs-not-call'))
})

test('validateSessionEvents：宿主运行时/状态事件类型不再误报 unknown-type（issue #20 附注）', () => {
  // 原生 DSH 会话含运行时/状态事件（issue #20 附注点名的 6 种 + 代表性扩展），
  // 白名单对齐宿主词汇表后应 0 告警，而不是被判 unknown-type。
  const runtimeTypes = [
    'permission/preset', 'sandbox/mode', 'approval/policy', 'agent/inbox/spliced',
    'request/header', 'assistant/chunk',
    'todo/write', 'request/context', 'session/end-seed', 'tool/code-dispatch',
    'compaction/prune', 'plan/mode', 'team/task', 'tool-workflow/run-start',
    'web/deepseek-search-llm-request',
  ]
  const r = validateSessionEvents(runtimeTypes.map((type, i) => ev(i, type)))
  assert.equal(r.ok, true)
  assert.deepEqual(r.problems, [])
})

test('validateSessionEvents：原生压缩事务契约（括号配对 / 遮蔽范围 / 检查点溯源）', () => {
  const out = convertCodexJsonl(codexCompactedRollout(), { sessionId: 'codex-comp-1' })
  assert.equal(validateSessionEvents(out.events).ok, true)
  const clone = () => JSON.parse(JSON.stringify(out.events))
  const firstProblem = (events) => validateSessionEvents(events).problems[0]

  // 遮蔽范围首尾与 shadowedSeqs 不一致
  const rangeBad = clone()
  const summary = rangeBad.find((e) => e.type === 'compaction/summary')
  summary.data.shadowedRange = { start: summary.data.shadowedSeqs[1], end: summary.data.shadowedRange.end }
  assert.equal(firstProblem(rangeBad).kind, 'compaction-shadow-range')

  // shadowedSeqs 为空（宿主不变式要求非空）
  const emptyShadow = clone()
  emptyShadow.find((e) => e.type === 'compaction/summary').data.shadowedSeqs = []
  assert.equal(firstProblem(emptyShadow).kind, 'compaction-shadow-empty')

  // 检查点缺溯源（漏掉被遮蔽节点）
  const noProv = clone()
  const ck = noProv.find((e) => e.type === 'user/message' && typeof e.surfaceOp === 'object')
  ck.sourceEventSeqs = ck.sourceEventSeqs.slice(1)
  assert.equal(firstProblem(noProv).kind, 'compaction-provenance-missing')

  // 检查点标记与括号 compactionId 不一致 / source 不是 compact 标记
  const wrongId = clone()
  wrongId.find((e) => e.type === 'user/message' && typeof e.surfaceOp === 'object').data.source.compactionId = 'other'
  assert.equal(firstProblem(wrongId).kind, 'compaction-checkpoint-orphan')

  // 未闭合的括号（只有 start）
  const unclosed = clone().filter((e) => e.type !== 'compaction/end')
  assert.ok(validateSessionEvents(unclosed).problems.some((p) => p.kind === 'compaction-unclosed'))

  // 缺 summary 的 end
  const orphanEnd = clone().filter((e) => e.type !== 'compaction/summary' && e.type !== 'user/message')
  assert.ok(validateSessionEvents(orphanEnd).problems.some((p) => p.kind === 'compaction-end-orphan'))
})

test('trimTurns：原生压缩的受遮蔽前缀不计预算、不裁剪、不丢弃', () => {
  // 受遮蔽前缀（log-only）即便超出预算也原样保留；预算只作用于检查点之后的有效段
  const shadowedTurn = {
    shadowed: true,
    prompt: '被压掉的旧问题',
    steps: [{ content: [{ type: 'text', text: 'A'.repeat(4000) }], toolCalls: [], toolResults: [] }],
  }
  const effectiveTurns = Array.from({ length: 6 }, (_, i) => ({
    prompt: '有效问题' + i,
    steps: [{ content: [{ type: 'text', text: 'B'.repeat(4000) }], toolCalls: [], toolResults: [] }],
  }))
  const turns = [shadowedTurn, { prompt: '', steps: [], compaction: { summary: '摘要' } }, ...effectiveTurns]
  const { turns: out, trimmed } = trimTurns(turns, 1500)
  assert.equal(out[0], shadowedTurn, '受遮蔽轮原样保留（连对象都不重建）')
  assert.equal(out[1].compaction.summary, '摘要', '边界轮的检查点标记保留')
  assert.ok(trimmed.droppedTurns > 0, '有效段仍按预算裁剪')
  assert.ok(trimmed.originalTokens < 7000, 'originalTokens 只算有效段（不含被遮蔽的 4000 字符）')
  // 受遮蔽轮不参与估算：把它的正文放大 10 倍，预算判断不变
  const bigger = [{ ...shadowedTurn, steps: [{ content: [{ type: 'text', text: 'A'.repeat(40000) }], toolCalls: [], toolResults: [] }] }, ...turns.slice(1)]
  assert.equal(trimTurns(bigger, 1500).trimmed.originalTokens, trimmed.originalTokens)
})

test('validateSessionEvents：原生会话 sourceEventSeqs/surfaceOp 语义不再误报（issue #20 附注）', () => {
  // assistant/message 在原生会话可引用 assistant/chunk（消息重建），不应判 source-event-seqs-not-call
  const assistantRef = validateSessionEvents([
    ev(0, 'assistant/chunk'),
    ev(1, 'assistant/message', { surfaceOp: 'append', sourceEventSeqs: [0] }),
  ])
  assert.equal(assistantRef.ok, true)

  // compaction 的 replace surfaceOp 是合法形态，不应判 missing-surface-op
  const replaceOp = validateSessionEvents([
    ev(0, 'assistant/message', { surfaceOp: { op: 'replace', start: 0, end: 0 } }),
  ])
  assert.equal(replaceOp.ok, true)

  // tool/result 指向非 tool/call 仍报 source-event-seqs-not-call（回归不变）
  const toolResultBadRef = validateSessionEvents([
    ev(0, 'assistant/chunk'),
    ev(1, 'tool/result', { surfaceOp: 'append', sourceEventSeqs: [0] }),
  ])
  assert.ok(toolResultBadRef.problems.some((p) => p.kind === 'source-event-seqs-not-call'))
})

test('validateSessionEvents：指向集合外的 sourceEventSeqs 合法（append 尾片跨轮引用）', () => {
  // 尾片从 fromSeq 重编号，引用前段事件（不在集合内）——不报错
  const tail = [
    ev(10, 'turn/start'),
    ev(11, 'tool/result', { surfaceOp: 'append', sourceEventSeqs: [3] }),
  ]
  const r = validateSessionEvents(tail)
  assert.equal(r.ok, true)
})

test('validateSessionEvents：非数组 / 畸形条目报告且封顶', () => {
  const notArr = validateSessionEvents({})
  assert.equal(notArr.ok, false)
  assert.equal(notArr.problems[0].kind, 'not-array')

  const many = validateSessionEvents(Array.from({ length: 100 }, (_, i) => ev(i, 'bogus/event')))
  assert.ok(many.problems.length <= 20) // VALIDATION_PROBLEM_CAP
  assert.equal(many.ok, false)
})

test('validateSessionEvents：首个 step/start 之前的 surface 事件被点名（issue #66）', () => {
  // 旧版本（≤0.18.3）导入日志的形状：环境变更声明排在首个 turn/start 之前。
  // 宿主 v2→v3 迁移对「首个 step/start 之前的 surface」fail-closed 拒载，此形状
  // 必须在导入/校验时被点名，而不是等宿主迁移时静默打不开。
  const legacy = [
    ev(0, 'user/message', { surfaceOp: 'append' }),
    ev(1, 'turn/start'),
    ev(2, 'step/start'),
    ev(3, 'user/message', { surfaceOp: 'append' }),
    ev(4, 'assistant/message', { surfaceOp: 'append' }),
    ev(5, 'step/end'),
    ev(6, 'turn/end'),
  ]
  const r = validateSessionEvents(legacy)
  assert.equal(r.ok, false)
  assert.deepEqual(r.problems.map((p) => p.kind), ['surface-before-first-step'])
  assert.equal(r.problems[0].seq, 0)
  // 新注入位（step/start 之后）同形状不报
  const fixed = validateSessionEvents([
    ev(0, 'turn/start'),
    ev(1, 'step/start'),
    ev(2, 'user/message', { surfaceOp: 'append' }),
    ev(3, 'assistant/message', { surfaceOp: 'append' }),
    ev(4, 'step/end'),
    ev(5, 'turn/end'),
  ])
  assert.equal(fixed.ok, true)
  // 无任何 step/start（只有提问没有回复）时不适用该约束
  const noStep = validateSessionEvents([
    ev(0, 'turn/start'),
    ev(1, 'user/message', { surfaceOp: 'append' }),
    ev(2, 'turn/end'),
  ])
  assert.equal(noStep.ok, true)
})

test('所有源的 assistant/message 都带 settlement 字段 stream（issue #41）', () => {
  const cases = [
    ['claude', () => convertClaudeJsonl(load('sess-simple-001.jsonl'))],
    ['codex', () => convertCodexJsonl(load('codex-simple.jsonl'))],
    ['cursor', () => convertCursorJsonl(load('cursor-simple.jsonl'))],
    ['gemini', () => convertGeminiJson(load('gemini-simple.json'))],
    ['pi', () => convertPiJsonl(load('pi-simple.jsonl'))],
    ['reasonix', () => convertReasonixJsonl(load('reasonix-v2.jsonl'))],
    ['qoder', () => convertQoderJsonl(load('qoder-simple.jsonl'))],
    ['opencode', () => convertOpencodeJson(load('opencode-simple.json'))],
  ]
  for (const [name, convert] of cases) {
    const out = convert()
    const assistants = out.events.filter((e) => e.type === 'assistant/message')
    assert.ok(assistants.length > 0, name + ' 应产出 assistant/message')
    for (const ev of assistants) {
      assert.equal(typeof ev.data.turn, 'number', name + ' assistant/message 带 turn')
      assert.equal(typeof ev.data.step, 'number', name + ' assistant/message 带 step')
      assert.ok(Array.isArray(ev.data.stream), name + ' assistant/message 带 stream 数组')
    }
  }
})

test('synthesizeSession: 跨 step 到达的异步结果归位到调用的 step', () => {
  const out = synthesizeSession({
    meta: { id: 't1', createdAt: 1700000000000 },
    turns: [{
      prompt: 'q',
      steps: [
        { content: [{ type: 'tool-call', id: 'c1', name: 'Bash', arguments: '{}' }], toolCalls: [{ id: 'c1', name: 'Bash', arguments: '{}' }], toolResults: [] },
        { content: [{ type: 'text', text: 'running' }], toolCalls: [], toolResults: [] },
        { content: [{ type: 'text', text: 'later' }], toolCalls: [], toolResults: [{ toolCallId: 'c1', content: [{ type: 'text', text: 'done' }] }] },
      ],
    }],
  })
  const call = out.events.find((e) => e.type === 'tool/call')
  const result = out.events.find((e) => e.type === 'tool/result')
  const firstStepEnd = out.events.find((e) => e.type === 'step/end')
  assert.ok(result, '异步结果仍被发射')
  assert.ok(result.seq < firstStepEnd.seq, '结果必须闭合在调用的 step 内（step/end 前配平）')
  assert.deepEqual(result.data.message.content[0].content, [{ type: 'text', text: 'done' }])
  assert.deepEqual(result.sourceEventSeqs, [call.seq], 'sourceEventSeqs 仍指向其 tool/call')
  assert.equal(out.events.filter((e) => e.type === 'tool/result').length, 1, '后续 step 不再重复该结果')
  assert.equal(out.orphanToolResults, undefined)
  assert.equal(out.duplicateToolResults, undefined)
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
})

test('synthesizeSession: 跨轮到达的异步结果归位到调用的轮', () => {
  const out = synthesizeSession({
    meta: { id: 't2', createdAt: 1700000000000 },
    turns: [
      {
        prompt: 'q1',
        steps: [{ content: [{ type: 'tool-call', id: 'c1', name: 'Bash', arguments: '{}' }], toolCalls: [{ id: 'c1', name: 'Bash', arguments: '{}' }], toolResults: [] }],
      },
      {
        prompt: 'q2',
        steps: [{ content: [{ type: 'text', text: 'next' }], toolCalls: [], toolResults: [{ toolCallId: 'c1', content: [{ type: 'text', text: 'late' }] }] }],
      },
    ],
  })
  const result = out.events.find((e) => e.type === 'tool/result')
  const firstTurnEnd = out.events.find((e) => e.type === 'turn/end')
  assert.ok(result && result.seq < firstTurnEnd.seq, '结果归位到调用所在轮的 step 内')
  assert.deepEqual(result.data.message.content[0].content, [{ type: 'text', text: 'late' }])
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
})

test('synthesizeSession: 无广告调用的孤儿结果丢弃并计数', () => {
  const out = synthesizeSession({
    meta: { id: 't3', createdAt: 1700000000000 },
    turns: [{
      prompt: 'q',
      steps: [{ content: [{ type: 'text', text: 'hi' }], toolCalls: [], toolResults: [{ toolCallId: 'ghost', content: [{ type: 'text', text: 'orphan-body' }] }] }],
    }],
  })
  assert.equal(out.events.filter((e) => e.type === 'tool/result').length, 0)
  assert.equal(out.orphanToolResults, 1)
  assert.equal(out.duplicateToolResults, undefined)
  assert.ok(!JSON.stringify(out.events).includes('orphan-body'), '孤儿结果正文不进入日志')
  assertToolPairing(out.events)
})

test('synthesizeSession: 同一调用的重复结果保留首条并计数', () => {
  const out = synthesizeSession({
    meta: { id: 't4', createdAt: 1700000000000 },
    turns: [{
      prompt: 'q',
      steps: [{
        content: [{ type: 'tool-call', id: 'c1', name: 'Bash', arguments: '{}' }],
        toolCalls: [{ id: 'c1', name: 'Bash', arguments: '{}' }],
        toolResults: [
          { toolCallId: 'c1', content: [{ type: 'text', text: 'first' }] },
          { toolCallId: 'c1', content: [{ type: 'text', text: 'second' }], isError: true },
        ],
      }],
    }],
  })
  const results = out.events.filter((e) => e.type === 'tool/result')
  assert.equal(results.length, 1)
  assert.deepEqual(results[0].data.message.content[0].content, [{ type: 'text', text: 'first' }])
  assert.equal(results[0].data.message.content[0].isError, undefined, '首条无 isError 时不虚构')
  assert.equal(out.duplicateToolResults, 1)
  assert.equal(out.orphanToolResults, undefined)
  assertToolPairing(out.events)
  assertMessageOrderLegal(out.events)
})

test('synthesizeSession: 首个 surface 事件是首个 step 内的 system head（宿主 v3→v4 迁移的 protected head）', () => {
  // 宿主 v3→v4 迁移要求 surface 的第一个事件是 system/message（protected head），
  // 否则宿主续聊写自己的 system/message 时整份日志被拒载：
  // "system/message requires a protected first surface head"。导入会话此前不写 head。
  const out = convertClaudeJsonl(load('sess-simple-001.jsonl'), { sourcePath: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  const surface = out.events.filter((e) => e.surfaceOp !== undefined)
  assert.equal(surface[0].type, 'system/message')
  assert.equal(surface[0].surfaceOp, 'append')
  assert.equal(surface[0].data.message.role, 'system')
  assert.deepEqual(surface[0].data.message.content, [], 'head 内容留空：真正的提示词由宿主在下一步替换')
  // 宿主 agents.create 的 seed 校验：system/message 必须来自 system-prompt 生产者
  //（"seed system/message at index 2 message must have system-prompt source"）
  assert.deepEqual(surface[0].data.message.source, { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' })
  // 必须落在已打开的 step 内，且是第一个 step/start 之后的第一条（宿主锚点同位置）
  const stepIdx = out.events.findIndex((e) => e.type === 'step/start')
  assert.equal(out.events[stepIdx + 1].type, 'system/message')
  assert.deepEqual([out.events[stepIdx + 1].data.turn, out.events[stepIdx + 1].data.step], [1, 1])
  assert.equal(validateSessionEvents(out.events).ok, true)
})

test('synthesizeSession: 首轮无 step 时 head 自补一个只装 head 的 step（否则没有可锚的 step）', () => {
  const out = convertClaudeJsonl(load('sess-empty-001.jsonl'), { sourcePath: 'D:\\demo\\proj\\sess-empty-001.jsonl' })
  assert.deepEqual(out.events.map((e) => e.type), [
    'turn/start', 'step/start', 'system/message', 'user/message', 'step/end', 'user/message', 'turn/end',
  ])
  assert.equal(out.events[2].data.message.role, 'system')
  assert.equal(validateSessionEvents(out.events).ok, true)
})
