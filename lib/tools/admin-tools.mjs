// lib/tools/admin-tools.mjs — 导入相邻的管理型工具：import_agents（agent/skill 资产
// 迁移）/ doctor（只读体检）/ import_mcp（MCP 镜像片段）/ import_settings（配置迁移建议）
//
// 这四个工具都不导入会话；执行体分别在 lib/agents.mjs / lib/doctor.mjs / lib/mcp.mjs /
// lib/settings.mjs，本文件只放工具定义（参数 / 输出 schema / render）。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { runAgentsImport } from '../agents.mjs'
import { runDoctor } from '../doctor.mjs'
import { runMcpMirror } from '../mcp.mjs'
import { runSettingsSuggest } from '../settings.mjs'

function importAgentsTool(ctx) {
  // 外部 agent/mode prompt/skill/config → DSH skills 资产：
  // 非会话导入，独立注册。收集 pi/opencode/Claude/Codex 的自定义 agent / mode prompt /
  // skill / instructions / config，转换为 `$DSH_AGENTS_HOME/skills/<name>/SKILL.md`
  // bundle（provenance frontmatter）。缺省 dry-run 预览（plan 清单零副作用）；
  // apply:true 才写盘。
  return defineTool({
    name: 'import_agents',
    description:
      'Convert custom agent / prompt / skill / config assets from pi, opencode, Claude, and ' +
      'Codex into DSH skill bundles at $DSH_AGENTS_HOME/skills/<name>/SKILL.md. Defaults to ' +
      'dry-run (plan only, zero side effects); apply:true persists. Name clashes get a ' +
      '-<source> suffix; identical content skipped; sources already tagged kind:dsh not re-imported.',
    parameters: {
      apply: {
        type: 'boolean',
        description: 'Optional: true persists the plan to disk (default false = dry-run preview).',
      },
      piRoot: {
        type: 'string',
        description: 'Optional: pi root (default ~/.pi/agent).',
      },
      opencodeRoot: {
        type: 'string',
        description: 'Optional: opencode config root (default ~/.config/opencode).',
      },
      agentsHome: {
        type: 'string',
        description: 'Optional: DSH user-agents root (default $DSH_AGENTS_HOME or ~/.agents).',
      },
      claudeRoot: {
        type: 'string',
        description: 'Optional: Claude config root (default ~/.claude).',
      },
      claudeProjectRoot: {
        type: 'string',
        description: 'Optional: project root (its CLAUDE.md becomes a claude-md asset).',
      },
      codexRoot: {
        type: 'string',
        description: 'Optional: Codex config root (default ~/.codex).',
      },
      preview: {
        type: 'boolean',
        description: 'Optional: explicit dry-run alias.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          planned: { type: 'integer', required: true },
          applied: { type: 'integer', required: true },
          skipped: { type: 'integer', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                source: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                action: { type: 'string', enum: ['write', 'complete', 'skip'], required: true },
                reason: { type: 'string' },
                target: { type: 'string' },
              },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: (value.applied > 0 ? '已落盘：' : '预览（dry-run，未落盘）：')
          + value.total + ' 个候选 → 规划 ' + value.planned + ' 条'
          + (value.applied > 0 ? '（落盘 ' + value.applied + '）' : '')
          + (value.skipped > 0 ? '、跳过 ' + value.skipped : ''),
      }],
    },
    async execute(args) {
      return runAgentsImport(ctx, args)
    },
  })
}

function doctorTool(ctx, registryDir) {
  // doctor：迁移后健康检查。只读，不写任何文件。
  return defineTool({
    name: 'doctor',
    description:
      'Read-only health check for chat-import (registry readable, imported sessions exist, ' +
      'legacy pre-0.8.3 in-log markers issue #34 — repair via panel refresh, skills on disk, ' +
      'workspace registry, stray import session directories on disk that the host cannot read ' +
      'back and would collide with on re-import). Call after migration or when imports look ' +
      'missing. Never writes.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          checks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                ok: { type: 'boolean', required: true },
                detail: { type: 'string' },
              },
            },
          },
          issues: {
            type: 'array',
            required: true,
            items: { type: 'string' },
          },
          totals: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              records: { type: 'integer', required: true },
              sessions: { type: 'integer', required: true },
              missingSessions: { type: 'integer', required: true },
              skills: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: 'doctor: ok=' + value.ok + '\n'
          + (value.checks || []).map((c) => (c.ok ? '[ok] ' : '[!!] ') + c.name + '：' + (c.detail || '')).join('\n')
          + ((value.issues || []).length > 0 ? '\nissues: ' + value.issues.join('; ') : ''),
      }],
    },
    async execute() {
      return runDoctor(ctx, registryDir)
    },
  })
}

