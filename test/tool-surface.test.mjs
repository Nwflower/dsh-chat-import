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
import { CHAT_FORMAT_NAMES } from '../lib/toolkit.mjs'
import { FORMATS } from '../lib/discovery.mjs'
import { REIMPORT_REASONS } from '../lib/tools/schema.mjs'

const DTS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'index.d.ts'), 'utf8')

function registeredTools() {
  const defs = []
  registerTools({ tools: { register(def) { defs.push(def); return () => {} } }, get() { return undefined } }, '.tool-surface-test')
  return new Map(defs.map((d) => [d.name, d]))
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
