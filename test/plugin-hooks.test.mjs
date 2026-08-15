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
  globalThis.fetch = async (url) => {
    const u = String(url)
    // The axis-discovery endpoint `opszPin: 'auto'` asks first. No axes at all means
    // "not a variable font, nothing to pin" — the cheapest offline answer.
    if (u.includes('/metadata/fonts/')) return new Response(`)]}'\n{"axes": []}`, { status: 200 })
    return u.endsWith('.woff2')
      ? new Response(new Uint8Array([0x77, 0x4f, 0x46, 0x32]), { status: 200 })
      : new Response(CSS2, { status: 200 })
  }
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

// Vite serves files emitted as `fonts/x.woff2` below its configured `base`. The generated
// CSS and Nitro rules need that base in their URL, but Rollup's output filename must not
// contain it or `/docs/fonts/x.woff2` becomes `/docs/docs/fonts/x.woff2` in production.
test('Vite base prefixes font URLs but not emitted asset filenames', async (t) => {
  const root = sandbox(t)
  const plugin = fonts({
    families: [{ ...FAMILY, strategy: 'self-host' }],
    silent: true,
    publicPath: '/fonts/',
  })
  const returned = await plugin.config({ root, base: '/docs/' }, { command: 'build' })

  assert.ok(returned.nitro.routeRules['/docs/fonts/**'])
  assert.equal(returned.nitro.routeRules['/docs/fonts/**'].headers.link, '')
  assert.equal(returned.nitro.routeRules['/docs/fonts//**'], undefined)
  assert.match(plugin.load('\0virtual:fonts'), /href":"\/docs\/fonts\/manrope-/)

  // The other default exclusion is a request path too: hashed build output is requested
  // at /docs/assets/**, so an unprefixed '/assets/**' would match none of it and every
  // chunk would regain the preload header the exclusion exists to strip.
  assert.equal(returned.nitro.routeRules['/docs/assets/**'].headers.link, '')
  assert.equal(returned.nitro.routeRules['/assets/**'], undefined)

  const emitted = []
  plugin.buildStart.call({
    environment: { config: { consumer: 'client' } },
    emitFile: (asset) => emitted.push(asset),
  })
  assert.match(emitted[0].fileName, /^fonts\/manrope-.*\.woff2$/)
})

// Vite documents a full URL base for CDN deploys and './' for embedded ones; both built
// fine before base handling existed, so neither may hard-fail now — least of all for
// pure-CDN configs that self-host nothing.
test('a full-URL base puts the origin in font URLs and keeps route rules on paths', async (t) => {
  const root = sandbox(t)
  const plugin = fonts({ families: [{ ...FAMILY, strategy: 'self-host' }], silent: true })
  const returned = await plugin.config(
    { root, base: 'https://cdn.example.com/app/' },
    { command: 'build' },
  )
  assert.match(
    plugin.load('\0virtual:fonts'),
    /href":"https:\/\/cdn\.example\.com\/app\/fonts\/manrope-/,
  )
  // Route rules stay path-keyed: an origin-pull CDN forwards /app/fonts/* to this server,
  // and no route pattern could ever match an origin anyway.
  assert.ok(returned.nitro.routeRules['/app/fonts/**'])
  const emitted = []
  plugin.buildStart.call({
    environment: { config: { consumer: 'client' } },
    emitFile: (a) => emitted.push(a),
  })
  assert.match(emitted[0].fileName, /^fonts\/manrope-.*\.woff2$/, 'the base stays out of Rollup')
})

test('a full-URL base with a CDN-only config builds', async (t) => {
  const root = sandbox(t)
  const plugin = fonts({ families: [FAMILY], silent: true })
  const returned = await plugin.config(
    { root, base: 'https://cdn.example.com/assets/' },
    { command: 'build' },
  )
  assert.ok(returned.nitro.routeRules['/**'].headers.link, 'generation ran to completion')
})

