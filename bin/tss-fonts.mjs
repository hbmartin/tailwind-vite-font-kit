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
import { loadAndValidate, loadFontsConfig, validateFamilies } from '../src/config.mjs'
import {
  detectTailwindEntry,
  detectViteConfig,
  scanCssFonts,
  buildFontPlan,
  GENERIC_STACK_RE,
} from '../src/detect.mjs'
import { insertFontsPlugin } from '../src/codemod-vite.mjs'
import { codemodCss } from '../src/codemod-css.mjs'
import { color, unifiedDiff } from '../src/diff.mjs'

const args = process.argv.slice(2)
const cmd = args[0]
const flag = (n) => args.includes(`--${n}`)
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i === -1 ? d : args[i + 1]
}
const DRY = flag('dry-run')
const root = resolve(opt('cwd', process.cwd()))

// Built from src/diff.mjs's palette rather than a second set of escape codes, so NO_COLOR
// is honoured everywhere the CLI prints — it was respected in the diffs and ignored in the
// surrounding prose, which is worse than not supporting it at all.
const c = {
  dim: color.dim,
  b: color.bold,
  g: color.green,
  y: color.yellow,
  r: color.red,
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
  ${c.b('opsz')}    measure a family's optical-size axis and recommend an opszPin.
  ${c.b('early-hints')}
          write src/server.ts, a TanStack Start entry that ships the preloads as
          103 Early Hints — the only mechanism that beats a slow route loader.

  --dry-run   print the diff, write nothing
  --cwd DIR   run against DIR instead of the current directory

${c.b('tss-fonts opsz')} <Family> [--sizes 16,24,48,96] [--weights 400,700] [--write]

  Downloads the variable font once and measures how much its advance widths move
  across those sizes, then tells you what to pin \`opszPin\` at. Without it the
  default is 16, which is a guess — and on some families (Nunito Sans: 6..12) it
  is outside the axis entirely. --write puts the answer in fonts.config.mjs.

  Needs the optional peers: ${c.dim('pnpm add -D fontkit wawoff2')}
`)
  process.exit(0)
}
if (cmd !== 'adopt' && cmd !== 'init' && cmd !== 'opsz' && cmd !== 'early-hints') {
  die(`unknown command "${cmd}". Try \`tss-fonts help\`.`)
}

// ---------------------------------------------------------------------------
// early-hints — write the Start server entry. One file, two lines; everything
// interesting lives in the package so a fix reaches you through npm.
// ---------------------------------------------------------------------------

if (cmd === 'early-hints') {
  // Start resolves `src/server.ts` as the server entry — always .ts, regardless of
  // whether the project has a tsconfig. Vite compiles it either way, and the body below
  // is plain JS, so a JS project loses nothing by the extension.
  const dest = join(root, 'src', 'server.ts')
  const body =
    `// TanStack Start server entry. Ships the font preloads as 103 Early Hints, which is\n` +
    `// the only preload mechanism that can beat a slow route loader — Start's first byte\n` +
    `// waits on the loader, a 103 does not. Worth nothing on fast routes.\n` +
    `import { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'\n\n` +
    `export default createFontsServerEntry()\n`

  if (!existsSync(join(root, 'src'))) {
    die(`no src/ directory under ${root} — is this a TanStack Start app? Pass --cwd.`)
  }
  const before = existsSync(dest) ? readFileSync(dest, 'utf8') : ''
  if (before === body) {
    console.log(`${c.g('✓')} ${relative(root, dest)} is already this entry — nothing to do.`)
    process.exit(0)
  }
  if (before) {
    // A hand-written server entry is not ours to overwrite: it may wrap the handler,
    // add middleware, or do anything else. Show what to add instead.
    console.log(
      `${c.y('!')} ${relative(root, dest)} already exists. Add the wrapper by hand:\n\n${body}`,
    )
    process.exit(0)
  }
  console.log(`\n${c.b(relative(root, dest))} ${c.g('(new)')}`)
  console.log(unifiedDiff('', body, relative(root, dest)))
  if (DRY) {
    console.log(`\n${c.y('--dry-run')} — nothing written.`)
    process.exit(0)
  }
  writeFileSync(dest, body)
  console.log(`\n${c.g('✓')} wrote ${relative(root, dest)}`)
  console.log(
    c.dim(
      '  Early Hints need HTTP/2+ for Chrome to act on them, and a Node runtime for\n' +
        '  writeEarlyHints. Elsewhere this degrades to the Link: header, which the plugin\n' +
        '  already sets — so it is safe everywhere, just not always a win.',
    ),
  )
  process.exit(0)
}

