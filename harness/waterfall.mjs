#!/usr/bin/env node
// Measures the font critical path under emulated mobile network conditions.
//
// The baseline app chains: HTML -> /assets/styles.css -> fonts.googleapis.com/css2
// -> fonts.gstatic.com/*.woff2. That is 3 sequential round trips after the HTML,
// two of them to a third-party origin needing fresh DNS+TLS. Self-hosting with a
// preload collapses it. This quantifies the difference in ms.
//
// Usage: node waterfall.mjs --base http://localhost:3111 --label baseline

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
const PATH = args.path || '/probe/hero'
const RUNS = Number(args.runs || 3)

// Roughly "good 4G": 150ms RTT, 4 Mbps down. Latency is what the @import chain pays.
const CONDITIONS = {
  offline: false,
  latency: 150,
  downloadThroughput: (4 * 1024 * 1024) / 8,
  uploadThroughput: (1024 * 1024) / 8,
}

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })

async function once() {
  const page = await browser.newPage()
  await page.setViewport({ width: 390, height: 844 })
  await page.setCacheEnabled(false)
  const client = await page.createCDPSession()
  await client.send('Network.enable')
  await client.send('Network.emulateNetworkConditions', CONDITIONS)

  await page.evaluateOnNewDocument(`
    window.__t = { fontsReady: null };
    document.fonts.ready.then(() => { window.__t.fontsReady = performance.now() });
    window.__paint = {};
    new PerformanceObserver(l => { for (const e of l.getEntries()) window.__paint[e.name] = e.startTime }).observe({type:'paint',buffered:true});
  `)

  await page.goto(BASE + PATH, { waitUntil: 'networkidle0', timeout: 120000 })
  await new Promise((r) => setTimeout(r, 800))

  const timing = await page.evaluate(`(() => {
    const res = performance.getEntriesByType('resource').map(r => ({
      name: r.name, start: Math.round(r.startTime), end: Math.round(r.responseEnd),
      dur: Math.round(r.duration), type: r.initiatorType,
    }));
    return { res, paint: window.__paint, fontsReady: window.__t.fontsReady, nav: performance.getEntriesByType('navigation')[0]?.responseEnd };
  })()`)

  await page.close()
  return timing
}

const runs = []
for (let i = 0; i < RUNS; i++) runs.push(await once())
await browser.close()

const med = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const fontRes = runs[0].res.filter(
  (r) => /\.woff2?(\?|$)/.test(r.name) || /fonts\.googleapis|fonts\.gstatic/.test(r.name),
)
const cssRes = runs[0].res.filter(
  (r) => /\.css(\?|$)/.test(r.name) || /googleapis\.com\/css/.test(r.name),
)

const out = {
  label: LABEL,
  path: PATH,
  conditions: '150ms RTT / 4Mbps',
  fcpMs: Math.round(med(runs.map((r) => r.paint['first-contentful-paint'] || 0))),
  fcpAll: runs.map((r) => Math.round(r.paint['first-contentful-paint'] || 0)).sort((a, b) => a - b),
  fontsReadyMs: Math.round(med(runs.map((r) => r.fontsReady || 0))),
  fontsAll: runs.map((r) => Math.round(r.fontsReady || 0)).sort((a, b) => a - b),
  htmlDoneMs: Math.round(med(runs.map((r) => r.nav || 0))),
  chain: [...cssRes, ...fontRes]
    .sort((a, b) => a.start - b.start)
    .map((r) => ({
      url: r.name.replace(BASE, '').slice(0, 90),
      start: r.start,
      end: r.end,
      dur: r.dur,
    })),
  distinctOrigins: [
    ...new Set(
      runs[0].res.map((r) => {
        try {
          return new URL(r.name).origin
        } catch {
          return '?'
        }
      }),
    ),
  ],
}

console.log(JSON.stringify(out, null, 2))
console.log(`\n=== ${LABEL} @ 150ms RTT ===`)
console.log(`  HTML done        ${out.htmlDoneMs} ms`)
console.log(`  FCP              ${out.fcpMs} ms`)
console.log(`  fonts applied    ${out.fontsReadyMs} ms   <-- text is un-swapped until here`)
console.log(`  origins touched  ${out.distinctOrigins.join(', ')}`)
console.log('  chain:')
for (const c of out.chain)
  console.log(`    ${String(c.start).padStart(5)} -> ${String(c.end).padStart(5)} ms  ${c.url}`)
writeFileSync(args.out || `waterfall-${LABEL}.json`, JSON.stringify(out, null, 2))
