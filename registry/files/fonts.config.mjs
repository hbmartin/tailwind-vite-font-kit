// tailwind-font-kit. Edit this, then rebuild — the plugin regenerates on change.
//
// Already have fonts in your CSS? Run `npx tss-fonts adopt` and it will fill this in
// from your existing Google @import and --font-* vars, then clean them out of your CSS.

export default {
  families: [
    {
      // Any Google Fonts family name.
      name: 'Inter',
      // The Tailwind variable this drives. Emitted as a plain `@theme` block, so
      // `font-sans`, `--default-font-family` and `var(--font-sans)` all pick up the
      // metric-matched fallbacks.
      themeVar: '--font-sans',
      weights: [400, 500, 600, 700],
      // Tail of the stack, after the generated fallback families.
      stack: ['ui-sans-serif', 'system-ui', 'sans-serif'],
      // Preloading is zero-sum against your render-blocking stylesheet:
      // FCP cost ≈ preloaded bytes ÷ bandwidth. Preload the body face; add a display
      // face only if the headline is your LCP element.
      preloadWeights: [400],
      // 'self-host' (default) serves from your origin. 'cdn' keeps Google's gstatic URL
      // — the fallback machinery is identical either way, only the src changes.
      strategy: 'self-host',
    },

    // A display face, for reference. Inter and Fraunces both carry an `opsz` axis, so
    // `opszPin` matters: it removes the axis from the served file, which makes the
    // static metrics valid and shrinks the file ~45%. ~16 for body, ~48 for display.
    // {
    //   name: 'Fraunces',
    //   themeVar: '--font-display',
    //   weights: [500, 700],
    //   axes: 'opsz,wght@9..144,500;9..144,700',
    //   opszPin: 48,
    //   stack: ['Georgia', 'serif'],
    //   preloadWeights: [],
    // },
  ],

  // 'emit' (default) keeps the woff2 out of your source tree entirely.
  // Or give a directory path, e.g. 'public/fonts', for real files you can inspect.
  // Writing there is additive and .gitignore is never touched. Note that committing
  // those files does NOT make builds offline — that's what output: 'commit' is for.
  assets: 'emit',

  // 'cache' (default) generates into node_modules/.cache.
  // 'commit' generates into .tss-fonts/ so CI never touches the network.
  output: 'cache',
}
