// index-export.test.mjs — 反向导出与 bundle
// export_chat(claude) 序列化、export_bundle / restore_bundle 双层指纹、矩阵化互转 + verify_session。
// 由 test/index.test.mjs 按横幅分组拆出（纯移动：用例与断言未改）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { apply, exportClaudeSession } from '../lib/index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { slugifyClaudeCwd } from '../lib/cwd-map.mjs'
import { hostAbs } from './_support/host-path.mjs'
import { makeCtx, toolDef, chatDef, exportDef } from './_support/fake-host.mjs'
import { clearScanCache } from '../lib/discovery.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'
import { loadHostFixture as load } from './_support/fixtures.mjs'

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
})

async function seedSession(persistence, id, meta, events) {
  await persistence.create(meta)
  await persistence.append(id, events)
}

// 合成 DSH 事件（形状对齐真实日志：surface 事件带 surfaceOp:'append'）。

function mkEvent(type, seq, time, data, extra = {}) {
  return { type, seq, time, data, ...extra }
}

const OUT = join('C:', 'Users', 'test', '.claude', 'projects') // 跨平台 join，避免分隔符断言

test('export_claude 落盘：import → export 闭环、路径 <outputDir>/<slug>/<uuid>.jsonl、schema 校验', async () => {
  const tree = { 'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl') }
  const { ctx, persistence, writes } = makeCtx(tree)
  apply(ctx)
  await chatDef(ctx, 'claude').execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })
  assert.equal(persistence.sessions.size, 1)

  const def = exportDef(ctx, 'claude')
  const value = await def.execute({ sessionId: 'import-sess-simple-001', outputDir: OUT })

  assert.equal(value.mode, 'single')
  assert.equal(value.sourceSessionId, 'import-sess-simple-001')
  const expectedSlug = slugifyClaudeCwd(hostAbs('D:/demo/proj')) // 分隔符与盘符按宿主平台归一到 '-'
  assert.equal(value.slug, expectedSlug)
  assert.equal(value.cwd, hostAbs('D:/demo/proj'))
  assert.match(value.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(value.recordCount, 5) // mode + permission-mode + user + custom-title + assistant（环境变更声明被跳过）
  assert.equal(value.mapping.turns, 1)
  assert.equal(value.mapping.messages, 3) // 环境变更声明 + user + assistant（原样计数，导出时跳过）
  assert.equal(value.mapping.toolCalls, 0)
  assert.equal(value.mapping.toolResults, 0)
  assert.equal(value.dryRun, false)
  assert.equal(value.filePath, join(OUT, expectedSlug, value.sessionId + '.jsonl'))
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  // 落盘：createIfAbsent + 内容可解析、布局正确（每行一记录、恰一个结尾换行）
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, value.filePath)
  assert.equal(writes[0].options.kind, 'createIfAbsent')
  const body = writes[0].content.slice(0, -1)
  assert.equal(writes[0].content.endsWith('\n'), true)
  const lines = body.split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 5)
  assert.equal(lines[0].type, 'mode')
  const pm = lines[1]
  assert.deepEqual(Object.keys(pm).sort(), ['permissionMode', 'sessionId', 'type'])
  const user = lines[2]
  assert.equal(user.type, 'user')
  assert.equal(user.parentUuid, null)
  assert.equal(typeof user.message.content, 'string')
  assert.equal(user.cwd, hostAbs('D:/demo/proj'))
  const title = lines[3]
  assert.equal(title.type, 'custom-title')
  const asst = lines[4]
  assert.equal(asst.type, 'assistant')
  assert.equal(asst.parentUuid, user.uuid)
  assert.equal(asst.message.stop_reason, 'end_turn')
})

