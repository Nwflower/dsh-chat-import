// lib/chat-import-service.mjs — 给其它 DSH 插件复用的导入服务
//
// 只暴露现有 import_chat 分发器的 host 面，不另写一套解析或落盘逻辑。
//
// 批量编排 runChatImportAll 是「扫一批 → 逐个导入 → 聚合」的唯一实现：`/import-all` 命令与
// 服务的 importAll() 都调它（D21/D24）。命令的渲染留在 lib/command.mjs 的 formatAllImport，
// 注册进 ctx 的服务只是同一个函数的另一层皮——不要再往里内联第二份循环。

import { resolveImportBudget } from './budget.mjs'
import { runScanDiscover } from './discovery-host.mjs'
import { summarizeClaudeJsonl, summarizeCodexJsonl } from './handoff.mjs'
import { beginRegistryBatch, endRegistryBatch, resolveRegistryDir } from './imports.mjs'
import { importDiscoveryItem, IMPORT_SPECS, buildImportExecutor } from './toolkit.mjs'

const SERVICE_NAME = 'chatImport'

function validateInput(input) {
  if (!input || typeof input !== 'object') throw new TypeError('chatImport.importPath: input must be an object')
  if (typeof input.format !== 'string' || !input.format) throw new TypeError('chatImport.importPath: format is required')
  if (typeof input.path !== 'string' || !input.path) throw new TypeError('chatImport.importPath: path is required')
}

function objectInput(name, input) {
  if (input === undefined) return {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('chatImport.' + name + ': input must be an object')
  }
  return input
}

function validateResumeInput(input) {
  if (typeof input.format !== 'string' || !['claude', 'codex'].includes(input.format)) {
    throw new TypeError('chatImport.resumeSummary: format must be claude or codex')
  }
  if (typeof input.path !== 'string' || !input.path) {
    throw new TypeError('chatImport.resumeSummary: path is required')
  }
}

/**
 * 批量导入一个发现目标的全部会话：扫描（format / path / query）→ 逐个走 importDiscoveryItem
 * → 聚合计数、逐条结果、扫描警告与失败明细。
 *
 * 与 /import-all 命令共用（命令只负责参数解析与文案渲染）。语义与旧命令实现一致，另有两处
 * 收口：会话级 force 透传；一库多会话来源按发现条目的会话 id 精选（不是整库全导）。
 * @param {object} ctx host 上下文
 * @param {string} registryDir imports registry 目录
 * @param {object} [input] { format, path, query, force, storeImages, budget }
 * @param {AbortSignal} [signal] 可选取消信号（服务面传入；命令面不传）
 * @returns {Promise<object>} { mode:'batch', scanned, imported, appended, skipped, failed, errors, results, warnings }
 */
export async function runChatImportAll(ctx, registryDir, input, signal) {
  const args = objectInput('importAll', input)
  const budgetInfo = await resolveImportBudget(ctx, args)
  signal?.throwIfAborted?.()
  const scan = await runScanDiscover(ctx, { format: args.format, path: args.path, query: args.query }, registryDir)
  const summary = {
    mode: 'batch',
    scanned: scan.total,
    imported: 0,
    appended: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    results: [],
    warnings: scan.warnings,
  }
  // 批处理通道：逐会话的 registry 记录合并为末尾一次提交（此前每会话一次读-改-写 + fsync，
  // 几百会话的批量是 O(N²) I/O）。finally 保证失败也提交。
  beginRegistryBatch(registryDir)
  try {
    for (const session of scan.sessions || []) {
      signal?.throwIfAborted?.()
      if (!args.force && (session.importStatus === 'imported' || session.importStatus === 'archived')) {
        summary.skipped++
        summary.results.push({ format: session.format, sourcePath: session.sourcePath, sourceSessionId: session.sessionId, status: 'skipped' })
        continue
      }
      try {
        const out = await importDiscoveryItem(ctx, session.format, session.sourcePath, [session.sessionId], {
          force: args.force === true,
          budget: budgetInfo.budget,
          budgetSource: budgetInfo.source,
          ...(budgetInfo.clampedFrom !== undefined ? { budgetClampedFrom: budgetInfo.clampedFrom } : {}),
          storeImages: args.storeImages,
        })
        if (out.mode === 'batch') {
          summary.imported += out.imported || 0
          summary.appended += out.appended || 0
          summary.skipped += (out.alreadyImported || 0) + (out.skipped || 0)
          summary.failed += out.failed || 0
        } else if (out.status === 'imported') summary.imported++
        else if (out.status === 'appended') summary.appended++
        else if (out.status === 'failed') summary.failed++
        else summary.skipped++
        summary.results.push({
          format: session.format,
          sourcePath: session.sourcePath,
          sourceSessionId: session.sessionId,
          status: out.status || out.mode,
          result: out,
        })
      } catch (err) {
        summary.failed++
        const error = String((err && err.message) || err)
        if (summary.errors.length < 8) summary.errors.push({ sourcePath: session.sourcePath, error })
        summary.results.push({ format: session.format, sourcePath: session.sourcePath, sourceSessionId: session.sessionId, status: 'failed', error })
      }
    }
  } finally {
    await endRegistryBatch()
  }
  signal?.throwIfAborted?.()
  return summary
}

/**
 * Register the public host service after the import specs have been built.
 * The service returns the same result shape as import_chat, including sessionId
 * for a single import and results for a batch import.
 */
export function registerChatImportService(ctx) {
  if (typeof ctx.provide !== 'function') return

  const registryDir = resolveRegistryDir()

  const service = Object.freeze({
    async scanDiscover(input, signal) {
      const args = objectInput('scanDiscover', input)
      signal?.throwIfAborted?.()
      const result = await runScanDiscover(ctx, args, registryDir)
      signal?.throwIfAborted?.()
      return result
    },
    async importPath(input, signal) {
      validateInput(input)
      signal?.throwIfAborted?.()
      const { format, ...args } = input
      const spec = IMPORT_SPECS.get(format)
      if (!spec) throw new Error('未知格式: ' + format)
      const result = await buildImportExecutor(ctx, spec)(args)
      signal?.throwIfAborted?.()
      return result
    },
    async importAll(input, signal) {
      return runChatImportAll(ctx, registryDir, input, signal)
    },
    async resumeSummary(input, signal) {
      const args = objectInput('resumeSummary', input)
      validateResumeInput(args)
      signal?.throwIfAborted?.()
      const raw = await ctx.fs.readText(await ctx.fs.resolve(args.path))
      signal?.throwIfAborted?.()
      const summarize = args.format === 'claude' ? summarizeClaudeJsonl : summarizeCodexJsonl
      const result = summarize(raw, { sessionId: args.sessionId || null })
      if (!result.lastUserPrompt) throw new Error('会话 ' + (args.sessionId || args.path) + ' 无用户回合可交接')
      signal?.throwIfAborted?.()
      return { format: args.format, sessionId: args.sessionId, ...result }
    },
  })

  ctx.provide(SERVICE_NAME, service)
}
