# Follow-up: local gates and compression

The baseline in `2026-09-14/` remains the original 214 observations. Subsequent
experiments preserve library defaults: **none of the three candidates met the
agreed requirement to fix 380px without regressing another tested width**.

## Repeated browser results

The same production output and 2-second font delay were used for every paired run.
Each cell below has three observations. Geometry measures include paragraph height
and CTA/card positions, so moving content below the viewport cannot hide a failure.

| In-app Chrome 152 viewport | Baseline CLS | Correct bold binding | Helvetica first for Manrope | Combined |
| --- | ---: | ---: | ---: | ---: |
| 380×900 | 0.143584 | 0.154318 | 0.000151 | 0.032615 |
| 800×900 | 0.000706 | screened out at 380 | 0.016525 | 0.016411 |
| 1060×900 | 0.000466 | screened out at 380 | 0.013527 | 0.013452 |
| 1280×900 | 0.000319 | screened out at 380 | 0.010465 | 0.010414 |

Changing bold binding retains the 24px paragraph height change and adds a 48px
headline height change: CTA/card movement reaches 72px. Helvetica alone eliminates
movement at 380px but regresses wider layouts. The combined candidate still has
48px of headline/CTA/card movement at 380px, and regresses the wider sizes too. The results are conclusive failures, so no
nine-repeat tie-break or full eligibility suite was needed. The full 36-width sweep,
main matrix, narrow diagnostics and additional Poppins/Fraunces coverage remain
required before a future candidate can change defaults; these screening results
must not be presented as that full acceptance run.

Additional local CLI screening tested 380, 390, 400, 600, 800, 1060 and 1280px with
three repetitions for baseline and all three candidates: 84 loads on macOS
(headless Chrome 151) and 84 on Ubuntu 24.04 (headless Chromium 140). The Ubuntu
and macOS screening results are evaluated against their own baselines. macOS
headless confirmed the Helvetica regressions
at 800, 1060 and 1280px. Correct bold binding also regressed 600px on both
platforms: macOS CLS 0.000275 → 0.039676; Ubuntu 0.000276 → 0.039730. In-app confirmation added 39 loads, for **207 valid new
observations**. Initial bold/combined trials that failed to transform minified
unquoted `local()` names were discarded and rerun after correcting the harness;
they are excluded from this count. A regression test now covers the actual minified
CSS form. Browser error checks passed. One in-app wait timed out after the
result element was already present; its completed result was recovered from the
DOM and validated, without adding a duplicate observation.

Headless Chrome's overlay scrollbars give its 380px viewport 316px of paragraph
width, versus 301px in the in-app browser. Consequently its baseline has no 380px
paragraph jump. A headless success cannot establish that the original regression
is fixed. The probe now records usable document width; comparisons also reject
mismatched browser user agents. Use the same browser and scrollbar behavior for
baseline/candidate pairs.

## Cause checks

Browser platform-font inspection confirms that `src:local("Arial")` at declared
weight 700 loads `ArialMT`; explicit bold sources load `Arial-BoldMT`. This explains
why face names deserve investigation, but correcting that mismatch alone does not
fix the reported paragraph wrapping. The harness retains the candidate, including
Liberation bold aliases, for further experimentation; production generation is
unchanged.

The downloaded Manrope file's metrics match the database at weights 400–800:
weighted average widths 920, 937, 954, 971 and 988; units-per-em 2000; ascent 2132;
descent −600. No metric data was modified. Reproduce with
`browser-benchmark-metrics.mjs` and inspect actual local bindings with
`browser-benchmark-local-faces.mjs`.

## Implemented infrastructure

The local runner now supports manifests, configurable viewports/repetitions/family
expectations and either the in-app adapter or the reference app's Puppeteer.
Validation requires complete cells, unique runs, matching viewports, loaded
fallbacks, expected fresh font responses, valid geometry and no browser/request
errors. Valid measurements and performance acceptance are separate outcomes.
Empty data and omitted difficult cells cannot pass. Focused tests cover these
failure modes and the per-cell regression gates.

The setup helper prepares a pinned reference checkout with frozen dependencies and
imports the current local kit. Bundle auditing uses portable module paths, detects
hashed filenames and ignores compressed sidecars. Future run artifacts remain in
ignored `harness/results/`; no browser CI or scheduled runs were added. See the
[local workflow](../../harness/browser-benchmark.md) for commands.

## Bundle and deployment outcome

The production comparison again found identical client JavaScript: **0 added browser
JavaScript** from font-kit. Metric fallback CSS costs **650 gzip / 527 Brotli bytes**.
The 107-module client graph contains none of the font build dependencies. This
supports the package's build-time architecture; it does not prove a universal CLS
advantage or that every byte of React/TanStack is necessary.

The sibling reference app's separate compression change generates gzip/Brotli assets
and sets `Vary: Accept-Encoding` for identity responses as well. Native server GETs
validated every JS/CSS/font file under all three encodings, checking identical
decoded content, immutable caching, types, WOFF2 behavior and font preloads. The
reference app's own locked build reduces its main JS response from 319,794 bytes to
100,964 gzip or 87,633 Brotli. No client code, dependency upgrade or deployment was
needed. Details and the 21-response audit are committed in the reference app.

Validation: 225 tests passed; coverage 87.35% lines, 80.93% branches, 82.16% functions.
Lint, formatting and type checks passed. `npm pack --dry-run` contains 22 files and
remains 73,156 bytes, exactly matching the baseline package size; harness and reports
are excluded.

The setup helper was also exercised end to end: a new checkout installed the frozen
lockfile and completed a production build with the local kit import and module audit.
