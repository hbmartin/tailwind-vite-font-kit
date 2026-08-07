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
 * Only ranges (`a..b`) in the opsz position are replaced; an already-pinned spec is
 * returned unchanged.
 */
export function pinOpsz(axes, pin) {
  return axes.replace(
    /@(.*)$/,
    (_, tuples) =>
      '@' +
      tuples
        .split(';')
        .map((t) => t.replace(/^[\d.]+\.\.[\d.]+/, String(pin)))
        .join(';'),
  )
}

/**
 * Build the css2 URL for a family, pinning `opsz` if present.
 * Default pin is 16 — near the median size body text renders at. Pass `opszPin: 48`
 * (or whatever your display size is) for a display face.
 */
export function googleUrl(fam, log = () => {}) {
  let axes = fam.axes ?? `wght@${[...fam.weights].sort((a, b) => a - b).join(';')}`
  if (hasOpszAxis(axes)) {
    const pin = fam.opszPin ?? 16
    axes = pinOpsz(axes, pin)
    log(`  opsz axis detected -> pinned at ${pin} (removes the axis, ~45% smaller file)`)
  }
  return `https://fonts.googleapis.com/css2?family=${fam.name.replace(/\s+/g, '+')}:${axes}&display=swap`
}
