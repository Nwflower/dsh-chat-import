// test/codearts.test.mjs — CodeArts Desktop 会话导入单元与集成测试（合成数据）
//
// 夹具按 CodeArts 真实存储形状合成：history.jsonl 一行一条消息，
// content 是 Rust serde 变体（SinglePart / MultiPart，元素是 Text / ToolCall / ToolResult）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { convertCodeartsJson, parseCodeartsTime } from '../lib/convert/codearts.mjs'
import {
  codeartsUserDataDirs,
  listCodeartsSessions,
  readCodeartsSessionSummary,
  previewCodeartsDirectory,
  previewCodeartsFile,
} from '../lib/sources/codearts.mjs'
import { convertLocalJsonl } from '../lib/convert/local-jsonl.mjs'
import { discoverSessions } from '../lib/discovery.mjs'
import { apply } from '../lib/index.mjs'
import { hostAbs } from './_support/host-path.mjs'
import { makeCtx, toolDef } from './_support/fake-host.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'
import { clearScanCache } from '../lib/discovery/scan-cache.mjs'

// 集成用例隔离：每个用例独立 DSH_HOME（registry 落盘在 $DSH_HOME/dsh-chat-import），
// 进程内共享的扫描缓存每用例清空。
beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
})

const TEST_CWD = hostAbs('C:/projects/codearts-demo')

function syntheticMeta(overrides = {}) {
  return {
    session_id: 'ff119714-beda-42a7-b9c2-06ee66fb0927',
    created_at: '2026-10-29T21:47:28.195777600Z',
    updated_at: '2026-10-30T02:32:12.494756500Z',
    title: 'CodeArts synthetic test session',
    working_directory: TEST_CWD,
    used_tokens: 3975509,
    user_turn_count: 5,
    agent_name: 'built_in_agent',
    current_model: { provider_id: 'inferhub-provider', model_id: 'deepseek-v4.1-flash-1017' },
    metadata: { clientType: 'desktop', clientVersion: '0.2.6' },
    ...overrides,
  }
}

// 消息按 CodeArts 的真实形状合成：用户提问是 SinglePart.Text，
// 助手消息是 MultiPart（Text + ToolCall），工具结果是独立的 role:'Tool' 消息。
function syntheticMessages() {
  return [
    {
      id: 'msg_189a1dbbb0022CHr1o5ciX62iw',
      role: 'User',
      content: { SinglePart: { Text: { id: 'prt_189a1dbbb0016yV0sKHO52EmEe', text: '列出当前目录的文件' } } },
      timestamp: '2026-10-29T21:47:28.572955600Z',
      model_ref: { provider_id: 'inferhub-provider', model_id: 'deepseek-v4.1-flash-1017' },
      token_usage: null,
      finish_reason: null,
      reasoning_content: null,
      synthetic: false,
      agent: 'CLI Agent',
    },
    {
      id: 'msg_189a1dc04001SVhJnd5toN1Knc',
      role: 'Assistant',
      content: {
        MultiPart: [
          { Text: { id: 'prt_a1', text: '我先跑一下 ls。' } },
          {
            ToolCall: {
              internal_id: 'prt_b1',
              id: 'call_f2a16306341c4dc6b6f64d64',
              name: 'bash',
              arguments: { command: 'ls -la' },
            },
          },
        ],
      },
      timestamp: '2026-10-29T21:47:33.219544300Z',
      model_ref: { provider_id: 'inferhub-provider', model_id: 'deepseek-v4.1-flash-1017' },
      token_usage: {
        prompt_tokens: 8868, completion_tokens: 509, total_tokens: 9377,
        max_tokens: 1044480, reasoning_tokens: 296, cached_tokens: 512,
      },
      finish_reason: 'tool_calls',
      reasoning_content: '用户想看目录内容，先跑 ls。',
      synthetic: false,
      agent: 'CLI Agent',
    },
    {
      id: 'msg_189a1edee003GI7IHn6xoxiQAI',
      role: 'Tool',
      content: {
        MultiPart: [
          {
            ToolResult: {
              id: 'prt_189a1edee001Xob7jHEttyJC8R',
              tool_call_id: 'call_f2a16306341c4dc6b6f64d64',
              tool_result: {
                tool_name: 'bash',
                success: true,
                formatted_output: 'file1.txt\nfile2.js',
                tool_output: 'file1.txt\nfile2.js',
                error: null,
                title: 'bash',
                metadata: null,
                attachments: null,
              },
            },
          },
        ],
      },
      timestamp: '2026-10-29T21:47:33.230819800Z',
      model_ref: { provider_id: 'inferhub-provider', model_id: 'deepseek-v4.1-flash-1017' },
      token_usage: null,
      finish_reason: null,
      reasoning_content: null,
      synthetic: false,
      agent: 'CLI Agent',
    },
    {
      id: 'msg_189a1ee01001LUR3z6DJc2wLMC',
      role: 'Assistant',
      content: { SinglePart: { Text: { id: 'prt_c1', text: '目录里有 file1.txt 和 file2.js。' } } },
      timestamp: '2026-10-29T21:47:35.000000000Z',
      model_ref: { provider_id: 'inferhub-provider', model_id: 'deepseek-v4.1-flash-1017' },
      token_usage: {
        prompt_tokens: 9000, completion_tokens: 30, total_tokens: 9030,
        max_tokens: 1044480, reasoning_tokens: 0, cached_tokens: 512,
      },
      finish_reason: 'stop',
      reasoning_content: null,
      synthetic: false,
      agent: 'CLI Agent',
    },
  ]
}

