// Whether a fallback width error turns into CLS is decided by ONE coin flip:
// does the headline wrap to a different number of lines at THIS container
// width? A single viewport therefore measures nothing. This sweeps viewport
// widths across the range a real desktop/tablet audience actually uses and
// reports the distribution.
import puppeteer from 'puppeteer'
import { writeFileSync } from 'node:fs'

const BASE = process.env.BASE || 'http://localhost:3303'
const LABEL = process.argv[2] || 'unlabeled'
const PATHNAME = process.env.PROBE || '/probe/opszcls'
const DELAY = 1800
// Only widths BELOW the .page-wrap cap (1080px) change the container, and the
// display clamp() only moves below ~1067px — every wider viewport is literally
// the same layout, which is why a naive viewport sweep measures nothing.
const WIDTHS = []
for (let w = 360; w <= 1060; w += 20) WIDTHS.push(w)

const INIT = `window.__s=[];new PerformanceObserver(l=>{for(const e of l.getEntries()){if(!e.hadRecentInput)window.__s.push(e.value)}}).observe({type:'layout-shift',buffered:true});`
const SNAP = `(()=>{const h=document.querySelector('h1');const r=document.createRange();r.selectNodeContents(h);
 const pb=document.querySelector('[data-probe="b"]');
 return {lines:r.getClientRects().length,h:Math.round(h.getBoundingClientRect().height),
 by:pb?Math.round(pb.getBoundingClientRect().top+window.scrollY):null,doc:document.documentElement.scrollHeight}})()`

const b = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const rows = []
for (const w of WIDTHS) {
  const p = await b.newPage()
  await p.setViewport({ width: w, height: 900 })
  await p.setCacheEnabled(false)
  await p.evaluateOnNewDocument(INIT)
  await p.setRequestInterception(true)
  p.on('request', (r) => {
    if (r.resourceType() === 'font' || /\.woff2?($|\?)/.test(r.url()))
      setTimeout(() => r.continue().catch(() => {}), DELAY)
    else r.continue().catch(() => {})
  })
  p.goto(BASE + PATHNAME, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await new Promise((r) => setTimeout(r, DELAY - 700))
  const before = await p.evaluate(SNAP).catch(() => null)
  await new Promise((r) => setTimeout(r, DELAY + 1600))
  const after = await p.evaluate(SNAP).catch(() => null)
  const cls = (await p.evaluate('window.__s')).reduce((a, x) => a + x, 0)
  rows.push({
    w,
    cls: +cls.toFixed(4),
    dLines: after && before ? after.lines - before.lines : null,
    dY: after && before && after.by != null ? after.by - before.by : null,
  })
  await p.close()
}
await b.close()
const desk = rows.filter((r) => r.w >= 700)
const mob = rows.filter((r) => r.w < 700)
const summarise = (rs, name) => {
  const cls = rs.map((r) => r.cls)
  const sorted = [...cls].sort((a, b) => a - b)
  const reflow = rs.filter((r) => r.dLines !== 0).length
  const summary = {
    name,
    widths: rs.length,
    median: sorted[Math.floor(sorted.length / 2)],
    p90: sorted[Math.floor(sorted.length * 0.9)],
    max: Math.max(...cls),
    mean: cls.reduce((a, x) => a + x, 0) / cls.length,
    nonzero: cls.filter((c) => c > 0.0005).length,
    lineCountChanged: reflow,
    maxDeltaY: Math.max(...rs.map((r) => Math.abs(r.dY ?? 0))),
  }
  console.log(
    `${name.padEnd(8)} widths=${summary.widths}  CLS median=${summary.median.toFixed(4)} p90=${summary.p90.toFixed(4)} max=${summary.max.toFixed(4)} mean=${summary.mean.toFixed(4)}  nonzero=${summary.nonzero}/${summary.widths}  lineCountChanged=${summary.lineCountChanged}/${summary.widths}  maxΔy=${summary.maxDeltaY}px`,
  )
  return summary
}
console.log(`\n=== ${LABEL} ${PATHNAME} ===`)
const summaries = [summarise(desk, '700-1060'), summarise(mob, '360-680')]
console.log(
  'per-width: ' +
    rows.map((r) => `${r.w}:${r.cls}${r.dLines ? '(' + r.dLines + 'L)' : ''}`).join(' '),
)
writeFileSync(
  process.env.OUT || `/tmp/clswidth-${LABEL}.json`,
  JSON.stringify({ label: LABEL, base: BASE, probe: PATHNAME, summaries, rows }, null, 1),
)
