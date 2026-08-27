// lib/import-prefs.mjs — 导入偏好设置（宿主侧命名空间注册 + 读取 + 面板 fenced 路由助手）
//
// 用 DSH 设置命名空间（ctx.settings）承载一个开关：
//   importSystemPrompt —— 是否把源 transcript 的系统提示词作为「上下文注入」导入。
// 默认 false（保持既有过滤行为：system/developer/harness 注入一律丢弃）。
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

// 命名空间 schema：importSystemPrompt 布尔、缺省 false（继承 schema 默认，无需 base）。
const ImportPrefsSchema = Schema.object({
  importSystemPrompt: Schema.boolean().default(false),
})

export const IMPORT_PREFS_DEFAULT = { importSystemPrompt: false }

// 注册设置命名空间：ctx.inject 惰性挂载（settings 晚于 apply 期也必然命中；无 settings
// 服务的 profile 不执行、不报错）。效果挂插件 fiber（dispose 即移除）。
export function registerImportPrefs(ctx) {
  ctx.inject(['settings'], (sctx) => {
    try {
      return sctx.settings.register(IMPORT_SETTINGS_NAMESPACE, ImportPrefsSchema)
    } catch (err) {
      console.error('[dsh-chat-import] settings register failed: ' + String((err && err.message) || err))
      return undefined
    }
  })
}

// 读取导入偏好（缺省 { importSystemPrompt: false }）：ctx.settings 缺席 / 命名空间未
// 注册 / 值形态异常时返回默认，不抛错。（导入管线用 settings.get 直读。）
export function readImportPrefs(ctx) {
  try {
    const settings = ctx.get('settings')
    if (!settings || typeof settings.get !== 'function') return { ...IMPORT_PREFS_DEFAULT }
    const value = settings.get(IMPORT_SETTINGS_NAMESPACE)
    if (!value || typeof value !== 'object') return { ...IMPORT_PREFS_DEFAULT }
    return { importSystemPrompt: value.importSystemPrompt === true }
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