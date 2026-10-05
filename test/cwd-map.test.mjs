// cwd-map.test.mjs — REQ-39 full 单测：slug 编解码 / Claude 权威映射 / Reasonix 贪心
// 解码 / home-dir 沙箱判定（纯函数 + mock fs）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { slugifyClaudeCwd, decodeClaudeSlug, isHomePath, resolveClaudeCwd, greedyDecodeSlugPath, encodeCursorSlug, resolveCursorSlugPath, greedyDecodeCursorSlugPath, parseCursorEmbeddedTimestamp, stripCursorTitleDecorations, isCursorNonRepoSlug, clearWorkspacePathCache } from '../lib/cwd-map.mjs'

test('slugifyClaudeCwd / decodeClaudeSlug: 编码往返 + 中文路径 + 盘符边界', () => {
  const cwd = 'C:\\Users\\示例用户\\my-proj'
  const slug = slugifyClaudeCwd(cwd)
  assert.equal(slug, 'C--Users-示例用户-my-proj')
  // 解码（有损兜底：my-proj 会被拆成 my/proj，已知歧义）
  const decoded = decodeClaudeSlug(slug)
  assert.equal(decoded, 'C:\\Users\\示例用户\\my\\proj')
  // 无盘符形态
  assert.equal(decodeClaudeSlug('users-name'), 'users\\name')
  assert.equal(decodeClaudeSlug(''), null)
})

test('isHomePath: 主目录（含尾斜杠/大小写变体）判定，非主目录排除', () => {
  const home = homedir().replace(/[\\/]+$/, '')
  assert.equal(isHomePath(home), true)
  assert.equal(isHomePath(home + '\\'), true)
  assert.equal(isHomePath(home + '\\projects'), false)
  assert.equal(isHomePath(''), false)
})

