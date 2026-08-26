// lib/resume-command.mjs — REQ-30 交接摘要续聊命令面：/resume-claude /resume-codex
//
// 对标 dsh-resume-plugin：把外部 transcript 当不可信静态历史 → 交接摘要（目标 + 最后
// 请求、相关文件/产物、已完成/未完成、精确停止点、最安全下一步）→ 注入当前会话继续。
// 安全模型：不执行/不复述 system/developer/thinking；摘要生成在 lib/handoff.mjs（纯
// 函数）。选择：留空 = 最近会话（scan_discover 按 lastActiveAt 降序）；id:<会话id> =
// 精确指定；标题关键词 = 匹配（多匹配列候选不猜测，提示用 id 重跑）。commands 是
// 可选 host 服务，经 ctx.inject(['commands']) 延迟注册（headless 缺席时插件照常激活）。

import { runScanDiscover } from './discovery-host.mjs'
import { summarizeClaudeJsonl, summarizeCodexJsonl } from './handoff.mjs'

export function registerResumeCommands(ctx, registryDir) {
  ctx.inject(['commands'], (cmdCtx) => {
    for (const [name, format, summarize, label] of [
      ['resume-claude', 'claude', summarizeClaudeJsonl, 'Claude Code'],
      ['resume-codex', 'codex', summarizeCodexJsonl, 'Codex'],
    ]) {
      cmdCtx.commands.register({
        name,
        description:
          '生成 ' + label + ' 历史会话的交接摘要并注入当前会话：' +
          '把 transcript 当不可信静态历史，提炼目标 + 最后请求、相关文件/产物、已完成/未完成、' +
          '精确停止点、最安全下一步；摘要不含 system/developer/thinking 内容。' +
          '用法：/' + name + ' [id:<会话id> | 标题关键词]（留空 = 最近会话；多匹配列出候选不猜测）。',
        input: { hint: '[id:<会话id> | 标题关键词]' },
        async handler(invocation) {
          const raw = String(invocation.rawInput || '').trim()
          try {
            const scan = await runScanDiscover(ctx, { format }, registryDir)
            const sessions = scan.sessions || []
            if (sessions.length === 0) {
              return { kind: 'error', text: '未发现任何 ' + label + ' 会话（默认数据根为空）' }
            }
            let target
            if (!raw) {
              target = sessions[0] // 已按 lastActiveAt 降序 = 最近
            } else if (raw.startsWith('id:')) {
              const id = raw.slice(3).trim()
              target = sessions.find((s) => s.sessionId === id)
              if (!target) return { kind: 'error', text: '未找到会话: ' + id }
            } else {
              const q = raw.toLowerCase()
              const hits = sessions.filter((s) => s.title && s.title.toLowerCase().includes(q))
              if (hits.length === 0) {
                return { kind: 'error', text: '没有标题匹配「' + raw + '」的会话（可用 id:<会话id> 指定）' }
              }
              if (hits.length > 1) {
                // 多匹配列候选不猜测
                const list = hits.slice(0, 8).map((s, i) => (i + 1) + '. ' + s.sessionId + '（' + s.title + '）').join('\n')
                return {
                  kind: 'success',
                  text: '「' + raw + '」匹配 ' + hits.length + ' 个会话，不猜测，请指定：\n' + list
                    + '\n用法：/' + name + ' id:<会话id>',
                }
              }
              target = hits[0]
            }
            const rawText = await ctx.fs.readText(await ctx.fs.resolve(target.sourcePath))
            const out = summarize(rawText, { sessionId: target.sessionId })
            if (!out.lastUserPrompt) {
              return { kind: 'error', text: '会话 ' + target.sessionId + ' 无用户回合可交接' }
            }
            return { kind: 'success', text: out.summary }
          } catch (err) {
            return { kind: 'error', text: '交接摘要失败：' + String((err && err.message) || err) }
          }
        },
      })
    }
  })
}
