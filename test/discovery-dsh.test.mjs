// discovery-dsh.test.mjs — DSH 自身会话日志的发现
// 代次工件名（v3 → dsh、v4 → dsh4）、默认数据根、~XXXX 转义还原。
// 由 test/discovery.test.mjs 按 lib/discovery/ 的实现族拆出（纯移动：用例与断言未改）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { discoverSessions, clearScanCache, clearInflightScans } from '../lib/discovery.mjs'
import { memoryHost } from './_support/discovery-host.mjs'
import { FAKE_HOME as HOME, j } from './_support/discovery-host.mjs'

beforeEach(() => {
  clearScanCache()
  clearInflightScans()
})

test('dsh：单文件路径自动探测（不给 format）—— 代次工件名 + Windows 分隔符', async () => {
  const winFile = 'D:\\demo\\dsh-home\\sessions\\--D-Build--\\session-abc\\session.v3.jsonl'
  const posixFile = '/demo/dsh-home/sessions/--D-Build--/session-def/session.v3.jsonl'
  const body = (id) => [
    j({ type: 'session', id, cwd: '/demo/proj', createdAt: 1700000000000 }),
    j({ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '单文件路径也要能探测' }] } }),
  ].join('\n')

  for (const [file, id] of [[winFile, 'session-abc'], [posixFile, 'session-def']]) {
    const host = memoryHost(new Map([[file, { type: 'file', mtimeMs: 1786000002000, text: body(id) }]]))
    const { sessions, total } = await discoverSessions({ path: file, host, imports: {} })
    assert.equal(total, 1, '单文件目标应产出 1 条（' + file + '）')
    assert.equal(sessions[0].format, 'dsh', file)
    assert.equal(sessions[0].sessionId, id)
    assert.equal(sessions[0].sourcePath, file)
  }
})

test('dsh / dsh4：按日志代次给格式（v3 → dsh，v4 → dsh4）', async () => {
  const body = (id) => [
    j({ type: 'session', id, cwd: '/demo/proj', createdAt: 1700000000000 }),
    j({ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '代次分流' }] } }),
  ].join('\n')
  const cases = [
    ['D:\\demo\\dsh-home\\sessions\\--D-Build--\\session-a\\session.v3.jsonl', 'session-a', 'dsh'],
    ['D:\\demo\\dsh-home\\sessions\\--D-Build--\\session-b\\session.v4.jsonl', 'session-b', 'dsh4'],
  ]
  for (const [file, id, fmt] of cases) {
    const host = memoryHost(new Map([[file, { type: 'file', mtimeMs: 1786000002000, text: body(id) }]]))
    const { sessions, total } = await discoverSessions({ path: file, host, imports: {} })
    assert.equal(total, 1, file)
    assert.equal(sessions[0].sessionId, id)
    assert.equal(sessions[0].format, fmt, file + ' 应按日志代次归到 ' + fmt)
  }
})

test('dsh / dsh4：默认数据根（不给 path）两个代次都能发现，单选 dsh4 也有目标', async () => {
  const dshHome = join(HOME, 'dsh-home-roots')
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  try {
    const body = (id) => [
      j({ type: 'session', id, cwd: '/demo/proj', createdAt: 1700000000000 }),
      j({ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '默认根' }] } }),
    ].join('\n')
    const dir = (...p) => [join(dshHome, 'sessions', ...p), { type: 'dir' }]
    const files = new Map([
      dir(), dir('--D-Build--'), dir('--D-Build--', 'session-a'), dir('--D-Build--', 'session-b'),
      [join(dshHome, 'sessions', '--D-Build--', 'session-a', 'session.v3.jsonl'), { type: 'file', mtimeMs: 1786000002000, text: body('session-a') }],
      [join(dshHome, 'sessions', '--D-Build--', 'session-b', 'session.v4.jsonl'), { type: 'file', mtimeMs: 1786000002000, text: body('session-b') }],
    ])
    const all = await discoverSessions({ home: HOME, host: memoryHost(files), imports: {}, cache: new Map() })
    const byId = Object.fromEntries(all.sessions.filter((e) => e.format === 'dsh' || e.format === 'dsh4').map((e) => [e.sessionId, e.format]))
    assert.deepEqual(byId, { 'session-a': 'dsh', 'session-b': 'dsh4' })
    const v4 = await discoverSessions({ format: 'dsh4', home: HOME, host: memoryHost(files), imports: {}, cache: new Map() })
    assert.deepEqual(v4.sessions.map((e) => e.sessionId), ['session-b'])
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})
