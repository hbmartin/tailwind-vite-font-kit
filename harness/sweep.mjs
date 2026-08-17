#!/usr/bin/env node
// Sweeps every probe page x viewport and reports CLS + layout deltas, plus a
// static audit of what font CSS actually reached the browser.
//
// Usage: node sweep.mjs --label baseline [--base http://localhost:3111] [--runs 3]

import puppeteer from 'puppeteer'
import { writeFileSync } from 'node:fs'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]])
    return acc
  }, []),
)

const BASE = args.base || 'http://localhost:3111'
const LABEL = args.label || 'unlabeled'
const RUNS = Number(args.runs || 3)
const FONT_DELAY_MS = Number(args.delay || 2000)

const PROBES = ['hero', 'tailwind', 'normal']
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]

const FONT_BINARY_RE = /\.(woff2?|ttf|otf|eot)(\?|$)/i

// The pre-swap snapshot and audit have to land between "the page has laid out on the
// fallback" and "the intercepted fonts are released". The closing edge is FONT_DELAY_MS
// after the page ASKS for a font, not after navigation starts, so a slow cold start moves
// the whole window later rather than shortening it. Anchoring to the first font request
// and polling for the state we care about is what keeps a first-navigation-on-a-cold-
// runner from producing an empty audit that the CLS gate then reports as a font
// regression.
const PRE_SWAP_MARGIN_MS = 400
const PRE_SWAP_GRACE_MS = 8000
const PRE_SWAP_POLL_MS = 50

const PRE_SWAP_READY = `(() => {
  if (document.readyState === 'loading') return false;
  const fallbacks = [...document.fonts].filter((f) => / Fallback: /.test(f.family || ''));
  // 'unloaded' faces never settle on their own, and targets absent from this platform
  // end at 'error' — neither can be waited for. What must not still be in flight is a
  // face that IS resolving, and at least one has to have actually landed.
  return fallbacks.length > 0 &&
    fallbacks.every((f) => f.status !== 'loading') &&
    fallbacks.some((f) => f.status === 'loaded');
})()`

const INIT = `
window.__shifts = [];
window.__paint = {};
new PerformanceObserver((l) => {
  for (const e of l.getEntries()) {
    if (e.hadRecentInput) continue;
    window.__shifts.push({ value: e.value, startTime: e.startTime,
      sources: (e.sources||[]).map(s => ({
        node: s.node ? (s.node.nodeName + (s.node.dataset && s.node.dataset.probe ? '[' + s.node.dataset.probe + ']' : '')) : '?',
        dy: s.previousRect && s.currentRect ? Math.round(s.currentRect.y - s.previousRect.y) : null })) });
  }
}).observe({ type: 'layout-shift', buffered: true });
new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__paint[e.name] = e.startTime; }).observe({ type: 'paint', buffered: true });
new PerformanceObserver((l) => { const es = l.getEntries(); if (es.length) window.__paint.lcp = es[es.length-1].startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
`

const SNAP = `(() => {
  const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return {y: Math.round(b.y), h: Math.round(b.height)} };
  return { scrollHeight: document.documentElement.scrollHeight, a: r('[data-probe="a"]'), b: r('[data-probe="b"]'), card0: r('[data-probe="card-0"]'), fontsStatus: document.fonts.status };
})()`

const RUNTIME_AUDIT = `(() => {
  const faces = []; let unreadableSheets = 0;
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules } catch { unreadableSheets++; continue }
    const walk = (rs, guarded) => { for (const r of rs) {
      if (r.constructor.name === 'CSSFontFaceRule') { const s = r.style;
        faces.push({ family: (s.getPropertyValue('font-family')||'').replace(/["']/g,'').trim(),
          srcKind: /local\\(/.test(s.getPropertyValue('src')) ? 'local' : 'url',
          src: (s.getPropertyValue('src')||'').slice(0,120),
          sizeAdjust: s.getPropertyValue('size-adjust'), ascentOverride: s.getPropertyValue('ascent-override'),
          descentOverride: s.getPropertyValue('descent-override'), lineGapOverride: s.getPropertyValue('line-gap-override'),
          hasUnicodeRange: !!s.getPropertyValue('unicode-range'), display: s.getPropertyValue('font-display'), insideSupports: guarded });
      } else if (r.cssRules) walk(r.cssRules, guarded || r.constructor.name === 'CSSSupportsRule');
    }};
    walk(rules, false);
  }
  const h = document.querySelector('h1');
  return { fontFaces: faces, unreadableSheets,
    captured: 'before-delayed-web-fonts',
    fontFaceSet: [...document.fonts].map(f => ({
      family: (f.family||'').replace(/["']/g,'').trim(), weight: f.weight,
      style: f.style, status: f.status })),
    computedBody: getComputedStyle(document.body).fontFamily,
    computedH1: h ? getComputedStyle(h).fontFamily : null,
    cssVarFontSans: getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim(),
    preloadLinks: [...document.querySelectorAll('link[rel=preload][as=font]')].map(l => ({href:l.getAttribute('href'),crossorigin:l.getAttribute('crossorigin')})),
    headStyleTags: document.querySelectorAll('head style').length };
})()`

