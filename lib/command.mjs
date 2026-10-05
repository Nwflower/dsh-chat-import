// lib/command.mjs — /import + /import-all 命令面
//
// 斜杠命令 `/import <source> <path>`（用户触发、不占模型轮次）：解析 source（来源短名 /
// 客户端来源 id / 工具全名三态）与 path（单文件或目录/数据根），复用工具同一套分发与
// 结果文案（lib/toolkit.mjs 的 importDiscoveryItem、lib/tools/import-render.mjs——幂等 /
// 增量 / force / 预算语义与 import_chat 工具完全一致）。`/import-all [source]` 扫描默认数据根批量导入
// 未导入/部分导入会话并聚合报告。commands 是可选 host 服务（headless /
// CLI 会话可能不挂载），经 ctx.inject(['commands']) 延迟注册——服务缺席时命令不可用
// 但插件照常激活（与 webServer 晚挂载同一模式）。handler 执行自动落盘
// command/run + command/done 生命周期事件（官方 commands 服务），满足「模型可见
// ⟺ 落盘」。

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveImportBudget } from './budget.mjs'
import { CHAT_FORMAT_NAMES, IMPORT_SPECS, importDiscoveryItem } from './toolkit.mjs'
import { renderImportText } from './tools/import-render.mjs'
import { importFileTarget } from './file-import.mjs'
import { readImportPrefs } from './import-prefs.mjs'
import { runScanDiscover } from './discovery-host.mjs'
import { loadImports, listPersistedHeaders, registryEntries, beginRegistryBatch, endRegistryBatch } from './imports.mjs'
import { loadIgnores } from './ignore.mjs'
import { attachPlannedWorkspace, planWorkspaceGroup } from './workspace-group.mjs'
import { runDoctor } from './doctor.mjs'
import { runMcpMirror } from './mcp.mjs'
import { runSettingsSuggest } from './settings.mjs'
import { clearScanCache, clearInflightScans, SCAN_CACHE_FILE } from './discovery.mjs'

// 命令接受的来源名 → import_chat format，由 CHAT_FORMAT_NAMES 派生（新来源自动可用）。三态都
// 接受：短名（claude）、旧工具全名（import_claude）、口语别名（客户端来源 id claude-code；
// auto = local-jsonl 的三级探测）。
const TOOL_FORMAT = Object.fromEntries([
  ...CHAT_FORMAT_NAMES.flatMap((f) => [[f, f], ['import_' + f.replace(/-/g, '_'), f]]),
  ['claude-code', 'claude'],
  ['auto', 'local-jsonl'],
])

const SOURCE_NAMES = [...CHAT_FORMAT_NAMES.filter((f) => f !== 'local-jsonl'), 'auto'].join('/')

