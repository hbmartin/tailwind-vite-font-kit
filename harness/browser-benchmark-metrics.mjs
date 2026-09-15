// Verify database metrics against the exact Manrope WOFF2 used by the browser.
// node harness/browser-benchmark-metrics.mjs /path/to/manrope.woff2 output.json
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { create } from 'fontkit'
import { entireMetricsCollection } from '@capsizecss/metrics/entireMetricsCollection'
import { toSfnt, xWidthAvg } from '../src/opsz-policy.mjs'
const [path, output] = process.argv.slice(2)
if (!output) throw new Error('Pass Manrope WOFF2 and output JSON')
const bytes = readFileSync(path)
const font = create(await toSfnt(bytes))
const rows = [400, 500, 600, 700, 800].map((weight) => {
  const instance = font.getVariation({ wght: weight })
  const measured = {
    xWidthAvg: xWidthAvg(instance),
    unitsPerEm: instance.unitsPerEm,
    ascent: instance.ascent,
    descent: instance.descent,
    lineGap: instance.lineGap,
  }
  const metric =
    entireMetricsCollection.manrope.variants[String(weight)] ??
    entireMetricsCollection.manrope.variants.regular
  const database = Object.fromEntries(
    Object.keys(measured).map((key) => [
      key,
      key === 'xWidthAvg' ? (metric.subsets?.latin?.xWidthAvg ?? metric.xWidthAvg) : metric[key],
    ]),
  )
  assert.deepEqual(measured, database, `Manrope ${weight} differs from database`)
  return { weight, measured, database }
})
writeFileSync(
  output,
  JSON.stringify(
    { sha256: createHash('sha256').update(bytes).digest('hex'), validated: true, rows },
    null,
    2,
  ),
)
console.log(JSON.stringify({ validated: true, weights: rows.length }))
