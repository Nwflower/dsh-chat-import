// lib/import-prefs.mjs — 导入偏好设置（宿主侧命名空间注册 + 读取 + 面板 fenced 路由助手）
//
// 用 DSH 设置命名空间（ctx.settings）承载两个开关：
//   importSystemPrompt —— 是否把源 transcript 的系统提示词作为「上下文注入」导入。
// 默认 true：注入正文已按 dsh 惯例附环境变更声明（工具/权限/执行指令以 DSH 当前
// 会话为准），原文仅作参考附在声明之后；显式 false 保留关闭（仅环境变更声明）。
//   injectTools —— 本插件工具注入对话上下文的档位：'off'（不注入，仅 GUI 面板）/
// 'minimal'（仅注入 import_chat 入口，低频管理型工具不占常驻上下文）/ 'full'（全部
// 13 个工具）。默认 'minimal'：导入是低频需求，常驻成本优先。历史持久化值为 boolean
// （true/false），经 normalizeInjectTools 归一（true→'full'，false→'off'）；schema 用
// any 承载，避免 union 把旧 boolean 吞成默认值。工具注册/注销由 registerTools
// （lib/tools.mjs）返回的 reconcile 经 onInjectToolsChange 驱动（回调值 = 归一后的
// 档位字符串），本模块只负责在 settings 就绪时读取初值 + 订阅变化。
//
// 与 DSH 配置客户端契约（关键）：api-proxy 的 settings RPC 只把「暴露白名单」内的
// 命名空间服务给配置客户端（settingsScope），插件自有命名空间不在其列——客户端设置页
// 读取 / 写入本偏好经面板 fenced 路由（/api-import/prefs，与面板同一信任围栏）走进程
// 内 seam（describe / update），不用 settingsScope（对齐 dsh-better-sidebar 的
// settingsGet / settingsUpdate 模式）。
//
// ctx.settings 是可选宿主服务且可能晚于本插件挂载：注册用 ctx.inject(['settings'])
// 惰性执行（对齐本仓库 webServer 晚挂载的既有姿势），服务缺席 / 注册失败不致命——
// 读取方回退默认，导入照常可用。

import Schema from '@deepseek-ai/schemastery'

export const IMPORT_SETTINGS_NAMESPACE = 'chat-import'

// 命名空间 schema：importSystemPrompt 布尔（缺省 true）；injectTools 用 any 承载三档
// 字符串 + 历史 boolean——union 会把非成员值吞成默认值，破坏 true→'full' 的旧值语义，
// 归一化职责交给 normalizeInjectTools。
const ImportPrefsSchema = Schema.object({
  importSystemPrompt: Schema.boolean().default(true),
  injectTools: Schema.any().default('minimal'),
})

export const IMPORT_PREFS_DEFAULT = { importSystemPrompt: true, injectTools: 'minimal' }

export const INJECT_MODES = ['off', 'minimal', 'full']

// injectTools 档位归一：'off' | 'minimal' | 'full' 原样通过；历史 boolean
// true→'full'、false→'off'；其它形态（undefined / 缺键 / 异常值）回退默认 'minimal'。
export function normalizeInjectTools(value) {
  if (value === 'off' || value === 'minimal' || value === 'full') return value
  if (value === true) return 'full'
  if (value === false) return 'off'
  return 'minimal'
}

