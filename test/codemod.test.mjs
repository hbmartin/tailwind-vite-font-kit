import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codemodCss } from '../src/codemod-css.mjs'
import { themeBlocks, familiesFromGoogleUrl, scanCssFonts } from '../src/detect.mjs'

const OWNED = ['--font-sans', '--font-display']
const USAGES = [
  { family: 'Poppins', themeVar: '--font-sans' },
  { family: 'Fraunces', themeVar: '--font-display' },
]
const run = (css) => codemodCss(css, { ownedVars: OWNED, rewriteUsages: USAGES })

const MESSY = `@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700&family=Poppins:wght@400;500&display=swap');
@import 'tailwindcss';

@theme inline {
  --font-sans: 'Poppins', ui-sans-serif, system-ui, sans-serif;
  --color-bg: var(--bg);
}

.display-title {
  font-family: 'Fraunces', Georgia, serif;
}
`

test('removes the Google @import, the owned var, and rewrites the usage', () => {
  const { ok, css, changes } = run(MESSY)
  assert.ok(ok)
  assert.ok(!/fonts\.googleapis\.com/.test(css))
  assert.ok(!/--font-sans\s*:/.test(css))
  assert.match(css, /font-family:\s*var\(--font-display\)/)
  // untouched neighbours survive
  assert.match(css, /--color-bg: var\(--bg\)/)
  assert.match(css, /@import 'tailwindcss'/)
  assert.equal(changes.length, 3)
})

test('is idempotent — a second pass changes nothing', () => {
  const once = run(MESSY).css
  const twice = run(once).css
  assert.equal(once, twice)
})

test('does not add a physical @import (the Vite plugin injects it in-memory)', () => {
  assert.ok(!/fonts\.gen\.css/.test(run(MESSY).css))
})

test('leaves font-family declarations inside @font-face alone', () => {
  const css = `@import 'tailwindcss';
@font-face { font-family: 'Poppins'; src: url(/a.woff2); }
.x { font-family: 'Poppins', sans-serif; }`
  const out = run(css).css
  assert.match(out, /@font-face \{ font-family: 'Poppins'/, '@font-face was rewritten')
  assert.match(out, /\.x \{ font-family: var\(--font-sans\)/)
})

test('themeBlocks brace-matches, so a nested block does not truncate the body', () => {
  // The naive /@theme inline\s*\{([\s\S]*?)\n\}/ used elsewhere stops at the first
  // column-0 brace and would mangle this.
  const css = `@theme inline {
  --font-sans: 'X';
  @supports (a:b) {
    --nested: 1;
  }
  --font-display: 'Y';
}
.after { color: red }`
  const [blk] = themeBlocks(css)
  const body = css.slice(blk.bodyStart, blk.end - 1)
  assert.ok(body.includes('--font-display'), 'body was truncated at the nested block')
  assert.ok(!body.includes('.after'), 'body ran past the closing brace')
  assert.equal(blk.inline, true)
})

test('removes owned vars from a @theme block containing nested braces', () => {
  const css = `@import 'tailwindcss';
@theme inline {
  --font-sans: 'Poppins', sans-serif;
  @supports (a:b) { --nested: 1; }
  --keep: 2;
}`
  const out = run(css).css
  assert.ok(!/--font-sans\s*:/.test(out))
  assert.match(out, /--keep: 2/)
  assert.match(out, /--nested: 1/)
})

test('familiesFromGoogleUrl parses multi-family urls with axes', () => {
  const fams = familiesFromGoogleUrl(
    'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700&family=Poppins:wght@400;500&display=swap',
  )
  const byName = Object.fromEntries(fams.map((f) => [f.name, f]))
  assert.ok(byName.Fraunces.hasOpsz)
  assert.ok(!byName.Poppins.hasOpsz)
  assert.deepEqual(byName.Poppins.weights, [400, 500])
  assert.deepEqual(byName.Fraunces.weights, [500, 700])
})

test('scanCssFonts finds theme vars and google urls', () => {
  const { themeVars, googleUrls } = scanCssFonts(MESSY)
  assert.equal(googleUrls.length, 1)
  assert.ok(themeVars.some((v) => v.varName === '--font-sans' && v.first === 'Poppins'))
})

test('a project with nothing to change reports no edits', () => {
  const clean = `@import 'tailwindcss';\n.x { color: red }`
  const { ok, css } = run(clean)
  assert.ok(ok)
  assert.equal(css, clean)
})
