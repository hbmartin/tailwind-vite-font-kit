import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { escapeRegExp } from './string.mjs'

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

const ASCII_WHITESPACE_RE = /[\t\n\f\r ]/
const RAW_TEXT_ELEMENTS = new Set([
  'script',
  'style',
  'title',
  'textarea',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
])

const asciiLower = (value) =>
  value.replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 32))

function parseStartTag(html, tagStart, nameEnd, name) {
  const attributes = new Map()
  let index = nameEnd
  while (index < html.length) {
    while (index < html.length && ASCII_WHITESPACE_RE.test(html[index])) index++
    if (index >= html.length) return null
    if (html[index] === '>') {
      const end = index + 1
      return { name, raw: html.slice(tagStart, end), start: tagStart, end, attributes }
    }
    if (html[index] === '/') {
      index++
      continue
    }

    const start = index
    while (
      index < html.length &&
      !ASCII_WHITESPACE_RE.test(html[index]) &&
      !/[=/>]/.test(html[index])
    ) {
      index++
    }
    if (index === start) {
      index++
      continue
    }
    const attributeName = asciiLower(html.slice(start, index))
    let attributeEnd = index
    while (index < html.length && ASCII_WHITESPACE_RE.test(html[index])) index++

    let value
    if (html[index] === '=') {
      index++
      while (index < html.length && ASCII_WHITESPACE_RE.test(html[index])) index++
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
        while (
          index < html.length &&
          !ASCII_WHITESPACE_RE.test(html[index]) &&
          html[index] !== '>'
        ) {
          index++
        }
        value = html.slice(valueStart, index)
      }
      attributeEnd = index
    }

    // Browsers retain the first duplicate HTML attribute and ignore later copies.
    if (!attributes.has(attributeName)) {
      attributes.set(attributeName, {
        name: attributeName,
        value,
        start,
        end: attributeEnd,
      })
    }
  }
  return null
}

function commentEnd(html, start) {
  // Abrupt empty-comment forms have dedicated tokenizer transitions.
  if (html[start + 4] === '>') return start + 5
  if (html[start + 4] === '-' && html[start + 5] === '>') return start + 6

  let index = start + 4
  while ((index = html.indexOf('--', index)) !== -1) {
    if (html[index + 2] === '>') return index + 3
    if (html[index + 2] === '!' && html[index + 3] === '>') return index + 4
    index += 2
  }
  return -1
}

function declarationEnd(html, start) {
  let quote = null
  for (let index = start; index < html.length; index++) {
    if (quote) {
      if (html[index] === quote) quote = null
    } else if (html[index] === '"' || html[index] === "'") {
      quote = html[index]
    } else if (html[index] === '>') {
      return index + 1
    }
  }
  return -1
}

/**
 * Scan the HTML once without mistaking quoted tag-shaped text, comments, or raw-text
 * contents for live elements. Source ranges are absolute offsets into `html` so callers
 * can repair a tag without serialising or otherwise changing unrelated markup.
 */
