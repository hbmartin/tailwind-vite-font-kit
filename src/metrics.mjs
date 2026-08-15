// Metric-matched fallback @font-face generation.
//
// The four descriptors, and which of them actually do anything:
//   size-adjust        scales glyph advances. THE one that matters in a Tailwind app,
//                      because it changes wrapping, hence line count, hence height.
//   ascent-override    }  drive the line box — and are INERT wherever line-height is
//   descent-override   }  anything other than `normal`. Tailwind's preflight sets a
//   line-gap-override  }  unitless 1.5 on html, so that is everywhere by default.
// They are emitted anyway: ~600 bytes, zero requests, and they are the insurance for
// third-party CSS, `not-prose` islands, and anything that opts out of the pin.

/**
 * One generated face per local() target, each with a DISTINCT family name.
 *
 * A single `local("Arial")` face is a silent no-op on Android and most Linux, where
 * Arial isn't installed — the face fails to load and the stack falls through to an
 * unadjusted family. Distinct names let each platform pick the one it has; identical
 * names carrying conflicting descriptors would let the last loadable one win silently.
 *
 * `BlinkMacSystemFont` is deliberately absent: it is a CSS keyword, not an installed
 * face, and resolves to `status: "error"` in Chrome on macOS. fontaine lists it first.
 *
 * Order matters — the first target that is installed wins. Arial and Georgia are the
 * most broadly available, and measured best here. Be aware this is a weak lever:
 * Helvetica Neue measured *more* accurate than Arial (+0.20% vs +0.26%) yet produced
 * worse CLS, because below ~1% error whether a line break flips is arbitrary.
 */
export const FALLBACK_TARGETS = {
  'sans-serif': [
    ['Arial', 'arial'],
    ['Helvetica Neue', 'helveticaNeue'],
    ['Segoe UI', 'segoeUI'],
    ['Roboto', 'roboto'],
  ],
  serif: [
    ['Georgia', 'georgia'],
    ['Times New Roman', 'timesNewRoman'],
  ],
  monospace: [['Courier New', 'courierNew']],
}

export const pct = (n) => `${+(n * 100).toFixed(4)}%`
export const metricsKey = (family) =>
  family.replace(/\s+/g, '').replace(/^(.)/, (m) => m.toLowerCase())

// Per-weight metrics. Arial 700 is 7.7% wider than Arial regular, so ONE fallback face
// per family is wrong for every weight but one. capsize ships `variants` for all ~1,921
// families and for the fallback targets too, so this is free and fully offline.
// Targets only carry `regular` and `700`.
const variantOf = (m, weight) =>
  m.variants?.[String(weight)] ?? m.variants?.[weight >= 600 ? '700' : 'regular'] ?? m
const targetVariant = (m, weight) => m.variants?.[weight >= 600 ? '700' : 'regular'] ?? m

/**
 * Build the fallback faces for one family.
 * @param {Record<string, any>} METRICS
 * @param {string} family
 * @param {string} subset
 * @param {number[]} weights
 * @param {(message: string) => void} [log]
 * @param {(message: string) => void} [warn] for outcomes where the build succeeds but the
 *   result is wrong; must not be silenceable
 * @returns {{ css: string, names: string[] }} `names` go into the @theme stack, in order.
 *   The rules carry no unicode-range — the caller scopes them, and merges subsets whose
 *   metrics come out identical.
 */
export function fallbackFaces(METRICS, family, subset, weights, log = () => {}, warn = () => {}) {
  const m = METRICS[metricsKey(family)]
  if (!m) {
    // Not a log line. With no metrics there are no fallback faces, no size-adjust and no
    // CLS protection — the font still loads and the page still looks right until it
    // reflows, so nothing else will ever tell anyone this happened.
    warn(
      `no capsize metrics for "${family}" — NO metric-matched fallbacks were emitted for it, ` +
        `so this family gets no CLS protection. Check the spelling against the Google Fonts ` +
        `family name, or set a \`stack\` you are happy to fall back to.`,
    )
    return { css: '', names: [] }
  }
  const cat = FALLBACK_TARGETS[m.category] ? m.category : 'sans-serif'
  const out = []
  const names = []

  for (const [localName, key] of FALLBACK_TARGETS[cat]) {
    const fbFamily = METRICS[key]
    if (!fbFamily) continue
    const name = `${family} Fallback: ${localName}`
    names.push(name)

    for (const weight of weights) {
      const v = variantOf(m, weight)
      const fb = targetVariant(fbFamily, weight)
      // Variants carry their own per-subset data — prefer it, since a variant's average
      // width differs from the family's (Poppins 700 latin: 515 vs 500).
      const xAvg = v.subsets?.[subset]?.xWidthAvg ?? v.xWidthAvg
      const fbAvg = fb.subsets?.[subset]?.xWidthAvg ?? fb.xWidthAvg
      const upem = v.unitsPerEm ?? m.unitsPerEm
      const fbUpem = fb.unitsPerEm ?? fbFamily.unitsPerEm
      const sizeAdjust = xAvg / upem / (fbAvg / fbUpem)
      if (!Number.isFinite(sizeAdjust) || sizeAdjust <= 0) {
        // Names the subset: faces are per-subset, and the caller dedupes identical
        // messages — without the subset a real warning for a second subset would read
        // as a repeat of the first and be dropped.
        warn(
          `non-finite size-adjust for "${name}" weight ${weight} (${subset} subset) — ` +
            `that face was skipped`,
        )
        continue
      }
      const ascent = v.ascent ?? m.ascent
      const descent = v.descent ?? m.descent
      const lineGap = v.lineGap ?? m.lineGap

      // ascent/descent/line-gap are divided by size-adjust because the browser applies
      // size-adjust to them too; pre-compensating makes the final values equal the web
      // font's. Same formula as next/font, though the inputs differ (capsize uses a
      // frequency-weighted average width, next/font an unweighted one) — so do NOT
      // write tests asserting parity with next/font's numbers.
      out.push(
        `@font-face{font-family:"${name}";font-weight:${weight};src:local("${localName}");` +
          `size-adjust:${pct(sizeAdjust)};` +
          `ascent-override:${pct(ascent / (upem * sizeAdjust))};` +
          `descent-override:${pct(Math.abs(descent) / (upem * sizeAdjust))};` +
          `line-gap-override:${pct(lineGap / (upem * sizeAdjust))}` +
          `}`,
      )
    }
  }
  return { css: out.join('\n'), names }
}
