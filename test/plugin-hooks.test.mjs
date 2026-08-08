// The Vite hooks themselves. `test/plugin.test.mjs` covers the entry-seen accounting;
// this covers everything that needs a real generate() behind it — the Nitro route rules,
// the asset emit, the dev middleware, the @import injection and the virtual module.
//
// Generation is driven by a mocked fetch against a temp root, so none of it touches the
// network. `strategy: 'cdn'` keeps Google's URL in src, so no woff2 is downloaded either;
// the tests that need real files on disk say so and mock the download too.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fonts } from '../src/index.mjs'

const CSS2 = `/* latin */
@font-face {
  font-family: 'Manrope';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/fake/v1/abc123.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}
`

// A real capsize family, so generation emits fallback faces and the warn channel
// stays quiet — a spurious warning in the test output trains people to ignore it.
const FAMILY = {
  name: 'Manrope',
  themeVar: '--font-sans',
  weights: [400],
  preloadWeights: [400],
  strategy: 'cdn',
}

/** A temp project root plus a fetch that answers css2 and woff2 requests. */
function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'tss-fonts-hooks-'))
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) =>
    String(url).endsWith('.woff2')
      ? new Response(new Uint8Array([0x77, 0x4f, 0x46, 0x32]), { status: 200 })
      : new Response(CSS2, { status: 200 })
  t.after(() => {
    globalThis.fetch = realFetch
    rmSync(root, { recursive: true, force: true })
  })
  return root
}

/** Run config() and hand back the nitro route rules it asked for. */
async function routeRules(t, options) {
  const root = sandbox(t)
  const plugin = fonts({ families: [FAMILY], silent: true, ...options })
  const returned = await plugin.config({ root }, { command: 'build' })
  return { rules: returned.nitro.routeRules, plugin, root }
}

test('the fonts path gets immutable caching and CORS', async (t) => {
  const { rules } = await routeRules(t)
  assert.deepEqual(
    rules['/fonts/**'].headers['cache-control'],
    'public, max-age=31536000, immutable',
  )
  assert.equal(rules['/fonts/**'].headers['access-control-allow-origin'], '*')
})

test('the preload header is set on every document route', async (t) => {
  const { rules } = await routeRules(t)
  assert.match(rules['/**'].headers.link, /^<[^>]+\.woff2>; rel=preload; as=font; /)
  assert.match(rules['/**'].headers.link, /crossorigin$/, 'crossorigin is not optional')
})

// Nitro merges every matching rule's headers key-by-key with the more specific rule last,
// so `/**` reaches the hashed build output and the font files unless a more specific rule
// overrides the key. Browsers only act on Link: for the navigation response, so without
// this every JS chunk on the page carries a few hundred wasted bytes.
test('asset paths and the fonts themselves carry an empty preload header', async (t) => {
  const { rules } = await routeRules(t)
  assert.equal(rules['/assets/**'].headers.link, '')
  assert.equal(rules['/fonts/**'].headers.link, '')
  // and the override must not have dropped the cache headers set on the same pattern
  assert.equal(rules['/fonts/**'].headers['access-control-allow-origin'], '*')
})

test('preloadHeader.exclude replaces the default exclusion list', async (t) => {
  const { rules } = await routeRules(t, { preloadHeader: { exclude: ['/static/**'] } })
  assert.equal(rules['/static/**'].headers.link, '')
  assert.equal(
    rules['/assets/**'],
    undefined,
    'an explicit list must not be merged with the default',
  )
  assert.equal(rules['/fonts/**'].headers.link, undefined)
})

test('preloadHeader: false emits no link rule at all', async (t) => {
  const { rules } = await routeRules(t, { preloadHeader: false })
  assert.equal(rules['/**'], undefined)
  assert.equal(rules['/fonts/**'].headers.link, undefined)
  assert.ok(rules['/fonts/**'].headers['cache-control'], 'caching is independent of preloading')
})

test('an unknown `output` value fails the build rather than silently caching', async (t) => {
  const root = sandbox(t)
  const plugin = fonts({ families: [FAMILY], silent: true, output: 'somewhere' })
  await assert.rejects(
    () => plugin.config({ root }, { command: 'build' }),
    /`output` must be 'cache' or 'commit'/,
  )
})

