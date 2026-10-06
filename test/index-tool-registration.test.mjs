// index-tool-registration.test.mjs — 工具注册面与发现入口
// apply 注册十二个工具、skills 注入、output.render 可用、scan_discover 目录探测。
// 由 test/index.test.mjs 按横幅分组拆出（纯移动：用例与断言未改）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { makeCtx, toolDef } from './_support/fake-host.mjs'
import { clearScanCache } from '../lib/discovery.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
})

test('apply 注册十二个工具（import_chat 分发器 + import_agents + doctor + import_mcp + import_settings + scan_discover + export_chat 三合一 + REQ-33 识别/撤回 + REQ-56 bundle 导出/还原 + verify_session）', () => {
  const { ctx, registered } = makeCtx({})
  apply(ctx)
  assert.equal(registered.length, 12)
  const names = registered.map((d) => d.name).sort()
  assert.deepEqual(names, ['doctor', 'export_bundle', 'export_chat', 'import_agents', 'import_chat', 'import_mcp', 'import_settings', 'list_imported_sessions', 'restore_bundle', 'retract_import', 'scan_discover', 'verify_session'])
  for (const def of registered) {
    if (['doctor', 'import_mcp', 'import_settings', 'export_bundle', 'restore_bundle', 'scan_discover', 'list_imported_sessions', 'retract_import', 'verify_session'].includes(def.name)) {
      // doctor / MCP / settings / bundle / 发现 / 识别 / 撤回 / 校验工具：单对象输出 schema（非 oneOf）
      assert.equal(def.output.schema.type, 'object')
      assert.ok(!Array.isArray(def.output.schema.oneOf))
    } else if (def.name === 'export_chat') {
      // export_chat 三合一：单对象输出 schema（三态合并，非 oneOf）
      assert.equal(def.output.schema.type, 'object')
      assert.ok(!Array.isArray(def.output.schema.oneOf))
    } else if (def.name === 'import_agents') {
      // REQ-59：单对象输出 schema（非导入状态机，独立注册）
      assert.equal(def.output.schema.type, 'object')
      assert.ok(!Array.isArray(def.output.schema.oneOf))
    } else {
      // import_chat：输出 schema 是 oneOf（单文件 / 批量 + REQ-17 dry-run 预览两个变体）
      assert.equal(def.name, 'import_chat')
      assert.ok(Array.isArray(def.output.schema.oneOf))
      assert.equal(def.output.schema.oneOf.length, 4)
    }
  }
})

test('apply 把转换指南注册为运行时 skill（skills 服务在场时）', () => {
  const skills = []
  const { ctx } = makeCtx({}, { services: { skills: { register(def) { skills.push(def); return () => {} } } } })
  apply(ctx)
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, 'dsh-chat-import-convert')
  assert.ok(skills[0].content.includes('"interchange": "dsh-chat-import"'))
  // 缺席口径由其余所有用例覆盖：makeCtx({}) 无 skills 服务，apply 照常完成
})

test('issue #20：doctor/import_agents/import_mcp/import_settings 的 output.render 可用', () => {
  const { ctx } = makeCtx({})
  apply(ctx)
  const doctor = toolDef(ctx, 'doctor')
  assert.match(
    doctor.output.render({}, { ok: true, checks: [{ name: 'registry', ok: true, detail: '1 条' }], issues: [], totals: { records: 1, sessions: 0, missingSessions: 0, skills: 0 } }).map((b) => b.text).join('\n'),
    /doctor: ok=true/,
  )
  const agents = toolDef(ctx, 'import_agents')
  assert.match(
    agents.output.render({ apply: false }, { total: 2, planned: 2, applied: 0, skipped: 0, results: [] }).map((b) => b.text).join('\n'),
    /预览（dry-run，未落盘）/,
  )
  const mcp = toolDef(ctx, 'import_mcp')
  assert.match(
    mcp.output.render({}, { total: 0, servers: [], planText: '# No MCP servers found\n', writtenTo: null }).map((b) => b.text).join('\n'),
    /MCP 镜像计划/,
  )
  const settings = toolDef(ctx, 'import_settings')
  assert.match(
    settings.output.render({}, { total: 0, suggestions: [], sources: [] }).map((b) => b.text).join('\n'),
    /配置建议：0 条/,
  )
})

