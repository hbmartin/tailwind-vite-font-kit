/// <reference path="./virtual-fonts.d.ts" />
import type { Plugin } from 'vite'

export interface FontFamily {
  /** Google Fonts family name, e.g. `'Manrope'`. */
  name: string
  /**
   * The Tailwind theme variable this family drives. Emitted as
   * `@theme { --font-sans: 'Manrope', '<fallbacks>', <stack> }`.
   */
  themeVar: `--font-${string}`
  /**
   * Weights to request. One fallback face is generated per weight.
   *
   * Optional only when `axes` carries a `wght` axis, in which case the weights are
   * derived from it — `'opsz,wght@9..144,500;9..144,700'` yields `[500, 700]`. A family
   * with neither is an error: the fallback faces need concrete values.
   */
  weights?: number[]
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
   *
   * `'auto'` measures the font instead of guessing: it downloads the variable font once,
   * computes the advance-width swing across `opszSizes`, and pins accordingly. Costs an
   * extra download on a cold generate (never on a warm one) and needs the optional peer
   * dependencies `fontkit` and `wawoff2`. `npx tss-fonts opsz <Family>` prints the same
   * answer without changing anything.
   *
   * Worth knowing before hand-picking a number: the axis range varies a lot between
   * families — Fraunces is 9..144, Inter 14..32, Nunito Sans only 6..12, so the default
   * of 16 is outside the axis on some families and is clamped.
   */
  opszPin?: number | 'auto'
  /**
   * The px font sizes this family actually renders at, used by `opszPin: 'auto'` to
   * decide where to pin. Defaults to a spread of body, subhead, heading and display
   * sizes. Ignored unless `opszPin` is `'auto'`.
   */
  opszSizes?: number[]
}

/** One entry of the preload set, as an HTTP `Link:` header or a JSX `<link>`. */
export interface FontPreload {
  rel: 'preload'
  as: 'font'
  type: 'font/woff2'
  href: string
  crossOrigin: 'anonymous'
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
   *
   * The header is set on `/**`, since that is the only pattern covering every document
   * route. Nitro merges matching rules' headers key-by-key with the more specific rule
   * winning, so paths listed in `exclude` get an empty `Link:` instead — a browser reads
   * zero links from it. Defaults to the hashed build output and the font files
   * themselves; pass your own list to widen or narrow it.
   */
  preloadHeader?: boolean | { exclude?: string[] }
  /**
   * Append two scoped `@utility` escape hatches to the generated stylesheet:
   * `leading-auto` and `prose-auto`, both of which set `line-height: normal` on a
   * subtree. Default false.
   *
   * Tailwind pins a unitless `line-height: 1.5` on `html` and again on every `text-*`
   * utility, and a unitless leading makes the `ascent-override` / `descent-override` /
   * `line-gap-override` descriptors on the fallback faces inert. These give you named,
   * scoped ways out of that where you actually want optical leading.
   *
   * There is deliberately no global un-pin: measured net CLS benefit is zero if you ship
   * metric fallbacks, and +0.02–0.06 if you do not.
   */
  leadingUtilities?: boolean
  silent?: boolean
}

export declare function fonts(options?: FontsOptions): Plugin
export default fonts
