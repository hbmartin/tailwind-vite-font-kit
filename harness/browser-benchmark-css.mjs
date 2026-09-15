// Shared handling for generated and minified metric CSS. Preserve original tokens
// when reordering stacks so quoting/escaping cannot change family identity.
const metricFacePattern = /@font-face\s*\{[^{}]*\bsize-adjust\s*:[^{}]*\}/gi
export const metricFaces = (css) => [...css.matchAll(metricFacePattern)]
export const mapMetricFaces = (css, transform) => css.replace(metricFacePattern, transform)
export function familyName(token) {
  return token
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\([0-9a-f]{1,6})\s?|\\(.)/gi, (_, hex, char) =>
      hex ? String.fromCodePoint(parseInt(hex, 16)) : char,
    )
}
export function mapStacks(css, transform) {
  return css.replace(/((?:--[\w-]+|font-family)\s*:)([^;{}]+)/gi, (original, property, value) => {
    const tokens = value.match(/(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\\.|[^,])+/g) ?? []
    const before = tokens
    const after = transform([...before])
    if (before.length === after.length && before.every((token, i) => token === after[i]))
      return original
    return property + after.join(',')
  })
}
export function stripFallbacks(css) {
  return mapStacks(
    mapMetricFaces(css, () => ''),
    (tokens) => tokens.filter((t) => !familyName(t).includes(' Fallback: ')),
  )
}
export function fontWeight(face) {
  const value = /font-weight\s*:\s*([^;}]+)/i.exec(face)?.[1].trim().toLowerCase() ?? 'normal'
  if (value === 'normal') return 400
  if (value === 'bold') return 700
  return /^\d+$/.test(value) ? Number(value) : null // Do not guess across variable weight ranges.
}
