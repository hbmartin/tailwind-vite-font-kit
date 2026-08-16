# tailwind-vite-font-kit

Self-hosted Google fonts with metric-matched fallbacks for **TanStack Start + Tailwind v4**, as one
Vite plugin. Your `styles.css` and `__root.tsx` are never touched.

Measured on a real app, swapping Poppins in cold with the font response delayed 2 s:

| probe | untreated | with this |
|---|---|---|
| mobile hero | **0.1211** (failing CWV) | **0.0004** |
| mobile body text | 0.0822 | 0.0099 |
| desktop hero | 0.0431 | 0.0003 |

---

## Install

**With shadcn** (the project already has `components.json`):

```bash
npx shadcn@latest add https://raw.githubusercontent.com/hbmartin/tailwind-vite-font-kit/main/registry/r/fonts.json
```

or register the namespace once in `components.json`:

```json
{ "registries": { "@hm": "https://raw.githubusercontent.com/hbmartin/tailwind-vite-font-kit/main/registry/r/{name}.json" } }
```

```bash
npx shadcn@latest add @hm/fonts
```

**Without shadcn:**

```bash
pnpm add -D tailwind-vite-font-kit && npx tss-fonts init
```

Either way you end up adding one line to `vite.config.ts` — shadcn deliberately cannot run codemods,
and `tss-fonts init` does it for you:

```ts
import { fonts } from 'tailwind-vite-font-kit'

plugins: [
  nitro(),
  fonts(),        // BEFORE tailwindcss() — both are enforce:'pre', array order decides
  tailwindcss(),
  tanstackStart(),
  viteReact(),
]
```

### Already have fonts wired up?

```bash
npx tss-fonts adopt --dry-run    # see the diff first
npx tss-fonts adopt
```

It reads the Google `@import` and `--font-*` vars you already have, writes them into
`fonts.config.mjs`, removes them from your CSS, and points hand-written `font-family` rules at the
theme var. If `fonts.config.mjs` disagrees with your CSS it **stops** rather than deleting the only
record of what you were using — pass `--from-css` to adopt what the project actually uses.

---

## Configuration

`fonts.config.mjs`, in the project root:

```js
export default {
  families: [
    {
      name: 'Poppins',
      themeVar: '--font-sans',           // → @theme { --font-sans: 'Poppins', '<fallbacks>', … }
      weights: [400, 500, 600, 700],
      stack: ['ui-sans-serif', 'system-ui', 'sans-serif'],
      preloadWeights: [400],
      strategy: 'self-host',             // or 'cdn' — per family
    },
    {
      name: 'Fraunces',
      themeVar: '--font-display',
      weights: [500, 700],
      axes: 'opsz,wght@9..144,500;9..144,700',
      opszPin: 48,                       // or 'auto' — see "opsz" below
      stack: ['Georgia', 'serif'],
      preloadWeights: [],
    },
  ],
  assets: 'emit',    // 'emit' = nothing in your source tree | or a dir path, e.g. 'public/fonts'
  output: 'cache',   // 'cache' = node_modules/.cache | 'commit' = .tss-fonts/, hermetic CI
}
```

You can also pass the same object inline: `fonts({ families: [...] })`. Inline options win.

### Requirements

**Vite 7 or 8**, and **Tailwind v4** — v3 has no `@theme`. Node ≥22.

**Vite `base` is respected.** Leave `publicPath` as `'/fonts'` when deploying under a
subpath: with `base: '/docs/'`, emitted files live at `fonts/*` and are requested from
`/docs/fonts/*`. A full-URL base (`base: 'https://cdn.example.com/app/'`) puts the origin
into the font URLs in the build; a relative base (`'./'`) cannot be followed by
plugin-written URLs, so those stay root-absolute and the plugin says so when fonts are
self-hosted. A base set by *another plugin's* `config()` hook is detected after the fact
and reported — set `base` directly in your Vite config. A trailing slash in `publicPath`
is normalized, and `publicPath: '/'` serves fonts from the bundle root. At the bundle root
the fonts share a namespace with documents, so the plugin deliberately omits its font-scoped
Nitro caching/CORS rule and font-response preload exclusion rather than matching the whole app.