test('export_claude 带标题会话：custom-title 放首个 user 后、assistant 前；返回 title', async () => {
  const tree = { 'D:\\demo\\proj\\sess-title-001.jsonl': load('sess-title-001.jsonl') }
  const { ctx, writes } = makeCtx(tree)
  apply(ctx)
  await chatDef(ctx, 'claude').execute({ path: 'D:\\demo\\proj\\sess-title-001.jsonl' })

  const def = exportDef(ctx, 'claude')
  const value = await def.execute({ sessionId: 'import-sess-title-001', outputDir: OUT })
  assert.equal(value.recordCount, 5) // mode + permission-mode + user + custom-title + assistant
  assert.equal(typeof value.title, 'string')
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const lines = writes[0].content.slice(0, -1).split('\n').map((l) => JSON.parse(l))
  const user = lines[2]
  const title = lines[3]
  assert.equal(title.type, 'custom-title')
  assert.equal(title.customTitle, value.title)
  assert.equal(Object.hasOwn(title, 'uuid'), false)
  assert.equal(Object.hasOwn(title, 'parentUuid'), false)
  assert.equal(lines[4].parentUuid, user.uuid) // assistant 链越过 custom-title
})

test('export_claude 工具会话：tool_use/tool_result 配对、sourceToolAssistantUUID、stop_reason', async () => {
  const tree = { 'D:\\demo\\proj\\sess-tool-001.jsonl': load('sess-tool-001.jsonl') }
  const { ctx, writes } = makeCtx(tree)
  apply(ctx)
  await chatDef(ctx, 'claude').execute({ path: 'D:\\demo\\proj\\sess-tool-001.jsonl' })

  const def = exportDef(ctx, 'claude')
  const value = await def.execute({ sessionId: 'import-sess-tool-001', outputDir: OUT })
  assert.equal(value.recordCount, 7) // mode + permission-mode + user + custom-title + assistant + tool_result + assistant
  assert.equal(value.mapping.toolCalls, 1)
  assert.equal(value.mapping.toolResults, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const lines = writes[0].content.slice(0, -1).split('\n').map((l) => JSON.parse(l))
  const asst1 = lines[4]
  const thinking = asst1.message.content.find((b) => b.type === 'thinking')
  assert.deepEqual(thinking, { type: 'thinking', thinking: thinking.thinking, signature: '' })
  const toolUse = asst1.message.content.find((b) => b.type === 'tool_use')
  assert.ok(toolUse)
  assert.equal(toolUse.name, 'Bash')
  assert.deepEqual(toolUse.input, { command: 'ls -la' })
  assert.equal(asst1.message.stop_reason, 'tool_use')

  const tr = lines[5]
  assert.equal(tr.type, 'user')
  assert.equal(tr.parentUuid, asst1.uuid)
  assert.equal(tr.sourceToolAssistantUUID, asst1.uuid)
  assert.equal(tr.message.content[0].type, 'tool_result')
  assert.equal(tr.message.content[0].tool_use_id, 'toolu_01')
  assert.equal(tr.message.content[0].content, 'README.md\nsrc\n')
  assert.equal(Object.hasOwn(tr.message.content[0], 'is_error'), false) // fixture is_error:false → 不写
  assert.equal(lines[6].message.stop_reason, 'end_turn')
})

test('export_claude dryRun：不写盘、返回目标路径与统计', async () => {
  const tree = { 'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl') }
  const { ctx, writes } = makeCtx(tree)
  apply(ctx)
  await chatDef(ctx, 'claude').execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })

  const def = exportDef(ctx, 'claude')
  const value = await def.execute({ sessionId: 'import-sess-simple-001', outputDir: OUT, dryRun: true })
  assert.equal(value.dryRun, true)
  assert.equal(writes.length, 0) // 不写盘
  assert.equal(typeof value.filePath, 'string')
  assert.equal(value.recordCount, 5)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
})

