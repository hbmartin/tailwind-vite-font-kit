export interface FontsServerEntryOptions {
  /**
   * Write a `103 Early Hints` response carrying the font preloads, when the runtime
   * supports it. Default true.
   *
   * This is the only preload mechanism that can beat a slow route loader, because Start's
   * first byte waits on the loader while a 103 does not. Measured with an 800 ms loader:
   * fonts applied 1259 ms vs 1536 ms for `head().links`, FCP 1300 ms vs 1516 ms. On a
   * fast route it buys nothing over the plugin's `Link:` header.
   *
   * Requires HTTP/2+ for Chrome to act on it, and a Node runtime for `writeEarlyHints`.
   * Under workerd or Deno it silently degrades to the `Link:` header.
   */
  earlyHints?: boolean
  /**
   * Append `Link:` preload headers to the document response. Default false.
   *
   * The Vite plugin already sets this through Nitro route rules, so turning it on beside
   * the plugin duplicates the header on every document. Opt in only if you have set
   * `preloadHeader: false` there.
   */
  linkHeader?: boolean
  /** Override how the Start handler is built. For tests, and for apps that already wrap
   *  `createStartHandler` themselves. */
  createHandler?: (streamHandler: unknown) => unknown
}

export interface FontsServerEntry {
  fetch(request: Request, ...rest: unknown[]): Promise<Response>
}

/**
 * A TanStack Start server entry that ships the font preloads as early as the runtime
 * allows. Use it as `src/server.ts`:
 *
 * ```ts
 * import { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'
 * export default createFontsServerEntry()
 * ```
 *
 * `npx tss-fonts early-hints` writes that file for you.
 */
export declare function createFontsServerEntry(options?: FontsServerEntryOptions): FontsServerEntry
export default createFontsServerEntry
