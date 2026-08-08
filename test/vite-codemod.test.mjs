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

// fonts() is a Vite plugin. `css.postcss.plugins` is spelled identically to the Vite key,
// and the anchor used to accept it, writing a config that loads and then fails.
test('returns null when the only tailwindcss() is in css.postcss.plugins', () => {
  const src =
    HEADER +
    `export default defineConfig({\n  css: { postcss: { plugins: [tailwindcss()] } },\n})\n`
  assert.equal(insertFontsPlugin(src), null)
})

test('returns null when the only tailwindcss() is in build.rollupOptions.plugins', () => {
  const src =
    HEADER +
    `export default defineConfig({\n  build: { rollupOptions: { plugins: [tailwindcss()] } },\n})\n`
  assert.equal(insertFontsPlugin(src), null)
})

// The rejection is about depth, not the word `postcss`: a real plugins array still takes
// the insert when a nested one sits alongside it.
test('inserts into the Vite plugins array despite a nested postcss plugins array', () => {
  const src =
    HEADER +
    `export default defineConfig({\n  plugins: [tailwindcss()],\n  css: { postcss: { plugins: [autoprefixer()] } },\n})\n`
  const out = insertFontsPlugin(src)
  assert.match(out, /\n  plugins: \[fonts\(\), tailwindcss\(\)\],\n/)
  assert.match(out, /postcss: \{ plugins: \[autoprefixer\(\)\] \}/) // untouched
  assert.equal(count(out, 'fonts(),'), 1)
})

// A config object reached through a callback is still top level — the enclosing braces
// are anonymous, so the depth check must not reject it.
test('accepts a config object returned from a defineConfig callback', () => {
  const src =
    HEADER + `export default defineConfig(({ mode }) => ({\n  plugins: [tailwindcss()],\n}))\n`
  const out = insertFontsPlugin(src)
  assert.match(out, /\n  plugins: \[fonts\(\), tailwindcss\(\)\],\n/)
})

test('accepts a config object returned from a callback body', () => {
  const src =
    HEADER +
    `export default defineConfig(({ mode }) => {\n  const env = loadEnv(mode)\n  return { plugins: [tailwindcss()] }\n})\n`
  const out = insertFontsPlugin(src)
  assert.match(out, /return \{ plugins: \[fonts\(\), tailwindcss\(\)\] \}/)
})

test('accepts a config merged onto a base', () => {
  const src =
    HEADER + `export default defineConfig(mergeConfig(base, {\n  plugins: [tailwindcss()],\n}))\n`
  const out = insertFontsPlugin(src)
  assert.match(out, /\n  plugins: \[fonts\(\), tailwindcss\(\)\],\n/)
})

test('accepts a hoisted config object handed to defineConfig', () => {
  const src =
    HEADER +
    `const config = {\n  plugins: [tailwindcss()],\n}\nexport default defineConfig(config)\n`
  const out = insertFontsPlugin(src)
  assert.match(out, /const config = \{\n  plugins: \[fonts\(\), tailwindcss\(\)\],\n\}/)
})

test('accepts a type-annotated hoisted config object exported directly', () => {
  const src =
    HEADER + `const config: UserConfig = {\n  plugins: [tailwindcss()],\n}\nexport default config\n`
  const out = insertFontsPlugin(src)
  assert.match(out, /const config: UserConfig = \{\n  plugins: \[fonts\(\), tailwindcss\(\)\],\n\}/)
})

// Nesting is not always spelled as nesting. A call between the key and its object leaves
// every enclosing brace anonymous, so a keyed-ancestor check waves the postcss array through.
test('returns null for a plugins array wrapped in an unknown call', () => {
  const src =
    HEADER +
    `export default defineConfig({\n  css: createPostcss({ plugins: [tailwindcss()] }),\n})\n`
  assert.equal(insertFontsPlugin(src), null)
})

// Same hole without the wrapper: a const binding never had a key to be found on.
test('returns null for a hoisted postcss config object', () => {
  const src =
    HEADER +
    `const postcssConfig = {\n  plugins: [tailwindcss()],\n}\nexport default defineConfig({ css: { postcss: postcssConfig } })\n`
  assert.equal(insertFontsPlugin(src), null)
})
