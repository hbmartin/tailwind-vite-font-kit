// Confirm actual browser-selected faces, independently of declared CSS weights.
// node harness/browser-benchmark-local-faces.mjs /path/to/reference-app out.json
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { writeFileSync } from 'node:fs'
const [app, output] = process.argv.slice(2)
if (!output) throw new Error('Pass reference app directory and output JSON')
const require = createRequire(resolve(app, 'package.json'))
const { default: puppeteer } = await import(require.resolve('puppeteer'))
const browser = await puppeteer.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.setContent(`<style>
    @font-face{font-family:Existing;src:local("Arial"),local("Liberation Sans");font-weight:700}
    @font-face{font-family:Corrected;src:local("Arial Bold"),local("Arial-BoldMT"),local("Liberation Sans Bold"),local("LiberationSans-Bold");font-weight:700}
    span{font-size:40px;font-weight:700}
    </style><span id="existing" style="font-family:Existing">Hamburgefonts 0123456789</span><span id="corrected" style="font-family:Corrected">Hamburgefonts 0123456789</span>`)
  await page.evaluate(() => document.fonts.ready)
  const client = await page.createCDPSession()
  await client.send('DOM.enable')
  await client.send('CSS.enable')
  const { root } = await client.send('DOM.getDocument')
  const rows = []
  for (const selector of ['#existing', '#corrected']) {
    const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    rows.push({ selector, ...(await client.send('CSS.getPlatformFontsForNode', { nodeId })) })
  }
  writeFileSync(output, JSON.stringify({ browser: await browser.version(), rows }, null, 2))
  console.log(JSON.stringify(rows))
} finally {
  await browser.close()
}
