#!/usr/bin/env node
// tss-fonts — one-time project wiring. Everything that happens on every build lives in
// the Vite plugin; this only touches your source files, once, with a printed diff.
//
//   npx tss-fonts adopt          migrate existing font CSS (the shadcn path)
//   npx tss-fonts init           adopt + write fonts.config.mjs + edit vite.config.ts
//   npx tss-fonts <cmd> --dry-run
//
// Deliberately absent: any edit to routes/__root.tsx. Preloads ship as an HTTP `Link:`
// header from the plugin, so there is nothing to splice into head().links — which is
// what the tested codemods were most brittle at (4 of 12 root-route shapes bailed).

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  detectTailwindEntry,
  detectViteConfig,
  scanCssFonts,
  buildFontPlan,
  GENERIC_STACK_RE,
} from '../src/detect.mjs'
import { insertFontsPlugin } from '../src/codemod-vite.mjs'
import { codemodCss } from '../src/codemod-css.mjs'
import { unifiedDiff } from '../src/diff.mjs'

const args = process.argv.slice(2)
const cmd = args[0]
const flag = (n) => args.includes(`--${n}`)
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i === -1 ? d : args[i + 1]
}
const DRY = flag('dry-run')
const root = resolve(opt('cwd', process.cwd()))

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
}
// Annotated on the binding, not the arrow: TS only narrows control flow past a
// never-returning call when the *variable* carries the type.
/** @type {(m: string) => never} */
const die = (m) => {
  console.error(`${c.r('error')} ${m}`)
  process.exit(1)
}

if (!cmd || flag('help') || cmd === 'help') {
  console.log(`
${c.b('tss-fonts')} — wiring for tailwind-vite-font-kit

  ${c.b('adopt')}   migrate a project that already has fonts: remove the Google @import,
          remove --font-* from your @theme (the generated one owns them now), and
          point hand-written font-family rules at the theme var.
  ${c.b('init')}    adopt, plus write fonts.config.mjs and add fonts() to vite.config.ts.

  --dry-run   print the diff, write nothing
  --cwd DIR   run against DIR instead of the current directory
`)
  process.exit(0)
}
if (cmd !== 'adopt' && cmd !== 'init') die(`unknown command "${cmd}". Try \`tss-fonts help\`.`)

// ---------------------------------------------------------------------------
// locate the project
// ---------------------------------------------------------------------------

const found = detectTailwindEntry(root)
if (!found) {
  die(
    `could not find a stylesheet containing \`@import 'tailwindcss'\` under ${root}.\n` +
      `  Pass --cwd, or add the import to your entry CSS first.`,
  )
}
const entry = found.path
const entryText = readFileSync(entry, 'utf8')
console.log(`${c.dim('tailwind entry')}  ${relative(root, entry)}`)
if (found.all.length > 1) {
  console.log(
    `${c.y('!')} ${found.all.length} stylesheets import tailwindcss; using the shallowest. ` +
      `Others: ${found.all
        .slice(1)
        .map((f) => relative(root, f))
        .join(', ')}`,
  )
}

// ---------------------------------------------------------------------------
// work out which families we own
// ---------------------------------------------------------------------------

const configPath = join(root, 'fonts.config.mjs')
// Assigned in both branches below; the else branch exits when it finds nothing.
/** @type {import('../index.d.ts').FontFamily[]} */
let families
let detectedFromConfig = false

