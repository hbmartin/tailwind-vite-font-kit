import { test } from 'node:test'
import assert from 'node:assert/strict'
import { googleUrl, hasOpszAxis, pinOpsz } from '../src/opsz.mjs'

test('detects an opsz axis from the css2 spec, without downloading anything', () => {
  assert.ok(hasOpszAxis('opsz,wght@9..144,500;9..144,700'))
  assert.ok(hasOpszAxis('opsz@14..32'))
  assert.ok(!hasOpszAxis('wght@400;700'))
  // must not false-positive on a family whose axis merely contains the letters
  assert.ok(!hasOpszAxis('wdth,wght@75..100,400'))
})

test('pinOpsz replaces the range in every weight tuple', () => {
  assert.equal(pinOpsz('opsz,wght@9..144,500;9..144,700', 48), 'opsz,wght@48,500;48,700')
  assert.equal(pinOpsz('opsz@14..32', 16), 'opsz@16')
})

test('pinOpsz leaves an already-pinned spec alone', () => {
  assert.equal(pinOpsz('opsz,wght@48,500;48,700', 16), 'opsz,wght@48,500;48,700')
})

// A measured pin has to land in EVERY tuple: mixed fixed values keep the opsz axis on
// the wire, which is exactly what pinning exists to remove.
test('pinOpsz replaceFixed pins fixed values too, preserving other axes', () => {
  assert.equal(
    pinOpsz('opsz,wght@12,400;72,700', 21, { replaceFixed: true }),
    'opsz,wght@21,400;21,700',
  )
  assert.equal(
    pinOpsz('ital,opsz,wght@0,12,400;1,72,700', 21, { replaceFixed: true }),
    'ital,opsz,wght@0,21,400;1,21,700',
  )
})

test('pinOpsz pins the opsz position when other axes come first', () => {
  // css2 axis tags are alphabetical, so ital precedes opsz — the pin must land on the
  // opsz slot of every tuple, not on whatever value happens to be first.
  assert.equal(
    pinOpsz('ital,opsz,wght@0,9..144,500;1,9..144,700', 48),
    'ital,opsz,wght@0,48,500;1,48,700',
  )
})

test('googleUrl pins opsz and defaults to 16', () => {
  const url = googleUrl({
    name: 'Fraunces',
    axes: 'opsz,wght@9..144,500;9..144,700',
    weights: [500],
  })
  assert.match(url, /opsz,wght@16,500;16,700/)
})

test('googleUrl honours an explicit opszPin', () => {
  const url = googleUrl({
    name: 'Fraunces',
    axes: 'opsz,wght@9..144,500;9..144,700',
    weights: [500],
    opszPin: 48,
  })
  assert.match(url, /opsz,wght@48,500;48,700/)
})

// A hand-fixed tuple value is more specific than one family-wide number, and configs
// written before opszPin existed rely on it winning — silently replacing it changes
// which optical-size masters a site downloads. The conflict is reported, not resolved
// silently in either direction. (`opszPin: 'auto'` still reaches the wire: it hands
// googleUrl an axes spec with the measured pin already in every tuple.)
test('googleUrl: hand-fixed opsz values win over a conflicting opszPin, loudly', () => {
  const warned = []
  const url = googleUrl(
    { name: 'Fraunces', axes: 'opsz,wght@12,500;72,700', opszPin: 48 },
    () => {},
    (m) => warned.push(m),
  )
  assert.match(url, /opsz,wght@12,500;72,700/, 'the hand-written values must survive')
  assert.match(warned.join(' '), /opszPin: 48/)
  assert.match(warned.join(' '), /hand-written values win/)
})

test('googleUrl: a numeric opszPin fills ranges without any conflict warning', () => {
  const warned = []
  const url = googleUrl(
    { name: 'Fraunces', axes: 'opsz,wght@9..144,500;9..144,700', opszPin: 48 },
    () => {},
    (m) => warned.push(m),
  )
  assert.match(url, /opsz,wght@48,500;48,700/)
  assert.deepEqual(warned, [])
})

test('googleUrl leaves hand-pinned opsz values alone when no opszPin is set', () => {
  const url = googleUrl({ name: 'Fraunces', axes: 'opsz,wght@48,500;48,700' })
  assert.match(url, /opsz,wght@48,500;48,700/)
})

test('googleUrl builds a wght spec from weights when no axes are given, sorted', () => {
  const url = googleUrl({ name: 'Manrope', weights: [700, 400, 500] })
  assert.match(url, /family=Manrope:wght@400;500;700/)
  assert.match(url, /display=swap/)
})

test('spaces in a family name become +', () => {
  assert.match(
    googleUrl({ name: 'Plus Jakarta Sans', weights: [400] }),
    /family=Plus\+Jakarta\+Sans/,
  )
})
