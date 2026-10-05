// lib/atomic-write.mjs — 本地 JSON 状态文件（imports registry / ignores / 扫描书签）共用的原子写
//
// 同目录 temp + fsync + rename：rename 在 POSIX 上原子替换，在 Windows 上经
// MoveFileExW(MOVEFILE_REPLACE_EXISTING) 原子替换；中途失败删掉 temp，不留半截文件。
// 串行化（读-改-写链）由各调用方自持——本函数只保证单次写入的原子性。

import { open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export async function writeAtomic(filePath, data) {
  const tmp = join(dirname(filePath), '.' + randomUUID() + '.tmp')
  try {
    const handle = await open(tmp, 'wx')
    try {
      await handle.writeFile(data, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, filePath)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}
