import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { diagnoseResolvedConfig, loadProjectVite } from '../src/doctor.mjs'
import { isDoctorContext, runInDoctorContext } from '../src/doctor-context.mjs'
import { resolvePreloadDelivery } from '../src/preload-delivery.mjs'

const VITE_EXTENSIONS = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json']

function fixtureFile(candidate) {
  const exact = (() => {
    try {
      return statSync(candidate).isFile() ? candidate : undefined
    } catch {
      return undefined
    }
  })()
  if (exact) return exact

  const extension = extname(candidate)
  const replacements =
    extension === '.js'
      ? ['.ts', '.tsx']
      : extension === '.mjs'
        ? ['.mts']
        : extension === '.cjs'
          ? ['.cts']
          : extension === '.jsx'
            ? ['.tsx']
            : []
  for (const replacement of replacements) {
    const file = candidate.slice(0, -extension.length) + replacement
    if (existsSync(file)) return file
  }
  if (!extension) {
    for (const suffix of VITE_EXTENSIONS) {
      const file = candidate + suffix
      if (existsSync(file)) return file
    }
    for (const suffix of VITE_EXTENSIONS) {
      const file = join(candidate, `index${suffix}`)
      if (existsSync(file)) return file
    }
  }
  return undefined
}

function fixtureResolver(root, config) {
  return async (specifier, importer) => {
    let id = specifier
    let aliasApplied = false
    const configured = config.resolve?.alias
    const aliases = Array.isArray(configured)
      ? configured
      : configured && typeof configured === 'object'
        ? Object.entries(configured).map(([find, replacement]) => ({ find, replacement }))
        : []
    for (const alias of aliases) {
      const matches =
        typeof alias.find === 'string'
          ? id === alias.find || id.startsWith(`${alias.find}/`)
          : (() => {
              alias.find.lastIndex = 0
              return alias.find.test(id)
            })()
      if (!matches) continue
      if (alias.find instanceof RegExp) alias.find.lastIndex = 0
      id = id.replace(alias.find, alias.replacement)
      aliasApplied = true
      break
    }

    if (/^(?:\0|virtual:)/.test(id)) return aliasApplied ? id : undefined
    if (id.startsWith('node:')) return id
    const clean = id.split(/[?#]/, 1)[0]
    let candidate
    if (isAbsolute(clean)) {
      candidate = fixtureFile(clean) ? clean : resolve(root, `.${clean}`)
    } else if (clean.startsWith('./') || clean.startsWith('../')) {
      candidate = resolve(importer ? dirname(importer) : root, clean)
    } else if (aliasApplied) {
      candidate = resolve(root, clean)
    } else {
      const packageName = clean.startsWith('@')
        ? clean.split('/').slice(0, 2).join('/')
        : clean.split('/', 1)[0]
      const packageSubpath = clean.slice(packageName.length).replace(/^\//, '')
      candidate = join(root, 'node_modules', packageName, packageSubpath)
    }
    return fixtureFile(candidate)
  }
}

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tss-fonts-doctor-'))
  const filesDir = join(root, 'generated')
  mkdirSync(filesDir)
  writeFileSync(join(root, 'styles.css'), `@import 'tailwindcss';\n`)
  writeFileSync(join(filesDir, 'manrope-test.woff2'), Buffer.from('wOF2font'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const options = {
    families: [{ name: 'Manrope', themeVar: '--font-sans', weights: [400] }],
    preloadHtml: 'auto',
    preloadHeader: true,
    ...overrides.options,
  }
  const generation = {
    filesDir,
    files: ['manrope-test.woff2'],
    digests: { 'manrope-test.woff2': { sha256: 'unused', bytes: 8 } },
    preloads: [
      {
        rel: 'preload',
        as: 'font',
        type: 'font/woff2',
        href: '/fonts/manrope-test.woff2',
        crossOrigin: 'anonymous',
      },
    ],
    sourceRequests: [],
    ...overrides.generation,
  }
  const diagnostics = {
    options,
    generation,
    warnings: [],
    warningEvents: [],
    hasNitro: false,
    selfHosts: true,
    ...overrides.diagnostics,
  }
  diagnostics.delivery ??= resolvePreloadDelivery(options, {
    preloadCount: generation.preloads.length,
    hasNitro: diagnostics.hasNitro,
    htmlEntryDetected: true,
  })
  const font = {
    name: 'tailwind-vite-font-kit',
    api: { getDiagnostics: () => diagnostics },
  }
  const resolved = { plugins: [font, { name: '@tailwindcss/vite:scan' }] }
  resolved.createResolver = () => fixtureResolver(root, resolved)
  return {
    root,
    font,
    resolved,
  }
}

function disableAutomaticDelivery(item) {
  const diagnostics = item.font.api.getDiagnostics()
  diagnostics.delivery = resolvePreloadDelivery(diagnostics.options, {
    preloadCount: diagnostics.generation.preloads.length,
    hasNitro: false,
    htmlEntryDetected: false,
  })
}

const hasCheck = (checks, status, message) =>
  checks.some((check) => check.status === status && message.test(check.message))

test('doctor passes generation checks and warns for valid plain-Vite fallbacks', async (t) => {
  const { root, resolved } = fixture(t)
  const checks = await diagnoseResolvedConfig(root, resolved)
  assert.equal(
    checks.some((item) => item.status === 'failure'),
    false,
  )
  assert.ok(
    checks.some((item) => item.status === 'warning' && /Nitro is absent/.test(item.message)),
  )
  assert.ok(checks.some((item) => /8 bytes/.test(item.message)))
})

test('doctor fails plugin order, inline conflicts, and an exceeded zero budget', async (t) => {
  const { root, font, resolved } = fixture(t, { options: { preloadBudgetKb: 0 } })
  writeFileSync(
    join(root, 'styles.css'),
    `@import 'tailwindcss';\n@theme inline {\n  --font-sans: Arial;\n}\n`,
  )
  resolved.plugins = [{ name: '@tailwindcss/vite:scan' }, font]
  const checks = await diagnoseResolvedConfig(root, resolved)
  const failures = checks.filter((item) => item.status === 'failure').map((item) => item.message)
  assert.ok(failures.some((message) => /must be listed before/.test(message)))
  assert.ok(failures.some((message) => /@theme inline/.test(message)))
  assert.ok(failures.some((message) => /exceeding the 0 kB budget/.test(message)))
})

test('doctor reports a CDN measurement network failure', async (t) => {
  const { root, resolved } = fixture(t, {
    generation: {
      files: [],
      digests: {},
      preloads: [
        {
          rel: 'preload',
          as: 'font',
          type: 'font/woff2',
          href: 'https://fonts.gstatic.com/s/fake/font.woff2',
          crossOrigin: 'anonymous',
        },
      ],
    },
    diagnostics: { selfHosts: false },
  })
  const checks = await diagnoseResolvedConfig(root, resolved, {
    fetchImpl: async (_url, options) => {
      assert.ok(options.signal instanceof AbortSignal)
      throw new Error('offline')
    },
  })
  assert.ok(
    checks.some(
      (item) => item.status === 'failure' && /could not measure.*offline/.test(item.message),
    ),
  )
})

test('doctor handles Nitro, explicit HTML, manual, and missing delivery paths', async (t) => {
  const scenarios = [
    {
      name: 'Nitro header',
      options: {},
      diagnostics: { hasNitro: true },
      htmlEntryDetected: false,
      status: 'pass',
      message: /Nitro will deliver/,
    },
    {
      name: 'Nitro explicit HTML',
      options: { preloadHeader: false, preloadHtml: true },
      diagnostics: { hasNitro: true },
      htmlEntryDetected: false,
      status: 'warning',
      message: /Nitro production HTML does not use Vite's HTML transform/,
    },
    {
      name: 'manual HTML',
      options: { preloadHtml: false },
      diagnostics: { hasNitro: false },
      htmlEntryDetected: false,
      status: 'warning',
      message: /manual font preload delivery/,
    },
    {
      name: 'missing HTML',
      options: {},
      diagnostics: { hasNitro: false },
      htmlEntryDetected: false,
      status: 'failure',
      message: /no automatic Nitro or HTML delivery path/,
    },
  ]

  for (const scenario of scenarios) {
    const item = fixture(t, { options: scenario.options, diagnostics: scenario.diagnostics })
    const diagnostics = item.font.api.getDiagnostics()
    diagnostics.delivery = resolvePreloadDelivery(diagnostics.options, {
      preloadCount: diagnostics.generation.preloads.length,
      hasNitro: diagnostics.hasNitro,
      htmlEntryDetected: scenario.htmlEntryDetected,
    })
    const checks = await diagnoseResolvedConfig(item.root, item.resolved)
    assert.ok(
      checks.some(
        (check) => check.status === scenario.status && scenario.message.test(check.message),
      ),
      scenario.name,
    )
  }
})

test('doctor recognizes the package Start server entry and classifies its guarantees', async (t) => {
  const scenarios = [
    {
      name: 'Link fallback',
      args: '{ linkHeader: true }',
      status: 'pass',
      message: /deliver font preload Link headers/,
    },
    {
      name: 'quoted Link fallback',
      args: "{ 'linkHeader': true }",
      status: 'pass',
      message: /deliver font preload Link headers/,
    },
    {
      name: 'Early Hints only',
      args: '',
      status: 'warning',
      message: /Early Hints without a Link-header fallback/,
    },
    {
      name: 'dynamic options',
      args: 'serverOptions',
      declaration: 'const serverOptions = getServerOptions()\n',
      status: 'warning',
      message: /could not be verified/,
    },
    {
      name: 'nested unrelated option',
      args: '{ createHandler: { linkHeader: true } }',
      status: 'warning',
      message: /Early Hints without a Link-header fallback/,
    },
    {
      name: 'disabled delivery',
      args: '{ earlyHints: false, linkHeader: false }',
      status: 'failure',
      message: /no automatic Nitro or HTML delivery path/,
    },
  ]

  for (const scenario of scenarios) {
    const item = fixture(t)
    mkdirSync(join(item.root, 'src'))
    writeFileSync(
      join(item.root, 'src', 'server.ts'),
      `import { createFontsServerEntry as makeFontsServer } from 'tailwind-vite-font-kit/start-server'\n` +
        (scenario.declaration ?? '') +
        `export default makeFontsServer(${scenario.args})\n`,
    )
    const diagnostics = item.font.api.getDiagnostics()
    diagnostics.delivery = resolvePreloadDelivery(diagnostics.options, {
      preloadCount: diagnostics.generation.preloads.length,
      hasNitro: false,
      htmlEntryDetected: false,
    })
    const checks = await diagnoseResolvedConfig(item.root, item.resolved)
    assert.ok(
      checks.some(
        (check) => check.status === scenario.status && scenario.message.test(check.message),
      ),
      scenario.name,
    )
  }
})

test('doctor discovers supported server-entry extensions and custom source paths', async (t) => {
  for (const relativePath of [
    'src/server.tsx',
    'src/server.mts',
    'src/server.cts',
    'src/server.cjs',
    'application/http-entry.jsx',
  ]) {
    const item = fixture(t)
    const file = join(item.root, relativePath)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(
      file,
      `import { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'\n` +
        `export default createFontsServerEntry({ linkHeader: true })\n`,
    )
    const diagnostics = item.font.api.getDiagnostics()
    diagnostics.delivery = resolvePreloadDelivery(diagnostics.options, {
      preloadCount: diagnostics.generation.preloads.length,
      hasNitro: false,
      htmlEntryDetected: false,
    })
    const checks = await diagnoseResolvedConfig(item.root, item.resolved)
    assert.ok(
      checks.some(
        (check) =>
          check.status === 'pass' && /deliver font preload Link headers/.test(check.message),
      ),
      relativePath,
    )
  }
})

test('doctor follows the resolved Start entry through a local default re-export', async (t) => {
  const item = fixture(t)
  const entry = join(item.root, 'src/server.ts')
  const implementation = join(item.root, 'src/font-server.ts')
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(entry, `export { default } from './font-server'\n`)
  writeFileSync(
    implementation,
    `import {createFontsServerEntry}from 'tailwind-vite-font-kit/start-server'\n` +
      `export default createFontsServerEntry({ linkHeader: true })\n`,
  )
  item.resolved.environments = {
    ssr: { build: { rollupOptions: { input: 'virtual:tanstack-start-server-entry' } } },
  }
  item.resolved.resolve = {
    alias: [{ find: 'virtual:tanstack-start-server-entry', replacement: entry }],
  }
  const diagnostics = item.font.api.getDiagnostics()
  diagnostics.delivery = resolvePreloadDelivery(diagnostics.options, {
    preloadCount: diagnostics.generation.preloads.length,
    hasNitro: false,
    htmlEntryDetected: false,
  })

  const checks = await diagnoseResolvedConfig(item.root, item.resolved)
  assert.ok(
    checks.some(
      (check) => check.status === 'pass' && /deliver font preload Link headers/.test(check.message),
    ),
  )
})

test('doctor follows root-absolute and string-alias default-export chains', async (t) => {
  const item = fixture(t)
  const entry = join(item.root, 'app/entry.ts')
  const bridge = join(item.root, 'src/bridge.ts')
  const implementation = join(item.root, 'src/font-server.ts')
  mkdirSync(dirname(entry), { recursive: true })
  mkdirSync(dirname(bridge), { recursive: true })
  writeFileSync(entry, `export { default } from '#server/bridge'\n`)
  writeFileSync(
    bridge,
    `import implementation from '/src/font-server'\nexport default implementation\n`,
  )
  writeFileSync(
    implementation,
    `import { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'\n` +
      `export default createFontsServerEntry({ linkHeader: true })\n`,
  )
  item.resolved.environments = {
    ssr: { build: { rollupOptions: { input: entry } } },
  }
  item.resolved.resolve = {
    alias: [
      { find: 'virtual:tanstack-start-server-entry', replacement: entry },
      { find: '#server', replacement: join(item.root, 'src') },
    ],
  }
  const diagnostics = item.font.api.getDiagnostics()
  diagnostics.delivery = resolvePreloadDelivery(diagnostics.options, {
    preloadCount: diagnostics.generation.preloads.length,
    hasNitro: false,
    htmlEntryDetected: false,
  })

  const checks = await diagnoseResolvedConfig(item.root, item.resolved)
  assert.ok(
    checks.some(
      (check) => check.status === 'pass' && /deliver font preload Link headers/.test(check.message),
    ),
  )
})

test('the authoritative Start alias accepts Vite replacement path forms and queries', async (t) => {
  for (const replacement of ['src/entry.ts', './src/entry.ts', '/src/entry.ts', 'absolute']) {
    const item = fixture(t)
    const entry = join(item.root, 'src/entry.ts')
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(
      entry,
      `import { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'\n` +
        `export default createFontsServerEntry({ linkHeader: true })\n`,
    )
    item.resolved.resolve = {
      alias: [
        {
          find: 'virtual:tanstack-start-server-entry',
          replacement: `${replacement === 'absolute' ? entry : replacement}?server-entry`,
        },
      ],
    }
    disableAutomaticDelivery(item)

    const checks = await diagnoseResolvedConfig(item.root, item.resolved)
    assert.ok(hasCheck(checks, 'pass', /deliver font preload Link headers/), replacement)
  }
})

test('configured local aliases are followed through the Vite resolver', async (t) => {
  for (const alias of ['~', '@', '#server']) {
    const item = fixture(t)
    const entry = join(item.root, 'src/entry.ts')
    const implementation = join(item.root, 'src/handler.ts')
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, `export { default } from '${alias}/handler'\n`)
    writeFileSync(
      implementation,
      `import { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'\n` +
        `export default createFontsServerEntry({ linkHeader: true })\n`,
    )
    item.resolved.resolve = {
      alias: [
        { find: 'virtual:tanstack-start-server-entry', replacement: entry },
        { find: alias, replacement: join(item.root, 'src') },
      ],
    }
    disableAutomaticDelivery(item)

    const checks = await diagnoseResolvedConfig(item.root, item.resolved)
    assert.ok(hasCheck(checks, 'pass', /deliver font preload Link headers/), alias)
  }
})

test('an authoritative entry in a sibling workspace package is inspected', async (t) => {
  const item = fixture(t)
  const sibling = mkdtempSync(join(tmpdir(), 'tss-fonts-sibling-'))
  t.after(() => rmSync(sibling, { recursive: true, force: true }))
  const entry = join(sibling, 'server.ts')
  writeFileSync(
    entry,
    `import { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'\n` +
      `export default createFontsServerEntry({ linkHeader: true })\n`,
  )
  item.resolved.resolve = {
    alias: [{ find: 'virtual:tanstack-start-server-entry', replacement: entry }],
  }
  disableAutomaticDelivery(item)

  const checks = await diagnoseResolvedConfig(item.root, item.resolved)
  assert.ok(hasCheck(checks, 'pass', /deliver font preload Link headers/))
})

test('the resolved Start entry is authoritative over unrelated helper users', async (t) => {
  const item = fixture(t)
  const entry = join(item.root, 'app/server.ts')
  const unrelated = join(item.root, 'application/preview.ts')
  mkdirSync(dirname(entry), { recursive: true })
  mkdirSync(dirname(unrelated), { recursive: true })
  writeFileSync(
    entry,
    `import { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'\n` +
      `export default createFontsServerEntry({ linkHeader: true })\n`,
  )
  writeFileSync(
    unrelated,
    `import { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'\n` +
      `export default createFontsServerEntry()\n`,
  )
  item.resolved.environments = {
    ssr: { build: { rolldownOptions: { input: { index: entry } } } },
  }
  item.resolved.resolve = {
    alias: [{ find: 'virtual:tanstack-start-server-entry', replacement: entry }],
  }
  const diagnostics = item.font.api.getDiagnostics()
  diagnostics.delivery = resolvePreloadDelivery(diagnostics.options, {
    preloadCount: diagnostics.generation.preloads.length,
    hasNitro: false,
    htmlEntryDetected: false,
  })

  const checks = await diagnoseResolvedConfig(item.root, item.resolved)
  assert.ok(
    checks.some(
      (check) => check.status === 'pass' && /deliver font preload Link headers/.test(check.message),
    ),
  )
})

test('filesystem fallback prefers a server-named helper entry', async (t) => {
  const item = fixture(t)
  const entry = join(item.root, 'app/server.ts')
  const implementation = join(item.root, 'app/font-server.ts')
  const unrelated = join(item.root, 'application/preview.ts')
  mkdirSync(dirname(entry), { recursive: true })
  mkdirSync(dirname(unrelated), { recursive: true })
  writeFileSync(entry, `export { default } from './font-server'\n`)
  writeFileSync(
    implementation,
    `import { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'\n` +
      `export default createFontsServerEntry({ linkHeader: true })\n`,
  )
  writeFileSync(
    unrelated,
    `import { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'\n` +
      `export default createFontsServerEntry()\n`,
  )
  const diagnostics = item.font.api.getDiagnostics()
  diagnostics.delivery = resolvePreloadDelivery(diagnostics.options, {
    preloadCount: diagnostics.generation.preloads.length,
    hasNitro: false,
    htmlEntryDetected: false,
  })

  const checks = await diagnoseResolvedConfig(item.root, item.resolved)
  assert.ok(
    checks.some(
      (check) => check.status === 'pass' && /deliver font preload Link headers/.test(check.message),
    ),
  )
})

test('dynamic authoritative default-export flows are uncertain rather than absent', async (t) => {
  const item = fixture(t)
  const entry = join(item.root, 'src/server.ts')
  const implementation = join(item.root, 'src/font-server.ts')
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(entry, `export default import('./font-server').then((module) => module.default)\n`)
  writeFileSync(
    implementation,
    `import { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'\n` +
      `export default createFontsServerEntry({ linkHeader: true })\n`,
  )
  item.resolved.environments = {
    ssr: { build: { rollupOptions: { input: entry } } },
  }
  item.resolved.resolve = {
    alias: [{ find: 'virtual:tanstack-start-server-entry', replacement: entry }],
  }
  const diagnostics = item.font.api.getDiagnostics()
  diagnostics.delivery = resolvePreloadDelivery(diagnostics.options, {
    preloadCount: diagnostics.generation.preloads.length,
    hasNitro: false,
    htmlEntryDetected: false,
  })

  const checks = await diagnoseResolvedConfig(item.root, item.resolved)
  assert.ok(
    checks.some(
      (check) => check.status === 'warning' && /could not be verified/.test(check.message),
    ),
  )
  assert.equal(
    checks.some((check) => /no automatic Nitro or HTML delivery path/.test(check.message)),
    false,
  )
})

test('unresolvable authoritative Start entries are uncertain rather than absent', async (t) => {
  const item = fixture(t)
  item.resolved.resolve = {
    alias: [
      {
        find: 'virtual:tanstack-start-server-entry',
        replacement: join(item.root, 'missing-server.ts'),
      },
    ],
  }
  const diagnostics = item.font.api.getDiagnostics()
  diagnostics.delivery = resolvePreloadDelivery(diagnostics.options, {
    preloadCount: diagnostics.generation.preloads.length,
    hasNitro: false,
    htmlEntryDetected: false,
  })

  const checks = await diagnoseResolvedConfig(item.root, item.resolved)
  assert.ok(
    checks.some(
      (check) => check.status === 'warning' && /could not be verified/.test(check.message),
    ),
  )
  assert.equal(
    checks.some((check) => /no automatic Nitro or HTML delivery path/.test(check.message)),
    false,
  )
})

test('generic SSR inputs do not masquerade as the resolved Start server entry', async (t) => {
  for (const [name, input] of [
    ['copied HTML input', 'index.html'],
    ['unrelated virtual input', 'virtual:other-framework-server'],
  ]) {
    const item = fixture(t)
    const entry = join(item.root, 'application/http-entry.ts')
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(join(item.root, 'index.html'), '<!doctype html><title>app</title>')
    writeFileSync(
      entry,
      `import { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'\n` +
        `export default createFontsServerEntry({ linkHeader: true })\n`,
    )
    item.resolved.environments = {
      ssr: { build: { rollupOptions: { input } } },
    }
    disableAutomaticDelivery(item)

    const checks = await diagnoseResolvedConfig(item.root, item.resolved)
    assert.ok(hasCheck(checks, 'pass', /deliver font preload Link headers/), name)
  }
})

test('TanStack Start SSR input is a gated fallback when the virtual alias is unavailable', async (t) => {
  const item = fixture(t)
  const entry = join(item.root, 'application/http-entry.ts')
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(
    entry,
    `import { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'\n` +
      `export default createFontsServerEntry({ linkHeader: true })\n`,
  )
  item.resolved.plugins.push({ name: 'tanstack-start:config' })
  item.resolved.environments = {
    ssr: { build: { rollupOptions: { input: 'application/http-entry.ts' } } },
  }
  disableAutomaticDelivery(item)

  const checks = await diagnoseResolvedConfig(item.root, item.resolved)
  assert.ok(hasCheck(checks, 'pass', /deliver font preload Link headers/))

  item.resolved.environments.ssr.build.rolldownOptions = { input: entry }
  const ambiguous = await diagnoseResolvedConfig(item.root, item.resolved)
  assert.ok(hasCheck(ambiguous, 'warning', /could not be verified/))
})

test('an absent named entry plus a generic helper candidate is uncertain', async (t) => {
  const item = fixture(t)
  for (const relativePath of ['app/server.ts', 'lib/server.js']) {
    const file = join(item.root, relativePath)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `export default function unrelated() {}\n`)
  }
  const entry = join(item.root, 'application/http-entry.ts')
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(
    entry,
    `import { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'\n` +
      `export default createFontsServerEntry({ linkHeader: true })\n`,
  )
  disableAutomaticDelivery(item)

  const checks = await diagnoseResolvedConfig(item.root, item.resolved)
  assert.ok(hasCheck(checks, 'warning', /could not be verified/))
  assert.equal(hasCheck(checks, 'pass', /deliver font preload Link headers/), false)
})

test('default-as imports, separate export lists, and TypeScript substitutions are followed', async (t) => {
  const item = fixture(t)
  const entry = join(item.root, 'app/entry.ts')
  const implementation = join(item.root, 'app/handler.ts')
  const util = join(item.root, 'app/util.ts')
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(
    entry,
    `import { default as handler } from './handler.js'\n` +
      `export { helper } from './util.js'\n` +
      `export { handler as default }\n`,
  )
  writeFileSync(util, `export const helper = true\n`)
  writeFileSync(
    implementation,
    `import { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'\n` +
      `export default createFontsServerEntry({ linkHeader: true })\n`,
  )
  item.resolved.resolve = {
    alias: [{ find: 'virtual:tanstack-start-server-entry', replacement: entry }],
  }
  disableAutomaticDelivery(item)

  const checks = await diagnoseResolvedConfig(item.root, item.resolved)
  assert.ok(hasCheck(checks, 'pass', /deliver font preload Link headers/))
})

test('literal JavaScript targets win over TypeScript substitutions', async (t) => {
  const item = fixture(t)
  const entry = join(item.root, 'app/entry.ts')
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(entry, `export { default } from './handler.js'\n`)
  writeFileSync(join(item.root, 'app/handler.js'), `export default function handler() {}\n`)
  writeFileSync(
    join(item.root, 'app/handler.ts'),
    `import { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'\n` +
      `export default createFontsServerEntry({ linkHeader: true })\n`,
  )
  item.resolved.resolve = {
    alias: [{ find: 'virtual:tanstack-start-server-entry', replacement: entry }],
  }
  disableAutomaticDelivery(item)

  const checks = await diagnoseResolvedConfig(item.root, item.resolved)
  assert.ok(hasCheck(checks, 'failure', /no automatic Nitro or HTML delivery path/))
  assert.equal(hasCheck(checks, 'pass', /deliver font preload Link headers/), false)
})

test('import.meta is not mistaken for an unresolved dynamic default export', async (t) => {
  const item = fixture(t)
  const entry = join(item.root, 'app/entry.ts')
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(entry, `const here = import.meta.url\nexport default function handler() {}\n`)
  item.resolved.resolve = {
    alias: [{ find: 'virtual:tanstack-start-server-entry', replacement: entry }],
  }
  disableAutomaticDelivery(item)

  const checks = await diagnoseResolvedConfig(item.root, item.resolved)
  assert.ok(hasCheck(checks, 'failure', /no automatic Nitro or HTML delivery path/))
  assert.equal(hasCheck(checks, 'warning', /could not be verified/), false)
})

test('unresolved package-like defaults are uncertain and resolved dependencies are absent', async (t) => {
  for (const source of [
    `export { default } from '@tanstack/react-start/server'\n`,
    `export { default } from 'example-server-entry'\n`,
    `export { default } from '~/server'\n`,
    `export { default } from '@/server'\n`,
    `export { default } from '#server'\n`,
  ]) {
    const item = fixture(t)
    const entry = join(item.root, 'app/entry.ts')
    mkdirSync(dirname(entry), { recursive: true })
    writeFileSync(entry, source)
    item.resolved.resolve = {
      alias: [{ find: 'virtual:tanstack-start-server-entry', replacement: entry }],
    }
    disableAutomaticDelivery(item)

    const checks = await diagnoseResolvedConfig(item.root, item.resolved)
    assert.ok(hasCheck(checks, 'warning', /could not be verified/), source)
    assert.equal(hasCheck(checks, 'failure', /no automatic Nitro or HTML delivery path/), false)
  }

  const item = fixture(t)
  const dependencyEntry = join(item.root, 'node_modules/example-server-entry/server.js')
  mkdirSync(dirname(dependencyEntry), { recursive: true })
  writeFileSync(
    dependencyEntry,
    `import { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'\n` +
      `export default createFontsServerEntry({ linkHeader: true })\n`,
  )
  item.resolved.resolve = {
    alias: [{ find: 'virtual:tanstack-start-server-entry', replacement: dependencyEntry }],
  }
  disableAutomaticDelivery(item)
  const checks = await diagnoseResolvedConfig(item.root, item.resolved)
  assert.ok(hasCheck(checks, 'failure', /no automatic Nitro or HTML delivery path/))
})

test('conventional candidates must be files and multiple real candidates stay uncertain', async (t) => {
  const directoryItem = fixture(t)
  mkdirSync(join(directoryItem.root, 'src/server.ts'), { recursive: true })
  const customEntry = join(directoryItem.root, 'application/http-entry.ts')
  mkdirSync(dirname(customEntry), { recursive: true })
  writeFileSync(
    customEntry,
    `import { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'\n` +
      `export default createFontsServerEntry({ linkHeader: true })\n`,
  )
  disableAutomaticDelivery(directoryItem)
  const directoryChecks = await diagnoseResolvedConfig(directoryItem.root, directoryItem.resolved)
  assert.ok(hasCheck(directoryChecks, 'pass', /deliver font preload Link headers/))

  const ambiguousItem = fixture(t)
  mkdirSync(join(ambiguousItem.root, 'src'))
  writeFileSync(join(ambiguousItem.root, 'src/server.ts'), `export default function first() {}\n`)
  writeFileSync(join(ambiguousItem.root, 'src/server.js'), `export default function second() {}\n`)
  disableAutomaticDelivery(ambiguousItem)
  const ambiguousChecks = await diagnoseResolvedConfig(ambiguousItem.root, ambiguousItem.resolved)
  assert.ok(hasCheck(ambiguousChecks, 'warning', /could not be verified/))
})

test('a conventional server entry is authoritative over a wired example', async (t) => {
  const item = fixture(t)
  mkdirSync(join(item.root, 'src'))
  mkdirSync(join(item.root, 'examples'))
  writeFileSync(
    join(item.root, 'src/server.ts'),
    `import { createStartHandler } from '@tanstack/react-start/server'\n` +
      `export default createStartHandler({})\n`,
  )
  writeFileSync(
    join(item.root, 'examples/fonts-entry.ts'),
    `import { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'\n` +
      `export default createFontsServerEntry({ linkHeader: true })\n`,
  )
  const diagnostics = item.font.api.getDiagnostics()
  diagnostics.delivery = resolvePreloadDelivery(diagnostics.options, {
    preloadCount: diagnostics.generation.preloads.length,
    hasNitro: false,
    htmlEntryDetected: false,
  })

  const checks = await diagnoseResolvedConfig(item.root, item.resolved)
  assert.ok(
    checks.some(
      (check) =>
        check.status === 'failure' &&
        /font preloads have no automatic Nitro or HTML delivery path/.test(check.message),
    ),
  )
})

test('type-only imports and re-exports do not create custom server-entry candidates', async (t) => {
  const item = fixture(t)
  mkdirSync(join(item.root, 'application'))
  writeFileSync(
    join(item.root, 'application/types.ts'),
    `import type { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'\n`,
  )
  writeFileSync(
    join(item.root, 'application/reexport.ts'),
    `export type { FontsServerEntryOptions } from 'tailwind-vite-font-kit/start-server'\n` +
      `export { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'\n`,
  )
  writeFileSync(
    join(item.root, 'application/side-effect.ts'),
    `import 'tailwind-vite-font-kit/start-server'\n`,
  )
  const diagnostics = item.font.api.getDiagnostics()
  diagnostics.delivery = resolvePreloadDelivery(diagnostics.options, {
    preloadCount: diagnostics.generation.preloads.length,
    hasNitro: false,
    htmlEntryDetected: false,
  })

  const checks = await diagnoseResolvedConfig(item.root, item.resolved)
  assert.ok(
    checks.some(
      (check) =>
        check.status === 'failure' &&
        /font preloads have no automatic Nitro or HTML delivery path/.test(check.message),
    ),
  )
  assert.equal(
    checks.some((check) => /could not be verified/.test(check.message)),
    false,
  )
})

test('ignored source trees cannot make a valid custom server entry ambiguous', async (t) => {
  const item = fixture(t)
  const entry = join(item.root, 'application/http-entry.ts')
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(
    entry,
    `import { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'\n` +
      `export default createFontsServerEntry({ linkHeader: true })\n`,
  )
  for (const directory of [
    'test',
    'tests',
    '__tests__',
    'fixtures',
    'examples',
    'docs',
    'public',
    '.cache',
    'scripts',
    'e2e',
    'cypress',
    'playwright',
  ]) {
    const ignored = join(item.root, directory, 'server.ts')
    mkdirSync(dirname(ignored), { recursive: true })
    writeFileSync(
      ignored,
      `import { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'\n` +
        `export default createFontsServerEntry()\n`,
    )
  }
  const diagnostics = item.font.api.getDiagnostics()
  diagnostics.delivery = resolvePreloadDelivery(diagnostics.options, {
    preloadCount: diagnostics.generation.preloads.length,
    hasNitro: false,
    htmlEntryDetected: false,
  })

  const checks = await diagnoseResolvedConfig(item.root, item.resolved)
  assert.ok(
    checks.some(
      (check) => check.status === 'pass' && /deliver font preload Link headers/.test(check.message),
    ),
  )
  assert.equal(
    checks.some((check) => /could not be verified/.test(check.message)),
    false,
  )
})

test('doctor reports indirect server-entry wiring as unknown rather than absent', async (t) => {
  const item = fixture(t)
  mkdirSync(join(item.root, 'src'))
  writeFileSync(
    join(item.root, 'src/server.ts'),
    `import { createFontsServerEntry } from 'tailwind-vite-font-kit/start-server'\n` +
      `const entry = createFontsServerEntry({ linkHeader: true })\n` +
      `export default entry\n`,
  )
  const diagnostics = item.font.api.getDiagnostics()
  diagnostics.delivery = resolvePreloadDelivery(diagnostics.options, {
    preloadCount: diagnostics.generation.preloads.length,
    hasNitro: false,
    htmlEntryDetected: false,
  })
  const checks = await diagnoseResolvedConfig(item.root, item.resolved)
  assert.ok(
    checks.some(
      (check) => check.status === 'warning' && /could not be verified/.test(check.message),
    ),
  )
  assert.equal(
    checks.some((check) => /no automatic Nitro or HTML delivery path/.test(check.message)),
    false,
  )
})

test('doctor does not inspect a server entry when Nitro already guarantees delivery', async (t) => {
  const item = fixture(t, { diagnostics: { hasNitro: true } })
  mkdirSync(join(item.root, 'src/server.ts'), { recursive: true })
  const checks = await diagnoseResolvedConfig(item.root, item.resolved)
  assert.ok(
    checks.some((check) => check.status === 'pass' && /Nitro will deliver/.test(check.message)),
  )
})

test('doctor does not assign document delivery responsibility to SSR or library builds', async (t) => {
  for (const [name, diagnostics, build, message] of [
    ['SSR', { isSsrBuild: true }, { ssr: true }, /SSR build defers document preload delivery/],
    [
      'library',
      { isLibraryBuild: true },
      { lib: { entry: 'src/index.js' } },
      /library builds do not produce a document preload response/,
    ],
  ]) {
    const item = fixture(t, { diagnostics })
    item.resolved.build = build
    const pluginDiagnostics = item.font.api.getDiagnostics()
    pluginDiagnostics.delivery = resolvePreloadDelivery(pluginDiagnostics.options, {
      preloadCount: pluginDiagnostics.generation.preloads.length,
      hasNitro: false,
      htmlEntryDetected: false,
    })
    const checks = await diagnoseResolvedConfig(item.root, item.resolved)
    assert.ok(
      checks.some((check) => check.status === 'pass' && message.test(check.message)),
      name,
    )
    assert.equal(
      checks.some((check) => /no automatic Nitro or HTML delivery path/.test(check.message)),
      false,
      name,
    )
  }
})

test('doctor CDN measurement aborts on its configured timeout', async (t) => {
  const { root, resolved } = fixture(t, {
    generation: {
      files: [],
      digests: {},
      preloads: [
        {
          rel: 'preload',
          as: 'font',
          type: 'font/woff2',
          href: 'https://fonts.gstatic.com/s/fake/font.woff2',
          crossOrigin: 'anonymous',
        },
      ],
    },
    diagnostics: { selfHosts: false },
  })
  const checks = await diagnoseResolvedConfig(root, resolved, {
    preloadTimeoutMs: 5,
    fetchImpl: (_url, { signal }) =>
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
  })
  assert.ok(
    checks.some((item) => item.status === 'failure' && /could not measure/.test(item.message)),
  )
})

test('doctor filters covered warnings by code, not English text', async (t) => {
  const { root, resolved } = fixture(t, {
    diagnostics: {
      warnings: ['wording that must not be regex matched'],
      warningEvents: [
        { code: 'NO_NITRO_HTML_FALLBACK', message: 'arbitrary delivery wording' },
        { code: 'GENERAL', message: 'preserved generator warning' },
      ],
    },
  })
  const checks = await diagnoseResolvedConfig(root, resolved)
  assert.equal(checks.filter((item) => item.message === 'preserved generator warning').length, 1)
  assert.equal(
    checks.some((item) => item.message === 'arbitrary delivery wording'),
    false,
  )
})

test('Vite is resolved from the selected project root', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tss-fonts-project-vite-'))
  const viteDir = join(root, 'node_modules', 'vite')
  mkdirSync(viteDir, { recursive: true })
  writeFileSync(
    join(viteDir, 'package.json'),
    JSON.stringify({ name: 'vite', version: '0.0.0-test', type: 'module', exports: './index.js' }),
  )
  writeFileSync(join(viteDir, 'index.js'), `export const projectMarker = 'selected-root'\n`)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal((await loadProjectVite(root)).projectMarker, 'selected-root')
})

test('doctor context is async-scoped rather than process-wide', async () => {
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const inside = runInDoctorContext(async () => {
    await gate
    return isDoctorContext()
  })
  assert.equal(isDoctorContext(), false)
  release()
  assert.equal(await inside, true)
  assert.equal(isDoctorContext(), false)
})

test('doctor context is shared by independently evaluated package copies', async () => {
  const nonce = `${Date.now()}-${Math.random()}`
  const first = await import(`../src/doctor-context.mjs?copy=first-${nonce}`)
  const second = await import(`../src/doctor-context.mjs?copy=second-${nonce}`)
  assert.equal(first.isDoctorContext(), false)
  assert.equal(second.isDoctorContext(), false)
  const observed = await first.runInDoctorContext(async () => second.isDoctorContext())
  assert.equal(observed, true)
  assert.equal(first.isDoctorContext(), false)
  assert.equal(second.isDoctorContext(), false)
})
