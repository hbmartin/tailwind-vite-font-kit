#!/usr/bin/env node
// Regenerate src/weightings.mjs from the installed @capsizecss/unpack.
//
//   node scripts/extract-weightings.mjs > src/weightings.mjs
//
// Run this when test/weightings.test.mjs fails, which means capsize re-derived the table.
// Read the diff before committing it: these numbers feed every size-adjust the package
// emits, so a change here moves every fallback face.
//
// The table is not exported by @capsizecss/unpack. It lives as `var weightings_default`
// inside a content-hashed chunk of its minified dist, so this scans for the marker rather
// than hardcoding a filename that changes on every unpack release. That fragility is
// exactly why the result is vendored instead of being read at runtime.

import { createRequire } from 'node:module'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/** @returns {Promise<Record<string, Record<string, number>>>} */
export async function extractWeightings() {
  let dist
  try {
    dist = dirname(require.resolve('@capsizecss/unpack'))
  } catch {
    throw new Error(
      "install '@capsizecss/unpack' first — it is a devDependency of this repo, not a runtime one",
    )
  }
  const START = 'var weightings_default'
  const END = '//#endregion'
  for (const f of readdirSync(dist)) {
    if (!f.endsWith('.mjs')) continue
    const src = readFileSync(join(dist, f), 'utf8')
    const s = src.indexOf(START)
    if (s === -1) continue
    const e = src.indexOf(END, s)
    if (e === -1) continue
    const mod = await import(
      'data:text/javascript,' +
        encodeURIComponent(src.slice(s, e).replace(START, 'export const weightings'))
    )
    return mod.weightings
  }
  throw new Error(
    'could not find the weightings table in the @capsizecss/unpack dist — its bundle ' +
      'layout changed. Find the new marker and update START above.',
  )
}

/** The version the table was taken from. */
export const unpackVersion = () => require('@capsizecss/unpack/package.json').version

// Only render the file when run directly; the test imports the two helpers above.
if (import.meta.url === `file://${process.argv[1]}`) {
  const weightings = await extractWeightings()
  const ver = unpackVersion()
  const body = Object.entries(weightings)
    .map(
      ([subset, chars]) =>
        '  ' +
        JSON.stringify(subset) +
        ': {\n' +
        Object.entries(chars)
          .map(([ch, n]) => '    ' + JSON.stringify(ch) + ': ' + n)
          .join(',\n') +
        ',\n  },',
    )
    .join('\n')

  process.stdout.write(
    `// Per-subset character-frequency weights, used to compute a font's average character
// width the way capsize does (\`xWidthAvg\`). Vendored from @capsizecss/unpack ${ver}.
//
// Vendored rather than imported because \`@capsizecss/unpack\` does not export this table:
// the only way to reach it is to string-match \`var weightings_default\` inside a
// content-hashed chunk of its minified dist (\`shared-*.mjs\`). That is what this file
// used to do, at module scope, in a top-level await — so merely importing the module threw
// when the dependency was absent, and any change to the bundle layout broke it.
//
// It is static data: a frequency table over a writing system, not a computation. The
// numbers change only if capsize re-derives them, and test/weightings.test.mjs diffs this
// file against the installed @capsizecss/unpack so that shows up as a failing test rather
// than as silently wrong metrics.
//
// To refresh: node scripts/extract-weightings.mjs > src/weightings.mjs

/** @type {Record<string, Record<string, number>>} */
export const WEIGHTINGS = {
${body}
}

/** The @capsizecss/unpack release these numbers were taken from. */
export const WEIGHTINGS_SOURCE_VERSION = '${ver}'
`,
  )
}
