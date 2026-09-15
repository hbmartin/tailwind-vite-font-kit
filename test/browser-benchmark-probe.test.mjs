import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const code = readFileSync(
  new URL('../harness/browser-benchmark-probe.js', import.meta.url),
  'utf8',
).replace('__BENCH_CLS__', '() => 0')

async function probe(fetchEvidence) {
  let ready, output
  const document = {
    currentScript: {
      dataset: { config: JSON.stringify({ id: 'probe-test', variant: 'kit', delay: 0, width: 0 }) },
    },
    hidden: false,
    documentElement: { scrollHeight: 100, clientWidth: 380 },
    fonts: { ready: Promise.resolve(), [Symbol.iterator]: () => [][Symbol.iterator]() },
    querySelectorAll: () => [],
    addEventListener: (name, handler) => {
      if (name === 'DOMContentLoaded') ready = handler
    },
    createElement: () => ({}),
    body: {
      append: (element) => {
        output = element
      },
    },
  }
  runInNewContext(code, {
    document,
    addEventListener: () => {},
    PerformanceObserver: class {
      observe() {}
    },
    performance: { now: () => 200, getEntriesByName: () => [], getEntriesByType: () => [] },
    navigator: { userAgent: 'Probe test browser' },
    innerWidth: 380,
    innerHeight: 900,
    fetch: fetchEvidence,
    setTimeout: (handler) => queueMicrotask(handler),
  })
  ready()
  for (let i = 0; i < 20 && !output; i++) await new Promise((resolve) => setImmediate(resolve))
  assert(output, 'Probe did not publish a result')
  return JSON.parse(output.textContent)
}

test('non-JSON and failed evidence requests still publish diagnostic observations', async () => {
  const invalid = await probe(async () => ({
    ok: false,
    status: 409,
    json: async () => {
      throw new Error('Not JSON')
    },
  }))
  assert.equal(invalid.experiment, null)
  assert.deepEqual(invalid.errors, [
    'Missing benchmark evidence (HTTP 409)',
    'Invalid benchmark evidence JSON',
  ])
  const unavailable = await probe(async () => {
    throw new Error('Connection refused')
  })
  assert.equal(unavailable.experiment, null)
  assert.match(unavailable.errors[0], /Connection refused/)
})

test('an unapplied Fontaine evidence response remains inspectable and invalid', async () => {
  const experiment = {
    candidate: 'baseline',
    fontaine: { path: '/assets/stale.css', applied: false },
  }
  const result = await probe(async () => ({ ok: false, status: 409, json: async () => experiment }))
  assert.deepEqual(result.experiment, experiment)
  assert.deepEqual(result.errors, ['Missing benchmark evidence (HTTP 409)'])
})
