// generate() against a mocked css2 response — no network. `strategy: 'cdn'` keeps
// Google's URL in src, so no woff2 download happens either.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { generate } from '../src/generate.mjs'

const CSS2 = `/* latin */
@font-face {
  font-family: 'Fakefam';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/fake/v1/abc123.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}
`

/** A css2 response naming an arbitrary family, so two configs can be told apart. */
const css2For = (family) => CSS2.replace('Fakefam', family)

/** Minimal single-family options; `cdn` keeps everything offline. */
const optsFor = (name) => ({
  families: [
    { name, themeVar: '--font-sans', weights: [400], preloadWeights: [], strategy: 'cdn' },
  ],
  subsets: ['latin'],
  publicPath: '/fonts',
  output: 'cache',
})

/** Swap in a mocked fetch and a temp outDir, restored when the subtest ends. */
function sandbox(t, respond) {
  const outDir = mkdtempSync(join(tmpdir(), 'tss-fonts-test-'))
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push(String(url))
    return respond(String(url), init)
  }
  t.after(() => {
    globalThis.fetch = realFetch
    rmSync(outDir, { recursive: true, force: true })
  })
  return { outDir, calls }
}

test('preloadWeights match a variable font-weight range like "100 900"', async (t) => {
  const outDir = mkdtempSync(join(tmpdir(), 'tss-fonts-test-'))
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(CSS2, { status: 200 })
  t.after(() => {
    globalThis.fetch = realFetch
    rmSync(outDir, { recursive: true, force: true })
  })

  const gen = await generate(
    {
      families: [
        {
          name: 'Fakefam',
          themeVar: '--font-sans',
          weights: [400, 700],
          preloadWeights: [400],
          strategy: 'cdn',
        },
      ],
      subsets: ['latin'],
      publicPath: '/fonts',
    },
    outDir,
  )
  assert.equal(gen.preloads.length, 1, '400 sits inside 100–900, so the face must preload')
  assert.match(gen.preloads[0].href, /abc123\.woff2/)
  assert.equal(gen.realFaces, 1)
})

// The cache is keyed on the config hash. If the CSS file is NOT keyed with it, a config
// that was generated, replaced, and then restored reports a cache hit while the CSS on
// disk still belongs to the config that overwrote it — a clean build serving the wrong
// fonts, with `cache hit` in the log. Reachable by switching a branch that changes
// fonts.config.mjs, or by undoing a config edit.
test('a cache hit never serves CSS generated for a different config', async (t) => {
  let family = 'Alpha'
  const { outDir } = sandbox(t, () => new Response(css2For(family), { status: 200 }))
  const familyIn = (gen) => /font-family:"([^"]+)"/.exec(readFileSync(gen.cssPath, 'utf8'))[1]

  family = 'Alpha'
  assert.equal(familyIn(await generate(optsFor('Alpha'), outDir)), 'Alpha')

  family = 'Beta'
  assert.equal(familyIn(await generate(optsFor('Beta'), outDir)), 'Beta')

  // Back to the first config. Whether this is a hit or a miss is an implementation
  // detail; what must hold is that cssPath describes the config that was asked for.
  family = 'Alpha'
  const back = await generate(optsFor('Alpha'), outDir)
  assert.equal(familyIn(back), 'Alpha', 'cache hit served the other config’s CSS')
})

test("output:'cache' keeps other configs' output, so a branch flip stays a cache hit", async (t) => {
  let family = 'Alpha'
  const { outDir, calls } = sandbox(t, () => new Response(css2For(family), { status: 200 }))

  family = 'Alpha'
  await generate(optsFor('Alpha'), outDir)
  family = 'Beta'
  await generate(optsFor('Beta'), outDir)

  const before = calls.length
  family = 'Alpha'
  const back = await generate(optsFor('Alpha'), outDir)
  assert.equal(back.fromCache, true, 'the first config should still be cached')
  assert.equal(calls.length, before, 'a cache hit must not touch the network')
  assert.equal(readdirSync(outDir).filter((f) => f.endsWith('.gen.css')).length, 2)
})

// Guards the SEAM, not the math: test/metrics.test.mjs proves fallbackFaces() emits
// per-weight size-adjust given metrics that carry `variants`, but nothing there checks
// that the generator hands it such metrics.
//
// This matters because `@capsizecss/metrics` exposes per-family modules
// (`@capsizecss/metrics/manrope`) that look like a drop-in replacement for the 3.76 MB
// `entireMetricsCollection` — and they have NO `variants` key at all. Switching to them
// to save the parse silently collapses every fallback onto the family-level average,
// which is the exact error this package exists to remove (Arial regular 913 vs 700 983,
// the measured 7.7%). It would break nothing, throw nothing, and pass every other test.
test('the generator feeds fallbackFaces metrics that carry per-weight variants', async (t) => {
  const { outDir } = sandbox(t, () => new Response(css2For('Manrope'), { status: 200 }))
  const gen = await generate(
    {
      families: [
        {
          name: 'Manrope',
          themeVar: '--font-sans',
          weights: [400, 700],
          preloadWeights: [],
          strategy: 'cdn',
        },
      ],
      subsets: ['latin'],
      publicPath: '/fonts',
      output: 'cache',
    },
    outDir,
  )

  const css = readFileSync(gen.cssPath, 'utf8')
  const arial = [...css.matchAll(/@font-face\{([^}]*local\("Arial"\)[^}]*)\}/g)].map((m) => m[1])
  assert.equal(arial.length, 2, 'one Arial fallback face per declared weight')
  const sizeAdjust = (decls) => /size-adjust:([^;}]+)/.exec(decls)[1]
  assert.notEqual(
    sizeAdjust(arial[0]),
    sizeAdjust(arial[1]),
    'per-weight metrics collapsed — the generator is loading variant-less metrics',
  )
})

