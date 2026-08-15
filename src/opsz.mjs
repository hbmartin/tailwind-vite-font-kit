// Optical-size (`opsz`) handling.
//
// A font with an `opsz` axis has advance widths that depend on the size it renders at,
// and `font-optical-sizing: auto` is the CSS default. So no single static `size-adjust`
// can be correct — measured on Fraunces vs Times New Roman:
//
//   optical sizing auto @100px  ->  96.30%   (what actually renders)
//   forced opsz 14 (text)       -> 118.49%
//   forced opsz 144 (display)   ->  95.14%
//   what every tool emits       -> 115.45%   (~20% wrong for a display heading)
//
// The fix is not to compensate but to REMOVE the axis: pin `opsz` in the css2 request.
// The served woff2 then has no opsz axis at all, static metrics become valid again, no
// app CSS is involved, and the file is ~45% smaller (Fraunces 67.4 kB -> 36.2 kB).
// Measured residual error after pinning: -0.31% at 96px, -0.31% at 48px, -0.80% at 32px.
//
// Rejected alternatives, all measured:
//   - detect the axis and skip the fallback  -> WORSE than a wrong static fallback; it
//     trades a bounded error for an unbounded one, and was the only mode of eight to
//     register nonzero CLS on the standard probes.
//   - `font-optical-sizing: none` alone      -> -2.7% at 96px but -7.9% at 32px, and it
//     renders the fvar DEFAULT, which for several families is a display-size instance.
//   - measure in headless Chrome at build    -> pointless; fontkit already agrees with
//     Chrome to 0.146%, and the local() target usually isn't installed on a build box.
//
// Only ~29 of 1,942 Google families carry opsz (1.5%) — but the list includes Inter,
// DM Sans, Playfair, Literata, Nunito Sans, Merriweather and Fraunces.

/** Does this css2 axis spec declare an `opsz` axis? Free to check — no download needed. */
export function hasOpszAxis(axes) {
  return /(^|,)opsz/.test(axes)
}

/**
 * Rewrite a css2 axis tuple spec so `opsz` is pinned to a single value.
 *   'opsz,wght@9..144,500;9..144,700'  ->  'opsz,wght@48,500;48,700'
 * By default only ranges (`a..b`) in the opsz position are replaced, so a spec the user
 * pinned by hand is returned unchanged. `replaceFixed` overrides fixed values too — for
 * a measured pin that must land in EVERY tuple: mixed fixed values ('12,400;72,700')
 * keep the axis alive on the wire, which is exactly what pinning exists to remove.
 */
export function pinOpsz(axes, pin, { replaceFixed = false } = {}) {
  const at = axes.indexOf('@')
  if (at === -1) return axes
  // Axis tags are alphabetical in css2, so opsz is NOT always first — 'ital,opsz,wght'
  // puts it second. Pin the value at opsz's own position in each tuple.
  const oi = axes.slice(0, at).split(',').indexOf('opsz')
  if (oi === -1) return axes
  const tuples = axes
    .slice(at + 1)
    .split(';')
    .map((t) => {
      const parts = t.split(',')
      if (parts[oi] !== undefined && (replaceFixed || parts[oi].includes('..'))) {
        parts[oi] = String(pin)
      }
      return parts.join(',')
    })
  return axes.slice(0, at) + '@' + tuples.join(';')
}

/** Whether hand-fixed tuple values prevent a family-wide pin from taking effect. */
export function opszPinIsOverridden(axes, pin) {
  return hasOpszAxis(axes) && pinOpsz(axes, pin) !== pinOpsz(axes, pin, { replaceFixed: true })
}

/**
 * Build the css2 URL for a family, pinning `opsz` if present.
 * Default pin is 16 — near the median size body text renders at. Pass `opszPin: 48`
 * (or whatever your display size is) for a display face.
 * @param {import('../index.d.ts').FontFamily} fam
 * @param {(message: string) => void} [log]
 * @param {(message: string) => void} [warn] surfaced even under `silent`
 */
export function googleUrl(fam, log = () => {}, warn = log) {
  // `weights` is optional when `axes` supplies a wght axis. With neither there is no URL
  // to build — generate() rejects this earlier with the same complaint, but an empty
  // `wght@` is a silently malformed request, so refuse it here too.
  if (!fam.axes && !fam.weights?.length) {
    throw new Error(`[tss-fonts] family "${fam.name}" has neither \`weights\` nor \`axes\`.`)
  }
  let axes = fam.axes ?? `wght@${[...(fam.weights ?? [])].sort((a, b) => a - b).join(';')}`
  if (hasOpszAxis(axes)) {
    const pin = fam.opszPin ?? 16
    // Only ranges are filled with the pin. A value the user fixed by hand stays theirs:
    // an explicit '28,700' tuple is more specific than one family-wide number, and
    // configs written before opszPin existed rely on it winning — silently replacing it
    // changes which optical-size masters a site downloads. (`opszPin: 'auto'` is not
    // affected: applyRecommendation() hands over an axes spec with the measured pin
    // already in every tuple.) When both are present and disagree, the config is
    // ambiguous — say so instead of silently serving either interpretation.
    const pinned = pinOpsz(axes, pin)
    if (typeof fam.opszPin === 'number' && opszPinIsOverridden(axes, pin)) {
      warn(
        `"${fam.name}": \`axes\` fixes opsz by hand while \`opszPin: ${fam.opszPin}\` is ` +
          `also set — the hand-written values win. Remove \`opszPin\`, or switch the spec ` +
          `to a range (e.g. 'opsz,wght@9..144,400') if the pin should apply.`,
      )
    }
    axes = pinned
    log(`  opsz axis detected -> pinned at ${pin} (removes the axis, ~45% smaller file)`)
  }
  return `https://fonts.googleapis.com/css2?family=${fam.name.replace(/\s+/g, '+')}:${axes}&display=swap`
}
