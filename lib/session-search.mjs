// lib/session-search.mjs — full-text search inside discovered sessions (panel "search in content").
//
// Raw transcripts are mostly tool output: on a real machine 827 Claude Code files are 10.6 GB
// while the user / assistant text in them is ~130 MB. Scanning raw files per query costs a
// minute, so the text is extracted once into a per-file cache under
// $registryDir/search-index/ and searched from there:
//   * cache line = "<role>\t<text with newlines flattened>\n", role u | a;
//   * index.json remembers size / mtime / byte offset per source; an append-only .jsonl that
//     grew is read from the stored offset only (live sessions grow while you search), anything
//     else that changed is rebuilt;
//   * directories and one-file-many-sessions sources are not indexed (reported as skipped).
// A query matches a message when the message contains every whitespace-separated term
// (case-insensitive); the panel highlights the same terms.
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, appendFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { writeAtomic } from './atomic-write.mjs'
import { highlightTerms } from './highlight.mjs'

const INDEX_VERSION = 1
/** Raw sources above this size are skipped for non-JSONL (whole-file parse) formats. */
const JSON_MAX_BYTES = 64 * 1024 * 1024
/** A single extracted message longer than this is truncated in the cache. */
const TEXT_MAX = 20000
/** Snippets per hit and characters of context around the first term. */
const SNIPPETS_PER_HIT = 3
const SNIPPET_CONTEXT = 70
/** Keys whose string values count as conversation text in the generic extractor. */
const TEXT_KEYS = new Set(['text', 'content', 'prompt', 'message', 'input', 'output_text', 'input_text'])

/**
 * "foo  Bar" → ['foo', 'bar'] (lowercase, deduplicated, empty dropped). Same rule as the
 * panel's highlighting (lib/highlight.mjs), so a hit and its highlight can never disagree.
 */
export const searchTerms = highlightTerms

const flatten = (s) => s.replace(/[\r\n\t]+/g, ' ').trim()
const clip = (s) => (s.length > TEXT_MAX ? s.slice(0, TEXT_MAX) : s)

function partsText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((p) => p && (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') && typeof p.text === 'string')
    .map((p) => p.text).join('\n')
}

function genericStrings(node, out, depth) {
  if (depth > 6 || node === null || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const v of node) genericStrings(v, out, depth + 1); return }
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string') {
      if (TEXT_KEYS.has(k) && v.length > 0 && v.length < 200000) out.push(v)
    } else if (v && typeof v === 'object' && k !== 'tool_result' && k !== 'toolUseResult') {
      genericStrings(v, out, depth + 1)
    }
  }
}

/**
 * One parsed record → [{ role, text }]. Claude Code and Codex shapes are read precisely
 * (tool results excluded); other formats fall back to string values under text-like keys.
 */
export function extractRecord(rec) {
  if (!rec || typeof rec !== 'object') return []
  // Claude Code: { type: 'user'|'assistant', message: { content } }, meta lines are injected
  if ((rec.type === 'user' || rec.type === 'assistant') && rec.message && typeof rec.message === 'object') {
    if (rec.isMeta) return []
    const text = partsText(rec.message.content)
    return text.trim() ? [{ role: rec.type === 'user' ? 'u' : 'a', text }] : []
  }
  // Claude Code bookkeeping lines carry no conversation
  if (rec.type === 'summary' || rec.type === 'file-history-snapshot' || rec.type === 'system') return []
  // Codex rollout: { type: 'response_item', payload: { type: 'message', role, content } }
  if (rec.type === 'response_item' && rec.payload && typeof rec.payload === 'object') {
    if (rec.payload.type !== 'message') return []
    const text = partsText(rec.payload.content)
    return text.trim() ? [{ role: rec.payload.role === 'user' ? 'u' : 'a', text }] : []
  }
  if (rec.type === 'event_msg' || rec.type === 'turn_context' || rec.type === 'session_meta') return []
  const strings = []
  genericStrings(rec, strings, 0)
  const text = strings.join('\n')
  if (!text.trim()) return []
  return [{ role: rec.role === 'user' || rec.type === 'user' ? 'u' : 'a', text }]
}

const cacheLines = (records) => records.map((r) => r.role + '\t' + clip(flatten(r.text)) + '\n').join('')

function lineRecords(line) {
  if (!line || line.charCodeAt(0) !== 123 /* { */) return []
  try {
    return extractRecord(JSON.parse(line))
  } catch {
    return []
  }
}

/** Stream `file` from byte `start`; complete lines → cache text. Returns { text, end }. */
async function extractJsonlFrom(file, start) {
  let pending = Buffer.alloc(0)
  let consumed = start
  let text = ''
  for await (const chunk of createReadStream(file, { start })) {
    let buf = pending.length ? Buffer.concat([pending, chunk]) : chunk
    let from = 0
    for (let nl = buf.indexOf(10); nl !== -1; nl = buf.indexOf(10, from)) {
      const line = buf.toString('utf8', from, nl).replace(/\r$/, '')
      const recs = lineRecords(line)
      if (recs.length) text += cacheLines(recs)
      consumed += nl + 1 - from
      from = nl + 1
    }
    pending = buf.subarray(from)
    if (pending.length > 8 * 1024 * 1024) {
      // runaway line (an inlined image / huge paste): drop it but keep the offset exact
      consumed += pending.length
      pending = Buffer.alloc(0)
    }
  }
  // the unterminated tail is left for the next run (a live session may still be writing it)
  return { text, end: consumed }
}

async function extractWholeJson(file) {
  const raw = await readFile(file, 'utf8')
  let doc
  try {
    doc = JSON.parse(raw)
  } catch {
    return ''
  }
  const strings = []
  genericStrings(doc, strings, 0)
  return strings.length ? cacheLines([{ role: 'a', text: strings.join('\n') }]) : ''
}

