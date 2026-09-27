// codex-agents-md.test.mjs — Codex rollout 注入块过滤与 step.model 契约单测（缺陷 3 / 4）。
// 夹具全合成，无真实 transcript。
//
// 锁定的契约（lib/convert/codex.mjs）：
//   1) 用户消息里的 harness 注入块（'# AGENTS.md instructions' 前缀块、'<' 开头的环境块等）
//      既不开轮也不作标题，前缀表与发现层 isInjectedTitle 同源；importSystemPrompt 开启时
//      '# AGENTS.md' 前缀块收进 systemPrompt（拼接口径同 developer 分支），其余注入块无论
//      开关一律丢弃；过滤后为空不开轮，全注入 rollout 0 轮、标题不取注入。
//   2) turn_context 每条都更新当前模型；新开的步骤带 step.model → 中途换模型时前后步骤
//      各带各的模型；会话级 model 仍取第一条兜底。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertCodexJsonl } from '../lib/convert/codex.mjs'
import { isInjectedTitle } from '../lib/discovery.mjs'

const T0 = '2026-09-20T01:00:00.000Z'
const metaLine = (id) => JSON.stringify({
  timestamp: T0, type: 'session_meta',
  payload: { id, timestamp: T0, cwd: 'D:\\demo\\proj' },
})
const turnLine = (model) => JSON.stringify({
  timestamp: T0, type: 'turn_context', payload: { turn_id: 't', model },
})
const txt = (text) => ({ type: 'input_text', text })
const userLine = (blocks) => JSON.stringify({
  timestamp: T0, type: 'response_item',
  payload: { type: 'message', role: 'user', content: blocks },
})
const asstLine = (text) => JSON.stringify({
  timestamp: T0, type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
})

// 缺陷 3 的真实形态：首条 user 消息 = [AGENTS.md 注入块, 环境块]，其内没有任何人类提问
const AGENTS_MD = '# AGENTS.md instructions for D:\\demo\\proj\n\n<INSTRUCTIONS>只改 lib/ 下的文件</INSTRUCTIONS>'
const ENV_BLOCK = '<environment_context>\n  <cwd>D:\\demo\\proj</cwd>\n</environment_context>'

// 注入消息在前、真实提问在后
const injectThenAsk = (id, model = 'gpt-5.5') => [
  metaLine(id),
  turnLine(model),
  userLine([txt(AGENTS_MD), txt(ENV_BLOCK)]),
  asstLine('已读取仓库指令。'),
  userLine([txt('帮我修这个 bug')]),
  asstLine('先看报错。'),
].join('\n')

test('convertCodexJsonl: 首条 AGENTS.md 注入块不开轮，标题取真实提问', () => {
  const out = convertCodexJsonl(injectThenAsk('codex-inject-1'), { sessionId: 'codex-inject-1' })
  // 注入消息不开轮 → 它之后的 assistant 产物无轮可挂（被丢弃），首轮就是真实提问
  assert.equal(out.turns.length, 1)
  assert.deepEqual(out.turns.map((t) => t.prompt), ['帮我修这个 bug'])
  assert.equal(out.turns[0].steps.length, 1)
  assert.equal(out.title, '帮我修这个 bug')
  // 提问正文只剩真实提问（注入块不落进任何 user/message）
  const userTexts = out.events
    .filter((e) => e.type === 'user/message' && e.data.source && e.data.source.kind === 'user')
    .map((e) => e.data.content[0].text)
  assert.deepEqual(userTexts, ['帮我修这个 bug'])
  // 与发现层面板同口径：'# AGENTS.md' 前缀块与环境块判注入，真实提问不判
  assert.equal(isInjectedTitle(AGENTS_MD), true)
  assert.equal(isInjectedTitle(ENV_BLOCK), true)
  assert.equal(isInjectedTitle('帮我修这个 bug'), false)
})

