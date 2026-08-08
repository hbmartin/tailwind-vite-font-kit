// TanStack Start server entry that ships the font preloads as `103 Early Hints`.
//
//   // src/server.ts
//   import { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'
//   export default createFontsServerEntry()
//
// `npx tss-fonts early-hints` writes exactly that file.
//
// WHAT THIS BUYS, and when it buys nothing:
//
// Start's first byte waits on the route loader, so on a slow route every preload
// mechanism that lives in the HTML arrives late. A 103 does not: it goes out before
// `router.load()`. Measured with an 800 ms loader — fonts applied 1259 ms vs 1536 ms for
// head().links, and FCP 1300 ms vs 1516 ms. On a fast route it is worth nothing; the
// plugin's `Link:` response header already measures identical to head().links there.
//
// Constraints, all measured:
//   - Browsers act on the FIRST 103 only. A second one is ignored entirely. Start fires
//     an `onEarlyHints` event on a `static` phase (before router.load) and again on a
//     `dynamic` phase (after), so the font list is merged into the static write and the
//     dynamic phase is dropped.
//   - Chrome only acts on 103 over HTTP/2+. Over HTTP/1.1 it parses the hint
//     (Network.responseReceivedEarlyHints fires) but issues no preload.
//   - `writeEarlyHints` is a Node http.ServerResponse method, reached through srvx as
//     `request.runtime.node.res`. Under workerd or Deno it is absent, and this degrades
//     to the `Link:` header below.
//
// Keep head().links preloads as well if you have them: they are the only thing that works
// when neither of the above applies (static export, Safari, no CDN).

import { fontPreloads } from 'virtual:fonts'

/**
 * `crossorigin` is REQUIRED even same-origin. Fonts are always CORS-fetched, and a
 * preload without it is a DIFFERENT cache entry, so the font downloads twice: measured
 * 4 requests / 185 kB instead of 2 / 93 kB, with fonts applied at 1001 ms instead of
 * 686 ms — worse than shipping no preload at all (897 ms).
 * @type {string[]}
 */
const FONT_LINKS = fontPreloads.map(
  (p) => `<${p.href}>; rel=preload; as=font; type=${p.type}; crossorigin`,
)

/**
 * Everything below touches Start internals that are not part of its public types:
 * the `onEarlyHints` handler option, its `phase` discriminator, and the srvx runtime
 * handle on the request. Isolated here, and here only, so a Start release that moves any
 * of it breaks one function with one obvious cause rather than the whole entry.
 *
 * @param {unknown} request
 * @returns {{writeEarlyHints?: (hints: {link: string[]}) => void} | undefined}
 */
function nodeResponseOf(request) {
  return /** @type {any} */ (request)?.runtime?.node?.res
}

/**
 * @typedef {object} FontsServerEntryOptions
 * @property {boolean} [earlyHints] write a 103 when the runtime supports it. Default true.
 * @property {boolean} [linkHeader] append `Link:` to the document response. Default true.
 *   The Vite plugin already sets this via Nitro route rules; keep both only if you have
 *   turned `preloadHeader` off there.
 * @property {(streamHandler: any) => any} [createHandler] override how the Start handler is
 *   built. Exists for tests and for apps that already wrap `createStartHandler`.
 */

/**
 * Build a Start server entry that emits the font preloads as early as the runtime allows.
 *
 * @param {FontsServerEntryOptions} [options]
 */
export function createFontsServerEntry(options = {}) {
  const { earlyHints = true, linkHeader = true, createHandler } = options

  /** @type {Promise<any> | null} */
  let handlerPromise = null
  const getHandler = async () => {
    handlerPromise ??= (async () => {
      if (createHandler) return createHandler(null)
      // Imported lazily so this module can be loaded (and unit-tested) without Start
      // installed; it is an optional peer.
      const mod = await import('@tanstack/react-start/server').catch(() => {
        throw new Error(
          '[tss-fonts] `tailwind-vite-font-kit/start-server` needs @tanstack/react-start — ' +
            'it is an optional peer dependency, installed only when you use this entry.',
        )
      })
      return mod.createStartHandler(mod.defaultStreamHandler)
    })()
    return handlerPromise
  }

  return {
    /**
     * @param {Request} request
     * @param {...any} rest
     */
    async fetch(request, ...rest) {
      const handler = await getHandler()
      // Only documents get preloads. A fetch/XHR for JSON has nothing to preload for,
      // and a 103 on it would be wasted bytes on every navigation the router makes.
      const isDoc = (request.headers.get('accept') || '').includes('text/html')
      let sent = false

      const response = await handler(request, {
        ...rest[0],
        /** @param {{phase: string, links: string[]}} event */
        onEarlyHints: ({ phase, links }) => {
          // `static` runs BEFORE router.load(); `dynamic` runs after, which is too late
          // to matter and would be a second 103 the browser ignores anyway.
          if (!isDoc || !earlyHints || sent || phase !== 'static') return
          sent = true
          const res = nodeResponseOf(request)
          if (typeof res?.writeEarlyHints !== 'function') return
          try {
            // Fonts first: they are the long pole, and the browser honours order.
            res.writeEarlyHints({ link: [...FONT_LINKS, ...links] })
          } catch {
            // A destroyed socket, an aborted client, or a response that already started
            // must never take the document down with it — hints are best-effort.
          }
        },
      })

      if (isDoc && linkHeader) {
        for (const l of FONT_LINKS) response.headers.append('Link', l)
      }
      return response
    },
  }
}

export default createFontsServerEntry
