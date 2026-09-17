import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyStaticAudit, staticAudit } from '../harness/static-audit.mjs'
import {
  hasAnonymousHeaderCrossorigin,
  isHeaderFontPreload,
  parseLinkHeader,
  scanHtml,
} from '../src/preload-delivery.mjs'

const response = (url, body, { status = 200, headers = {} } = {}) => ({
  url,
  status,
  headers: new Headers(headers),
  text: async () => body,
  arrayBuffer: async () => Buffer.from(body),
})

test('empty static audits carry one explicit unavailability reason', () => {
  const audit = emptyStaticAudit(new Error('network failed'))
  assert.equal(audit.unavailableReason, 'network failed')
  assert.deepEqual(audit.errors, [])
  assert.deepEqual(audit.headerPreloadFontLinks, [])
  assert.equal(audit.sampleFontResponse, null)
  for (const unhelpful of ['', null, undefined, {}]) {
    assert.ok(emptyStaticAudit(unhelpful).unavailableReason.length > 0)
  }
})

test('Link parsing uses exact tokens, preserves quoted commas, and rejects malformed input', () => {
  const header =
    '</fonts/ok.woff2>; rel="preload alternate"; as=font; title="a,b"; crossorigin=true, ' +
    '</fonts/not-rel.woff2?rel=preload&as=font>; title=query, ' +
    '</fonts/prefix.woff2>; rel=preloadx; as=font; crossorigin, ' +
    '</fonts/malformed.woff2; rel=preload; as=font'
  const parsed = parseLinkHeader(header)
  const preloads = parsed.filter(isHeaderFontPreload)
  assert.equal(preloads.length, 1)
  assert.equal(preloads[0].target, '/fonts/ok.woff2')
  assert.match(preloads[0].raw, /title="a,b"/)
  assert.equal(hasAnonymousHeaderCrossorigin(preloads[0]), true)
  assert.deepEqual(parseLinkHeader(null), [])
})

test('Link parsing deliberately rejects malformed Chromium extensions', () => {
  for (const header of [
    '</fonts/font.woff2>; rel=preload; as=font; crossorigin;',
    "</fonts/font.woff2>; rel='preload'; as=font; crossorigin",
    '</fonts/font.woff2>; rel=preload; as=font; title=My Font; crossorigin',
    '</fonts/font.woff2>; rel=preload; as=font; crossorigin=',
  ]) {
    assert.equal(parseLinkHeader(header).filter(isHeaderFontPreload).length, 0, header)
  }
})

