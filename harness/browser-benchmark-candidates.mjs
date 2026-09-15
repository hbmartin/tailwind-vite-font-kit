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
    css = css.replace(/@font-face\s*\{[^{}]*size-adjust\s*:[^{}]*\}/g, (face) => {
      if (Number(/font-weight:\s*(\d+)/.exec(face)?.[1]) < 600) return face
      return face.replace(/local\(([^)]+)\)/g, (source, rawName) => {
        const name = rawName.trim().replace(/^["']|["']$/g, '')
        return boldNames[name]?.map((n) => `local("${n}")`).join(',') ?? source
      })
    })
  if (['manrope-helvetica', 'combined'].includes(candidate))
    css = css.replace(
      /(["']Manrope Fallback: Arial["'])\s*,\s*(["']Manrope Fallback: Helvetica Neue["'])/g,
      '$2,$1',
    )
  return css
}
