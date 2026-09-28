// lib/transfer.mjs — 导入面板「导入到」非 DSH 目标的转投管线
//
// 语义：把选中的外部会话**转换成目标工具自己的格式并落盘**，而不是在 DSH 里建会话。
// 目标工具（均复用 `export_chat` 已有的序列化器与落盘约定）：
//   claude   → ~/.claude/projects/<slug>/<uuid>.jsonl（Claude Code 直接读该目录，无需导入命令）
//   codex    → ~/.dsh/exports/<id>.rollout.jsonl（Codex rollout 格式文件）
//   kimi     → ~/.dsh/exports/<id>.wire.jsonl（Kimi wire 格式文件）
//   opencode → ~/.dsh/exports/<id>.opencode.json（`opencode import <file>` 读入）
//
// 实现路线：复用「导入 → 导出 → 清掉中间会话」三步，而不是为 26 种来源各写一条
// 「只转换不落盘」的捷径——转换质量与 `import_chat` + `export_chat` 完全一致，覆盖面
// 天然是全来源。代价是过程中会短暂存在一个 DSH 会话：
//   * **本次调用新建的**会话（import 状态 imported）在导出成功后立刻撤回（工件 / 工作区
//     挂接 / registry 记录一并清掉），因此目标为外部工具时不会在 DSH 留下副本；
//   * **原本就存在**的会话（already-imported / appended）不动——那是用户自己的会话，
//     只导出、不删除，并在结果里显式标 kept。
// 撤回失败（会话在跑、工件被占用）不静默：记 purgeError、保留会话并计入 kept。
import { deleteImportedSession } from './purge.mjs'
import { exportClaudeSession, exportCodexSession, exportKimiSession, exportOpencodeSession } from './export-tool.mjs'

// 目标格式能不能承载图片：Claude / Codex 有原生图片块（见 lib/export/claude.mjs 与
// codex.mjs），Kimi 的 wire 只认自有 blob 存储、opencode 的 file part 另需外部文件——
// 对这两种目标落图片字节没有任何收益（导不出去），徒增撤回后无法回收的附件。
const IMAGE_CAPABLE_TARGETS = new Set(['claude', 'codex'])

export function targetCarriesImages(target) {
  return IMAGE_CAPABLE_TARGETS.has(target)
}

/** 支持「导入到」的目标（'dsh' 是默认值，表示照常建 DSH 会话，不在本模块处理）。 */
export const TRANSFER_TARGETS = ['claude', 'codex', 'kimi', 'opencode']

const EXPORTERS = {
  claude: exportClaudeSession,
  codex: exportCodexSession,
  kimi: exportKimiSession,
  opencode: exportOpencodeSession,
}

export function isTransferTarget(target) {
  return TRANSFER_TARGETS.includes(target)
}

// 目标工具的落盘说明（面板/结果里提示用户「文件在哪、下一步做什么」）。
export function transferHint(target, filePath) {
  if (target === 'claude') return 'Claude Code 直接读该目录，用 claude --resume 即可打开'
  if (target === 'opencode') return '在 opencode 里执行 opencode import ' + filePath
  if (target === 'codex') return '把该 rollout 文件放到 Codex 的 sessions 目录即可被它读到'
  if (target === 'kimi') return '把该 wire.jsonl 放到 Kimi 的会话目录即可被它读到'
  return ''
}

// 从一次导入结果里取「需要转出的会话」：single 一条，batch 逐条（只取真拿到 sessionId 的）。
// 跳过/失败条目（status skipped|failed，或占位 id 'none'）不进转投——它们没有会话可导出。
function sessionsOf(imported) {
  if (!imported || typeof imported !== 'object') return []
  const usable = (status, sessionId) => typeof sessionId === 'string' && sessionId && sessionId !== 'none'
    && status !== 'skipped' && status !== 'failed'
  if (imported.mode === 'batch') {
    const list = Array.isArray(imported.results) ? imported.results : []
    return list
      .filter((r) => r && usable(r.status, r.sessionId))
      .map((r) => ({
        sessionId: r.sessionId,
        sourcePath: typeof r.path === 'string' ? r.path : undefined,
        // 只有本次调用新建的会话才允许撤回（见文件头说明）
        created: r.status === 'imported',
        images: typeof r.images === 'number' ? r.images : 0,
      }))
  }
  if (!usable(imported.status, imported.sessionId)) return []
  return [{
    sessionId: imported.sessionId,
    sourcePath: undefined,
    created: imported.status === 'imported',
    images: typeof imported.images === 'number' ? imported.images : 0,
  }]
}