function syntheticJsonl(messages = syntheticMessages()) {
  return messages.map((m) => JSON.stringify(m)).join('\n')
}

// ── 转换器单测 ─────────────────────────────────────────────────────────────

test('parseCodeartsTime: RFC3339 纳秒时间戳与毫秒值', () => {
  // 纳秒小数部分被截断到毫秒
  assert.equal(parseCodeartsTime('2026-10-01T12:00:00.123456789Z'), 1790856000123)
  assert.equal(parseCodeartsTime(1790856000000), 1790856000000)
  assert.equal(parseCodeartsTime(null), undefined)
})

test('convertCodeartsJson: user/assistant/tool 转换与工具调用配对', () => {
  const meta = syntheticMeta()
  const out = convertCodeartsJson(syntheticJsonl(), { meta, sourcePath: '/tmp/sessions/bucket/ff119714/history.jsonl' })

  assert.ok(out.meta)
  assert.equal(out.meta.id, 'import-ff119714-beda-42a7-b9c2-06ee66fb0927')
  assert.equal(out.meta.sourceId, 'ff119714-beda-42a7-b9c2-06ee66fb0927')
  assert.equal(out.meta.cwd, TEST_CWD)
  assert.equal(out.title, 'CodeArts synthetic test session')
  assert.equal(out.turns.length, 1)

  const turn = out.turns[0]
  assert.equal(turn.prompt, '列出当前目录的文件')
  assert.equal(turn.steps.length, 2)

  // 第一步：reasoning + text + tool-call + 配对的 tool-result
  const step1 = turn.steps[0]
  assert.equal(step1.content[0].type, 'reasoning')
  assert.match(step1.content[0].text, /先跑 ls/)
  assert.equal(step1.content[1].type, 'text')
  assert.match(step1.content[1].text, /跑一下 ls/)
  assert.equal(step1.toolCalls.length, 1)
  assert.equal(step1.toolCalls[0].id, 'call_f2a16306341c4dc6b6f64d64')
  assert.equal(step1.toolCalls[0].name, 'bash')
  // arguments 是对象 → 序列化成 JSON 字符串
  assert.equal(step1.toolCalls[0].arguments, '{"command":"ls -la"}')
  assert.equal(step1.toolResults.length, 1)
  assert.equal(step1.toolResults[0].toolCallId, 'call_f2a16306341c4dc6b6f64d64')
  assert.equal(step1.toolResults[0].content[0].text, 'file1.txt\nfile2.js')
  assert.equal(step1.toolResults[0].isError, false)

  // usage 四桶映射
  assert.deepEqual(step1.usage, {
    inputTokens: 8868, outputTokens: 509, cacheReadTokens: 512, reasoningTokens: 296,
  })

  // 第二步：纯文本回复
  const step2 = turn.steps[1]
  assert.equal(step2.toolCalls.length, 0)
  assert.match(step2.content[0].text, /file1\.txt/)
  assert.equal(out.droppedToolResults, 0)
})

