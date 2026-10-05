// test/tool-surface.test.mjs — 工具面的对外描述与实现一致（模型可见的 description 不能说谎）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerTools } from '../lib/tools.mjs'

function registeredTools() {
  const defs = []
  registerTools({ tools: { register(def) { defs.push(def); return () => {} } }, get() { return undefined } }, '.tool-surface-test')
  return new Map(defs.map((d) => [d.name, d]))
}

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
