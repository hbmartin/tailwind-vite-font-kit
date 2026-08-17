// The metric math. These assertions encode findings that took real measurement to
// establish — if a refactor breaks one, it breaks silently in the browser, which is
// exactly the failure mode this package exists to prevent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { entireMetricsCollection as METRICS } from '@capsizecss/metrics/entireMetricsCollection'
import { fallbackFaces, FALLBACK_TARGETS, localSources, metricsKey, pct } from '../src/metrics.mjs'

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
  const all = Object.values(FALLBACK_TARGETS)
    .flat()
    .flatMap(([name, , aliases = []]) => [name, ...aliases])
  assert.ok(!all.includes('BlinkMacSystemFont'))
  // and it must not be reachable via the metrics key either
  assert.ok(!all.some((n) => /blink/i.test(n)))
})

test('metric-compatible Liberation aliases share the matching system-font face', () => {
  const sans = parse(fallbackFaces(METRICS, 'Manrope', 'latin', [400]).css)
  const serif = parse(fallbackFaces(METRICS, 'Fraunces', 'latin', [400]).css)
  // JetBrains Mono is capsize category `monospace`, so it selects the monospace targets.
  const mono = parse(fallbackFaces(METRICS, 'JetBrains Mono', 'latin', [400]).css)

  const arial = sans.find((face) => face.src.includes('local("Arial")'))
  const times = serif.find((face) => face.src.includes('local("Times New Roman")'))
  const courier = mono.find((face) => face.src.includes('local("Courier New")'))

  assert.equal(arial.src, 'local("Arial"),local("Liberation Sans")')
  assert.equal(times.src, 'local("Times New Roman"),local("Liberation Serif")')
  assert.equal(courier.src, 'local("Courier New"),local("Liberation Mono")')
  assert.equal(
    sans.filter((face) => face.src.includes('Liberation Sans')).length,
    1,
    'the alias must not add a second fallback face',
  )
  assert.equal(
    mono.filter((face) => face.src.includes('Liberation Mono')).length,
    1,
    'the alias must not add a second fallback face',
  )
})

// Every alias declared in FALLBACK_TARGETS has to reach the CSS. The monospace pair had
// no assertion at all for a while: the tuple could lose it and lint, the unit tests and
// both CI invariant jobs would all still pass.
test('every declared alias reaches the emitted face for its own category', () => {
  const probes = {
    'sans-serif': 'Manrope',
    serif: 'Fraunces',
    monospace: 'JetBrains Mono',
  }
  for (const [category, targets] of Object.entries(FALLBACK_TARGETS)) {
    const faces = parse(fallbackFaces(METRICS, probes[category], 'latin', [400]).css)
    assert.equal(faces.length > 0, true, `${category} emitted no faces`)
    for (const [local, , aliases = []] of targets) {
      const face = faces.find((f) => f.src.includes(`local("${local}")`))
      if (!face) continue // a target with no capsize metrics is skipped by design
      for (const alias of aliases) {
        assert.ok(
          face.src.includes(`local("${alias}")`),
          `${category}: "${local}" lost its "${alias}" alias`,
        )
      }
    }
  }
})

// src/opsz-policy.mjs emits fallback faces too. When it built its own `src:local("X")`
// the Linux aliases reached only one of the two emitters; both call this now.
test('localSources is the single src builder, and appends aliases in order', () => {
  assert.equal(localSources('Arial'), 'local("Arial")')
  assert.equal(localSources('Arial', []), 'local("Arial")')
  assert.equal(
    localSources('Courier New', ['Liberation Mono']),
    'local("Courier New"),local("Liberation Mono")',
  )
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

// Degrading to no faces is correct — a missing family must not fail the build — but it
// removes every bit of CLS protection for that family while the page still renders fine.
// Nothing downstream can notice, so this has to reach the WARN channel, which `silent`
// does not suppress. It sat on the log channel for a while, where `silent: true` hid it.
test('an unknown family degrades to no faces, and says so on the warn channel', () => {
  const logged = []
  const warned = []
  const { css, names } = fallbackFaces(
    METRICS,
    'Definitely Not A Real Font',
    'latin',
    [400],
    (m) => logged.push(m),
    (m) => warned.push(m),
  )
  assert.equal(css, '')
  assert.deepEqual(names, [])
  assert.match(warned.join(' '), /no capsize metrics/)
  assert.equal(logged.join(' '), '', 'this must not be a suppressible log line')
})
