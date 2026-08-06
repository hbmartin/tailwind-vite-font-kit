#!/usr/bin/env node
// Reusable font generator. Copy this file + fonts.config.mjs into a project, run
// `node build-fonts.mjs`, and add ONE line to your Tailwind entry:
//
//     @import 'tailwindcss';
//     @import './fonts.gen.css';     <- this
//
// Everything else is generated: self-hosted woff2, real @font-face rules with
// Google's unicode-range preserved, metric-matched fallback faces, and a @theme
// block wiring each family into a Tailwind variable with its fallback already in
// the stack. Nothing to remember at the call site.
//
// Why a real on-disk file and a plain `@import`: Tailwind resolves its own imports
// with enhanced-resolve + fs.readFile, so a Vite virtual module cannot be imported
// from a Tailwind entry (hard build failure), and a `@theme` block in a stylesheet
// outside Tailwind's import graph is silently dropped.

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { entireMetricsCollection as METRICS } from '@capsizecss/metrics/entireMetricsCollection'
import config from './fonts.config.mjs'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// One generated face per local() target. A single `local("Arial")` face is a silent
// no-op on Android and most Linux, where Arial isn't installed — the face fails to
// load and the stack falls through to an unadjusted family.
// Names are DISTINCT per target: identical family names carrying conflicting
// descriptors let the last loadable one win silently.
// BlinkMacSystemFont is deliberately absent — it is a CSS keyword, not an installed
// face, and never resolves (verified: status "error" in Chrome on macOS).
const FALLBACK_TARGETS = {
  'sans-serif': [
    ['Arial', 'arial'],
    ['Helvetica Neue', 'helveticaNeue'],
    ['Segoe UI', 'segoeUI'],
    ['Roboto', 'roboto'],
  ],
  serif: [
    ['Georgia', 'georgia'],
    ['Times New Roman', 'timesNewRoman'],
  ],
  monospace: [['Courier New', 'courierNew']],
}

const pct = (n) => `${+(n * 100).toFixed(4)}%`
const metricsKey = (family) =>
  family.replace(/\s+/g, '').replace(/^(.)/, (m) => m.toLowerCase())

// If the family carries an `opsz` axis, PIN it in the request URL rather than trying
// to compensate for it later. The served woff2 then has no opsz axis at all: the
// problem stops existing, static metrics become valid again, no app CSS is involved,
// and the file is ~45% smaller. Only ~1.5% of Google Fonts families carry opsz
// (Fraunces, Inter, DM Sans, Playfair, Literata, Nunito Sans, Roboto Flex, …), so this
// branch is rare — but when it fires, the un-pinned error reaches +22% at display sizes.
// Pin near the median size the family renders at: ~16 for body, ~48 for display.
function googleUrl(fam) {
  let axes = fam.axes ?? `wght@${[...fam.weights].sort((a, b) => a - b).join(';')}`
  if (/(^|,)opsz/.test(axes)) {
    const pin = fam.opszPin ?? 16
    // 'opsz,wght@9..144,500;9..144,700' -> 'opsz,wght@48,500;48,700'
    axes = axes.replace(/@(.*)$/, (_, tuples) =>
      '@' + tuples.split(';').map((t) => t.replace(/^[\d.]+\.\.[\d.]+/, String(pin))).join(';'),
    )
    console.log(`  opsz axis detected -> pinned at ${pin}`)
  }
  return `https://fonts.googleapis.com/css2?family=${fam.name.replace(/\s+/g, '+')}:${axes}&display=swap`
}

// Per-weight metrics. A bold face is materially wider than its regular — Arial 700 is
// 7.7% wider than Arial regular — so ONE fallback face for a family is wrong for every
// weight but one. capsize ships `variants` for all 1,921 families, and for the fallback
// targets too, so this is free and offline. Targets only carry regular + 700.
const variantOf = (m, weight) =>
  m.variants?.[String(weight)] ?? m.variants?.[weight >= 600 ? '700' : 'regular'] ?? m
const targetVariant = (m, weight) =>
  m.variants?.[weight >= 600 ? '700' : 'regular'] ?? m

// ascent/descent/line-gap are divided by size-adjust because the browser applies
// size-adjust to them too; pre-compensating makes the final values equal the web font's.
function fallbackFaces(family, subset, weights) {
  const m = METRICS[metricsKey(family)]
  if (!m) {
    console.warn(`  ! no metrics for "${family}" — skipping fallback faces`)
    return { css: '', names: [] }
  }
  const cat = FALLBACK_TARGETS[m.category] ? m.category : 'sans-serif'
  const out = []
  const names = []
  for (const [localName, key] of FALLBACK_TARGETS[cat]) {
    const fbFamily = METRICS[key]
    if (!fbFamily) continue
    const name = `${family} Fallback: ${localName}`
    names.push(name)
    for (const weight of weights) {
      const v = variantOf(m, weight)
      const fb = targetVariant(fbFamily, weight)
      // Subset data lives on the family entry, not the variant; fall back to it.
      const xAvg = v.xWidthAvg ?? m.subsets?.[subset]?.xWidthAvg ?? m.xWidthAvg
      const fbAvg = fb.xWidthAvg ?? fbFamily.subsets?.[subset]?.xWidthAvg ?? fbFamily.xWidthAvg
      const upem = v.unitsPerEm ?? m.unitsPerEm
      const fbUpem = fb.unitsPerEm ?? fbFamily.unitsPerEm
      const sizeAdjust = xAvg / upem / (fbAvg / fbUpem)
      out.push(
        `@font-face{font-family:"${name}";font-weight:${weight};src:local("${localName}");` +
          `size-adjust:${pct(sizeAdjust)};` +
          `ascent-override:${pct(v.ascent / (upem * sizeAdjust))};` +
          `descent-override:${pct(Math.abs(v.descent) / (upem * sizeAdjust))};` +
          `line-gap-override:${pct(v.lineGap / (upem * sizeAdjust))}}`,
      )
    }
  }
  return { css: out.join('\n'), names }
}

