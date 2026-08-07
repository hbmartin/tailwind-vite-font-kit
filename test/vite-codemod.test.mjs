import { test } from 'node:test'
import assert from 'node:assert/strict'
import { insertFontsPlugin } from '../src/codemod-vite.mjs'

const HEADER = `import { defineConfig } from 'vite'\nimport tailwindcss from '@tailwindcss/vite'\n\n`
const IMPORT = `import { fonts } from 'tailwind-vite-font-kit'`
const count = (s, sub) => s.split(sub).length - 1

test('inserts before tailwindcss() with a trailing comma', () => {
  const src =
    HEADER +
    `export default defineConfig({\n  plugins: [\n    tailwindcss(),\n    react(),\n  ],\n})\n`
  const out = insertFontsPlugin(src)
  assert.match(out, /import \{ fonts \} from 'tailwind-vite-font-kit'/)
  assert.match(out, /\n    fonts\(\),\n    tailwindcss\(\),/)
})

test('inserts before a final tailwindcss() with no trailing comma', () => {
  const src =
    HEADER +
    `export default defineConfig({\n  plugins: [\n    react(),\n    tailwindcss()\n  ],\n})\n`
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

test('produces the exact expected file', () => {
  const src = HEADER + `export default defineConfig({\n  plugins: [tailwindcss()],\n})\n`
  assert.equal(
    insertFontsPlugin(src),
    `import { defineConfig } from 'vite'\n` +
      `import tailwindcss from '@tailwindcss/vite'\n` +
      IMPORT +
      `\n\nexport default defineConfig({\n  plugins: [fonts(), tailwindcss()],\n})\n`,
  )
})

test('the import and the entry are each emitted exactly once', () => {
  const src = HEADER + `export default defineConfig({\n  plugins: [\n    tailwindcss(),\n  ],\n})\n`
  const out = insertFontsPlugin(src)
  assert.equal(count(out, IMPORT), 1)
  assert.equal(count(out, 'fonts(),'), 1)
})

test('leaves a multiline final import intact', () => {
  const src =
    `import { defineConfig } from 'vite'\n` +
    `import {\n  tailwindcss,\n} from '@tailwindcss/vite'\n\n` +
    `export default defineConfig({ plugins: [tailwindcss()] })\n`
  const out = insertFontsPlugin(src)
  assert.match(out, /import \{\n  tailwindcss,\n\} from '@tailwindcss\/vite'\n/)
  assert.match(
    out,
    /'@tailwindcss\/vite'\nimport \{ fonts \} from 'tailwind-vite-font-kit'\n\nexport default/,
  )
  assert.equal(count(out, IMPORT), 1)
})

test('handles a semicolon-terminated final import', () => {
  const src = `import tailwindcss from '@tailwindcss/vite';\n\nexport default { plugins: [tailwindcss()] };\n`
  const out = insertFontsPlugin(src)
  assert.match(out, /'@tailwindcss\/vite';\nimport \{ fonts \} from 'tailwind-vite-font-kit'\n\n/)
})

test('returns null when there is no import declaration to hang fonts() off', () => {
  const src = `const tailwindcss = require('@tailwindcss/vite')\n\nmodule.exports = { plugins: [tailwindcss()] }\n`
  assert.equal(insertFontsPlugin(src), null)
})

test('ignores a tailwindcss() inside a comment', () => {
  const src =
    HEADER + `// plugins: [tailwindcss()],\nexport default defineConfig({ plugins: [] })\n`
  assert.equal(insertFontsPlugin(src), null)
})

test('anchors on the real entry when a comment also mentions tailwindcss()', () => {
  const src =
    HEADER +
    `// was: plugins: [tailwindcss()],\nexport default defineConfig({ plugins: [tailwindcss()] })\n`
  const out = insertFontsPlugin(src)
  assert.match(out, /\/\/ was: plugins: \[tailwindcss\(\)\],\n/) // comment untouched
  assert.match(out, /defineConfig\(\{ plugins: \[fonts\(\), tailwindcss\(\)\] \}\)/)
  assert.equal(count(out, 'fonts(),'), 1)
})

test('returns null for a tailwindcss() outside the plugins array', () => {
  const src =
    HEADER +
    `export default defineConfig({ css: { postcss: { plugins: [] } }, build: { rollupOptions: [tailwindcss()] } })\n`
  assert.equal(insertFontsPlugin(src), null)
})

test('returns null when two tailwindcss() entries make the anchor ambiguous', () => {
  const src =
    HEADER +
    `const a = [tailwindcss()]\nexport default defineConfig({ plugins: [tailwindcss()] })\n`
  assert.equal(insertFontsPlugin(src), null)
})

test('accepts a helper plugins array', () => {
  const src =
    HEADER + `const plugins = [\n  tailwindcss(),\n]\nexport default defineConfig({ plugins })\n`
  const out = insertFontsPlugin(src)
  assert.match(out, /const plugins = \[\n  fonts\(\),\n  tailwindcss\(\),\n\]/)
})

test('accepts a type-annotated helper plugins array', () => {
  const src =
    HEADER +
    `const plugins: PluginOption[] = [tailwindcss()]\nexport default defineConfig({ plugins })\n`
  const out = insertFontsPlugin(src)
  assert.match(out, /const plugins: PluginOption\[\] = \[fonts\(\), tailwindcss\(\)\]/)
})

test('accepts a plugins factory that takes an argument', () => {
  const src = HEADER + `export default defineConfig({ plugins: (env) => [tailwindcss()] })\n`
  const out = insertFontsPlugin(src)
  assert.match(out, /plugins: \(env\) => \[fonts\(\), tailwindcss\(\)\]/)
})

// The anchor used to accept ANY assigned array, because its `=>?` matched a bare `=`.
test('returns null for an assigned array that is not named plugins', () => {
  const src = HEADER + `const shared = [tailwindcss()]\nexport default defineConfig({})\n`
  assert.equal(insertFontsPlugin(src), null)
})

test('returns null for an arrow-returned array that is not the plugins entry', () => {
  const src = HEADER + `const build = () => [tailwindcss()]\nexport default defineConfig({})\n`
  assert.equal(insertFontsPlugin(src), null)
})

test('returns null for an array whose name merely ends in Plugins', () => {
  const src = HEADER + `const postcssPlugins = [tailwindcss()]\nexport default defineConfig({})\n`
  assert.equal(insertFontsPlugin(src), null)
})

// A `plugins` key earlier on the same line must not anchor an unrelated later array.
test('returns null when an unrelated key on the plugins line holds the call', () => {
  const src =
    HEADER +
    `export default defineConfig({ plugins: [], build: { rollupOptions: [tailwindcss()] } })\n`
  assert.equal(insertFontsPlugin(src), null)
})
