// index-import-codex.test.mjs — Codex 集成（含分页 rollout）
// container.exec 与分页链：签名、分页页/链书签、增量续写。
// 由 test/index.test.mjs 按横幅分组拆出（纯移动：用例与断言未改）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.mjs'
import { discoverSessions, clearScanCache } from '../lib/discovery.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { hostAbs } from './_support/host-path.mjs'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'
import { loadHostFixture as load } from './_support/fixtures.mjs'

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
})

const PAG_THREAD = '0f1e2d3c-4b5a-6978-8901-2abcdef01234'

const PAG_PAGE_ID = '7c6d5e4f-0011-2233-4455-66778899aabb'

const PAG_DIR = 'D:\\demo\\codex-chain\\sessions\\2026\\09\\14\\'

const PAG_DIR2 = 'D:\\demo\\codex-chain\\sessions\\2026\\09\\15\\'

function pagMeta(id, over = {}) {
  return JSON.stringify({
    timestamp: '2026-09-14T10:54:34.000Z', type: 'session_meta',
    payload: { id, cwd: hostAbs('D:/demo/codex-chain'), timestamp: '2026-09-14T10:54:34.000Z', ...over },
  })
}

function pagUser(text, ts) {
  return JSON.stringify({ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
}

function pagAsst(text, ts) {
  return JSON.stringify({ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })
}

test('import_codex 单文件导入：落盘、归组、返回值符合 schema', async () => {
  const { ctx, persistence, attached } = makeCtx({ 'D:\\demo\\codex\\simple.jsonl': load('codex-simple.jsonl') })
  apply(ctx)
  const def = chatDef(ctx, 'codex')
  const value = await def.execute({ path: 'D:\\demo\\codex\\simple.jsonl' })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-019e3b3f-636d-7cb3-aaab-0255eb45ad4f')
  assert.equal(value.turns, 1)
  assert.equal(value.messages, 2)
  assert.equal(value.toolCalls, 0)
  assert.equal(value.alreadyImported, false)

  const violations = validateJsonSchemaValue(def.output.schema, value)
  assert.deepEqual(violations, [])

  const saved = persistence.sessions.get('import-019e3b3f-636d-7cb3-aaab-0255eb45ad4f')
  assert.ok(saved)
  assert.equal(saved.meta.cwd, hostAbs('D:/demo/codex-proj'))
  assert.equal(saved.events.at(-1).type, 'session/title')
  assert.match(saved.events.at(-1).data.title, /^Codex · /)
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assertEnvelopeHygiene(saved.events)
  assert.equal(attached.length, 1)
  assert.equal(attached[0].id, 'import-019e3b3f-636d-7cb3-aaab-0255eb45ad4f')
})

test('import_codex 工具历史：tool/result 带 sourceEventSeqs 且 output 落盘', async () => {
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\codex\\tool.jsonl': load('codex-tool.jsonl') })
  apply(ctx)
  const def = chatDef(ctx, 'codex')
  const value = await def.execute({ path: 'D:\\demo\\codex\\tool.jsonl' })
  assert.equal(value.mode, 'single')
  assert.equal(value.toolCalls, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get(value.sessionId)
  const result = saved.events.find((e) => e.type === 'tool/result')
  assert.ok(result)
  assert.equal(result.data.message.content[0].content[0].text, 'README.md\nsrc\n')
})

test('import_codex 外部导入展平信封：还原为 tool/call + tool/result，计数透出且渲染可见', async () => {
  const T = '2026-09-07T04:21:56.824Z'
  const line = (type, payload) => JSON.stringify({ timestamp: T, type, payload })
  const asst = (text) => line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
  const recs = [
    line('session_meta', { id: 'ext-demo-001', timestamp: T, cwd: hostAbs('D:/demo/mods') }),
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '改一下建筑数值' }] }),
    // 正文 + 调用信封混排在同一文本块（实测 776 块如此），信封载荷为 key:value
    asst('先读设计稿。\n\n[external_agent_tool_call: Bash]\ndescription: 查数值\ncommand: grep -n "# 关键词" a.sql\n[/external_agent_tool_call]'),
    // 结果信封带 error 标记
    asst('[external_agent_tool_result: error]\ngrep: a.sql: No such file\n[/external_agent_tool_result]'),
    // 第二个调用：Codex 只保留了 file（Edit 的 old/new 已被上游丢弃）
    asst('[external_agent_tool_call: Edit]\nfile: D:\\demo\\mods\\a.sql\n[/external_agent_tool_call]'),
    asst('[external_agent_tool_result]\n已修改\n[/external_agent_tool_result]'),
  ].join('\n')
  const target = 'D:\\demo\\codex\\external-agent.jsonl'
  const { ctx, persistence } = makeCtx({ [target]: recs })
  apply(ctx)
  const def = chatDef(ctx, 'codex')
  const value = await def.execute({ path: target })

  assert.equal(value.status, 'imported')
  assert.equal(value.toolCalls, 2)
  assert.deepEqual(value.externalAgent, { calls: 2, results: 2, orphanResults: 0, malformed: 0 })
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get(value.sessionId)
  assertEnvelopeHygiene(saved.events)
  const calls = saved.events.filter((e) => e.type === 'tool/call')
  assert.deepEqual(calls.map((e) => e.data.name), ['Bash', 'Edit'])
  assert.deepEqual(JSON.parse(calls[0].data.arguments), { description: '查数值', command: 'grep -n "# 关键词" a.sql' })
  // Edit 只剩文件路径：上游丢掉的正文不补，也不虚构
  assert.deepEqual(JSON.parse(calls[1].data.arguments), { file: 'D:\\demo\\mods\\a.sql' })
  const results = saved.events.filter((e) => e.type === 'tool/result')
  assert.equal(results.length, 2)
  assert.equal(results[0].data.message.content[0].isError, true)
  assert.equal(results[0].data.message.content[0].toolCallId, calls[0].data.callId)
  // 工具生命周期：结果与调用同步（宿主不变量），正文里不再残留信封标记
  for (const [, r] of results.entries()) assert.equal(r.data.step, calls.find((c) => c.data.callId === r.data.message.content[0].toolCallId).data.step)
  const flat = JSON.stringify(saved.events)
  assert.equal(flat.includes('external_agent_tool'), false, '信封不得再以正文落入日志')
  assert.ok(flat.includes('先读设计稿。'), '混排块里的正文必须保留')

  const text = def.output.render({ path: target }, value).map((b) => b.text).join('\n')
  assert.ok(text.includes('还原外部工具调用 2 次'))
})

