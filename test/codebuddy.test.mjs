// codebuddy.test.mjs — CodeBuddy Code CLI 源转换核心单元测试 + import_chat 集成测试
// （假宿主见 _support/fake-host.mjs；自包含合成数据，形状按 CodeBuddy Code 的会话存储归纳，
// 不掺真实 transcript）
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { convertCodebuddyJsonl } from '../lib/convert/codebuddy.mjs'
import { convertLocalJsonl } from '../lib/convert/local-jsonl.mjs'
import { SESSION_FORMAT_VERSION } from '../lib/convert/core.mjs'
import { apply } from '../lib/index.mjs'
import { hostAbs } from './_support/host-path.mjs'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { clearScanCache } from '../lib/discovery.mjs'
import { assertToolPairing } from './_support/session-invariants.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 集成用例隔离：每个用例独立 DSH_HOME（registry 落盘在 $DSH_HOME/dsh-chat-import），
// 进程内共享的扫描缓存每用例清空。
beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
})

const SID = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const CWD = hostAbs('H:/CodexProjects/my-project')
const TS = 1787131157250

function cb(recs) {
  return recs.map((r) => JSON.stringify(r)).join('\n')
}

// CodeBuddy 的条目是 OpenAI Agents SDK 形状 + 扩展字段（sessionId / timestamp / cwd）。
// user 提问不包壳（SDK 的 user() 直出），content 可以是字符串或 input_text 块数组。
function blocks(text, type) {
  return typeof text === 'string' ? [{ type, text }] : text
}
function userRec(text, extra = {}) {
  return {
    id: 'u-' + Math.random().toString(36).slice(2), timestamp: TS, type: 'message', role: 'user',
    content: typeof text === 'string' ? text : blocks(text, 'input_text'),
    sessionId: SID, cwd: CWD, ...extra,
  }
}
function assistantRec(text, extra = {}) {
  return {
    id: 'a-' + Math.random().toString(36).slice(2), timestamp: TS, type: 'message', role: 'assistant',
    content: typeof text === 'string' ? text : blocks(text, 'output_text'),
    sessionId: SID, cwd: CWD, ...extra,
  }
}
function reasoningRec(text) {
  return {
    id: 'r-' + Math.random().toString(36).slice(2), timestamp: TS, type: 'reasoning',
    content: [{ type: 'reasoning_text', text }], sessionId: SID, cwd: CWD,
  }
}
function callRec(callId, name, args = '{}', extra = {}) {
  return {
    id: 'c-' + Math.random().toString(36).slice(2), timestamp: TS, type: 'function_call',
    callId, name, arguments: args, status: 'completed', sessionId: SID, cwd: CWD, ...extra,
  }
}
function resultRec(callId, text, extra = {}) {
  return {
    id: 'x-' + Math.random().toString(36).slice(2), timestamp: TS, type: 'function_call_result',
    callId, name: 'Bash', status: 'completed', output: { type: 'text', text }, sessionId: SID, cwd: CWD, ...extra,
  }
}

test('简单 user/assistant 轮次（content 为字符串）→ 1 轮、cwd/createdAt 落 meta', () => {
  const out = convertCodebuddyJsonl(cb([
    userRec('帮我看看这个项目'),
    assistantRec('好的，我先读一下结构。'),
  ]), { sourcePath: 'C:/Users/u/.codebuddy/projects/H--CodexProjects-my-project/' + SID + '.jsonl' })
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.id, 'import-' + SID)
  assert.equal(out.meta.sourceId, SID)
  assert.equal(out.meta.cwd, CWD)
  assert.equal(out.meta.createdAt, TS)
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].prompt, '帮我看看这个项目')
  assert.equal(out.title, '帮我看看这个项目')
})

test('content 为块数组时同样识别（input_text / output_text）', () => {
  const out = convertCodebuddyJsonl(cb([
    userRec([{ type: 'input_text', text: '数组形态提问' }]),
    assistantRec([{ type: 'output_text', text: '数组形态回答' }]),
  ]), { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].prompt, '数组形态提问')
  assert.equal(out.turns[0].steps[0].content[0].text, '数组形态回答')
})

