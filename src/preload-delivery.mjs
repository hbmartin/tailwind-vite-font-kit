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
const RAW_TEXT_ELEMENTS = new Set([
  'script',
  'style',
  'title',
  'textarea',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
])

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
  const lower = html.toLowerCase()
  let index = 0
  while ((index = html.indexOf('<', index)) !== -1) {
    if (html.startsWith('<!--', index)) {
      const end = html.indexOf('-->', index + 4)
      if (end === -1) break
      index = end + 3
      continue
    }

    const nameMatch = /^<([a-z][a-z0-9:-]*)(?=[\s/>])/i.exec(html.slice(index))
    if (!nameMatch) {
      index++
      continue
    }
    const name = nameMatch[1].toLowerCase()
    if (name === 'link') {
      const link = parseLink(html, index)
      // A genuinely unclosed quote in live markup keeps the browser in the tag's
      // attribute-value state, so later link-shaped text is not another element.
      if (!link) break
      links.push(link)
      index = link.end
      continue
    }

    let quote = null
    let tagEnd = -1
    for (let cursor = index + nameMatch[0].length; cursor < html.length; cursor++) {
      const char = html[cursor]
      if (quote) {
        if (char === quote) quote = null
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === '>') {
        tagEnd = cursor + 1
        break
      }
    }
    if (tagEnd === -1) break

    if (RAW_TEXT_ELEMENTS.has(name)) {
      const closing = new RegExp(`</${name}(?=[\\s/>])`, 'g')
      closing.lastIndex = tagEnd
      const match = closing.exec(lower)
      if (!match) break
      const closingEnd = html.indexOf('>', match.index + match[0].length)
      if (closingEnd === -1) break
      index = closingEnd + 1
    } else {
      index = tagEnd
    }
  }
  return links
}

const HTTP_TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+/
const HTTP_PARAMETER_VALUE_RE = /^[!#$%&'()*+\-./:<=>?@[\]^_`{|}~0-9A-Za-z]+/

function parseHeaderLink(rawValue) {
  const raw = rawValue.trim()
  if (!raw.startsWith('<')) return null
  const targetEnd = raw.indexOf('>', 1)
  if (targetEnd === -1) return null

  const parameters = new Map()
  let index = targetEnd + 1
  while (index < raw.length) {
    while (index < raw.length && /[\t ]/.test(raw[index])) index++
    if (index >= raw.length) break
    if (raw[index] !== ';') return null
    index++
    while (index < raw.length && /[\t ]/.test(raw[index])) index++

    const nameMatch = HTTP_TOKEN_RE.exec(raw.slice(index))
    if (!nameMatch) return null
    const name = nameMatch[0].toLowerCase()
    index += nameMatch[0].length
    while (index < raw.length && /[\t ]/.test(raw[index])) index++

    let value
    if (raw[index] === '=') {
      index++
      while (index < raw.length && /[\t ]/.test(raw[index])) index++
      if (raw[index] === '"') {
        index++
        let parsed = ''
        let closed = false
        while (index < raw.length) {
          const char = raw[index++]
          if (char === '\\') {
            if (index >= raw.length) return null
            parsed += raw[index++]
          } else if (char === '"') {
            closed = true
            break
          } else {
            parsed += char
          }
        }
        if (!closed) return null
        value = parsed
      } else {
        const valueMatch = HTTP_PARAMETER_VALUE_RE.exec(raw.slice(index))
        if (!valueMatch) return null
        value = valueMatch[0]
        index += valueMatch[0].length
      }
      while (index < raw.length && /[\t ]/.test(raw[index])) index++
      if (index < raw.length && raw[index] !== ';') return null
    }

    if (!parameters.has(name)) parameters.set(name, { name, value })
  }

  return { raw, target: raw.slice(1, targetEnd), parameters }
}

/**
 * Parse an HTTP Link field without treating commas inside URI references or quoted
 * parameter values as entry separators. Malformed entries are omitted.
 */
export function parseLinkHeader(value) {
  if (typeof value !== 'string') return []
  const entries = []
  let start = 0
  let quote = false
  let escaped = false
  let inTarget = false
  for (let index = 0; index <= value.length; index++) {
    const char = value[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quote = false
      continue
    }
    if (char === '"') quote = true
    else if (char === '<') inTarget = true
    else if (char === '>') inTarget = false
    else if ((char === ',' && !inTarget) || index === value.length) {
      const entry = parseHeaderLink(value.slice(start, index))
      if (entry) entries.push(entry)
      start = index + 1
    }
  }
  return entries
}

export const headerLinkParameter = (link, name) => link.parameters.get(name)?.value
export const headerLinkRelTokens = (link) =>
  headerLinkParameter(link, 'rel')?.toLowerCase().split(/\s+/).filter(Boolean) ?? []

export const isHeaderFontPreload = (link) =>
  headerLinkRelTokens(link).includes('preload') &&
  headerLinkParameter(link, 'as')?.toLowerCase() === 'font'

export function hasAnonymousHeaderCrossorigin(link) {
  const crossorigin = link.parameters.get('crossorigin')
  return crossorigin !== undefined && crossorigin.value?.toLowerCase() !== 'use-credentials'
}

export const htmlLinkAttribute = (link, name) => link.attributes.get(name)?.value
export const htmlLinkRelTokens = (link) =>
  htmlLinkAttribute(link, 'rel')?.toLowerCase().split(/\s+/) ?? []

export const isHtmlFontPreload = (link) =>
  htmlLinkRelTokens(link).includes('preload') &&
  htmlLinkAttribute(link, 'as')?.toLowerCase() === 'font'

export function hasAnonymousCrossorigin(link) {
  const crossorigin = link.attributes.get('crossorigin')
  return crossorigin !== undefined && crossorigin.value?.toLowerCase() !== 'use-credentials'
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
