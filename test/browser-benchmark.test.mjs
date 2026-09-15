import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validate, compare } from '../harness/browser-benchmark-validation.mjs'
import {
  matrixCases,
  regressionCases,
  runDriver,
  runCases,
  newBrowserErrors,
} from '../harness/browser-benchmark-runner.mjs'
import { candidateCss } from '../harness/browser-benchmark-candidates.mjs'
const cases = Array.from({ length: 3 }, () => ({
  viewport: 380,
  height: 900,
  probe: 'hero',
  group: 'responsive',
  variant: 'kit',
}))
function fixture(candidate = 'baseline') {
  return cases.map((c, i) => ({
    ...c,
    id: String(i),
    userAgent: 'Test Chrome',
    experiment: {
      candidate,
      transformId: 'd'.repeat(64),
      assets: [
        {
          path: '/assets/styles.css',
          type: 'text/css',
          sourceHash: 'a'.repeat(64),
          servedHash: (candidate === 'baseline' ? 'a' : 'c').repeat(64),
        },
      ],
    },
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
      layoutWidth: 365,
      elements: [
        { tag: 'P', probe: null, text: 'Paragraph', rect: { x: 0, y: 0, width: 100, height: 100 } },
      ],
      faces: ['Manrope', 'Fraunces'].flatMap((family) => [
        { family, status: 'loading' },
        { family: `${family} Fallback: Arial`, status: 'loaded' },
      ]),
    },
    after: {
      layoutWidth: 365,
      elements: [
        { tag: 'P', probe: null, text: 'Paragraph', rect: { x: 0, y: 0, width: 100, height: 100 } },
      ],
      faces: ['Manrope', 'Fraunces'].map((family) => ({ family, status: 'loaded' })),
    },
  }))
}
function fontaineFixture(candidate = 'baseline') {
  return fixture(candidate).map((row) => ({
    ...row,
    variant: 'fontaine',
    experiment: {
      ...row.experiment,
      assets: row.experiment.assets.map((asset) => ({ ...asset, servedHash: 'c'.repeat(64) })),
      fontaine: { path: '/assets/styles.css', cssHash: 'f'.repeat(64), applied: true },
    },
    before: {
      ...row.before,
      faces: row.before.faces.map((face) => ({
        ...face,
        family: face.family.includes('Fallback:')
          ? face.family.split(' Fallback:')[0] + ' fallback'
          : face.family,
      })),
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
    [
      (r) => {
        r.requestedViewport.width++
      },
      /viewport mismatch/,
    ],
    [
      (r) => {
        r.resources[0].status = 404
      },
      /failed request/,
    ],
    [
      (r) => {
        r.resources[0].transfer = 0
      },
      /cached\/empty/,
    ],
    [
      (r) => {
        r.resources.push(r.resources[0])
      },
      /duplicate font URL/,
    ],
    [
      (r) => {
        r.before.at = 2200
      },
      /late before-snapshot/,
    ],
    [
      (r) => {
        r.before.faces = r.before.faces.filter((f) => f.status === 'loading')
      },
      /fallback never loaded/,
    ],
    [
      (r) => {
        r.after.faces = []
      },
      /never loaded/,
    ],
    [
      (r) => {
        r.errors.push('error')
      },
      /browser errors/,
    ],
    [
      (r) => {
        r.hidden = true
      },
      /hidden page/,
    ],
    [
      (r) => {
        r.after.elements[0].rect.y = NaN
      },
      /invalid geometry/,
    ],
  ]
  for (const [change, expected] of changes) {
    const rows = fixture()
    change(rows[0])
    assert.throws(() => validate(rows, { cases }), expected)
  }
})

test('valid measurements and performance acceptance are separate', () => {
  const baseline = validate(fixture(), { cases })
  assert.throws(() => compare(baseline, baseline), /identified candidate/)
  assert.equal(
    compare(baseline, validate(fixture('binding'), { cases, candidate: 'binding' })).accepted,
    true,
  )
  const rows = fixture('binding')
  for (const r of rows) {
    r.cls = 0.03
    r.after.elements[0].rect.height += 24
  }
  const candidate = validate(rows, { cases, candidate: 'binding' })
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
  candidate.candidate = 'binding'
  for (const cell of candidate.summary) {
    cell.experiment.candidate = 'binding'
    cell.experiment.assets[0].servedHash = 'c'.repeat(64)
  }
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

test('delay is part of the manifest and comparison identity', () => {
  const rows = fixture()
  rows.forEach((r) => {
    r.delay = 0
  })
  assert.throws(() => validate(rows, { cases }), /Incomplete/)
  const fastCases = cases.map((c) => ({ ...c, delay: 0 }))
  const candidate = validate(
    rows.map((r) => ({ ...r, experiment: fixture('binding')[0].experiment })),
    { cases: fastCases, candidate: 'binding' },
  )
  assert.throws(() => compare(validate(fixture(), { cases }), candidate), /Unpaired comparison/)
})
test('candidate, source assets, layout width, and strict validation cannot be bypassed', () => {
  assert.throws(() => validate(fixture(), { cases, candidate: 'binding' }), /wrong candidate proxy/)
  const baseline = validate(fixture(), { cases })
  for (const [change, message] of [
    [
      (r) => {
        r.before.layoutWidth = 380
      },
      /Layout width mismatch/,
    ],
    [
      (r) => {
        r.experiment.assets[0].sourceHash = 'b'.repeat(64)
      },
      /Production asset mismatch/,
    ],
    [
      (r) => {
        r.experiment.transformId = 'e'.repeat(64)
      },
      /Harness transform mismatch/,
    ],
  ]) {
    const rows = fixture('binding')
    rows.forEach(change)
    assert.throws(() => compare(baseline, validate(rows, { cases, candidate: 'binding' })), message)
  }
  const rows = fixture('binding')
  rows.forEach((r) => {
    r.errors = ['error']
    r.hidden = true
  })
  assert.throws(
    () => compare(baseline, validate(rows, { cases, candidate: 'binding', strict: false })),
    /complete validated/,
  )
  const unchanged = fixture('binding')
  unchanged.forEach((r) => {
    r.experiment.assets[0].servedHash = r.experiment.assets[0].sourceHash
  })
  assert.throws(() => validate(unchanged, { cases, candidate: 'binding' }), /did not change CSS/)
})
test('candidate acceptance requires paired changed kit CSS at the 380px hero', () => {
  const systemCases = cases.map((c) => ({ ...c, variant: 'system' }))
  const systemRows = (candidate) =>
    fixture(candidate).map((row) => ({
      ...row,
      variant: 'system',
      resources: [],
      experiment: {
        ...row.experiment,
        assets: row.experiment.assets.map((asset) => ({ ...asset, servedHash: 'b'.repeat(64) })),
      },
    }))
  const baseline = validate(systemRows('baseline'), { cases: systemCases })
  const candidate = validate(systemRows('binding'), { cases: systemCases, candidate: 'binding' })
  assert.throws(() => compare(baseline, candidate), /Missing 380px kit hero/)
  const misleadingCases = systemCases.map((row) => ({ ...row, group: 'fake/380/900/hero/kit' }))
  const misleadingRows = systemRows('binding').map((row) => ({
    ...row,
    group: 'fake/380/900/hero/kit',
  }))
  assert.throws(
    () => validate(misleadingRows, { cases: misleadingCases, candidate: 'binding' }),
    /invalid cell identity/,
  )

  const changedBaseline = fixture()
  changedBaseline.forEach((row) => {
    row.experiment.assets[0].servedHash = 'b'.repeat(64)
  })
  assert.throws(() => validate(changedBaseline, { cases }), /baseline kit CSS changed/)

  const pairedBaseline = validate(fixture(), { cases })
  const pairedCandidate = validate(fixture('binding'), { cases, candidate: 'binding' })
  pairedCandidate.summary[0].experiment.assets[0].servedHash = 'a'.repeat(64)
  assert.throws(
    () => compare(pairedBaseline, pairedCandidate),
    /Candidate kit CSS matches baseline/,
  )
  pairedCandidate.summary[0].experiment.candidate = 'baseline'
  assert.throws(() => compare(pairedBaseline, pairedCandidate), /Candidate cell candidate mismatch/)
})
test('Fontaine replacement identity and non-kit served CSS must match between runs', () => {
  const fontaineCases = cases.map((c) => ({ ...c, variant: 'fontaine' }))
  const baseline = validate(fontaineFixture(), { cases: fontaineCases })
  const candidate = validate(fontaineFixture('binding'), {
    cases: fontaineCases,
    candidate: 'binding',
  })
  assert.equal(compare(baseline, candidate, { mode: 'diagnostic' }).accepted, null)
  candidate.summary[0].experiment.fontaine.cssHash = 'e'.repeat(64)
  assert.throws(() => compare(baseline, candidate, { mode: 'diagnostic' }), /Fontaine CSS mismatch/)
  candidate.summary[0].experiment.fontaine.cssHash = 'f'.repeat(64)
  candidate.summary[0].experiment.assets[0].servedHash = 'd'.repeat(64)
  assert.throws(
    () => compare(baseline, candidate, { mode: 'diagnostic' }),
    /Non-kit served asset mismatch/,
  )
  const unapplied = fontaineFixture()
  unapplied.forEach((row) => {
    row.experiment.fontaine.applied = false
  })
  assert.throws(() => validate(unapplied, { cases: fontaineCases }), /Fontaine CSS was not applied/)
})
test('probe identity cannot collide through slashes in probe attributes and text', () => {
  const rows = fixture()
  rows[0].before.elements[0].probe = 'a/b'
  rows[0].before.elements[0].text = 'c'
  rows[0].after.elements[0].probe = 'a'
  rows[0].after.elements[0].text = 'b/c'
  assert.throws(() => validate(rows, { cases }), /changed probe identity/)
})
test('an empty saved batch resumes after its first case fails', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'benchmark-empty-resume-'))
  const output = join(dir, 'raw.json')
  const batch = [{ viewport: 380, height: 900, probe: 'hero', variant: 'kit' }]
  try {
    await assert.rejects(
      runDriver(
        {
          viewport: async () => {},
          read: async () => {
            throw new Error('first case failed')
          },
        },
        batch,
        [],
        output,
      ),
      /first case failed/,
    )
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), [])
    const results = []
    await runDriver(
      { viewport: async () => {}, read: async () => ({ errors: [] }) },
      batch,
      results,
      output,
    )
    assert.equal(results.length, 1)
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('in-app log collection ignores prior unparseable times and flags lost history', async () => {
  const old = { message: 'old error', timestamp: 'unparseable' }
  const current = { message: 'current error', timestamp: '1970-01-01T00:00:00Z' }
  assert.deepEqual(newBrowserErrors([old], [old, current]), ['current error'])
  assert.deepEqual(newBrowserErrors([old], [current]), [
    'Browser log history lost the run boundary',
    'current error',
  ])
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'benchmark-tab-logs-'))
  const logs = [old]
  const results = []
  try {
    await runCases(
      {
        dev: { logs: async () => [...logs] },
        goto: async () => {
          logs.push(current)
        },
        playwright: {
          locator: () => ({
            waitFor: async () => {},
            textContent: async () => JSON.stringify({ errors: [] }),
          }),
        },
      },
      { set: async () => {} },
      [{ viewport: 380, height: 900, probe: 'hero', variant: 'kit' }],
      results,
      join(dir, 'raw.json'),
    )
    assert.deepEqual(results[0].errors, ['current error'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('explicit file expectations support multiple weights and reject missing or unexpected files', () => {
  const rows = fixture()
  for (const r of rows) {
    r.resources[0].name = 'http://localhost/__bench/' + r.id + '/fonts/manrope-400.woff2'
    r.resources[1].name = 'http://localhost/fonts/fraunces.woff2'
    r.resources.push({ ...r.resources[0], name: 'http://localhost/fonts/manrope-700.woff2' })
  }
  const families = {
    hero: [
      { name: 'Manrope', files: ['/fonts/manrope-400.woff2', '/fonts/manrope-700.woff2'] },
      { name: 'Fraunces', files: ['/fonts/fraunces.woff2'] },
    ],
  }
  assert.equal(validate(rows, { cases, families }).loads, 3)
  rows[0].resources[2].name = 'http://localhost/fonts/wrong.woff2'
  assert.throws(() => validate(rows, { cases, families }), /missing expected font/)
})
test('missing group normalizes identically, and diagnostic comparisons cannot approve defaults', () => {
  const withoutGroup = cases.map(({ group: _group, ...c }) => c)
  const rows = fixture().map((r) => ({
    ...r,
    group: 'matrix',
    viewport: { width: 390, height: 900 },
    requestedViewport: { width: 390, height: 900 },
  }))
  const options = { cases: withoutGroup.map((c) => ({ ...c, viewport: 390 })) }
  const baseline = validate(rows, options)
  const candidate = validate(
    rows.map((r) => ({ ...r, experiment: fixture('binding')[0].experiment })),
    { ...options, candidate: 'binding' },
  )
  assert.throws(() => compare(baseline, candidate), /Missing 380px/)
  assert.deepEqual(compare(baseline, candidate, { mode: 'diagnostic' }), {
    dataValid: true,
    mode: 'diagnostic',
    accepted: null,
    failures: [],
  })
})
test('repetitions must contain the same elements in the same order', () => {
  const missing = fixture()
  missing[1].before.elements.push({ ...missing[1].before.elements[0], text: 'Other' })
  missing[1].after.elements.push({ ...missing[1].after.elements[0], text: 'Other' })
  assert.throws(() => validate(missing, { cases }), /identities differ across repetitions/)
  const swapped = fixture()
  swapped[1].before.elements[0].text = 'Another paragraph'
  swapped[1].after.elements[0].text = 'Another paragraph'
  assert.throws(() => validate(swapped, { cases }), /identities differ across repetitions/)
})
test('regular, keyword and ranged weights are handled deliberately', () => {
  for (const weight of ['', 'font-weight:normal;', 'font-weight:400;', 'font-weight:400 700;']) {
    const face = `@font-face{font-family:Example;${weight}src:local(Georgia);size-adjust:100%}`
    assert.equal(candidateCss(face, 'binding'), face)
  }
  assert.match(
    candidateCss('@font-face{font-weight:bold;src:local(Georgia);size-adjust:100%}', 'binding'),
    /Georgia Bold/,
  )
})
test('the injected CLS function starts its window at the first shift', async () => {
  const { clsSession } = await import('../harness/browser-benchmark-session.mjs')
  assert.equal(
    +clsSession(
      [800, 1600, 2400, 3200, 4000, 4800, 5300].map((at) => ({ at, value: 0.01 })),
    ).toFixed(2),
    0.07,
  )
  assert.equal(
    clsSession([
      { at: 200, value: 0.1 },
      { at: 1200, value: 0.2 },
      { at: 1300, value: 1, hadRecentInput: true },
    ]),
    0.2,
  )
  assert.equal(clsSession([]), 0)
})
test('shared CSS stripping handles quoted, escaped, and unquoted family tokens', async () => {
  const { stripFallbacks } = await import('../harness/browser-benchmark-css.mjs')
  const css =
    '@font-face{font-family:Manrope Fallback\\: Arial;size-adjust:100%;src:local(Arial)}:root{--font-sans:Manrope,Manrope Fallback\\: Arial,"Manrope Fallback: Helvetica Neue",sans-serif}p{font-family:Manrope,Manrope Fallback\\3a  Arial,serif}'
  const plain = stripFallbacks(css)
  assert(!plain.includes('Fallback'))
  assert.match(plain, /--font-sans:Manrope,sans-serif/)
  assert.match(plain, /font-family:Manrope,serif/)
  const reordered = candidateCss(
    ':root{--font-sans:Manrope,Manrope Fallback\\: Arial,Manrope Fallback\\: Helvetica Neue,sans-serif}',
    'manrope-helvetica',
  )
  assert(reordered.indexOf('Helvetica') < reordered.indexOf('Arial'))
})
test('CSS stripping preserves important declarations and repairs fallback-only stacks and shorthand', async () => {
  const { stripFallbacks } = await import('../harness/browser-benchmark-css.mjs')
  assert.equal(
    stripFallbacks(':root{--font-sans:Manrope,"Manrope Fallback: Arial"!important}'),
    ':root{--font-sans:Manrope!important}',
  )
  assert.equal(
    stripFallbacks(':root{--font-sans:"Manrope Fallback: Arial"}'),
    ':root{--font-sans:"Arial"}',
  )
  assert.equal(
    stripFallbacks('p{font:italic bold 16px/1.2 Manrope,"Manrope Fallback: Arial",sans-serif}'),
    'p{font:italic bold 16px/1.2 Manrope,sans-serif}',
  )
  assert.equal(
    stripFallbacks('p{font:16px / 1.2 "Manrope Fallback: Arial",sans-serif}'),
    'p{font:16px / 1.2 sans-serif}',
  )
  assert.equal(
    stripFallbacks('p{font:16px "Manrope Fallback: Helvetica Neue"!important}'),
    'p{font:16px "Helvetica Neue"!important}',
  )
  assert.throws(
    () => stripFallbacks('p{font:unknown "Manrope Fallback: Arial"}'),
    /Cannot safely parse font shorthand/,
  )
  assert.throws(
    () => stripFallbacks('p{font:var(--size) "Manrope Fallback: Arial"}'),
    /Cannot safely parse font shorthand/,
  )
  const untouched = ':root { --unrelated:  red, blue ; } p { font: inherit; }'
  assert.equal(stripFallbacks(untouched), untouched)
  assert.equal(
    stripFallbacks('p{font:var(--unrelatedFallback)}'),
    'p{font:var(--unrelatedFallback)}',
  )
  const importantCandidate = candidateCss(
    ':root{--font-sans:"Manrope Fallback: Arial","Manrope Fallback: Helvetica Neue"!important}',
    'manrope-helvetica',
  )
  assert(importantCandidate.indexOf('Helvetica Neue') < importantCandidate.indexOf('Arial'))
  assert(importantCandidate.endsWith('!important}'))
})
test('output paths cannot collide or overwrite existing files; historical summary is read-only', async () => {
  const { outputPaths, assertNewOutputs } = await import('../harness/browser-benchmark-output.mjs')
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  assert.throws(() => outputPaths('run'), /must end in .json/)
  const dir = mkdtempSync(join(tmpdir(), 'benchmark-output-'))
  try {
    const input = join(dir, 'raw.json')
    const oldSummary = join(dir, 'raw-summary.json')
    writeFileSync(input, JSON.stringify(fixture()))
    writeFileSync(oldSummary, 'historical summary')
    assert.throws(() => assertNewOutputs([input]), /Refusing to overwrite/)
    execFileSync(process.execPath, ['harness/browser-benchmark-summary.mjs', input], {
      stdio: 'pipe',
    })
    assert.equal(readFileSync(oldSummary, 'utf8'), 'historical summary')
    const nested = join(dir, 'new', 'results', 'summary.json')
    execFileSync(
      process.execPath,
      ['harness/browser-benchmark-summary.mjs', input, '--output', nested],
      {
        stdio: 'pipe',
      },
    )
    assert.equal(JSON.parse(readFileSync(nested, 'utf8')).loads, 3)
    assert.throws(() =>
      execFileSync(
        process.execPath,
        ['harness/browser-benchmark-summary.mjs', input, '--output', input],
        { stdio: 'pipe' },
      ),
    )
    assert.equal(JSON.parse(readFileSync(input)).length, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('portable audit paths retain kit and dependency source identities', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join, resolve } = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'benchmark-module-path-'))
  try {
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'assets', 'main.js'), 'app()')
    writeFileSync(join(dir, 'assets', 'style.css'), 'body{}')
    const modules = join(dir, 'modules.json')
    const output = join(dir, 'report.json')
    writeFileSync(
      modules,
      JSON.stringify({
        main: [
          { id: resolve('src/index.mjs'), renderedLength: 100 },
          {
            id: '/elsewhere/node_modules/tailwind-vite-font-kit/src/index.mjs',
            renderedLength: 90,
          },
          { id: '/elsewhere/node_modules/other/src/index.js', renderedLength: 80 },
        ],
      }),
    )
    assert.throws(() =>
      execFileSync(
        process.execPath,
        ['harness/browser-benchmark-bundles.mjs', dir, dir, modules, output],
        { stdio: 'pipe' },
      ),
    )
    const report = JSON.parse(readFileSync(output))
    assert.deepEqual(
      report.largestModules.map((m) => m.id),
      [
        '<font-kit>/src/index.mjs',
        'node_modules/tailwind-vite-font-kit/src/index.mjs',
        'node_modules/other/src/index.js',
      ],
    )
    assert.equal(report.suspectModules.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CSS helpers do not change unrelated declarations or inflate the fallback size delta', async () => {
  const { stripFallbacks } = await import('../harness/browser-benchmark-css.mjs')
  const css =
    ':root { --unrelated:  red, blue ; --font-sans: "Manrope", sans-serif ; } p { font-family: Georgia, serif; }'
  assert.equal(stripFallbacks(css), css)
  assert.equal(candidateCss(css, 'manrope-helvetica'), css)
  assert.equal(
    stripFallbacks(
      ':root{--font-sans:"Manrope", "Manrope Fallback: Arial", ui-sans-serif, system-ui}',
    ),
    ':root{--font-sans:"Manrope", ui-sans-serif, system-ui}',
  )
})
