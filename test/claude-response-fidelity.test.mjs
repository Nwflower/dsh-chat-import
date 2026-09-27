// claude-response-fidelity.test.mjs — Claude 转录结果保真与流式拆行合并（纯转换层）
//
// 锁定的契约（lib/convert/claude.mjs）：
//   1) tool_result.content 三形态：字符串（实测 29494/33254 = 88.7%，shell 输出等）→ 单文本块，
//      数组 → 逐块映射（image 块 → [image] 占位 + images 计数；未知块计数），缺失 → 空数组
//      （由合成层兜底，不虚构文本）。此前只映射数组，字符串内容全部导成空结果。
//   2) 流式拆行合并：Claude Code 把一次响应拆成多条 assistant 记录（同 message.id，每行一段
//      增量：thinking / text / tool_use）。同 id 且中间只隔元数据记录的行并回同一步（文件头
//      契约「一条 assistant 消息 = 一步」）；间隔里出现 user / assistant 会话记录立即断开
//      （同 id 跨会话记录重复出现是另一次真实消息，粘连会跨轮错并）。
// fixtures 全部合成，无真实 transcript。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertClaudeJsonl } from '../lib/convert/index.mjs'

const SID = 'sess-fidelity-001'
const jsonl = (recs) => recs.map((r) => JSON.stringify({ sessionId: SID, ...r })).join('\n')
const user = (content) => ({ type: 'user', message: { role: 'user', content } })
const asstId = (id, blocks, model) => ({
  type: 'assistant',
  message: { id, role: 'assistant', ...(model ? { model } : {}), content: blocks },
})

// ── 1. 字符串 tool_result（88.7% 的真实形态）不再导成空结果 ──
test('claude tool_result: 字符串 content → 单文本块（事件层可见正文）', () => {
  const out = convertClaudeJsonl(jsonl([
    user('看一眼目录'),
    asstId('msg_t1', [{ type: 'tool_use', id: 'toolu_ls', name: 'Bash', input: { command: 'ls' } }]),
    user([{ type: 'tool_result', tool_use_id: 'toolu_ls', content: 'file-a.txt\nfile-b.txt' }]),
  ]), { fileStem: SID })

  const step = out.turns[0].steps[0]
  assert.deepEqual(step.toolResults[0].content, [{ type: 'text', text: 'file-a.txt\nfile-b.txt' }])
  const tr = out.events.find((e) => e.type === 'tool/result')
  assert.equal(tr.data.message.content[0].content[0].text, 'file-a.txt\nfile-b.txt', 'tool/result 里必须有正文')
  assert.equal(step.toolResults[0].isError, false)
})

test('claude tool_result: 字符串 is_error 结果同样保留正文与错误标记', () => {
  const out = convertClaudeJsonl(jsonl([
    user('跑构建'),
    asstId('msg_t2', [{ type: 'tool_use', id: 'toolu_build', name: 'Bash', input: {} }]),
    user([{ type: 'tool_result', tool_use_id: 'toolu_build', content: 'error: 缺少依赖', is_error: true }]),
  ]), { fileStem: SID })

  const tr = out.turns[0].steps[0].toolResults[0]
  assert.deepEqual(tr.content, [{ type: 'text', text: 'error: 缺少依赖' }])
  assert.equal(tr.isError, true)
})

test('claude tool_result: 数组 content 逐块映射（既有形态不回归）', () => {
  const out = convertClaudeJsonl(jsonl([
    user('读文件'),
    asstId('msg_t3', [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: {} }]),
    user([{
      type: 'tool_result',
      tool_use_id: 'toolu_read',
      content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }],
    }]),
  ]), { fileStem: SID })

  assert.deepEqual(out.turns[0].steps[0].toolResults[0].content, [
    { type: 'text', text: '第一段' },
    { type: 'text', text: '第二段' },
  ])
})

test('claude tool_result: content 缺失 → 空数组（不虚构文本，交给合成层兜底）', () => {
  const out = convertClaudeJsonl(jsonl([
    user('中断的工具'),
    asstId('msg_t4', [{ type: 'tool_use', id: 'toolu_none', name: 'Bash', input: {} }]),
    user([{ type: 'tool_result', tool_use_id: 'toolu_none' }]),
  ]), { fileStem: SID })

  assert.deepEqual(out.turns[0].steps[0].toolResults[0].content, [])
})

test('claude tool_result: image 块 → [image] 占位 + images 计数（base64 不进日志）', () => {
  const b64 = 'iVBORw0KGgoAAAANSUhEUg=='
  const out = convertClaudeJsonl(jsonl([
    user('看截图'),
    asstId('msg_img', [{ type: 'tool_use', id: 'toolu_shot', name: 'Screenshot', input: {} }]),
    user([{
      type: 'tool_result',
      tool_use_id: 'toolu_shot',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } }],
    }]),
  ]), { fileStem: SID })

  assert.deepEqual(out.turns[0].steps[0].toolResults[0].content, [{ type: 'text', text: '[image]' }])
  assert.equal(out.images, 1)
  assert.ok(!JSON.stringify(out.events).includes(b64), 'base64 永不进日志')
})

