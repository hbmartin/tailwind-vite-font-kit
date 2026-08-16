#!/usr/bin/env node
// Validate the weekly browser report and always leave a compact, issue-friendly result.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const EXPECTED_KEYS = [
  'desktop/hero',
  'desktop/tailwind',
  'desktop/normal',
  'mobile/hero',
  'mobile/tailwind',
  'mobile/normal',
]
const REQUIRED_FALLBACKS = ['Manrope Fallback:', 'Fraunces Fallback:']

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const finiteNonnegative = (value) => Number.isFinite(value) && value >= 0

const [
  reportPath = 'cls.json',
  environmentPath = 'cls-environment.json',
  widthPath = 'cls-widths.json',
] = process.argv.slice(2)
const outputPath = process.argv[5] || 'cls-metrics.json'
const notePath = process.argv[6]
const threshold = Number(process.env.THRESHOLD ?? '0.02')
const report = readJson(reportPath)
const context = existsSync(environmentPath) ? readJson(environmentPath) : null
const widthSweep = existsSync(widthPath) ? readJson(widthPath) : null
const errors = []

if (!finiteNonnegative(threshold)) errors.push(`invalid threshold: ${process.env.THRESHOLD}`)
if (!Array.isArray(report.results)) errors.push('cls.json results must be an array')

const grouped = new Map()
for (const result of Array.isArray(report.results) ? report.results : []) {
  const key = `${result.viewport}/${result.probe}`
  const entries = grouped.get(key) || []
  entries.push(result)
  grouped.set(key, entries)
}

for (const key of EXPECTED_KEYS) {
  const entries = grouped.get(key) || []
  if (entries.length !== 1) {
    errors.push(`${key} appears ${entries.length} times; expected exactly once`)
    continue
  }
  const [result] = entries
  if (!Array.isArray(result.clsAll) || result.clsAll.length !== 3) {
    errors.push(`${key} must contain exactly 3 CLS runs`)
  } else if (!result.clsAll.every(finiteNonnegative)) {
    errors.push(`${key} contains a non-finite or negative CLS run`)
  }
  if (!finiteNonnegative(result.clsMedian)) {
    errors.push(`${key} has an invalid median CLS`)
  }
}

for (const key of grouped.keys()) {
  if (!EXPECTED_KEYS.includes(key)) errors.push(`unexpected probe result: ${key}`)
}

const heroAudit = grouped.get('desktop/hero')?.[0]?.audit
const fontFaceSet = Array.isArray(heroAudit?.fontFaceSet) ? heroAudit.fontFaceSet : []
const loadedFallbacks = fontFaceSet.filter(
  (face) =>
    face.status === 'loaded' && REQUIRED_FALLBACKS.some((prefix) => face.family.startsWith(prefix)),
)
for (const prefix of REQUIRED_FALLBACKS) {
  if (!loadedFallbacks.some((face) => face.family.startsWith(prefix))) {
    errors.push(`${prefix.slice(0, -1)} was not loaded before the delayed web fonts`)
  }
}

const rows = EXPECTED_KEYS.flatMap((key) => {
  const result = grouped.get(key)?.[0]
  return result ? [{ k: key, cls: result.clsMedian, clsAll: result.clsAll }] : []
})
const validRows = rows.filter((row) => finiteNonnegative(row.cls))
const worst = validRows.length
  ? validRows.reduce((current, row) => (row.cls > current.cls ? row : current))
  : null
const thresholdExceeded = worst ? worst.cls > threshold : false
const gateErrors = [...errors]
if (thresholdExceeded && worst) {
  gateErrors.push(`${worst.k} CLS ${worst.cls.toFixed(4)} exceeds ${threshold}`)
}

const output = {
  measuredAt: new Date().toISOString(),
  threshold,
  gate: { passed: gateErrors.length === 0, errors: gateErrors },
  worst,
  rows,
  loadedFallbacks,
  context,
  widthSweep: widthSweep
    ? { probe: widthSweep.probe, summaries: widthSweep.summaries, rows: widthSweep.rows }
    : null,
}
writeFileSync(outputPath, JSON.stringify(output, null, 2))
if (notePath) {
  const note = {
    measuredAt: output.measuredAt,
    threshold,
    gate: output.gate,
    worst,
    rows: rows.map(({ k, cls }) => ({ k, cls })),
    loadedFallbacks: [...new Set(loadedFallbacks.map((face) => face.family))],
    context,
    widthSweep: output.widthSweep
      ? { probe: output.widthSweep.probe, summaries: output.widthSweep.summaries }
      : null,
  }
  writeFileSync(notePath, `${JSON.stringify(note)}\n`)
}

for (const row of rows) {
  const value = finiteNonnegative(row.cls) ? row.cls.toFixed(4) : 'invalid'
  console.log(row.k.padEnd(20), value)
}
for (const error of gateErrors) console.error(`::error::${error}`)
if (gateErrors.length) process.exitCode = 1