test('convertCodeartsJson: synthetic 上下文注入标 plugin 来源且不计标题', () => {
  const messages = [
    syntheticMessages()[0],
    {
      id: 'msg_inject',
      role: 'User',
      content: { SinglePart: { Text: { id: 'prt_i', text: '## Current Todo List\n\n• [→] 检查本地环境' } } },
      timestamp: '2026-10-29T21:47:30.000000000Z',
      synthetic: true,
    },
    {
      id: 'msg_real',
      role: 'User',
      content: { SinglePart: { Text: { id: 'prt_r', text: '继续' } } },
      timestamp: '2026-10-29T21:47:31.000000000Z',
      synthetic: false,
    },
    syntheticMessages()[3],
  ]
  const out = convertCodeartsJson(syntheticJsonl(messages), { meta: syntheticMeta({ title: null }) })

  assert.equal(out.turns.length, 3)
  // 注入轮标 plugin：内容顺序不变，但不作标题回退
  assert.deepEqual(out.turns[1].promptSource, { kind: 'plugin', plugin: 'chat-import' })
  assert.equal(out.turns[1].prompt, '## Current Todo List\n\n• [→] 检查本地环境')
  assert.equal(out.turns[2].promptSource, undefined)
  assert.equal(out.injectedPrompts, 1)
  // 标题回退到首条真人提问（不是注入内容）
  assert.equal(out.title, '列出当前目录的文件')
})

test('convertCodeartsJson: 未配对工具结果计数丢弃，无前驱 assistant 跳过', () => {
  const messages = [
    {
      id: 'msg_orphan_assistant', role: 'Assistant',
      content: { SinglePart: { Text: { id: 'prt_x', text: '孤儿回复' } } },
      timestamp: '2026-10-29T21:47:28.000000000Z',
    },
    syntheticMessages()[0],
    {
      id: 'msg_orphan_tool', role: 'Tool',
      content: {
        MultiPart: [{
          ToolResult: {
            id: 'prt_y', tool_call_id: 'call_unknown',
            tool_result: { tool_name: 'bash', success: true, formatted_output: 'orphan', attachments: null },
          },
        }],
      },
      timestamp: '2026-10-29T21:47:34.000000000Z',
    },
  ]
  const out = convertCodeartsJson(syntheticJsonl(messages), { meta: syntheticMeta() })

  assert.equal(out.turns.length, 1)
  assert.equal(out.droppedToolResults, 1)
  assert.ok(out.skipped >= 1)
})

test('convertCodeartsJson: 失败工具结果标 isError', () => {
  const messages = [
    syntheticMessages()[0],
    {
      id: 'msg_a', role: 'Assistant',
      content: {
        MultiPart: [{
          ToolCall: { internal_id: 'prt_c', id: 'call_fail', name: 'bash', arguments: { command: 'x' } },
        }],
      },
      timestamp: '2026-10-29T21:47:33.000000000Z',
    },
    {
      id: 'msg_r', role: 'Tool',
      content: {
        MultiPart: [{
          ToolResult: {
            id: 'prt_r', tool_call_id: 'call_fail',
            tool_result: { tool_name: 'bash', success: false, error: 'Cancelled', attachments: null },
          },
        }],
      },
      timestamp: '2026-10-29T21:47:34.000000000Z',
    },
  ]
  const out = convertCodeartsJson(syntheticJsonl(messages), { meta: syntheticMeta() })
  const result = out.turns[0].steps[0].toolResults[0]
  assert.equal(result.isError, true)
  // formatted_output 缺失 → 回退 error 文本
  assert.equal(result.content[0].text, 'Cancelled')
})

test('convertCodeartsJson: 同一 callId 的重复调用塌缩为首次（折叠器 invariant 守护）', () => {
  // 源里同一 callId 出现两次 tool-call（畸形 / 重发）：DSH 会话折叠器对第二次同 id start
  // 会硬异常并吞掉整段轨迹，共用件 dropDuplicateCalls 只留首次，计数 droppedDuplicateCalls。
  const call = (id) => ({ ToolCall: { internal_id: 'i', id, name: 'bash', arguments: { command: 'x' } } })
  const messages = [
    syntheticMessages()[0],
    {
      id: 'msg_a1', role: 'Assistant',
      content: { MultiPart: [call('call_dup')] },
      timestamp: '2026-10-29T21:47:33.000000000Z',
    },
    {
      id: 'msg_a2', role: 'Assistant',
      content: { MultiPart: [call('call_dup')] },
      timestamp: '2026-10-29T21:47:34.000000000Z',
    },
    {
      id: 'msg_r', role: 'Tool',
      content: {
        MultiPart: [{
          ToolResult: {
            id: 'prt_r', tool_call_id: 'call_dup',
            tool_result: { tool_name: 'bash', success: true, formatted_output: 'ok', attachments: null },
          },
        }],
      },
      timestamp: '2026-10-29T21:47:35.000000000Z',
    },
  ]
  const out = convertCodeartsJson(syntheticJsonl(messages), { meta: syntheticMeta() })
  assert.equal(out.droppedDuplicateCalls, 1)
  const calls = out.turns[0].steps.flatMap((s) => s.toolCalls)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, 'call_dup')
  // 结果仍按 callId 配到保留的首次调用
  const results = out.turns[0].steps.flatMap((s) => s.toolResults)
  assert.equal(results.length, 1)
  assert.equal(results[0].toolCallId, 'call_dup')
})

