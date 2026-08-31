import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isStrictSemanticPrefix,
  parseReasonixSemantic,
  selectReasonixMaximalBranches,
} from '../lib/convert/reasonix-lineage.mjs'

function candidate(path, meta, messages, extra = {}) {
  const raw = messages.map((message) => (
    typeof message === 'string' ? message : JSON.stringify(message)
  )).join('\n')
  const parsed = parseReasonixSemantic(raw)
  return {
    path,
    target: { targetKey: path, displayPath: path },
    meta: { topic_title: 'Synthetic topic', ...meta },
    semantic: parsed.semantic,
    parseErrors: parsed.parseErrors,
    hasWal: extra.hasWal === true,
  }
}

const user = (content, id) => ({ role: 'user', content, id })
const assistant = (content, id) => ({ role: 'assistant', content, id })

test('Reasonix lineage semantic hash ignores volatile ids', () => {
  const oldIds = parseReasonixSemantic([
    JSON.stringify(user('A', 'old-user')),
    JSON.stringify(assistant('X', 'old-assistant')),
  ].join('\n'))
  const newIds = parseReasonixSemantic([
    JSON.stringify(user('A', 'new-user')),
    JSON.stringify(assistant('X', 'new-assistant')),
  ].join('\n'))
  assert.deepEqual(oldIds.semantic, newIds.semantic)
})

test('Reasonix lineage requires a proper prefix, not an ordered subsequence', () => {
  assert.equal(isStrictSemanticPrefix(['A', 'C'], ['A', 'B', 'C']), false)
  assert.equal(isStrictSemanticPrefix(['A', 'B'], ['A', 'B', 'C']), true)
  assert.equal(isStrictSemanticPrefix(['A', 'B'], ['A', 'B']), false)
})

test('Reasonix lineage collapses only a proven ancestor and keeps divergent leaves', () => {
  const base = candidate('base.jsonl', { id: 'root', topic_id: 'topic-1' }, [user('A'), assistant('X')])
  const left = candidate('left.jsonl', { id: 'left', parent_id: 'root', topic_id: 'topic-1' }, [
    user('A'), assistant('X'), user('B'), assistant('Y'),
  ])
  const right = candidate('right.jsonl', { id: 'right', parent_id: 'root', topic_id: 'topic-1' }, [
    user('A'), assistant('X'), user('C'), assistant('Z'),
  ])
  const result = selectReasonixMaximalBranches([base, left, right])
  assert.deepEqual(new Set(result.selected.map((item) => item.path)), new Set(['left.jsonl', 'right.jsonl']))
  assert.equal(result.covered.length, 1)
  assert.equal(result.covered[0].path, 'base.jsonl')
  assert.ok(['left.jsonl', 'right.jsonl'].includes(result.covered[0].coveredBy))
})

test('Reasonix lineage follows an unambiguous transitive parent chain', () => {
  const base = candidate('base.jsonl', { id: 'root', topic_id: 'topic-2' }, [user('A')])
  const middle = candidate('middle.jsonl', { id: 'middle', parent_id: 'root', topic_id: 'topic-2' }, [user('A'), assistant('B')])
  const leaf = candidate('leaf.jsonl', { id: 'leaf', parent_id: 'middle', topic_id: 'topic-2' }, [user('A'), assistant('B'), user('C')])
  const result = selectReasonixMaximalBranches([base, middle, leaf])
  assert.deepEqual(result.selected.map((item) => item.path), ['leaf.jsonl'])
  assert.deepEqual(new Set(result.covered.map((item) => item.path)), new Set(['base.jsonl', 'middle.jsonl']))
})

test('Reasonix lineage keeps a semantic prefix without explicit parent lineage', () => {
  const base = candidate('base.jsonl', { id: 'root', topic_id: 'topic-3' }, [user('A')])
  const extended = candidate('extended.jsonl', { id: 'extended', topic_id: 'topic-3' }, [user('A'), assistant('B')])
  const result = selectReasonixMaximalBranches([base, extended])
  assert.equal(result.selected.length, 2)
  assert.equal(result.covered.length, 0)
})

test('Reasonix lineage keeps exact duplicates even with a parent link', () => {
  const base = candidate('base.jsonl', { id: 'root', topic_id: 'topic-4' }, [user('A')])
  const copy = candidate('copy.jsonl', { id: 'copy', parent_id: 'root', topic_id: 'topic-4' }, [user('A')])
  const result = selectReasonixMaximalBranches([base, copy])
  assert.equal(result.selected.length, 2)
  assert.equal(result.covered.length, 0)
})

test('Reasonix lineage keeps candidates when a sidecar id is ambiguous', () => {
  const firstRoot = candidate('root-a.jsonl', { id: 'root', topic_id: 'topic-ambiguous-id' }, [user('A')])
  const secondRoot = candidate('root-b.jsonl', { id: 'root', topic_id: 'topic-ambiguous-id' }, [user('A')])
  const child = candidate('child.jsonl', { id: 'child', parent_id: 'root', topic_id: 'topic-ambiguous-id' }, [user('A'), assistant('B')])
  const result = selectReasonixMaximalBranches([firstRoot, secondRoot, child])
  assert.equal(result.selected.length, 3)
  assert.equal(result.covered.length, 0)
})

test('Reasonix lineage keeps malformed or WAL-backed candidates', () => {
  const malformed = candidate('broken.jsonl', { id: 'broken', topic_id: 'topic-5' }, [user('A'), '{bad json'])
  const child = candidate('child.jsonl', { id: 'child', parent_id: 'broken', topic_id: 'topic-5' }, [user('A'), assistant('B')])
  const walBase = candidate('wal-base.jsonl', { id: 'wal-base', topic_id: 'topic-6' }, [user('A')], { hasWal: true })
  const walChild = candidate('wal-child.jsonl', { id: 'wal-child', parent_id: 'wal-base', topic_id: 'topic-6' }, [user('A'), assistant('B')])
  const result = selectReasonixMaximalBranches([malformed, child, walBase, walChild])
  assert.equal(malformed.parseErrors.length, 1)
  assert.deepEqual(new Set(result.selected.map((item) => item.path)), new Set([
    'broken.jsonl', 'child.jsonl', 'wal-base.jsonl', 'wal-child.jsonl',
  ]))
  assert.equal(result.covered.length, 0)
})

test('Reasonix lineage uses logical_topic_id when available and keeps missing-topic files independent', () => {
  const base = candidate('base.jsonl', { id: 'root', logical_topic_id: 'logical-1', topic_id: 'physical-a' }, [user('A')])
  const leaf = candidate('leaf.jsonl', { id: 'leaf', parent_id: 'root', logical_topic_id: 'logical-1', topic_id: 'physical-b' }, [user('A'), assistant('B')])
  const one = candidate('one.jsonl', { id: 'one' }, [user('A')])
  const two = candidate('two.jsonl', { id: 'two', parent_id: 'one' }, [user('A'), assistant('B')])
  const result = selectReasonixMaximalBranches([base, leaf, one, two])
  assert.deepEqual(new Set(result.selected.map((item) => item.path)), new Set(['leaf.jsonl', 'one.jsonl', 'two.jsonl']))
  assert.deepEqual(result.covered.map((item) => item.path), ['base.jsonl'])
})
