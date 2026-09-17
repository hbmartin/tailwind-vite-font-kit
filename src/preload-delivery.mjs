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

function parseLink(html, tagStart) {
  const attributes = new Map()
  let index = tagStart + 5 // immediately after `<link`
  while (index < html.length) {
    while (index < html.length && SPACE_RE.test(html[index])) index++
    if (index >= html.length) return null
    if (html[index] === '>') {
      const end = index + 1
      return { raw: html.slice(tagStart, end), start: tagStart, end, attributes }
    }
    if (html[index] === '/') {
      index++
      continue
    }

    const start = index
    while (index < html.length && !SPACE_RE.test(html[index]) && !/[=/>]/.test(html[index])) {
      index++
    }
    if (index === start) {
      index++
      continue
    }
    const name = html.slice(start, index).toLowerCase()
    while (index < html.length && SPACE_RE.test(html[index])) index++

    let value
    if (html[index] === '=') {
      index++
      while (index < html.length && SPACE_RE.test(html[index])) index++
      const quote = html[index] === '"' || html[index] === "'" ? html[index++] : null
      const valueStart = index
      if (quote) {
        while (index < html.length && html[index] !== quote) index++
        // Without a closing quote the browser never reaches a `>` in the tag state.
        // Stop the whole scan: later `<link` text is part of this attribute, not another
        // tag, and rescanning every occurrence would make malformed input quadratic.
        if (index >= html.length) return null
        value = html.slice(valueStart, index)
        index++
      } else {
        // Quotes inside an unquoted value are parse errors in HTML, but browsers retain
        // them as ordinary value characters. Treating one as a delimiter can consume the
        // rest of the document and move a repair onto an unrelated closing tag.
        while (index < html.length && !SPACE_RE.test(html[index]) && html[index] !== '>') index++
        value = html.slice(valueStart, index)
      }
    }

    // Browsers retain the first duplicate HTML attribute and ignore later copies.
    if (!attributes.has(name)) attributes.set(name, { name, value, start, end: index })
  }
  return null
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
    const link = parseLink(html, match.index)
    if (!link) break
    starts.lastIndex = link.end
    links.push(link)
  }
  return links
}

export const htmlLinkAttribute = (link, name) => link.attributes.get(name)?.value
export const htmlLinkRelTokens = (link) =>
  htmlLinkAttribute(link, 'rel')?.toLowerCase().split(/\s+/) ?? []

export const isHtmlFontPreload = (link) =>
  htmlLinkRelTokens(link).includes('preload') &&
  htmlLinkAttribute(link, 'as')?.toLowerCase() === 'font'

export function hasAnonymousCrossorigin(link) {
  const crossorigin = link.attributes.get('crossorigin')
  const value = crossorigin?.value?.toLowerCase()
  return crossorigin !== undefined && (value === undefined || value === '' || value === 'anonymous')
}

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
    const href = htmlLinkAttribute(link, 'href')
    if (!isHtmlFontPreload(link) || !href) continue
    const decoded = decodeHtmlHref(href)
    if (!wanted.has(decoded)) continue

    present.add(decoded)
    if (!hasAnonymousCrossorigin(link)) edits.push(crossoriginEdit(html, link))
  }

  let normalizedHtml = html
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    normalizedHtml =
      normalizedHtml.slice(0, edit.start) + edit.text + normalizedHtml.slice(edit.end)
  }
  return { html: normalizedHtml, present, changed: edits.length > 0 }
}
