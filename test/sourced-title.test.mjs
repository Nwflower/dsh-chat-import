import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatSourcedTitle,
  pinSourcedSessionTitle,
  stripSourcedPrefix,
  sourceLabelFromKey,
} from '../lib/sourced-title.mjs'

test('formatSourcedTitle：有话题时加来源前缀', () => {
  assert.equal(formatSourcedTitle('Cursor', 'Read rules', 1_700_000_000_000), 'Cursor · Read rules')
})

test('formatSourcedTitle：无话题时用未命名 + 短日期', () => {
  const t = formatSourcedTitle('Cursor', '', Date.parse('2026-08-27T07:11:00.000Z'))
  assert.match(t, /^Cursor · 未命名 · \d{4}-\d{2}-\d{2}$/)
})

test('stripSourcedPrefix：避免重复前缀', () => {
  assert.equal(stripSourcedPrefix('Cursor · Fix bug', 'Cursor'), 'Fix bug')
  assert.equal(stripSourcedPrefix('来自 Cursor · Fix bug', 'Cursor'), 'Fix bug')
})

test('pinSourcedSessionTitle：无 title 事件时追加', () => {
  const converted = {
    meta: { createdAt: 1_700_000_000_000 },
    turns: [{ prompt: 'Hello' }],
    events: [{ type: 'session', seq: 0 }],
  }
  pinSourcedSessionTitle(converted, sourceLabelFromKey('cursor'))
  assert.equal(converted.title, 'Cursor · Hello')
  const ev = converted.events.find((e) => e.type === 'session/title')
  assert.ok(ev)
  assert.equal(ev.data.title, 'Cursor · Hello')
})
