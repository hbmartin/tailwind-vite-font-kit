// Minimal plain Vite + Tailwind v4 app. It exercises generation, automatic HTML
// preloads, and preview response headers. A separate pinned fixture covers Nitro/Start.
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { fonts } from 'tailwind-vite-font-kit'

export default defineConfig({
  plugins: [fonts(), tailwindcss()],
  build: { outDir: 'dist' },
})
