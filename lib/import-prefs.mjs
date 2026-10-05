// lib/import-prefs.mjs — 导入偏好设置（宿主两代设置模型同一套代码，见 docs/architecture.md D10）
//
// 三个开关：
//   importSystemPrompt —— 是否把源 transcript 的系统提示词作为「上下文注入」导入。默认 true：
//     注入正文按 dsh 惯例附环境变更声明（工具/权限/执行指令以 DSH 当前会话为准），原文仅作
//     参考附在声明之后；显式 false 只留环境变更声明。
//   injectTools —— 本插件工具注入对话上下文的档位：'off'（不注入，仅 GUI 面板与命令）/
//     'minimal'（默认，仅注入 import_chat 入口——导入是低频需求，常驻上下文成本优先）/
//     'full'（全部工具）。持久化值也可能是 boolean，经 normalizeInjectTools 归一（true→'full'，
//     false→'off'）；schema 用 any 承载，避免 union 把 boolean 吞成默认值。工具注册/注销由
//     registerTools（lib/tools.mjs）返回的 reconcile 经 onInjectToolsChange 驱动（回调值 =
//     归一后的档位），本模块只负责在 settings 就绪时读初值 + 订阅变化。
//   sidebarButton —— 侧栏入口开关。
//
// ── 宿主设置模型（按能力探测绑定，两条路径收敛到同一个「值 + revision」模型）────────────
//   forms  —— 条目模型（DSH 0.1.7+）：命名空间 = profile 里本插件条目的 id，schema = 插件入口
//             导出的 Config（loader 校验）。settings.describe() 名单含本插件**裸条目 id** 即走
//             describe / update，并 settings.configure({ auto: false }) 声明本插件自带设置页
//             （宿主不另生成自动页）。
//   legacy —— 命名空间注册模型（DSH 0.1.5 及更早）：settings 服务有 register / get，插件按
//             自持命名空间 'chat-import' 注册 schema。
//   none   —— 两者皆无 → 读回默认、写不持久化（available:false），导入照常。
//
// 条目 id 契约：条目模型的 loader 把 ctx.fiber.entry.id 报成 "<kind>:<id>"（如
// insert:import-claude），设置服务却按裸 id 建索引——带前缀写会得到 409 settings-conflict。
// entryIdOf() 取最后一个 ':' 之后的部分，拿不到时回退 patch 里声明的 import-claude。
//
// schemastery 解析契约：插件常以软链 / 本地 link 装进 profile，其自身 require 锚点下不一定
// 有 @deepseek-ai/schemastery，故解析锚点优先**运行中的 harness bin**（旁边必带它），再退回
// 本模块自身。解析不到时不抛：Config 缺席只会让条目模型下本条目不出现在设置名单里，插件其余
// 功能照常（legacy 注册同样跳过）。
//
// 与 DSH 配置客户端的契约：api-proxy 的 settings RPC 只把「暴露白名单」内的命名空间服务给
// 配置客户端（settingsScope），插件自有命名空间不在其列——客户端设置页经面板 fenced 路由
// （/api-import/prefs，与面板同一信任围栏）走进程内 seam（describe / update）读写本偏好。
//
// ctx.settings 是可选宿主服务且可能晚于本插件挂载：注册用 ctx.inject(['settings']) 惰性执行，
// 服务缺席 / 注册失败不致命——读取方回退默认，导入照常可用。

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

// schemastery 解析：优先运行中的 harness bin，再退回本模块自身的解析锚点。同步解析，供模块
// 顶层的 Config 导出使用；失败返回 undefined（不抛，插件照常加载）。
function loadSchemastery() {
  const anchors = []
  const argv1 = typeof process !== 'undefined' && process.argv ? process.argv[1] : undefined
  if (typeof argv1 === 'string' && argv1 !== '') {
    try { anchors.push(pathToFileURL(argv1).href) } catch { /* 非法 argv[1]：跳过该锚点 */ }
  }
  anchors.push(import.meta.url)
  for (const anchor of anchors) {
    try {
      const mod = createRequire(anchor)('@deepseek-ai/schemastery')
      if (mod) return mod.default || mod
    } catch { /* 该锚点解析不到：试下一个 */ }
  }
  return undefined
}

