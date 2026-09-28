// panel-layout.test.mjs — 导入面板骨架（lib/client.js 内联 JSX 源码）的结构契约：
// 面板按「选择区 → 筛选层 → 工具栏 → 列表 → 分页 → 底部主操作区」自上而下排布：
// 选择区只有一行、读成「从 全部来源 导入到 DSH 会话环境」（「从」与「导入到」当连接词、
// 行内不画分隔线），工作区筛选并入筛选层与搜索框同排，工具栏只留选择类动作
//（已选条数由底部主按钮的「导入所选 (N)」承担，不再单独占一个 label）。
//
// 为什么读源码断言：面板是 client.js 里的 React.createElement 内联树，零构建、
// 无 DOM 测试环境（devDependencies 只有 eslint）。这些约定在真实 UI 上肉眼可见、
// 但没有任何模块边界能兜住——顺序或分隔线一旦被改回去，只有这里会响。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** DiscoveryPanel 的 body 表达式：从函数内 `const body = React.createElement` 到收尾 `return`。 */
function panelBody() {
  const start = source.indexOf('function DiscoveryPanel()')
  assert.notEqual(start, -1, 'lib/client.js 缺少 DiscoveryPanel')
  const bodyAt = source.indexOf('const body = React.createElement', start)
  assert.notEqual(bodyAt, -1, 'DiscoveryPanel 缺少 body 树')
  const end = source.indexOf('\n      return React.createElement("div", { ref: rootRef', bodyAt)
  assert.notEqual(end, -1, 'DiscoveryPanel body 树没有可识别的收尾')
  return source.slice(bodyAt, end)
}

const at = (haystack, needle) => {
  const i = haystack.indexOf(needle)
  assert.notEqual(i, -1, '面板源码里找不到：' + needle)
  return i
}

test('面板纵向顺序：选择区 → 筛选层 → 工具栏 → 列表 → 分页 → 底部主操作区', () => {
  const body = panelBody()
  const order = [
    'style.rowPlain',
    't("from")',
    't("source.title")',
    't("importTo")',
    'style.searchRow',
    'style.toolbar',
    't("workspace.title")',
    'style.list',
    'style.pageBar',
    'style.resultBar',
    'style.importBar',
  ].map((needle) => [needle, at(body, needle)])
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i - 1][1] < order[i][1], order[i][0] + ' 应排在 ' + order[i - 1][0] + ' 之后')
  }
})

test('导入按钮置底：主按钮排在列表与分页之后，不再夹在工具栏与列表之间', () => {
  const body = panelBody()
  const primary = at(body, 't("import.selected"')
  assert.ok(primary > at(body, 'style.list'), '导入所选应排在会话列表之后')
  assert.ok(primary > at(body, 'style.pageBar'), '导入所选应排在分页条之后（贴面板底缘）')
  assert.ok(primary > at(body, 'style.toolbar'), '导入所选不应再紧跟工具栏')
})

test('选择区只剩一行（来源 + 落点），无分隔线（组边界由筛选层的上边框承担）', () => {
  const body = panelBody()
  // 选择区一行用 rowPlain（无 borderBottom 的行样式）
  assert.equal((body.match(/style\.rowPlain/g) || []).length, 1, '选择区只有「来源 + 落点」一行，应使用 rowPlain')
  assert.equal((body.match(/style\.row\b/g) || []).length, 0, '选择行不应再使用带下边框的 style.row')
  const stylesAt = source.indexOf('const makeStyles = (C) => ({')
  assert.notEqual(stylesAt, -1)
  const styles = source.slice(stylesAt, source.indexOf('function fmtTime', stylesAt))
  const rowPlain = styles.match(/rowPlain:\s*\{([^}]*)\}/)
  assert.ok(rowPlain, 'makeStyles 缺少 rowPlain 定义')
  assert.ok(!/border/.test(rowPlain[1]), 'rowPlain 不得带任何边框：' + rowPlain[1])
  const searchRow = styles.match(/searchRow:\s*\{([^}]*)\}/)
  assert.ok(searchRow, 'makeStyles 缺少 searchRow 定义')
  assert.match(searchRow[1], /borderTop/, 'searchRow 应承担选择区的组边界（borderTop）')
})

