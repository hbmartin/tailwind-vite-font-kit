# Contributing

Thanks for looking. `docs/MAINTAINERS.md` is the real reference — layout, every check and
what it runs, the traps, and the release process. This page is the short version.

## Getting set up

```bash
pnpm install
pnpm test          # unit tests, no network, no browser
pnpm run check     # the local gate: lint → typecheck → coverage, in CI's order
```

`pnpm run check` is what CI runs first. If it passes locally it will almost certainly pass
there; the parts that can still differ are the fixture build and the package checks, which
need the network.

To try a change against a real app, **link** rather than `file:` — pnpm *copies* a `file:`
dependency, so your edits will not be picked up and you will chase a ghost for ten minutes:

```bash
cd ../some-tanstack-app
pnpm add -D link:../font-kit
```

## What a good change looks like here

**Explain why, in the code.** Nearly every non-obvious line in this package carries the
measurement or the failure that produced it, because almost everything here fails
*silently* — the page renders, the fonts load, and the metrics are quietly wrong. A comment
saying what a line does is noise; one saying what happens without it is the point.

**Bring a number.** If a change is about performance or layout stability, `harness/` has
the tools that produced every figure in the README. Use `--runs 9` on `waterfall.mjs`; FCP
is noisy enough that a 3-run median once produced a 844 ms reading against a true 644 ms,
and a whole conclusion was written on top of it.

**Write the test that would have caught it.** For a bug fix, the useful test is one that
fails before your change. Several tests in here exist because an "obvious" optimisation
would have silently degraded the output — `test/generate.test.mjs` has one guarding the
metrics source for exactly that reason.

**Do not lower the coverage thresholds.** They are a ratchet set just under the current
numbers. Raise them when you add tests.

## Things worth knowing before you start

- **Tailwind resolves its own `@import`s** with `fs.readFile`, bypassing Vite. That is why
  the generated CSS is a real file on disk and not a virtual module, and why anything that
  must reach Tailwind gets appended to that file.
- **`@theme`, never `@theme inline`.** `inline` bakes literals into every `.font-*` utility
  and into `--default-font-family`, and nothing downstream can override them.
- **The plugin must run before `@tailwindcss/vite`.** Both are `enforce: 'pre'`, so array
  order decides. `buildEnd()` hard-errors if the entry was never seen, because the
  alternative is an app that silently loses every font.
- **`bin/tss-fonts.mjs` deletes user source.** Anything touching `adopt` needs to keep the
  refusals intact: when `fonts.config.mjs` disagrees with the CSS, it must stop rather than
  proceed, because adopting destroys the only record of what the project was using.

The JSDoc traps in `docs/MAINTAINERS.md` are worth reading before you write any — both fail
in a way that points somewhere else entirely.

## Reporting a bug

The most useful report names the versions of Vite, Tailwind and this package, the
`fonts.config.mjs` (or the inline `fonts({...})` options), and what the generated CSS
actually contains — `node_modules/.cache/tss-fonts/fonts-*.gen.css`, or `.tss-fonts/` under
`output: 'commit'`. Most reports come down to something in that file being absent rather
than wrong.
