import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const run = (command, args, cwd, env = process.env) =>
  execFileSync(command, args, { cwd, env, encoding: 'utf8' })

const GOOD_STATIC_AUDIT = {
  headerPreloadFontLinks: [
    '</fonts/manrope.woff2>; rel=preload; as=font; type=font/woff2; crossorigin',
  ],
  headPreloadFontLinks: [],
  sampleFontResponse: {
    status: 200,
    cacheControl: 'public, max-age=31536000, immutable',
    cors: '*',
    link: '',
  },
}

test('weekly CLS stages the complete static-audit module graph', () => {
  const workflow = readFileSync(join(root, '.github/workflows/cls-weekly.yml'), 'utf8')
  for (const path of [
    '../harness/sweep.mjs',
    '../harness/static-audit.mjs',
    '../src/preload-delivery.mjs',
  ]) {
    assert.ok(workflow.includes(path), `${path} is missing from the staged harness`)
  }
  assert.match(workflow, /node \.font-kit-ci\/harness\/sweep\.mjs/)
})

test('write-note keeps metrics and CLS histories on separate refs', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'font-kit-notes-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const origin = join(dir, 'origin.git')
  const work = join(dir, 'work')
  run('git', ['init', '--bare', origin], dir)
  run('git', ['init', work], dir)
  run('git', ['config', 'user.name', 'Test'], work)
  run('git', ['config', 'user.email', 'test@example.com'], work)
  writeFileSync(join(work, 'seed'), 'seed\n')
  run('git', ['add', 'seed'], work)
  run('git', ['commit', '-m', 'seed'], work)
  run('git', ['remote', 'add', 'origin', origin], work)

  const noteEnv = { ...process.env, GITHUB_SHA: run('git', ['rev-parse', 'HEAD'], work).trim() }
  delete noteEnv.GITHUB_TOKEN
  delete noteEnv.TSS_NOTES_NAMESPACE

  const script = join(root, 'scripts/write-note.sh')
  const metrics = join(dir, 'metrics.json')
  const clsOne = join(dir, 'cls-one.ndjson')
  const clsTwo = join(dir, 'cls-two.ndjson')
  writeFileSync(metrics, '{"metric":1}\n')
  writeFileSync(clsOne, '{"cls":1}\n')
  writeFileSync(clsTwo, '{"cls":2}\n')
  run('bash', [script, metrics], work, noteEnv)
  run('bash', [script, clsOne], work, { ...noteEnv, TSS_NOTES_NAMESPACE: 'cls' })
  run('bash', [script, clsTwo], work, { ...noteEnv, TSS_NOTES_NAMESPACE: 'cls' })

  assert.equal(run('git', ['notes', '--ref=metrics', 'show', 'HEAD'], work).trim(), '{"metric":1}')
  assert.deepEqual(run('git', ['notes', '--ref=cls', 'show', 'HEAD'], work).trim().split('\n'), [
    '{"cls":1}',
    '{"cls":2}',
  ])
  const invalid = spawnSync('bash', [script, clsOne], {
    cwd: work,
    env: { ...noteEnv, TSS_NOTES_NAMESPACE: '../bad' },
  })
  assert.equal(invalid.status, 2)
})

test('check-cls enforces the exact six probes, three runs, and loaded fallbacks', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'font-kit-cls-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const keys = [
    ['desktop', 'hero'],
    ['desktop', 'tailwind'],
    ['desktop', 'normal'],
    ['mobile', 'hero'],
    ['mobile', 'tailwind'],
    ['mobile', 'normal'],
  ]
  // `fontFaces` is what the page DECLARED; `fontFaceSet` is what resolved. The required
  // families are read off the former, so the reference app can change its fonts without
  // this repo shipping a matching edit.
  const audit = {
    fontFaces: [
      { family: 'Manrope Fallback: Arial' },
      { family: 'Manrope Fallback: Roboto' },
      { family: 'Fraunces Fallback: Georgia' },
    ],
    fontFaceSet: [
      { family: 'Manrope Fallback: Arial', status: 'loaded' },
      { family: 'Manrope Fallback: Roboto', status: 'error' },
      { family: 'Fraunces Fallback: Georgia', status: 'loaded' },
    ],
  }
  const report = {
    staticAudit: GOOD_STATIC_AUDIT,
    results: keys.map(([viewport, probe]) => ({
      viewport,
      probe,
      clsMedian: 0.001,
      clsAll: [0, 0.001, 0.002],
      audit: viewport === 'desktop' && probe === 'hero' ? audit : null,
    })),
  }
  const reportPath = join(dir, 'cls.json')
  const outputPath = join(dir, 'metrics.json')
  const notePath = join(dir, 'metrics.ndjson')
  writeFileSync(reportPath, JSON.stringify(report))
  const script = join(root, 'scripts/check-cls.mjs')
  run(
    'node',
    [
      script,
      reportPath,
      join(dir, 'missing-env'),
      join(dir, 'missing-width'),
      outputPath,
      notePath,
    ],
    dir,
    {
      ...process.env,
      THRESHOLD: '0.02',
    },
  )
  assert.equal(JSON.parse(readFileSync(outputPath)).gate.passed, true)
  assert.equal(readFileSync(notePath, 'utf8').trim().split('\n').length, 1)

  report.results[0].clsAll = [0.001]
  writeFileSync(reportPath, JSON.stringify(report))
  const invalid = spawnSync(
    'node',
    [script, reportPath, join(dir, 'missing-env'), join(dir, 'missing-width'), outputPath],
    { cwd: dir, env: { ...process.env, THRESHOLD: '0.02' } },
  )
  assert.equal(invalid.status, 1)
  assert.equal(JSON.parse(readFileSync(outputPath)).gate.passed, false)
})

