// lib/skill.mjs — interchange 转换指南注册为宿主运行时 skill（可选服务，缺席跳过）
//
// 文件导入识别失败的出路（docs/USAGE.md「识别失败不是死胡同」）：除「复制失败摘要」
// 的任务模板外，插件把 docs/INTERCHANGE-GUIDE.md 注册成运行时 skill
// dsh-chat-import-convert——用户的 Agent 可直接调用它拿到完整转换指令，
// 不必访问 GitHub；模板里的链接仍是兜底。
//
// skills 是可选 host 服务（旧宿主 / headless profile 可能没有），入口经
// ctx.inject(['skills'], …) 延迟注册——与 webServer 同一姿势：服务永不就绪时
// 回调不执行，导入功能不受影响。
//
// 内容单一事实源是 docs/ 下的指南文件（npm 包 files 含 docs/*.md），注册时同步
// 读入：指南迭代不需要改本文件。读不到记警告并跳过注册（失败要大声，不静默）。
// resourceBase 指到 docs/ 目录：指南里的相对链接（INTERCHANGE.md、中文版指南）
// 由消费方按目录解析。

import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 运行时 skill 名（kebab-case；任务模板与文档里点名它，改名三处同步）。 */
export const CONVERT_SKILL_NAME = 'dsh-chat-import-convert'

const GUIDE_FILE = new URL('../docs/INTERCHANGE-GUIDE.md', import.meta.url)

// 组装 skill 定义（纯函数，便于测试）：content 空时返回 null（调用方跳过注册）。
export function buildConvertSkill(content) {
  if (typeof content !== 'string' || !content.trim()) return null
  return {
    name: CONVERT_SKILL_NAME,
    description: 'Convert any external chat transcript into an importable dsh-chat-import interchange v1 JSON document（把任意对话记录转成可导入的 interchange v1 文档）。',
    whenToUse: '文件导入提示「所有对话格式解析器全部解析失败」时使用；user pastes a failure summary asking to convert a transcript.',
    source: 'runtime',
    content,
    resourceBase: { kind: 'directory', path: dirname(fileURLToPath(GUIDE_FILE)) },
  }
}

// 注册进 ctx 所在层（全局层）：技能目录对宿主内所有 agent 可见。读指南失败只记
// 警告并跳过——面板任务模板仍带 GitHub 链接兜底，导入主流程不受影响。
export function registerConvertSkill(ctx, skills, { readFile } = {}) {
  const read = readFile || ((p) => readFileSync(p, 'utf8'))
  let content
  try {
    content = read(fileURLToPath(GUIDE_FILE))
  } catch (err) {
    console.warn('[dsh-chat-import] 转换指南读取失败，跳过 skill 注册：' + String((err && err.message) || err))
    return undefined
  }
  const skill = buildConvertSkill(content)
  if (!skill) {
    console.warn('[dsh-chat-import] 转换指南内容为空，跳过 skill 注册')
    return undefined
  }
  return skills.register(skill)
}
