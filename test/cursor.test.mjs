import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rmSync, utimesSync, writeFileSync } from 'node:fs'
import { cursorComposerWorkspace, cursorUserDataDir, readCursorComposerWorkspaces } from '../lib/sources/cursor.mjs'
import { cursorWorkspaceFixture } from './_support/cursor.mjs'
import { openSqliteFixture, withTempDirAsync } from './_support/tmp-db.mjs'

const header = (fsPath) => JSON.stringify({ workspaceIdentifier: { uri: { fsPath } } })

test('cursor：User 根按平台定位，Linux 遵循 XDG_CONFIG_HOME', () => {
  const home = join('synthetic', 'home')
  const config = join('synthetic', 'config')
  assert.equal(cursorUserDataDir(home, { APPDATA: config }, 'win32'), join(config, 'Cursor', 'User'))
  assert.equal(cursorUserDataDir(home, {}, 'win32'), join(home, 'AppData', 'Roaming', 'Cursor', 'User'))
  assert.equal(cursorUserDataDir(home, {}, 'darwin'), join(home, 'Library', 'Application Support', 'Cursor', 'User'))
  assert.equal(cursorUserDataDir(home, { XDG_CONFIG_HOME: config }, 'linux'), join(config, 'Cursor', 'User'))
  assert.equal(cursorUserDataDir(home, {}, 'linux'), join(home, '.config', 'Cursor', 'User'))
})

test('cursor：只采用目录，畸形头可回退 workspace.json.folder 文件 URI', async () => {
  await withTempDirAsync('cursor-headers-', async (root) => {
    const cwd = join(root, 'moved-project')
    const folder = join(root, '含空格 project')
    const workspaceFile = join(root, 'multi.code-workspace')
    const { ctx } = cursorWorkspaceFixture(root, {
      rows: [
        { composerId: 'direct', workspaceId: 'sidecar', value: header(cwd) },
        { composerId: 'sidecar', workspaceId: 'sidecar', value: '{broken' },
        { composerId: 'deleted', workspaceId: 'sidecar', value: header(join(root, 'deleted')) },
        { composerId: 'multi', value: header(workspaceFile) },
        { composerId: 'relative', value: header('relative/path') },
        { composerId: 'remote', workspaceId: 'remote', value: 'null' },
        { composerId: 'traversal', workspaceId: '../escape', value: '[]' },
        { composerId: 'wrong-type', workspaceId: 42, value: header({ path: cwd }) },
        { composerId: '', value: header(cwd) },
      ],
      tree: {
        [cwd]: 'dir', [folder]: 'dir', [workspaceFile]: '{}',
        [join(root, 'workspaceStorage', 'sidecar', 'workspace.json')]: JSON.stringify({ folder: pathToFileURL(folder).href }),
        [join(root, 'workspaceStorage', 'remote', 'workspace.json')]: JSON.stringify({ folder: 'vscode-remote://ssh-remote/project' }),
        [join(root, 'escape', 'workspace.json')]: JSON.stringify({ folder: cwd }),
      },
    })
    assert.deepEqual(await readCursorComposerWorkspaces(ctx), new Map([
      ['direct', cwd], ['sidecar', folder], ['deleted', folder],
    ]))
  })
})

test('cursor：畸形登记及文件读取失败按类别计数告警，仍保留可用工作区', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  await withTempDirAsync('cursor-warnings-', async (root) => {
    const cwd = join(root, 'project')
    const denied = join(root, 'denied')
    const unreadable = join(root, 'workspaceStorage', 'unreadable', 'workspace.json')
    const { ctx } = cursorWorkspaceFixture(root, {
      rows: [
        { composerId: 'bad-header', value: '{broken' },
        { composerId: 'bad-sidecar', workspaceId: 'broken' },
        { composerId: 'read-failure', workspaceId: 'unreadable' },
        { composerId: 'stat-failure', value: header(denied) },
        { composerId: 'valid', value: header(cwd) },
      ],
      tree: {
        [cwd]: 'dir', [unreadable]: '{}',
        [join(root, 'workspaceStorage', 'broken', 'workspace.json')]: '{broken',
      },
    })
    const stat = ctx.fs.stat
    const readText = ctx.fs.readText
    t.mock.method(ctx.fs, 'stat', async (target) => {
      if (target.targetKey === denied) throw new Error('EACCES')
      return stat(target)
    })
    t.mock.method(ctx.fs, 'readText', async (target) => {
      if (target.targetKey === unreadable) throw new Error('EACCES')
      return readText(target)
    })
    assert.deepEqual(await readCursorComposerWorkspaces(ctx), new Map([['valid', cwd]]))
    assert.equal(warn.mock.callCount(), 1)
    const message = String(warn.mock.calls[0].arguments[0])
    assert.match(message, /cursor.*malformedHeaders=1.*malformedSidecars=1.*readFailures=2/)
  })
})

