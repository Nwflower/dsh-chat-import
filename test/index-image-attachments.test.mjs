// index-image-attachments.test.mjs — 图片落地与降级
// 附件落地 / 占位降级 / V3 落点降级 / storeImages 开关 / 两处计数同口径相加。
// 由 test/index.test.mjs 按横幅分组拆出（纯移动：用例与断言未改）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.mjs'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { makeCtx, chatDef } from './_support/fake-host.mjs'
import { clearScanCache } from '../lib/discovery.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
  clearScanCache()
})

test('导入结果透出保真计数：metaMessages / images（附件落地）/ droppedToolResultBlocks 合规且渲染可见', async () => {
  const sid = 'sess-counters-001'
  const b64 = 'iVBORw0KGgoAAAANSUhEUg=='
  const recs = [
    { sessionId: sid, type: 'user', message: { role: 'user', content: '跑命令' } },
    { sessionId: sid, type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_str', name: 'Bash', input: {} }] } },
    // 字符串 content 的 tool_result（真实占比 88.7%）：正文必须进日志
    { sessionId: sid, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_str', content: 'stdout 正文' }] } },
    { sessionId: sid, type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: '宿主回执' }] } },
    { sessionId: sid, type: 'assistant', message: { id: 'msg_2', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_img', name: 'Shot', input: {} }] } },
    // 图片块 → 经 ctx.attachments 落成附件，日志里只有引用（base64 不进日志）
    { sessionId: sid, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_img', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } }] }] } },
    { sessionId: sid, type: 'assistant', message: { id: 'msg_3', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_ref', name: 'X', input: {} }] } },
    // 未知块类型 → 计数上报（不静默）
    { sessionId: sid, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ref', content: [{ type: 'tool_reference', tool_name: 'y' }] }] } },
  ].map((r) => JSON.stringify(r)).join('\n')
  const target = 'D:\\demo\\proj\\' + sid + '.jsonl'
  const saved = []
  const { ctx, persistence } = makeCtx({ [target]: recs }, {
    services: {
      attachments: {
        async saveImage(input) {
          saved.push(input)
          return { attachmentId: 'sha256:test-image', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 }
        },
      },
    },
  })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const value = await def.execute({ path: target })

  assert.equal(value.status, 'imported')
  assert.equal(value.metaMessages, 1)
  assert.equal(value.images, 1)
  assert.equal(value.imagesDegraded, undefined, '有附件服务：没有降级')
  assert.equal(value.droppedToolResultBlocks, 1)
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, value), [])

  // 图片字节交给了宿主附件服务，且日志里只有引用
  assert.equal(saved.length, 1)
  assert.equal(saved[0].mediaType, 'image/png')
  assert.deepEqual([...saved[0].data], [...Buffer.from(b64, 'base64')])
  const flat = JSON.stringify(persistence.sessions.get('import-' + sid).events)
  assert.ok(flat.includes('stdout 正文'), '字符串 tool_result 正文必须落盘')
  assert.ok(flat.includes('sha256:test-image'), '图片以附件引用落盘')
  assert.ok(!flat.includes('iVBORw0KGgo'), 'base64 永不进日志')

  // 渲染正文可见（不只在返回值里）
  const text = def.output.render({ path: target }, value).map((b) => b.text).join('\n')
  assert.ok(text.includes('isMeta 记录 1 条'))
  assert.ok(text.includes('图片落成附件 1 张'))
  assert.ok(text.includes('无法映射的结果块 1 个'))
})

test('图片降级：宿主无 attachments 服务时以 [image] 占位落盘并计入 imagesDegraded', async () => {
  const sid = 'sess-img-degrade'
  const recs = [
    { sessionId: sid, type: 'user', message: { role: 'user', content: '看截图' } },
    { sessionId: sid, type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_img', name: 'Shot', input: {} }] } },
    { sessionId: sid, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_img', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' } }] }] } },
  ].map((r) => JSON.stringify(r)).join('\n')
  const target = 'D:\\demo\\proj\\' + sid + '.jsonl'
  const { ctx, persistence } = makeCtx({ [target]: recs })
  apply(ctx)
  const value = await chatDef(ctx, 'claude').execute({ path: target })

  assert.equal(value.status, 'imported')
  assert.equal(value.images, undefined, '没有服务：一张也没落成附件')
  assert.equal(value.imagesDegraded, 1)
  const flat = JSON.stringify(persistence.sessions.get('import-' + sid).events)
  assert.ok(flat.includes('[image]'), '降级为占位文本')
  assert.ok(!flat.includes('iVBORw0KGgo'), 'base64 永不进日志')
})

test('图片落地：显式 V3 落点不支持附件引用 → 降级为占位并计数（不写读不出的日志）', async () => {
  const sid = 'sess-img-v3'
  const recs = [
    { sessionId: sid, type: 'user', message: { role: 'user', content: '看截图' } },
    { sessionId: sid, type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_img', name: 'Shot', input: {} }] } },
    { sessionId: sid, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_img', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' } }] }] } },
  ].map((r) => JSON.stringify(r)).join('\n')
  const target = 'D:\\demo\\proj\\' + sid + '.jsonl'
  let saves = 0
  const { ctx, persistence } = makeCtx({ [target]: recs }, {
    services: { attachments: { async saveImage() { saves++; return { attachmentId: 'sha256:x', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } } } },
  })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const { withHostFormatVersion } = await import('../lib/import-core.mjs')
  const value = await withHostFormatVersion(ctx, 3, () => def.execute({ path: target }))

  assert.equal(value.status, 'imported')
  assert.equal(value.images, undefined, 'V3 落点不落附件')
  assert.equal(value.imagesDegraded, 1)
  assert.equal(saves, 0, '未调用附件服务')
  const saved = persistence.sessions.get('import-' + sid)
  assert.equal(saved.meta.version, 3, '落成 V3 generation')
  const flat = JSON.stringify(saved.events)
  assert.ok(flat.includes('[image]'), '降级为占位文本')
  assert.ok(!flat.includes('iVBORw0KGgo'), 'base64 永不进日志')
})

