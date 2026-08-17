// ─────────────────────────────────────────────────────────────────────────────
// Decide what to do about `opsz`. Everything here is offline — no network, no
// browser. It reads the axes out of the woff2 you are ACTUALLY going to serve.
//
// This is the machinery behind `npx tss-fonts opsz <Family>` and `opszPin: 'auto'`.
// Both paths are opt-in: fontkit and wawoff2 are OPTIONAL peer dependencies, imported
// lazily below, so a normal build never loads them and an install without them works.
//
// DECISION RULE (thresholds are the measured ones — see the report):
//
//   0. Before anything else: if you control the download URL, ask Google for a
//      PINNED opsz (`family=Fraunces:opsz,wght@48,500;48,700`). The served woff2
//      then has NO opsz axis, every static metric is valid again, and the file is
//      45% smaller (37.1 kB vs 67.4 kB for Fraunces latin). planOpsz reports this
//      as `recommendPinnedDownload` whenever the swing is large.
//   1. No `opsz` axis in the SERVED file            -> nothing to do. (98.5% of
//      Google Fonts families; 94.8% of the variable ones.)
//   2. opsz present but the width swing across the
//      sizes the app really uses is < 1.5%          -> treat as static: instance
//      once at the fvar default and move on.
//   3. opsz present, swing >= 1.5%, and the app pins
//      `font-optical-sizing: none`                  -> ONE face, instanced at the
//      SERVED file's fvar DEFAULT. Verified in Chrome on 5 families: optical
//      sizing off renders the fvar default exactly (residual 0.000%). Do NOT use
//      the family-level table — for 17 of 29 opsz families it describes a
//      different instance, off by up to 40%.
//   4. opsz present, swing >= 1.5%, optical sizing left at auto:
//      a. the type scale is a FIXED ladder you can enumerate -> one fallback
//         family per rung, instanced at that px size, switched by the same media
//         / container queries that switch the font-size. Exact at the rungs.
//      b. the type scale is FLUID (clamp/vw) -> buckets cannot be exact; the best
//         5 buckets still leave 2.5% worst-case on Fraunces. Emit
//         `font-optical-sizing: none` on the family's own class and fall back to
//         (3). A constant small error beats a size-dependent large one.
//
// ALSO — bigger than opsz at ordinary sizes: emit one fallback face PER DECLARED
// WEIGHT. Fraunces wght 700 is 5.3% wider than wght 500 at the same opsz, and a
// single-weight fallback family is what leaves the residual error on bold
// headings in every strategy below.
// ─────────────────────────────────────────────────────────────────────────────

import { localSources } from './metrics.mjs'
import { WEIGHTINGS } from './weightings.mjs'

// ── optional peers, imported on demand ───────────────────────────────────────
// These are `peerDependenciesMeta.optional` rather than dependencies: they are only
// needed by the two opt-in paths above, and fontkit + a brotli decompressor are a lot of
// bytes to put on every install of a font plugin. Importing this module must never throw,
// which is why nothing here is imported at module scope — the previous version of this
// file did exactly that, in a top-level await, and could not be loaded at all without
// @capsizecss/unpack present.

const INSTALL_HINT = (pkgs) =>
  `install ${pkgs.map((p) => `\`${p}\``).join(' and ')} to use this — ` +
  `${pkgs.join(' ')} are optional peer dependencies of tailwind-vite-font-kit, ` +
  `needed only by \`tss-fonts opsz\` and \`opszPin: 'auto'\`.`

/** @type {Promise<any> | null} */
let fontkitPromise = null
async function loadFontkit() {
  fontkitPromise ??= import('fontkit').catch(() => {
    throw new Error(`[tss-fonts] ${INSTALL_HINT(['fontkit'])}`)
  })
  return fontkitPromise
}

// ── capsize's exact xWidthAvg algorithm, applied to a VARIATION INSTANCE ──────
// @capsizecss/unpack only exposes family-level numbers, so the same weighting table is
// re-applied here to a fontkit instance. The table is vendored in ./weightings.mjs
// rather than scraped out of unpack's minified dist at import time; see that file.

/**
 * @param {any} font a fontkit font or variation instance
 * @param {string} subset
 */