const Schema = loadSchemastery()

// .volatile() 只存在于条目模型宿主自带的 schemastery——Config 只对条目模型有意义，在没有它的
// schemastery 上构造会在模块加载期抛 "volatile is not a function"。探测后才构造：没有时 Config
// 为 undefined，走 legacy 注册路径。
function supportsVolatile(S) {
  if (!S) return false
  try { return typeof S.boolean().volatile === 'function' } catch { return false }
}

// legacy 模型的自持命名空间；条目模型的命名空间是 profile 条目 id。
export const IMPORT_SETTINGS_NAMESPACE = 'chat-import'
// patch 里声明的条目 id（cordis.patch.yml），ctx.fiber.entry.id 拿不到时的回退。
export const IMPORT_ENTRY_ID_FALLBACK = 'import-claude'

// 条目模型的 Config：字段都标 volatile 才可经 settings.update 编辑（宿主只把 volatile 字段
// 投影成设置表单；写非 volatile 字段会报 "is not volatile"）。injectTools 用 any 承载三档
// 字符串 + boolean，归一化交给 normalizeInjectTools。
export const Config = supportsVolatile(Schema)
  ? Schema.object({
      importSystemPrompt: Schema.boolean().default(true).volatile(),
      injectTools: Schema.any().default('minimal').volatile(),
      sidebarButton: Schema.boolean().default(true).volatile(),
    })
  : undefined

// legacy 模型的注册 schema（同字段，无 volatile——该模型由注册者自行管理生命周期）。
const LegacyImportPrefsSchema = Schema
  ? Schema.object({
      importSystemPrompt: Schema.boolean().default(true),
      injectTools: Schema.any().default('minimal'),
      sidebarButton: Schema.boolean().default(true),
    })
  : undefined

export const IMPORT_PREFS_DEFAULT = { importSystemPrompt: true, injectTools: 'minimal', sidebarButton: true }

export const INJECT_MODES = ['off', 'minimal', 'full']

// injectTools 档位归一：'off' | 'minimal' | 'full' 原样通过；boolean true→'full'、
// false→'off'；其它形态（undefined / 缺键 / 异常值）回退默认 'minimal'。
export function normalizeInjectTools(value) {
  if (value === 'off' || value === 'minimal' || value === 'full') return value
  if (value === true) return 'full'
  if (value === false) return 'off'
  return 'minimal'
}

// 本插件在宿主设置服务里的**裸条目 id**（见文件头「条目 id 契约」）：取最后一个 ':' 之后的
// 部分；拿不到时回退 patch 里声明的 id。没有前缀时是无操作。
export function entryIdOf(ctx) {
  let id
  try { id = ctx && ctx.fiber && ctx.fiber.entry && ctx.fiber.entry.id } catch { id = undefined }
  if (typeof id === 'string' && id !== '') {
    const colon = id.lastIndexOf(':')
    return colon === -1 ? id : id.slice(colon + 1)
  }
  return IMPORT_ENTRY_ID_FALLBACK
}

// 每个 ctx 的绑定解析结果（settings 服务在场时缓存；服务可能晚挂载，缺席不缓存）。
const prefsBindings = new WeakMap()

/**
 * 解析本插件的设置绑定：条目模型（forms）/ 命名空间注册模型（legacy）/ 无服务（none）。
 * @param ctx - 插件上下文
 * @param settingsOverride - 已拿到的 settings 服务（registerImportPrefs 的 inject 回调
 *   直接持有 sctx.settings；ctx.get 缺席的测试/嵌入场景也据此解析）
 * @returns {{ mode: 'forms'|'legacy'|'none', ns: string|undefined, settings: object|undefined }}
 */
