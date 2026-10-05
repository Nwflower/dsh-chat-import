// mcp.test.mjs — MCP 镜像（Claude/Codex → DSH MCP client 计划）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseClaudeMcp, parseCodexMcp, buildMcpPlan, renderMcpPlan, runMcpMirror,
} from '../lib/mcp.mjs'
import { makeFs } from './_support/fake-host.mjs'

test('parseClaudeMcp: 解析 mcpServers command/args/env', () => {
  const json = JSON.stringify({
    mcpServers: {
      filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], env: { KEY: 'VALUE' } },
      noargs: { command: 'echo' },
    },
  })
  const rows = parseClaudeMcp(json)
  assert.equal(rows.length, 2)
  const fsServer = rows.find((r) => r.name === 'filesystem')
  assert.equal(fsServer.source, 'claude')
  assert.equal(fsServer.command, 'npx')
  assert.deepEqual(fsServer.args, ['-y', '@modelcontextprotocol/server-filesystem'])
  assert.deepEqual(fsServer.env, { KEY: 'VALUE' })
})

test('parseCodexMcp: 解析 [mcp_servers.*] command/args/env', () => {
  const toml = `
[mcp_servers.fs]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem"]
env = { KEY = "VALUE" }

[mcp_servers.simple]
command = "echo"
`
  const rows = parseCodexMcp(toml)
  assert.equal(rows.length, 2)
  const fsServer = rows.find((r) => r.name === 'fs')
  assert.equal(fsServer.source, 'codex')
  assert.equal(fsServer.command, 'npx')
  assert.deepEqual(fsServer.args, ['-y', '@modelcontextprotocol/server-filesystem'])
  assert.deepEqual(fsServer.env, { KEY: 'VALUE' })
})

test('buildMcpPlan/renderMcpPlan: 去重并生成 YAML 片段', () => {
  const rows = buildMcpPlan([
    [{ source: 'claude', name: 'fs', command: 'npx', args: [], env: {} }],
    [{ source: 'codex', name: 'fs', command: 'npx', args: [], env: {} }],
  ])
  assert.equal(rows.length, 2) // 同名不同源保留
  const plan = renderMcpPlan(rows)
  assert.match(plan, /# dsh-chat-import MCP mirror/)
  assert.match(plan, /name: dsh-mcp-client/)
  assert.match(plan, /fs:/)
})

test('renderMcpPlan: issue #14 env 值单引号转义（冒号/井号）且文件头含安全提醒', () => {
  const rows = [{ source: 'claude', name: 'gh', command: 'npx', args: [], env: { GITHUB_TOKEN: 'ghp_realSecretValue1234567890', API_KEY: 'sk-abc: #def' } }]
  const plan = renderMcpPlan(rows)
  assert.ok(plan.includes("GITHUB_TOKEN: 'ghp_realSecretValue1234567890'"))
  assert.ok(plan.includes("API_KEY: 'sk-abc: #def'"))
  assert.match(plan, /dsh-mcp-client package installed before merging/)
  assert.match(plan, /replace secrets with \$\{VAR\} references/)
})

test('renderMcpPlan: issue #14 组件 id 按 source+name 唯一（safeId 压缩撞名加后缀）', () => {
  const rows = [
    { source: 'claude', name: 'My Server', command: 'npx', args: [], env: {} },
    { source: 'claude', name: 'my-server', command: 'npx', args: [], env: {} },
    { source: 'codex', name: 'My Server', command: 'npx', args: [], env: {} },
  ]
  const plan = renderMcpPlan(rows)
  const ids = [...plan.matchAll(/- id: (mcp-mirror-[^\n]+)/g)].map((m) => m[1])
  assert.equal(ids.length, 3)
  assert.equal(new Set(ids).size, 3) // 全部唯一
  assert.ok(ids.some((id) => id.startsWith('mcp-mirror-claude-my-server')))
  assert.ok(ids.some((id) => id.startsWith('mcp-mirror-codex-my-server')))
})

test('runMcpMirror: dry-run 零写盘 + apply 只写 outPath', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-'))
  const claudePath = join(root, 'claude-mcp.json')
  const codexPath = join(root, 'config.toml')
  const outPath = join(root, 'mcp-mirror.cordis.yml')
  writeFileSync(claudePath, JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', 'x'] } } }))
  writeFileSync(codexPath, '[mcp_servers.remote]\ncommand = "mcp-remote"\n')
  const ctx = { fs: makeFs({}, { real: true, writeThrough: true }) }
  const dry = await runMcpMirror(ctx, { claudeMcpPath: claudePath, codexConfigPath: codexPath })
  assert.equal(dry.total, 2)
  assert.equal(dry.writtenTo, null)
  assert.ok(!existsSync(outPath))

  const applied = await runMcpMirror(ctx, { claudeMcpPath: claudePath, codexConfigPath: codexPath, apply: true, outPath })
  assert.equal(applied.total, 2)
  assert.equal(applied.writtenTo, outPath)
  assert.ok(existsSync(outPath))
  assert.match(readFileSync(outPath, 'utf8'), /dsh-mcp-client/)
})
