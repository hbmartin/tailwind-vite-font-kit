// Run manually. Puppeteer comes from the disposable reference app, never npm runtime.
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { runDriver, regressionCases } from './browser-benchmark-runner.mjs'
import { validate } from './browser-benchmark-validation.mjs'
const { values } = parseArgs({
  options: {
    app: { type: 'string' },
    origin: { type: 'string', default: 'http://127.0.0.1:3211' },
    output: { type: 'string', default: 'harness/results/run.json' },
    manifest: { type: 'string' },
    executable: { type: 'string' },
  },
})
if (!values.app) throw new Error('Pass --app /path/to/disposable-reference-app')
const require = createRequire(resolve(values.app, 'package.json'))
const { default: puppeteer } = await import(require.resolve('puppeteer'))
const manifest = values.manifest
  ? JSON.parse(await readFile(values.manifest, 'utf8'))
  : { cases: regressionCases() }
const results = []
await mkdir(dirname(values.output), { recursive: true })
await writeFile(
  values.output.replace(/\.json$/, '-manifest.json'),
  JSON.stringify(manifest, null, 2),
)
const browser = await puppeteer.launch({
  executablePath: values.executable,
  headless: true,
  args: process.env.BENCH_NO_SANDBOX === '1' ? ['--no-sandbox'] : [],
})
try {
  const page = await browser.newPage()
  let errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('requestfailed', (r) => errors.push(`${r.url()}: ${r.failure()?.errorText}`))
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`)
  })
  await runDriver(
    {
      viewport: (size) => page.setViewport(size),
      async read(url) {
        errors = []
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await page.waitForSelector('#font-benchmark-result', { timeout: 15000 })
        const result = await page.$eval('#font-benchmark-result', (el) =>
          JSON.parse(el.textContent),
        )
        result.errors.push(...errors)
        return result
      },
    },
    manifest.cases,
    results,
    values.output,
    { origin: values.origin },
  )
  const summary = validate(results, manifest)
  await writeFile(
    values.output.replace(/\.json$/, '-summary.json'),
    JSON.stringify(summary, null, 2),
  )
  console.log(JSON.stringify({ output: values.output, loads: results.length, validated: true }))
} finally {
  await browser.close()
}
