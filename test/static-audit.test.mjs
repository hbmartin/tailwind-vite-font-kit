import test from 'node:test'
import assert from 'node:assert/strict'
import { staticAudit } from '../harness/static-audit.mjs'

const response = (url, body, { status = 200, headers = {} } = {}) => ({
  url,
  status,
  headers: new Headers(headers),
  text: async () => body,
  arrayBuffer: async () => Buffer.from(body),
})

test('static audit follows stylesheet-relative imports and samples the preloaded face', async () => {
  const calls = []
  const pages = new Map([
    [
      'https://site.test/probe/hero',
      response(
        'https://site.test/probe/hero',
        `<link rel="stylesheet" href="/assets/app.css">
         <link rel="preload" as="font" href="/fonts/target.woff2" crossorigin>`,
      ),
    ],
    [
      'https://site.test/assets/app.css',
      response(
        'https://site.test/assets/app.css',
        `@font-face { font-family: ThirdParty; src: url(https://other.test/unrelated.woff2) }
         @import "./nested/fonts.css";`,
      ),
    ],
    [
      'https://site.test/assets/nested/fonts.css',
      response(
        'https://site.test/assets/nested/fonts.css',
        `@font-face { font-family: Target; src: url(../../fonts/target.woff2); size-adjust: 100% }`,
      ),
    ],
    [
      'https://site.test/fonts/target.woff2',
      response('https://site.test/fonts/target.woff2', 'wOF2font', {
        headers: {
          'cache-control': 'public, max-age=31536000, immutable',
          'access-control-allow-origin': '*',
        },
      }),
    ],
  ])
  const audit = await staticAudit('https://site.test/probe/hero', {
    fetchImpl: async (url) => {
      calls.push(String(url))
      const found = pages.get(String(url))
      if (!found) throw new Error(`unexpected fetch: ${url}`)
      return found
    },
  })

  assert.ok(calls.includes('https://site.test/assets/nested/fonts.css'))
  assert.equal(calls.includes('https://other.test/unrelated.woff2'), false)
  assert.equal(audit.sampleFontResponse.url, 'https://site.test/fonts/target.woff2')
  assert.match(audit.sampleFontResponse.cacheControl, /immutable/)
})

test('static audit does not substitute an unrelated face when no preload matches', async () => {
  const audit = await staticAudit('https://site.test/', {
    fetchImpl: async (url) => {
      if (String(url) === 'https://site.test/') {
        return response(
          'https://site.test/',
          `<style>@font-face { font-family: Other; src: url(/fonts/other.woff2) }</style>`,
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    },
  })
  assert.equal(audit.sampleFontResponse, null)
})
