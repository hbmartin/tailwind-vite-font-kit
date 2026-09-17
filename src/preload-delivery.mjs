import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const HTML_INPUT_RE = /\.html(?:$|[?#])/i

function inputValues(input) {
  if (typeof input === 'string') return [input]
  if (Array.isArray(input)) return input
  if (input && typeof input === 'object') return Object.values(input)
  return []
}

export function hasConventionalHtmlEntry(
  root,
  resolved,
  { isSsrBuild = false, isLibraryBuild = Boolean(resolved.build?.lib) } = {},
) {
  if (isSsrBuild || isLibraryBuild || resolved.appType === 'custom') return false
  const input = resolved.build?.rollupOptions?.input
  if (input !== undefined) {
    return inputValues(input).some(
      (value) => typeof value === 'string' && HTML_INPUT_RE.test(value),
    )
  }
  return existsSync(resolve(root, 'index.html'))
}

export function preloadHeaderEnabled(options) {
  const value = options.preloadHeader
  return (
    value === undefined ||
    value === true ||
    (value !== null && typeof value === 'object' && !Array.isArray(value))
  )
}

export function resolvePreloadDelivery(
  options,
  { preloadCount = 0, hasNitro = false, htmlEntryDetected = false, htmlTransforms = 0 } = {},
) {
  const headerConfigured = preloadHeaderEnabled(options)
  const preloadHtml = options.preloadHtml === undefined ? 'auto' : options.preloadHtml
  const headerActive = preloadCount > 0 && hasNitro && headerConfigured
  const htmlInjectionEnabled =
    preloadCount > 0 &&
    (preloadHtml === true ||
      (preloadHtml === 'auto' && !hasNitro && headerConfigured && htmlEntryDetected))
  const manualOptOut =
    preloadCount > 0 &&
    !headerActive &&
    !htmlInjectionEnabled &&
    (options.preloadHeader === false || preloadHtml === false)

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

export const decodeHtmlHref = (href) => href.replace(/&(?:amp|#0*38|#x0*26);/gi, '&')

const SPACE_RE = /\s/

function parseAttributes(html, tagStart, tagEnd) {
  const attributes = new Map()
  let index = tagStart + 5 // immediately after `<link`
  const contentEnd = tagEnd - 1 // the closing `>`
  while (index < contentEnd) {
    while (index < contentEnd && SPACE_RE.test(html[index])) index++
    if (index >= contentEnd || html[index] === '>') break
    if (html[index] === '/') {
      index++
      continue
    }

    const start = index
    while (index < contentEnd && !SPACE_RE.test(html[index]) && !/[=/>]/.test(html[index])) {
      index++
    }
    if (index === start) {
      index++
      continue
    }
    const name = html.slice(start, index).toLowerCase()
    while (index < contentEnd && SPACE_RE.test(html[index])) index++

    let value
    if (html[index] === '=') {
      index++
      while (index < contentEnd && SPACE_RE.test(html[index])) index++
      const quote = html[index] === '"' || html[index] === "'" ? html[index++] : null
      const valueStart = index
      if (quote) {
        while (index < contentEnd && html[index] !== quote) index++
        value = html.slice(valueStart, index)
        if (html[index] === quote) index++
      } else {
        while (index < contentEnd && !SPACE_RE.test(html[index]) && html[index] !== '>') index++
        value = html.slice(valueStart, index)
      }
    }

    // Browsers retain the first duplicate HTML attribute and ignore later copies.
    if (!attributes.has(name)) attributes.set(name, { name, value, start, end: index })
  }
  return attributes
}

/**
 * Parse link tags without mistaking attribute-shaped quoted text for real attributes.
 * Attribute source ranges are absolute offsets into `html` so callers can repair a tag
 * without serialising or otherwise changing unrelated markup.
 */
export function parseHtmlLinks(html) {
  const links = []
  const starts = /<link(?=[\s/>])/gi
  let match
  while ((match = starts.exec(html))) {
    const start = match.index
    let index = start + match[0].length
    let quote = null
    while (index < html.length) {
      const char = html[index]
      if (quote) {
        if (char === quote) quote = null
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === '>') {
        index++
        break
      }
      index++
    }
    if (index > html.length || html[index - 1] !== '>') continue
    starts.lastIndex = index
    links.push({
      raw: html.slice(start, index),
      start,
      end: index,
      attributes: parseAttributes(html, start, index),
    })
  }
  return links
}

const attributeValue = (link, name) => link.attributes.get(name)?.value
const relTokens = (link) => attributeValue(link, 'rel')?.toLowerCase().split(/\s+/) ?? []

function crossoriginEdit(html, link) {
  const current = link.attributes.get('crossorigin')
  if (current) return { start: current.start, end: current.end, text: 'crossorigin="anonymous"' }

  let at = link.end - 1
  let before = at - 1
  while (before >= link.start && SPACE_RE.test(html[before])) before--
  if (html[before] === '/') at = before
  return { start: at, end: at, text: ' crossorigin="anonymous"' }
}

export function normalizeHtmlFontPreloads(html, preloads) {
  const wanted = new Map(preloads.map((preload) => [preload.href, preload]))
  const present = new Set()
  const edits = []
  for (const link of parseHtmlLinks(html)) {
    const as = attributeValue(link, 'as')?.toLowerCase()
    const href = attributeValue(link, 'href')
    if (!relTokens(link).includes('preload') || as !== 'font' || !href) continue
    const decoded = decodeHtmlHref(href)
    if (!wanted.has(decoded)) continue

    const crossorigin = link.attributes.get('crossorigin')
    const value = crossorigin?.value?.toLowerCase()
    const compatible =
      crossorigin !== undefined && (value === undefined || value === '' || value === 'anonymous')
    present.add(decoded)
    if (!compatible) edits.push(crossoriginEdit(html, link))
  }

  let normalizedHtml = html
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    normalizedHtml =
      normalizedHtml.slice(0, edit.start) + edit.text + normalizedHtml.slice(edit.end)
  }
  return { html: normalizedHtml, present, changed: edits.length > 0 }
}
