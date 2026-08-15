// tailwind-vite-font-kit — the whole Google-font pipeline as ONE Vite plugin.
//
//   plugins: [ nitro(), fonts({ families: [...] }), tailwindcss(), tanstackStart(), viteReact() ]
//
// Your styles.css and __root.tsx are never touched. What happens, in the order it must:
//
//   config()          fetch css2 + download woff2 (cached), write fonts.gen.css, and hand
//                     Nitro two route rules: `immutable` on the fonts, and a `Link:`
//                     preload header on documents. `config` is the earliest async hook
//                     and runs ONCE per process — `buildStart` fires per-environment and
//                     would race Tailwind's transform in a multi-environment build.
//   transform()       rewrite the Tailwind ENTRY in-memory to `@import` that file.
//                     Tailwind bypasses Vite for its own @imports, so the target must be
//                     a real file — but the entry itself does pass through Vite.
//   buildStart()      emitFile the woff2 into the CLIENT bundle.
//   configureServer() serve the same woff2 from the cache in dev.
//
// Preloads ship as an HTTP `Link:` header, not a <link> in head(). That is what makes
// this zero-app-edit, and it is order-free — React 19 hoists stylesheets above any
// <link> you write, so a JSX preload lands after them. Measured equivalent:
// 608ms FCP / 586ms fonts (header) vs 604 / 579 (JSX), 9 runs at 150ms RTT.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, posix } from 'node:path'
import { CSS_NAME_RE, generate } from './generate.mjs'
import { assertConfigShape, loadFontsConfig, validateFamilies } from './config.mjs'

