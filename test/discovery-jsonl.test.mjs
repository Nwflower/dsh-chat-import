// discovery-jsonl.test.mjs — JSONL 族（codex / cursor / reasonix / openclaw / pi）的发现
// 签名自拒、子代理过滤、项目名回退、伴生文件排除。
// 由 test/discovery.test.mjs 按 lib/discovery/ 的实现族拆出（纯移动：用例与断言未改）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { discoverSessions, clearScanCache, clearInflightScans } from '../lib/discovery.mjs'
import { resolveCursorSlugPath, clearWorkspacePathCache } from '../lib/cwd-map.mjs'
import { memoryHost } from './_support/discovery-host.mjs'
import { FAKE_HOME as HOME, j } from './_support/discovery-host.mjs'

beforeEach(() => {
  clearScanCache()
  clearInflightScans()
})

test('codex：session_meta 签名、注入过滤标题、项目名（cwd basename / YYYY-MM 回退）', async () => {
  const root = join(HOME, '.codex', 'sessions')
  const withCwd = join(root, '2026', '03', '10', 'rollout-20260310T120000-019e3b3f-636d-7cb3-aaab-0255eb45ad4f.jsonl')
  const noCwd = join(root, '2026', '03', '11', 'rollout-20260311T080000-019e3b3f-636d-7cb3-aaab-0255eb45ad5f.jsonl')
  const files = new Map([
    [root, { type: 'dir' }], [join(root, '2026'), { type: 'dir' }],
    [join(root, '2026', '03'), { type: 'dir' }], [join(root, '2026', '03', '10'), { type: 'dir' }],
    [join(root, '2026', '03', '11'), { type: 'dir' }],
    [withCwd, { type: 'file', text: [
      j({ type: 'session_meta', timestamp: '2026-03-10T12:00:00Z', payload: { id: '019e3b3f-636d-7cb3-aaab-0255eb45ad4f', cwd: 'D:/demo/codex-proj' } }),
      j({ type: 'response_item', payload: { type: 'message', role: 'user', content: '<environment_context>\n<cwd>/x</cwd>\n</environment_context>' } }),
      j({ type: 'response_item', payload: { type: 'message', role: 'user', content: '为什么构建失败' } }),
    ].join('\n') }],
    [noCwd, { type: 'file', text: [
      j({ type: 'session_meta', payload: { id: '019e3b3f-636d-7cb3-aaab-0255eb45ad5f' } }),
      j({ type: 'response_item', payload: { type: 'message', role: 'user', content: '重构模块' } }),
    ].join('\n') }],
  ])
  const host = memoryHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'codex', host, imports: {} })
  assert.equal(total, 2)
  const a = sessions.find((s) => s.sessionId === '019e3b3f-636d-7cb3-aaab-0255eb45ad4f')
  assert.equal(a.title, '为什么构建失败')
  assert.equal(a.project, 'codex-proj')
  assert.ok(a.createdAt > 0)
  const b = sessions.find((s) => s.sessionId === '019e3b3f-636d-7cb3-aaab-0255eb45ad5f')
  assert.equal(b.title, '重构模块')
  assert.equal(b.project, '2026/03') // 无 cwd → sessions/YYYY/MM 布局回退
})