export function scanHtml(html) {
  const links = []
  const styles = []
  const noscripts = []
  let index = 0
  let templateDepth = 0
  while ((index = html.indexOf('<', index)) !== -1) {
    if (html.startsWith('<!--', index)) {
      const end = commentEnd(html, index)
      if (end === -1) break
      index = end
      continue
    }

    // Processing instructions and unknown declarations become bogus comments in HTML and
    // consume their contents through the first `>`. DOCTYPE is the one declaration whose
    // quoted identifiers need their delimiters preserved.
    if (html[index + 1] === '?' || html[index + 1] === '!') {
      const isDoctype =
        asciiLower(html.slice(index + 2, index + 9)) === 'doctype' &&
        (ASCII_WHITESPACE_RE.test(html[index + 9] ?? '') || html[index + 9] === '>')
      const end = isDoctype ? declarationEnd(html, index + 2) : html.indexOf('>', index + 2) + 1
      if (end <= 0) break
      index = end
      continue
    }

    if (html[index + 1] === '/') {
      if (!/[A-Za-z]/.test(html[index + 2] ?? '')) {
        index++
        continue
      }
      let nameEnd = index + 3
      while (
        nameEnd < html.length &&
        !ASCII_WHITESPACE_RE.test(html[nameEnd]) &&
        html[nameEnd] !== '/' &&
        html[nameEnd] !== '>'
      ) {
        nameEnd++
      }
      const name = asciiLower(html.slice(index + 2, nameEnd))
      const tag = parseStartTag(html, index, nameEnd, name)
      if (!tag) break
      if (name === 'template' && templateDepth > 0) templateDepth--
      index = tag.end
      continue
    }

    // HTML's tag-open state requires an ASCII letter. Once in the tag-name state, `_`,
    // `.`, and non-ASCII characters are retained until a real tag-name delimiter.
    if (!/[A-Za-z]/.test(html[index + 1] ?? '')) {
      index++
      continue
    }
    let nameEnd = index + 2
    while (
      nameEnd < html.length &&
      !ASCII_WHITESPACE_RE.test(html[nameEnd]) &&
      html[nameEnd] !== '/' &&
      html[nameEnd] !== '>'
    ) {
      nameEnd++
    }
    const name = asciiLower(html.slice(index + 1, nameEnd))
    const tag = parseStartTag(html, index, nameEnd, name)
    // A genuinely unclosed quote in live markup keeps the browser in the tag's
    // attribute-value state, so later tag-shaped text is not another element.
    if (!tag) break
    if (name === 'link' && templateDepth === 0) links.push(tag)

    if (name === 'template') {
      templateDepth++
      index = tag.end
      continue
    }
    if (name === 'plaintext') break

    if (RAW_TEXT_ELEMENTS.has(name)) {
      // Search the original source. Case-folding a copy can change its length (`İ` is the
      // smallest counterexample) and makes every later source position unsafe.
      const closing = new RegExp(`</${escapeRegExp(name)}(?=[\\t\\n\\f\\r />])`, 'gi')
      closing.lastIndex = tag.end
      const match = closing.exec(html)
      if (!match) {
        const record = { text: html.slice(tag.end), start: tag.end, end: html.length }
        if (name === 'style' && templateDepth === 0) styles.push(record)
        if (name === 'noscript' && templateDepth === 0) noscripts.push(record)
        break
      }
      const record = { text: html.slice(tag.end, match.index), start: tag.end, end: match.index }
      if (name === 'style' && templateDepth === 0) styles.push(record)
      if (name === 'noscript' && templateDepth === 0) noscripts.push(record)
      const closingTag = parseStartTag(html, match.index, match.index + 2 + name.length, name)
      if (!closingTag) break
      index = closingTag.end
    } else {
      index = tag.end
    }
  }
  return { links, styles, noscripts }
}

export const parseHtmlLinks = (html) => scanHtml(html).links

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

const relationTokens = (value) =>
  value
    ?.toLowerCase()
    .split(/[\t\n\f\r ]+/)
    .filter(Boolean) ?? []
const isFontPreload = (rel, as) => relationTokens(rel).includes('preload') && as === 'font'
const hasAnonymousValue = (values) => {
  const crossorigin = values.get('crossorigin')
  return crossorigin !== undefined && crossorigin.value?.toLowerCase() !== 'use-credentials'
}

export const headerLinkParameter = (link, name) => link.parameters.get(name)?.value
export const headerLinkRelTokens = (link) => relationTokens(headerLinkParameter(link, 'rel'))

export const isHeaderFontPreload = (link) =>
  isFontPreload(headerLinkParameter(link, 'rel'), headerLinkParameter(link, 'as')?.toLowerCase())

export const hasAnonymousHeaderCrossorigin = (link) => hasAnonymousValue(link.parameters)

export const htmlLinkAttribute = (link, name) => link.attributes.get(name)?.value
export const htmlLinkRelTokens = (link) => relationTokens(htmlLinkAttribute(link, 'rel'))

export const isHtmlFontPreload = (link) =>
  isFontPreload(htmlLinkAttribute(link, 'rel'), htmlLinkAttribute(link, 'as')?.toLowerCase())

export const hasAnonymousCrossorigin = (link) => hasAnonymousValue(link.attributes)

function crossoriginEdit(html, link) {
  const current = link.attributes.get('crossorigin')
  if (current) return { start: current.start, end: current.end, text: 'crossorigin="anonymous"' }

  let at = link.end - 1
  let before = at - 1
  while (before >= link.start && ASCII_WHITESPACE_RE.test(html[before])) before--
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
