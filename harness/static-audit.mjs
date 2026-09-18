// Follow the served HTML -> stylesheets -> @import chain in Node so cross-origin CSS can
// be inspected without the browser's stylesheet access restrictions.
import {
  decodeHtmlHref,
  htmlLinkAttribute,
  htmlLinkRelTokens,
  isHeaderFontPreload,
  isHtmlFontPreload,
  parseLinkHeader,
  scanHtml,
} from '../src/preload-delivery.mjs'

const HANDLER_CHARACTER_REFERENCES = new Map([
  ['quot', '"'],
  ['apos', "'"],
  ['period', '.'],
  ['equals', '='],
  ['lpar', '('],
  ['rpar', ')'],
  ['comma', ','],
  ['Tab', '\t'],
  ['NewLine', '\n'],
  ['nbsp', '\u00a0'],
])

function decodeHandlerAttribute(value) {
  return value.replace(
    /&#(?:[xX]([0-9A-Fa-f]+)|([0-9]+));?|&([A-Za-z][A-Za-z0-9]+);/g,
    (raw, hex, decimal, named) => {
      if (named) return HANDLER_CHARACTER_REFERENCES.get(named) ?? raw
      const codePoint = Number.parseInt(hex ?? decimal, hex ? 16 : 10)
      if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        return '\ufffd'
      }
      return String.fromCodePoint(codePoint)
    },
  )
}

export function emptyStaticAudit(error) {
  const suppliedReason =
    typeof error?.message === 'string'
      ? error.message.trim()
      : typeof error === 'string'
        ? error.trim()
        : ''
  const unavailableReason = suppliedReason || 'the static audit failed for an unknown reason'
  return {
    stylesheetHrefs: [],
    inlineStyleTags: 0,
    totalFontFaceBlocks: 0,
    facesWithSizeAdjust: 0,
    facesWithAscentOverride: 0,
    facesWithLocalSrc: 0,
    supportsGuards: 0,
    fontFamiliesDeclared: [],
    sampleFallbackFace: null,
    headPreloadFontLinks: [],
    navigationLinkHeader: '',
    headerPreloadFontLinks: [],
    sampleFontResponse: null,
    unavailableReason,
    errors: [],
  }
}

