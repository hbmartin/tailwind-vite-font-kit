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
BENCH_FONTAINE_CSS=/path/to/fontaine.css node harness/browser-benchmark-server.mjs
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
and unloaded metric fallbacks. It writes per-cell medians, ranges, and geometry deltas.
Keep browser console checks and native production HTTP headers alongside the report.
Reset the browser viewport after the experiment.

Do not interpret local FCP/LCP samples as field performance, an absolute CLS guarantee,
or a ranking of every font loader. Safari, Firefox, Linux/Windows fallbacks, other font
families, scripts/languages, real network contention, and route interactions require
separate measurements.