test("a relative base ('./') builds; self-hosting warns, CDN-only stays quiet", async (t) => {
  const warned = captureWarnings(t)
  const root = sandbox(t)
  const cdn = fonts({ families: [FAMILY], silent: true })
  await cdn.config({ root, base: './' }, { command: 'build' })
  assert.deepEqual(warned, [], 'nothing is self-hosted, so nothing is wrong')

  const selfHost = fonts({ families: [{ ...FAMILY, strategy: 'self-host' }], silent: true })
  await selfHost.config({ root, base: './' }, { command: 'build' })
  assert.match(warned.join('\n'), /`base` is relative/)
})

// publicPath '/' served fonts from the bundle root long before base handling existed.
// No pattern can scope the root, so there is no immutable rule and no fonts exclusion —
// which is what pre-base versions actually did too (their pattern was '//**').
test("publicPath '/' builds and serves fonts from the bundle root", async (t) => {
  const root = sandbox(t)
  const plugin = fonts({
    families: [{ ...FAMILY, strategy: 'self-host' }],
    silent: true,
    publicPath: '/',
  })
  const returned = await plugin.config({ root }, { command: 'build' })
  assert.equal(returned.nitro.routeRules['//**'], undefined)
  assert.match(plugin.load('\0virtual:fonts'), /href":"\/manrope-/)
  assert.ok(returned.nitro.routeRules['/**'].headers.link)
  assert.equal(returned.nitro.routeRules['/assets/**'].headers.link, '')
  const emitted = []
  plugin.buildStart.call({
    environment: { config: { consumer: 'client' } },
    emitFile: (a) => emitted.push(a),
  })
  assert.match(emitted[0].fileName, /^manrope-.*\.woff2$/, 'no directory prefix at the root')
})

test('bundle-root fonts never apply font rules to a non-root base namespace', async (t) => {
  for (const publicPath of ['/', '/docs/']) {
    const root = sandbox(t)
    const plugin = fonts({
      families: [{ ...FAMILY, strategy: 'self-host' }],
      silent: true,
      publicPath,
    })
    const returned = await plugin.config({ root, base: '/docs/' }, { command: 'build' })
    const rules = returned.nitro.routeRules
    assert.equal(rules['/docs/**'], undefined, `${publicPath} must not make HTML immutable`)
    assert.equal(rules['/docs//**'], undefined, `${publicPath} must not emit a dead rule either`)
    assert.match(plugin.load('\0virtual:fonts'), /href":"\/docs\/manrope-/)
    assert.ok(rules['/**'].headers.link, 'documents keep their preload header')
    assert.equal(rules['/docs/assets/**'].headers.link, '')
  }
})

test("a full-URL base plus publicPath '/' also skips the shared app namespace", async (t) => {
  const root = sandbox(t)
  const plugin = fonts({
    families: [{ ...FAMILY, strategy: 'self-host' }],
    silent: true,
    publicPath: '/',
  })
  const returned = await plugin.config(
    { root, base: 'https://cdn.example.com/app/' },
    { command: 'build' },
  )
  assert.equal(returned.nitro.routeRules['/app/**'], undefined)
  assert.equal(returned.nitro.routeRules['/app//**'], undefined)
  assert.match(plugin.load('\0virtual:fonts'), /href":"https:\/\/cdn\.example\.com\/app\/manrope-/)
})

test("Vite's serve-time resolution of '' and './' does not look like a later base change", async (t) => {
  for (const base of ['', './']) {
    const root = sandbox(t)
    const plugin = fonts({
      families: [{ ...FAMILY, strategy: 'self-host' }],
      silent: true,
    })
    await plugin.config({ root, base }, { command: 'serve' })
    assert.doesNotThrow(() =>
      plugin.configResolved({ base: '/', plugins: [{ name: 'vite:nitro' }] }),
    )
    assert.match(plugin.load('\0virtual:fonts'), /href":"\/fonts\/manrope-/)
  }
})