test('HTML scanning keeps inline styles after malformed tokenizer constructs', () => {
  const liveStyle = '<style>.live { color: green }</style>'
  for (const prefix of [
    '<!-- note --->',
    '<!-- note ---->',
    '<!-- note --!>',
    '<!DOCTYPE html PUBLIC "quoted>identifier">',
    '<!DOCTYPE html PUBLIC "unterminated>',
    '</ <style>.hidden { color: red }</style>>',
    '</1 <style>.hidden { color: red }</style>>',
  ]) {
    const { styles } = scanHtml(prefix + liveStyle)
    assert.deepEqual(
      styles.map((style) => style.text),
      ['.live { color: green }'],
      prefix,
    )
  }
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

test('static audit models JavaScript-on CSS without noscript or inert style preloads', async () => {
  const calls = []
  const documentUrl = 'https://site.test/'
  const appCssUrl = 'https://site.test/app.css'
  const fallbackCssUrl = 'https://site.test/fallback.css'
  const lateCssUrl = 'https://site.test/late.css'
  const fontUrl = 'https://site.test/fonts/target.woff2'
  const audit = await staticAudit(documentUrl, {
    fetchImpl: async (url) => {
      const current = String(url)
      calls.push(current)
      if (current === documentUrl) {
        return response(
          documentUrl,
          `<link rel=preload as=style href=/app.css onload="this.rel='stylesheet'">
           <noscript>
             <link rel=stylesheet href=/app.css>
             <link rel=stylesheet href=/fallback.css>
             <link rel=preload as=style href=/inert.css>
             <link rel=preload as=font href=/fonts/inert.woff2 crossorigin>
           </noscript>
           <link rel=stylesheet href=/late.css>
           <link rel=preload as=style href=/unused.css>
           <link rel=preload as=font href=/fonts/target.woff2 crossorigin>`,
        )
      }
      if (current === appCssUrl) {
        return response(
          current,
          `@font-face { font-family: Target; src: url(/fonts/target.woff2) }`,
        )
      }
      if (current === fallbackCssUrl) {
        return response(
          current,
          `@font-face { font-family: Fallback; src: url(/fonts/fallback.woff2) }`,
        )
      }
      if (current === lateCssUrl) return response(current, 'body { color: inherit }')
      if (current === fontUrl) return response(current, 'wOF2font')
      throw new Error(`unexpected fetch: ${url}`)
    },
  })

  assert.deepEqual(audit.stylesheetHrefs, ['/app.css', '/late.css'])
  assert.equal(calls.filter((url) => url === appCssUrl).length, 1)
  assert.equal(calls.filter((url) => url === fallbackCssUrl).length, 0)
  assert.equal(calls.includes('https://site.test/unused.css'), false)
  assert.equal(audit.totalFontFaceBlocks, 1)
  assert.equal(audit.headPreloadFontLinks.length, 1)
  assert.doesNotMatch(audit.headPreloadFontLinks.join('\n'), /inert\.woff2/)
  assert.equal(audit.sampleFontResponse.url, fontUrl)
})

test('static audit includes active declarative shadow-root styles exactly once', async () => {
  const documentUrl = 'https://site.test/'
  const shadowCssUrl = 'https://site.test/shadow.css'
  const closedCssUrl = 'https://site.test/closed.css'
  const audit = await staticAudit(documentUrl, {
    fetchImpl: async (url) => {
      const current = String(url)
      if (current === documentUrl) {
        return response(
          documentUrl,
          `<template>
             <style>@font-face { font-family: Inert; src: url(/inert.woff2) }</style>
             <template shadowrootmode=open><link rel=stylesheet href=/nested-inert.css></template>
           </template>
           <template shadowrootmode=open>
             <style>@font-face { font-family: InlineShadow; src: url(/inline.woff2) }</style>
             <link rel=stylesheet href=/shadow.css>
           </template>
           <template shadowrootmode=closed>
             <link rel=preload as=style href=/closed.css
               onload="this.setAttribute('rel', 'stylesheet')">
           </template>`,
        )
      }
      if (current === shadowCssUrl) {
        return response(
          current,
          `@font-face { font-family: LinkedShadow; src: url(/linked.woff2) }`,
        )
      }
      if (current === closedCssUrl) {
        return response(
          current,
          `@font-face { font-family: ClosedShadow; src: url(/closed.woff2) }`,
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    },
  })

  assert.deepEqual(audit.stylesheetHrefs, ['/shadow.css', '/closed.css'])
  assert.equal(audit.inlineStyleTags, 1)
  assert.equal(audit.totalFontFaceBlocks, 3)
  assert.deepEqual(audit.fontFamiliesDeclared.sort(), [
    'ClosedShadow',
    'InlineShadow',
    'LinkedShadow',
  ])
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

test('static audit reads only live inline style elements case-insensitively', async () => {
  const documentUrl = 'https://site.test/'
  const fontUrl = 'https://site.test/fonts/target.woff2'
  const audit = await staticAudit(documentUrl, {
    fetchImpl: async (url) => {
      if (String(url) === documentUrl) {
        return response(
          documentUrl,
          `<script>const fake = '<style>@font-face { src: url(/fonts/script.woff2) }</style>'</script>
           <!-- <style>@font-face { src: url(/fonts/comment.woff2) }</style> -->
           <STYLE>@font-face { font-family: Target; src: url(/fonts/target.woff2) }</STYLE>
           <link rel=preload as=font href=/fonts/target.woff2 crossorigin>`,
        )
      }
      if (String(url) === fontUrl) return response(fontUrl, 'wOF2font')
      throw new Error(`unexpected fetch: ${url}`)
    },
  })

  assert.equal(audit.inlineStyleTags, 1)
  assert.equal(audit.totalFontFaceBlocks, 1)
  assert.equal(audit.sampleFontResponse.url, fontUrl)
})

test('static audit parses unquoted links, preserves long links, and records malformed URLs', async () => {
  const longPath = `/fonts/${'very-long-segment-'.repeat(20)}target.woff2`
  const documentUrl = 'https://site.test/'
  const fontUrl = new URL(longPath, documentUrl).href
  const audit = await staticAudit(documentUrl, {
    fetchImpl: async (url) => {
      const current = String(url)
      if (current === documentUrl) {
        return response(
          documentUrl,
          `<link href=/assets/app.css rel=stylesheet>
           <link hreflang=en href=${longPath} as=font rel=preload crossorigin>
           <link rel=preload as=font href="http://[" crossorigin>`,
          {
            headers: {
              link: `<${longPath}>; rel=preload; as=font; crossorigin, <http://[>; rel=preload; as=font; crossorigin`,
            },
          },
        )
      }
      if (current === 'https://site.test/assets/app.css') {
        return response(current, `@font-face { font-family: Target; src: url(${longPath}) }`)
      }
      if (current === fontUrl) {
        return response(current, 'wOF2font', {
          headers: {
            'cache-control': 'public, max-age=31536000, immutable',
            'access-control-allow-origin': '*',
          },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    },
  })

  assert.deepEqual(audit.stylesheetHrefs, ['/assets/app.css'])
  assert.equal(audit.sampleFontResponse.url, fontUrl)
  assert.ok(audit.headPreloadFontLinks[0].length > 200)
  assert.match(audit.headPreloadFontLinks[0], /crossorigin>$/)
  assert.ok(audit.headerPreloadFontLinks[0].length > 300)
  assert.match(audit.headerPreloadFontLinks[0], /crossorigin$/)
  assert.equal(audit.errors.length, 2)
  assert.match(audit.errors.join('\n'), /invalid Link-header preload href/)
  assert.match(audit.errors.join('\n'), /invalid HTML preload href/)
})
