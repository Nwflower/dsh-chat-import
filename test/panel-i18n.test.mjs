// panel-i18n.test.mjs — 面板字典（lib/client.js 里的 DICT）的完整性契约：
//   1. zh / en 键集一致（缺一边的键在该语言下会直接显示键名）；
//   2. 面板里每个字面量 t("…") / tr("…") 都在字典里（拼错键名同样会显示键名）；
//   3. 字典里没有死键：每个键要么以字面量出现在面板代码里，要么落在动态查键前缀
//     （t("target." + v) 这类）之下——死键只会让两种语言的维护面无谓变大；
//   4. 面向用户的错误文案不绕过字典硬编码中文（英文界面下会冒出中文）。
//
// 字典是 bundle 里的对象字面量：切出来求值，测的就是实际发布的那一份。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const dictStart = source.indexOf('    const DICT = {')
assert.notEqual(dictStart, -1, 'lib/client.js 缺少 DICT')
const dictEnd = source.indexOf('\n    };\n', dictStart)
assert.notEqual(dictEnd, -1, 'DICT 没有可识别的收尾')
const DICT = new Function('return ' + source.slice(source.indexOf('{', dictStart), dictEnd + '\n    }'.length))()
// 字典之外的面板代码（用来判定「键是否被引用」）
const code = source.slice(0, dictStart) + source.slice(dictEnd)

test('zh / en 键集一致', () => {
  const zh = Object.keys(DICT.zh)
  const en = Object.keys(DICT.en)
  assert.deepEqual(zh.filter((k) => !(k in DICT.en)), [], 'en 缺这些键')
  assert.deepEqual(en.filter((k) => !(k in DICT.zh)), [], 'zh 缺这些键')
})

test('面板里的字面量键都在字典里', () => {
  const used = new Set([...code.matchAll(/\btr?\("([^"]+)"\s*[,)]/g)].map((m) => m[1]))
  assert.ok(used.size > 100, '应能从 bundle 里找出面板用到的字面量键')
  const missing = [...used].filter((k) => !(k in DICT.zh) || !(k in DICT.en))
  assert.deepEqual(missing, [], '这些键在字典里不存在（界面会直接显示键名）')
})

test('字典里没有死键（字面量引用或动态前缀之一）', () => {
  const prefixes = [...new Set([...code.matchAll(/\bt\("([\w.-]+\.)"\s*\+/g)].map((m) => m[1]))]
  assert.ok(prefixes.length > 0, '应能识别出动态查键前缀')
  const dead = Object.keys(DICT.zh).filter((k) => !code.includes('"' + k + '"') && !prefixes.some((p) => k.startsWith(p)))
  assert.deepEqual(dead, [], '这些键没有任何引用（删掉，或补上引用）')
})

test('面向用户的错误文案走字典，不硬编码中文', () => {
  for (const text of ['导入面板请求失败', '导入偏好读取失败']) {
    assert.equal(code.includes(text), false, '「' + text + '」应走 t()，不该出现在字典之外')
  }
  assert.match(code, /t\("error\.request", \{ msg: /, '扫描请求抛错走 error.request')
  assert.match(code, /t\("error\.prefs", \{ msg: /, '偏好读取抛错走 error.prefs')
})