test('export_claude cwd 覆盖：slug/记录 cwd 用入参而非 header', async () => {
  const tree = { 'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl') }
  const { ctx, writes } = makeCtx(tree)
  apply(ctx)
  await chatDef(ctx, 'claude').execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })

  const value = await exportDef(ctx, 'claude').execute({
    sessionId: 'import-sess-simple-001',
    outputDir: OUT,
    cwd: "C:\\Users\\Meier's\\work", // 含非字母数字：验证 slug 替换
  })
  assert.equal(value.cwd, "C:\\Users\\Meier's\\work")
  assert.equal(value.slug, 'C--Users-Meier-s-work')
  assert.equal(value.filePath, join(OUT, 'C--Users-Meier-s-work', value.sessionId + '.jsonl'))
  const lines = writes[0].content.slice(0, -1).split('\n').map((l) => JSON.parse(l))
  assert.equal(lines[2].cwd, "C:\\Users\\Meier's\\work")
})

test('export_claude 会话不存在：抛错', async () => {
  const { ctx } = makeCtx({})
  apply(ctx)
  const def = exportDef(ctx, 'claude')
  await assert.rejects(() => def.execute({ sessionId: 'no-such-session' }), /会话不存在/)
})

test('export_claude 无 cwd（header 无且未提供）：抛错', async () => {
  const { ctx, persistence } = makeCtx({})
  await seedSession(persistence, 'sess-nocwd', { version: 0, id: 'sess-nocwd', createdAt: 1786000000000 }, [
    mkEvent('user/message', 0, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    mkEvent('assistant/message', 1, 1786000000000, { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'hello' }], source: { kind: 'model', provider: 'dsh' } }, { surfaceOp: 'append' }),
  ])
  apply(ctx)
  const def = exportDef(ctx, 'claude')
  await assert.rejects(() => def.execute({ sessionId: 'sess-nocwd' }), /cwd/)
})

test('export_claude createIfAbsent：目标已存在（uuid 碰撞模拟）时不覆盖', async () => {
  const tree = { 'D:\\demo\\proj\\sess-simple-001.jsonl': load('sess-simple-001.jsonl') }
  const { ctx } = makeCtx(tree)
  apply(ctx)
  await chatDef(ctx, 'claude').execute({ path: 'D:\\demo\\proj\\sess-simple-001.jsonl' })

  const fixed = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const target = join(OUT, slugifyClaudeCwd(hostAbs('D:/demo/proj')), fixed + '.jsonl')
  tree[target] = 'preexisting' // 目标文件已存在
  await assert.rejects(
    () => exportClaudeSession(ctx, { sessionId: 'import-sess-simple-001', outputDir: OUT }, { uuid: () => fixed }),
    /EEXIST/,
  )
  assert.equal(tree[target], 'preexisting') // 未被覆盖
})

test('export_claude 注入会话：非人类 user/message 跳过并计数', async () => {
  const { ctx, persistence, writes } = makeCtx({})
  await seedSession(persistence, 'sess-inject', { version: 0, id: 'sess-inject', createdAt: 1786000000000, cwd: hostAbs('D:/demo/proj') }, [
    mkEvent('user/message', 0, 1786000000000, { id: 'i1', role: 'user', content: [{ type: 'text', text: '系统注入' }], source: { kind: 'system' } }, { surfaceOp: 'append' }),
    mkEvent('user/message', 1, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: '真实提问' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    mkEvent('assistant/message', 2, 1786000000000, { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '回答' }], source: { kind: 'model', provider: 'dsh' } }, { surfaceOp: 'append' }),
  ])
  apply(ctx)
  const def = exportDef(ctx, 'claude')
  const value = await def.execute({ sessionId: 'sess-inject', outputDir: OUT })
  assert.equal(value.mapping.skippedInjections, 1)
  assert.equal(value.recordCount, 4) // 注入不落记录
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  const lines = writes[0].content.slice(0, -1).split('\n').map((l) => JSON.parse(l))
  assert.equal(lines[2].message.content, '真实提问')
  assert.equal(lines[2].parentUuid, null) // 首个真实 user 成为链头
})

