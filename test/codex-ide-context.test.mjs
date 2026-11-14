// codex-ide-context.test.mjs — Codex VS Code 扩展的 IDE 上下文包装不得吞掉真实提问。
//
// 锁定的契约（lib/convert/codex.mjs）：
//   1) '# Context from my IDE setup:' 包装里的 '## My request:' 正文是用户提问，必须保留；
//   2) 只有上下文、没有请求段的包装消息仍然整体丢弃（等价于注入块）；
//   3) 未命中包装的普通文本行为不变；
//   4) 页面上下文（'<' 开头）与注入前缀表照旧过滤；
//   5) 与 '# Response annotations:' 块共存时，两者都算用户内容；
//   6) 端到端：一条带两条包装提问的 rollout 必须开两轮，且 prompt 是请求正文。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexUserPrompt, stripIdeSetupPreamble, convertCodexJsonl } from '../lib/convert/codex.mjs'
import { loadFixture } from './_support/fixtures.mjs'

const wrap = (request, activeFile = 'src/main.cpp') => (
  '# Context from my IDE setup:\n\n'
  + '## Active file: ' + activeFile + '\n'
  + '## Open tabs:\n- a.cpp: src/a.cpp\n- b.cpp: src/b.cpp\n\n'
  + '## My request:\n' + request
)

const txt = (text) => ({ type: 'input_text', text })

test('IDE 包装内的真实提问被保留', () => {
  const prompt = codexUserPrompt([txt(wrap('把 main 同步到 9a25321'))])
  assert.equal(prompt, '把 main 同步到 9a25321')
})

test('只有上下文、没有请求段的包装消息仍然丢弃', () => {
  const contextOnly = '# Context from my IDE setup:\n\n## Open tabs:\n- a.cpp: src/a.cpp'
  assert.equal(codexUserPrompt([txt(contextOnly)]), '')
})

test('未命中包装的普通文本行为不变', () => {
  assert.equal(codexUserPrompt([txt('普通提问')]), '普通提问')
})

test('页面上下文与注入前缀照旧被过滤', () => {
  assert.equal(codexUserPrompt([txt('<environment_context><cwd>D:\\x</cwd></environment_context>')]), '')
  assert.equal(codexUserPrompt([txt('# AGENTS.md instructions for D:\\x\n\n<INSTRUCTIONS>a</INSTRUCTIONS>')]), '')
})

test('与 Response annotations 块共存时两者都保留', () => {
  const annotation = '# Response annotations:\nEach item contains text selected from an earlier Codex response.\n'
    + '<response-annotations>[{"text":"这段要改"}]</response-annotations>'
  const prompt = codexUserPrompt([txt(annotation), txt(wrap('按批注改'))])
  assert.ok(prompt.includes('response-annotations'), 'annotation 块应保留')
  assert.ok(prompt.endsWith('按批注改'), '请求正文应保留且在最后')
})

test('stripIdeSetupPreamble 的输入形态', () => {
  assert.equal(stripIdeSetupPreamble(wrap('问题')), '问题')
  assert.equal(stripIdeSetupPreamble('# Context from my IDE setup:\n\n## Open tabs:\n- a'), '')
  assert.equal(stripIdeSetupPreamble('普通文本'), '普通文本')
  // 大小写不敏感的前缀匹配，但请求段标记必须是行首的 '## My request:'
  assert.equal(stripIdeSetupPreamble('# CONTEXT FROM MY IDE SETUP:\n## My request:\n大小写'), '大小写')
  // CRLF：真实 rollout 里确有 '\r\n' 的消息，行尾锚点必须容忍 '\r'
  assert.equal(stripIdeSetupPreamble('# Context from my IDE setup:\r\n\r\n## My request:\r\nCRLF 提问\r\n'), 'CRLF 提问')
  // 请求正文自带 '##' 标题时，只按行首的 '## My request:' 切一刀，后续标题原样保留
  assert.equal(
    stripIdeSetupPreamble('# Context from my IDE setup:\n\n## My request:\n填模板\n\n## Description\nx\n'),
    '填模板\n\n## Description\nx',
  )
})

test('端到端：夹具里的包装提问 → 每轮一个 prompt，顺序与正文都对', () => {
  // 夹具全合成（test/fixtures/codex-ide-context.jsonl），与其它 codex-* 夹具同口径。
  // 覆盖本机真实 rollout 里出现的三种形态：带 Active file、无 Active file、CRLF、
  // 以及请求正文自带 '##' 标题。
  const out = convertCodexJsonl(loadFixture('codex-ide-context.jsonl'), {})
  assert.equal(out.turns.length, 5, '五条包装提问应开五轮')
  assert.equal(out.turns[0].prompt, '先看一下入口函数')
  assert.equal(out.turns[1].prompt, '再改成 RAII')
  assert.equal(out.turns[2].prompt, '没有活动文件时的包装')
  assert.equal(out.turns[3].prompt, 'CRLF 换行也要认')
  assert.ok(out.turns[4].prompt.startsWith('帮我把这段填一下'), '模板提问被保留')
  assert.ok(out.turns[4].prompt.includes('## Description'), '正文里的 ## 标题不能被当成包装分隔')
  assert.ok(out.turns[4].prompt.includes('### Validation'), '正文里的 ### 标题同样保留')
  assert.equal(out.title, '先看一下入口函数', '标题取首个真实提问，而不是注入块')
})
