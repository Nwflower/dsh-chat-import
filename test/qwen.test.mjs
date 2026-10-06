// qwen.test.mjs — 千问办公（Qwen Work CN）源转换核心单元测试（自包含合成数据，不掺真实 transcript）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { convertQwenJsonl, realWorkspaceDir } from '../lib/convert/qwen.mjs'
import { SESSION_FORMAT_VERSION } from '../lib/convert/core.mjs'
import { assertToolPairing } from './_support/session-invariants.mjs'

function qw(recs) {
  return recs.map((r) => JSON.stringify(r)).join('\n')
}

const SID = '5543d6df-ec9e-4ce9-842d-aaa9cc74867f'
const QWEN_WS = 'C:\\Users\\Administrator\\.qwenworkcn\\workspace\\ws-demo-0001'
const REAL_DIR = 'E:\\dev-suite\\demo.Client-app'
const TS = '2026-08-28T08:09:41.457Z'

function wsDirsRec() {
  return { type: 'workspace-directories', sessionId: SID, directories: [QWEN_WS, REAL_DIR] }
}
function runtimeRec(model) {
  return { type: 'runtime-config', sessionId: SID, model, reasoningEffort: 'medium', contextWindow: 262144, generation: 'qwen4-preview' }
}
function humanRec(text) {
  return {
    type: 'user', sessionId: SID, timestamp: TS, uuid: 'u1', parentUuid: null, isSidechain: false,
    cwd: QWEN_WS, promptId: 'p1', humanInput: { text, mode: 'prompt' },
    message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>\n环境注入\n</system-reminder>' }] },
  }
}
// 无 humanInput 的 user 记录：content text 块是唯一人类文本来源（2026-08-28 实测 26/70）
function userTextRec(text) {
  return {
    type: 'user', sessionId: SID, timestamp: TS, uuid: 'u2', parentUuid: null, isSidechain: false,
    cwd: QWEN_WS,
    message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>注入</system-reminder>' }, { type: 'text', text }] },
  }
}
function toolResultRec(callId, text) {
  return {
    type: 'user', sessionId: SID, timestamp: TS, uuid: 'u3', parentUuid: 'a1', isSidechain: false,
    cwd: QWEN_WS, toolUseResult: { stdout: text },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: [{ type: 'text', text }] }] },
  }
}
function assistantRec(content, extras = {}) {
  return {
    type: 'assistant', sessionId: SID, timestamp: TS, uuid: 'a1', parentUuid: 'u1', isSidechain: false,
    cwd: QWEN_WS, message: { role: 'assistant', model: 'qwen3.8-flash', content }, ...extras,
  }
}

test('简单轮次：humanInput 首问 + workspace-directories 项目 + runtime-config 模型', () => {
  const out = convertQwenJsonl(qw([
    wsDirsRec(),
    runtimeRec('qwen3.8-flash'),
    humanRec('出个html介绍一下ai领域的思路'),
    assistantRec([{ type: 'thinking', thinking: '先想一下' }, { type: 'text', text: '好的，我来介绍' }]),
  ]), { sourcePath: 'C:/Users/u/.qwenworkcn/projects/slug/' + SID + '.jsonl' })
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.sourceId, SID)
  assert.equal(out.meta.cwd, REAL_DIR) // 记录内 cwd 是千问临时工作区，取 workspace-directories 真实目录
  assert.equal(out.title, '出个html介绍一下ai领域的思路')
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].prompt, '出个html介绍一下ai领域的思路') // humanInput 权威，注入块不进提问
  assert.ok(out.messages >= 2)
  assert.equal(out.skippedSystemUsers, 0)
})

test('无 humanInput 的 user 记录回退 text 块（跳过 <system 注入块）；纯注入记录不计丢失', () => {
  const out = convertQwenJsonl(qw([
    wsDirsRec(),
    humanRec('第一问'),
    assistantRec([{ type: 'text', text: '答' }]),
    userTextRec('第二问（无 humanInput）'),
    assistantRec([{ type: 'text', text: '答2' }]),
  ]), { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.turns.length, 2)
  assert.equal(out.turns[1].prompt, '第二问（无 humanInput）')

  const onlyInjected = convertQwenJsonl(qw([
    wsDirsRec(),
    { type: 'user', sessionId: SID, timestamp: TS, cwd: QWEN_WS, message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>只有注入</system-reminder>' }] } },
    assistantRec([{ type: 'text', text: '答' }]),
  ]), { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(onlyInjected.turns.length, 0)
  assert.equal(onlyInjected.skippedSystemUsers, 1) // 正常注入载体，不计 droppedUserPrompts
  assert.equal(onlyInjected.droppedUserPrompts, 0)
})

test('tool_use/tool_result 配对：result 后置按 tool_use_id 挂回 call 所属 step', () => {
  const out = convertQwenJsonl(qw([
    wsDirsRec(),
    humanRec('跑一下 ls'),
    assistantRec([{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'ls' } }]),
    toolResultRec('call-1', 'file-a\nfile-b'),
    assistantRec([{ type: 'text', text: '列出两个文件' }]),
  ]), { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].steps.length, 2)
  assert.equal(out.toolCalls, 1)
  assert.equal(out.droppedToolResults, 0)
  assertToolPairing(out.events)
})

test('fileStem 与 sessionId 不一致的辅助转写被跳过（防撞 id）', () => {
  const out = convertQwenJsonl(qw([
    wsDirsRec(),
    humanRec('问'),
  ]), { fileStem: 'other-uuid', sourcePath: '/p/other-uuid.jsonl' })
  assert.equal(out.meta, null)
  assert.equal(out.events.length, 0)
  assert.match(out.skipReason, /auxiliary transcript/)
})

test('realWorkspaceDir：非 .qwenworkcn 目录优先；纯千问目录返回 null', () => {
  assert.equal(realWorkspaceDir([QWEN_WS, REAL_DIR]), REAL_DIR)
  assert.equal(realWorkspaceDir([QWEN_WS]), null)
  assert.equal(realWorkspaceDir(undefined), null)
  assert.equal(realWorkspaceDir(['D:/plain/project']), 'D:/plain/project')
})
