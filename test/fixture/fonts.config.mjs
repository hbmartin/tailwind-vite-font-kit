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
  ],
  assets: 'emit',
}
