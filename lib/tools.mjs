// lib/tools.mjs — 工具注册门面：构建全部工具定义 + 按 injectTools 档位对账注入
//
// 工具定义按分组住在 lib/tools/：
//   lib/toolkit.mjs              import_chat 分发器（来源 spec 表见 lib/tools/import-sources.mjs）
//   lib/tools/admin-tools.mjs    import_agents / doctor / import_mcp / import_settings
//   lib/tools/export-tools.mjs   export_chat / export_bundle / restore_bundle
//   lib/tools/session-tools.mjs  verify_session / list_imported_sessions / retract_import
//   lib/tools/scan-tool.mjs      scan_discover
//
// registerTools 先构建全部工具定义（makeImportChatTool 同时把 IMPORT_SPECS 落进
// lib/toolkit.mjs，供面板 POST /api-import/import 与 /import 命令复用——与工具是否
// 注入无关，GUI/命令在工具隐藏时照常可用），再按「injectTools」偏好档位对账：
// 'off' 注销全部 / 'minimal' 仅注入 import_chat（低频管理型工具不占常驻上下文）/
// 'full' 注入全部；历史 boolean（true→full / false→off）兼容。本函数尾部默认
// register('full') 兜底 settings 缺席的 CLI/headless，返回 reconcile(mode) 供
// registerImportPrefs 在 settings 就绪/变化时驱动。依赖 ctx（host 服务），非纯函数。

import { TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'
import { makeImportChatTool } from './toolkit.mjs'
import { buildImportSources } from './tools/import-sources.mjs'
import { makeAdminTools } from './tools/admin-tools.mjs'
import { makeExportTools } from './tools/export-tools.mjs'
import { makeSessionTools } from './tools/session-tools.mjs'
import { makeScanTool } from './tools/scan-tool.mjs'

export function registerTools(ctx, registryDir) {
  // 声明 TOOL_RUNTIME_SCHEDULER 命名导入：一旦解析到旧副本 dsh-tools@0.0.1-rc.1
  //（只导出 TOOL_REGISTRY_SCHEDULER），模块加载即失败并大声报错，而不是静默用旧
  // ABI 注册工具、最终让宿主 agent-loop 在调度时崩溃
  //（Cannot read properties of undefined (reading 'prepare')）并污染会话历史。
  if (typeof TOOL_RUNTIME_SCHEDULER !== 'symbol') {
    throw new Error('dsh-chat-import: resolved @deepseek-ai/dsh-tools lacks TOOL_RUNTIME_SCHEDULER — requires >=0.1.0-rc.6 <0.3.0')
  }
  // 工具定义数组：先全部构建（makeImportChatTool 同时把 IMPORT_SPECS 落盘到
  // lib/toolkit.mjs，面板/命令依赖它，与工具注入无关），再统一注册。注入开关
  //（injectTools）只控制 ctx.tools.register 是否执行，构建与 IMPORT_SPECS 恒发生。
  const definitions = [
    makeImportChatTool(ctx, buildImportSources(ctx, registryDir)),
    ...makeAdminTools(ctx, registryDir),
    ...makeExportTools(ctx, registryDir),
    ...makeSessionTools(ctx, registryDir),
    makeScanTool(ctx, registryDir),
  ]
  // 注入档位对账：'off' 注销全部；'minimal' 仅注入 import_chat（低频管理型工具
  // export/bundle/scan 等不进模型上下文，导入能力保留；GUI 面板与 /import 命令
  // 不依赖注入，构建与 IMPORT_SPECS 恒发生）；'full' 注入全部。旧 boolean
  // （true→'full' / false→'off'）由 import-prefs 的 normalizeInjectTools 归一后才到达。
  // reconcile(mode) 由 registerImportPrefs 在 settings 就绪/变化时调用；本函数尾部
  // 默认 register('full') 兜底 settings 缺席的 CLI/headless（行为与旧默认一致）。
  // 兼容历史 boolean 入参：false = 'off'、true = 'full'（'minimal' 为纯新增档）。
  // ctx.tools.register 返回 cordis effect disposer（注销同时触发 tools/change 重新
  // 投影 schema），幂等可重复调用。
  const MINIMAL_TOOLS = new Set(['import_chat'])
  let disposers = null
  const unregister = () => {
    if (disposers === null) return
    const current = disposers
    disposers = null
    for (const dispose of current) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch (err) {
        // 注销失败不打断其它工具（失败要大声——记警告不静默吞）
        console.warn('[dsh-chat-import] 注销工具失败：' + String((err && err.message) || err))
      }
    }
  }
  const register = (mode) => {
    unregister()
    const defs = mode === 'minimal'
      ? definitions.filter((def) => MINIMAL_TOOLS.has(def.name))
      : definitions
    disposers = defs.map((def) => ctx.tools.register(def))
  }
  const reconcile = (mode) => {
    if (mode === 'off' || mode === false) unregister()
    else register(mode === 'minimal' ? 'minimal' : 'full')
  }
  register('full')
  return reconcile
}
