// Build-time generation: fetch the css2 stylesheet, download the woff2, compute the
// metric-matched fallbacks, and write one real on-disk CSS file.
//
// It has to be a REAL file: Tailwind resolves its own @imports with enhanced-resolve +
// fs.readFile, bypassing Vite's plugin container entirely, so a virtual module cannot
// be @imported from a Tailwind entry (hard build failure, not a silent one).

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, posix } from 'node:path'
import { createRequire } from 'node:module'
import { fallbackFaces } from './metrics.mjs'
import { leadingUtilities } from './leading.mjs'
import { googleUrl } from './opsz.mjs'
import { weightsFromSpec } from './detect.mjs'

const require_ = createRequire(import.meta.url)
const PKG_VERSION = require_('../package.json').version

// Google returns legacy TTF with every subset in one file unless it believes you are a
// modern desktop browser. With this UA it returns per-subset woff2 with unicode-range.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const slug = (s) => s.toLowerCase().replace(/\s+/g, '-')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** @param {Buffer} buf */
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/**
 * Write via a temp file in the same directory, then rename.
 *
 * `node_modules/.cache` is shared: a monorepo building two apps at once, or a dev server
 * running beside a build, has two generators in the same directory. A plain writeFileSync
 * lets a reader observe a half-written stylesheet or a truncated woff2, and the digest
 * check would then reject a cache that was never actually bad. rename(2) is atomic within
 * a filesystem, so a reader sees either the old file or the whole new one.
 *
 * The temp name carries the pid so two processes cannot collide on it, and a per-call
 * counter so two concurrent generate() runs in ONE process (a monorepo building two apps,
 * a dev server beside a build) cannot share or unlink each other's temp file either.
 * @param {string} path
 * @param {string | Buffer} data
 */
let tmpSeq = 0
function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.${tmpSeq++}.tmp`
  try {
    writeFileSync(tmp, data)
    renameSync(tmp, path)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // Best effort: the write already failed, and the temp file may never have existed.
    }
    throw err
  }
}

// The font URLs are read out of a network response, so nothing about them is trusted by
// construction. Google serves the binaries from exactly one host; anything else means the
// css2 response was not what we think it was, and the build should stop rather than
// download and ship it.
const FONT_HOSTS = new Set(['fonts.gstatic.com'])

/**
 * @param {string} src the `src: url(...)` taken from a css2 response
 * @param {string} family for the error message
 */
export function assertFontHost(src, family) {
  let host
  try {
    host = new URL(src).host
  } catch {
    throw new Error(`[tss-fonts] ${family}: css2 returned an unparseable font URL: ${src}`)
  }
  if (!FONT_HOSTS.has(host)) {
    throw new Error(
      `[tss-fonts] ${family}: refusing to download a font from ${host} — ` +
        `expected ${[...FONT_HOSTS].join(' or ')}. The css2 response was not what it should be.`,
    )
  }
}

/**
 * fetch with retry+backoff. A bare ETIMEDOUT to fonts.googleapis.com killed a build
 * during testing with no recovery; a cold first contact was measured at 61s.
 * @param {string} url
 * @param {{tries?: number, baseDelay?: number, timeout?: number,
 *          log?: (message: string) => void}} [o]
 */
async function fetchRetry(
  url,
  { tries = 3, baseDelay = 500, timeout = 60_000, log = () => {} } = {},
) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      // Generous per-attempt timeout: a cold first contact was measured at 61s total,
      // but a single hung socket must not stall the build forever.
      const res = await fetch(url, {
        headers: { 'user-agent': UA },
        signal: AbortSignal.timeout(timeout),
      })
      if (!res.ok) {
        const err = /** @type {Error & {permanent?: boolean}} */ (new Error(`HTTP ${res.status}`))
        // Only transient statuses are worth retrying; a 400/404 will never get better.
        err.permanent = !(
          res.status === 408 ||
          res.status === 425 ||
          res.status === 429 ||
          res.status >= 500
        )
        throw err
      }
      return res
    } catch (err) {
      lastErr = err
      if (err.permanent || i === tries - 1) break
      const wait = baseDelay * 2 ** i
      log(`  fetch failed (${err.message}); retrying in ${wait}ms`)
      await sleep(wait)
    }
  }
  throw new Error(
    `[tss-fonts] could not fetch ${url}: ${lastErr?.message}. ` +
      `If this is CI, set \`output: 'commit'\` so the generated files live in the repo ` +
      `and builds never touch the network.`,
  )
}

/** The generated stylesheet's name for a given cache key. Exported so the plugin can
 *  recognise an entry that already carries the import. */
export const cssName = (key) => `fonts-${key}.gen.css`

/** Matches any generated stylesheet name, keyed or not. Used to spot an already-injected
 *  entry even when the key has since changed, and to prune stale pairs. */