test('cursor：一条畸形登记不使逐会话发现重复读库或告警', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  t.mock.method(Date, 'now', () => 1000)
  await withTempDirAsync('cursor-partial-cache-', async (root) => {
    const cwd = join(root, 'project')
    const { ctx } = cursorWorkspaceFixture(root, {
      rows: [{ composerId: 'valid', value: header(cwd) }, { composerId: 'broken', value: '{broken' }],
      tree: { [cwd]: 'dir' },
    })
    // 指纹探测只 stat；processPath 每次真正打开登记库时调用一次。
    const opens = t.mock.method(ctx.fs, 'processPath')
    for (const id of ['valid', 'broken', 'missing', 'valid', 'broken']) {
      assert.equal(await cursorComposerWorkspace(ctx, id), id === 'valid' ? cwd : null)
    }
    assert.equal(opens.mock.callCount(), 1, '部分坏行仍应复用已读结果')
    assert.equal(warn.mock.callCount(), 1)
    assert.match(String(warn.mock.calls[0].arguments[0]), /malformedHeaders=1/)
  })
})

test('cursor：登记册文件系统探测失败告警并降级', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  await withTempDirAsync('cursor-stat-failure-', async (root) => {
    const { ctx } = cursorWorkspaceFixture(root)
    t.mock.method(ctx.fs, 'stat', async () => { throw new Error('EACCES') })
    assert.deepEqual(await readCursorComposerWorkspaces(ctx), new Map())
    assert.equal(warn.mock.callCount(), 1)
    assert.match(String(warn.mock.calls[0].arguments[0]), /readFailures=1/)
  })
})

for (const columns of ['composerId TEXT, value TEXT', 'composerId TEXT, workspaceId TEXT', 'composerId TEXT', 'id TEXT']) {
  test('cursor：缺可选列不阻断可用路径，缺 composerId 则跳过（' + columns + '）', async () => {
    await withTempDirAsync('cursor-columns-', async (root) => {
      const cwd = join(root, 'project')
      const row = columns.includes('value') ? { composerId: 'session', value: header(cwd) }
        : columns.includes('workspaceId') ? { composerId: 'session', workspaceId: 'workspace' } : null
      const { ctx } = cursorWorkspaceFixture(root, {
        create: 'CREATE TABLE composerHeaders (' + columns + ')', rows: row ? [row] : [],
        tree: {
          [cwd]: 'dir',
          [join(root, 'workspaceStorage', 'workspace', 'workspace.json')]: JSON.stringify({ folder: cwd }),
        },
      })
      assert.equal(await cursorComposerWorkspace(ctx, 'session'), row ? cwd : null)
    })
  })
}

for (const kind of ['missing', 'no-table', 'corrupt', 'locked']) {
  test('cursor：可选登记册不可读时返回空映射（' + kind + '）', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {})
    await withTempDirAsync('cursor-unavailable-', async (root) => {
      const { ctx, dbPath } = cursorWorkspaceFixture(root, {
        create: kind === 'no-table' ? 'CREATE TABLE other (id TEXT)' : undefined,
      })
      if (kind === 'missing') rmSync(dbPath)
      if (kind === 'corrupt') writeFileSync(dbPath, 'not sqlite')
      const locked = kind === 'locked' ? openSqliteFixture(dbPath, { statements: ['BEGIN EXCLUSIVE'] }) : null
      try {
        assert.equal(await cursorComposerWorkspace(ctx, 'session'), null)
      } finally {
        if (locked) locked.close()
      }
      assert.equal(warn.mock.callCount(), 0, '缺库 / 缺表 / 锁库保留静默探测')
    })
  })
}

