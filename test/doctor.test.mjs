import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diagnoseResolvedConfig } from '../src/doctor.mjs'

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tss-fonts-doctor-'))
  const filesDir = join(root, 'generated')
  mkdirSync(filesDir)
  writeFileSync(join(root, 'styles.css'), `@import 'tailwindcss';\n`)
  writeFileSync(join(filesDir, 'manrope-test.woff2'), Buffer.from('wOF2font'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const diagnostics = {
    options: {
      families: [{ name: 'Manrope', themeVar: '--font-sans', weights: [400] }],
      preloadHtml: 'auto',
      preloadHeader: true,
      ...overrides.options,
    },
    generation: {
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
    },
    warnings: [],
    hasNitro: false,
    selfHosts: true,
    ...overrides.diagnostics,
  }
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
    fetchImpl: async () => {
      throw new Error('offline')
    },
  })
  assert.ok(
    checks.some(
      (item) => item.status === 'failure' && /could not measure.*offline/.test(item.message),
    ),
  )
})
