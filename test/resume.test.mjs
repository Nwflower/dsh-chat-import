// resume.test.mjs — REQ-30 交接摘要续聊：纯函数（handoff）+ 命令面（选择/多匹配不猜测）
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { summarizeClaudeJsonl, summarizeCodexJsonl } from '../lib/handoff.mjs'
import { registerResumeCommands } from '../lib/resume-command.mjs'
import { clearScanCache } from '../lib/discovery.mjs'

beforeEach(() => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  clearScanCache()
})

// 合成 Claude transcript（含 thinking 块——摘要必须排除它）。
function claudeTranscript(sessionId, ts, prompt, assistantText, filePath) {
  return [
    JSON.stringify({ type: 'mode', mode: 'normal', sessionId }),
    JSON.stringify({ sessionId, type: 'user', cwd: 'D:\\demo\\proj', message: { role: 'user', content: prompt }, timestamp: ts }),
    JSON.stringify({ sessionId, type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '内部推理，不得外泄', signature: 'x' }, { type: 'text', text: assistantText }, { type: 'tool_use', id: 'call1', name: 'Read', input: { file_path: filePath } }] }, timestamp: ts }),
    JSON.stringify({ sessionId, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call1', content: '文件内容' }] }, timestamp: ts }),
  ].join('\n')
}

test('summarizeClaudeJsonl: 排除 thinking/system，含最后请求/最近回复/涉及文件/停止点', () => {
  const raw = claudeTranscript('sess-h1', '2026-08-01T10:00:00.000Z', '帮我重构 readme', '好的，我先读文件', 'D:\\demo\\proj\\README.md')
  const out = summarizeClaudeJsonl(raw, { sessionId: 'sess-h1' })
  assert.equal(out.lastUserPrompt, '帮我重构 readme')
  assert.equal(out.lastTool, 'Read')
  assert.ok(out.files.includes('D:\\demo\\proj\\README.md'))
  assert.match(out.summary, /# 交接摘要（Claude Code 会话 sess-h1）/)
  assert.match(out.summary, /最后用户请求：帮我重构 readme/)
  assert.match(out.summary, /最近工具调用：Read/)
  assert.match(out.summary, /精确停止点：user @ 2026-08-01T10:00:00/)
  // 安全：thinking 内容绝不出现在摘要里
  assert.ok(!out.summary.includes('内部推理'))
  // 最安全下一步提示存在
  assert.match(out.summary, /最安全下一步/)
})

test('summarizeClaudeJsonl: 畸形行计数、无用户回合返回空 lastUserPrompt', () => {
  const raw = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}\nnot-json\n'
  const out = summarizeClaudeJsonl(raw)
  assert.equal(out.skipped, 1)
  assert.equal(out.lastUserPrompt, '')
  assert.match(out.summary, /解析跳过 1 行/)
})

