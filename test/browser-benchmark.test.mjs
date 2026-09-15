import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validate, compare } from '../harness/browser-benchmark-validation.mjs'
import { matrixCases, regressionCases } from '../harness/browser-benchmark-runner.mjs'
import { candidateCss } from '../harness/browser-benchmark-candidates.mjs'
const cases = Array.from({ length: 3 }, () => ({
  viewport: 380,
  height: 900,
  probe: 'hero',
  group: 'responsive',
  variant: 'kit',
}))
function fixture() {
  return cases.map((c, i) => ({
    ...c,
    id: String(i),
    viewport: { width: 380, height: 900 },
    requestedViewport: { width: 380, height: 900 },
    delay: 2000,
    cls: 0,
    fcp: 20,
    errors: [],
    hidden: false,
    resources: ['Manrope', 'Fraunces'].map((f) => ({
      name: `http://localhost/${i}/${f}.woff2`,
      encoded: 100,
      transfer: 400,
      status: 200,
      end: 2100,
    })),
    before: {
      at: 200,
      elements: [{ tag: 'P', probe: null, rect: { x: 0, y: 0, width: 100, height: 100 } }],
      faces: ['Manrope', 'Fraunces'].flatMap((family) => [
        { family, status: 'loading' },
        { family: `${family} Fallback: Arial`, status: 'loaded' },
      ]),
    },
    after: {
      elements: [{ tag: 'P', probe: null, rect: { x: 0, y: 0, width: 100, height: 100 } }],
      faces: ['Manrope', 'Fraunces'].map((family) => ({ family, status: 'loaded' })),
    },
  }))
}
test('manifest requires exactly the declared repeated cells', () => {
  assert.equal(validate(fixture(), { cases }).loads, 3)
  assert.throws(() => validate([], { cases }), /No observations/)
  assert.throws(() => validate(fixture().slice(1), { cases }), /Incomplete/)
  const duplicate = fixture()
  duplicate[1].id = duplicate[0].id
  assert.throws(() => validate(duplicate, { cases }), /Duplicate run/)
  assert.throws(() => validate(fixture()), /manifest/)
})
test('invalid browser data cannot be accepted', () => {
  const changes = [
    (r) => {
      r.viewport.width++
    },
    (r) => {
      r.resources[0].status = 404
    },
    (r) => {
      r.resources[0].transfer = 0
    },
    (r) => {
      r.resources.push(r.resources[0])
    },
    (r) => {
      r.before.at = 2200
    },
    (r) => {
      r.before.faces = []
    },
    (r) => {
      r.after.faces = []
    },
    (r) => {
      r.errors.push('error')
    },
    (r) => {
      r.hidden = true
    },
    (r) => {
      r.after.elements[0].rect.y = NaN
    },
  ]
  for (const change of changes) {
    const rows = fixture()
    change(rows[0])
    assert.throws(() => validate(rows, { cases }))
  }
})
test('valid measurements and performance acceptance are separate', () => {
  const baseline = validate(fixture(), { cases })
  assert.equal(compare(baseline, baseline).accepted, true)
  const rows = fixture()
  for (const r of rows) {
    r.cls = 0.03
    r.after.elements[0].rect.height += 24
  }
  const candidate = validate(rows, { cases })
  assert.equal(candidate.validated, true)
  const report = compare(baseline, candidate)
  assert.equal(report.accepted, false)
  assert.deepEqual(
    report.failures.map((f) => f.reason),
    ['CLS regression', 'Geometry regression', '380px acceptance gate'],
  )
  assert.throws(
    () => compare({ ...baseline, completenessChecked: false }, candidate),
    /complete validated/,
  )
})
test('any width regression rejects a candidate even when aggregate CLS improves', () => {
  const baseline = validate(fixture(), { cases })
  const other = structuredClone(baseline.summary[0])
  other.key = other.key.replace('/380/', '/400/')
  other.cls = 0.1
  baseline.summary.push(other)
  const candidate = structuredClone(baseline)
  candidate.summary[0].cls = 0.001
  candidate.summary[1].cls = 0
  assert.equal(compare(baseline, candidate).accepted, false)
})
test('default regression suite includes every responsive width and three repetitions', () => {
  assert.equal(matrixCases().length, 108)
  const all = regressionCases()
  assert.equal(all.filter((c) => c.group === 'responsive').length, 108)
  assert.equal(all.filter((c) => c.group === 'widths').length, 33)
  assert.equal(all.filter((c) => c.group === 'confirmation').length, 3)
})
test('candidate changes preserve regular sources and Liberation bold aliases', () => {
  const face = (weight) =>
    `@font-face{font-family:"Manrope Fallback: Arial";font-weight:${weight};src:local("Arial"),local("Liberation Sans");size-adjust:100%}`
  const css =
    face(400) +
    face(700) +
    ':root{--font-sans:"Manrope","Manrope Fallback: Arial","Manrope Fallback: Helvetica Neue","Manrope Fallback: Roboto";--font-other:"Poppins Fallback: Arial"}'
  const result = candidateCss(css, 'combined')
  assert(result.includes(face(400)))
  assert(result.includes('local("Arial-BoldMT")'))
  assert(result.includes('local("LiberationSans-Bold")'))
  assert(
    result.includes(
      '"Manrope Fallback: Helvetica Neue","Manrope Fallback: Arial","Manrope Fallback: Roboto"',
    ),
  )
  assert(result.includes('"Poppins Fallback: Arial"'))
})