if (existsSync(configPath) && !flag('from-css')) {
  const mod = await import(pathToFileURL(configPath).href + `?t=${Date.now()}`)
  families = (mod.default ?? mod).families
  detectedFromConfig = true
  console.log(
    `${c.dim('config')}          fonts.config.mjs (${families.map((f) => f.name).join(', ')})`,
  )

  // `shadcn add` always drops the template config, so on a project that already uses
  // different fonts the config and the CSS disagree. Say so rather than silently
  // migrating the CSS to a family the project never used.
  const inCss = scanCssFonts(entryText)
  const cssFamilies = new Set(
    inCss.googleUrls
      .flatMap((u) => u.match(/family=([^:&]+)/g) ?? [])
      .map((m) => decodeURIComponent(m.slice('family='.length)).replace(/\+/g, ' ')),
  )
  // The --font-* declarations the codemod deletes (the ones the config owns) also name
  // families; one naming a real family the config doesn't know is the same hazard.
  const ownedByConfig = new Set(families.map((f) => f.themeVar))
  for (const tv of inCss.themeVars) {
    if (!ownedByConfig.has(tv.varName)) continue
    if (tv.first && !GENERIC_STACK_RE.test(tv.first)) cssFamilies.add(tv.first)
  }
  const missing = [...cssFamilies].filter(
    (n) => !families.some((f) => f.name.toLowerCase() === n.toLowerCase()),
  )
  // Refuse, don't warn-and-proceed. Adopting deletes the CSS that names these families,
  // so continuing with the wrong config destroys the only record of what the project used.
  if (missing.length && !flag('force')) {
    console.error(
      `\n${c.r('stopped')} your CSS uses ${c.b(missing.join(', '))}, ` +
        `which ${missing.length > 1 ? 'are' : 'is'} not in fonts.config.mjs (${families.map((f) => f.name).join(', ')}).\n\n` +
        `  Adopting would delete the CSS that names ${missing.length > 1 ? 'them' : 'it'}, so this is almost certainly not what you want.\n\n` +
        `  ${c.b('--from-css')}  adopt what the project actually uses (overwrites fonts.config.mjs)\n` +
        `  ${c.b('--force')}     proceed with fonts.config.mjs as written\n\n` +
        c.dim(
          `  If fonts.config.mjs is still the template \`shadcn add\` installed, you want --from-css.`,
        ),
    )
    process.exit(1)
  }
} else {
  if (flag('from-css') && existsSync(configPath)) {
    console.log(`${c.dim('--from-css')}      ignoring the existing fonts.config.mjs`)
  }
  // Zero-config: adopt whatever the project already uses.
  const plan = buildFontPlan({
    cssText: entryText,
    flags: {
      sans: opt('sans'),
      display: opt('display'),
      mono: opt('mono'),
      preload: opt('preload'),
    },
  })
  families = plan.assigned
  if (!families?.length) {
    // No config file and nothing left to detect: either this project was already
    // adopted (we deleted the CSS that described the fonts) or it has no fonts.
    // Neither is an error.
    console.log(
      `\n${c.g('✓')} nothing to adopt — no Google @import and no --font-* vars in ` +
        `${relative(root, entry)}.\n` +
        c.dim('  Already migrated, or configure families inline in vite.config.ts.'),
    )
    process.exit(0)
  }
  console.log(
    `${c.dim('detected')}        ${families.map((f) => f.name).join(', ')} ${c.dim('(from your CSS)')}`,
  )
}

const ownedVars = families.map((f) => f.themeVar)
const rewriteUsages = families.map((f) => ({ family: f.name, themeVar: f.themeVar }))

// ---------------------------------------------------------------------------
// 1. the CSS codemod
// ---------------------------------------------------------------------------

const res = codemodCss(entryText, { ownedVars, rewriteUsages, addImport: false })
if (!res.ok) die(res.reason)

const edits = []
if (res.css !== entryText) {
  edits.push([entry, entryText, res.css])
  console.log(`\n${c.b(relative(root, entry))}`)
  for (const ch of res.changes) console.log(`  ${c.g('•')} ${ch}`)
  console.log(unifiedDiff(entryText, res.css, relative(root, entry)))
} else {
  console.log(
    `\n${c.dim('nothing to change in')} ${relative(root, entry)} ${c.dim('(already adopted)')}`,
  )
}

// ---------------------------------------------------------------------------
// 2. init-only: fonts.config.mjs + vite.config.ts
// ---------------------------------------------------------------------------