**Nitro is what delivers the preloads.** The `Link:` header and the `immutable` caching on
`/fonts/**` both ship as Nitro route rules, which is what makes this zero-app-edit. On
plain Vite that config key is ignored: the fonts still generate, emit and serve, you just
silently get neither. The plugin warns once when it does not find Nitro. To preload
without it, set `preloadHeader: false` and render the links yourself from `virtual:fonts`.

---

## What it does, and why each part is load-bearing

Every one of these fails **silently** if you get it wrong, which is the reason this package exists.

| Rule | Why |
|---|---|
| Generated CSS is a **real on-disk file** | Tailwind resolves its own `@import`s with `fs.readFile`, bypassing Vite. A virtual module is a hard build failure. |
| Plain **`@theme`**, never `@theme inline` | `inline` bakes literals into `.font-*` and `--default-font-family`, so nothing downstream reaches them. Verified: you get `--default-font-family:var(--font-sans)`. |
| The `@theme` is **inside Tailwind's import graph** | One Tailwind never sees is shipped to the browser as an unknown at-rule and dropped, with zero warnings. |
| **One fallback face per declared weight** | Arial 700 is 7.7% wider than Arial regular. One face per family is wrong for every weight but one. |
| **Distinct family name per metric target** | Same-named faces with conflicting descriptors let the last loadable one win silently. Compatible aliases such as Arial/Liberation Sans share one face; targets with different metrics do not. |
| **Linux-compatible `local()` aliases** | Arial and Times New Roman are normally absent on Linux. Their faces also try Liberation Sans and Liberation Serif, which use the matching descriptors and are present on the monitored Ubuntu runner. |
| **Never `local("BlinkMacSystemFont")`** | It is a CSS keyword, not an installed face — `status: "error"` in Chrome on macOS. fontaine lists it first. |
| **`crossorigin` on every preload** | Even same-origin. Without it the font downloads **twice** (4 requests / 185 kB instead of 2 / 93 kB) and lands *later* than shipping no preload at all. No error, no warning. |
| **`opsz` pinned in the request URL** | Otherwise `size-adjust` is off by up to +22% at display sizes. Pinning removes the axis and shrinks the file ~45%. |
| **`/fonts/**` served `immutable`** | Nitro serves `public/` with no cache-control at all. |
| Desktop Chrome **User-Agent** on the CSS fetch | Without it Google returns legacy TTF with every subset in one file. |

Preloads ship as an HTTP **`Link:` response header**, not a `<link>` in `head()`. That is what makes
this zero-app-edit, and it is order-free — React 19 hoists stylesheets above any `<link>` you write.
Measured equivalent: 608 ms FCP / 586 ms fonts (header) vs 604 / 579 (JSX), 9 runs at 150 ms RTT.

### The preload budget

Preloading is zero-sum against your render-blocking stylesheet.

> **FCP cost ≈ preloaded bytes ÷ bandwidth.** A 66 kB display face measured 156 ms of FCP at
> ~500 kB/s (132 ms predicted).

Preload the body face. Add the display face only if the headline is your LCP element — and note that
pinning `opsz` often shrinks it enough to change that answer, so re-measure.

### opsz

If a family has an optical-size axis, its advance widths depend on the size it renders at, so no
static `size-adjust` can be right. Measured on Fraunces vs Times New Roman:

```text
optical sizing auto @100px  ->  96.30%   (what renders)
forced opsz 14              -> 118.49%
what every other tool emits -> 115.45%
after pinning opsz          ->  -0.31% error
```