/**
 * 单条发现条目的转投。`importItem` 由调用方注入（panel 传 importDiscoveryItem），
 * 避免 transfer ↔ panel 的循环依赖。
 * 返回 `{ mode, target, files, transferred, purged, kept, failed }`。
 */
export async function transferDiscoveryItem(ctx, item, { registryDir, importItem, force, replace, budget, budgetSource } = {}) {
  const target = item && item.target
  if (!isTransferTarget(target)) throw new Error('未知导入目标: ' + String(target))
  if (typeof importItem !== 'function') throw new Error('transferDiscoveryItem 需要 importItem（导入执行体）')
  const exportSession = EXPORTERS[target]

  // 1) 先按常规路径导入（全来源覆盖；批量源在这里展开成多条会话）。
  // storeImages：只有目标格式能承载图片时才落附件——图片字节要先落进会话日志，导出才能
  // 读回来写进目标格式；但本次新建的中间会话随后会被撤回，而宿主附件服务没有删除面
  // （见 lib/attachments.mjs 与 D14），这些字节会留在附件存储里不可回收。对 Kimi /
  // opencode 这类导不出图片的目标，落字节纯属浪费，直接不落（图片降级为占位并在结果里计数）。
  const storeImages = targetCarriesImages(target)
  const imported = await importItem(ctx, item.format, item.sourcePath, item.sessionIds, { force, replace, budget, budgetSource, storeImages })
  const sessions = sessionsOf(imported)
  // 导入本身没产出会话（被跳过：辅助转录 / 无用户回合 / 非会话目录）——转投同样要大声，
  // 不能返回一个「transferred: 0 且没有任何原因」的空结果让用户以为成功了
  if (sessions.length === 0) {
    const reason = (imported && typeof imported.skipReason === 'string' && imported.skipReason)
      || (imported && typeof imported.error === 'string' && imported.error)
      || ('导入未产出会话（status: ' + String(imported && imported.status) + '）')
    return {
      mode: imported && imported.mode === 'batch' ? 'batch' : 'single',
      target,
      status: 'failed',
      files: [],
      transferred: 0,
      purged: 0,
      kept: 0,
      failed: 1,
      error: reason,
      hint: '',
    }
  }

  const files = []
  let transferred = 0
  let purged = 0
  let kept = 0
  let failed = 0
  // 撤回后留在附件存储里、无法回收的图片字节数（>0 才占键；宿主无删除 API，见 D14）
  let attachmentsOrphaned = 0
  for (const session of sessions) {
    let out
    try {
      // 2) 导出到目标格式（claude 需要 cwd：优先用发现条目的 cwd，其次会话 header.cwd）
      const args = { sessionId: session.sessionId }
      if (typeof item.cwd === 'string' && item.cwd) args.cwd = item.cwd
      out = target === 'claude' ? await exportSession(ctx, args, { registryDir }) : await exportSession(ctx, args)
    } catch (err) {
      failed++
      files.push({
        sessionId: session.sessionId,
        sourcePath: session.sourcePath,
        status: 'failed',
        error: String((err && err.message) || err),
        kept: session.created !== true,
      })
      continue
    }
    transferred++
    const entry = {
      sessionId: session.sessionId,
      sourcePath: session.sourcePath,
      status: 'transferred',
      filePath: out.filePath,
      recordCount: out.recordCount,
      kept: session.created !== true,
    }
    if (out.degradations) entry.degradations = out.degradations
    // 3) 本次新建的中间会话：导出成功后撤回（不残留 DSH 副本）
    if (session.created === true) {
      try {
        await deleteImportedSession(ctx, registryDir, session.sessionId)
        purged++
        entry.purged = true
        // 图片字节已随会话写出但会话被撤回：附件存储没有删除面，这些字节留在那里
        if (session.images > 0) {
          attachmentsOrphaned += session.images
          entry.attachmentsOrphaned = session.images
        }
      } catch (err) {
        // 撤回失败要大声：会话保留（用户还能自己删），把原因带到结果里
        kept++
        entry.kept = true
        entry.purgeError = String((err && err.message) || err)
      }
    } else {
      kept++
    }
    files.push(entry)
  }

  const mode = imported && imported.mode === 'batch' ? 'batch' : 'single'
  const status = failed > 0 && transferred === 0 ? 'failed' : (failed > 0 ? 'partial' : 'transferred')
  return {
    mode,
    target,
    status,
    files,
    transferred,
    purged,
    kept,
    failed,
    // 图片字节留在附件存储里没能回收的张数（目标能承载图片、且中间会话被撤回时才会 >0）
    ...(attachmentsOrphaned > 0 ? { attachmentsOrphaned } : {}),
    hint: transferHint(target, files.find((f) => f.filePath) ? files.find((f) => f.filePath).filePath : undefined),
  }
}
