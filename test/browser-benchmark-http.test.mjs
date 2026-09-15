import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createBenchmarkServer } from '../harness/browser-benchmark-server.mjs'
const originalCss =
  '@font-face{font-family:Manrope Fallback\\: Arial;font-weight:700;src:local(Arial);size-adjust:100%}:root{--font-sans:Manrope,Manrope Fallback\\: Arial,sans-serif}'
async function server(t, options = {}) {
  const seen = []
  const upstream = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url })
    if (req.url.startsWith('/assets/main.css'))
      res.writeHead(200, { 'content-type': 'text/css' }).end(originalCss)
    else if (req.url.startsWith('/assets/route.css'))
      res.writeHead(200, { 'content-type': 'text/css' }).end('.route{color:red}')
    else if (req.url.startsWith('/assets/main.js'))
      res
        .writeHead(200, { 'content-type': 'text/javascript' })
        .end('const url="/"+"assets/route.css"')
    else if (req.url.startsWith('/fonts/'))
      res.writeHead(200, { 'content-type': 'font/woff2' }).end('font bytes')
    else
      res
        .writeHead(200, {
          'content-type': 'text/html',
          link: '</fonts/font.woff2>;rel=preload;as=font',
        })
        .end(
          '<html><head><link rel="stylesheet" href="/assets/main.css"></head><body><main>Fixture</main></body></html>',
        )
  }).listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const proxy = createBenchmarkServer({
    origin: `http://127.0.0.1:${upstream.address().port}`,
    ...options,
  }).listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  t.after(() => {
    proxy.closeAllConnections()
    proxy.close()
    upstream.closeAllConnections()
    upstream.close()
  })
  const base = `http://127.0.0.1:${proxy.address().port}`
  return {
    base,
    seen,
    get: (path, init) => fetch(base + path, init),
    page: (id, variant = 'kit') => fetch(`${base}/probe/hero?run=${id}&variant=${variant}&delay=0`),
  }
}
test('runtime asset URLs inherit the page variant and queries survive forwarding', async (t) => {
  const { base, get, page, seen } = await server(t)
  await page('swap', 'swap')
  const response = await get('/assets/main.css?v=17&import', {
    headers: { referer: `${base}/probe/hero?run=swap` },
  })
  assert.equal(response.status, 200)
  assert(!(await response.text()).includes('Fallback'))
  assert(seen.some((r) => r.url === '/assets/main.css?v=17&import'))
  await get('/__bench/swap/assets/route.css?v=2')
  assert(seen.some((r) => r.url === '/assets/route.css?v=2'))
  assert.equal((await get('/assets/main.css')).status, 409)
  const before = seen.length
  assert.equal((await get('/probe/hero', { method: 'POST', body: 'data' })).status, 405)
  assert.equal(seen.length, before)
  assert.equal((await get('/__bench/swap//elsewhere.example')).status, 404)
})
test('evidence identifies the actual candidate and transformed CSS, including unquoted local names', async (t) => {
  const { get, page } = await server(t, { candidate: 'binding' })
  const html = await (await page('binding')).text()
  assert(html.includes('function clsSession('))
  assert(!html.includes('__BENCH_CLS__'))
  const css = await (await get('/__bench/binding/assets/main.css')).text()
  assert(css.includes('Arial-BoldMT'))
  await get('/__bench/binding/assets/main.js')
  await get('/__bench/binding/fonts/font.woff2')
  const evidence = await (await get('/__bench/binding/evidence')).json()
  assert.equal(evidence.candidate, 'binding')
  assert.match(evidence.transformId, /^[a-f0-9]{64}$/)
  const stylesheet = evidence.assets.find((a) => a.path.endsWith('.css'))
  assert.notEqual(stylesheet.sourceHash, stylesheet.servedHash)
  assert(
    evidence.assets
      .filter((a) => !a.path.endsWith('.css'))
      .every((a) => a.sourceHash === a.servedHash),
  )
  assert.equal((await page('binding')).status, 409)
})
test('Fontaine replaces only its declared source stylesheet', async (t) => {
  assert.throws(
    () => createBenchmarkServer({ fontaineCss: '.replacement{}' }),
    /BENCH_FONTAINE_PATH/,
  )
  const { get, page } = await server(t, {
    fontaineCss: '.replacement{color:blue}',
    fontainePath: '/assets/main.css',
  })
  await page('fontaine', 'fontaine')
  assert.equal(
    await (await get('/__bench/fontaine/assets/main.css')).text(),
    '.replacement{color:blue}',
  )
  assert.equal(await (await get('/__bench/fontaine/assets/route.css')).text(), '.route{color:red}')
})
