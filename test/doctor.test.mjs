// doctor.test.mjs — REQ-66 doctor 健康检查（纯整理 + 命令/工具集成见 command.test.mjs）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectImportedIds, listImportArtifactIds } from '../lib/doctor.mjs'

test('REQ-66 collectImportedIds: single + multi 子表都收集', () => {
  const registry = {
    imports: {
      'C:/a.jsonl': { kind: 'single', dshId: 'import-a' },
      'C:/multi.jsonl': {
        kind: 'multi',
        conversations: {
          c1: { dshId: 'import-c1' },
          c2: { dshId: 'import-c2' },
        },
      },
      'C:/legacy': 'import-legacy', // 旧 string 记录也兼容
    },
  }
  const ids = collectImportedIds(registry)
  assert.deepEqual(ids.sort(), ['import-a', 'import-c1', 'import-c2', 'import-legacy'].sort())
})

test('REQ-66 collectImportedIds: 空/损坏条目跳过', () => {
  assert.deepEqual(collectImportedIds({ imports: { a: null, b: 123, c: {} } }), [])
})

test('issue #41 listImportArtifactIds：只列 <bucket>/import-* 目录，缺失根返回空', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sess-root-'))
  mkdirSync(join(root, 'bucket-a', 'import-ghost-1'), { recursive: true })
  mkdirSync(join(root, 'bucket-a', 'import-ghost-2'), { recursive: true })
  mkdirSync(join(root, 'bucket-a', 'native-session'), { recursive: true })
  mkdirSync(join(root, 'bucket-b', 'import-ghost-3'), { recursive: true })
  // bucket 层级上的普通文件不应被当成目录展开
  assert.deepEqual((await listImportArtifactIds(root)).sort(), ['import-ghost-1', 'import-ghost-2', 'import-ghost-3'])
  assert.deepEqual(await listImportArtifactIds(join(root, 'no-such-root')), [])
})