test('import_codex 目录批量导入：递归扫描、逐文件独立会话、schema 校验', async () => {
  const tree = {
    'D:\\demo\\codex': 'dir',
    'D:\\demo\\codex\\a.jsonl': load('codex-simple.jsonl'),
    'D:\\demo\\codex\\b.jsonl': load('codex-tool.jsonl'),
  }
  const { ctx, persistence, attached } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'codex')
  const value = await def.execute({ path: 'D:\\demo\\codex' })

  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.equal(value.alreadyImported, 0)
  assert.equal(value.failed, 0)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  assert.equal(persistence.sessions.size, 2)
  assert.equal(attached.length, 2)
})

test('import_codex 幂等：重复导入同一文件已存在则跳过', async () => {
  const { ctx, persistence } = makeCtx({ 'D:\\demo\\codex\\a.jsonl': load('codex-simple.jsonl') })
  apply(ctx)
  const def = chatDef(ctx, 'codex')
  const first = await def.execute({ path: 'D:\\demo\\codex\\a.jsonl' })
  const second = await def.execute({ path: 'D:\\demo\\codex\\a.jsonl' })
  assert.equal(first.alreadyImported, false)
  assert.equal(second.alreadyImported, true)
  assert.equal(persistence.sessions.size, 1)
})

test('import_codex 分页 rollout：导最后一页也拿到整链（首页 + 次页拼一个会话）', async () => {
  const pageA = PAG_DIR + `rollout-2026-09-14T10-54-33-${PAG_THREAD}.jsonl`
  const pageB = PAG_DIR2 + `rollout-2026-09-15T19-55-00-${PAG_THREAD}_${PAG_PAGE_ID}.jsonl`
  const { ctx, persistence, attached } = makeCtx({
    // 中间目录也要进树：链解析从 sessions 祖先逐层 listDir 下钻
    'D:\\demo\\codex-chain\\sessions': 'dir',
    'D:\\demo\\codex-chain\\sessions\\2026': 'dir',
    'D:\\demo\\codex-chain\\sessions\\2026\\09': 'dir',
    [PAG_DIR.replace(/\\+$/, '')]: 'dir',
    [PAG_DIR2.replace(/\\+$/, '')]: 'dir',
    [pageA]: [
      pagMeta(PAG_THREAD),
      pagUser('第一问', '2026-09-14T10:55:00.000Z'),
      pagAsst('答一', '2026-09-14T10:55:10.000Z'),
    ].join('\n'),
    [pageB]: [
      pagMeta(PAG_THREAD, {
        history_mode: 'paginated',
        history_base: { thread_id: PAG_THREAD, end_ordinal_exclusive: 3, end_byte_offset: 300 },
      }),
      pagUser('第二问', '2026-09-15T19:56:00.000Z'),
      pagAsst('答二', '2026-09-15T19:56:10.000Z'),
    ].join('\n'),
  })
  apply(ctx)
  const def = chatDef(ctx, 'codex')
  // 报告者的用法：导入的是**最后一页**
  const value = await def.execute({ path: pageB })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-' + PAG_THREAD)
  assert.equal(value.turns, 2) // 首页 + 次页拼成一个会话
  assert.equal(value.messages, 4)

  const saved = persistence.sessions.get('import-' + PAG_THREAD)
  assert.ok(saved)
  assert.equal(saved.meta.cwd, hostAbs('D:/demo/codex-chain'))
  // 会话时间取首页 meta 的 timestamp（次页 meta 被忽略）
  assert.equal(saved.meta.createdAt, Date.parse('2026-09-14T10:54:34.000Z'))
  assert.match(saved.events.at(-1).data.title, /^Codex · /)
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assertEnvelopeHygiene(saved.events)
  assert.equal(attached.length, 1)
  assert.equal(attached[0].id, 'import-' + PAG_THREAD)
})

