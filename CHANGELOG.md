# Changelog

## Unreleased

Release this as **0.2.0** — it contains two breaking changes. Run `pnpm version minor`
(which also creates the tag), then publish a GitHub release; see `docs/MAINTAINERS.md`.

### Breaking

- **Vite 6 is no longer supported.** The peer range is now `^7 || ^8`. The `transform`
  hook uses the `{ filter, handler }` object form, which needs Rollup ≥4.38 / Vite ≥6.3 —
  on Vite 6.0–6.2 the filter was silently ignored and the hook ran on every module. The
  range was never tested, either; CI now builds the fixture at the floor of each supported
  major and asserts the same output invariants.
- **The preload `Link:` header no longer lands on asset responses.** It is still set on
  `/**`, because that is the only pattern covering every document route, but
  `${publicPath}/**` and `/assets/**` now receive an empty `Link:` so browsers read zero
  links from them. If you depended on the header reaching those paths, set
  `preloadHeader: { exclude: [] }`.

### Fixed

- **A cache hit could serve a different config's CSS.** `meta-<key>.json` was keyed by the
  config hash but `fonts.gen.css` was a fixed filename, so the hit check never verified
  the stylesheet belonged to the key. Generating config A, then B, then A again logged
  `cache hit` and left B's CSS on disk — a clean build shipping the wrong fonts. Reachable
  by switching a branch that changes `fonts.config.mjs`, or by undoing a config edit. The
  stylesheet is keyed too now; `output: 'commit'` prunes other configs, `output: 'cache'`
  keeps them so a branch flip stays a cache hit.
- **The `Link:` header was on every response**, including each JS chunk and the woff2
  itself. Nitro merges the headers of all matching route rules key-by-key with the more
  specific rule winning, so `/fonts/**` added to `/**` rather than replacing it. Browsers
  only act on `Link:` for the navigation response, so the rest was waste.
- **`assets: '<dir>'` never repaired a damaged file.** Writes were additive-only, so a
  file truncated by an interrupted write kept its name and served as a valid font forever.
  Files whose bytes differ from the generated ones are now rewritten. Fonts the config no
  longer uses are reported by name and never deleted.
- **A malformed `fonts.config.mjs` crashed the CLI with a `TypeError`** partway through,
  in the one tool that deletes your source. Loading and validation now happen before
  anything is written, and reject a `themeVar` outside Tailwind's `--font-*` namespace —
  which otherwise produces a `@theme` block Tailwind accepts and silently ignores.
- **`weights` was required in the types but optional at runtime**, making an `axes`-only
  family a type error despite being a supported shape.
- **`silent: true` hid warnings.** It suppressed "no capsize metrics for X", which means
  every metric-matched fallback for that family is missing — the package's whole purpose,
  gone quietly. Outcomes where the build succeeds but the result is wrong now go to a warn
  channel that `silent` does not touch.

### Added

- **`npx tss-fonts opsz <Family>`** downloads the variable font once, measures how much
  its advance widths actually move across the sizes you give it, and recommends an
  `opszPin`. `--write` puts the answer in `fonts.config.mjs`. Needs the optional peers
  `fontkit` and `wawoff2`.
- **`opszPin: 'auto'`** does the same during generation, on a cold generate only.
  Worth knowing: axis ranges vary a lot — Fraunces is `9..144`, Inter `14..32`, Nunito
  Sans only `6..12` — so the default pin of 16 is off the end of the axis on some
  families and gets clamped.
- **`leadingUtilities: true`** appends the `leading-auto` and `prose-auto` `@utility`
  escape hatches to the generated stylesheet (previously `extras/leading-opt-in.css`).
- **`tailwind-vite-font-kit/start-server`** and **`npx tss-fonts early-hints`** for the
  `103 Early Hints` server entry (previously `extras/server.ts`). It is the only preload
  mechanism that beats a slow route loader: measured 1259 ms vs 1536 ms to fonts-applied
  with an 800 ms loader.
- **`preloadHeader: { exclude: [...] }`** to control which paths get an empty `Link:`.
- A **warning when no Nitro plugin is present**, since the preload header and the
  immutable caching both ship as Nitro route rules and are otherwise lost silently.
- Downloaded woff2 are now recorded with a sha256 and verified on cache reuse, so a
  truncated cache entry is a miss rather than a valid-looking font. Downloads are
  restricted to `fonts.gstatic.com`, since the URL comes from a network response.
- Cache writes are atomic (temp file + rename); `node_modules/.cache` is shared between
  concurrent builds.

### Removed

- **`extras/` is gone from the package.** Everything in it shipped but could not be used
  from an install — each file needed dependencies the package never declared, and none of
  it was typechecked. The three files became the features listed above.

### Internal

- The capsize character-frequency table is vendored in `src/weightings.mjs` instead of
  being string-matched out of `@capsizecss/unpack`'s minified dist at import time. A test
  diffs it against the installed version so upstream drift fails CI.
- Coverage moved from 69/74/62 to 79/78/77. `src/index.mjs` went from 43% to 91% of lines
  and 21% to 96% of functions; `bin/tss-fonts.mjs` from no direct tests to 82% of
  functions.

## 0.1.0

First release.