function makeFsTree(tree) {
  const norm = (p) => String(p).replace(/\\/g, '/')
  return {
    fs: {
      async resolve(path) { return { targetKey: path, displayPath: path } },
      async stat(target) {
        const v = tree[target.targetKey] ?? tree[norm(target.targetKey)] ?? tree[norm(target.targetKey).replace(/\//g, '\\')]
        return v === undefined ? undefined : { type: v === 'dir' ? 'directory' : 'file', size: 1, version: 'v' }
      },
      async readText(target) {
        const v = tree[target.targetKey] ?? tree[norm(target.targetKey)]
        if (v === undefined || v === 'dir') throw new Error('FS_NOT_FOUND')
        return v
      },
    },
  }
}

test('resolveClaudeCwd: ~/.claude.json projects 权威映射（精确 / basename / 下划线变体）', async () => {
  const home = homedir().replace(/[\\/]+$/, '')
  const claudeJson = JSON.stringify({
    projects: {
      'D:\\work\\my-proj': { folderName: 'my-proj' },
      'C:\\Users\\name\\proj_a': { folderName: 'proj_a' },
      'E:\\deep\\nested\\target': { folderName: 'target' },
    },
  })
  // 夹具键按本平台分隔符拼（与实现同口径）：POSIX 上 home + '\\.claude.json' 根本不是那个文件
  const ctx = makeFsTree({ [join(home, '.claude.json')]: claudeJson })
  // 精确：slugify('D:\work\my-proj') = 'D--work-my-proj'
  assert.equal(await resolveClaudeCwd(ctx, 'D--work-my-proj'), 'D:\\work\\my-proj')
  // basename 变体：slug 只含 basename
  assert.equal(await resolveClaudeCwd(ctx, 'my-proj'), 'D:\\work\\my-proj')
  // 下划线变体：'proj_a' 的 slugify = 'proj-a' → underscore 匹配
  assert.equal(await resolveClaudeCwd(ctx, 'proj-a'), 'C:\\Users\\name\\proj_a')
  // 无命中 → null
  assert.equal(await resolveClaudeCwd(ctx, 'no-such-project'), null)
})

test('resolveClaudeCwd: 按本平台路径口径定位 ~/.claude.json（POSIX 上不得拼出反斜杠）', async () => {
  const asked = []
  const ctx = {
    fs: {
      async resolve(path) { asked.push(path); return { targetKey: path, displayPath: path } },
      async readText() { return JSON.stringify({ projects: { '/work/demo': {} } }) },
    },
  }
  await resolveClaudeCwd(ctx, '-work-demo')
  assert.deepEqual(asked, [join(homedir(), '.claude.json')])
})

test('resolveClaudeCwd: ~/.claude.json 缺失/损坏 → null（回退解码不崩）', async () => {
  const home = homedir().replace(/[\\/]+$/, '')
  const ctx = makeFsTree({})
  assert.equal(await resolveClaudeCwd(ctx, 'C--Users-name'), null)
  const bad = makeFsTree({ [join(home, '.claude.json')]: 'not json' })
  assert.equal(await resolveClaudeCwd(bad, 'C--Users-name'), null)
})

test('greedyDecodeSlugPath: 整段命中 → 直接返回真实路径', async () => {
  const ctx = makeFsTree({
    'C:\\users\\alice\\work': 'dir',
  })
  assert.equal(await greedyDecodeSlugPath(ctx, 'c--users--alice--work'), 'C:\\users\\alice\\work')
})

test('greedyDecodeSlugPath: 含 - 目录名逐段贪心（单段 → 合并 ≤3 段）', async () => {
  const ctx = makeFsTree({
    'C:\\users': 'dir',
    'C:\\users\\alice': 'dir',
    'C:\\users\\alice\\my-proj': 'dir',
  })
  // slug 'c--users--alice--my--proj'：整段不命中（my-proj 是单目录），贪心逐段：
  // 'users' 单段命中 → 'alice' 单段命中 → 剩余 'my'/'proj' 单段不命中 → 合并 2 段
  // 'my-proj' 命中
  assert.equal(await greedyDecodeSlugPath(ctx, 'c--users--alice--my--proj'), 'C:\\users\\alice\\my-proj')
})

test('greedyDecodeSlugPath: 全程不命中 → null；无盘符 slug 也支持', async () => {
  const ctx = makeFsTree({ 'C:\\users\\alice': 'dir' })
  assert.equal(await greedyDecodeSlugPath(ctx, 'c--users--bob'), null)
  const noDrive = makeFsTree({ 'users\\alice': 'dir' })
  assert.equal(await greedyDecodeSlugPath(noDrive, 'users--alice'), 'users\\alice')
  assert.equal(await greedyDecodeSlugPath(ctx, ''), null)
})

test('encodeCursorSlug: 盘符 + 路径分隔符与 . 均编码为 -', () => {
  assert.equal(
    encodeCursorSlug('E:\\dev-suite\\demo.Client-app'),
    'e-dev-suite-demo-Client-app',
  )
  assert.equal(
    encodeCursorSlug('E:\\dev-suite\\scheduled-tasks\\publish-fail-monitor'),
    'e-dev-suite-scheduled-tasks-publish-fail-monitor',
  )
  assert.equal(encodeCursorSlug('C:\\Users\\Administrator\\Desktop'), 'c-Users-Administrator-Desktop')
})

test('resolveCursorSlugPath: workspace.json/registry 正向匹配 + 点号目录贪心解码', async () => {
  clearWorkspacePathCache()
  const tree = {
    'E:\\dev-suite': 'dir',
    'E:\\dev-suite\\demo.Client-app': 'dir',
    'E:\\dev-suite\\scheduled-tasks': 'dir',
    'E:\\dev-suite\\scheduled-tasks\\publish-fail-monitor': 'dir',
  }
  const ctx = {
    ...makeFsTree(tree),
    get(service) {
      if (service === 'workspaceRegistry') {
        return {
          list: () => [
            { path: 'E:\\dev-suite\\demo.Client-app' },
            { path: 'E:\\dev-suite\\scheduled-tasks\\publish-fail-monitor' },
          ],
        }
      }
      return undefined
    },
  }
  assert.equal(
    await resolveCursorSlugPath(ctx, 'e-dev-suite-demo-Client-app'),
    'E:\\dev-suite\\demo.Client-app',
  )
  assert.equal(
    await resolveCursorSlugPath(ctx, 'e-dev-suite-scheduled-tasks-publish-fail-monitor'),
    'E:\\dev-suite\\scheduled-tasks\\publish-fail-monitor',
  )
  assert.equal(await resolveCursorSlugPath(ctx, 'empty-window'), null)
  assert.equal(await resolveCursorSlugPath(ctx, '1784784551097'), null)
})

test('greedyDecodeCursorSlugPath: 无 registry 时靠磁盘 . 还原（demo.Client-app）', async () => {
  const tree = {
    'E:\\dev-suite': 'dir',
    'E:\\dev-suite\\demo.Client-app': 'dir',
  }
  const ctx = makeFsTree(tree)
  assert.equal(
    await greedyDecodeCursorSlugPath(ctx, 'e-dev-suite-demo-Client-app'),
    'E:\\dev-suite\\demo.Client-app',
  )
})

test('parseCursorEmbeddedTimestamp / stripCursorTitleDecorations', () => {
  const raw = '<timestamp>Friday, Aug 7, 2026, 3:44 PM (UTC+8)</timestamp>\n<user_query>hello</user_query>'
  const ts = parseCursorEmbeddedTimestamp(raw)
  assert.ok(typeof ts === 'number' && ts > 0)
  assert.equal(stripCursorTitleDecorations(raw), 'hello')
  assert.equal(isCursorNonRepoSlug('empty-window'), true)
  assert.equal(isCursorNonRepoSlug('1784784551097'), true)
  assert.equal(isCursorNonRepoSlug('e-dev-suite-demo-Client-app'), false)
})