test('选择区一行读完：来源下拉 → 连接词「导入到」→ 落点下拉；工作区筛选在筛选层', () => {
  const body = panelBody()
  const selects = [...body.matchAll(/SearchableSelect/g)].map((m) => m.index)
  assert.equal(selects.length, 4, '面板应有来源 / 落点 / 路径筛选 / 时间筛选四个下拉')
  const joins = [...body.matchAll(/style\.rowJoin/g)].map((m) => m.index)
  assert.equal(joins.length, 2, '本行有两个连接词：「从」与「导入到」')
  assert.ok(joins[0] < selects[0], '「从」应排在来源下拉之前')
  assert.ok(selects[0] < joins[1] && joins[1] < selects[1], '「导入到」应夹在来源与落点两个下拉之间（同一行）')
  const toolbarAt = at(body, 'style.toolbar')
  const listAt = at(body, 'style.list')
  assert.ok(toolbarAt < selects[2] && selects[2] < listAt, '工作区筛选挂在工具栏末位，排在列表之前')
  const toolbar = body.slice(toolbarAt, listAt)
  // 工具栏三个动作按钮（全选 / 清空 / 刷新）都走 toolBtn，窄面板下一起降级成图标。
  // 「仅选未导入 / 仅选已导入」两个跨页勾选按钮已移除：重导语义下前者的集合由「全选 +
  // 未导入行」覆盖，后者批量重导只会空转（源未变）或产出副本（已续聊），名字也不描述动作。
  assert.equal((toolbar.match(/toolBtn\(/g) || []).length, 3, '工具栏的三个动作按钮走 toolBtn')
  assert.ok(toolbar.indexOf('t("workspace.title")') > toolbar.lastIndexOf('toolBtn('),
    '路径筛选不是 toolBtn 条目：窄面板下工具按钮降级成图标时它仍保持文字')
  assert.ok(toolbar.indexOf('t("filter.time")') > toolbar.lastIndexOf('toolBtn('),
    '时间筛选同样不经 toolBtn，窄面板下也保持文字')
  assert.ok(toolbar.indexOf('t("workspace.title")') < toolbar.indexOf('t("filter.time")'),
    '两个筛选控件相邻：路径在前、时间在后')
  assert.equal(body.includes('selected.count'), false, '已选条数由底部主按钮承担，工具栏不再重复显示')
})

test('底部主操作区自带上边框，与列表/分页分区；导入结果条紧贴主按钮之上', () => {
  const stylesAt = source.indexOf('const makeStyles = (C) => ({')
  const styles = source.slice(stylesAt, source.indexOf('function fmtTime', stylesAt))
  const importBar = styles.match(/importBar:\s*\{([^}]*)\}/)
  assert.ok(importBar, 'makeStyles 缺少 importBar 定义')
  assert.match(importBar[1], /borderTop/, '置底后的 importBar 应改画上边框')
  assert.ok(!/borderBottom/.test(importBar[1]), '置底后的 importBar 不应再留下边框')
  const resultBar = styles.match(/resultBar:\s*\{([^}]*)\}/)
  assert.ok(resultBar, 'makeStyles 缺少 resultBar 定义')
  assert.match(resultBar[1], /borderTop/, 'resultBar 应带上边框（与分页条分区）')
  const body = panelBody()
  assert.ok(at(body, 'style.resultBar') < at(body, 'style.importBar'), '导入结果应紧贴主按钮之上')
})

// 勾选入口是**整行**，不在行首工具标上：点 22px 的方图当勾选位不直观。
// 契约：行容器挂 role=checkbox / aria-checked / aria-label 与键盘切换；工具标只作指示器
//（不接 onClick、不占 tab 位）；行内导入 / 同步按钮必须 stopPropagation，否则点按钮会连带勾选。
test('会话行：多选入口是整行（role=checkbox + 键盘切换），工具标只作指示，导入按钮不冒泡', () => {
  const rowAt = source.indexOf('const SessionRow = React.memo(function SessionRow')
  assert.notEqual(rowAt, -1, 'lib/client.js 缺少 SessionRow')
  const row = source.slice(rowAt, source.indexOf('function DiscoveryPanel()', rowAt))

  // 整行：勾选语义 + 键盘可达（挂在行容器上，而不是消息体内部的某个子节点）
  const rowOpenAt = row.indexOf('return React.createElement("div", {')
  assert.notEqual(rowOpenAt, -1, 'SessionRow 应渲染行容器')
  const rowOpen = row.slice(rowOpenAt, row.indexOf('React.createElement(SourceBadge'))
  assert.match(rowOpen, /role: "checkbox"/, '行容器应带 checkbox 角色')
  assert.match(rowOpen, /"aria-checked": checked/, '行容器应暴露 aria-checked')
  assert.match(rowOpen, /"aria-label": (s.title || props.noTitle)/, '行容器应带可读的 aria-label')
  assert.ok(rowOpen.includes('onClick: importing ? undefined : () => onToggle(key)'), '点整行即切换勾选')
  assert.ok(rowOpen.includes('e.key === "Enter" || e.key === " "'), '行应支持 Enter / 空格切换')
  assert.ok(rowOpen.includes('tabIndex: importing ? -1 : 0'), '行应是键盘停靠点')
  // 手型写在 rowStyle 里（cursor 依赖 importing，所以不在 createElement 的属性内联）
  assert.ok(row.includes('cursor: importing ? "default" : "pointer"'), '行应显示可点手型')
  // 消息体不再自行承载勾选语义（避免双份控件 / 双 tab 位）
  const mainAt = row.indexOf('style.itemMain')
  assert.ok(!row.slice(mainAt, mainAt + 80).includes('toggleProps'), '消息体不应再挂 toggleProps')

  // 工具标：只作指示器
  const badgeAt = row.indexOf('React.createElement(SourceBadge, {')
  assert.notEqual(badgeAt, -1, '行内应仍渲染来源工具标')
  const badge = row.slice(badgeAt, row.indexOf('}),', badgeAt))
  assert.ok(!/onClick/.test(badge), '工具标不应再接收点击（勾选入口已移到消息体）')
  assert.ok(badge.includes('checked,'), '工具标仍应显示选中态')

  // 行内按钮在可勾选容器内部 → 必须拦住冒泡，否则「点导入」会顺带勾上这一行
  const slotAt = row.indexOf('style.rowSlot')
  assert.ok(mainAt < slotAt, '导入按钮槽位应排在消息体之后')
  const slot = row.slice(slotAt)
  assert.ok(slot.includes('e.stopPropagation(); onImport(s)'), '导入按钮应先 stopPropagation 再执行导入')
  assert.ok(slot.includes('onClick: (e) =>'), '导入按钮的点击应拿到事件对象（用于拦冒泡）')
})
