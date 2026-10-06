// convert-titles.test.mjs — 标题口径（各源共用）
// 显式标题优先级、首问兜底、80 字符截断与省略号、空白标题不钉事件。
// 由 test/convert.test.mjs 按主题拆出（纯移动：用例与断言未改）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { convertClaudeJsonl, convertCodexJsonl, convertCursorJsonl, convertGeminiJson, convertReasonixJsonl } from '../lib/convert/index.mjs'
import { loadFixture } from './_support/fixtures.mjs'
const load = loadFixture

test('REQ-27 claude: custom-title（summary 记录）覆盖 ai-title 与首问', () => {
  const raw = [
    '{"sessionId":"sess-req27-001","type":"summary","summary":"用户自定义标题","leafUuid":null}',
    '{"sessionId":"sess-req27-001","type":"user","message":{"role":"user","content":"第一个问题"}}',
    '{"sessionId":"sess-req27-001","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"回答"}]}}',
    '{"sessionId":"sess-req27-001","type":"ai-title","aiTitle":"AI 生成的标题"}',
  ].join('\n')
  const out = convertClaudeJsonl(raw)
  assert.equal(out.title, '用户自定义标题') // custom 覆盖 ai
  const titleEv = out.events.find((e) => e.type === 'session/title')
  assert.ok(titleEv)
  assert.equal(titleEv.data.title, '用户自定义标题')
  // summary 记录的 title 字段同源（兼容字段名变体）
  const out2 = convertClaudeJsonl(raw.replace('"summary":"用户自定义标题"', '"title":"标题字段变体"'))
  assert.equal(out2.title, '标题字段变体')
})

test('REQ-27 claude: ai-title 覆盖首问兜底', () => {
  const out = convertClaudeJsonl(load('sess-title-001.jsonl'))
  assert.equal(out.title, '项目问题讨论') // ai-title，而非首问「问个问题」
  const titleEv = out.events.find((e) => e.type === 'session/title')
  assert.equal(titleEv.data.title, '项目问题讨论')
})

test('REQ-27 claude: 无显式标题 → 首问兜底（out.title，不钉事件）', () => {
  const out = convertClaudeJsonl(load('sess-simple-001.jsonl'))
  assert.equal(out.title, '你好，帮我看看这个项目')
  assert.equal(out.events.some((e) => e.type === 'session/title'), false)
})

test('REQ-27 codex: 首问兜底（无显式标题源）', () => {
  const out = convertCodexJsonl(load('codex-simple.jsonl'))
  assert.equal(out.title, '你好，看看这个项目')
  assert.equal(out.events.some((e) => e.type === 'session/title'), false)
})

test('REQ-27 cursor/gemini: 首问兜底', () => {
  const c = convertCursorJsonl(load('cursor-simple.jsonl'))
  assert.equal(c.title, 'Create a basic python interpreter in rust.')
  assert.equal(c.events.some((e) => e.type === 'session/title'), false)
  const g = convertGeminiJson(load('gemini-simple.json'))
  assert.equal(g.title, 'Create a basic python interpreter in rust.')
  assert.equal(g.events.some((e) => e.type === 'session/title'), false)
})

test('REQ-27 reasonix: meta.summary（显式）> 首问兜底', () => {
  const withTitle = convertReasonixJsonl(load('reasonix-v2.jsonl'), { reasonixId: 'desktop-202606020725-2', title: '查看当前编辑 xlsx 的 skill' })
  assert.equal(withTitle.title, '查看当前编辑 xlsx 的 skill')
  assert.ok(withTitle.events.some((e) => e.type === 'session/title'))
  const bare = convertReasonixJsonl(load('reasonix-v1.jsonl'), { reasonixId: 'desktop-202606020721-1' })
  assert.equal(bare.title, '在 github 上搜索 codegraph 并安装')
  assert.equal(bare.events.some((e) => e.type === 'session/title'), false)
})

test('REQ-27 截断：首问超 80 字符 → 79 字符 + 省略号（统一规则）', () => {
  const raw = [
    '{"sessionId":"sess-req27-002","type":"user","message":{"role":"user","content":"' + '长'.repeat(85) + '"}}',
    '{"sessionId":"sess-req27-002","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"回答"}]}}',
  ].join('\n')
  const out = convertClaudeJsonl(raw)
  assert.equal(out.title.length, 80)
  assert.equal(out.title, '长'.repeat(79) + '…')
})

test('REQ-27 截断：显式标题（ai-title）同样截断', () => {
  const raw = [
    '{"sessionId":"sess-req27-003","type":"user","message":{"role":"user","content":"首问"}}',
    '{"sessionId":"sess-req27-003","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"回答"}]}}',
    '{"sessionId":"sess-req27-003","type":"ai-title","aiTitle":"' + 'x'.repeat(90) + '"}',
  ].join('\n')
  const out = convertClaudeJsonl(raw)
  assert.equal(out.title, 'x'.repeat(79) + '…')
  const titleEv = out.events.find((e) => e.type === 'session/title')
  assert.equal(titleEv.data.title, 'x'.repeat(79) + '…')
})

test('REQ-27 空标题不写 session/title（空白 ai-title 视作无标题 → 首问兜底）', () => {
  const raw = [
    '{"sessionId":"sess-req27-004","type":"user","message":{"role":"user","content":"首问"}}',
    '{"sessionId":"sess-req27-004","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"回答"}]}}',
    '{"sessionId":"sess-req27-004","type":"ai-title","aiTitle":"   "}',
  ].join('\n')
  const out = convertClaudeJsonl(raw)
  assert.equal(out.events.some((e) => e.type === 'session/title'), false)
  assert.equal(out.title, '首问')
})
