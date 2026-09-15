// Usage: node harness/browser-benchmark-bundles.mjs KIT_PUBLIC MANUAL_PUBLIC KIT_MODULES OUT
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'

const [kitPublic, manualPublic, moduleFile, out] = process.argv.slice(2)
if (!out) throw new Error('Pass KIT_PUBLIC MANUAL_PUBLIC KIT_MODULES OUT')
const stats = (dir) =>
  readdirSync(join(dir, 'assets'))
    .sort()
    .map((name) => {
      const bytes = readFileSync(join(dir, 'assets', name))
      return {
        name,
        bytes: bytes.length,
        gzip: gzipSync(bytes).length,
        brotli: brotliCompressSync(bytes).length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }
    })
const kit = stats(kitPublic)
const manual = stats(manualPublic)
const js = (assets) => assets.filter((a) => a.name.endsWith('.js'))
const modules = Object.entries(JSON.parse(readFileSync(moduleFile, 'utf8'))).flatMap(
  ([chunk, entries]) => entries.map((entry) => ({ chunk, ...entry })),
)
const suspectModules = modules.filter((m) =>
  /font-kit\/src|fontkit|capsize|wawoff2|es-module-lexer/.test(m.id),
)
const identicalJavaScript = JSON.stringify(js(kit)) === JSON.stringify(js(manual))
const cssName = kit.find((a) => a.name.endsWith('.css')).name
const css = readFileSync(join(kitPublic, 'assets', cssName), 'utf8')
const fallbackPattern = /@font-face\s*\{[^{}]*size-adjust\s*:[^{}]*\}/g
const plain = css
  .replace(fallbackPattern, '')
  .replace(/(?:"[^"]* Fallback: [^"]*"|'[^']* Fallback: [^']*')\s*,\s*/g, '')
const size = (s) => ({
  raw: Buffer.byteLength(s),
  gzip: gzipSync(s).length,
  brotli: brotliCompressSync(s).length,
})
const kitCss = size(css),
  plainCss = size(plain)
const report = {
  kit,
  manual,
  identicalJavaScript,
  kitModuleCount: modules.length,
  suspectModules,
  largestModules: [...modules].sort((a, b) => b.renderedLength - a.renderedLength).slice(0, 12),
  css: {
    kit: kitCss,
    plain: plainCss,
    fallbackFaces: [...css.matchAll(fallbackPattern)].length,
    delta: Object.fromEntries(Object.keys(kitCss).map((k) => [k, kitCss[k] - plainCss[k]])),
  },
}
writeFileSync(out, JSON.stringify(report, null, 2))
assert(
  identicalJavaScript,
  'The static-CSS build changed the JavaScript output; inspect the report',
)
assert.equal(suspectModules.length, 0, 'Font build dependencies entered the client module graph')
console.log(
  JSON.stringify({ identicalJavaScript, modules: modules.length, css: report.css }, null, 2),
)