const realFaces = []
const fallbackCss = []
const themeLines = []
const preloads = []
const seenFiles = new Map()

mkdirSync(config.outDir, { recursive: true })
mkdirSync(dirname(config.outCss), { recursive: true })

for (const fam of config.families) {
  const url = googleUrl(fam)
  console.log(`\n${fam.name}\n  ${url}`)
  const css = await fetch(url, { headers: { 'user-agent': UA } }).then((r) => r.text())

  const blocks = [...css.matchAll(/\/\*\s*([a-z0-9-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g)]
  const wanted = blocks.filter(([, subset]) => config.subsets.includes(subset))
  if (!wanted.length) throw new Error(`no ${config.subsets.join('/')} blocks for ${fam.name}`)

  // 'self-host' (default) rewrites src to your origin; 'cdn' keeps Google's gstatic
  // URL. Either way the @font-face rules, the unicode-range splits and the metric
  // fallbacks are identical — only the src changes. That is the CDN-vs-self-host
  // toggle: no tool in the ecosystem offers it, because fontless hard-rewrites every
  // remote src and unplugin-fonts' google provider never downloads at all.
  const selfHost = (fam.strategy ?? 'self-host') === 'self-host'

  for (const [, , block] of wanted) {
    const weight = /font-weight:\s*([^;]+)/.exec(block)[1].trim()
    const style = /font-style:\s*([^;]+)/.exec(block)[1].trim()
    const src = /src:\s*url\(([^)]+)\)/.exec(block)[1]
    const range = /unicode-range:\s*([^;}]+)/.exec(block)?.[1].trim()

    let href = src
    if (selfHost) {
      let file = seenFiles.get(src)
      if (!file) {
        file = `${fam.name.toLowerCase().replace(/\s+/g, '-')}-${src.split('/').pop()}`
        const buf = Buffer.from(
          await fetch(src, { headers: { 'user-agent': UA } }).then((r) => r.arrayBuffer()),
        )
        writeFileSync(join(config.outDir, file), buf)
        seenFiles.set(src, file)
        console.log(`  downloaded ${file} (${(buf.length / 1024).toFixed(1)} kB)`)
      }
      href = `${config.publicPath}/${file}`
    }

    realFaces.push(
      `@font-face{font-family:"${fam.name}";font-style:${style};font-weight:${weight};` +
        `font-display:swap;src:url(${href}) format("woff2")` +
        (range ? `;unicode-range:${range}` : '') +
        `}`,
    )

    const w = Number(String(weight).split(' ')[0])
    if (fam.preloadWeights?.includes(w) && !preloads.some((p) => p.href === href)) {
      preloads.push({
        rel: 'preload',
        as: 'font',
        type: 'font/woff2',
        href,
        crossOrigin: 'anonymous',
      })
    }
  }

  const { css: fbCss, names } = fallbackFaces(fam.name, config.subsets[0], fam.weights)
  if (fbCss) fallbackCss.push(fbCss)

  // Plain `@theme`, not `@theme inline`. Under `inline` Tailwind bakes the literal
  // value into `.font-*` utilities and into `--default-font-family`, so nothing
  // downstream can override it. Non-inline keeps the `var()` indirection.
  const stack = [`'${fam.name}'`, ...names.map((n) => `'${n}'`), ...fam.stack]
  themeLines.push(`  ${fam.themeVar}: ${stack.join(', ')};`)
  console.log(`  ${fam.themeVar} -> ${names.length} fallback faces`)
}

const nFallback = fallbackCss.join('\n').split('@font-face').length - 1
const out = `/* GENERATED by build-fonts.mjs — do not edit. Run \`node build-fonts.mjs\`. */

${realFaces.join('\n')}

${fallbackCss.join('\n')}

@theme {
${themeLines.join('\n')}
}
`
writeFileSync(config.outCss, out)

writeFileSync(
  join(dirname(config.outCss), 'fonts.gen.ts'),
  `// GENERATED by build-fonts.mjs — do not edit.\n` +
    `export const fontPreloads = ${JSON.stringify(preloads, null, 2)} as const\n`,
)

console.log(`\nwrote ${config.outCss}`)
console.log(`  ${realFaces.length} real faces, ${nFallback} fallback faces, ${preloads.length} preloads`)
console.log(`\nAdd to your Tailwind entry, after \`@import 'tailwindcss';\`:`)
console.log(`  @import './${config.outCss.split('/').pop()}';`)
