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
  arialLocals: (css.match(/local\(["']?Arial["']?\)/g) || []).length,
  liberationSansLocals: (css.match(/local\(["']?Liberation Sans["']?\)/g) || []).length,
  timesNewRomanLocals: (css.match(/local\(["']?Times New Roman["']?\)/g) || []).length,
  liberationSerifLocals: (css.match(/local\(["']?Liberation Serif["']?\)/g) || []).length,
  leakedThemeAtRule: /@theme/.test(css) ? 1 : 0,
  defaultFontFamilyIsVar: /--default-font-family:\s*var\(/.test(css) ? 1 : 0,
  themeVarsWithFallback: (css.match(/--font-[a-z-]+:[^;}]*Fallback:/g) || []).length,
}

console.log(JSON.stringify(metrics, null, 2))