export function resolvePrefsBinding(ctx, settingsOverride) {
  const cached = prefsBindings.get(ctx)
  if (cached) return cached
  let settings = settingsOverride
  if (!settings) {
    try {
      settings = ctx && typeof ctx.get === 'function' ? ctx.get('settings') : undefined
    } catch {
      settings = undefined
    }
  }
  let binding
  if (!settings) {
    binding = { mode: 'none', ns: undefined, settings: undefined }
  } else {
    const hasDescribe = typeof settings.describe === 'function'
    const hasRegister = typeof settings.register === 'function'
    // legacy 模型的 settings 有 get，条目模型没有：有 get 即 legacy，无需 register 也在场。
    const hasGet = typeof settings.get === 'function'
    const entryId = entryIdOf(ctx)
    let listed = false
    if (hasDescribe) {
      try {
        listed = settings.describe({ redactSecrets: true }).some((d) => d && d.ns === entryId)
      } catch {
        listed = false
      }
    }
    if (listed) binding = { mode: 'forms', ns: entryId, settings }
    else if (hasRegister || hasGet) binding = { mode: 'legacy', ns: IMPORT_SETTINGS_NAMESPACE, settings }
    else binding = { mode: 'none', ns: entryId, settings }
  }
  // 只缓存确定结果：settings 在场却解析成 none，多半是「本条目此刻还没进 describe 名单」——
  // apply 期 fiber 还是 state 1（cordis _setEpoch → _reload 期间），settings.describe() 会跳过
  // 本条目，apply 结束（state 2）后才看得到。缓存 none 会让之后所有读取都停在 none；不缓存
  // 则后续读取重新解析、自然落到 forms，真不可配置时只是每次多一次 describe()。
  if (settings && binding.mode !== 'none') prefsBindings.set(ctx, binding)
  return binding
}

// 在 settings.describe() 的名单里找本命名空间的描述子（forms / legacy 共用）。
function findDescriptor(binding) {
  if (!binding.settings || typeof binding.settings.describe !== 'function') return undefined
  try {
    return binding.settings.describe({ redactSecrets: true }).find((d) => d && d.ns === binding.ns)
  } catch {
    return undefined
  }
}

// 读当前原始值：legacy 优先 settings.get（该模型有 get）；forms 走 describe（无 get）。
function readRawValue(binding) {
  if (binding.mode === 'legacy' && binding.settings && typeof binding.settings.get === 'function') {
    try {
      const value = binding.settings.get(binding.ns)
      if (value && typeof value === 'object') return value
    } catch { /* 读失败 → 退回 describe / 默认，不抛 */ }
  }
  const desc = findDescriptor(binding)
  return desc && desc.value && typeof desc.value === 'object' ? desc.value : undefined
}

