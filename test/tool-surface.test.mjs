// test/tool-surface.test.mjs — 工具面的对外描述与实现一致
//
// 两类漂移在这里拦住：模型可见的 description 说了实现不做的事；手写的 lib/index.d.ts
// 跟不上运行时清单（格式枚举、工具名、状态枚举）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerTools } from '../lib/tools.mjs'
import { CHAT_FORMAT_NAMES, IMPORT_SPECS } from '../lib/toolkit.mjs'
import { FORMATS } from '../lib/discovery.mjs'
import { BATCH_ITEM_FIELDS } from '../lib/import-batch.mjs'
import { REIMPORT_REASONS } from '../lib/tools/schema.mjs'
import { makeCtx } from './_support/fake-host.mjs'

const DTS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'index.d.ts'), 'utf8')

function registeredTools() {
  const { ctx, registered } = makeCtx()
  registerTools(ctx, '.tool-surface-test')
  return new Map(registered.map((d) => [d.name, d]))
}

// `export type X = | 'a' | 'b' …` 的字符串字面量成员（跳过成员间的文档注释）
function dtsUnion(name) {
  const m = DTS.match(new RegExp('export type ' + name + ' =([\\s\\S]*?)(?:\\n\\n|\\nexport )'))
  assert.ok(m, 'index.d.ts 缺少 type ' + name)
  return [...m[1].replace(/\/\*\*[\s\S]*?\*\//g, '').matchAll(/'([^']+)'/g)].map((x) => x[1])
}

const sorted = (list) => [...list].sort()

test('export_chat：description 不宣称写 imports registry（claude 导出的 mapping 只在返回值里）', () => {
  const def = registeredTools().get('export_chat')
  assert.ok(!/registry/i.test(def.description), def.description)
  assert.match(def.description, /mapping/)
})

test('export_chat：format 枚举与 description 点名的目标一致', () => {
  const def = registeredTools().get('export_chat')
  const formats = def.parameters.properties.format.enum
  assert.deepEqual(formats, ['claude', 'codex', 'kimi', 'opencode'])
  for (const f of formats) assert.ok(def.description.includes(f + ' = '), f)
})

test('index.d.ts：ChatFormat = import_chat 的 format 枚举（CHAT_FORMAT_NAMES）', () => {
  assert.deepEqual(sorted(dtsUnion('ChatFormat')), sorted(CHAT_FORMAT_NAMES))
  const def = registeredTools().get('import_chat')
  assert.deepEqual(sorted(def.parameters.properties.format.enum), sorted(CHAT_FORMAT_NAMES))
})

test('index.d.ts：ScanFormat = discovery 的 FORMATS', () => {
  assert.deepEqual(sorted(dtsUnion('ScanFormat')), sorted(FORMATS))
})

test('index.d.ts：ExportFormat / LocalJsonlFormat / ReimportReason 与运行时枚举一致', () => {
  const tools = registeredTools()
  assert.deepEqual(sorted(dtsUnion('ExportFormat')), sorted(tools.get('export_chat').parameters.properties.format.enum))
  assert.deepEqual(sorted(dtsUnion('LocalJsonlFormat')), sorted(tools.get('import_chat').parameters.properties.parseFormat.enum))
  assert.deepEqual(sorted(dtsUnion('ReimportReason')), sorted(REIMPORT_REASONS))
})

test('index.d.ts：ImportStatus 覆盖 import_chat 输出 schema 的全部状态', () => {
  const schema = registeredTools().get('import_chat').output.schema
  const statuses = new Set()
  for (const branch of schema.oneOf) {
    if (branch.properties.status?.enum) branch.properties.status.enum.forEach((s) => statuses.add(s))
    const item = branch.properties.results?.items
    if (item?.properties.status?.enum) item.properties.status.enum.forEach((s) => statuses.add(s))
  }
  const declared = new Set(dtsUnion('ImportStatus'))
  for (const s of statuses) assert.ok(declared.has(s), 'ImportStatus 缺 ' + s)
})

test('index.d.ts：ToolSurface 的方法 = 注册的工具名', () => {
  const m = DTS.match(/export interface ToolSurface \{([\s\S]*?)\n\}/)
  assert.ok(m)
  const methods = [...m[1].matchAll(/^\s+(\w+)\(/gm)].map((x) => x[1])
  assert.deepEqual(sorted(methods), sorted(registeredTools().keys()))
})

// ── 来源清单的三张表互相对账（docs/architecture.md D21）────────────────────────
// 发现层的来源描述符表、import_chat 的 format 表、面板/命令依赖的导入 spec 表此前各写一份，
// 彼此之间没有任何断言——漏登记只会在用户点导入时以「未知格式」暴露。这三条把「靠自觉」
// 变成门禁：新来源只要漏了任何一张表，这里就红。

test('来源清单：发现层 FORMATS ⊆ import_chat 的 format（差集恒为 local-jsonl）', () => {
  const missing = FORMATS.filter((f) => !CHAT_FORMAT_NAMES.includes(f))
  assert.deepEqual(missing, [], 'FORMATS 里有来源没进 CHAT_FORMAT_NAMES：' + missing.join(', '))
  // 反向差集是本插件唯一的「非来源格式」：local-jsonl 是文件导入的落点，不是可发现的来源
  assert.deepEqual(CHAT_FORMAT_NAMES.filter((f) => !FORMATS.includes(f)), ['local-jsonl'])
})

test('来源清单：每个 FORMATS 都在 IMPORT_SPECS 里（面板 / /import 命令依赖它）', () => {
  const tools = registeredTools() // 注册期填充 IMPORT_SPECS
  assert.ok(tools.has('import_chat'))
  const missing = FORMATS.filter((f) => !IMPORT_SPECS.has(f))
  assert.deepEqual(missing, [], 'FORMATS 里有来源没登记导入 spec：' + missing.join(', '))
  // spec 的 format 字段与键一致（面板按 format 取 spec）
  for (const f of FORMATS) assert.equal(IMPORT_SPECS.get(f).format, f)
})

test('来源清单：批量条目字段（BATCH_ITEM_FIELDS）都在 import_chat 的批量 schema 里', () => {
  const schema = registeredTools().get('import_chat').output.schema
  // 批量**落盘**分支（预览分支只有 previewEntry 的规模字段，组装不出导入报告）
  const batch = schema.oneOf.find((b) => b.properties.mode && b.properties.mode.enum.includes('batch') && !b.properties.preview)
  assert.ok(batch, 'import_chat 输出 schema 缺批量落盘分支')
  const itemProps = batch.properties.results.items.properties
  // 批量条目由 lib/import-batch.mjs 的 batchItem 从单文件结果挑字段装配；schema 里没声明的
  // 字段会被宿主的输出校验丢掉——单文件结果有、批量条目却静默没有，只在批量场景暴露。
  for (const field of BATCH_ITEM_FIELDS) {
    const key = field === 'skipReason' ? 'reason' : field // batchItem 的改名口径
    assert.ok(key in itemProps, '批量条目 schema 缺字段 ' + key + '（BATCH_ITEM_FIELDS 有，批量装配会丢）')
  }
  // 失败条目（failedItem）的三个字段同样要被接纳
  for (const key of ['path', 'status', 'error']) assert.ok(key in itemProps, '批量条目 schema 缺 ' + key)
})
