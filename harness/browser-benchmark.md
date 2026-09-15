# Production browser benchmark

The September 2026 experiment and its raw observations live in
[`docs/performance/2026-09-14`](../docs/performance/2026-09-14/REPORT.md).
These helpers are repository-only and are not included in the npm package.

## Production build comparison

Use a disposable copy of the reference app, checked out at the commit recorded in
`environment.json`, and install its frozen lockfile. Keep the copy **outside any
`node_modules` directory**, which the font plugin correctly excludes from transforms.
Import this checkout's `src/index.mjs` in the copied Vite config; the reference app's
older installed npm version must not supply the plugin being tested.

The exact benchmark Vite config is recorded as `appConfig` in `environment.json`.
Change its absolute import to your checkout. It adds a client module audit and a
`FONT_BENCH_MANUAL` switch without changing application components.

1. Build with the plugin enabled. Preserve `.output` as `kit-output` and
   `client-modules.json` as `kit-modules.json`.
2. Copy the generated `node_modules/.cache/tss-fonts/*.gen.css` into
   `src/benchmark-fonts.css`. Add its `@import` immediately after the Tailwind import
   in `src/styles.css`. Copy `.output/public/fonts` to `public/fonts`.
3. Build the same application with `FONT_BENCH_MANUAL=1`, using the static CSS and
   disabling only the font plugin. Preserve both builds.
4. Compare the artifacts, including SHA-256 hashes of every client JavaScript chunk:

```sh
node harness/browser-benchmark-bundles.mjs \
  /path/to/kit-output/public /path/to/app/.output/public \
  /path/to/kit-modules.json /path/to/bundle-audit.json
```

The audit fails if the JavaScript differs or font build dependencies enter its module
graph. Compression sizes are calculated independently for each production asset.

## Browser comparison

Serve the preserved kit production output on port 3210. For the direct competitor,
install Fontaine 0.8.1 in a separate disposable directory and run:

```sh
node harness/browser-benchmark-fontaine.mjs \
  /path/to/kit-output/public/assets/styles-HASH.css \
  /path/to/competitor/node_modules/fontaine/dist/index.mjs \
  /path/to/fontaine.css
BENCH_FONTAINE_CSS=/path/to/fontaine.css \
BENCH_FONTAINE_PATH=/assets/styles-HASH.css node harness/browser-benchmark-server.mjs
```

`BENCH_ORIGIN` and `BENCH_PORT` override the production origin and proxy port.
The Fontaine helper runs the actual transform, with its default category fallbacks,
and explicitly connects the documented fallback names to Tailwind's two font variables.
This compares fallback generation, not Fontaine's end-to-end download/preload integration.

Open URLs such as this in the in-app browser:

```text
http://127.0.0.1:3211/probe/hero?variant=kit&run=unique-id&delay=2000
```

Supported variants are `kit`, `swap`, `swap-preload`, `optional`, `system`, and
`fontaine` when its CSS is provided. The app markup and JavaScript are identical.
The proxy changes only font CSS and preload headers. All resources get unique
per-run paths and `no-store` responses. JavaScript/CSS responses are gzip-compressed
when requested; WOFF2 is unchanged. Font responses are delayed by the requested
number of milliseconds **after their request arrives**. This is a font-swap stress
test, not a cellular network or CPU emulator.

The injected measurement script starts before app code, observes layout-shift entries
without recent input, computes the maximum CLS session window, and records geometry,
font-face states, paint times, and Resource Timing entries. At 200 ms after DOM ready
it captures the fallback state. After the requested delay plus 550 ms, fonts-ready,
and another 250 ms, it publishes JSON in the hidden `#font-benchmark-result` element.
It never enters the production bundle. The browser runner reads this DOM element:

```js
await tab.goto(url)
await tab.playwright.locator('#font-benchmark-result').waitFor({
  state: 'attached', timeoutMs: 12000,
})
const result = JSON.parse(
  await tab.playwright.locator('#font-benchmark-result').textContent(),
)
// Add probe and group ('matrix' or 'widths') before saving the result.
```

For the main matrix, test all six variants on `hero`, `tailwind`, and `normal` at
390 × 844 and 1280 × 900. Use three fresh navigations for each cell, unique run IDs,
and rotate variant order. Collect measurements sequentially in one tab.

`browser-benchmark-runner.mjs` provides `matrixCases()`, `responsiveCases()`, and
`runCases(tab, viewportCapability, cases, results, outputPath)` for these operations.
Import it through the in-app browser skill after connecting to the browser; run
batches of at most 14 cases so each tool call can finish within a minute. The helper
does not create a separate browser or require Playwright/Puppeteer dependencies.