test('REQ-21 export_claude：会话内的图片块读回字节写进 JSONL（不再一律跳过）', async () => {
  const { ctx, persistence, writes } = makeCtx({})
  await seedSession(persistence, 'sess-degrade', { version: 0, id: 'sess-degrade', createdAt: 1786000000000, cwd: hostAbs('D:/demo/proj') }, [
    mkEvent('user/message', 0, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: '看图' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    mkEvent('assistant/message', 1, 1786000000000, { id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: '这是图' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] }, source: { kind: 'model', provider: 'dsh' } }, { surfaceOp: 'append' }),
  ])
  apply(ctx)
  const def = exportDef(ctx, 'claude')
  const value = await def.execute({ sessionId: 'sess-degrade', outputDir: OUT })
  // 无降级：图片块被如实导出（v0 会话里的内联 base64 图片块 → Claude 的 image 载荷）
  assert.equal(value.degradations, undefined)
  assert.equal(value.mapping.images, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  const line = writes[0].content.slice(0, -1).split('\n').map((l) => JSON.parse(l))[3]
  assert.deepEqual(line.message.content, [
    { type: 'text', text: '这是图' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
  ])
})

test('REQ-21 export_claude 降级报告：拿不到字节的图片块 + 注入跳过逐条列出（不静默）', async () => {
  const { ctx, persistence, writes } = makeCtx({})
  await seedSession(persistence, 'sess-img-degrade', { version: 0, id: 'sess-img-degrade', createdAt: 1786000000000, cwd: hostAbs('D:/demo/proj') }, [
    mkEvent('user/message', 0, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: '看图' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    mkEvent('assistant/message', 1, 1786000000000, { id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: '这是图' }, { type: 'image', attachment: { attachmentId: 'sha256:gone', mediaType: 'image/png', bytes: 5, width: 1, height: 1 } }] }, source: { kind: 'model', provider: 'dsh' } }, { surfaceOp: 'append' }),
    mkEvent('user/message', 2, 1786000000000, { id: 'env1', role: 'user', content: [{ type: 'text', text: '注入' }], source: { kind: 'plugin', plugin: 'chat-import' } }, { surfaceOp: 'append' }),
  ])
  apply(ctx)
  const def = exportDef(ctx, 'claude')
  const value = await def.execute({ sessionId: 'sess-img-degrade', outputDir: OUT })
  // 无 attachments 服务 → 读不回字节：图片按 [image] 占位导出并计入附件跳过
  assert.equal(value.mapping.unavailableImages, 1)
  assert.deepEqual(value.degradations, [
    { id: 'attachment-skipped', kind: 'attachmentSkipped', strategy: 'skip-placeholder', count: 1 },
    { id: 'injection-skipped', kind: 'injectionSkipped', strategy: 'skip-placeholder', count: 1 },
  ])
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])
  const line = writes[0].content.slice(0, -1).split('\n').map((l) => JSON.parse(l))[3]
  assert.deepEqual(line.message.content, [{ type: 'text', text: '这是图' }, { type: 'text', text: '[image]' }])
})

