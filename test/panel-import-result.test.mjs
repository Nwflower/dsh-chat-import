// panel-import-result.test.mjs — 面板导入结果摘要（src/client/utils.js 的 fmtImportResult）
// 与「被忽略墓碑挡下的条目」定位（src/client/discovery.js 的 ignoredItems）：
// 从 bundle 切出来求值，测的就是发布的那份逻辑（面板没有 DOM 测试环境）。
//
// 契约（一条会话都没建的结果被读成「已处理」）：status='ignored' 必须单独计数并点名原因，
// 不能并进「跳过」；被挡下的条目要能被定位出来，供 Toast 的「仍然导入」（force 越权）动作
// 重试——永久解除走 /unignore。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** 切出 bundle 里一段 4 空格基准缩进的顶层声明（与 panel-discovery.test.mjs 同一手法）。 */
function topLevel(startMarker, endMarker = '\n    }') {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, 'lib/client.js 缺少 ' + startMarker)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, startMarker + ' 没有可识别的收尾')
  return source.slice(start, end + endMarker.length)
}

// 字典替身：只记键与插值，按真实 fill 的 {name} 语义做纯文本替换（不能 JSON 转义，
// 否则嵌套的插值会被转义两次）；分隔符给一个真实字符，便于断言并列原因
const t = (key, vars) => (key === 'result.separator' ? ' | ' : key
  + (vars ? '(' + Object.keys(vars).map((k) => k + '=' + vars[k]).join(',') + ')' : ''))
const { fmtImportResult, ignoredItems } = new Function('t', [
  topLevel('function ignoreReasonCode('),
  topLevel('function ignoreReasonsOf('),
  topLevel('function fmtIgnoreReasons('),
  topLevel('function fmtImportResult('),
  topLevel('function ignoredItems('),
].join('\n') + '\nreturn { fmtImportResult, ignoredItems };')(t)

/** 摘要里的计数条（result.done 的 bits）：拆出来断言各键与条数，不受外层包文案干扰。 */
function bitsOf(text) {
  const start = text.indexOf('bits=')
  assert.notEqual(start, -1, '摘要必须经 result.done 汇总：' + text)
  return text.slice(start + 'bits='.length, text.lastIndexOf(')'))
}

test('fmtImportResult：忽略墓碑单独计数并点名原因，不混进「跳过」', () => {
  const bits = bitsOf(fmtImportResult([{ status: 'ignored', sourcePath: 'p', reason: 'retracted' }], t))
  assert.ok(bits.includes('result.ignored(n=1)'), bits)
  assert.ok(bits.includes('ignore.reason.retracted'), bits)
  assert.ok(!bits.includes('result.skipped'), '忽略不能并进「跳过」：' + bits)
  assert.ok(!bits.includes('result.nochange'), '要给出结论，不能只说「无变化」：' + bits)
})

test('fmtImportResult：原因码从 skipReason 兜底解析；未知码走兜底文案并原样带出', () => {
  // 老路径只带合并串：仍要点得出原因，不能退回一句「跳过」
  assert.ok(bitsOf(fmtImportResult([{ status: 'ignored', skipReason: 'ignored:archived' }], t)).includes('ignore.reason.archived'))
  assert.ok(bitsOf(fmtImportResult([{ status: 'ignored', reason: 'weird' }], t)).includes('ignore.reason.other(code=weird)'))
  // 多个原因去重后并列
  const two = bitsOf(fmtImportResult([
    { status: 'ignored', reason: 'archived' },
    { status: 'ignored', reason: 'archived' },
    { status: 'ignored', reason: 'retracted' },
  ], t))
  assert.ok(two.includes('ignore.reason.archived | ignore.reason.retracted'), two)
})

test('fmtImportResult：批量计数分开报（ignored 与 skipped 各一条），原因取服务端去重清单', () => {
  const bits = bitsOf(fmtImportResult([{
    mode: 'batch', total: 4, imported: 1, skipped: 1, ignored: 2, failed: 0,
    ignoredReasons: ['workspace-deleted'],
  }], t))
  assert.ok(bits.includes('result.skipped(n=1)'), bits)
  assert.ok(bits.includes('result.ignored(n=2)'), bits)
  assert.ok(bits.includes('ignore.reason.workspace-deleted'), bits)
  // 批量没有原因清单时只报计数，不编原因
  const bare = bitsOf(fmtImportResult([{ mode: 'batch', total: 2, imported: 0, skipped: 0, ignored: 2 }], t))
  assert.ok(bare.includes('result.ignored(n=2)'), bare)
  assert.ok(!bare.includes('ignore.reasonSuffix'), bare)
})

test('fmtImportResult：普通跳过仍是「跳过」，其余计数不受影响', () => {
  const bits = bitsOf(fmtImportResult([{ status: 'skipped' }, { status: 'imported' }], t))
  assert.ok(bits.includes('result.skipped(n=1)'), bits)
  assert.ok(bits.includes('result.imported(n=1)'), bits)
  assert.ok(!bits.includes('result.ignored'), bits)
})

test('ignoredItems：按 sourcePath 定位被挡下的条目；批量只有计数时按整批重试', () => {
  const items = [{ sourcePath: 'a' }, { sourcePath: 'b' }, { sourcePath: 'c' }]
  assert.deepEqual(ignoredItems([{ status: 'ignored', sourcePath: 'b' }], items), [items[1]])
  // 批量结果只带计数、定位不到逐条 → 整批交给 force 重试（按钮点了必须有反应）
  assert.deepEqual(ignoredItems([{ mode: 'batch', ignored: 2 }], items), items)
  // 没有被忽略的条目时不给动作
  assert.deepEqual(ignoredItems([{ status: 'imported', sourcePath: 'a' }], items), [])
  assert.deepEqual(ignoredItems([{ mode: 'batch', ignored: 0 }], items), [])
})