For the responsive sweep, test viewport widths 360 through 1060 in 20-pixel
increments, each at a height of 900. Keep `width=0` so the app's own container sizing
and responsive font-size clamp remain active. Use group `responsive`.

For additional narrow-container diagnostics, use a 1280 × 900 viewport and append
`&width=280`, through 480 in 20-pixel increments. This changes the main container
width while retaining desktop typography; it is a deliberate stress case, not a
simulation of the app's normal mobile layout. Use group `widths`. Test both `kit`
and `fontaine`; report CLS and probe displacement because content moving below
the viewport can escape CLS scoring.

Save all observations to `raw-results.json`, then validate them:

```sh
node harness/browser-benchmark-summary.mjs /path/to/raw-results.json
```

The summary rejects cached/missing/duplicate font downloads, late fallback snapshots,
and unloaded metric fallbacks. It prints per-cell medians, ranges, and geometry deltas. To save a new summary,
add `--output harness/results/new-summary.json`. Existing files are never overwritten;
the historical summary stays unchanged.
Keep browser console checks and native production HTTP headers alongside the report.
Reset the browser viewport after the experiment.

Do not interpret local FCP/LCP samples as field performance, an absolute CLS guarantee,
or a ranking of every font loader. Safari, Firefox, Linux/Windows fallbacks, other font
families, scripts/languages, real network contention, and route interactions require
separate measurements.

## Local regression workflow

Prepare a fresh, pinned reference checkout with a frozen lockfile:

```sh
node harness/browser-benchmark-setup.mjs ../reference-app /tmp/font-benchmark-app
```

The setup imports the current local kit, records its commit and dirty status, and
uses the baseline's audited Vite configuration. Build dependencies remain in the
reference checkout. Fontaine remains a separately installed, pinned comparator.
Build and preserve plugin/manual outputs as described above; the bundle audit
ignores precompressed `.gz`, `.br`, `.zst` sidecars and discovers hashed asset names.

Run the local CLI against a running production proxy:

```sh
node harness/browser-benchmark-cli.mjs --app /tmp/font-benchmark-app \
  --origin http://127.0.0.1:3211 --output harness/results/baseline.json
```

It resolves Puppeteer from that checkout's frozen dependencies. Install its Chromium
with the Puppeteer CLI if needed, or pass `--executable /path/to/chrome`. The in-app
adapter remains available and uses only the supplied browser tab. No browser run
was added to CI, pull-request checks, or scheduled automation.

Default CLI coverage is three repetitions of the three probes at 390/1280, all 36
responsive widths, the 380px confirmation, and 11 narrow containers: 162 loads.
Supply `--manifest path.json` to customize it. A manifest is an object with `cases`
(an array from `matrixCases`, `responsiveCases`, or `regressionCases`) and optionally
`candidate` (default `baseline`) and `families`, mapping probe names to font expectations. Cases
accept `viewport`, `height`, `probe`, `variant`, `width`, `delay`, and `group`.
`matrixCases` and `responsiveCases` accept `repeats`, `viewports`, and `variants`;
`matrixCases` also accepts `probes`. The in-app `runCases` final argument accepts
`{ origin }`. Save the same manifest alongside in-app results before running.

```sh
node harness/browser-benchmark-summary.mjs harness/results/candidate.json \
  harness/results/candidate-manifest.json harness/results/baseline.json \
  --output harness/results/comparison.json
```

Validation rejects empty/incomplete/duplicated case sets (including mismatched delay), wrong viewports, failed
requests, browser errors, hidden pages, missing fonts/fallbacks and invalid geometry.
A complete validated run can still fail performance acceptance. Comparison rejects
any cell whose six-decimal median CLS or median absolute vertical movement exceeds
the paired baseline, and requires the 380×900 hero to have CLS ≤0.02 and zero
vertical position/height change. Use three repeats, or nine when inconclusive.
A passing comparison covers **only its manifest**; a short screening manifest cannot
establish production eligibility. Changes require the full suite, Poppins/Fraunces
regressions, and matched macOS and Ubuntu results before changing defaults.

Keep browser version, OS, fonts, scrollbar behavior, content and production build
identical within each baseline/candidate pair. Headless Chrome uses overlay
scrollbars: the same outer viewport can have 15px more usable width than the in-app
browser. Before/after usable layout widths are recorded and must match across paired cells. Do not compare the CLI
and historical in-app values as if their layout were identical.

Experimental candidates are opt-in **harness-only**, with no library API setting:

```sh
BENCH_PORT=3212 BENCH_CANDIDATE=binding node harness/browser-benchmark-server.mjs
BENCH_PORT=3213 BENCH_CANDIDATE=manrope-helvetica node harness/browser-benchmark-server.mjs
BENCH_PORT=3214 BENCH_CANDIDATE=combined node harness/browser-benchmark-server.mjs
```

They correct bold local-face names (including Liberation aliases), move the existing
Helvetica Neue fallback ahead of Arial for Manrope only, or combine both. Real
regular and bold faces are distinct; declarations must use matching metrics. No
metric values are tuned to this page's text. Failed screening gates rule out a
candidate early, before a costly full eligibility run.

For a local Ubuntu run, use the official Playwright Noble container as a browser
runtime, mount this repository at `/work` and the disposable reference app at `/app`
(with its actual dependency directory at `/app/node_modules` if symlinked), and run
the same CLI inside the container. This experiment used image
`mcr.microsoft.com/playwright:v1.55.0-noble@sha256:b27e719ecbfef153e13fd24e8341736733bf2658b229677eb21ff57ff5d7fb29`
with `--platform linux/amd64`, Chromium at
`/ms-playwright/chromium-1187/chrome-linux/chrome`, and the proxy origin
`http://host.docker.internal:3211`. `BENCH_NO_SANDBOX=1` is only for that disposable
root container. Compare Linux candidates to Linux baselines; installed Liberation
fallbacks differ from the Mac's Arial/Georgia.

Future raw runs, manifests and summaries go in ignored `harness/results/`. The
committed September baseline remains unchanged; record decisions in a separate
follow-up report. Browser tooling and reports remain outside the published package.


## Review fixes: trustworthy comparisons and safe artifacts

Run a candidate with **both** its proxy origin and its expected identity:

```sh
node harness/browser-benchmark-cli.mjs --app /tmp/font-benchmark-app \
  --origin http://127.0.0.1:3212 --candidate binding \
  --output harness/results/binding.json
node harness/browser-benchmark-summary.mjs harness/results/binding.json \
  harness/results/binding-manifest.json harness/results/baseline.json \
  --output harness/results/binding-comparison.json
```

The proxy writes its actual candidate, a hash of the measurement/transform code,
and original/transformed asset hashes into every observation. The CLI fails on the
first wrong-proxy observation; validation checks the manifest's expected candidate.
Acceptance requires an identified candidate that actually changed CSS, a baseline,
matching production asset hashes, matching harness code, the same browser, matching
usable layout widths, at least three repetitions, and delayed font swaps. A second
baseline run cannot be accepted as a candidate. These are operator-error checks,
not signatures that authenticate manually edited JSON.

Case identity includes font delay; missing `group` and `delay` normalize to `matrix`
and `2000`. Repetitions must have identical element identities (including text),
asset evidence, and layout widths. A change in text/hydration invalidates a font-only
comparison. Both adapters collect browser errors. Historical `strict: false`
validation can summarize old observations, but its output cannot pass comparison.
The archived observations lack the new evidence; collect fresh paired runs to use
the acceptance gate instead of fabricating metadata for them.

For a limited investigation without a 380px hero, add `--diagnostic` to the summary
command. It reports per-cell regressions with `accepted: null`; it can never approve
production defaults. Normal acceptance retains the mandatory 380×900 hero gate.

A family name string still means one downloaded file for that family. For static
weights or multiple subsets, list the exact expected paths (without the per-run
`/__bench/ID` prefix):

```json
{
  "families": {
    "hero": [
      { "name": "Poppins", "files": ["/fonts/poppins-400.woff2", "/fonts/poppins-700.woff2"] },
      { "name": "Fraunces", "files": ["/fonts/fraunces.woff2"] }
    ]
  }
}
```

Use the actual generated filenames. Counts, required paths, duplicate downloads,
fresh responses, and loaded family/fallback faces are all checked.

Output names must end in `.json`. CLI runs refuse existing raw/manifest/summary
paths; choose a fresh prefix for each run. In-app batches may append only when the
supplied results exactly match the saved raw observations. The summary command
prints by default; `--output` saves exclusively to a new file. This avoids changing
the committed baseline summary or overwriting raw measurements.

The proxy supports GET/HEAD benchmark pages and assets. Other methods fail explicitly.
Runtime `/assets/` and `/fonts/` requests must carry an attributable page/module
referrer, otherwise they fail instead of silently receiving baseline CSS. Queries
are preserved. `BENCH_FONTAINE_PATH` identifies the original main stylesheet;
additional stylesheets retain their own contents. Shared CSS helpers handle quoted,
unquoted, and escaped fallback names in stripping, candidate transformations and
bundle accounting. Unsupported weight ranges remain unchanged by the bold candidate.
