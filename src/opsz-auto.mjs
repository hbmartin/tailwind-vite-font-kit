// Work out what `opszPin` a family should use, by measuring the font instead of guessing.
//
// Shared by `npx tss-fonts opsz <Family>`, which prints the answer, and `opszPin: 'auto'`,
// which applies it during generation. Both need the same three steps:
//
//   1. ask Google for the family with its opsz axis intact (a RANGE, not a pin)
//   2. download that woff2 and decompress it — fontkit reads fvar from a woff2 but
//      cannot read glyph advances from one, and this measures advances
//   3. measure the width swing across the sizes the family actually renders at, and
//      recommend a pin
//
// Why this is worth a download: `opszPin` defaults to 16, and 16 is only right for body
// text. On a display face the axis can be 9..144 with an fvar default of 14, and the
// difference between pinning at 16 and pinning at 48 was measured at ~20% of advance
// width. The default is a guess; this is a measurement.

import { hasOpszAxis, pinOpsz } from './opsz.mjs'
import { detectAxes, planOpsz, toSfnt } from './opsz-policy.mjs'
import { weightsFromSpec } from './detect.mjs'
import { assertFontHost } from './generate.mjs'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** Default size ladder when the caller has not said what sizes the family renders at.
 *  Body, subhead, heading, display — enough spread to expose a swing if there is one. */
export const DEFAULT_SIZES = [16, 24, 48, 96]

/**
 * The family's variation axes, straight from Google, with no API key.
 *
 * This is the piece that makes the command usable: to keep the opsz axis in the served
 * file you must ask css2 for a RANGE, and to ask for a range you must already know it.
 * Verified against the live API:
 *
 *   family=Fraunces                        -> a static 400 instance, no fvar at all
 *   family=Fraunces:opsz@0..1000           -> HTTP 400, an HTML error page with no hint
 *   family=Fraunces:opsz,wght@9..144,400   -> the variable font, axis intact
 *
 * So guessing is out and the bare form is useless. `fonts.google.com/metadata/fonts/<F>`
 * returns the real ranges unauthenticated (Fraunces: opsz 9..144; Inter: 14..32;
 * Nunito Sans: 6..12; Poppins: no axes at all). The body is XSSI-guarded with a `)]}'`
 * prefix, hence the slice to the first brace.
 *
 * Note the ranges are worth knowing for their own sake: Nunito Sans tops out at 12, so
 * the default `opszPin: 16` is outside its axis and gets clamped.
 *
 * @param {string} family
 * @returns {Promise<{tag: string, min: number, max: number, defaultValue: number}[] | null>}
 *   null when the metadata could not be read — the caller falls back to the configured axes
 */
