// Drift guard for the vendored character-frequency table.
//
// src/weightings.mjs is a copy of a table that lives, unexported, inside @capsizecss/unpack's
// minified dist. Copying it removed a top-level await that threw on import when the
// dependency was missing, and a string-match against a content-hashed chunk name that was
// going to break on some future unpack release.
//
// The cost of copying is drift: if capsize re-derives the frequencies, our size-adjust
// values silently stop matching theirs. This test is what converts that into a failing
// build. When it fails, regenerate and READ THE DIFF — every fallback face in the package
// moves with these numbers:
//
//   node scripts/extract-weightings.mjs > src/weightings.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WEIGHTINGS, WEIGHTINGS_SOURCE_VERSION } from '../src/weightings.mjs'
import { extractWeightings, unpackVersion } from '../scripts/extract-weightings.mjs'

test('the vendored table still matches @capsizecss/unpack', async () => {
  const upstream = await extractWeightings()
  assert.deepEqual(
    WEIGHTINGS,
    upstream,
    `src/weightings.mjs has drifted from @capsizecss/unpack ${unpackVersion()} ` +
      `(vendored from ${WEIGHTINGS_SOURCE_VERSION}). ` +
      `Regenerate with \`node scripts/extract-weightings.mjs > src/weightings.mjs\` and read the diff.`,
  )
})

// Not redundant with the deepEqual above: it pins what the table has to LOOK like for
// xWidthAvg to be meaningful, so a structurally broken extraction that happens to match a
// structurally broken upstream still fails.
test('the table is a usable frequency distribution', () => {
  assert.ok(Object.keys(WEIGHTINGS).length > 0, 'no subsets')
  assert.ok(WEIGHTINGS.latin, 'latin is the default subset and must be present')

  for (const [subset, chars] of Object.entries(WEIGHTINGS)) {
    const values = Object.values(chars)
    assert.ok(values.length > 10, `${subset} has implausibly few characters`)
    assert.ok(
      values.every((n) => typeof n === 'number' && n >= 0 && n <= 1),
      `${subset} has a weight outside 0..1`,
    )
    // The weights are rounded to 4dp, so they sum to about 1 rather than exactly 1.
    const sum = values.reduce((a, b) => a + b, 0)
    assert.ok(Math.abs(sum - 1) < 0.01, `${subset} weights sum to ${sum}, expected ~1`)
  }

  // Latin's most frequent character by some margin is the space (0.154 vs 0.0922 for
  // 'e'), so its absence would mean the extraction picked up the wrong object. This is
  // deliberately latin-only: Thai does not space between words and legitimately has no
  // entry for it, which is what an earlier version of this assertion got wrong.
  assert.ok(WEIGHTINGS.latin[' '] > 0.1, 'latin has no weight for the space character')
})