test('claude tool_result: 未知块类型计数（droppedToolResultBlocks），不静默吞', () => {
  const out = convertClaudeJsonl(jsonl([
    user('引用工具'),
    asstId('msg_ref', [{ type: 'tool_use', id: 'toolu_ref', name: 'X', input: {} }]),
    user([{ type: 'tool_result', tool_use_id: 'toolu_ref', content: [{ type: 'tool_reference', tool_name: 'y' }] }]),
  ]), { fileStem: SID })

  assert.deepEqual(out.turns[0].steps[0].toolResults[0].content, [])
  assert.equal(out.droppedToolResultBlocks, 1)
})

// ── 2. 流式拆行合并 ──
test('claude 拆行: 同 message.id 的 thinking/text/tool_use 三行并成一步', () => {
  const out = convertClaudeJsonl(jsonl([
    user('实现功能'),
    asstId('msg_split', [{ type: 'thinking', thinking: '先想清楚' }]),
    asstId('msg_split', [{ type: 'text', text: '开始改。' }]),
    asstId('msg_split', [{ type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: { file: 'a.mjs' } }]),
    user([{ type: 'tool_result', tool_use_id: 'toolu_edit', content: '改好了' }]),
  ]), { fileStem: SID })

  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].steps.length, 1, '一次响应 = 一步（拆行必须并回）')
  const step = out.turns[0].steps[0]
  assert.deepEqual(step.content.map((b) => b.type), ['reasoning', 'text', 'tool-call'])
  assert.equal(step.toolCalls.length, 1)
  assert.equal(step.toolResults.length, 1, '结果挂回合并后的同一步，配对不破')
  assert.equal(step.toolResults[0].toolCallId, 'toolu_edit')

  const assistantMsgs = out.events.filter((e) => e.type === 'assistant/message')
  assert.equal(assistantMsgs.length, 1, '一次响应只出一条 assistant/message')
  assert.deepEqual(assistantMsgs[0].data.message.content.map((b) => b.type), ['reasoning', 'text', 'tool-call'])
})

test('claude 拆行: 不同 message.id 的相邻行各成一步（不误并）', () => {
  const out = convertClaudeJsonl(jsonl([
    user('两段回复'),
    asstId('msg_a', [{ type: 'text', text: '第一段' }]),
    asstId('msg_b', [{ type: 'text', text: '第二段' }]),
  ]), { fileStem: SID })

  assert.equal(out.turns[0].steps.length, 2)
  assert.deepEqual(out.turns[0].steps.map((s) => s.content[0].text), ['第一段', '第二段'])
})

test('claude 拆行: 中间只隔元数据记录（mode/last-prompt 等）仍然合并', () => {
  const out = convertClaudeJsonl(jsonl([
    user('继续'),
    asstId('msg_meta', [{ type: 'thinking', thinking: '思考' }]),
    { type: 'mode', mode: 'acceptEdits' },
    { type: 'last-prompt', text: '继续' },
    asstId('msg_meta', [{ type: 'text', text: '产出' }]),
  ]), { fileStem: SID })

  assert.equal(out.turns[0].steps.length, 1, '元数据旁路记录不切断合并组')
  assert.deepEqual(out.turns[0].steps[0].content.map((b) => b.type), ['reasoning', 'text'])
})

test('claude 拆行: 中间夹 user 会话记录（工具结果）必须断开合并组', () => {
  const out = convertClaudeJsonl(jsonl([
    user('两轮工具'),
    asstId('msg_c', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }]),
    user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: '结果一' }]),
    // 复用同一 message.id（真实转录里实测 1868 对）：这是另一次响应，不能与上一个并成一步
    asstId('msg_c', [{ type: 'text', text: '第二次回复' }]),
  ]), { fileStem: SID })

  assert.equal(out.turns[0].steps.length, 2, '跨 user 记录不复用同一 message.id 的合并组')
  assert.equal(out.turns[0].steps[1].content[0].text, '第二次回复')
})

test('claude 拆行: step.model 取合并组首行的 message.model', () => {
  const out = convertClaudeJsonl(jsonl([
    user('换模型后'),
    asstId('msg_m', [{ type: 'thinking', thinking: '想' }], 'claude-sonnet-5'),
    asstId('msg_m', [{ type: 'text', text: '答' }]),
  ]), { fileStem: SID })

  assert.equal(out.turns[0].steps.length, 1)
  assert.equal(out.turns[0].steps[0].model, 'claude-sonnet-5')
})

test('claude 拆行: isMeta 文本只前置一次（合并组只开一步）', () => {
  const out = convertClaudeJsonl(jsonl([
    user('提问'),
    { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: '宿主回执' }] } },
    asstId('msg_meta2', [{ type: 'text', text: '第一段' }]),
    asstId('msg_meta2', [{ type: 'text', text: '第二段' }]),
  ]), { fileStem: SID })

  assert.equal(out.turns[0].steps.length, 1)
  assert.deepEqual(out.turns[0].steps[0].content.map((b) => b.text), ['宿主回执', '第一段', '第二段'])
  assert.equal(out.metaMessages, 1)
})
