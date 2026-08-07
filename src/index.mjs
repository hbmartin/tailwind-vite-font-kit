// tailwind-font-kit — the whole Google-font pipeline as ONE Vite plugin.
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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { generate } from './generate.mjs'

const VIRTUAL_ID = 'virtual:fonts'
const RESOLVED_VIRTUAL_ID = '\0virtual:fonts'

/** @param {import('../index.d.ts').FontsOptions} userOptions */
export function fonts(userOptions = {}) {
  const opts = {
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
  }
  const log = (m) => !opts.silent && console.log(`[tss-fonts] ${m}`)

  // Families may come from the call site OR from `fonts.config.mjs` in the project root.
  // The config file is what `npx shadcn add` drops, since shadcn can place files but
  // cannot edit vite.config.ts — so `fonts()` with no arguments is the shadcn path.
  // Explicit options always win.
  async function resolveFamilies(r) {
    if (opts.families?.length) return
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
      const mod = await import(pathToFileURL(p).href)
      Object.assign(opts, { ...(mod.default ?? mod), ...userOptions })
      log(`loaded ${name}`)
      return
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
  let gen = null
  let entrySeen = 0
  let warnedConflict = false

  const outDirFor = (r) =>
    opts.output === 'commit'
      ? resolve(r, typeof opts.output === 'string' && opts.output !== 'commit' ? opts.output : '.tss-fonts')
      : join(r, 'node_modules', '.cache', 'tss-fonts')

  return {
    name: 'tailwind-font-kit',
    // MUST beat @tailwindcss/vite, which is also `pre`. Between two `pre` plugins the
    // array order decides, so this plugin has to be listed before tailwindcss().
    enforce: 'pre',
    sharedDuringBuild: true,

    async config(config, env) {
      isServe = env.command === 'serve'
      root = resolve(config.root ?? process.cwd())
      await resolveFamilies(root)
      const outDir = outDirFor(root)
      mkdirSync(outDir, { recursive: true })

      const t0 = Date.now()
      gen = await generate(opts, outDir, log)
      if (!gen.fromCache) log(`generation took ${Date.now() - t0}ms`)

      // If the user asked for real files on disk, write them HERE, not in buildStart.
      // Vite/Nitro copy publicDir before buildStart runs, so writing later means the
      // fonts only appear on the SECOND build — they 404 on the first.
      if (opts.assets !== 'emit') {
        const dir = resolve(root, opts.assets)
        mkdirSync(dir, { recursive: true })
        let written = 0
        for (const f of gen.files) {
          const dest = join(dir, f)
          // Additive only: never delete from a directory the user also owns.
          if (!existsSync(dest)) {
            writeFileSync(dest, readFileSync(join(gen.filesDir, f)))
            written++
          }
        }
        log(
          `wrote ${written} new woff2 to ${opts.assets}/ (${gen.files.length} total). ` +
            `Committing them is optional and does NOT make builds offline — use output:'commit'.`,
        )
      }

      // Nitro's vite plugin defu's `userConfig.nitro` into its own config
      // (nitro/dist/vite.mjs:413), so the plugin can configure itself.
      const routeRules = {
        // Nitro serves public/ and any non-/assets path with NO cache-control at all,
        // while giving hashed /assets/* immutable. Safe here because the filenames
        // carry Google's content hash.
        [`${opts.publicPath}/**`]: {
          headers: {
            'cache-control': 'public, max-age=31536000, immutable',
            'access-control-allow-origin': '*',
          },
        },
      }

      if (opts.preloadHeader && gen.preloads.length) {
        const link = gen.preloads
          .map((p) => `<${p.href}>; rel=preload; as=font; type=${p.type}; crossorigin`)
          .join(', ')
        routeRules['/**'] = { headers: { link } }
      }

      return { nitro: { routeRules } }
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
          fileName: posix.join(opts.publicPath.replace(/^\//, ''), f),
          source: readFileSync(join(gen.filesDir, f)),
        })
      }
      log(`emitted ${gen.files.length} woff2 into the client bundle`)
    },

    // Dev has no bundle, so serve the same bytes off the generated dir.
    configureServer(server) {
      const prefix = opts.publicPath.replace(/\/$/, '') + '/'
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
        if (code.includes('fonts.gen.css')) return

        // We do NOT rewrite the user's CSS. `npx tss-fonts adopt` does that once, with a
        // printed diff you can review. Silently mutating source on every build hides a
        // regex with known blind spots (nested braces, multi-line @import).
        if (!warnedConflict) {
          const conflicts = []
          if (/@import\s+(?:url\()?["']?https?:\/\/fonts\.googleapis\.com/.test(code)) {
            conflicts.push('a render-blocking Google @import (a second CSS request, and it declares the same families with no metric fallbacks)')
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
        let spec = relative(dirname(id.split('?')[0]), gen.cssPath).split(/[\\/]/).join('/')
        if (!spec.startsWith('.')) spec = './' + spec
        entrySeen++
        log(`injected @import into ${id.split('/').pop()}`)
        return code.replace(/(@import\s+["']tailwindcss["'];?)/, `$1\n@import '${spec}';`)
      },
    },

    buildEnd() {
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
