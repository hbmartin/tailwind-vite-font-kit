// The opsz tooling: the pure, offline parts, plus the wiring that decides what URL a
// resolved pin actually produces.
//
// planOpsz / detectAxes need a real variable font and the optional peers (fontkit,
// wawoff2), so they are exercised by hand and in the `opsz` CLI rather than here. What is
// tested here is everything that can go wrong WITHOUT a font: the spec builders, the
// weightings guard, and the generator wiring — which is where the interesting bug was.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectAxesFromGoogleUrl, xWidthAvg } from '../src/opsz-policy.mjs'
import { applyRecommendation, specFromAxes } from '../src/opsz-auto.mjs'
import { googleUrl } from '../src/opsz.mjs'

const AXES = [
  { tag: 'wght', min: 100, max: 900, defaultValue: 400 },
  { tag: 'opsz', min: 9, max: 144, defaultValue: 14 },
  { tag: 'SOFT', min: 0, max: 100, defaultValue: 0 },
]

test('specFromAxes emits css2-ordered tags with one tuple per weight', () => {
  // css2 requires axis tags in alphabetical order, and rejects a spec that is not.
  const spec = specFromAxes(AXES, [400, 700])
  const [tags, tuples] = spec.split('@')
  assert.deepEqual(tags.split(','), tags.split(',').sort())
  assert.equal(tags, 'SOFT,opsz,wght')
  assert.deepEqual(tuples.split(';'), ['0..100,9..144,400', '0..100,9..144,700'])
})

test('specFromAxes emits a single tuple when the family has no wght axis', () => {
  const spec = specFromAxes([{ tag: 'opsz', min: 9, max: 144 }], [400, 700])
  assert.equal(spec, 'opsz@9..144')
})

test('detectAxesFromGoogleUrl tells a pinned opsz from a ranged one', () => {
  const ranged = detectAxesFromGoogleUrl(
    'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,700',
  )
  assert.equal(ranged.Fraunces.hasOpsz, true)
  assert.equal(ranged.Fraunces.opszPinned, false)

  // A single value means Google serves a file with no opsz axis at all — the whole point.
  const pinned = detectAxesFromGoogleUrl(
    'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@48,700',
  )
  assert.equal(pinned.Fraunces.opszPinned, true)
})

test('xWidthAvg refuses a subset it has no weightings for', () => {
  assert.throws(
    () => xWidthAvg({ glyphsForString: () => [] }, 'klingon'),
    /no character weightings for subset "klingon"/,
  )
})

// The bug this pins: `opszPin: 'auto'` measured the font, computed a pin, and then threw
// it away. googleUrl() applies a pin by rewriting the family's `axes` spec, and a family
// configured with `weights` but no `axes` has no spec to rewrite — it built `wght@700`,
// which carries no opsz axis, so the request went out unpinned and Google served whatever
// instance it chose. Nothing failed; the measurement was simply discarded.
//
// Asserted through googleUrl() rather than on the returned object, because the URL is the
// only thing that actually decides which bytes arrive.
test('a recommendation reaches the download URL even with no configured axes', () => {
  const fam = { name: 'Fraunces', themeVar: '--font-display', weights: [700] }
  const rec = { hasOpsz: true, pin: 48, pinnedAxes: 'opsz,wght@48,700' }

  const resolved = applyRecommendation(fam, rec)
  const url = googleUrl(resolved)

  assert.match(url, /opsz,wght@48,700/, 'the measured pin never reached the request')
  assert.ok(!/9\.\.144/.test(url), 'the axis must be pinned, not requested as a range')
  // Without the fix this was the whole spec, and the opsz axis simply vanished.
  assert.ok(!/family=Fraunces:wght@700/.test(url))
})

test('a family with no opsz axis loses the auto sentinel entirely', () => {
  // googleUrl() would otherwise interpolate the string 'auto' where a px size belongs.
  const fam = { name: 'Poppins', themeVar: '--font-sans', weights: [400], opszPin: 'auto' }
  const resolved = applyRecommendation(fam, { hasOpsz: false })
  assert.equal(resolved.opszPin, undefined)
  assert.equal(
    googleUrl(resolved),
    'https://fonts.googleapis.com/css2?family=Poppins:wght@400&display=swap',
  )
})

test('applyRecommendation keeps a configured axes spec when there is nothing better', () => {
  const fam = { name: 'Fraunces', weights: [700], axes: 'opsz,wght@9..144,700' }
  const resolved = applyRecommendation(fam, { hasOpsz: true, pin: 48 })
  assert.equal(resolved.axes, 'opsz,wght@9..144,700')
  // and googleUrl still pins it, because the spec has an opsz axis to pin into
  assert.match(googleUrl(resolved), /opsz,wght@48,700/)
})