test('codex：子代理 rollout（thread_source=subagent / source.subagent）默认过滤', async () => {
  const root = join(HOME, '.codex', 'sessions')
  const day = join(root, '2026', '03', '12')
  const main = join(day, 'rollout-main-019e3b3f-636d-7cb3-aaab-0255eb45ad6f.jsonl')
  const subThreadSource = join(day, 'rollout-sub-019e3b3f-636d-7cb3-aaab-0255eb45ad7f.jsonl')
  const subSource = join(day, 'rollout-sub2-019e3b3f-636d-7cb3-aaab-0255eb45ad8f.jsonl')
  const files = new Map([
    [root, { type: 'dir' }], [join(root, '2026'), { type: 'dir' }],
    [join(root, '2026', '03'), { type: 'dir' }], [day, { type: 'dir' }],
    [main, { type: 'file', text: [
      j({ type: 'session_meta', payload: { id: '019e3b3f-636d-7cb3-aaab-0255eb45ad6f' } }),
      j({ type: 'response_item', payload: { type: 'message', role: 'user', content: '主会话提问' } }),
    ].join('\n') }],
    [subThreadSource, { type: 'file', text: [
      j({ type: 'session_meta', payload: { id: '019e3b3f-636d-7cb3-aaab-0255eb45ad7f', thread_source: 'subagent' } }),
      j({ type: 'response_item', payload: { type: 'message', role: 'user', content: '子代理工作' } }),
    ].join('\n') }],
    [subSource, { type: 'file', text: [
      j({ type: 'session_meta', payload: { id: '019e3b3f-636d-7cb3-aaab-0255eb45ad8f', source: { subagent: { thread_spawn: { parent_thread_id: '019e3b3f-636d-7cb3-aaab-0255eb45ad6f', depth: 1 } } } } }),
      j({ type: 'response_item', payload: { type: 'message', role: 'user', content: '子代理工作2' } }),
    ].join('\n') }],
  ])
  const host = memoryHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'codex', host, imports: {} })
  assert.equal(total, 1)
  assert.equal(sessions[0].sessionId, '019e3b3f-636d-7cb3-aaab-0255eb45ad6f')
})

test('reasonix：desktop-* 发现、projects/<slug> 项目名、伴生排除、subagent 默认过滤', async () => {
  const root = join(HOME, '.reasonix', 'projects', 'demo-proj')
  const main = join(root, 'desktop-202603101200-1.jsonl')
  const sub = join(root, 'subagent-sub-5-202603101201.jsonl')
  const files = new Map([
    [root, { type: 'dir' }],
    [main, { type: 'file', text: [
      j({ role: 'user', content: '帮我写个排序函数', createdAt: 1786000000000 }),
      j({ role: 'assistant', content: '好的', createdAt: 1786000001000 }),
    ].join('\n') }],
    [sub, { type: 'file', text: j({ role: 'user', content: '子代理提问', createdAt: 1786000002000 }) }],
    // WAL / 伴生文件：不发现
    [join(root, 'desktop-202603101200-1.events.jsonl'), { type: 'file', text: '{"type":"event"}' }],
    [join(root, 'desktop-202603101200-1.conflicts.jsonl'), { type: 'file', text: '{}' }],
    [join(root, 'desktop-202603101200-1.guardian.jsonl'), { type: 'file', text: '{}' }],
    [join(root, 'not-desktop.jsonl'), { type: 'file', text: j({ role: 'user', content: '不是 reasonix 命名' }) }],
  ])
  const host = memoryHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'reasonix', host, imports: {} })
  assert.equal(total, 1)
  const a = sessions.find((s) => s.sessionId === 'desktop-202603101200-1')
  assert.equal(a.title, '帮我写个排序函数')
  assert.equal(a.project, 'demo-proj')
  assert.equal(a.createdAt, 1786000000000)
  assert.ok(!sessions.some((s) => s.sessionId === 'subagent-sub-5-202603101201'), 'subagent 子代理应默认过滤')
})

test('openclaw：sessions.json displayName 标题、项目名（记录 cwd > agents/<agent> 布局）', async () => {
  const root = join(HOME, '.openclaw', 'agents')
  const sessDir = join(root, 'main', 'sessions')
  const files = new Map([
    [root, { type: 'dir' }], [join(root, 'main'), { type: 'dir' }], [sessDir, { type: 'dir' }],
    [join(sessDir, 'sessions.json'), { type: 'file', text: j({ a: { sessionId: 'sess-a', displayName: '重构登录模块' } }) }],
    [join(sessDir, 'sess-a.jsonl'), { type: 'file', text: [
      j({ type: 'session', id: 'sess-a', cwd: '/home/dev/proj', timestamp: '2026-03-06T10:00:00Z' }),
      j({ type: 'message', message: { role: 'user', content: '帮我看看构建失败' }, timestamp: '2026-03-06T10:01:00Z' }),
    ].join('\n') }],
    // 无 displayName / 无 cwd 的会话：标题首条 user 文本、项目名 agents/<agent> 布局回退
    [join(sessDir, 'sess-b.jsonl'), { type: 'file', text: [
      j({ type: 'session', id: 'sess-b', timestamp: '2026-03-06T11:00:00Z' }),
      j({ type: 'message', message: { role: 'user', content: '另一个问题' }, timestamp: '2026-03-06T11:01:00Z' }),
    ].join('\n') }],
  ])
  const host = memoryHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'openclaw', host, imports: {} })
  assert.equal(total, 2)
  const a = sessions.find((s) => s.sessionId === 'sess-a')
  assert.equal(a.title, '重构登录模块') // sessions.json displayName 优先
  assert.equal(a.project, 'proj') // 记录内 cwd basename 优先
  assert.ok(a.createdAt > 0)
  const b = sessions.find((s) => s.sessionId === 'sess-b')
  assert.equal(b.title, '另一个问题')
  assert.equal(b.project, 'main') // 无 cwd → agents/<agent> 布局回退
})