// The failure mode this pins: the sweep could not audit the page, so `audit` carries a
// reason instead of a face list. Reporting that as "Manrope Fallback was not loaded"
// sends the maintainer looking for a font bug that does not exist.
test('check-cls reports an unusable audit as an audit failure, not a missing fallback', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'font-kit-audit-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const keys = [
    ['desktop', 'hero'],
    ['desktop', 'tailwind'],
    ['desktop', 'normal'],
    ['mobile', 'hero'],
    ['mobile', 'tailwind'],
    ['mobile', 'normal'],
  ]
  const report = {
    staticAudit: GOOD_STATIC_AUDIT,
    results: keys.map(([viewport, probe]) => ({
      viewport,
      probe,
      clsMedian: 0,
      clsAll: [0, 0, 0],
      audit:
        viewport === 'desktop' && probe === 'hero'
          ? { fontFaces: [], fontFaceSet: [], unavailableReason: 'the runtime audit threw: boom' }
          : null,
    })),
  }
  const reportPath = join(dir, 'cls.json')
  const outputPath = join(dir, 'metrics.json')
  writeFileSync(reportPath, JSON.stringify(report))
  const result = spawnSync(
    process.execPath,
    [
      join(root, 'scripts/check-cls.mjs'),
      reportPath,
      join(dir, 'missing-env'),
      join(dir, 'missing-width'),
      outputPath,
    ],
    { cwd: dir, env: { ...process.env, THRESHOLD: '0.02' }, encoding: 'utf8' },
  )
  assert.equal(result.status, 1)
  const { gate } = JSON.parse(readFileSync(outputPath))
  assert.equal(gate.passed, false)
  assert.match(gate.errors.join('\n'), /runtime audit is unavailable/)
  assert.ok(
    !gate.errors.some((error) => /was not loaded before the delayed web fonts/.test(error)),
    'an audit that never ran must not be reported as a missing fallback',
  )
})

// `Number(process.env.THRESHOLD ?? '0.02')` read an empty THRESHOLD as a threshold of 0,
// which fails every probe with any measurable CLS and files it as a regression.
test('check-cls treats an empty THRESHOLD as unset, and still writes a result on bad input', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'font-kit-threshold-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const keys = [
    ['desktop', 'hero'],
    ['desktop', 'tailwind'],
    ['desktop', 'normal'],
    ['mobile', 'hero'],
    ['mobile', 'tailwind'],
    ['mobile', 'normal'],
  ]
  const audit = {
    fontFaces: [{ family: 'Manrope Fallback: Arial' }],
    fontFaceSet: [{ family: 'Manrope Fallback: Arial', status: 'loaded' }],
  }
  const reportPath = join(dir, 'cls.json')
  const outputPath = join(dir, 'metrics.json')
  writeFileSync(
    reportPath,
    JSON.stringify({
      staticAudit: GOOD_STATIC_AUDIT,
      results: keys.map(([viewport, probe]) => ({
        viewport,
        probe,
        clsMedian: 0.001,
        clsAll: [0, 0.001, 0.002],
        audit: viewport === 'desktop' && probe === 'hero' ? audit : null,
      })),
    }),
  )
  const script = join(root, 'scripts/check-cls.mjs')
  const args = [reportPath, join(dir, 'missing-env'), join(dir, 'missing-width'), outputPath]
  const empty = spawnSync('node', [script, ...args], {
    cwd: dir,
    env: { ...process.env, THRESHOLD: '' },
  })
  assert.equal(empty.status, 0)
  assert.equal(JSON.parse(readFileSync(outputPath)).threshold, 0.02)

  // A truncated cls.json used to throw at module top level, leaving no cls-metrics.json
  // for the summary or the issue body to read.
  writeFileSync(reportPath, '{"results": [')
  const truncated = spawnSync('node', [script, ...args], {
    cwd: dir,
    env: { ...process.env, THRESHOLD: '0.02' },
  })
  assert.equal(truncated.status, 1)
  const { gate } = JSON.parse(readFileSync(outputPath))
  assert.equal(gate.passed, false)
  assert.match(gate.errors.join('\n'), /could not read the browser report/)
})