// 注册设置：ctx.inject 惰性挂载（settings 晚于 apply 期也必然命中；无 settings 服务的
// profile 不执行、不报错）。回调**不返回**任何值：cordis 校验回调返回值为「函数/可空/
// thenable/可迭代」，返回普通对象会抛 TypeError: Invalid effect——legacy 模型的 register
// 返回的 owner scope 正是这种对象，所以它的返回值不能作为回调结果透出。
//
// onInjectToolsChange（可选）在绑定就绪后被调用一次（初值对账——含持久化为 boolean 的值），
// 并在 injectTools 变化时再次调用（值 = normalizeInjectTools 归一后的档位）。settings 缺席时
// 回调永不触发，工具保持 registerTools 的默认注入态。
//
// 初值来源优先**插件自己的 config**（apply(ctx, config) 的第二个参数）：条目模型下 volatile
// 字段是实时引用，loader 在设置写入时用 updateVolatile 原地更新并发出 loader/volatile-update
// ——apply 期 settings.describe() 会跳过本条目，只有 config 读得到。变更通知因此有两条：
// loader/volatile-update（本 fiber 精确）与 settings/document-updated（设置服务广播）；
// reconcile 幂等，重复触发无害。
export function registerImportPrefs(ctx, onInjectToolsChange, config) {
  ctx.inject(['settings'], (sctx) => {
    try {
      const settings = sctx && sctx.settings
      const binding = resolvePrefsBinding(ctx, settings)
      if (binding.mode === 'none' && !(settings && typeof settings.describe === 'function')) return
      // 初值：优先插件 config 的 volatile 引用；缺失时退回 settings 读。
      const fromConfig = () => {
        const ref = config && config.injectTools
        return ref && typeof ref.get === 'function' ? normalizeInjectTools(ref.get()) : undefined
      }
      const fromBinding = () => {
        if (!binding || binding.mode === 'none') return undefined
        const value = readRawValue(binding)
        return normalizeInjectTools(value && typeof value === 'object' ? value.injectTools : undefined)
      }
      const current = () => fromConfig() ?? fromBinding() ?? 'minimal'

      if (binding.mode === 'legacy') {
        // 命名空间注册模型：插件自持命名空间
        if (!LegacyImportPrefsSchema) return
        const scope = settings.register(binding.ns, LegacyImportPrefsSchema)
        if (typeof onInjectToolsChange !== 'function') return
        const injectTools = () => {
          const value = typeof scope.get === 'function' ? scope.get() : undefined
          return normalizeInjectTools(value && typeof value === 'object' ? value.injectTools : undefined)
        }
        onInjectToolsChange(injectTools())
        if (typeof scope.watch === 'function') scope.watch(() => onInjectToolsChange(injectTools()))
        return
      }

      // forms / none（条目模型，或本条目此刻还没进 describe 名单）：页面策略 + 初值 + 变更订阅。
      // 页面策略：本插件自带侧栏面板，不需要宿主再生成一个自动设置页。经 sctx.effect 登记
      //（对齐宿主插件 child.effect(() => child.settings.configure(...)) 的姿势），configure
      // 的 disposer 随插件卸载释放——直接调用会把策略留在服务里，重载时抛 "already configured"。
      if (ctx.fiber && settings && typeof settings.configure === 'function') {
        try {
          const registerPolicy = () => settings.configure({ auto: false }, ctx.fiber)
          if (typeof sctx.effect === 'function') sctx.effect(registerPolicy)
          else registerPolicy()
        } catch (err) {
          console.error('[dsh-chat-import] settings.configure failed: ' + String((err && err.message) || err))
        }
      }
      if (typeof onInjectToolsChange !== 'function') return
      onInjectToolsChange(current())
      const onChange = () => onInjectToolsChange(current())
      try {
        // loader 在 volatile 配置原地更新后发出，且只投递给本 fiber（filter: owner.fiber === fiber）
        ctx.on('loader/volatile-update', onChange)
      } catch { /* 事件不可用：实时对账退化为下次读取，不影响导入 */ }
      try {
        // { global: true }：设置服务的广播事件在自己的 owner 上下文发出，跨 fiber 也要收到
        sctx.on('settings/document-updated', (ns) => {
          if (binding.mode === 'forms' && ns !== binding.ns) return
          onChange()
        }, { global: true })
      } catch { /* 同上 */ }
    } catch (err) {
      console.error('[dsh-chat-import] settings register failed: ' + String((err && err.message) || err))
    }
  })
}