// 注册设置命名空间：ctx.inject 惰性挂载（settings 晚于 apply 期也必然命中；无 settings
// 服务的 profile 不执行、不报错）。register 内部已自行把命名空间生命周期挂到插件 fiber
//（SettingsProvider.register 的 ctx.effect），其返回的 owner scope 不是可回收 effect——
// 绝不能作为 inject 回调返回值：cordis 校验回调返回值为「函数/可空/thenable/可迭代」，
// 普通对象会抛 TypeError: Invalid effect，直接报废整个插件 apply（桌面宿主 settings 就绪
// 早、回调同步执行即触发，表现为桌面端启动崩溃；web/headless 下 settings 缺席或晚到、
// 回调不执行所以不崩）。注册抛错（重复命名空间等）记日志、不向外抛。
//
// onInjectToolsChange（可选）在命名空间注册完成后被调用一次（初值对账——含此前已持久化
// boolean 的场景），并在 injectTools 变化时再次调用（值 = normalizeInjectTools 归一后的
// 档位字符串 'off' | 'minimal' | 'full'）。settings 缺席时回调永不触发，工具保持
// registerTools 的默认注入态（CLI/headless 不受影响）。
export function registerImportPrefs(ctx, onInjectToolsChange) {
  ctx.inject(['settings'], (sctx) => {
    try {
      const scope = sctx.settings.register(IMPORT_SETTINGS_NAMESPACE, ImportPrefsSchema)
      if (typeof onInjectToolsChange !== 'function') return
      const injectTools = () => {
        const value = typeof scope.get === 'function' ? scope.get() : undefined
        return normalizeInjectTools(value && typeof value === 'object' ? value.injectTools : undefined)
      }
      onInjectToolsChange(injectTools())
      if (typeof scope.watch === 'function') scope.watch(() => onInjectToolsChange(injectTools()))
    } catch (err) {
      console.error('[dsh-chat-import] settings register failed: ' + String((err && err.message) || err))
    }
  })
}

// 读取导入偏好（缺省 { importSystemPrompt: true, injectTools: 'minimal' }）：ctx.settings
// 缺席 / 命名空间未注册 / 值形态异常时返回默认，不抛错。（导入管线用 settings.get 直读。）
// injectTools 经 normalizeInjectTools 归一（兼容历史 boolean 与异常值，不让降级形态
// 悄悄改回旧行为）。
export function readImportPrefs(ctx) {
  try {
    const settings = ctx.get('settings')
    if (!settings || typeof settings.get !== 'function') return { ...IMPORT_PREFS_DEFAULT }
    const value = settings.get(IMPORT_SETTINGS_NAMESPACE)
    if (!value || typeof value !== 'object') return { ...IMPORT_PREFS_DEFAULT }
    return {
      importSystemPrompt: value.importSystemPrompt !== false,
      injectTools: normalizeInjectTools(value.injectTools),
    }
  } catch {
    return { ...IMPORT_PREFS_DEFAULT }
  }
}

// 面板 fenced 路由读取：describe 拿当前 resolved 值 + revision。settings 缺席 /
// describe 不可用 → 默认值 + available:false（路由据此标注降级，客户端照常渲染）。
export function describeImportPrefs(ctx) {
  try {
    const settings = ctx.get('settings')
    if (!settings || typeof settings.describe !== 'function') {
      return { value: { ...IMPORT_PREFS_DEFAULT }, revision: undefined, available: false }
    }
    const desc = settings.describe({ redactSecrets: true }).find((d) => d && d.ns === IMPORT_SETTINGS_NAMESPACE)
    if (!desc) return { value: { ...IMPORT_PREFS_DEFAULT }, revision: undefined, available: true }
    return {
      value: desc.value && typeof desc.value === 'object' ? desc.value : { ...IMPORT_PREFS_DEFAULT },
      revision: desc.revision,
      available: true,
    }
  } catch {
    return { value: { ...IMPORT_PREFS_DEFAULT }, revision: undefined, available: false }
  }
}

// 面板 fenced 路由写入：settings.update（expectedRevision 冲突保护——命名空间被并发
// 移动时服务抛 SettingsConflictError，由路由转成友好码）。settings 缺席 → 原样返回
// 默认（不持久化，客户端按 available 降级）。
export async function updateImportPrefs(ctx, patch, expectedRevision) {
  const settings = ctx.get('settings')
  if (!settings || typeof settings.update !== 'function') {
    return { value: { ...IMPORT_PREFS_DEFAULT }, revision: undefined, available: false }
  }
  await settings.update(IMPORT_SETTINGS_NAMESPACE, patch, expectedRevision)
  return describeImportPrefs(ctx)
}