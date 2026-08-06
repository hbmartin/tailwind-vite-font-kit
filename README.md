# font-kit — reusable font setup for TanStack Start + Tailwind v4

Copy this folder into a project, edit `fonts.config.mjs`, run the generator, add **one line**
to your Tailwind entry. Everything else is derived.

```bash
cp -r font-kit ./fonts && cd fonts
pnpm add -D @capsizecss/metrics
node build-fonts.mjs
```

```css
/* src/styles.css */
@import 'tailwindcss';
@import './fonts.gen.css';   /* <- the whole integration */
```

```tsx
// src/routes/__root.tsx
import { fontPreloads } from '../fonts.gen'
head: () => ({ links: [...fontPreloads, { rel: 'stylesheet', href: appCss }] })
```

Delete any hand-written `--font-sans` from your own `@theme` block — the generated one owns it.

---

## What it generates

`src/fonts.gen.css` — one real on-disk file containing:

1. Real `@font-face` rules with Google's `unicode-range` splits preserved, `src` pointing at your
   origin (or gstatic, per family).
2. Metric-matched fallback `@font-face` rules — **one per (local target × declared weight)**, each
   with a distinct family name.
3. A `@theme` block wiring each family to a Tailwind variable with its fallbacks already in the stack.

`src/fonts.gen.ts` — the `fontPreloads` array for `head().links`.

---

## The rules it applies automatically, and why each one is load-bearing

| Rule | Why |
|---|---|
| A **real on-disk CSS file**, imported normally | Tailwind resolves its own `@import`s with `fs.readFile`, bypassing Vite's plugin container. A virtual module is a hard build failure. |
| Plain **`@theme`**, never `@theme inline` | Under `inline`, Tailwind bakes literals into `.font-*` and into `--default-font-family`, so nothing downstream reaches them. Non-inline keeps the `var()` indirection — verified: `--default-font-family:var(--font-sans)`. |
| The `@theme` lives **inside Tailwind's import graph** | A `@theme` block Tailwind never sees is shipped to the browser as an unknown at-rule and dropped. Zero warnings. |
| **One fallback face per declared weight** | Arial 700 is 7.7% wider than Arial regular. One face per family is wrong for every weight but one. Costs ~300 bytes. |
| **Distinct family name per `local()` target** | Same-named faces with conflicting descriptors let the last loadable one win silently. Distinct names let each platform pick the one it has. |
| **Never `local("BlinkMacSystemFont")`** | It is a CSS keyword, not an installed face. Verified `status: "error"` in Chrome on macOS. Every tool that ships it ships a dead entry. |
| **`crossOrigin: 'anonymous'` on every preload** | Even same-origin. Without it you get a **double download**: 4 requests / 185 kB instead of 2 / 93 kB, and fonts land *later* than with no preload at all. |
| **`opsz` pinned in the request URL** | If the family has an optical-size axis, the served woff2 otherwise has size-dependent advance widths and no static `size-adjust` can be right. Pinning removes the axis: error drops from +22% to −0.3%, and the file shrinks ~45%. |
| **Desktop Chrome User-Agent on the CSS fetch** | Without it Google returns legacy TTF with all subsets in one file. |

---

## Config

```js
{
  name: 'Manrope',
  themeVar: '--font-sans',        // becomes @theme { --font-sans: ... }
  weights: [400, 500, 600, 700, 800],
  stack: ['ui-sans-serif', 'system-ui', 'sans-serif'],
  preloadWeights: [400],          // [] to disable; see the preload budget below
  strategy: 'self-host',          // or 'cdn' — per family
  axes: 'opsz,wght@9..144,500;9..144,700',  // optional raw css2 axis spec
  opszPin: 48,                    // where to pin an opsz axis (~16 body, ~48 display)
}
```

## The preload budget

Preloading is zero-sum against your render-blocking stylesheet.

> **FCP cost ≈ preloaded bytes ÷ effective bandwidth.**
> Measured: 66 kB display face cost 156 ms of FCP at ~500 kB/s (132 ms predicted).

Measured on this app at 150 ms RTT / 4 Mbps, 9 runs:

| | FCP | fonts applied | swap window |
|---|---|---|---|
| no preload | **468** | 897 | 429 ms |
| body face only (24 kB) | 512 | 895 (body face done at **460**) | — |
| body + display (24+66 kB) | 668 | **686** | 22 ms |

Default to the **body face only**. Add the display face when the headline is your LCP element.

## Optional extras

- **`server.ts`** — merged static-phase `103 Early Hints` + `Link:` response header. On a slow route
  (800 ms loader) this was the only option that improved FCP *and* the swap window simultaneously
  (FCP 1516→1300, fonts 1536→1259 — fonts ready *before* first paint). Worth nothing and costs
  nothing on fast routes. Degrades to a no-op on non-Node runtimes, HTTP/1.1, and in dev.
  **Do not** use Start's built-in `head().links` Early-Hints promotion: those links only exist after
  `router.load()`, so they go out as a *second* 103, which browsers discard — measurably worse than
  shipping no preload at all.
- **`vite.config.ts` route rule** — Nitro serves `public/` with **no cache-control at all** while
  giving hashed `/assets/*` `immutable`. This silently undercuts every preload strategy on repeat
  visits:
  ```ts
  nitro({ routeRules: { '/fonts/**': { headers: {
    'cache-control': 'public, max-age=31536000, immutable',
    'access-control-allow-origin': '*' } } } })
  ```
- **`leading-opt-in.css`** — two scoped `@utility` escape hatches if you want optical leading on a
  specific block. Import it only if you need it; the generator never applies it.
- **`opsz-policy.mjs`** — offline axis detection and instance-accurate metrics (fontkit), if you want
  the full decision tree rather than just pinning.

## Harness

`harness/sweep.mjs` (CLS per probe × viewport), `harness/waterfall.mjs` (FCP / fonts-applied under
emulated 4G — always `--runs 9`, FCP is noisy), `harness/targets.mjs` (per-fallback accuracy vs the
real font), `harness/clswidth.mjs` (container-width CLS sweep).

Use `clswidth.mjs` before believing any width-related result: a single-viewport CLS number is
degenerate for advance-width errors — one config read 0.0001 at two viewports while shifting 51 px
at 2 of 36 container widths.

## What this deliberately does NOT do

- No `@supports` guard. `@supports` tests *properties*; these are `@font-face` *descriptors*, so
  `@supports (ascent-override: 90%)` is **false in every browser**, including ones that support it.
- No JS feature detection. Under Tailwind's pinned leading, Safari renders identically to Chrome
  (verified: 127.5 px either way) — the vertical descriptors are inert everywhere, so there is
  nothing to detect.
- No global leading override. Measured net CLS benefit: zero.
- No headless browser at build time. Non-hermetic, ~1 s slower, and fontkit already agrees with
  Chrome to 0.146%.