function importMcpTool(ctx) {
  // MCP 镜像：Claude/Codex MCP → DSH MCP client 计划。默认 dry-run；
  // apply=true 只把生成 YAML 片段写到 outPath（绝不直接改 profile）。
  return defineTool({
    name: 'import_mcp',
    description:
      'Mirror MCP server configs from Claude and Codex into a reviewable DSH MCP client YAML ' +
      'fragment. Defaults to dry-run (zero writes); apply:true writes the fragment file. Never ' +
      'auto-modifies the profile — review the fragment manually before merging.',
    parameters: {
      claudeMcpPath: {
        type: 'string',
        description: 'Optional: Claude MCP config path (default ~/.claude.json; or project .mcp.json).',
      },
      codexConfigPath: {
        type: 'string',
        description: 'Optional: Codex config.toml path (default ~/.codex/config.toml).',
      },
      apply: {
        type: 'boolean',
        description: 'Optional: true writes the generated fragment (default false = dry-run).',
      },
      outPath: {
        type: 'string',
        description: 'Optional: output path when apply (default $DSH_HOME/dsh-chat-import/mcp-mirror.cordis.yml).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          servers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                source: { type: 'string', required: true },
                name: { type: 'string', required: true },
                command: { type: 'string', required: true },
                args: { type: 'array', required: true, items: { type: 'string' } },
                env: { type: 'object', required: true, additionalProperties: true },
              },
            },
          },
          planText: { type: 'string', required: true },
          writtenTo: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: (value.writtenTo ? '已写入 MCP 镜像片段：' : 'MCP 镜像计划（dry-run，未落盘）：')
          + value.total + ' 个 server'
          + (value.total > 0 ? '\n' + (value.servers || []).map((s) => '  - ' + s.source + '/' + s.name + ' (' + s.command + ')').join('\n') : ''),
      }],
    },
    async execute(args) {
      return runMcpMirror(ctx, args)
    },
  })
}

function importSettingsTool(ctx) {
  // settings/config 翻译建议：Claude settings.json / Codex config.toml → 建议。
  // 只读，不自动应用。
  return defineTool({
    name: 'import_settings',
    description:
      'Read-only migration advice: parse Claude settings.json and Codex config.toml (model / ' +
      'permissions / hooks / env) and suggest DSH equivalents, flagging unmappable items. Never writes.',
    parameters: {
      claudeSettingsPath: {
        type: 'string',
        description: 'Optional: Claude settings.json path (default ~/.claude/settings.json).',
      },
      codexConfigPath: {
        type: 'string',
        description: 'Optional: Codex config.toml path (default ~/.codex/config.toml).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          suggestions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                source: { type: 'string', required: true },
                value: { type: 'string', required: true },
                suggestion: { type: 'string', required: true },
                unmappable: { type: 'boolean', required: true },
              },
            },
          },
          sources: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: '配置建议：' + value.total + ' 条（来源：' + (value.sources || []).join(', ') + '）'
          + (value.total > 0 ? '\n' + value.suggestions.map((s) => '  - [' + s.source + '] ' + s.key + '：' + s.suggestion + (s.unmappable ? '（不可直接映射）' : '')).join('\n') : ''),
      }],
    },
    async execute(args) {
      return runSettingsSuggest(ctx, args)
    },
  })
}

export function makeAdminTools(ctx, registryDir) {
  return [
    importAgentsTool(ctx),
    doctorTool(ctx, registryDir),
    importMcpTool(ctx),
    importSettingsTool(ctx),
  ]
}
