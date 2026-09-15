// Shared handling for generated and minified metric CSS. Keep untouched CSS byte-for-byte.
import postcss from 'postcss'

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

// CSS family lists can contain quoted commas, escapes, functions, and comments.
function splitOutside(value, separator) {
  const parts = []
  let quote = '',
    depth = 0,
    comment = false,
    start = 0
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (comment) {
      if (char === '*' && value[i + 1] === '/') {
        comment = false
        i++
      }
      continue
    }
    if (char === '\\') {
      i++
      continue
    }
    if (quote) {
      if (char === quote) quote = ''
      continue
    }
    if (char === '/' && value[i + 1] === '*') {
      comment = true
      i++
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '(') {
      depth++
      continue
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (!depth && separator(char)) {
      parts.push({ text: value.slice(start, i), start })
      start = i + 1
    }
  }
  parts.push({ text: value.slice(start), start })
  return parts
}

const families = (value) => splitOutside(value, (char) => char === ',').map((part) => part.text)
const fallbackBase = (token) => {
  const name = familyName(token)
  const at = name.indexOf(' Fallback: ')
  return at < 0 ? null : name.slice(at + ' Fallback: '.length)
}
function withoutFallbacks(tokens) {
  const kept = tokens.filter((token) => fallbackBase(token) === null)
  if (kept.length) return kept
  // A fallback-only list must remain a valid font stack after stripping metrics.
  return [JSON.stringify(fallbackBase(tokens[0]))]
}
function changeValue(decl, transform, value = decl.value, prefix = '') {
  const before = families(value)
  const after = transform([...before])
  if (before.length === after.length && before.every((token, i) => token === after[i])) return false
  decl.value = prefix + after.join(',')
  return true
}

export function mapStacks(css, transform) {
  const root = postcss.parse(css)
  let changed = false
  root.walkDecls((decl) => {
    if (/^--[\w-]+$/.test(decl.prop) || decl.prop.toLowerCase() === 'font-family')
      changed = changeValue(decl, transform) || changed
  })
  return changed ? root.toString() : css
}

const sizeToken =
  /^(?:\d*\.?\d+(?:px|em|rem|pt|%|vw|vh)|xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger|(?:calc|clamp)\(.+\))(?:\/.*)?$/i
function fontFamilyStart(value) {
  const words = splitOutside(value, (char) => /\s/.test(char)).filter((part) => part.text.length)
  const size = words.findIndex((part) => sizeToken.test(part.text))
  if (size < 0) return null
  let next = size + 1
  const sizeText = words[size].text
  if (sizeText.endsWith('/'))
    next++ // font-size / line-height
  else if (words[next]?.text === '/') next += 2
  else if (words[next]?.text.startsWith('/')) next++
  return words[next]?.start ?? null
}

export function stripFallbacks(css) {
  const root = postcss.parse(css)
  let changed = false
  root.walkAtRules('font-face', (rule) => {
    if (
      rule.nodes?.some((node) => node.type === 'decl' && node.prop.toLowerCase() === 'size-adjust')
    ) {
      rule.remove()
      changed = true
    }
  })
  root.walkDecls((decl) => {
    const prop = decl.prop.toLowerCase()
    if (/^--[\w-]+$/.test(decl.prop) || prop === 'font-family')
      changed = changeValue(decl, withoutFallbacks) || changed
    else if (
      prop === 'font' &&
      families(decl.value).some((token) => familyName(token).includes(' Fallback: '))
    ) {
      const start = fontFamilyStart(decl.value)
      if (start === null) throw new Error(`Cannot safely parse font shorthand: ${decl.value}`)
      changed =
        changeValue(decl, withoutFallbacks, decl.value.slice(start), decl.value.slice(0, start)) ||
        changed
    }
  })
  return changed ? root.toString() : css
}

export function fontWeight(face) {
  const value = /font-weight\s*:\s*([^;}]+)/i.exec(face)?.[1].trim().toLowerCase() ?? 'normal'
  if (value === 'normal') return 400
  if (value === 'bold') return 700
  return /^\d+$/.test(value) ? Number(value) : null // Do not guess across variable weight ranges.
}
