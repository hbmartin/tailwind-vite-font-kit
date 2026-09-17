// tailwind-vite-font-kit — the whole Google-font pipeline as ONE Vite plugin.
//
//   plugins: [ nitro(), fonts({ families: [...] }), tailwindcss(), tanstackStart(), viteReact() ]
//
// Your styles.css and __root.tsx are never touched. What happens, in the order it must:
//
//   config()          fetch css2 + download woff2 (cached), write fonts.gen.css, and hand
//                     Nitro two route rules: `immutable` on the fonts, and a `Link:`
//                     preload header on documents. `config` is the earliest async hook;
//                     Vite may repeat it while resolving build environments, whereas
//                     `buildStart` fires after configuration and per environment.
//   transform()       rewrite the Tailwind ENTRY in-memory to `@import` that file.
//                     Tailwind bypasses Vite for its own @imports, so the target must be
//                     a real file — but the entry itself does pass through Vite.
//   buildStart()      emitFile the woff2 into the CLIENT bundle.
//   configureServer() serve the same woff2 from the cache in dev.
//
// Nitro ships preloads as an HTTP `Link:` header. Plain Vite receives equivalent
// head-prepended links from transformIndexHtml. Measured equivalent: 608ms FCP / 586ms
// fonts (header) vs 604 / 579 (HTML), 9 runs at 150ms RTT.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, posix } from 'node:path'
import { CSS_NAME_RE, generate } from './generate.mjs'
import { assertConfigShape, loadFontsConfig, validateFamilies, validateOptions } from './config.mjs'
import { isDoctorContext } from './doctor-context.mjs'
import {
  hasConventionalHtmlEntry,
  normalizeHtmlFontPreloads,
  preloadHeaderEnabled,
  resolvePreloadDelivery,
} from './preload-delivery.mjs'

const VIRTUAL_ID = 'virtual:fonts'
const RESOLVED_VIRTUAL_ID = '\0virtual:fonts'
const FULL_URL_BASE_RE = /^(?:https?:)?\/\//
const FONT_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const FONT_CORS_ORIGIN = '*'
const DEFAULT_OPTIONS = {
  publicPath: '/fonts',
  assets: 'emit',
  output: 'cache',
  preloadHeader: true,
  preloadHtml: 'auto',
  silent: false,
}

const defaultOptions = () => ({ ...DEFAULT_OPTIONS, subsets: ['latin'] })

function assignDefined(target, ...sources) {
  for (const source of sources) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (value !== undefined) target[key] = value
    }
  }
  return target
}

/** Turn a user-facing URL prefix into one absolute directory path. `'/'` is legal —
 *  fonts then live at the bundle root, which worked before base handling existed. */
function normalizePublicPath(value, label = 'publicPath') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`[tss-fonts] \`${label}\` must be a non-empty URL path, e.g. '/fonts'.`)
  }
  return '/' + value.trim().replace(/^\/+|\/+$/g, '')
}

/** Mirror the parts of Vite's base resolution that affect generated URLs. Config hooks
 * see the raw user value, while configResolved sees this command-specific form. */
function viteBaseForCommand(base, { isServe = false, isSsrBuild = false } = {}) {
  if (base == null) return '/'
  if (base === '' || base === './') return isServe || isSsrBuild ? '/' : './'
  if (base.startsWith('.')) return '/'

  const external = FULL_URL_BASE_RE.test(base)
  if (!isServe && external) return base.replace(/\/+$/, '') + '/'

  try {
    const resolved = new URL(base, 'http://vite.dev').pathname
    return (resolved.startsWith('/') ? resolved : `/${resolved}`).replace(/\/+$/, '') + '/'
  } catch {
    // Vite will report a malformed base itself. Keep comparison deterministic and let the
    // existing public-path parser produce this package's more specific warning.
    return base.replace(/\/+$/, '') + '/'
  }
}

/**
 * A Vite `base` prefixes the public URL but not Rollup's output filename. Keep those
 * separate: with base '/docs/', `fonts/x.woff2` is emitted under dist/fonts/ and served
 * from /docs/fonts/x.woff2. A single `publicPath` used for both worked only at root.
 *
 * Every Vite-legal base has to come out of here with a working build — a full URL (CDN
 * deploy) and a relative './' are documented values, and rejecting them broke configs
 * that self-host nothing at all. Returns:
 *   assetPath   where Rollup emits / the assets directory writes — never carries base
 *   publicPath  what goes into hrefs; under a URL base this carries the origin
 *   routePath   the path font requests take on THIS server — Nitro patterns and the dev
 *               middleware key on it; equals publicPath except under a URL base
 *   basePath    the base's path portion, for prefixing other route patterns ('' at root)
 * @param {string | undefined} base
 * @param {string} publicPath
 * @param {{selfHost?: boolean, warn?: (message: string) => void}} [context]
 */