test('cursor：同宿主并发共用缓存，DB 指纹变化立即重读', async (t) => {
  await withTempDirAsync('cursor-cache-', async (root) => {
    let now = 1000
    t.mock.method(Date, 'now', () => now)
    const cwd = join(root, 'project')
    const moved = join(root, 'moved-project')
    const { ctx, dbPath } = cursorWorkspaceFixture(root, {
      rows: [{ composerId: 'session', value: header(cwd) }], tree: { [cwd]: 'dir', [moved]: 'dir' },
    })
    const [first, second] = await Promise.all([readCursorComposerWorkspaces(ctx), readCursorComposerWorkspaces(ctx)])
    assert.equal(first, second)
    const db = openSqliteFixture(dbPath)
    try { db.prepare('UPDATE composerHeaders SET value = ?').run(header(moved)) } finally { db.close() }
    utimesSync(dbPath, 2, 2)
    assert.equal(await cursorComposerWorkspace(ctx, 'session'), moved)
    now += 30_001
    assert.equal(await cursorComposerWorkspace(ctx, 'session'), moved)
  })
})

test('cursor：WAL 变化立即使发现缓存失效', async () => {
  await withTempDirAsync('cursor-wal-cache-', async (root) => {
    const cwd = join(root, 'project')
    const moved = join(root, 'moved-project')
    const { ctx, dbPath } = cursorWorkspaceFixture(root, {
      rows: [{ composerId: 'session', value: header(cwd) }], tree: { [cwd]: 'dir', [moved]: 'dir' },
    })
    const db = openSqliteFixture(dbPath, { statements: ['PRAGMA journal_mode = WAL', 'PRAGMA wal_autocheckpoint = 0'] })
    try {
      assert.equal(await cursorComposerWorkspace(ctx, 'session'), cwd)
      db.prepare('UPDATE composerHeaders SET value = ?').run(header(moved))
      utimesSync(dbPath + '-wal', 2, 2)
      assert.equal(await cursorComposerWorkspace(ctx, 'session'), moved)
    } finally { db.close() }
  })
})

test('cursor：锁库失败不入缓存，解锁后同指纹立即重试', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  await withTempDirAsync('cursor-lock-retry-', async (root) => {
    const cwd = join(root, 'project')
    const { ctx, dbPath } = cursorWorkspaceFixture(root, {
      rows: [{ composerId: 'session', value: header(cwd) }], tree: { [cwd]: 'dir' },
    })
    const locked = openSqliteFixture(dbPath, { statements: ['BEGIN EXCLUSIVE'] })
    try { assert.equal(await cursorComposerWorkspace(ctx, 'session'), null) } finally { locked.close() }
    assert.equal(await cursorComposerWorkspace(ctx, 'session'), cwd)
    assert.equal(warn.mock.callCount(), 0)
  })
})

test('cursor：旁路文件变更仍在 30 秒后刷新，文件读取失败不入缓存', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  await withTempDirAsync('cursor-sidecar-cache-', async (root) => {
    let now = 1000
    t.mock.method(Date, 'now', () => now)
    const cwd = join(root, 'project')
    const moved = join(root, 'moved-project')
    const sidecar = join(root, 'workspaceStorage', 'workspace', 'workspace.json')
    const tree = { [cwd]: 'dir', [moved]: 'dir', [sidecar]: JSON.stringify({ folder: cwd }) }
    const { ctx } = cursorWorkspaceFixture(root, { rows: [{ composerId: 'session', workspaceId: 'workspace' }], tree })
    const readText = ctx.fs.readText
    let denied = true
    t.mock.method(ctx.fs, 'readText', async (target) => {
      if (denied) throw new Error('EACCES')
      return readText(target)
    })
    assert.equal(await cursorComposerWorkspace(ctx, 'session'), null)
    denied = false
    assert.equal(await cursorComposerWorkspace(ctx, 'session'), cwd)
    tree[sidecar] = JSON.stringify({ folder: moved })
    assert.equal(await cursorComposerWorkspace(ctx, 'session'), cwd)
    now += 30_001
    assert.equal(await cursorComposerWorkspace(ctx, 'session'), moved)
    assert.equal(warn.mock.callCount(), 1)
  })
})