export const CSS_NAME_RE = /fonts(?:-[0-9a-f]{16})?\.gen\.css/

/**
 * Cached files whose bytes no longer match what was downloaded.
 *
 * A meta written before digests were recorded has none, in which case there is nothing to
 * check and the cache is taken at face value — an upgrade must not force a re-download.
 * @param {{files: string[], digests?: Record<string, {sha256: string, bytes: number}>}} meta
 * @param {string} filesDir
 */
function corruptFiles(meta, filesDir) {
  if (!meta.digests) return []
  return meta.files.filter((f) => {
    const want = meta.digests?.[f]
    if (!want) return false
    try {
      const buf = readFileSync(join(filesDir, f))
      return buf.length !== want.bytes || sha256(buf) !== want.sha256
    } catch {
      return true
    }
  })
}

/** Everything that changes the output, hashed — the cache key. The package version is
 *  part of it so upgrading the generator invalidates stale caches automatically. */
function cacheKey(opts) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        v: PKG_VERSION,
        families: opts.families,
        subsets: opts.subsets,
        publicPath: opts.publicPath,
        // Changes the emitted CSS, so it has to move the key — otherwise toggling it
        // is a cache hit and the utilities never appear (or never go away).
        leadingUtilities: opts.leadingUtilities,
      }),
    )
    .digest('hex')
    .slice(0, 16)
}

/**
 * Options once the plugin has applied its defaults and resolved `families` (from the
 * call site or from `fonts.config.mjs`). Everything below can assume all of it is set.
 * @typedef {Required<Pick<import('../index.d.ts').FontsOptions,
 *     'subsets' | 'publicPath' | 'assets' | 'output' | 'preloadHeader' | 'silent'>>
 *   & Pick<import('../index.d.ts').FontsOptions, 'leadingUtilities'>
 *   & { families: import('../index.d.ts').FontFamily[] }} ResolvedOptions
 */

/**
 * @typedef {object} Generated
 * @property {string} cssPath
 * @property {string} filesDir
 * @property {string[]} files
 * @property {Record<string, {sha256: string, bytes: number}>} [digests] keyed by filename;
 *   absent on a meta written by an older version, and on `strategy: 'cdn'` families,
 *   which download nothing
 * @property {import('../index.d.ts').FontPreload[]} preloads
 * @property {number} realFaces
 * @property {number} fallbackFaces
 * @property {boolean} fromCache
 */

/**
 * @param {ResolvedOptions} opts
 * @param {string} outDir
 * @param {(message: string) => void} [log]
 * @param {(message: string) => void} [warn] surfaced even under `silent` — see src/index.mjs
 * @returns {Promise<Generated>}
 */
