// lib/discovery/registry.mjs — 来源描述符表：发现层「支持哪些来源」的唯一真相源
//
// 每个来源一个描述符（定义在各来源族模块里，与扫描器同住）：
//   format          来源短名（FORMATS 成员；工具 schema enum / 面板来源 id 的口径）
//   roots(home,env) 默认数据根：路径 | 路径数组 | null（null = 无默认根，只在显式 path 时发现）
//   scan(host, target, ctx)  扫描一个目标（文件或目录）→ 条目数组；结构不符返回 []（自拒）。
//                   ctx = { bm, emit, format, warn }：bm 书签 store（可空）、emit 逐条产出（可空）、
//                   format 请求的格式（dsh / dsh4 共用扫描器时据此过滤）、warn(err) 上报可降级的失败
//   layoutProject(sourcePath)  可选：按源目录布局提取项目名（记录内 cwd 缺失时的回退）
//   matchFile(lower, base)     可选：单文件路径特征（入参已小写；base = 文件名）。true = 候选，
//                   'only' = 独占（命中即只交给它），false = 不认
//   fileFallback    可选：路径特征全不命中时，按扩展名组（'jsonl' / 'json' / 'db'）兜底探测
//   sessionsFromHost 可选：扫描器经 host.readSessions(format, dbPath) 取 SQLite 会话摘要
//                   （host 侧须有该 format 的读取器，见 lib/discovery-host.mjs 的 DB_SUMMARY_FORMATS）
// SOURCES 的顺序即 FORMATS 的顺序：默认扫描、流式产出与同时间戳条目的先后都按它。新增来源 =
// 在来源族模块里写一个描述符 + 在这里登记一行。

import { homedir } from 'node:os'
import { claudeSource, qoderSource, workbuddySource, qwenSource } from './claude.mjs'
import { codexSource, cursorSource, reasonixSource, openclawSource, piSource } from './jsonl.mjs'
import { geminiSource, antigravitySource } from './gemini.mjs'
import {
  opencodeSource, mimocodeSource, kilocodeSource, zcodeSource, teleagentSource, gooseSource, zedSource,
  crushSource, traeSource, hermesSource,
} from './sqlite.mjs'
import { clineSource } from './cline.mjs'
import { kimiSource, grokbuildSource, vibeSource } from './session-dirs.mjs'
import { continueSource, chatgptSource } from './documents.mjs'
import { dshSource, dsh4Source } from './dsh.mjs'

export const SOURCES = Object.freeze([
  claudeSource, codexSource, cursorSource, geminiSource, antigravitySource, reasonixSource, opencodeSource,
  mimocodeSource, zcodeSource, grokbuildSource, openclawSource, piSource, hermesSource, kimiSource,
  kilocodeSource, qoderSource, chatgptSource, workbuddySource, qwenSource, continueSource, clineSource,
  gooseSource, dsh4Source, zedSource, crushSource, teleagentSource, traeSource, vibeSource, dshSource,
])

export const FORMATS = SOURCES.map((s) => s.format)

const BY_FORMAT = new Map(SOURCES.map((s) => [s.format, s]))

/** format → 描述符（未知格式 undefined）。 */
export function sourceOf(format) {
  return BY_FORMAT.get(format)
}

/** 默认数据根：{ <format>: 路径 | 路径数组 | null }。env 缺省取 process.env。 */
export function defaultRoots({ home = homedir(), env = process.env } = {}) {
  return Object.fromEntries(SOURCES.map((s) => [s.format, s.roots(home, env) ?? null]))
}

/** 按源目录布局提取项目名；该来源无布局约定或路径不符 → null。 */
export function layoutProject(sourcePath, format) {
  const source = BY_FORMAT.get(format)
  return source && source.layoutProject ? source.layoutProject(sourcePath) : null
}

function extensionGroup(lower) {
  if (lower.endsWith('.jsonl')) return 'jsonl'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.db')) return 'db'
  return null
}

/**
 * 单文件路径 → 可消费它的候选格式：先看各来源的路径特征（独占命中直接返回），全不命中再按
 * 扩展名组兜底（扫描器按结构自拒）。路径特征两种分隔符都认。
 */
export function fileFormatsForPath(path) {
  const lower = String(path).toLowerCase()
  const base = lower.slice(Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\')) + 1)
  const hits = []
  for (const s of SOURCES) {
    const hit = s.matchFile ? s.matchFile(lower, base) : false
    if (hit === 'only') return [s.format]
    if (hit) hits.push(s.format)
  }
  if (hits.length > 0) return hits
  const group = extensionGroup(lower)
  if (!group) return []
  return SOURCES.filter((s) => s.fileFallback && s.fileFallback.includes(group)).map((s) => s.format)
}
