import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'
import { fonts } from 'tailwind-vite-font-kit'

export default defineConfig({
  plugins: [
    nitro({
      routeRules: {
        '/fonts/**': {
          headers: { 'access-control-allow-origin': 'https://fixture.invalid' },
        },
      },
    }),
    fonts(),
    tailwindcss(),
    tanstackStart(),
    react(),
  ],
})
