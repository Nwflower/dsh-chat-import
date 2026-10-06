// test/_support/fixtures.mjs — 合成夹具的载入口径
//
// 夹具全部合成、不含真实 transcript（AGENTS.md）；「从哪里读、怎么读」是同一件事，
// 此前各文件自己拼 `join(dirname(fileURLToPath(import.meta.url)), 'fixtures')` 或
// `new URL('./fixtures/x', import.meta.url)`。口径收在这里一份。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostAbsText } from './host-path.mjs'

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

/** 夹具的绝对路径（需要自己用 fs 读、或交给宿主 fs 服务时用）。 */
export function fixturePath(name) {
  return join(FIXTURES_DIR, name)
}

/** 读一个夹具为 UTF-8 文本（最常见的形态）。 */
export function loadFixture(name) {
  return readFileSync(fixturePath(name), 'utf8')
}

/** 读一个夹具为 Buffer（二进制夹具，如 session.jsonl.zstd）。 */
export function loadFixtureBytes(name) {
  return readFileSync(fixturePath(name))
}

/**
 * 读一个夹具并按宿主平台改写其中的盘符路径（转录 / 元数据夹具带的是 Windows cwd，
 * 宿主落盘前按本平台 isAbsolute 剔除）。Windows 上恒等。集成用例统一用这个。
 */
export function loadHostFixture(name) {
  return hostAbsText(loadFixture(name))
}