export async function staticAudit(url, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url)
  const html = await response.text()
  const documentUrl = response.url || url
  const navigationLinkHeader = response.headers.get('link') || ''
  const headerLinks = parseLinkHeader(navigationLinkHeader)
  const headerFontPreloads = headerLinks.filter(isHeaderFontPreload)
  const rawHeaderPreloadFontLinks = headerFontPreloads.map((link) => link.raw)
  const headerPreloadFontLinks = [...rawHeaderPreloadFontLinks]
  const { links: htmlLinks, styles: inlineStyleRecords } = scanHtml(html)
  const htmlFontPreloads = htmlLinks.filter(isHtmlFontPreload)
  const stylesheetHref = (link) => {
    const relations = htmlLinkRelTokens(link)
    const as = htmlLinkAttribute(link, 'as')?.toLowerCase()
    const onload = decodeHandlerAttribute(htmlLinkAttribute(link, 'onload') ?? '')
    const promotesPreload =
      /\bthis\s*\.\s*rel\s*=\s*(['"])stylesheet\1/i.test(onload) ||
      /\bthis\s*\.\s*setAttribute\s*\(\s*(['"])rel\1\s*,\s*(['"])stylesheet\2\s*\)/i.test(onload)
    if (
      !relations.includes('stylesheet') &&
      !(relations.includes('preload') && as === 'style' && promotesPreload)
    ) {
      return null
    }
    const href = htmlLinkAttribute(link, 'href')
    return href ? decodeHtmlHref(href) : null
  }
  const hrefs = [
    ...new Set(
      htmlLinks
        .filter((link) => !link.inShadowRoot)
        .map((link) => stylesheetHref(link))
        .filter((href) => typeof href === 'string'),
    ),
  ]
  const inlineStyles = inlineStyleRecords
    .filter((style) => !style.inShadowRoot)
    .map((style) => style.text)
  const rawHeadPreloadFontLinks = htmlFontPreloads.map((link) => link.raw)
  const headPreloadFontLinks = [...rawHeadPreloadFontLinks]
  const auditErrors = []
  const seen = new Set()
  const stylesheets = inlineStyles.map((text) => ({ text, url: documentUrl }))

  async function pull(href, baseUrl, depth = 0) {
    if (depth > 3) return
    let absolute
    try {
      absolute = new URL(href, baseUrl).href
    } catch {
      return
    }
    if (seen.has(absolute)) return
    seen.add(absolute)
    try {
      const cssResponse = await fetchImpl(absolute, {
        headers: {
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        },
      })
      const text = await cssResponse.text()
      const stylesheetUrl = cssResponse.url || absolute
      stylesheets.push({ text, url: stylesheetUrl })
      for (const match of text.matchAll(/@import\s+(?:url\()?["']?([^"')]+)["']?\)?/g)) {
        await pull(match[1], stylesheetUrl, depth + 1)
      }
    } catch {
      // A missing optional stylesheet is represented by the audit data it leaves absent.
    }
  }

  for (const href of hrefs) await pull(href, documentUrl)
  const all = stylesheets.map((sheet) => sheet.text).join('\n')
  const faceRecords = stylesheets.flatMap((sheet) =>
    [...sheet.text.matchAll(/@font-face\s*\{[^}]*\}/g)].map((match) => ({
      block: match[0],
      stylesheetUrl: sheet.url,
    })),
  )
  const faceBlocks = faceRecords.map((face) => face.block)
  const preloadUrls = new Set()
  for (const link of headerFontPreloads) {
    const href = link.target
    if (href) {
      try {
        preloadUrls.add(new URL(href, documentUrl).href)
      } catch (error) {
        auditErrors.push(
          `invalid Link-header preload href ${JSON.stringify(href)}: ${error.message}`,
        )
      }
    }
  }
  for (const link of htmlFontPreloads) {
    const href = htmlLinkAttribute(link, 'href')
    if (href) {
      try {
        preloadUrls.add(new URL(decodeHtmlHref(href), documentUrl).href)
      } catch (error) {
        auditErrors.push(`invalid HTML preload href ${JSON.stringify(href)}: ${error.message}`)
      }
    }
  }
  const sampleFontHref = faceRecords
    .map(({ block, stylesheetUrl }) => {
      const href = /src:[^;}]*url\(([^)]+)\)/.exec(block)?.[1]?.replace(/^['"]|['"]$/g, '')
      if (!href || href.startsWith('local(')) return null
      try {
        return new URL(href, stylesheetUrl).href
      } catch {
        return null
      }
    })
    .find((href) => href && preloadUrls.has(href))
  let sampleFontResponse = null
  if (sampleFontHref) {
    try {
      const fontResponse = await fetchImpl(sampleFontHref)
      await fontResponse.arrayBuffer()
      sampleFontResponse = {
        url: sampleFontHref,
        status: fontResponse.status,
        cacheControl: fontResponse.headers.get('cache-control') || '',
        cors: fontResponse.headers.get('access-control-allow-origin') || '',
        link: fontResponse.headers.get('link') || '',
      }
    } catch (error) {
      sampleFontResponse = { url: sampleFontHref, error: error.message }
    }
  }
  return {
    stylesheetHrefs: hrefs,
    inlineStyleTags: inlineStyles.length,
    totalFontFaceBlocks: faceBlocks.length,
    facesWithSizeAdjust: faceBlocks.filter((block) => /size-adjust/.test(block)).length,
    facesWithAscentOverride: faceBlocks.filter((block) => /ascent-override/.test(block)).length,
    facesWithLocalSrc: faceBlocks.filter((block) => /local\(/.test(block)).length,
    supportsGuards: (all.match(/@supports\s*\([^)]*ascent-override/g) || []).length,
    fontFamiliesDeclared: [
      ...new Set(
        faceBlocks
          .map((block) =>
            (block.match(/font-family:\s*([^;]+)/) || [])[1]?.replace(/["']/g, '').trim(),
          )
          .filter(Boolean),
      ),
    ],
    sampleFallbackFace:
      faceBlocks
        .find((block) => /size-adjust/.test(block))
        ?.replace(/\s+/g, ' ')
        .slice(0, 400) || null,
    headPreloadFontLinks,
    navigationLinkHeader: navigationLinkHeader.slice(0, 2000),
    headerPreloadFontLinks,
    sampleFontResponse,
    errors: auditErrors,
  }
}
