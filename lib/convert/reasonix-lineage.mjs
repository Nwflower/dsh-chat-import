// Reasonix recovery lineage selection. This module deliberately fails open:
// uncertain candidates remain independent sessions instead of being collapsed.

import { createHash } from 'node:crypto'

const VOLATILE_KEYS = new Set([
  'id', 'tool_call_id', 'createdAt', 'updatedAt', 'workDurationMs', 'durationMs',
  'usage', 'token_usage', 'input_tokens', 'output_tokens', 'cache_read_tokens',
  'reasoning_tokens',
])

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const key of Object.keys(value).sort()) {
    if (!VOLATILE_KEYS.has(key)) out[key] = stable(value[key])
  }
  return out
}

function stableStringify(value) {
  return JSON.stringify(stable(value))
}

export function semanticReasonixMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return stableStringify(message)
  const role = message.role
  if (role === 'system') return null
  if (role === 'user') {
    const raw = typeof message.raw_content === 'string' && message.raw_content
      ? message.raw_content
      : message.content
    const payload = { role, content: raw }
    for (const key of ['attachments', 'images', 'files']) {
      if (Object.hasOwn(message, key)) payload[key] = stable(message[key])
    }
    return stableStringify(payload)
  }
  if (role === 'assistant') {
    const calls = (Array.isArray(message.tool_calls) ? message.tool_calls : [])
      .filter((call) => call && typeof call === 'object')
      .map((call) => ({
        name: call.name ?? call.function?.name,
        arguments: stable(call.arguments ?? call.function?.arguments),
      }))
    return stableStringify({
      role,
      reasoning_content: message.reasoning_content,
      content: message.content,
      tool_calls: calls,
    })
  }
  if (role === 'tool') {
    return stableStringify({
      role,
      name: message.name,
      content: message.content,
      is_error: message.is_error,
    })
  }
  return stableStringify(message)
}

export function parseReasonixSemantic(raw) {
  const semantic = []
  const parseErrors = []
  for (const [index, line] of String(raw || '').split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    try {
      const value = semanticReasonixMessage(JSON.parse(line))
      if (value !== null) semantic.push(createHash('sha256').update(value).digest('base64url'))
    } catch (error) {
      parseErrors.push({ line: index + 1, error: String(error?.message || error) })
    }
  }
  return { semantic, parseErrors }
}

// A proper prefix is intentionally stricter than an ordered subsequence and
// excludes exact duplicates. Both choices avoid guessing across real forks.
export function isStrictSemanticPrefix(prefix, sequence) {
  if (prefix.length === 0 || prefix.length >= sequence.length) return false
  return prefix.every((value, index) => value === sequence[index])
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function logicalKey(candidate) {
  return nonEmptyString(candidate.meta?.logical_topic_id)
    || nonEmptyString(candidate.meta?.topic_id)
}

function candidateId(candidate) {
  return nonEmptyString(candidate.meta?.id)
}

function parentId(candidate) {
  return nonEmptyString(candidate.meta?.parent_id)
}

function uniqueCandidatesById(members) {
  const byId = new Map()
  const ambiguous = new Set()
  for (const candidate of members) {
    const id = candidateId(candidate)
    if (!id) continue
    if (byId.has(id)) {
      byId.delete(id)
      ambiguous.add(id)
    } else if (!ambiguous.has(id)) {
      byId.set(id, candidate)
    }
  }
  return byId
}

export function hasExplicitReasonixLineage(ancestor, descendant, byId) {
  const ancestorId = candidateId(ancestor)
  const descendantId = candidateId(descendant)
  if (!ancestorId || !descendantId) return false
  if (byId.get(ancestorId) !== ancestor || byId.get(descendantId) !== descendant) return false
  const seen = new Set()
  let current = descendant
  while (current) {
    const parent = parentId(current)
    if (!parent || seen.has(parent)) return false
    if (parent === ancestorId) return true
    seen.add(parent)
    current = byId.get(parent)
  }
  return false
}

function rank(candidate) {
  return [
    candidate.semantic.length,
    String(candidate.meta?.updated_at || candidate.meta?.updatedAt || ''),
    Number(candidate.meta?.recovery_depth || candidate.meta?.recoveryDepth || 0),
    String(candidate.path || ''),
  ]
}

function compareRankDesc(a, b) {
  const ar = rank(a)
  const br = rank(b)
  for (let index = 0; index < ar.length; index++) {
    if (ar[index] === br[index]) continue
    return ar[index] < br[index] ? 1 : -1
  }
  return 0
}

function canProveCovered(candidate, possible, byId) {
  return candidate.parseErrors.length === 0
    && possible.parseErrors.length === 0
    && candidate.hasWal !== true
    && possible.hasWal !== true
    && isStrictSemanticPrefix(candidate.semantic, possible.semantic)
    && hasExplicitReasonixLineage(candidate, possible, byId)
}

export function selectReasonixMaximalBranches(candidates) {
  const grouped = new Map()
  const independent = []
  for (const candidate of candidates) {
    const key = logicalKey(candidate)
    if (!key) {
      independent.push({ ...candidate, coveredBy: null })
      continue
    }
    const members = grouped.get(key) || []
    members.push(candidate)
    grouped.set(key, members)
  }

  const selected = [...independent]
  const covered = []
  const groups = []
  for (const [topicId, members] of grouped) {
    const ranked = [...members].sort(compareRankDesc)
    const byId = uniqueCandidatesById(ranked)
    const kept = []
    for (const candidate of ranked) {
      const owner = kept.find((possible) => canProveCovered(candidate, possible, byId)) || null
      if (owner) covered.push({ ...candidate, coveredBy: owner.path })
      else kept.push(candidate)
    }
    const title = ranked.find((candidate) => (
      nonEmptyString(candidate.meta?.topic_title)
    ))?.meta.topic_title.trim()
    const publicKept = kept.map((candidate) => ({ ...candidate, coveredBy: null }))
    groups.push({ topicId, title, physicalCount: members.length, selected: publicKept })
    selected.push(...publicKept)
  }
  return { selected, covered, groups }
}
