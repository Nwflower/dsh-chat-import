import { copilotCliHeadMeta } from '../convert/copilot-cli.mjs'
import { isAbsoluteLike, joinForPlatform, normalizeTitle } from '../convert/util.mjs'
import { fileFingerprint, projectFromRecord, makeEntry, emitEach, parseJsonlHead, HEAD_MAX_BYTES } from './common.mjs'
import { walkFiles } from './walk.mjs'
import { probeSource } from './scan-cache.mjs'

// 根目录：`~/.copilot/session-state`（官方 COPILOT_HOME 迁移整个 .copilot 根时随迁）。
export function copilotCliRoots(home, env = {}, platform = process.platform) {
  if (isAbsoluteLike(env.COPILOT_HOME || '')) return [joinForPlatform(platform, env.COPILOT_HOME, 'session-state')]
  return [joinForPlatform(platform, home, '.copilot', 'session-state')]
}

async function scanCopilotCli(host, target, { bm, emit }) {
  const st = await host.stat(target)
  if (!st) return []
  const files = []
  await walkFiles(host, target, files, (name) => /^events\.jsonl$/i.test(name))
  const out = []
  for (const file of files) {
    const fst = await host.stat(file.path)
    if (!fst) continue
    const entries = await probeSource(bm, 'copilot-cli', file.path, fileFingerprint(fst), async () => {
      const head = await host.readHead(file.path, HEAD_MAX_BYTES)
      if (head === null || head === '') return []
      const meta = copilotCliHeadMeta(parseJsonlHead(head))
      if (!meta) return []
      return [makeEntry({
        format: 'copilot-cli',
        sessionId: meta.id,
        title: meta.title ? normalizeTitle(meta.title) : null,
        cwd: meta.cwd,
        project: projectFromRecord(meta.cwd, () => null),
        createdAt: meta.createdAt,
        // 追加式事件流的 mtime 即最后一次写入时刻（头部窗口不含末尾时间戳）
        lastActiveAt: fst.mtimeMs,
        sourcePath: file.path,
      })]
    })
    out.push(...entries)
    await emitEach(emit, entries)
  }
  return out
}

export const copilotCliSource = {
  format: 'copilot-cli',
  roots: copilotCliRoots,
  scan: scanCopilotCli,
  matchFile: (lower) => /(^|[\\/])session-state[\\/][^\\/]+[\\/]events\.jsonl$/.test(lower) ? 'only' : false,
  fileFallback: ['jsonl'],
}
