// test/context-bridge.test.mjs — REQ-28 memory / CLAUDE.md / skills 上下文桥接
//
// env DSH_IMPORT_CONTEXT_BRIDGE=1 开启 + 模拟 agent/session-start：断言 memory 与
// CLAUDE.md 注册为 PromptContext（同步 text provider 返回内容）、Claude skills 注册
// 为 skills provider；默认关闭 / 无 cwd 时不注册。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerContextBridge } from '../lib/context-bridge.mjs'
import { makeCtx } from './_support/fake-host.mjs'

async function fireSessionStart(env, cwd, sp, skills) {
  const agent = {
    session: { header: { cwd } },
    ctx: { systemPrompt: sp, skills },
  }
  for (const h of env.listeners.get('agent/session-start') || []) await h({ agent })
}

// 造一个带 memory / skills / CLAUDE.md 的 Claude 家目录与项目根
function seedClaudeHome(claudeHome, cwd) {
  mkdirSync(join(claudeHome, 'memory'), { recursive: true })
  writeFileSync(join(claudeHome, 'memory', 'feedback-code-style.md'), '代码风格：优先小而清晰的函数。', 'utf8')
  writeFileSync(join(claudeHome, 'memory', 'user-preferences.md'), '用户偏好中文回复。', 'utf8')
  mkdirSync(join(claudeHome, 'skills', 'code-review'), { recursive: true })
  writeFileSync(join(claudeHome, 'skills', 'code-review', 'SKILL.md'), '# Code Review\n审查代码时关注边界条件。', 'utf8')
  writeFileSync(join(claudeHome, 'CLAUDE.md'), '# 全局说明\n这是全局 CLAUDE.md。', 'utf8')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'CLAUDE.md'), '# 项目说明\n这是一个演示项目。', 'utf8')
}

function withBridgeEnv(fn) {
  const prev = process.env.DSH_IMPORT_CONTEXT_BRIDGE
  process.env.DSH_IMPORT_CONTEXT_BRIDGE = '1'
  return async () => {
    try {
      await fn()
    } finally {
      if (prev === undefined) delete process.env.DSH_IMPORT_CONTEXT_BRIDGE
      else process.env.DSH_IMPORT_CONTEXT_BRIDGE = prev
    }
  }
}

test('REQ-28 桥接：memory + CLAUDE.md 注册 PromptContext、skills 注册 provider', withBridgeEnv(async () => {
  const env = makeCtx()
  const claudeHome = mkdtempSync(join(tmpdir(), 'dsh-bridge-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-bridge-cwd-'))
  seedClaudeHome(claudeHome, cwd)
  registerContextBridge(env.ctx, { claudeHome })
  const contexts = []
  const providers = []
  const sp = { context: (def) => contexts.push(def) }
  const skills = { registerProvider: (create) => { providers.push(create({})); return () => {} } }
  await fireSessionStart(env, cwd, sp, skills)

  const names = contexts.map((c) => c.name)
  assert.ok(names.includes('claude-bridge-memory'), 'memory context: ' + names)
  assert.ok(names.includes('claude-bridge-claude-md'), 'CLAUDE.md context: ' + names)
  assert.ok(names.includes('claude-bridge-global-claude-md'), 'global CLAUDE.md context: ' + names)
  // memory text provider（同步）返回拼接内容（feedback 组在 user 组前）
  const memDef = contexts.find((c) => c.name === 'claude-bridge-memory')
  const memText = memDef.text()
  assert.ok(memText.includes('feedback-code-style'), 'memory 含 feedback 文件: ' + memText)
  assert.ok(memText.includes('user-preferences'), 'memory 含 user 文件: ' + memText)
  assert.ok(memText.indexOf('feedback-code-style') < memText.indexOf('user-preferences'), 'feedback 排序在 user 前')
  // CLAUDE.md context provider 返回项目说明 + 全局说明
  const mdDef = contexts.find((c) => c.name === 'claude-bridge-claude-md')
  assert.ok(mdDef.text().includes('演示项目'), 'CLAUDE.md 内容: ' + mdDef.text())
  const globalMdDef = contexts.find((c) => c.name === 'claude-bridge-global-claude-md')
  assert.ok(globalMdDef.text().includes('全局 CLAUDE.md'), '全局 CLAUDE.md 内容: ' + globalMdDef.text())

  // skills provider：list 返回 1 个 claude- 前缀候选，get 返回 SKILL.md 内容
  assert.equal(providers.length, 1, 'skills.registerProvider 被调')
  const provider = providers[0]
  assert.equal(provider.name, 'claude-bridge')
  const candidates = await provider.list({})
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].name, 'claude-code-review')
  const def = await provider.get(candidates[0], {})
  assert.ok(def.content.includes('Code Review'), 'SKILL.md 内容: ' + def.content)
}))

test('REQ-28 桥接：默认关闭（env 未设）不注册', async () => {
  delete process.env.DSH_IMPORT_CONTEXT_BRIDGE
  const env = makeCtx()
  const claudeHome = mkdtempSync(join(tmpdir(), 'dsh-bridge-off-'))
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-bridge-off-cwd-'))
  seedClaudeHome(claudeHome, cwd)
  registerContextBridge(env.ctx, { claudeHome })
  const contexts = []
  await fireSessionStart(env, cwd, { context: (def) => contexts.push(def) }, { registerProvider: () => () => {} })
  assert.equal(contexts.length, 0, '默认关闭不注册')
})

test('REQ-28 桥接：无 cwd 的会话不注册', withBridgeEnv(async () => {
  const env = makeCtx()
  const claudeHome = mkdtempSync(join(tmpdir(), 'dsh-bridge-nocwd-'))
  registerContextBridge(env.ctx, { claudeHome })
  const contexts = []
  await fireSessionStart(env, undefined, { context: (def) => contexts.push(def) }, { registerProvider: () => () => {} })
  assert.equal(contexts.length, 0, '无 cwd 不注册')
}))
