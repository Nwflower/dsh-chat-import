// panel-file-card.test.mjs — 「从文件导入」单文件卡片对 host 面失败的渲染契约。
//
// host 面读取 / 派生 / 解析抛错时，预览条目是 { status:'failed', error }（lib/file-import.mjs
// 的 previewOneTarget）。卡片若只按 turns === 0 渲染，这类失败会被读成「没有可导入的轮次」，
// 真实错误被吞掉（违反「失败要大声」），也与批处理卡片已有的 status==='failed' 口径不一致。
// 面板是 lib/client.js 里的 h()（= React.createElement）内联树，零构建、无 DOM 测试环境
//（devDependencies 只有 eslint），所以按源码断言语义——这层没有模块边界能兜住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** renderSingleCard 的函数体：从声明到下一个渲染函数（toggleBatch）之前。 */
function singleCardBody() {
  const start = source.indexOf('const renderSingleCard = (entry) => {')
  assert.notEqual(start, -1, 'lib/client.js 缺少 renderSingleCard')
  const end = source.indexOf('const toggleBatch = (p) => {', start)
  assert.notEqual(end, -1, 'renderSingleCard 之后找不到 toggleBatch（收尾标记变了）')
  return source.slice(start, end)
}

test('单文件卡片：status===\'failed\' 时亮出真实错误，不再读成「没有可导入的轮次」', () => {
  const body = singleCardBody()
  assert.match(body, /const failed = entry\.status === "failed"/, '卡片要识别 host 面的失败条目')
  // 错误正文（entry.error）优先，缺键时回退通用「读取失败」
  assert.match(body, /failed \? h\("div", \{ style: style\.warn \}, entry\.error \|\| t\("fileImport\.batch\.failed"\)\) : null/)
  // 失败条目既没有可导入轮次、也不是「未识别」：noTurns 与三项计数都不能盖掉真实错误
  assert.match(body, /!bundle && !failed && turns === 0 && !entry\.skipReason && !hasFailures \? h\("div", \{ style: style\.warn \}, t\("fileImport\.noTurns"\)\) : null/)
  assert.match(body, /\(unrecognized \|\| failed\) \? null : h\("span", \{ style: style\.meta \}, counts\.join\(" · "\)\)/)
})
