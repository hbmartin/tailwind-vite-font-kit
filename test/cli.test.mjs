// The `tss-fonts` CLI, driven as a real process against scratch projects.
//
// This is the only thing in the repo that DELETES the user's source: `adopt` strips the
// Google at-import and the --font-* declarations out of their Tailwind entry. The pieces
// it calls are well covered (test/codemod.test.mjs, test/vite-codemod.test.mjs); what was
// not covered is the orchestration around them — which is where the destructive decisions
// are made. Everything here is offline: no command exercised below touches the network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../bin/tss-fonts.mjs', import.meta.url))

const ENTRY = `@import 'tailwindcss';
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap');

@theme {
  --font-sans: 'Poppins', ui-sans-serif, system-ui, sans-serif;
}

.hero { font-family: 'Poppins', sans-serif; }
`

const VITE_CONFIG = `import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    tailwindcss(),
  ],
})
`

/** A scratch project with a Tailwind entry, plus whatever extra files a test needs. */
function project(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tss-cli-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const all = { 'src/styles.css': ENTRY, ...files }
  for (const [rel, body] of Object.entries(all)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body)
  }
  return root
}

/** Run the CLI. Returns {status, out} rather than throwing, so exit codes can be asserted. */
function run(root, ...args) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args, '--cwd', root], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // NO_COLOR keeps the assertions about message text free of escape sequences.
      env: { ...process.env, NO_COLOR: '1' },
    })
    return { status: 0, out }
  } catch (err) {
    return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

const read = (root, rel) => readFileSync(join(root, rel), 'utf8')

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

test('init migrates the CSS, captures the config, and wires vite.config', (t) => {
  const root = project(t, { 'vite.config.ts': VITE_CONFIG })
  const { status } = run(root, 'init')
  assert.equal(status, 0)

  const css = read(root, 'src/styles.css')
  assert.ok(!css.includes('fonts.googleapis.com'), 'the render-blocking import must go')
  assert.ok(!/--font-sans\s*:/.test(css), 'the generated theme owns --font-sans now')
  assert.match(css, /font-family:\s*var\(--font-sans\)/, 'hand-written rules point at the var')
  assert.match(css, /@import 'tailwindcss'/, 'the entry import survives')

  // adopt DELETES the only record of which fonts the project used, so it has to persist
  // what it found or the information is gone.
  const cfg = read(root, 'fonts.config.mjs')
  assert.match(cfg, /name: 'Poppins'/)
  assert.match(cfg, /weights: \[400, 600, 700\]/, 'weights come from the URL that was removed')

  const vite = read(root, 'vite.config.ts')
  assert.match(vite, /import \{ fonts \} from 'tailwind-vite-font-kit'/)
  assert.match(vite, /fonts\(\),\s*\n\s*tailwindcss\(\)/, 'fonts() must precede tailwindcss()')
})

test('--dry-run writes nothing at all', (t) => {
  const root = project(t, { 'vite.config.ts': VITE_CONFIG })
  const { status, out } = run(root, 'init', '--dry-run')
  assert.equal(status, 0)
  assert.match(out, /--dry-run/)
  assert.equal(read(root, 'src/styles.css'), ENTRY, 'the entry was modified')
  assert.equal(read(root, 'vite.config.ts'), VITE_CONFIG, 'the vite config was modified')
  assert.ok(!existsSync(join(root, 'fonts.config.mjs')), 'a config file was written')
})

test('adopt is idempotent — a second run changes nothing', (t) => {
  const root = project(t)
  run(root, 'adopt')
  const after = read(root, 'src/styles.css')
  const cfg = read(root, 'fonts.config.mjs')

  const { status, out } = run(root, 'adopt')
  assert.equal(status, 0)
  assert.match(out, /nothing to (do|change)/)
  assert.equal(read(root, 'src/styles.css'), after)
  assert.equal(read(root, 'fonts.config.mjs'), cfg)
})

test('a backup is written for edited files, but not for new ones', (t) => {
  const root = project(t)
  run(root, 'adopt')
  assert.ok(existsSync(join(root, 'src/styles.css.bak')), 'the edited entry has no backup')
  assert.equal(read(root, 'src/styles.css.bak'), ENTRY, 'the backup should be the original')
  assert.ok(
    !existsSync(join(root, 'fonts.config.mjs.bak')),
    'a file that did not exist has nothing to back up',
  )
})

// ---------------------------------------------------------------------------
// the refusal — the most important thing this CLI does
// ---------------------------------------------------------------------------

// `shadcn add` always drops the template config, so on a project already using different
// fonts the config and the CSS disagree. Adopting would delete the CSS naming the real
// families, which is the only record of them.
test('adopt refuses when the config names different fonts than the CSS', (t) => {
  const root = project(t, {
    'fonts.config.mjs': `export default {
  families: [{ name: 'Manrope', themeVar: '--font-sans', weights: [400] }],
}
`,
  })
  const { status, out } = run(root, 'adopt')
  assert.equal(status, 1, 'this must not be a warn-and-proceed')
  assert.match(out, /stopped/)
  assert.match(out, /Poppins/, 'the message should name what the CSS actually uses')
  assert.match(out, /--from-css/)
  assert.match(out, /--force/)
  assert.equal(
    read(root, 'src/styles.css'),
    ENTRY,
    'nothing may be deleted before this is resolved',
  )
})

test('--from-css adopts what the project really uses', (t) => {
  const root = project(t, {
    'fonts.config.mjs': `export default {
  families: [{ name: 'Manrope', themeVar: '--font-sans', weights: [400] }],
}
`,
  })
  const { status } = run(root, 'adopt', '--from-css')
  assert.equal(status, 0)
  assert.match(read(root, 'fonts.config.mjs'), /name: 'Poppins'/, 'the config should be rewritten')
  assert.ok(!read(root, 'src/styles.css').includes('googleapis'))
})

test('--force proceeds with the config as written', (t) => {
  const root = project(t, {
    'fonts.config.mjs': `export default {
  families: [{ name: 'Manrope', themeVar: '--font-sans', weights: [400] }],
}
`,
  })
  const { status } = run(root, 'adopt', '--force')
  assert.equal(status, 0)
  assert.match(read(root, 'fonts.config.mjs'), /Manrope/, 'the config must be left alone')
})

// ---------------------------------------------------------------------------
// config validation — this runs BEFORE anything is deleted
// ---------------------------------------------------------------------------

const badConfigs = {
  'a missing families array': 'export default { fmilies: [] }',
  'a themeVar outside the --font-* namespace': `export default {
    families: [{ name: 'Poppins', themeVar: 'font-sans', weights: [400] }] }`,
  'a family with neither weights nor axes': `export default {
    families: [{ name: 'Poppins', themeVar: '--font-sans' }] }`,
  'an empty families array': 'export default { families: [] }',
}

for (const [what, body] of Object.entries(badConfigs)) {
  test(`adopt refuses ${what}, without a stack trace`, (t) => {
    const root = project(t, { 'fonts.config.mjs': body })
    const { status, out } = run(root, 'adopt')
    assert.equal(status, 1)
    assert.match(out, /\[tss-fonts\] fonts\.config\.mjs:/, 'the error should name the file')
    assert.ok(
      !/TypeError|Cannot read properties/.test(out),
      `crashed instead of explaining:\n${out}`,
    )
    assert.equal(read(root, 'src/styles.css'), ENTRY, 'nothing may be deleted on a bad config')
  })
}

test('a config that will not even parse is reported, not thrown', (t) => {
  const root = project(t, { 'fonts.config.mjs': 'export default { families: [ }' })
  const { status, out } = run(root, 'adopt')
  assert.equal(status, 1)
  assert.match(out, /could not load fonts\.config\.mjs/)
  assert.equal(read(root, 'src/styles.css'), ENTRY)
})

// ---------------------------------------------------------------------------
// the rest
// ---------------------------------------------------------------------------

test('a project with nothing to adopt says so and succeeds', (t) => {
  // Already migrated: no Google import, no --font-* left to find.
  const root = project(t, { 'src/styles.css': `@import 'tailwindcss';\n.x { color: red }\n` })
  const { status, out } = run(root, 'adopt')
  assert.equal(status, 0, 'an already-migrated project is not an error')
  assert.match(out, /nothing to adopt/)
})

test('no Tailwind entry is an error that says how to fix it', (t) => {
  const root = project(t, { 'src/styles.css': '.x { color: red }' })
  const { status, out } = run(root, 'adopt')
  assert.equal(status, 1)
  assert.match(out, /could not find a stylesheet containing/)
  assert.match(out, /--cwd/)
})

test('an unknown command does not silently do nothing', (t) => {
  const root = project(t)
  const { status, out } = run(root, 'frobnicate')
  assert.equal(status, 1)
  assert.match(out, /unknown command "frobnicate"/)
})

test('init without a vite config prints the snippet instead of failing', (t) => {
  const root = project(t)
  const { status, out } = run(root, 'init')
  assert.equal(status, 0)
  assert.match(out, /no vite\.config\.ts found/)
  assert.match(out, /BEFORE tailwindcss\(\)/, 'ordering is the thing people get wrong')
})

test('init leaves an already-wired vite config alone', (t) => {
  const wired = VITE_CONFIG.replace(
    "import tailwindcss from '@tailwindcss/vite'",
    "import tailwindcss from '@tailwindcss/vite'\nimport { fonts } from 'tailwind-vite-font-kit'",
  )
  const root = project(t, { 'vite.config.ts': wired })
  const { status, out } = run(root, 'init')
  assert.equal(status, 0)
  assert.match(out, /already has the plugin/)
  assert.equal(read(root, 'vite.config.ts'), wired)
})

// adopt deletes the declarations that were applying the fonts, and unlike init it does
// not wire the plugin — so between the two commands the app has no fonts at all. That was
// a dim footnote printed either way; it is now a warning, and only when it applies.
test('adopt warns loudly when the plugin is not wired up yet', (t) => {
  const root = project(t, { 'vite.config.ts': VITE_CONFIG })
  const { out } = run(root, 'adopt')
  assert.match(out, /Your app has no fonts until you add the plugin/)
  assert.match(out, /npx tss-fonts init/, 'it should offer the one-command fix')
  assert.match(out, /BEFORE tailwindcss\(\)/, 'ordering is the thing people get wrong')
})

test('adopt stays quiet when the plugin is already wired up', (t) => {
  const wired = VITE_CONFIG.replace(
    "import tailwindcss from '@tailwindcss/vite'",
    "import tailwindcss from '@tailwindcss/vite'\nimport { fonts } from 'tailwind-vite-font-kit'",
  ).replace('tailwindcss(),', 'fonts(),\n    tailwindcss(),')
  const root = project(t, { 'vite.config.ts': wired })
  const { out } = run(root, 'adopt')
  assert.ok(!out.includes('has no fonts'), 'nothing is wrong, so nothing should be alarming')
  assert.match(out, /already has the plugin/)
})

// The package name alone is not wiring: an import nothing calls (or a commented-out
// line) leaves the app with no fonts, which is exactly what the warning is for.
test('adopt still warns when the plugin is imported but never called', (t) => {
  const imported = VITE_CONFIG.replace(
    "import tailwindcss from '@tailwindcss/vite'",
    "import tailwindcss from '@tailwindcss/vite'\nimport { fonts } from 'tailwind-vite-font-kit'",
  )
  const root = project(t, { 'vite.config.ts': imported })
  const { out } = run(root, 'adopt')
  assert.match(out, /Your app has no fonts until you add the plugin/)
})

test('NO_COLOR is honoured across the whole output, not just the diffs', (t) => {
  const root = project(t, { 'vite.config.ts': VITE_CONFIG })
  const { out } = run(root, 'init')
  // eslint-disable-next-line no-control-regex -- asserting the ABSENCE of escape codes
  assert.ok(!/\[/.test(out), 'found ANSI escapes despite NO_COLOR')
})

// The opsz measurement itself needs the network; everything here dies before it.
test('opsz rejects sizes and weights that are not positive numbers', (t) => {
  const root = project(t)
  for (const [flag, value] of [
    ['sizes', 'foo'],
    ['sizes', '16,,48'],
    ['weights', '0,-400'],
  ]) {
    const res = run(root, 'opsz', 'Fraunces', `--${flag}`, value)
    assert.equal(res.status, 1, `--${flag} ${value} must be rejected`)
    assert.match(res.out, new RegExp(`--${flag} expects a comma-separated list`))
  }
})

test('opsz refuses a malformed fonts.config.mjs rather than measuring around it', (t) => {
  // themeVar missing: --write would then do text surgery on a config the package
  // itself considers broken.
  const root = project(t, {
    'fonts.config.mjs': `export default { families: [{ name: 'Poppins' }] }`,
  })
  const res = run(root, 'opsz', 'Poppins')
  assert.equal(res.status, 1)
  assert.match(res.out, /\[tss-fonts\] fonts\.config\.mjs:/)
})

test('opsz with no family and no config says what to do', (t) => {
  const root = project(t)
  const res = run(root, 'opsz')
  assert.equal(res.status, 1)
  assert.match(res.out, /name a family/)
})

test('early-hints writes a server entry, and never overwrites one', (t) => {
  // No tsconfig on purpose: Start resolves src/server.ts as the entry either way, so
  // the extension must not depend on one.
  const root = project(t)
  assert.equal(run(root, 'early-hints').status, 0)
  const entry = read(root, 'src/server.ts')
  assert.match(entry, /createFontsServerEntry/)
  assert.match(entry, /tailwind-vite-font-kit\/start-server/)

  // Re-running is a no-op...
  const again = run(root, 'early-hints')
  assert.equal(again.status, 0)
  assert.match(again.out, /already this entry/)

  // ...and a hand-written entry is not ours to replace.
  writeFileSync(join(root, 'src/server.ts'), '// mine\n')
  const mine = run(root, 'early-hints')
  assert.equal(mine.status, 0)
  assert.match(mine.out, /already exists/)
  assert.equal(read(root, 'src/server.ts'), '// mine\n')
})
