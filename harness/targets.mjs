// For each generated fallback face, how closely does it actually reproduce the real
// font's advance width in this browser? A size-adjust is only as good as the metric
// data for the local() target it points at.
import puppeteer from 'puppeteer'

const BASE = process.argv[2] || 'http://localhost:3300'
const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
const p = await b.newPage()
await p.setViewport({ width: 1400, height: 900 })
await p.goto(BASE + '/probe/hero', { waitUntil: 'networkidle0' })
await p.evaluate('document.fonts.ready')
await new Promise((r) => setTimeout(r, 600))

const r = await p.evaluate(() => {
  const w = (fam, size, weight) => {
    const d = document.createElement('div')
    d.style.cssText =
      'position:absolute;left:-9999px;white-space:nowrap;font-size:' +
      size +
      'px;font-weight:' +
      weight +
      ';font-family:' +
      fam
    d.textContent = 'Typography is the craft of endowing human language with a durable visual form'
    document.body.appendChild(d)
    const x = d.getBoundingClientRect().width
    d.remove()
    return +x.toFixed(1)
  }
  const strip = (s) => s.replace(/^["']|["']$/g, '')
  const uniq = [...new Set([...document.fonts].map((f) => strip(f.family)))]
  const out = { notLoaded: [], sansTargets: {}, serifTargets: {}, rawLocals: {} }
  for (const f of document.fonts) {
    if (f.status !== 'loaded')
      out.notLoaded.push(strip(f.family) + '/' + f.weight + ' = ' + f.status)
  }
  out.manropeReal = w('Manrope', 17, 400)
  out.frauncesReal = w('Fraunces', 56, 700)
  for (const n of uniq.filter((x) => x.startsWith('Manrope Fallback'))) {
    out.sansTargets[n] = w('"' + n + '"', 17, 400)
  }
  for (const n of uniq.filter((x) => x.startsWith('Fraunces Fallback'))) {
    out.serifTargets[n] = w('"' + n + '"', 56, 700)
  }
  for (const n of ['Helvetica Neue', 'Segoe UI', 'Roboto', 'Arial', 'Georgia', 'Times New Roman']) {
    out.rawLocals[n] = w('"' + n + '"', 17, 400)
  }
  return out
})
await b.close()

if (r.notLoaded.length) {
  console.log('faces that did NOT load (local() target absent on this machine):')
  for (const n of r.notLoaded) console.log('   ' + n)
}
console.log('\nManrope @17px/400 = ' + r.manropeReal + 'px  -- fallback faces, error vs real:')
for (const [n, v] of Object.entries(r.sansTargets)) {
  const err = (v / r.manropeReal - 1) * 100
  console.log(
    '  ' +
      n.padEnd(38) +
      String(v).padStart(8) +
      'px   ' +
      (err >= 0 ? '+' : '') +
      err.toFixed(2) +
      '%',
  )
}
console.log('\nFraunces @56px/700 = ' + r.frauncesReal + 'px  -- fallback faces, error vs real:')
for (const [n, v] of Object.entries(r.serifTargets)) {
  const err = (v / r.frauncesReal - 1) * 100
  console.log(
    '  ' +
      n.padEnd(38) +
      String(v).padStart(8) +
      'px   ' +
      (err >= 0 ? '+' : '') +
      err.toFixed(2) +
      '%',
  )
}
console.log('\nraw locals on this machine @17px (equal widths = same underlying face):')
for (const [n, v] of Object.entries(r.rawLocals)) console.log('  ' + n.padEnd(20) + v + 'px')
