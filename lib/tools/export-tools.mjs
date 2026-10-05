// lib/tools/export-tools.mjs — 出边工具：export_chat（DSH → claude / codex / kimi /
// opencode）/ export_bundle（interchange 便携包）/ restore_bundle（便携包还原）
//
// 执行体在 lib/export-tool.mjs 与 lib/restore.mjs，本文件只放工具定义。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { exportClaudeSession, exportBundleSession, exportCodexSession, exportKimiSession, exportOpencodeSession } from '../export-tool.mjs'
import { restoreBundle, restoreBundleDirectory } from '../restore.mjs'
import { DECISION_REPORT_PROPS, REIMPORTED_SCHEMA } from './schema.mjs'

function exportChatTool(ctx) {
  // 反向导出：DSH 会话日志（只读）→ claude / codex / kimi / opencode 的原生格式，四个目标
  // 共享同一工具面：sessionId 必填、createIfAbsent 不覆盖、dryRun 不写盘、降级逐条报告。
  // claude 分支额外在返回值里给出会话映射（mapping）——只在返回值里，不写 imports registry
  //（导出是可重复的只读动作，见 lib/export-tool.mjs）。
  return defineTool({
    name: 'export_chat',
    description:
      'Serialize a DSH session (read-only, never rewrites history) into an external chat format ' +
      're-importable via import_chat: claude = resumable Claude Code JSONL; codex = rollout ' +
      'JSONL; kimi = Kimi wire.jsonl; opencode = JSON for `opencode import <file>`. dryRun ' +
      'serializes without writing. Returns target path, counts, degradations (claude also the ' +
      'session mapping).',
    parameters: {
      format: {
        type: 'string',
        required: true,
        enum: ['claude', 'codex', 'kimi', 'opencode'],
        description: 'Target format (required): claude=Claude Code JSONL (resumable with --resume); codex=Codex rollout JSONL; kimi=Kimi CLI wire.jsonl; opencode=JSON for `opencode import <file>`.',
      },
      sessionId: {
        type: 'string',
        required: true,
        description: 'DSH session id to export (required).',
      },
      cwd: {
        type: 'string',
        description: 'Optional (claude only): override exported cwd (default session header.cwd; error when neither present).',
      },
      path: {
        type: 'string',
        description: 'Optional (codex/kimi/opencode only): output file path (default <outputDir>/<sessionId>.<ext>).',
      },
      outputDir: {
        type: 'string',
        description: 'Optional: output directory (claude default ~/.claude/projects; codex/kimi/opencode default ~/.dsh/exports).',
      },
      dryRun: {
        type: 'boolean',
        description: 'Optional: true serializes without writing, returning target path and stats.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['single'], required: true },
          sessionId: { type: 'string', required: true },
          filePath: { type: 'string', required: true },
          recordCount: { type: 'integer', required: true },
          dryRun: { type: 'boolean', required: true },
          // claude 分支：sourceSessionId/slug/cwd/title/mapping
          sourceSessionId: { type: 'string' },
          slug: { type: 'string' },
          cwd: { type: 'string' },
          title: { type: 'string' },
          mapping: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sourceSessionId: { type: 'string' },
              sessionUuid: { type: 'string' },
              slug: { type: 'string' },
              filePath: { type: 'string' },
              turns: { type: 'integer' },
              messages: { type: 'integer' },
              toolCalls: { type: 'integer' },
              toolResults: { type: 'integer' },
              droppedToolResults: { type: 'integer' },
              skippedInjections: { type: 'integer' },
              // 图片：images = 读回字节并写进目标格式的块数；
              // unavailableImages = 读不到字节、以 [image] 占位导出的块数
              images: { type: 'integer' },
              unavailableImages: { type: 'integer' },
            },
          },
          // codex / kimi / opencode 分支：toolCalls/toolResults（无 mapping）
          toolCalls: { type: 'integer' },
          toolResults: { type: 'integer' },
          // 降级逐条报告（各目标共享）：有损项（孤儿结果/注入跳过/附件跳过）
          degradations: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                strategy: { type: 'string', enum: ['lossless', 'text-fallback', 'skip-placeholder'], required: true },
                count: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (args, value) => {
        const isClaude = value.mapping !== null && value.mapping !== undefined
        const srcId = isClaude ? value.sourceSessionId : value.sessionId
        const calls = isClaude ? value.mapping.toolCalls : value.toolCalls
        const degNote = (value.degradations || []).map((d) => d.id + ' ' + d.count).join('、')
        return [{
          type: 'text',
          text: (value.dryRun ? '导出预览（dryRun，未写盘）：' : '已导出：')
            + '会话 ' + srcId + ' → ' + value.filePath
            + '（' + value.recordCount + ' 条记录、' + (calls || 0) + ' 次工具调用'
            + (degNote ? '；降级：' + degNote : '') + '）',
        }]
      },
    },
    async execute(args) {
      const { format, ...rest } = args
      if (format === 'claude') return exportClaudeSession(ctx, rest)
      if (format === 'codex') return exportCodexSession(ctx, rest)
      if (format === 'opencode') return exportOpencodeSession(ctx, rest)
      return exportKimiSession(ctx, rest)
    },
  })
}