test('convertCodeartsJson: 首条是注入时标题跳过注入取首条真人提问', () => {
  const inject = (text) => ({
    id: 'msg_inj', role: 'User',
    content: { SinglePart: { Text: { id: 'prt_i', text } } },
    timestamp: '2026-10-29T21:47:28.000000000Z', synthetic: true,
  })
  const real = (text) => ({
    id: 'msg_real', role: 'User',
    content: { SinglePart: { Text: { id: 'prt_r', text } } },
    timestamp: '2026-10-29T21:47:29.000000000Z', synthetic: false,
  })
  const assistant = {
    id: 'msg_a', role: 'Assistant',
    content: { SinglePart: { Text: { id: 'prt_a', text: '好的' } } },
    timestamp: '2026-10-29T21:47:30.000000000Z',
  }

  // 首注入 + 后真人 → 标题取真人提问（注入文本永不钉成标题）
  const out1 = convertCodeartsJson(syntheticJsonl([inject('## Current Todo List'), real('继续'), assistant]), { meta: syntheticMeta({ title: null }) })
  assert.equal(out1.title, '继续')

  // 全是注入 → 空标题（pin 层落「未命名 · 日期」，与 kimi 同口径）
  const out2 = convertCodeartsJson(syntheticJsonl([inject('## Current Todo List'), assistant]), { meta: syntheticMeta({ title: null }) })
  assert.equal(out2.title, '')

  // meta 有 title 时照用，与注入无关
  const out3 = convertCodeartsJson(syntheticJsonl([inject('x'), real('y')]), { meta: syntheticMeta() })
  assert.equal(out3.title, 'CodeArts synthetic test session')
})

test('convertCodeartsJson: 认不出的入参一律降级为 skipResult，不抛异常', () => {
  // 转换器被 local-jsonl 探测 / 宿主导入 / 预览三条路径直接调用，契约上不抛异常——
  // 抛了会让批量导入在该条上中断。认不出的入参按「无消息」处理。
  const junk = [{}, [1, 2], 42, null, undefined, { messages: 'not-array' }, { messages: {} }]
  for (const raw of junk) {
    const out = convertCodeartsJson(raw, { meta: { session_id: 'x' } })
    assert.equal(out.meta, null, String(raw))
    assert.equal(out.turns.length, 0)
    assert.equal(out.skipReason, 'no user turns found in CodeArts session')
  }
})

test('convertCodeartsJson: 未识别的 role 不开轮，返回 skipReason', () => {
  // 未识别的 role（源里只有 User/Assistant/Tool）→ 不开轮 → skipResult
  const out = convertCodeartsJson('{"role":"System","content":{"SinglePart":{"Text":{"text":"x"}}}}')
  assert.equal(out.meta, null)
  assert.equal(out.turns.length, 0)
  assert.equal(out.skipReason, 'no user turns found in CodeArts session')
})

test('convertCodeartsJson: 畸形行计数上报不影响其余消息', () => {
  const raw = ['{ broken json', ...syntheticMessages().map((m) => JSON.stringify(m))].join('\n')
  const out = convertCodeartsJson(raw, { meta: syntheticMeta() })
  assert.equal(out.turns.length, 1)
  assert.equal(out.skipped, 1)
  assert.ok(out.skippedLines.length >= 1)
})

// ── local-jsonl 自动识别 ───────────────────────────────────────────────────