// scan_discover 的共用夹具：一次目录探测（两个会话，一个带注入首行、一个无 cwd），
// 返回工具定义与首次扫描结果，供下面各条契约各自断言（此前它们挤在同一个用例里）。
function scanClaudeFixture() {
  const root = 'D:\\demo\\claude\\projects'
  const tree = {
    [root]: 'dir',
    [root + '\\proj-a']: 'dir',
    [root + '\\proj-a\\sess-aaa.jsonl']: [
      '{"sessionId":"sess-aaa","type":"user","cwd":"D:\\\\demo\\\\claude-proj","message":{"role":"user","content":"帮我重构这个模块"}}',
      '{"sessionId":"sess-aaa","type":"assistant","message":{"role":"assistant","content":"好"}}',
    ].join('\n'),
    [root + '\\proj-a\\sess-aaa']: 'dir', // 主 transcript 的伴生目录（非 .jsonl，不扫）
    [root + '\\proj-a\\sess-aaa\\subagents']: 'dir',
    [root + '\\proj-a\\sess-aaa\\subagents\\agent-123.jsonl']: '{"sessionId":"sess-aaa"}',
    [root + '\\proj-a\\sess-bbb.jsonl']: [
      '{"sessionId":"sess-bbb","type":"user","message":{"role":"user","content":"<system-reminder>系统注入，不是提问</system-reminder>"}}',
      '{"sessionId":"sess-bbb","type":"user","message":{"role":"user","content":"真实问题"}}',
    ].join('\n'),
  }
  const host = makeCtx(tree)
  apply(host.ctx)
  return { root, def: toolDef(host.ctx, 'scan_discover'), ...host }
}

test('scan_discover：目录探测 claude，条目字段与 schema', async () => {
  const { root, def } = scanClaudeFixture()
  const first = await def.execute({ path: root })
  assert.equal(first.total, 2)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, first), [])

  const aaa = first.sessions.find((s) => s.sessionId === 'sess-aaa')
  assert.ok(aaa)
  assert.equal(aaa.format, 'claude')
  assert.equal(aaa.title, '帮我重构这个模块')
  assert.equal(aaa.project, 'claude-proj') // 记录内 cwd basename（REQ-40 项目名提取）
  assert.equal(aaa.importStatus, 'not-imported') // registry 为空
  assert.equal(aaa.sourcePath, root + '\\proj-a\\sess-aaa.jsonl')
  // 面板不再展示消息条数 → 发现条目不带 messageCount（schema 同步剔除）
  assert.ok(!('messageCount' in aaa))
})

test('scan_discover：注入首行被过滤、无 cwd 记录回退布局 slug', async () => {
  const { root, def } = scanClaudeFixture()
  const first = await def.execute({ path: root })
  const bbb = first.sessions.find((s) => s.sessionId === 'sess-bbb')
  assert.equal(bbb.title, '真实问题') // 注入首行被过滤（REQ-40 标题提取）
  assert.equal(bbb.project, 'proj-a') // 无 cwd 记录 → 布局 slug 回退
})

test('scan_discover：零副作用（不写库、不落盘）', async () => {
  const { root, def, persistence, writes } = scanClaudeFixture()
  await def.execute({ path: root })
  assert.equal(persistence.sessions.size, 0)
  assert.equal(writes.length, 0)
})

test('scan_discover：TTL 缓存命中不重读、query 过滤忽略大小写', async () => {
  const { root, def, reads } = scanClaudeFixture()
  const first = await def.execute({ path: root })
  assert.equal(first.total, 2)
  const readsAfterFirst = reads.count
  assert.ok(readsAfterFirst > 0)

  const second = await def.execute({ path: root })
  assert.equal(second.total, 2)
  assert.equal(reads.count, readsAfterFirst)

  const q = await def.execute({ path: root, query: '重构' })
  assert.equal(q.total, 1)
  assert.equal(q.sessions[0].sessionId, 'sess-aaa')
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, q), [])
})
