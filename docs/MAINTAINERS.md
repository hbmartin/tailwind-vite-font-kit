# Maintaining tailwind-font-kit

Everything a future you needs to change this safely. The README is for users; this is for
whoever has to touch the internals.

## Layout

```
src/index.mjs        the Vite plugin — hooks, ordering, the Link: header, the @import injection
src/generate.mjs     build-time generation: css2 fetch, woff2 download, caching, retry
src/metrics.mjs      FALLBACK_TARGETS + the size-adjust / override math
src/opsz.mjs         optical-size axis detection and URL pinning
src/detect.mjs       project detection: Tailwind entry, vite config, fonts already in the CSS
src/codemod-css.mjs  the one-time CSS migration
src/diff.mjs         unified diff printer
bin/tss-fonts.mjs    the `adopt` / `init` CLI
registry/            shadcn registry source + built output (registry/r is committed)
test/                node:test unit tests + a minimal Vite fixture for CI
scripts/             CI helpers: collect-metrics.mjs, write-note.sh
extras/              opt-in files that are shipped but never installed automatically
harness/             measurement tools — NOT in package.json `files`, dev only
docs/                this file + FRAMEWORK-COUPLING.md (what Vite/Tailwind/TanStack each own)
```

## Setup

```bash
pnpm install
pnpm test                 # unit tests, no network, ~150 ms
pnpm registry:build       # regenerate registry/r from registry/registry.json
```

To try it against a real app, link rather than `file:` — pnpm **copies** a `file:` dependency,
so your edits will not be picked up and you will chase a ghost for ten minutes:

```bash
cd ../some-tanstack-app
pnpm add -D link:../font-kit
```

## Testing

`pnpm test` covers the parts that fail silently: the per-weight `size-adjust` math and the
ascent/descent pre-compensation, `opsz` detection and pinning, the CSS codemod's idempotency and
its brace-matching, and the URL/CSS parsers. No network, no browser.

What unit tests **cannot** cover, and therefore must be checked by hand before a release:

| Path | How to check |
|---|---|
| `@import` injection | build any Tailwind app; assert `--default-font-family:var(--font-sans)` in the built CSS |
| Dev parity | `pnpm dev`, fetch the entry CSS with `accept: text/css`, expect the same `--font-sans` |
| Nitro route rules | `curl -I /fonts/x.woff2` → `immutable` + CORS; `curl -I /` → `link:` header |
| `assets` as a directory | must appear in the output on the **first** build (see the trap below) |
| `output: 'commit'` | clear the cache, rebuild, expect `cache hit … no network` |
| shadcn install | serve `registry/r` statically, install by URL and by `@ns/fonts` |

The `harness/` scripts produce the numbers quoted in the README:

```bash
node harness/sweep.mjs --label x --base http://localhost:3000 --runs 3    # CLS per probe x viewport
node harness/waterfall.mjs --base http://localhost:3000 --runs 9          # FCP / fonts-applied
node harness/targets.mjs http://localhost:3000                            # per-fallback accuracy
node harness/clswidth.mjs                                                 # container-width sweep
```

Always use `--runs 9` on `waterfall.mjs`. FCP is noisy enough that a 3-run median once produced a
844 ms reading against a true value of 644 ms, and a whole conclusion was written on top of it.
Use `clswidth.mjs` for anything that changes advance width: a config reading 0.0001 at two viewports
was shifting 51 px at 2 of 36 container widths.

## CI and the metrics notes

Two workflows:

- **`ci.yml`** — every push and PR. Unit tests, registry build + staleness check, builds
  `test/fixture` (a plain Vite + Tailwind app, so it is fast and needs no browser), collects static
  metrics, and asserts invariants. On pushes to `main` it writes the metrics to a git note.
- **`cls-weekly.yml`** — Mondays. Clones the reference app, points it at this commit, builds, runs
  the puppeteer sweep, appends CLS to the same note, and opens (or comments on) an issue labelled
  `cls-regression` if the worst median CLS exceeds the threshold (default `0.02`) or the job fails.

Reading the metrics:

```bash
git fetch origin 'refs/notes/*:refs/notes/*'
git log --notes=metrics
git notes --ref=metrics show <sha>
```

