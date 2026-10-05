#!/usr/bin/env node
// bin/dsh-chat-import.mjs — 独立 CLI（无 DSH host 也可用，只读）
//
// 子命令：
//   export-md <session log | session-dir> [--out file]   DSH 会话日志 → Markdown
//   doctor                                               离线体检：registry ↔ 磁盘会话目录对账
//   help                                                 打印帮助
//
// 导入 / 导出到其它工具依赖 DSH 的会话持久化与工作区服务，只在 DSH 内（import_chat 等工具、
// /import 命令、面板）可用；这里只提供不需要启动 DSH 的只读通道。路径口径与插件一致：
// registry 目录取 lib/imports.mjs 的 resolveRegistryDir（$DSH_HOME 缺省 ~/.dsh），会话日志
// 读取认宿主的代次命名（session[.vN].jsonl[.zstd]）与多帧 zstd（lib/sources/dsh.mjs）。

import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { sessionJsonlToMarkdown } from '../lib/markdown.mjs'
import { resolveRegistryDir } from '../lib/imports.mjs'
import { runOfflineDoctor } from '../lib/doctor.mjs'
import { decodeZstdText, dshSessionLogVersion } from '../lib/sources/dsh.mjs'

// 会话目录里挑日志：代次最高者优先（宿主只往当前代次写），同代次明文优先（免解压）。
async function sessionLogIn(dir) {
  const logs = (await readdir(dir))
    .map((name) => ({ name, version: dshSessionLogVersion(name) }))
    .filter((e) => e.version !== undefined)
    .sort((a, b) => (b.version - a.version) || (Number(/\.zstd$/i.test(a.name)) - Number(/\.zstd$/i.test(b.name))))
  if (logs.length === 0) throw new Error('目录中没有找到会话日志（session[.vN].jsonl[.zstd]）：' + dir)
  return join(dir, logs[0].name)
}

async function readSessionText(path) {
  const file = (await stat(path)).isDirectory() ? await sessionLogIn(path) : path
  if (/\.zstd$/i.test(file)) return decodeZstdText(await readFile(file))
  return readFile(file, 'utf8')
}

async function cmdExportMd(args) {
  const outIdx = args.indexOf('--out')
  const outPath = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : null
  const source = args.filter((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1))[0]
  if (!source) throw new Error('用法：dsh-chat-import export-md <session log | session-dir> [--out file]')
  const md = sessionJsonlToMarkdown(await readSessionText(source))
  if (outPath) {
    await mkdir(dirname(outPath), { recursive: true })
    await writeFile(outPath, md, 'utf8')
    return `已写入 ${outPath}`
  }
  return md
}

async function cmdDoctor() {
  const out = await runOfflineDoctor(resolveRegistryDir())
  return `doctor: registry ${out.records} 条记录（导入会话 ${out.importedIds.length} 个），`
    + `sessions ${out.sessionDirs} 个会话（其中导入 ${out.importDirs.length} 个）`
    + (out.issues.length ? '\n' + out.issues.map((i) => '  - ' + i).join('\n') : '')
}

const HELP = `dsh-chat-import — standalone CLI

用法：
  dsh-chat-import export-md <session log | session-dir> [--out file]
      会话日志可以是 session[.vN].jsonl 或 .zstd 压缩件；给目录时取其中代次最高的日志
  dsh-chat-import doctor
  dsh-chat-import help
`

async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  try {
    let output
    if (cmd === 'export-md') {
      output = await cmdExportMd(args)
    } else if (cmd === 'doctor') {
      output = await cmdDoctor()
    } else {
      output = HELP
    }
    process.stdout.write(output.endsWith('\n') ? output : output + '\n')
  } catch (err) {
    process.stderr.write(String((err && err.message) || err) + '\n')
    process.exitCode = 1
  }
}

main()
