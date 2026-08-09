# Framework coupling

What this package actually depends on, and what is only named after.

Short version: it is a **Vite + Tailwind v4** plugin. Tailwind is load-bearing and not
removable. TanStack Start is one functional touchpoint plus some cosmetics.

## TanStack Start / Nitro

### Load-bearing (one thing)

`config()` returns `{ nitro: { routeRules } }`. Nitro's Vite plugin `defu`s
`userConfig.nitro` into its own config, so this is how the plugin configures itself without
asking the user to edit anything.

The precedence runs the other way from what you might assume. The call is
`defu(ctx.pluginConfig, ctx.pluginConfig.config, userConfig.nitro)` (`nitro/dist/vite.mjs`),
and what this plugin returns lands in `userConfig.nitro` — the LAST argument, so the
**lowest** priority. These rules are defaults: a same-key rule in the user's own
`nitro({ routeRules })` wins over them. That is the behaviour you want, but it is the
opposite of what the code comment here used to claim.

Those route rules carry two things:

- `cache-control: public, max-age=31536000, immutable` on `${publicPath}/**`. Nitro serves
  non-`/assets` paths with no cache-control at all, so without this the woff2 are
  revalidated on every load. Safe because the filenames carry Google's content hash.
- The preload `Link:` header on `/**`, which is the entire zero-app-edit preload story.

`/**` is also the only pattern that covers every document route, and it covers everything
else too. Nitro resolves route rules by merging EVERY matching rule's `headers` map
key-by-key, most-specific last (rou3's `matchAll` returns least-specific first), so
`/fonts/**` *adds to* `/**` rather than replacing it. There is no per-header delete:
`headers: false` drops the whole merged map for that path, and defu skips `null`/`undefined`
rather than deleting. The one lever available is an empty value on a more specific rule, so
`${publicPath}/**` and `/assets/**` get `link: ''`, which browsers read as zero links.
Configurable via `preloadHeader.exclude`.

On plain Vite there is no Nitro, so the key is ignored. Nothing errors — fonts still
generate, emit, and serve — you just silently lose preloads and long-lived caching. That is
the one behaviour that would need a different mechanism (an HTML transform, or a
dev/preview middleware) to survive outside Nitro.

### Opt-in extra

`src/start-server.mjs`, exported as `tailwind-vite-font-kit/start-server`, is 100%
Start-specific: `createStartHandler`, `defaultStreamHandler`, and Start's `onEarlyHints`
static/dynamic phases. It exists for the 103 Early Hints path, which is the only preload
mechanism that can beat a slow route loader.

Nothing on the default path imports it: `@tanstack/react-start` is an optional peer, the
import is lazy, and the plugin never references the module. Every cast against Start
internals is confined to one adapter function, so a Start release that moves them breaks one
thing with one obvious cause.

### Cosmetic only

- `bin/tss-fonts.mjs`'s `snippet()` and the `docs` strings in `registry/registry.json`
  print an example plugins array containing `nitro()` and `tanstackStart()`.
- `src/detect.mjs` lists `.tanstack` among ignored directories.
- The `tss-` binary prefix and the `[tss-fonts]` log prefix.

`package.json` already reflects the real scope — the package is named
`tailwind-vite-font-kit`, not `tanstack-*`.

## Tailwind v4

Not removable, and specifically **v4** — v3 has no `@theme`.

- The transform only fires on a stylesheet matching `@import "tailwindcss"`
  (`TAILWIND_ENTRY_RE` in `src/detect.mjs`, the `transform` hook in `src/index.mjs`), detected by content rather than path.
  `buildEnd()` hard-errors if it never saw one, because two `pre`
  plugins resolve by array order and a misordered `fonts()` would otherwise lose every font
  silently.
- `src/generate.mjs` emits a `@theme { --font-sans: … }` block. The whole config schema
  is keyed on `` themeVar: `--font-${string}` ``, which `src/config.mjs` also validates.
- The `@theme inline` conflict warning and the `adopt` codemod
  (`src/codemod-css.mjs`) both operate on Tailwind semantics — `inline` bakes the literal
  into `--default-font-family` and every `.font-*` utility, and wins over ours.

## Vite

- `enforce: 'pre'`, and must precede `@tailwindcss/vite`, which is also `pre`.
- The `transform` hook uses the `{ filter, handler }` object form, which needs Rollup
  >=4.38. That is why the peer range starts at Vite 7 rather than 6: on Vite 6.0-6.2 the
  filter is silently ignored and the hook runs on every module. CI builds the fixture at the
  floor of each supported major so the range is tested rather than asserted.
- `sharedDuringBuild: true` — generation happens once in `config()`, the earliest async
  hook, rather than in `buildStart()`, which fires per-environment and would race Tailwind's
  transform in a multi-environment build.
- `emitFile` in `buildStart()` for the client bundle; `configureServer()` middleware for
  dev, which has no bundle.
- Peer range is `vite: ^7 || ^8`.

## If you wanted to drop TanStack entirely

Delete `src/start-server.mjs` and its export, reword the CLI and registry snippets, and
replace the `{ nitro: { routeRules } }` return with a portable preload mechanism. What is
left is a general Vite + Tailwind v4 plugin. Nothing else in `src/` would change.
