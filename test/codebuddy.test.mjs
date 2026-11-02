// codebuddy.test.mjs — CodeBuddy Code 源转换核心单元测试 + import_chat 集成测试。
// 记录构造与 workbuddy.test.mjs 同源（同一引擎异名产品，事件词汇同构）；本文件专测
// codebuddy 专属差异：convertCodebuddyJsonl 入口、显式标题记录优先级、discovery
// codebuddySource 的 roots/scan/matchFile、registry 接线。自包含合成数据，不掺真实 transcript。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { convertCodebuddyJsonl } from '../lib/convert/workbuddy.mjs'
import { SOURCES } from '../lib/discovery/registry.mjs'
import { SESSION_FORMAT_VERSION } from '../lib/convert/core.mjs'
import { clearScanCache, clearInflightScans, discoverSessions } from '../lib/discovery.mjs'
import { memoryHost, FAKE_HOME as HOME } from './_support/discovery-host.mjs'
import { apply } from '../lib/index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { assertEnvelopeHygiene } from './_support/envelope.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'
import { hostAbs } from './_support/host-path.mjs'

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
  clearInflightScans()
})

function cb(recs) {
  return recs.map((r) => JSON.stringify(r)).join('\n')
}

const SID = '0016c4c9-2098-4372-ac81-86cdf5d3fb07'
const CWD = hostAbs('H:/CodexProjects/my-project')
const TS = 1787131157250

function userRec(innerText) {
  return {
    id: 'u-' + Math.random().toString(36).slice(2), timestamp: TS, type: 'message', role: 'user',
    content: [{ type: 'input_text', text: innerText }], sessionId: SID, cwd: CWD,
  }
}
function assistantRec(content) {
  return {
    id: 'a-' + Math.random().toString(36).slice(2), timestamp: TS, type: 'message', role: 'assistant',
    content: Array.isArray(content) ? content : [{ type: 'output_text', text: content }],
    sessionId: SID, cwd: CWD,
  }
}

test('注册表含 codebuddy 且描述符自洽（roots/matchFile/scan）', () => {
  const s = SOURCES.find((x) => x.format === 'codebuddy')
  assert.ok(s, 'codebuddy 在 SOURCES 里')
  assert.equal(s.format, 'codebuddy')
  const roots = s.roots(process.env.HOME || 'C:/Users/u')
  assert.ok(Array.isArray(roots) && roots.length === 1)
  assert.match(roots[0], /\.codebuddy[\\/]projects/)
  assert.equal(s.matchFile('C:/Users/u/.codebuddy/projects/p/a.jsonl'), true)
  assert.equal(s.matchFile('C:/Users/u/.workbuddy/projects/p/a.jsonl'), false)
})

test('简单 user/assistant 轮次 → 1 轮、meta 落字段、provider 走 codebuddy 标签', () => {
  const raw = cb([
    userRec('<user_query>帮我看看这个项目</user_query>'),
    assistantRec('好的，我先读一下结构。'),
  ])
  const out = convertCodebuddyJsonl(raw, { codebuddyId: SID })
  assert.equal(out.meta.version, SESSION_FORMAT_VERSION)
  assert.equal(out.meta.sourceId, SID)
  assert.equal(out.meta.cwd, CWD)
  assert.equal(out.meta.createdAt, TS)
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].prompt, '帮我看看这个项目')
  assert.equal(out.messages, 2)
  assert.equal(out.toolCalls, 0)
})

test('显式标题记录优先级：custom > ai > topic，同类后到者胜', () => {
  const raw = cb([
    userRec('<user_query>修构建</user_query>'),
    assistantRec('检查 go build。'),
    { id: 't1', timestamp: TS + 1, type: 'topic', topic: '构建话题', sessionId: SID, cwd: CWD },
    { id: 't2', timestamp: TS + 2, type: 'ai-title', aiTitle: 'AI 自动标题', sessionId: SID, cwd: CWD },
    { id: 't3', timestamp: TS + 3, type: 'custom-title', customTitle: '修构建', sessionId: SID, cwd: CWD },
  ])
  const out = convertCodebuddyJsonl(raw, { codebuddyId: SID })
  assert.equal(out.title, '修构建')
})

test('占位符标题被忽略（空/(No content)/<image_local_path> 壳），回退首问', () => {
  const raw = cb([
    userRec('<user_query>真正的提问</user_query>'),
    assistantRec('回复。'),
    { id: 'p1', timestamp: TS + 1, type: 'ai-title', aiTitle: '(No content)', sessionId: SID, cwd: CWD },
    { id: 'p2', timestamp: TS + 2, type: 'topic', topic: '<image_local_path>/x.png</image_local_path>', sessionId: SID, cwd: CWD },
  ])
  const out = convertCodebuddyJsonl(raw, { codebuddyId: SID })
  assert.equal(out.title, '真正的提问')
})