function publicPathsForVite(base, publicPath, { selfHost = true, warn = () => {} } = {}) {
  const assetPath = normalizePublicPath(publicPath)
  if (!base || base === '/') {
    return { assetPath, publicPath: assetPath, routePath: assetPath, basePath: '' }
  }
  // A full-URL base (CDN deploy). Only hrefs carry the origin, and only in the build —
  // dev serves off the local server, where just the path portion applies. The path
  // portion stays in the route patterns: an origin-pull CDN forwards it to this server.
  if (FULL_URL_BASE_RE.test(base)) {
    let url
    try {
      url = new URL(base.startsWith('//') ? `https:${base}` : base)
    } catch {
      warn(`could not parse Vite \`base\` ${JSON.stringify(base)} — font URLs will not carry it.`)
      return { assetPath, publicPath: assetPath, routePath: assetPath, basePath: '' }
    }
    const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
    // Match the path-base compatibility behavior below: before base support existed,
    // users sometimes included the deployment path in publicPath themselves.
    if (basePath && (assetPath === basePath || assetPath.startsWith(`${basePath}/`))) {
      const stripped = assetPath.slice(basePath.length) || '/'
      return {
        assetPath: stripped,
        publicPath: url.origin + assetPath,
        routePath: assetPath,
        basePath,
      }
    }
    const routePath = assetPath === '/' ? basePath || '/' : posix.join(basePath || '/', assetPath)
    return {
      assetPath,
      publicPath: url.origin + routePath,
      routePath,
      basePath,
    }
  }
  // A relative base ('./'). Vite rewrites ITS asset URLs per importing page, but the
  // URLs in the generated CSS are written here, with no page to be relative to — they
  // stay root-absolute, which is exactly what pre-base versions emitted. Only worth a
  // warning when fonts are actually self-hosted; a pure-CDN config never touches them.
  if (!base.startsWith('/')) {
    if (selfHost) {
      warn(
        `Vite \`base\` is relative (${JSON.stringify(base)}), which the generated font URLs ` +
          `cannot follow — they stay root-absolute (${assetPath}/...). Self-hosted fonts only ` +
          `resolve if the site deploys at the domain root; use an absolute or full-URL base, ` +
          `or \`strategy: 'cdn'\`.`,
      )
    }
    return { assetPath, publicPath: assetPath, routePath: assetPath, basePath: '' }
  }
  const basePath = normalizePublicPath(base, 'base')
  // Keep an explicit path that already includes base working: users may have used it as
  // a workaround before the plugin learned Vite's base semantics.
  if (assetPath === basePath || assetPath.startsWith(`${basePath}/`)) {
    const stripped = assetPath.slice(basePath.length) || '/'
    return { assetPath: stripped, publicPath: assetPath, routePath: assetPath, basePath }
  }
  // Fonts at the bundle root occupy the base namespace itself. Avoid a trailing slash
  // sentinel here: downstream route patterns must make that namespace collision explicit.
  const joined = assetPath === '/' ? basePath : posix.join(basePath, assetPath)
  return { assetPath, publicPath: joined, routePath: joined, basePath }
}

/**
 * @param {import('../index.d.ts').FontsOptions} userOptions
 * @returns {import('vite').Plugin}
 */