// 读取导入偏好（缺省见 IMPORT_PREFS_DEFAULT）：绑定 none / 值形态异常时返回默认，不抛错。
// injectTools 经 normalizeInjectTools 归一（boolean 与异常值）。
export function readImportPrefs(ctx) {
  try {
    const binding = resolvePrefsBinding(ctx)
    const value = binding.mode === 'none' ? undefined : readRawValue(binding)
    if (!value || typeof value !== 'object') return { ...IMPORT_PREFS_DEFAULT }
    return {
      importSystemPrompt: value.importSystemPrompt !== false,
      injectTools: normalizeInjectTools(value.injectTools),
      sidebarButton: value.sidebarButton !== false,
    }
  } catch {
    return { ...IMPORT_PREFS_DEFAULT }
  }
}

/**
 * 只读自检：把宿主设置服务的关键事实吐出来（两代设置模型的排障入口）。
 * 判读顺序：probe.ns 里有没有裸 id → namespaceState 是不是裸 id → hasSettings/hasDescribe。
 * @param ctx - 插件上下文
 * @param binding - 可选，已解析的绑定（省略则现解析）
 * @returns {{ hasSettings, hasDescribe, hasRegister, count, ns, namespaceState, error }}
 */
export function probeImportPrefs(ctx, binding = resolvePrefsBinding(ctx)) {
  const probe = {
    hasSettings: false, hasDescribe: false, hasRegister: false,
    count: 0, ns: '', namespaceState: 'unavailable', error: null,
  }
  let settings
  try {
    settings = ctx && typeof ctx.get === 'function' ? ctx.get('settings') : undefined
  } catch (err) {
    probe.error = String((err && err.message) || err)
    return probe
  }
  if (!settings) return probe
  probe.hasSettings = true
  probe.hasDescribe = typeof settings.describe === 'function'
  probe.hasRegister = typeof settings.register === 'function'
  if (!probe.hasDescribe) {
    probe.namespaceState = binding.mode === 'legacy' ? 'registered:' + binding.ns : 'unavailable'
    return probe
  }
  try {
    const all = settings.describe({ redactSecrets: true })
    probe.count = all.length
    probe.ns = all.map((d) => d && d.ns).filter((x) => typeof x === 'string' && x).join(',')
    probe.namespaceState = all.some((d) => d && d.ns === binding.ns)
      ? 'configured:' + binding.ns
      : 'missing:' + binding.ns
  } catch (err) {
    probe.error = String((err && err.message) || err)
  }
  return probe
}

// 面板 fenced 路由读取：describe 拿当前 resolved 值 + revision + 自检 probe。绑定 none /
// describe 不可用 → 默认值 + available:false（路由据此标注降级，客户端照常渲染）。
export function describeImportPrefs(ctx) {
  const binding = resolvePrefsBinding(ctx)
  const probe = probeImportPrefs(ctx, binding)
  if (binding.mode === 'none') {
    return { value: { ...IMPORT_PREFS_DEFAULT }, revision: undefined, available: false, probe }
  }
  try {
    const desc = findDescriptor(binding)
    if (!desc) return { value: { ...IMPORT_PREFS_DEFAULT }, revision: undefined, available: true, probe }
    return {
      value: desc.value && typeof desc.value === 'object' ? desc.value : { ...IMPORT_PREFS_DEFAULT },
      revision: desc.revision,
      available: true,
      probe,
    }
  } catch (err) {
    return {
      value: { ...IMPORT_PREFS_DEFAULT },
      revision: undefined,
      available: false,
      probe: { ...probe, error: String((err && err.message) || err) },
    }
  }
}

// 面板 fenced 路由写入：settings.update（expectedRevision 冲突保护——命名空间被并发
// 移动时服务抛 SettingsConflictError，由路由转成友好码）。绑定 none → 原样返回默认
//（不持久化，客户端按 available 降级）。
export async function updateImportPrefs(ctx, patch, expectedRevision) {
  const binding = resolvePrefsBinding(ctx)
  if (binding.mode === 'none' || !binding.settings || typeof binding.settings.update !== 'function') {
    return describeImportPrefs(ctx)
  }
  await binding.settings.update(binding.ns, patch, expectedRevision)
  return describeImportPrefs(ctx)
}