export function registerImportCommand(ctx, registryDir) {
  // commands 是可选 host 服务（命令面母项）：headless / 无命令服务的 profile
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
          // auto / local-jsonl：任意本地文件或目录，走面板同一套文件导入编排
          //（三级探测 + 便携包转 restore + 目录批量），不是发现条目的导入路径
          if (format === 'local-jsonl') {
            const out = await importFileTarget(ctx, {
              registryDir,
              path,
              budget: budgetInfo.budget,
              budgetSource: budgetInfo.source,
              importSystemPrompt: readImportPrefs(ctx).importSystemPrompt === true,
            })
            if (out.ok === false) return { kind: 'error', text: '导入失败：' + out.error }
            return { kind: 'success', text: renderImportText(out, IMPORT_SPECS.get(format)) }
          }
          const out = await importDiscoveryItem(ctx, format, path, [], {
            budget: budgetInfo.budget,
            budgetSource: budgetInfo.source,
          })
          return { kind: 'success', text: renderImportText(out, IMPORT_SPECS.get(format)) }
        } catch (err) {
          return { kind: 'error', text: '导入失败：' + String((err && err.message) || err) }
        }
      },
    })
    // /import-all：扫描（可选限定单来源 / 显式路径，缺省该格式默认数据根）
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
          // 批处理通道：/import-all 逐会话的 registry 记录合并为末尾一次提交（此前每会话
          // 一次读-改-写 + fsync，几百会话的批量是 O(N²) I/O）。finally 保证失败也提交。
          beginRegistryBatch(registryDir)
          try {
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
          } finally {
            await endRegistryBatch()
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
    // /attach-workspaces：按 imports registry 回填 workspace。宿主只接受「会话 header 的
    // cwd 与工作区路径相等」的挂接，而 header 是 append-only、改写不了，所以这里按每个会话
    // 的**实际 cwd** 重新规划目标（cwd 命中已有工作区 → 直接挂；cwd 是本机目录 → 建工作区
    // 后挂），其余如实报告未归组。不再回退源文件目录——那条路在宿主上必然被拒，只会留下
    // 空工作区（见 docs/architecture.md D16）。想把 cwd 不在本机的会话归组，只能用
    // force 重导一份（新会话按新 cwd 落组）。
    cmdCtx.commands.register({
      name: 'attach-workspaces',
      description:
        '按 imports registry 中记录的源路径，把已导入会话重新挂到匹配的 DSH workspace（幂等，重复执行安全）。' +
        '用法：/attach-workspaces [--mode auto|dedicated|per-project] [--dir <path>]。' +
        '归组依据是会话自己的 cwd：命中已有工作区 → 挂接；cwd 是本机目录 → 先建工作区再挂；' +
        'cwd 不在本机（跨机器导入）或不可用时如实报告未归组——已落盘会话的 cwd 不可改写，' +
        '要换 cwd 请用 force 重导。',
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
          const workspaceDir = dirArg ? dirArg[1] : undefined
          const registry = await loadImports(registryDir)
          // 归组计划要读被删工作区墓碑：registry 读取已刷新忽略快照，这里显式再读一次，
          // 避免命令在其它入口之后执行时用到过期快照
          await loadIgnores(registryDir)
          // 展开口径统一在 lib/imports.mjs 的 registryEntries（含重导另铸的历史副本）
          const targets = registryEntries(registry.imports).map((e) => ({ sourcePath: e.sourcePath, dshId: e.dshId }))
          const cwdOf = new Map()
          for (const header of await listPersistedHeaders(ctx)) {
            if (header && typeof header.id === 'string') cwdOf.set(header.id, typeof header.cwd === 'string' ? header.cwd : '')
          }
          let attached = 0
          let created = 0
          let failed = 0
          const errors = []
          for (const t of targets) {
            const plan = await planWorkspaceGroup(ctx, { cwd: cwdOf.get(t.dshId) || '' }, t.sourcePath, {
              workspaceMode: mode, workspaceDir, registryDir,
            })
            const res = await attachPlannedWorkspace(ctx, plan, t.dshId)
            if (!res.ok) {
              failed++
              if (errors.length < 8) errors.push({ dshId: t.dshId, sourcePath: t.sourcePath, error: res.reason })
              continue
            }
            attached++
            if (res.created) created++
          }
          const bits = ['模式 ' + mode, '扫描 ' + targets.length + ' 条导入记录']
          if (attached) bits.push('已挂接 ' + attached)
          if (created) bits.push('新建工作区 ' + created)
          if (failed) bits.push('未归组 ' + failed)
          const detail = errors.slice(0, 5).map((e) => '  - ' + e.dshId + '（' + (e.error || '未知原因') + '）')
          return {
            kind: 'success',
            text: '/attach-workspaces 完成：' + bits.join('，') + (detail.length ? '\n' + detail.join('\n') : ''),
          }
        } catch (err) {
          return { kind: 'error', text: 'attach-workspaces 失败：' + String((err && err.message) || err) }
        }
      },
    })
    // /doctor：迁移后健康检查（只读）
    cmdCtx.commands.register({
      name: 'doctor',
      description:
        '只读健康检查：imports registry、导入会话存在性、skills 落盘、workspaceRegistry 可用性、' +
        '磁盘上宿主读不出的残留导入会话目录。不写任何文件。',
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
    // /mcp-status：只读列出 Claude/Codex 发现的 MCP server，并提示 import_mcp
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
    // /settings-suggest：只读列出 Claude/Codex 配置迁移建议
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
    // /import-reset（缓存重置）：清空扫描缓存与 scan-cache.json 书签，不删任何已导入会话
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
