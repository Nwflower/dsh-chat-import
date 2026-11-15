// cherrystudio.test.mjs — Cherry Studio 源的流式快照折叠与导入核心测试。
// 自包含合成数据（形状按本机 27 份真实转录归纳，不掺真实内容）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { convertCherrystudioJsonl, collapseCherryStudioSnapshots } from '../lib/convert/cherrystudio.mjs'
import { cherrystudioSource } from '../lib/discovery/claude.mjs'
import { apply } from '../lib/index.mjs'
import { hostAbs } from './_support/host-path.mjs'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { clearScanCache } from '../lib/discovery.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
})

const SID = '04750e66-d455-4057-bd2f-c3d12a24f8f4'
const CWD = hostAbs('S:/apps/llm/agentwork')
const TS = 1789757934255

// 真实形状：user 的 message.content 是字符串；assistant 是内容块数组。
function rec(extra) {
  return {
    type: 'user', sessionId: SID, timestamp: new Date(TS).toISOString(), cwd: CWD,
    uuid: 'u-' + Math.random().toString(36).slice(2), parentUuid: null,
    message: { role: 'user', content: '问题' },
    ...extra,
  }
}

// 流式快照：同一 message.id，逐次增长的正文（Cherry Studio 的 3–4 份前缀）。
function snapshots(id, texts) {
  return texts.map((text, i) => rec({
    type: 'assistant',
    message: { id, type: 'message', role: 'assistant', content: [{ type: 'text', text }] },
    uuid: 'a-' + i,
  }))
}

function jsonl(recs) {
  return recs.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

test('折叠：同一 message.id 的 4 份前缀快照只留最长的正文', () => {
  const raw = jsonl([
    rec({ type: 'queue-operation', message: undefined }),
    rec({ message: { role: 'user', content: '问题' } }),
    ...snapshots('msg_1', ['前缀', '前缀变长', '前缀变长完整回复', '前缀变长完整回复。']),
    rec({ type: 'last-prompt', message: undefined }),
  ])
  const collapsed = collapseCherryStudioSnapshots(raw)
  const lines = collapsed.trim().split('\n')
  assert.equal(lines.length, 4, '4 份快照 + 1 条提问 + 2 条元数据 → 折叠后 4 行')
  const texts = lines.map((l) => JSON.parse(l).message?.content?.[0]?.text).filter(Boolean)
  assert.deepEqual(texts, ['前缀变长完整回复。'], '保留最长快照，无前缀重复')

  const out = convertCherrystudioJsonl(raw, { fileStem: SID })
  const assistantTexts = (out.events || [])
    .filter((e) => e.type === 'assistant/message')
    .flatMap((e) => (e.data?.message?.content || []).map((c) => c.text || '').filter(Boolean))
  assert.equal(assistantTexts.length, 1, '导入后只有一条助手回复')
  assert.match(assistantTexts[0], /完整回复。$/)
})

test('折叠：不同 message.id 的快照互不干扰；requestId 优先于 message.id', () => {
  const a = snapshots('msg_a', ['A1', 'A1A2'])
  const b = snapshots('msg_b', ['B1', 'B1B2', 'B1B2B3'])
  // requestId 相同但 message.id 不同 → 按 requestId 折叠成一组
  const c = snapshots('msg_c1', ['C1']).map((r) => ({ ...r, requestId: 'req-shared' }))
  const d = snapshots('msg_c2', ['C1C2']).map((r) => ({ ...r, requestId: 'req-shared' }))
  const lines = collapseCherryStudioSnapshots(jsonl([...a, ...b, ...c, ...d])).trim().split('\n')
  const texts = lines.map((l) => JSON.parse(l).message?.content?.[0]?.text).filter(Boolean)
  assert.deepEqual(texts, ['A1A2', 'B1B2B3', 'C1C2'], '两组独立 + requestId 合并组取最长')
})

test('折叠：无 key 的记录原样保留，畸形行不吞', () => {
  const raw = jsonl([rec({ type: 'attachment', message: undefined })]) + '{bad json\n' + jsonl([rec({ type: 'mode', message: undefined })])
  const lines = collapseCherryStudioSnapshots(raw).trim().split('\n')
  assert.equal(lines.length, 2, '畸形行不计入，两条元数据保留')
})

test('发现层：路径签名自拒（非 CherryStudio 根返回空）', async () => {
  const fakeHost = { readDir: async () => [], stat: async () => null, readHead: async () => '', readTail: async () => '' }
  const out = await cherrystudioSource.scan(fakeHost, hostAbs('C:/Users/u/.claude/projects'), { bm: null, emit: null })
  assert.deepEqual(out, [])
  const outs = await cherrystudioSource.scan(fakeHost, hostAbs('C:/Users/u/AppData/Roaming/CherryStudio/.claude/projects'), { bm: null, emit: null })
  assert.deepEqual(outs, [])
})

test('import_chat 集成：cherrystudio format 能导入折叠后的会话', async () => {
  const root = join(process.env.DSH_HOME, 'CherryStudio', 'Data', 'Agents', '.claude', 'projects', 'S--apps-llm-agentwork')
  mkdirSync(root, { recursive: true })
  const file = join(root, SID + '.jsonl')
  writeFileSync(file, jsonl([
    rec({ type: 'queue-operation', message: undefined }),
    rec({ message: { role: 'user', content: '复旦微 FPAI 的资料哪里找' } }),
    ...snapshots('msg_1', ['正在', '正在查，', '正在查，看 www.fmsh.com']),
  ]), 'utf-8')

  const { ctx } = makeCtx(null, { real: true })
  apply(ctx)
  const importTool = chatDef(ctx, 'cherrystudio')
  assert.ok(importTool, 'import_chat 工具已注册')
  const result = await importTool.execute({ path: file })
  assert.equal(result.status, 'imported')
})
