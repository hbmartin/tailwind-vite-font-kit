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
// buildStart — emitting the fonts into the client bundle
// ---------------------------------------------------------------------------

/** A plugin whose config() has already run, so `gen` is populated. */
async function built(t, options) {
  const root = sandbox(t)
  const plugin = fonts({ families: [selfHosted], silent: true, ...options })
  await plugin.config({ root }, { command: options?.serve ? 'serve' : 'build' })
  return plugin
}

test('buildStart emits one asset per woff2, at the public path', async (t) => {
  const plugin = await built(t)
  const emitted = []
  plugin.buildStart.call({
    environment: { config: { consumer: 'client' } },
    emitFile: (a) => emitted.push(a),
  })
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, 'asset')
  // Nitro points the client outDir at .output/public, so this lands at /fonts/x.woff2.
  assert.match(emitted[0].fileName, /^fonts\/manrope-.*\.woff2$/)
  assert.ok(Buffer.isBuffer(emitted[0].source) || emitted[0].source instanceof Uint8Array)
})

test('buildStart emits nothing outside the client environment', async (t) => {
  const plugin = await built(t)
  const emitFile = () => assert.fail('the SSR and nitro passes must not emit the fonts again')
  plugin.buildStart.call({ environment: { config: { consumer: 'server' } }, emitFile })
})

test('buildStart emits nothing in serve mode', async (t) => {
  // emitFile throws "not supported in serve mode"; buildStart still runs for the dev
  // module graph, so the guard is what keeps `vite dev` from crashing on startup.
  const plugin = await built(t, { serve: true })
  const emitFile = () => assert.fail('emitFile is not available in serve mode')
  plugin.buildStart.call({ environment: { config: { consumer: 'client' } }, emitFile })
})

// ---------------------------------------------------------------------------
// configureServer — dev has no bundle, so the same bytes are served from cache
// ---------------------------------------------------------------------------

/** A dev server whose middleware is captured, plus the name of a font it really has. */
async function devServer(t, options) {
  const root = sandbox(t)
  const plugin = fonts({ families: [selfHosted], silent: true, ...options })
  await plugin.config({ root }, { command: 'serve' })

  let middleware
  plugin.configureServer({
    middlewares: { use: (fn) => (middleware = fn) },
    watcher: { add() {}, on() {} },
  })

  // The virtual module is the plugin's own record of what it emitted, so it is the honest
  // source for "a filename this server should recognise".
  const [, fontFile] = /\/fonts\/([^"]+\.woff2)/.exec(plugin.load('\0virtual:fonts'))

  /** @param {string} url */
  const request = (url) => {
    const headers = {}
    let body = null
    let nexted = false
    middleware(
      { url },
      { setHeader: (k, v) => (headers[k] = v), end: (b) => (body = b) },
      () => (nexted = true),
    )
    return { headers, body, nexted }
  }
  return { request, fontFile }
}

test('the dev middleware serves a known font with caching and CORS headers', async (t) => {
  const { request, fontFile } = await devServer(t)
  const { headers, body, nexted } = request(`/fonts/${fontFile}`)
  assert.equal(nexted, false, 'a font the generator produced must not fall through')
  assert.ok(body, 'nothing was served')
  assert.equal(headers['content-type'], 'font/woff2')
  assert.equal(headers['access-control-allow-origin'], '*')
  assert.match(headers['cache-control'], /immutable/)
})

test('the dev middleware ignores a query string on a known font', async (t) => {
  const { request, fontFile } = await devServer(t)
  assert.equal(request(`/fonts/${fontFile}?v=1`).nexted, false)
})

test('the dev middleware passes through anything it does not own', async (t) => {
  const { request } = await devServer(t)
  assert.equal(request('/fonts/not-a-real-file.woff2').nexted, true)
  assert.equal(request('/fonts/not-a-real-file.woff2').body, null)
  assert.equal(request('/assets/index.js').nexted, true, 'paths outside publicPath')
})

// ---------------------------------------------------------------------------
// transform — the @import injection
// ---------------------------------------------------------------------------

test('the transform injects an import relative to the entry, not the root', async (t) => {
  // Tailwind resolves its own at-imports from the IMPORTING FILE's directory, so a
  // root-relative specifier would simply not resolve.
  const plugin = await built(t)
  const ctx = {
    warn() {},
    error(m) {
      throw new Error(m)
    },
  }
  const out = plugin.transform.handler.call(ctx, `@import 'tailwindcss';\n`, '/proj/src/styles.css')
  assert.match(out, /@import '[^']*fonts-[0-9a-f]{16}\.gen\.css'/)
  assert.ok(/@import '\.\.?\//.test(out), `specifier is not relative: ${out}`)
})

test('the transform is idempotent and leaves non-entry stylesheets alone', async (t) => {
  const plugin = await built(t)
  const ctx = { warn() {}, error() {} }
  const once = plugin.transform.handler.call(ctx, `@import 'tailwindcss';\n`, '/p/a.css')
  assert.equal(plugin.transform.handler.call(ctx, once, '/p/a.css'), undefined)
  assert.equal(plugin.transform.handler.call(ctx, '.x { color: red }', '/p/b.css'), undefined)
})

test('the transform warns once about a Google import and an inline theme', async (t) => {
  const plugin = await built(t)
  const warnings = []
  const ctx = { warn: (m) => warnings.push(m), error() {} }
  const code = `@import 'tailwindcss';
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400');
@theme inline {
  --font-sans: 'Poppins', sans-serif;
}
`
  plugin.transform.handler.call(ctx, code, '/p/a.css')
  assert.equal(warnings.length, 1, 'one warning, listing everything found')
  assert.match(warnings[0], /render-blocking Google/)
  assert.match(warnings[0], /--font-sans inside `@theme inline`/)
  assert.match(warnings[0], /tss-fonts adopt/, 'it should say how to fix it')

  // Warned once per process, not once per stylesheet per build.
  plugin.transform.handler.call(ctx, code, '/p/b.css')
  assert.equal(warnings.length, 1)
})

test('virtual:fonts exposes the preloads and the family map', async (t) => {
  const plugin = await built(t)
  assert.equal(plugin.resolveId('virtual:fonts'), '\0virtual:fonts')
  assert.equal(plugin.resolveId('something-else'), undefined)

  const mod = plugin.load('\0virtual:fonts')
  const preloads = JSON.parse(/fontPreloads = (\[.*?\])\n/s.exec(mod)[1])
  assert.equal(preloads.length, 1)
  assert.deepEqual(Object.keys(preloads[0]).sort(), ['as', 'crossOrigin', 'href', 'rel', 'type'])
  assert.equal(preloads[0].crossOrigin, 'anonymous', 'a preload without this downloads twice')
  assert.match(mod, /fontFamilies = \{"--font-sans":"Manrope"\}/)
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
