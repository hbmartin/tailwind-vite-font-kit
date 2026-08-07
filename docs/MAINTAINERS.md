# Maintaining tailwind-vite-font-kit

Everything a future you needs to change this safely. The README is for users; this is for
whoever has to touch the internals.

## Layout

```text
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
test/types.test.mjs  guards index.d.ts against drifting from the .mjs sources
scripts/             CI helpers: collect-metrics.mjs, write-note.sh
extras/              opt-in files that are shipped but never installed automatically
harness/             measurement tools — NOT in package.json `files`, dev only
docs/                this file + FRAMEWORK-COUPLING.md (what Vite/Tailwind/TanStack each own)
```

## Setup

```bash
pnpm install
pnpm test                 # unit tests, no network, ~150 ms
pnpm run check            # everything CI runs on every Node version, in CI's order
pnpm registry:build       # regenerate registry/r from registry/registry.json
```

To try it against a real app, link rather than `file:` — pnpm **copies** a `file:` dependency,
so your edits will not be picked up and you will chase a ghost for ten minutes:

```bash
cd ../some-tanstack-app
pnpm add -D link:../font-kit
```

## Checks

Every command is in `package.json`; this is the part that is not obvious from reading it.

| Command | Runs |
|---|---|
| `pnpm run lint` | `oxlint --deny-warnings` + `oxfmt --check`. No ESLint, no Prettier. |
| `pnpm run format` | `oxfmt --write .` — rewrites in place |
| `pnpm run typecheck` | `tsc --noEmit` over `src`, `bin`, `index.d.ts` and `test/types.test.mjs` |
| `pnpm run test:coverage` | the unit tests plus Node's own coverage thresholds |
| `pnpm run publint` | packs the tarball and lints its `exports` / `files` / `bin` |
| `pnpm run types:lint` | `attw --profile esm-only` — proves the types resolve from a real install |
| `pnpm run verify:package` | `npm publish --dry-run`; also fails if the version is already published |
| `pnpm run check` | lint → typecheck → coverage, in CI's order |
| `pnpm run release:check` | `check` + publint + attw + `verify:package` — the whole pre-publish gate |

### Typechecking .mjs

There is no build step and no TypeScript source: `index.d.ts` is hand-written against the
`.mjs` files, and the exports map points consumers straight at `src/index.mjs`. Three things
keep the two from drifting:

- **`tsconfig.json` runs `checkJs` in strict mode over the sources.** `fonts()` is annotated
  `@param {FontsOptions}` / `@returns {Plugin}`, so an option the implementation reads but
  `index.d.ts` does not declare is a typecheck failure, not a runtime surprise. `noImplicitAny`
  and `useUnknownInCatchVariables` are off — the rest of strict is on.
- **`test/types.test.mjs`** imports the package *by its own name*, which goes through the
  exports map, and diffs the runtime export names against the ones declared in `index.d.ts`.
- **`attw`** checks the published shape resolves for ESM consumers.

Two JSDoc traps, both of which fail in a way that points somewhere else:

- A bare `@import` or `@theme` in a JSDoc *description* is parsed as a tag and silently
  truncates the surrounding `@typedef`'s property list. Write "the CSS import" instead.
- A never-returning helper only narrows control flow when the *binding* is annotated
  (`/** @type {(m: string) => never} */ const die = ...`), not the arrow function.

### Coverage

Thresholds are set as a ratchet just under the current numbers (66% lines, 71% branches,
59% functions), not at an aspirational figure — they exist to stop regressions. `index.mjs`
(~43% lines) and `detect.mjs` (~48%) are the gaps; the Vite hooks are exercised by the fixture
build in CI rather than by unit tests. Raise the numbers when you add tests, never lower them.
They are enforced on Node 22 only, because V8's coverage output shifts between Node releases.

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

Three workflows:

- **`ci.yml`** — every push and PR, in two jobs. `checks` is hermetic and runs the lint,
  typecheck and unit tests on Node 22, 24 and 26 (the `engines` floor through the newest
  release), with coverage, publint, attw and `pnpm audit` pinned to 22. `integration` needs the
  network: registry build + staleness check, builds `test/fixture` (a plain Vite + Tailwind app,
  so it is fast and needs no browser), collects static metrics, and asserts invariants. On
  pushes to `main` a third job writes the metrics to a git note.
- **`release.yml`** — on a **published GitHub release**, not on a tag push. Checks the tag
  matches `package.json`, runs `release:check`, and publishes with npm trusted publishing
  (OIDC) and `--provenance`. There is no `NPM_TOKEN`: the trust relationship is configured in
  the package settings on npmjs.com, and the workflow will fail until that is done.
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

Publishing is automated; a human bumps the version and writes the release notes.

1. A manual pass over the table above (nothing else covers those paths).
2. `pnpm version <patch|minor|major>` — this also creates the `vX.Y.Z` tag.
3. `pnpm registry:build` and commit `registry/r` — **CI fails if it is stale**, and the raw
   GitHub URL users install from serves straight out of `registry/r` on `main`.
4. `pnpm run release:check` locally. It runs the whole gate including a publish dry-run, so it
   also catches a version that is already on npm.
5. Push, including tags, and let CI go green.
6. **Publish a GitHub release** on that tag. Pushing the tag alone does nothing — `release.yml`
   fires on `release: published`, re-runs `release:check`, and publishes with provenance. Mark
   it a prerelease to publish under the `next` dist-tag instead of `latest`.
7. Verify the real path from a throwaway project:
   `npx shadcn@latest add https://raw.githubusercontent.com/hbmartin/tailwind-vite-font-kit/main/registry/r/fonts.json`

The first release through this path needs npm trusted publishing configured for the package on
npmjs.com (publisher: this repo, workflow `release.yml`). Until then the publish step fails on
authentication, which is the intended failure mode — there is no token to fall back to.

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