test('check-cls gates preload and font response delivery headers', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'font-kit-delivery-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const keys = [
    ['desktop', 'hero'],
    ['desktop', 'tailwind'],
    ['desktop', 'normal'],
    ['mobile', 'hero'],
    ['mobile', 'tailwind'],
    ['mobile', 'normal'],
  ]
  const report = {
    staticAudit: structuredClone(GOOD_STATIC_AUDIT),
    results: keys.map(([viewport, probe]) => ({
      viewport,
      probe,
      clsMedian: 0,
      clsAll: [0, 0, 0],
      audit:
        viewport === 'desktop' && probe === 'hero'
          ? {
              fontFaces: [{ family: 'Manrope Fallback: Arial' }],
              fontFaceSet: [{ family: 'Manrope Fallback: Arial', status: 'loaded' }],
            }
          : null,
    })),
  }
  const input = join(dir, 'cls.json')
  const output = join(dir, 'metrics.json')
  const script = join(root, 'scripts/check-cls.mjs')
  const execute = () => {
    writeFileSync(input, JSON.stringify(report))
    return spawnSync(
      'node',
      [script, input, join(dir, 'missing-env'), join(dir, 'missing-width'), output],
      { cwd: dir, env: { ...process.env, THRESHOLD: '0.02' } },
    )
  }
  assert.equal(execute().status, 0)
  report.staticAudit.headerPreloadFontLinks = [
    `<https://cdn.test/${'long-segment-'.repeat(30)}font.woff2>; rel=preload; as=font; crossorigin`,
  ]
  assert.equal(execute().status, 0, 'crossorigin beyond the old audit truncation still passes')
  const failures = [
    [(audit) => (audit.headerPreloadFontLinks = []), /no font preload/],
    [
      (audit) => (audit.headerPreloadFontLinks = ['</fonts/manrope.woff2>; rel=preload; as=font']),
      /missing crossorigin/,
    ],
    [
      (audit) =>
        (audit.headerPreloadFontLinks = [
          '</fonts/crossorigin/manrope.woff2>; rel=preload; as=font',
        ]),
      /missing crossorigin/,
    ],
    [
      (audit) =>
        (audit.headerPreloadFontLinks = [
          '</fonts/manrope.woff2>; rel=preload; as=font; title=crossorigin',
        ]),
      /missing crossorigin/,
    ],
    [
      (audit) =>
        (audit.headerPreloadFontLinks = [
          '</fonts/manrope.woff2>; rel=preload; as=font; crossorigin="use-credentials"',
        ]),
      /missing crossorigin/,
    ],
    [
      (audit) => {
        audit.headerPreloadFontLinks = []
        audit.headPreloadFontLinks = [
          '<link rel="preload" as="font" href="/fonts/manrope.woff2?crossorigin" title="crossorigin">',
        ]
      },
      /missing crossorigin/,
    ],
    [
      (audit) => {
        audit.headerPreloadFontLinks = []
        audit.headPreloadFontLinks = [
          '<link rel="preload" as="font" href="/fonts/manrope.woff2" crossorigin="use-credentials">',
        ]
      },
      /missing crossorigin/,
    ],
    [
      (audit) =>
        (audit.headerPreloadFontLinks = [
          '</fonts/manrope.woff2>; rel=preload; as=font; crossorigin',
          '</fonts/display.woff2>; rel=preload; as=font',
        ]),
      /missing crossorigin/,
    ],
    [(audit) => (audit.sampleFontResponse.status = 404), /returned HTTP 404/],
    [(audit) => (audit.sampleFontResponse.cacheControl = 'public'), /immutable cache-control/],
    [(audit) => (audit.sampleFontResponse.cors = ''), /missing CORS/],
    [
      (audit) => (audit.sampleFontResponse.link = '</fonts/manrope.woff2>; rel=preload'),
      /incorrectly carries/,
    ],
    [(audit) => (audit.errors = ['invalid HTML preload href']), /invalid HTML preload href/],
  ]
  for (const [breakAudit, expected] of failures) {
    report.staticAudit = structuredClone(GOOD_STATIC_AUDIT)
    breakAudit(report.staticAudit)
    assert.equal(execute().status, 1)
    assert.match(JSON.parse(readFileSync(output)).gate.errors.join('\n'), expected)
  }

  report.staticAudit = {
    unavailableReason: 'navigation returned malformed HTML',
    headerPreloadFontLinks: [],
    headPreloadFontLinks: [],
    sampleFontResponse: null,
    errors: [],
  }
  assert.equal(execute().status, 1)
  const unavailableErrors = JSON.parse(readFileSync(output)).gate.errors
  assert.ok(
    unavailableErrors.some((error) => /static font delivery audit is unavailable/.test(error)),
  )
  assert.equal(
    unavailableErrors.some((error) => /document carries no font preload/.test(error)),
    false,
  )
  assert.equal(
    unavailableErrors.some((error) => /sample font response/.test(error)),
    false,
  )
})