test('export_claude 中断会话：末尾补发空 tool_result，会话日志只读不被触碰', async () => {
  const { ctx, persistence, writes } = makeCtx({})
  const events = [
    mkEvent('user/message', 0, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: '提问' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    mkEvent('assistant/message', 1, 1786000000000, { turn: 1, step: 1, id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 'callZ', name: 'Bash', arguments: '{}' }], source: { kind: 'model', provider: 'dsh' } }, { surfaceOp: 'append' }),
    mkEvent('tool/call', 2, 1786000000000, { turn: 1, step: 1, callId: 'callZ', name: 'Bash', arguments: '{}' }),
  ]
  await seedSession(persistence, 'sess-interrupted', { version: 0, id: 'sess-interrupted', createdAt: 1786000000000, cwd: hostAbs('D:/demo/proj') }, events)
  apply(ctx)
  const def = exportDef(ctx, 'claude')
  const value = await def.execute({ sessionId: 'sess-interrupted', outputDir: OUT })
  assert.equal(value.recordCount, 5) // 末尾补发 1 条
  assert.equal(value.mapping.toolResults, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  const lines = writes[0].content.slice(0, -1).split('\n').map((l) => JSON.parse(l))
  const last = lines[4]
  assert.equal(last.message.content[0].type, 'tool_result')
  assert.deepEqual(last.message.content[0].content, [])
  assert.equal(last.parentUuid, lines[3].uuid)
  // 会话日志未被触碰（只读来源）
  const saved = persistence.sessions.get('sess-interrupted')
  assert.equal(saved.events.length, events.length)
  assert.equal(saved.events.filter((e) => e.type === 'tool/result').length, 0)
})

test('REQ-56 bundle 闭环：export_bundle 落盘 → restore_bundle 还原 0 skipped、schema 校验、幂等', async () => {
  const { ctx, persistence, writes } = makeCtx({})
  await seedSession(persistence, 'sess-bundle-001', { version: 0, id: 'sess-bundle-001', createdAt: 1786000000000, cwd: hostAbs('D:/demo/proj') }, [
    mkEvent('turn/start', 0, 1786000000000, { turn: 1 }),
    mkEvent('user/message', 1, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    mkEvent('assistant/message', 2, 1786000000000, { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '你好！' }], source: { kind: 'model', provider: 'dsh' } } }, { surfaceOp: 'append' }),
    mkEvent('turn/end', 3, 1786000000000, { turn: 1, reason: { kind: 'completed' } }),
  ])
  apply(ctx)
  const exp = toolDef(ctx, 'export_bundle')
  const bundlePath = join('C:', 'Users', 'test', 'exports', 'sess-bundle-001.dshbundle.json')
  const value = await exp.execute({ sessionId: 'sess-bundle-001', path: bundlePath })
  assert.equal(value.mode, 'single')
  assert.equal(value.eventCount, 4)
  assert.match(value.sha256.session, /^[0-9a-f]{64}$/)
  assert.match(value.sha256.bundle, /^[0-9a-f]{64}$/)
  assert.deepEqual(validateJsonSchemaValue(exp.output.schema, value), [])
  assert.equal(writes[0].path, bundlePath)
  assert.equal(writes[0].options.kind, 'createIfAbsent')

  // 还原（bundle 在 mock 树里）；同机语义需要 originalCwd 在 fs 树中可达
  const tree2 = { [bundlePath]: writes[0].content, [hostAbs('D:/demo/proj')]: 'dir' }
  const { ctx: ctx2, persistence: p2 } = makeCtx(tree2)
  apply(ctx2)
  const rst = toolDef(ctx2, 'restore_bundle')
  const restored = await rst.execute({ path: bundlePath })
  assert.equal(restored.mode, 'single')
  assert.equal(restored.status, 'imported')
  assert.equal(restored.skipped, 0)
  assert.equal(restored.turns, 1)
  assert.equal(restored.messages, 2)
  assert.equal(restored.sourceSessionId, 'sess-bundle-001')
  assert.equal(restored.originalCwd, hostAbs('D:/demo/proj'))
  assert.equal(restored.cwdAvailable, true) // 同机：原 cwd 可达
  assert.deepEqual(validateJsonSchemaValue(rst.output.schema, restored), [])
  const saved = p2.sessions.get(restored.sessionId)
  assert.ok(saved)
  assert.equal(saved.events.at(-1).type, 'turn/end')
  const again = await rst.execute({ path: bundlePath })
  assert.equal(again.status, 'already-imported')
  assert.equal(p2.sessions.size, 1)
})