// The utilities go into the GENERATED stylesheet rather than a file you import, because
// Tailwind resolves its own at-imports itself and drops any `@utility` it never sees, with
// no warning. Being inside fonts.gen.css is what guarantees it reaches Tailwind.
test('leadingUtilities appends the escape hatches, and is off by default', async (t) => {
  const { outDir } = sandbox(t, () => new Response(css2For('Manrope'), { status: 200 }))
  const base = optsFor('Manrope')

  const off = await generate(base, outDir)
  assert.ok(!readFileSync(off.cssPath, 'utf8').includes('@utility'))

  const on = await generate({ ...base, leadingUtilities: true }, outDir)
  const css = readFileSync(on.cssPath, 'utf8')
  assert.match(css, /@utility leading-auto/)
  assert.match(css, /@utility prose-auto/)
  // After the theme block: `@utility` is a Tailwind at-rule and the theme is what the
  // rest of the file exists for.
  assert.ok(css.indexOf('@utility') > css.indexOf('@theme'))

  // Toggling it must not be a cache hit, or the utilities never appear (or never go away).
  assert.notEqual(off.cssPath, on.cssPath, 'leadingUtilities must be part of the cache key')
})

// A file truncated by a killed build or a full disk keeps its name and its mtime, so
// existence alone is not evidence it is intact — it would be served as a valid font
// forever. The recorded digest is what turns that into a cache miss.
test('a woff2 whose bytes no longer match the recorded digest forces a regenerate', async (t) => {
  const { outDir, calls } = sandbox(t, (url) =>
    url.endsWith('.woff2')
      ? new Response(new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x01, 0x02]), { status: 200 })
      : new Response(CSS2, { status: 200 }),
  )
  const selfHosted = {
    ...optsFor('Fakefam'),
    families: [{ ...optsFor('Fakefam').families[0], strategy: 'self-host' }],
  }

  const first = await generate(selfHosted, outDir)
  assert.equal(first.files.length, 1)
  assert.ok(first.digests?.[first.files[0]]?.sha256, 'the digest must be recorded')

  const hit = await generate(selfHosted, outDir)
  assert.equal(hit.fromCache, true)

  // Truncate the cached font the way an interrupted write would.
  writeFileSync(join(outDir, 'files', first.files[0]), Buffer.alloc(2))
  const before = calls.length
  const after = await generate(selfHosted, outDir)
  assert.equal(after.fromCache, false, 'a corrupt cached font must not be reused')
  assert.ok(calls.length > before, 'it should have been re-downloaded')
})

test('a font URL pointing somewhere other than gstatic is refused', async (t) => {
  const evil = CSS2.replace('https://fonts.gstatic.com', 'https://fonts.gstatic.com.evil.test')
  const { outDir } = sandbox(t, () => new Response(evil, { status: 200 }))
  const selfHosted = {
    ...optsFor('Fakefam'),
    families: [{ ...optsFor('Fakefam').families[0], strategy: 'self-host' }],
  }
  await assert.rejects(() => generate(selfHosted, outDir), /refusing to download a font from/)
})

test('no temp files survive a successful generate', async (t) => {
  const { outDir } = sandbox(t, (url) =>
    url.endsWith('.woff2')
      ? new Response(new Uint8Array([0x77, 0x4f, 0x46, 0x32]), { status: 200 })
      : new Response(CSS2, { status: 200 }),
  )
  await generate(
    {
      ...optsFor('Fakefam'),
      families: [{ ...optsFor('Fakefam').families[0], strategy: 'self-host' }],
    },
    outDir,
  )
  const strays = [...readdirSync(outDir), ...readdirSync(join(outDir, 'files'))].filter((f) =>
    f.endsWith('.tmp'),
  )
  assert.deepEqual(strays, [])
})

test("output:'commit' prunes other configs, so the committed dir describes one config", async (t) => {
  let family = 'Alpha'
  const { outDir } = sandbox(t, () => new Response(css2For(family), { status: 200 }))
  const commit = (name) => ({ ...optsFor(name), output: 'commit' })

  family = 'Alpha'
  await generate(commit('Alpha'), outDir)
  family = 'Beta'
  const gen = await generate(commit('Beta'), outDir)

  const generated = readdirSync(outDir).filter((f) => f.endsWith('.gen.css'))
  assert.deepEqual(generated, [basename(gen.cssPath)], 'the stale stylesheet was left behind')
  assert.equal(readdirSync(outDir).filter((f) => f.startsWith('meta-')).length, 1)
})
