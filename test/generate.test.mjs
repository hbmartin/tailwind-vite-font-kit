// generate() against a mocked css2 response — no network. `strategy: 'cdn'` keeps
// Google's URL in src, so no woff2 download happens either.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { assertFontHost, generate } from '../src/generate.mjs'

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

const MULTI_SUBSET_CSS2 =
  CSS2 +
  CSS2.replace('/* latin */', '/* thai */')
    .replace('abc123.woff2', 'thai456.woff2')
    .replace('U+0000-00FF', 'U+0E00-0E7F')

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
  const requests = []
  globalThis.fetch = async (url, init) => {
    calls.push(String(url))
    requests.push({ url: String(url), init })
    return respond(String(url), init)
  }
  t.after(() => {
    globalThis.fetch = realFetch
    rmSync(outDir, { recursive: true, force: true })
  })
  return { outDir, calls, requests }
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

test('font URLs must use HTTPS on the approved gstatic origin', () => {
  assert.throws(
    () => assertFontHost('http://fonts.gstatic.com/s/fake/v1/abc123.woff2', 'Fakefam'),
    /expected https:\/\/fonts\.gstatic\.com/,
  )
  assert.throws(
    () => assertFontHost('https://fonts.gstatic.com:444/s/fake/v1/abc123.woff2', 'Fakefam'),
    /expected https:\/\/fonts\.gstatic\.com/,
  )
  assert.throws(
    () => assertFontHost('data:font/woff2,not-a-google-font', 'Fakefam'),
    (err) => {
      assert.match(err.message, /from data:font\/woff2,not-a-google-font/)
      assert.ok(!err.message.includes('from null'))
      return true
    },
  )
})

test('self-hosted font downloads disable redirect following', async (t) => {
  const { outDir, requests } = sandbox(t, (url) =>
    url.endsWith('.woff2')
      ? new Response(new Uint8Array([0x77, 0x4f, 0x46, 0x32]), { status: 200 })
      : new Response(CSS2, { status: 200 }),
  )
  await generate(
    {
      ...optsFor('Manrope'),
      families: [{ ...optsFor('Manrope').families[0], strategy: 'self-host' }],
    },
    outDir,
  )
  const fontRequest = requests.find((r) => r.url.endsWith('.woff2'))
  assert.equal(fontRequest?.init?.redirect, 'error')
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

test('a missing woff2 forces a regenerate even when the meta is intact', async (t) => {
  const { outDir } = sandbox(t, (url) =>
    url.endsWith('.woff2')
      ? new Response(new Uint8Array([0x77, 0x4f, 0x46, 0x32]), { status: 200 })
      : new Response(CSS2, { status: 200 }),
  )
  const opts = {
    ...optsFor('Manrope'),
    families: [{ ...optsFor('Manrope').families[0], strategy: 'self-host' }],
  }
  const first = await generate(opts, outDir)
  rmSync(join(outDir, 'files', first.files[0]))
  assert.equal((await generate(opts, outDir)).fromCache, false)
})

test('a truncated meta file is a cache miss, not a crash', async (t) => {
  const { outDir } = sandbox(t, () => new Response(css2For('Manrope'), { status: 200 }))
  const opts = optsFor('Manrope')
  await generate(opts, outDir)
  const meta = readdirSync(outDir).find((f) => f.startsWith('meta-'))
  writeFileSync(join(outDir, meta), '{"files": [')
  assert.equal((await generate(opts, outDir)).fromCache, false)
})

// The retry ladder is the difference between a flaky network and a failed build: a bare
// ETIMEDOUT to fonts.googleapis.com killed a build during testing with no recovery.
// Exactly one retry, not two: the backoff is real (500ms, then 1s), and a second retry
// would triple this test's cost to prove nothing the first one does not.
test('a transient status is retried rather than failing the build', async (t) => {
  let attempts = 0
  const { outDir } = sandbox(t, () => {
    attempts++
    return attempts < 2 ? new Response('', { status: 503 }) : new Response(CSS2, { status: 200 })
  })
  await generate(optsFor('Manrope'), outDir)
  assert.equal(attempts, 2, '503 should have been retried until it succeeded')
})

test('a 404 is not retried, and the error names the offline escape hatch', async (t) => {
  let attempts = 0
  const { outDir } = sandbox(t, () => {
    attempts++
    return new Response('', { status: 404 })
  })
  await assert.rejects(() => generate(optsFor('Manrope'), outDir), /could not fetch/)
  assert.equal(attempts, 1, 'a 404 will never get better; retrying it just wastes the build')
  await assert.rejects(() => generate(optsFor('Manrope'), outDir), /output: 'commit'/)
})

// If Google reshapes css2, the failure should name the family and the URL rather than
// surfacing as a TypeError on a null match somewhere in the parser.
test('an unparseable @font-face block fails with the family and the URL', async (t) => {
  const noWeight = CSS2.replace(/\s*font-weight:[^;]+;/, '')
  const { outDir } = sandbox(t, () => new Response(noWeight, { status: 200 }))
  await assert.rejects(
    () => generate(optsFor('Manrope'), outDir),
    /could not parse font-weight in a Manrope @font-face block from https:/,
  )
})

test('a subset with no blocks says which subsets were available', async (t) => {
  const { outDir } = sandbox(t, () => new Response(css2For('Manrope'), { status: 200 }))
  await assert.rejects(
    () => generate({ ...optsFor('Manrope'), subsets: ['cyrillic'] }, outDir),
    /no cyrillic blocks for Manrope\. Available: latin/,
  )
})

// A fallback's average width is script-dependent (Arial's Thai average is much wider
// than its Latin one). The fallback faces must therefore mirror Google's unicode-range
// split instead of calculating one face from subsets[0] and applying it everywhere.
test('each selected subset gets a unicode-scoped fallback with its own metrics', async (t) => {
  const { outDir } = sandbox(t, () => new Response(MULTI_SUBSET_CSS2, { status: 200 }))
  const gen = await generate({ ...optsFor('Poppins'), subsets: ['latin', 'thai'] }, outDir)
  const css = readFileSync(gen.cssPath, 'utf8')
  const arial = [
    ...css.matchAll(/@font-face\{([^}]*font-family:"Poppins Fallback: Arial"[^}]*)\}/g),
  ].map((m) => m[1])

  assert.equal(arial.length, 2, 'one Arial fallback face per selected subset')
  assert.ok(arial.some((face) => face.includes('unicode-range:U+0000-00FF')))
  assert.ok(arial.some((face) => face.includes('unicode-range:U+0E00-0E7F')))
  const sizeAdjust = (face) => /size-adjust:([^;}]+)/.exec(face)[1]
  assert.notEqual(
    sizeAdjust(arial[0]),
    sizeAdjust(arial[1]),
    'Latin metrics must not be reused for Thai fallback glyphs',
  )
})