Only ~29 of 1,942 Google families carry `opsz` — but that includes Inter, DM Sans, Playfair,
Literata, Nunito Sans, Merriweather and Fraunces.

**What should you pin it at?** Measure, rather than guessing — the axis range is different for
every family, and the default of 16 is off the end of some of them:

```bash
npx tss-fonts opsz Fraunces --sizes 16,24,48,96
#   axis          opsz 9..144 (fvar default 9)
#   width swing   2% across 16, 24, 48, 96px
#   recommended   opszPin: 48

npx tss-fonts opsz            # every family in your fonts.config.mjs
npx tss-fonts opsz --write    # write the answers into fonts.config.mjs
```

| family | opsz axis | so a pin of 16 is |
|---|---|---|
| Fraunces | `9..144` | valid, but 3× too small for a display face |
| Inter | `14..32` | about right |
| Nunito Sans | `6..12` | **outside the axis** — clamped to 12 |

`opszPin: 'auto'` runs the same measurement during generation, on a cold generate only — tell it
what sizes the family renders at with `opszSizes: [16, 24, 48, 96]`. Both need the optional peers:
`pnpm add -D fontkit wawoff2`.

---

## Deliberately not done

- **No `@supports` guard.** `@supports` tests *properties*; these are `@font-face` *descriptors*, so
  `@supports (ascent-override: 90%)` is false in **every** browser, including ones that support it.
- **No JS feature detection.** Under Tailwind's pinned leading, Safari renders identically to Chrome
  (127.5 px either way) — the vertical descriptors are inert everywhere, so there is nothing to detect.
- **No global leading override.** Measured net CLS benefit: zero.
- **No headless browser at build time.** fontkit already agrees with Chrome to 0.146%.
- **No edit to `__root.tsx`.** The `Link:` header removes the need, and root-route codemods were the
  most brittle thing tested (4 of 12 shapes bailed).

---

## Opt-in extras

**`103 Early Hints`** — the only preload mechanism that beats a slow route loader, because Start's
first byte waits on the loader and a 103 does not. With an 800 ms loader it was the only option that
improved FCP *and* the swap window together (1516→1300 ms FCP, 1536→1259 ms fonts, ready *before*
first paint). Worth nothing on fast routes, where the `Link:` header already measures identical.

```bash
npx tss-fonts early-hints    # writes src/server.ts
```

```ts
// src/server.ts — what that command writes
import { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'

export default createFontsServerEntry()
```

Needs `@tanstack/react-start`. Chrome only acts on a 103 over HTTP/2+, and `writeEarlyHints` is a
Node API — elsewhere this degrades to the `Link:` header, which the plugin already sets.

**Optical leading** — `leadingUtilities: true` adds two scoped `@utility` escape hatches,
`leading-auto` and `prose-auto`, for the rare block where you want font-metric leading. Note
`leading-normal` is `1.5`; only `leading-[normal]` emits `normal`. There is deliberately no global
un-pin: measured net CLS benefit is zero if you ship metric fallbacks, and worse if you don't.

## Measuring

`harness/` has the tools used for every number above: `sweep.mjs` (CLS per probe × viewport),
`waterfall.mjs` (FCP / fonts-applied under emulated 4G — always `--runs 9`, FCP is noisy enough that
3 runs produced a misleading outlier), `targets.mjs` (per-fallback accuracy vs the real font), and
`clswidth.mjs` (container-width sweep).

It lives in the repo, not in the npm package — clone
[the repo](https://github.com/hbmartin/tailwind-vite-font-kit) to use it.

Use `clswidth.mjs` before believing any width-related result: a config that read 0.0001 at two
viewports was shifting 51 px at 2 of 36 container widths.

The weekly monitor gates three runs of `hero`, `tailwind`, and `normal` at desktop and mobile sizes
on `ubuntu-24.04`. It also checks that the sans and serif fallback faces actually loaded before the
delayed web fonts. The broader hero width sweep is reported for diagnosis but does not gate.