export function xWidthAvg(font, subset = 'latin') {
  const w = WEIGHTINGS[subset]
  if (!w) {
    throw new Error(
      `[tss-fonts] no character weightings for subset "${subset}" ` +
        `(have: ${Object.keys(WEIGHTINGS).join(', ')})`,
    )
  }
  const sample = Object.keys(w).join('')
  const glyphs = font.glyphsForString(sample)
  // The weighting is applied by index, so a glyph count that differs from the sample
  // length (shaping merged or dropped glyphs) would silently weight the wrong chars.
  if (glyphs.length !== sample.length) {
    throw new Error(
      `[tss-fonts] glyphsForString returned ${glyphs.length} glyphs for a ${sample.length}-char sample — ` +
        `index-based weighting would be wrong for this font/subset`,
    )
  }
  let sum = 0
  glyphs.forEach((g, i) => {
    if (g.isMark) return
    sum += (g.advanceWidth ?? 0) * w[sample.charAt(i)]
  })
  return Math.round(sum)
}

const asBuf = (b) => (Buffer.isBuffer(b) ? b : Buffer.from(b))

// GOTCHA worth knowing: fontkit parses `fvar` out of a woff2 fine (so detection
// works on the raw download), but it CANNOT read glyph advances from one — the
// glyf/cmap tables are still brotli-compressed and `glyphsForString` throws
// "Cannot read properties of undefined (reading 'tables')". Anything that
// measures widths must decompress first.
/** @param {Buffer | Uint8Array} buf */
export async function toSfnt(buf) {
  const b = asBuf(buf)
  if (b.toString('ascii', 0, 4) !== 'wOF2') return b
  const wawoff2 = await import('wawoff2').catch(() => {
    throw new Error(`[tss-fonts] ${INSTALL_HINT(['wawoff2'])}`)
  })
  const decompress = wawoff2.default?.decompress ?? wawoff2.decompress
  return Buffer.from(await decompress(b))
}

const pct = (n) => `${(n * 100).toFixed(4)}%`
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]

// Anything that MEASURES needs decompressed glyf/cmap; a woff2 gets as far as
// glyphsForString and dies on "Cannot read properties of undefined". Fail up front
// with the actual fix instead.
function requireSfnt(buf, fn) {
  if (asBuf(buf).toString('ascii', 0, 4) === 'wOF2') {
    throw new Error(
      `[tss-fonts] ${fn} measures glyph advances, which fontkit cannot read from a woff2 — ` +
        `decompress first: const sfnt = await toSfnt(buf)`,
    )
  }
}

// ── (a) DETECTION ────────────────────────────────────────────────────────────
/** Read the fvar axes straight out of the woff2/ttf you downloaded. */
export async function detectAxes(buf) {
  const fontkit = await loadFontkit()
  const font = fontkit.create(asBuf(buf))
  const axes = font.variationAxes || {}
  const opsz = axes.opsz ?? null
  return {
    axes,
    hasOpsz: !!opsz,
    opsz: opsz && { min: opsz.min, default: opsz.default, max: opsz.max },
  }
}

/** Zero-I/O variant: the axis list is already in the Google css2 URL you asked
 *  for (`family=Fraunces:ital,opsz,wght@0,9..144,500`). Lets a generator decide
 *  the download shape before it downloads anything. */
export function detectAxesFromGoogleUrl(url) {
  const out = {}
  for (const spec of new URL(url).searchParams.getAll('family')) {
    const [name, axisSpec] = spec.split(':')
    const tags = axisSpec ? axisSpec.split('@')[0].split(',') : []
    const values = axisSpec ? (axisSpec.split('@')[1] || '').split(';')[0].split(',') : []
    const i = tags.indexOf('opsz')
    out[name.replace(/\+/g, ' ')] = {
      axes: tags,
      hasOpsz: i >= 0,
      // `opsz@14` (single value) => Google returns a file with no opsz fvar axis.
      opszPinned: i >= 0 && values[i] != null && !values[i].includes('..'),
    }
  }
  return out
}

/** Dependency-free fvar reader — sfnt (ttf/otf) only, NOT woff2. */
export function readFvar(buf) {
  const u32 = (o) => buf.readUInt32BE(o)
  const u16 = (o) => buf.readUInt16BE(o)
  /** @type {{off: number} | null} */
  let fvar = null
  for (let i = 0; i < u16(4); i++) {
    const rec = 12 + i * 16
    if (buf.toString('ascii', rec, rec + 4) === 'fvar') fvar = { off: u32(rec + 8) }
  }
  if (!fvar) return { axes: {}, hasOpsz: false }
  const o = fvar.off
  const axes = {}
  for (let i = 0; i < u16(o + 8); i++) {
    const a = o + u16(o + 4) + i * u16(o + 10)
    axes[buf.toString('ascii', a, a + 4)] = {
      min: buf.readInt32BE(a + 4) / 65536,
      default: buf.readInt32BE(a + 8) / 65536,
      max: buf.readInt32BE(a + 12) / 65536,
    }
  }
  return { axes, hasOpsz: 'opsz' in axes, opsz: axes.opsz ?? null }
}

