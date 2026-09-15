import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createBenchmarkServer } from '../harness/browser-benchmark-server.mjs'
const originalCss =
  '@font-face{font-family:Manrope Fallback\\: Arial;font-weight:700;src:local(Arial);size-adjust:100%}:root{--font-sans:Manrope,Manrope Fallback\\: Arial,sans-serif}'
async function server(t, options = {}) {
  const { routeCss = '.route{color:red}', ...proxyOptions } = options
  const seen = []
  const upstream = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url })
    if (req.url.startsWith('/assets/main.css'))
      res.writeHead(200, { 'content-type': 'text/css' }).end(originalCss)
    else if (req.url.startsWith('/assets/route.css'))
      res.writeHead(200, { 'content-type': 'text/css' }).end(routeCss)
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
    ...proxyOptions,
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
test('stale Fontaine path yields invalid evidence and other stylesheets lose kit fallbacks', async (t) => {
  const stale = await server(t, {
    fontaineCss: '.replacement{color:blue}',
    fontainePath: '/assets/stale.css',
    routeCss: originalCss + '.route{color:red}',
  })
  await stale.page('stale', 'fontaine')
  await stale.get('/__bench/stale/assets/main.css')
  const other = await (await stale.get('/__bench/stale/assets/route.css')).text()
  assert(!other.includes('Fallback'))
  const evidence = await stale.get('/__bench/stale/evidence')
  assert.equal(evidence.status, 409)
  const body = await evidence.json()
  assert.deepEqual(body.fontaine, {
    path: '/assets/stale.css',
    cssHash: body.fontaine.cssHash,
    applied: false,
  })

  const valid = await server(t, {
    fontaineCss: '.replacement{color:blue}',
    fontainePath: '/assets/main.css',
    routeCss: originalCss + '.route{color:red}',
  })
  await valid.page('valid', 'fontaine')
  assert.equal(
    await (await valid.get('/__bench/valid/assets/main.css')).text(),
    '.replacement{color:blue}',
  )
  assert(!(await (await valid.get('/__bench/valid/assets/route.css')).text()).includes('Fallback'))
  const applied = await valid.get('/__bench/valid/evidence')
  assert.equal(applied.status, 200)
  assert.equal((await applied.json()).fontaine.applied, true)
})
test('per-run cookie attributes unprefixed assets without Referer and rejects conflicts', async (t) => {
  const { base, get, page } = await server(t)
  const first = await page('cookie-a', 'swap')
  const cookie = first.headers.get('set-cookie')
  assert.match(cookie, /font_bench_run=cookie-a;.*HttpOnly/)
  const noReferer = await get('/assets/main.css', { headers: { cookie } })
  assert.equal(noReferer.status, 200)
  assert(!(await noReferer.text()).includes('Fallback'))
  await page('cookie-b', 'kit')
  const conflict = await get('/assets/main.css', {
    headers: { cookie, referer: `${base}/probe/hero?run=cookie-b` },
  })
  assert.equal(conflict.status, 409)
  assert.equal(
    (
      await get('/assets/main.css', {
        headers: { cookie, referer: `${base}/probe/hero?run=unknown` },
      })
    ).status,
    409,
  )
  assert.equal(
    (await get('/__bench/cookie-b/assets/main.css', { headers: { cookie } })).status,
    200,
  )
  assert.equal(
    (await get('/assets/main.css', { headers: { cookie: 'font_bench_run=unknown' } })).status,
    409,
  )
})
test('bad origins fail before listen and upstream failures are logged with a 502 body', async (t) => {
  assert.throws(() => createBenchmarkServer({ origin: '' }), /BENCH_ORIGIN/)
  assert.throws(() => createBenchmarkServer({ origin: 'ftp://example.test' }), /BENCH_ORIGIN/)
  const logs = []
  const previous = console.error
  console.error = (...args) => logs.push(args)
  try {
    const broken = await server(t, { origin: 'http://127.0.0.1:1' })
    const response = await broken.page('upstream-error')
    assert.equal(response.status, 502)
    assert.match(await response.text(), /fetch failed/)
    assert.equal(logs[0][1].run, 'upstream-error')
  } finally {
    console.error = previous
  }
})
test('proxy started through a symlink listens even with an empty BENCH_ORIGIN', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'benchmark-server-symlink-'))
  const link = join(dir, 'proxy.mjs')
  symlinkSync(resolve('harness/browser-benchmark-server.mjs'), link)
  const child = spawn(process.execPath, [link], {
    env: { ...process.env, BENCH_PORT: '0', BENCH_ORIGIN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let timer
  try {
    const started = await Promise.race([
      once(child.stdout, 'data').then(([data]) => String(data)),
      once(child, 'exit').then(([code]) => {
        throw new Error(`Proxy exited before listen: ${code}`)
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Proxy did not listen')), 3000)
      }),
    ])
    assert.match(started, /Benchmark proxy:/)
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await once(child, 'exit').catch(() => {})
    }
    rmSync(dir, { recursive: true, force: true })
  }
})