// ---------------------------------------------------------------------------
// opsz — read-only unless --write, and it never touches CSS, so it runs before
// any of the project detection the other two commands need.
// ---------------------------------------------------------------------------

if (cmd === 'opsz') {
  // Absent is not the same as invalid: a missing option falls back to the defaults, but
  // `--sizes foo` or `--weights 0,-400` must be rejected — an empty or negative list
  // would silently skew the measurement (and the printout) instead of erroring.
  const nums = (name) => {
    const raw = opt(name)
    if (raw === undefined) return undefined
    const list = String(raw).split(',').map(Number)
    if (list.some((n) => !Number.isFinite(n) || n <= 0)) {
      die(`--${name} expects a comma-separated list of positive numbers, got "${raw}"`)
    }
    return list
  }
  const family = args[1] && !args[1].startsWith('--') ? args[1] : null
  const sizes = nums('sizes')
  const weights = nums('weights')

  const cfgPath = join(root, 'fonts.config.mjs')
  /** @type {import('../index.d.ts').FontFamily[]} */
  let configured = []
  if (existsSync(cfgPath)) {
    // Same load-and-validate path as adopt: a config this tool cannot understand has to
    // stop the run — --write would otherwise do text surgery on a file it cannot parse.
    const cfg = await loadAndValidate(cfgPath, 'fonts.config.mjs').catch(
      /** @param {Error} err */ (err) => die(err.message),
    )
    configured = /** @type {import('../index.d.ts').FontFamily[]} */ (cfg.families)
  }

  // With no family named, measure every family the project already declares — that is
  // the question someone actually has after `init`.
  /** @type {import('../index.d.ts').FontFamily[]} */
  const targets = family
    ? [
        configured.find(
          (f) => f.name.toLowerCase() === family.toLowerCase(),
        ) ?? /** @type {import('../index.d.ts').FontFamily} */ ({ name: family }),
      ]
    : configured
  if (!targets.length) {
    die(
      `name a family, e.g. \`tss-fonts opsz Fraunces\`, or run this in a project with a fonts.config.mjs.`,
    )
  }

  const { recommendOpszPin } = await import('../src/opsz-auto.mjs')
  /** @type {{name: string, pin: number}[]} */
  const found = []

  for (const fam of targets) {
    const want = { ...fam, weights: weights ?? fam.weights }
    process.stdout.write(`${c.b(fam.name)} `)
    let rec
    try {
      rec = await recommendOpszPin(want, { sizes })
    } catch (err) {
      console.log(c.r('failed'))
      console.log(`  ${err.message}`)
      continue
    }
    if (!rec.hasOpsz) {
      console.log(c.dim('— no opsz axis'))
      console.log(c.dim(`  ${rec.reason}`))
      continue
    }
    console.log('')
    console.log(
      `  axis          opsz ${rec.axis.min}..${rec.axis.max} (fvar default ${rec.axis.default})`,
    )
    console.log(
      `  width swing   ${rec.swingPct}% across ${(sizes ?? [16, 24, 48, 96]).join(', ')}px`,
    )
    console.log(`  ${c.g('recommended')}   ${c.b(`opszPin: ${rec.pin}`)}`)
    if (fam.opszPin != null && fam.opszPin !== 'auto' && fam.opszPin !== rec.pin) {
      console.log(`  ${c.y('note')}          your config says opszPin: ${fam.opszPin}`)
    }
    found.push({ name: fam.name, pin: rec.pin })
  }

  if (flag('write')) {
    if (!found.length) die('nothing to write — no family had an opsz axis.')
    if (!existsSync(cfgPath)) die(`no fonts.config.mjs in ${root} to write to.`)
    let text = readFileSync(cfgPath, 'utf8')
    const before = text
    // Rewrite descending, so an earlier edit never shifts a later entry's offsets.
    for (const { name, pin } of [...found].reverse()) {
      const edited = setOpszPin(text, name, pin)
      if (edited == null) {
        console.log(
          `  ${c.y('!')} could not locate ${name} in fonts.config.mjs — set opszPin: ${pin} by hand`,
        )
      } else {
        text = edited
      }
    }
    if (text === before) {
      console.log(`\n${c.dim('fonts.config.mjs already matches — nothing to write.')}`)
    } else if (DRY) {
      console.log(`\n${c.y('--dry-run')} — fonts.config.mjs would change:`)
      console.log(unifiedDiff(before, text, 'fonts.config.mjs'))
    } else {
      copyFileSync(cfgPath, cfgPath + '.bak')
      writeFileSync(cfgPath, text)
      console.log(`\n${c.g('✓')} wrote fonts.config.mjs (backup: fonts.config.mjs.bak)`)
    }
  } else if (found.length) {
    console.log(
      `\n${c.dim("Pass --write to put this in fonts.config.mjs, or set opszPin: 'auto'.")}`,
    )
  }
  process.exit(0)
}

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
  // Validated before anything else reads it: the next section DELETES the CSS that
  // names these families, so a config this tool cannot understand has to stop the run
  // rather than fail partway through with a TypeError.
  const cfg = await loadFontsConfig(configPath).catch((err) =>
    die(`could not load fonts.config.mjs — ${err.message}`),
  )
  try {
    families = validateFamilies(cfg.families, 'fonts.config.mjs')
  } catch (err) {
    die(`${err.message}\n\n  ${c.b('--from-css')}  ignore it and adopt what your CSS uses instead`)
  }
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
console.log(`\n${c.g('✓')} wrote ${edits.length} file(s). Backups: *.bak ${c.dim('(gitignored)')}`)

