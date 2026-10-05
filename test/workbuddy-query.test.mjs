// test/workbuddy-query.test.mjs — WorkBuddy 用户提问提取：转换器（导入的提问）与发现层（面板标题）
// 共用 lib/convert/workbuddy.mjs 的 extractWorkbuddyUserQuery 一份口径
//
// WorkBuddy 把人类提问包在 <user_query> 里，外面堆 system-reminder / project_context 等注入块。
// 有 <user_query> 取其正文；没有时剥掉 system-reminder 整块、其余标签**替换为空格**后折叠空白——
// 标签两侧的文字分属不同块，直接删标签会把相邻两段粘成一个词（此前转换器就是这样，与发现层
// 的标题不一致）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertWorkbuddyJsonl, extractWorkbuddyUserQuery } from '../lib/convert/workbuddy.mjs'

const block = (text) => ({ type: 'input_text', text })

test('<user_query> 正文优先（可跨块），去首尾空白', () => {
  assert.equal(extractWorkbuddyUserQuery([
    block('<system-reminder>\n注入\n</system-reminder>'),
    block('<user_query>\n  帮我看看\n这个项目  \n</user_query>'),
  ]), '帮我看看\n这个项目')
  assert.equal(extractWorkbuddyUserQuery([block('<user_query>第一段'), block('第二段</user_query>')]), '第一段\n第二段')
})

test('无 <user_query>：剥掉 system-reminder 整块，其余标签按词界替换为空格', () => {
  assert.equal(extractWorkbuddyUserQuery([
    block('<system-reminder>不是提问</system-reminder><project_context>repo</project_context>Fix<b>the</b>bug'),
  ]), 'repo Fix the bug')
})

test('空 / 纯注入 / 非数组 content → 空串（调用方不开轮、不作标题）', () => {
  assert.equal(extractWorkbuddyUserQuery([]), '')
  assert.equal(extractWorkbuddyUserQuery([block('<system-reminder>纯注入</system-reminder>')]), '')
  assert.equal(extractWorkbuddyUserQuery([block('<user_query>   </user_query>')]), '')
  assert.equal(extractWorkbuddyUserQuery(undefined), '')
  assert.equal(extractWorkbuddyUserQuery({ text: '不是块数组' }), '')
})

test('转换器的提问与提取口径一致（无 <user_query> 时同样不粘词）', () => {
  const raw = [
    { type: 'message', role: 'user', sessionId: 'wb-q', timestamp: 1787131157250, content: [block('<context>repo</context>Fix<b>the</b>bug')] },
    { type: 'message', role: 'assistant', sessionId: 'wb-q', timestamp: 1787131157251, content: [{ type: 'output_text', text: 'ok' }] },
  ].map((r) => JSON.stringify(r)).join('\n')
  const out = convertWorkbuddyJsonl(raw, { sourcePath: '/p/wb-q.jsonl' })
  assert.equal(out.turns[0].prompt, 'repo Fix the bug')
})