test('summarizeCodexJsonl: response_item 消息 + function_call 解析', () => {
  const raw = [
    JSON.stringify({ type: 'session_meta', timestamp: '2026-08-01T10:00:00.000Z', payload: { id: 'codex-1' } }),
    JSON.stringify({ timestamp: '2026-08-01T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '修 bug' }] } }),
    JSON.stringify({ timestamp: '2026-08-01T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '定位到了' }] } }),
    JSON.stringify({ timestamp: '2026-08-01T10:00:03.000Z', type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'edit', arguments: '{"file_path":"src/a.ts"}' } }),
  ].join('\n')
  const out = summarizeCodexJsonl(raw, { sessionId: 'codex-1' })
  assert.equal(out.lastUserPrompt, '修 bug')
  assert.equal(out.lastTool, 'edit')
  assert.ok(out.files.includes('src/a.ts'))
  assert.match(out.summary, /# 交接摘要（Codex 会话 codex-1）/)
  assert.ok(!out.summary.includes('output_text'))
})

// ── 命令面：mock commands + 临时 home（os.homedir 读 USERPROFILE/HOME） ──
function makeResumeCtx(tree, commands) {
  const norm = (p) => String(p).replace(/\\/g, '/')
  const fs = {
    async resolve(path) { return { targetKey: path, displayPath: path } },
    lookup(p) {
      const f = norm(p)
      return tree[p] ?? tree[f] ?? tree[f.replace(/\//g, '\\')]
    },
    async stat(target) {
      const v = this.lookup(target.targetKey)
      if (v !== undefined) return v === 'dir' ? { type: 'directory' } : { type: 'file', size: v.length, version: 'v' + v.length }
      return undefined
    },
    async readText(target) {
      const v = this.lookup(target.targetKey)
      if (v === undefined || v === 'dir') throw new Error('FS_NOT_FOUND ' + target.targetKey)
      return v
    },
    async listDir(target) {
      const entries = []
      // 跨平台：tree 键可能用 join() 的正斜杠（Linux）或写死的反斜杠（Windows），统一归一为 / 做前缀匹配
      const normPath = (p) => String(p).replace(/\\/g, '/')
      const prefix = normPath(target.targetKey)
      const base = prefix.endsWith('/') ? prefix : prefix + '/'
      for (const [path, v] of Object.entries(tree)) {
        const n = normPath(path)
        if (n.startsWith(base) && n !== base) {
          const rest = n.slice(base.length)
          if (!rest.includes('/')) entries.push({ name: rest, type: v === 'dir' ? 'directory' : 'file', target: { targetKey: path, displayPath: path } })
        }
      }
      return entries.sort((a, b) => a.name.localeCompare(b.name))
    },
    processPath(target) { return target.targetKey },
  }
  const ctx = {
    fs,
    get() { return undefined },
    inject(serviceList, cb) {
      if (serviceList.every((s) => ctx[s] !== undefined)) cb(ctx)
      return undefined
    },
    commands: { register: (def) => commands.push(def) },
  }
  return ctx
}

function resumeFixtureTree(home) {
  const root = join(home, '.claude', 'projects', 'proj-a')
  const tree = { [join(home, '.claude', 'projects')]: 'dir', [join(home, '.claude', 'projects', 'proj-a')]: 'dir' }
  tree[join(root, 'sess-new.jsonl')] = claudeTranscript('sess-new', '2026-08-02T10:00:00.000Z', '新任务：修登录', '好的', 'D:\\demo\\proj\\login.ts')
  tree[join(root, 'sess-old.jsonl')] = claudeTranscript('sess-old', '2026-08-01T10:00:00.000Z', '旧任务：重构', '好的', 'D:\\demo\\proj\\app.ts')
  tree[join(root, 'sess-similar-a.jsonl')] = claudeTranscript('sess-similar-a', '2026-08-01T09:00:00.000Z', '修登录的密码框', 'ok', 'D:\\demo\\proj\\login.ts')
  tree[join(root, 'sess-similar-b.jsonl')] = claudeTranscript('sess-similar-b', '2026-08-01T08:00:00.000Z', '修登录的验证码', 'ok', 'D:\\demo\\proj\\login.ts')
  return tree
}

test('resume-claude 命令：留空 = 最近会话（时间戳降序）；id: 精确指定', async () => {
  const home = mkdtempSync(join(tmpdir(), 'resume-home-'))
  process.env.USERPROFILE = home
  process.env.HOME = home
  const commands = []
  const ctx = makeResumeCtx(resumeFixtureTree(home), commands)
  registerResumeCommands(ctx, join(process.env.DSH_HOME, 'dsh-chat-import'))
  assert.equal(commands.length, 2)
  const resumeClaude = commands.find((c) => c.name === 'resume-claude')
  const resumeCodex = commands.find((c) => c.name === 'resume-codex')
  assert.ok(resumeClaude)
  assert.ok(resumeCodex)
  // 描述净化（无 REQ-NN / 竞品对标，审计 §1.9）：断言描述不再泄漏开发侧注解
  assert.doesNotMatch(resumeClaude.description, /REQ-\d+|对标/)

  // 留空 → 最近（sess-new，时间戳最新）
  const latest = await resumeClaude.handler({ rawInput: '' })
  assert.equal(latest.kind, 'success')
  assert.match(latest.text, /Claude Code 会话 sess-new/)
  assert.match(latest.text, /新任务：修登录/)

  // id: 精确指定（旧会话）
  const byId = await resumeClaude.handler({ rawInput: 'id:sess-old' })
  assert.equal(byId.kind, 'success')
  assert.match(byId.text, /Claude Code 会话 sess-old/)
  assert.match(byId.text, /旧任务：重构/)

  // 未知 id → error
  const missing = await resumeClaude.handler({ rawInput: 'id:nope' })
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /未找到会话: nope/)
})

test('resume-claude 命令：关键词多匹配列候选不猜测；单匹配直接摘要', async () => {
  const home = mkdtempSync(join(tmpdir(), 'resume-home-'))
  process.env.USERPROFILE = home
  process.env.HOME = home
  const commands = []
  const ctx = makeResumeCtx(resumeFixtureTree(home), commands)
  registerResumeCommands(ctx, join(process.env.DSH_HOME, 'dsh-chat-import'))
  const resumeClaude = commands.find((c) => c.name === 'resume-claude')

  // 多匹配：「修登录」命中 sess-new / sess-similar-a / sess-similar-b → 列候选不猜测
  const multi = await resumeClaude.handler({ rawInput: '修登录' })
  assert.equal(multi.kind, 'success')
  assert.match(multi.text, /匹配 3 个会话，不猜测/)
  assert.match(multi.text, /sess-similar-a/)
  assert.match(multi.text, /id:<会话id>/)
  // 未选择 → 摘要正文（最后用户请求行）不得出现，只列候选
  assert.ok(!multi.text.includes('最后用户请求'))

  // 单匹配：「重构」只命中 sess-old → 直接摘要
  const single = await resumeClaude.handler({ rawInput: '重构' })
  assert.equal(single.kind, 'success')
  assert.match(single.text, /旧任务：重构/)

  // 无匹配 → error
  const none = await resumeClaude.handler({ rawInput: '不存在的话题' })
  assert.equal(none.kind, 'error')
})
