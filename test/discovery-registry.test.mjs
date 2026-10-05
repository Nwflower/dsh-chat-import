// test/discovery-registry.test.mjs — 来源描述符表（lib/discovery/registry.mjs）的派生契约
//
// FORMATS / defaultRoots / 扫描器 / 布局项目名 / 单文件路径判格式都从同一张描述符表派生；
// 这里锁住「派生结果与各来源描述一致」，以及此前几张平行清单漂移留下的缺口（单文件
// db.sqlite 判不出 zcode 等）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { discoverSessions, clearScanCache, clearInflightScans, FORMATS, defaultRoots, layoutProject } from '../lib/discovery.mjs'
import { SOURCES } from '../lib/discovery/registry.mjs'
import { DB_SUMMARY_FORMATS } from '../lib/discovery-host.mjs'
import { memoryHost, withDirs } from './_support/discovery-host.mjs'

beforeEach(() => {
  clearScanCache()
  clearInflightScans()
})

const HOME = join('C:', 'Users', 'tester')

test('单文件路径：zcode 的 db.sqlite 不给 format 也能判格式并发现', async () => {
  const dbPath = join(HOME, '.zcode', 'cli', 'db', 'db.sqlite')
  const host = memoryHost(new Map([[dbPath, { type: 'file', text: 'SQLite format 3', mtimeMs: 1786000000000 }]]))
  host.dbSessions = (kind) => (kind === 'zcode'
    ? [{ id: 'zcs-1', title: 'Z 会话', directory: join(HOME, 'proj'), createdAt: 1, lastActiveAt: 2 }]
    : null)
  const { sessions } = await discoverSessions({ path: dbPath, host, imports: {}, cache: new Map() })
  assert.deepEqual(sessions.map((s) => [s.format, s.sessionId]), [['zcode', 'zcs-1']])
})

test('defaultRoots：键集合与 FORMATS 一致（每个来源恰有一个描述符），chatgpt 无默认根', () => {
  const roots = defaultRoots({ home: HOME, env: {} })
  assert.deepEqual(Object.keys(roots).sort(), [...FORMATS].sort())
  assert.equal(roots.chatgpt, null)
  assert.equal(new Set(FORMATS).size, FORMATS.length)
})

test('defaultRoots：env 注入（不读 process.env）——DSH_HOME / GROK_HOME / CONTINUE_GLOBAL_DIR / CLINE_*', () => {
  const env = {
    DSH_HOME: join(HOME, 'harness'),
    GROK_HOME: join(HOME, 'grok-data'),
    CONTINUE_GLOBAL_DIR: join(HOME, 'cont'),
    CLINE_SESSION_DATA_DIR: join(HOME, 'cline-sessions'),
    CLINE_LEGACY_GLOBAL_STORAGE_DIR: join(HOME, 'cline-legacy'),
  }
  const roots = defaultRoots({ home: HOME, env })
  assert.equal(roots.dsh, join(HOME, 'harness', 'sessions'))
  assert.equal(roots.dsh4, join(HOME, 'harness', 'sessions'))
  assert.deepEqual(roots.grokbuild, [join(HOME, 'grok-data', 'sessions'), join(HOME, 'grok-data', 'archived_sessions')])
  assert.equal(roots.continue, join(HOME, 'cont', 'sessions'))
  assert.deepEqual(roots.cline, [join(HOME, 'cline-sessions'), join(HOME, 'cline-legacy')])
})

test('FORMATS 顺序固定（工具 schema enum 与默认扫描 / 流式产出顺序）', () => {
  assert.deepEqual(FORMATS, [
    'claude', 'codex', 'cursor', 'gemini', 'antigravity', 'reasonix', 'opencode', 'mimocode',
    'zcode', 'grokbuild', 'openclaw', 'pi', 'hermes', 'kimi', 'kilocode', 'qoder', 'chatgpt', 'workbuddy', 'qwen',
    'continue', 'cline', 'goose', 'dsh4', 'zed', 'crush', 'teleagent', 'trae', 'vibe', 'dsh',
  ])
})

test('sessionsFromHost 的来源与 host.readSessions 读取器表一一对应（新增 SQLite 来源两侧都要登记）', () => {
  const needed = SOURCES.filter((s) => s.sessionsFromHost).map((s) => s.format).sort()
  assert.deepEqual([...DB_SUMMARY_FORMATS].sort(), needed)
})

// dsh 与 dsh4 是同一目录布局的两个代次桶：布局项目名（记录无 cwd、大 .zstd 快路径时的回退）
// 两者同口径。此前 layoutProject 的 switch 只登记了 dsh，dsh4 条目的项目恒为 null。
test('layoutProject / 扫描：dsh4 与 dsh 同用 workspace 键解码出项目名', async () => {
  const p4 = '/h/sessions/--a~002Eb--/sid/session.v4.jsonl'
  assert.equal(layoutProject(p4, 'dsh4'), '--a.b--')
  const root = join(HOME, 'dsh-home-layout', 'sessions')
  const file = join(root, '--proj~0020x--', 'session-v4', 'session.v4.jsonl')
  const body = [
    JSON.stringify({ type: 'session', id: 'session-v4', createdAt: 1700000000000 }),
    JSON.stringify({ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '无 cwd 的 V4 日志' }] } }),
  ].join('\n')
  const host = memoryHost(withDirs(root, new Map([[file, { type: 'file', mtimeMs: 1786000002000, text: body }]])))
  const { sessions } = await discoverSessions({ path: root, format: 'dsh4', host, imports: {}, cache: new Map() })
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].project, '--proj x--')
})

// 发现层不直接打开 SQLite（摘要经 host.readSessions，读取器在 lib/discovery-host.mjs）：import
// lib/discovery.mjs 不应把 node:sqlite 带进进程（否则每个只用发现层的入口都会打印 SQLite 的
// ExperimentalWarning）。在干净子进程里验证模块加载清单。
test('import lib/discovery.mjs 不加载 node:sqlite', () => {
  const url = new URL('../lib/discovery.mjs', import.meta.url).href
  const code = `await import(${JSON.stringify(url)}); process.stdout.write(JSON.stringify(process.moduleLoadList.filter((m) => /sqlite/i.test(m))))`
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(JSON.parse(res.stdout), [])
  assert.ok(!/SQLite is an experimental feature/.test(res.stderr), res.stderr)
})
