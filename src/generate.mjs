// Build-time generation: fetch the css2 stylesheet, download the woff2, compute the
// metric-matched fallbacks, and write one real on-disk CSS file.
//
// It has to be a REAL file: Tailwind resolves its own @imports with enhanced-resolve +
// fs.readFile, bypassing Vite's plugin container entirely, so a virtual module cannot
// be @imported from a Tailwind entry (hard build failure, not a silent one).

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { createRequire } from 'node:module'
import { fallbackFaces } from './metrics.mjs'
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

/**
 * fetch with retry+backoff. A bare ETIMEDOUT to fonts.googleapis.com killed a build
 * during testing with no recovery; a cold first contact was measured at 61s.
 */
async function fetchRetry(url, { tries = 3, baseDelay = 500, timeout = 60_000, log = () => {} } = {}) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      // Generous per-attempt timeout: a cold first contact was measured at 61s total,
      // but a single hung socket must not stall the build forever.
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(timeout) })
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`)
        // Only transient statuses are worth retrying; a 400/404 will never get better.
        err.permanent = !(res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500)
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
      }),
    )
    .digest('hex')
    .slice(0, 16)
}

/**
 * @returns {Promise<{cssPath: string, filesDir: string, files: string[], preloads: object[],
 *                    realFaces: number, fallbackFaces: number, fromCache: boolean}>}
 */
export async function generate(opts, outDir, log = () => {}) {
  const key = cacheKey(opts)
  const metaPath = join(outDir, `meta-${key}.json`)
  const filesDir = join(outDir, 'files')
  const cssPath = join(outDir, 'fonts.gen.css')

  if (existsSync(metaPath) && existsSync(cssPath)) {
    // A truncated or hand-mangled meta file is a cache MISS, not a crash.
    let meta = null
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    } catch {}
    if (Array.isArray(meta?.files) && meta.files.every((f) => existsSync(join(filesDir, f)))) {
      log(`cache hit (${meta.files.length} woff2, ${meta.realFaces} faces) — no network`)
      return { ...meta, cssPath, filesDir, fromCache: true }
    }
  }

  const { entireMetricsCollection: METRICS } = await import(
    '@capsizecss/metrics/entireMetricsCollection'
  ).catch(() => require_('@capsizecss/metrics/entireMetricsCollection'))

  mkdirSync(filesDir, { recursive: true })

  const realFaces = []
  const fallbackCss = []
  const themeLines = []
  const preloads = []
  const files = []
  const seenSrc = new Map()

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
    const url = googleUrl(fam, log)
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
          throw new Error(`[tss-fonts] could not parse ${what} in a ${fam.name} @font-face block from ${url}`)
        }
        return m[1]
      }
      const weight = grab(/font-weight:\s*([^;]+)/, 'font-weight').trim()
      const style = grab(/font-style:\s*([^;]+)/, 'font-style').trim()
      const src = grab(/src:\s*url\(([^)]+)\)/, 'src')
      const range = /unicode-range:\s*([^;}]+)/.exec(block)?.[1].trim()

      let href = src
      if (selfHost) {
        let file = seenSrc.get(src)
        if (!file) {
          // Google's own filenames already carry a content hash, so a fixed name is
          // safe to serve `immutable`.
          file = `${slug(fam.name)}-${src.split('/').pop()}`
          const buf = Buffer.from(await (await fetchRetry(src, { log })).arrayBuffer())
          writeFileSync(join(filesDir, file), buf)
          seenSrc.set(src, file)
          files.push(file)
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
      if (fam.preloadWeights?.some((pw) => pw >= wLo && pw <= wHi) && !preloads.some((p) => p.href === href)) {
        // crossOrigin is REQUIRED even same-origin. Fonts are always CORS-fetched, and a
        // preload without it is a *different* cache entry, so the font downloads TWICE:
        // measured 4 requests / 185 kB instead of 2 / 93 kB, and fonts applied 104ms
        // LATER than shipping no preload at all. No error, no console warning.
        preloads.push({ rel: 'preload', as: 'font', type: 'font/woff2', href, crossOrigin: 'anonymous' })
      }
    }

    const { css: fbCss, names } = fallbackFaces(METRICS, fam.name, opts.subsets[0], famWeights, log)
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
    `${realFaces.join('\n')}\n\n${fallbackCss.join('\n')}\n\n@theme {\n${themeLines.join('\n')}\n}\n`
  writeFileSync(cssPath, out)

  const meta = {
    files,
    preloads,
    realFaces: realFaces.length,
    fallbackFaces: fallbackCss.join('\n').split('@font-face').length - 1,
  }
  writeFileSync(metaPath, JSON.stringify(meta, null, 2))
  log(
    `wrote fonts.gen.css — ${meta.realFaces} real faces, ${meta.fallbackFaces} fallback faces, ${preloads.length} preloads`,
  )
  return { ...meta, cssPath, filesDir, fromCache: false }
}