test("Vite-normalized slashless and full-URL dev bases generate against Vite's paths", async (t) => {
  for (const [base, resolvedBase] of [
    ['docs/', '/docs/'],
    ['https://cdn.example.com/app/', '/app/'],
  ]) {
    const root = sandbox(t)
    const plugin = fonts({
      families: [{ ...FAMILY, strategy: 'self-host' }],
      silent: true,
    })
    const returned = await plugin.config({ root, base }, { command: 'serve' })
    assert.ok(returned.nitro.routeRules[`${resolvedBase}fonts/**`])
    assert.match(plugin.load('\0virtual:fonts'), new RegExp(`href":"${resolvedBase}fonts/manrope-`))
    assert.doesNotThrow(() =>
      plugin.configResolved({ base: resolvedBase, plugins: [{ name: 'vite:nitro' }] }),
    )
  }
})

// This plugin's config() runs before every other plugin's (enforce:'pre'), so a base a
// framework plugin injects from its own config hook is invisible until configResolved —
// by which point the CSS hrefs and route rules are baked. Self-hosted URLs are then
// wrong: hard failure. CDN hrefs point at Google: a warning about the patterns.
test('a base injected by a later plugin fails a self-hosting build loudly', async (t) => {
  const root = sandbox(t)
  const plugin = fonts({ families: [{ ...FAMILY, strategy: 'self-host' }], silent: true })
  await plugin.config({ root }, { command: 'build' })
  assert.throws(
    () => plugin.configResolved({ base: '/docs/', plugins: [{ name: 'vite:nitro' }] }),
    /resolved to "\/docs\/"/,
  )
})

test('a base injected by a later plugin only warns when nothing is self-hosted', async (t) => {
  const warned = captureWarnings(t)
  const { plugin } = await routeRules(t)
  plugin.configResolved({ base: '/docs/', plugins: [{ name: 'vite:nitro' }] })
  assert.match(warned.join('\n'), /Set `base` directly/)
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

test('a non-array preloadHeader.exclude is rejected, not iterated as characters', async (t) => {
  const root = sandbox(t)
  const plugin = fonts({
    families: [FAMILY],
    silent: true,
    preloadHeader: { exclude: '/static/**' },
  })
  await assert.rejects(
    () => plugin.config({ root }, { command: 'build' }),
    /`preloadHeader\.exclude` must be an array/,
  )
})

// index.d.ts and the README both promise `opszPin: 'auto'`; validation once rejected it
// as "not a positive number". Pin the promise, on both ways families reach the plugin.
test("opszPin: 'auto' passes validation from inline options", async (t) => {
  const { rules } = await routeRules(t, { families: [{ ...FAMILY, opszPin: 'auto' }] })
  assert.ok(rules['/fonts/**'], 'generation ran to completion')
})

test("opszPin: 'auto' passes validation from a loaded fonts.config.mjs", async (t) => {
  const root = sandbox(t)
  writeFileSync(
    join(root, 'fonts.config.mjs'),
    `export default { families: [${JSON.stringify({ ...FAMILY, opszPin: 'auto' })}] }\n`,
  )
  const plugin = fonts({ silent: true })
  const returned = await plugin.config({ root }, { command: 'build' })
  assert.ok(returned.nitro.routeRules['/fonts/**'], 'generation ran to completion')
})

// The plugin once merged whatever the file exported: spreading an array into the options
// produces index keys and no `families`, which ended at the misleading "no families
// configured". The shape error has to name the actual mistake instead.
test('a config that default-exports the families array is named as the mistake', async (t) => {
  const root = sandbox(t)
  writeFileSync(join(root, 'fonts.config.mjs'), `export default [${JSON.stringify(FAMILY)}]\n`)
  const plugin = fonts({ silent: true })
  await assert.rejects(
    () => plugin.config({ root }, { command: 'build' }),
    /fonts\.config\.mjs: the default export must be an object shaped like \{ families: \[\.\.\.\] \}, got an array/,
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