test('框架注入的 user 条目不开轮（isMeta / skipRun / 内部续跑 / compact agent）', () => {
  const out = convertCodebuddyJsonl(cb([
    userRec('<system-reminder>上下文</system-reminder>', { isMeta: true }),
    userRec('占位不触发运行', { skipRun: true }),
    userRec('内部续跑', { startsNewUserRequest: false }),
    userRec('compact 内部消息', { agent: 'COMPACT' }),
    userRec('附带数据', { isAdditionalData: true }),
    userRec('真实提问'),
    assistantRec('回答'),
  ]), { sourcePath: '/p/' + SID + '.jsonl' })
  // 五条注入都不开轮，只有真实提问那一轮
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].prompt, '真实提问')
  // 注入内容也不该被当成标题兜底
  assert.equal(out.title, '真实提问')
})

test('reasoning 事件前插到紧随其后的步；新开轮时清空不串轮', () => {
  const out = convertCodebuddyJsonl(cb([
    userRec('问'),
    reasoningRec('先想一下'),
    assistantRec('答'),
    userRec('第二问'),
    reasoningRec('第二轮的思考'),
    assistantRec('第二答'),
  ]), { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.turns.length, 2)
  // 第一轮的推理落在第一个 assistant 步的头部
  const step1 = out.turns[0].steps[0]
  assert.equal(step1.content[0].type, 'reasoning')
  assert.equal(step1.content[0].text, '先想一下')
  // 第二轮同样只带自己的思考，不串轮
  const step2 = out.turns[1].steps[0]
  assert.equal(step2.content[0].type, 'reasoning')
  assert.equal(step2.content[0].text, '第二轮的思考')
})

test('无后续步的 reasoning 被丢弃，不串到下一轮', () => {
  const out = convertCodebuddyJsonl(cb([
    userRec('问'),
    reasoningRec('被打断的思考'),
    userRec('第二问'),
    assistantRec('第二答'),
  ]), { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.turns.length, 2)
  // 第二轮开轮前 pendingReasoning 已清空：那一步不再带上一轮的思考
  const step2 = out.turns[1].steps[0]
  assert.equal(step2.content[0].type, 'text')
})

test('工具调用与结果按 callId 配对，乱序结果归位到声明它的步', () => {
  const out = convertCodebuddyJsonl(cb([
    userRec('跑个命令'),
    callRec('call_1', 'Bash', '{"command":"ls"}'),
    callRec('call_2', 'Read', '{"file":"a.ts"}'),
    // 结果乱序到达：call_2 的结果先到
    resultRec('call_2', 'file body'),
    resultRec('call_1', 'a.ts\nb.ts'),
    assistantRec('完成'),
  ]), { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.droppedOrphanResults, 0)
  const steps = out.turns[0].steps
  const calls = steps.flatMap((s) => s.toolCalls)
  assert.equal(calls.length, 2)
  // 每个调用各自拿到自己的结果
  const byId = new Map(steps.flatMap((s) => s.toolResults).map((r) => [r.toolCallId, r]))
  assert.equal(byId.get('call_1').content[0].text, 'a.ts\nb.ts')
  assert.equal(byId.get('call_2').content[0].text, 'file body')
})

test('孤儿工具结果计数丢弃（transcript 中途开始 / 调用被过滤）', () => {
  const out = convertCodebuddyJsonl(cb([
    userRec('问'),
    // 没有对应的 function_call
    resultRec('call_ghost', '孤儿结果'),
    assistantRec('答'),
  ]), { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.droppedOrphanResults, 1)
  const results = out.turns[0].steps.flatMap((s) => s.toolResults)
  assert.equal(results.length, 0)
})

test('非 completed 的运行期结果不落盘；isError 结果如实标记', () => {
  const out = convertCodebuddyJsonl(cb([
    userRec('问'),
    callRec('call_ok', 'Bash'),
    callRec('call_bad', 'Bash'),
    callRec('call_err', 'mcp'),
    resultRec('call_ok', 'ok'),
    resultRec('call_bad', 'boom', { status: 'incomplete' }),
    resultRec('call_err', 'MCP 失败', { status: 'completed', output: { isError: true, text: 'MCP 失败' } }),
    assistantRec('答'),
  ]), { sourcePath: '/p/' + SID + '.jsonl' })
  const results = out.turns[0].steps.flatMap((s) => s.toolResults)
  const byId = new Map(results.map((r) => [r.toolCallId, r]))
  assert.equal(byId.has('call_ok'), true)
  assert.equal(byId.get('call_ok').isError, false)
  assert.equal(byId.has('call_bad'), false)
  assert.equal(byId.get('call_err').isError, true)
})

test('usage 四桶映射：camelCase 与 snake_case 两代键名都认', () => {
  const camel = convertCodebuddyJsonl(cb([
    userRec('问'),
    assistantRec('答', { providerData: { model: 'glm-5.2', usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 30, reasoningTokens: 5 } } }),
  ]), { sourcePath: '/p/' + SID + '.jsonl' })
  assert.deepEqual(camel.turns[0].steps[0].usage, {
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, reasoningTokens: 5,
  })
  // 模型名落到 assistant 消息的 source（provider 归 codebuddy）
  const asst = camel.events.find((e) => e.data && e.data.message && e.data.message.role === 'assistant')
  assert.equal(asst.data.message.source.model, 'glm-5.2')
  assert.equal(asst.data.message.source.provider, 'codebuddy')

  const snake = convertCodebuddyJsonl(cb([
    userRec('问'),
    assistantRec('答', { providerData: { model: 'kimi-k2', rawUsage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 4, reasoning_tokens: 1 } } }),
  ]), { sourcePath: '/p/' + SID + '.jsonl' })
  assert.deepEqual(snake.turns[0].steps[0].usage, {
    inputTokens: 7, outputTokens: 2, cacheReadTokens: 4, reasoningTokens: 1,
  })
})

test('缺必填桶的 usage 整份丢弃（不投影出半个 usage）', () => {
  const out = convertCodebuddyJsonl(cb([
    userRec('问'),
    assistantRec('答', { providerData: { usage: { outputTokens: 20 } } }),
  ]), { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.turns[0].steps[0].usage, undefined)
})

test('custom-title / ai-title 作显式标题，优先于首问兜底', () => {
  const custom = convertCodebuddyJsonl(cb([
    userRec('首问不该当标题'),
    assistantRec('答'),
    { type: 'custom-title', customTitle: '我改的名字', sessionId: SID, timestamp: TS },
  ]), { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(custom.title, '我改的名字')

  const ai = convertCodebuddyJsonl(cb([
    userRec('首问不该当标题'),
    assistantRec('答'),
    { type: 'ai-title', aiTitle: '生成的标题', sessionId: SID, timestamp: TS },
  ]), { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(ai.title, '生成的标题')

  // 重命名后到者胜：两条 custom-title 取最后一条
  const renamed = convertCodebuddyJsonl(cb([
    userRec('问'),
    assistantRec('答'),
    { type: 'custom-title', customTitle: '第一个名字', sessionId: SID, timestamp: TS },
    { type: 'custom-title', customTitle: '第二个名字', sessionId: SID, timestamp: TS + 10 },
  ]), { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(renamed.title, '第二个名字')
})

test('运行期 custom 条目只计数不进正文（droppedMetaItems）', () => {
  const out = convertCodebuddyJsonl(cb([
    userRec('问'),
    { type: 'turn-metrics', id: 'tm', timestamp: TS, durationMs: 100, tokenDelta: 5 },
    { type: 'context-usage', id: 'cu', timestamp: TS, contextTokens: 1000, usageByCategory: { systemPrompt: 1, conversation: 2, tools: 3, mcp: 4, skills: 5, version: 1 } },
    { type: 'credit-usage', id: 'cr', timestamp: TS, providerData: { conversationRequestId: 'r', credit: 1, source: 'team_member', stageId: 's' } },
    { type: 'file-history-snapshot', messageId: 'm', timestamp: TS, isSnapshotUpdate: false, snapshot: { messageId: 'm', trackedFileBackups: {} } },
    { type: 'resend-fork-notice', id: 'rf', timestamp: TS },
    assistantRec('答'),
  ]), { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.droppedMetaItems, 5)
  assert.equal(out.turns.length, 1)
  // 正文里不剩任何运行期痕迹
  const texts = out.turns[0].steps.flatMap((s) => s.content).map((b) => b.text || '')
  assert.ok(!texts.some((t) => /turn-metrics|context-usage|credit-usage|file-history/.test(t)))
})

test('畸形 JSONL 行 → skipped 计数 + skippedLines 明细（不上报内容）', () => {
  const raw = [
    JSON.stringify(userRec('正常提问')),
    '{ 这不是 JSON',
    JSON.stringify(assistantRec('部分回答')),
  ].join('\n')
  const out = convertCodebuddyJsonl(raw, { sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.skipped, 1)
  assert.equal(out.skippedLines.length, 1)
  assert.equal(out.skippedLines[0].line, 2)
  assert.ok(!String(out.skippedLines[0].error).includes('这不是 JSON'))
  assert.equal(out.turns.length, 1)
})

test('空 / 全注入 transcript → 无可导入内容，不抛异常', () => {
  for (const raw of ['', '\n\n', cb([userRec('x', { isMeta: true })])]) {
    const out = convertCodebuddyJsonl(raw, { sourcePath: '/p/' + SID + '.jsonl' })
    assert.equal(out.turns.length, 0)
  }
})

test('无 sessionId 的事件 → 以 args.codebuddyId 兜底作稳定源 id', () => {
  const out = convertCodebuddyJsonl(cb([
    { id: 'u', timestamp: TS, type: 'message', role: 'user', content: '问', cwd: CWD },
    { id: 'a', timestamp: TS, type: 'message', role: 'assistant', content: '答', cwd: CWD },
  ]), { codebuddyId: SID, sourcePath: '/p/' + SID + '.jsonl' })
  assert.equal(out.meta.id, 'import-' + SID)
  assert.equal(out.meta.sourceId, SID)
})

// ── local-jsonl 自动识别 ───────────────────────────────────────────────────

test('convertLocalJsonl：.codebuddy/projects 下的 history 自动识别为 codebuddy', () => {
  const out = convertLocalJsonl(cb([
    userRec('识别我'),
    assistantRec('答'),
  ]), { sourcePath: 'C:/Users/u/.codebuddy/projects/H--CodexProjects-my-project/' + SID + '.jsonl' })
  assert.equal(out.detectedFormat, 'codebuddy')
  assert.equal(out.detectedBy, 'path-hint')
  assert.equal(out.turns.length, 1)
})

// ── 工具集成（import_chat { format: 'codebuddy' }） ─────────────────────────

test('import_chat 工具可正常导入 CodeBuddy 会话文件', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-codebuddy-tool-'))
  try {
    const projDir = join(tmp, 'H--CodexProjects-my-project')
    mkdirSync(projDir, { recursive: true })
    const sessionFile = join(projDir, SID + '.jsonl')
    writeFileSync(sessionFile, cb([
      userRec('帮我看看这个项目'),
      reasoningRec('先看目录'),
      callRec('call_1', 'Bash', '{"command":"ls"}'),
      resultRec('call_1', 'a.ts'),
      assistantRec('目录里有 a.ts'),
    ]))

    const { ctx, persistence } = makeCtx(null, { real: true })
    apply(ctx)
    const importTool = chatDef(ctx, 'import_chat')
    assert.ok(importTool, 'import_chat 工具已注册')

    const result = await importTool.execute({ format: 'codebuddy', path: sessionFile })
    assert.equal(result.status, 'imported')
    assert.equal(result.turns, 1)
    assert.equal(persistence.sessions.size, 1)

    const [created] = persistence.sessions.values()
    assert.equal(created.meta.id, 'import-' + SID)
    assert.ok(created.events.length > 0)
    const types = created.events.map((e) => e.type)
    assert.ok(types.includes('user/message'))
    assert.ok(types.includes('tool/call'))
    assert.ok(types.includes('tool/result'))
    assertEnvelopeHygiene(created.events)
    assertToolPairing(created.events)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('import_chat 幂等：重复导入同一文件已存在则跳过', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-codebuddy-idem-'))
  try {
    const projDir = join(tmp, 'proj')
    mkdirSync(projDir, { recursive: true })
    const sessionFile = join(projDir, SID + '.jsonl')
    writeFileSync(sessionFile, cb([userRec('问'), assistantRec('答')]))

    const { ctx, persistence } = makeCtx(null, { real: true })
    apply(ctx)
    const importTool = chatDef(ctx, 'import_chat')

    const first = await importTool.execute({ format: 'codebuddy', path: sessionFile })
    assert.equal(first.status, 'imported')
    const second = await importTool.execute({ format: 'codebuddy', path: sessionFile })
    assert.equal(second.status, 'already-imported')
    assert.equal(persistence.sessions.size, 1)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('伴生元数据 .meta.json 不当成会话（否则同一会话被导入两次）', async () => {
  const { isSidecarJson } = await import('../lib/import-batch.mjs')
  assert.equal(isSidecarJson(SID + '.meta.json'), true)
  assert.equal(isSidecarJson(SID + '.jsonl'), false)
  // 普通会话 json（ChatGPT / Gemini 导出）不受影响
  assert.equal(isSidecarJson('conversations.json'), false)
  const { isImportableName } = await import('../lib/file-import.mjs')
  assert.equal(isImportableName(SID + '.meta.json'), false)
  assert.equal(isImportableName(SID + '.jsonl'), true)
})
