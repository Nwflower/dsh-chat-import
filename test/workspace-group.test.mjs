// test/workspace-group.test.mjs — 归组契约：目标工作区必须与**创建时的 header cwd** 一致
//
// 宿主（@deepseek-ai/dsh-workspace attachSession）只接受 cwd 与工作区路径相等的挂接，
// 客户端的「未分组」判据是「不在任何 workspace.sessionIds 里」。这里的 mock 按该契约
// 实现：create 只接受已存在的目录，attachSession 校验「会话 cwd === 工作区路径」。
// 覆盖 docs/architecture.md D16 的四条落点规则与两类失败上报。
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { attachPlannedWorkspace, planWorkspaceGroup, normalizeWorkspaceMode } from '../lib/workspace-group.mjs'
import { loadIgnores, rememberWorkspaceIgnore } from '../lib/ignore.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'

process.env.DSH_HOME = freshDshHome('dsh-home-wsg-')

const DEDICATED = join(process.env.DSH_HOME, 'dsh-chat-import-workspace')

// 归组契约 mock：dirs = 磁盘上真实存在的目录（另有真实 fs 兜底——专用导入工作区由被测
// 代码自己 mkdir）；workspaces = 已注册工作区路径；sessionCwd = 会话 header 的 cwd
// （attachSession 校验用，模拟宿主读 header）。
function hostMock({ dirs = [], workspaces = [], sessionCwd = {} } = {}) {
  const existing = new Set(dirs)
  const registered = new Set(workspaces)
  const created = []
  const attachCalls = []
  const isDir = (p) => {
    if (existing.has(p)) return true
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  }
  const entity = (path) => ({
    path,
    async attachSession(id) {
      // 宿主校验：header.cwd 必须与工作区路径逐字相等（realpath 归一后）
      if (sessionCwd[id] !== path) {
        throw new Error(`cannot attach session '${id}' to workspace '${path}': its cwd resolves to '${sessionCwd[id] ?? ''}'`)
      }
      attachCalls.push({ ws: path, id })
    },
  })
  const registry = {
    async resolveByPath(p) { return registered.has(p) ? entity(p) : null },
    async create(p) {
      if (!isDir(p)) throw new Error(`cannot create a workspace at '${p}': path is not a directory`)
      created.push(p)
      registered.add(p)
      return entity(p)
    },
  }
  const ctx = { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) }
  return { ctx, created, attachCalls, registered }
}

test('normalizeWorkspaceMode：未知值按 auto，已知三态原样', () => {
  assert.equal(normalizeWorkspaceMode(undefined), 'auto')
  assert.equal(normalizeWorkspaceMode('nope'), 'auto')
  for (const m of ['auto', 'dedicated', 'per-project']) assert.equal(normalizeWorkspaceMode(m), m)
})

test('cwd 命中已有工作区：沿用该工作区，不改写 cwd', async () => {
  const cwd = 'D:\\proj\\alpha'
  const h = hostMock({ dirs: [cwd], workspaces: [cwd] })
  const plan = await planWorkspaceGroup(h.ctx, { cwd }, 'D:\\src\\a.jsonl')
  assert.equal(plan.mode, 'workspace')
  assert.equal(plan.path, cwd)
  assert.equal(plan.created, false)
  h.cap = undefined
  assert.deepEqual(h.created, [])
})

test('cwd 是本机目录但还不是工作区：就地建工作区（会话落在真实项目下）', async () => {
  const cwd = 'D:\\proj\\beta'
  const h = hostMock({ dirs: [cwd] })
  const plan = await planWorkspaceGroup(h.ctx, { cwd }, 'D:\\src\\b.jsonl')
  assert.equal(plan.mode, 'project')
  assert.equal(plan.path, cwd)
  assert.equal(plan.created, true)
  assert.deepEqual(h.created, [cwd])
})

test('cwd = 主目录：不建主目录工作区，落点是专用导入工作区', async () => {
  const home = process.env.USERPROFILE || process.env.HOME
  const h = hostMock({ dirs: [home] })
  const plan = await planWorkspaceGroup(h.ctx, { cwd: home }, 'D:\\src\\c.jsonl')
  assert.equal(plan.mode, 'dedicated')
  assert.equal(plan.path, DEDICATED)
  assert.equal(plan.fallbackFrom, 'cwd-is-home')
  assert.deepEqual(h.created, [DEDICATED])
})

test('cwd 不可达（跨机器）：宿主拒绝建工作区 → 落点专用导入工作区，且不碰源目录', async () => {
  const h = hostMock({ dirs: [] })
  const plan = await planWorkspaceGroup(h.ctx, { cwd: 'D:\\machine-a\\gone' }, 'C:\\Users\\b\\incoming\\x.jsonl')
  assert.equal(plan.mode, 'dedicated')
  assert.equal(plan.path, DEDICATED)
  assert.match(plan.fallbackFrom, /^create-failed: /)
  // 关键回归：源文件目录绝不被建成工作区（旧实现留下的空工作区源头）
  assert.deepEqual(h.created, [DEDICATED])
})

