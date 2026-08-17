#!/usr/bin/env node
// Collect metrics from a built fixture and print them as JSON on stdout.
//
// Static only: no browser, no network beyond the generator's own fetch. These are the
// numbers that change when someone refactors the generator, and they are deterministic
// enough to diff between commits. The noisy ones (CLS, FCP) live in the weekly job.
//
//   node scripts/collect-metrics.mjs <builtAppDir>

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { FALLBACK_TARGETS } from '../src/metrics.mjs'

const app = process.argv[2]
if (!app) {
  console.error('usage: collect-metrics.mjs <builtAppDir>')
  process.exit(1)
}

// Works for both layouts: the Vite fixture (dist/) and a TanStack Start app
// (.output/public/), so the same script serves the fast job and the weekly job.
const layouts = [
  { assets: join(app, '.output/public/assets'), fonts: join(app, '.output/public/fonts') },
  { assets: join(app, 'dist/assets'), fonts: join(app, 'dist/fonts') },
]
const layout = layouts.find(
  (l) => existsSync(l.assets) && readdirSync(l.assets).some((f) => f.endsWith('.css')),
)
if (!layout) {
  console.error(`no built stylesheet under ${layouts.map((l) => l.assets).join(' or ')}`)
  process.exit(1)
}
const assetsDir = layout.assets
const fontsDir = layout.fonts
// A build can emit more than one CSS chunk; the faces may not be in the first one.
const css = readdirSync(assetsDir)
  .filter((f) => f.endsWith('.css'))
  .map((f) => readFileSync(join(assetsDir, f), 'utf8'))
  .join('\n')
const faces = [...css.matchAll(/@font-face\{[^}]*\}/g)].map((m) => m[0])

const fontFiles = existsSync(fontsDir) ? readdirSync(fontsDir) : []
const fontBytes = fontFiles.reduce((n, f) => n + statSync(join(fontsDir, f)).size, 0)

// Read the alias pairs off the generator itself, so adding one to FALLBACK_TARGETS
// extends the CI invariant automatically instead of needing a second, hand-kept list.
const aliasPairs = Object.values(FALLBACK_TARGETS)
  .flat()
  .flatMap(([primary, , aliases = []]) => aliases.map((alias) => ({ primary, alias })))
const localRe = (name) => new RegExp(`local\\(["']?${name.replace(/ /g, '\\s')}["']?\\)`, 'g')
const countLocals = (text, name) => (text.match(localRe(name)) || []).length
const aliasStats = aliasPairs.map(({ primary, alias }) => ({
  primary,
  alias,
  primaryLocals: countLocals(css, primary),
  aliasLocals: countLocals(css, alias),
  // The regression MAINTAINERS.md warns about: the alias emitted as its OWN @font-face
  // rather than as a second source in the primary's face. Global counts alone cannot see
  // it — both totals still match — but the shipped stack precedence is wrong.
  orphanFaces: faces.filter(
    (face) => countLocals(face, alias) > 0 && countLocals(face, primary) === 0,
  ).length,
}))

const metrics = {
  cssBytes: css.length,
  fontFaceTotal: faces.length,
  fontFaceWithSizeAdjust: faces.filter((f) => /size-adjust/.test(f)).length,
  fontFaceWithLocalSrc: faces.filter((f) => /local\(/.test(f)).length,
  fontFileCount: fontFiles.length,
  fontBytes,

  // Invariants. Any of these flipping is a real regression, and each one is a bug we
  // actually shipped or nearly shipped at some point.
  googleapisRefs: (css.match(/googleapis/g) || []).length,
  gstaticRefs: (css.match(/gstatic/g) || []).length,
  blinkMacSystemFontLocals: (css.match(/local\(["']?BlinkMacSystemFont/g) || []).length,
  arialLocals: countLocals(css, 'Arial'),
  liberationSansLocals: countLocals(css, 'Liberation Sans'),
  timesNewRomanLocals: countLocals(css, 'Times New Roman'),
  liberationSerifLocals: countLocals(css, 'Liberation Serif'),
  courierNewLocals: countLocals(css, 'Courier New'),
  liberationMonoLocals: countLocals(css, 'Liberation Mono'),

  // Flat scalars, because metrics.json is also appended to a git note and rendered as a
  // two-column table; `aliasSummary` keeps the detail human-readable in both.
  aliasPairsDeclared: aliasStats.length,
  aliasPairsPresent: aliasStats.filter((s) => s.primaryLocals > 0).length,
  aliasPairsMismatched: aliasStats.filter(
    (s) => s.primaryLocals > 0 && s.primaryLocals !== s.aliasLocals,
  ).length,
  aliasOrphanFaces: aliasStats.reduce((n, s) => n + s.orphanFaces, 0),
  aliasSummary: aliasStats
    .map((s) => `${s.primary}=${s.primaryLocals}/${s.alias}=${s.aliasLocals}`)
    .join('; '),
  leakedThemeAtRule: /@theme/.test(css) ? 1 : 0,
  defaultFontFamilyIsVar: /--default-font-family:\s*var\(/.test(css) ? 1 : 0,
  themeVarsWithFallback: (css.match(/--font-[a-z-]+:[^;}]*Fallback:/g) || []).length,
}

console.log(JSON.stringify(metrics, null, 2))
