// Shared cases and driver. The in-app adapter only uses its supplied tab.
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import assert from 'node:assert/strict'
import { outputPaths } from './browser-benchmark-output.mjs'
import { randomUUID } from 'node:crypto'

export function matrixCases({
  repeats = 3,
  viewports = [390, 1280],
  variants = ['kit', 'fontaine', 'swap-preload', 'swap', 'optional', 'system'],
  probes = ['hero', 'tailwind', 'normal'],
} = {}) {
  return Array.from({ length: repeats }, (_, repeat) =>
    viewports.flatMap((viewport) =>
      (repeat % 2 ? [...variants].reverse() : variants).flatMap((variant) =>
        probes.map((probe) => ({
          variant,
          viewport,
          height: viewport === 390 ? 844 : 900,
          probe,
          group: 'matrix',
        })),
      ),
    ),
  ).flat()
}
export function responsiveCases({
  repeats = 3,
  viewports = Array.from({ length: 36 }, (_, i) => 360 + i * 20),
  variants = ['kit', 'fontaine'],
} = {}) {
  return matrixCases({ repeats, viewports, variants, probes: ['hero'] }).map((c) => ({
    ...c,
    height: 900,
    group: 'responsive',
  }))
}
export function regressionCases({ repeats = 3, variants = ['kit'] } = {}) {
  return [
    ...matrixCases({ repeats, variants }),
    ...responsiveCases({ repeats, variants }),
    ...matrixCases({ repeats, viewports: [380], variants, probes: ['hero'] }).map((c) => ({
      ...c,
      group: 'confirmation',
    })),
    ...Array.from({ length: 11 }, (_, i) => 280 + i * 20).flatMap((width) =>
      matrixCases({ repeats, viewports: [1280], variants, probes: ['hero'] }).map((c) => ({
        ...c,
        width,
        group: 'widths',
      })),
    ),
  ]
}
export async function runDriver(
  driver,
  cases,
  results,
  outputPath,
  { origin = 'http://127.0.0.1:3211' } = {},
) {
  outputPaths(outputPath)
  await mkdir(dirname(outputPath), { recursive: true })
  if (!results.length) await writeFile(outputPath, '[]', { flag: 'wx' })
  else
    assert.deepEqual(
      JSON.parse(await readFile(outputPath, 'utf8')),
      results,
      'Resume data differs from saved observations',
    )
  for (const c of cases) {
    const viewport = { width: c.viewport, height: c.height ?? (c.viewport === 390 ? 844 : 900) }
    await driver.viewport(viewport)
    const id = randomUUID()
    const url = new URL(`/probe/${c.probe}`, origin)
    for (const [key, value] of Object.entries({
      variant: c.variant,
      run: id,
      delay: c.delay ?? 2000,
      width: c.width ?? 0,
    }))
      url.searchParams.set(key, String(value))
    const r = await driver.read(url.href)
    r.probe = c.probe
    r.group = c.group ?? 'matrix'
    r.requestedViewport = viewport
    results.push(r)
    await writeFile(outputPath, JSON.stringify(results))
  }
  return results
}
export async function runCases(tab, viewportCapability, cases, results, outputPath, options) {
  return runDriver(
    {
      viewport: (size) => viewportCapability.set(size),
      async read(url) {
        const startedAt = Date.now()
        await tab.goto(url)
        const locator = tab.playwright.locator('#font-benchmark-result')
        await locator.waitFor({ state: 'attached', timeoutMs: 15000 })
        const result = JSON.parse(await locator.textContent())
        const logs = await tab.dev.logs({ levels: ['error'], limit: 100 })
        result.errors.push(
          ...logs
            .filter(
              (log) =>
                !Number.isFinite(Date.parse(log.timestamp)) ||
                Date.parse(log.timestamp) >= startedAt,
            )
            .map((log) => log.message),
        )
        return result
      },
    },
    cases,
    results,
    outputPath,
    options,
  )
}