function exportBundleTool(ctx) {
  // export_bundle / restore_bundle：DSH 会话 → interchange bundle（SHA-256
  // 双层指纹 + 事件级无损 + 跨机器落点信息），还原 = 指纹校验 → convertDshJsonl
  // 状态机（幂等键 = bundle 路径）；跨机器 cwd 不可达走轻量 cwd 回退归组并报告
  //（不静默）。bundle 格式见 docs/INTERCHANGE.md §4。
  return defineTool({
    name: 'export_bundle',
    description:
      'Export a DSH session into a portable interchange bundle: SHA-256 dual checksums ' +
      '(tamper-detectable), event-level lossless (restores to a continuable session), and ' +
      'cross-machine landing info (originalCwd + landingHint). dryRun serializes without ' +
      'writing. Reads logs only, never rewrites history. Returns path, checksums, landing info.',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'DSH session id to export (required).',
      },
      path: {
        type: 'string',
        description: 'Optional: output file path (default <outputDir>/<sessionId>.dshbundle.json).',
      },
      outputDir: {
        type: 'string',
        description: 'Optional: output directory (default ~/.dsh/exports).',
      },
      dryRun: {
        type: 'boolean',
        description: 'Optional: true serializes only, writes nothing.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['single'], required: true },
          sessionId: { type: 'string', required: true },
          filePath: { type: 'string', required: true },
          eventCount: { type: 'integer', required: true },
          dryRun: { type: 'boolean', required: true },
          originalCwd: { type: 'string' },
          landingHint: { type: 'string' },
          sha256: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              session: { type: 'string', required: true },
              bundle: { type: 'string', required: true },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: (value.dryRun ? '导出预览（dryRun，未写盘）：' : '已导出 bundle：')
          + '会话 ' + value.sessionId + ' → ' + value.filePath
          + '（' + value.eventCount + ' 条事件；会话级 ' + value.sha256.session.slice(0, 12) + '…'
          + (value.originalCwd ? '；原 cwd ' + value.originalCwd : '') + '）',
      }],
    },
    async execute(args) {
      return exportBundleSession(ctx, args)
    },
  })
}

