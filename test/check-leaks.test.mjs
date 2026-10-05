// check-leaks.test.mjs — .github/scripts/check-leaks.mjs 的文件集口径：
// 全量模式扫「受版本管理的文件」（git ls-files），所以 dev/ 绝不入库这条规则真的能触发；
// 此前走文件系统遍历且跳过 dev/，被 git add -f 强制入库的 dev/ 文件永远查不出来。
// 每个用例把脚本拷进一个临时目录（脚本按自身位置定仓库根），在里面造 git 仓库再跑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../.github/scripts/check-leaks.mjs', import.meta.url))
const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0

/** 临时仓库：.github/scripts/check-leaks.mjs + README.md + dev/notes.md；git 为真时 git init。 */
function sandbox(withGit) {
  const dir = mkdtempSync(join(tmpdir(), 'check-leaks-'))
  mkdirSync(join(dir, '.github', 'scripts'), { recursive: true })
  copyFileSync(SCRIPT, join(dir, '.github', 'scripts', 'check-leaks.mjs'))
  writeFileSync(join(dir, 'README.md'), '# demo\n')
  mkdirSync(join(dir, 'dev'))
  writeFileSync(join(dir, 'dev', 'notes.md'), '本地笔记\n')
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    assert.equal(r.status, 0, 'git ' + args.join(' ') + ': ' + r.stderr)
  }
  if (withGit) {
    git('init', '-q')
    git('add', 'README.md', '.github')
  }
  // 不让 git 往临时目录之上找仓库（tmpdir 恰好在某个仓库里时，「非 git 检出」用例才不失真）
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) }
  const run = () => spawnSync(process.execPath, [join(dir, '.github', 'scripts', 'check-leaks.mjs')], { cwd: dir, encoding: 'utf8', env })
  return { dir, git, run, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('dev/ 下的文件进了版本管理（git add -f）→ 规则 1 报错', { skip: !hasGit && 'git 不可用' }, () => {
  const box = sandbox(true)
  try {
    box.git('add', '-f', 'dev/notes.md')
    const r = box.run()
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stderr, /dev\/notes\.md: dev\/ 本地工程文件受版本管理/)
  } finally {
    box.done()
  }
})

test('dev/ 只躺在工作区里（未入库）→ 不报错，扫的是受版本管理的文件', { skip: !hasGit && 'git 不可用' }, () => {
  const box = sandbox(true)
  try {
    const r = box.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    // README.md + 脚本本身：dev/notes.md 不在清单里
    assert.match(r.stdout, /扫描 2 文件/)
  } finally {
    box.done()
  }
})

test('不在 git 检出里 → 退回遍历文件系统（跳过 dev/ 等本地目录）', () => {
  const box = sandbox(false)
  try {
    const r = box.run()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /扫描 2 文件/)
  } finally {
    box.done()
  }
})