test('import_codex 分页幂等：重复导同一页跳过；新增一页后重导按 append 增量', async () => {
  const pageA = PAG_DIR + `rollout-2026-09-14T10-54-33-${PAG_THREAD}.jsonl`
  const pageB = PAG_DIR2 + `rollout-2026-09-15T19-55-00-${PAG_THREAD}_${PAG_PAGE_ID}.jsonl`
  const tree = {
    'D:\\demo\\codex-chain\\sessions': 'dir',
    'D:\\demo\\codex-chain\\sessions\\2026': 'dir',
    'D:\\demo\\codex-chain\\sessions\\2026\\09': 'dir',
    [PAG_DIR.replace(/\\+$/, '')]: 'dir',
    [PAG_DIR2.replace(/\\+$/, '')]: 'dir',
    [pageA]: [
      pagMeta(PAG_THREAD),
      pagUser('第一问', '2026-09-14T10:55:00.000Z'),
      pagAsst('答一', '2026-09-14T10:55:10.000Z'),
    ].join('\n'),
    [pageB]: [
      pagMeta(PAG_THREAD, { history_mode: 'paginated', history_base: { thread_id: PAG_THREAD } }),
      pagUser('第二问', '2026-09-15T19:56:00.000Z'),
      pagAsst('答二', '2026-09-15T19:56:10.000Z'),
    ].join('\n'),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'codex')

  const first = await def.execute({ path: pageB })
  assert.equal(first.turns, 2)
  const again = await def.execute({ path: pageB })
  assert.equal(again.alreadyImported, true)
  assert.equal(persistence.sessions.size, 1)

  // 追加第三页（真正的增量场景：Codex 又开了一个新分页文件）。mock 的 listDir 有
  // entriesCache，这里直接在 ctx.fs.listDir 外层注入新条目，模拟缓存过期后的目录内容
  const pageC = PAG_DIR2 + `rollout-2026-09-15T20-41-00-${PAG_THREAD}_9a8b7c6d.jsonl`
  tree[pageC] = [
    pagMeta(PAG_THREAD, { history_mode: 'paginated', history_base: { thread_id: PAG_PAGE_ID } }),
    pagUser('第三问', '2026-09-15T20:42:00.000Z'),
    pagAsst('答三', '2026-09-15T20:42:10.000Z'),
  ].join('\n')
  const origListDir = ctx.fs.listDir
  ctx.fs.listDir = async (t) => {
    const base = await origListDir(t)
    const key = t.targetKey || ''
    if (key.replace(/[\\/]+$/, '') === PAG_DIR2.replace(/[\\/]+$/, '')) {
      return [...base, {
        name: pageC.split('\\').pop(), type: 'file',
        target: { targetKey: pageC, displayPath: pageC }, version: 1,
      }]
    }
    return base
  }
  const third = await def.execute({ path: pageB })
  assert.equal(third.status, 'appended')
  assert.ok((third.appendedTurns ?? 0) >= 1)
  const saved = persistence.sessions.get('import-' + PAG_THREAD)
  const prompts = saved.events
    .filter((e) => e.type === 'user/message' && e.data.source.kind === 'user')
    .flatMap((e) => e.data.content).filter((b) => b.type === 'text').map((b) => b.text)
  assert.deepEqual(prompts, ['第一问', '第二问', '第三问'])
})