test('convertLocalJsonl: codearts 的 history.jsonl 自动识别为 codearts', () => {
  const raw = syntheticJsonl()
  const out = convertLocalJsonl(raw, {
    sourcePath: '/home/u/.codearts/kernel/sessions/2026-10-30-05-47-28-a198caeba310ddb3/ff119714/history.jsonl',
  })
  assert.equal(out.detectedFormat, 'codearts')
  assert.equal(out.detectedBy, 'path-hint')
  assert.equal(out.turns.length, 1)
})

// ── 发现层单测 ─────────────────────────────────────────────────────────────

test('listCodeartsSessions & readCodeartsSessionSummary 下钻两层目录并抽摘要', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-codearts-discover-'))
  try {
    const bucket = join(tmp, '2026-10-30-05-47-28-a198caeba310ddb3')
    const sessionDir = join(bucket, 'ff119714-beda-42a7-b9c2-06ee66fb0927')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify(syntheticMeta({ title: 'Discovered Session' })))
    writeFileSync(join(sessionDir, 'history.jsonl'), syntheticJsonl())

    const files = new Map()
    files.set(tmp, { type: 'dir' })
    files.set(bucket, { type: 'dir' })
    files.set(sessionDir, { type: 'dir' })
    files.set(join(sessionDir, 'meta.json'), { type: 'file', size: 100, mtimeMs: 1700000000000 })
    files.set(join(sessionDir, 'history.jsonl'), { type: 'file', size: 500, mtimeMs: 1700000000000 })

    const host = {
      async stat(p) {
        const item = files.get(p)
        if (!item) return null
        return item.type === 'dir' ? { type: 'directory' } : { type: 'file', size: item.size, mtimeMs: item.mtimeMs }
      },
      async readDir(p) {
        if (p === tmp) return [{ name: '2026-10-30-05-47-28-a198caeba310ddb3', type: 'directory', path: bucket }]
        if (p === bucket) return [{ name: 'ff119714-beda-42a7-b9c2-06ee66fb0927', type: 'directory', path: sessionDir }]
        return []
      },
      async readText(p) {
        if (p === join(sessionDir, 'meta.json')) return JSON.stringify(syntheticMeta({ title: 'Discovered Session' }))
        if (p === join(sessionDir, 'history.jsonl')) return syntheticJsonl()
        return null
      },
      async readHead(p) {
        if (p === join(sessionDir, 'history.jsonl')) return syntheticJsonl()
        return null
      },
    }

    const sessions = await listCodeartsSessions(host, tmp)
    assert.equal(sessions.length, 1)
    // 三种 target 形态同口径：启动桶、会话目录本身
    assert.deepEqual(await listCodeartsSessions(host, bucket), [sessionDir])
    assert.deepEqual(await listCodeartsSessions(host, sessionDir), [sessionDir])
    const summary = await readCodeartsSessionSummary(host, sessions[0])
    assert.equal(summary.title, 'Discovered Session')
    assert.equal(summary.directory, TEST_CWD)
    // meta.used_tokens 是累计消耗而非当前上下文占用 → 不映射 contextTokens（不虚构）
    assert.equal(summary.contextTokens, undefined)

    // discoverSessions 集成
    const disc = await discoverSessions({ path: tmp, format: 'codearts', host, imports: {} })
    assert.equal(disc.total, 1)
    assert.equal(disc.sessions[0].format, 'codearts')
    assert.equal(disc.sessions[0].title, 'Discovered Session')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('codeartsUserDataDirs: 解析 CODEARTS_HOME 与默认 ~/.codearts 路径', () => {
  const defaultDirs = codeartsUserDataDirs('/mock/home')
  assert.ok(defaultDirs.some((d) => d.includes('.codearts')))

  const originalEnv = process.env.CODEARTS_HOME
  try {
    process.env.CODEARTS_HOME = '/custom/codearts'
    const customDirs = codeartsUserDataDirs('/mock/home')
    assert.ok(customDirs.some((d) => d.includes('custom')))
  } finally {
    if (originalEnv !== undefined) process.env.CODEARTS_HOME = originalEnv
    else delete process.env.CODEARTS_HOME
  }
})

test('codeartsUserDataDirs: 空白或相对路径的 CODEARTS_HOME 被忽略（不造出垃圾根）', () => {
  const originalEnv = process.env.CODEARTS_HOME
  try {
    for (const bogus of ['', '   ', 'relative/path', './rel']) {
      process.env.CODEARTS_HOME = bogus
      const dirs = codeartsUserDataDirs('/mock/home')
      // 只剩默认根；不得把相对路径当来源根（面板会把它当成真来源列出来）
      assert.deepEqual(dirs, [join('/mock/home', '.codearts', 'kernel', 'sessions')], `CODEARTS_HOME=${JSON.stringify(bogus)}`)
    }
    // 绝对路径仍生效（盘符与 POSIX 根两种口径）
    for (const good of ['/abs/codearts', 'C:\\abs\\codearts']) {
      process.env.CODEARTS_HOME = good
      const dirs = codeartsUserDataDirs('/mock/home')
      assert.equal(dirs.length, 2, `CODEARTS_HOME=${good} 应同时给出自定义根与默认根`)
      assert.ok(dirs[0].includes('kernel'), good)
    }
  } finally {
    if (originalEnv !== undefined) process.env.CODEARTS_HOME = originalEnv
    else delete process.env.CODEARTS_HOME
  }
})

// ── 工具集成测试（import_chat { format: 'codearts' }） ──────────────────────

test('import_chat 工具可正常导入 CodeArts 会话目录', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-codearts-tool-'))
  try {
    const bucket = join(tmp, '2026-10-30-05-47-28-a198caeba310ddb3')
    const sessionDir = join(bucket, 'ff119714-beda-42a7-b9c2-06ee66fb0927')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify(syntheticMeta({ title: 'Tool Imported Session' })))
    writeFileSync(join(sessionDir, 'history.jsonl'), syntheticJsonl())

    const { ctx, persistence } = makeCtx(null, { real: true })
    const createdSessions = persistence.sessions

    apply(ctx)
    const importTool = toolDef(ctx, 'import_chat')
    assert.ok(importTool, 'import_chat 工具已注册')

    const result = await importTool.execute({
      format: 'codearts',
      path: sessionDir,
    })

    assert.equal(result.status, 'imported')
    assert.equal(result.turns, 1)
    assert.equal(createdSessions.size, 1)

    const [created] = createdSessions.values()
    assert.equal(created.meta.id, 'import-ff119714-beda-42a7-b9c2-06ee66fb0927')
    assert.ok(created.events.length > 0)
    const types = created.events.map((e) => e.type)
    assert.ok(types.includes('user/message'))
    assert.ok(types.includes('tool/call'))
    assert.ok(types.includes('tool/result'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('import_chat 批量导入 sessions 根（两层下钻收集多会话）与直传 history.jsonl', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-codearts-batch-'))
  try {
    const b1 = join(tmp, '2026-10-30-00-40-33-1c9178358e8b5d5f')
    const s1 = join(b1, 'f16ce92d-1fbc-45eb-9312-fc766ea79373')
    const b2 = join(tmp, '2026-10-30-00-44-18-250eb756dcfb0664')
    const s2 = join(b2, '8854958b-64d6-4765-b959-f91b1837dd34')
    mkdirSync(s1, { recursive: true })
    mkdirSync(s2, { recursive: true })
    writeFileSync(join(s1, 'meta.json'), JSON.stringify(syntheticMeta({ session_id: 'f16ce92d-1fbc-45eb-9312-fc766ea79373', title: 'S1' })))
    writeFileSync(join(s1, 'history.jsonl'), syntheticJsonl())
    writeFileSync(join(s2, 'meta.json'), JSON.stringify(syntheticMeta({ session_id: '8854958b-64d6-4765-b959-f91b1837dd34', title: 'S2' })))
    writeFileSync(join(s2, 'history.jsonl'), syntheticJsonl())

    const { ctx, persistence } = makeCtx(null, { real: true })
    apply(ctx)
    const importTool = toolDef(ctx, 'import_chat')

    // sessions 根 → 批量两条
    const batch = await importTool.execute({ format: 'codearts', path: tmp })
    assert.equal(batch.mode, 'batch')
    assert.equal(batch.imported, 2)
    assert.equal(persistence.sessions.size, 2)

    // 直传 history.jsonl → 单会话（幂等键仍取会话目录）
    const single = await importTool.execute({ format: 'codearts', path: join(s1, 'history.jsonl') })
    assert.equal(single.status, 'already-imported')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('import_chat 对缺失 meta.json 的会话照常导入（标题回退首问、源 id 取目录名）', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-codearts-nometa-'))
  try {
    const bucket = join(tmp, '2026-10-30-05-47-28-a198caeba310ddb3')
    const sessionDir = join(bucket, 'ff119714-beda-42a7-b9c2-06ee66fb0927')
    mkdirSync(sessionDir, { recursive: true })
    // 只写 history.jsonl，不写 meta.json
    writeFileSync(join(sessionDir, 'history.jsonl'), syntheticJsonl())

    const { ctx, persistence } = makeCtx(null, { real: true })
    apply(ctx)
    const importTool = toolDef(ctx, 'import_chat')
    const result = await importTool.execute({ format: 'codearts', path: sessionDir })

    assert.equal(result.status, 'imported')
    assert.equal(result.turns, 1)
    const [created] = persistence.sessions.values()
    // 标题回退首条真人提问（session/title 事件）；meta 缺失 → 无源 cwd，D16 归组把
    // header 的 cwd 改写为专用导入工作区（会话可见，不伪造源路径）
    const titleEvent = created.events.find((e) => e.type === 'session/title')
    assert.match(titleEvent?.data?.title ?? '', /列出当前目录的文件/)
    assert.match(String(created.meta.cwd), /dsh-chat-import-workspace/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('幂等键归一化：先传会话目录、再传同一会话的 history.jsonl 不重复导入', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-codearts-key-'))
  try {
    const bucket = join(tmp, '2026-10-30-05-47-28-a198caeba310ddb3')
    const sessionDir = join(bucket, 'ff119714-beda-42a7-b9c2-06ee66fb0927')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify(syntheticMeta()))
    writeFileSync(join(sessionDir, 'history.jsonl'), syntheticJsonl())

    const { ctx, persistence } = makeCtx(null, { real: true })
    apply(ctx)
    const importTool = toolDef(ctx, 'import_chat')

    const viaDir = await importTool.execute({ format: 'codearts', path: sessionDir })
    assert.equal(viaDir.status, 'imported')
    // 同一会话换一种传法（直传 history.jsonl）→ 幂等键归一化到会话目录，判为已导入
    const viaFile = await importTool.execute({ format: 'codearts', path: join(sessionDir, 'history.jsonl') })
    assert.equal(viaFile.status, 'already-imported')
    assert.equal(persistence.sessions.size, 1)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('role 大小写宽容：小写 user/assistant/tool 同样识别（对齐 vibe 口径）', () => {
  const lower = syntheticMessages().map((m) => ({ ...m, role: String(m.role).toLowerCase() }))
  const out = convertCodeartsJson(syntheticJsonl(lower), { meta: syntheticMeta() })
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].steps[0].toolCalls.length, 1)
  assert.equal(out.turns[0].steps[0].toolResults.length, 1)
})

test('伴生索引：messages.index.jsonl 不当作会话（否则同一会话被导入两次）', async () => {
  // CodeArts 会话目录 = history.jsonl（主转录）+ messages.index.jsonl（字节区间索引）+ meta.json。
  // local-jsonl 兜底通道按 .jsonl 递归收集时若把索引也收下，同一会话会落成两份
  // （另一条 turns 相同、sessionId 带 -1 后缀）。
  const { isSidecarJsonl } = await import('../lib/import-batch.mjs')
  assert.equal(isSidecarJsonl('messages.index.jsonl'), true)
  assert.equal(isSidecarJsonl('history.jsonl'), false)
  for (const n of ['x.events.jsonl', 'x.conflicts.jsonl', 'x.guardian.jsonl']) {
    assert.equal(isSidecarJsonl(n), true, n) // 既有伴生类型仍排除
  }
})

test('previewCodeartsFile & previewCodeartsDirectory: 只读预览目录与单文件', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-codearts-prev-'))
  try {
    const bucket = join(tmp, '2026-10-30-05-47-28-a198caeba310ddb3')
    const sessionDir = join(bucket, 'ff119714-beda-42a7-b9c2-06ee66fb0927')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify(syntheticMeta({ title: 'Preview Session' })))
    writeFileSync(join(sessionDir, 'history.jsonl'), syntheticJsonl())

    const { ctx } = makeCtx(null, { real: true })
    const single = await previewCodeartsFile(ctx, { displayPath: sessionDir }, {})
    assert.equal(single.title, 'Preview Session')
    assert.equal(single.turns, 1)

    const dir = await previewCodeartsDirectory(ctx, { displayPath: tmp }, {})
    assert.equal(dir.total, 1)
    assert.equal(dir.results[0].title, 'Preview Session')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