test('REQ-62 跨机器还原：originalCwd 不可达 → cwdAvailable:false + 回退归组 + restoreNote（不静默）', async () => {
  // A 机导出 bundle（cwd = A 机路径，B 机不存在——用确定不存在的目录名保证 stat 失败）
  const A_CWD = 'D:\\__machine_a_nonexistent_9f3k__\\work'
  const { ctx, writes } = makeCtx({})
  await seedSession(ctx.sessionPersistence, 'sess-machine-a', { version: 0, id: 'sess-machine-a', createdAt: 1786000000000, cwd: A_CWD }, [
    mkEvent('user/message', 0, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    mkEvent('assistant/message', 1, 1786000000000, { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model', provider: 'dsh' } } }, { surfaceOp: 'append' }),
  ])
  apply(ctx)
  const exp = toolDef(ctx, 'export_bundle')
  const bundlePath = join('C:', 'Users', 'b', 'incoming', 'sess-machine-a.dshbundle.json')
  await exp.execute({ sessionId: 'sess-machine-a', path: bundlePath })
  const bundleContent = writes[0].content

  // B 机：bundle 文件在（原 cwd D:\machine-a\work 不存在），还原
  const treeB = { [bundlePath]: bundleContent }
  // 模拟宿主 create 的目录校验：A 机路径在 B 机不存在 → 建不出工作区
  const { ctx: ctxB, persistence: pB, attached } = makeCtx(treeB, { rejectWorkspaceCreate: (p) => p === A_CWD })
  apply(ctxB)
  const rst = toolDef(ctxB, 'restore_bundle')
  const restored = await rst.execute({ path: bundlePath })
  assert.equal(restored.status, 'imported')
  assert.equal(restored.skipped, 0)
  assert.equal(restored.cwdAvailable, false)
  assert.equal(restored.originalCwd, A_CWD)
  assert.equal(restored.landingHint, 'work')
  // 原 cwd 建不出工作区 → 落点是专用导入工作区（改成 cwd 后挂接成功）。不再声称
  // 「回退归组到 bundle 目录」——那条路在宿主上必然被拒（docs/architecture.md D16）
  assert.equal(restored.groupedTo, join(process.env.DSH_HOME, 'dsh-chat-import-workspace'))
  assert.match(restored.restoreNote, /原 cwd 不可达/)
  assert.deepEqual(validateJsonSchemaValue(rst.output.schema, restored), [])
  assert.equal(attached.length, 1)
  assert.equal(attached[0].ws, restored.groupedTo)
  assert.ok(pB.sessions.has(restored.sessionId))
})

test('REQ-56 损坏检测：bundle 被篡改（log 改动）→ restore_bundle 大声失败不还原', async () => {
  const { ctx, writes } = makeCtx({})
  await seedSession(ctx.sessionPersistence, 'sess-tamper', { version: 0, id: 'sess-tamper', createdAt: 1786000000000, cwd: hostAbs('D:/demo/proj') }, [
    mkEvent('user/message', 0, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
  ])
  apply(ctx)
  await toolDef(ctx, 'export_bundle').execute({ sessionId: 'sess-tamper', path: 'C:\\tmp\\tamper.dshbundle.json' })
  const doc = JSON.parse(writes[0].content)
  doc.log = doc.log.replace('hi', '被篡改') // 不重算指纹
  const { ctx: ctx2, persistence: p2 } = makeCtx({ 'C:\\tmp\\tamper.dshbundle.json': JSON.stringify(doc) })
  apply(ctx2)
  const rst = toolDef(ctx2, 'restore_bundle')
  await assert.rejects(() => rst.execute({ path: 'C:\\tmp\\tamper.dshbundle.json' }), /bundle 校验失败/)
  assert.equal(p2.sessions.size, 0)
  // 预览分支同样报跳过原因（不抛错）
  const preview = await rst.execute({ path: 'C:\\tmp\\tamper.dshbundle.json', preview: true })
  assert.equal(preview.preview, true)
  assert.equal(preview.skipped, 1)
  assert.match(preview.skipReason, /bundle 校验失败/)
})

test('REQ-56 restore_bundle 目录模式：递归收集 .dshbundle.json 逐文件还原', async () => {
  const { ctx, writes } = makeCtx({})
  await seedSession(ctx.sessionPersistence, 'sess-dir-001', { version: 0, id: 'sess-dir-001', createdAt: 1786000000000, cwd: hostAbs('D:/demo/proj') }, [
    mkEvent('user/message', 0, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    mkEvent('assistant/message', 1, 1786000000000, { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model', provider: 'dsh' } } }, { surfaceOp: 'append' }),
  ])
  apply(ctx)
  const exp = toolDef(ctx, 'export_bundle')
  const dir = 'C:\\backups'
  await exp.execute({ sessionId: 'sess-dir-001', path: dir + '\\sess-dir-001.dshbundle.json' })
  await exp.execute({ sessionId: 'sess-dir-001', path: dir + '\\sub\\sess-dir-001-copy.dshbundle.json', cwd: hostAbs('D:/other') })

  const { ctx: ctx2, persistence: p2 } = makeCtx({
    [dir]: 'dir',
    [dir + '\\sess-dir-001.dshbundle.json']: writes[0].content,
    [dir + '\\sub']: 'dir',
    [dir + '\\sub\\sess-dir-001-copy.dshbundle.json']: writes[1].content,
    [dir + '\\notes.txt']: 'not a bundle',
  })
  apply(ctx2)
  const rst = toolDef(ctx2, 'restore_bundle')
  const value = await rst.execute({ path: dir })
  assert.equal(value.mode, 'batch')
  assert.equal(value.total, 2)
  assert.equal(value.imported, 2)
  assert.deepEqual(validateJsonSchemaValue(rst.output.schema, value), [])
  assert.equal(p2.sessions.size, 2)
})

test('REQ-23 export_codex / export_kimi：落盘 + 可再导入 + 降级报告 + schema', async () => {
  const { ctx, writes } = makeCtx({})
  await seedSession(ctx.sessionPersistence, 'sess-matrix-001', { version: 0, id: 'sess-matrix-001', createdAt: 1786000000000, cwd: hostAbs('D:/demo/proj') }, [
    mkEvent('turn/start', 0, 1786000000000, { turn: 1 }),
    mkEvent('user/message', 1, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: '跑测试' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    mkEvent('assistant/message', 2, 1786000000000, { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '好' }, { type: 'tool-call', id: 'c1', name: 'Bash', arguments: '{"command":"npm test"}' }], source: { kind: 'model', provider: 'dsh' } } }, { surfaceOp: 'append' }),
    mkEvent('tool/call', 3, 1786000000000, { turn: 1, step: 1, callId: 'c1', name: 'Bash', arguments: '{"command":"npm test"}' }),
    mkEvent('tool/result', 4, 1786000000000, { turn: 1, step: 1, message: { id: 't1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'all green' }] }], source: { kind: 'tool', callId: 'c1' } } }, { surfaceOp: 'append' }),
    mkEvent('turn/end', 5, 1786000000000, { turn: 1, reason: { kind: 'completed' } }),
  ])
  apply(ctx)
  const codexDef = exportDef(ctx, 'codex')
  const cwdPath = 'C:\\exports\\x.rollout.jsonl'
  const codexOut = await codexDef.execute({ sessionId: 'sess-matrix-001', path: cwdPath })
  assert.equal(codexOut.recordCount, 5) // session_meta + user + assistant + function_call + function_call_output
  assert.equal(codexOut.toolCalls, 1)
  assert.equal(codexOut.toolResults, 1)
  assert.deepEqual(validateJsonSchemaValue(codexDef.output.schema, codexOut), [])

  const kimiDef = exportDef(ctx, 'kimi')
  const kimiPath = 'C:\\exports\\y.wire.jsonl'
  const kimiOut = await kimiDef.execute({ sessionId: 'sess-matrix-001', path: kimiPath })
  assert.equal(kimiOut.recordCount, 7) // metadata + TurnBegin + StepBegin + TextPart + ToolCall + ToolResult + TurnEnd
  assert.equal(kimiOut.toolCalls, 1)
  assert.deepEqual(validateJsonSchemaValue(kimiDef.output.schema, kimiOut), [])

  // 双向闭环：导出文件再经对应 import_* 导入（新 ctx 模拟另一侧）
  const { ctx: ctx2, persistence: p2 } = makeCtx({ [cwdPath]: writes[0].content, [kimiPath]: writes[1].content })
  apply(ctx2)
  const impCodex = chatDef(ctx2, 'codex')
  const codexBack = await impCodex.execute({ path: cwdPath })
  assert.equal(codexBack.mode, 'single')
  assert.equal(codexBack.status, 'imported')
  assert.equal(codexBack.toolCalls, 1)
  const impKimi = chatDef(ctx2, 'kimi')
  const kimiBack = await impKimi.execute({ path: kimiPath })
  assert.equal(kimiBack.mode, 'single')
  assert.equal(kimiBack.status, 'imported')
  assert.equal(kimiBack.toolCalls, 1)
  assert.equal(p2.sessions.size, 2)
})

test('REQ-23 verify_session：平衡会话 ok、不平衡会话定位问题 + repair 提示（只读）', async () => {
  const { ctx, persistence } = makeCtx({})
  // 平衡会话
  await seedSession(persistence, 'sess-ok', { version: 0, id: 'sess-ok', createdAt: 1786000000000, cwd: hostAbs('D:/demo/proj') }, [
    mkEvent('turn/start', 0, 1786000000000, { turn: 1 }),
    mkEvent('user/message', 1, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    mkEvent('assistant/message', 2, 1786000000000, { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model', provider: 'dsh' } } }, { surfaceOp: 'append' }),
    mkEvent('turn/end', 3, 1786000000000, { turn: 1, reason: { kind: 'completed' } }),
  ])
  // 不平衡会话：turn 无 end + call 无 result + surface 缺 surfaceOp
  await seedSession(persistence, 'sess-broken', { version: 0, id: 'sess-broken', createdAt: 1786000000000, cwd: hostAbs('D:/demo/proj') }, [
    mkEvent('turn/start', 0, 1786000000000, { turn: 1 }),
    mkEvent('user/message', 1, 1786000000000, { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }), // 缺 surfaceOp
    mkEvent('assistant/message', 2, 1786000000000, { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model', provider: 'dsh' } } }, { surfaceOp: 'append' }),
    mkEvent('tool/call', 3, 1786000000000, { turn: 1, step: 1, callId: 'c1', name: 'Bash', arguments: '{}' }), // 无 result
  ])
  apply(ctx)
  const def = toolDef(ctx, 'verify_session')
  const ok = await def.execute({ sessionId: 'sess-ok' })
  assert.equal(ok.ok, true)
  assert.equal(ok.problems.length, 0)
  assert.equal(ok.turns, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, ok), [])

  const broken = await def.execute({ sessionId: 'sess-broken' })
  assert.equal(broken.ok, false)
  const kinds = broken.problems.map((p) => p.kind)
  assert.ok(kinds.includes('missing-surface-op'))
  assert.ok(kinds.includes('turn-unbalanced'))
  assert.ok(kinds.includes('call-without-result'))
  // repair 提示按 kind 给出
  const hints = broken.repairHints.map((h) => h.kind)
  assert.ok(hints.includes('call-without-result'))
  assert.ok(hints.includes('turn-unbalanced'))
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, broken), [])
  // 只读：会话未被改动
  assert.equal(persistence.sessions.get('sess-broken').events.length, 4)
})
