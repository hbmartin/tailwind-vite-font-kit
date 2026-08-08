// Guards the published type surface. `index.d.ts` is hand-written against .mjs sources,
// so nothing but this file and `pnpm typecheck` stops the two from drifting apart.
//
// This file is deliberately inside tsconfig.json's `include`: the annotations below are
// checked by `tsc`, so a FontsOptions field that the implementation stops reading, or a
// return type that stops matching Vite's Plugin, fails the typecheck rather than here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import selfDefault, { fonts as selfNamed } from 'tailwind-vite-font-kit'
import * as entry from '../src/index.mjs'

const dts = readFileSync(new URL('../index.d.ts', import.meta.url), 'utf8')

test('the package resolves through its own exports map', () => {
  // A self-reference import goes through `exports`, so a broken map fails here rather
  // than in the first project that installs the package.
  assert.equal(typeof selfNamed, 'function')
  assert.equal(selfDefault, selfNamed)
  assert.equal(selfNamed, entry.fonts)
})

test('index.d.ts declares every runtime export, and no others', () => {
  const declared = new Set()
  for (const [, name] of dts.matchAll(/^export declare (?:function|const|class) (\w+)/gm)) {
    declared.add(name)
  }
  if (/^export default /m.test(dts)) declared.add('default')

  const actual = new Set(Object.keys(entry))
  assert.deepEqual(
    [...declared].sort(),
    [...actual].sort(),
    'index.d.ts and src/index.mjs disagree about the public exports',
  )
})

test('the plugin factory returns a Vite plugin named after the package', () => {
  /** @type {import('../index.d.ts').FontsOptions} */
  const options = {
    families: [
      {
        name: 'Manrope',
        themeVar: '--font-sans',
        weights: [400, 700],
        stack: ['ui-sans-serif', 'system-ui'],
        preloadWeights: [400],
        strategy: 'self-host',
        opszPin: 16,
      },
    ],
    subsets: ['latin'],
    publicPath: '/fonts',
    assets: 'emit',
    output: 'cache',
    preloadHeader: true,
    silent: true,
  }

  // A family whose weights live only in the axes spec is a supported shape — the
  // generator derives them (src/generate.mjs) — so the types must accept it. `weights`
  // was declared required here for a while, which made this config a type error.
  /** @type {import('../index.d.ts').FontFamily} */
  const axesOnly = {
    name: 'Fraunces',
    themeVar: '--font-display',
    axes: 'opsz,wght@9..144,500;9..144,700',
    opszPin: 48,
  }
  assert.equal(axesOnly.weights, undefined)

  const plugin = entry.fonts(options)
  const name = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ).name
  assert.equal(plugin.name, name)
  assert.equal(plugin.enforce, 'pre')
})
