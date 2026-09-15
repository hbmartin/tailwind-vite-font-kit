import { stripFallbacks, metricFaces } from './browser-benchmark-css.mjs'
// Usage: node harness/browser-benchmark-bundles.mjs KIT_PUBLIC MANUAL_PUBLIC KIT_MODULES OUT
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'

const [kitPublic, manualPublic, moduleFile, out] = process.argv.slice(2)
if (!out) throw new Error('Pass KIT_PUBLIC MANUAL_PUBLIC KIT_MODULES OUT')
const stats = (dir) =>
  readdirSync(join(dir, 'assets'))
    .filter((name) => !/\.(?:gz|br|zst|map)$/.test(name))
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
const kitRoot = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/')
const suspectModules = modules.filter((m) => {
  const id = m.id.replaceAll('\\', '/')
  return (
    id.startsWith(`${kitRoot}src/`) ||
    /(?:^|\/)node_modules\/(?:@capsizecss\/|fontkit\/|wawoff2\/|es-module-lexer\/|tailwind-vite-font-kit\/)/.test(
      id,
    )
  )
})
const portable = (m) => {
  const id = m.id.replaceAll('\\', '/')
  if (id.startsWith(kitRoot + 'src/')) return { ...m, id: id.replace(kitRoot, '<font-kit>/') }
  if (id.includes('node_modules/')) return { ...m, id: id.slice(id.indexOf('node_modules/')) }
  return { ...m, id: id.replace(/^.*?\/src\//, '<reference-app>/src/') }
}
assert(js(kit).length && js(manual).length, 'Missing JavaScript assets')
const identicalJavaScript = JSON.stringify(js(kit)) === JSON.stringify(js(manual))
const cssAssets = kit.filter((a) => a.name.endsWith('.css'))
assert(cssAssets.length, 'Missing CSS assets')
const css = cssAssets.map((a) => readFileSync(join(kitPublic, 'assets', a.name), 'utf8')).join('\n')
const plain = stripFallbacks(css)
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
  suspectModules: suspectModules.map(portable),
  largestModules: [...modules]
    .sort((a, b) => b.renderedLength - a.renderedLength)
    .slice(0, 12)
    .map(portable),
  css: {
    kit: kitCss,
    plain: plainCss,
    fallbackFaces: metricFaces(css).length,
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
