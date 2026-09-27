// test/_support/compaction.mjs — 原生压缩事务的共享测试断言（多源转换用例共用，故收进
// _support/，与 host-path.mjs 同处）。
//
//   assertNativeCompaction(events)   —— 宿主 @deepseek-ai/dsh-compaction 的 Surface contract
//     与 dsh-compaction/invariant 的校验项：start/summary/检查点/end 四件套、遮蔽范围与
//     shadowedSeqs 首尾一致、检查点标记与括号 compactionId 一致、sourceEventSeqs 覆盖全部
//     被遮蔽节点。返回检查点数量。
//   derivedSurfaceMessages(events)   —— 逐 surface 节点折叠（宿主 deriveMessages 的口径）：
//     返回模型实际看到的消息 'role:content' 列表。
import assert from 'node:assert/strict'

export function assertNativeCompaction(events) {
  const starts = events.filter((e) => e.type === 'compaction/start')
  const summaries = events.filter((e) => e.type === 'compaction/summary')
  const ends = events.filter((e) => e.type === 'compaction/end')
  const checks = events.filter((e) => e.type === 'user/message' && e.surfaceOp && typeof e.surfaceOp === 'object')
  assert.equal(summaries.length, starts.length)
  assert.equal(ends.length, starts.length)
  assert.equal(checks.length, starts.length)
  for (let i = 0; i < starts.length; i++) {
    const id = starts[i].data.compactionId
    assert.ok(typeof id === 'string' && id.length > 0)
    assert.equal(starts[i].data.turn, null) // 独立事务：发生在两轮之间
    assert.equal(summaries[i].data.compactionId, id)
    assert.equal(ends[i].data.compactionId, id)
    const s = summaries[i].data
    assert.ok(Array.isArray(s.shadowedSeqs) && s.shadowedSeqs.length > 0, 'shadowedSeqs 非空（宿主不变式）')
    assert.equal(s.shadowedRange.start, s.shadowedSeqs[0])
    assert.equal(s.shadowedRange.end, s.shadowedSeqs[s.shadowedSeqs.length - 1])
    assert.ok(Number.isInteger(s.shadowedTokenCount) && s.shadowedTokenCount >= 0)
    assert.ok(typeof s.provider === 'string' && s.provider.length > 0)
    assert.ok(typeof s.model === 'string' && s.model.length > 0)
    assert.equal(s.summary[0].type, 'text')
    const ck = checks[i]
    assert.deepEqual(ck.surfaceOp, { op: 'replace', start: s.shadowedRange.start, end: s.shadowedRange.end })
    // 溯源：必须包含每一个被遮蔽的 surface 节点（宿主 assertProvenance 的硬要求）
    assert.deepEqual(ck.sourceEventSeqs, s.shadowedSeqs)
    assert.deepEqual(ck.data.source, { kind: 'plugin', plugin: 'compact', compactionId: id })
    assert.equal(ck.data.content[0].text, s.summary[0].text)
    const seqs = [starts[i].seq, summaries[i].seq, ck.seq, ends[i].seq]
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), '事务顺序 start → summary → 检查点 → end')
  }
  return starts.length
}

export function derivedSurfaceMessages(events) {
  const bySeq = new Map(events.map((e) => [e.seq, e]))
  const surfaces = []
  for (const ev of events) {
    if (ev.surfaceOp === undefined) continue
    if (ev.surfaceOp === 'append') { surfaces.push(ev.seq); continue }
    const { start, end } = ev.surfaceOp
    const si = surfaces.indexOf(start)
    const ei = surfaces.indexOf(end)
    if (si === -1 || ei === -1) throw new Error('replace 范围不在 surface 上')
    surfaces.splice(si, ei - si + 1, ev.seq)
  }
  return surfaces.map((s) => {
    const ev = bySeq.get(s)
    const m = ev.data.message || ev.data
    const text = (m.content || []).map((b) => b.text || b.type).join('|')
    return m.role + ':' + text
  })
}