`scripts/write-note.sh` fetches, appends, pushes, and retries on rejection — concurrent runs race on
`refs/notes/metrics`. A failed note **warns rather than failing the build**; the numbers are also in
the job summary.

The asserted invariants are each a bug that shipped or nearly shipped: `googleapisRefs: 0`,
`gstaticRefs: 0`, `blinkMacSystemFontLocals: 0`, `leakedThemeAtRule: 0`,
`defaultFontFamilyIsVar: 1`, `themeVarsWithFallback: 2`. If you change the fixture's font count,
update the expected `themeVarsWithFallback`.

## Releasing

1. `pnpm test` and a manual pass over the table above.
2. Bump `version` in `package.json`.
3. `pnpm registry:build` and commit `registry/r` — **CI fails if it is stale**, and the raw
   GitHub URL users install from serves straight out of `registry/r` on `main`.
4. Tag and push, including tags.
5. `npm publish --access public`.
6. Verify the real path from a throwaway project:
   `npx shadcn@latest add https://raw.githubusercontent.com/hbmartin/tailwind-font-kit/main/registry/r/fonts.json`

The registry needs **no hosting**: `raw.githubusercontent.com` is a static file host and shadcn
accepts it. If you later want a nicer URL, any static host works — the only requirement is that it
serves the JSON and, for the namespaced form, that the URL template contains `{name}`.

Note that `registry/r` on `main` is what users get, so a registry change reaches them **without an
npm release** — but the `devDependencies` entry in it pins the package name only, not a version, so
they always get the latest published package.

## Traps, and why the code looks the way it does

Each of these cost real debugging time. None of them fails loudly.

- **Generation runs in `config()`, not `buildStart()`.** `buildStart` fires once per environment
  (client, ssr, nitro) and would race Tailwind's transform. `config` is the earliest async hook and
  runs once per process.
- **Writing `assets`-directory files also happens in `config()`.** Vite/Nitro copy `publicDir`
  before `buildStart`, so writing there means the fonts only appear on the **second** build. This
  was a shipped bug; the symptom is a clean build serving 404s for every font.
- **`emitFile` throws in serve mode.** `buildStart` still runs for the dev module graph, hence the
  `isServe` guard. Dev is served by the `configureServer` middleware instead.
- **The transform must exclude `?url`/`?raw`/`?worker`.** Vite hands you a *JavaScript module* for
  those ids; returning modified code produces a rolldown `PARSE_ERROR`.
- **Build and dev use different ids** for the same file: `styles.css?transform-only` and
  `styles.css?direct`. Match both.
- **Plain `@theme`, never `@theme inline`.** `inline` bakes literals into `.font-*` and
  `--default-font-family`, so nothing downstream can override them.
- **The generated CSS must be a real file.** Tailwind resolves its own `@import`s with
  enhanced-resolve + `fs.readFile`, bypassing Vite entirely — a virtual module is a hard failure.
- **Two `enforce: 'pre'` plugins resolve by array order.** Ours must precede `tailwindcss()`.
  `buildEnd` calls `this.error` if the entry was never transformed, because the silent version of
  this is an app with no fonts at all.
- **`local("BlinkMacSystemFont")` never resolves** — it is a CSS keyword, not a face. A unit test
  guards against it creeping back into `FALLBACK_TARGETS`.
- **`crossorigin` is mandatory on font preloads even same-origin.** Without it the font is fetched
  twice and lands *later* than with no preload at all.
- **pnpm copies `file:` dependencies.** Use `link:` while developing.

## Deliberate non-features

Re-litigate these only with new measurements, not with reasoning:

- No `@supports` guard — `@supports` tests properties, and these are `@font-face` *descriptors*, so
  the condition is false in every browser including ones that support the feature.
- No JS feature detection — under Tailwind's pinned leading Safari renders identically to Chrome.
- No global leading override — measured net CLS benefit is zero.
- No headless browser at build time — fontkit agrees with Chrome to 0.146%, and the `local()`
  target usually is not installed on a build machine anyway.
- No edit to `__root.tsx` — the `Link:` header removes the need, and root-route codemods bailed on
  4 of 12 real-world shapes when tested.