const VIRTUAL_ID = 'virtual:fonts'
const RESOLVED_VIRTUAL_ID = '\0virtual:fonts'

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
function viteBaseForCommand(base, { isServe = false } = {}) {
  if (base == null) return '/'
  if (base === '' || base === './') return isServe ? '/' : './'
  if (base.startsWith('.')) return '/'

  const external = /^(?:https?:)?\/\//.test(base)
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
 * @param {{isServe?: boolean, selfHost?: boolean,
 *          warn?: (message: string) => void}} [context]
 */
function publicPathsForVite(
  base,
  publicPath,
  { isServe = false, selfHost = true, warn = () => {} } = {},
) {
  const assetPath = normalizePublicPath(publicPath)
  if (!base || base === '/') {
    return { assetPath, publicPath: assetPath, routePath: assetPath, basePath: '' }
  }
  // A full-URL base (CDN deploy). Only hrefs carry the origin, and only in the build —
  // dev serves off the local server, where just the path portion applies. The path
  // portion stays in the route patterns: an origin-pull CDN forwards it to this server.
  if (/^(?:https?:)?\/\//.test(base)) {
    let url
    try {
      url = new URL(base.startsWith('//') ? `https:${base}` : base)
    } catch {
      warn(`could not parse Vite \`base\` ${JSON.stringify(base)} — font URLs will not carry it.`)
      return { assetPath, publicPath: assetPath, routePath: assetPath, basePath: '' }
    }
    const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
    const routePath = assetPath === '/' ? basePath || '/' : posix.join(basePath || '/', assetPath)
    return {
      assetPath,
      publicPath: isServe ? routePath : url.origin + routePath,
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
  const opts = /** @type {import('./generate.mjs').ResolvedOptions} */ ({
    subsets: ['latin'],
    publicPath: '/fonts',
    // 'emit' (default) — Rollup emits the woff2 into the client bundle; nothing lands
    // in your source tree. Any other value is a directory path relative to the project
    // root (e.g. 'public/fonts'), for when you want real files you can inspect or serve
    // without the plugin. Note that committing those files does NOT make builds
    // hermetic — the generated CSS still lives in `output`. Use output:'commit' for that.
    assets: 'emit',
    output: 'cache', // 'cache' | 'commit'
    preloadHeader: true,
    silent: false,
    ...userOptions,
  })
  /** @param {string} m */
  const log = (m) => !opts.silent && console.log(`[tss-fonts] ${m}`)
  // Deliberately NOT gated on `silent`. `silent` means "stop narrating a build that is
  // going fine", not "hide it when the metric fallbacks — the entire reason this package
  // exists — were silently not emitted". Everything routed here is a case where the build
  // succeeds and the result is wrong.
  /** @param {string} m */
  const warn = (m) => console.warn(`[tss-fonts] ${m}`)

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
      Object.assign(opts, { ...cfg, ...userOptions })
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
  // The URL in generated CSS includes Vite's base; emitted Rollup filenames must not.
  let assetPath = '/fonts'
  // The server-side request path for fonts — Nitro patterns and the dev middleware use
  // this, never `opts.publicPath`, which under a full-URL base carries the CDN origin.
  let routePath = '/fonts'
  // Whether any family self-hosts: decides how loudly base problems are reported.
  let selfHosts = true
  // What config() saw as `base`, checked against the final value in configResolved().
  /** @type {string | undefined} */
  let assumedBase
  // Vite's command-specific resolution of assumedBase, used for generation and comparison.
  let generatedBase = '/'
  // Assigned in config(), which is the earliest async hook; every other hook runs after.
  /** @type {Awaited<ReturnType<typeof generate>>} */
  let gen
  let entrySeen = 0
  let warnedConflict = false
  /** @type {string | null} */
  let configFile = null

  const outDirFor = (r) =>
    opts.output === 'commit'
      ? resolve(r, '.tss-fonts')
      : join(r, 'node_modules', '.cache', 'tss-fonts')

  return {
    name: 'tailwind-vite-font-kit',
    // MUST beat @tailwindcss/vite, which is also `pre`. Between two `pre` plugins the
    // array order decides, so this plugin has to be listed before tailwindcss().
    enforce: 'pre',
    sharedDuringBuild: true,

    async config(config, env) {
      isServe = env.command === 'serve'
      root = resolve(config.root ?? process.cwd())
      await resolveFamilies(root)
      assumedBase = config.base
      generatedBase = viteBaseForCommand(config.base, { isServe })
      selfHosts = opts.families.some((f) => (f.strategy ?? 'self-host') === 'self-host')
      const paths = publicPathsForVite(generatedBase, opts.publicPath, {
        isServe,
        selfHost: selfHosts,
        warn,
      })
      assetPath = paths.assetPath
      routePath = paths.routePath
      opts.publicPath = paths.publicPath
      // When assets emit at the bundle root, font filenames and documents share one
      // namespace. No route pattern can select only the fonts without also selecting HTML.
      const fontsShareDocumentNamespace = paths.assetPath === '/'
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
      const preloadExcludes = excludeOpt ?? [
        ...(fontsShareDocumentNamespace ? [] : [`${routePath}/**`]),
        posix.join(paths.basePath || '/', 'assets') + '/**',
      ]
      if (opts.output !== 'cache' && opts.output !== 'commit') {
        throw new Error(`[tss-fonts] \`output\` must be 'cache' or 'commit', got '${opts.output}'`)
      }
      const outDir = outDirFor(root)
      mkdirSync(outDir, { recursive: true })

      const t0 = Date.now()
      gen = await generate(opts, outDir, log, warn)
      if (!gen.fromCache) log(`generation took ${Date.now() - t0}ms`)

      // If the user asked for real files on disk, write them HERE, not in buildStart.
      // Vite/Nitro copy publicDir before buildStart runs, so writing later means the
      // fonts only appear on the SECOND build — they 404 on the first.
      if (opts.assets !== 'emit') {
        const dir = resolve(root, opts.assets)
        mkdirSync(dir, { recursive: true })
        let written = 0
        let repaired = 0
        for (const f of gen.files) {
          const dest = join(dir, f)
          const source = readFileSync(join(gen.filesDir, f))
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
            !gen.files.includes(f) &&
            slugs.some((s) => f.startsWith(`${s}-`)),
        )

        log(
          `${opts.assets}/: ${written} new, ${repaired} repaired, ${gen.files.length} total. ` +
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
            'cache-control': 'public, max-age=31536000, immutable',
            'access-control-allow-origin': '*',
          },
        }
      }

      if (opts.preloadHeader && gen.preloads.length) {
        const link = gen.preloads
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
      // emitFile throws "not supported in serve mode"; buildStart still runs for the dev
      // module graph. Dev is covered by the middleware below.
      if (isServe) return
      if (this.environment?.config?.consumer !== 'client') return

      // Directory mode already wrote the files in config(); publicDir handles serving.
      if (opts.assets !== 'emit') return

      for (const f of gen.files) {
        this.emitFile({
          type: 'asset',
          fileName: posix.join(assetPath.replace(/^\//, ''), f),
          source: readFileSync(join(gen.filesDir, f)),
        })
      }
      log(`emitted ${gen.files.length} woff2 into the client bundle`)
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
      const finalBase = viteBaseForCommand(resolved.base, { isServe })
      if (finalBase !== generatedBase) {
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
      if (!opts.preloadHeader || !gen?.preloads.length) return
      if (resolved.plugins?.some((p) => p.name?.includes('nitro'))) return
      warn(
        `no Nitro plugin found, so the preload \`Link:\` header and \`immutable\` caching ` +
          `on ${opts.publicPath}/ were not applied — those ship as Nitro route rules.\n` +
          `  The fonts and the metric fallbacks still work. To preload without Nitro, set ` +
          `\`preloadHeader: false\` and render the links yourself:\n` +
          `    import { fontPreloads } from 'virtual:fonts'`,
      )
    },

    configureServer(server) {
      // Generation happens once, in config() — a config-file edit needs a restart, and
      // configFileDependencies does not cover files loaded by a plugin, so watch it here.
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
      const prefix = routePath.replace(/\/$/, '') + '/'
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0]
        if (!url.startsWith(prefix)) return next()
        const name = url.slice(prefix.length)
        if (!gen.files.includes(name)) return next()
        res.setHeader('content-type', 'font/woff2')
        res.setHeader('access-control-allow-origin', '*')
        res.setHeader('cache-control', 'public, max-age=31536000, immutable')
        res.end(readFileSync(join(gen.filesDir, name)))
      })
    },

    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_VIRTUAL_ID
    },
    load(id) {
      // Escape hatch for JSX preloads or typed handles. Not needed on the default path.
      if (id === RESOLVED_VIRTUAL_ID) {
        return (
          `export const fontPreloads = ${JSON.stringify(gen.preloads)}\n` +
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
        let spec = relative(dirname(id.split('?')[0]), gen.cssPath)
          .split(/[\\/]/)
          .join('/')
        if (!spec.startsWith('.')) spec = './' + spec
        log(`injected @import into ${id.split('/').pop()}`)
        return code.replace(/(@import\s+["']tailwindcss["'];?)/, `$1\n@import '${spec}';`)
      },
    },

    buildEnd() {
      // The Tailwind entry is only guaranteed to pass through the CLIENT environment;
      // an SSR/nitro pass that never transforms CSS must not report a false failure.
      if (this.environment && this.environment.config?.consumer !== 'client') return
      // Two `pre` plugins resolve by array order. If someone moves fonts() after
      // tailwindcss(), injection silently stops and the app loses every font — fail loud.
      if (entrySeen === 0) {
        this.error(
          "[tss-fonts] never saw a stylesheet containing `@import 'tailwindcss'`, so the " +
            '@theme block was NOT injected and no fonts were applied.\n' +
            '  - Is fonts() listed BEFORE tailwindcss() in your plugins array?\n' +
            '  - Is your Tailwind entry actually imported by the app?',
        )
      }
    },
  }
}

export default fonts
