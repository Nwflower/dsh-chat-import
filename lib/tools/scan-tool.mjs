// lib/tools/scan-tool.mjs — scan_discover：只读扫描本机各来源默认数据根的会话索引
//
// 发现核心在 lib/discovery.mjs，host 适配在 lib/discovery-host.mjs；本文件只放工具定义。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { FORMATS } from '../discovery.mjs'
import { runScanDiscover } from '../discovery-host.mjs'

export function makeScanTool(ctx, registryDir) {
  const definitions = []
  // 会话发现：只读扫描（发现核心在 lib/discovery.mjs，host 适配见
  // lib/discovery-host.mjs；30s TTL 缓存进程内共享 + 持久化 mtime 书签跨进程免重扫）。
  // 零副作用：不写库、不 create/append，registry 只读 loadImports 供 importStatus
  // 标注（书签文件是缓存元数据，非会话数据）。
  definitions.push(defineTool({
    name: 'scan_discover',
    description:
      'Read-only scan of the local default data roots for all supported chat formats (same ' +
      'enum as import_chat), returning a per-session index (format / title / project / cwd / ' +
      'times / sourcePath / importStatus, etc.) to preview before batch import. path probes ' +
      'one root; default scans all roots (chatgpt has no auto root — point path at ' +
      'conversations.json). query filters title/project/path. Cached: 30s TTL + mtime ' +
      'bookmarks. Zero side effects.',
    parameters: {
      path: {
        type: 'string',
        description: 'Optional: scan root (directory or single file, e.g. ~/.claude/projects or conversations.json). Default scans all format roots.',
      },
      format: {
        type: 'string',
        enum: FORMATS,
        description: 'Optional: scan only this format; default probes all formats by path.',
      },
      query: {
        type: 'string',
        description: 'Optional: substring filter on title / project / path (case-insensitive).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          sessions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                format: { type: 'string', enum: FORMATS, required: true },
                sessionId: { type: 'string', required: true },
                title: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                project: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                createdAt: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                lastActiveAt: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                contextTokens: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                sourcePath: { type: 'string', required: true },
                cwd: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                gitBranch: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                gitDirty: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
                importStatus: { type: 'string', enum: ['imported', 'partial', 'not-imported', 'archived'], required: true },
              },
            },
          },
        },
      },
      render: (args, value) => {
        const byFormat = {}
        for (const s of value.sessions) byFormat[s.format] = (byFormat[s.format] || 0) + 1
        const formatBits = Object.entries(byFormat).map(([f, n]) => f + ' ' + n)
        const imported = value.sessions.filter((s) => s.importStatus === 'imported').length
        const partial = value.sessions.filter((s) => s.importStatus === 'partial').length
        const archived = value.sessions.filter((s) => s.importStatus === 'archived').length
        const pending = value.sessions.filter((s) => s.importStatus === 'not-imported').length
        const statusBits = ['已导入 ' + imported]
        if (partial) statusBits.push('部分 ' + partial)
        if (archived) statusBits.push('已归档 ' + archived)
        statusBits.push('未导入 ' + pending)
        return [{
          type: 'text',
          text: '扫描完成：共发现 ' + value.total + ' 个会话（' + formatBits.join('、') + '；'
            + statusBits.join('、') + '）' + (args.query ? '（query=' + args.query + '）' : ''),
        }]
      },
    },
    async execute(args) {
      return runScanDiscover(ctx, args, registryDir)
    },
  }))
  return definitions[0]
}
