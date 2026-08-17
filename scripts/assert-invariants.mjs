#!/usr/bin/env node
// Assert the invariants a build must hold, against the output of collect-metrics.mjs.
//
// This was ~40 lines of `node -e` duplicated between the `integration` job and every leg
// of the Vite matrix, paying the backtick-inside-YAML escaping twice and free to drift:
// an invariant added to one copy still printed "invariants ok" in the other.
//
//   node scripts/assert-invariants.mjs metrics.json [label]

import { readFileSync } from 'node:fs'

// Each of these is a bug that shipped, or nearly shipped.
const MUST_EQUAL = {
  googleapisRefs: 0,
  gstaticRefs: 0,
  blinkMacSystemFontLocals: 0,
  leakedThemeAtRule: 0,
  defaultFontFamilyIsVar: 1,
  // One per family in test/fixture/fonts.config.mjs.
  themeVarsWithFallback: 3,
  // Every alias pair the generator declares must reach the CSS...
  aliasPairsMismatched: 0,
  // ...as a second source in the primary's OWN face, never as a face of its own.
  aliasOrphanFaces: 0,
}
const MUST_BE_AT_LEAST = {
  fontFaceWithSizeAdjust: 8,
  // Arial/Liberation Sans, Times New Roman/Liberation Serif, Courier New/Liberation Mono.
  aliasPairsDeclared: 3,
  // ...and the fixture must actually exercise all three, or a dropped alias is invisible.
  aliasPairsPresent: 3,
}

const [metricsPath = 'metrics.json', label = ''] = process.argv.slice(2)
const metrics = JSON.parse(readFileSync(metricsPath, 'utf8'))
const failures = []

for (const [key, expected] of Object.entries(MUST_EQUAL)) {
  if (metrics[key] !== expected) failures.push(`${key} = ${metrics[key]}, expected ${expected}`)
}
for (const [key, floor] of Object.entries(MUST_BE_AT_LEAST)) {
  if (!(metrics[key] >= floor))
    failures.push(`${key} = ${metrics[key]}, expected at least ${floor}`)
}

if (failures.length) {
  for (const failure of failures) console.error(`::error::${failure}`)
  console.error(`alias detail: ${metrics.aliasSummary || '(none collected)'}`)
  process.exit(1)
}
console.log(`invariants ok${label ? ` ${label}` : ''}`)
