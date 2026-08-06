// The only file you edit per project.
export default {
  // Where the generated CSS and the woff2 files go.
  outCss: 'src/fonts.gen.css',
  outDir: 'public/fonts',
  publicPath: '/fonts',

  // Subsets to keep from Google's per-subset @font-face blocks.
  subsets: ['latin'],

  families: [
    {
      // Google Fonts family name.
      name: 'Manrope',
      // The Tailwind theme variable this family should drive.
      // Emitted as `@theme { --font-sans: 'Manrope', '<fallbacks>', <stack> }`.
      themeVar: '--font-sans',
      weights: [400, 500, 600, 700, 800],
      // Tail of the stack after the generated fallback faces.
      stack: ['ui-sans-serif', 'system-ui', 'sans-serif'],
      // Which above-the-fold faces to preload. [] disables preloading for this family.
      preloadWeights: [400],
    },
    {
      name: 'Fraunces',
      themeVar: '--font-display',
      axes: 'opsz,wght@9..144,500;9..144,700',
      opszPin: 48,
      weights: [500, 700],
      stack: ['Georgia', 'serif'],
      preloadWeights: [700],
    },
  ],
}