// ── THE PLAN ─────────────────────────────────────────────────────────────────

/**
 * One instance of the variable font to generate a fallback face from.
 * @typedef {object} OpszInstance
 * @property {number} [weight]
 * @property {Record<string, number>} variations
 * @property {number[]} [sizes]   the px sizes this bucket covers (`buckets` strategy)
 * @property {string} [suffix]    appended to the fallback family name, to keep buckets distinct
 */

/**
 * @typedef {object} OpszPlan
 * @property {'static'|'pin-fvar-default'|'emit-optical-sizing-none'|'buckets'} strategy
 * @property {string} reason
 * @property {OpszInstance[]} instances
 * @property {boolean} perWeight
 * @property {{min: number, default: number, max: number}} [axis] absent when there is no opsz
 * @property {number} [swingPct]  worst advance-width swing across the used sizes
 * @property {number} [pin]       the single opsz value to request, when one is worth requesting
 * @property {boolean} [recommendPinnedDownload]
 * @property {string} [pinnedDownloadHint]
 * @property {string} [css]
 * @property {string} [warning]
 */

/**
 * @param {Buffer | Uint8Array} buf   the woff2/ttf you will serve
 * @param {object} [opts]
 * @param {number[]} [opts.sizes]                 every px font-size this family renders at
 * @param {number[]} [opts.weights]               the font-weight values on its faces
 * @param {boolean} [opts.opticalSizingPinned]    app sets `font-optical-sizing: none`
 * @param {boolean} [opts.fluidTypeScale]         sizes come from clamp()/vw, not a ladder
 * @param {number} [opts.tolerancePct]            max acceptable advance-width error
 * @returns {Promise<OpszPlan>}
 */
export async function planOpsz(buf, opts = {}) {
  const {
    sizes = [16],
    weights = [400],
    opticalSizingPinned = false,
    fluidTypeScale = false,
    tolerancePct = 1.5,
  } = opts
  const fontkit = await loadFontkit()
  const font = fontkit.create(asBuf(buf))
  const ax = font.variationAxes?.opsz
  const perWeight = weights.length > 1
  /** @type {(w: number) => Record<string, number>} */
  const varyW = (w) =>
    font.variationAxes?.wght ? { wght: w } : /** @type {Record<string, number>} */ ({})

  if (!ax) {
    return {
      strategy: 'static',
      reason: 'no opsz axis in the served file — family-level metrics are valid',
      instances: weights.map((w) => ({ weight: w, variations: varyW(w) })),
      perWeight,
    }
  }

  // Everything past here measures advances, which a woff2 cannot provide.
  requireSfnt(buf, 'planOpsz')

  const clamp = (o) => Math.min(Math.max(o, ax.min), ax.max)
  const w0 = weights[0]
  /** @type {(o: number, w?: number) => Record<string, number>} */
  const vary = (o, w = w0) => ({ ...varyW(w), opsz: clamp(o) })
  // Memoised: the bucketing loop re-measures the same (size, weight) pairs repeatedly,
  // and each miss costs a full getVariation + glyph walk.
  const emCache = new Map()
  const em = (o, w = w0) => {
    const k = `${o}|${w}`
    if (!emCache.has(k)) {
      const v = font.getVariation(vary(o, w))
      emCache.set(k, xWidthAvg(v) / v.unitsPerEm)
    }
    return emCache.get(k)
  }

  // The swing that matters is the worst across the DECLARED weights, not just the
  // first one — opsz width response differs by weight (see the per-weight note above).
  const swingPct = Math.max(
    ...weights.map((w) => {
      const used = sizes.map((s) => em(s, w))
      return (Math.max(...used) / Math.min(...used) - 1) * 100
    }),
  )
  const base = { axis: { ...ax }, swingPct: +swingPct.toFixed(2), perWeight }

  if (opticalSizingPinned) {
    return {
      ...base,
      strategy: 'pin-fvar-default',
      reason:
        'app pins font-optical-sizing:none — the browser renders the fvar default instance at every size',
      instances: weights.map((w) => ({ weight: w, variations: vary(ax.default, w) })),
    }
  }
  if (swingPct < tolerancePct) {
    return {
      ...base,
      strategy: 'static',
      reason: `opsz present but the width swing over the used sizes is ${swingPct.toFixed(2)}% < ${tolerancePct}%`,
      instances: weights.map((w) => ({ weight: w, variations: vary(median(sizes), w) })),
    }
  }
  // Big swing. If you own the download, delete the axis instead of modelling it.
  // Clamped: the median used size can sit outside the axis (e.g. 200px on a 9..144 opsz).
  const pin = Math.round(clamp(median(sizes)))
  const recommendPinnedDownload = {
    recommendPinnedDownload: true,
    pinnedDownloadHint:
      `request a single opsz value instead of a range, e.g. ` +
      `https://fonts.googleapis.com/css2?family=<Family>:opsz,wght@${weights.map((w) => `${pin},${w}`).join(';')} ` +
      `— the served woff2 then has no opsz axis at all and is markedly smaller.`,
    pin,
  }
  if (fluidTypeScale) {
    return {
      ...base,
      ...recommendPinnedDownload,
      strategy: 'emit-optical-sizing-none',
      reason:
        `width swing ${swingPct.toFixed(2)}% and the type scale is fluid, so the used px size is a continuous ` +
        `function of the viewport that no class or bucket can track exactly`,
      css: `{ font-optical-sizing: none }`,
      instances: weights.map((w) => ({ weight: w, variations: vary(ax.default, w) })),
    }
  }
  // Fixed ladder: greedy bucketing over the enumerated sizes.
  const sorted = [...new Set(sizes)].sort((a, b) => a - b)
  const buckets = []
  let group = [sorted[0]]
  for (const s of sorted.slice(1)) {
    const trial = [...group, s]
    const centre = trial[Math.floor(trial.length / 2)]
    // Every bucket is emitted for every weight below, so it has to hold at every weight:
    // measuring w0 alone can accept a bucket that breaks tolerance at 700. Re-measuring
    // is cheap because em() is memoised — the pairs are bounded by sizes × weights.
    const worst = Math.max(
      ...weights.flatMap((w) => {
        const c = em(centre, w)
        return trial.map((x) => Math.abs(c / em(x, w) - 1) * 100)
      }),
    )
    if (worst <= tolerancePct) group.push(s)
    else {
      buckets.push(group)
      group = [s]
    }
  }
  buckets.push(group)
  return {
    ...base,
    ...recommendPinnedDownload,
    strategy: 'buckets',
    reason: `width swing ${swingPct.toFixed(2)}% over the used sizes exceeds ${tolerancePct}%`,
    instances: buckets.flatMap((g) => {
      const centre = g[Math.floor(g.length / 2)]
      return weights.map((w) => ({
        weight: w,
        sizes: g,
        suffix: ` Fallback ${centre}`,
        variations: vary(centre, w),
      }))
    }),
    warning:
      'each bucket needs its own family name AND a media/container query switching families exactly where ' +
      'the font-size changes — a utility class alone cannot know the used px size.',
  }
}