test('pi：会话头签名（version 字段）、session_info 名称标题、cwd 项目名、旁支/他格式自拒', async () => {
  const root = join(HOME, '.pi', 'agent', 'sessions', '--demo-pi-proj--')
  const s1 = join(root, '2026-06-01T10-00-00-000Z_019f0a11.jsonl')
  const files = new Map([
    [root, { type: 'dir' }],
    [s1, { type: 'file', mtimeMs: 1786000002000, text: [
      j({ type: 'session', version: 3, id: '019f0a11', timestamp: '2026-06-01T10:00:00.000Z', cwd: 'D:\\demo\\pi-proj' }),
      j({ type: 'message', id: 'a1', parentId: null, timestamp: '2026-06-01T10:00:01.000Z', message: { role: 'user', content: '帮我重构这个模块', timestamp: 1786000001000 } }),
      j({ type: 'session_info', id: 'z9', parentId: 'a1', timestamp: '2026-06-01T10:05:00.000Z', name: '重构模块讨论' }),
    ].join('\n') }],
    // 无 version 的 session 头（hermes/openclaw 形态）→ Pi 签名自拒
    [join(root, 'sess-other.jsonl'), { type: 'file', text: [
      j({ type: 'session', id: 'other', timestamp: '2026-06-01T10:00:00.000Z' }),
      j({ type: 'message', message: { role: 'user', content: '不是 Pi' }, timestamp: '2026-06-01T10:01:00.000Z' }),
    ].join('\n') }],
  ])
  const host = memoryHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'pi', host, imports: {} })
  assert.equal(total, 1)
  const s = sessions[0]
  assert.equal(s.format, 'pi')
  assert.equal(s.sessionId, '019f0a11')
  assert.equal(s.title, '重构模块讨论') // session_info 名称优先
  assert.equal(s.project, 'pi-proj') // 记录内 cwd basename
  assert.equal(s.createdAt, Date.parse('2026-06-01T10:00:00.000Z'))
  assert.equal(s.lastActiveAt, 1786000002000)
})

