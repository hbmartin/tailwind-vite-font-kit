// Production SSR proxy for in-app-browser experiments; no browser automation dependency.
// Start the built TanStack app, then: node harness/browser-benchmark-server.mjs
// Open /probe/hero?variant=kit&run=unique&delay=2000. Every run gets unique asset
// URLs and no-store responses so browser memory/disk caches cannot hide font swaps.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const origin = process.env.BENCH_ORIGIN || 'http://127.0.0.1:3210'
const port = Number(process.env.BENCH_PORT || 3211)
const probe = readFileSync(new URL('./browser-benchmark-probe.js', import.meta.url), 'utf8')
const variants = new Set(['kit', 'swap', 'swap-preload', 'optional', 'system'])
const fontaineCss = process.env.BENCH_FONTAINE_CSS
  ? readFileSync(process.env.BENCH_FONTAINE_CSS, 'utf8')
  : null
if (fontaineCss) variants.add('fontaine')
const runs = new Map()
const stripFallbacks = (css) =>
  css
    .replace(/@font-face\s*\{[^{}]*size-adjust\s*:[^{}]*\}/g, '')
    .replace(/(?:"[^"]* Fallback: [^"]*"|'[^']* Fallback: [^']*')\s*,\s*/g, '')

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`)
    const asset = /^\/__bench\/([^/]+)\/(.*)$/.exec(url.pathname)
    let run, upstreamPath
    if (asset) {
      run = runs.get(asset[1])
      if (!run) {
        res.writeHead(404).end()
        return
      }
      upstreamPath = '/' + asset[2]
    } else {
      const variant = url.searchParams.get('variant') || 'kit'
      if (!variants.has(variant)) {
        res.writeHead(400).end('Unknown variant')
        return
      }
      const id = url.searchParams.get('run') || String(Date.now())
      const delay = Math.min(10000, Math.max(0, Number(url.searchParams.get('delay') || 0)))
      const width = Number(url.searchParams.get('width') || 0)
      run = { id, variant, delay, width }
      runs.set(id, run)
      upstreamPath = url.pathname + url.search
    }
    const prefix = `/__bench/${run.id}`
    const rewrite = (s) => s.replace(/\/(assets|fonts)\//g, `${prefix}/$1/`)
    const response = await fetch(origin + upstreamPath)
    const type = response.headers.get('content-type') || ''
    let body = Buffer.from(await response.arrayBuffer())
    const headers = { 'content-type': type, 'cache-control': 'no-store' }
    if (type.includes('text/css')) {
      let css = run.variant === 'fontaine' ? fontaineCss : body.toString()
      if (run.variant !== 'kit' && run.variant !== 'fontaine') css = stripFallbacks(css)
      if (run.variant === 'optional')
        css = css.replace(/font-display\s*:\s*swap/g, 'font-display:optional')
      if (run.variant === 'system') {
        css = css.replace(/@font-face\s*\{[^{}]*\}/g, '')
        css += ':root{--font-sans:ui-sans-serif,system-ui,sans-serif;--font-display:Georgia,serif}'
      }
      body = Buffer.from(rewrite(css))
    } else if (type.includes('javascript')) {
      body = Buffer.from(rewrite(body.toString()))
    } else if (type.includes('text/html')) {
      let html = rewrite(body.toString())
      const config = JSON.stringify(run).replace(/'/g, '&#39;')
      html = html.replace('<head>', `<head><script data-config='${config}'>${probe}</script>`)
      if (run.width)
        html = html.replace(
          '</head>',
          `<style>main.page-wrap{width:${run.width}px;max-width:100%}</style></head>`,
        )
      body = Buffer.from(html)
      if (['kit', 'swap-preload', 'fontaine'].includes(run.variant)) {
        const link = response.headers.get('link')
        if (link) headers.link = rewrite(link)
      }
    }
    if (/\.woff2?(?:\?|$)/.test(upstreamPath)) {
      await new Promise((resolve) => setTimeout(resolve, run.delay))
      headers['access-control-allow-origin'] = '*'
    } else if (
      /javascript|text\/css|text\/html/.test(type) &&
      /gzip/.test(req.headers['accept-encoding'] || '')
    ) {
      body = gzipSync(body)
      headers['content-encoding'] = 'gzip'
      headers.vary = 'Accept-Encoding'
    }
    headers['content-length'] = String(body.length)
    res.writeHead(response.status, headers).end(body)
  } catch (error) {
    console.error(error)
    res.writeHead(502).end(String(error))
  }
}).listen(port, '127.0.0.1', () => console.log(`Benchmark proxy: http://127.0.0.1:${port}`))
