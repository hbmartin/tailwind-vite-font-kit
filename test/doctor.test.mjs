import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diagnoseResolvedConfig, loadProjectVite } from '../src/doctor.mjs'
import { isDoctorContext, runInDoctorContext } from '../src/doctor-context.mjs'
import { resolvePreloadDelivery } from '../src/preload-delivery.mjs'

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
  return {
    root,
    font,
    resolved: { plugins: [font, { name: '@tailwindcss/vite:scan' }] },
  }
}

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
      status: 'pass',
      message: /explicit HTML preload injection is enabled with Nitro/,
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