test('browser environments cannot be silently mixed', () => {
  const baseline = validate(fixture(), { cases })
  const candidate = structuredClone(baseline)
  candidate.userAgents = ['Different browser']
  assert.throws(() => compare(baseline, candidate), /Browser\/platform mismatch/)
})

test('bundle audit ignores compression sidecars and rejects leaked build dependencies', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'font-bundle-audit-'))
  try {
    for (const name of ['kit', 'manual']) {
      mkdirSync(join(dir, name, 'assets'), { recursive: true })
      writeFileSync(
        join(dir, name, 'assets', 'entry-dynamic-hash.js'),
        'console.log("application")',
      )
      writeFileSync(join(dir, name, 'assets', 'styles-dynamic-hash.css'), 'body{color:black}')
    }
    writeFileSync(join(dir, 'kit', 'assets', 'entry-dynamic-hash.js.br'), 'sidecar')
    const modules = join(dir, 'modules.json')
    const output = join(dir, 'report.json')
    writeFileSync(
      modules,
      JSON.stringify({ entry: [{ id: '/another/machine/app/src/main.tsx', renderedLength: 12 }] }),
    )
    const args = [
      'harness/browser-benchmark-bundles.mjs',
      join(dir, 'kit'),
      join(dir, 'manual'),
      modules,
      output,
    ]
    execFileSync(process.execPath, args, { stdio: 'pipe' })
    const report = JSON.parse(readFileSync(output))
    assert.equal(report.identicalJavaScript, true)
    assert.equal(report.kit.length, 2)
    assert.equal(report.largestModules[0].id, '<reference-app>/src/main.tsx')
    writeFileSync(
      modules,
      JSON.stringify({
        entry: [
          { id: '/different-checkout/node_modules/fontkit/dist/main.js', renderedLength: 50 },
        ],
      }),
    )
    assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }))
    assert.equal(JSON.parse(readFileSync(output)).suspectModules.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bold candidate handles actual minified production local names', () => {
  const css =
    '@font-face{font-family:Manrope Fallback\\: Arial;font-weight:700;src:local(Arial),local(Liberation Sans);size-adjust:101.15%;ascent-override:105.388%;descent-override:29.6589%;line-gap-override:0%}'
  const changed = candidateCss(css, 'binding')
  assert.notEqual(changed, css)
  assert(
    changed.includes(
      'src:local("Arial Bold"),local("Arial-BoldMT"),local("Liberation Sans Bold"),local("LiberationSans-Bold")',
    ),
  )
  assert(changed.includes('size-adjust:101.15%'))
})
