// lib/command.mjs — REQ-42 /import + REQ-29 /import-all 命令面
//
// 斜杠命令 `/import <source> <path>`（用户触发、不占模型轮次）：解析 source（15 个
// 来源的短名 / 客户端来源 id / 工具全名三态）与 path（单文件或目录/数据根），复用
// 面板同一套导入编排（importDiscoveryItem + IMPORT_SPECS——幂等 / 增量 / force /
// 预算语义与 import_* 工具完全一致）。`/import-all [source]` 扫描默认数据根批量导入
// 未导入/部分导入会话并聚合报告（REQ-29）。commands 是可选 host 服务（headless /
// CLI 会话可能不挂载），经 ctx.inject(['commands']) 延迟注册——服务缺席时命令不可用
// 但插件照常激活（与 webServer 晚挂载同一模式）。handler 执行自动落盘
// command/run + command/done 生命周期事件（官方 commands 服务），满足「模型可见
// ⟺ 落盘」。

import { rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { resolveImportBudget } from './budget.mjs'
import { importDiscoveryItem } from './panel.mjs'
import { runScanDiscover } from './discovery-host.mjs'
import { loadImports, unwrapRecord } from './imports.mjs'
import { attachToWorkspace } from './import-core.mjs'
import { runDoctor } from './doctor.mjs'
import { runMcpMirror } from './mcp.mjs'
import { runSettingsSuggest } from './settings.mjs'
import { clearScanCache, clearInflightScans, SCAN_CACHE_FILE } from './discovery.mjs'

// 命令接受的来源名 → discovery format：短名（claude/codex/...）、客户端来源 id
// （claude-code）、工具全名（import_claude）三态都接受。
const TOOL_FORMAT = {
  claude: 'claude', 'claude-code': 'claude', import_claude: 'claude',
  codex: 'codex', import_codex: 'codex',
  chatgpt: 'chatgpt', import_chatgpt: 'chatgpt',
  cursor: 'cursor', import_cursor: 'cursor',
  gemini: 'gemini', import_gemini: 'gemini',
  reasonix: 'reasonix', import_reasonix: 'reasonix',
  opencode: 'opencode', import_opencode: 'opencode',
  mimocode: 'mimocode', import_mimocode: 'mimocode',
  zcode: 'zcode', import_zcode: 'zcode',
  grokbuild: 'grokbuild', import_grokbuild: 'grokbuild',
  openclaw: 'openclaw', import_openclaw: 'openclaw',
  pi: 'pi', import_pi: 'pi',
  hermes: 'hermes', import_hermes: 'hermes',
  kimi: 'kimi', import_kimi: 'kimi',
  qoder: 'qoder', import_qoder: 'qoder',
  workbuddy: 'workbuddy', import_workbuddy: 'workbuddy',
  dsh: 'dsh', import_dsh: 'dsh',
}

const SOURCE_NAMES = 'claude/codex/chatgpt/cursor/gemini/reasonix/opencode/mimocode/zcode/grokbuild/openclaw/pi/hermes/kimi/qoder/workbuddy/dsh'

// 把导入结果压成人类可读文本（对齐 import_* 工具 render 的语义：批量计数 +
// 前 5 条失败/跳过明细；单文件按 status 区分）。
function summaryText(out) {
  if (out.mode === 'batch') {
    const bits = ['共扫描 ' + out.total + ' 个']
    if (out.imported) bits.push('新增 ' + out.imported)
    if (out.appended) bits.push('续写 ' + out.appended)
    if (out.alreadyImported) bits.push('已存在 ' + out.alreadyImported)
    if (out.skipped) bits.push('跳过 ' + out.skipped)
    if (out.failed) bits.push('失败 ' + out.failed)
    const detail = (out.results || []).filter((r) => r.status === 'failed' || r.status === 'skipped').slice(0, 5)
      .map((r) => '  - ' + r.path + (r.error ? '：' + r.error : r.reason ? '：' + r.reason : ''))
    return '批量导入完成：' + bits.join('，') + (detail.length ? '\n' + detail.join('\n') : '')
  }
  if (out.status === 'skipped' && out.sessionId === 'none') {
    return '跳过导入：' + (out.skipReason || '非目标格式 transcript')
  }
  if (out.status === 'appended') {
    return '会话 ' + out.sessionId + ' 已续写 ' + out.appendedTurns + ' 轮、' + out.appendedEvents + ' 条事件（源文件新增轮次）'
  }
  if (out.alreadyImported) {
    const why = out.sourceShrunk ? '源文件轮次减少（sourceShrunk），需要完整副本请用工具 force:true'
      : out.changedInPlace ? '源文件在既有轮次内变化（append-only 无法改写）'
        : out.argsChanged ? '导入参数已变化（args-changed），需要按新参数导入请用工具 force:true'
          : out.budgetChanged ? '上下文预算已变化（budget-changed），需要按新预算导入请用工具 force:true'
            : '源文件未变化'
    return '会话 ' + out.sessionId + ' 已存在，跳过导入：' + why + '。'
  }
  return '已导入 ' + out.turns + ' 轮对话（' + out.messages + ' 条消息、' + out.toolCalls + ' 次工具调用）→ 会话 ' + out.sessionId
}

export function registerImportCommand(ctx, registryDir) {
  // commands 是可选 host 服务（REQ-29 命令面母项）：headless / 无命令服务的 profile
  // 下回调不执行，插件照常激活（与 webServer 晚挂载同一模式）。
  ctx.inject(['commands'], (cmdCtx) => {
    cmdCtx.commands.register({
      name: 'import',
      description:
        '从外部聊天记录导入历史对话为可继续的 DSH 会话。用法：/import <source> <path>（source ∈ ' + SOURCE_NAMES +
        '；path 为 transcript 文件或会话目录/数据根——单文件导入、目录批量，幂等/增量/force/预算语义与 import_* 工具一致）。',
      input: { hint: '<source> <path>' },
      async handler(invocation) {
        const raw = String(invocation.rawInput || '').trim()
        const m = raw.match(/^(\S+)\s+(.+)$/)
        if (!m) {
          return { kind: 'error', text: '用法：/import <source> <path>（source ∈ ' + SOURCE_NAMES + '）' }
        }
        const format = TOOL_FORMAT[m[1].toLowerCase()]
        if (!format) return { kind: 'error', text: '未知来源: ' + m[1] + '（可用：' + SOURCE_NAMES + '）' }
        const path = m[2].trim()
        try {
          const budgetInfo = await resolveImportBudget(ctx, {})
          const out = await importDiscoveryItem(ctx, format, path, [], {
            budget: budgetInfo.budget,
            budgetSource: budgetInfo.source,
          })
          return { kind: 'success', text: summaryText(out) }
        } catch (err) {
          return { kind: 'error', text: '导入失败：' + String((err && err.message) || err) }
        }
      },
    })
    // REQ-29 /import-all：扫描（可选限定单来源 / 显式路径，缺省该格式默认数据根）
    // 的会话 → 未导入/部分导入逐个导入（复用面板同一编排，幂等/增量语义一致），
    // 返回聚合报告。归档会话跳过（隐藏态，需显式重导）；失败逐条上报（≤5 条），不静默。
    cmdCtx.commands.register({
      name: 'import-all',
      description:
        '一键批导入：扫描全部来源（或指定单一来源）的默认数据根，把未导入/部分导入的会话逐个导入为可继续的 DSH 会话。用法：/import-all [source] [path]（source ∈ ' +
        SOURCE_NAMES + '，留空 = 全部；path 缺省 = 该来源默认数据根）。幂等：已导入跳过、增长续写。',
      input: { hint: '[source] [path]' },
      async handler(invocation) {
        const raw = String(invocation.rawInput || '').trim()
        const parts = raw.split(/\s+/)
        let format
        let path
        if (parts.length > 0 && TOOL_FORMAT[parts[0].toLowerCase()]) {
          format = TOOL_FORMAT[parts[0].toLowerCase()]
          const rest = parts.slice(1).join(' ')
          if (rest) path = rest
        } else if (raw) {
          path = raw // 首 token 不是来源名 → 整体按路径处理（限定该路径的全部格式探测）
        }
        if (parts.length > 0 && !format && !TOOL_FORMAT[parts[0].toLowerCase()] && parts[0]) {
          // 来源名拼写错误但像命令参数 → 提示（避免把 typo 当路径静默扫描）
          const looksLikeSource = SOURCE_NAMES.split('/').some((n) => n.startsWith(parts[0].toLowerCase()))
          if (looksLikeSource) return { kind: 'error', text: '未知来源: ' + parts[0] + '（可用：' + SOURCE_NAMES + '，或留空全部）' }
        }
        try {
          const budgetInfo = await resolveImportBudget(ctx, {})
          const scan = await runScanDiscover(ctx, { format, path }, registryDir)
          const summary = { scanned: scan.total, imported: 0, appended: 0, skipped: 0, failed: 0, errors: [] }
          for (const s of scan.sessions || []) {
            if (s.importStatus === 'imported' || s.importStatus === 'archived') {
              summary.skipped++
              continue
            }
            try {
              const out = await importDiscoveryItem(ctx, s.format, s.sourcePath, [], {
                force: false,
                budget: budgetInfo.budget,
                budgetSource: budgetInfo.source,
              })
              if (out.mode === 'batch') {
                summary.imported += out.imported || 0
                summary.appended += out.appended || 0
                summary.skipped += (out.alreadyImported || 0) + (out.skipped || 0)
                summary.failed += out.failed || 0
              } else if (out.status === 'imported') summary.imported++
              else if (out.status === 'appended') summary.appended++
              else if (out.status === 'failed') summary.failed++
              else summary.skipped++
            } catch (err) {
              summary.failed++
              if (summary.errors.length < 8) {
                summary.errors.push({ sourcePath: s.sourcePath, error: String((err && err.message) || err) })
              }
            }
          }
          const bits = ['扫描 ' + summary.scanned + ' 个会话']
          if (summary.imported) bits.push('新增 ' + summary.imported)
          if (summary.appended) bits.push('续写 ' + summary.appended)
          if (summary.skipped) bits.push('跳过 ' + summary.skipped)
          if (summary.failed) bits.push('失败 ' + summary.failed)
          const detail = summary.errors.slice(0, 5).map((e) => '  - ' + e.sourcePath + '：' + e.error)
          return {
            kind: 'success',
            text: '/import-all 完成：' + bits.join('，') + (detail.length ? '\n' + detail.join('\n') : ''),
          }
        } catch (err) {
          return { kind: 'error', text: '批量导入失败：' + String((err && err.message) || err) }
        }
      },
    })
    // REQ-65 /attach-workspaces：按 imports registry 回填 workspace。对早期未分组或
    // 归组失败的历史导入做可重复修复；复用 attachToWorkspace（cwd 候选 + 源目录回退）。
    cmdCtx.commands.register({
      name: 'attach-workspaces',
      description:
        '按 imports registry 中记录的源路径，把已导入会话重新挂到匹配的 DSH workspace。' +
        '用法：/attach-workspaces [--mode auto|dedicated|per-project] [--dir <path>]。' +
        'auto/per-project 按 cwd 或源文件目录回退；dedicated 把所有导入会话挂到单个工作区（默认 $DSH_HOME/dsh-chat-import-workspace，可用 --dir 覆盖）。' +
        '幂等，重复执行安全。',
      input: { hint: '[--mode auto|dedicated|per-project] [--dir <path>]' },
      async handler(invocation) {
        try {
          const raw = String(invocation.rawInput || '').trim()
          const modeArg = /--mode\s+(\S+)/.exec(raw)
          const dirArg = /--dir\s+(\S+)/.exec(raw)
          const mode = modeArg ? modeArg[1] : 'auto'
          if (!['auto', 'dedicated', 'per-project'].includes(mode)) {
            return { kind: 'error', text: '未知 workspace 模式: ' + mode + '（可选 auto / dedicated / per-project）' }
          }
          const registry = await loadImports(registryDir)
          const entries = Object.entries(registry.imports || {})
          const targets = []
          for (const [sourcePath, entry] of entries) {
            const rec = unwrapRecord(entry)
            if (!rec) continue
            if (rec.kind === 'multi') {
              for (const table of ['conversations', 'sessions']) {
                const subs = rec[table] && typeof rec[table] === 'object' ? rec[table] : {}
                for (const sub of Object.values(subs)) {
                  const r = unwrapRecord(sub)
                  if (r && typeof r.dshId === 'string') targets.push({ sourcePath, dshId: r.dshId })
                }
              }
            } else if (typeof rec.dshId === 'string') {
              targets.push({ sourcePath, dshId: rec.dshId })
            }
          }
          let attached = 0
          let failed = 0
          const errors = []
          if (mode === 'dedicated') {
            const dir = dirArg ? dirArg[1] : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-chat-import-workspace')
            const wr = ctx.get('workspaceRegistry')
            if (!wr || typeof wr.resolveByPath !== 'function' || typeof wr.create !== 'function') {
              throw new Error('workspaceRegistry 不可用，无法使用 dedicated 模式')
            }
            await mkdir(dir, { recursive: true })
            let ws = await wr.resolveByPath(dir)
            if (!ws) ws = await wr.create(dir)
            if (!ws) throw new Error('无法创建 dedicated workspace: ' + dir)
            for (const t of targets) {
              try {
                await ws.attachSession(t.dshId)
                attached++
              } catch (err) {
                failed++
                if (errors.length < 8) errors.push({ dshId: t.dshId, sourcePath: t.sourcePath, error: String((err && err.message) || err) })
              }
            }
          } else {
            for (const t of targets) {
              const ok = await attachToWorkspace(ctx, {}, t.sourcePath)
              if (ok) attached++
              else {
                failed++
                if (errors.length < 8) errors.push({ dshId: t.dshId, sourcePath: t.sourcePath })
              }
            }
          }
          const bits = ['模式 ' + mode, '扫描 ' + targets.length + ' 条导入记录']
          if (attached) bits.push('已挂接 ' + attached)
          if (failed) bits.push('失败 ' + failed)
          const detail = errors.slice(0, 5).map((e) => '  - ' + e.dshId + '（' + e.sourcePath + '）')
          return {
            kind: 'success',
            text: '/attach-workspaces 完成：' + bits.join('，') + (detail.length ? '\n' + detail.join('\n') : ''),
          }
        } catch (err) {
          return { kind: 'error', text: 'attach-workspaces 失败：' + String((err && err.message) || err) }
        }
      },
    })
    // REQ-66 /doctor：迁移后健康检查（只读）
    cmdCtx.commands.register({
      name: 'doctor',
      description:
        '只读健康检查：imports registry、导入会话存在性、skills 落盘、workspaceRegistry 可用性。' +
        '对标 dsh-movein doctor；不写任何文件。',
      input: { hint: '无需参数' },
      async handler() {
        try {
          const out = await runDoctor(ctx, registryDir)
          const bits = ['registry ' + out.totals.records + ' 条', '会话 ' + out.totals.sessions + ' 个', '缺失 ' + out.totals.missingSessions, 'skills ' + out.totals.skills]
          const text = '/doctor：' + (out.ok ? '健康' : '发现 ' + out.issues.length + ' 个问题') + '（' + bits.join('，') + '）'
            + (out.issues.length ? '\n' + out.issues.slice(0, 8).map((i) => '  - ' + i).join('\n') : '')
          return { kind: out.ok ? 'success' : 'error', text }
        } catch (err) {
          return { kind: 'error', text: '/doctor 失败：' + String((err && err.message) || err) }
        }
      },
    })
    // REQ-68 /mcp-status：只读列出 Claude/Codex 发现的 MCP server，并提示 import_mcp
    cmdCtx.commands.register({
      name: 'mcp-status',
      description:
        '只读扫描 Claude .mcp.json / ~/.claude.json 与 Codex config.toml 中的 MCP server，' +
        '列出名称/来源/命令。不写任何文件；需要生成 DSH MCP client 片段请用 import_mcp 工具。',
      input: { hint: '无需参数' },
      async handler() {
        try {
          const out = await runMcpMirror(ctx, {})
          if (out.total === 0) {
            return { kind: 'success', text: '/mcp-status：未发现 MCP server（Claude/Codex 配置为空或不存在）' }
          }
          const lines = out.servers.map((s) => `  - [${s.source}] ${s.name}: ${s.command} ${s.args.join(' ')}`).join('\n')
          return { kind: 'success', text: `/mcp-status：发现 ${out.total} 个 MCP server\n` + lines + '\n用 import_mcp 生成 DSH MCP client 片段。' }
        } catch (err) {
          return { kind: 'error', text: '/mcp-status 失败：' + String((err && err.message) || err) }
        }
      },
    })
    // REQ-71 /settings-suggest：只读列出 Claude/Codex 配置迁移建议
    cmdCtx.commands.register({
      name: 'settings-suggest',
      description:
        '只读解析 Claude settings.json 与 Codex config.toml，列出迁移到 DSH 时的建议与不可直接映射项。' +
        '不写任何文件；需要生成配置时请人工按建议处理。',
      input: { hint: '无需参数' },
      async handler() {
        try {
          const out = await runSettingsSuggest(ctx, {})
          if (out.total === 0) {
            return { kind: 'success', text: '/settings-suggest：未发现可解析的 Claude/Codex 配置（或文件不存在）' }
          }
          const lines = out.suggestions.map((s) => `  - [${s.source}] ${s.key}=${s.value}${s.unmappable ? '（需人工映射）' : ''}: ${s.suggestion}`).join('\n')
          return { kind: 'success', text: `/settings-suggest：${out.total} 条建议\n` + lines }
        } catch (err) {
          return { kind: 'error', text: '/settings-suggest 失败：' + String((err && err.message) || err) }
        }
      },
    })
    // REQ-74（缓存重置）：清空扫描缓存与 scan-cache.json 书签，不删任何已导入会话
    cmdCtx.commands.register({
      name: 'import-reset',
      description:
        '清空扫描缓存（进程内 30s TTL + $DSH_HOME/dsh-chat-import/scan-cache.json 持久书签）。' +
        '已导入会话和 imports registry 不受影响；适合扫描结果疑似过期时强制重扫。',
      input: { hint: '无需参数' },
      async handler() {
        try {
          clearScanCache()
          clearInflightScans()
          const cacheFile = join(registryDir, SCAN_CACHE_FILE)
          try {
            await rm(cacheFile, { force: true })
          } catch {
            // 删除失败不致命；进程内缓存已清
          }
          return { kind: 'success', text: '/import-reset：扫描缓存已清空（已导入会话不受影响）' }
        } catch (err) {
          return { kind: 'error', text: '/import-reset 失败：' + String((err && err.message) || err) }
        }
      },
    })
  })
}