// `adopt` deletes the CSS that described the fonts, so it must persist what it found
// or the information is lost and the plugin has nothing to work from. Writing it also
// makes a second run idempotent: the config is found, the CSS is already clean, no-op.
// Write whenever the families came from the CSS rather than the config — including
// `--from-css`, which explicitly means "overwrite what's there".
if (!detectedFromConfig) {
  const body = renderConfig(families)
  const before = existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
  if (before !== body) {
    edits.push([configPath, before, body])
    console.log(
      `\n${c.b('fonts.config.mjs')} ${before ? c.y('(overwritten)') : c.g('(new)')} ${c.dim('— captured from your CSS')}`,
    )
    console.log(unifiedDiff(before, body, 'fonts.config.mjs'))
  }
}

if (cmd === 'init') {
  const vite = detectViteConfig(root)
  if (!vite) {
    console.log(`\n${c.y('!')} no vite.config.ts found — add the plugin yourself:\n${snippet()}`)
  } else {
    const vText = readFileSync(vite, 'utf8')
    if (vText.includes('tailwind-vite-font-kit')) {
      console.log(`\n${c.dim('vite.config already has the plugin (skipped)')}`)
    } else {
      const out = insertFontsPlugin(vText)
      if (out == null) {
        console.log(
          // insertFontsPlugin() bails for several reasons — no tailwindcss() call, more
          // than one, one that is not a plugins-array entry, no import to hang fonts()
          // off — so the message stays neutral rather than naming the wrong cause.
          `\n${c.y('!')} could not safely insert \`fonts()\` into ${relative(root, vite)} — ` +
            `add the plugin by hand, BEFORE tailwindcss():\n${snippet()}`,
        )
      } else {
        edits.push([vite, vText, out])
        console.log(`\n${c.b(relative(root, vite))}`)
        console.log(`  ${c.g('•')} added fonts() before tailwindcss()`)
        console.log(unifiedDiff(vText, out, relative(root, vite)))
      }
    }
  }
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

if (!edits.length) {
  console.log(`\n${c.g('✓')} nothing to do.`)
  process.exit(0)
}
if (DRY) {
  console.log(`\n${c.y('--dry-run')} — no files written (${edits.length} would change).`)
  process.exit(0)
}
for (const [file, before, after] of edits) {
  if (before && before !== after) copyFileSync(file, file + '.bak')
  writeFileSync(file, after)
}
console.log(`\n${c.g('✓')} wrote ${edits.length} file(s). Backups: *.bak`)
if (cmd === 'adopt')
  console.log(c.dim('  If you have not added fonts() to vite.config.ts yet, see `tss-fonts init`.'))

// ---------------------------------------------------------------------------

function renderConfig(fams) {
  return (
    `// tailwind-vite-font-kit. Edit this, then rebuild — the plugin regenerates on change.\n` +
    `export default {\n  families: [\n` +
    fams
      .map(
        (f) =>
          `    {\n      name: '${f.name}',\n      themeVar: '${f.themeVar}',\n` +
          `      weights: [${f.weights.join(', ')}],\n` +
          (f.axes ? `      axes: '${f.axes}',\n` : '') +
          (f.opszPin ? `      opszPin: ${f.opszPin},\n` : '') +
          `      stack: [${(f.stack ?? []).map((s) => `'${s}'`).join(', ')}],\n` +
          // Preloading is zero-sum against the render-blocking stylesheet:
          // FCP cost ~= preloaded bytes / bandwidth. Body face only, by default.
          `      preloadWeights: [${(f.preloadWeights ?? []).join(', ')}],\n    },`,
      )
      .join('\n') +
    `\n  ],\n}\n`
  )
}

function snippet() {
  return `
  import { fonts } from 'tailwind-vite-font-kit'
  // ...
  plugins: [
    nitro(),
    fonts(),          // <- BEFORE tailwindcss(); both are enforce:'pre', array order decides
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ]`
}
