export default {
  families: [
    {
      name: 'Poppins',
      themeVar: '--font-sans',
      weights: [400, 700],
      stack: ['ui-sans-serif', 'system-ui', 'sans-serif'],
      preloadWeights: [400],
    },
    {
      name: 'Fraunces',
      themeVar: '--font-display',
      weights: [500, 700],
      axes: 'opsz,wght@9..144,500;9..144,700',
      opszPin: 48,
      stack: ['Georgia', 'serif'],
      preloadWeights: [],
    },
    // A monospace family so the CI invariants actually exercise the third alias pair
    // (Courier New / Liberation Mono). Without one, dropping it from FALLBACK_TARGETS
    // passes every test and every invariant, and the Linux regression ships silently.
    {
      name: 'JetBrains Mono',
      themeVar: '--font-mono',
      weights: [400],
      stack: ['ui-monospace', 'monospace'],
      preloadWeights: [],
    },
  ],
  assets: 'emit',
}