// ── EMIT ─────────────────────────────────────────────────────────────────────
/**
 * @param {Buffer | Uint8Array} buf
 * @param {OpszPlan} plan
 * `targets` takes FALLBACK_TARGETS entries verbatim — `[local, metricsKey, aliases?]`.
 * Anything narrower would drop the Linux aliases on destructuring, which is exactly the
 * silent no-op the aliases exist to remove.
 * @param {{family: string, targets: [string, string, string[]?][], metrics: Record<string, any>}} opts
 */
export async function buildFallbackCss(buf, plan, opts) {
  const { family, targets, metrics } = opts
  requireSfnt(buf, 'buildFallbackCss')
  const fontkit = await loadFontkit()
  const font = fontkit.create(asBuf(buf))
  const out = []
  for (const inst of plan.instances) {
    const v = Object.keys(inst.variations || {}).length ? font.getVariation(inst.variations) : font
    const x = xWidthAvg(v)
    for (const [local, mk, aliases = []] of targets) {
      const fb = metrics[mk]
      if (!fb) {
        throw new Error(
          `[tss-fonts] no metrics entry for target key "${mk}" (local "${local}") — ` +
            `keys must exist in the passed entireMetricsCollection`,
        )
      }
      const fbEm = (fb.subsets?.latin?.xWidthAvg ?? fb.xWidthAvg) / fb.unitsPerEm
      const sa = x / v.unitsPerEm / fbEm
      // The vertical descriptors are divided by size-adjust because the browser
      // applies size-adjust to them too; pre-compensating makes the final used
      // values equal the web font's.
      out.push(
        `@font-face{font-family:"${family}${inst.suffix || ' Fallback'}";` +
          (plan.perWeight && inst.weight ? `font-weight:${inst.weight};` : '') +
          `src:${localSources(local, aliases)};size-adjust:${pct(sa)};` +
          `ascent-override:${pct(v.ascent / (v.unitsPerEm * sa))};` +
          `descent-override:${pct(Math.abs(v.descent) / (v.unitsPerEm * sa))};` +
          `line-gap-override:${pct(v.lineGap / (v.unitsPerEm * sa))}}`,
      )
    }
  }
  return out.join('')
}
