import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const run = (command, args, cwd, env = process.env) =>
  execFileSync(command, args, { cwd, env, encoding: 'utf8' })

test('write-note keeps metrics and CLS histories on separate refs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'font-kit-notes-'))
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

  const script = join(root, 'scripts/write-note.sh')
  const metrics = join(dir, 'metrics.json')
  const clsOne = join(dir, 'cls-one.ndjson')
  const clsTwo = join(dir, 'cls-two.ndjson')
  writeFileSync(metrics, '{"metric":1}\n')
  writeFileSync(clsOne, '{"cls":1}\n')
  writeFileSync(clsTwo, '{"cls":2}\n')
  run('bash', [script, metrics], work)
  run('bash', [script, clsOne], work, { ...process.env, TSS_NOTES_NAMESPACE: 'cls' })
  run('bash', [script, clsTwo], work, { ...process.env, TSS_NOTES_NAMESPACE: 'cls' })

  assert.equal(run('git', ['notes', '--ref=metrics', 'show', 'HEAD'], work).trim(), '{"metric":1}')
  assert.deepEqual(run('git', ['notes', '--ref=cls', 'show', 'HEAD'], work).trim().split('\n'), [
    '{"cls":1}',
    '{"cls":2}',
  ])
  const invalid = spawnSync('bash', [script, clsOne], {
    cwd: work,
    env: { ...process.env, TSS_NOTES_NAMESPACE: '../bad' },
  })
  assert.equal(invalid.status, 2)
})

test('check-cls enforces the exact six probes, three runs, and loaded fallbacks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'font-kit-cls-'))
  const keys = [
    ['desktop', 'hero'],
    ['desktop', 'tailwind'],
    ['desktop', 'normal'],
    ['mobile', 'hero'],
    ['mobile', 'tailwind'],
    ['mobile', 'normal'],
  ]
  const audit = {
    fontFaceSet: [
      { family: 'Manrope Fallback: Arial', status: 'loaded' },
      { family: 'Fraunces Fallback: Georgia', status: 'loaded' },
    ],
  }
  const report = {
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
