// test/source-derive.test.mjs — 文件型来源的旁读派生（lib/tools/source-derive.mjs）
//
// mock fs 按**精确路径**查找（不做分隔符归一）：这里要守的正是「派生出的旁路文件路径
// 在本平台真实可达」，归一化查找会把拼错分隔符的路径也判成命中。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { reasonixDesktopLayout, reasonixDeriveArgs, fileStem } from '../lib/tools/source-derive.mjs'

function exactFs(files) {
  return {
    async resolve(path) { return { targetKey: path, displayPath: path } },
    async stat(target) {
      const v = files[target.targetKey]
      return v === undefined ? undefined : { type: 'file', size: v.length }
    },
    async readText(target) {
      const v = files[target.targetKey]
      if (v === undefined) throw new Error('ENOENT ' + target.targetKey)
      return v
    },
    async listDir() { return [] },
    processPath(target) { return target.targetKey },
  }
}

test('reasonixDesktopLayout：sessions 目录原样截取输入前缀（不改分隔符）', () => {
  assert.deepEqual(reasonixDesktopLayout('/home/u/.reasonix/projects/my-slug/sessions/abc.jsonl'),
    { slug: 'my-slug', sessionsDir: '/home/u/.reasonix/projects/my-slug/sessions' })
  assert.deepEqual(reasonixDesktopLayout('C:\\Users\\u\\.reasonix\\projects\\my-slug\\sessions\\abc.jsonl'),
    { slug: 'my-slug', sessionsDir: 'C:\\Users\\u\\.reasonix\\projects\\my-slug\\sessions' })
  assert.equal(reasonixDesktopLayout('/home/u/.reasonix/sessions/abc.jsonl'), null)
})

test('reasonixDeriveArgs：桌面版布局从本平台可达的 .titles.json 取标题', async () => {
  const file = '/home/u/.reasonix/projects/my-slug/sessions/abc.jsonl'
  const titles = join('/home/u/.reasonix/projects/my-slug/sessions', '.titles.json')
  const ctx = { fs: exactFs({ [file]: '', [titles]: JSON.stringify({ abc: '  桌面版标题 ' }) }) }
  const derived = await reasonixDeriveArgs(ctx, { targetKey: file, displayPath: file })
  assert.equal(derived.reasonixId, 'abc')
  assert.equal(derived.title, '桌面版标题')
})

test('reasonixDeriveArgs：.titles.json 损坏时告警并回退首问，不静默吞掉', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const file = '/home/u/.reasonix/projects/my-slug/sessions/abc.jsonl'
  const titles = join('/home/u/.reasonix/projects/my-slug/sessions', '.titles.json')
  const ctx = { fs: exactFs({ [file]: '', [titles]: '{broken' }) }
  const derived = await reasonixDeriveArgs(ctx, { targetKey: file, displayPath: file })
  assert.equal(derived.title, undefined)
  assert.equal(warn.mock.callCount(), 1)
  assert.match(String(warn.mock.calls[0].arguments[0]), /\.titles\.json/)
})

test('reasonixDeriveArgs：没有 .titles.json 是常态，不告警', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const file = '/home/u/.reasonix/projects/my-slug/sessions/abc.jsonl'
  const derived = await reasonixDeriveArgs({ fs: exactFs({ [file]: '' }) }, { targetKey: file, displayPath: file })
  assert.equal(derived.title, undefined)
  assert.equal(warn.mock.callCount(), 0)
})

test('fileStem：去掉目录与扩展名（两种分隔符）', () => {
  assert.equal(fileStem('/a/b/sess-1.jsonl'), 'sess-1')
  assert.equal(fileStem('C:\\a\\b\\sess-2.jsonl'), 'sess-2')
  assert.equal(fileStem('/a/b/s.json', /\.json$/i), 's')
})
