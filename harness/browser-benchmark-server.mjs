// Read-only production proxy. Export the server for real HTTP regression tests.
import { createServer } from 'node:http'
import { readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { gzipSync } from 'node:zlib'
import { candidateCss } from './browser-benchmark-candidates.mjs'
import { stripFallbacks } from './browser-benchmark-css.mjs'
import { clsSession } from './browser-benchmark-session.mjs'
import { assetEvidence, fontAssetPattern } from './browser-benchmark-assets.mjs'
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const require = createRequire(import.meta.url)
const transformId = digest(
  ['assets', 'css', 'candidates', 'session', 'probe', 'server']
    .map((name) =>
      readFileSync(
        new URL(`./browser-benchmark-${name}.${name === 'probe' ? 'js' : 'mjs'}`, import.meta.url),
      ),
    )
    .concat(`postcss/${require('postcss/package.json').version}`)
    .join('\n'),
)
const probe = readFileSync(
  new URL('./browser-benchmark-probe.js', import.meta.url),
  'utf8',
).replace('__BENCH_CLS__', () => clsSession.toString())
export function createBenchmarkServer({
  origin = 'http://127.0.0.1:3210',
  candidate = 'baseline',
  fontaineCss,
  fontainePath,
} = {}) {
  let upstreamOrigin
  try {
    upstreamOrigin = new URL(origin)
    if (!['http:', 'https:'].includes(upstreamOrigin.protocol) || !upstreamOrigin.host)
      throw new Error('Unsupported origin')
  } catch {
    throw new Error('BENCH_ORIGIN must be an absolute http(s) URL')
  }
  if (!['baseline', 'binding', 'manrope-helvetica', 'combined'].includes(candidate))
    throw new Error('Unknown candidate')
  const hasFontaine = fontaineCss !== undefined
  if (hasFontaine && (!fontaineCss || !/^\/assets\/[^?#]+\.css$/.test(fontainePath ?? '')))
    throw new Error('Set BENCH_FONTAINE_PATH to the original /assets/*.css path')
  const variants = new Set([
    'kit',
    'swap',
    'swap-preload',
    'optional',
    'system',
    ...(hasFontaine ? ['fontaine'] : []),
  ])
  const runs = new Map()
  return createServer(async (req, res) => {
    let run, upstreamPath
    try {
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405, { allow: 'GET, HEAD' }).end()
        return
      }
      const url = new URL(req.url, 'http://benchmark.local')
      const asset = /^\/__bench\/([^/]+)\/(.*)$/.exec(url.pathname)
      if (asset) {
        run = runs.get(asset[1])
        if (!run) {
          res.writeHead(404).end('Unknown run')
          return
        }
        if (asset[2] === 'evidence') {
          const body = JSON.stringify({
            candidate,
            transformId,
            assets: [...run.assets.values()].sort((a, b) => a.path.localeCompare(b.path)),
            ...(run.variant === 'fontaine'
              ? {
                  fontaine: {
                    path: fontainePath,
                    cssHash: digest(fontaineCss),
                    applied: run.fontaineApplied,
                  },
                }
              : {}),
          })
          res
            .writeHead(run.variant === 'fontaine' && !run.fontaineApplied ? 409 : 200, {
              'content-type': 'application/json',
              'cache-control': 'no-store',
            })
            .end(req.method === 'HEAD' ? undefined : body)
          return
        }
        if (!/^(assets|fonts)\//.test(asset[2])) {
          res.writeHead(404).end('Unknown asset path')
          return
        }
        upstreamPath = '/' + asset[2] + url.search
      } else if (/^\/(assets|fonts)\//.test(url.pathname)) {
        // Runtime URLs can bypass rewriting. Prefer a same-origin referrer and use
        // the page's short-lived cookie when the referrer is unavailable.
        let referrerId
        try {
          const referrer = new URL(req.headers.referer)
          if (referrer.host === req.headers.host)
            referrerId =
              /^\/__bench\/([^/]+)\//.exec(referrer.pathname)?.[1] ??
              referrer.searchParams.get('run')
        } catch {
          /* Missing or malformed Referer. */
        }
        const cookieId = /(?:^|;\s*)font_bench_run=([\w-]+)(?=;|$)/.exec(
          req.headers.cookie ?? '',
        )?.[1]
        const referrerRun = runs.get(referrerId)
        const cookieRun = runs.get(cookieId)
        if (referrerId && !referrerRun) {
          res.writeHead(409).end('Referer names an unknown benchmark run')
          return
        }
        if (referrerRun && cookieRun && referrerRun !== cookieRun) {
          res.writeHead(409).end('Conflicting benchmark run attribution')
          return
        }
        run = referrerRun ?? cookieRun
        if (!run) {
          res.writeHead(409).end('Asset request has no benchmark run')
          return
        }
        upstreamPath = url.pathname + url.search
      } else if (/^\/probe\/[\w-]+$/.test(url.pathname)) {
        const variant = url.searchParams.get('variant') || 'kit'
        const id = url.searchParams.get('run')
        const delay = Number(url.searchParams.get('delay') ?? 2000)
        const width = Number(url.searchParams.get('width') ?? 0)
        if (
          !variants.has(variant) ||
          !/^[\w-]+$/.test(id ?? '') ||
          !Number.isFinite(delay) ||
          delay < 0 ||
          delay > 10000 ||
          !Number.isFinite(width) ||
          width < 0
        ) {
          res.writeHead(400).end('Invalid benchmark case')
          return
        }
        if (runs.has(id)) {
          res.writeHead(409).end('Use a fresh run ID')
          return
        }
        run = { id, variant, delay, width, assets: new Map(), fontaineApplied: false }
        runs.set(id, run)
        // Bound a long-lived local proxy's bookkeeping. A sequential run retains
        // its evidence until at least 1,000 subsequent page navigations.
        if (runs.size > 1000) runs.delete(runs.keys().next().value)
        upstreamPath = url.pathname + url.search
      } else {
        res.writeHead(404).end('Unknown benchmark route')
        return
      }
      const prefix = `/__bench/${run.id}`
      const rewrite = (s) => s.replace(/\/(assets|fonts)\//g, `${prefix}/$1/`)
      const response = await fetch(new URL(upstreamPath, upstreamOrigin))
      const type = response.headers.get('content-type') || ''
      let body = Buffer.from(await response.arrayBuffer())
      const sourceHash = digest(body)
      const headers = { 'content-type': type, 'cache-control': 'no-store' }
      if (type.includes('text/css')) {
        let css = body.toString()
        if (run.variant === 'fontaine') {
          if (new URL(upstreamPath, upstreamOrigin).pathname === fontainePath && response.ok) {
            css = fontaineCss
            run.fontaineApplied = true
          } else css = stripFallbacks(css)
        }
        if (candidate !== 'baseline' && run.variant === 'kit') css = candidateCss(css, candidate)
        if (run.variant !== 'kit' && run.variant !== 'fontaine') css = stripFallbacks(css)
        if (run.variant === 'optional')
          css = css.replace(/font-display\s*:\s*swap/g, 'font-display:optional')
        if (run.variant === 'system') {
          css = css.replace(/@font-face\s*\{[^{}]*\}/g, '')
          css +=
            ':root{--font-sans:ui-sans-serif,system-ui,sans-serif;--font-display:Georgia,serif}'
        }
        run.assets.set(upstreamPath, assetEvidence(upstreamPath, type, sourceHash, digest(css)))
        body = Buffer.from(rewrite(css))
      } else if (type.includes('javascript')) {
        run.assets.set(upstreamPath, assetEvidence(upstreamPath, type, sourceHash))
        body = Buffer.from(rewrite(body.toString()))
      } else if (type.includes('text/html')) {
        let html = rewrite(body.toString())
        const config = JSON.stringify({
          id: run.id,
          variant: run.variant,
          delay: run.delay,
          width: run.width,
        }).replace(/'/g, '&#39;')
        html = html.replace(
          '<head>',
          `<head><link rel="icon" href="data:,"><script data-config='${config}'>${probe}</script>`,
        )
        if (run.width)
          html = html.replace(
            '</head>',
            `<style>main.page-wrap{width:${run.width}px;max-width:100%}</style></head>`,
          )
        body = Buffer.from(html)
        if (upstreamPath.startsWith('/probe/') && response.ok)
          headers['set-cookie'] =
            `font_bench_run=${run.id}; Path=/; Max-Age=120; HttpOnly; SameSite=Lax`
        if (['kit', 'swap-preload', 'fontaine'].includes(run.variant)) {
          const link = response.headers.get('link')
          if (link) headers.link = rewrite(link)
        }
      }
      if (fontAssetPattern.test(upstreamPath)) {
        await new Promise((resolve) => setTimeout(resolve, run.delay))
        run.assets.set(upstreamPath, assetEvidence(upstreamPath, type, sourceHash))
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
      res.writeHead(response.status, headers).end(req.method === 'HEAD' ? undefined : body)
    } catch (error) {
      console.error('Benchmark proxy error', {
        request: req.url,
        run: run?.id,
        upstreamPath,
        error,
      })
      if (res.headersSent) res.destroy(error)
      else res.writeHead(502).end(String(error))
    }
  })
}
const isDirect = (() => {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return false
  }
})()
if (isDirect) {
  const port = Number(process.env.BENCH_PORT || 3211)
  createBenchmarkServer({
    origin: process.env.BENCH_ORIGIN || undefined,
    candidate: process.env.BENCH_CANDIDATE || undefined,
    fontainePath: process.env.BENCH_FONTAINE_PATH,
    fontaineCss: process.env.BENCH_FONTAINE_CSS
      ? readFileSync(process.env.BENCH_FONTAINE_CSS, 'utf8')
      : undefined,
  }).listen(port, '127.0.0.1', () => console.log(`Benchmark proxy: http://127.0.0.1:${port}`))
}