test('标题来源：只有 topic 时用 topic；custom 后到覆盖 ai', () => {
  const raw = cb([
    userRec('<user_query>提问</user_query>'),
    assistantRec('回复。'),
    { id: 't1', timestamp: TS + 1, type: 'ai-title', aiTitle: 'AI 标题', sessionId: SID, cwd: CWD },
    { id: 't2', timestamp: TS + 2, type: 'custom-title', customTitle: '自定义标题', sessionId: SID, cwd: CWD },
  ])
  const out = convertCodebuddyJsonl(raw, { codebuddyId: SID })
  assert.equal(out.title, '自定义标题')
})

// ---- import_codebuddy 集成 ----

test('import_codebuddy 单文件导入：落盘、标题带 CodeBuddy 前缀、返回值符合 schema', async () => {
  const src = hostAbs('D:/demo/codebuddy/') + SID + '.jsonl'
  const { ctx, persistence } = makeCtx({ [src]: cb([
    userRec('<user_query>帮我看看这个项目</user_query>'),
    assistantRec('好的，我先读一下结构。'),
    { id: 't1', timestamp: TS + 2, type: 'custom-title', customTitle: '项目结构梳理', sessionId: SID, cwd: CWD },
  ]) })
  apply(ctx)
  const def = chatDef(ctx, 'codebuddy')
  const value = await def.execute({ path: src })

  assert.equal(value.mode, 'single')
  assert.equal(value.sessionId, 'import-' + SID)
  assert.equal(value.turns, 1)
  assert.equal(value.messages, 2)
  assert.equal(value.alreadyImported, false)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const saved = persistence.sessions.get('import-' + SID)
  assert.ok(saved)
  assert.equal(saved.meta.cwd, CWD)
  // 宿主 header 白名单不含 sourceId：只服务 registry 与导出协议
  assert.equal(saved.meta.sourceId, undefined)
  assert.equal(saved.events.at(-1).type, 'session/title')
  assert.match(saved.events.at(-1).data.title, /^CodeBuddy · /)
  assert.match(saved.events.at(-1).data.title, /项目结构梳理/)
  assert.ok(saved.events.every((e, i) => e.seq === i))
  assertEnvelopeHygiene(saved.events)
})

// ---- 发现层：数据根与面板标题 ----

test('roots 尊重 $CODEBUDDY_CONFIG_DIR（CodeBuddy 自己的 resolveCliHomeDir 口径）', () => {
  const s = SOURCES.find((x) => x.format === 'codebuddy')
  assert.deepEqual(
    s.roots('/home/u', { CODEBUDDY_CONFIG_DIR: '/custom/cb' }),
    [join('/custom/cb', 'projects')],
  )
  // 未设置 / 空串 → 默认根
  assert.deepEqual(s.roots('/home/u', {}), [join('/home/u', '.codebuddy', 'projects')])
  assert.deepEqual(s.roots('/home/u', { CODEBUDDY_CONFIG_DIR: '   ' }), [join('/home/u', '.codebuddy', 'projects')])
})

test('发现层：面板标题走显式标题记录（custom > ai > topic），与导入标题同源', async () => {
  const root = join(HOME, '.codebuddy', 'projects')
  const proj = join(root, 'proj-slug')
  const s1 = join(proj, SID + '.jsonl')
  const files = new Map([
    [root, { type: 'dir' }],
    [proj, { type: 'dir' }],
    [s1, {
      type: 'file',
      mtimeMs: 1786000002000,
      text: cb([
        userRec('<user_query>首个提问</user_query>'),
        assistantRec('回复。'),
        { id: 't1', timestamp: TS + 5, type: 'ai-title', aiTitle: 'AI 标题', sessionId: SID, cwd: CWD },
        { id: 't2', timestamp: TS + 6, type: 'custom-title', customTitle: '自定义标题', sessionId: SID, cwd: CWD },
      ]),
    }],
  ])
  const { sessions, total } = await discoverSessions({
    path: root, format: 'codebuddy', host: memoryHost(files), imports: {},
  })
  assert.equal(total, 1)
  assert.equal(sessions[0].format, 'codebuddy')
  assert.equal(sessions[0].title, '自定义标题')
  assert.equal(sessions[0].sessionId, SID)
})

test('发现层：无显式标题时回退首问；路径自拒对非 codebuddy 根返回空', async () => {
  const root = join(HOME, '.codebuddy', 'projects')
  const proj = join(root, 'proj-slug')
  const s1 = join(proj, SID + '.jsonl')
  const files = new Map([
    [root, { type: 'dir' }],
    [proj, { type: 'dir' }],
    [s1, {
      type: 'file',
      mtimeMs: 1786000002000,
      text: cb([
        userRec('<user_query>只有首问</user_query>'),
        assistantRec('回复。'),
        { id: 't1', timestamp: TS + 5, type: 'ai-title', aiTitle: '(No content)', sessionId: SID, cwd: CWD },
      ]),
    }],
  ])
  const host = memoryHost(files)
  const ok = await discoverSessions({ path: root, format: 'codebuddy', host, imports: {} })
  assert.equal(ok.sessions[0].title, '只有首问') // 占位标题不算，回退首问
  const other = await discoverSessions({ path: join(HOME, 'elsewhere'), format: 'codebuddy', host, imports: {} })
  assert.equal(other.total, 0)
})
