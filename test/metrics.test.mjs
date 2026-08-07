// The metric math. These assertions encode findings that took real measurement to
// establish — if a refactor breaks one, it breaks silently in the browser, which is
// exactly the failure mode this package exists to prevent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { entireMetricsCollection as METRICS } from '@capsizecss/metrics/entireMetricsCollection'
import { fallbackFaces, FALLBACK_TARGETS, metricsKey, pct } from '../src/metrics.mjs'

const parse = (css) =>
  [...css.matchAll(/@font-face\{([^}]*)\}/g)].map((m) =>
    Object.fromEntries(
      m[1]
        .split(';')
        .filter(Boolean)
        .map((d) => {
          const i = d.indexOf(':')
          return [d.slice(0, i).trim(), d.slice(i + 1).trim()]
        }),
    ),
  )

test('metricsKey lowercases the first char and strips spaces', () => {
  assert.equal(metricsKey('Times New Roman'), 'timesNewRoman')
  assert.equal(metricsKey('Manrope'), 'manrope')
  assert.equal(metricsKey('DM Sans'), 'dMSans')
})

test('pct trims trailing zeros so the output is stable', () => {
  assert.equal(pct(1), '100%')
  assert.equal(pct(1.03185), '103.185%')
})

test('never emits local("BlinkMacSystemFont") — it is a CSS keyword, not a face', () => {
  const all = Object.values(FALLBACK_TARGETS).flat().map(([name]) => name)
  assert.ok(!all.includes('BlinkMacSystemFont'))
  // and it must not be reachable via the metrics key either
  assert.ok(!all.some((n) => /blink/i.test(n)))
})

test('one fallback face per (target x declared weight), with distinct family names', () => {
  const weights = [400, 700]
  const { css, names } = fallbackFaces(METRICS, 'Manrope', 'latin', weights)
  const faces = parse(css)
  const targets = FALLBACK_TARGETS['sans-serif'].length

  assert.equal(faces.length, targets * weights.length)
  assert.equal(names.length, targets)
  assert.equal(new Set(names).size, targets, 'family names must be distinct per target')

  // Every face carries an explicit weight — without it one face is wrong for every
  // weight but one (Arial 700 is ~7.7% wider than Arial regular).
  for (const f of faces) assert.ok(f['font-weight'], 'face is missing font-weight')
})

test('bold and regular get different size-adjust for the same family', () => {
  const { css } = fallbackFaces(METRICS, 'Manrope', 'latin', [400, 700])
  const faces = parse(css).filter((f) => f.src.includes('Arial'))
  const w400 = faces.find((f) => f['font-weight'] === '400')
  const w700 = faces.find((f) => f['font-weight'] === '700')
  assert.notEqual(
    w400['size-adjust'],
    w700['size-adjust'],
    'per-weight metrics collapsed — this is the highest-value rule in the generator',
  )
})

test('ascent/descent/line-gap are pre-compensated by size-adjust', () => {
  // The browser applies size-adjust to the overrides too, so the emitted values must be
  // divided by it for the finals to equal the web font's.
  const { css } = fallbackFaces(METRICS, 'Manrope', 'latin', [400])
  const face = parse(css).find((f) => f.src.includes('Arial'))
  const m = METRICS.manrope
  const v = m.variants?.['regular'] ?? m
  const sa = Number(face['size-adjust'].replace('%', '')) / 100
  const expectedAscent = (v.ascent / (v.unitsPerEm * sa)) * 100

  const got = Number(face['ascent-override'].replace('%', ''))
  assert.ok(
    Math.abs(got - expectedAscent) < 0.001,
    `ascent-override ${got} != pre-compensated ${expectedAscent}`,
  )
  // descent is emitted as a positive percentage
  assert.ok(!face['descent-override'].startsWith('-'))
})

test('serif families select the serif fallback targets', () => {
  const { names } = fallbackFaces(METRICS, 'Fraunces', 'latin', [400])
  assert.ok(names.some((n) => n.includes('Georgia')))
  assert.ok(!names.some((n) => n.includes('Arial')))
})

test('an unknown family degrades to no faces rather than throwing', () => {
  const logged = []
  const { css, names } = fallbackFaces(METRICS, 'Definitely Not A Real Font', 'latin', [400], (m) =>
    logged.push(m),
  )
  assert.equal(css, '')
  assert.deepEqual(names, [])
  assert.match(logged.join(' '), /no capsize metrics/)
})