// Follow the served HTML -> stylesheets -> @import chain in Node so we can read
// cross-origin CSS the page itself cannot introspect.
async function staticAudit(url) {
  const response = await fetch(url)
  const html = await response.text()
  const navigationLinkHeader = response.headers.get('link') || ''
  const headerPreloadFontLinks = navigationLinkHeader
    .split(/,(?=\s*<)/)
    .filter((link) => /\brel\s*=\s*["']?preload/i.test(link) && /\bas\s*=\s*["']?font/i.test(link))
    .map((link) => link.trim().slice(0, 300))
  const hrefs = [
    ...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/g),
  ].map((m) => m[1])
  const inlineStyles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1])
  const seen = new Set()
  const cssTexts = [...inlineStyles]
  const origin = new globalThis.URL(url).origin
  async function pull(href, depth = 0) {
    if (depth > 3) return
    const abs = href.startsWith('http') ? href : origin + href
    if (seen.has(abs)) return
    seen.add(abs)
    try {
      const t = await fetch(abs, {
        headers: {
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        },
      }).then((r) => r.text())
      cssTexts.push(t)
      for (const m of t.matchAll(/@import\s+(?:url\()?["']?([^"')]+)["']?\)?/g))
        await pull(m[1], depth + 1)
    } catch {
      /* ignore */
    }
  }
  for (const h of hrefs) await pull(h)
  const all = cssTexts.join('\n')
  const faceBlocks = [...all.matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => m[0])
  return {
    stylesheetHrefs: hrefs,
    inlineStyleTags: inlineStyles.length,
    totalFontFaceBlocks: faceBlocks.length,
    facesWithSizeAdjust: faceBlocks.filter((b) => /size-adjust/.test(b)).length,
    facesWithAscentOverride: faceBlocks.filter((b) => /ascent-override/.test(b)).length,
    facesWithLocalSrc: faceBlocks.filter((b) => /local\(/.test(b)).length,
    supportsGuards: (all.match(/@supports\s*\([^)]*ascent-override/g) || []).length,
    fontFamiliesDeclared: [
      ...new Set(
        faceBlocks
          .map((b) => (b.match(/font-family:\s*([^;]+)/) || [])[1]?.replace(/["']/g, '').trim())
          .filter(Boolean),
      ),
    ],
    sampleFallbackFace:
      faceBlocks
        .find((b) => /size-adjust/.test(b))
        ?.replace(/\s+/g, ' ')
        .slice(0, 400) || null,
    headPreloadFontLinks: [...html.matchAll(/<link[^>]+rel=["']preload["'][^>]*>/g)]
      .filter((m) => /as=["']font/.test(m[0]))
      .map((m) => m[0].slice(0, 200)),
    navigationLinkHeader: navigationLinkHeader.slice(0, 2000),
    headerPreloadFontLinks,
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Poll until the page is worth auditing, or until the pre-swap window closes.
 * @returns {Promise<{ready: boolean, reason: string | null}>} `reason` names why the
 *   window was missed, so a failed gate can say "the audit did not run" instead of
 *   inventing a missing fallback.
 */
async function waitForPreSwap(page, fontRequest, hardDeadline) {
  let lastProbeError = null
  while (Date.now() < hardDeadline) {
    // Only meaningful once a font has been requested; until then the swap cannot happen.
    if (
      fontRequest.at !== null &&
      Date.now() >= fontRequest.at + FONT_DELAY_MS - PRE_SWAP_MARGIN_MS
    ) {
      return { ready: false, reason: 'the pre-swap window closed before the fallbacks resolved' }
    }
    try {
      if (await page.evaluate(PRE_SWAP_READY)) return { ready: true, reason: null }
    } catch (error) {
      // The execution context is destroyed as the navigation commits; that is expected
      // here and must not be mistaken for a real failure, so it only surfaces if the
      // whole window expires without a single successful probe.
      lastProbeError = String(error?.message || error)
    }
    await sleep(PRE_SWAP_POLL_MS)
  }
  const waited = FONT_DELAY_MS + PRE_SWAP_GRACE_MS
  return {
    ready: false,
    reason: lastProbeError
      ? `the page was not auditable within ${waited}ms (last probe error: ${lastProbeError})`
      : `the page was not auditable within ${waited}ms of navigation`,
  }
}

async function runProbe(browser, probe, vp) {
  const url = `${BASE}/probe/${probe}`
  const runs = []
  let audit = null
  let before = null
  let after = null
  for (let i = 0; i < RUNS; i++) {
    const page = await browser.newPage()
    await page.setViewport({ width: vp.width, height: vp.height })
    await page.setCacheEnabled(false)
    await page.evaluateOnNewDocument(INIT)
    await page.setRequestInterception(true)
    const reqs = []
    const fontRequest = { at: null }
    page.on('request', (req) => {
      reqs.push(req.url())
      if (req.resourceType() === 'font' || FONT_BINARY_RE.test(req.url())) {
        if (fontRequest.at === null) fontRequest.at = Date.now()
        setTimeout(() => req.continue().catch(() => {}), FONT_DELAY_MS)
        return
      }
      req.continue().catch(() => {})
    })
    const navigationStartedAt = Date.now()
    page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {})
    const preSwap = await waitForPreSwap(
      page,
      fontRequest,
      navigationStartedAt + FONT_DELAY_MS + PRE_SWAP_GRACE_MS,
    )
    const snapBefore = await page.evaluate(SNAP).catch(() => null)
    let preSwapAudit = null
    if (i === 0) {
      const captured = await page
        .evaluate(RUNTIME_AUDIT)
        .catch((error) => ({ auditError: String(error?.message || error) }))
      const reason = captured.auditError
        ? `the runtime audit threw: ${captured.auditError}`
        : preSwap.reason
      // A null (or empty) audit is indistinguishable downstream from "the fallbacks are
      // missing", and check-cls.mjs gates on it. An audit that cannot be trusted carries
      // the reason it cannot, so the gate reports the infrastructure failure it is.
      preSwapAudit = reason ? { ...captured, unavailableReason: reason } : captured
    }
    // The swap is FONT_DELAY_MS after the request, so wait past that point rather than
    // past a wall-clock guess that a late font request would have invalidated.
    const swapAt = (fontRequest.at ?? Date.now()) + FONT_DELAY_MS
    await sleep(Math.max(500, swapAt + 2500 - Date.now()))
    const snapAfter = await page.evaluate(SNAP).catch(() => null)
    const shifts = await page.evaluate('window.__shifts')
    const paint = await page.evaluate('window.__paint')
    if (i === 0) {
      audit = preSwapAudit
      before = snapBefore
      after = snapAfter
    }
    runs.push({ cls: shifts.reduce((a, s) => a + s.value, 0), shifts, paint })
    await page.close()
  }
  const cls = runs.map((r) => r.cls).sort((a, b) => a - b)
  const delta = (k) => (before?.[k] && after?.[k] ? after[k].y - before[k].y : null)
  return {
    probe,
    viewport: vp.name,
    clsMedian: cls[Math.floor(cls.length / 2)],
    clsAll: cls,
    shiftPx: { a: delta('a'), b: delta('b'), card0: delta('card0') },
    scrollHeightDelta: before && after ? after.scrollHeight - before.scrollHeight : null,
    fcp: Math.round(runs[0].paint['first-contentful-paint'] || 0),
    lcp: Math.round(runs[0].paint.lcp || 0),
    audit,
  }
}

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const results = []
for (const vp of VIEWPORTS) for (const p of PROBES) results.push(await runProbe(browser, p, vp))
await browser.close()

const stat = await staticAudit(`${BASE}/probe/hero`)
const out = {
  label: LABEL,
  base: BASE,
  fontDelayMs: FONT_DELAY_MS,
  runs: RUNS,
  staticAudit: stat,
  results,
}
console.log(JSON.stringify(out, null, 2))
writeFileSync(args.out || `result-${LABEL}.json`, JSON.stringify(out, null, 2))

console.log('\n=== SUMMARY: ' + LABEL + ' ===')
for (const r of results) {
  console.log(
    `${r.viewport.padEnd(8)} ${r.probe.padEnd(9)} CLS=${r.clsMedian.toFixed(4).padStart(8)}  shiftPx a=${String(r.shiftPx.a).padStart(5)} b=${String(r.shiftPx.b).padStart(5)}  Δheight=${String(r.scrollHeightDelta).padStart(5)}  fcp=${r.fcp}`,
  )
}
console.log(
  `fallback @font-face w/ size-adjust: ${stat.facesWithSizeAdjust}/${stat.totalFontFaceBlocks}, local() srcs: ${stat.facesWithLocalSrc}, @supports guards: ${stat.supportsGuards}, font preloads: ${stat.headerPreloadFontLinks.length} header + ${stat.headPreloadFontLinks.length} HTML`,
)
