// Follow the served HTML -> stylesheets -> @import chain in Node so cross-origin CSS can
// be inspected without the browser's stylesheet access restrictions.
const decodeHtmlHref = (href) => href.replace(/&(?:amp|#0*38|#x0*26);/gi, '&')

export async function staticAudit(url, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url)
  const html = await response.text()
  const documentUrl = response.url || url
  const navigationLinkHeader = response.headers.get('link') || ''
  const rawHeaderPreloadFontLinks = navigationLinkHeader
    .split(/,(?=\s*<)/)
    .filter((link) => /\brel\s*=\s*["']?preload/i.test(link) && /\bas\s*=\s*["']?font/i.test(link))
    .map((link) => link.trim())
  const headerPreloadFontLinks = rawHeaderPreloadFontLinks.map((link) => link.slice(0, 300))
  const hrefs = [
    ...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/g),
  ].map((match) => match[1])
  const inlineStyles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(
    (match) => match[1],
  )
  const rawHeadPreloadFontLinks = [...html.matchAll(/<link[^>]+rel=["']preload["'][^>]*>/g)]
    .filter((match) => /as=["']font/.test(match[0]))
    .map((match) => match[0])
  const headPreloadFontLinks = rawHeadPreloadFontLinks.map((tag) => tag.slice(0, 200))
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
  for (const link of rawHeaderPreloadFontLinks) {
    const href = /<([^>]+)>/.exec(link)?.[1]
    if (href) preloadUrls.add(new URL(href, documentUrl).href)
  }
  for (const tag of rawHeadPreloadFontLinks) {
    const href = /\bhref=["']([^"']+)["']/i.exec(tag)?.[1]
    if (href) preloadUrls.add(new URL(decodeHtmlHref(href), documentUrl).href)
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
  }
}
