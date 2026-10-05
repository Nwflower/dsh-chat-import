// lib/tools/session-tools.mjs — 已导入会话的管理工具：verify_session（只读结构校验）/
// list_imported_sessions（只读识别）/ retract_import（引导式撤回）
//
// 执行体在 lib/verify.mjs 与 lib/retract.mjs，本文件只放工具定义。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { verifySession } from '../verify.mjs'
import { listImportedSessions, retractImport } from '../retract.mjs'
import { PROBLEM_ITEM_SCHEMA, nullable } from './schema.mjs'

function verifySessionTool(ctx) {
  // 只读结构校验：会话起不来 / 表现异常时定位问题，给出 repair 提示，零副作用。
  return defineTool({
    name: 'verify_session',
    description:
      'Read-only structural validation of a DSH session: seq continuity, turn/step pairing, ' +
      'tool call/result pairing. Use to diagnose a session that fails to resume or misbehaves. ' +
      'Zero side effects. Reports per-item problems plus repairHints (re-import / close ' +
      'half-open turns / source boundary notes).',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'DSH session id to validate (required).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['single'], required: true },
          sessionId: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          eventCount: { type: 'integer', required: true },
          turns: { type: 'integer', required: true },
          title: { type: 'string' },
          problems: { type: 'array', required: true, items: PROBLEM_ITEM_SCHEMA },
          repairHints: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true },
                hint: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: '会话 ' + value.sessionId + '（' + value.turns + ' 轮、' + value.eventCount + ' 条事件）'
          + (value.ok ? '：结构校验通过 ✅'
            : '：发现 ' + value.problems.length + ' 个问题\n'
              + value.problems.slice(0, 10).map((p) => '  - [' + p.kind + '] ' + (p.seq !== null ? 'seq ' + p.seq + '：' : '') + p.message).join('\n')
              + (value.repairHints.length ? '\n修复建议：\n' + value.repairHints.map((h) => '  - ' + h.kind + '：' + h.hint).join('\n') : '')),
      }],
    },
    async execute(args) {
      return verifySession(ctx, args)
    },
  })
}

function listImportedSessionsTool(ctx, registryDir) {
  // 导入识别 / 撤回（只读）：平台无 delete 面（sessionPersistence.remove /
  // fs.removeFile 未提供，见 lib/retract.mjs 段落）——list_imported_sessions 只读
  // 识别（imports registry 反查为权威，旧日志标记兜底），retract_import 移除 registry
  // 记录 + 引导手动删工件，绝不调用任何删除。
  return defineTool({
    name: 'list_imported_sessions',
    description:
      'Read-only listing of every DSH session imported by this plugin (imports registry ' +
      'authoritative; older logs matched by the session/imported marker). Returns sessionId / ' +
      'title / sourcePath / artifactPath / importedAt per hit. Zero side effects.',
    parameters: {},
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
                sessionId: { type: 'string', required: true },
                title: { type: 'string' },
                sourcePath: { ...nullable('string'), required: true },
                artifactPath: { ...nullable('string'), required: true },
                importedAt: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: '已识别导入会话 ' + value.total + ' 个' + (value.total === 0 ? '' : '\n' + value.sessions.map((s) =>
          '  - ' + s.sessionId + (s.title ? '《' + s.title + '》' : '') + ' ← ' + s.sourcePath
          + '\n    工件路径：' + (s.artifactPath || '无（后端无单会话工件）')).join('\n')),
      }],
    },
    async execute() {
      return listImportedSessions(ctx, registryDir)
    },
  })
}

function retractImportTool(ctx, registryDir) {
  return defineTool({
    name: 'retract_import',
    description:
      'Guided un-import (read-only): drop an imported session from the imports registry and ' +
      'print manual-delete steps for its artifact; never deletes anything itself. Address by ' +
      'sessionId (registry / legacy in-log marker) or sourcePath (direct removal). A remaining ' +
      'artifact copy re-imports as idempotent backfill; stale ghost ids auto-cast a suffixed ' +
      'new id (staleGhost).',
    parameters: {
      sessionId: {
        type: 'string',
        description: 'DSH session id to retract (alternative to sourcePath; source file located via log marker / registry).',
      },
      sourcePath: {
        type: 'string',
        description: 'Source file path to retract (alternative to sessionId; directly removes the registry record by idempotency key).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'boolean', required: true, const: true },
          sourcePath: { type: 'string', required: true },
          artifactPath: { ...nullable('string'), required: true },
          wasRegistered: { type: 'boolean', required: true },
          manualDelete: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: '已撤回：registry 记录 ' + value.sourcePath + ' 已移除'
          + (value.wasRegistered ? '' : '（此前已移除，幂等）') + '。\n' + value.manualDelete,
      }],
    },
    async execute(args) {
      return retractImport(ctx, args, registryDir)
    },
  })
}

export function makeSessionTools(ctx, registryDir) {
  return [
    verifySessionTool(ctx),
    listImportedSessionsTool(ctx, registryDir),
    retractImportTool(ctx, registryDir),
  ]
}
