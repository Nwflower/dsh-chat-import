// upload.test.mjs — 上传暂存通道（断点续传 / 指纹 / 配额 / 回收）的行为测试。
//
// 契约：lib/upload.mjs 文件头（init → chunk×N → complete）；HTTP 路由在 lib/panel.mjs。
// 用真实临时目录（registry 与暂存都是插件自有数据，走 node:fs）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  uploadInit, uploadChunk, uploadComplete, uploadResolvedPath, uploadsStats,
  cleanupStaging, gcUploads, removeUpload, isUploadPath, sanitizeUploadName, uploadsDir,
} from '../lib/upload.mjs'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-upload-'))
}
function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

test('上传：init → 分片 → complete 落成可导入文件，续传 offset 对齐', async () => {
  const dir = tempDir()
  try {
    const payload = Buffer.from('line one\nline two\n'.repeat(500))
    const hash = sha256(payload)
    const init = await uploadInit(dir, { name: 'session.jsonl', size: payload.length, sha256: hash })
    assert.equal(init.ok, true)
    assert.equal(init.receivedOffset, 0)
    assert.ok(init.chunkSize > 0)

    const cut = Math.floor(payload.length / 3)
    const first = await uploadChunk(dir, { uploadId: init.uploadId, offset: 0, data: payload.subarray(0, cut).toString('base64') })
    assert.equal(first.receivedOffset, cut)
    // 偏移不符：带回真实位置供客户端对齐（而不是静默丢弃）
    const mismatch = await uploadChunk(dir, { uploadId: init.uploadId, offset: 5, data: 'AA==' })
    assert.equal(mismatch.ok, false)
    assert.equal(mismatch.code, 'offset-mismatch')
    assert.equal(mismatch.receivedOffset, cut)
    const second = await uploadChunk(dir, { uploadId: init.uploadId, offset: cut, data: payload.subarray(cut).toString('base64') })
    assert.equal(second.receivedOffset, payload.length)

    const done = await uploadComplete(dir, { uploadId: init.uploadId })
    assert.equal(done.ok, true)
    assert.equal(readFileSync(done.path, 'utf8'), payload.toString('utf8'))
    // 幂等：重复 complete 返回同一路径
    const again = await uploadComplete(dir, { uploadId: init.uploadId })
    assert.equal(again.path, done.path)
    assert.equal(await uploadResolvedPath(dir, init.uploadId), done.path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('上传：同 (sha256,size) 幂等——刷新/断线后续传或零重传', async () => {
  const dir = tempDir()
  try {
    const payload = Buffer.from('abc')
    const hash = sha256(payload)
    const init = await uploadInit(dir, { name: 'a.jsonl', size: 3, sha256: hash })
    await uploadChunk(dir, { uploadId: init.uploadId, offset: 0, data: payload.toString('base64') })
    // 未完成时重开：同一 uploadId + 已收字节（客户端据此续传）
    const resume = await uploadInit(dir, { name: 'a.jsonl', size: 3, sha256: hash })
    assert.equal(resume.uploadId, init.uploadId)
    assert.equal(resume.receivedOffset, 3)
    assert.equal(resume.completed, undefined)
    const done = await uploadComplete(dir, { uploadId: init.uploadId })
    // 完成后再 init：直接给 path（零重传）
    const fresh = await uploadInit(dir, { name: 'renamed.jsonl', size: 3, sha256: hash })
    assert.equal(fresh.uploadId, init.uploadId)
    assert.equal(fresh.completed, true)
    assert.equal(fresh.path, done.path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('上传：指纹不符拒绝产出文件（分片保留可重传），越界分片拒绝', async () => {
  const dir = tempDir()
  try {
    const payload = Buffer.from('hello')
    const init = await uploadInit(dir, { name: 'x.jsonl', size: payload.length, sha256: 'a'.repeat(64) })
    const over = await uploadChunk(dir, { uploadId: init.uploadId, offset: 0, data: Buffer.from('toolongpayload').toString('base64') })
    assert.equal(over.ok, false)
    assert.equal(over.code, 'overflow')
    await uploadChunk(dir, { uploadId: init.uploadId, offset: 0, data: payload.toString('base64') })
    const bad = await uploadComplete(dir, { uploadId: init.uploadId })
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 'hash-mismatch')
    assert.equal(bad.receivedOffset, payload.length) // 分片仍在，可重传
    assert.equal(await uploadResolvedPath(dir, init.uploadId), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('上传：参数守卫（大小非法 / 缺指纹 / 超单文件上限 / 未知 uploadId）', async () => {
  const dir = tempDir()
  try {
    assert.equal((await uploadInit(dir, { name: 'a', size: 0, sha256: 'a'.repeat(64) })).code, 'invalid-size')
    assert.equal((await uploadInit(dir, { name: 'a', size: 10, sha256: 'nope' })).code, 'invalid-hash')
    process.env.DSH_IMPORT_UPLOAD_MAX_BYTES = '8'
    try {
      assert.equal((await uploadInit(dir, { name: 'a', size: 9, sha256: 'a'.repeat(64) })).code, 'too-large')
    } finally {
      delete process.env.DSH_IMPORT_UPLOAD_MAX_BYTES
    }
    // uploadId 来自网络：只认 UUID 形态（目录穿越一律当作不存在）
    assert.equal(await uploadResolvedPath(dir, '../../etc/passwd'), null)
    assert.equal((await uploadChunk(dir, { uploadId: '../../x', offset: 0, data: 'AA==' })).code, 'not-found')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('上传：文件名 sanitize（路径穿越 / 控制字符 / 超长）', () => {
  assert.equal(sanitizeUploadName('..\\..\\evil.jsonl'), 'evil.jsonl')
  assert.equal(sanitizeUploadName('a\u0001b.jsonl'), 'ab.jsonl')
  assert.equal(sanitizeUploadName('   '), 'upload')
  assert.equal(sanitizeUploadName('..'), 'upload')
  const long = sanitizeUploadName('x'.repeat(300) + '.jsonl')
  assert.ok(long.length <= 120)
})

test('上传：GC 回收未完成件、保留已完成件；清理只删未被 registry 引用的件', async () => {
  const dir = tempDir()
  try {
    const keptPayload = Buffer.from('kept')
    const kept = await uploadInit(dir, { name: 'kept.jsonl', size: 4, sha256: sha256(keptPayload) })
    await uploadChunk(dir, { uploadId: kept.uploadId, offset: 0, data: keptPayload.toString('base64') })
    const keptDone = await uploadComplete(dir, { uploadId: kept.uploadId })

    const stalePayload = Buffer.from('stale')
    const stale = await uploadInit(dir, { name: 'stale.jsonl', size: 5, sha256: sha256(stalePayload) })
    await uploadChunk(dir, { uploadId: stale.uploadId, offset: 0, data: stalePayload.toString('base64') })

    const orphanPayload = Buffer.from('orphan')
    const orphan = await uploadInit(dir, { name: 'orphan.jsonl', size: 6, sha256: sha256(orphanPayload) })
    await uploadChunk(dir, { uploadId: orphan.uploadId, offset: 0, data: orphanPayload.toString('base64') })
    const orphanDone = await uploadComplete(dir, { uploadId: orphan.uploadId })
    assert.equal(orphanDone.ok, true)

    // gc：只回收未完成件（已完成件是 registry 的源键，绝不自动删）
    const removed = await gcUploads(dir, { maxAgeMs: -1 })
    assert.equal(removed, 1)
    assert.equal(await uploadResolvedPath(dir, stale.uploadId), null)
    assert.equal(await uploadResolvedPath(dir, kept.uploadId), keptDone.path)

    // cleanup：保留被 registry 引用的完成件，删掉未被引用的完成件
    const out = await cleanupStaging(dir, [keptDone.path])
    assert.equal(out.removed, 1)
    assert.equal(out.kept, 1)
    assert.equal(await uploadResolvedPath(dir, orphan.uploadId), null)
    assert.equal(await uploadResolvedPath(dir, kept.uploadId), keptDone.path)
    assert.equal(isUploadPath(dir, keptDone.path), true)

    const stats = await uploadsStats(dir)
    assert.equal(stats.completed, 1)
    assert.equal(stats.pending, 0)
    assert.ok(stats.bytes > 0)
    assert.ok(uploadsDir(dir).endsWith('uploads'))

    assert.equal(await removeUpload(dir, kept.uploadId), true)
    assert.equal(await uploadResolvedPath(dir, kept.uploadId), null)
    assert.deepEqual(await uploadsStats(dir), { pending: 0, completed: 0, bytes: 0, limitBytes: stats.limitBytes, dir: stats.dir })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
