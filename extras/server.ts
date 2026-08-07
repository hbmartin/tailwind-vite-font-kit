// src/server.ts — TanStack Start custom server entry.
//
// Start resolves `src/server.{ts,tsx}` as the server entry (see
// start-plugin-core/src/planning.ts -> resolveEntry({ type: 'server entry',
// defaultEntry: 'server' })). Default entry is
// `@tanstack/react-start/default-entry/server`.
//
// What this adds over the default entry:
//
//  1. ONE 103 Early Hints response, written on Start's `static` phase — which
//     runs BEFORE `await router.load()`. This is the only preload mechanism
//     that can beat a slow route loader, because Start's first byte waits on
//     the loader. Measured: with an 800ms loader, fonts applied 1259ms vs
//     1536ms for head().links.
//     - Browsers act on the FIRST 103 only (measured: a second 103 is ignored
//       entirely). Start's own `dynamic` phase fires a SECOND event, after
//       router.load(), which is where head().links would land. So we merge our
//       statically-known font list into the static-phase write and drop the
//       dynamic phase.
//     - Chrome only acts on 103 over HTTP/2+. Over HTTP/1.1 it parses the 103
//       (Network.responseReceivedEarlyHints fires) but issues no preload.
//     - Node exposes writeEarlyHints on the raw res, reachable through srvx as
//       `request.runtime.node.res`. Under other runtimes (workerd, Deno) this
//       is absent; the code degrades to the Link header below.
//
//  2. A `Link:` response header on the HTML, as the portable fallback. Works
//     on HTTP/1.1, and is the input many CDNs (Cloudflare, Fastly) turn into
//     their own 103. Measured identical to head().links on a fast route.
//
// Keep head().links preloads as well: they are the only thing that works when
// neither of the above applies (static export, Safari, no CDN).
import {
  createStartHandler,
  defaultStreamHandler,
} from '@tanstack/react-start/server'
import type { Register } from '@tanstack/react-router'
import type { RequestHandler } from '@tanstack/react-start/server'
import { fontPreloads } from 'virtual:fonts'

const handler = createStartHandler(defaultStreamHandler)

// `crossorigin` is REQUIRED even same-origin: fonts are always CORS-fetched,
// and a preload without it is a different cache entry -> the font downloads
// TWICE. Measured: 4 requests / 185kB instead of 2 / 93kB, fonts applied
// 1001ms instead of 686ms — worse than no preload at all (897ms).
const FONT_LINKS = fontPreloads.map(
  (p) => `<${p.href}>; rel=preload; as=font; type=${p.type}; crossorigin`,
)

export type ServerEntry = { fetch: RequestHandler<Register> }

export function createServerEntry(entry: ServerEntry): ServerEntry {
  return { async fetch(...args) { return await entry.fetch(...args) } }
}

export default createServerEntry({
  async fetch(request, ...rest) {
    const isDoc = (request.headers.get('accept') || '').includes('text/html')
    let sentEarlyHints = false

    const response = await (handler as any)(request, {
      ...((rest[0] as any) || {}),
      onEarlyHints: ({ phase, links }: { phase: string; links: Array<string> }) => {
        if (!isDoc || sentEarlyHints || phase !== 'static') return
        sentEarlyHints = true
        const res = (request as any).runtime?.node?.res
        if (typeof res?.writeEarlyHints !== 'function') return
        try {
          // fonts first: they are the long pole and the browser honours order
          res.writeEarlyHints({ link: [...FONT_LINKS, ...links] })
        } catch {
          // A destroyed socket, aborted client, or already-started response must never
          // take the document response down with it — hints are best-effort.
        }
      },
    })

    if (isDoc) {
      for (const l of FONT_LINKS) response.headers.append('Link', l)
    }
    return response
  },
} as any)
