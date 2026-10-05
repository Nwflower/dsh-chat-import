// lib/budget.mjs — 上下文预算解析（纯 host 面）
//
// 导入会话无 provider 配置时不会被 dsh 自动压缩（routedTarget 解析失败），超长
// 会话全量落盘后恢复对话直接 400。预算（token 数）解析优先级：
//   工具参数 budget > 环境变量 DSH_IMPORT_CONTEXT_BUDGET >
//   动态（agentDefaultModel.currentSelection + llm.resolveModelInfo 模型窗口）>
//   静态默认 550k。
// agentDefaultModel / llm 在 rc.6 host 服务面存在但可能未挂载：任一步不可用或
// 抛错都回退静态默认，绝不报错。解析结果盖写进 args.budget（转换层消费）与
// args.budgetSource（裁剪上报标注来源），并落进 imports registry。

export const DEFAULT_CONTEXT_BUDGET = 550000
export const IMPORT_BUDGET_ENV = 'DSH_IMPORT_CONTEXT_BUDGET'

// 预算值归一：缺省/非法（非正数）返回 null。
export function parseBudgetValue(v) {
  if (v === undefined || v === null || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).trim())
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/**
 * 宿主默认模型及其元数据：agentDefaultModel.currentSelection + llm.resolveModelInfo。
 * 预算动态解析与导入会话的模型绑定（agents.create 的 agentOptions）共用这一条探测链；任一环不可用
 * 或抛错都返回 null——两处都只把它当「有则更好」的信号，绝不因此阻塞导入。
 * @returns {Promise<{ provider: string, model: string, info: object | null } | null>}
 */
export async function resolveDefaultModelInfo(ctx) {
  try {
    const adm = ctx.get('agentDefaultModel')
    const llm = ctx.get('llm')
    if (!adm || typeof adm.currentSelection !== 'function') return null
    if (!llm || typeof llm.resolveModelInfo !== 'function') return null
    const selection = adm.currentSelection()
    if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') return null
    const info = await llm.resolveModelInfo(selection.provider, selection.model)
    return { provider: selection.provider, model: selection.model, info: info && typeof info === 'object' ? info : null }
  } catch {
    // 服务未挂载 / 选择不可读 / 模型元数据解析失败：按「无默认模型信号」处理
    return null
  }
}

// 动态预算：默认模型窗口 − 默认输出上限 − max(25% 窗口, 40k)；模型无窗口元数据 → null。
async function dynamicContextBudget(ctx) {
  const resolved = await resolveDefaultModelInfo(ctx)
  const info = resolved && resolved.info
  const window = info && info.context && typeof info.context.contextWindow === 'number' ? info.context.contextWindow : null
  if (window === null || window <= 0) return null
  const maxTokens = typeof info.defaultMaxTokens === 'number' && info.defaultMaxTokens > 0 ? info.defaultMaxTokens : 0
  const budget = window - maxTokens - Math.max(Math.floor(window * 0.25), 40000)
  return Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : null
}

// 完整解析链，返回 { budget, source }（source ∈ param|env|dynamic|default）。
export async function resolveImportBudget(ctx, args) {
  const param = parseBudgetValue(args.budget)
  if (param !== null) return { budget: param, source: 'param' }
  const env = parseBudgetValue(process.env[IMPORT_BUDGET_ENV])
  if (env !== null) return { budget: env, source: 'env' }
  const dynamic = await dynamicContextBudget(ctx)
  if (dynamic !== null) return { budget: dynamic, source: 'dynamic' }
  return { budget: DEFAULT_CONTEXT_BUDGET, source: 'default' }
}

// 把预算来源标注并入转换层裁剪上报（convert.mjs 纯函数只知预算值，不知来源）。
export function markTrimmedSource(out, args) {
  if (out && out.trimmed && typeof args.budgetSource === 'string') {
    out.trimmed = { ...out.trimmed, source: args.budgetSource }
  }
  return out
}