function restoreBundleTool(ctx, registryDir) {
  return defineTool({
    name: 'restore_bundle',
    description:
      'Restore an interchange bundle (from export_bundle) into a continuable DSH session. ' +
      'Verifies dual SHA-256 checksums (tampered bundles fail loudly, never silently); ' +
      'idempotency key = bundle path (repeat restores skipped, force saves a copy). ' +
      'Cross-machine: unreachable originalCwd groups into the bundle directory and reports ' +
      'cwdAvailable:false + groupedTo. preview gives a zero-side-effect preview.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Path to the .dshbundle.json bundle file, or a directory of bundles (directory mode restores each).',
      },
      sessionId: {
        type: 'string',
        description: 'Optional: override the restored DSH session id (default import-<source session id>).',
      },
      force: {
        type: 'boolean',
        description: 'Optional: force-restore as a fresh copy under a new id even if already restored.',
      },
      preview: {
        type: 'boolean',
        description: 'Optional: true dry-runs — no writes, returns the would-restore list.',
      },
      dryRun: {
        type: 'boolean',
        description: 'Optional: alias of preview.',
      },
      recursive: {
        type: 'boolean',
        description: 'Optional: recurse in directory mode (default true).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['single', 'batch'], required: true },
          preview: { type: 'boolean' },
          sessionId: { type: 'string' },
          sourceSessionId: { type: 'string' },
          status: { type: 'string', enum: ['imported', 'already-imported', 'appended', 'skipped', 'ignored'] },
          turns: { type: 'integer' },
          messages: { type: 'integer' },
          toolCalls: { type: 'integer' },
          skipped: { type: 'integer' },
          skipReason: { type: 'string' },
          // 预览：会话 header 的 cwd（与 import_chat 预览同口径）
          cwd: { type: 'string' },
          originalCwd: { type: 'string' },
          cwdAvailable: { type: 'boolean' },
          landingHint: { type: 'string' },
          groupedTo: { type: 'string' },
          restoreNote: { type: 'string' },
          title: { type: 'string' },
          createdAt: { type: 'integer' },
          total: { type: 'integer' },
          imported: { type: 'integer' },
          alreadyImported: { oneOf: [{ type: 'boolean' }, { type: 'integer' }] },
          appended: { type: 'integer' },
          failed: { type: 'integer' },
          // 还原与 import_chat 走同一套导入状态机（docs/architecture.md D13 的重导语义、参数 /
          // 预算变化跳过、图片落地、归组、压缩检查点透传……），决策层报告字段共用一份
          ...DECISION_REPORT_PROPS,
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                status: { type: 'string', required: true },
                sessionId: { type: 'string' },
                turns: { type: 'integer' },
                messages: { type: 'integer' },
                toolCalls: { type: 'integer' },
                skipped: { type: 'integer' },
                restoreNote: { type: 'string' },
                cwdAvailable: { type: 'boolean' },
                groupedTo: { type: 'string' },
                ungrouped: { type: 'integer' },
                ungroupedReason: { type: 'string' },
                error: { type: 'string' },
                reason: { type: 'string' },
                storedShrunk: { type: 'boolean' },
                reimported: REIMPORTED_SCHEMA,
              },
            },
          },
        },
      },
      render: (args, value) => {
        if (value.preview === true) {
          return [{
            type: 'text',
            text: '还原预览（dry-run，未落盘）：'
              + (value.title ? '《' + value.title + '》' : '')
              + (value.turns > 0 ? value.turns + ' 轮对话' : '无可导入内容')
              + (value.skipped ? '（跳过 ' + value.skipped + '）' : '')
              + (value.skipReason ? '\n跳过原因：' + value.skipReason : ''),
          }]
        }
        if (value.mode === 'batch') {
          const bits = ['共还原 ' + value.total + ' 个 bundle']
          if (value.imported) bits.push('新增 ' + value.imported)
          if (value.appended) bits.push('续写 ' + value.appended)
          if (value.alreadyImported) bits.push('已存在 ' + value.alreadyImported)
          if (value.skipped) bits.push('跳过 ' + value.skipped)
          if (value.failed) bits.push('失败 ' + value.failed)
          const notes = (value.results || []).filter((r) => r.restoreNote).slice(0, 3).map((r) => '  - ' + r.path + '：' + r.restoreNote)
          return [{
            type: 'text',
            text: '批量还原完成：' + bits.join('，') + (notes.length ? '\n' + notes.join('\n') : ''),
          }]
        }
        if (value.status === 'skipped') {
          return [{ type: 'text', text: '跳过还原：' + (value.skipReason || 'bundle 无内容') }]
        }
        return [{
          type: 'text',
          text: '已还原 ' + value.turns + ' 轮对话（' + value.messages + ' 条消息、' + value.toolCalls + ' 次工具调用）→ 会话 ' + value.sessionId
            + (value.restoreNote ? '\n' + value.restoreNote : ''),
        }]
      },
    },
    async execute(args) {
      const target = await ctx.fs.resolve(args.path)
      const info = await ctx.fs.stat(target)
      if (info && info.type === 'directory') {
        return restoreBundleDirectory(ctx, target, args, { registryDir })
      }
      return restoreBundle(ctx, args, { registryDir })
    },
  })
}

export function makeExportTools(ctx, registryDir) {
  return [
    exportChatTool(ctx),
    exportBundleTool(ctx),
    restoreBundleTool(ctx, registryDir),
  ]
}