export async function discoverAxes(family) {
  const url = `https://fonts.google.com/metadata/fonts/${encodeURIComponent(family)}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) return null
    const text = await res.text()
    const json = JSON.parse(text.slice(text.indexOf('{')))
    return Array.isArray(json.axes) ? json.axes : null
  } catch {
    return null
  }
}

/**
 * A css2 spec that keeps every axis, built from the discovered ranges.
 *
 * Deliberately NOT googleUrl(), whose entire job is to pin opsz away.
 * @param {{tag: string, min: number, max: number}[]} axes
 * @param {number[]} weights
 */
export function specFromAxes(axes, weights) {
  // css2 wants axis tags in alphabetical order, with one value per tag per tuple.
  const tags = axes.map((a) => a.tag).sort((a, b) => (a < b ? -1 : 1))
  const tuple = (w) =>
    tags
      .map((t) => {
        if (t === 'wght') return String(w)
        // `tags` is derived from `axes`, so the lookup cannot miss; the fallback is for
        // the type checker, not for a reachable case.
        const a = axes.find((x) => x.tag === t)
        return a ? `${a.min}..${a.max}` : '0'
      })
      .join(',')
  const useWeights = tags.includes('wght') ? weights : [null]
  return `${tags.join(',')}@${useWeights.map((w) => tuple(w)).join(';')}`
}

/**
 * Fold a recommendation back into the family the generator will download.
 *
 * Small, but this is where `opszPin: 'auto'` went wrong: it is not enough to set
 * `opszPin`, because googleUrl() applies a pin by rewriting the family's `axes` spec, and
 * a family configured with `weights` and no `axes` has no spec to rewrite. It built
 * `wght@700` — no opsz axis in the request at all — so the measured pin was silently
 * discarded and Google served whatever instance it liked. Taking `pinnedAxes` is what
 * makes the measurement reach the wire.
 *
 * @param {import('../index.d.ts').FontFamily} fam
 * @param {{hasOpsz: boolean, pin?: number, pinnedAxes?: string}} rec
 * @returns {import('../index.d.ts').FontFamily}
 */
export function applyRecommendation(fam, rec) {
  // No axis to pin. Drop the sentinel so googleUrl() never sees the string 'auto' where
  // it expects a number.
  if (!rec.hasOpsz) return { ...fam, opszPin: undefined }
  return { ...fam, opszPin: rec.pin, axes: rec.pinnedAxes ?? fam.axes }
}

/**
 * @param {string} url
 * @returns {Promise<Response>}
 */
async function get(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`[tss-fonts] HTTP ${res.status} for ${url}`)
  return res
}

/**
 * Measure a family and recommend an `opszPin`.
 *
 * @param {import('../index.d.ts').FontFamily} fam
 * @param {object} [opts]
 * @param {number[]} [opts.sizes] px sizes this family renders at
 * @param {number} [opts.tolerancePct]
 * @param {(m: string) => void} [opts.log]
 * @returns {Promise<{
 *   hasOpsz: boolean, pin?: number, axis?: {min: number, default: number, max: number},
 *   swingPct?: number, strategy?: string, reason?: string, bytes?: number,
 *   pinnedAxes?: string
 * }>}
 */
export async function recommendOpszPin(
  fam,
  { sizes = DEFAULT_SIZES, tolerancePct = 1.5, log = () => {} } = {},
) {
  // A family configured through its axes spec carries its weights there — measure at
  // those, not at a 400 the config never asked for. [400] is only for a bare name.
  const specWeights = !fam.weights?.length && fam.axes ? weightsFromSpec(fam.axes).weights : []
  const weights = fam.weights?.length ? fam.weights : specWeights.length ? specWeights : [400]

  // Cheap pre-check: if the config already spells out the axes and opsz is not among
  // them, there is nothing to measure and nothing to download.
  if (fam.axes && !hasOpszAxis(fam.axes)) {
    return { hasOpsz: false, reason: 'the axes spec declares no opsz axis' }
  }

  // Ask Google what axes the family actually has. This is free, needs no key, and is
  // what lets the command work from nothing but a family name.
  const discovered = await discoverAxes(fam.name)
  if (discovered && !discovered.some((a) => a.tag === 'opsz')) {
    return {
      hasOpsz: false,
      reason: `Google lists no opsz axis for ${fam.name}${
        discovered.length
          ? ` (it has: ${discovered.map((a) => a.tag).join(', ')})`
          : ' (not a variable font)'
      } — nothing to pin`,
    }
  }

  // Prefer the discovered ranges; fall back to whatever the config declared if the
  // metadata endpoint was unreachable or changed shape.
  const spec = discovered?.length ? specFromAxes(discovered, weights) : fam.axes
  if (!spec) {
    throw new Error(
      `[tss-fonts] could not determine the axes for ${fam.name}. ` +
        `Pass them in the family's \`axes\`, e.g. 'opsz,wght@9..144,400;9..144,700'.`,
    )
  }
  const url = `https://fonts.googleapis.com/css2?family=${fam.name.replace(/\s+/g, '+')}:${spec}&display=swap`
  log(`fetching ${url}`)
  const css = await (await get(url)).text()
  // css2 labels each subset's @font-face with a comment, and the first block is whatever
  // subset sorts first (cyrillic-ext, for many families) — a per-subset file with the
  // wrong glyphs to measure. Pick the latin block explicitly.
  const blocks = [...css.matchAll(/\/\*\s*([a-z0-9-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g)]
  const latin = blocks.find(([, subset]) => subset === 'latin')
  const src = latin ? /src:\s*url\(([^)]+)\)/.exec(latin[2])?.[1] : undefined
  if (!src) {
    throw new Error(
      `[tss-fonts] could not find a latin @font-face block in the css2 response for ${fam.name}`,
    )
  }
  assertFontHost(src, fam.name)

  log(`downloading ${src}`)
  const woff2 = Buffer.from(await (await get(src)).arrayBuffer())

  // fvar survives brotli, so detection works on the raw download.
  const { hasOpsz, opsz } = await detectAxes(woff2)
  if (!hasOpsz || !opsz) {
    return {
      hasOpsz: false,
      bytes: woff2.length,
      reason: 'the served file has no opsz axis — static metrics are already valid',
    }
  }

  // Measuring advances does not; decompress first.
  const sfnt = await toSfnt(woff2)
  const plan = await planOpsz(sfnt, { sizes, weights, tolerancePct })

  // planOpsz only computes a pin when the swing is worth acting on; below tolerance the
  // median used size is still the best single value, clamped into the axis.
  const pin =
    plan.pin ??
    Math.round(
      Math.min(
        Math.max([...sizes].sort((a, b) => a - b)[Math.floor(sizes.length / 2)], opsz.min),
        opsz.max,
      ),
    )

  return {
    hasOpsz: true,
    axis: opsz,
    swingPct: plan.swingPct,
    strategy: plan.strategy,
    reason: plan.reason,
    bytes: woff2.length,
    // The spec to actually download with. A family configured with weights but no `axes`
    // has nothing for googleUrl() to pin INTO — it builds `wght@700`, which has no opsz
    // axis, so the measured pin silently does nothing and Google serves whatever instance
    // it likes. Handing back a ready-made spec is what closes that loop.
    //
    // A family that already spells out its axes keeps them: pin opsz in place and leave
    // every other axis (wdth, ital, the declared weight tuples) exactly as configured —
    // rebuilding from scratch here used to silently drop them. (The early return above
    // guarantees fam.axes carries opsz when it exists at all.)
    //
    // The rebuilt spec is only opsz and wght: extra axes a family may carry (Fraunces has
    // SOFT and WONK) would keep the file variable along them for no benefit here.
    pinnedAxes: fam.axes
      ? pinOpsz(fam.axes, pin)
      : `opsz,wght@${weights.map((w) => `${pin},${w}`).join(';')}`,
    pin,
  }
}
