// Plugin hook behaviour that needs no build: the entry-seen accounting and the
// buildEnd fail-loud check. Neither path touches generation, so no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fonts } from '../src/index.mjs'

const FAMILIES = [
  { name: 'Manrope', themeVar: '--font-sans', weights: [400], stack: [], preloadWeights: [] },
]

test('an entry that already imports fonts.gen.css still counts as seen', () => {
  const plugin = fonts({ families: FAMILIES })
  const ctx = {
    warn() {},
    error(msg) {
      throw new Error(msg)
    },
  }
  const code = `@import 'tailwindcss';\n@import './fonts.gen.css';\n`
  assert.equal(plugin.transform.handler.call(ctx, code, '/app/src/styles.css'), undefined)
  assert.doesNotThrow(() => plugin.buildEnd.call(ctx))
})

test('buildEnd only enforces injection in the client environment', () => {
  const plugin = fonts({ families: FAMILIES })
  const ssr = {
    environment: { config: { consumer: 'server' } },
    error() {
      throw new Error('buildEnd must not error outside the client environment')
    },
  }
  assert.doesNotThrow(() => plugin.buildEnd.call(ssr))

  const client = {
    environment: { config: { consumer: 'client' } },
    error(msg) {
      throw new Error(msg)
    },
  }
  assert.throws(() => plugin.buildEnd.call(client), /never saw a stylesheet/)
})
