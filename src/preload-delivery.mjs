import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const HTML_INPUT_RE = /\.html(?:$|[?#])/i

function inputValues(input) {
  if (typeof input === 'string') return [input]
  if (Array.isArray(input)) return input
  if (input && typeof input === 'object') return Object.values(input)
  return []
}

export function hasConventionalHtmlEntry(root, resolved, { isSsrBuild = false } = {}) {
  if (isSsrBuild || resolved.appType === 'custom') return false
  const input = resolved.build?.rollupOptions?.input
  if (input !== undefined) {
    return inputValues(input).some(
      (value) => typeof value === 'string' && HTML_INPUT_RE.test(value),
    )
  }
  return existsSync(resolve(root, 'index.html'))
}

export function resolvePreloadDelivery(
  options,
  { preloadCount = 0, hasNitro = false, htmlEntryDetected = false, htmlTransforms = 0 } = {},
) {
  const headerConfigured = options.preloadHeader !== false
  const headerActive = preloadCount > 0 && hasNitro && headerConfigured
  const htmlInjectionEnabled =
    preloadCount > 0 &&
    (options.preloadHtml === true ||
      (options.preloadHtml === 'auto' && !hasNitro && headerConfigured && htmlEntryDetected))
  const manualOptOut =
    preloadCount > 0 &&
    !headerActive &&
    !htmlInjectionEnabled &&
    (options.preloadHeader === false || options.preloadHtml === false)

  return {
    preloadCount,
    hasNitro,
    headerActive,
    htmlInjectionEnabled,
    htmlEntryDetected,
    manualOptOut,
    htmlTransforms,
  }
}

const decodeHref = (href) => href.replace(/&(?:amp|#0*38|#x0*26);/gi, '&')

function attribute(tag, name) {
  const match = new RegExp(
    `(?:^|\\s)${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+)))?`,
    'i',
  ).exec(tag)
  if (!match) return { present: false, value: undefined }
  return { present: true, value: match[1] ?? match[2] ?? match[3] }
}

function repairCrossorigin(tag) {
  const current = attribute(tag, 'crossorigin')
  if (current.present) {
    return tag.replace(
      /\scrossorigin(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>]+))?/i,
      ' crossorigin="anonymous"',
    )
  }
  return tag.replace(/\s*(\/?>)$/, ' crossorigin="anonymous"$1')
}

export function normalizeHtmlFontPreloads(html, preloads) {
  const wanted = new Map(preloads.map((preload) => [preload.href, preload]))
  const present = new Set()
  let changed = false
  const normalizedHtml = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = attribute(tag, 'rel').value?.toLowerCase().split(/\s+/) ?? []
    const as = attribute(tag, 'as').value?.toLowerCase()
    const href = attribute(tag, 'href').value
    if (!rel.includes('preload') || as !== 'font' || !href) return tag
    const decoded = decodeHref(href)
    if (!wanted.has(decoded)) return tag

    const crossorigin = attribute(tag, 'crossorigin')
    const value = crossorigin.value?.toLowerCase()
    const compatible =
      crossorigin.present && (value === undefined || value === '' || value === 'anonymous')
    present.add(decoded)
    if (compatible) return tag
    changed = true
    return repairCrossorigin(tag)
  })
  return { html: normalizedHtml, present, changed }
}
