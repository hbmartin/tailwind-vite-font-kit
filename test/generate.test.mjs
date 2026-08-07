// generate() against a mocked css2 response — no network. `strategy: 'cdn'` keeps
// Google's URL in src, so no woff2 download happens either.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generate } from '../src/generate.mjs'

const CSS2 = `/* latin */
@font-face {
  font-family: 'Fakefam';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/fake/v1/abc123.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}
`

test('preloadWeights match a variable font-weight range like "100 900"', async (t) => {
  const outDir = mkdtempSync(join(tmpdir(), 'tss-fonts-test-'))
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(CSS2, { status: 200 })
  t.after(() => {
    globalThis.fetch = realFetch
    rmSync(outDir, { recursive: true, force: true })
  })

  const gen = await generate(
    {
      families: [
        {
          name: 'Fakefam',
          themeVar: '--font-sans',
          weights: [400, 700],
          preloadWeights: [400],
          strategy: 'cdn',
        },
      ],
      subsets: ['latin'],
      publicPath: '/fonts',
    },
    outDir,
  )
  assert.equal(gen.preloads.length, 1, '400 sits inside 100–900, so the face must preload')
  assert.match(gen.preloads[0].href, /abc123\.woff2/)
  assert.equal(gen.realFaces, 1)
})
