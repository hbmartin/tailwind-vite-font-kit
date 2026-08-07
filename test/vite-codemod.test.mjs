import { test } from 'node:test'
import assert from 'node:assert/strict'
import { insertFontsPlugin } from '../src/codemod-vite.mjs'

const HEADER = `import { defineConfig } from 'vite'\nimport tailwindcss from '@tailwindcss/vite'\n\n`

test('inserts before tailwindcss() with a trailing comma', () => {
  const src = HEADER + `export default defineConfig({\n  plugins: [\n    tailwindcss(),\n    react(),\n  ],\n})\n`
  const out = insertFontsPlugin(src)
  assert.match(out, /import \{ fonts \} from 'tailwind-vite-font-kit'/)
  assert.match(out, /\n    fonts\(\),\n    tailwindcss\(\),/)
})

test('inserts before a final tailwindcss() with no trailing comma', () => {
  const src = HEADER + `export default defineConfig({\n  plugins: [\n    react(),\n    tailwindcss()\n  ],\n})\n`
  const out = insertFontsPlugin(src)
  assert.match(out, /\n    fonts\(\),\n    tailwindcss\(\)\n/)
})

test('inserts into a single-line plugins array', () => {
  const src = HEADER + `export default defineConfig({ plugins: [tailwindcss()] })\n`
  const out = insertFontsPlugin(src)
  assert.match(out, /plugins: \[fonts\(\), tailwindcss\(\)\] /)
})

test('returns null when there is no tailwindcss() entry to anchor on', () => {
  assert.equal(insertFontsPlugin(HEADER + `export default defineConfig({ plugins: [] })\n`), null)
})
