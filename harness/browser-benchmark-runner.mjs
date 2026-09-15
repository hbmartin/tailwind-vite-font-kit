// Import through the in-app browser skill's JavaScript tool. Supply the already
// connected tab and browser viewport capability; this does not launch a browser.
import { writeFile } from 'node:fs/promises'

export function matrixCases() {
  const cases = []
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const viewport of [390, 1280]) {
      const variants = ['kit', 'fontaine', 'swap-preload', 'swap', 'optional', 'system']
      if (repeat % 2) variants.reverse()
      for (const variant of variants) {
        for (const probe of ['hero', 'tailwind', 'normal']) {
          cases.push({ variant, viewport, probe, group: 'matrix' })
        }
      }
    }
  }
  return cases
}

export function responsiveCases() {
  return Array.from({ length: 36 }, (_, i) => 360 + i * 20).flatMap((viewport) =>
    ['kit', 'fontaine'].map((variant) => ({
      variant,
      viewport,
      probe: 'hero',
      group: 'responsive',
    })),
  )
}

export async function runCases(tab, viewportCapability, cases, results, outputPath) {
  const summary = []
  for (const c of cases) {
    await viewportCapability.set({ width: c.viewport, height: c.viewport === 390 ? 844 : 900 })
    const id = `r${String(results.length).padStart(5, '0')}`
    const url = new URL(`http://127.0.0.1:3211/probe/${c.probe}`)
    for (const [key, value] of Object.entries({
      variant: c.variant,
      run: id,
      delay: c.delay ?? 2000,
      width: c.width ?? 0,
    })) {
      url.searchParams.set(key, String(value))
    }
    await tab.goto(url.href)
    await tab.playwright
      .locator('#font-benchmark-result')
      .waitFor({ state: 'attached', timeoutMs: 12000 })
    const r = JSON.parse(await tab.playwright.locator('#font-benchmark-result').textContent())
    r.probe = c.probe
    r.group = c.group ?? 'matrix'
    results.push(r)
    await writeFile(outputPath, JSON.stringify(results))
    summary.push({ id, variant: r.variant, viewport: r.viewport.width, probe: r.probe, cls: r.cls })
  }
  return summary
}
