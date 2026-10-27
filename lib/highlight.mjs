// lib/highlight.mjs — search-term highlighting ranges (panel titles, snippets, preview).
// Pure and dependency-free: inlined into lib/client.js by scripts/build-client.mjs and imported
// by the tests directly.

/** "Fix  the fix" → ['fix', 'the'] — the same term rule as lib/session-search.mjs searchTerms. */
export function highlightTerms(query) {
  const seen = new Set()
  for (const t of String(query || '').toLowerCase().split(/\s+/)) if (t) seen.add(t)
  return [...seen]
}

/**
 * Text + terms → [[start, end), …] sorted and merged, case-insensitive. Overlapping or touching
 * matches merge into one range so a highlight never nests.
 */
export function highlightRanges(text, terms) {
  const str = typeof text === 'string' ? text : ''
  if (!str || !Array.isArray(terms) || terms.length === 0) return []
  const lower = str.toLowerCase()
  const raw = []
  for (const term of terms) {
    if (!term) continue
    for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + term.length)) raw.push([at, at + term.length])
  }
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out = []
  for (const r of raw) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}