export function fonts(userOptions = {}) {
  // `families` is filled in by resolveFamilies() below, which throws if neither the
  // call site nor fonts.config.mjs supplied any — so every hook can assume it is set.
  const opts = /** @type {import('./generate.mjs').ResolvedOptions} */ (
    assignDefined({}, defaultOptions(), userOptions)
  )
  const warningEvents = []
  const doctorMode = () => isDoctorContext()
  const log = (m) => !opts.silent && !doctorMode() && console.log(`[tss-fonts] ${m}`)
  // Deliberately NOT gated on `silent`. `silent` means "stop narrating a build", not
  // "hide delivery, correctness, or production-header conditions that still need review".
  /** @param {string} m */
  const warn = (m, code = 'GENERAL') => {
    warningEvents.push({ code, message: m })
    if (!doctorMode()) console.warn(`[tss-fonts] ${m}`)
  }

  // Families may come from the call site OR from `fonts.config.mjs` in the project root.
  // The config file is what `npx shadcn add` drops, since shadcn can place files but
  // cannot edit vite.config.ts — so `fonts()` with no arguments is the shadcn path.
  // Explicit options always win.
  /** @param {string} r */
  async function resolveFamilies(r) {
    // Inline options are validated too. They are the path a human hand-writes, so they
    // are at least as likely to carry a typo as the generated config file.
    if (opts.families?.length) {
      validateFamilies(opts.families, 'fonts() options')
      return
    }
    // Root first, then src/ — shadcn resolves a bare `target` against the project's
    // component root, so an item authored without `~/` lands in src/.
    const candidates = [
      'fonts.config.mjs',
      'fonts.config.js',
      'src/fonts.config.mjs',
      'src/fonts.config.js',
    ]
    for (const name of candidates) {
      const p = join(r, name)
      if (!existsSync(p)) continue
      // Cache-busted so a dev-server restart in the same process sees edits. Shape-checked
      // before merging: spreading an array (or a string) into `opts` produces index keys
      // and no `families`, which would end at the misleading "no families configured".
      const cfg = assertConfigShape(await loadFontsConfig(p), name)
      assignDefined(opts, cfg, userOptions)
      configFile = p
      log(`loaded ${name}`)
      // Validate only once families are known to be present — a config file with no
      // families at all falls through to the friendlier "nothing configured" error below.
      if (opts.families?.length) {
        validateFamilies(opts.families, name)
        return
      }
      break // config found but no families in it — fall through to the error
    }
    throw new Error(
      '[tss-fonts] no families configured. Either pass them inline:\n' +
        "  fonts({ families: [{ name: 'Manrope', themeVar: '--font-sans', weights: [400,700],\n" +
        "    stack: ['ui-sans-serif','system-ui','sans-serif'], preloadWeights: [400] }] })\n" +
        'or create fonts.config.mjs in your project root (this is what `shadcn add` installs).',
    )
  }

  let root = process.cwd()
  let isServe = false
  let isSsrBuild = false
  let isLibraryBuild = false
  // The URL in generated CSS includes Vite's base; emitted Rollup filenames must not.
  let assetPath = '/fonts'
  // The server-side request path for fonts — Nitro patterns and the dev middleware use
  // this, never `publicPath`, which under a full-URL base carries the CDN origin.
  let routePath = '/fonts'
  // The generated href prefix for this config run. Keep it separate from `opts.publicPath`:
  // Vite can invoke config() more than once on a shared plugin instance, and rewriting the
  // configured value would make the next invocation resolve an already-resolved URL.
  let publicPath = '/fonts'
  // Whether any family self-hosts: decides how loudly base problems are reported.
  let selfHosts = true
  // What config() saw as `base`, checked against the final value in configResolved().
  /** @type {string | undefined} */
  let assumedBase
  // Vite's command-specific resolution of assumedBase, used for generation and comparison.
  let generatedBase = '/'
  // The base portion used by preload exclusions; unlike routePath, this can differ even
  // when the final public href is unchanged because publicPath already contained the base.
  let generatedBasePath = ''
  // Assigned in config(), which is the earliest async hook; every other hook runs after.
  /** @type {Awaited<ReturnType<typeof generate>> | undefined} */
  let gen
  let entrySeen = 0
  let warnedConflict = false
  /** @type {string | null} */
  let configFile = null
  let hasNitro = false
  let htmlEntryDetected = false
  let htmlTransforms = 0
  let fontPathPrefix = '/fonts/'
  let generatedFiles = new Set()
  let fontRulesAreScoped = true
  let warnedMissingHtmlTransform = false
  let failedBuildEnvironments = new WeakSet()
  let buildFailedWithoutEnvironment = false
  // Vite 8 resolves the top-level config and then resolves each environment again on the
  // same shared plugin. The raw config passed to those later calls does not identify the
  // environment, so client HTML state must stay sticky until this build actually finishes.
  let resetHtmlStateOnNextConfig = true

  const outDirFor = (r, output = opts.output) =>
    output === 'commit' ? resolve(r, '.tss-fonts') : join(r, 'node_modules', '.cache', 'tss-fonts')

  const currentDelivery = () =>
    resolvePreloadDelivery(opts, {
      preloadCount: gen?.preloads.length ?? 0,
      hasNitro,
      htmlEntryDetected,
      htmlTransforms,
    })

  const requireGeneration = () => {
    if (!gen) throw new Error('[tss-fonts] font generation has not completed')
    return gen
  }

  const isClientBuildContext = (context) => {
    const consumer = context.environment?.config?.consumer
    if (consumer !== undefined) return consumer === 'client'
    const environmentSsr = context.environment?.config?.build?.ssr
    return environmentSsr !== undefined ? !environmentSsr : !isSsrBuild
  }

  const clearBuildFailure = (environment) => {
    if (environment) failedBuildEnvironments.delete(environment)
    else buildFailedWithoutEnvironment = false
  }

  const recordBuildFailure = (environment) => {
    if (environment) failedBuildEnvironments.add(environment)
    else buildFailedWithoutEnvironment = true
    resetHtmlStateOnNextConfig = true
  }

  const buildFailed = (environment) =>
    environment ? failedBuildEnvironments.has(environment) : buildFailedWithoutEnvironment

  const api = {
    getDiagnostics() {
      return {
        root,
        options: opts,
        generation: gen,
        warnings: warningEvents.map((event) => event.message),
        warningEvents: warningEvents.map((event) => ({ ...event })),
        hasNitro,
        isSsrBuild,
        isLibraryBuild,
        selfHosts,
        entrySeen,
        configFile,
        paths: { assetPath, routePath, publicPath },
        delivery: currentDelivery(),
      }
    },
  }

  const fontRequestName = (rawUrl) => {
    const url = (rawUrl || '').split('?')[0]
    if (!url.startsWith(fontPathPrefix)) return null
    const name = url.slice(fontPathPrefix.length)
    return generatedFiles.has(name) ? name : null
  }

  const setFontPolicyHeaders = (res) => {
    res.setHeader('access-control-allow-origin', FONT_CORS_ORIGIN)
    res.setHeader('cache-control', FONT_CACHE_CONTROL)
  }

  const setFontHeaders = (res) => {
    res.setHeader('content-type', 'font/woff2')
    setFontPolicyHeaders(res)
  }

  return {
    name: 'tailwind-vite-font-kit',
    api,
    // MUST beat @tailwindcss/vite, which is also `pre`. Between two `pre` plugins the
    // array order decides, so this plugin has to be listed before tailwindcss().
    enforce: 'pre',
    sharedDuringBuild: true,

    async config(config, env) {
      // A restart creates and configures its replacement server before the old server
      // closes, so every serve config starts fresh. Build configs instead reset only once:
      // createBuilder's later client/SSR config calls belong to the same run.
      if (env.command === 'serve' || resetHtmlStateOnNextConfig) {
        htmlEntryDetected = false
        htmlTransforms = 0
        warnedMissingHtmlTransform = false
        resetHtmlStateOnNextConfig = false
      }
      for (const key of Object.keys(opts)) delete opts[key]
      assignDefined(opts, defaultOptions(), userOptions)
      warningEvents.length = 0
      entrySeen = 0
      warnedConflict = false
      configFile = null
      hasNitro = false
      failedBuildEnvironments = new WeakSet()
      buildFailedWithoutEnvironment = false
      gen = undefined
      generatedFiles = new Set()
      fontRulesAreScoped = true
      isServe = env.command === 'serve'
      isSsrBuild = env.command === 'build' && Boolean(config.build?.ssr)
      isLibraryBuild = env.command === 'build' && Boolean(config.build?.lib)
      root = resolve(config.root ?? process.cwd())
      await resolveFamilies(root)
      validateOptions(opts, configFile ? relative(root, configFile) : 'fonts() options')
      assumedBase = config.base
      generatedBase = viteBaseForCommand(config.base, { isServe, isSsrBuild })
      selfHosts = opts.families.some((f) => (f.strategy ?? 'self-host') === 'self-host')
      const paths = publicPathsForVite(generatedBase, opts.publicPath, {
        selfHost: selfHosts,
      })
      assetPath = paths.assetPath
      routePath = paths.routePath
      publicPath = paths.publicPath
      generatedBasePath = paths.basePath
      // When assets emit at the bundle root, font filenames and documents share one
      // namespace. No route pattern can select only the fonts without also selecting HTML.
      const fontsShareDocumentNamespace = paths.assetPath === '/'
      fontRulesAreScoped = !fontsShareDocumentNamespace
      // Paths that must NOT carry the preload header. Defaults cover the two that
      // dominate an SSR page's response count: the hashed build output and the fonts
      // themselves (which would otherwise preload themselves). A non-array (a string is
      // iterable — the loop below would mint one route rule PER CHARACTER) is a config
      // error, not something to pass through.
      const excludeOpt =
        typeof opts.preloadHeader === 'object' ? opts.preloadHeader?.exclude : undefined
      if (
        excludeOpt !== undefined &&
        (!Array.isArray(excludeOpt) || excludeOpt.some((p) => typeof p !== 'string'))
      ) {
        throw new Error(
          `[tss-fonts] \`preloadHeader.exclude\` must be an array of route patterns, ` +
            `e.g. ['/api/**']`,
        )
      }
      // Both defaults are request paths, so both carry the base: hashed build output is
      // requested at <base>/assets/**, and an unprefixed '/assets/**' matches none of it.
      // When fonts share the bundle root, no pattern can single them out — skip it.
      const assetsDir = (config.build?.assetsDir ?? 'assets').replace(/^\/+|\/+$/g, '')
      const preloadExcludes = excludeOpt ?? [
        ...(fontsShareDocumentNamespace ? [] : [`${routePath}/**`]),
        // An empty assetsDir puts chunks at the bundle root, where excluding the whole
        // namespace would also suppress preloads on documents.
        ...(assetsDir ? [posix.join(paths.basePath || '/', assetsDir) + '/**'] : []),
      ]
      if (opts.output !== 'cache' && opts.output !== 'commit') {
        throw new Error(`[tss-fonts] \`output\` must be 'cache' or 'commit', got '${opts.output}'`)
      }
      // A full-URL base intentionally uses local hrefs in dev and CDN hrefs in builds.
      // Keep that serve-only CSS in the disposable cache so `vite dev` cannot prune or
      // dirty the hermetic build artifacts committed in .tss-fonts/.
      const generationOutput =
        isServe && opts.output === 'commit' && FULL_URL_BASE_RE.test(config.base ?? '')
          ? 'cache'
          : opts.output
      const outDir = outDirFor(root, generationOutput)
      mkdirSync(outDir, { recursive: true })

      const t0 = Date.now()
      const generated = await generate(
        { ...opts, publicPath, output: generationOutput },
        outDir,
        log,
        warn,
      )
      gen = generated
      fontPathPrefix = routePath.replace(/\/$/, '') + '/'
      generatedFiles = new Set(generated.files)
      if (!generated.fromCache) log(`generation took ${Date.now() - t0}ms`)

      // If the user asked for real files on disk, write them HERE, not in buildStart.
      // Vite/Nitro copy publicDir before buildStart runs, so writing later means the
      // fonts only appear on the SECOND build — they 404 on the first.
      if (opts.assets !== 'emit') {
        const dir = resolve(root, opts.assets)
        mkdirSync(dir, { recursive: true })
        let written = 0
        let repaired = 0
        for (const f of generated.files) {
          const dest = join(dir, f)
          const source = readFileSync(join(generated.filesDir, f))
          if (!existsSync(dest)) {
            writeFileSync(dest, source)
            written++
            continue
          }
          // Same name, different bytes. Google's filenames carry a content hash, so this
          // is not a different font — it is a damaged copy of this one (an interrupted
          // write, a bad checkout, a truncating editor). Left alone it serves as a valid
          // font forever, because nothing downstream ever reads it again.
          const current = readFileSync(dest)
          if (current.length !== source.length || !current.equals(source)) {
            writeFileSync(dest, source)
            repaired++
          }
        }

        // Files this plugin plausibly wrote on an earlier run that are no longer needed.
        // Reported, never deleted: the directory belongs to the user, and a name collision
        // with something of theirs is possible. Matching on the family slug keeps the
        // report to fonts, not to everything in the directory.
        const slugs = opts.families.map((fa) => fa.name.toLowerCase().replace(/\s+/g, '-'))
        const orphans = readdirSync(dir).filter(
          (f) =>
            f.endsWith('.woff2') &&
            !generated.files.includes(f) &&
            slugs.some((s) => f.startsWith(`${s}-`)),
        )

        log(
          `${opts.assets}/: ${written} new, ${repaired} repaired, ${generated.files.length} total. ` +
            `Committing them is optional and does NOT make builds offline — use output:'commit'.`,
        )
        if (orphans.length) {
          warn(
            `${orphans.length} font file(s) in ${opts.assets}/ are no longer used by your config ` +
              `and were left in place:\n` +
              orphans.map((f) => `  ${f}`).join('\n') +
              `\nDelete them by hand once you are sure nothing else serves them.`,
          )
        }
      }

      // Nitro's vite plugin defu's `userConfig.nitro` into its own config
      // (nitro/dist/vite.mjs:413), which is how the plugin configures itself without
      // asking anyone to edit anything. Note the call is
      // `defu(ctx.pluginConfig, ctx.pluginConfig.config, userConfig.nitro)` — what this
      // returns is the LAST argument, i.e. the LOWEST priority. These rules are
      // defaults: a same-key rule in the user's own `nitro({ routeRules })` wins.
      /** @type {Record<string, {headers: Record<string, string>}>} */
      const routeRules = {}
      // Nitro serves public/ and any non-/assets path with NO cache-control at all,
      // while giving hashed /assets/* immutable. Safe here because the filenames
      // carry Google's content hash. Keyed on routePath, not publicPath — under a
      // full-URL base publicPath carries an origin, which no route pattern can match.
      // At the bundle root the fonts share every document's namespace and no pattern can
      // scope them safely, whether the site base itself is '/' or '/docs/'.
      if (!fontsShareDocumentNamespace) {
        routeRules[`${routePath}/**`] = {
          headers: {
            'cache-control': FONT_CACHE_CONTROL,
            'access-control-allow-origin': FONT_CORS_ORIGIN,
          },
        }
      }

      if (preloadHeaderEnabled(opts) && generated.preloads.length) {
        const link = generated.preloads
          .map((p) => `<${p.href}>; rel=preload; as=font; type=${p.type}; crossorigin`)
          .join(', ')
        routeRules['/**'] = { headers: { link } }

        // `/**` is the only pattern that covers every document route, but it covers
        // every OTHER response too. Nitro merges the `headers` of all matching rules
        // key-by-key, most-specific last (rou3 matchAll returns least-specific first),
        // so `/fonts/**` ADDS to `/**` rather than replacing it — without this, every
        // JS chunk and the woff2 itself ship a font preload header that only the
        // navigation response can act on.
        //
        // An empty value on a more specific rule is the only lever available: there is
        // no per-header delete, `headers: false` would drop the cache-control above
        // with it, and defu skips null/undefined instead of deleting.
        //
        // On static-host presets Nitro flattens route rules into a platform file rather
        // than running this logic (`writeCFHeaders` in nitro/dist/_presets.mjs emits
        // `  link: ` for an empty value, most-specific block first). Whether that host
        // honours a value-less line is its business — but the failure mode is benign:
        // the line is ignored and the `/**` header applies, which is where this started.
        // Nothing regresses, the saving is just not realised there.
        for (const pattern of preloadExcludes) {
          routeRules[pattern] = {
            headers: { ...routeRules[pattern]?.headers, link: '' },
          }
        }
      }

      // `nitro` is not a Vite config key — nitro's own plugin augments UserConfig, and
      // this package deliberately does not depend on its types to read one field back.
      return /** @type {import('vite').UserConfig} */ (
        /** @type {unknown} */ ({ nitro: { routeRules } })
      )
    },

    // Emit the woff2 into the CLIENT bundle. Nitro points the client environment's
    // outDir at `.output/public`, so `fileName: 'fonts/x.woff2'` lands at
    // `.output/public/fonts/x.woff2` and serves at `/fonts/x.woff2`.
    buildStart() {
      clearBuildFailure(this.environment)
      // emitFile throws "not supported in serve mode"; buildStart still runs for the dev
      // module graph. Dev is covered by the middleware below.
      if (isServe) return
      if (!isClientBuildContext(this)) return

      // Directory mode already wrote the files in config(); publicDir handles serving.
      if (opts.assets !== 'emit') return

      const generated = requireGeneration()
      for (const f of generated.files) {
        this.emitFile({
          type: 'asset',
          fileName: posix.join(assetPath.replace(/^\//, ''), f),
          source: readFileSync(join(generated.filesDir, f)),
        })
      }
      log(`emitted ${generated.files.length} woff2 into the client bundle`)
    },

    // Dev has no bundle, so serve the same bytes off the generated dir.
    // The `Link:` preload header and the immutable caching above are both delivered as
    // Nitro route rules. On plain Vite there is no Nitro, the `nitro` config key is
    // ignored, and nothing errors — fonts still generate, emit and serve, you just
    // quietly lose preloading and long-lived caching. That is worth one line of output,
    // because the symptom is "it works, but slower than the README says".
    configResolved(resolved) {
      // config() above runs before every OTHER plugin's config hook (this plugin is
      // enforce:'pre'), so a `base` a framework plugin injects from its own config()
      // was invisible there — only here is the final value known. The generated CSS and
      // the returned route rules are already built, so a mismatch cannot be repaired,
      // only reported: as a hard failure when self-hosted URLs are baked wrong, as a
      // warning when only route patterns can be off (CDN hrefs point at Google).
      const finalCommand = resolved.command ?? (isServe ? 'serve' : 'build')
      const finalIsServe = finalCommand === 'serve'
      const finalIsSsrBuild =
        finalCommand === 'build' &&
        (resolved.build?.ssr !== undefined ? Boolean(resolved.build.ssr) : isSsrBuild)
      const finalIsLibraryBuild =
        finalCommand === 'build' &&
        (resolved.build?.lib !== undefined ? Boolean(resolved.build.lib) : isLibraryBuild)
      const finalBase = viteBaseForCommand(resolved.base, {
        isServe: finalIsServe,
        isSsrBuild: finalIsSsrBuild,
      })
      // Compare what the base actually changes, not its spelling. Vite normalizes '' and
      // './' to '/' for an SSR build; when a later plugin enables SSR, config() may have
      // generated against './', but both forms still produce the same root-absolute font
      // hrefs, emitted paths and route rules. Treating that as a mismatch hard-failed a
      // correct build even though none of the generated output differed.
      const finalPaths = publicPathsForVite(finalBase, opts.publicPath, {
        selfHost: selfHosts,
        warn,
      })
      const pathsDiffer =
        finalPaths.assetPath !== assetPath ||
        finalPaths.publicPath !== publicPath ||
        finalPaths.routePath !== routePath ||
        finalPaths.basePath !== generatedBasePath
      if (pathsDiffer) {
        const msg =
          `Vite \`base\` resolved to ${JSON.stringify(resolved.base)}, but it was ` +
          `${JSON.stringify(assumedBase ?? '/')} in the config hook (resolved there as ` +
          `${JSON.stringify(generatedBase)}) when the fonts were generated — another ` +
          `plugin set it after this one read it. Set \`base\` directly in your Vite config ` +
          `so every plugin sees the same value.`
        if (selfHosts) {
          throw new Error(`[tss-fonts] ${msg} Until then the self-hosted font URLs are wrong.`)
        }
        warn(`${msg} (Only route-rule patterns are affected — the font URLs point at Google.)`)
      }
      hasNitro = Boolean(resolved.plugins?.some((p) => p.name?.includes('nitro')))
      isSsrBuild = finalIsSsrBuild
      isLibraryBuild = finalIsLibraryBuild
      // A shared plugin sees every environment's config before any environment builds.
      // Keep the client HTML capability once observed; a later server config has no HTML
      // entry of its own, but must not disable the client's transformIndexHtml hook.
      htmlEntryDetected ||= hasConventionalHtmlEntry(root, resolved, {
        isSsrBuild: finalIsSsrBuild,
        isLibraryBuild: finalIsLibraryBuild,
      })
      const delivery = currentDelivery()
      if (!finalIsSsrBuild && !finalIsLibraryBuild) {
        if (!hasNitro && delivery.htmlInjectionEnabled) {
          warn(
            `no Nitro plugin found; generated font preloads are configured for Vite HTML injection.`,
            'NO_NITRO_HTML_FALLBACK',
          )
        } else if (!hasNitro && delivery.manualOptOut) {
          warn(
            `automatic font preloading is disabled by configuration. Render \`fontPreloads\` ` +
              `from \`virtual:fonts\` yourself.`,
            'MANUAL_PRELOAD_DELIVERY',
          )
        } else if (!hasNitro && gen?.preloads.length) {
          warn(
            `no Nitro plugin and no conventional Vite HTML entry were found, so no automatic ` +
              `font preloads will be delivered. Render \`fontPreloads\` from \`virtual:fonts\` yourself.`,
            'NO_AUTOMATIC_PRELOAD_PATH',
          )
        }
      }
      if (selfHosts && (!hasNitro || !fontRulesAreScoped)) {
        warn(
          `Production immutable caching on ${publicPath}/ is the ` +
            `deployment host's responsibility (Vite dev and preview set it locally).`,
          'EXTERNAL_FONT_HEADERS',
        )
      }
    },

    transformIndexHtml(html) {
      if (!currentDelivery().htmlInjectionEnabled || !gen?.preloads.length) return
      htmlTransforms++
      const normalized = normalizeHtmlFontPreloads(html, gen.preloads)
      const tags = gen.preloads
        .filter((preload) => !normalized.present.has(preload.href))
        .map((preload) => ({
          tag: 'link',
          attrs: {
            rel: preload.rel,
            as: preload.as,
            type: preload.type,
            href: preload.href,
            crossorigin: preload.crossOrigin,
          },
          injectTo: /** @type {const} */ ('head-prepend'),
        }))
      if (!normalized.changed && !tags.length) return
      return { html: normalized.html, tags }
    },

    configureServer(server) {
      const generated = requireGeneration()
      // Generation happens during config resolution — a config-file edit needs a restart,
      // and configFileDependencies does not cover files loaded by a plugin, so watch it here.
      if (configFile) {
        server.watcher.add(configFile)
        server.watcher.on('change', (f) => {
          if (resolve(f) === configFile) {
            log(`${relative(root, configFile)} changed — restarting dev server`)
            server.restart()
          }
        })
      }
      // routePath, not publicPath: dev requests hit this server's paths, and under a
      // full-URL base publicPath would carry an origin no req.url ever starts with.
      server.middlewares.use((req, res, next) => {
        const name = fontRequestName(req.url)
        if (!name) return next()
        setFontHeaders(res)
        res.end(readFileSync(join(generated.filesDir, name)))
      })
    },

    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!fontRequestName(req.url) || typeof res.writeHead !== 'function') return next()
        const writeHead = res.writeHead
        res.writeHead = function (statusCode, ...args) {
          const candidate = typeof args[0] === 'string' ? args[1] : args[0]
          const headers =
            candidate && typeof candidate === 'object' && !Array.isArray(candidate)
              ? candidate
              : null
          const keyFor = (name) =>
            headers && Object.keys(headers).find((key) => key.toLowerCase() === name)
          const get = (name) => {
            const key = keyFor(name)
            return key ? headers[key] : this.getHeader?.(name)
          }
          const set = (name, value) => {
            if (headers) headers[keyFor(name) ?? name] = value
            else this.setHeader(name, value)
          }
          const contentType = String(get('content-type') ?? '')
          const isFontResponse =
            statusCode === 304 ||
            ((statusCode === 200 || statusCode === 206) && /^font\/woff2(?:;|$)/i.test(contentType))
          if (isFontResponse) {
            set('access-control-allow-origin', FONT_CORS_ORIGIN)
            set('cache-control', FONT_CACHE_CONTROL)
          }
          return writeHead.call(this, statusCode, ...args)
        }
        next()
      })
    },

    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_VIRTUAL_ID
    },
    load(id) {
      // Escape hatch for JSX preloads or typed handles. Not needed on the default path.
      if (id === RESOLVED_VIRTUAL_ID) {
        const generated = requireGeneration()
        return (
          `export const fontPreloads = ${JSON.stringify(generated.preloads)}\n` +
          `export const fontFamilies = ${JSON.stringify(
            Object.fromEntries(opts.families.map((f) => [f.themeVar, f.name])),
          )}\n`
        )
      }
    },

    transform: {
      filter: {
        id: {
          // `?url` and `?raw` hand you a JavaScript module, not CSS. Vite's own css
          // plugin and @tailwindcss/vite both exclude them; a plugin that doesn't will
          // eventually return modified JS and produce a rolldown PARSE_ERROR.
          include: [/\.css(\?|$)/],
          exclude: [/[?&](url|raw|worker)\b/, /node_modules/],
        },
      },
      handler(code, id) {
        // The entry is whatever stylesheet imports 'tailwindcss' — detect by CONTENT,
        // not by path, so it works regardless of what the project calls the file.
        if (!/@import\s+["']tailwindcss["']/.test(code)) return
        // Counted BEFORE the already-injected check: an entry that carries the import
        // (hand-added, or a re-transform) is still a seen entry, not a buildEnd failure.
        entrySeen++
        // Matches any generated name, not just the current key's: an entry carrying a
        // stale `fonts-<oldkey>.gen.css` (hand-added, or left by an earlier transform)
        // must not receive a second import beside it.
        if (CSS_NAME_RE.test(code)) return

        // We do NOT rewrite the user's CSS. `npx tss-fonts adopt` does that once, with a
        // printed diff you can review. Silently mutating source on every build hides a
        // regex with known blind spots (nested braces, multi-line @import).
        if (!warnedConflict) {
          const conflicts = []
          if (/@import\s+(?:url\()?["']?https?:\/\/fonts\.googleapis\.com/.test(code)) {
            conflicts.push(
              'a render-blocking Google @import (a second CSS request, and it declares the same families with no metric fallbacks)',
            )
          }
          const inlineTheme = /@theme\s+inline\s*\{([\s\S]*?)\n\}/.exec(code)
          if (inlineTheme) {
            const owned = opts.families
              .map((f) => f.themeVar)
              .filter((v) => new RegExp(`^\\s*${v}\\s*:`, 'm').test(inlineTheme[1]))
            if (owned.length) {
              conflicts.push(
                `${owned.join(', ')} inside \`@theme inline\` — \`inline\` bakes the literal into ` +
                  `--default-font-family and every .font-* utility, and it wins over ours`,
              )
            }
          }
          if (conflicts.length) {
            warnedConflict = true
            this.warn(
              `[tss-fonts] found in your Tailwind entry:\n` +
                conflicts.map((c) => `  - ${c}`).join('\n') +
                `\nRun \`npx tss-fonts adopt\` to migrate (prints a diff, supports --dry-run).`,
            )
          }
        }

        // Tailwind resolves @imports with enhanced-resolve from the IMPORTING FILE's
        // directory, so the specifier must be relative to the entry, not the root.
        let spec = relative(dirname(id.split('?')[0]), requireGeneration().cssPath)
          .split(/[\\/]/)
          .join('/')
        if (!spec.startsWith('.')) spec = './' + spec
        log(`injected @import into ${id.split('/').pop()}`)
        return code.replace(/(@import\s+["']tailwindcss["'];?)/, `$1\n@import '${spec}';`)
      },
    },

    buildEnd(error) {
      if (error) {
        recordBuildFailure(this.environment)
        return
      }
      // The Tailwind entry is only guaranteed to pass through the CLIENT environment;
      // an SSR/nitro pass that never transforms CSS must not report a false failure.
      if (!isClientBuildContext(this)) return
      // Two `pre` plugins resolve by array order. If someone moves fonts() after
      // tailwindcss(), injection silently stops and the app loses every font — fail loud.
      if (entrySeen === 0) {
        recordBuildFailure(this.environment)
        this.error(
          "[tss-fonts] never saw a stylesheet containing `@import 'tailwindcss'`, so the " +
            '@theme block was NOT injected and no fonts were applied.\n' +
            '  - Is fonts() listed BEFORE tailwindcss() in your plugins array?\n' +
            '  - Is your Tailwind entry actually imported by the app?',
        )
      }
    },

    closeBundle() {
      resetHtmlStateOnNextConfig = true
      // Vite transforms and emits index.html after Rollup's buildEnd hook. Check here so a
      // valid HTML build is not reported missing merely because its transform ran later.
      const environmentBuild = this.environment?.config?.build
      const environmentIsSsrBuild =
        environmentBuild?.ssr !== undefined ? Boolean(environmentBuild.ssr) : isSsrBuild
      const environmentIsLibraryBuild =
        environmentBuild?.lib !== undefined ? Boolean(environmentBuild.lib) : isLibraryBuild
      const environmentBuildFailed = buildFailed(this.environment)
      if (environmentIsSsrBuild || environmentIsLibraryBuild || environmentBuildFailed) return
      if (!isClientBuildContext(this)) return
      const delivery = currentDelivery()
      if (
        !isServe &&
        delivery.htmlInjectionEnabled &&
        !delivery.headerActive &&
        delivery.htmlTransforms === 0 &&
        !warnedMissingHtmlTransform
      ) {
        warnedMissingHtmlTransform = true
        warn(
          `HTML preload injection was enabled, but Vite transformed no HTML entry. No automatic ` +
            `font preloads were emitted; render \`fontPreloads\` from \`virtual:fonts\` yourself.`,
          'NO_AUTOMATIC_PRELOAD_PATH',
        )
      }
    },
  }
}

export default fonts
