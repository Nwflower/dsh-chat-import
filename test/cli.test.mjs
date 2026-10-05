// test/cli.test.mjs — 独立 CLI（bin/dsh-chat-import.mjs）：真实子进程 + 临时 DSH_HOME
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dsh-chat-import.mjs')

function run(args, home) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home || mkdtempSync(join(tmpdir(), 'dsh-cli-home-')) },
  })
  return { code: res.status, stdout: res.stdout, stderr: res.stderr }
}

const SESSION = [
  { type: 'session', version: 3, id: 'import-cli', createdAt: 1786000000000 },
  { type: 'session/title', seq: 0, data: { title: 'CLI 导出标题' } },
  { type: 'user/message', seq: 1, data: { role: 'user', content: [{ type: 'text', text: '压缩日志里的提问' }] }, surfaceOp: 'append' },
].map((r) => JSON.stringify(r)).join('\n') + '\n'

test('CLI export-md：直接读 .zstd 会话日志（宿主落盘的就是 zstd）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cli-zstd-'))
  const file = join(dir, 'session.v3.jsonl.zstd')
  writeFileSync(file, zstdCompressSync(Buffer.from(SESSION, 'utf8')))
  const out = run(['export-md', file])
  assert.equal(out.code, 0, out.stderr)
  assert.match(out.stdout, /# CLI 导出标题/)
  assert.match(out.stdout, /压缩日志里的提问/)
})

test('CLI export-md：给会话目录时取代次最高的日志（含 session.vN 命名），--out 写文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cli-dir-'))
  writeFileSync(join(dir, 'session.jsonl'), SESSION.replace('CLI 导出标题', '旧代次'), 'utf8')
  writeFileSync(join(dir, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(SESSION, 'utf8')))
  const outFile = join(dir, 'out', 'session.md')
  const out = run(['export-md', '--out', outFile, dir])
  assert.equal(out.code, 0, out.stderr)
  assert.match(readFileSync(outFile, 'utf8'), /# CLI 导出标题/)
})

test('CLI export-md：目录里没有会话日志时大声失败', () => {
  const out = run(['export-md', mkdtempSync(join(tmpdir(), 'dsh-cli-empty-'))])
  assert.equal(out.code, 1)
  assert.match(out.stderr, /没有找到会话日志/)
})

test('CLI doctor：按插件同一 registry 目录对账磁盘会话目录，点名缺失与残留', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cli-doctor-'))
  mkdirSync(join(home, 'dsh-chat-import'), { recursive: true })
  writeFileSync(join(home, 'dsh-chat-import', 'imports.json'), JSON.stringify({
    version: 1,
    imports: {
      'src-a.jsonl': { kind: 'single', dshId: 'import-a', turns: 1 },
      'src-b.jsonl': { kind: 'single', dshId: 'import-b', turns: 1 },
    },
  }), 'utf8')
  for (const id of ['import-a', 'import-stray', 'user-session']) mkdirSync(join(home, 'sessions', 'bucket', id), { recursive: true })
  const out = run(['doctor'], home)
  assert.equal(out.code, 0, out.stderr)
  assert.match(out.stdout, /registry 2 条记录（导入会话 2 个），sessions 3 个会话（其中导入 2 个）/)
  assert.match(out.stdout, /找不到会话目录：import-b/)
  assert.match(out.stdout, /不在 registry 里.*import-stray/)
})
