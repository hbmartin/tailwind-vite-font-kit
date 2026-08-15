// Google font binaries are untrusted URLs extracted from a network response. Keep the
// complete-origin check small and dependency-free so both generation and opsz measurement
// can use it without loading each other's implementation modules.

const FONT_HOSTS = new Set(['fonts.gstatic.com'])

/**
 * @param {string} src the `src: url(...)` taken from a css2 response
 * @param {string} family for the error message
 */
export function assertFontHost(src, family) {
  let url
  try {
    url = new URL(src)
  } catch {
    throw new Error(`[tss-fonts] ${family}: css2 returned an unparseable font URL: ${src}`)
  }
  // The host is only half the origin. An `http:` URL has the same host but downgrades
  // the download's transport security (and becomes mixed content in `strategy: 'cdn'`).
  // A custom port is likewise not Google's font origin.
  if (url.protocol !== 'https:' || url.port || !FONT_HOSTS.has(url.hostname)) {
    const actual = url.origin === 'null' ? url.href : url.origin
    throw new Error(
      `[tss-fonts] ${family}: refusing to download a font from ${actual} — ` +
        `expected https://${[...FONT_HOSTS].join(' or ')}. The css2 response was not what it should be.`,
    )
  }
}

/**
 * Turn Node's generic fetch failure for `redirect: 'error'` into the same actionable
 * diagnostic everywhere a validated font binary is downloaded.
 * @param {string} url
 * @param {unknown} err
 * @returns {Error | null}
 */
export function redirectRefusalError(url, err) {
  const cause = /** @type {{cause?: {message?: unknown}}} */ (err)?.cause
  if (!/redirect/i.test(String(cause?.message ?? ''))) return null
  return new Error(
    `[tss-fonts] ${url} answered with a redirect, which was refused — validated font ` +
      `downloads do not follow redirects. ` +
      `Check for an intercepting proxy or captive portal.`,
  )
}