test('environment capture records unavailable metadata without aborting', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'font-kit-environment-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const output = join(dir, 'environment.json')
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts/collect-cls-environment.mjs'), join(dir, 'missing-app'), output],
    {
      cwd: root,
      encoding: 'utf8',
      // Keep this resilience test independent of Corepack. Under Node's aggregate
      // coverage, launching pnpm here would count pnpm's bundled 5 MB CLI as project code.
      env: { ...process.env, PATH: '/usr/bin:/bin', GITHUB_SHA: 'test-sha' },
    },
  )
  assert.equal(result.status, 0, result.stderr)
  const environment = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(environment.runtime.puppeteer, null)
  assert.ok(environment.metadataErrors['runtime.puppeteer.entry'])
})

test('assert-invariants fails on a mismatched alias pair and on an orphaned alias face', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'font-kit-invariants-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const script = join(root, 'scripts/assert-invariants.mjs')
  const ok = {
    googleapisRefs: 0,
    gstaticRefs: 0,
    blinkMacSystemFontLocals: 0,
    leakedThemeAtRule: 0,
    defaultFontFamilyIsVar: 1,
    themeVarsWithFallback: 3,
    fontFaceWithSizeAdjust: 13,
    aliasPairsDeclared: 3,
    aliasPairsPresent: 3,
    aliasPairsMismatched: 0,
    aliasOrphanFaces: 0,
    aliasSummary: 'Arial=2/Liberation Sans=2',
  }
  const at = join(dir, 'metrics.json')
  const check = (metrics) => {
    writeFileSync(at, JSON.stringify(metrics))
    return spawnSync('node', [script, at], { encoding: 'utf8' })
  }

  assert.equal(check(ok).status, 0)
  assert.match(check(ok).stdout, /invariants ok/)
  // The exact regression the global counts could not see.
  assert.equal(check({ ...ok, aliasOrphanFaces: 1 }).status, 1)
  assert.equal(check({ ...ok, aliasPairsMismatched: 1 }).status, 1)
  // A dropped monospace alias shows up as one fewer declared pair.
  assert.equal(check({ ...ok, aliasPairsDeclared: 2 }).status, 1)
  // ...and a fixture that stops exercising one shows up as one fewer present pair.
  assert.equal(check({ ...ok, aliasPairsPresent: 2 }).status, 1)
  assert.equal(check({ ...ok, googleapisRefs: 1 }).status, 1)
})

test('the issue body and the job summary render one table from one module', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'font-kit-report-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const metricsPath = join(dir, 'cls-metrics.json')
  writeFileSync(
    metricsPath,
    JSON.stringify({
      threshold: 0.02,
      gate: { passed: false, errors: ['desktop/hero CLS 0.0300 exceeds 0.02'] },
      worst: { k: 'desktop/hero', cls: 0.03 },
      rows: [{ k: 'desktop/hero', cls: 0.03, clsAll: [0.02, 0.03, 0.04] }],
      loadedFallbacks: [],
    }),
  )
  const missing = join(dir, 'missing.json')
  const body = run(
    'node',
    [join(root, 'scripts/write-cls-issue-body.mjs'), metricsPath, missing],
    dir,
    {
      ...process.env,
      RUN_URL: 'https://example.test/run/1',
      COMMIT_SHA: 'abcdef1234567890',
    },
  )
  const summary = run(
    'node',
    [join(root, 'scripts/write-cls-summary.mjs'), metricsPath, missing, missing],
    dir,
  )

  const row = '| desktop/hero | 0.0200, 0.0300, 0.0400 | 0.0300 |'
  assert.ok(body.includes(row), 'issue body lost the shared table')
  assert.ok(summary.includes(row), 'job summary lost the shared table')
  assert.match(body, /abcdef12/)
  assert.match(body, /desktop\/hero CLS 0\.0300 exceeds 0\.02/)

  // With no metrics at all it must still say why, rather than throw.
  const empty = run('node', [join(root, 'scripts/write-cls-issue-body.mjs'), missing, missing], dir)
  assert.match(empty, /failed before producing gated measurements/)
})
