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
// The families are NOT hardcoded: the reference app's HEAD floats, so naming its fonts
// here would turn any font swap in that repo into a weekly false regression. Every
// `<Family> Fallback: <Target>` face the page actually declares is required to have
// resolved instead, which is both drift-proof and stricter.
const FALLBACK_FAMILY_RE = /^(.+?) Fallback: .+$/

const DEFAULT_THRESHOLD = 0.02
const finiteNonnegative = (value) => Number.isFinite(value) && value >= 0

const [
  reportPath = 'cls.json',
  environmentPath = 'cls-environment.json',
  widthPath = 'cls-widths.json',
] = process.argv.slice(2)
const outputPath = process.argv[5] || 'cls-metrics.json'
const notePath = process.argv[6]
const errors = []

// This file's contract is to ALWAYS leave a compact, issue-friendly result, so a
// truncated or malformed input has to become a gate error rather than an uncaught throw
// that leaves the summary and the issue body with nothing to read.
const readJson = (path, label) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    errors.push(`could not read ${label} (${path}): ${error.message}`)
    return null
  }
}

// `?? '0.02'` accepted an EMPTY THRESHOLD as a valid threshold of 0, which fails every
// probe with any measurable CLS and reports it as a regression instead of as the
// misconfiguration it is.
const rawThreshold = process.env.THRESHOLD ?? ''
const threshold = rawThreshold.trim() === '' ? DEFAULT_THRESHOLD : Number(rawThreshold)
const report = readJson(reportPath, 'the browser report') || {}
const context = existsSync(environmentPath) ? readJson(environmentPath, 'the environment') : null
const widthSweep = existsSync(widthPath) ? readJson(widthPath, 'the width sweep') : null

if (!finiteNonnegative(threshold)) errors.push(`invalid threshold: ${JSON.stringify(rawThreshold)}`)
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
const familyOf = (face) => (typeof face?.family === 'string' ? face.family : '')
const fontFaceSet = Array.isArray(heroAudit?.fontFaceSet) ? heroAudit.fontFaceSet : []
// Which web-font families declared a metric-matched fallback, read off the page's own CSS.
const requiredPrefixes = [
  ...new Set(
    (Array.isArray(heroAudit?.fontFaces) ? heroAudit.fontFaces : [])
      .map((face) => FALLBACK_FAMILY_RE.exec(familyOf(face))?.[1])
      .filter(Boolean),
  ),
]
const loadedFallbacks = fontFaceSet.filter(
  (face) =>
    face.status === 'loaded' &&
    requiredPrefixes.some((prefix) => familyOf(face).startsWith(`${prefix} Fallback: `)),
)

// An audit that could not run is an infrastructure failure, not a font regression. Saying
// so is the difference between "fix the runner" and a week spent looking for a font bug.
if (!heroAudit || heroAudit.unavailableReason) {
  errors.push(
    `desktop/hero runtime audit is unavailable (${heroAudit?.unavailableReason ?? 'the sweep recorded no audit'}) — the fallback check could not run`,
  )
} else if (requiredPrefixes.length === 0) {
  errors.push('desktop/hero declared no metric-matched fallback faces')
} else {
  for (const prefix of requiredPrefixes) {
    if (!loadedFallbacks.some((face) => familyOf(face).startsWith(`${prefix} Fallback: `))) {
      errors.push(`${prefix} Fallback was not loaded before the delayed web fonts`)
    }
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
