// Minimal Vite + Tailwind v4 app. Deliberately NOT a TanStack Start app: this fixture
// exists to exercise the generator and the Tailwind @import/@theme integration on every
// push, in seconds, with no browser. The Start-specific surface (nitro routeRules, the
// Link: preload header, SSR) is covered by the weekly job against the reference app.
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { fonts } from 'tailwind-font-kit'

export default defineConfig({
  plugins: [fonts(), tailwindcss()],
  build: { outDir: 'dist' },
})