// `adopt` has just deleted the CSS that was applying these fonts, and unlike `init` it
// does not wire the plugin. Until fonts() is in the plugins array the app has NO fonts —
// so this is a warning when the config actually lacks it, not a dim footnote either way.
if (cmd === 'adopt') {
  const vite = detectViteConfig(root)
  const vText = vite ? readFileSync(vite, 'utf8') : ''
  // The package name alone is not wiring — a commented-out line or an unused import
  // matches it, and the app still has no fonts. Require an actual fonts() call too.
  const wired = vite && vText.includes('tailwind-vite-font-kit') && /\bfonts\s*\(/.test(vText)
  if (wired) {
    console.log(c.dim(`  ${relative(root, vite)} already has the plugin — you are done.`))
  } else {
    console.log(
      `\n${c.y('!')} ${c.b('Your app has no fonts until you add the plugin.')} The declarations that\n` +
        `  were applying them have just been removed, and the generated ones only exist\n` +
        `  once fonts() runs.\n\n` +
        `  ${c.b('npx tss-fonts init')}   does it for you\n` +
        (vite
          ? `  or add it by hand to ${relative(root, vite)}, BEFORE tailwindcss():${snippet()}`
          : `  or add it by hand:${snippet()}`),
    )
  }
}

// ---------------------------------------------------------------------------

/**
 * Set `opszPin` on one family's entry in a fonts.config.mjs, by text surgery.
 *
 * Scoped by braces rather than by regex distance: a config with several families has
 * several `opszPin:` lines, and matching the nearest one to a family name is how you end
 * up writing a display face's pin onto the body face. Finds the object literal that
 * CONTAINS this family's `name:`, and edits only inside it.
 *
 * @param {string} text
 * @param {string} family
 * @param {number} pin
 * @returns {string | null} the edited text, or null when the entry could not be located
 */
function setOpszPin(text, family, pin) {
  const nameRe = new RegExp(`name:\\s*['"\`]${family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`)
  const at = text.search(nameRe)
  if (at === -1) return null

  // Walk out to the enclosing `{`, then match forward to its `}`.
  let open = text.lastIndexOf('{', at)
  if (open === -1) return null
  let depth = 1
  let i = open + 1
  while (i < text.length && depth > 0) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') depth--
    i++
  }
  const entry = text.slice(open, i)

  const existing = /(\n?[ \t]*opszPin:\s*)(?:[\d.]+|['"]auto['"])(,?)/.exec(entry)
  const edited = existing
    ? entry.replace(existing[0], `${existing[1]}${pin}${existing[2] || ','}`)
    : // No pin yet — insert after the name, matching the entry's own layout. A one-line
      // entry (`{ name: 'Inter', weights: [400] }`) stays on one line; a multi-line one
      // gets a new line at the name line's indent. Splitting a one-line entry produced
      // valid but unindented output, which is a diff nobody wants to review.
      entry.replace(nameRe, (m) => {
        const at = entry.search(nameRe)
        const lineStart = entry.lastIndexOf('\n', at) + 1
        const multiline = entry.slice(0, at).includes('\n') || entry.slice(at).includes('\n')
        if (!multiline) return `${m}, opszPin: ${pin}`
        const indent = /^[ \t]*/.exec(entry.slice(lineStart))?.[0] ?? '      '
        return `${m},\n${indent}opszPin: ${pin}`
      })

  return text.slice(0, open) + edited + text.slice(i)
}

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
