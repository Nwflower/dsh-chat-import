// lib/discovery/jcode.mjs — jcode 会话 JSON 族的发现：~/.jcode/sessions/session_*.json
//
// 每文件一个完整会话快照（同目录另有 .bak 备份、coord.json / req.json 运行状态文件，
// 只认 session_*.json）。标题口径与转换器一致：title > short_name > 首条真实 user 文本；
// 结构不符（不是对象 / 没有 messages 数组）即自拒。
import { join } from 'node:path'
import { normalizeTitle } from '../convert/util.mjs'
import { jcodeTimeMs } from '../convert/jcode.mjs'
import { basenameOf, fileFingerprint, makeEntry, emitEach, projectFromRecord } from './common.mjs'
import { walkFiles } from './walk.mjs'
import { probeSource } from './scan-cache.mjs'

const isJcodeFile = (name) => /^session_[^\\/]+\.json$/i.test(name)

function firstUserText(messages) {
  const first = messages.find((m) => m && m.role === 'user' && m.display_role !== 'system')
  if (!first) return ''
  const blocks = Array.isArray(first.content) ? first.content : []
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

async function scanJcode(host, target, { bm, emit }) {
  const files = []
  await walkFiles(host, target, files, isJcodeFile)
  const out = []
  for (const file of files) {
    if (!/\.jcode[\\/]sessions[\\/]/i.test(file.path)) continue
    const st = await host.stat(file.path)
    if (!st) continue
    // 标题/时间都取自文件本体，指纹用单文件（mtime + size）。
    const entries = await probeSource(bm, 'jcode', file.path, fileFingerprint(st), async () => {
      const raw = await host.readText(file.path)
      let session
      try {
        session = JSON.parse(raw)
      } catch {
        return []
      }
      if (!session || typeof session !== 'object' || Array.isArray(session)) return []
      if (!Array.isArray(session.messages)) return []
      const messages = session.messages
      const title = normalizeTitle(
        (typeof session.title === 'string' ? session.title : '')
        || (typeof session.short_name === 'string' ? session.short_name : '')
        || firstUserText(messages),
      ) || null
      const cwd = typeof session.working_dir === 'string' && session.working_dir ? session.working_dir : undefined
      const sessionId = typeof session.id === 'string' && session.id
        ? session.id
        : basenameOf(file.name).replace(/\.json$/i, '')
      const createdAt = jcodeTimeMs(session.created_at) ?? undefined
      const lastActiveAt = jcodeTimeMs(session.updated_at) ?? st.mtimeMs
      return [makeEntry({
        format: 'jcode',
        sessionId,
        title,
        project: projectFromRecord(cwd, () => null),
        createdAt,
        lastActiveAt,
        sourcePath: file.path,
        cwd,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

export const jcodeSource = {
  format: 'jcode',
  roots: (home) => join(home, '.jcode', 'sessions'),
  scan: scanJcode,
  // 路径特征独占：.jcode/sessions 下的 .json（.bak 不是有效会话文件）
  matchFile: (lower) => /\.jcode[\\/]sessions[\\/]/i.test(lower) && /\.json$/i.test(lower) && !/\.bak$/i.test(lower),
  fileFallback: ['json'],
}