// capsize's data only differentiates a few scripts (latin and thai, at time of writing);
// latin and latin-ext resolve to the same family-level averages, so emitting a face per
// subset doubles the render-blocking CSS with byte-identical rules. Identical subsets
// collapse into one set of faces — and covering every served subset, they need no range.
test('subsets with identical metrics share one set of fallback faces', async (t) => {
  const latinExt = MULTI_SUBSET_CSS2.replace('/* thai */', '/* latin-ext */').replace(
    'U+0E00-0E7F',
    'U+0100-024F',
  )
  const { outDir } = sandbox(t, () => new Response(latinExt, { status: 200 }))
  const gen = await generate({ ...optsFor('Poppins'), subsets: ['latin', 'latin-ext'] }, outDir)
  const css = readFileSync(gen.cssPath, 'utf8')
  const arial = [
    ...css.matchAll(/@font-face\{([^}]*font-family:"Poppins Fallback: Arial"[^}]*)\}/g),
  ].map((m) => m[1])
  assert.equal(arial.length, 1, 'identical per-subset faces must not be duplicated')
  assert.ok(!arial[0].includes('unicode-range'), 'a face covering every subset needs no range')
})

// The hard-error is keyed on the subsets a family actually SERVES, not on how many the
// config selects: a family covering only latin out of ['latin', 'greek'] gets a single
// rangeless fallback face — failing the whole build there helped nobody.
test('a single-subset family tolerates a missing unicode-range under a multi-subset config', async (t) => {
  const rangeless = CSS2.replace(/\s*unicode-range:[^;]+;/, '')
  const { outDir } = sandbox(t, () => new Response(rangeless, { status: 200 }))
  const gen = await generate({ ...optsFor('Manrope'), subsets: ['latin', 'greek'] }, outDir)
  const css = readFileSync(gen.cssPath, 'utf8')
  assert.match(css, /Manrope Fallback: Arial/, 'the fallback faces must still be emitted')
})

test('a family really serving several subsets still demands parseable ranges', async (t) => {
  const broken = MULTI_SUBSET_CSS2.replace(/\s*unicode-range: U\+0E00-0E7F;/, '')
  const { outDir } = sandbox(t, () => new Response(broken, { status: 200 }))
  await assert.rejects(
    () => generate({ ...optsFor('Poppins'), subsets: ['latin', 'thai'] }, outDir),
    /could not parse unicode-range for Poppins's thai subset/,
  )
})

// Missing capsize metrics are one family-level problem. The warning used to print once
// per selected subset — and the mechanism meant to stop that silenced genuinely distinct
// per-subset warnings instead.
test('the missing-metrics warning prints once, not once per subset', async (t) => {
  const { outDir } = sandbox(t, () => new Response(MULTI_SUBSET_CSS2, { status: 200 }))
  const warned = []
  await generate(
    { ...optsFor('Fakefam'), subsets: ['latin', 'thai'] },
    outDir,
    () => {},
    (m) => warned.push(m),
  )
  assert.equal(
    warned.filter((m) => m.includes('no capsize metrics')).length,
    1,
    'one family-level problem, one warning',
  )
})

// A refused redirect is the origin guard tripping, deterministically — retrying it
// re-refuses the same redirect, and the generic "fetch failed" + CI-cache advice made
// the guard's trip indistinguishable from a network outage.
test('a refused redirect is not retried and the error names the redirect', async (t) => {
  let woff2Attempts = 0
  const { outDir } = sandbox(t, (url, init) => {
    if (url.endsWith('.woff2')) {
      woff2Attempts++
      assert.equal(init?.redirect, 'error')
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') })
    }
    return new Response(CSS2, { status: 200 })
  })
  const selfHosted = {
    ...optsFor('Fakefam'),
    families: [{ ...optsFor('Fakefam').families[0], strategy: 'self-host' }],
  }
  await assert.rejects(
    () => generate(selfHosted, outDir),
    /answered with a redirect, which was refused — validated font downloads do not follow redirects/,
  )
  assert.equal(woff2Attempts, 1, 'a deterministic refusal must not be retried')
})

test('a family with neither weights nor axes is rejected before any request', async (t) => {
  const { outDir, calls } = sandbox(t, () => new Response(CSS2, { status: 200 }))
  await assert.rejects(
    () =>
      generate(
        {
          ...optsFor('Manrope'),
          families: [{ name: 'Manrope', themeVar: '--font-sans', preloadWeights: [] }],
        },
        outDir,
      ),
    /declares no weights/,
  )
  assert.equal(calls.length, 0, 'it should fail before touching the network')
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
