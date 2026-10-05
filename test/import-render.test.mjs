// test/import-render.test.mjs — 导入结果文案（import_chat render 与 /import 命令共用）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderImportText, renderImportResult } from '../lib/tools/import-render.mjs'

const SESSION_SPEC = { sourceLabel: 'opencode', label: { batch: '会话', skipped: '无用户回合' } }
const FILE_SPEC = { sourceLabel: 'Claude Code' }

test('预览：批量按来源单位计数并列出前 5 条明细；单文件报规模与跳过原因', () => {
  const batch = renderImportText({
    mode: 'batch', preview: true, total: 7,
    results: Array.from({ length: 7 }, (_, i) => ({ path: 'p' + i, title: 't' + i })),
  }, SESSION_SPEC)
  assert.match(batch, /^预览（dry-run，未落盘）：共 7 个会话/)
  assert.equal(batch.split('\n').length, 1 + 5)
  const single = renderImportText({ mode: 'single', preview: true, title: '标题', turns: 0, messages: 0, toolCalls: 0, skipped: 1, skipReason: '空会话' }, FILE_SPEC)
  assert.match(single, /《标题》无可导入内容（0 条消息、0 次工具调用、跳过 1）\n跳过原因：空会话/)
})

test('批量：计数、重导副本、图片、裁剪与失败明细都可见', () => {
  const text = renderImportText({
    mode: 'batch', total: 4, imported: 2, reimported: 1, appended: 1, alreadyImported: 0, skipped: 1, failed: 1,
    images: 3, imagesDegraded: 1,
    results: [
      { path: 'a', status: 'imported', trimmed: { droppedTurns: 1 } },
      { path: 'b', status: 'failed', error: '坏库' },
      { path: 'c', status: 'skipped', reason: '无回合' },
    ],
  }, SESSION_SPEC)
  for (const needle of ['共扫描 4 个会话', '新增 2 个会话', '其中 1 个是重导新副本', '续写 1 个会话', '跳过 1 个（无用户回合）',
    '失败 1 个', '图片落成附件 3 张', '图片降级占位 1 张', '1 个会话触发预算裁剪', '  - b：坏库', '  - c：无回合']) {
    assert.ok(text.includes(needle), needle + ' ∉ ' + text)
  }
  assert.match(renderImportText({ mode: 'batch', total: 1, skipped: 1, results: [] }, FILE_SPEC), /跳过 1 个（非 Claude Code transcript）/)
})

test('单文件：跳过 / 续写 / 重导副本 / 已导入的文案', () => {
  assert.match(renderImportText({ mode: 'single', status: 'skipped', sessionId: 'none', skippedLines: [{ line: 3 }] }, FILE_SPEC),
    /^跳过导入：非 Claude Code transcript\n畸形行明细：L3/)
  assert.match(renderImportText({ mode: 'single', status: 'appended', sessionId: 's', appendedTurns: 2, appendedEvents: 9 }, FILE_SPEC),
    /会话 s 已续写 2 轮、9 条事件/)
  assert.match(renderImportText({ mode: 'single', status: 'imported', reimported: { previous: 'a', current: 'b', reason: 'continued-in-dsh' } }, FILE_SPEC),
    /已重导为新会话 b：该会话已在 DSH 续聊过.*原会话 a 原样保留/)
  const imported = renderImportText({
    mode: 'single', status: 'imported', sessionId: 's', turns: 1, messages: 2, toolCalls: 0, skipped: 1,
    trimmed: { droppedTurns: 2, croppedBlocks: 0, droppedOversized: 0, summaryInserted: true, estimatedTokens: 10, budget: 20, source: 'param' },
    secrets: [{ line: 1, kind: 'key' }], ungrouped: 1,
  }, FILE_SPEC)
  assert.match(imported, /已导入 1 轮对话（2 条消息、0 次工具调用）→ 会话 s（跳过 1 行畸形记录）（裁剪 2 轮，已插入摘要，估算 10\/20 tokens，来源 param）/)
  assert.match(imported, /secrets 命中 1 处、未归组 1 个会话（原因未知）/)
})

test('已导入跳过：每种原因都说清楚（命令面与工具同一份文案）', () => {
  const reasons = [
    ['storedShrunk', 'storedShrunk'], ['sourceShrunk', 'sourceShrunk'], ['changedInPlace', 'append-only'],
    ['argsChanged', 'args-changed'], ['budgetChanged', 'budget-changed'], ['appendedSkipped', '读不到 DSH 侧日志长度'],
    ['backfilled', '已回填导入记录'],
  ]
  for (const [flag, needle] of reasons) {
    const text = renderImportText({ mode: 'single', status: 'already-imported', sessionId: 's', alreadyImported: true, [flag]: flag === 'appendedSkipped' ? 'x' : true }, FILE_SPEC)
    assert.ok(text.includes(needle), flag + '：' + text)
  }
  assert.match(renderImportText({ mode: 'single', sessionId: 's', alreadyImported: true }, FILE_SPEC), /源文件未变化/)
})

test('renderImportResult：同一段文案包成文本块', () => {
  assert.deepEqual(renderImportResult({}, { mode: 'single', sessionId: 's', alreadyImported: true }, FILE_SPEC),
    [{ type: 'text', text: '会话 s 已存在，跳过导入：源文件未变化。' }])
})
