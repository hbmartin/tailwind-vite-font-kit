import { test } from 'node:test'
import assert from 'node:assert/strict'
import { familiesFromGoogleUrl, weightsFromSpec } from '../src/detect.mjs'

test('weightsFromSpec reads the wght position, wherever it sits', () => {
  assert.deepEqual(weightsFromSpec('wght@400;500;700').weights, [400, 500, 700])
  assert.deepEqual(weightsFromSpec('opsz,wght@9..144,500;9..144,700').weights, [500, 700])
  assert.deepEqual(weightsFromSpec('ital,wght@0,400;1,700').weights, [400, 700])
})

test('a spec without a wght axis yields no weights — other axes are not weights', () => {
  assert.deepEqual(weightsFromSpec('ital@0;1').weights, [])
  assert.deepEqual(weightsFromSpec('opsz@14..32').weights, [])
})

test('familiesFromGoogleUrl defaults to [400] when the spec has no wght axis', () => {
  const fams = familiesFromGoogleUrl('https://fonts.googleapis.com/css2?family=Crimson+Pro:ital@0;1')
  assert.equal(fams.length, 1)
  assert.deepEqual(fams[0].weights, [400])
})
