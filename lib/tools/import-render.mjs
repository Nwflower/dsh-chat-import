// lib/tools/import-render.mjs — 导入结果的人类可读文案（import_chat 的 render 与 /import 命令共用）
//
// 文案按来源 spec 的 label 取批量单位（「文件」/「会话」/「线程」）与跳过原因，sourceLabel
// 进「非 X transcript」提示。只读结果字段，不拼入任何会话内容（畸形行只报行号与 kind）。
// 跳过原因要说全（storedShrunk / sourceShrunk / changedInPlace / argsChanged / budgetChanged /
// appendedSkipped / backfilled，见 docs/architecture.md D13）：用户看到「已存在，跳过」时必须
// 知道为什么、要不要 force。

// 裁剪上报摘要（trimmed 存在时追加一句人类可读说明）
function trimmedNote(v) {
  const t = v && v.trimmed
  if (!t) return ''
  const bits = []
  if (t.droppedTurns > 0) bits.push('裁剪 ' + t.droppedTurns + ' 轮')
  if (t.croppedBlocks > 0) bits.push('裁剪 ' + t.croppedBlocks + ' 条超长内容')
  if (t.droppedOversized > 0) bits.push('丢弃 ' + t.droppedOversized + ' 条超半消息')
  if (t.summaryInserted) bits.push('已插入摘要')
  return bits.length > 0 ? '（' + bits.join('，') + '，估算 ' + t.estimatedTokens + '/' + t.budget + ' tokens，来源 ' + t.source + '）' : ''
}

// 畸形行明细 + 保真 / 降级计数（失败要大声：这些计数原本只停在转换器返回值里）
function detailsNote(v) {
  const skippedLines = v.skippedLines || []
  const counts = []
  if (v.secrets && v.secrets.length > 0) counts.push('secrets 命中 ' + v.secrets.length + ' 处')
  if (v.permissionCount) counts.push('permission ' + v.permissionCount + ' 条')
  if (v.metaMessages) counts.push('isMeta 记录 ' + v.metaMessages + ' 条')
  if (v.images) counts.push('图片落成附件 ' + v.images + ' 张')
  if (v.imagesDegraded) counts.push('图片降级占位 ' + v.imagesDegraded + ' 张')
  if (v.toolUseResultsMerged) counts.push('富结果 sidecar ' + v.toolUseResultsMerged + ' 条')
  if (v.backendToolCalls) counts.push('后端工具调用 ' + v.backendToolCalls + ' 次')
  if (v.droppedToolResultBlocks) counts.push('无法映射的结果块 ' + v.droppedToolResultBlocks + ' 个')
  if (v.droppedMalformedOutputs) counts.push('未知输出块 ' + v.droppedMalformedOutputs + ' 个')
  if (v.droppedMalformedArgs) counts.push('畸形工具参数 ' + v.droppedMalformedArgs + ' 条')
  // 展平信封还原（Codex Desktop 外部导入的 rollout）：还原数 + 两项降级
  if (v.externalAgent && v.externalAgent.calls) counts.push('还原外部工具调用 ' + v.externalAgent.calls + ' 次')
  if (v.externalAgent && v.externalAgent.orphanResults) counts.push('无调用的工具结果 ' + v.externalAgent.orphanResults + ' 条（保留为正文）')
  if (v.externalAgent && v.externalAgent.malformed) counts.push('畸形工具信封 ' + v.externalAgent.malformed + ' 个')
  // 归组：未归组的会话仍在，只是落在侧栏「未分组」——不报出来用户就只会觉得「没导入」
  if (v.workspaceCreated && v.workspace) counts.push('新建工作区 ' + v.workspace)
  if (v.ungrouped) counts.push('未归组 ' + v.ungrouped + ' 个会话（' + (v.ungroupedReason || '原因未知') + '）')
  if (skippedLines.length === 0) return counts.join('、')
  const lines = skippedLines.slice(0, 20).map((s) => 'L' + s.line).join('/')
  const more = skippedLines.length > 20 ? ' …' : ''
  return '畸形行明细：' + lines + more + (counts.length ? '（' + counts.join('、') + '）' : '')
}

// 「已存在，跳过」的原因：按判定优先级取第一个命中的标注
function alreadyImportedReason(v) {
  if (v.storedShrunk) return 'DSH 侧会话日志比上次落盘时短（storedShrunk，被外部截短），不写、跳过；需要完整副本请用 force:true'
  if (v.sourceShrunk) return '源文件轮次减少（sourceShrunk），跳过；需要完整副本请用 force:true'
  if (v.changedInPlace) return '源文件在既有轮次内变化（append-only 无法改写），跳过'
  if (v.argsChanged) return '导入参数已变化（args-changed），跳过；需要按新参数导入请用 force:true'
  if (v.budgetChanged) return '上下文预算已变化（budget-changed），跳过；需要按新预算导入请用 force:true'
  if (v.appendedSkipped) return '源文件已增长但读不到 DSH 侧日志长度，跳过增量续写'
  if (v.backfilled) return '已回填导入记录（旧版本导入的会话）'
  return '源文件未变化'
}

