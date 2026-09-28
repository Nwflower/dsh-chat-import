// lib/ignore-command.mjs — 忽略表命令面：/ignores、/unignore、/ignore。
//
// 忽略由 ignore-watch 自动登记（归档 / 删工作区）与 retract/purge 自动登记
// （撤回 / 删除），命令面只负责查看与手动解除/新增；commands 是可选 host 服务，
// 无命令服务的 profile 下回调不执行，插件照常激活（与其他命令模块同一模式）。
import { findSourceEntryByDshId, loadImports } from './imports.mjs'
import { forgetIgnore, forgetIgnoreByDshId, forgetWorkspaceIgnore, listIgnores, loadIgnores, rememberIgnore, sourceIgnoreKey } from './ignore.mjs'

const REASON_LABEL = {
  archived: '已归档',
  retracted: '已删除/撤回',
  'workspace-deleted': '工作区已删',
}

function describe(entry) {
  const reason = REASON_LABEL[entry.reason] || entry.reason || '未知'
  if (entry.kind === 'workspace') return '工作区 ' + entry.key + '（' + reason + '，恢复条件：新会话或取消归档）'
  return entry.key + '（' + reason + (entry.dshId ? '，会话 ' + entry.dshId : '') + '）'
}

export function registerIgnoreCommand(ctx, registryDir) {
  ctx.inject(['commands'], (cmdCtx) => {
    cmdCtx.commands.register({
      name: 'ignores',
      description: '列出被忽略的导入源：归档 / 删除 / 删工作区时自动登记，重扫会跳过它们。',
      async handler() {
        try {
          const ignores = await loadIgnores(registryDir)
          const items = listIgnores(ignores)
          if (items.length === 0) return { kind: 'success', text: '忽略表为空：没有会被跳过的导入源。' }
          return { kind: 'success', text: '已忽略 ' + items.length + ' 条：\n- ' + items.map(describe).join('\n- ') + '\n\n解除：/unignore <sessionId|sourcePath|all>' }
        } catch (err) {
          return { kind: 'error', text: '读取忽略表失败：' + String((err && err.message) || err) }
        }
      },
    })

    cmdCtx.commands.register({
      name: 'unignore',
      description: '解除忽略（恢复某个源/会话可被导入；all = 清空忽略表）。用法：/unignore <sessionId|sourcePath|all>',
      input: { hint: '<sessionId|sourcePath|all>' },
      async handler(invocation) {
        const token = String(invocation.rawInput || '').trim()
        if (!token) return { kind: 'error', text: '用法：/unignore <sessionId|sourcePath|all>' }
        try {
          if (token.toLowerCase() === 'all') {
            const ignores = await loadIgnores(registryDir)
            for (const key of Object.keys(ignores.sources)) await forgetIgnore(registryDir, key)
            for (const cwd of Object.keys(ignores.workspaces)) await forgetWorkspaceIgnore(registryDir, cwd)
            return { kind: 'success', text: '已清空忽略表。' }
          }
          if (token.startsWith('session-') || token.startsWith('import-')) {
            const registry = await loadImports(registryDir)
            const entry = findSourceEntryByDshId(registry.imports, token)
            if (!entry) return { kind: 'error', text: '会话不在 imports registry（不是本插件导入的会话）：' + token }
            await forgetIgnore(registryDir, sourceIgnoreKey(entry.sourcePath, entry.subTable, entry.subKey))
            await forgetIgnoreByDshId(registryDir, token)
            return { kind: 'success', text: '已解除忽略：' + token }
          }
          // 路径（或工作区 cwd）：源键与工作区记录都尝试解除
          await forgetIgnore(registryDir, token)
          await forgetIgnoreByDshId(registryDir, token)
          await forgetWorkspaceIgnore(registryDir, token)
          return { kind: 'success', text: '已解除忽略（若存在）：' + token }
        } catch (err) {
          return { kind: 'error', text: '解除忽略失败：' + String((err && err.message) || err) }
        }
      },
    })

    cmdCtx.commands.register({
      name: 'ignore',
      description: '手动忽略一个源/会话，之后重扫不会导入它。用法：/ignore <sessionId|sourcePath>',
      input: { hint: '<sessionId|sourcePath>' },
      async handler(invocation) {
        const token = String(invocation.rawInput || '').trim()
        if (!token) return { kind: 'error', text: '用法：/ignore <sessionId|sourcePath>' }
        try {
          const registry = await loadImports(registryDir)
          const byPath = Object.prototype.hasOwnProperty.call(registry.imports, token)
          const byId = byPath ? null : findSourceEntryByDshId(registry.imports, token)
          if (!byPath && !byId) {
            return { kind: 'error', text: '不是本插件导入的源或会话：' + token + '（手动忽略未导入的源暂不支持）' }
          }
          if (byPath) {
            await rememberIgnore(registryDir, { key: token, reason: 'retracted' })
          } else {
            await rememberIgnore(registryDir, {
              key: sourceIgnoreKey(byId.sourcePath, byId.subTable, byId.subKey),
              reason: 'retracted',
              dshId: token,
              sourcePath: byId.sourcePath,
            })
          }
          return { kind: 'success', text: '已忽略：' + token }
        } catch (err) {
          return { kind: 'error', text: '忽略失败：' + String((err && err.message) || err) }
        }
      },
    })
  })
}