test('cursor：slug 解码为真实工作区名分组，<timestamp> 解析时间，非仓库 slug 不归组', async () => {
  clearWorkspacePathCache()
  const slugDots = 'e-dev-suite-demo-Client-app'
  const slugHyphen = 'e-dev-suite-scheduled-tasks-publish-fail-monitor'
  const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const cwdDots = 'E:\\dev-suite\\demo.Client-app'
  const cwdHyphen = 'E:\\dev-suite\\scheduled-tasks\\publish-fail-monitor'
  const root = join(HOME, '.cursor', 'projects')
  const tsRaw = '<timestamp>Friday, Aug 7, 2026, 3:44 PM (UTC+8)</timestamp>\n<user_query>点号目录提问</user_query>'
  const dirA = join(root, slugDots, 'agent-transcripts', uuid)
  const fileA = join(dirA, uuid + '.jsonl')
  const dirB = join(root, slugHyphen, 'agent-transcripts', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
  const fileB = join(dirB, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl')
  const dirNum = join(root, '1784784551097', 'agent-transcripts', 'cccccccc-cccc-cccc-cccc-cccccccccccc')
  const fileNum = join(dirNum, 'cccccccc-cccc-cccc-cccc-cccccccccccc.jsonl')
  const files = new Map([
    [root, { type: 'dir' }],
    [join(root, slugDots), { type: 'dir' }],
    [join(root, slugHyphen), { type: 'dir' }],
    [join(root, '1784784551097'), { type: 'dir' }],
    [join(root, slugDots, 'agent-transcripts'), { type: 'dir' }],
    [join(root, slugHyphen, 'agent-transcripts'), { type: 'dir' }],
    [join(root, '1784784551097', 'agent-transcripts'), { type: 'dir' }],
    [dirA, { type: 'dir' }],
    [dirB, { type: 'dir' }],
    [dirNum, { type: 'dir' }],
    [fileA, { type: 'file', mtimeMs: 1786000002000, text: [
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: tsRaw }] } }),
    ].join('\n') }],
    [fileB, { type: 'file', mtimeMs: 1786000003000, text: [
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>连字符目录</user_query>' }] } }),
    ].join('\n') }],
    [fileNum, { type: 'file', mtimeMs: 1786000004000, text: [
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>纯数字 slug</user_query>' }] } }),
    ].join('\n') }],
    ['E:\\dev-suite', { type: 'dir' }],
    [cwdDots, { type: 'dir' }],
    ['E:\\dev-suite\\scheduled-tasks', { type: 'dir' }],
    [cwdHyphen, { type: 'dir' }],
  ])
  const host = memoryHost(files)
  host.resolveCursorSlug = async (s) => {
    const ctx = {
      get(service) {
        if (service === 'workspaceRegistry') {
          return { list: () => [{ path: cwdDots }, { path: cwdHyphen }] }
        }
        return undefined
      },
      fs: {
        async resolve(p) { return { targetKey: p } },
        async stat(t) {
          const v = files.get(t.targetKey)
          if (!v) return null
          return v.type === 'dir' ? { type: 'directory' } : { type: 'file', size: (v.text || '').length, mtimeMs: v.mtimeMs }
        },
      },
    }
    return resolveCursorSlugPath(ctx, s)
  }
  const { sessions, total } = await discoverSessions({ path: root, format: 'cursor', host, imports: {} })
  assert.equal(total, 3)
  const dots = sessions.find((s) => s.sessionId === uuid)
  assert.equal(dots.project, 'demo.Client-app')
  assert.equal(dots.cwd, cwdDots)
  assert.equal(dots.title, '点号目录提问')
  assert.ok(typeof dots.createdAt === 'number' && dots.createdAt > 0)
  assert.equal(dots.lastActiveAt, 1786000002000)
  const hyphen = sessions.find((s) => s.sessionId === 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
  assert.equal(hyphen.project, 'publish-fail-monitor')
  assert.equal(hyphen.cwd, cwdHyphen)
  const numeric = sessions.find((s) => s.sessionId === 'cccccccc-cccc-cccc-cccc-cccccccccccc')
  assert.equal(numeric.project, null)
  assert.equal(numeric.cwd, null)
})

test('codex：扁平 archived_sessions/ 下的 rollout 可被发现', async () => {
  const root = join(HOME, '.codex', 'archived_sessions')
  const archived = join(root, 'rollout-20260310T120000-019e3b3f-636d-7cb3-aaab-0255eb45ad4f.jsonl')
  const files = new Map([
    [root, { type: 'dir' }],
    [archived, { type: 'file', text: [
      j({ type: 'session_meta', timestamp: '2026-03-10T12:00:00Z', payload: { id: '019e3b3f-636d-7cb3-aaab-0255eb45ad4f', cwd: 'D:/demo/codex-proj' } }),
      j({ type: 'response_item', payload: { type: 'message', role: 'user', content: '归档会话也要能导入' } }),
    ].join('\n') }],
  ])
  const host = memoryHost(files)

  const { sessions, total } = await discoverSessions({ path: root, format: 'codex', host, imports: {} })
  assert.equal(total, 1)
  assert.equal(sessions[0].sessionId, '019e3b3f-636d-7cb3-aaab-0255eb45ad4f')
  assert.equal(sessions[0].title, '归档会话也要能导入')
  assert.equal(sessions[0].sourcePath, archived)
})