export async function generate(opts, outDir, log = () => {}, warn = () => {}) {
  const key = cacheKey(opts)
  const metaPath = join(outDir, `meta-${key}.json`)
  const filesDir = join(outDir, 'files')
  // Keyed, like the meta beside it. With a fixed name, a config that was generated,
  // replaced and then restored found its own meta AND a CSS file belonging to whatever
  // config overwrote it — reported as a cache hit, and the app shipped the wrong fonts.
  const cssPath = join(outDir, cssName(key))

  if (existsSync(metaPath) && existsSync(cssPath)) {
    // A truncated or hand-mangled meta file is a cache MISS, not a crash.
    /** @type {Omit<Generated, 'cssPath' | 'filesDir' | 'fromCache'> | null} */
    let meta = null
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    } catch {}
    if (Array.isArray(meta?.files) && meta.files.every((f) => existsSync(join(filesDir, f)))) {
      // Existing is not the same as intact. A file truncated by a killed build or a full
      // disk keeps its name and its mtime, and would be served as a valid font forever.
      const bad = corruptFiles(meta, filesDir)
      if (bad.length) {
        log(
          `cache rejected — ${bad.join(', ')} ${bad.length > 1 ? 'do' : 'does'} not match the recorded digest`,
        )
      } else {
        log(`cache hit (${meta.files.length} woff2, ${meta.realFaces} faces) — no network`)
        return { ...meta, cssPath, filesDir, fromCache: true }
      }
    }
  }

  // DO NOT "optimise" this into per-family imports.
  //
  // `@capsizecss/metrics` exposes `@capsizecss/metrics/manrope` etc. through a wildcard
  // export, and at 3.76 MB this collection is an obvious thing to want to avoid loading.
  // Those per-family modules do NOT carry a `variants` key — measured, not assumed:
  // `entireMetricsCollection.manrope.variants` has 7 entries, `@capsizecss/metrics/manrope`
  // has none. Without variants every fallback face falls back to the family-level average,
  // which silently reintroduces the single largest error this package removes (Arial
  // regular 913 vs 700 983 — the 7.7% in metrics.mjs). Nothing throws; the CSS just gets
  // quietly worse. test/generate.test.mjs pins this.
  //
  // The cost is bounded anyway: this line sits AFTER the cache-hit return above, so it is
  // paid on a cold generate and never on a warm build.
  const { entireMetricsCollection: METRICS } =
    await import('@capsizecss/metrics/entireMetricsCollection').catch(() =>
      require_('@capsizecss/metrics/entireMetricsCollection'),
    )

  mkdirSync(filesDir, { recursive: true })

  const realFaces = []
  const fallbackCss = []
  const themeLines = []
  /** @type {import('../index.d.ts').FontPreload[]} */
  const preloads = []
  const files = []
  const seenSrc = new Map()
  /** @type {Record<string, {sha256: string, bytes: number}>} */
  const digests = {}

  for (const fam of opts.families) {
    // Weights may live only in an axes spec ('opsz,wght@9..144,500;9..144,700'); the
    // fallback faces still need concrete values, so derive them rather than crash.
    const famWeights = fam.weights?.length
      ? fam.weights
      : fam.axes
        ? weightsFromSpec(fam.axes).weights
        : []
    if (!famWeights.length) {
      throw new Error(
        `[tss-fonts] family "${fam.name}" declares no weights, and its axes spec has no wght values to derive them from.`,
      )
    }
    // `opszPin: 'auto'` measures the font instead of guessing a pin. It costs an extra
    // css2 fetch plus one variable-font download, and needs the optional peers, so it is
    // opt-in and happens only on a cold generate — the resolved pin is part of the cache
    // key, so a warm build never repeats it.
    let resolved = fam
    if (fam.opszPin === 'auto') {
      const {
        recommendOpszPin,
        applyRecommendation,
        DEFAULT_SIZES: DEFAULT_OPSZ_SIZES,
      } = await import('./opsz-auto.mjs')
      const rec = await recommendOpszPin(fam, { sizes: fam.opszSizes, log })
      if (rec.hasOpsz && rec.axis) {
        log(
          `  ${fam.name}: opsz ${rec.axis.min}..${rec.axis.max}, width swing ${rec.swingPct}% ` +
            `over ${(fam.opszSizes ?? DEFAULT_OPSZ_SIZES).join(', ')}px -> pinning at ${rec.pin}`,
        )
      } else {
        log(`  ${fam.name}: ${rec.reason}`)
      }
      resolved = applyRecommendation(fam, rec)
    }

    const url = googleUrl(resolved, log)
    log(`${fam.name}: ${url}`)
    const css = await (await fetchRetry(url, { log })).text()

    const blocks = [...css.matchAll(/\/\*\s*([a-z0-9-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g)]
    const wanted = blocks.filter(([, subset]) => opts.subsets.includes(subset))
    if (!wanted.length) {
      throw new Error(
        `[tss-fonts] no ${opts.subsets.join('/')} blocks for ${fam.name}. ` +
          `Available: ${[...new Set(blocks.map((b) => b[1]))].join(', ') || 'none'}`,
      )
    }

    // 'self-host' rewrites src to your origin; 'cdn' keeps Google's gstatic URL. Either
    // way the @font-face rules, the unicode-range splits and the metric fallbacks are
    // identical — only the src changes. No other tool offers this toggle: fontless hard-
    // rewrites every remote src, and unplugin-fonts' google provider never downloads.
    const selfHost = (fam.strategy ?? 'self-host') === 'self-host'

    for (const [, , block] of wanted) {
      // If Google reshapes the css2 output, fail with a message naming the family and
      // URL instead of a bare TypeError on a null match.
      const grab = (re, what) => {
        const m = re.exec(block)
        if (!m) {
          throw new Error(
            `[tss-fonts] could not parse ${what} in a ${fam.name} @font-face block from ${url}`,
          )
        }
        return m[1]
      }
      const weight = grab(/font-weight:\s*([^;]+)/, 'font-weight').trim()
      const style = grab(/font-style:\s*([^;]+)/, 'font-style').trim()
      const src = grab(/src:\s*url\(([^)]+)\)/, 'src')
      // Validated for BOTH strategies: 'cdn' writes this URL straight into the emitted
      // CSS, so an off-host src is just as much a poisoned css2 response there as it is
      // on the self-host download path.
      assertFontHost(src, fam.name)
      const range = /unicode-range:\s*([^;}]+)/.exec(block)?.[1].trim()

      let href = src
      if (selfHost) {
        let file = seenSrc.get(src)
        if (!file) {
          // Google's own filenames already carry a content hash, so a fixed name is
          // safe to serve `immutable`.
          file = `${slug(fam.name)}-${src.split('/').pop()}`
          const buf = Buffer.from(await (await fetchRetry(src, { log })).arrayBuffer())
          writeAtomic(join(filesDir, file), buf)
          seenSrc.set(src, file)
          files.push(file)
          // Recorded so a cache hit can prove the bytes on disk are still the bytes that
          // were downloaded, and so the `assets` directory copy can spot a stale or
          // truncated file rather than trusting the filename.
          digests[file] = { sha256: sha256(buf), bytes: buf.length }
          log(`  downloaded ${file} (${(buf.length / 1024).toFixed(1)} kB)`)
        }
        href = posix.join(opts.publicPath, file)
      }

      realFaces.push(
        `@font-face{font-family:"${fam.name}";font-style:${style};font-weight:${weight};` +
          `font-display:swap;src:url(${href}) format("woff2")` +
          (range ? `;unicode-range:${range}` : '') +
          `}`,
      )

      // A variable face declares 'font-weight: 100 900' — treat that as an inclusive
      // range, so preloadWeights: [400] still matches it.
      const [wLo, wHi = wLo] = String(weight).trim().split(/\s+/).map(Number)
      if (
        fam.preloadWeights?.some((pw) => pw >= wLo && pw <= wHi) &&
        !preloads.some((p) => p.href === href)
      ) {
        // crossOrigin is REQUIRED even same-origin. Fonts are always CORS-fetched, and a
        // preload without it is a *different* cache entry, so the font downloads TWICE:
        // measured 4 requests / 185 kB instead of 2 / 93 kB, and fonts applied 104ms
        // LATER than shipping no preload at all. No error, no console warning.
        preloads.push({
          rel: 'preload',
          as: 'font',
          type: 'font/woff2',
          href,
          crossOrigin: 'anonymous',
        })
      }
    }

    const { css: fbCss, names } = fallbackFaces(
      METRICS,
      fam.name,
      opts.subsets[0],
      famWeights,
      log,
      warn,
    )
    if (fbCss) fallbackCss.push(fbCss)

    // Plain `@theme`, NEVER `@theme inline`. Under `inline` Tailwind bakes the literal
    // value into `.font-*` utilities and into `--default-font-family`, so nothing
    // downstream can override it. Non-inline keeps the var() indirection, which is why
    // the root font-family inherits the fallbacks too.
    const stack = [`'${fam.name}'`, ...names.map((n) => `'${n}'`), ...(fam.stack ?? [])]
    themeLines.push(`  ${fam.themeVar}: ${stack.join(', ')};`)
    log(`  ${fam.themeVar} -> ${names.length} fallback families x ${famWeights.length} weights`)
  }

  const out =
    `/* GENERATED by tailwind-vite-font-kit — do not edit. */\n\n` +
    `${realFaces.join('\n')}\n\n${fallbackCss.join('\n')}\n\n@theme {\n${themeLines.join('\n')}\n}\n` +
    // Appended AFTER the theme block: `@utility` has to reach Tailwind, and this file is
    // the one place already guaranteed to be inside its import graph.
    (opts.leadingUtilities ? leadingUtilities() : '')
  writeAtomic(cssPath, out)

  const meta = {
    files,
    digests,
    preloads,
    realFaces: realFaces.length,
    fallbackFaces: fallbackCss.join('\n').split('@font-face').length - 1,
  }
  // The meta is written LAST and names the CSS: a reader that sees the meta is
  // guaranteed the stylesheet and every woff2 it refers to are already complete.
  writeAtomic(metaPath, JSON.stringify(meta, null, 2))
  pruneStale(outDir, key, opts.output, log)
  log(
    `wrote ${cssName(key)} — ${meta.realFaces} real faces, ${meta.fallbackFaces} fallback faces, ${preloads.length} preloads`,
  )
  return { ...meta, cssPath, filesDir, fromCache: false }
}

/**
 * Drop meta/CSS pairs belonging to other configs.
 *
 * Only under `output: 'commit'`, where the directory is checked into the repo and should
 * describe exactly the config that is in the repo beside it. Under `output: 'cache'` they
 * are a few KB each and keeping them is what makes flipping between two branches a cache
 * hit rather than a fresh download. `files/` is left alone either way — the names carry
 * Google's content hash, so they are shared across configs and safe to keep.
 *
 * @param {string} outDir
 * @param {string} key
 * @param {string} output
 * @param {(message: string) => void} log
 */
function pruneStale(outDir, key, output, log) {
  if (output !== 'commit') return
  const keep = new Set([cssName(key), `meta-${key}.json`])
  let removed = 0
  for (const name of readdirSync(outDir)) {
    if (keep.has(name)) continue
    if (!CSS_NAME_RE.test(name) && !/^meta-[0-9a-f]{16}\.json$/.test(name)) continue
    try {
      unlinkSync(join(outDir, name))
      removed++
    } catch {
      // A file another process is mid-rename on is not worth failing a build over.
    }
  }
  if (removed) log(`pruned ${removed} stale generated file(s) from .tss-fonts/`)
}
