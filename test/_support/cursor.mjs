// Cursor 登记册合成夹具：库写入临时目录，宿主只把默认 User 根映射到该目录。
import { join } from 'node:path'
import { cursorUserDataDir } from '../../lib/sources/cursor.mjs'
import { makeFs } from './fake-host.mjs'
import { writeSqliteFixture } from './tmp-db.mjs'

export function cursorWorkspaceFixture(root, { create = 'CREATE TABLE composerHeaders (composerId TEXT, workspaceId TEXT, value TEXT)', rows = [], tree = {} } = {}) {
  const dbPath = join(root, 'globalStorage', 'state.vscdb')
  writeSqliteFixture(dbPath, { create, rows: { composerHeaders: rows } })
  const fs = makeFs(tree, { real: true })
  const resolve = fs.resolve
  const userRoot = cursorUserDataDir()
  fs.resolve = (path) => resolve(path === userRoot || path.startsWith(userRoot + '/') || path.startsWith(userRoot + '\\')
    ? root + path.slice(userRoot.length) : path)
  return { ctx: { fs }, dbPath }
}
