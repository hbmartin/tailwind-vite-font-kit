import { mapMetricFaces, mapStacks, familyName, fontWeight } from './browser-benchmark-css.mjs'
// Experimental CSS only. No production defaults change until the paired gates pass.
const boldNames = {
  Arial: ['Arial Bold', 'Arial-BoldMT'],
  'Liberation Sans': ['Liberation Sans Bold', 'LiberationSans-Bold'],
  'Helvetica Neue': ['Helvetica Neue Bold', 'HelveticaNeue-Bold'],
  'Segoe UI': ['Segoe UI Bold', 'SegoeUI-Bold'],
  Roboto: ['Roboto Bold', 'Roboto-Bold'],
  Georgia: ['Georgia Bold', 'Georgia-Bold'],
  'Times New Roman': ['Times New Roman Bold', 'TimesNewRomanPS-BoldMT'],
  'Liberation Serif': ['Liberation Serif Bold', 'LiberationSerif-Bold'],
  'Courier New': ['Courier New Bold', 'CourierNewPS-BoldMT'],
  'Liberation Mono': ['Liberation Mono Bold', 'LiberationMono-Bold'],
}
export function candidateCss(css, candidate) {
  if (!['binding', 'manrope-helvetica', 'combined'].includes(candidate))
    throw new Error(`Unknown candidate: ${candidate}`)
  if (['binding', 'combined'].includes(candidate))
    css = mapMetricFaces(css, (face) => {
      const weight = fontWeight(face)
      if (weight === null || weight < 600) return face
      return face.replace(/local\(([^)]+)\)/g, (source, rawName) => {
        const name = rawName.trim().replace(/^["']|["']$/g, '')
        return boldNames[name]?.map((n) => `local("${n}")`).join(',') ?? source
      })
    })
  if (['manrope-helvetica', 'combined'].includes(candidate))
    css = mapStacks(css, (tokens) => {
      const arial = tokens.findIndex((t) => familyName(t) === 'Manrope Fallback: Arial')
      const helvetica = tokens.findIndex(
        (t) => familyName(t) === 'Manrope Fallback: Helvetica Neue',
      )
      if (arial >= 0 && helvetica > arial) tokens.splice(arial, 0, ...tokens.splice(helvetica, 1))
      return tokens
    })
  return css
}
