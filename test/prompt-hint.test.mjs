// test/prompt-hint.test.mjs — REQ-53 新会话开始迁移提示
//
// mock ctx（真实 node:fs 包装供 discovery host）+ 模拟 agent/session-start：
// cwd 下存在可导入会话 → systemPrompt.context 注册提示 + hints.json 记忆；
// 同一 cwd 只提示一次；无历史 / 无 cwd / env 关闭时不提示。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerSessionHint } from '../lib/prompt-hint.mjs'
import { makeCtx as makeHostCtx } from './_support/fake-host.mjs'

// 最小 codex rollout（首记录 session_meta 带 payload 为格式签名；discovery 识别 + 找到即算可导入）
function codexRollout() {
  return [
    JSON.stringify({ type: 'session_meta', timestamp: '2026-08-14T00:00:00Z', payload: { id: 'rx-1', cwd: '/demo' } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-08-14T00:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }),
  ].join('\n') + '\n'
}

// 真实 node:fs 包装的 ctx（discovery host 读真实临时目录）；listeners 收集 ctx.on 注册的处理器。
function makeCtx() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hint-'))
  const registryDir = join(home, 'dsh-chat-import')
  const host = makeHostCtx(null, { real: true })
  return { ctx: host.ctx, registryDir, sessions: host.persistence.sessions, listeners: host.listeners }
}

// 触发一次 agent/session-start（模拟 Scoped<Agent> payload）；handler 是 async（内部
// await loadHints / discoverSessions），必须 await 完成后再断言。
async function fireSessionStart(env, cwd, contextSpy) {
  const agent = {
    session: { header: { cwd } },
    ctx: { systemPrompt: { context: contextSpy } },
  }
  for (const h of env.listeners.get('agent/session-start') || []) await h({ agent })
}

// 造一个 codex rollout 历史：cwd/.codex 布局——用 path=cwd 扫描时 buildTargets
// 把 cwd 作 codex 的 target，scanFormat 在 target 下找 YYYY/MM/DD/rollout-*.jsonl。
function seedCodexHistory(root) {
  const dir = join(root, '2026', '08', '14')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'rollout-h1.jsonl')
  writeFileSync(file, codexRollout(), 'utf8')
  return file
}

test('REQ-53 迁移提示：cwd 有可导入历史 → 注入提示并记记忆', async () => {
  const env = makeCtx()
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-hint-cwd-'))
  seedCodexHistory(cwd)
  registerSessionHint(env.ctx, env.registryDir)
  const contexts = []
  await fireSessionStart(env, cwd, (def) => contexts.push(def))

  assert.equal(contexts.length, 1, '应注册一条 PromptContext')
  assert.equal(contexts[0].name, 'chat-import-migration-hint')
  assert.ok(contexts[0].text.includes('可导入'), '提示含可导入计数: ' + contexts[0].text)
  assert.ok(contexts[0].text.includes('/import'), '提示指引命令: ' + contexts[0].text)
  // per-project 记忆落盘：hints.json 记 cwd
  const hints = JSON.parse(readFileSync(join(env.registryDir, 'hints.json'), 'utf8'))
  assert.equal(typeof hints[cwd], 'number', 'hints.json 记 cwd')
  // 再次触发同一 cwd → 不再注入（记忆生效）
  await fireSessionStart(env, cwd, (def) => contexts.push(def))
  assert.equal(contexts.length, 1, '同一 cwd 只提示一次')
})

test('REQ-53 迁移提示：无历史的工作区不提示、不写记忆', async () => {
  const env = makeCtx()
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-hint-empty-'))
  registerSessionHint(env.ctx, env.registryDir)
  const contexts = []
  await fireSessionStart(env, cwd, (def) => contexts.push(def))
  assert.equal(contexts.length, 0, '无历史不提示')
  assert.throws(() => readFileSync(join(env.registryDir, 'hints.json')), '不写 hints.json')
})

test('REQ-53 迁移提示：无 cwd 的会话不提示', async () => {
  const env = makeCtx()
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-hint-nocwd-'))
  seedCodexHistory(cwd)
  registerSessionHint(env.ctx, env.registryDir)
  const contexts = []
  await fireSessionStart(env, undefined, (def) => contexts.push(def))
  assert.equal(contexts.length, 0, '无 cwd 不提示')
})

test('REQ-53 迁移提示：DSH_IMPORT_SESSION_HINT=0 关闭', async () => {
  const prev = process.env.DSH_IMPORT_SESSION_HINT
  process.env.DSH_IMPORT_SESSION_HINT = '0'
  try {
    const env = makeCtx()
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-hint-off-'))
    seedCodexHistory(cwd)
    registerSessionHint(env.ctx, env.registryDir)
    const contexts = []
    await fireSessionStart(env, cwd, (def) => contexts.push(def))
    assert.equal(contexts.length, 0, 'env 关闭时不提示')
  } finally {
    if (prev === undefined) delete process.env.DSH_IMPORT_SESSION_HINT
    else process.env.DSH_IMPORT_SESSION_HINT = prev
  }
})

// 短会话（headless 单轮）在发现跑完前就结束：agent scope 失活后读 agent.ctx 的服务会抛
// "cannot get required service … in inactive context"，注册效果会抛 CordisError INACTIVE_EFFECT。
// 服务在第一个 await 前取到；会话已结束则安静放弃（没有可提示的对象，不是故障），也不记
// 记忆——下一个会话照常提示。
test('迁移提示：会话在发现期间结束 → 不告警、不记记忆', async () => {
  const env = makeCtx()
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-hint-ended-'))
  seedCodexHistory(cwd)
  registerSessionHint(env.ctx, env.registryDir)
  let ended = false
  const inactive = Object.assign(new Error('cannot create effect on inactive context'), { code: 'INACTIVE_EFFECT' })
  const agent = {
    session: { header: { cwd } },
    ctx: {
      get systemPrompt() {
        if (ended) throw new Error('cannot get required service "systemPrompt" in inactive context')
        return { context() { if (ended) throw inactive } }
      },
    },
  }
  const warnings = []
  const warn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const runs = (env.listeners.get('agent/session-start') || []).map((h) => h({ agent }))
    ended = true // handler 已同步跑到第一个 await：此后 agent 失活
    await Promise.all(runs)
  } finally {
    console.warn = warn
  }
  assert.deepEqual(warnings, [], '会话已结束不是故障：' + warnings.join(' | '))
  let hints = {}
  try { hints = JSON.parse(readFileSync(join(env.registryDir, 'hints.json'), 'utf8')) } catch { /* 未写记忆文件 */ }
  assert.equal(hints[cwd], undefined, '没提示出去就不记记忆')
})
