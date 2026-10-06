// lib/mcp.mjs — MCP 镜像（Codex/Claude MCP → DSH MCP client 计划）
//
// 纯函数解析 + 计划生成：
//   parseClaudeMcp(json)   Claude `.mcp.json` / `~/.claude.json` 的 mcpServers
//   parseCodexMcp(toml)    Codex `config.toml` 的 [mcp_servers.*]
//   buildMcpPlan(servers)  归一为 { source, name, command, args, env } 列表
//   renderMcpPlan(servers) 生成可人工审阅/合并的 YAML 片段（不自动改 profile）
//
// 安全边界：默认 dry-run；apply=true 只把生成片段写到 $DSH_HOME/dsh-chat-import/
// mcp-mirror.cordis.yml（或显式 outPath），绝不直接改 profile 的 cordis.patch.yml。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultCodexConfigPath } from './settings.mjs'

function unquote(s) {
  const t = String(s || '').trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
}

/** 简单解析 TOML 数组字符串，如 ["a", "b"]。支持双引号/单引号。 */
export function parseTomlArray(text) {
  const t = String(text || '').trim()
  if (!t.startsWith('[') || !t.endsWith(']')) return []
  const inner = t.slice(1, -1)
  const parts = []
  let cur = ''
  let quote = null
  for (const ch of inner) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (ch === ',') {
      parts.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts.map(unquote)
}

/** 解析 Claude MCP 配置（JSON 对象含 mcpServers）。 */
export function parseClaudeMcp(jsonText) {
  let doc
  try {
    doc = JSON.parse(jsonText)
  } catch {
    return []
  }
  const servers = doc && typeof doc === 'object' && doc.mcpServers && typeof doc.mcpServers === 'object'
    ? doc.mcpServers
    : (doc && typeof doc === 'object' && doc.projects ? doc : {})
  const out = []
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object') continue
    out.push({
      source: 'claude',
      name,
      command: String(cfg.command ?? ''),
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
      env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
    })
  }
  return out
}

/** 解析 Codex config.toml 的 [mcp_servers.*] 简单实现。 */
export function parseCodexMcp(tomlText) {
  const out = []
  let current = null
  for (const rawLine of String(tomlText || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    const section = /^\[mcp_servers\.([^\]]+)\]$/.exec(line)
    if (section) {
      current = { source: 'codex', name: section[1].trim(), command: '', args: [], env: {} }
      out.push(current)
      continue
    }
    if (!current) continue
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1]
    const val = kv[2]
    if (key === 'command') current.command = unquote(val)
    else if (key === 'args') current.args = parseTomlArray(val)
    else if (key === 'env') {
      // 仅解析 { KEY = "value", ... } 形式；复杂嵌套留给人工审阅
      const m = /^\{(.*)\}$/.exec(val)
      if (m) {
        for (const pair of m[1].split(',')) {
          const [k, ...rest] = pair.split('=')
          if (k && rest.length) {
            current.env[k.trim()] = unquote(rest.join('='))
          }
        }
      }
    }
  }
  return out
}

/** 归一化并去重（同名同源保留第一个）。 */
export function buildMcpPlan(serverLists) {
  const seen = new Set()
  const rows = []
  for (const list of serverLists) {
    for (const s of list) {
      const key = s.source + ':' + s.name
      if (seen.has(key)) continue
      seen.add(key)
      rows.push({ ...s })
    }
  }
  return rows
}

/** YAML 单引号标量转义（`'` → `''`）。纯函数。 */
export function yamlSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** 生成可人工合并的 YAML 片段（dsh-mcp-client 行，未验证 schema，仅供参考）。
 * issue #14：env 值统一单引号转义（防 `: ` / `#` 破坏 YAML）；组件 id 按
 * source+name 生成并保证同计划内唯一（safeId 压缩可能撞名）。 */
export function renderMcpPlan(rows) {
  if (rows.length === 0) return '# No MCP servers found\n'
  const lines = [
    '# dsh-chat-import MCP mirror (generated, review before merging)',
    '# Source: Claude .mcp.json / Codex config.toml',
    '# NOTE: verify the profile already has the dsh-mcp-client package installed before merging',
    '# NOTE: env values below are copied verbatim from the source config — replace secrets with ${VAR} references and review before merging',
    '- insert:',
  ]
  const usedIds = new Set()
  for (const row of rows) {
    const safeId = row.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mcp'
    let id = `mcp-mirror-${row.source}-${safeId}`
    let n = 2
    while (usedIds.has(id)) {
      id = `mcp-mirror-${row.source}-${safeId}-${n++}`
    }
    usedIds.add(id)
    lines.push(`    - id: ${id}`)
    lines.push(`      name: dsh-mcp-client`)
    lines.push(`      config:`)
    lines.push(`        servers:`)
    lines.push(`          ${row.name}:`)
    lines.push(`            command: ${row.command}`)
    if (row.args.length > 0) {
      lines.push(`            args: [${row.args.map((a) => JSON.stringify(a)).join(', ')}]`)
    }
    if (Object.keys(row.env || {}).length > 0) {
      lines.push(`            env:`)
      for (const [k, v] of Object.entries(row.env)) {
        lines.push(`              ${k}: ${yamlSingleQuote(v)}`)
      }
    }
  }
  return lines.join('\n') + '\n'
}

/** 默认 Claude MCP 候选路径：~/.claude.json（用户级）与 cwd/.mcp.json（项目级，经 fs）。 */
export function defaultClaudeMcpPath(env = process.env) {
  return join(env.HOME || homedir(), '.claude.json')
}

// Codex config.toml 的默认路径（~/.codex/config.toml）由 lib/settings.mjs 拥有——两个功能
// 读同一份文件，路径口径只留一份。

/** 默认输出路径：$DSH_HOME/dsh-chat-import/mcp-mirror.cordis.yml。 */
export function defaultMirrorOutPath(env = process.env) {
  const base = env.DSH_HOME || join(homedir(), '.dsh')
  return join(base, 'dsh-chat-import', 'mcp-mirror.cordis.yml')
}

/**
 * 入口：读 Claude/Codex MCP 配置 → 生成计划 → 可选写盘（只写生成的 YAML
 * 片段到 outPath，绝不改 profile）。ctx.fs 需要 resolve/readText/writeText。
 * @param {object} ctx host ctx（fs）
 * @param {object} args { claudeMcpPath?, codexConfigPath?, apply?, outPath? }
 * @returns {object} { total, servers, planText, writtenTo? }
 */
export async function runMcpMirror(ctx, args = {}) {
  const claudePath = args.claudeMcpPath || defaultClaudeMcpPath()
  const codexPath = args.codexConfigPath || defaultCodexConfigPath()
  const lists = []
  for (const [path, parse] of [
    [claudePath, parseClaudeMcp],
    [codexPath, parseCodexMcp],
  ]) {
    try {
      const target = await ctx.fs.resolve(path)
      const text = await ctx.fs.readText(target)
      lists.push(parse(text))
    } catch {
      // 缺文件/不可读：静默跳过
    }
  }
  const rows = buildMcpPlan(lists)
  const planText = renderMcpPlan(rows)
  let writtenTo = null
  if (args.apply === true) {
    const out = args.outPath || defaultMirrorOutPath()
    const target = await ctx.fs.resolve(out)
    await ctx.fs.writeText(target, planText)
    writtenTo = out
  }
  return { total: rows.length, servers: rows, planText, writtenTo }
}