const hashOf = (p) => createHash('sha1').update(p).digest('hex')

/** The on-disk index (paths → cache metadata) with a write-behind flush. */
export class SearchIndex {
  constructor(registryDir) {
    this.dir = join(registryDir, 'search-index')
    this.file = join(this.dir, 'index.json')
    this.entries = null
    this.dirty = false
    this.lock = Promise.resolve()
  }

  async load() {
    if (this.entries) return
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'))
      this.entries = data && data.version === INDEX_VERSION && data.entries && typeof data.entries === 'object' ? data.entries : {}
    } catch {
      this.entries = {}
    }
    await mkdir(this.dir, { recursive: true })
  }

  async flush() {
    if (!this.dirty) return
    this.dirty = false
    await writeAtomic(this.file, JSON.stringify({ version: INDEX_VERSION, entries: this.entries }) + '\n')
  }

  /**
   * Bring one source's cache up to date and return its cache text (null = not indexable).
   * Serialized per index: two searches never append to the same cache at once.
   */
  refresh(path) {
    const run = this.lock.then(() => this.refreshNow(path))
    this.lock = run.catch(() => {})
    return run
  }

  async refreshNow(path) {
    await this.load()
    let info
    try {
      info = await stat(path)
    } catch {
      return null
    }
    if (!info.isFile()) return null
    const jsonl = /\.jsonl$/i.test(path)
    if (!jsonl && !/\.json$/i.test(path)) return null
    if (!jsonl && info.size > JSON_MAX_BYTES) return null
    const cache = join(this.dir, hashOf(path) + '.txt')
    const prev = this.entries[path]
    const unchanged = prev && prev.size === info.size && prev.mtimeMs === info.mtimeMs
    if (unchanged) {
      try {
        return await readFile(cache, 'utf8')
      } catch {
        // cache file lost: rebuild below
      }
    }
    const grew = jsonl && prev && info.size > prev.size && info.mtimeMs >= prev.mtimeMs && Number.isFinite(prev.offset)
    if (grew) {
      const { text, end } = await extractJsonlFrom(path, prev.offset)
      if (text) await appendFile(cache, text, 'utf8')
      this.entries[path] = { size: info.size, mtimeMs: info.mtimeMs, offset: end }
    } else if (jsonl) {
      const { text, end } = await extractJsonlFrom(path, 0)
      await writeFile(cache, text, 'utf8')
      this.entries[path] = { size: info.size, mtimeMs: info.mtimeMs, offset: end }
    } else {
      await writeFile(cache, await extractWholeJson(path), 'utf8')
      this.entries[path] = { size: info.size, mtimeMs: info.mtimeMs }
    }
    this.dirty = true
    return readFile(cache, 'utf8')
  }
}

function snippetOf(text, terms) {
  const lower = text.toLowerCase()
  let at = lower.length
  for (const t of terms) {
    const i = lower.indexOf(t)
    if (i !== -1 && i < at) at = i
  }
  const start = Math.max(0, at - SNIPPET_CONTEXT)
  const end = Math.min(text.length, at + SNIPPET_CONTEXT * 2)
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

/** Cache text → { count, snippets } for messages containing every term (count 0 = no hit). */
export function searchCacheText(cacheText, terms) {
  let count = 0
  const snippets = []
  if (!cacheText || terms.length === 0) return { count, snippets }
  for (const line of cacheText.split('\n')) {
    if (line.length < 3) continue
    const lower = line.toLowerCase()
    if (!terms.every((t) => lower.includes(t))) continue
    count++
    if (snippets.length < SNIPPETS_PER_HIT) {
      snippets.push({ role: line[0] === 'u' ? 'user' : 'assistant', text: snippetOf(line.slice(2), terms) })
    }
  }
  return { count, snippets }
}

const JOB_IDLE_MS = 5 * 60_000

/**
 * Background search jobs keyed by (list key, query). A job walks the given entries, refreshes
 * each cache and records hits; the panel polls progress. Starting a new query for the same
 * list cancels the previous one.
 */
export function createSearchJobs(registryDir) {
  const index = new SearchIndex(registryDir)
  const jobs = new Map()

  function sweep(now) {
    for (const [k, j] of jobs) if (j.done && now - j.lastActive > JOB_IDLE_MS) jobs.delete(k)
  }

  function start(listKey, query, entries, { skip } = {}) {
    const now = Date.now()
    sweep(now)
    const key = listKey + '\u0000' + query
    let job = jobs.get(key)
    if (job) {
      job.lastActive = now
      return job
    }
    for (const j of jobs.values()) if (j.listKey === listKey) j.cancelled = true
    const terms = searchTerms(query)
    job = { listKey, query, terms, total: entries.length, scanned: 0, skipped: 0, hits: [], done: false, cancelled: false, error: null, lastActive: now }
    jobs.set(key, job)
    ;(async () => {
      try {
        let sinceFlush = 0
        for (const entry of entries) {
          if (job.cancelled) break
          job.scanned++
          if (skip && skip(entry)) { job.skipped++; continue }
          let text = null
          try {
            text = await index.refresh(entry.processPath)
          } catch {
            text = null
          }
          if (text === null) { job.skipped++; continue }
          const found = searchCacheText(text, terms)
          if (found.count > 0) {
            job.hits.push({
              format: entry.format, sourcePath: entry.sourcePath, sessionId: entry.sessionId,
              count: found.count, snippets: found.snippets,
            })
          }
          if (++sinceFlush >= 50) { sinceFlush = 0; await index.flush() }
        }
        await index.flush()
      } catch (err) {
        job.error = String((err && err.message) || err)
      } finally {
        job.done = true
      }
    })()
    return job
  }

  return { start, index }
}
