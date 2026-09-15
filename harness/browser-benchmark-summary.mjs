// Summarize and validate measurements exported from the in-app browser.
// Usage: node harness/browser-benchmark-summary.mjs path/to/raw-results.json
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'

const input = process.argv[2]
if (!input) throw new Error('Pass the raw-results.json path')
const results = JSON.parse(readFileSync(input, 'utf8'))
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const groups = new Map()
for (const r of results) {
  assert(Number.isFinite(r.cls) && r.cls >= 0, `${r.id}: invalid CLS`)
  assert(r.before && r.after, `${r.id}: missing geometry`)
  const fonts = r.resources.filter((f) => /\.woff2(?:\?|$)/.test(f.name))
  const expected = r.variant === 'system' ? 0 : r.probe === 'hero' ? 2 : 1
  assert.equal(fonts.length, expected, `${r.id}: missing or duplicate fonts`)
  assert(
    fonts.every((f) => f.encoded > 0 && f.transfer > 0),
    `${r.id}: cached/empty font response`,
  )
  if (r.delay >= 1500 && expected) {
    assert(r.before.at < Math.min(...fonts.map((f) => f.end)), `${r.id}: late before-snapshot`)
    assert(
      r.before.faces.some((f) => f.status === 'loading'),
      `${r.id}: no font was loading`,
    )
  }
  if (['kit', 'fontaine'].includes(r.variant) && r.delay >= 1500) {
    for (const family of r.probe === 'hero' ? ['Manrope', 'Fraunces'] : ['Manrope']) {
      const fallbackPrefix = r.variant === 'kit' ? `${family} Fallback:` : `${family} fallback`
      assert(
        r.before.faces.some((f) => f.family.startsWith(fallbackPrefix) && f.status === 'loaded'),
        `${r.id}: ${family} fallback did not load`,
      )
      assert(
        r.after.faces.some((f) => f.family === family && f.status === 'loaded'),
        `${r.id}: ${family} never loaded`,
      )
    }
  }
  const key = `${r.group}/${r.viewport.width}/${r.probe}/${r.variant}/${r.width}`
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(r)
}
const summary = [...groups].map(([key, rows]) => ({
  key,
  runs: rows.length,
  cls: median(rows.map((r) => r.cls)),
  min: Math.min(...rows.map((r) => r.cls)),
  max: Math.max(...rows.map((r) => r.cls)),
  fcp: median(rows.map((r) => r.fcp)),
  fontBytes: median(
    rows.map((r) =>
      r.resources.filter((f) => /\.woff2(?:\?|$)/.test(f.name)).reduce((n, f) => n + f.encoded, 0),
    ),
  ),
  maxProbeShift: Math.max(
    ...rows.flatMap((r) =>
      r.after.elements.map((e, i) =>
        e.probe ? Math.abs(e.rect.y - r.before.elements[i].rect.y) : 0,
      ),
    ),
  ),
}))
writeFileSync(
  input.replace(/\.json$/, '-summary.json'),
  JSON.stringify({ loads: results.length, validated: true, summary }, null, 2),
)
console.log(JSON.stringify({ loads: results.length, validated: true, summary }, null, 2))
