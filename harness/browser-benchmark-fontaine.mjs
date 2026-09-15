import { stripFallbacks } from './browser-benchmark-css.mjs'
// Run the real Fontaine transform against the same self-hosted production CSS.
// Usage: node harness/browser-benchmark-fontaine.mjs INPUT_CSS FONTAINE_MODULE OUTPUT_CSS
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const [input, modulePath, output] = process.argv.slice(2)
if (!output) throw new Error('Pass INPUT_CSS FONTAINE_MODULE OUTPUT_CSS')
const { FontaineTransform } = await import(pathToFileURL(resolve(modulePath)).href)
const plain = stripFallbacks(readFileSync(input, 'utf8'))
const plugin = FontaineTransform.vite({ fallbacks: {} })
let { code } = await plugin.transform.handler(plain, '/benchmark/styles.css')
// Fontaine documents explicitly adding the fallback suffix to CSS variables.
// The reference app accesses these families through Tailwind theme variables.
for (const [variable, family] of [
  ['sans', 'Manrope'],
  ['display', 'Fraunces'],
]) {
  const original = `--font-${variable}:"${family}",`
  assert(code.includes(original), `Expected the reference app's ${variable} variable`)
  code = code.replace(original, `${original}"${family} fallback",`)
}
assert(code.includes('size-adjust:'), 'Fontaine did not emit metric fallbacks')
writeFileSync(output, code)
console.log(`Wrote ${output}`)
