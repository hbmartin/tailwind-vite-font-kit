import type { Plugin } from 'vite'

export interface FontFamily {
  /** Google Fonts family name, e.g. `'Manrope'`. */
  name: string
  /**
   * The Tailwind theme variable this family drives. Emitted as
   * `@theme { --font-sans: 'Manrope', '<fallbacks>', <stack> }`.
   */
  themeVar: `--font-${string}`
  /** Weights to request. One fallback face is generated per weight. */
  weights: number[]
  /** Tail of the font stack, after the generated fallback families. */
  stack?: string[]
  /**
   * Which weights to preload. `[]` disables preloading for this family.
   * Preloading is zero-sum against your render-blocking stylesheet:
   * FCP cost ≈ preloaded bytes ÷ bandwidth (66 kB at ~500 kB/s measured 156 ms).
   * Preload the body face; add the display face only if the headline is your LCP element.
   */
  preloadWeights?: number[]
  /** `'self-host'` (default) serves from your origin; `'cdn'` keeps Google's gstatic URL. */
  strategy?: 'self-host' | 'cdn'
  /** Raw css2 axis spec, e.g. `'opsz,wght@9..144,500;9..144,700'`. Defaults to `wght@<weights>`. */
  axes?: string
  /**
   * Where to pin an `opsz` axis, if the family has one. Defaults to 16.
   * Pinning removes the axis from the served file, which makes static metrics valid
   * again and shrinks the file ~45%. Use ~16 for body text, ~48 for a display face.
   */
  opszPin?: number
}

export interface FontsOptions {
  /**
   * May be omitted when `fonts.config.mjs` in the project root provides the families
   * (the shadcn path). The plugin throws at build time if neither supplies them.
   */
  families?: FontFamily[]
  /** Subsets to keep from Google's per-subset blocks. Default `['latin']`. */
  subsets?: string[]
  /** URL prefix the fonts are served from. Default `'/fonts'`. */
  publicPath?: string
  /**
   * `'emit'` (default) — woff2 emitted as build assets; nothing lands in your source tree.
   *
   * Any other value is a **directory path relative to the project root** (e.g.
   * `'public/fonts'`) for when you want real files you can inspect, or serve without
   * this plugin. Writing is additive; nothing in that directory is ever deleted, and
   * .gitignore is never touched.
   *
   * Committing those files does NOT make builds offline — the generated CSS still lives
   * in `output`. Use `output: 'commit'` for hermetic builds.
   */
  assets?: 'emit' | (string & {})
  /**
   * `'cache'` (default) — generated into `node_modules/.cache/tss-fonts`.
   * `'commit'` — generated into `.tss-fonts/` in the repo, so CI never touches the
   * network. Cold generation was measured at 61 s on first contact with Google.
   */
  output?: 'cache' | 'commit'
  /**
   * Emit preloads as an HTTP `Link:` response header via Nitro route rules. Default true.
   * This is what makes the plugin zero-app-edit. Set false and import `fontPreloads`
   * from `virtual:fonts` if you would rather render `<link>` tags yourself.
   */
  preloadHeader?: boolean
  silent?: boolean
}

export declare function fonts(options?: FontsOptions): Plugin
export default fonts

declare module 'virtual:fonts' {
  export const fontPreloads: Array<{
    rel: 'preload'
    as: 'font'
    type: 'font/woff2'
    href: string
    crossOrigin: 'anonymous'
  }>
  export const fontFamilies: Record<string, string>
}