test('import_codex fullHistory 入 args 指纹：换值重导走 argsChanged，不另建会话', async () => {
  const pageA = PAG_DIR + `rollout-2026-09-14T10-54-33-${PAG_THREAD}.jsonl`
  const pageB = PAG_DIR2 + `rollout-2026-09-15T19-55-00-${PAG_THREAD}_${PAG_PAGE_ID}.jsonl`
  const tree = {
    'D:\\demo\\codex-chain\\sessions': 'dir',
    'D:\\demo\\codex-chain\\sessions\\2026': 'dir',
    'D:\\demo\\codex-chain\\sessions\\2026\\09': 'dir',
    [PAG_DIR.replace(/\\+$/, '')]: 'dir',
    [PAG_DIR2.replace(/\\+$/, '')]: 'dir',
    [pageA]: [
      pagMeta(PAG_THREAD),
      pagUser('第一问', '2026-09-14T10:55:00.000Z'),
      pagAsst('答一', '2026-09-14T10:55:10.000Z'),
    ].join('\n'),
    [pageB]: [
      pagMeta(PAG_THREAD, { history_mode: 'paginated', history_base: { thread_id: PAG_THREAD } }),
      pagUser('第二问', '2026-09-15T19:56:00.000Z'),
      pagAsst('答二', '2026-09-15T19:56:10.000Z'),
    ].join('\n'),
  }
  const { ctx, persistence } = makeCtx(tree)
  apply(ctx)
  const def = chatDef(ctx, 'codex')

  const first = await def.execute({ path: pageB })
  assert.equal(first.alreadyImported, false)
  assert.equal(persistence.sessions.size, 1)
  // 换 fullHistory（压缩是否尊重）→ 转换产物会变 → 参数指纹变化 → argsChanged 跳过
  const second = await def.execute({ path: pageB, fullHistory: true })
  assert.equal(second.alreadyImported, true)
  assert.equal(second.argsChanged, true)
  assert.equal(persistence.sessions.size, 1)
})

test('import_codex 分页发现：同 thread 多页只出一条（标题取首页首问，修复同名条目）', async () => {
  const pageA = PAG_DIR + `rollout-2026-09-14T10-54-33-${PAG_THREAD}.jsonl`
  const pageB = PAG_DIR2 + `rollout-2026-09-15T19-55-00-${PAG_THREAD}_${PAG_PAGE_ID}.jsonl`
  const tree = {
    'D:\\demo\\codex-chain\\sessions': 'dir',
    'D:\\demo\\codex-chain\\sessions\\2026': 'dir',
    'D:\\demo\\codex-chain\\sessions\\2026\\09': 'dir',
    [PAG_DIR.replace(/\\+$/, '')]: 'dir',
    [PAG_DIR2.replace(/\\+$/, '')]: 'dir',
    [pageA]: [
      pagMeta(PAG_THREAD),
      pagUser('第一问（会话起点）', '2026-09-14T10:55:00.000Z'),
      pagAsst('答一', '2026-09-14T10:55:10.000Z'),
    ].join('\n'),
    [pageB]: [
      pagMeta(PAG_THREAD, { history_mode: 'paginated', history_base: { thread_id: PAG_THREAD } }),
      pagUser('第一问（会话起点）', '2026-09-15T19:56:00.000Z'), // 与首页同文 → 旧行为撞标题
      pagAsst('答二', '2026-09-15T19:56:10.000Z'),
    ].join('\n'),
  }
  const host = {
    stat: async (p) => {
      const v = tree[p]
      if (v === undefined) return null
      return v === 'dir' ? { type: 'directory' } : { type: 'file', size: v.length, mtimeMs: 1786000000000 }
    },
    readHead: async (p, max) => (tree[p] !== undefined ? tree[p].slice(0, max) : null),
    readText: async (p) => (tree[p] !== undefined ? tree[p] : null),
    readDir: async (p) => {
      const norm = (x) => String(x).replace(/\\/g, '/')
      const prefix = norm(p).replace(/\/$/, '') + '/'
      const out = []
      for (const path of Object.keys(tree)) {
        const n = norm(path)
        if (!n.startsWith(prefix) || n === prefix) continue
        const rest = n.slice(prefix.length)
        if (rest.includes('/')) continue
        out.push({ name: path.split('\\').pop(), type: tree[path] === 'dir' ? 'directory' : 'file', path })
      }
      return out
    },
  }
  const { sessions, total } = await discoverSessions({
    path: 'D:\\demo\\codex-chain\\sessions', format: 'codex', host, imports: {},
  })
  assert.equal(total, 1) // 旧行为是两条同题条目
  const s = sessions[0]
  assert.equal(s.sessionId, PAG_THREAD)
  assert.equal(s.title, '第一问（会话起点）') // 首页首问（不是次页的同文首问）
  assert.equal(s.sourcePath, pageA) // 幂等键 = 链首页
})