test('convertCodexJsonl: importSystemPrompt 开启时 AGENTS.md 注入块收进 systemPrompt', () => {
  const on = convertCodexJsonl(injectThenAsk('codex-inject-on'), { sessionId: 'codex-inject-on', importSystemPrompt: true })
  const env = on.events.find((e) => e.data && e.data.id === 'import:codex-inject-on:env')
  assert.ok(env, '环境变更声明应存在')
  assert.ok(env.data.content[0].text.includes(AGENTS_MD))
  // 收进 systemPrompt 不影响开轮/标题
  assert.deepEqual(on.turns.map((t) => t.prompt), ['帮我修这个 bug'])
  assert.equal(on.title, '帮我修这个 bug')
  // 只收 '# AGENTS.md' 前缀块：环境块即使开关开启也不保留（不落进任何事件）
  assert.ok(!env.data.content[0].text.includes('<environment_context>'))
  assert.ok(!on.events.some((e) => e.data && JSON.stringify(e.data).includes('<environment_context>')))
})

test('convertCodexJsonl: 开关关闭时 AGENTS.md 注入块与其它注入块一样丢弃', () => {
  const off = convertCodexJsonl(injectThenAsk('codex-inject-off'), { sessionId: 'codex-inject-off' })
  const env = off.events.find((e) => e.data && e.data.id === 'import:codex-inject-off:env')
  assert.ok(env, '环境变更声明总是注入（关闭开关时只是不含源系统提示词）')
  assert.ok(!env.data.content[0].text.includes('# AGENTS.md'))
  assert.ok(!off.events.some((e) => e.data && JSON.stringify(e.data).includes('# AGENTS.md')))
})

test('convertCodexJsonl: 全注入 rollout（无真实提问）0 轮、标题不取注入', () => {
  const allInject = [
    metaLine('codex-all-inject'),
    turnLine('gpt-5.5'),
    userLine([txt(AGENTS_MD), txt(ENV_BLOCK)]),
    asstLine('已读取仓库指令。'),
  ].join('\n')
  const out = convertCodexJsonl(allInject, { sessionId: 'codex-all-inject' })
  assert.equal(out.turns.length, 0)
  assert.equal(out.title, '')
  // 无轮次 → 无 step/start 可锚，连环境变更声明都不注入（events.mjs 既有契约）
  assert.equal(out.events.length, 0)
  // 开关开启同样 0 轮：systemPrompt 收集了但没有轮次承载注入
  const on = convertCodexJsonl(allInject, { sessionId: 'codex-all-inject-on', importSystemPrompt: true })
  assert.equal(on.turns.length, 0)
  assert.equal(on.title, '')
  assert.equal(on.events.length, 0)
})

test('convertCodexJsonl: turn_context 中途换模型 → 前后步骤各带各的 step.model', () => {
  const raw = [
    metaLine('codex-model-switch'),
    turnLine('gpt-5.5'),
    userLine([txt('第一问')]),
    asstLine('第一答'),
    turnLine('gpt-5.6'),
    userLine([txt('第二问')]),
    asstLine('第二答'),
  ].join('\n')
  const out = convertCodexJsonl(raw, { sessionId: 'codex-model-switch' })
  assert.deepEqual(out.turns.map((t) => t.steps.map((s) => s.model)), [['gpt-5.5'], ['gpt-5.6']])
  // 事件层：assistant/message 的 source.model = step.model || 会话级 model
  const models = out.events
    .filter((e) => e.type === 'assistant/message')
    .map((e) => e.data.message.source.model)
  assert.deepEqual(models, ['gpt-5.5', 'gpt-5.6'])
})

test('convertCodexJsonl: 未给 turn_context 模型的步骤不写 step.model，会话级取第一条兜底', () => {
  // 步骤开在 turn_context 之前 → currentModel 仍空；会话级 model 取第一条 turn_context
  const raw = [
    metaLine('codex-model-fallback'),
    userLine([txt('问')]),
    asstLine('答'),
    turnLine('gpt-5.5'),
    turnLine('gpt-5.6'),
  ].join('\n')
  const out = convertCodexJsonl(raw, { sessionId: 'codex-model-fallback' })
  assert.equal(out.turns[0].steps[0].model, undefined)
  assert.deepEqual(
    out.events.find((e) => e.type === 'assistant/message').data.message.source,
    { kind: 'model', provider: 'codex', model: 'gpt-5.5' },
  )
})