// On plain Vite the `nitro` config key is simply ignored: no preloads, no immutable
// caching, no error. "It works but slower than the README claims" is exactly the kind of
// silent degradation this package exists to stop, so it says so once.
test('a build without Nitro says the preload header was not applied', async (t) => {
  const warned = captureWarnings(t)
  const { plugin } = await routeRules(t)
  plugin.configResolved({ plugins: [{ name: 'vite:css' }, { name: '@tailwindcss/vite' }] })
  assert.match(warned.join('\n'), /no Nitro plugin found/)
  assert.match(warned.join('\n'), /virtual:fonts/, 'it should point at the way out')
})

test('a build with Nitro stays quiet', async (t) => {
  const warned = captureWarnings(t)
  const { plugin } = await routeRules(t)
  plugin.configResolved({ plugins: [{ name: 'vite:nitro' }] })
  assert.deepEqual(warned, [])
})

test('preloadHeader: false is a deliberate choice, not a missing Nitro', async (t) => {
  const warned = captureWarnings(t)
  const { plugin } = await routeRules(t, { preloadHeader: false })
  plugin.configResolved({ plugins: [{ name: 'vite:css' }] })
  assert.deepEqual(warned, [])
})

// ---------------------------------------------------------------------------
// assets: '<dir>' — the plugin writes into a directory the USER owns
// ---------------------------------------------------------------------------

/** Capture the warn channel, which is deliberately not routed through `silent`. */
function captureWarnings(t) {
  const warned = []
  const real = console.warn
  console.warn = (m) => warned.push(String(m))
  t.after(() => {
    console.warn = real
  })
  return warned
}

const selfHosted = { ...FAMILY, strategy: 'self-host' }

/** config() with the fonts written to a real directory under the project root. */
async function withAssetsDir(t, root = sandbox(t)) {
  const plugin = fonts({ families: [selfHosted], silent: true, assets: 'public/fonts' })
  await plugin.config({ root }, { command: 'build' })
  return { root, dir: join(root, 'public/fonts') }
}

test('the fonts land in the assets directory on the FIRST build', async (t) => {
  // Not the second: Vite and Nitro copy publicDir before buildStart runs, so writing
  // any later means a clean build serves 404s for every font.
  const { dir } = await withAssetsDir(t)
  assert.equal(readdirSync(dir).filter((f) => f.endsWith('.woff2')).length, 1)
})

test('a damaged file in the assets directory is repaired, not skipped', async (t) => {
  const root = sandbox(t)
  const { dir } = await withAssetsDir(t, root)
  const [file] = readdirSync(dir)
  const good = readFileSync(join(dir, file))

  // Same name, different bytes — an interrupted write or a bad checkout. The name carries
  // Google's content hash, so this is a damaged copy of this font, not a different one.
  writeFileSync(join(dir, file), Buffer.alloc(2))
  await withAssetsDir(t, root)
  assert.deepEqual(readFileSync(join(dir, file)), good, 'the damaged file was left in place')
})

test('a font the config no longer uses is reported by name, never deleted', async (t) => {
  const root = sandbox(t)
  const { dir } = await withAssetsDir(t, root)
  // Named the way the plugin names its own output, so it is recognisably ours.
  writeFileSync(join(dir, 'manrope-stale123.woff2'), Buffer.alloc(4))
  // Something of the user's that merely lives in the same directory.
  writeFileSync(join(dir, 'brand-icons.woff2'), Buffer.alloc(4))

  const warned = captureWarnings(t)
  await withAssetsDir(t, root)

  assert.match(warned.join('\n'), /manrope-stale123\.woff2/, 'the orphan should be named')
  assert.ok(
    !warned.join('\n').includes('brand-icons'),
    'a file we did not write is not ours to flag',
  )
  assert.ok(readdirSync(dir).includes('manrope-stale123.woff2'), 'the plugin must not delete it')
  assert.ok(readdirSync(dir).includes('brand-icons.woff2'))
})