/**
 * 导入结果 → 一段人类可读文本。
 * @param value - runImportSpec / importFileTarget 的结果（单文件 / 批量 / 预览）
 * @param spec - 来源 spec（取 label / sourceLabel；缺省按「文件」与 transcript 措辞）
 */
export function renderImportText(value, spec) {
  const label = (spec && spec.label) || {}
  const sourceLabel = (spec && spec.sourceLabel) || 'transcript'
  const batchUnit = label.batch || '文件'
  // dry-run 预览：人类可读清单（未落盘提示 + 逐条明细摘要）
  if (value.preview === true) {
    if (value.mode === 'batch') {
      const detail = (value.results || []).slice(0, 5).map((r) => '  - ' + r.path
        + (r.title ? '：' + r.title : '')
        + (r.skipReason ? '：' + r.skipReason : '')
        + (r.status === 'failed' && r.error ? '：' + r.error : ''))
      return '预览（dry-run，未落盘）：共 ' + value.total + ' 个' + batchUnit
        + (detail.length ? '\n' + detail.join('\n') : '')
    }
    return '预览（dry-run，未落盘）：'
      + (value.title ? '《' + value.title + '》' : '')
      + (value.turns > 0 ? value.turns + ' 轮对话' : '无可导入内容')
      + '（' + value.messages + ' 条消息、' + value.toolCalls + ' 次工具调用'
      + (value.skipped ? '、跳过 ' + value.skipped : '') + '）'
      + (value.skipReason ? '\n跳过原因：' + value.skipReason : '')
  }
  if (value.mode === 'batch') {
    const bits = ['共扫描 ' + value.total + ' 个' + batchUnit]
    if (value.imported) bits.push('新增 ' + value.imported + ' 个会话')
    if (value.reimported) bits.push('其中 ' + value.reimported + ' 个是重导新副本（原会话保留）')
    if (value.appended) bits.push('续写 ' + value.appended + ' 个会话')
    if (value.alreadyImported) bits.push('已存在 ' + value.alreadyImported + ' 个')
    if (value.skipped) bits.push('跳过 ' + value.skipped + ' 个（' + (label.skipped || '非 ' + sourceLabel + ' transcript') + '）')
    if (value.failed) bits.push('失败 ' + value.failed + ' 个')
    if (value.images) bits.push('图片落成附件 ' + value.images + ' 张')
    if (value.imagesDegraded) bits.push('图片降级占位 ' + value.imagesDegraded + ' 张')
    const trimmedItems = (value.results || []).filter((r) => r.trimmed).length
    if (trimmedItems) bits.push(trimmedItems + ' 个会话触发预算裁剪')
    // 失败 / 跳过原因要可见，不只计数（最多展示 5 条）
    const problems = (value.results || []).filter((r) => r.status === 'failed' || r.status === 'skipped').slice(0, 5)
    const detail = problems.map((r) => '  - ' + r.path + (r.error ? '：' + r.error : r.reason ? '：' + r.reason : ''))
    return '批量导入完成：' + bits.join('，') + (detail.length ? '\n' + detail.join('\n') : '')
  }
  if (value.status === 'skipped' && value.sessionId === 'none') {
    const details = detailsNote(value)
    return '跳过导入：' + (value.skipReason || '非 ' + sourceLabel + ' transcript') + (details ? '\n' + details : '')
  }
  if (value.status === 'appended') {
    return '会话 ' + value.sessionId + ' 已续写 ' + value.appendedTurns + ' 轮、' + value.appendedEvents + ' 条事件（源文件新增轮次）。' + trimmedNote(value)
  }
  if (value.status === 'imported' && value.reimported) {
    // 重导另铸副本的三种情形说清楚：被续聊（最需要解释）、无基线（旧记录）、显式 force
    const why = value.reimported.reason === 'continued-in-dsh'
      ? '该会话已在 DSH 续聊过，继续往里追加导入轮次会混进你自己的对话，'
      : value.reimported.reason === 'baseline-missing'
        ? '旧记录没有基线（无法判断是否被续聊），'
        : ''
    return '已重导为新会话 ' + value.reimported.current + '：' + why
      + '原会话 ' + value.reimported.previous + ' 原样保留，两者都能继续。' + trimmedNote(value)
  }
  if (value.alreadyImported) {
    return '会话 ' + value.sessionId + ' 已存在，跳过导入：' + alreadyImportedReason(value) + '。'
  }
  const details = detailsNote(value)
  return '已导入 ' + value.turns + ' 轮对话（' + value.messages + ' 条消息、' + value.toolCalls + ' 次工具调用）→ 会话 ' + value.sessionId
    + (value.skipped ? '（跳过 ' + value.skipped + ' 行畸形记录）' : '') + trimmedNote(value) + (details ? '\n' + details : '')
}

/** import_chat 的 output.render：同一段文案包成文本块。 */
export function renderImportResult(_args, value, spec) {
  return [{ type: 'text', text: renderImportText(value, spec) }]
}