test('cwd 缺失（无 cwdHint / 无 cwd）：落点专用导入工作区，reason 为 no-cwd', async () => {
  const h = hostMock({ dirs: [] })
  const plan = await planWorkspaceGroup(h.ctx, {}, 'D:\\src\\d.jsonl')
  assert.equal(plan.path, DEDICATED)
  assert.equal(plan.fallbackFrom, 'no-cwd')
})

test('workspaceMode=per-project：cwd 用不上时如实放弃归组（不改写 cwd）', async () => {
  const h = hostMock({ dirs: [] })
  const plan = await planWorkspaceGroup(h.ctx, { cwd: 'D:\\machine-a\\gone' }, 'D:\\src\\e.jsonl', { workspaceMode: 'per-project' })
  assert.equal(plan.path, null)
  assert.equal(plan.mode, 'per-project')
  assert.match(plan.reason, /^create-failed: /)
  assert.deepEqual(h.created, [])
})

test('workspaceMode=dedicated：一律落专用导入工作区（workspaceDir 可覆盖）', async () => {
  const dir = join(process.env.DSH_HOME, 'custom-import-ws')
  const h = hostMock({ dirs: ['D:\\proj\\gamma'] })
  const plan = await planWorkspaceGroup(h.ctx, { cwd: 'D:\\proj\\gamma' }, 'D:\\src\\f.jsonl', { workspaceMode: 'dedicated', workspaceDir: dir })
  assert.equal(plan.mode, 'dedicated')
  assert.equal(plan.path, dir)
  assert.deepEqual(h.created, [dir])
})

test('被删工作区墓碑：命中该源的 sessionKeys 时不再重建（上报 workspace-ignored）', async () => {
  const registryDir = mkdtempSync(join(tmpdir(), 'dsh-wsg-ign-'))
  const sourcePath = 'D:\\src\\g.jsonl'
  await rememberWorkspaceIgnore(registryDir, DEDICATED, [sourcePath])
  await loadIgnores(registryDir)
  const h = hostMock({ dirs: [] })
  const plan = await planWorkspaceGroup(h.ctx, { cwd: 'C:\\Users\\x' }, sourcePath)
  assert.equal(plan.path, null)
  assert.equal(plan.reason, 'workspace-ignored')
  assert.deepEqual(h.created, [])
  // 新源（不在 sessionKeys 里）照常放行：删过一次专用工作区不会永久堵死归组
  const plan2 = await planWorkspaceGroup(h.ctx, { cwd: 'C:\\Users\\x' }, 'D:\\src\\other.jsonl')
  assert.equal(plan2.path, DEDICATED)
})

test('workspaceRegistry 缺席：归组放弃但如实给 reason（不抛错、不阻断导入）', async () => {
  const plan = await planWorkspaceGroup({ get: () => undefined }, { cwd: 'D:\\proj\\delta' }, 'D:\\src\\h.jsonl')
  assert.equal(plan.path, null)
  assert.equal(plan.reason, 'no-registry')
})

test('attachPlannedWorkspace：cwd 不符时宿主拒绝 → ok:false + attach-failed 原因', async () => {
  const cwd = 'D:\\proj\\epsilon'
  const h = hostMock({ dirs: [cwd] })
  const plan = await planWorkspaceGroup(h.ctx, { cwd }, 'D:\\src\\i.jsonl')
  assert.equal(plan.path, cwd)
  // 会话 header 的 cwd 没跟着落点走（调用方忘了改写）→ 宿主拒绝，必须可见
  const bad = await attachPlannedWorkspace(h.ctx, plan, 'import-x')
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /^attach-failed: /)
  // 正确改写 cwd 后（同 plan.path）挂接成功
  const h2 = hostMock({ dirs: [cwd], sessionCwd: { 'import-x': cwd } })
  const plan2 = await planWorkspaceGroup(h2.ctx, { cwd }, 'D:\\src\\i.jsonl')
  const ok = await attachPlannedWorkspace(h2.ctx, plan2, 'import-x')
  assert.equal(ok.ok, true)
  assert.equal(ok.path, cwd)
  assert.deepEqual(h2.attachCalls, [{ ws: cwd, id: 'import-x' }])
})

test('attachPlannedWorkspace：无目标时原样回传 reason（未归组可解释）', async () => {
  const h = hostMock({ dirs: [] })
  const plan = await planWorkspaceGroup(h.ctx, { cwd: 'D:\\gone' }, 'D:\\src\\j.jsonl', { workspaceMode: 'per-project' })
  const res = await attachPlannedWorkspace(h.ctx, plan, 'import-y')
  assert.equal(res.ok, false)
  assert.match(res.reason, /^create-failed: /)
})
