// Trae Work coverage: pure conversion, read-only ItemTable extraction, known path
// layouts, and discovery metadata. Fixtures are synthetic and contain no user data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { convertTraeJson } from '../lib/convert/trae.mjs'
import { listTraeDatabases, readTraeDb, readTraeDbSummaries } from '../lib/sources/trae.mjs'
import { discoverSessions } from '../lib/discovery.mjs'

function fixtureSessions() {
  return {
    list: [
      {
        sessionId: 'trae-1',
        title: 'Trae import fixture',
        directory: 'C:/workspace/trae-demo',
        createdAt: '2026-09-30T12:00:00.000Z',
        messages: [
          { id: 'm1', role: 'user', content: 'Fix the failing test' },
          { id: 'm2', role: 'ai', content: 'I will inspect the test first.' },
          {
            id: 'm3',
            role: 'assistant',
            agentTaskContent: {
              guideline: {
                planItems: [{ thought: 'Inspect the fixture', toolName: 'read', params: { path: 'test.js' }, result: 'Found the assertion.' }],
              },
            },
          },
        ],
      },
      // Tool-only rows do not become empty DSH turns.
      { sessionId: 'trae-empty', messages: [{ role: 'tool', content: 'internal' }] },
    ],
  }
}

function makeDb(valueRows) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-trae-'))
  const path = join(dir, 'state.vscdb')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB NOT NULL)')
  const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
  for (const [key, value] of valueRows) insert.run(key, typeof value === 'string' ? value : JSON.stringify(value))
  db.close()
  return { dir, path }
}

test('Trae converter preserves user/assistant turns and readable plan fallback', () => {
  const result = convertTraeJson(JSON.stringify(fixtureSessions().list[0]))
  assert.ok(result.meta)
  assert.equal(result.turns.length, 1)
  assert.equal(result.turns[0].prompt, 'Fix the failing test')
  const content = result.turns[0].steps.flatMap((step) => step.content).map((part) => part.text || '').join('\n')
  assert.match(content, /I will inspect the test first\./)
  assert.match(content, /\[thought\] Inspect the fixture/)
  assert.match(content, /\[tool\] read/)
  assert.match(JSON.stringify(result), /trae/)
})

test('Trae reader uses the primary key, fallback keys, and deduplicates sessions', () => {
  const numeric = fixtureSessions()
  numeric.list[0].createdAt = 1780000000000
  numeric.list[0].messages[0].timestamp = 1780000001000
  const { dir, path } = makeDb([
    ['memento/icube-ai-agent-storage', numeric],
    ['ChatStore', { sessions: [{ sessionId: 'trae-1', messages: [{ role: 'user', content: 'duplicate' }] }, { sessionId: 'trae-2', messages: [{ role: 'user', content: 'fallback' }] }] }],
  ])
  try {
    const sessions = readTraeDb(path)
    assert.deepEqual(sessions.map((session) => session.id), ['trae-1', 'trae-2'])
    const summary = readTraeDbSummaries(path)[0]
    assert.equal(summary.title, 'Trae import fixture')
    assert.equal(summary.createdAt, 1780000000000)
    assert.equal(summary.lastActiveAt, 1780000001000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Trae discovery expands workspaceStorage databases without scanning unrelated files', async () => {
  const root = 'C:/Users/tester/AppData/Roaming/Trae/User'
  const workspace = join(root, 'workspaceStorage', 'workspace-hash')
  const dbPath = join(workspace, 'state.vscdb')
  const files = new Map([
    [root, { type: 'directory' }],
    [join(root, 'workspaceStorage'), { type: 'directory' }],
    [workspace, { type: 'directory' }],
    [dbPath, { type: 'file', size: 128, mtimeMs: 1780000000000 }],
    [join(root, 'workspaceStorage', 'workspace-hash', 'unrelated.json'), { type: 'file', size: 4, mtimeMs: 1780000000000 }],
  ])
  const host = {
    async stat(path) {
      const item = files.get(path)
      return item ? { type: item.type, size: item.size, mtimeMs: item.mtimeMs } : null
    },
    async readDir(path) {
      const separator = path.includes('\\') ? '\\' : '/'
      const prefix = path.endsWith(separator) ? path : path + separator
      return [...files.entries()]
        .filter(([candidate]) => candidate.startsWith(prefix) && !/[\\/]/.test(candidate.slice(prefix.length)))
        .map(([candidate, item]) => ({ name: candidate.slice(prefix.length), type: item.type, path: candidate }))
    },
    async readHead() { return null },
    async readTail() { return null },
    async readText() { return null },
    async readSessions(kind, path) {
      assert.equal(kind, 'trae')
      assert.equal(path, dbPath)
      return [{ id: 'trae-1', title: 'Trae import fixture', directory: 'C:/workspace/trae-demo', createdAt: 1780000000000, lastActiveAt: 1780000001000 }]
    },
  }
  const result = await discoverSessions({ path: root, format: 'trae', host, imports: {} })
  assert.equal(result.total, 1)
  assert.equal(result.sessions[0].format, 'trae')
  assert.equal(result.sessions[0].sourcePath, dbPath)
  assert.equal(result.sessions[0].project, 'trae-demo')
})

test('Trae database path helper accepts a direct state.vscdb file', async () => {
  const { dir, path } = makeDb([['memento/icube-ai-agent-storage', fixtureSessions()]])
  try {
    const host = {
      async stat(candidate) { return candidate === path ? { type: 'file' } : null },
      async readDir() { return [] },
    }
    assert.deepEqual(await listTraeDatabases(host, path), [path])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
