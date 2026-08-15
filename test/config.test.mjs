// validateFamilies() is what stands between `adopt` and deleting CSS it cannot
// re-create, so its rejection paths are pinned directly — the CLI tests only reach
// them through a subprocess, and only for the configs those tests happen to write.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAndValidate, validateFamilies } from '../src/config.mjs'

/** One valid family, with `extra` merged over it. */
const fam = (extra) => [{ name: 'Manrope', themeVar: '--font-sans', weights: [400], ...extra }]

test('a valid family list is returned as-is', () => {
  const families = fam()
  assert.equal(validateFamilies(families, 'test'), families)
})

test("opszPin accepts a positive number or 'auto', and nothing else", () => {
  assert.doesNotThrow(() => validateFamilies(fam({ opszPin: 16 }), 'test'))
  // index.d.ts and the README both promise 'auto'; validation once rejected it.
  assert.doesNotThrow(() => validateFamilies(fam({ opszPin: 'auto' }), 'test'))
  for (const bad of [0, -16, Number.NaN, 'automatic', true]) {
    assert.throws(() => validateFamilies(fam({ opszPin: bad }), 'test'), /opszPin/)
  }
})

test("opszSizes is validated when opszPin is 'auto'", () => {
  assert.doesNotThrow(() => validateFamilies(fam({ opszPin: 'auto' }), 'test'))
  assert.doesNotThrow(() =>
    validateFamilies(fam({ opszPin: 'auto', opszSizes: [12, 16, 48] }), 'test'),
  )
  for (const bad of [[], [0, 16], [-1, 16], [Number.NaN], [Number.POSITIVE_INFINITY], '16,48']) {
    assert.throws(
      () => validateFamilies(fam({ opszPin: 'auto', opszSizes: bad }), 'test'),
      /opszSizes.*non-empty array of positive finite/s,
    )
  }
  // The option is documented as ignored for a numeric pin, so irrelevant data remains ignored.
  assert.doesNotThrow(() => validateFamilies(fam({ opszPin: 16, opszSizes: [] }), 'test'))
})

test('an axes spec may carry the weights, but only through a wght axis', () => {
  assert.doesNotThrow(() =>
    validateFamilies(fam({ weights: undefined, axes: 'opsz,wght@9..144,400' }), 'test'),
  )
  // No wght axis and no weights: the generator would have nothing to derive faces
  // from, and by then adopt has already deleted the CSS. Rejected up front.
  assert.throws(
    () => validateFamilies(fam({ weights: undefined, axes: 'ital@0;1' }), 'test'),
    /no wght axis/,
  )
  assert.throws(() => validateFamilies(fam({ weights: [] }), 'test'), /neither/)
})

test('loadAndValidate names a default export that is not a config object', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tss-config-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // One file per case: loadFontsConfig cache-busts with Date.now(), which two imports
  // of the same path can collide on inside a single millisecond.
  let n = 0
  const write = (body) => {
    const p = join(dir, `fonts.config.${n++}.mjs`)
    writeFileSync(p, body)
    return p
  }

  // The families array exported directly is the likely hand-edit mistake; a bare
  // string stands in for everything else. Both must say "object", not "got nothing".
  await assert.rejects(
    () => loadAndValidate(write(`export default [{ name: 'Manrope' }]\n`), 'fonts.config.mjs'),
    /must be an object.*got an array/s,
  )
  await assert.rejects(
    () => loadAndValidate(write(`export default 'Manrope'\n`), 'fonts.config.mjs'),
    /must be an object.*got string/s,
  )

  const good = write(
    `export default { families: [{ name: 'Manrope', themeVar: '--font-sans', weights: [400] }] }\n`,
  )
  const cfg = await loadAndValidate(good, 'fonts.config.mjs')
  assert.equal(cfg.families[0].name, 'Manrope')
})
