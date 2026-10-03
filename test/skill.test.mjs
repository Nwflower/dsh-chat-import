// test/skill.test.mjs — lib/skill.mjs 契约：转换指南注册为宿主运行时 skill
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildConvertSkill, registerConvertSkill, CONVERT_SKILL_NAME } from '../lib/skill.mjs'

test('buildConvertSkill：指南内容组装成运行时 skill 定义', () => {
  const def = buildConvertSkill('# Guide\n…')
  assert.equal(def.name, 'dsh-chat-import-convert')
  assert.equal(def.source, 'runtime')
  assert.equal(def.content, '# Guide\n…')
  // resourceBase 指到包内 docs/：指南里的相对链接（INTERCHANGE.md、中文版）按目录解析
  assert.equal(def.resourceBase.kind, 'directory')
  assert.ok(def.resourceBase.path.replace(/\\/g, '/').endsWith('/docs'))
  assert.ok(def.description.length > 0)
  assert.ok(def.whenToUse.length > 0)
})

test('buildConvertSkill：空内容返回 null（调用方跳过注册）', () => {
  assert.equal(buildConvertSkill(''), null)
  assert.equal(buildConvertSkill('  \n '), null)
  assert.equal(buildConvertSkill(undefined), null)
})

test('registerConvertSkill：读包内指南并注册，内容含 interchange 标记', () => {
  const registered = []
  const dispose = registerConvertSkill({}, { register(def) { registered.push(def); return () => {} } })
  assert.equal(typeof dispose, 'function')
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, CONVERT_SKILL_NAME)
  assert.ok(registered[0].content.includes('"interchange": "dsh-chat-import"'))
})

test('registerConvertSkill：指南读取失败只警告不注册（大声但不炸导入）', () => {
  const registered = []
  const warns = []
  const origWarn = console.warn
  console.warn = (m) => warns.push(m)
  try {
    const out = registerConvertSkill(
      {},
      { register(def) { registered.push(def) } },
      { readFile() { throw new Error('EIO') } },
    )
    assert.equal(out, undefined)
  } finally {
    console.warn = origWarn
  }
  assert.equal(registered.length, 0)
  assert.equal(warns.length, 1)
  assert.match(warns[0], /skill/)
})