test('图片落地：续写到 V3 旧会话时同样降级（跟目标会话自己的代次）', async () => {
  const sid = 'sess-img-v3-append'
  const recs = [
    { sessionId: sid, type: 'user', message: { role: 'user', content: '第一问' } },
    { sessionId: sid, type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: '答' }] } },
  ].map((r) => JSON.stringify(r)).join('\n')
  const target = 'D:\\demo\\proj\\' + sid + '.jsonl'
  const tree = { [target]: recs }
  let saves = 0
  const { ctx, persistence } = makeCtx(tree, {
    services: { attachments: { async saveImage() { saves++; return { attachmentId: 'sha256:y', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } } } },
  })
  apply(ctx)
  const def = chatDef(ctx, 'claude')
  const { withHostFormatVersion } = await import('../lib/import-core.mjs')
  // 先按 V3 建会话
  await withHostFormatVersion(ctx, 3, () => def.execute({ path: target }))
  assert.equal(persistence.sessions.get('import-' + sid).meta.version, 3)

  // 源增长（新增一轮带图）后重导 → 走 append 路径，且目标会话本身是 V3
  tree[target] = recs + '\n' + [
    { sessionId: sid, type: 'user', message: { role: 'user', content: '再看一张' } },
    { sessionId: sid, type: 'assistant', message: { id: 'msg_2', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_img2', name: 'Shot', input: {} }] } },
    { sessionId: sid, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_img2', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' } }] }] } },
  ].map((r) => JSON.stringify(r)).join('\n')

  const value = await def.execute({ path: target })
  assert.equal(value.status, 'appended')
  assert.equal(value.images, undefined, 'V3 目标会话不落附件')
  assert.equal(value.imagesDegraded, 1)
  assert.equal(saves, 0)
  const flat = JSON.stringify(persistence.sessions.get('import-' + sid).events)
  assert.ok(flat.includes('[image]'))
  assert.ok(!flat.includes('iVBORw0KGgo'), 'base64 永不进日志')
})

test('图片落地可关：storeImages=false 时不写附件，图片只留占位并计数', async () => {
  const sid = 'sess-img-off'
  const recs = [
    { sessionId: sid, type: 'user', message: { role: 'user', content: '看截图' } },
    { sessionId: sid, type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_img', name: 'Shot', input: {} }] } },
    { sessionId: sid, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_img', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' } }] }] } },
  ].map((r) => JSON.stringify(r)).join('\n')
  const target = 'D:\\demo\\proj\\' + sid + '.jsonl'
  let saves = 0
  const { ctx, persistence } = makeCtx({ [target]: recs }, {
    services: { attachments: { async saveImage() { saves++; return { attachmentId: 'sha256:x', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } } } },
  })
  apply(ctx)
  const value = await chatDef(ctx, 'claude').execute({ path: target, storeImages: false })

  assert.equal(value.status, 'imported')
  assert.equal(value.images, undefined, '关掉后一张也不落')
  assert.equal(value.imagesDegraded, 1)
  assert.equal(saves, 0, '未调用附件服务')
  const flat = JSON.stringify(persistence.sessions.get('import-' + sid).events)
  assert.ok(flat.includes('[image]'))
  assert.ok(!flat.includes('iVBORw0KGgo'), 'base64 永不进日志')
})

test('imagesDegraded：宿主层降级与转换层降级同口径相加（不覆盖、不重复计）', async () => {
  const sid = 'sess-img-mixed'
  const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' } }
  const recs = [
    { sessionId: sid, type: 'user', message: { role: 'user', content: '看三张图' } },
    { sessionId: sid, type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Shot', input: {} }] } },
    // 两张有字节（storeImages=false → 宿主层降级 2）+ 一张远程 URL（转换层拿不到字节 → 降级 1）
    { sessionId: sid, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: [png, png, { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }] }] } },
  ].map((r) => JSON.stringify(r)).join('\n')
  const target = 'D:\\demo\\proj\\' + sid + '.jsonl'
  const { ctx } = makeCtx({ [target]: recs })
  apply(ctx)
  const value = await chatDef(ctx, 'claude').execute({ path: target, storeImages: false })
  assert.equal(value.status, 'imported')
  assert.equal(value.imagesDegraded, 3)
})

test('图片已是附件引用（DSH 源回灌）：原样保留，不重复存、不降级', async () => {
  const sid = 'sess-img-ref'
  const ref = { attachmentId: 'sha256:existing', mediaType: 'image/png', bytes: 68, width: 1, height: 1, name: 'a.png' }
  const recs = [
    { sessionId: sid, type: 'user', message: { role: 'user', content: '看图' } },
    { sessionId: sid, type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'image', attachment: ref }] } },
  ].map((r) => JSON.stringify(r)).join('\n')
  const target = 'D:\\demo\\proj\\' + sid + '.jsonl'
  let saves = 0
  const { ctx, persistence } = makeCtx({ [target]: recs }, {
    services: { attachments: { async saveImage() { saves++; return ref } } },
  })
  apply(ctx)
  const value = await chatDef(ctx, 'claude').execute({ path: target })

  assert.equal(value.images, 1)
  assert.equal(value.imagesDegraded, undefined)
  assert.equal(saves, 0, '已有引用不再经 saveImage')
  const flat = JSON.stringify(persistence.sessions.get('import-' + sid).events)
  assert.ok(flat.includes('sha256:existing'))
})
