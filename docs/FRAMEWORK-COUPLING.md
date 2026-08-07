# Framework coupling

What this package actually depends on, and what is only named after.

Short version: it is a **Vite + Tailwind v4** plugin. Tailwind is load-bearing and not
removable. TanStack Start is one functional touchpoint plus some cosmetics.

## TanStack Start / Nitro

### Load-bearing (one thing)

`src/index.mjs:150` — `config()` returns `{ nitro: { routeRules } }`. Nitro's Vite plugin
`defu`s `userConfig.nitro` into its own config, so this is how the plugin configures itself
without asking the user to edit anything.

Those route rules carry two things:

- `cache-control: public, max-age=31536000, immutable` on `${publicPath}/**`. Nitro serves
  non-`/assets` paths with no cache-control at all, so without this the woff2 are
  revalidated on every load. Safe because the filenames carry Google's content hash.
- The preload `Link:` header on `/**`, which is the entire zero-app-edit preload story.

On plain Vite there is no Nitro, so the key is ignored. Nothing errors — fonts still
generate, emit, and serve — you just silently lose preloads and long-lived caching. That is
the one behaviour that would need a different mechanism (an HTML transform, or a
dev/preview middleware) to survive outside Nitro.

### Opt-in extra

`extras/server.ts` is 100% Start-specific: `createStartHandler`, `defaultStreamHandler`, and
Start's `onEarlyHints` static/dynamic phases. It exists for the 103 Early Hints path, which
is the only preload mechanism that can beat a slow route loader. It is shipped but never
installed automatically, and the plugin does not reference it.

### Cosmetic only

- `bin/tss-fonts.mjs:243-253` and the `docs` strings in `registry/registry.json` print an
  example plugins array containing `nitro()` and `tanstackStart()`.
- `src/detect.mjs:7` lists `.tanstack` among ignored directories.
- The `tss-` binary prefix and the `[tss-fonts]` log prefix.

`package.json` already reflects the real scope — the package is named
`tailwind-vite-font-kit`, not `tanstack-*`.

## Tailwind v4

Not removable, and specifically **v4** — v3 has no `@theme`.

- The transform only fires on a stylesheet matching `@import "tailwindcss"`
  (`src/detect.mjs:37`, `src/index.mjs:218`), detected by content rather than path.
  `buildEnd()` hard-errors if it never saw one (`src/index.mjs:264`), because two `pre`
  plugins resolve by array order and a misordered `fonts()` would otherwise lose every font
  silently.
- `src/generate.mjs:170` emits a `@theme { --font-sans: … }` block. The whole config schema
  is keyed on `` themeVar: `--font-${string}` `` (`index.d.ts:10`).
- The `@theme inline` conflict warning (`src/index.mjs:229`) and the `adopt` codemod
  (`src/codemod-css.mjs`) both operate on Tailwind semantics — `inline` bakes the literal
  into `--default-font-family` and every `.font-*` utility, and wins over ours.

## Vite

- `enforce: 'pre'`, and must precede `@tailwindcss/vite`, which is also `pre`.
- `sharedDuringBuild: true` — generation happens once in `config()`, the earliest async
  hook, rather than in `buildStart()`, which fires per-environment and would race Tailwind's
  transform in a multi-environment build.
- `emitFile` in `buildStart()` for the client bundle; `configureServer()` middleware for
  dev, which has no bundle.
- Peer range is `vite: ^6 || ^7 || ^8`.

## If you wanted to drop TanStack entirely

Delete `extras/server.ts`, reword the CLI and registry snippets, and replace the
`{ nitro: { routeRules } }` return with a portable preload mechanism. What is left is a
general Vite + Tailwind v4 plugin. Nothing else in `src/` would change.
